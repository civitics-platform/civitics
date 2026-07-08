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
  startFullRun,
  isPartComplete,
  markPartComplete,
  completeFullRun,
  completeDeltaRun,
  describeState,
  readLegacyBaselines,
} from "./state";

const NOW = "2026-07-08T12:00:00.000Z";

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

  const plan = startFullRun(state, "contracts", "20260704", NOW);
  assert.deepEqual(plan, { resumed: false, discardedDate: null, completedParts: [] });
  assert.equal(state.contracts?.fullInProgress?.archiveDate, "20260704");
  assert.equal(getBaseline(state, "contracts"), null, "an in-progress Full is NOT a delta baseline");

  const k1 = partKey("z1.zip", "p1.csv");
  const k2 = partKey("z1.zip", "p2.csv");
  assert.equal(isPartComplete(state, "contracts", k1), false);
  markPartComplete(state, "contracts", k1, NOW);
  assert.equal(isPartComplete(state, "contracts", k1), true);
  assert.equal(isPartComplete(state, "contracts", k2), false);

  // Marking the same part twice is idempotent.
  markPartComplete(state, "contracts", k1, NOW);
  assert.equal(state.contracts?.fullInProgress?.completedParts.length, 1);

  completeFullRun(state, "contracts", "20260704", NOW);
  assert.equal(state.contracts?.fullInProgress, undefined, "partial cleared on completion");
  assert.deepEqual(getBaseline(state, "contracts"), {
    lastArchiveDate: "20260704", lastRunType: "full", lastRunAt: NOW,
  });
});

test("FIX-739 startFullRun resumes the SAME archive, preserving completed parts", () => {
  const state = createEmptyState();
  startFullRun(state, "contracts", "20260704", NOW);
  markPartComplete(state, "contracts", partKey("z1.zip", "p1.csv"), NOW);

  // Killed mid-run; the next dispatch re-plans the same archive date.
  const plan = startFullRun(state, "contracts", "20260704", NOW);
  assert.equal(plan.resumed, true);
  assert.deepEqual(plan.completedParts, [partKey("z1.zip", "p1.csv")]);
  assert.equal(isPartComplete(state, "contracts", partKey("z1.zip", "p1.csv")), true, "part still complete on resume");
});

test("FIX-739 startFullRun discards an in-progress Full when the archive date changes", () => {
  const state = createEmptyState();
  startFullRun(state, "contracts", "20260704", NOW);
  markPartComplete(state, "contracts", partKey("z1.zip", "p1.csv"), NOW);

  // A newer weekly Full dropped — the partial for the old date is thrown away.
  const plan = startFullRun(state, "contracts", "20260711", NOW);
  assert.equal(plan.resumed, false);
  assert.equal(plan.discardedDate, "20260704");
  assert.deepEqual(plan.completedParts, []);
  assert.equal(state.contracts?.fullInProgress?.archiveDate, "20260711");
  assert.equal(
    state.contracts?.fullInProgress?.completedParts.length,
    0,
    "old parts do not carry into the new archive",
  );
});

test("FIX-739 categories are isolated within one state row", () => {
  const state = createEmptyState();
  completeFullRun(state, "contracts", "20260704", NOW);
  assert.equal(getBaseline(state, "assistance"), null, "assistance untouched by contracts");

  startFullRun(state, "assistance", "20260704", NOW);
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

  startFullRun(s, "contracts", "20260704", NOW);
  markPartComplete(s, "contracts", partKey("z.zip", "p1.csv"), NOW);
  assert.match(describeState(s, "contracts"), /full-in-progress=20260704 parts=1/);

  completeFullRun(s, "contracts", "20260704", NOW);
  assert.match(describeState(s, "contracts"), /baseline=20260704\(full\)/);
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
