/**
 * FIX-462 — phase-scoped kill detection.
 *
 * Runs via:  tsx --test src/scripts/mark-killed.test.ts
 *
 * The surfacing case: once enrichment-phase is decoupled from fec-phase
 * (.github/workflows/nightly.yml — enrichment runs even when fec-phase times
 * out), BOTH phases write `nightly_cron` rows for the same UTC date. On a
 * Sunday where fec-phase is SIGTERM'd mid-FEC-bulk, the rows are:
 *   - fec-phase:        status='running'  metadata.phase='fec'   (orphaned)
 *   - enrichment-phase: status='complete' metadata.phase='enrichment'
 * Without phase scoping, mark-killed sees enrichment's terminal row and
 * wrongly concludes the night finished → no killed marker → canary says
 * `missing`. selectKillTarget(rows, 'fec') must still surface the fec orphan.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { bindingSource, matchOwnRun, normalizeJobStartedAt, selectKillTarget } from "./mark-killed";
import { githubRunIdentity } from "../pipelines/sync-log";

type Row = Parameters<typeof selectKillTarget>[0][number];

const fecRunning: Row = {
  id: "fec-1",
  status: "running",
  started_at: "2026-05-31T06:20:00Z",
  completed_at: null,
  metadata: { phase: "fec" },
};
const enrichComplete: Row = {
  id: "enr-1",
  status: "complete",
  started_at: "2026-05-31T08:30:00Z",
  completed_at: "2026-05-31T09:10:00Z",
  metadata: { phase: "enrichment" },
};

test("fec-phase kill is detected even when enrichment-phase completed same date", () => {
  const rows = [enrichComplete, fecRunning];
  const { finished, orphan } = selectKillTarget(rows, "fec");
  assert.equal(finished, undefined);
  assert.equal(orphan?.id, "fec-1");
});

test("enrichment-phase is a no-op when its own run finished", () => {
  const rows = [enrichComplete, fecRunning];
  const { finished, orphan } = selectKillTarget(rows, "enrichment");
  assert.equal(finished?.id, "enr-1");
  assert.equal(orphan, undefined);
});

test("fec-phase clean run (terminal row present) is a no-op", () => {
  const fecComplete: Row = { ...fecRunning, status: "partial", completed_at: "2026-05-30T07:00:00Z" };
  const { finished, orphan } = selectKillTarget([fecComplete], "fec");
  assert.equal(finished?.id, "fec-1");
  assert.equal(orphan, undefined);
});

test("no same-phase rows → nothing to do", () => {
  const { finished, orphan } = selectKillTarget([enrichComplete], "fec");
  assert.equal(finished, undefined);
  assert.equal(orphan, undefined);
});

test("unscoped (no phase) preserves legacy behavior", () => {
  // First terminal row wins regardless of phase.
  const r1 = selectKillTarget([enrichComplete, fecRunning]);
  assert.equal(r1.finished?.id, "enr-1");
  // Only running rows → orphan surfaces.
  const r2 = selectKillTarget([fecRunning]);
  assert.equal(r2.orphan?.id, "fec-1");
});

test("rows missing metadata are excluded from a phase-scoped scan", () => {
  const legacy: Row = {
    id: "legacy-1",
    status: "running",
    started_at: "2026-05-31T06:20:00Z",
    completed_at: null,
    metadata: null,
  };
  const { orphan } = selectKillTarget([legacy], "fec");
  assert.equal(orphan, undefined);
});

// ---------------------------------------------------------------------------
// FIX-963 — the no-op guard is bound to THIS job's own run.
//
// The measured case (2026-08-05, fec-backfill): a 22:43 UTC dispatch succeeded,
// the 01:03 dispatch OOM'd at 01:17, and mark-killed --window-hours 7 no-op'd
// because the earlier success was still in the window. The crashed row stranded
// at status='running'. Both directions matter: the crashed run must now reap its
// own row, AND a genuine own-run success must still no-op.
// ---------------------------------------------------------------------------

const RUN_CRASHED = "30965259079";
const RUN_EARLIER = "30949000001";

const earlierSuccess: Row = {
  id: "fec-bulk-earlier",
  status: "complete",
  started_at: "2026-08-04T22:43:00Z",
  completed_at: "2026-08-05T00:10:00Z",
  metadata: { github_run_id: RUN_EARLIER, github_run_attempt: "1" },
};
const crashedRunning: Row = {
  id: "fec-bulk-crashed",
  status: "running",
  started_at: "2026-08-05T01:03:00Z",
  completed_at: null,
  metadata: { github_run_id: RUN_CRASHED, github_run_attempt: "1" },
};
// rows arrive started_at DESC from the query
const fecBulkRows: Row[] = [crashedRunning, earlierSuccess];

test("FIX-963 run-id binding: success-then-crash now reaps the crashed run's own row", () => {
  const r = selectKillTarget(fecBulkRows, undefined, {
    runId: RUN_CRASHED,
    runAttempt: "1",
  });
  assert.equal(r.binding, "run-id");
  assert.equal(r.finished, undefined, "the EARLIER run's success must not count as this run finishing");
  assert.equal(r.orphan?.id, "fec-bulk-crashed");
  assert.equal(r.orphanIsOwnRun, true);
  assert.deepEqual(r.foreignFinished.map((x) => x.id), ["fec-bulk-earlier"]);
});

test("FIX-963 run-id binding: a genuine own-run success still no-ops", () => {
  const ownSuccess: Row = { ...crashedRunning, status: "complete", completed_at: "2026-08-05T02:40:00Z" };
  const r = selectKillTarget([ownSuccess, earlierSuccess], undefined, {
    runId: RUN_CRASHED,
    runAttempt: "1",
  });
  assert.equal(r.finished?.id, "fec-bulk-crashed");
  assert.equal(r.orphan, undefined);
});

test("FIX-963 run-id binding: a re-run (attempt 2) does not inherit attempt 1's success", () => {
  const attempt1Success: Row = {
    ...crashedRunning,
    status: "complete",
    completed_at: "2026-08-05T02:40:00Z",
    metadata: { github_run_id: RUN_CRASHED, github_run_attempt: "1" },
  };
  const attempt2Running: Row = {
    id: "fec-bulk-attempt2",
    status: "running",
    started_at: "2026-08-05T04:00:00Z",
    completed_at: null,
    metadata: { github_run_id: RUN_CRASHED, github_run_attempt: "2" },
  };
  const r = selectKillTarget([attempt2Running, attempt1Success], undefined, {
    runId: RUN_CRASHED,
    runAttempt: "2",
  });
  assert.equal(r.finished, undefined);
  assert.equal(r.orphan?.id, "fec-bulk-attempt2");
  assert.equal(r.orphanIsOwnRun, true);
});

test("FIX-963 job-start fallback: pre-971a rows (no run id) bind on started_at", () => {
  const legacyEarlierSuccess: Row = { ...earlierSuccess, metadata: null };
  const legacyCrashed: Row = { ...crashedRunning, metadata: null };
  const r = selectKillTarget([legacyCrashed, legacyEarlierSuccess], undefined, {
    jobStartedAt: "2026-08-05T01:03:00Z",
  });
  assert.equal(r.binding, "job-start");
  assert.equal(r.finished, undefined, "22:43 success predates the 01:03 job start");
  assert.equal(r.orphan?.id, "fec-bulk-crashed");
  assert.equal(r.orphanIsOwnRun, true);
});

test("FIX-963 job-start fallback: a terminal row at/after job start still no-ops", () => {
  const legacyOwnSuccess: Row = {
    id: "fec-bulk-own",
    status: "complete",
    started_at: "2026-08-05T01:03:00Z",
    completed_at: "2026-08-05T02:40:00Z",
    metadata: null,
  };
  const r = selectKillTarget([legacyOwnSuccess], undefined, {
    jobStartedAt: "2026-08-05T01:03:00Z",
  });
  assert.equal(r.finished?.id, "fec-bulk-own");
  assert.equal(r.orphan, undefined);
});

test("FIX-963 no binding evidence → legacy any-terminal-row behavior is unchanged", () => {
  const r = selectKillTarget(fecBulkRows);
  assert.equal(r.binding, "none");
  assert.equal(r.finished?.id, "fec-bulk-earlier");
  assert.equal(r.orphan, undefined);
});

test("FIX-963 phase scoping still applies on top of own-run binding", () => {
  const fecOwnRunning: Row = { ...fecRunning, metadata: { phase: "fec", github_run_id: RUN_CRASHED } };
  const enrOwnComplete: Row = {
    ...enrichComplete,
    metadata: { phase: "enrichment", github_run_id: RUN_CRASHED },
  };
  const r = selectKillTarget([enrOwnComplete, fecOwnRunning], "fec", { runId: RUN_CRASHED });
  assert.equal(r.finished, undefined, "same run id, different phase, must not suppress");
  assert.equal(r.orphan?.id, "fec-1");
});

test("matchOwnRun classifies own / foreign / unknown", () => {
  assert.equal(matchOwnRun(crashedRunning, { runId: RUN_CRASHED }), "own");
  assert.equal(matchOwnRun(earlierSuccess, { runId: RUN_CRASHED }), "foreign");
  // Row has no run id and no clock supplied → nothing can be proven.
  assert.equal(matchOwnRun({ ...crashedRunning, metadata: null }, { runId: RUN_CRASHED }), "unknown");
  // Own-run id missing (local invocation) but the row has one → unknown.
  assert.equal(matchOwnRun(crashedRunning, {}), "unknown");
  assert.equal(bindingSource(undefined), "none");
  assert.equal(bindingSource({ runId: "1" }), "run-id");
  assert.equal(bindingSource({ jobStartedAt: "2026-08-05T01:03:00Z" }), "job-start");
});

test("normalizeJobStartedAt rejects garbage rather than binding to NaN", () => {
  assert.equal(normalizeJobStartedAt("2026-08-05T01:03:00Z"), "2026-08-05T01:03:00.000Z");
  assert.equal(normalizeJobStartedAt("not-a-date"), undefined);
  assert.equal(normalizeJobStartedAt(""), undefined);
  assert.equal(normalizeJobStartedAt(undefined), undefined);
});

// ---------------------------------------------------------------------------
// FIX-971a — run identity is captured from the GHA environment.
// ---------------------------------------------------------------------------

test("FIX-971a githubRunIdentity captures the three GHA run keys", () => {
  assert.deepEqual(
    githubRunIdentity({
      GITHUB_RUN_ID: "30965259079",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_WORKFLOW: "fec-backfill",
    }),
    {
      github_run_id: "30965259079",
      github_run_attempt: "2",
      github_workflow: "fec-backfill",
    },
  );
});

test("FIX-971a githubRunIdentity is empty off CI, so local rows are unchanged", () => {
  assert.deepEqual(githubRunIdentity({}), {});
  // Partial environments contribute only what they have.
  assert.deepEqual(githubRunIdentity({ GITHUB_RUN_ID: "7" }), { github_run_id: "7" });
});
