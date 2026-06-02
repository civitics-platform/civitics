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
import { selectKillTarget } from "./mark-killed";

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
