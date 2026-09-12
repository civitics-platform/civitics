/**
 * FIX-1176 — `pnpm receipts:daily`: the standing reads, as a file.
 *
 * WHY THIS EXISTS. Most of the "reads to bank" in every Cowork prompt are the
 * same dozen queries every day — when the nightly started against its slot, the
 * phase durations and peak_rss_mb, the hour-04 vacuum durations, the 06:00
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
 * WHAT IT CANNOT SEE. Section 9 of the output names the reads with no SQL
 * surface (57014 counts live in `postgres_logs`, which the Logs API serves and
 * SQL does not; GHA job logs age out). They are listed so their absence is
 * never mistaken for a clean check.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Client } from "pg";
import { buildDbUrl } from "../lib/heavy-rebuild";
import {
  type Bands,
  type CanaryCondition,
  type JobFiring,
  type KeyValueRow,
  type PhaseRow,
  type QueryRecord,
  type ReceiptsData,
  type SkipRow,
  type SldRow,
  type UnitTiming,
  type VacuumRow,
  type VmRow,
  compareToBand,
  nominalDate,
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

/** The two hour-04 vacuum jobs, by NAME (jobids are not portable — FIX-946). */
const VACUUM_JOBS = ["ec-vacuum-analyze", "fe-vacuum-analyze"];

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
  slotOffsetHours: number | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { date: null, target: "auto", dryRun: false, outDir: "docs/receipts", slotOffsetHours: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--date") {
      i += 1;
      a.date = argv[i] ?? null;
    } else if (arg === "--out") {
      i += 1;
      a.outDir = argv[i] ?? a.outDir;
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
      console.log(
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
 * The repo root, walking up from this file until the workspace marker.
 *
 * A RELATIVE --out MUST NOT resolve against process.cwd(). `pnpm --filter
 * @civitics/data …` runs with the cwd at `packages/data`, so `docs/receipts`
 * would silently become `packages/data/docs/receipts` — the same class of bug
 * the enrichment-drain runbook warns about for `--output` (CLAUDE.md: "pnpm
 * resolves --output paths from package cwd; running from repo root claims 12
 * batches then fails to write the files"). Here it would put the receipts file
 * and bands.json in a directory nothing reads, and the run would look clean.
 * An ABSOLUTE --out is taken verbatim.
 */
function repoRoot(): string {
  let dir = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  // Falling back to cwd is wrong in the pnpm --filter case, so say so loudly
  // rather than writing somewhere surprising.
  console.warn("[receipts] could not locate the repo root (no pnpm-workspace.yaml above this file) — resolving --out against the cwd");
  return process.cwd();
}

function resolveOutDir(outDir: string): string {
  return isAbsolute(outDir) ? outDir : join(repoRoot(), outDir);
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
       (metadata->>'is_weekly')::boolean         AS is_weekly
FROM public.data_sync_log
WHERE pipeline IN ('nightly_cron','nightly_killed')
  AND started_at >= $1::timestamptz
  AND started_at <  $2::timestamptz
ORDER BY started_at`;

/**
 * Every job in cron.job with its last firing, correlated to whatever
 * data_sync_log row that firing wrote.
 *
 * The correlation is TIME-FIRST with a name tiebreak, not name-first: several
 * pg_cron jobs CALL a procedure that logs under a different pipeline name
 * (`refresh-derived-mvs-daily` writes `refresh_derived_mvs`), so a pure name
 * join would silently lose the `skipped` status on exactly the jobs the FIX-950
 * interlock guards — which is the one status this file must not miss.
 */
const Q_CRON_JOBS = `
WITH last_run AS (
  SELECT DISTINCT ON (d.jobid)
         d.jobid, d.status, d.return_message, d.start_time, d.end_time
  FROM cron.job_run_details d
  WHERE d.start_time >= now() - make_interval(days => $1::int)
  ORDER BY d.jobid, d.start_time DESC
)
SELECT j.jobid, j.jobname, j.schedule, j.active,
       r.start_time, r.end_time,
       r.status                                                   AS cron_status,
       r.return_message,
       EXTRACT(epoch FROM (r.end_time - r.start_time))::numeric   AS duration_s,
       s.status                                                   AS sync_status,
       s.metadata->>'skip_reason'                                 AS skip_reason
FROM cron.job j
LEFT JOIN last_run r ON r.jobid = j.jobid
LEFT JOIN LATERAL (
  SELECT l.status, l.metadata
  FROM public.data_sync_log l
  WHERE r.start_time IS NOT NULL
    AND l.metadata->>'source' LIKE 'pg_cron%'
    AND l.started_at BETWEEN r.start_time - interval '90 seconds'
                         AND COALESCE(r.end_time, r.start_time) + interval '90 seconds'
  ORDER BY (l.pipeline = replace(j.jobname, '-', '_')) DESC,
           abs(EXTRACT(epoch FROM (l.started_at - r.start_time))) ASC
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

const Q_VACUUMS = `
SELECT j.jobname, d.start_time, d.status,
       EXTRACT(epoch FROM (d.end_time - d.start_time))::numeric AS duration_s
FROM cron.job_run_details d
JOIN cron.job j ON j.jobid = d.jobid
WHERE j.jobname = ANY($1::text[])
  AND d.start_time >= now() - make_interval(days => $2::int)
ORDER BY d.start_time DESC
LIMIT 20`;

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

/** Reads that were asked for and have no SQL surface. Never silently dropped. */
const NOT_CAPTURABLE = [
  "**57014 (statement cancelled) counts.** They live in `postgres_logs`, which the Supabase " +
    "Analytics (Logflare) API serves and SQL does not reach at all. There is no repo script for " +
    "it today: query `GET https://api.supabase.com/v1/projects/{ref}/analytics/endpoints/" +
    "logs.all?sql=…&iso_timestamp_start=…&iso_timestamp_end=…` with a " +
    "`SUPABASE_MANAGEMENT_API_KEY` bearer token when a cancellation census is needed (the " +
    "FIX-1165 method).",
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
}

/**
 * The nightly's scheduled start. GHA run metadata is NOT in the database, and
 * `gh` is only available where it is installed and authenticated — in the
 * workflow (with the job token) and on a developer machine. Everywhere else
 * this degrades to a stated "unchecked" rather than a guess, which is the same
 * pattern `cc:verify` uses for the same reason.
 */
function readGhRuns(): { runs: GhRun[]; note: string | null } {
  const res = spawnSync(
    "gh",
    [
      "run", "list",
      "--workflow", "nightly.yml",
      "--event", "schedule",
      "--json", "createdAt,conclusion,databaseId",
      "-L", "10",
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
  const isLocal = host.startsWith("127.0.0.1") || host.startsWith("localhost");
  const targetLabel = isLocal ? "LOCAL (Docker)" : "PROD (Supabase Pro)";
  console.log("[receipts] target " + targetLabel + " — " + host);
  console.log("[receipts] nominal day " + date + " (slot offset " + slotOffsetHours + "h)");

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
    // The run that NAMES this day, by the same rule the file name uses.
    const ghRun = gh.runs.find((run) => nominalDate(new Date(run.createdAt), slotOffsetHours) === date) ?? null;
    let offsetHours: number | null = null;
    if (ghRun !== null) {
      const created = new Date(ghRun.createdAt);
      const slot = new Date(created);
      slot.setUTCHours(SLOT_HOUR_UTC, 0, 0, 0);
      // The slot is the most recent SLOT_HOUR_UTC at or before createdAt.
      if (slot > created) slot.setUTCDate(slot.getUTCDate() - 1);
      offsetHours = (created.getTime() - slot.getTime()) / 3_600_000;
    }

    const cronRows = await r.run<Record<string, unknown>>("cron_jobs", Q_CRON_JOBS, [CRON_LOOKBACK_DAYS]);
    const firings: JobFiring[] = cronRows.map((row) => ({
      jobname: str(row["jobname"]) ?? "(unnamed)",
      jobid: num(row["jobid"]),
      schedule: str(row["schedule"]),
      active: Boolean(row["active"]),
      last_start: iso(row["start_time"]),
      last_end: iso(row["end_time"]),
      duration_s: num(row["duration_s"]),
      cron_status: str(row["cron_status"]),
      return_message: str(row["return_message"]),
      sync_status: str(row["sync_status"]),
      skip_reason: str(row["skip_reason"]),
    }));

    const bands = loadBands(resolveOutDir(args.outDir));
    const cronJobs = verdictsFor(firings, bands);

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
        slot_utc: SLOT_UTC,
        offset_hours: offsetHours,
        nominal_date: date,
        slot_offset_hours: slotOffsetHours,
        is_weekly: phases.find((p) => p.is_weekly !== null)?.is_weekly ?? null,
        phases,
        gha_note:
          gh.note ??
          (ghRun === null ? "No scheduled nightly run maps to nominal day " + date + " in the last 10 scheduled runs." : null),
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
    console.log("\n===== " + date + ".md =====\n");
    console.log(md);
    console.log("\n===== " + date + ".json (first 40 lines) =====\n");
    console.log(json.split("\n").slice(0, 40).join("\n"));
    console.log("\n[receipts] --dry-run — nothing written.");
    return;
  }

  const outDir = resolveOutDir(args.outDir);
  mkdirSync(outDir, { recursive: true });
  const mdPath = join(outDir, date + ".md");
  const jsonPath = join(outDir, date + ".json");
  writeFileSync(mdPath, md, "utf8");
  writeFileSync(jsonPath, json, "utf8");
  console.log("[receipts] wrote " + mdPath);
  console.log("[receipts] wrote " + jsonPath);
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
