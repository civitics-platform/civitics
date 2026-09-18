/**
 * The pg_cron job → `data_sync_log` pipeline mapping, DERIVED from the catalog.
 *
 * There is no table for this and there should not be one: a mapping table is a
 * second source of truth that drifts silently the moment a migration renames a
 * procedure or a pipeline literal. The mapping is already written down twice in
 * the database — once in `cron.job.command` (which procedure a job CALLs) and
 * once in that procedure's own body (which pipeline literal it INSERTs) — so
 * this reads both and joins them.
 *
 * Two literal forms exist in the tree, both matched here:
 *
 *   INSERT INTO public.data_sync_log (pipeline, …) VALUES ('<name>', …)
 *   c_pipeline text := '<name>';        -- donor_rollup_rebuild_bulk
 *
 * Three job classes resolve NULL, all of them correctly:
 *
 *   - the twelve `*-vacuum-analyze` jobs, whose command is a bare `VACUUM`
 *     with no procedure at all (`proc IS NULL`);
 *   - the two every-two-minutes watchdogs (`enforce_cron_job_budgets`,
 *     `enforce_derived_mvs_unit_budget`), which READ and UPDATE other
 *     pipelines' rows and never INSERT one of their own;
 *   - `abuse-events-retention`, whose procedure writes no `data_sync_log` row.
 *
 * A NULL pipeline is the whole point. It is what lets a reader of this mapping
 * say "this job has no writer" instead of guessing, which is the bug FIX-1190
 * closes: the receipts cron table used to correlate a firing to a
 * `data_sync_log` row TIME-FIRST, so a job with no writer of its own inherited
 * whichever neighbour happened to write within ±90 s. On 2026-09-15 that
 * rendered `ec-vacuum-analyze` and `officials-vacuum-analyze` as `skipped`
 * carrying `ec_crawl`'s backoff reason — a vacuum reported as an interlock skip
 * it had no part in.
 *
 * Comment-only lines are stripped from `prosrc` before the literal regexes run.
 * No procedure carries a commented-out pipeline literal today (checked on the
 * clone, 2026-09-18: the five comment lines mentioning `data_sync_log` are all
 * prose), but the regexes have no comment awareness of their own, so a
 * commented-out `VALUES ('…'` added later would otherwise resolve as live.
 */

/** One row of the derived mapping — one row per job in `cron.job`. */
export interface CronJobPipeline {
  jobid: number;
  jobname: string;
  active: boolean;
  /** The procedure the job's command CALLs / SELECTs, or null for a bare VACUUM. */
  proc: string | null;
  /** The `data_sync_log.pipeline` literal that procedure writes, or null. */
  pipeline: string | null;
  /** True when the procedure INSERTs a `data_sync_log` row at all. */
  writes_dsl: boolean;
  /** True when the procedure consults `prod_session_state()` — the FIX-950 interlock. */
  guarded: boolean;
}

/**
 * The three patterns the derivation turns on, as SQL-regex source.
 *
 * They are constants rather than inline literals so the unit suite can assert
 * against the SAME text the query runs. A test that re-types the pattern tests
 * its own copy, which is how a regex and its test drift apart.
 *
 * They are `String.raw` so a backslash in the source IS a backslash in the
 * pattern — a plain string literal would need doubling, and the doubling is
 * exactly what gets miscounted. Single quotes are SQL-escaped (`''`) because
 * these are spliced into a SQL string literal; `sqlRegexToJs()` undoes that
 * for the tests.
 */
export const RE_PROC_FROM_COMMAND = String.raw`(?:CALL|SELECT)\s+(?:public\.)?([a-z_0-9]+)\s*\(`;

/** `INSERT INTO public.data_sync_log (pipeline, …) VALUES ('<name>', …)` */
export const RE_PIPELINE_FROM_INSERT =
  String.raw`data_sync_log\s*\([^)]*\)\s*VALUES\s*\(\s*''([a-z_0-9]+)''`;

/** `c_pipeline text := '<name>';` — the `donor_rollup_rebuild_bulk` form. */
export const RE_PIPELINE_FROM_LOCAL = String.raw`c_pipeline\s+text\s*:=\s*''([a-z_0-9]+)''`;

/** A comment-ONLY line. Inline trailing comments are deliberately left alone. */
export const RE_COMMENT_ONLY_LINE = String.raw`(?n)^[ \t]*--[^\n]*$`;

/**
 * The SQL-escaped pattern text as a JS RegExp, for the unit suite.
 *
 * Only the escaping differs between the two engines for these patterns: `\s`,
 * `\t`, `[^)]` and the capture groups mean the same thing in both. Postgres's
 * `(?n)` newline-sensitive flag has no JS spelling, so it maps to `m` — which
 * is the half that matters here, `^`/`$` per line.
 */
export function sqlRegexToJs(pattern: string, flags = "i"): RegExp {
  const hasN = pattern.startsWith("(?n)");
  return new RegExp(
    (hasN ? pattern.slice(4) : pattern).replace(/''/g, "'"),
    hasN ? flags + "m" : flags,
  );
}

/**
 * One derivation site, shared by the receipts file (FIX-1190) and
 * `claimProdSession()`'s hold set (FIX-1177/1172). Two copies of this query
 * would be two mappings.
 *
 * Takes no parameters. Returns one row per `cron.job` row, ordered by jobname.
 */
export const Q_CRON_JOB_PIPELINES = `
WITH job AS (
  SELECT j.jobid, j.jobname, j.active,
         (regexp_match(j.command, '${RE_PROC_FROM_COMMAND}', 'i'))[1] AS proc
  FROM cron.job j
), src AS (
  SELECT job.*,
         -- Comment-only lines removed; inline trailing comments left alone,
         -- since a live literal can sit on a line that ends in one.
         regexp_replace(pr.prosrc, '${RE_COMMENT_ONLY_LINE}', '', 'g') AS body,
         pr.prosrc AS raw
  FROM job
  LEFT JOIN pg_proc pr
         ON pr.proname = job.proc
        AND pr.pronamespace = 'public'::regnamespace
)
SELECT jobid, jobname, active, proc,
       COALESCE(
         (regexp_match(body, '${RE_PIPELINE_FROM_INSERT}', 'i'))[1],
         (regexp_match(body, '${RE_PIPELINE_FROM_LOCAL}', 'i'))[1]
       )                                                                AS pipeline,
       COALESCE(raw ILIKE '%INSERT INTO public.data_sync_log%', false)  AS writes_dsl,
       COALESCE(raw ILIKE '%prod_session_state%', false)                AS guarded
FROM src
ORDER BY jobname`;

/** The guarded subset, as pipeline names — the set a supervised session holds. */
export const Q_GUARDED_PIPELINES = `
WITH jp AS (${Q_CRON_JOB_PIPELINES})
SELECT DISTINCT pipeline FROM jp
WHERE guarded AND pipeline IS NOT NULL
ORDER BY pipeline`;
