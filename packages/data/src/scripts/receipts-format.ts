/**
 * FIX-1176 — the pure half of the daily receipts file.
 *
 * Everything here is a total function over plain data: no DB, no clock, no
 * process.env, no I/O. `receipts-daily.ts` does the reading; this decides what
 * the numbers MEAN and renders them. The split exists because the verdict
 * matrix is the part that has to be right, and the DB layer is the part that
 * cannot be tested without prod — see receipts-format.test.ts for the matrix.
 *
 * THE RULE THAT DRIVES THE SHAPE: a number in a receipts file is never a claim
 * without its instrument. Every section carries the SQL that produced it in a
 * collapsed block, so a reader who doubts a figure can re-run the exact
 * statement rather than reconstruct it. That is also why `queries` carries an
 * `elapsed_ms` per statement — "the job must never be a load on the box it
 * measures" is then checkable from the file itself.
 *
 * BANDS ARE NOT MEASUREMENTS. docs/receipts/bands.json is hand-edited and this
 * module never writes it. A job with no entry gets `no-band` — never `in-band`,
 * because "nobody wrote down what normal is" and "this is normal" are different
 * facts, and collapsing them is how a detector stops covering what it
 * enumerates (the FIX-977 / playbook E5 lesson, applied to durations).
 */

/**
 * Verdict vocabulary.
 *
 * The first six are cc-123 D2's list verbatim. `failed` and `running` are
 * ADDITIONS, and the reason is a contradiction between D2 and the tree: D2
 * assumes every firing yields a duration to compare, but
 * `cron.job_run_details.status` also carries `failed` (the job raised) and
 * `running` (no `end_time` yet, so no duration at all). Rendering either
 * against a band would report a crash that died in 3 s as `in-band`, which is
 * worse than having two more words.
 */
export type Verdict =
  | "in-band"
  | "above"
  | "below"
  | "missing"
  | "skipped"
  | "no-band"
  | "failed"
  | "running";

/** One hand-written band. `hi_s` is the ceiling that matters; `lo_s` is usually 0. */
export interface Band {
  lo_s: number;
  hi_s: number;
  /** Where the numbers came from. Required — an unsourced band is folklore. */
  source: string;
}

export type Bands = Record<string, Band>;

/** A pg_cron job's most recent firing, joined to whatever data_sync_log said about it. */
export interface JobFiring {
  jobname: string;
  jobid: number | null;
  schedule: string | null;
  active: boolean;
  /** ISO-8601 UTC, or null when the job has not fired in the lookback. */
  last_start: string | null;
  last_end: string | null;
  duration_s: number | null;
  /** `cron.job_run_details.status` — 'succeeded' | 'failed' | 'running' | … */
  cron_status: string | null;
  return_message: string | null;
  /** `data_sync_log.status` for the row this firing wrote, when one correlates. */
  sync_status: string | null;
  skip_reason: string | null;
}

export interface JobVerdict extends JobFiring {
  band: Band | null;
  verdict: Verdict;
  /** Human tail for the verdict — the skip reason, the failure message, the band breached. */
  detail: string | null;
}

/**
 * The verdict matrix, in precedence order. The order IS the design:
 *
 *  1. A DELIBERATE SKIP outranks everything. The FIX-950 interlock turns a
 *     firing into a `skipped` data_sync_log row on purpose; calling that
 *     `missing` reports an operator's correct action as a fault. (This is the
 *     asymmetry FIX-1177 filed against the shared freshness readers, which
 *     count only `complete` and therefore cannot tell the two apart. The
 *     receipts file reads `data_sync_log` directly so that it can.)
 *  2. STILL RUNNING has no duration, so no band applies.
 *  3. FAILED is not a duration either — the number is how long it took to die.
 *  4. NEVER FIRED is `missing`.
 *  5. NO BAND is `no-band`. Never `in-band`.
 *  6. Only then is the duration compared.
 */
export function verdictFor(firing: JobFiring, band: Band | null): JobVerdict {
  const base = { ...firing, band };

  if (firing.sync_status === "skipped") {
    return {
      ...base,
      verdict: "skipped",
      detail: firing.skip_reason ?? "skipped (no reason recorded)",
    };
  }
  // FAILED IS CHECKED BEFORE IN-FLIGHT, and the order is load-bearing.
  // pg_cron leaves `end_time` NULL on a job that never got to run at all — the
  // FIX-1073/FIX-1137 `job startup timeout` class writes status='failed' with
  // no end_time. Inferring "in flight" from the null end_time first (which this
  // did until a prod read on 2026-09-12 caught it) reported
  // donor-party-rollup-refresh's 09-08 startup timeout as `running`, i.e. a
  // four-day-old failure rendered as healthy work in progress.
  if (firing.cron_status === "failed") {
    return {
      ...base,
      verdict: "failed",
      detail: firing.return_message ?? "cron status failed",
    };
  }
  // pg_cron's non-terminal statuses: starting, connecting, sending, running.
  // All of them mean "no duration yet", so none of them can be band-compared.
  if (firing.cron_status !== null && firing.cron_status !== "succeeded") {
    return {
      ...base,
      verdict: "running",
      detail: "in flight at read time (" + firing.cron_status + ") — no duration yet",
    };
  }
  if (firing.last_start !== null && firing.last_end === null) {
    return { ...base, verdict: "running", detail: "in flight at read time — no duration yet" };
  }
  if (firing.last_start === null || firing.duration_s === null) {
    return { ...base, verdict: "missing", detail: "no firing in the lookback window" };
  }
  return { ...base, ...compareToBand(firing.duration_s, band) };
}

/**
 * The duration comparison on its own, so a UNIT band can use exactly the same
 * rule as a JOB band. Section 3's `rebuild_entity_search_index` ceiling
 * (FIX-1152) is a unit timing read out of a run row's `unit_seconds`, not a
 * pg_cron wall time — but "above" has to mean the same thing in both places or
 * the file teaches two different vocabularies.
 */
export function compareToBand(
  seconds: number | null,
  band: Band | null,
): { verdict: Verdict; detail: string | null } {
  if (seconds === null) return { verdict: "missing", detail: "no measurement" };
  if (band === null) return { verdict: "no-band", detail: "no band in docs/receipts/bands.json" };
  if (seconds > band.hi_s) return { verdict: "above", detail: fmtSeconds(seconds) + " > " + band.hi_s + " s" };
  if (seconds < band.lo_s) return { verdict: "below", detail: fmtSeconds(seconds) + " < " + band.lo_s + " s" };
  return { verdict: "in-band", detail: null };
}

export function verdictsFor(firings: JobFiring[], bands: Bands): JobVerdict[] {
  return firings.map((f) => verdictFor(f, bands[f.jobname] ?? null));
}

/**
 * The nominal day a run names, as a UTC `YYYY-MM-DD` string.
 *
 * This is weekly-gate.ts's FIX-1163 rule, re-projected onto the file NAME
 * rather than the weekly gate: nightly.yml's cron fires at 21:00 UTC on the day
 * BEFORE the run it names, and each phase job carries
 * NIGHTLY_SLOT_OFFSET_HOURS=3 so the orchestrator reads the day off `now + 3h`.
 * The receipts file has to be named for the SAME day the run itself gated on,
 * or the file and the run it describes disagree about what day it is.
 *
 * Offset 0 (any non-scheduled invocation) is the plain UTC date, which is what
 * a human running `pnpm receipts:daily` by hand expects.
 *
 * Deliberately NOT imported from weekly-gate.ts: that module's
 * `nominalSlotInstant` projects through local `getDay()`, which is correct
 * there (it mirrors production's own gate, and GHA runners are UTC) and wrong
 * here (a file name must be UTC regardless of the machine's zone). Same rule,
 * different projection — so it is written out rather than shared, and this
 * comment is why.
 */
export function nominalDate(now: Date, slotOffsetHours: number): string {
  const shifted = new Date(now.getTime() + slotOffsetHours * 3_600_000);
  return shifted.toISOString().slice(0, 10);
}

/** One executed statement: the instrument behind a number. */
export interface QueryRecord {
  /** Stable key the sections reference. */
  key: string;
  sql: string;
  elapsed_ms: number | null;
  error: string | null;
}

export interface PhaseRow {
  phase: string;
  status: string;
  started_at: string | null;
  duration_s: number | null;
  peak_rss_mb: number | null;
  skip_reason: string | null;
  is_weekly: boolean | null;
}

export interface NightlySection {
  /** From `gh run list`; null when `gh` was unavailable (locally, usually). */
  created_at: string | null;
  run_id: number | null;
  conclusion: string | null;
  /** UTC hour:minute the cron slot names, e.g. "21:00". */
  slot_utc: string;
  /** createdAt − slot, in hours, when both are known. */
  offset_hours: number | null;
  nominal_date: string;
  slot_offset_hours: number;
  is_weekly: boolean | null;
  phases: PhaseRow[];
  /** Why the GHA half is absent, when it is. */
  gha_note: string | null;
}

export interface UnitTiming {
  unit: string;
  seconds: number;
}

export interface VmRow {
  relation: string;
  pct_all_visible: number | null;
  n_dead_tup: number | null;
  relpages: number | null;
}

export interface DailySection {
  /** The most recent firing of any status — what actually happened last. */
  run_started_at: string | null;
  run_status: string | null;
  run_skip_reason: string | null;
  /**
   * When the numbers below were taken: the most recent `complete` run. Differs
   * from `run_started_at` exactly when the last firing was skipped or failed,
   * and carrying both is what keeps a FIX-950 hold from erasing the series.
   */
  measured_at: string | null;
  units: number | null;
  units_ok: number | null;
  elapsed_seconds: number | null;
  search_unit_seconds: number | null;
  /** FIX-1152's ceiling, applied through the same `compareToBand` as a job band. */
  search_unit_band: Band | null;
  search_unit_verdict: Verdict;
  search_unit_detail: string | null;
  unit_seconds: UnitTiming[];
  vm_before: VmRow[];
  vm_now: VmRow[];
  weekly_started_at: string | null;
  weekly_status: string | null;
  weekly_elapsed_seconds: number | null;
}

export interface KeyValueRow {
  key: string;
  value: string;
}

export interface SkipRow {
  pipeline: string;
  started_at: string;
  skip_reason: string | null;
  source: string | null;
}

export interface CanaryCondition {
  key: string;
  tier: string;
  severity: number | null;
  unchangedRuns: number | null;
  detail: string;
}

export interface SldRow {
  state: string;
  chamber: string;
  unlinked: number;
}

export interface SldSection {
  total: number | null;
  linked: number | null;
  residual: number | null;
  by_state: SldRow[];
}

export interface FecSection {
  drop_probe: KeyValueRow[];
  indiv_watermark: KeyValueRow[];
  bulk_run_state: string | null;
  emit_runs: KeyValueRow[];
  emit_keys_note: string;
}

export interface InterlockSection {
  prod_session: KeyValueRow[];
  skips_24h: SkipRow[];
}

export interface VacuumRow {
  jobname: string;
  start_time: string;
  duration_s: number | null;
  status: string;
}

export interface ReceiptsData {
  nominal_date: string;
  generated_at: string;
  target: string;
  target_host: string;
  nightly: NightlySection;
  cron_jobs: JobVerdict[];
  daily: DailySection;
  vacuums: VacuumRow[];
  fec: FecSection;
  interlock: InterlockSection;
  canary: { run_started_at: string | null; conditions: CanaryCondition[] };
  sld: SldSection;
  not_capturable: string[];
  queries: QueryRecord[];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function fmtSeconds(s: number | null): string {
  if (s === null || Number.isNaN(s)) return "—";
  if (s < 60) return s.toFixed(1) + " s";
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return s.toFixed(1) + " s (" + m + "m " + rest.toFixed(0) + "s)";
}

function esc(v: unknown): string {
  if (v === null || v === undefined) return "—";
  // A pipe inside a cell would split the column; a newline would end the row.
  return String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function table(headers: string[], rows: unknown[][]): string {
  if (rows.length === 0) return "_(no rows)_\n";
  const head = "| " + headers.join(" | ") + " |";
  const sep = "|" + headers.map(() => "---").join("|") + "|";
  const body = rows.map((r) => "| " + r.map(esc).join(" | ") + " |").join("\n");
  return head + "\n" + sep + "\n" + body + "\n";
}

/** The collapsed instrument block that follows every section's numbers. */
function queryBlock(queries: QueryRecord[], keys: string[]): string {
  const picked = keys
    .map((k) => queries.find((q) => q.key === k))
    .filter((q): q is QueryRecord => q !== undefined);
  if (picked.length === 0) return "";
  const body = picked
    .map((q) => {
      const head = q.error
        ? "-- " + q.key + " — ERROR: " + q.error
        : "-- " + q.key + " — " + (q.elapsed_ms === null ? "not timed" : q.elapsed_ms + " ms");
      return head + "\n" + q.sql.trim();
    })
    .join("\n\n");
  return "<details><summary>queries</summary>\n\n```sql\n" + body + "\n```\n\n</details>\n";
}

export function renderMarkdown(d: ReceiptsData): string {
  const out: string[] = [];
  const p = (s: string): void => {
    out.push(s);
  };

  p("# Receipts — " + d.nominal_date);
  p("");
  p(
    "Generated " +
      d.generated_at +
      " against **" +
      d.target +
      "** (`" +
      d.target_host +
      "`) by `pnpm receipts:daily` (FIX-1176). Read-only: the session runs with " +
      "`default_transaction_read_only = on`, so a write in here would fail rather than land.",
  );
  p("");
  p(
    "**The date is the nightly's NOMINAL day, not the wall clock.** nightly.yml's cron fires at " +
      d.nightly.slot_utc +
      " UTC on the day *before* the run it names, and each phase carries " +
      "`NIGHTLY_SLOT_OFFSET_HOURS` so the run gates on `now + offset` (FIX-1163, " +
      "`packages/data/src/pipelines/weekly-gate.ts`). This file used offset **" +
      d.nightly.slot_offset_hours +
      "h**, so it is named for the same day the run itself gated on.",
  );
  p("");
  p("---");
  p("");

  // 1 -------------------------------------------------------------------
  p("## 1. The nightly");
  p("");
  p(
    table(
      ["field", "value"],
      [
        ["slot (cron)", d.nightly.slot_utc + " UTC, previous day"],
        ["run createdAt", d.nightly.created_at],
        ["GHA run id", d.nightly.run_id],
        ["conclusion", d.nightly.conclusion],
        [
          "offset (createdAt − slot)",
          d.nightly.offset_hours === null ? null : d.nightly.offset_hours.toFixed(2) + " h",
        ],
        ["slot offset hours", d.nightly.slot_offset_hours],
        ["nominal day", d.nightly.nominal_date],
        ["isWeekly", d.nightly.is_weekly],
      ],
    ),
  );
  if (d.nightly.gha_note !== null) {
    p("> " + d.nightly.gha_note);
    p("");
  }
  p("### Phases");
  p("");
  p(
    table(
      ["phase", "status", "started (UTC)", "duration", "peak_rss_mb", "skip_reason"],
      d.nightly.phases.map((r) => [
        r.phase,
        r.status,
        r.started_at,
        fmtSeconds(r.duration_s),
        r.peak_rss_mb,
        r.skip_reason,
      ]),
    ),
  );
  p(queryBlock(d.queries, ["nightly_phases"]));

  // 2 -------------------------------------------------------------------
  p("## 2. pg_cron jobs vs their bands");
  p("");
  p(
    "Every job in `cron.job`, matched **by NAME** — jobids differ between prod and the local " +
      "clone and are not portable (CLAUDE.md, FIX-946). `no-band` means nobody has written a " +
      "band for this job in `docs/receipts/bands.json`; it is not a pass.",
  );
  p("");
  p(
    table(
      ["job", "active", "schedule", "last firing (UTC)", "duration", "cron status", "band", "verdict", "detail"],
      d.cron_jobs.map((j) => [
        j.jobname,
        j.active ? "yes" : "**no**",
        j.schedule,
        j.last_start,
        fmtSeconds(j.duration_s),
        j.cron_status,
        j.band === null ? "—" : j.band.lo_s + "–" + j.band.hi_s + " s",
        j.verdict === "in-band" ? "in-band" : "**" + j.verdict + "**",
        j.detail,
      ]),
    ),
  );
  p(queryBlock(d.queries, ["cron_jobs"]));

  // 3 -------------------------------------------------------------------
  p("## 3. The 06:00 UTC daily (`refresh_derived_mvs`)");
  p("");
  p(
    table(
      ["field", "value"],
      [
        ["last firing (UTC)", d.daily.run_started_at],
        ["status", d.daily.run_status],
        ["skip_reason", d.daily.run_skip_reason],
        [
          "numbers below measured at",
          d.daily.measured_at === null
            ? "— (no complete run found)"
            : d.daily.measured_at +
              (d.daily.measured_at === d.daily.run_started_at
                ? ""
                : " — **the last firing was not a completion, so these are the last COMPLETE run's**"),
        ],
        ["units ok / units", esc(d.daily.units_ok) + " / " + esc(d.daily.units)],
        ["wall", fmtSeconds(d.daily.elapsed_seconds)],
        ["`rebuild_entity_search_index`", fmtSeconds(d.daily.search_unit_seconds)],
        [
          "&nbsp;&nbsp;↳ vs band",
          (d.daily.search_unit_band === null
            ? "—"
            : d.daily.search_unit_band.lo_s + "–" + d.daily.search_unit_band.hi_s + " s") +
            " → " +
            (d.daily.search_unit_verdict === "in-band"
              ? "in-band"
              : "**" + d.daily.search_unit_verdict + "**") +
            (d.daily.search_unit_detail === null ? "" : " (" + d.daily.search_unit_detail + ")"),
        ],
      ],
    ),
  );
  p("### Unit timings");
  p("");
  p(table(["unit", "seconds"], d.daily.unit_seconds.map((u) => [u.unit, u.seconds.toFixed(1)])));
  p("### `vm_before` — the run's own reading");
  p("");
  p(
    table(
      ["relation", "pct_all_visible", "n_dead_tup", "relpages"],
      d.daily.vm_before.map((v) => [v.relation, v.pct_all_visible, v.n_dead_tup, v.relpages]),
    ),
  );
  p("### Visibility map now");
  p("");
  p(
    table(
      ["relation", "pct_all_visible", "n_dead_tup", "relpages"],
      d.daily.vm_now.map((v) => [v.relation, v.pct_all_visible, v.n_dead_tup, v.relpages]),
    ),
  );
  p("### The weekly (`refresh-derived-mvs-weekly`)");
  p("");
  p(
    table(
      ["field", "value"],
      [
        ["started (UTC)", d.daily.weekly_started_at],
        ["status", d.daily.weekly_status],
        ["wall", fmtSeconds(d.daily.weekly_elapsed_seconds)],
      ],
    ),
  );
  p(queryBlock(d.queries, ["daily_run", "vm_now", "weekly_run"]));

  // 4 -------------------------------------------------------------------
  p("## 4. Hour-04 vacuums (FIX-1169's series)");
  p("");
  p(
    table(
      ["job", "start (UTC)", "duration", "status"],
      d.vacuums.map((v) => [v.jobname, v.start_time, fmtSeconds(v.duration_s), v.status]),
    ),
  );
  p(queryBlock(d.queries, ["vacuums"]));

  // 5 -------------------------------------------------------------------
  p("## 5. FEC — drop probe, watermarks, emit set");
  p("");
  p("### `pipeline_state.fec_drop_probe`");
  p("");
  p(table(["key", "value"], d.fec.drop_probe.map((r) => [r.key, r.value])));
  p("### `pipeline_state.fec_indiv_watermark`");
  p("");
  p(table(["cycle", "last_modified"], d.fec.indiv_watermark.map((r) => [r.key, r.value])));
  p("### `pipeline_state.fec_bulk_run_state`");
  p("");
  p(
    d.fec.bulk_run_state === null
      ? "_Absent — no bulk run in flight. FIX-754 clears this key at cycle completion, so its absence IS the \"cycle complete\" signal._\n"
      : "```json\n" + d.fec.bulk_run_state + "\n```\n",
  );
  p("### `fec_emit_runs` — latest per (cycle, source)");
  p("");
  p(table(["run", "detail"], d.fec.emit_runs.map((r) => [r.key, r.value])));
  p("");
  p("> " + d.fec.emit_keys_note);
  p("");
  p(queryBlock(d.queries, ["fec_state", "fec_emit"]));

  // 6 -------------------------------------------------------------------
  p("## 6. Prod-session interlock footprint (FIX-950)");
  p("");
  p("### `prod_session_state()` now");
  p("");
  p(table(["field", "value"], d.interlock.prod_session.map((r) => [r.key, r.value])));
  p("### Every `skipped` row in the last 24 h");
  p("");
  p(
    table(
      ["pipeline", "started (UTC)", "source", "skip_reason"],
      d.interlock.skips_24h.map((s) => [s.pipeline, s.started_at, s.source, s.skip_reason]),
    ),
  );
  p(queryBlock(d.queries, ["prod_session", "skips_24h"]));

  // 7 -------------------------------------------------------------------
  p("## 7. Canary conditions");
  p("");
  p(
    "Last `canary_check` run: " +
      esc(d.canary.run_started_at) +
      ". Conditions are keyed and carry an unchanged-run counter (FIX-1036); the canary pages on " +
      "a TRANSITION, so a long-standing `escalate` here is not new news.",
  );
  p("");
  p(
    table(
      ["key", "tier", "severity", "unchanged runs", "detail"],
      d.canary.conditions.map((c) => [c.key, c.tier, c.severity, c.unchangedRuns, c.detail]),
    ),
  );
  p(queryBlock(d.queries, ["canary"]));

  // 8 -------------------------------------------------------------------
  p("## 8. SLD district linkage");
  p("");
  p(
    table(
      ["field", "value"],
      [
        ["total active state legislators", d.sld.total],
        ["linked", d.sld.linked],
        ["residual (unlinked)", d.sld.residual],
      ],
    ),
  );
  p("### Residual by state / chamber");
  p("");
  p(
    "Expected shape after FIX-914: **ME lower only** (tribal representatives). Any other state " +
      "in this table is a regression.",
  );
  p("");
  p(table(["state", "chamber", "unlinked"], d.sld.by_state.map((r) => [r.state, r.chamber, r.unlinked])));
  p(queryBlock(d.queries, ["sld_coverage", "sld_residual"]));

  // 9 -------------------------------------------------------------------
  p("## 9. Not capturable here");
  p("");
  p("Named reads that have **no SQL surface**, listed so nobody reads their absence as a clean check.");
  p("");
  p(d.not_capturable.map((s) => "- " + s).join("\n"));
  p("");

  // Instrument cost ------------------------------------------------------
  p("---");
  p("");
  p("## Instrument cost");
  p("");
  p(
    table(
      ["query", "elapsed", "error"],
      d.queries.map((q) => [q.key, q.elapsed_ms === null ? "—" : q.elapsed_ms + " ms", q.error]),
    ),
  );
  const total = d.queries.reduce((a, q) => a + (q.elapsed_ms ?? 0), 0);
  p("");
  p("**Total DB time: " + total + " ms** across " + d.queries.length + " statements.");
  p("");

  return out.join("\n") + "\n";
}

/** The machine sidecar. Same data, no prose — this is what tooling reads. */
export function renderJson(d: ReceiptsData): string {
  return JSON.stringify(d, null, 2) + "\n";
}
