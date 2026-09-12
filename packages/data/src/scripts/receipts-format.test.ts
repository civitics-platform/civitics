/**
 * FIX-1176 — the verdict matrix and the renderer, over fixtures.
 *
 * Runs via:  tsx --test src/scripts/receipts-format.test.ts
 *
 * receipts-format.ts is pure by construction so that the part which decides
 * what a number MEANS can be tested without a database. The DB layer in
 * receipts-daily.ts is the only untested seam, and it is the same direct-pg
 * read path scripts/db-query.mjs and the canary already use.
 *
 * The matrix below is the point. Getting `skipped` to outrank `missing` is the
 * whole reason this file exists: the FIX-950 interlock turns a firing into a
 * `skipped` row on purpose, and every shared freshness reader counts only
 * `complete` and therefore cannot tell a deliberate skip from a missed cycle
 * (FIX-1177). The receipts file must.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type Band,
  type Bands,
  type JobFiring,
  type ReceiptsData,
  compareToBand,
  fmtSeconds,
  nominalDate,
  renderJson,
  renderMarkdown,
  verdictFor,
  verdictsFor,
} from "./receipts-format";

const BAND: Band = { lo_s: 0, hi_s: 140, source: "test" };

function firing(over: Partial<JobFiring> = {}): JobFiring {
  return {
    jobname: "ec-vacuum-analyze",
    jobid: 6,
    schedule: "30 4 * * *",
    active: true,
    last_start: "2026-09-12T04:30:00Z",
    last_end: "2026-09-12T04:32:04Z",
    duration_s: 124.3,
    cron_status: "succeeded",
    return_message: "CALL",
    sync_status: "complete",
    skip_reason: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The verdict matrix
// ---------------------------------------------------------------------------

test("in-band: a succeeded firing inside its band", () => {
  const v = verdictFor(firing(), BAND);
  assert.equal(v.verdict, "in-band");
  assert.equal(v.detail, null);
});

test("above: duration over hi_s, with the breach spelled out", () => {
  const v = verdictFor(firing({ duration_s: 899.5 }), BAND);
  assert.equal(v.verdict, "above");
  assert.match(v.detail ?? "", /> 140 s/);
});

test("below: duration under lo_s", () => {
  const v = verdictFor(firing({ duration_s: 2 }), { lo_s: 100, hi_s: 200, source: "test" });
  assert.equal(v.verdict, "below");
  assert.match(v.detail ?? "", /< 100 s/);
});

test("missing: no firing in the lookback window", () => {
  const v = verdictFor(
    firing({ last_start: null, last_end: null, duration_s: null, cron_status: null, sync_status: null }),
    BAND,
  );
  assert.equal(v.verdict, "missing");
});

test("no-band: a perfectly normal firing with nothing written down is NOT in-band", () => {
  const v = verdictFor(firing(), null);
  assert.equal(v.verdict, "no-band");
  assert.match(v.detail ?? "", /bands\.json/);
});

test("skipped outranks everything, and carries the reason (FIX-950 / FIX-1177)", () => {
  const v = verdictFor(
    firing({ sync_status: "skipped", skip_reason: "prod session held: FIX-950 receipt", duration_s: 0.4 }),
    BAND,
  );
  assert.equal(v.verdict, "skipped");
  assert.equal(v.detail, "prod session held: FIX-950 receipt");
});

test("skipped beats missing — a deliberate skip is never reported as a missed cycle", () => {
  const v = verdictFor(
    firing({ sync_status: "skipped", skip_reason: "prod session held: x", last_start: null, duration_s: null }),
    BAND,
  );
  assert.equal(v.verdict, "skipped");
});

test("skipped with no recorded reason still says so rather than going blank", () => {
  const v = verdictFor(firing({ sync_status: "skipped", skip_reason: null }), BAND);
  assert.equal(v.verdict, "skipped");
  assert.match(v.detail ?? "", /no reason recorded/);
});

test("failed: a crash that died in 3 s is NOT in-band", () => {
  const v = verdictFor(
    firing({ cron_status: "failed", duration_s: 3.1, return_message: "canceling statement due to user request" }),
    BAND,
  );
  assert.equal(v.verdict, "failed");
  assert.equal(v.detail, "canceling statement due to user request");
});

test("failed falls back to the status when there is no return message", () => {
  const v = verdictFor(firing({ cron_status: "failed", return_message: null }), BAND);
  assert.equal(v.verdict, "failed");
  assert.match(v.detail ?? "", /cron status failed/);
});

test("running: cron says running", () => {
  const v = verdictFor(firing({ cron_status: "running", last_end: null, duration_s: null }), BAND);
  assert.equal(v.verdict, "running");
});

test("failed with a NULL end_time is failed, not running (the startup-timeout class)", () => {
  // Caught by the first prod read, 2026-09-12: donor-party-rollup-refresh's
  // 09-08 15:00 firing is status='failed' with no end_time (FIX-1073/FIX-1137
  // `job startup timeout`). Inferring in-flight from the null end_time first
  // rendered a four-day-old failure as healthy work in progress.
  const v = verdictFor(
    firing({
      jobname: "donor-party-rollup-refresh",
      cron_status: "failed",
      last_end: null,
      duration_s: null,
      return_message: "job startup timeout",
    }),
    BAND,
  );
  assert.equal(v.verdict, "failed");
  assert.equal(v.detail, "job startup timeout");
});

test("pg_cron's other non-terminal statuses are in-flight, never band-compared", () => {
  for (const s of ["starting", "connecting", "sending"]) {
    const v = verdictFor(firing({ cron_status: s, duration_s: 0.0 }), BAND);
    assert.equal(v.verdict, "running", s + " should read as running");
    assert.match(v.detail ?? "", new RegExp(s));
  }
});

test("running: no end_time is in-flight even when cron has not said so yet", () => {
  const v = verdictFor(firing({ last_end: null, duration_s: null }), BAND);
  assert.equal(v.verdict, "running");
});

test("exact boundaries are inside the band, not outside it", () => {
  assert.equal(verdictFor(firing({ duration_s: 140 }), BAND).verdict, "in-band");
  assert.equal(verdictFor(firing({ duration_s: 0 }), BAND).verdict, "in-band");
  assert.equal(verdictFor(firing({ duration_s: 140.1 }), BAND).verdict, "above");
});

test("verdictsFor keys bands by NAME and leaves unnamed jobs at no-band", () => {
  const bands: Bands = { "ec-vacuum-analyze": BAND };
  const out = verdictsFor([firing(), firing({ jobname: "fe-vacuum-analyze", jobid: 999 })], bands);
  assert.equal(out[0]?.verdict, "in-band");
  assert.equal(out[1]?.verdict, "no-band");
  // jobid is carried through but never used for matching — jobids are not
  // portable between prod and the clone (CLAUDE.md, FIX-946).
  assert.equal(out[1]?.jobid, 999);
});

// ---------------------------------------------------------------------------
// compareToBand — the unit-band path uses the SAME rule as a job band
// ---------------------------------------------------------------------------

test("compareToBand: FIX-1152's search unit against its 300 s ceiling", () => {
  const band: Band = { lo_s: 0, hi_s: 300, source: "FIX-1152" };
  assert.equal(compareToBand(236.0, band).verdict, "in-band");
  assert.equal(compareToBand(1017.0, band).verdict, "above");
  assert.match(compareToBand(1017.0, band).detail ?? "", /> 300 s/);
});

test("compareToBand: no measurement is missing, no band is no-band", () => {
  assert.equal(compareToBand(null, { lo_s: 0, hi_s: 300, source: "x" }).verdict, "missing");
  assert.equal(compareToBand(236.0, null).verdict, "no-band");
});

// ---------------------------------------------------------------------------
// The nominal-day rule (FIX-1163)
// ---------------------------------------------------------------------------

test("nominal day: a 22:54 UTC start under offset 3 names the NEXT day", () => {
  assert.equal(nominalDate(new Date("2026-09-11T22:54:15Z"), 3), "2026-09-12");
});

test("nominal day: offset 0 is the plain UTC date", () => {
  assert.equal(nominalDate(new Date("2026-09-11T22:54:15Z"), 0), "2026-09-11");
});

test("nominal day: an on-time 21:00 start and a 20:59-late one name the same day", () => {
  // The window that maps to a nominal day is [slot, slot+24h) — the widest
  // correct window, covering every GitHub offset ever observed for this
  // workflow including the 11h51 outlier.
  assert.equal(nominalDate(new Date("2026-09-11T21:00:00Z"), 3), "2026-09-12");
  assert.equal(nominalDate(new Date("2026-09-12T20:59:59Z"), 3), "2026-09-12");
  assert.equal(nominalDate(new Date("2026-09-12T21:00:00Z"), 3), "2026-09-13");
});

test("nominal day is UTC regardless of the machine's zone", () => {
  // The file name must not move when the same instant is read on a machine in
  // PDT — this is why the rule is written out here and not imported from
  // weekly-gate.ts, whose projection goes through local getDay().
  assert.equal(nominalDate(new Date(Date.UTC(2026, 8, 12, 0, 30)), 0), "2026-09-12");
});

// ---------------------------------------------------------------------------
// fmtSeconds
// ---------------------------------------------------------------------------

test("fmtSeconds: null renders as an em dash, not 0", () => {
  assert.equal(fmtSeconds(null), "—");
});

test("fmtSeconds: sub-minute is plain seconds, longer adds the m/s gloss", () => {
  assert.equal(fmtSeconds(124.3), "124.3 s (2m 4s)");
  assert.equal(fmtSeconds(55.7), "55.7 s");
});

// ---------------------------------------------------------------------------
// The renderer, over a whole-file fixture
// ---------------------------------------------------------------------------

function fixture(): ReceiptsData {
  return {
    nominal_date: "2026-09-12",
    generated_at: "2026-09-12T06:30:00.000Z",
    target: "PROD (Supabase Pro)",
    target_host: "aws-0-us-west-2.pooler.supabase.com:5432",
    nightly: {
      created_at: "2026-09-11T22:54:15Z",
      run_id: 34655954209,
      conclusion: "success",
      slot_utc: "21:00",
      offset_hours: 1.904,
      nominal_date: "2026-09-12",
      slot_offset_hours: 3,
      is_weekly: false,
      phases: [
        {
          phase: "fec",
          status: "complete",
          started_at: "2026-09-11T23:02:10Z",
          duration_s: 412.5,
          peak_rss_mb: 2871,
          skip_reason: null,
          is_weekly: false,
        },
        {
          phase: "enrichment-light",
          status: "skipped",
          started_at: "2026-09-11T23:40:00Z",
          duration_s: 2.1,
          peak_rss_mb: 175,
          skip_reason: "prod session held: cc-121 nightly hold smoke",
          is_weekly: false,
        },
      ],
      gha_note: null,
    },
    cron_jobs: verdictsFor(
      [
        firing(),
        firing({ jobname: "rule-taggers-daily", jobid: 11, duration_s: 899.5 }),
        firing({
          jobname: "donor-rollup-refresh",
          jobid: 24,
          sync_status: "skipped",
          skip_reason: "prod session held: x",
        }),
      ],
      { "ec-vacuum-analyze": BAND, "rule-taggers-daily": { lo_s: 713, hi_s: 858, source: "cc-118" } },
    ),
    daily: {
      run_started_at: "2026-09-12T06:00:00Z",
      run_status: "complete",
      run_skip_reason: null,
      measured_at: "2026-09-12T06:00:00Z",
      units: 13,
      units_ok: 13,
      elapsed_seconds: 236.0,
      search_unit_seconds: 214.2,
      search_unit_band: { lo_s: 0, hi_s: 300, source: "FIX-1152" },
      search_unit_verdict: "in-band",
      search_unit_detail: null,
      unit_seconds: [{ unit: "rebuild_entity_search_index", seconds: 214.2 }],
      vm_before: [{ relation: "entity_connections", pct_all_visible: 88.8, n_dead_tup: 12000, relpages: 329008 }],
      vm_now: [{ relation: "entity_connections", pct_all_visible: 99.2, n_dead_tup: 0, relpages: 329008 }],
      weekly_started_at: "2026-09-08T00:47:00Z",
      weekly_status: "succeeded",
      weekly_elapsed_seconds: 1622.6,
    },
    vacuums: [
      { jobname: "ec-vacuum-analyze", start_time: "2026-09-12T04:30:00Z", duration_s: 124.3, status: "succeeded" },
    ],
    fec: {
      drop_probe: [{ key: "cycle", value: "2026" }],
      indiv_watermark: [{ key: "2026", value: "Sun, 06 Sep 2026 15:54:54 GMT" }],
      bulk_run_state: null,
      emit_runs: [{ key: "2026 / fec_bulk_indiv", value: "keys=2203015, started …, complete …" }],
      emit_keys_note: "planner estimate",
    },
    interlock: {
      prod_session: [{ key: "held", value: "false" }],
      skips_24h: [
        {
          pipeline: "donor_rollup_refresh",
          started_at: "2026-09-12T03:17:03Z",
          skip_reason: "prod session held: x",
          source: "pg_cron",
        },
      ],
    },
    canary: {
      run_started_at: "2026-09-12T03:21:07Z",
      conditions: [{ key: "rollup_stale:donor_rollup_refresh", tier: "report", severity: 51.2, unchangedRuns: 3, detail: "stale" }],
    },
    sld: {
      total: 7445,
      linked: 7443,
      residual: 2,
      by_state: [{ state: "Maine", chamber: "legislature_lower", unlinked: 2 }],
    },
    not_capturable: ["**57014 counts.** `postgres_logs` only."],
    queries: [
      { key: "cron_jobs", sql: "SELECT 1", elapsed_ms: 42, error: null },
      { key: "sld_coverage", sql: "SELECT 2", elapsed_ms: 118, error: null },
      { key: "canary", sql: "SELECT 3", elapsed_ms: null, error: "statement timeout" },
    ],
  };
}

test("renderMarkdown: all nine sections are present, in order", () => {
  const md = renderMarkdown(fixture());
  const headings = md.split("\n").filter((l) => l.startsWith("## "));
  assert.deepEqual(headings, [
    "## 1. The nightly",
    "## 2. pg_cron jobs vs their bands",
    "## 3. The 06:00 UTC daily (`refresh_derived_mvs`)",
    "## 4. Hour-04 vacuums (FIX-1169's series)",
    "## 5. FEC — drop probe, watermarks, emit set",
    "## 6. Prod-session interlock footprint (FIX-950)",
    "## 7. Canary conditions",
    "## 8. SLD district linkage",
    "## 9. Not capturable here",
    "## Instrument cost",
  ]);
});

test("renderMarkdown: every number carries its instrument", () => {
  const md = renderMarkdown(fixture());
  // One collapsed query block per section that has one.
  assert.ok(md.includes("<details><summary>queries</summary>"));
  // And the cost of taking the reading is in the file itself.
  assert.match(md, /\*\*Total DB time: 160 ms\*\* across 3 statements/);
});

test("renderMarkdown: a failed query is rendered as an error, never as a blank", () => {
  const md = renderMarkdown(fixture());
  assert.match(md, /canary — ERROR: statement timeout/);
});

test("renderMarkdown: non-in-band verdicts are bolded so a scan finds them", () => {
  const md = renderMarkdown(fixture());
  assert.ok(md.includes("**above**"));
  assert.ok(md.includes("**skipped**"));
  assert.ok(md.includes("| in-band |"));
});

test("renderMarkdown: a pipe in a cell is escaped rather than splitting the column", () => {
  const d = fixture();
  d.interlock.skips_24h[0]!.skip_reason = "a | b";
  const md = renderMarkdown(d);
  assert.ok(md.includes("a \\| b"));
});

test("renderMarkdown: the nominal-day rule is stated at the top of every file", () => {
  const md = renderMarkdown(fixture());
  assert.match(md, /NOMINAL day, not the wall clock/);
  assert.match(md, /NIGHTLY_SLOT_OFFSET_HOURS/);
});

test("renderMarkdown: an empty section says so instead of rendering a headless table", () => {
  const d = fixture();
  d.vacuums = [];
  assert.ok(renderMarkdown(d).includes("_(no rows)_"));
});

test("renderMarkdown: a gha_note is surfaced when the GHA half is unchecked", () => {
  const d = fixture();
  d.nightly.gha_note = "GHA run metadata UNCHECKED — `gh run list` unavailable here";
  assert.match(renderMarkdown(d), /> GHA run metadata UNCHECKED/);
});

test("renderJson: round-trips to the same object", () => {
  const d = fixture();
  assert.deepEqual(JSON.parse(renderJson(d)), JSON.parse(JSON.stringify(d)));
});
