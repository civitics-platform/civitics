/**
 * FIX-1036 — the transition classifier's decision table.
 *
 * Runs via:  tsx --test src/__tests__/canary-transitions.test.ts
 *
 * Pure functions over plain data, so unlike detector-coverage.test.ts these
 * need no Postgres and are meaningful in CI. Each case pins a shape that was
 * either the defect being fixed or a false positive the fix has to survive.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type Condition,
  STILL_RED_AFTER_RUNS,
  WORSEN_FACTOR,
  classifyTransitions,
  decideAlert,
  describeTransitions,
  withUnchangedRuns,
} from "../scripts/canary-transitions";

const cond = (
  key: string,
  tier: "escalate" | "report",
  severity: number,
  unchangedRuns?: number,
): Condition => ({ key, tier, severity, detail: `${key} @ ${severity}`, unchangedRuns });

const kindOf = (ts: ReturnType<typeof classifyTransitions>, key: string) =>
  ts.find((t) => t.key === key)?.kind;

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test("FIX-1036 no previous verdict makes every condition NEW exactly once", () => {
  const cur = [cond("rollup:a", "escalate", 100), cond("orphan:b", "report", 1)];
  const ts = classifyTransitions(cur, null);
  assert.equal(ts.length, 2);
  assert.ok(ts.every((t) => t.kind === "new"));

  const decision = decideAlert(cur, ts, true);
  assert.equal(decision.send, true);
  assert.equal(decision.tier, "ESCALATE");
  // The email has to SAY this is a baseline, or the first run after deploy
  // reads as an overnight platform collapse.
  assert.equal(decision.firstRun, true);
});

test("FIX-1036 a stale rollup ageing by a day is UNCHANGED, not worsening", () => {
  // THE DEFECT. Severity for a rollup is hours-since-complete, which climbs on
  // its own every night. Under a strict `severity > previous` test this pipeline
  // would read as "worsening" every single run and page nightly forever — the
  // exact behaviour FIX-1036 exists to end.
  const prev = [cond("rollup:donor_party_rollup_refresh", "escalate", 879)];
  const cur  = [cond("rollup:donor_party_rollup_refresh", "escalate", 903)];
  const ts = classifyTransitions(cur, prev);
  assert.equal(kindOf(ts, "rollup:donor_party_rollup_refresh"), "unchanged");
  assert.equal(decideAlert(cur, ts, false).send, false);
});

test("FIX-1036 a genuinely large jump IS worsening", () => {
  const prev = [cond("rollup:a", "escalate", 30)];
  const cur  = [cond("rollup:a", "escalate", 30 * WORSEN_FACTOR)];
  const ts = classifyTransitions(cur, prev);
  assert.equal(kindOf(ts, "rollup:a"), "worsening");
  assert.equal(decideAlert(cur, ts, false).tier, "ESCALATE");
});

test("FIX-1036 report -> escalate is worsening even when severity barely moves", () => {
  // The TIER is the judgement. A rollup crossing from one cadence cycle late to
  // two-plus must page even though hours-since-complete only ticked up a little.
  const prev = [cond("rollup:a", "report", 100)];
  const cur  = [cond("rollup:a", "escalate", 101)];
  const ts = classifyTransitions(cur, prev);
  assert.equal(kindOf(ts, "rollup:a"), "worsening");
  assert.equal(decideAlert(cur, ts, false).tier, "ESCALATE");
});

test("FIX-1036 one key per rollup: crossing tiers is not recovery-plus-new", () => {
  // Keying a rollup by its tier (`rollup_stale:` vs `rollup_escalating:`) would
  // make a worsening pipeline look like one problem clearing and a different
  // one appearing. Same key, changing tier, is the honest encoding.
  const ts = classifyTransitions(
    [cond("rollup:a", "escalate", 500)],
    [cond("rollup:a", "report", 200)],
  );
  assert.equal(ts.length, 1);
  assert.equal(ts[0]!.kind, "worsening");
});

test("FIX-1036 a condition that disappears is RECOVERED", () => {
  const prev = [cond("vm_degraded:financial_relationships", "escalate", 65)];
  const ts = classifyTransitions([], prev);
  assert.equal(kindOf(ts, "vm_degraded:financial_relationships"), "recovered");
  const d = decideAlert([], ts, false);
  assert.equal(d.send, true);
  assert.equal(d.tier, "RECOVERED");
});

test("FIX-1036 something clearing while other things still escalate is STILL RED, not RECOVERED", () => {
  const prev = [cond("rollup:a", "escalate", 500), cond("rollup:b", "escalate", 500)];
  const cur  = [cond("rollup:a", "escalate", 520)];
  const ts = classifyTransitions(cur, prev);
  const d = decideAlert(cur, ts, false);
  assert.equal(d.send, true);
  assert.equal(d.tier, "STILL RED");
});

test("FIX-1036 report-only movement sends a REPORT, never an ESCALATE", () => {
  const prev: Condition[] = [];
  const cur  = [cond("orphan:entity_connection_stats_rebuild", "report", 1)];
  const ts = classifyTransitions(cur, prev);
  const d = decideAlert(cur, ts, false);
  assert.equal(d.tier, "REPORT");
});

// ---------------------------------------------------------------------------
// The silence floor
// ---------------------------------------------------------------------------

test("FIX-1036 an unchanged escalating condition stays quiet until the STILL RED floor", () => {
  let prev: Condition[] = [cond("rollup:a", "escalate", 500, 0)];
  // Runs 1..STILL_RED_AFTER_RUNS-1: quiet.
  for (let run = 1; run < STILL_RED_AFTER_RUNS; run++) {
    const cur = [cond("rollup:a", "escalate", 500)];
    const ts = classifyTransitions(cur, prev);
    assert.equal(ts[0]!.kind, "unchanged");
    assert.equal(
      decideAlert(cur, ts, false).send,
      false,
      `run ${run} must stay quiet — nightly pages on a static condition are the defect`,
    );
    prev = withUnchangedRuns(cur, ts);
  }
  // The floor run: a reminder goes out even with nothing new.
  const cur = [cond("rollup:a", "escalate", 500)];
  const ts = classifyTransitions(cur, prev);
  const d = decideAlert(cur, ts, false);
  assert.equal(ts[0]!.unchangedRuns, STILL_RED_AFTER_RUNS);
  assert.equal(d.send, true);
  assert.equal(d.tier, "STILL RED");
});

test("FIX-1036 an unchanged REPORT-only condition never trips the STILL RED floor", () => {
  const prev = [cond("orphan:x", "report", 1, STILL_RED_AFTER_RUNS + 5)];
  const cur  = [cond("orphan:x", "report", 1)];
  const ts = classifyTransitions(cur, prev);
  assert.equal(decideAlert(cur, ts, false).send, false);
});

test("FIX-1036 a clean run after a clean run sends nothing", () => {
  const ts = classifyTransitions([], []);
  assert.deepEqual(ts, []);
  assert.equal(decideAlert([], ts, false).send, false);
});

test("FIX-1036 unchanged counters reset when a condition worsens", () => {
  const prev = [cond("rollup:a", "escalate", 100, 5)];
  const cur  = [cond("rollup:a", "escalate", 400)];
  const ts = classifyTransitions(cur, prev);
  assert.equal(ts[0]!.kind, "worsening");
  assert.equal(withUnchangedRuns(cur, ts)[0]!.unchangedRuns, 0);
});

test("FIX-1036 the digest names what moved, escalating first", () => {
  const cur = [cond("rollup:a", "escalate", 500), cond("orphan:b", "report", 1)];
  const lines = describeTransitions(classifyTransitions(cur, null));
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /\[NEW\] \(escalating\)/);
  assert.match(lines[1]!, /\[NEW\] \(report-only\)/);
});

// ---------------------------------------------------------------------------
// FIX-1073 — the tier thresholds, exercised as the canary applies them.
// ---------------------------------------------------------------------------

/** Mirrors main()'s keying: one key per job for streaks, ONE flat key for the
 *  burst (bucket timestamps change every run, so keying on them would make
 *  every burst permanently `new`). */
function tierConditions(
  perJob: { jobid: number; streak: number }[],
  burstCounts: number[],
  streakThreshold: number,
  burstThreshold: number,
): Condition[] {
  const out: Condition[] = [];
  for (const s of perJob.filter((s) => s.streak >= streakThreshold)) {
    out.push(cond(`cron_startup_streak:${s.jobid}`, "escalate", s.streak));
  }
  const over = burstCounts.filter((n) => n >= burstThreshold);
  if (over.length > 0) out.push(cond("cron_startup_burst", "escalate", Math.max(...over)));
  return out;
}

const N = 6;  // streak threshold shipped in the FIX-1073 migration
const M = 10; // burst threshold shipped in the FIX-1073 migration

test("FIX-1073 the quiet-day ceiling measured on prod sits under BOTH thresholds", () => {
  // 2026-08-04..08-11, the days before the crawl-era connection pressure:
  // max consecutive streak 4, max 60-minute bucket 6.
  const quietDays: [number, number][] = [[2, 2], [1, 1], [3, 2], [0, 1], [1, 1], [3, 6], [4, 6]];
  for (const [maxStreak, maxBucket] of quietDays) {
    const c = tierConditions([{ jobid: 40, streak: maxStreak }], [maxBucket], N, M);
    assert.deepEqual(c, [], `a quiet day (streak ${maxStreak}, bucket ${maxBucket}) must not escalate`);
  }
});

test("FIX-1073 every incident day measured on prod trips a tier", () => {
  // 08-17, 08-18, 08-19, 08-24, 08-25, 08-26, 08-29, 08-31, 09-01.
  const incidentDays: [number, number][] = [
    [29, 35], [13, 48], [49, 91], [22, 49], [28, 59], [4, 11], [20, 39], [29, 44], [9, 38],
  ];
  for (const [maxStreak, maxBucket] of incidentDays) {
    const c = tierConditions([{ jobid: 40, streak: maxStreak }], [maxBucket], N, M);
    assert.ok(c.length > 0, `an incident day (streak ${maxStreak}, bucket ${maxBucket}) must escalate`);
  }
  // 08-26 is the case that justifies keeping BOTH tiers: its worst streak (4)
  // is a quiet-day number, and only the burst tier catches it.
  assert.deepEqual(tierConditions([{ jobid: 40, streak: 4 }], [11], N, M).map((c) => c.key), ["cron_startup_burst"]);
});

test("FIX-1073 a lone startup timeout is no longer a finding", () => {
  // The staged behaviour: canary-check.ts failed the run on ONE row in
  // startup_timeouts. Over the 30 days to 2026-09-02 that is 16 of 30 days red.
  assert.deepEqual(tierConditions([{ jobid: 24, streak: 1 }], [1], N, M), []);
});

test("FIX-1073 a persistent burst on consecutive nights does not re-page", () => {
  // The flat burst key is what makes this true: keyed by hourly bucket, every
  // night's burst would be a different key and therefore permanently `new`.
  const night1 = tierConditions([], [38], N, M);
  const ts1 = classifyTransitions(night1, null);
  assert.equal(decideAlert(night1, ts1, true).send, true);

  const night2 = tierConditions([], [40], N, M);
  const ts2 = classifyTransitions(night2, withUnchangedRuns(night1, ts1));
  assert.equal(ts2[0]!.kind, "unchanged");
  assert.equal(decideAlert(night2, ts2, false).send, false);
});

test("FIX-1073 a burst that gets dramatically worse does re-page", () => {
  const prev = [cond("cron_startup_burst", "escalate", 12)];
  const cur  = [cond("cron_startup_burst", "escalate", 91)];
  const ts = classifyTransitions(cur, prev);
  assert.equal(ts[0]!.kind, "worsening");
  assert.equal(decideAlert(cur, ts, false).tier, "ESCALATE");
});
