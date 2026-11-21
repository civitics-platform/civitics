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
 *   - the thirteen `*-vacuum-analyze` jobs, whose command is a bare `VACUUM`
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
  /** The job's live `cron.job.schedule` expression, e.g. `30 4 * * *`. */
  schedule: string;
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
  SELECT j.jobid, j.jobname, j.active, j.schedule,
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
SELECT jobid, jobname, active, schedule, proc,
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

// ---------------------------------------------------------------------------
// Owner schedules — FIX-1193 (ii)
// ---------------------------------------------------------------------------

/** What the tail cost table needs to know about one scheduled owner. */
export interface OwnerSchedule {
  /**
   * `source: "cron"` — the live `cron.job.schedule` expression.
   * `source: "registry"` — the owner's `job_registry.deadline_rule`.
   */
  schedule: string;
  /**
   * `source: "cron"` — the job's command reaches a procedure consulting
   * `prod_session_state()`. `source: "registry"` — the row's `gates` carry
   * `prod_session`, so the dispatcher defers it while a supervised session holds.
   */
  guarded: boolean;
  /**
   * `cron.job.active` — a scheduled owner that is switched off collects nothing.
   * Always true for a dispatched owner: its pg_cron twin is parked BY DESIGN and
   * the dispatcher fires it, so the twin's `active` says nothing about it.
   */
  active: boolean;
  /** FIX-1437 — which table decided this owner. */
  source: "registry" | "cron";
}

/**
 * The `job_registry` columns the owner read needs — FIX-1437.
 *
 * Since cc-267 the VACUUM owners (and the MV / rollup owners) are DISPATCHED
 * rows: the dispatcher fires them under their `gates`, and their `cron.job`
 * slots are parked. Read off `cron.job` alone they render as their parked
 * schedule, `[INACTIVE]`, and UNGUARDED (a bare `VACUUM` consults nothing),
 * which is how the FIX-1302 apply (cc-293) printed a false FIX-1193 warning.
 */
export const Q_OWNER_REGISTRY = `
SELECT job, deadline_rule, gates
FROM public.job_registry
ORDER BY job`;

/** One `Q_OWNER_REGISTRY` row. */
export interface OwnerRegistryRow {
  job: string;
  deadline_rule: string;
  gates: string[] | null;
}

/**
 * A registry row the dispatcher owns: its deadline rule is not a fixed `at …`
 * clock. The same test `prod_op_gate` (b) and PROMPT_TEMPLATE §Drain-and-wait
 * (a) use: `deadline_rule !~ '^at '`. An `at …` row fires from its own
 * `cron.job` slot, so the cron read decides it.
 */
export function isDispatched(rule: string): boolean {
  return !/^at /.test(rule);
}

/** The one line a failed registry read prints, then the cron read stands alone. */
export const REGISTRY_NOT_READ = "registry not read — schedules from cron.job only";

/**
 * Every owner keyed by NAME, for a caller that has an owner name and wants to
 * know when it next runs and whether a supervised session defers it.
 *
 * Two small statements merged into one map — FIX-1437. `cron.job` gives every
 * row; a `job_registry` row the dispatcher owns (`isDispatched`) then REPLACES
 * its name's cron row, so a dispatched owner's parked twin is never what
 * prints. A name with no registry row, or with an `at …` rule, is decided by
 * the cron read alone. The registry wins the decision, but it is queried
 * SECOND: a failed statement inside a caller's open transaction aborts it, and
 * a registry failure must degrade to the cron read (one printed line), never
 * take the cron read down with it.
 *
 * Keyed by NAME and never by jobid, because jobids differ between prod and the
 * local clone by construction — the clone's `cron` schema is local history
 * (CLAUDE.md / FIX-946): `ec-vacuum-analyze` is jobid 6 on prod and 15 here.
 * A jobid read off one database and used against the other names a different
 * job, silently.
 *
 * The point of reading this rather than writing it down: the tail cost table
 * carried its owners' schedules as hard-coded parentheticals
 * ("fr-vacuum-analyze (Mon 01:00)") until FIX-1193, and a parenthetical is a
 * second source of truth that goes stale the day the schedule moves — which is
 * exactly what FIX-1191's daily-FR change does to that one. One read, called
 * once per run, is cheaper than a stale string that reads as authoritative.
 */
export async function readOwnerSchedules(client: {
  query: (sql: string) => Promise<{ rows: unknown[] }>;
}): Promise<Map<string, OwnerSchedule>> {
  const cron = (await client.query(Q_CRON_JOB_PIPELINES)).rows as CronJobPipeline[];
  const owners = new Map<string, OwnerSchedule>(
    cron.map((r) => [
      r.jobname,
      { schedule: r.schedule, guarded: r.guarded, active: r.active, source: "cron" },
    ]),
  );
  let registry: OwnerRegistryRow[];
  try {
    registry = (await client.query(Q_OWNER_REGISTRY)).rows as OwnerRegistryRow[];
  } catch (err) {
    console.info(`  ! ${REGISTRY_NOT_READ} (${err instanceof Error ? err.message : String(err)})`);
    return owners;
  }
  for (const r of registry) {
    if (!isDispatched(r.deadline_rule)) continue;
    owners.set(r.job, {
      schedule: r.deadline_rule,
      guarded: (r.gates ?? []).includes("prod_session"),
      active: true,
      source: "registry",
    });
  }
  return owners;
}

/** One in-flight/settled read per client, so a run reads its owners exactly once. */
const OWNER_SCHEDULE_CACHE = new WeakMap<object, Promise<Map<string, OwnerSchedule>>>();

/**
 * `readOwnerSchedules`, memoised per client — FIX-1201.
 *
 * The deferred-tail banner is printed from inside `runVacuum` / `runMvsAndVacuum`
 * / `runRollups`, which are reached on several different paths and NOT always
 * after the point where `main()` reads the owners for the tail cost table. So
 * the banner cannot simply be handed the map `main()` already has without
 * threading an optional parameter through some twenty call sites, most of which
 * would only ever pass it through.
 *
 * Memoising the read instead keeps the property that actually matters — ONE
 * owner read per run, whoever asks first — while leaving
 * `printDeferredTail(kind, owners?)` a pure function of its arguments, which is
 * what makes it unit-testable with stubbed rows.
 *
 * The promise is cached, not the value, so two concurrent callers share one
 * query rather than racing two. A rejection is not cached: the entry is dropped
 * so a later caller can retry, and a failed owner read degrades the banner to
 * `?` (the `printTailTable` convention: "nobody looked", not "nothing owns it")
 * rather than failing a remediation run.
 */
export async function readOwnerSchedulesOnce(client: {
  query: (sql: string) => Promise<{ rows: unknown[] }>;
}): Promise<Map<string, OwnerSchedule>> {
  const hit = OWNER_SCHEDULE_CACHE.get(client);
  if (hit) return hit;
  const p = readOwnerSchedules(client).catch((err: unknown) => {
    OWNER_SCHEDULE_CACHE.delete(client);
    throw err;
  });
  OWNER_SCHEDULE_CACHE.set(client, p);
  return p;
}
