/**
 * FIX-1176 — `pnpm receipts:daily`: the standing reads, as a file.
 *
 * WHY THIS EXISTS. Most of the "reads to bank" in every Cowork prompt are the
 * same dozen queries every day — when the nightly started against its slot, the
 * phase durations and peak_rss_mb, the daily vacuum durations, the 06:00
 * daily's units and vm_before, a dozen pg_cron jobs against their bands, the
 * FEC drop probe, the FIX-950 interlock's footprint, the canary's conditions,
 * the SLD residual. None of that needs a model. Once it is a file, "receipt =
 * the next scheduled run" becomes "receipt = tomorrow's file", and the standing
 * no-prod-contact-while-a-receipt-is-being-taken rule shrinks from a whole
 * session to this job's own runtime (a few seconds — see the Instrument cost
 * table every file carries).
 *
 * WHAT IT WRITES. Two files per UTC-nominal day under `docs/receipts/`:
 *   YYYY-MM-DD.md    — human; every number next to the SQL that produced it
 *   YYYY-MM-DD.json  — machine; the same data, for Cowork and any tooling
 * Idempotent: re-running for the same date overwrites both.
 *
 * READ-ONLY BY CONSTRUCTION, not by intention. The session sets
 * `default_transaction_read_only = on` before anything else, so a write in here
 * fails with 25006 rather than landing. That is the whole safety story: this job
 * runs unattended against prod every night and must never be able to change it.
 *
 * COST DISCIPLINE. `statement_timeout` is 15 s per statement and every query is
 * timed, with the timings rendered into the file. A job that measures the box
 * must not be a load on it — so `fec_emit_keys` is reported from
 * `fec_emit_runs.keys` plus a planner estimate rather than `count(*)` over a
 * table with hundreds of millions of rows, and every failed statement degrades
 * that section rather than killing the run.
 *
 * WHAT IT CANNOT SEE. Section 11 of the output names the reads with no SQL
 * surface (57014 counts live in `postgres_logs`, which the Logs API serves and
 * SQL does not; GHA job logs age out). They are listed so their absence is
 * never mistaken for a clean check.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveUnderRepoRoot } from "../lib/repo-root";
import { isLocalDsn, receiptsOutDir } from "../lib/receipts-out-dir";
import type { Client } from "pg";
import { buildDbUrl } from "../lib/heavy-rebuild";
import { Q_CRON_JOB_PIPELINES } from "../lib/cron-job-pipelines";
import { readBoxHealthRing, upstashCredsFromEnv } from "@civitics/db";
import { memoryDay, seriesRows, seriesStats, type MemoryDay } from "../lib/box-health-series";
import { type DispatchStamp, type NightlyRunRow, isAlreadyRanRun } from "./receipts-format";
import {
  type Bands,
  type CanaryCondition,
  type JobConclusion,
  type JobFiring,
  type KeyValueRow,
  type LegislatorIdsRun,
  type PhaseRow,
  type QueryRecord,
  type ReceiptsData,
  type SkipRow,
  type SldRow,
  type UnitTiming,
  type VacuumRow,
  type VmRow,
  type VmProbeRow,
  type VotesSkips,
  type TagRulesKept,
  type ForkerBucketRow,
  type ForkerCancelRow,
  type ForkerRunningRow,
  type MemDay,
  type CrawlOverlapRow,
  type CrawlSkipCounters,
  type CrawlSkips,
  BURST_THRESHOLD,
  compareToBand,
  crawlSkipsBaselineFrom,
  nominalDate,
  previousNominalDay,
  renderJson,
  renderMarkdown,
  verdictsFor,
} from "./receipts-format";

/**
 * The cron slot nightly.yml fires on. Kept as a string because it is printed,
 * not computed with; the hour below is the computed half.
 */
const SLOT_UTC = "21:00";
const SLOT_HOUR_UTC = 21;

/**
 * Default slot offset in hours when NIGHTLY_SLOT_OFFSET_HOURS is absent.
 *
 * DELIBERATELY 3, WHERE weekly-gate.ts DEFAULTS TO 0. The difference is not an
 * oversight. weekly-gate defaults to 0 because a plain `workflow_dispatch`
 * genuinely wants wall-clock semantics. This file always describes a SCHEDULED
 * nightly, so the slot rule always applies — a hand-run `pnpm receipts:daily`
 * at 06:00 UTC wants last night's 22:5x run, and offset 0 would put that run
 * one day outside the window and render an empty section 1. The GHA job passes
 * the env explicitly (mirroring the phase jobs' expression), so the default
 * only ever governs a hand run.
 */
const DEFAULT_SLOT_OFFSET_HOURS = 3;

/** Per-statement cap. Nothing here should come close; this is the backstop. */
const STATEMENT_TIMEOUT = "15s";

/** How far back `cron.job_run_details` is scanned for "the last firing". */
const CRON_LOOKBACK_DAYS = 14;

/**
 * The daily vacuum jobs, by NAME (jobids are not portable — FIX-946).
 *
 * FIX-1191 put `financial_relationships` on its own DAILY 03:00 slot, which is
 * why this list is no longer "the two hour-04 jobs": the FR vacuum is the one
 * that does not fire in hour 04, and leaving it out rendered section 4 as a
 * complete series that was missing its most expensive member.
 *
 * FIX-1239 added `votes-vacuum-analyze` — WEEKLY (Sat 02:37), not daily, but
 * `votes` is already on the pre-ec probe, and a probe with no wall beside it is
 * the cc-138 gap again. Q_VACUUMS' LIMIT is sized to keep one full week of all
 * four in view (see there).
 */
const VACUUM_JOBS = ["fr-vacuum-analyze", "ec-vacuum-analyze", "fe-vacuum-analyze", "votes-vacuum-analyze"];

/** The unit whose duration FIX-1152 watches. */
const SEARCH_UNIT = "rebuild_entity_search_index";

/**
 * The bands.json key for that unit. A `job:unit` key, so one flat map holds
 * both job bands and the handful of unit bands without a second schema.
 */
const SEARCH_UNIT_BAND_KEY = "refresh-derived-mvs-daily:" + SEARCH_UNIT;

interface Args {
  date: string | null;
  target: "local" | "prod" | "auto";
  dryRun: boolean;
  outDir: string;
  /** FIX-1209 — whether `--out` was GIVEN, not merely what it resolved to. */
  outGiven: boolean;
  slotOffsetHours: number | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    date: null,
    target: "auto",
    dryRun: false,
    outDir: "docs/receipts",
    outGiven: false,
    slotOffsetHours: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--date") {
      i += 1;
      a.date = argv[i] ?? null;
    } else if (arg === "--out") {
      i += 1;
      a.outDir = argv[i] ?? a.outDir;
      a.outGiven = argv[i] !== undefined;
    } else if (arg === "--slot-offset") {
      i += 1;
      a.slotOffsetHours = Number(argv[i]);
    } else if (arg === "--local") {
      a.target = "local";
    } else if (arg === "--prod") {
      a.target = "prod";
    } else if (arg === "--dry-run") {
      a.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      console.info(
        "receipts-daily — read-only daily receipts file (FIX-1176)\n\n" +
          "  --date YYYY-MM-DD   nominal day to report on (default: derived from now + slot offset)\n" +
          "  --local | --prod    force the target DB (default: whatever NEXT_PUBLIC_SUPABASE_URL says)\n" +
          "  --dry-run           print both files to stdout, write nothing\n" +
          "  --out DIR           output directory (default: docs/receipts)\n" +
          "  --slot-offset N     override NIGHTLY_SLOT_OFFSET_HOURS (default " +
          DEFAULT_SLOT_OFFSET_HOURS +
          ")\n",
      );
      process.exit(0);
    }
  }
  if (a.date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(a.date)) {
    console.error("[receipts] --date must be YYYY-MM-DD, got " + JSON.stringify(a.date));
    process.exit(1);
  }
  if (a.slotOffsetHours !== null && (!Number.isInteger(a.slotOffsetHours) || a.slotOffsetHours < 0 || a.slotOffsetHours > 23)) {
    console.error("[receipts] --slot-offset must be an integer in [0,23]");
    process.exit(1);
  }
  return a;
}

/**
 * Resolve the slot offset. Explicit flag, then the env the phase jobs set, then
 * the default above. An unparseable env value is REFUSED (falls through to the
 * default) rather than applied — same reasoning as weekly-gate's parser: a
 * fat-fingered value would silently rename the file by a day.
 */
function resolveSlotOffset(args: Args): number {
  if (args.slotOffsetHours !== null) return args.slotOffsetHours;
  const raw = process.env["NIGHTLY_SLOT_OFFSET_HOURS"];
  if (raw !== undefined && /^\d{1,2}$/.test(raw.trim())) {
    const n = Number(raw.trim());
    if (n >= 0 && n <= 23) return n;
  }
  if (raw !== undefined && raw.trim() !== "") {
    console.warn(
      "[receipts] NIGHTLY_SLOT_OFFSET_HOURS=" +
        JSON.stringify(raw) +
        " is not an integer in [0,23] — using the default " +
        DEFAULT_SLOT_OFFSET_HOURS,
    );
  }
  return DEFAULT_SLOT_OFFSET_HOURS;
}

/**
 * A RELATIVE --out MUST NOT resolve against process.cwd(). `pnpm --filter
 * @civitics/data …` runs with the cwd at `packages/data`, so `docs/receipts`
 * would silently become `packages/data/docs/receipts` — a directory nothing
 * reads, with the run still looking clean. An ABSOLUTE --out is taken verbatim.
 *
 * FIX-1198 lifted the walk-up into lib/repo-root.ts so this and
 * audit-fec-emit-residue share one copy instead of two that can drift.
 */
function resolveOutDir(outDir: string): string {
  return resolveUnderRepoRoot(outDir, "receipts");
}

/**
 * FIX-1209 — the canonical directory (where `bands.json` lives, and where the
 * nightly `--prod` run writes) and the directory THIS run may write its
 * receipt to. They differ only for a LOCAL run that was not given `--out`,
 * which is the one case that used to overwrite the day's prod receipt.
 *
 * Keyed on the resolved DSN, not on the flag: `auto` reaches whichever
 * database `.env.local` names, and `.env.local` pointing at prod is a
 * documented normal state.
 */
function resolveReceiptPaths(args: Args, isLocal: boolean): { bandsDir: string; outDir: string; redirected: boolean } {
  const bandsDir = resolveOutDir(args.outDir);
  const outDir = receiptsOutDir(bandsDir, { local: isLocal, outGiven: args.outGiven });
  return { bandsDir, outDir, redirected: outDir !== bandsDir };
}

function resolveDbUrl(target: Args["target"]): string {
  if (target === "local") return "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  if (target === "prod") {
    const password = process.env["SUPABASE_DB_PASSWORD"];
    if (process.env["SUPABASE_DB_URL"] !== undefined) return process.env["SUPABASE_DB_URL"] as string;
    if (password === undefined || password === "") {
      console.error("[receipts] --prod needs SUPABASE_DB_PASSWORD (or SUPABASE_DB_URL) in the environment.");
      process.exit(1);
    }
    const url = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "";
    const m = url.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
    if (m === null) {
      console.error("[receipts] --prod needs NEXT_PUBLIC_SUPABASE_URL to name the project ref, got " + JSON.stringify(url));
      process.exit(1);
    }
    const region = process.env["SUPABASE_DB_REGION"] ?? "us-west-2";
    return (
      "postgresql://postgres." +
      m[1] +
      ":" +
      encodeURIComponent(password) +
      "@aws-0-" +
      region +
      ".pooler.supabase.com:5432/postgres"
    );
  }
  return buildDbUrl();
}

/** Host only — the DSN carries a password and must never reach the file. */
function hostOf(dsn: string): string {
  try {
    const u = new URL(dsn);
    return u.hostname + ":" + (u.port === "" ? "5432" : u.port);
  } catch {
    return "(unparseable DSN)";
  }
}

/**
 * Run one statement, time it, and record it. A failure degrades that section to
 * empty and is rendered in the file — the run never dies on one bad read,
 * because a receipts file that is 90 % present beats no file at all on the
 * night something is broken (which is exactly when it is worth having).
 */
class Reader {
  readonly queries: QueryRecord[] = [];

  constructor(private readonly client: Client) {}

  async run<T>(key: string, sql: string, params: unknown[] = []): Promise<T[]> {
    const t0 = Date.now();
    try {
      const res = await this.client.query(sql, params as never[]);
      this.queries.push({ key, sql, elapsed_ms: Date.now() - t0, error: null });
      return res.rows as T[];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.queries.push({ key, sql, elapsed_ms: Date.now() - t0, error: msg });
      console.warn("[receipts] query " + key + " FAILED: " + msg + " — section degraded, run continues");
      return [];
    }
  }
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().replace(".000Z", "Z");
  return String(v);
}

function str(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

// ---------------------------------------------------------------------------
// The reads
// ---------------------------------------------------------------------------

const Q_NIGHTLY_PHASES = `
SELECT started_at, status,
       metadata->>'phase'                        AS phase,
       (metadata->>'duration_ms')::numeric/1000  AS duration_s,
       (metadata->>'peak_rss_mb')::numeric       AS peak_rss_mb,
       metadata->>'skip_reason'                  AS skip_reason,
       (metadata->>'is_weekly')::boolean         AS is_weekly,
       metadata->>'github_run_id'                AS github_run_id,
       metadata->>'dispatched_by'                AS dispatched_by
FROM public.data_sync_log
WHERE pipeline IN ('nightly_cron','nightly_killed')
  AND started_at >= $1::timestamptz
  AND started_at <  $2::timestamptz
ORDER BY started_at`;

/**
 * FIX-1238 — the nightly window's latest `congress_votes` row. `skipped_rolls`
 * is the vote writer's record of rolls it did not insert because the bill has
 * no `bill_details` row (the FK target of `votes.bill_proposal_id`).
 */
const Q_VOTES_SKIPS = `
SELECT rows_failed, metadata->'skipped_rolls' AS skipped_rolls
FROM public.data_sync_log
WHERE pipeline = 'congress_votes'
  AND started_at >= $1::timestamptz
  AND started_at <  $2::timestamptz
ORDER BY started_at DESC
LIMIT 1`;

/**
 * FIX-1273 — the nightly window's latest `tag_rules` row. `kept_*` is the
 * FIX-1259 provenance guard's count per tagger, written by runRuleBasedTagger
 * through the FIX-911 metadata channel; absent on rows before FIX-1273.
 */
const Q_TAG_RULES_KEPT = `
SELECT status, rows_inserted,
       metadata->'kept_total'              AS kept_total,
       metadata->'kept_proposals'          AS kept_proposals,
       metadata->'kept_financial_entities' AS kept_financial_entities,
       metadata->'kept_officials'          AS kept_officials
FROM public.data_sync_log
WHERE pipeline = 'tag_rules'
  AND started_at >= $1::timestamptz
  AND started_at <  $2::timestamptz
ORDER BY started_at DESC
LIMIT 1`;

/**
 * FIX-1218 — the nightly dispatcher's per-call stamp. One row by primary key,
 * rewritten on every call of /api/cron/gha-dispatch/nightly (dispatched,
 * refused or error). Absent before the FIX-1218 migration, or before the
 * route's first call after it; the renderer says which.
 */
const Q_GHA_DISPATCH_NIGHTLY = `
SELECT value
FROM public.pipeline_state
WHERE key = 'gha_dispatch_nightly'`;

/**
 * Every job in cron.job with its last firing, correlated to the data_sync_log
 * row THAT JOB'S OWN WRITER wrote.
 *
 * The key is the job's DERIVED pipeline (`Q_CRON_JOB_PIPELINES`), not its name
 * and not the clock. A name join was never possible — several jobs CALL a
 * procedure that logs under a different pipeline (`refresh-derived-mvs-daily`
 * writes `refresh_derived_mvs`) — but the TIME-FIRST join that stood in for it
 * had a worse failure: a job with NO writer of its own silently inherited
 * whichever neighbour wrote inside ±90 s. On 2026-09-15 `ec-vacuum-analyze`
 * and `officials-vacuum-analyze` both rendered `skipped` on `ec_crawl`'s
 * backoff reason, which is a vacuum reported as an interlock skip it had no
 * part in (FIX-1190).
 *
 * The ±90 s window survives as the DISAMBIGUATOR, not the key: six jobs share
 * three pipelines (the three EC jobs → `entity_connections_rebuild`;
 * daily/weekly `refresh-derived-mvs` → `refresh_derived_mvs`; daily/weekly
 * `rule-taggers` → `run_rule_taggers`; and `fe-crawl` +
 * `financial-entity-totals-incremental` → `financial_entity_totals_refresh`),
 * so the pipeline alone does not identify a firing. Closest `started_at` to the
 * firing's `start_time` wins.
 *
 * When `jp.pipeline IS NULL` the LATERAL returns nothing BY CONSTRUCTION, so
 * `sync_status` is NULL and `verdictFor()` falls through to the cron status
 * alone — which is the rule FIX-1190 asks for, and needs no change to the
 * verdict matrix.
 */
const Q_CRON_JOBS = `
WITH jp AS (
${Q_CRON_JOB_PIPELINES}
), last_run AS (
  SELECT DISTINCT ON (d.jobid)
         d.jobid, d.status, d.return_message, d.start_time, d.end_time
  FROM cron.job_run_details d
  WHERE d.start_time >= now() - make_interval(days => $1::int)
  ORDER BY d.jobid, d.start_time DESC
)
SELECT j.jobid, j.jobname, j.schedule, j.active,
       jp.pipeline,
       r.start_time, r.end_time,
       r.status                                                   AS cron_status,
       r.return_message,
       EXTRACT(epoch FROM (r.end_time - r.start_time))::numeric   AS duration_s,
       s.status                                                   AS sync_status,
       s.metadata->>'skip_reason'                                 AS skip_reason,
       -- FIX-1178 (d) — the daily rule-tagger's delete/insert split, when the
       -- run stamped one. Absent for every other job and for a cadence that
       -- timed nothing, which renders as an em dash rather than a zero.
       s.metadata->>'phase_seconds'                               AS phase_seconds
FROM cron.job j
JOIN jp ON jp.jobid = j.jobid
LEFT JOIN last_run r ON r.jobid = j.jobid
LEFT JOIN LATERAL (
  SELECT l.status, l.metadata
  FROM public.data_sync_log l
  WHERE r.start_time IS NOT NULL
    AND jp.pipeline IS NOT NULL
    AND l.pipeline = jp.pipeline
    AND l.metadata->>'source' LIKE 'pg_cron%'
    AND l.started_at BETWEEN r.start_time - interval '90 seconds'
                         AND COALESCE(r.end_time, r.start_time) + interval '90 seconds'
  ORDER BY abs(EXTRACT(epoch FROM (l.started_at - r.start_time))) ASC
  LIMIT 1
) s ON true
ORDER BY j.jobname`;

/**
 * Two rows, not one: the LATEST row of any status, and the latest COMPLETE one.
 *
 * They are usually the same row and the split looks redundant — until the most
 * recent firing was a FIX-950 interlock skip. Reading only "the latest row"
 * then renders every unit timing and the whole vm_before reading as blank, and
 * the search-unit band as `missing`, which reports a deliberate operator hold
 * as a lost measurement. That is FIX-1177's asymmetry showing up one layer
 * down, so it is handled the same way it is handled in the verdict matrix: the
 * skip is stated as what happened, and the last real measurement is still
 * carried, labelled with when it was taken.
 */
const Q_DAILY_RUN = `
(SELECT 'latest' AS which, started_at, status,
        metadata->>'skip_reason'                AS skip_reason,
        (metadata->>'units')::int               AS units,
        (metadata->>'units_ok')::int            AS units_ok,
        (metadata->>'elapsed_seconds')::numeric AS elapsed_seconds,
        metadata->'unit_seconds'                AS unit_seconds,
        metadata->'vm_before'                   AS vm_before
 FROM public.data_sync_log
 WHERE pipeline = 'refresh_derived_mvs'
   AND metadata->>'cadence' IS DISTINCT FROM 'weekly'
 ORDER BY started_at DESC
 LIMIT 1)
UNION ALL
(SELECT 'complete' AS which, started_at, status,
        metadata->>'skip_reason'                AS skip_reason,
        (metadata->>'units')::int               AS units,
        (metadata->>'units_ok')::int            AS units_ok,
        (metadata->>'elapsed_seconds')::numeric AS elapsed_seconds,
        metadata->'unit_seconds'                AS unit_seconds,
        metadata->'vm_before'                   AS vm_before
 FROM public.data_sync_log
 WHERE pipeline = 'refresh_derived_mvs'
   AND metadata->>'cadence' IS DISTINCT FROM 'weekly'
   AND status = 'complete'
 ORDER BY started_at DESC
 LIMIT 1)`;

/**
 * FIX-1189 O2 — §10. The Q_DAILY_RUN split: the latest row of any status says
 * what happened, the latest `complete` one carries the numbers. O1 (cc-193)
 * adds the writer's latest `congress_legislator_ids_bind` row, any status;
 * none exists until CIVITICS_LEGISLATOR_IDS_BIND is set.
 */
const Q_LEGISLATOR_IDS = `
(SELECT 'latest' AS which, started_at, status, error_message, metadata
 FROM public.data_sync_log
 WHERE pipeline = 'congress_legislator_ids_report'
 ORDER BY started_at DESC
 LIMIT 1)
UNION ALL
(SELECT 'complete' AS which, started_at, status, error_message, metadata
 FROM public.data_sync_log
 WHERE pipeline = 'congress_legislator_ids_report'
   AND status = 'complete'
 ORDER BY started_at DESC
 LIMIT 1)
UNION ALL
(SELECT 'bind' AS which, started_at, status, error_message, metadata
 FROM public.data_sync_log
 WHERE pipeline = 'congress_legislator_ids_bind'
 ORDER BY started_at DESC
 LIMIT 1)`;

const Q_WEEKLY_RUN = `
SELECT d.start_time AS started_at, d.status,
       EXTRACT(epoch FROM (d.end_time - d.start_time))::numeric AS elapsed_seconds
FROM cron.job_run_details d
JOIN cron.job j ON j.jobid = d.jobid
WHERE j.jobname = 'refresh-derived-mvs-weekly'
ORDER BY d.start_time DESC
LIMIT 1`;

/**
 * Live visibility-map state for the two relations FIX-1152/FIX-884/FIX-943 care
 * about. Catalog + stats views only, so it is a cheap read no matter how large
 * the heaps are.
 */
const Q_VM_NOW = `
SELECT c.relname                                                       AS relation,
       CASE WHEN c.relpages = 0 THEN NULL
            ELSE ROUND(100.0 * c.relallvisible / c.relpages, 1) END    AS pct_all_visible,
       s.n_dead_tup,
       c.relpages
FROM pg_class c
LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE c.oid IN ('public.entity_connections'::regclass,
                'public.financial_entities'::regclass,
                'public.financial_relationships'::regclass)
ORDER BY c.relname`;

/**
 * FIX-1169 — the pre-vacuum visibility-map probes.
 *
 * One row per label, upserted by `record_vm_probe()` five minutes before each
 * vacuum. Ordered by key so `pre-ec` / `pre-fe` / `pre-fr` render in a stable
 * order rather than in whatever order the last upsert left.
 */
const Q_VM_PROBES = `
SELECT key, value
FROM public.pipeline_state
WHERE key LIKE 'vm_probe:%'
ORDER BY key`;

const Q_VACUUMS = `
SELECT j.jobname, d.start_time, d.status,
       EXTRACT(epoch FROM (d.end_time - d.start_time))::numeric AS duration_s
FROM cron.job_run_details d
JOIN cron.job j ON j.jobid = d.jobid
WHERE j.jobname = ANY($1::text[])
  AND d.start_time >= now() - make_interval(days => $2::int)
ORDER BY d.start_time DESC
LIMIT 24`;
// FIX-1239 — was 20, which is 6 d 16 h of the three daily jobs: a weekly job
// that last fired 6.9 d ago fell off the bottom. 24 = 7 d x 3 daily + 1 weekly
// + 2 of slack.

const Q_FEC_STATE = `
SELECT key, value
FROM public.pipeline_state
WHERE key IN ('fec_drop_probe','fec_indiv_watermark','fec_bulk_run_state')`;

const Q_FEC_EMIT = `
SELECT DISTINCT ON (cycle_year, source)
       cycle_year, source, run_id, started_at, complete_at, keys
FROM public.fec_emit_runs
ORDER BY cycle_year DESC, source, started_at DESC`;

/**
 * The emit-key population, as a PLANNER ESTIMATE. An exact count(*) over
 * fec_emit_keys is a full scan of a table that holds one row per emitted
 * (relationship, cycle) pair, and this job must never be a load on the box it
 * measures — so the estimate is what is reported, labelled as one.
 */
const Q_FEC_EMIT_KEYS_EST = `
SELECT reltuples::bigint AS est FROM pg_class WHERE oid = 'public.fec_emit_keys'::regclass`;

const Q_PROD_SESSION = `SELECT public.prod_session_state() AS state`;

const Q_SKIPS_24H = `
SELECT pipeline, started_at,
       metadata->>'skip_reason' AS skip_reason,
       metadata->>'source'      AS source
FROM public.data_sync_log
WHERE status = 'skipped'
  AND started_at >= now() - interval '24 hours'
ORDER BY started_at DESC
LIMIT 100`;

const Q_CANARY = `
SELECT started_at, metadata->'conditions' AS conditions
FROM public.data_sync_log
WHERE pipeline = 'canary_check'
ORDER BY started_at DESC
LIMIT 1`;

/**
 * FIX-913 / FIX-859 / FIX-914's coverage read, verbatim from the recipe in
 * cc-prompt-113 P0-A. Do not "improve" it — the expected values in every
 * receipt so far are against this exact shape.
 */
const Q_SLD_COVERAGE = `
SELECT count(*) AS total,
       count(*) FILTER (WHERE o.metadata->>'district_jurisdiction_id' IS NOT NULL) AS linked
FROM officials o
JOIN governing_bodies gb ON gb.id = o.governing_body_id
JOIN jurisdictions p ON p.id = gb.jurisdiction_id AND p.type = 'state'
WHERE gb.type IN ('legislature_lower','legislature_upper')
  AND o.is_active AND NOT coalesce(o.is_synthetic,false)`;

const Q_SLD_RESIDUAL = `
SELECT p.name AS state, gb.type AS chamber, count(*) AS unlinked
FROM officials o
JOIN governing_bodies gb ON gb.id = o.governing_body_id
JOIN jurisdictions p ON p.id = gb.jurisdiction_id AND p.type = 'state'
WHERE gb.type IN ('legislature_lower','legislature_upper')
  AND o.is_active AND NOT coalesce(o.is_synthetic,false)
  AND o.metadata->>'district_jurisdiction_id' IS NULL
GROUP BY p.name, gb.type
ORDER BY count(*) DESC, p.name`;

// ── FIX-1194 §9, the forker ───────────────────────────────────────────────────
//
// The predicate is FIX-1073's: a run that FAILED with `startup timeout` in its
// return_message. pg_cron writes that message when it cannot fork a background
// worker, so the row records a firing that did no work at all — which for a
// watchdog means its budget went unenforced for that tick.
//
// These read `cron.job_run_details` directly, which this session can do: it
// connects as `postgres` over raw `pg`, not through PostgREST (service_role has
// no USAGE on schema `cron` — measured on prod 2026-09-21, and the reason
// FIX-1194's wrapper is SECURITY DEFINER).

const Q_FORKER_24H = `
SELECT to_char(date_trunc('hour', d.start_time), 'YYYY-MM-DD HH24:00') AS bucket,
       count(*)                  AS failures,
       count(DISTINCT d.jobid)   AS jobs_affected
FROM cron.job_run_details d
WHERE d.start_time >= now() - interval '24 hours'
  AND d.status = 'failed'
  AND d.return_message ILIKE '%startup timeout%'
GROUP BY 1
ORDER BY 1 DESC`;

const Q_FORKER_7D = `
SELECT to_char(date_trunc('day', d.start_time), 'YYYY-MM-DD') AS bucket,
       count(*)                  AS failures,
       count(DISTINCT d.jobid)   AS jobs_affected
FROM cron.job_run_details d
WHERE d.start_time >= now() - interval '7 days'
  AND d.status = 'failed'
  AND d.return_message ILIKE '%startup timeout%'
GROUP BY 1
ORDER BY 1 DESC`;

// The LEFT JOIN to cron.job is deliberate and not cosmetic: pg_cron DELETES the
// cron.job row on unschedule while job_run_details survives, so an inner join
// would silently drop exactly the historical runs this section is for. A run
// whose job is gone still names its jobid.
const Q_FORKER_RUNNING = `
WITH bursts AS (
  SELECT date_trunc('hour', d.start_time) AS bucket, count(*) AS failures
  FROM cron.job_run_details d
  WHERE d.start_time >= now() - interval '24 hours'
    AND d.status = 'failed'
    AND d.return_message ILIKE '%startup timeout%'
  GROUP BY 1
  HAVING count(*) >= $1::int
)
SELECT to_char(b.bucket, 'YYYY-MM-DD HH24:00') AS bucket,
       x.jobname,
       x.start_time,
       x.wall_s,
       x.status
FROM bursts b
LEFT JOIN LATERAL (
  SELECT COALESCE(j.jobname, '(unscheduled jobid ' || d.jobid || ')') AS jobname,
         d.start_time,
         EXTRACT(epoch FROM (COALESCE(d.end_time, now()) - d.start_time))::numeric AS wall_s,
         d.status
  FROM cron.job_run_details d
  LEFT JOIN cron.job j ON j.jobid = d.jobid
  WHERE d.start_time <= b.bucket + interval '1 hour'
    AND COALESCE(d.end_time, now()) >= b.bucket
    AND NOT (d.status = 'failed' AND d.return_message ILIKE '%startup timeout%')
  ORDER BY (COALESCE(d.end_time, now()) - d.start_time) DESC
  LIMIT 1
) x ON true
ORDER BY b.bucket DESC`;

const Q_FORKER_CANCELS = `
SELECT acted_at, jobname, age_seconds, budget_seconds, acted_via
FROM public.cron_job_budget_action
WHERE acted_at >= now() - interval '7 days'
ORDER BY acted_at DESC
LIMIT 50`;

/**
 * FIX-1208 — the Vercel watchdog path's LIVENESS stamp.
 *
 * `run_cron_watchdogs()` rewrites this one row on every call, cancel or no
 * cancel, and that wrapper's only caller is the Vercel route (pg_cron calls the
 * two inner watchdogs directly by name). So the row's presence and age answer
 * "did the second path run?" — which `cron_job_budget_action.acted_via` cannot,
 * because it is written only when a cancel actually happens and is therefore
 * silent on a healthy day.
 *
 * Returns no rows on a database where the FIX-1208 migration has not been
 * applied, or before the route's first call after it was; the renderer reports
 * that as `missing` rather than guessing.
 */
const Q_FORKER_VERCEL_LIVENESS = `
SELECT value->>'at' AS at
FROM public.pipeline_state
WHERE key = 'cron_watchdog_vercel'`;

/**
 * FIX-1194 P1-B / FIX-1125 — the two box-health stamps, in one read. Both are
 * single pipeline_state rows rewritten in place, so this is a two-row lookup by
 * primary key. A database without the migration returns no rows, and the
 * renderer reports each as `missing`.
 */
const Q_BOX_HEALTH = `
SELECT key, value
FROM public.pipeline_state
WHERE key IN ('box_health', 'box_health_mem')`;

/**
 * FIX-1124 — both crawls' LIFETIME skip counters. Nothing keeps their history,
 * so each file banks them and the next takes the delta. The peer reasons (and
 * blackout / cycle_cooldown) write no data_sync_log row by design (FIX-1111),
 * which is why the counters are the only instrument for them.
 */
const Q_CRAWL_SKIPS = `
SELECT key, value->'skips' AS skips, clock_timestamp() AS read_at
FROM public.pipeline_state
WHERE key IN ('ec_crawl', 'fe_crawl')`;

/**
 * FIX-1270 — the generic EC arms parked after two consecutive cancels. One key;
 * an absent row is nothing parked, the same as `{}`.
 */
const Q_EC_ARM_PARKED = `
SELECT value
FROM public.pipeline_state
WHERE key = 'ec_arm_parked'`;

/**
 * FIX-1124 — crawl units whose running span met a peer's, last 24 h. A peer that
 * waited in peer_wait_gate starts its span after the wait (its started_at is the
 * CALL's transaction start, before the wait). skipped / deferred rows did no
 * work; reaped rows have no end and would read as running until now.
 */
const Q_CRAWL_OVERLAPS = `
SELECT c.pipeline AS crawl, c.status AS crawl_status, c.started_at AS crawl_start, c.completed_at AS crawl_end,
       d.pipeline AS peer, d.metadata->>'cadence' AS peer_cadence,
       d.started_at + make_interval(secs => COALESCE((d.metadata->'gate'->>'waited_s')::int, 0)) AS peer_start,
       d.completed_at AS peer_end
FROM public.data_sync_log c
JOIN public.data_sync_log d
  ON d.pipeline IN ('refresh_derived_mvs', 'run_rule_taggers')
 AND d.status NOT IN ('skipped', 'deferred', 'reaped')
 AND d.started_at >= now() - interval '30 hours'
 AND c.started_at < COALESCE(d.completed_at, now())
 AND COALESCE(c.completed_at, now())
     > d.started_at + make_interval(secs => COALESCE((d.metadata->'gate'->>'waited_s')::int, 0))
WHERE c.pipeline IN ('entity_connections_rebuild', 'financial_entity_totals_refresh')
  AND c.status NOT IN ('skipped', 'deferred', 'reaped')
  AND c.started_at >= now() - interval '24 hours'
ORDER BY c.started_at`;

/**
 * FIX-1125 — the day's memory series, from the OFF-box ring. Not SQL: one
 * Upstash LRANGE (one command). Absent credentials are a stated reason, not a
 * failure.
 *
 * FIX-1194 (cc-183) — and the day's SUMMARY, banked as `forker.memory_day`:
 * the ring holds 24 h and nothing else keeps the series, so a memory threshold
 * can only be sized from these files. nightly.yml's receipts job passes
 * UPSTASH_REDIS_REST_URL / _TOKEN from the repository Actions secrets of the
 * same names; until both exist they arrive empty, this reads
 * `available: false`, `memory_day` is null, and the line points at
 * data:box-health:series.
 */
async function readMemDay(now: Date): Promise<{ day: MemDay; memory_day: MemoryDay | null }> {
  const creds = upstashCredsFromEnv(process.env);
  if (!creds) {
    return {
      day: {
        available: false,
        reason:
          "UPSTASH_REDIS_REST_URL / _TOKEN are not in this runner's environment (nightly.yml's receipts job reads them " +
          "from the repository Actions secrets of the same names; until both exist the series is not banked)",
      },
      memory_day: null,
    };
  }
  const ring = await readBoxHealthRing(creds, fetch);
  if (!ring.ok) return { day: { available: false, reason: "ring read failed: " + ring.error }, memory_day: null };
  const rows = seriesRows(ring.samples, { hours: 24, now });
  const st = seriesStats(rows, ring.samples);
  return { day: { available: true, ...st }, memory_day: memoryDay(rows, st) };
}

/** Reads that were asked for and have no SQL surface. Never silently dropped. */
const NOT_CAPTURABLE = [
  "**57014 (statement cancelled) counts.** They live in `postgres_logs`, which the Supabase " +
    "Management API's `logs` endpoint serves and SQL does not reach at all — so they are not capturable " +
    "from HERE, which is a Postgres session. They ARE capturable: " +
    "`pnpm --filter @civitics/data data:census:cancellations:prod` reads them (and the " +
    "front-door 5xx rate) through the Logs API and prints both against the cc-131 read 7 (f) " +
    "gates, exiting non-zero when either fails. A paced prod op's front-door cost — renders lost " +
    "per CALL and per breather against `--renders-per-call-max`, and the run total — is in its " +
    "runner receipt, `docs/audits/<day>-fix1212-bootstrap-runner*.md` (FIX-1232); this job runs " +
    "no census of its own.",
  "**GHA step logs and per-step timings.** `gh run view --log` only, and they age out. This file " +
    "carries the run's `createdAt`/`conclusion` from the API, not its logs.",
  "**Vercel edge / CDN volume.** Cloudflare analytics only — see `scripts/cf-analytics.mjs`.",
  "**`peak_rss_mb` for a phase that was KILLED.** The value is stamped by the phase's own " +
    "completion path, so a job the runner OOM-killed leaves no reading; the `nightly_killed` row " +
    "records the gap, not the heap.",
];

// ---------------------------------------------------------------------------
// GHA run metadata — the one non-SQL read
// ---------------------------------------------------------------------------

interface GhRun {
  createdAt: string;
  conclusion: string;
  databaseId: number;
  /** FIX-1218 — `schedule` | `workflow_dispatch`. */
  event?: string;
}

/**
 * The nightly's runs. GHA run metadata is NOT in the database, and
 * `gh` is only available where it is installed and authenticated — in the
 * workflow (with the job token) and on a developer machine. Everywhere else
 * this degrades to a stated "unchecked" rather than a guess, which is the same
 * pattern `cc:verify` uses for the same reason.
 *
 * FIX-1218 — ALL EVENTS. This read used to filter `--event schedule`, which
 * would have rendered every dispatched night as `missing` the day the Vercel
 * dispatcher landed: the run that does the work is now a `workflow_dispatch`,
 * and the `schedule` run is the fallback. 20, not 10, because a healthy day now
 * has two runs.
 */
function readGhRuns(): { runs: GhRun[]; note: string | null } {
  const res = spawnSync(
    "gh",
    [
      "run", "list",
      "--workflow", "nightly.yml",
      "--json", "createdAt,conclusion,databaseId,event",
      "-L", "20",
    ],
    { encoding: "utf8", shell: process.platform === "win32" },
  );
  if (res.error !== undefined || res.status !== 0) {
    const why = res.error !== undefined ? res.error.message : (res.stderr ?? "").trim().split("\n")[0];
    return {
      runs: [],
      note:
        "GHA run metadata UNCHECKED — `gh run list` unavailable here (" +
        (why === undefined || why === "" ? "non-zero exit" : why) +
        "). The slot/offset row is blank rather than guessed.",
    };
  }
  try {
    return { runs: JSON.parse(res.stdout) as GhRun[], note: null };
  } catch (err) {
    return { runs: [], note: "GHA run metadata UNCHECKED — could not parse `gh` output: " + String(err) };
  }
}

/** `gh run view <id> --json jobs` shape, narrowed to what §1 renders. */
interface GhJobRaw {
  name?: string;
  conclusion?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  /** FIX-1218 — read only to tell a stood-down fallback from a working run. */
  steps?: Array<{ name?: string; conclusion?: string | null }>;
}

/**
 * The run's per-JOB conclusions.
 *
 * Needed because the run-level conclusion is structurally blank in a scheduled
 * file: the `receipts` job is a job of the run it describes. The four phase
 * jobs HAVE concluded by then, so this is the honest reading. Degrades to an
 * empty list on any failure, exactly like {@link readGhRuns} — a missing `gh`
 * must never fail the receipts job, which runs with `if: always()`.
 */
function readGhJobs(runId: number): { jobs: JobConclusion[]; already_ran: boolean | null } {
  const res = spawnSync(
    "gh",
    ["run", "view", String(runId), "--json", "jobs"],
    { encoding: "utf8", shell: process.platform === "win32" },
  );
  if (res.error !== undefined || res.status !== 0) return { jobs: [], already_ran: null };
  try {
    const parsed = JSON.parse(res.stdout) as { jobs?: GhJobRaw[] };
    const raw = parsed.jobs ?? [];
    return {
      jobs: raw.map((j) => ({
        name: j.name ?? "(unnamed)",
        // An in-flight job reports "" — render it as unknown rather than as a
        // conclusion, the same distinction the run-level cell now makes.
        conclusion: j.conclusion === undefined || j.conclusion === null || j.conclusion === "" ? null : j.conclusion,
        started_at: j.startedAt ?? null,
        completed_at: j.completedAt ?? null,
      })),
      // FIX-1218 — the preflight's signature, from the steps.
      already_ran: isAlreadyRanRun(
        raw.map((j) => ({
          name: j.name ?? "",
          steps: (j.steps ?? []).map((s) => ({ name: s.name ?? "", conclusion: s.conclusion ?? null })),
        })),
      ),
    };
  } catch {
    return { jobs: [], already_ran: null };
  }
}

/** createdAt − the most recent SLOT_HOUR_UTC at or before it, in hours. */
function offsetFromSlot(createdAt: string): number {
  const created = new Date(createdAt);
  const slot = new Date(created);
  slot.setUTCHours(SLOT_HOUR_UTC, 0, 0, 0);
  if (slot > created) slot.setUTCDate(slot.getUTCDate() - 1);
  return (created.getTime() - slot.getTime()) / 3_600_000;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const slotOffsetHours = resolveSlotOffset(args);
  const now = new Date();
  const date = args.date ?? nominalDate(now, slotOffsetHours);

  const dsn = resolveDbUrl(args.target);
  const host = hostOf(dsn);
  // FIX-1209 — one definition of "is this the local Docker box", shared with
  // the output-path resolver so the label and the write destination cannot
  // disagree about which database this run reached.
  const isLocal = isLocalDsn(dsn);
  const targetLabel = isLocal ? "LOCAL (Docker)" : "PROD (Supabase Pro)";
  console.info("[receipts] target " + targetLabel + " — " + host);
  console.info("[receipts] nominal day " + date + " (slot offset " + slotOffsetHours + "h)");

  // The exact window that maps to this nominal day: a run at instant t names
  // day d iff date(t + offset) = d, i.e. t in [d - offset, d + 24h - offset).
  const windowStart = new Date(Date.parse(date + "T00:00:00Z") - slotOffsetHours * 3_600_000);
  const windowEnd = new Date(windowStart.getTime() + 24 * 3_600_000);

  const { Client: PgClient } = await import("pg");
  const client = new PgClient({ connectionString: dsn });
  await client.connect();

  let data: ReceiptsData;
  try {
    // Order matters: read-only FIRST, so nothing after this point can write
    // even if a future edit adds a statement that tries.
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '" + STATEMENT_TIMEOUT + "'");
    const r = new Reader(client);

    const phaseRows = await r.run<Record<string, unknown>>("nightly_phases", Q_NIGHTLY_PHASES, [
      windowStart.toISOString(),
      windowEnd.toISOString(),
    ]);
    const phases: PhaseRow[] = phaseRows.map((row) => ({
      phase: str(row["phase"]) ?? "(unnamed)",
      status: str(row["status"]) ?? "(none)",
      started_at: iso(row["started_at"]),
      duration_s: num(row["duration_s"]),
      peak_rss_mb: num(row["peak_rss_mb"]),
      skip_reason: str(row["skip_reason"]),
      is_weekly: row["is_weekly"] === null || row["is_weekly"] === undefined ? null : Boolean(row["is_weekly"]),
    }));

    const gh = readGhRuns();
    // Every run that NAMES this day, by the same rule the file name uses, oldest
    // first. FIX-1218: a healthy day has two — the dispatched run and the late
    // schedule fallback — so this is a list, and the single-run fields below
    // describe the one that did the work.
    const dayRuns = gh.runs
      .filter((run) => nominalDate(new Date(run.createdAt), slotOffsetHours) === date)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const jobsByRun = new Map(dayRuns.map((run) => [run.databaseId, readGhJobs(run.databaseId)]));
    // Which trigger fired a run, from the rows it wrote. A stood-down fallback
    // wrote none, so its event is the only witness.
    const byRunId = new Map<string, string>();
    for (const row of phaseRows) {
      const id = str(row["github_run_id"]);
      const by = str(row["dispatched_by"]);
      if (id !== null && by !== null) byRunId.set(id, by);
    }
    const runs: NightlyRunRow[] = dayRuns.map((run) => ({
      run_id: run.databaseId,
      event: run.event ?? null,
      dispatched_by: byRunId.get(String(run.databaseId)) ?? (run.event === "schedule" ? "schedule" : null),
      created_at: run.createdAt,
      offset_hours: offsetFromSlot(run.createdAt),
      conclusion: run.conclusion === "" ? null : run.conclusion,
      already_ran: jobsByRun.get(run.databaseId)?.already_ran ?? null,
    }));
    const ghRun = dayRuns.find((run) => jobsByRun.get(run.databaseId)?.already_ran !== true) ?? dayRuns[0] ?? null;
    const offsetHours: number | null = ghRun === null ? null : offsetFromSlot(ghRun.createdAt);

    // FIX-1238 — the window's congress_votes row: which rolls were skipped
    // because their bill has no bill_details row. Rendered only when non-empty.
    const votesRows = await r.run<Record<string, unknown>>("votes_skips", Q_VOTES_SKIPS, [
      windowStart.toISOString(),
      windowEnd.toISOString(),
    ]);
    const votesSkips: VotesSkips | null =
      votesRows[0] === undefined
        ? null
        : {
            rows_failed: num(votesRows[0]["rows_failed"]),
            skipped_rolls: (Array.isArray(votesRows[0]["skipped_rolls"])
              ? (votesRows[0]["skipped_rolls"] as Record<string, unknown>[])
              : []
            ).map((s) => ({
              roll: str(s["roll"]) ?? "?",
              bill_key: str(s["bill_key"]) ?? "?",
              proposal_id: str(s["proposal_id"]) ?? "?",
              reason: str(s["reason"]) ?? "?",
              holder_proposal_id: str(s["holder_proposal_id"]),
            })),
          };

    // FIX-1273 — the window's tag_rules row and the FIX-1259 kept counts.
    const keptRows = await r.run<Record<string, unknown>>("tag_rules_kept", Q_TAG_RULES_KEPT, [
      windowStart.toISOString(),
      windowEnd.toISOString(),
    ]);
    const k0 = keptRows[0];
    const tagRulesKept: TagRulesKept | null =
      k0 === undefined
        ? null
        : {
            status: str(k0["status"]),
            rows_inserted: num(k0["rows_inserted"]),
            kept_total: num(k0["kept_total"]),
            kept_proposals: num(k0["kept_proposals"]),
            kept_financial_entities: num(k0["kept_financial_entities"]),
            kept_officials: num(k0["kept_officials"]),
          };

    const dispatchRows = await r.run<Record<string, unknown>>("gha_dispatch_nightly", Q_GHA_DISPATCH_NIGHTLY);
    const dv = (dispatchRows[0]?.["value"] ?? null) as Record<string, unknown> | null;
    const dispatcher: DispatchStamp | null =
      dv === null
        ? null
        : {
            at: str(dv["at"]),
            status: str(dv["status"]),
            http_status: num(dv["http_status"]),
            run_id: num(dv["run_id"]),
            detail: str(dv["detail"]),
            last_dispatched_at: str(dv["last_dispatched_at"]),
          };

    const cronRows = await r.run<Record<string, unknown>>("cron_jobs", Q_CRON_JOBS, [CRON_LOOKBACK_DAYS]);
    const firings: JobFiring[] = cronRows.map((row) => ({
      jobname: str(row["jobname"]) ?? "(unnamed)",
      jobid: num(row["jobid"]),
      schedule: str(row["schedule"]),
      active: Boolean(row["active"]),
      pipeline: str(row["pipeline"]),
      last_start: iso(row["start_time"]),
      last_end: iso(row["end_time"]),
      duration_s: num(row["duration_s"]),
      cron_status: str(row["cron_status"]),
      return_message: str(row["return_message"]),
      sync_status: str(row["sync_status"]),
      skip_reason: str(row["skip_reason"]),
      phase_seconds: str(row["phase_seconds"]),
    }));

    // bands.json stays in the CANONICAL dir even when the receipt is
    // redirected — it is hand-edited and shared by both targets, and following
    // the receipt into local/ would make every job read `no-band` (FIX-1209).
    const bands = loadBands(resolveReceiptPaths(args, isLocal).bandsDir);
    // FIX-1251: the read instant + lookback let a monthly job that has not come
    // round yet read `scheduled`, not `missing`.
    const cronJobs = verdictsFor(firings, bands, { asOf: now, lookbackDays: CRON_LOOKBACK_DAYS });

    const dailyRows = await r.run<Record<string, unknown>>("daily_run", Q_DAILY_RUN);
    // `latest` says what happened; `complete` carries the numbers. See Q_DAILY_RUN.
    const daily0 = dailyRows.find((row) => row["which"] === "latest");
    const dailyOk = dailyRows.find((row) => row["which"] === "complete");
    const unitSecondsObj = (dailyOk?.["unit_seconds"] ?? {}) as Record<string, unknown>;
    const unitSeconds: UnitTiming[] = Object.entries(unitSecondsObj)
      .map(([unit, v]) => ({ unit, seconds: num(v) ?? 0 }))
      .sort((a, b) => b.seconds - a.seconds);
    const vmBefore: VmRow[] = ((dailyOk?.["vm_before"] ?? []) as Record<string, unknown>[]).map((v) => ({
      relation: str(v["relation"]) ?? "(unnamed)",
      pct_all_visible: num(v["pct_all_visible"]),
      n_dead_tup: num(v["n_dead_tup"]),
      relpages: num(v["relpages"]),
    }));

    const searchUnitSeconds = num(unitSecondsObj[SEARCH_UNIT]);
    const searchBand = bands[SEARCH_UNIT_BAND_KEY] ?? null;
    const searchVerdict = compareToBand(searchUnitSeconds, searchBand);

    const vmNowRows = await r.run<Record<string, unknown>>("vm_now", Q_VM_NOW);
    const vmNow: VmRow[] = vmNowRows.map((v) => ({
      relation: str(v["relation"]) ?? "(unnamed)",
      pct_all_visible: num(v["pct_all_visible"]),
      n_dead_tup: num(v["n_dead_tup"]),
      relpages: num(v["relpages"]),
    }));

    const weeklyRows = await r.run<Record<string, unknown>>("weekly_run", Q_WEEKLY_RUN);
    const weekly0 = weeklyRows[0];

    const vacRows = await r.run<Record<string, unknown>>("vacuums", Q_VACUUMS, [VACUUM_JOBS, CRON_LOOKBACK_DAYS]);
    const vacuums: VacuumRow[] = vacRows.map((v) => ({
      jobname: str(v["jobname"]) ?? "(unnamed)",
      start_time: iso(v["start_time"]) ?? "—",
      duration_s: num(v["duration_s"]),
      status: str(v["status"]) ?? "—",
    }));

    // FIX-1169 — the pre-vacuum probes. One pipeline_state row per label,
    // overwritten daily; the history lives in these files, not in the table.
    const probeRows = await r.run<Record<string, unknown>>("vm_probes", Q_VM_PROBES);
    const vmProbes: VmProbeRow[] = probeRows.flatMap((row) => {
      const label = String(row["key"] ?? "").replace(/^vm_probe:/, "");
      const value = (row["value"] ?? {}) as { at?: unknown; vm?: unknown };
      const at = iso(value.at);
      return (Array.isArray(value.vm) ? (value.vm as Record<string, unknown>[]) : []).map((v) => ({
        label,
        at,
        relation: str(v["relation"]) ?? "(unnamed)",
        pct_all_visible: num(v["pct_all_visible"]),
        n_dead_tup: num(v["n_dead_tup"]),
        relpages: num(v["relpages"]),
      }));
    });

    const stateRows = await r.run<Record<string, unknown>>("fec_state", Q_FEC_STATE);
    const stateByKey = new Map<string, Record<string, unknown>>();
    for (const row of stateRows) {
      stateByKey.set(String(row["key"]), (row["value"] ?? {}) as Record<string, unknown>);
    }
    const emitRows = await r.run<Record<string, unknown>>("fec_emit", Q_FEC_EMIT);
    const estRows = await r.run<Record<string, unknown>>("fec_emit_keys_est", Q_FEC_EMIT_KEYS_EST);

    const psRows = await r.run<Record<string, unknown>>("prod_session", Q_PROD_SESSION);
    const skipRows = await r.run<Record<string, unknown>>("skips_24h", Q_SKIPS_24H);
    const canaryRows = await r.run<Record<string, unknown>>("canary", Q_CANARY);
    const sldRows = await r.run<Record<string, unknown>>("sld_coverage", Q_SLD_COVERAGE);
    const residualRows = await r.run<Record<string, unknown>>("sld_residual", Q_SLD_RESIDUAL);

    // FIX-1194 §9 — the forker.
    const bucketRows = (rows: Record<string, unknown>[]): ForkerBucketRow[] =>
      rows.map((v) => ({
        bucket: str(v["bucket"]) ?? "—",
        failures: num(v["failures"]) ?? 0,
        jobs_affected: num(v["jobs_affected"]) ?? 0,
      }));

    const forker24h = bucketRows(
      await r.run<Record<string, unknown>>("forker_24h", Q_FORKER_24H),
    );
    const forker7d = bucketRows(await r.run<Record<string, unknown>>("forker_7d", Q_FORKER_7D));

    const forkerRunningRows = await r.run<Record<string, unknown>>(
      "forker_running",
      Q_FORKER_RUNNING,
      [BURST_THRESHOLD],
    );
    const forkerRunning: ForkerRunningRow[] = forkerRunningRows.map((v) => ({
      bucket: str(v["bucket"]) ?? "—",
      jobname: str(v["jobname"]),
      start_time: iso(v["start_time"]),
      wall_s: num(v["wall_s"]),
      status: str(v["status"]),
    }));

    const forkerCancelRows = await r.run<Record<string, unknown>>(
      "forker_cancels",
      Q_FORKER_CANCELS,
    );
    const forkerCancels: ForkerCancelRow[] = forkerCancelRows.map((v) => ({
      acted_at: iso(v["acted_at"]) ?? "—",
      jobname: str(v["jobname"]) ?? "(unnamed)",
      age_seconds: num(v["age_seconds"]),
      budget_seconds: num(v["budget_seconds"]),
      acted_via: str(v["acted_via"]) ?? "—",
    }));

    const forkerLivenessRows = await r.run<Record<string, unknown>>(
      "forker_vercel_liveness",
      Q_FORKER_VERCEL_LIVENESS,
    );
    const forkerLivenessAt = iso(forkerLivenessRows[0]?.["at"]) ?? null;

    // FIX-1194 P1-B / FIX-1125 — the probe, the memory mirror, and the ring's day.
    const boxRows = await r.run<{ key: string; value: Record<string, unknown> }>("box_health", Q_BOX_HEALTH);
    const boxBy = new Map(boxRows.map((row) => [row.key, row.value]));
    const mem = await readMemDay(now).catch(
      (err: unknown): { day: MemDay; memory_day: MemoryDay | null } => ({
        day: { available: false, reason: err instanceof Error ? err.message : String(err) },
        memory_day: null,
      }),
    );

    // FIX-1124 — the crawl counters, the previous day's as the baseline (from the
    // directory THIS run writes to, so a local run never diffs against prod's
    // file), and the overlaps.
    const crawlRows = await r.run<{ key: string; skips: CrawlSkipCounters | null; read_at: unknown }>(
      "crawl_skips",
      Q_CRAWL_SKIPS,
    );
    const crawlBy = new Map(crawlRows.map((row) => [row.key, row.skips ?? null]));
    const crawlSkips: CrawlSkips = {
      ec_crawl: crawlBy.get("ec_crawl") ?? null,
      fe_crawl: crawlBy.get("fe_crawl") ?? null,
      read_at: iso(crawlRows[0]?.read_at) ?? now.toISOString(),
    };
    const baselineFile = previousNominalDay(date) + ".json";
    const baselinePath = join(resolveReceiptPaths(args, isLocal).outDir, baselineFile);
    const crawlBaseline = crawlSkipsBaselineFrom(
      baselineFile,
      existsSync(baselinePath) ? readFileSync(baselinePath, "utf8") : null,
    );
    const overlapRows = await r.run<Record<string, unknown>>("crawl_overlaps", Q_CRAWL_OVERLAPS);
    const crawlOverlaps: CrawlOverlapRow[] = overlapRows.map((v) => ({
      crawl: str(v["crawl"]) ?? "(unnamed)",
      crawl_status: str(v["crawl_status"]),
      crawl_start: iso(v["crawl_start"]),
      crawl_end: iso(v["crawl_end"]),
      peer: str(v["peer"]) ?? "(unnamed)",
      peer_cadence: str(v["peer_cadence"]),
      peer_start: iso(v["peer_start"]),
      peer_end: iso(v["peer_end"]),
    }));
    // FIX-1270 — parked EC arms; no row is nothing parked.
    const parkedRows = await r.run<{ value: Record<string, Record<string, unknown>> | null }>(
      "ec_arm_parked",
      Q_EC_ARM_PARKED,
    );
    const ecArmParked = parkedRows[0]?.value ?? {};

    // FIX-1189 O2 — §10.
    const legRows = await r.run<Record<string, unknown>>("legislator_ids", Q_LEGISLATOR_IDS);
    const legRun = (which: string): LegislatorIdsRun | null => {
      const row = legRows.find((x) => x["which"] === which);
      if (row === undefined) return null;
      return {
        started_at: iso(row["started_at"]),
        status: str(row["status"]),
        error: str(row["error_message"]),
        metadata: (row["metadata"] ?? null) as Record<string, unknown> | null,
      };
    };

    const total = num(sldRows[0]?.["total"]);
    const linked = num(sldRows[0]?.["linked"]);

    data = {
      nominal_date: date,
      generated_at: now.toISOString(),
      target: targetLabel,
      target_host: host,
      nightly: {
        created_at: ghRun?.createdAt ?? null,
        run_id: ghRun?.databaseId ?? null,
        conclusion: ghRun?.conclusion ?? null,
        jobs: ghRun === null ? [] : (jobsByRun.get(ghRun.databaseId)?.jobs ?? []),
        slot_utc: SLOT_UTC,
        offset_hours: offsetHours,
        nominal_date: date,
        slot_offset_hours: slotOffsetHours,
        is_weekly: phases.find((p) => p.is_weekly !== null)?.is_weekly ?? null,
        phases,
        gha_note:
          gh.note ??
          (ghRun === null ? "No nightly run (any event) maps to nominal day " + date + " in the last 20 runs." : null),
        runs,
        dispatcher,
        votes_skips: votesSkips,
        tag_rules_kept: tagRulesKept,
      },
      cron_jobs: cronJobs,
      daily: {
        run_started_at: iso(daily0?.["started_at"]),
        run_status: str(daily0?.["status"]),
        run_skip_reason: str(daily0?.["skip_reason"]),
        measured_at: iso(dailyOk?.["started_at"]),
        units: num(dailyOk?.["units"]),
        units_ok: num(dailyOk?.["units_ok"]),
        elapsed_seconds: num(dailyOk?.["elapsed_seconds"]),
        search_unit_seconds: searchUnitSeconds,
        search_unit_band: searchBand,
        search_unit_verdict: searchVerdict.verdict,
        search_unit_detail: searchVerdict.detail,
        unit_seconds: unitSeconds,
        vm_before: vmBefore,
        vm_now: vmNow,
        weekly_started_at: iso(weekly0?.["started_at"]),
        weekly_status: str(weekly0?.["status"]),
        weekly_elapsed_seconds: num(weekly0?.["elapsed_seconds"]),
      },
      vacuums,
      vm_probes: vmProbes,
      fec: {
        drop_probe: flatten(stateByKey.get("fec_drop_probe")),
        indiv_watermark: flattenWatermark(stateByKey.get("fec_indiv_watermark")),
        bulk_run_state: stateByKey.has("fec_bulk_run_state")
          ? JSON.stringify(stateByKey.get("fec_bulk_run_state"), null, 2)
          : null,
        emit_runs: emitRows.map((row) => ({
          key: String(row["cycle_year"]) + " / " + String(row["source"]),
          value:
            "keys=" +
            String(row["keys"] ?? "—") +
            ", started " +
            (iso(row["started_at"]) ?? "—") +
            ", complete " +
            (iso(row["complete_at"]) ?? "IN FLIGHT"),
        })),
        emit_keys_note:
          "`fec_emit_keys` population (planner estimate, `pg_class.reltuples`): **" +
          (num(estRows[0]?.["est"]) ?? "unknown") +
          "**. An exact `count(*)` is a full scan of that table and is deliberately not taken — " +
          "the per-run key counts above come from `fec_emit_runs.keys`, stamped at completion.",
      },
      interlock: {
        prod_session: flatten((psRows[0]?.["state"] ?? {}) as Record<string, unknown>),
        skips_24h: skipRows.map((s): SkipRow => ({
          pipeline: str(s["pipeline"]) ?? "(unnamed)",
          started_at: iso(s["started_at"]) ?? "—",
          skip_reason: str(s["skip_reason"]),
          source: str(s["source"]),
        })),
      },
      canary: {
        run_started_at: iso(canaryRows[0]?.["started_at"]),
        // escalate first, then by key. The canary itself pages on TRANSITIONS,
        // not on state, so this table is often long and mostly unchanged —
        // ordering by tier is what makes it scannable rather than ignorable.
        conditions: ((canaryRows[0]?.["conditions"] ?? []) as Record<string, unknown>[])
          .map(
            (c): CanaryCondition => ({
              key: str(c["key"]) ?? "(unkeyed)",
              tier: str(c["tier"]) ?? "—",
              severity: num(c["severity"]),
              unchangedRuns: num(c["unchangedRuns"]),
              detail: str(c["detail"]) ?? "",
            }),
          )
          .sort((a, b) => {
            if (a.tier !== b.tier) return a.tier === "escalate" ? -1 : b.tier === "escalate" ? 1 : 0;
            return a.key.localeCompare(b.key);
          }),
      },
      sld: {
        total,
        linked,
        residual: total !== null && linked !== null ? total - linked : null,
        by_state: residualRows.map((row): SldRow => ({
          state: str(row["state"]) ?? "(unnamed)",
          chamber: str(row["chamber"]) ?? "—",
          unlinked: num(row["unlinked"]) ?? 0,
        })),
      },
      forker: {
        by_hour_24h: forker24h,
        by_day_7d: forker7d,
        running_in_bursts: forkerRunning,
        cancels_7d: forkerCancels,
        vercel_liveness_at: forkerLivenessAt,
        box_health: boxBy.get("box_health") ?? null,
        box_health_mem: boxBy.get("box_health_mem") ?? null,
        mem_day: mem.day,
        memory_day: mem.memory_day,
        crawl_skips: crawlSkips,
        crawl_skips_baseline: crawlBaseline,
        crawl_overlaps_24h: crawlOverlaps,
        ec_arm_parked: ecArmParked,
      },
      legislator_ids: { latest: legRun("latest"), complete: legRun("complete"), bind: legRun("bind") },
      not_capturable: NOT_CAPTURABLE,
      queries: r.queries,
    };
  } finally {
    await client.end().catch(() => {
      /* best effort */
    });
  }

  const md = renderMarkdown(data);
  const json = renderJson(data);

  if (args.dryRun) {
    console.info("\n===== " + date + ".md =====\n");
    console.info(md);
    console.info("\n===== " + date + ".json (first 40 lines) =====\n");
    console.info(json.split("\n").slice(0, 40).join("\n"));
    console.info("\n[receipts] --dry-run — nothing written.");
    return;
  }

  const { outDir, redirected } = resolveReceiptPaths(args, isLocal);
  if (redirected) {
    console.info(
      "[receipts] LOCAL target and no --out — writing under " +
        outDir +
        " so this run cannot overwrite the day's PROD receipt (FIX-1209). Pass --out to override.",
    );
  }
  mkdirSync(outDir, { recursive: true });
  const mdPath = join(outDir, date + ".md");
  const jsonPath = join(outDir, date + ".json");
  writeFileSync(mdPath, md, "utf8");
  writeFileSync(jsonPath, json, "utf8");
  console.info("[receipts] wrote " + mdPath);
  console.info("[receipts] wrote " + jsonPath);
}

/** `{a: 1, b: {c: 2}}` → rows, so a jsonb blob renders as a readable table. */
function flatten(obj: Record<string, unknown> | undefined): KeyValueRow[] {
  if (obj === undefined || obj === null) return [];
  return Object.entries(obj).map(([key, v]) => ({
    key,
    value: v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v),
  }));
}

/** fec_indiv_watermark is `{cycle: {etag, last_modified}}` — only the date matters here. */
function flattenWatermark(obj: Record<string, unknown> | undefined): KeyValueRow[] {
  if (obj === undefined || obj === null) return [];
  return Object.entries(obj).map(([cycle, v]) => {
    const rec = (v ?? {}) as Record<string, unknown>;
    return { key: cycle, value: String(rec["last_modified"] ?? JSON.stringify(v)) };
  });
}

/**
 * Bands are HAND-EDITED and this script never writes them. A missing or
 * unparseable file is not fatal: every job then reads `no-band`, which is the
 * honest answer when nobody has written down what normal is.
 */
function loadBands(outDir: string): Bands {
  const path = join(outDir, "bands.json");
  if (!existsSync(path)) {
    console.warn("[receipts] no bands.json at " + path + " — every job will read no-band");
    return {};
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const bands: Bands = {};
    for (const [jobname, v] of Object.entries(raw)) {
      if (jobname.startsWith("$")) continue; // $schema / $comment keys
      const b = v as Record<string, unknown>;
      const lo = Number(b["lo_s"]);
      const hi = Number(b["hi_s"]);
      const source = typeof b["source"] === "string" ? b["source"] : "";
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || source === "") {
        console.warn("[receipts] bands.json: " + jobname + " is missing lo_s/hi_s/source — ignored (no-band)");
        continue;
      }
      bands[jobname] = { lo_s: lo, hi_s: hi, source };
    }
    return bands;
  } catch (err) {
    console.warn("[receipts] bands.json unreadable (" + String(err) + ") — every job will read no-band");
    return {};
  }
}

main().catch((err: unknown) => {
  console.error("[receipts] FAILED: " + (err instanceof Error ? err.stack : String(err)));
  process.exit(1);
});
