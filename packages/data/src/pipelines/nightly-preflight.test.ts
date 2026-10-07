/**
 * FIX-1218 — the nightly's nominal-day preflight.
 *
 * Runs via:  tsx --test src/pipelines/nightly-preflight.test.ts
 *
 * The dispatched run (vercel-cron, 21:00 UTC) and the late scheduled fallback
 * name the same nominal day; the second one to arrive must find the first's
 * rows and stand down, while a human dispatch and a re-run of the same run must
 * never be refused.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DISPATCHED_BY_ENV,
  PREFLIGHT_OUTPUT,
  PREFLIGHT_PHASES,
  decideAllPhases,
  decidePreflight,
  failOpenOutputs,
  nightlyRunStamp,
  nominalDay,
  preflightOutputs,
  readDispatchedBy,
  type PreflightPhase,
  type PriorNightlyRow,
} from "./nightly-preflight";

const row = (over: Partial<PriorNightlyRow> = {}): PriorNightlyRow => ({
  id: "r1",
  status: "complete",
  started_at: "2026-09-24T21:00:40Z",
  phase: "fec",
  github_run_id: "111",
  dispatched_by: "vercel-cron",
  ...over,
});

test("nominalDay: the dispatch at the slot and the late fallback name the same UTC day", () => {
  // Thu 21:00:05 dispatched, offset 3 (the input) → Friday.
  assert.equal(nominalDay(new Date("2026-09-24T21:00:05Z"), 3), "2026-09-25");
  // The scheduled fallback at the measured band's two ends, offset 3 (the event).
  assert.equal(nominalDay(new Date("2026-09-24T22:35:19Z"), 3), "2026-09-25");
  assert.equal(nominalDay(new Date("2026-09-24T23:44:30Z"), 3), "2026-09-25");
  // A fallback queued behind a long Sunday night still names the same day.
  assert.equal(nominalDay(new Date("2026-09-25T20:59:59Z"), 3), "2026-09-25");
  // The window's far edge belongs to the next slot.
  assert.equal(nominalDay(new Date("2026-09-25T21:00:00Z"), 3), "2026-09-26");
  // Offset 0 (a plain manual dispatch) is the wall-clock UTC date.
  assert.equal(nominalDay(new Date("2026-09-24T21:00:05Z"), 0), "2026-09-24");
});

test("readDispatchedBy: a short slug or nothing", () => {
  assert.equal(readDispatchedBy("vercel-cron"), "vercel-cron");
  assert.equal(readDispatchedBy(" schedule "), "schedule");
  assert.equal(readDispatchedBy("manual"), "manual");
  for (const bad of [undefined, "", "   ", "Vercel-Cron", "a b", "x;rm -rf", "-lead", "a".repeat(33)]) {
    assert.equal(readDispatchedBy(bad), null, `${JSON.stringify(bad)} must be refused`);
  }
});

test("nightlyRunStamp: nominal_day always, dispatched_by only when the env names one", () => {
  const now = new Date("2026-09-24T21:00:05Z");
  assert.deepEqual(nightlyRunStamp(now, 3, { [DISPATCHED_BY_ENV]: "vercel-cron" }), {
    nominal_day: "2026-09-25",
    dispatched_by: "vercel-cron",
  });
  assert.deepEqual(nightlyRunStamp(now, 3, {}), { nominal_day: "2026-09-25" });
  assert.deepEqual(nightlyRunStamp(now, 3, { [DISPATCHED_BY_ENV]: "NOT A SLUG" }), {
    nominal_day: "2026-09-25",
  });
});

test("the fallback stands down when the dispatched run's rows exist", () => {
  const rows = [row(), row({ id: "r2", phase: "enrichment-heavy" })];
  for (const phase of ["fec", "enrichment-heavy"] as const) {
    const v = decidePreflight({ nominalDay: "2026-09-25", dispatchedBy: "schedule", runId: "222", rows, phase });
    assert.equal(v.alreadyRan, true, phase);
    // FIX-1281: each verdict matches its OWN phase's row, not every row of the day.
    assert.deepEqual(v.matched.map((r) => r.phase), [phase]);
    assert.match(v.reason, new RegExp(`^${phase}: nominal day 2026-09-25 already ran \\(run 111`));
  }
});

test("either automated trigger stands down — whichever arrives second", () => {
  // A dispatcher that fired LATE (after the schedule run already did the night).
  const v = decidePreflight({
    nominalDay: "2026-09-25",
    dispatchedBy: "vercel-cron",
    runId: "333",
    rows: [row({ github_run_id: "222", dispatched_by: "schedule" })],
    phase: "fec",
  });
  assert.equal(v.alreadyRan, true);
});

test("an empty day runs — the fallback covers a dead dispatcher", () => {
  for (const phase of PREFLIGHT_PHASES) {
    const v = decidePreflight({ nominalDay: "2026-09-25", dispatchedBy: "schedule", runId: "222", rows: [], phase });
    assert.equal(v.alreadyRan, false, phase);
    assert.deepEqual(v.matched, []);
  }
});

test("every status but skipped counts as ran — per phase", () => {
  for (const phase of PREFLIGHT_PHASES) {
    for (const status of ["running", "complete", "partial", "failed", "reaped"]) {
      const v = decidePreflight({
        nominalDay: "2026-09-25",
        dispatchedBy: "schedule",
        runId: "222",
        rows: [row({ phase, status })],
        phase,
      });
      assert.equal(v.alreadyRan, true, `${phase} ${status} must count as ran`);
    }
    // A FIX-950-held night did not run: the fallback may do it once the hold is off.
    const held = decidePreflight({
      nominalDay: "2026-09-25",
      dispatchedBy: "schedule",
      runId: "222",
      rows: [row({ status: "skipped" }), row({ id: "r2", phase: "enrichment-heavy", status: "skipped" })],
      phase,
    });
    assert.equal(held.alreadyRan, false, phase);
  }
});

test("a re-run of the SAME run (same GITHUB_RUN_ID, next attempt) is not a duplicate", () => {
  const v = decidePreflight({
    nominalDay: "2026-09-25",
    dispatchedBy: "vercel-cron",
    runId: "111",
    rows: [row({ github_run_id: "111" })],
    phase: "fec",
  });
  assert.equal(v.alreadyRan, false);
});

test("a human dispatch is never guarded, even on a claimed day", () => {
  for (const by of ["manual", null, "someone-else"]) {
    for (const phase of PREFLIGHT_PHASES) {
      const v = decidePreflight({
        nominalDay: "2026-09-25",
        dispatchedBy: by,
        runId: "444",
        rows: [row({ phase })],
        phase,
      });
      assert.equal(v.alreadyRan, false, `dispatched_by=${String(by)} must run ${phase}`);
      assert.match(v.reason, /not an automated firing path/);
    }
  }
});

test("a row with no run id (pre-FIX-971a shape) still counts", () => {
  const v = decidePreflight({
    nominalDay: "2026-09-25",
    dispatchedBy: "schedule",
    runId: "222",
    rows: [row({ github_run_id: null })],
    phase: "fec",
  });
  assert.equal(v.alreadyRan, true);
  assert.match(v.reason, /\(no run id\)/);
});

// ── FIX-1281 — the verdict is PER PHASE ─────────────────────────────────────

/**
 * Exactly the three rows run 37373195416 wrote for nominal day 2026-10-06
 * (receipts 2026-10-06 §1, Phases): its fec-phase was never acquired by a
 * hosted runner and was cancelled with zero steps, so there is NO fec row, while
 * heavy / light / tail ran on `!cancelled()` and closed `complete`.
 */
const MONDAY_ROWS: PriorNightlyRow[] = [
  row({ id: "h", phase: "enrichment-heavy", started_at: "2026-10-05T21:25:47.979Z", github_run_id: "37373195416" }),
  row({ id: "l", phase: "enrichment-light", started_at: "2026-10-05T21:29:55.757Z", github_run_id: "37373195416" }),
  row({ id: "t", phase: "enrichment-tail", started_at: "2026-10-05T21:30:51.743Z", github_run_id: "37373195416" }),
];

const fallback = (phase: PreflightPhase, rows: PriorNightlyRow[]) =>
  decidePreflight({ nominalDay: "2026-10-06", dispatchedBy: "schedule", runId: "37400026114", rows, phase });

test("a runnerless fec-phase: the Monday rows — the fallback does FEC, the enrichment phases stand down", () => {
  const fec = fallback("fec", MONDAY_ROWS);
  assert.equal(fec.alreadyRan, false, fec.reason);
  assert.deepEqual(fec.matched, []);
  for (const phase of ["enrichment-heavy", "enrichment-light", "enrichment-tail"] as const) {
    const v = fallback(phase, MONDAY_ROWS);
    assert.equal(v.alreadyRan, true, `${phase}: ${v.reason}`);
    assert.deepEqual(v.matched.map((r) => r.phase), [phase]);
    assert.match(v.reason, new RegExp(`^${phase}: nominal day 2026-10-06 already ran \\(run 37373195416: ${phase}=complete\\)`));
  }
  // And through the output names the workflow reads.
  const outputs = preflightOutputs(decideAllPhases({ nominalDay: "2026-10-06", dispatchedBy: "schedule", runId: "37400026114", rows: MONDAY_ROWS }), "2026-10-06");
  assert.deepEqual(outputs, {
    already_ran: "false",
    already_ran_enrichment_heavy: "true",
    already_ran_enrichment_light: "true",
    already_ran_enrichment_tail: "true",
    nominal_day: "2026-10-06",
  });
});

test("a healthy night: all four phases read already_ran and the fallback exits", () => {
  const rows = [row({ id: "f", phase: "fec", github_run_id: "37373195416" }), ...MONDAY_ROWS];
  const all = decideAllPhases({ nominalDay: "2026-10-06", dispatchedBy: "schedule", runId: "37400026114", rows });
  for (const phase of PREFLIGHT_PHASES) assert.equal(all[phase].alreadyRan, true, phase);
});

test("a null-phase (pre-FIX-462 whole-run) row counts for every phase", () => {
  for (const phase of PREFLIGHT_PHASES) {
    const v = fallback(phase, [row({ phase: null })]);
    assert.equal(v.alreadyRan, true, phase);
    assert.match(v.reason, /all=complete/);
  }
});

test("the orchestrator's own whole-run stamps cover the phases they ran", () => {
  // `all` runs every phase; `enrichment` runs the three enrichment sub-phases (index.ts runNightlySync).
  for (const phase of PREFLIGHT_PHASES) assert.equal(fallback(phase, [row({ phase: "all" })]).alreadyRan, true, phase);
  assert.equal(fallback("fec", [row({ phase: "enrichment" })]).alreadyRan, false);
  for (const phase of ["enrichment-heavy", "enrichment-light", "enrichment-tail"] as const) {
    assert.equal(fallback(phase, [row({ phase: "enrichment" })]).alreadyRan, true, phase);
  }
});

test("a skipped fec row (the FIX-950 hold) with complete enrichment rows: fec runs, enrichment stands down", () => {
  const rows = [row({ id: "f", phase: "fec", status: "skipped", github_run_id: "37373195416" }), ...MONDAY_ROWS];
  assert.equal(fallback("fec", rows).alreadyRan, false);
  for (const phase of ["enrichment-heavy", "enrichment-light", "enrichment-tail"] as const) {
    assert.equal(fallback(phase, rows).alreadyRan, true, phase);
  }
});

test("one phase's row never stands down another phase", () => {
  for (const ran of PREFLIGHT_PHASES) {
    for (const asked of PREFLIGHT_PHASES) {
      const v = fallback(asked, [row({ phase: ran })]);
      assert.equal(v.alreadyRan, ran === asked, `row ${ran}, verdict for ${asked}`);
    }
  }
});

test("FAIL OPEN writes every phase's output false", () => {
  assert.deepEqual(failOpenOutputs("2026-10-07"), {
    already_ran: "false",
    already_ran_enrichment_heavy: "false",
    already_ran_enrichment_light: "false",
    already_ran_enrichment_tail: "false",
    nominal_day: "2026-10-07",
  });
  assert.deepEqual(failOpenOutputs(null), {
    already_ran: "false",
    already_ran_enrichment_heavy: "false",
    already_ran_enrichment_light: "false",
    already_ran_enrichment_tail: "false",
  });
});

test("the phase list is the tree's: each phase has a :ci entrypoint, a job, and an output the workflow reads", () => {
  // Rule 122 — derive the list from the tree. The orchestrator stamps
  // metadata.phase from --phase=<p>; nightly.yml runs each phase through
  // data:nightly:<p>:ci and gates the job on the output named here.
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const yml = readFileSync(join(__dirname, "..", "..", "..", "..", ".github", "workflows", "nightly.yml"), "utf8");
  for (const phase of PREFLIGHT_PHASES) {
    const script = `data:nightly:${phase}:ci`;
    assert.match(pkg.scripts[script] ?? "", new RegExp(`--phase=${phase}( |$)`), script);
    assert.ok(yml.includes(`pnpm --filter @civitics/data ${script}`), `nightly.yml runs ${script}`);
    const out = PREFLIGHT_OUTPUT[phase];
    assert.ok(yml.includes(`${out}: \${{ steps.preflight.outputs.${out} }}`), `fec-phase declares output ${out}`);
  }
  // Each enrichment job gates on its OWN phase's output, never on the FEC one.
  for (const phase of ["enrichment-heavy", "enrichment-light", "enrichment-tail"] as const) {
    assert.ok(
      yml.includes(`if: \${{ !cancelled() && needs.fec-phase.outputs.${PREFLIGHT_OUTPUT[phase]} != 'true' }}`),
      `${phase}-phase gates on ${PREFLIGHT_OUTPUT[phase]}`,
    );
  }
  assert.ok(!/needs\.fec-phase\.outputs\.already_ran != 'true'/.test(yml), "no job gates on the FEC verdict alone");
});
