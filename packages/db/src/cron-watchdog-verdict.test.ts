import test from "node:test";
import assert from "node:assert/strict";

import { decideCronWatchdogVerdict } from "./cron-watchdog-verdict";

// ---------------------------------------------------------------------------
// The three fixtures are REAL shapes, not invented ones.
//
// `cancelFixture` is the D2 proof's payload verbatim (cc-142, local PostgREST,
// 2026-09-22T00:28:14Z) — the scratch `cc142-sleep` job cancelled at 14.8 s
// against a 5 s budget. `noopFixture` is the same call seventeen seconds later
// with nothing over budget, which is what 719 of every 720 daily calls look
// like. `innerErrorFixture` is the wrapper's own EXCEPTION handler output.
// ---------------------------------------------------------------------------

function cancelFixture(): unknown {
  return {
    at: "2026-09-22T00:28:14.803699+00:00",
    via: "vercel",
    unit: { action: "none", reason: "no running refresh_derived_mvs" },
    budget: {
      checked: 1,
      canceled: 1,
      actions: [
        {
          pid: 3292,
          jobid: 84,
          runid: 17435,
          jobname: "cc142-sleep",
          signaled: true,
          age_seconds: 14.8,
          budget_seconds: 5,
        },
      ],
      ec_window: { action: "none", reason: "no window in flight" },
    },
    labelled: 1,
  };
}

function noopFixture(): unknown {
  return {
    at: "2026-09-22T00:28:31.288653+00:00",
    via: "vercel",
    unit: { action: "none", reason: "no running refresh_derived_mvs" },
    budget: {
      checked: 0,
      canceled: 0,
      actions: [],
      ec_window: { action: "none", reason: "no window in flight" },
    },
    labelled: 0,
  };
}

function innerErrorFixture(): unknown {
  return {
    at: "2026-09-22T00:30:00.000000+00:00",
    via: "vercel",
    // The budget arm threw; the wrapper's handler caught it and still ran the
    // unit arm, which answered normally. This is the property under test.
    budget: { error: "permission denied for schema cron", sqlstate: "42501" },
    unit: { action: "canceled", unit: "chord_industry_flows_mv", pid: 4711, signaled: true },
    labelled: 0,
  };
}

// ---------------------------------------------------------------------------

test("cron-watchdog verdict: a cancel is ok, counted, and names the job", () => {
  const v = decideCronWatchdogVerdict(cancelFixture());
  assert.equal(v.ok, true);
  assert.equal(v.checked, 1);
  assert.equal(v.canceled, 1);
  assert.equal(v.unitAction, "none");
  assert.equal(v.labelled, 1);
  assert.deepEqual(v.cancelledJobs, ["cc142-sleep"]);
  assert.deepEqual(v.errors, []);
  assert.equal(
    v.line,
    "[cron/cron-watchdog] budget checked=1 canceled=1 unit=none via=vercel " +
      "at=2026-09-22T00:28:14.803699+00:00 jobs=cc142-sleep labelled=1",
  );
});

test("cron-watchdog verdict: a no-op is ok — 'canceled=0' is the healthy answer, not a failure", () => {
  const v = decideCronWatchdogVerdict(noopFixture());
  assert.equal(v.ok, true);
  assert.equal(v.canceled, 0);
  assert.deepEqual(v.cancelledJobs, []);
  assert.deepEqual(v.errors, []);
  // No `jobs=` and no `labelled=` segment when there is nothing to say.
  assert.equal(
    v.line,
    "[cron/cron-watchdog] budget checked=0 canceled=0 unit=none via=vercel " +
      "at=2026-09-22T00:28:31.288653+00:00",
  );
});

test("FIX-1208: the log line carries the DB clock, and says so even when it is absent", () => {
  // `at` has been in the payload since FIX-1194; FIX-1208 prints it, so the
  // Vercel log itself carries the DB's clock and can be compared against
  // pipeline_state.cron_watchdog_vercel without a query. A payload from before
  // that migration has no `at`, and the line must say `?` rather than
  // `at=undefined` or silently dropping the segment — a missing clock is
  // exactly the reading that matters when the stamp is also missing.
  const withAt = decideCronWatchdogVerdict(noopFixture());
  assert.match(withAt.line, / at=2026-09-22T00:28:31\.288653\+00:00$/);

  const noAt = decideCronWatchdogVerdict({
    via: "vercel",
    budget: { checked: 0, canceled: 0, actions: [] },
    unit: { action: "none" },
    labelled: 0,
  });
  assert.equal(noAt.ok, true, "a missing `at` is not a parse failure — the watchdogs still answered");
  assert.match(noAt.line, / at=\?$/);
});

test("cron-watchdog verdict: one arm throwing surfaces WITHOUT hiding the other's real result", () => {
  const v = decideCronWatchdogVerdict(innerErrorFixture());
  assert.equal(v.ok, false);
  assert.equal(v.checked, null, "the arm that threw reports no count rather than a false zero");
  assert.equal(v.canceled, 0);
  // The whole point: the unit arm's genuine 'canceled' survives the sibling's failure.
  assert.equal(v.unitAction, "canceled");
  assert.equal(v.errors.length, 1);
  assert.match(v.errors[0] ?? "", /^budget: permission denied for schema cron \[42501\]$/);
  assert.match(v.line, /ERRORS: budget: permission denied for schema cron \[42501\]$/);
  assert.match(v.line, /unit=canceled/);
});

test("cron-watchdog verdict: FIX-1101's ec_window error surfaces too, from inside the budget payload", () => {
  const raw = cancelFixture() as { budget: { ec_window: unknown } };
  raw.budget.ec_window = { action: "error", reason: "relation ec_window does not exist" };
  const v = decideCronWatchdogVerdict(raw);
  assert.equal(v.ok, false);
  assert.deepEqual(v.errors, ["ec_window: relation ec_window does not exist"]);
  // The budget arm itself did NOT throw, so its numbers are still real.
  assert.equal(v.checked, 1);
  assert.equal(v.canceled, 1);
});

test("cron-watchdog verdict: an unparseable payload is a verdict, never a throw", () => {
  for (const bad of [null, undefined, 42, "ok", []]) {
    const v = decideCronWatchdogVerdict(bad);
    assert.equal(v.ok, false, JSON.stringify(bad));
    assert.equal(v.unitAction, "unknown");
    assert.equal(v.line, "[cron/cron-watchdog] UNPARSEABLE payload");
  }
});

test("cron-watchdog verdict: a missing arm is named, not silently defaulted", () => {
  const v = decideCronWatchdogVerdict({ via: "vercel", labelled: 0 });
  assert.equal(v.ok, false);
  assert.deepEqual(v.errors, ["budget: arm missing from payload", "unit: arm missing from payload"]);
  assert.equal(v.checked, null);
});

test("cron-watchdog verdict: an unrecognised unit action is flagged rather than passed through", () => {
  const v = decideCronWatchdogVerdict({
    via: "vercel",
    budget: { checked: 0, canceled: 0, actions: [] },
    unit: { action: "reaped_maybe" },
    labelled: 0,
  });
  assert.equal(v.ok, false);
  assert.equal(v.unitAction, "unknown");
  assert.match(v.errors[0] ?? "", /unrecognised action "reaped_maybe"/);
});
