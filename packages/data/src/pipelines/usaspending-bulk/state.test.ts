/**
 * FIX-739 — DB-backed state transitions for the USASpending bulk pipeline.
 *
 * Pins the pure decision helpers in state.ts: the Full-run lifecycle (fresh →
 * in-progress → parts completing → delta baseline), same-archive resume vs
 * archive-date-mismatch discard, category isolation, and the one-time legacy
 * file→DB lift shape. No I/O against a DB — the load/save wrappers are thin
 * enough that the local + prod dispatch proof covers them.
 *
 * Runs via:  tsx --test src/pipelines/usaspending-bulk/state.test.ts
 */

import { test } from "node:test";
import assert   from "node:assert/strict";
import * as fs   from "node:fs";
import * as os   from "node:os";
import * as path from "node:path";
import {
  USASPENDING_STATE_VERSION,
  createEmptyState,
  parseState,
  getBaseline,
  partKey,
  startRun,
  isPartComplete,
  markPartComplete,
  completeFullRun,
  completeDeltaRun,
  describeState,
  readLegacyBaselines,
  type RunIdentity,
} from "./state";

const NOW = "2026-07-08T12:00:00.000Z";

const full  = (date: string): RunIdentity =>
  ({ runType: "full", archiveDate: date, archiveName: `FY2026_All_Contracts_Full_${date}.zip` });
const delta = (date: string): RunIdentity =>
  ({ runType: "delta", archiveDate: date, archiveName: `FY(All)_All_Contracts_Delta_${date}.zip` });

// ---------------------------------------------------------------------------
// parseState — shape guard
// ---------------------------------------------------------------------------

test("FIX-739 parseState accepts v1, rejects garbage / missing / future version", () => {
  assert.ok(parseState(createEmptyState()));
  assert.equal(parseState(null), null);
  assert.equal(parseState("x"), null);
  assert.equal(parseState([]), null);
  assert.equal(parseState({}), null, "missing version");
  assert.equal(parseState({ version: USASPENDING_STATE_VERSION + 1 }), null, "future version rejected");

  const round = parseState(JSON.parse(JSON.stringify(createEmptyState())));
  assert.ok(round);
  assert.equal(round.version, USASPENDING_STATE_VERSION);
});

// ---------------------------------------------------------------------------
// Full-run lifecycle
// ---------------------------------------------------------------------------

test("FIX-739 full lifecycle: fresh → in-progress → parts completing → baseline", () => {
  const state = createEmptyState();
  assert.equal(getBaseline(state, "contracts"), null, "fresh → run Full");

  const plan = startRun(state, "contracts", full("20260704"), NOW);
  assert.deepEqual(plan, { resumed: false, abandoned: null, completedParts: [] });
  assert.equal(state.contracts?.runInProgress?.archiveDate, "20260704");
  assert.equal(state.contracts?.runInProgress?.runType, "full");
  assert.equal(getBaseline(state, "contracts"), null, "an in-progress Full is NOT a delta baseline");

  const k1 = partKey("z1.zip", "p1.csv");
  const k2 = partKey("z1.zip", "p2.csv");
  assert.equal(isPartComplete(state, "contracts", k1), false);
  markPartComplete(state, "contracts", k1, NOW);
  assert.equal(isPartComplete(state, "contracts", k1), true);
  assert.equal(isPartComplete(state, "contracts", k2), false);

  // Marking the same part twice is idempotent.
  markPartComplete(state, "contracts", k1, NOW);
  assert.equal(state.contracts?.runInProgress?.completedParts.length, 1);

  completeFullRun(state, "contracts", "20260704", NOW);
  assert.equal(state.contracts?.runInProgress, undefined, "partial cleared on completion");
  assert.deepEqual(getBaseline(state, "contracts"), {
    lastArchiveDate: "20260704", lastRunType: "full", lastRunAt: NOW,
  });
});

test("FIX-739 startRun resumes the SAME Full archive, preserving completed parts", () => {
  const state = createEmptyState();
  startRun(state, "contracts", full("20260704"), NOW);
  markPartComplete(state, "contracts", partKey("z1.zip", "p1.csv"), NOW);

  // Killed mid-run; the next dispatch re-plans the same archive date.
  const plan = startRun(state, "contracts", full("20260704"), NOW);
  assert.equal(plan.resumed, true);
  assert.deepEqual(plan.completedParts, [partKey("z1.zip", "p1.csv")]);
  assert.equal(isPartComplete(state, "contracts", partKey("z1.zip", "p1.csv")), true, "part still complete on resume");
});

test("FIX-739 startRun discards an in-progress Full when the archive date changes", () => {
  const state = createEmptyState();
  startRun(state, "contracts", full("20260704"), NOW);
  markPartComplete(state, "contracts", partKey("z1.zip", "p1.csv"), NOW);

  // A newer weekly Full dropped — the partial for the old date is thrown away.
  const plan = startRun(state, "contracts", full("20260711"), NOW);
  assert.equal(plan.resumed, false);
  assert.equal(plan.abandoned?.archiveDate, "20260704");
  assert.deepEqual(plan.completedParts, []);
  assert.equal(state.contracts?.runInProgress?.archiveDate, "20260711");
  assert.equal(
    state.contracts?.runInProgress?.completedParts.length,
    0,
    "old parts do not carry into the new archive",
  );
});

test("FIX-739 categories are isolated within one state row", () => {
  const state = createEmptyState();
  completeFullRun(state, "contracts", "20260704", NOW);
  assert.equal(getBaseline(state, "assistance"), null, "assistance untouched by contracts");

  startRun(state, "assistance", full("20260704"), NOW);
  assert.deepEqual(
    getBaseline(state, "contracts"),
    { lastArchiveDate: "20260704", lastRunType: "full", lastRunAt: NOW },
    "contracts baseline survives assistance work",
  );
});

test("FIX-739 completeDeltaRun advances the baseline as a delta", () => {
  const state = createEmptyState();
  completeFullRun(state, "contracts", "20260704", NOW);
  completeDeltaRun(state, "contracts", "20260709", "2026-07-09T00:00:00.000Z");
  assert.deepEqual(getBaseline(state, "contracts"), {
    lastArchiveDate: "20260709", lastRunType: "delta", lastRunAt: "2026-07-09T00:00:00.000Z",
  });
});

test("FIX-739 describeState summarizes fresh / in-progress / baseline", () => {
  const s = createEmptyState();
  assert.match(describeState(s, "contracts"), /contracts=fresh/);

  startRun(s, "contracts", full("20260704"), NOW);
  markPartComplete(s, "contracts", partKey("z.zip", "p1.csv"), NOW);
  assert.match(describeState(s, "contracts"), /run-in-progress=full:20260704 parts=1/);

  completeFullRun(s, "contracts", "20260704", NOW);
  assert.match(describeState(s, "contracts"), /baseline=20260704\(full\)/);
});

// ---------------------------------------------------------------------------
// FIX-1274 — delta runs checkpoint too; the legacy `fullInProgress` key loads
// ---------------------------------------------------------------------------

test("FIX-1274 a DELTA run checkpoints per part and round-trips through JSON", () => {
  const state = createEmptyState();
  completeFullRun(state, "contracts", "20260806", NOW);

  const d = delta("20260924");
  const zip = d.archiveName;
  assert.deepEqual(startRun(state, "contracts", d, NOW), { resumed: false, abandoned: null, completedParts: [] });
  markPartComplete(state, "contracts", partKey(zip, "p1.csv"), NOW);
  markPartComplete(state, "contracts", partKey(zip, "p2.csv"), NOW);

  // The row as pipeline_state stores it, read back by the next invocation.
  const reloaded = parseState(JSON.parse(JSON.stringify(state)));
  assert.ok(reloaded);
  assert.deepEqual(reloaded.contracts?.runInProgress?.completedParts, [
    partKey(zip, "p1.csv"), partKey(zip, "p2.csv"),
  ]);
  const plan = startRun(reloaded, "contracts", d, NOW);
  assert.equal(plan.resumed, true, "the same delta archive resumes");
  assert.equal(isPartComplete(reloaded, "contracts", partKey(zip, "p2.csv")), true);
  assert.equal(isPartComplete(reloaded, "contracts", partKey(zip, "p3.csv")), false);
  assert.deepEqual(getBaseline(reloaded, "contracts")?.lastArchiveDate, "20260806",
    "a delta in progress does not move the baseline");

  completeDeltaRun(reloaded, "contracts", "20260924", NOW);
  assert.equal(reloaded.contracts?.runInProgress, undefined, "completeDeltaRun clears the run");
  assert.equal(getBaseline(reloaded, "contracts")?.lastArchiveDate, "20260924");
});

test("FIX-1274 a different delta archive (or a mode change) abandons the in-progress run", () => {
  const state = createEmptyState();
  startRun(state, "contracts", delta("20260924"), NOW);
  markPartComplete(state, "contracts", partKey(delta("20260924").archiveName, "p1.csv"), NOW);

  const next = startRun(state, "contracts", delta("20261024"), NOW);
  assert.equal(next.resumed, false);
  assert.equal(next.abandoned?.archiveDate, "20260924");
  assert.equal(next.abandoned?.completedParts.length, 1);

  // Same date, other mode: still a different run.
  const forced = startRun(state, "contracts", full("20261024"), NOW);
  assert.equal(forced.abandoned?.runType, "delta");
  assert.equal(state.contracts?.runInProgress?.runType, "full");
});

test("FIX-1274 the legacy fullInProgress key (10-08-era row) loads as runInProgress and is dropped", () => {
  // The shape the pre-FIX-1274 code wrote into pipeline_state.
  const legacy = {
    version: USASPENDING_STATE_VERSION,
    contracts: {
      baseline: { lastArchiveDate: "20260806", lastRunType: "delta", lastRunAt: "t" },
      fullInProgress: {
        archiveDate: "20260906", completedParts: ["FY2026_All_Contracts_Full_20260906.zip::p1.csv"],
        startedAt: "s", updatedAt: "u",
      },
    },
    assistance: { baseline: { lastArchiveDate: "20260806", lastRunType: "delta", lastRunAt: "t" } },
  };
  const s = parseState(JSON.parse(JSON.stringify(legacy)));
  assert.ok(s);
  assert.equal(s.contracts?.fullInProgress, undefined, "old key dropped in place — the next save writes the new shape");
  assert.deepEqual(s.contracts?.runInProgress, {
    runType: "full", archiveDate: "20260906", archiveName: "",
    completedParts: ["FY2026_All_Contracts_Full_20260906.zip::p1.csv"], startedAt: "s", updatedAt: "u",
  });
  assert.equal(s.assistance?.runInProgress, undefined);

  // A lifted record has no name; the same Full date still resumes it.
  const plan = startRun(s, "contracts", full("20260906"), NOW);
  assert.equal(plan.resumed, true);
  assert.equal(s.contracts?.runInProgress?.archiveName, full("20260906").archiveName, "the name is learned on resume");

  // And the stored JSON no longer carries the legacy key.
  assert.equal(JSON.stringify(s).includes("fullInProgress"), false);
});

// ---------------------------------------------------------------------------
// Legacy file → DB lift
// ---------------------------------------------------------------------------

test("FIX-739 readLegacyBaselines lifts only the active env's slice", () => {
  const tmp  = fs.mkdtempSync(path.join(os.tmpdir(), "usasp-state-"));
  const file = path.join(tmp, "state.json");
  try {
    fs.writeFileSync(file, JSON.stringify({
      envs: {
        "db.prod.example:5432": {
          contracts:  { lastArchiveDate: "20260601", lastRunType: "full",  lastRunAt: "t1" },
          assistance: { lastArchiveDate: "20260602", lastRunType: "delta", lastRunAt: "t2" },
        },
        "127.0.0.1:54321": {
          contracts: { lastArchiveDate: "20250101", lastRunType: "full", lastRunAt: "old" },
        },
      },
    }));

    assert.deepEqual(readLegacyBaselines(file, "db.prod.example:5432"), {
      contracts:  { lastArchiveDate: "20260601", lastRunType: "full",  lastRunAt: "t1" },
      assistance: { lastArchiveDate: "20260602", lastRunType: "delta", lastRunAt: "t2" },
    });
    assert.equal(readLegacyBaselines(file, "no.such.host"), null, "unknown env → nothing to lift");
    assert.equal(readLegacyBaselines(path.join(tmp, "missing.json"), "any"), null, "absent file → null");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("FIX-739 readLegacyBaselines falls back to v1 root, then v0 contracts-only root", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "usasp-state-"));
  try {
    const v1 = path.join(tmp, "v1.json");
    fs.writeFileSync(v1, JSON.stringify({
      contracts: { lastArchiveDate: "20260501", lastRunType: "full", lastRunAt: "t" },
    }));
    assert.deepEqual(readLegacyBaselines(v1, "whatever"), {
      contracts: { lastArchiveDate: "20260501", lastRunType: "full", lastRunAt: "t" },
    });

    const v0 = path.join(tmp, "v0.json");
    fs.writeFileSync(v0, JSON.stringify({ lastArchiveDate: "20260401", lastRunType: "full", lastRunAt: "t0" }));
    assert.deepEqual(readLegacyBaselines(v0, "whatever"), {
      contracts: { lastArchiveDate: "20260401", lastRunType: "full", lastRunAt: "t0" },
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
