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
  BURST_THRESHOLD,
  compareToBand,
  fmtSeconds,
  nominalDate,
  renderJson,
  renderMarkdown,
  RUN_IN_PROGRESS,
  runConclusionCell,
  verdictFor,
  verdictsFor,
  monthlyNotYetDue,
  votesSkipsLine,
  tagRulesKeptLine,
  VERCEL_LIVENESS_STALE_MIN,
  vercelLivenessVerdict,
  BOX_HEALTH_MEM_STALE_MIN,
  BOX_HEALTH_PROBE_STALE_MIN,
  boxHealthLines,
  stampLivenessVerdict,
  legislatorIdsLines,
  legislatorIdsBindLines,
  LEGISLATOR_IDS_STALE_HOURS,
  type LegislatorIdsSection,
  type CrawlSkips,
  CRAWL_SKIP_REASONS,
  crawlSkipLines,
  parkedArmLines,
  crawlSkipsBaselineFrom,
  previousNominalDay,
} from "./receipts-format";

const BAND: Band = { lo_s: 0, hi_s: 140, source: "test" };

function firing(over: Partial<JobFiring> = {}): JobFiring {
  return {
    jobname: "ec-vacuum-analyze",
    jobid: 6,
    schedule: "30 4 * * *",
    active: true,
    pipeline: null,
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

test("inactive: a disabled job that never fired is inactive, not missing", () => {
  const v = verdictFor(
    firing({
      jobname: "rebuild-ec-incremental",
      schedule: "0 8 * * 3",
      active: false,
      last_start: null,
      last_end: null,
      duration_s: null,
      cron_status: null,
      sync_status: null,
    }),
    BAND,
  );
  assert.equal(v.verdict, "inactive");
  assert.match(v.detail ?? "", /active = false/);
  // The schedule it WOULD fire on is the useful half — without it the reader
  // has to go to cron.job to find out what was turned off.
  assert.match(v.detail ?? "", /0 8 \* \* 3/);
});

test("inactive still names the disabled state when the schedule is unknown", () => {
  const v = verdictFor(
    firing({ active: false, schedule: null, last_start: null, last_end: null, duration_s: null, cron_status: null, sync_status: null }),
    BAND,
  );
  assert.equal(v.verdict, "inactive");
  assert.match(v.detail ?? "", /active = false/);
});

test("missing is reserved for an ACTIVE job — an inactive one that DID fire is still band-compared", () => {
  // Deactivated mid-lookback: the firing is real and its duration is the
  // interesting number, so `inactive` must not swallow it.
  const v = verdictFor(firing({ active: false }), BAND);
  assert.equal(v.verdict, "in-band");
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
      jobs: [
        {
          name: "fec-phase",
          conclusion: "success",
          started_at: "2026-09-11T22:54:18Z",
          completed_at: "2026-09-11T23:01:08Z",
        },
        {
          name: "receipts",
          conclusion: null,
          started_at: "2026-09-12T06:29:40Z",
          completed_at: null,
        },
      ],
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
      // FIX-1191 — the FR vacuum is DAILY at 03:00, so the series it leads is not
      // an hour-04 one. Ordered as the query returns them: by start time.
      { jobname: "fr-vacuum-analyze", start_time: "2026-09-12T03:00:00Z", duration_s: 212.0, status: "succeeded" },
      { jobname: "ec-vacuum-analyze", start_time: "2026-09-12T04:30:00Z", duration_s: 124.3, status: "succeeded" },
    ],
    // FIX-1169 — the pre-vacuum reading, five minutes ahead of the row above.
    vm_probes: [
      {
        label: "pre-ec",
        at: "2026-09-12T04:25:00Z",
        relation: "entity_connections",
        pct_all_visible: 61.4,
        n_dead_tup: 412_003,
        relpages: 329_008,
      },
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
    // FIX-1194 §9. The 2026-09-07 hour is cc-139's real burst (12/30 and 10/30
    // in the two watchdog jobs); the quiet hour beside it carries 2 failures on
    // purpose, because the threshold test needs a near-miss to be near.
    forker: {
      by_hour_24h: [
        { bucket: "2026-09-07 06:00", failures: 22, jobs_affected: 2 },
        { bucket: "2026-09-07 04:00", failures: 2, jobs_affected: 1 },
      ],
      by_day_7d: [
        { bucket: "2026-09-07", failures: 22, jobs_affected: 2 },
        { bucket: "2026-09-06", failures: 1, jobs_affected: 1 },
      ],
      running_in_bursts: [
        {
          bucket: "2026-09-07 06:00",
          jobname: "contract-flow-rollups-refresh",
          start_time: "2026-09-07T05:48:11Z",
          wall_s: 2431.6,
          status: "running",
        },
      ],
      cancels_7d: [
        {
          acted_at: "2026-09-07T06:14:02Z",
          jobname: "ec-crawl",
          age_seconds: 16.1,
          budget_seconds: 10,
          acted_via: "vercel",
        },
      ],
      // FIX-1208 — 1.5 min before the fixture's generated_at, i.e. healthy.
      vercel_liveness_at: "2026-09-12T06:28:30.000Z",
    },
    not_capturable: ["**57014 counts.** `postgres_logs` only."],
    queries: [
      { key: "cron_jobs", sql: "SELECT 1", elapsed_ms: 42, error: null },
      { key: "sld_coverage", sql: "SELECT 2", elapsed_ms: 118, error: null },
      { key: "canary", sql: "SELECT 3", elapsed_ms: null, error: "statement timeout" },
      // FIX-1208 — the reader records this key, so §9's query block prints it.
      { key: "forker_vercel_liveness", sql: "SELECT 4", elapsed_ms: 3, error: null },
    ],
  };
}

test("renderMarkdown: all eleven sections are present, in order", () => {
  const md = renderMarkdown(fixture());
  const headings = md.split("\n").filter((l) => l.startsWith("## "));
  assert.deepEqual(headings, [
    "## 1. The nightly",
    "## 2. pg_cron jobs vs their bands",
    "## 3. The 06:00 UTC daily (`refresh_derived_mvs`)",
    "## 4. Daily vacuums (FIX-1169's series)",
    "## 5. FEC — drop probe, watermarks, emit set",
    "## 6. Prod-session interlock footprint (FIX-950)",
    "## 7. Canary conditions",
    "## 8. SLD district linkage",
    "## 9. The forker (FIX-1194) — job startup timeouts and who was running",
    "## 10. FEC id divergence (FIX-1189 O2)",
    "## 11. Not capturable here",
    "## Instrument cost",
  ]);
});

test("renderMarkdown: every number carries its instrument", () => {
  const md = renderMarkdown(fixture());
  // One collapsed query block per section that has one.
  assert.ok(md.includes("<details><summary>queries</summary>"));
  // And the cost of taking the reading is in the file itself. 42 + 118 + 3;
  // `canary` has a null elapsed_ms (it errored) and still counts as a statement.
  assert.match(md, /\*\*Total DB time: 163 ms\*\* across 4 statements/);
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

// ---------------------------------------------------------------------------
// The run conclusion, which a scheduled file can never have (D4b)
// ---------------------------------------------------------------------------

test("runConclusionCell: a finished run's conclusion passes straight through", () => {
  assert.equal(runConclusionCell({ conclusion: "success", jobs: [] }), "success");
  assert.equal(runConclusionCell({ conclusion: "failure", jobs: [] }), "failure");
});

test("runConclusionCell: the blank a scheduled file always gets becomes the in-progress label", () => {
  // This is the real shape: `gh` reports "" because the receipts job is a job
  // OF the run it is describing. Every scheduled file shipped a blank cell.
  const cell = runConclusionCell({
    conclusion: "",
    jobs: [{ name: "fec-phase", conclusion: "success", started_at: null, completed_at: null }],
  });
  assert.equal(cell, RUN_IN_PROGRESS);
  assert.match(cell ?? "", /written by its last job/);
});

test("runConclusionCell: blank AND no jobs is unknown, not in-progress", () => {
  // `gh` unavailable. Claiming the run is in flight would be a guess, and the
  // gha_note already says the GHA half is unchecked.
  assert.equal(runConclusionCell({ conclusion: null, jobs: [] }), null);
  assert.equal(runConclusionCell({ conclusion: "", jobs: [] }), null);
});

test("renderMarkdown: the per-job table is rendered, with its reason", () => {
  const md = renderMarkdown(fixture());
  assert.match(md, /### Jobs/);
  assert.match(md, /\| fec-phase \| success \|/);
  assert.match(md, /a job of the run it describes/);
});

test("renderMarkdown: no jobs means no Jobs section rather than an empty one", () => {
  const d = fixture();
  d.nightly.jobs = [];
  const md = renderMarkdown(d);
  assert.ok(!md.includes("### Jobs"));
});

test("renderMarkdown: an in-flight run renders the label, not a blank cell", () => {
  const d = fixture();
  d.nightly.conclusion = "";
  assert.match(renderMarkdown(d), /written by its last job/);
});

// ---------------------------------------------------------------------------
// FIX-1190 — a job with no writer of its own must not inherit a verdict
// ---------------------------------------------------------------------------

/**
 * THE 2026-09-15 SHAPE, as a fixture.
 *
 * `ec-vacuum-analyze` is a bare `VACUUM (ANALYZE)` command. It calls no
 * procedure, writes no `data_sync_log` row, and therefore has no pipeline —
 * which is what `pipeline: null` says. The old TIME-FIRST correlation gave it
 * `ec_crawl`'s row anyway, because that row happened to start inside ±90 s,
 * and the file rendered:
 *
 *   | ec-vacuum-analyze | yes | 30 4 * * * | … | 132.9 s | succeeded | 0–140 s |
 *   | **skipped** | peer crawl ec_crawl is backed off until … |
 *
 * A 132.9-second vacuum that ran to completion, reported as an interlock skip
 * on another job's reason. The band it was inside of was never even consulted.
 */
test("FIX-1190: a pipeline-less job renders from its cron status, never a neighbour's skip", () => {
  const v = verdictFor(
    firing({ jobname: "ec-vacuum-analyze", pipeline: null, sync_status: null, skip_reason: null }),
    BAND,
  );
  assert.equal(v.verdict, "in-band");
  assert.equal(v.detail, null);
});

test("FIX-1190: the same job with no band is no-band — still not skipped", () => {
  const v = verdictFor(
    firing({ jobname: "officials-vacuum-analyze", duration_s: 3.8, pipeline: null, sync_status: null }),
    null,
  );
  assert.equal(v.verdict, "no-band");
});

/**
 * THE WRONG-BUT-GREEN SHAPE. This is what the OLD query produced, and it is
 * asserted here on purpose: the fixture exists to record that `verdictFor` is
 * not where the bug lived. Given a `skipped` sync_status the matrix correctly
 * says `skipped` — it has no way to know the status belonged to `ec_crawl`.
 * The fix had to be in the SQL key, which is why the next test reads the query
 * text itself.
 */
test("FIX-1190: verdictFor is NOT the bug — fed the inherited status it still says skipped", () => {
  const v = verdictFor(
    firing({
      jobname: "ec-vacuum-analyze",
      pipeline: null,
      sync_status: "skipped",
      skip_reason: "peer crawl ec_crawl is backed off until 2026-09-14 06:21:44.694017+00",
    }),
    BAND,
  );
  assert.equal(v.verdict, "skipped");
  assert.match(v.detail ?? "", /ec_crawl is backed off/);
});

test("FIX-1190: a job WITH a pipeline still honours a real skip of its own", () => {
  const v = verdictFor(
    firing({
      jobname: "ec-crawl",
      pipeline: "entity_connections_rebuild",
      sync_status: "skipped",
      skip_reason: "prod session held: manual FEC landing",
    }),
    BAND,
  );
  assert.equal(v.verdict, "skipped");
});

test("renderMarkdown: the cron table carries the resolved pipeline, and an em dash for none", () => {
  const d = fixture();
  d.cron_jobs = verdictsFor(
    [
      firing({ jobname: "ec-vacuum-analyze", pipeline: null, sync_status: null }),
      firing({ jobname: "vote-stats-refresh", pipeline: "official_vote_stats_rebuild", duration_s: 27.3 }),
    ],
    { "ec-vacuum-analyze": BAND },
  );
  const md = renderMarkdown(d);
  assert.match(md, /\| ec-vacuum-analyze \| yes \| 30 4 \* \* \* \| — \|/);
  assert.match(md, /\| vote-stats-refresh \| yes \| 30 4 \* \* \* \| `official_vote_stats_rebuild` \|/);
  // The header gained a column; a reader must be told what it means.
  assert.match(md, /job's OWN `data_sync_log` writer/);
});

test("renderMarkdown: FIX-1178 (a)'s three-key phase_seconds renders verbatim", () => {
  // The merge stamps {scan, delete, insert} where the rewrite stamped
  // {delete, insert}. The renderer passes the raw jsonb text through in
  // backticks, so a new key needs no renderer change — this asserts that,
  // rather than leaving it as an assumption in a prompt.
  const d = fixture();
  d.cron_jobs = verdictsFor(
    [
      firing({
        jobname: "rule-taggers-daily",
        pipeline: "run_rule_taggers",
        duration_s: 61.4,
        phase_seconds: '{"scan": 48.2, "delete": 9.1, "insert": 4.1}',
      }),
      // A cadence that timed nothing still reads as an em dash, not a zero.
      firing({ jobname: "rule-taggers-weekly", pipeline: "run_rule_taggers", phase_seconds: null }),
    ],
    {},
  );
  const md = renderMarkdown(d);
  assert.match(md, /\| `\{"scan": 48\.2, "delete": 9\.1, "insert": 4\.1\}` \|/);
  assert.match(md, /\| rule-taggers-weekly \| yes \| 30 4 \* \* \* \| `run_rule_taggers` \|/);
});

// ---------------------------------------------------------------------------
// FIX-1194 §9 — the forker
// ---------------------------------------------------------------------------

test("renderMarkdown: §9 renders the hourly startup-timeout buckets", () => {
  const md = renderMarkdown(fixture());
  assert.match(md, /\| hour \(UTC\) \| failures \| jobs affected \|/);
  assert.match(md, /\| 2026-09-07 06:00 \| 22 \| 2 \|/);
  assert.match(md, /\| 2026-09-07 04:00 \| 2 \| 1 \|/);
});

test("renderMarkdown: §9 renders the 7-day buckets so episodic vs chronic is readable", () => {
  const md = renderMarkdown(fixture());
  assert.match(md, /\| day \(UTC\) \| failures \| jobs affected \|/);
  assert.match(md, /\| 2026-09-07 \| 22 \| 2 \|/);
  assert.match(md, /episodic-vs-chronic/);
});

test("renderMarkdown: §9 names the longest overlapping job for a burst hour", () => {
  const md = renderMarkdown(fixture());
  assert.match(
    md,
    /\| 2026-09-07 06:00 \| contract-flow-rollups-refresh \| 2026-09-07T05:48:11Z \| 2431\.6 s \(40m 32s\) \| running \|/,
  );
  // It is a suspect, and the file has to say so rather than let a reader
  // mistake an overlap for a cause.
  assert.match(md, /SUSPECT, not a verdict/);
});

test("renderMarkdown: §9 — an hour BELOW the burst threshold gets no 'who was running' row", () => {
  const d = fixture();
  // The 04:00 hour carries 2 failures and is in the hourly table. The third
  // table is built from a HAVING >= BURST_THRESHOLD query, so it must not
  // appear there — this is the test that keeps the section sparse, which is
  // the only reason naming a suspect means anything.
  assert.equal(BURST_THRESHOLD, 3);
  assert.ok(d.forker.by_hour_24h.some((r) => r.bucket === "2026-09-07 04:00" && r.failures === 2));
  assert.ok(!d.forker.running_in_bursts.some((r) => r.bucket === "2026-09-07 04:00"));

  const md = renderMarkdown(d);
  const bursts = md.slice(md.indexOf("### Who was running"), md.indexOf("### Budget cancels"));
  assert.ok(bursts.includes("2026-09-07 06:00"), "the 22-failure hour IS named");
  assert.ok(!bursts.includes("2026-09-07 04:00"), "the 2-failure hour is NOT named");
  assert.match(md, /≥ 3 failures/);
});

test("renderMarkdown: §9 renders budget cancels with the path that acted", () => {
  const md = renderMarkdown(fixture());
  assert.match(md, /\| acted at \(UTC\) \| job \| age \| budget \| via \|/);
  assert.match(md, /\| 2026-09-07T06:14:02Z \| ec-crawl \| 16\.1 s \| 10 s \| vercel \|/);
});

test("renderMarkdown: §9 — a clean forker section says '(no rows)' rather than a headless table", () => {
  const d = fixture();
  d.forker = { by_hour_24h: [], by_day_7d: [], running_in_bursts: [], cancels_7d: [] };
  const md = renderMarkdown(d);
  const section = md.slice(md.indexOf("## 9. The forker"), md.indexOf("## 10."));
  assert.equal((section.match(/_\(no rows\)_/g) ?? []).length, 4);
  assert.match(section, /An empty table is the good answer/);
});

// ---------------------------------------------------------------------------
// FIX-1208 §9 — the Vercel path's liveness line
// ---------------------------------------------------------------------------

test("FIX-1208: a fresh stamp reads as an age, with no alarm", () => {
  const v = vercelLivenessVerdict("2026-09-12T06:28:30.000Z", "2026-09-12T06:30:00.000Z");
  assert.equal(v.verdict, "in-band");
  assert.equal(v.age_min, 1.5);
  assert.match(v.line, /last fired 2026-09-12T06:28:30\.000Z \(1\.5 min before this file\)$/);
});

test("FIX-1208: the `missing` branch — the one that carries weight", () => {
  // Five missed */2 firings. This is the reading the whole stamp exists for:
  // without it, an offline second path looks exactly like a healthy day,
  // because `acted_via` only appears when a cancel happens.
  const v = vercelLivenessVerdict("2026-09-12T06:00:00.000Z", "2026-09-12T06:30:00.000Z");
  assert.equal(v.verdict, "missing");
  assert.equal(v.age_min, 30);
  assert.match(v.line, /\*\*missing\*\*/);
  assert.match(v.line, /at least five missed/);
  assert.match(v.line, /second path is offline/);
});

test("FIX-1208: exactly at the threshold is still healthy; a hair over is not", () => {
  const asOf = "2026-09-12T06:30:00.000Z";
  assert.equal(vercelLivenessVerdict("2026-09-12T06:20:00.000Z", asOf).verdict, "in-band");
  assert.equal(vercelLivenessVerdict("2026-09-12T06:19:59.000Z", asOf).verdict, "missing");
  assert.equal(VERCEL_LIVENESS_STALE_MIN, 10);
});

test("FIX-1208: an absent key is `missing` and says WHY it might be absent", () => {
  for (const absent of [null, undefined, ""]) {
    const v = vercelLivenessVerdict(absent, "2026-09-12T06:30:00.000Z");
    assert.equal(v.verdict, "missing");
    assert.equal(v.age_min, null);
    assert.match(v.line, /last fired \*\*never\*\*/);
    // A reader must not have to guess between "not deployed" and "not running".
    assert.match(v.line, /migration is not on this database/);
  }
});

test("FIX-1208: an unparseable stamp is `missing`, not a NaN age", () => {
  const v = vercelLivenessVerdict("not-a-timestamp", "2026-09-12T06:30:00.000Z");
  assert.equal(v.verdict, "missing");
  assert.equal(v.age_min, null);
  assert.match(v.line, /unparseable/);
});

test("renderMarkdown: §9 carries the liveness line and its provenance note", () => {
  const md = renderMarkdown(fixture());
  const section = md.slice(md.indexOf("## 9. The forker"), md.indexOf("## 10."));
  assert.match(section, /Vercel path last fired 2026-09-12T06:28:30\.000Z \(1\.5 min before this file\)/);
  // The argument for trusting the row has to travel with the row.
  assert.match(section, /is a Vercel receipt by construction rather than by trust/);
  assert.match(section, /forker_vercel_liveness/);
});

test("renderMarkdown: §9 renders the liveness line even when the key is absent", () => {
  const d = fixture();
  d.forker = { by_hour_24h: [], by_day_7d: [], running_in_bursts: [], cancels_7d: [] };
  const md = renderMarkdown(d);
  const section = md.slice(md.indexOf("## 9. The forker"), md.indexOf("## 10."));
  assert.match(section, /Vercel path last fired \*\*never\*\*/);
});

// ── FIX-1194 P1-B / FIX-1125 — §9 "Box health" ──────────────────────────────

/** The probe stamp as the migration writes it; the numbers are prod's at 01:35 UTC 09-24. */
const PROBE = {
  at: "2026-09-12T06:29:10.000Z",
  startup_timeouts_10m: 0,
  startup_timeouts_60m: 0,
  watchdog_max_wall_10m: { budget: 0.016, unit: 0.004 },
  watchdog_runs_10m: { budget: 5, unit: 5 },
  running_budgeted_jobs: 0,
  running_over_budget: 0,
  oldest_running_s: null,
  backends: { client: 17, active: 1, idle_in_txn: 0, lock_waiting: 0, longest_active_s: null, max_connections: 60 },
  probe_ms: 22.1,
};
/** cc-149 read 2's real reading. */
const MEM = {
  at: "2026-09-12T06:28:00.000Z",
  route_at: "2026-09-12T06:27:59.500Z",
  mem_available_bytes: 418258944,
  mem_total_bytes: 948195328,
  swap_total_bytes: 1073737728,
  swap_free_bytes: 502247424,
  load1: 0.14,
};
const AS_OF = "2026-09-12T06:30:00.000Z";
const quiet = { by_hour_24h: [], by_day_7d: [], running_in_bursts: [], cancels_7d: [] };

test("FIX-1194: the probe is stale past 3 min (box_is_saturated's 180 s); the mirror past 10 (five 2-min firings)", () => {
  assert.equal(BOX_HEALTH_PROBE_STALE_MIN, 3);
  assert.equal(BOX_HEALTH_MEM_STALE_MIN, VERCEL_LIVENESS_STALE_MIN);
  const v = (at: string, min: number) => stampLivenessVerdict("x", "k", at, AS_OF, min, "why").verdict;
  assert.equal(v("2026-09-12T06:27:00.000Z", 3), "in-band");
  assert.equal(v("2026-09-12T06:26:59.000Z", 3), "missing");
  // A stamp newer than the file's clock is 0.0 min, not "-0.0" (the 09-24 receipt's §9 line).
  const fresh = stampLivenessVerdict("x", "k", "2026-09-12T06:30:00.300Z", AS_OF, 3, "why");
  assert.equal(fresh.age_min, 0);
  assert.match(fresh.line, /\(0\.0 min before this file\)$/);
  assert.match(stampLivenessVerdict("x", "pipeline_state.box_health", undefined, AS_OF, 3, "why").line,
    /x last stamped \*\*never\*\* — `pipeline_state\.box_health` is absent\./);
});

test("FIX-1194: §9 Box health — both stamps and their readings, the ring unavailable on this runner", () => {
  const lines = boxHealthLines(
    { ...quiet, box_health: PROBE, box_health_mem: MEM, mem_day: { available: false, reason: "no Upstash secret" } },
    AS_OF,
  );
  const text = lines.join("\n");
  assert.match(text, /Probe \(`box-health-probe`, every minute\) last stamped 2026-09-12T06:29:10\.000Z \(0\.8 min before this file\)\n/);
  assert.match(text, /startup timeouts 0 \(10 min\) \/ 0 \(60 min\); watchdog max wall over 10 min 0\.016 s \(budget\) \/ 0\.004 s \(unit\)/);
  assert.match(text, /client backends 17 of 60 \(1 active, 0 idle in txn, 0 lock-waiting\); probe 22\.1 ms\./);
  assert.match(text, /Memory mirror \(`\/api\/cron\/box-health`, every 2 min\) last stamped 2026-09-12T06:28:00\.000Z \(2\.0 min before this file\)\n/);
  assert.match(text, /Latest memory reading: 399 MB available of 904 MB \(44\.1 %\), swap in use 545 MB, load1 0\.14\./);
  assert.match(text, /\*\*not available from this runner\*\* — no Upstash secret\. `pnpm --filter @civitics\/data data:box-health:series`/);
});

test("FIX-1194: §9 Box health — stale and absent stamps say so; the ring's day renders min/median/max", () => {
  const stale = boxHealthLines(
    {
      ...quiet,
      box_health: { ...PROBE, at: "2026-09-12T06:20:00.000Z" },
      mem_day: {
        available: true, n: 720, first_at: "2026-09-11T06:30:00Z", last_at: "2026-09-12T06:28:00Z",
        min_mb: 212, min_at: "2026-09-11T15:58:00Z", median_mb: 401, max_mb: 455, mem_total_mb: 904,
      },
    },
    AS_OF,
  ).join("\n");
  assert.match(stale, /\(10\.0 min before this file\) — \*\*missing\*\*: more than 3 min\. The probe is a pg_cron firing, so a stale stamp IS the saturation signal/);
  assert.match(stale, /Memory mirror .* last stamped \*\*never\*\* — `pipeline_state\.box_health_mem` is absent\./);
  assert.match(stale, /720 samples 2026-09-11T06:30:00Z → 2026-09-12T06:28:00Z; MemAvailable min \*\*212 MB\*\* \(at 2026-09-11T15:58:00Z\) \/ median 401 MB \/ max 455 MB of 904 MB\./);
});

/** cc-183 read 6: prod's ring, 08:02 UTC 10-03 — the first day the series was summarised. */
const MEMORY_DAY = {
  samples: 720,
  first_at: "2026-10-02T08:02:22.264Z",
  last_at: "2026-10-03T08:00:22.255Z",
  swapin_per_s: { p50: 18.2, p95: 506.4, max: 1584.7 },
  swapout_per_s: { p50: 3.3, p95: 469.7, max: 1583.1 },
  mem_available_mb: { min: 176, p50: 457 },
  swap_used_mb: { max: 1014 },
  gaps: 0,
};

test("FIX-1194 (cc-183): §9 — the banked memory series renders when the ring was read; null adds nothing", () => {
  const banked = boxHealthLines(
    {
      ...quiet, box_health: PROBE, box_health_mem: MEM,
      mem_day: {
        available: true, n: 720, first_at: MEMORY_DAY.first_at, last_at: MEMORY_DAY.last_at,
        min_mb: 176, min_at: "2026-10-03T04:54:22.198Z", median_mb: 457, max_mb: 589, mem_total_mb: 904,
      },
      memory_day: MEMORY_DAY,
    },
    AS_OF,
  ).join("\n");
  assert.match(
    banked,
    /Memory series \(24 h, banked as `forker\.memory_day`\): swap-in p50\/p95\/max \*\*18\.2 \/ 506\.4 \/ 1584\.7\*\* pages\/s, swap-out 3\.3 \/ 469\.7 \/ 1583\.1 pages\/s; MemAvailable min \*\*176 MB\*\* \/ p50 457 MB; swap in use max 1014 MB; gaps 0 \(intervals over 6 min, not rated\)\./,
  );
  const absent = boxHealthLines(
    { ...quiet, box_health: PROBE, box_health_mem: MEM, mem_day: { available: false, reason: "no Upstash secret" }, memory_day: null },
    AS_OF,
  ).join("\n");
  assert.doesNotMatch(absent, /Memory series \(24 h/);
  assert.match(absent, /\*\*not available from this runner\*\* — no Upstash secret\./);
  // An empty ring banks a zero-sample day and draws no rate line.
  assert.doesNotMatch(
    boxHealthLines({ ...quiet, memory_day: { ...MEMORY_DAY, samples: 0 } }, AS_OF).join("\n"),
    /Memory series \(24 h/,
  );
});

test("FIX-1194 (cc-183): renderJson — forker.memory_day is the banked object, or an explicit null", () => {
  const d = fixture();
  d.forker = { ...d.forker, mem_day: { available: false, reason: "r" }, memory_day: null };
  const absent = JSON.parse(renderJson(d)) as { forker: Record<string, unknown> };
  assert.ok("memory_day" in absent.forker, "the key is present when the ring was not read");
  assert.equal(absent.forker["memory_day"], null);
  d.forker = { ...d.forker, memory_day: MEMORY_DAY };
  assert.deepEqual((JSON.parse(renderJson(d)) as { forker: Record<string, unknown> }).forker["memory_day"], MEMORY_DAY);
});

test("renderMarkdown: §9 carries the Box health subsection and its query", () => {
  const d = fixture();
  d.forker = { ...d.forker, box_health: PROBE, box_health_mem: MEM, mem_day: { available: false, reason: "r" } };
  const md = renderMarkdown(d);
  const section = md.slice(md.indexOf("## 9. The forker"), md.indexOf("## 10."));
  assert.match(section, /### Box health — the probe and the memory series \(FIX-1194 P1-B \/ FIX-1125\)/);
  assert.match(section, /Probe \(`box-health-probe`, every minute\) last stamped/);
  // An older fixture with no box-health keys still renders — both stamps read as never.
  const old = renderMarkdown(fixture());
  assert.match(old.slice(old.indexOf("## 9."), old.indexOf("## 10.")), /Probe .* last stamped \*\*never\*\*/);
  assert.match(old, /Day's memory series \(off-box ring\): not read\./);
});

// ── FIX-1189 O2 — §10, FEC id divergence ─────────────────────────────────────

const LEG_CLASSES = [
  "noop", "bindable", "prior_office_live", "prior_incomplete", "unlisted_live_id",
  "double_claim", "cross_bioguide_claim", "ambiguous_current", "dataset_lag", "no_bioguide",
];

/** The prod dry run of 2026-09-28, trimmed. */
function legMeta(): Record<string, unknown> {
  return {
    population: 539,
    counts: {
      noop: 444, bindable: 0, prior_office_live: 2, prior_incomplete: 29, unlisted_live_id: 3,
      double_claim: 59, cross_bioguide_claim: 0, ambiguous_current: 0, dataset_lag: 2, no_bioguide: 0,
    },
    double_claim_split: { current_id: 30, other_id: 29 },
    top_20: {
      prior_office_live: [
        { name: "Bill Foster", state: "IL-11", live: "H8IL14067", current_id: "H2IL11124" },
        { name: "Lois Frankel", state: "FL-22", live: "H2FL14053", current_id: "H2FL22080" },
      ],
      unlisted_live_id: [
        { name: "Ed Case", state: "HI-1", live: "H8HI01234" },
        { name: "Nick LaLota", state: "NY-1", live: "H0NY02200" },
        { name: "Robert Menendez", state: "NJ-8", live: "H2NJ08232" },
      ],
    },
    dataset_members: 539,
    matched_dataset_members: 539,
    dataset_ambiguous_current: 9,
    historical_members_count: 12231,
    unmatched_dataset_members: { count: 0, first_20: [] },
    dataset_ref: { current: { etag: 'W/"6ab4f9aa-166a83"', last_modified: "Thu, 24 Sep 2026 10:21:30 GMT" } },
  };
}

const LEG_AS_OF = "2026-09-29T00:10:00Z";

test("FIX-1189 §10: a fresh complete report renders counts that reconcile, the O1 tables, and the report-only lines", () => {
  const run = { started_at: "2026-09-28T23:05:00Z", status: "complete", error: null, metadata: legMeta() };
  const md = legislatorIdsLines({ latest: run, complete: run }, LEG_AS_OF, LEG_CLASSES).join("\n");
  assert.match(md, /Latest run 2026-09-28T23:05:00Z — complete, 1\.1 h before this file/);
  assert.match(md, /\| _total_ \| 539 \| = population \(539\) — reconciles \|/);
  assert.match(md, /\| \*\*double_claim\*\* \| 59 \|/);
  assert.match(md, /\*\*30\*\* with the member's CURRENT id on another row/);
  assert.match(md, /#### Top 20 `bindable`[\s\S]*_\(no rows\)_/);
  assert.match(md, /\| Bill Foster \| IL-11 \| H8IL14067 \| H2IL11124 \|/);
  assert.match(md, /- `unlisted_live_id`: \*\*3\*\* — Ed Case \(HI-1\), Nick LaLota \(NY-1\), Robert Menendez \(NJ-8\)$/m);
  assert.match(md, /- `cross_bioguide_claim`: \*\*0\*\*$/m);
  assert.doesNotMatch(md, /\*\*missing\*\*/);
});

test("FIX-1189 §10: no row in 48 h is `missing`, and so is no row ever", () => {
  const old = { started_at: "2026-09-26T23:00:00Z", status: "complete", error: null, metadata: legMeta() };
  const stale = legislatorIdsLines({ latest: old, complete: old }, LEG_AS_OF, LEG_CLASSES).join("\n");
  assert.ok(
    stale.includes(
      "**missing** — no `congress_legislator_ids_report` row in the last " +
        LEGISLATOR_IDS_STALE_HOURS +
        " h (latest 2026-09-26T23:00:00Z",
    ),
    stale,
  );
  const never = legislatorIdsLines({ latest: null, complete: null }, LEG_AS_OF, LEG_CLASSES).join("\n");
  assert.match(never, /\*\*missing\*\*.*\(none ever\)/);
  assert.match(never, /No complete report yet/);
});

test("FIX-1189 O1 §10: the writer's line appears only once it has run, in each status", () => {
  const run = { started_at: "2026-09-28T23:05:00Z", status: "complete", error: null, metadata: legMeta() };
  const none = legislatorIdsLines({ latest: run, complete: run }, LEG_AS_OF, LEG_CLASSES).join("\n");
  assert.doesNotMatch(none, /O1 writer/, "no bind key (a pre-cc-193 file) → no line");
  const nil = legislatorIdsLines({ latest: run, complete: run, bind: null }, LEG_AS_OF, LEG_CLASSES).join("\n");
  assert.doesNotMatch(nil, /O1 writer/, "the flag never set → no row → no line");

  const acted = {
    started_at: "2026-10-06T21:03:00Z", status: "complete", error: null,
    metadata: { acted: { bound: 0, promoted: 2, prior_appended: 29, refused_changed: 0 } },
  };
  const md = legislatorIdsLines({ latest: run, complete: run, bind: acted }, LEG_AS_OF, LEG_CLASSES).join("\n");
  assert.match(md, /O1 writer \(`congress_legislator_ids_bind`\) 2026-10-06T21:03:00Z — acted: bound \*\*0\*\*, promoted \*\*2\*\*, prior_appended \*\*29\*\*, refused_changed \*\*0\*\*/);

  const held = {
    started_at: "2026-10-06T21:03:00Z", status: "skipped", error: null,
    metadata: { skip_reason: "prod session held: cc-194" },
  };
  assert.match(
    legislatorIdsBindLines(held).join("\n"),
    /— skipped: prod session held: cc-194\./,
  );
  const failed = { started_at: "2026-10-06T21:03:00Z", status: "failed", error: "canceling statement due to statement timeout", metadata: null };
  assert.match(legislatorIdsBindLines(failed).join("\n"), /— \*\*failed\*\*: canceling statement/);
});

test("FIX-1189 §10: a failed latest run says so and still carries the last COMPLETE numbers, labelled", () => {
  const failed = { started_at: "2026-09-28T23:05:00Z", status: "failed", error: "Failed to fetch …: 503", metadata: null };
  const prev = { started_at: "2026-09-27T23:04:00Z", status: "complete", error: null, metadata: legMeta() };
  const md = legislatorIdsLines({ latest: failed, complete: prev }, LEG_AS_OF, LEG_CLASSES).join("\n");
  assert.match(md, /\*\*failed\*\*: Failed to fetch …: 503/);
  assert.match(md, /last COMPLETE report's, taken 2026-09-27T23:04:00Z/);
  assert.match(md, /= population \(539\) — reconciles/);
});

test("FIX-1189 §10: a report whose classes do not sum to the population is flagged, not passed", () => {
  const meta = legMeta();
  (meta["counts"] as Record<string, number>)["noop"] = 400;
  const run = { started_at: "2026-09-28T23:05:00Z", status: "complete", error: null, metadata: meta };
  const md = legislatorIdsLines({ latest: run, complete: run }, LEG_AS_OF, LEG_CLASSES).join("\n");
  assert.match(md, /\*\*≠ population 539\*\*/);
});

test("FIX-1189 §10: a pre-O2 file (no section data) renders a stated absence", () => {
  const s: LegislatorIdsSection | undefined = undefined;
  assert.match(legislatorIdsLines(s, LEG_AS_OF, LEG_CLASSES).join("\n"), /predates FIX-1189 O2/);
  const md = renderMarkdown(fixture());
  assert.match(md.slice(md.indexOf("## 10."), md.indexOf("## 11.")), /predates FIX-1189 O2/);
});

// FIX-1238 — the vote writer's skipped rolls get one line under the nightly's
// Phases table, and only when there is something to say.
test("FIX-1238: votesSkipsLine names each skipped roll, its bill, the reason and the key holder", () => {
  const line = votesSkipsLine({
    rows_failed: 1,
    skipped_rolls: [
      {
        roll: "2026-house-295",
        bill_key: "119-HR-4795",
        proposal_id: "d536667f-6a0d-4aeb-b1b9-324c946b4701",
        reason: "bill_details_key_collision",
        holder_proposal_id: "0e2433b5-0fd3-4e27-a3ae-9741c468122d",
      },
    ],
  })!;
  assert.match(line, /congress_votes skipped 1 roll\(s\)/);
  assert.match(line, /`2026-house-295` \(119-HR-4795, bill_details_key_collision; key held by 0e2433b5\)/);
  assert.match(line, /`rows_failed` 1/);
});

test("FIX-1238: no skips (or no votes row) renders nothing — the line is not a zero report", () => {
  assert.equal(votesSkipsLine(null), null);
  assert.equal(votesSkipsLine(undefined), null);
  assert.equal(votesSkipsLine({ rows_failed: 0, skipped_rolls: [] }), null);
  const d = fixture();
  assert.doesNotMatch(renderMarkdown(d), /congress_votes skipped/);
});

test("FIX-1238: renderMarkdown puts the skip line in section 1, after the Phases table", () => {
  const d = fixture();
  d.nightly.votes_skips = {
    rows_failed: 1,
    skipped_rolls: [
      { roll: "2026-house-295", bill_key: "119-HR-4795", proposal_id: "p", reason: "bill_details_landing_failed", holder_proposal_id: null },
    ],
  };
  const md = renderMarkdown(d);
  const at = md.indexOf("congress_votes skipped 1 roll(s)");
  assert.ok(at > md.indexOf("### Phases") && at < md.indexOf("## 2. pg_cron jobs"));
  assert.doesNotMatch(md.slice(at, md.indexOf("\n", at)), /key held by/);
});

// FIX-1273 — the rule taggers' FIX-1259 kept counts get one §1 line, read off
// the tag_rules data_sync_log row. Figures are the 10-03 nightly's (cc-191
// read 2): 108,113 upserted; kept 0 / 16 / 0.
const TAG_RULES_ROW = {
  status: "complete",
  rows_inserted: 108113,
  kept_total: 16,
  kept_proposals: 0,
  kept_financial_entities: 16,
  kept_officials: 0,
};

test("FIX-1273: tagRulesKeptLine names rows upserted and the kept count per tagger", () => {
  assert.equal(
    tagRulesKeptLine(TAG_RULES_ROW),
    "**Rule taggers** (`tag_rules`): 108,113 rows upserted · kept as another writer's: " +
      "0 proposals / 16 financial entities / 0 officials (FIX-1259)",
  );
});

test("FIX-1273: a window with no tag_rules row reads missing; a pre-FIX-1273 file renders nothing", () => {
  assert.match(tagRulesKeptLine(null)!, /missing — no `tag_rules` row in the window/);
  assert.equal(tagRulesKeptLine(undefined), null);
  assert.doesNotMatch(renderMarkdown(fixture()), /Rule taggers/);
});

test("FIX-1273: a row written before the change reads (no kept metadata), not zero", () => {
  const line = tagRulesKeptLine({
    ...TAG_RULES_ROW,
    kept_total: null,
    kept_proposals: null,
    kept_financial_entities: null,
    kept_officials: null,
  })!;
  assert.match(line, /108,113 rows upserted · \(no kept metadata\)/);
  assert.doesNotMatch(line, /kept as another writer's/);
});

test("FIX-1273: a non-complete row says so; renderMarkdown puts the line in section 1", () => {
  assert.match(tagRulesKeptLine({ ...TAG_RULES_ROW, status: "failed" })!, /status `failed`/);
  const d = fixture();
  d.nightly.tag_rules_kept = TAG_RULES_ROW;
  const md = renderMarkdown(d);
  const at = md.indexOf("**Rule taggers**");
  assert.ok(at > md.indexOf("### Phases") && at < md.indexOf("## 2. pg_cron jobs"));
});

// FIX-1251 — a monthly job that has not come round yet reads `scheduled`, not
// `missing`. Schedules are the five from docs/receipts/2026-09-30.json; the
// instants are that file's generated_at and the two receipt days owed.
const NEVER_FIRED = { last_start: null, last_end: null, duration_s: null, cron_status: null, sync_status: null };
const MONTHLIES: Array<[string, string, string]> = [
  ["financial-entity-totals-reconcile", "0 12 1 * *", "2026-10-01T12:00:00Z"],
  ["donor-rollup-orphan-sweep", "30 12 1 * *", "2026-10-01T12:30:00Z"],
  ["donor-party-rollup-orphan-sweep", "0 13 1 * *", "2026-10-01T13:00:00Z"],
  ["entity-connection-stats-orphan-sweep", "30 13 1 * *", "2026-10-01T13:30:00Z"],
  ["donation-edge-orphan-sweep", "30 11 1 * *", "2026-10-01T11:30:00Z"],
];
const CTX_0930 = { asOf: new Date("2026-09-30T00:01:15.618Z"), lookbackDays: 14 };

test("FIX-1251: the five monthlies read `scheduled · next Thu 10-01` in the 09-30 file", () => {
  for (const [jobname, schedule, nextAt] of MONTHLIES) {
    const v = verdictFor(firing({ jobname, schedule, ...NEVER_FIRED }), null, CTX_0930);
    assert.equal(v.verdict, "scheduled", jobname);
    assert.equal(v.detail, "monthly · next " + nextAt, jobname);
  }
});

test("FIX-1251: in the 10-16 file (10-01 is out of the lookback) they read `scheduled · next Sun 11-01`", () => {
  const ctx = { asOf: new Date("2026-10-15T21:13:00Z"), lookbackDays: 14 };
  const v = verdictFor(firing({ schedule: "0 12 1 * *", ...NEVER_FIRED }), null, ctx);
  assert.equal(v.verdict, "scheduled");
  assert.equal(v.detail, "monthly · next 2026-11-01T12:00:00Z");
});

test("FIX-1251: a monthly that SHOULD have fired inside the lookback and did not is still `missing`", () => {
  const ctx = { asOf: new Date("2026-10-05T21:13:00Z"), lookbackDays: 14 };
  const v = verdictFor(firing({ schedule: "0 12 1 * *", ...NEVER_FIRED }), null, ctx);
  assert.equal(v.verdict, "missing");
  assert.equal(monthlyNotYetDue("0 12 1 * *", ctx), null);
});

test("FIX-1251: a monthly that DID fire inside the lookback is band-compared, never `scheduled` (rule 105)", () => {
  const ctx = { asOf: new Date("2026-10-01T21:13:00Z"), lookbackDays: 14 };
  const v = verdictFor(firing({ schedule: "0 12 1 * *", duration_s: 42 }), BAND, ctx);
  assert.equal(v.verdict, "in-band");
  assert.equal(verdictFor(firing({ schedule: "0 12 1 * *", duration_s: 42 }), null, ctx).verdict, "no-band");
});

test("FIX-1251: a daily or weekly job with no firing is still `missing`, context or not", () => {
  assert.equal(verdictFor(firing({ schedule: "30 3 * * *", ...NEVER_FIRED }), null, CTX_0930).verdict, "missing");
  assert.equal(verdictFor(firing({ schedule: "37 2 * * 6", ...NEVER_FIRED }), null, CTX_0930).verdict, "missing");
});

test("FIX-1251: without a context the split is not made (`missing`); `inactive` still outranks it", () => {
  assert.equal(verdictFor(firing({ schedule: "0 12 1 * *", ...NEVER_FIRED }), null).verdict, "missing");
  assert.equal(verdictFor(firing({ schedule: "0 12 1 * *", active: false, ...NEVER_FIRED }), null, CTX_0930).verdict, "inactive");
});

test("FIX-1251: `scheduled` renders plain in the table (not a fault), `missing` stays bold", () => {
  const d = fixture();
  d.cron_jobs = verdictsFor(
    [firing({ jobname: "m1", schedule: "0 12 1 * *", ...NEVER_FIRED }), firing({ jobname: "d1", schedule: "30 3 * * *", ...NEVER_FIRED })],
    {},
    CTX_0930,
  );
  const md = renderMarkdown(d);
  assert.match(md, /\| scheduled \| monthly · next 2026-10-01T12:00:00Z \|/);
  assert.match(md, /\| \*\*missing\*\* \| no firing in the lookback window \|/);
});

// ---------------------------------------------------------------------------
// FIX-1124 — §9 "Peers": the crawls' skip counters as a 24 h delta, and overlaps
// ---------------------------------------------------------------------------

/** cc-189 read 3: prod's lifetime counters, 01:49 UTC 10-04, before part 1 landed. */
const SKIPS_1003: CrawlSkips = {
  ec_crawl: {
    backoff: 178, blackout: 436, cycle_cooldown: 1830,
    last_skip_at: "2026-10-04T01:00:00.318728+00:00", last_skip_reason: "cycle_cooldown",
  },
  fe_crawl: {
    backoff: 100, peer_backoff: 63,
    last_skip_at: "2026-09-21T13:30:00.278717+00:00", last_skip_reason: "peer_backoff",
  },
  read_at: "2026-10-04T01:49:36.267Z",
};
/** A day later: one morning of the expected skips (ec 5 firings, fe 3) plus the day's cooldowns. */
const SKIPS_1004: CrawlSkips = {
  ec_crawl: {
    backoff: 178, blackout: 445, cycle_cooldown: 1902, peer_due: 4, peer_running: 1,
    last_skip_at: "2026-10-05T01:00:00.2Z", last_skip_reason: "cycle_cooldown",
  },
  fe_crawl: {
    backoff: 100, peer_backoff: 63, peer_due: 3,
    last_skip_at: "2026-10-04T06:30:00.1Z", last_skip_reason: "peer_due",
  },
  read_at: "2026-10-05T01:49:00.000Z",
};

test("FIX-1124: previousNominalDay — the day before, across a month and a year", () => {
  assert.equal(previousNominalDay("2026-10-05"), "2026-10-04");
  assert.equal(previousNominalDay("2026-10-01"), "2026-09-30");
  assert.equal(previousNominalDay("2027-01-01"), "2026-12-31");
});

test("FIX-1124: crawlSkipsBaselineFrom — absent, unparseable, pre-FIX-1124 and banked files", () => {
  assert.deepEqual(crawlSkipsBaselineFrom("2026-10-03.json", null), {
    available: false, file: "2026-10-03.json", reason: "2026-10-03.json does not exist",
  });
  const bad = crawlSkipsBaselineFrom("2026-10-03.json", "{not json");
  assert.equal(bad.available, false);
  assert.match(bad.available ? "" : bad.reason, /^2026-10-03\.json is unparseable \(/);
  const old = crawlSkipsBaselineFrom("2026-10-03.json", JSON.stringify({ forker: { by_hour_24h: [] } }));
  assert.deepEqual(old, {
    available: false, file: "2026-10-03.json",
    reason: "2026-10-03.json carries no forker.crawl_skips (it predates FIX-1124)",
  });
  const banked = crawlSkipsBaselineFrom("2026-10-04.json", JSON.stringify({ forker: { crawl_skips: SKIPS_1003 } }));
  assert.deepEqual(banked, { available: true, file: "2026-10-04.json", skips: SKIPS_1003 });
});

test("FIX-1124: §9 Peers — baseline present renders the 24 h delta per reason, peer reasons first", () => {
  const text = crawlSkipLines({
    ...quiet,
    crawl_skips: SKIPS_1004,
    crawl_skips_baseline: { available: true, file: "2026-10-04.json", skips: SKIPS_1003 },
    crawl_overlaps_24h: [],
  }).join("\n");
  assert.deepEqual([...CRAWL_SKIP_REASONS], ["peer_running", "peer_due", "blackout", "cycle_cooldown", "backoff", "peer_backoff"]);
  assert.match(text, /^Crawl skips — delta of the lifetime counters against `2026-10-04\.json` \(read 2026-10-04T01:49:36\.267Z → 2026-10-05T01:49:00\.000Z, 24\.0 h\)/);
  assert.match(text, /\| crawl \| peer_running \| peer_due \| blackout \| cycle_cooldown \| backoff \| peer_backoff \| last skip \|/);
  assert.match(text, /\| ec_crawl \| 1 \| 4 \| 9 \| 72 \| 0 \| 0 \| cycle_cooldown @ 2026-10-05T01:00:00\.2Z \|/);
  assert.match(text, /\| fe_crawl \| 0 \| 3 \| 0 \| 0 \| 0 \| 0 \| peer_due @ 2026-10-04T06:30:00\.1Z \|/);
  assert.match(text, /Crawl↔peer overlaps, last 24 h: \*\*0\*\* — no crawl unit's span met/);
});

test("FIX-1124: §9 Peers — no baseline prints the lifetime counters and says why", () => {
  const text = crawlSkipLines({
    ...quiet,
    crawl_skips: SKIPS_1003,
    crawl_skips_baseline: {
      available: false, file: "2026-10-03.json",
      reason: "2026-10-03.json carries no forker.crawl_skips (it predates FIX-1124)",
    },
  }).join("\n");
  assert.match(text, /^Crawl skips — \*\*no baseline\*\* \(2026-10-03\.json carries no forker\.crawl_skips \(it predates FIX-1124\)\), so these are the LIFETIME counters, read 2026-10-04T01:49:36\.267Z\./);
  assert.match(text, /\| ec_crawl \| 0 \| 0 \| 436 \| 1830 \| 178 \| 0 \|/);
  assert.match(text, /\| fe_crawl \| 0 \| 0 \| 0 \| 0 \| 100 \| 63 \|/);
  // Not read at all is its own line, not an empty table.
  assert.deepEqual(crawlSkipLines({ ...quiet }), ["Crawl skips: not read."]);
});

test("FIX-1124: §9 Peers — a counter that went DOWN is a reset, never negative skips", () => {
  const text = crawlSkipLines({
    ...quiet,
    crawl_skips: { ...SKIPS_1004, ec_crawl: { blackout: 2 } },
    crawl_skips_baseline: { available: true, file: "2026-10-04.json", skips: SKIPS_1003 },
  }).join("\n");
  assert.match(text, /\| ec_crawl \| 0 \| 0 \| reset \(2\) \| reset \(0\) \| reset \(0\) \| 0 \| — @ — \|/);
});

test("FIX-1124: §9 Peers — overlaps render a row each, with the peer's cadence (cc-189 read 4's shape)", () => {
  const text = crawlSkipLines({
    ...quiet,
    crawl_skips: SKIPS_1003,
    crawl_skips_baseline: { available: false, file: "x.json", reason: "x.json does not exist" },
    crawl_overlaps_24h: [
      {
        crawl: "financial_entity_totals_refresh", crawl_status: "complete",
        crawl_start: "2026-10-03T06:30:00.220Z", crawl_end: "2026-10-03T06:30:00.306Z",
        peer: "run_rule_taggers", peer_cadence: "daily",
        peer_start: "2026-10-03T06:30:00.192Z", peer_end: "2026-10-03T06:33:12.555Z",
      },
    ],
  }).join("\n");
  assert.match(text, /Crawl↔peer overlaps, last 24 h: \*\*1\*\*\. The weekly cadences share these pipeline names/);
  assert.match(text, /\| financial_entity_totals_refresh \| complete \| 2026-10-03T06:30:00\.220Z → 2026-10-03T06:30:00\.306Z \| run_rule_taggers \| daily \| 2026-10-03T06:30:00\.192Z → 2026-10-03T06:33:12\.555Z \|/);
});

test("FIX-1124: renderMarkdown — §9 carries the Peers subsection; renderJson banks forker.crawl_skips", () => {
  const d = fixture();
  d.forker = {
    ...d.forker,
    crawl_skips: SKIPS_1003,
    crawl_skips_baseline: { available: false, file: "2026-09-11.json", reason: "2026-09-11.json does not exist" },
    crawl_overlaps_24h: [],
  };
  const md = renderMarkdown(d);
  const s9 = md.slice(md.indexOf("## 9."), md.indexOf("## 10."));
  assert.match(s9, /### Peers — crawl skips and crawl↔daily overlaps \(FIX-1124\)/);
  assert.match(s9, /\*\*no baseline\*\* \(2026-09-11\.json does not exist\)/);
  const json = JSON.parse(renderJson(d)) as { forker: { crawl_skips: CrawlSkips } };
  assert.deepEqual(json.forker.crawl_skips, SKIPS_1003);
  // The next day's reader takes exactly what this file banked.
  assert.deepEqual(crawlSkipsBaselineFrom("2026-09-12.json", renderJson(d)), {
    available: true, file: "2026-09-12.json", skips: SKIPS_1003,
  });
});

test("FIX-1270: §9 Parked EC arms — empty is the healthy reading and says so", () => {
  assert.deepEqual(parkedArmLines({ ...quiet, ec_arm_parked: {} }), [
    "Parked EC arms (FIX-1270): **none** — no generic arm has two consecutive cancels.",
  ]);
  assert.deepEqual(parkedArmLines({ ...quiet, ec_arm_parked: null }), [
    "Parked EC arms (FIX-1270): **none** — no generic arm has two consecutive cancels.",
  ]);
  // A file written before the reader existed is "not read", never "none".
  assert.deepEqual(parkedArmLines({ ...quiet }), ["Parked EC arms (FIX-1270): not read."]);
});

test("FIX-1270: §9 Parked EC arms — a parked arm renders a row with since, cancels, fp and the cancel", () => {
  const text = parkedArmLines({
    ...quiet,
    ec_arm_parked: {
      rebuild_entity_connections_contracts: {
        since: "2026-10-04T02:28:00.077Z", cancels: 2, fp: "n=3901112;t=2026-08-31 12:00:00+00",
        last_detail: "rebuild_entity_connections_contracts: canceling statement due to user request",
        log_id: "461dad58-04c4-42a2-ab06-63779a4ba557",
      },
    },
  }).join("\n");
  assert.match(text, /^Parked EC arms \(FIX-1270\): \*\*1\*\* — skipped by every firing until the source fingerprint moves/);
  assert.match(text, /\| arm \| since \| cancels \| fp parked on \| last cancel \|/);
  assert.match(text, /\| rebuild_entity_connections_contracts \| 2026-10-04T02:28:00\.077Z \| 2 \| n=3901112;t=2026-08-31 12:00:00\+00 \| rebuild_entity_connections_contracts: canceling statement due to user request \|/);
});
