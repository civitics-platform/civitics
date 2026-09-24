/**
 * FIX-1218 — receipts section 1 with two firing paths.
 *
 * Runs via:  tsx --test src/scripts/receipts-dispatch.test.ts
 *
 * A separate file from receipts-format.test.ts so its whole-file fixture stays
 * the pre-FIX-1218 shape: that fixture carries no `runs` / `dispatcher`, and
 * rendering it unchanged is itself the backward-compatibility assertion.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DISPATCHER_STALE_HOURS,
  dispatcherLivenessVerdict,
  isAlreadyRanRun,
  renderMarkdown,
  type DispatchStamp,
  type ReceiptsData,
} from "./receipts-format";

const stamp = (over: Partial<DispatchStamp> = {}): DispatchStamp => ({
  at: "2026-09-24T21:00:01Z",
  status: "dispatched",
  http_status: 200,
  run_id: 111,
  detail: null,
  last_dispatched_at: "2026-09-24T21:00:01Z",
  ...over,
});

test("isAlreadyRanRun: the preflight's signature is fec-phase 'Run FEC phase' = skipped", () => {
  const fec = (conclusion: string | null) => ({
    name: "fec-phase",
    steps: [
      { name: "Already ran for this nominal day? (FIX-1218)", conclusion: "success" },
      { name: "Run FEC phase", conclusion },
    ],
  });
  assert.equal(isAlreadyRanRun([fec("skipped")]), true);
  assert.equal(isAlreadyRanRun([fec("success")]), false);
  assert.equal(isAlreadyRanRun([fec("failure")]), false);
  // A cancelled run is not a stood-down one.
  assert.equal(isAlreadyRanRun([fec("cancelled")]), false);
  // Unreadable → unknown, never a guess.
  assert.equal(isAlreadyRanRun([]), null);
  assert.equal(isAlreadyRanRun([{ name: "fec-phase" }]), null);
  assert.equal(isAlreadyRanRun([{ name: "enrichment-heavy-phase", steps: [] }]), null);
});

test("dispatcherLivenessVerdict: in-band, refused, stale, absent", () => {
  const asOf = "2026-09-24T21:20:00Z";
  const ok = dispatcherLivenessVerdict(stamp(), asOf);
  assert.equal(ok.verdict, "in-band");
  assert.match(ok.line, /status \*\*dispatched\*\*, http 200, run 111/);

  const refused = dispatcherLivenessVerdict(
    stamp({ status: "refused", http_status: 401, run_id: null, detail: "Bad credentials", last_dispatched_at: "2026-09-23T21:00:02Z" }),
    asOf,
  );
  assert.equal(refused.verdict, "failed");
  assert.match(refused.line, /\*\*refused\*\*: "Bad credentials"\. Last GOOD dispatch 2026-09-23T21:00:02Z/);

  const stale = dispatcherLivenessVerdict(stamp({ at: "2026-09-23T20:00:00Z" }), asOf);
  assert.equal(stale.verdict, "missing");
  assert.match(stale.line, new RegExp(`more than ${DISPATCHER_STALE_HOURS} h`));

  for (const absent of [null, undefined, stamp({ at: null })]) {
    const v = dispatcherLivenessVerdict(absent, asOf);
    assert.equal(v.verdict, "missing");
    assert.match(v.line, /last fired \*\*never\*\*/);
  }
});

function minimal(): ReceiptsData {
  return {
    nominal_date: "2026-09-25",
    generated_at: "2026-09-24T23:50:00.000Z",
    target: "PROD (Supabase Pro)",
    target_host: "h:5432",
    nightly: {
      created_at: "2026-09-24T21:00:04Z",
      run_id: 111,
      conclusion: "success",
      jobs: [],
      slot_utc: "21:00",
      offset_hours: 0.0011,
      nominal_date: "2026-09-25",
      slot_offset_hours: 3,
      is_weekly: false,
      phases: [],
      gha_note: null,
      runs: [
        {
          run_id: 111,
          event: "workflow_dispatch",
          dispatched_by: "vercel-cron",
          created_at: "2026-09-24T21:00:04Z",
          offset_hours: 0.0011,
          conclusion: "success",
          already_ran: false,
        },
        {
          run_id: 222,
          event: "schedule",
          dispatched_by: "schedule",
          created_at: "2026-09-24T23:21:55Z",
          offset_hours: 2.365,
          conclusion: "",
          already_ran: true,
        },
      ],
      dispatcher: stamp(),
    },
    cron_jobs: [],
    daily: {
      run_started_at: null,
      run_status: null,
      run_skip_reason: null,
      measured_at: null,
      units: null,
      units_ok: null,
      elapsed_seconds: null,
      search_unit_seconds: null,
      search_unit_band: null,
      search_unit_verdict: "missing",
      search_unit_detail: null,
      unit_seconds: [],
      vm_before: [],
      vm_now: [],
      weekly_started_at: null,
      weekly_status: null,
      weekly_elapsed_seconds: null,
    },
    vacuums: [],
    vm_probes: [],
    fec: { drop_probe: [], indiv_watermark: [], bulk_run_state: null, emit_runs: [], emit_keys_note: "" },
    interlock: { prod_session: [], skips_24h: [] },
    canary: { run_started_at: null, conditions: [] },
    sld: { total: null, linked: null, residual: null, by_state: [] },
    forker: { by_hour_24h: [], by_day_7d: [], running_in_bursts: [], cancels_7d: [], vercel_liveness_at: null },
    not_capturable: [],
    queries: [],
  };
}

test("section 1 lists both runs, marks the fallback, and prints the dispatcher line", () => {
  const md = renderMarkdown(minimal());
  const s1 = md.slice(md.indexOf("## 1. The nightly"), md.indexOf("## 2."));
  assert.match(s1, /### Runs for this nominal day/);
  assert.match(s1, /\| 111 \| workflow_dispatch \| vercel-cron \| 2026-09-24T21:00:04Z \| 0\.00 h \| success \| did the work \|/);
  assert.match(s1, /\| 222 \| schedule \| schedule \| 2026-09-24T23:21:55Z \| 2\.37 h \| in progress \| already_ran \(stood down\) \|/);
  // generated_at 23:50:00 − stamp 21:00:01 = 2.83 h: the fallback's regeneration.
  assert.match(s1, /Dispatcher last fired 2026-09-24T21:00:01Z \(2\.8 h before this file\) — status \*\*dispatched\*\*, http 200, run 111/);
});

test("a pre-FIX-1218 nightly (no runs, no dispatcher key) renders no new block", () => {
  const d = minimal();
  delete d.nightly.runs;
  delete d.nightly.dispatcher;
  const md = renderMarkdown(d);
  assert.doesNotMatch(md, /Runs for this nominal day/);
  assert.doesNotMatch(md, /Dispatcher last fired/);
});
