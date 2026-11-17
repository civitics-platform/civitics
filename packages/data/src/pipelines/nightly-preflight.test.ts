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
  decideUnreadable,
  failOpenOutputs,
  nightlyRunStamp,
  nominalDay,
  parseWorkflowRuns,
  preflightOutputs,
  readDispatchedBy,
  resolvePreflight,
  runCoversDay,
  standDownOutputs,
  type DispatchedNightlyRun,
  type PreflightIo,
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

// ── FIX-1418 — an unreadable DB stands down when GitHub shows the night's run ─

/**
 * GitHub's `GET /repos/civitics-platform/civitics/actions/workflows/nightly.yml/
 * runs?event=workflow_dispatch&per_page=20`, read 2026-11-17 (cc-291), trimmed
 * to the newest three runs and the fields the parser reads plus `event`.
 * 43761700351 is the dispatched run that finished nominal day 2026-11-16 at
 * 23:35:17Z. The `schedule:` fallback 43781070231 (created 00:33:25Z) could not
 * read data_sync_log at 00:34:20Z and redid the night.
 */
const GITHUB_BODY = {
  total_count: 82,
  workflow_runs: [
    { id: 43956461273, event: "workflow_dispatch", created_at: "2026-11-16T21:05:23Z", status: "completed", conclusion: "success" },
    { id: 43761700351, event: "workflow_dispatch", created_at: "2026-11-15T21:05:22Z", status: "completed", conclusion: "success" },
    { id: 43640928940, event: "workflow_dispatch", created_at: "2026-11-14T21:05:22Z", status: "completed", conclusion: "success" },
  ],
};
const MON_DAY = "2026-11-16";
const MON_FALLBACK = "43781070231";

test("parseWorkflowRuns: GitHub's run list → id / created_at / status / conclusion; another shape is null", () => {
  assert.deepEqual(parseWorkflowRuns(GITHUB_BODY)?.[1], {
    id: "43761700351",
    created_at: "2026-11-15T21:05:22Z",
    status: "completed",
    conclusion: "success",
  });
  assert.equal(parseWorkflowRuns(GITHUB_BODY)?.length, 3);
  for (const bad of [null, undefined, "nope", { message: "Bad credentials" }, { workflow_runs: "x" }]) {
    assert.equal(parseWorkflowRuns(bad), null, JSON.stringify(bad));
  }
  // A run missing its id or created_at is dropped, not guessed.
  assert.deepEqual(parseWorkflowRuns({ workflow_runs: [{ id: 1 }, { created_at: "2026-11-15T21:05:22Z" }, null] }), []);
  // An in-flight run has no conclusion yet.
  assert.deepEqual(
    parseWorkflowRuns({ workflow_runs: [{ id: 7, created_at: "2026-11-15T21:05:22Z", status: "in_progress", conclusion: null }] }),
    [{ id: "7", created_at: "2026-11-15T21:05:22Z", status: "in_progress", conclusion: null }],
  );
});

test("runCoversDay: a dispatched run's created_at names its day through nominalDay(·, 3)", () => {
  assert.equal(runCoversDay("2026-11-15T21:05:22Z", MON_DAY), true);
  // A dispatch that started late still names the same day (the window is [21:00, 21:00)).
  assert.equal(runCoversDay("2026-11-16T20:59:59Z", MON_DAY), true);
  assert.equal(runCoversDay("2026-11-16T21:05:23Z", MON_DAY), false, "the next slot's run names 11-17");
  assert.equal(runCoversDay("2026-11-14T21:05:22Z", MON_DAY), false, "the previous slot's run names 11-15");
  assert.equal(runCoversDay("not a date", MON_DAY), false);
});

test("D2: Mon 11-16 replayed — a covering run stands every phase down, naming it", () => {
  const runs = parseWorkflowRuns(GITHUB_BODY);
  const v = decideUnreadable({ day: MON_DAY, runId: MON_FALLBACK, runs, tries: 3 });
  assert.equal(v.standDown, true, v.reason);
  assert.deepEqual(v.covering.map((r) => r.id), ["43761700351"]);
  assert.match(
    v.reason,
    /^DB unreadable after 3 tries; GitHub shows dispatched run 43761700351 \(completed \/ success, created 2026-11-15T21:05:22Z\) for nominal day 2026-11-16/,
  );
  assert.deepEqual(standDownOutputs(MON_DAY), {
    already_ran: "true",
    already_ran_enrichment_heavy: "true",
    already_ran_enrichment_light: "true",
    already_ran_enrichment_tail: "true",
    nominal_day: MON_DAY,
  });
});

test("D2: any status or conclusion covers — a run still in flight, cancelled, or failed", () => {
  const cases: Array<[string, string | null]> = [
    ["in_progress", null],
    ["queued", null],
    ["completed", "cancelled"],
    ["completed", "failure"],
  ];
  for (const [status, conclusion] of cases) {
    const v = decideUnreadable({
      day: MON_DAY,
      runId: MON_FALLBACK,
      runs: [{ id: "43761700351", created_at: "2026-11-15T21:05:22Z", status, conclusion }],
      tries: 3,
    });
    assert.equal(v.standDown, true, `${status}/${String(conclusion)}`);
    assert.ok(v.reason.includes(`(${status} / ${conclusion ?? "—"},`), v.reason);
  }
});

test("D3: only this run's own id → FAIL OPEN", () => {
  // A dispatched run that is itself unreadable must not stand itself down.
  const v = decideUnreadable({
    day: MON_DAY,
    runId: "43761700351",
    runs: [{ id: "43761700351", created_at: "2026-11-15T21:05:22Z", status: "in_progress", conclusion: null }],
    tries: 3,
  });
  assert.equal(v.standDown, false);
  assert.match(v.reason, /none of the 1 workflow_dispatch run\(s\) GitHub lists names nominal day 2026-11-16 — FAIL OPEN/);
});

test("D3: a run for the previous nominal day → FAIL OPEN (the dispatcher never armed tonight)", () => {
  const v = decideUnreadable({
    day: MON_DAY,
    runId: MON_FALLBACK,
    runs: [{ id: "43640928940", created_at: "2026-11-14T21:05:22Z", status: "completed", conclusion: "success" }],
    tries: 3,
  });
  assert.equal(v.standDown, false);
  assert.deepEqual(v.covering, []);
});

test("D3: GitHub unreadable (null) → FAIL OPEN, today's line", () => {
  const v = decideUnreadable({ day: MON_DAY, runId: MON_FALLBACK, runs: null, tries: 3 });
  assert.equal(v.standDown, false);
  assert.match(v.reason, /GitHub's run list unreadable too — FAIL OPEN: already_ran=false for every phase, this run does the night's work$/);
});

/** A recording PreflightIo: reads fail `failures` times, then answer `rows`. */
function fakeIo(opts: {
  failures: number;
  rows?: PriorNightlyRow[];
  runs?: DispatchedNightlyRun[] | null;
  githubThrows?: boolean;
}) {
  const calls = { reads: 0, github: 0, sleeps: [] as number[], info: [] as string[], warn: [] as string[] };
  const io: PreflightIo = {
    readRows: async () => {
      calls.reads++;
      if (calls.reads <= opts.failures) throw new Error("canceling statement due to statement timeout");
      return opts.rows ?? [];
    },
    listDispatchedRuns: async () => {
      calls.github++;
      if (opts.githubThrows) throw new Error("boom");
      return opts.runs === undefined ? null : opts.runs;
    },
    sleep: async (ms) => {
      calls.sleeps.push(ms);
    },
    info: (l) => calls.info.push(l),
    warn: (l) => calls.warn.push(l),
  };
  return { io, calls };
}

test("D1: the read is retried 20 s then 40 s — the sleeps are injected, not served", async () => {
  const { io, calls } = fakeIo({ failures: 2, rows: [row({ phase: "fec", github_run_id: "43761700351" })] });
  const out = await resolvePreflight({ day: MON_DAY, dispatchedBy: "schedule", runId: MON_FALLBACK }, io);
  assert.equal(calls.reads, 3);
  assert.deepEqual(calls.sleeps, [20_000, 40_000]);
  assert.equal(calls.github, 0, "a read that succeeds on the third try never asks GitHub");
  assert.equal(out["already_ran"], "true");
  assert.equal(out["already_ran_enrichment_heavy"], "false");
  assert.equal(calls.warn.length, 2);
  assert.match(
    calls.warn[0] ?? "",
    /data_sync_log read 1 of 3 failed \(canceling statement due to statement timeout\) — trying again in 20 s/,
  );
});

test("D1 + D2: three failed reads, then GitHub shows the run → every phase stands down with a notice", async () => {
  const { io, calls } = fakeIo({ failures: 3, runs: parseWorkflowRuns(GITHUB_BODY) });
  const out = await resolvePreflight({ day: MON_DAY, dispatchedBy: "schedule", runId: MON_FALLBACK }, io);
  assert.equal(calls.reads, 3);
  assert.deepEqual(calls.sleeps, [20_000, 40_000]);
  assert.equal(calls.github, 1);
  assert.deepEqual(out, standDownOutputs(MON_DAY));
  const notice = calls.info.find((l) => l.startsWith("::notice::"));
  assert.match(notice ?? "", /DB unreadable after 3 tries; GitHub shows dispatched run 43761700351 \(completed \/ success/);
});

test("D3 through resolvePreflight: GitHub null, empty, or a reader that throws fails open", async () => {
  const cases: Array<Parameters<typeof fakeIo>[0]> = [
    { failures: 3 },
    { failures: 3, githubThrows: true },
    { failures: 3, runs: [] },
  ];
  for (const opts of cases) {
    const { io, calls } = fakeIo(opts);
    const out = await resolvePreflight({ day: MON_DAY, dispatchedBy: "dispatcher", runId: "43761700351" }, io);
    assert.deepEqual(out, failOpenOutputs(MON_DAY), JSON.stringify(opts));
    assert.equal(calls.github, 1);
    assert.ok(calls.warn.some((l) => /FAIL OPEN: already_ran=false for every phase/.test(l)), JSON.stringify(opts));
  }
});

test("an unguarded trigger never reads the DB and never asks GitHub", async () => {
  for (const by of ["manual", null, "someone-else"]) {
    const { io, calls } = fakeIo({ failures: 99, runs: parseWorkflowRuns(GITHUB_BODY) });
    const out = await resolvePreflight({ day: MON_DAY, dispatchedBy: by, runId: "444" }, io);
    assert.equal(calls.reads, 0, String(by));
    assert.equal(calls.github, 0, String(by));
    assert.deepEqual(calls.sleeps, []);
    assert.deepEqual(out, failOpenOutputs(MON_DAY), "a human dispatch always runs");
  }
});

test("nightly.yml gives the preflight step its token and fec-phase actions: read (D4)", () => {
  const yml = readFileSync(join(__dirname, "..", "..", "..", "..", ".github", "workflows", "nightly.yml"), "utf8").replace(
    /\r\n/g,
    "\n",
  );
  const job = yml.slice(yml.indexOf("\n  fec-phase:"), yml.indexOf("\n  enrichment-heavy-phase:"));
  assert.match(job, /\n {4}permissions:\n {6}contents: read\n {6}actions: read\n/);
  const step = job.slice(job.indexOf("id: preflight"), job.indexOf("- name: Run FEC phase"));
  assert.match(step, /GH_TOKEN: \$\{\{ github\.token \}\}/);
});
