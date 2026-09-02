/**
 * FIX-974 — Break-glass driver for the BULK donor-rollup regime.
 *
 * `refresh_official_donor_rollup_incremental()` walks a per-recipient dirty set
 * and is the right shape for a trickle. It is the wrong shape for a backlog:
 * FIX-973 measured it at 19.0 s/recipient on 2026-08-06 (~33 ms/FR row, about
 * one random page per row), i.e. ~48 h of compute for the 9,086 recipients then
 * outstanding. `donor_rollup_rebuild_bulk()` does the same work in to_id RANGE
 * chunks, one index-only FR scan per chunk feeding all six arms.
 *
 * This script:
 *   * `SET statement_timeout = 0` at SESSION level BEFORE the CALL — the only
 *     place that 6 h role ceiling can be lifted (FIX-944, measured).
 *   * widens the procedure's own between-chunk budget to match, via a SESSION
 *     GUC that cannot strand into the scheduled pg_cron job.
 *   * re-CALLs while the procedure reports `partial`, so one invocation
 *     converges a sweep.
 *   * VACUUM (ANALYZE)s everything the procedure rewrote afterwards — the six
 *     live arms AND the four persistent `_drb_*` staging tables. NOT optional: this
 *     is a bulk rewrite, and the FIX-943 standing rule exists because the
 *     dead-tuple load of one lands inside the autovacuum threshold window and
 *     the next reader pays for it (FIX-884: 0.9% all-visible → 34,534 heap
 *     fetches → 20.5 s of a 22.1 s query). VACUUM cannot run inside a
 *     procedure, so it lives here.
 *
 * Everything the procedure does is committed per chunk and cursor-tracked
 * (pipeline_state key 'donor_rollup_bulk_sweep'), so killing this at any point
 * loses at most one chunk.
 *
 *   pnpm --filter @civitics/data data:donor-rollup:bulk                  # local
 *   pnpm --filter @civitics/data data:donor-rollup:bulk -- --status      # read-only
 *   pnpm --filter @civitics/data data:donor-rollup:bulk -- --mode full
 *   pnpm --filter @civitics/data data:donor-rollup:bulk:prod             # prod (--confirm baked in)
 *
 * Prod runs rewrite six live tables plus four staging tables and take hours.
 * Run them off-peak, clear of
 * the 09:00-15:20 UTC donor-rollup window and the nightly (~05:15-08:00 UTC) —
 * see CLAUDE.md "Data-state changes vs schema changes".
 */

import { Client } from "pg";

import { constructDbUrlFromEnv } from "./fec-orphan-classify";
import { ARMED_PROBE_SQL, isTimeoutDisarmed, type ArmedProbeRow } from "../lib/statement-timeout-probe";

const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const PIPELINE = "donor_rollup_bulk";
const STATE_KEY = "donor_rollup_bulk_sweep";

/**
 * Every table donor_rollup_rebuild_bulk() rewrites. Vacuumed in this order:
 * the six live arms first, then the four persistent `_drb_*` staging tables.
 *
 * FIX-1005 — the staging tables were missing. FIX-1003 gave vacuum ownership to
 * the six arms the INCREMENTAL path rewrites and deliberately skipped these,
 * because nothing scheduled calls the bulk procedure; this script is its only
 * caller, so this list is the ONLY thing standing between them and the FIX-943
 * violation. They are not scratch: all four are relkind='r', they persist
 * between runs, and none carries an autovacuum override — measured on prod
 * 2026-09-02, `_drb_fe` is 35,118 pages / 3.65M rows, larger than four of the
 * six arms above it. The write set is catalog-derived from the procedure's own
 * `pg_proc.prosrc`, not from the bullet.
 */
const REWRITTEN_ARMS = [
  "public.official_donor_rollup_mv",
  "public.official_donor_totals",
  "public.official_small_dollar_rollup",
  "public.official_sector_affinity_rollup",
  "public.treemap_individuals_rollup",
  "public.official_donor_bracket_totals",
  "public._drb_targets",
  "public._drb_chunk_fe",
  "public._drb_donor",
  "public._drb_fe",
] as const;

const DEFAULT_BUDGET_SECONDS = 20 * 3600;
const DEFAULT_MAX_ITERATIONS = 8;

interface Args {
  dbUrl: string;
  allowProd: boolean;
  confirm: boolean;
  statusOnly: boolean;
  budgetSeconds: number;
  maxIterations: number;
  mode: "dirty" | "full";
  chunks: number | null;
  skipVacuum: boolean;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const o = err as { message?: unknown; code?: unknown; detail?: unknown };
    if (typeof o.message === "string") {
      return [o.message, o.code ? `(${String(o.code)})` : "", o.detail ? `detail=${String(o.detail)}` : ""]
        .filter(Boolean)
        .join(" ");
    }
  }
  return String(err);
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  let dbUrl = constructDbUrlFromEnv() || LOCAL_DB_URL;
  let allowProd = false;
  let confirm = false;
  let statusOnly = false;
  let budgetSeconds = DEFAULT_BUDGET_SECONDS;
  let maxIterations = DEFAULT_MAX_ITERATIONS;
  let mode: "dirty" | "full" = "dirty";
  let chunks: number | null = null;
  let skipVacuum = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--db-url" && args[i + 1]) dbUrl = args[++i]!;
    else if (a === "--allow-prod") allowProd = true;
    else if (a === "--confirm") confirm = true;
    else if (a === "--status") statusOnly = true;
    else if (a === "--budget-seconds" && args[i + 1]) budgetSeconds = Number(args[++i]);
    else if (a === "--max-iterations" && args[i + 1]) maxIterations = Number(args[++i]);
    else if (a === "--chunks" && args[i + 1]) chunks = Number(args[++i]);
    else if (a === "--skip-vacuum") skipVacuum = true;
    else if (a === "--mode" && args[i + 1]) {
      const m = args[++i]!;
      if (m !== "dirty" && m !== "full") {
        console.error(`[bulk] --mode must be 'dirty' or 'full' (got ${m})`);
        process.exit(1);
      }
      mode = m;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: donor-rollup-bulk [--status] [--allow-prod --confirm]\n" +
          "                        [--mode dirty|full] [--chunks 16|32|64|128|256]\n" +
          "                        [--db-url URL] [--budget-seconds N] [--max-iterations N]\n" +
          "                        [--skip-vacuum]\n\n" +
          "  --status          report sweep state and exit; writes nothing\n" +
          "  --mode            'dirty' (default) rebuilds recipients touched since the\n" +
          "                    watermark; 'full' rebuilds every recipient\n" +
          "  --chunks          to_id-range chunk count (must divide 256)\n" +
          "  --budget-seconds  per-CALL between-chunk budget (default 72000)\n" +
          "  --max-iterations  CALLs before giving up (default 8)\n" +
          "  --skip-vacuum     skip the post-rewrite VACUUM (ANALYZE). Only for a run\n" +
          "                    you KNOW is partial and will be resumed shortly — the\n" +
          "                    FIX-943 rule says a completed bulk rewrite vacuums.\n",
      );
      process.exit(0);
    }
  }
  return { dbUrl, allowProd, confirm, statusOnly, budgetSeconds, maxIterations, mode, chunks, skipVacuum };
}

interface SweepState {
  chunkCursor: number | null;
  chunks: number | null;
  mode: string | null;
  sweepStartedAt: string | null;
  lastStatus: string | null;
  lastStartedAt: string | null;
  lastError: string | null;
  lastMeta: Record<string, unknown> | null;
}

async function readState(client: Client): Promise<SweepState> {
  const state = await client.query<{
    value: { chunk_cursor?: number; chunks?: number; mode?: string; sweep_started_at?: string };
  }>("SELECT value FROM public.pipeline_state WHERE key = $1", [STATE_KEY]);
  const log = await client.query<{
    status: string;
    started_at: string;
    error_message: string | null;
    metadata: Record<string, unknown> | null;
  }>(
    "SELECT status, started_at, error_message, metadata FROM public.data_sync_log WHERE pipeline = $1 ORDER BY started_at DESC LIMIT 1",
    [PIPELINE],
  );
  const v = state.rows[0]?.value ?? {};
  return {
    chunkCursor: typeof v.chunk_cursor === "number" ? v.chunk_cursor : null,
    chunks: typeof v.chunks === "number" ? v.chunks : null,
    mode: v.mode ?? null,
    sweepStartedAt: v.sweep_started_at ?? null,
    lastStatus: log.rows[0]?.status ?? null,
    lastStartedAt: log.rows[0]?.started_at ?? null,
    lastError: log.rows[0]?.error_message ?? null,
    lastMeta: log.rows[0]?.metadata ?? null,
  };
}

async function reportState(client: Client, label: string): Promise<SweepState> {
  const s = await readState(client);
  console.log(
    `[bulk] ${label}: last_status=${s.lastStatus ?? "-"} (${s.lastStartedAt ?? "never"})` +
      (s.chunkCursor !== null && s.chunkCursor >= 0
        ? ` sweep_in_flight cursor=${s.chunkCursor}/${(s.chunks ?? 32) - 1} mode=${s.mode} since ${s.sweepStartedAt}`
        : " no sweep in flight"),
  );
  if (s.lastMeta) {
    const m = s.lastMeta as Record<string, unknown>;
    const bits = ["targets", "target_officials", "chunks_done_this_run", "slowest_chunk_seconds", "elapsed_seconds"]
      .filter((k) => m[k] !== undefined)
      .map((k) => `${k}=${String(m[k])}`);
    if (bits.length) console.log(`[bulk]   ${bits.join(" ")}`);
  }
  if (s.lastError) console.log(`[bulk]   last_error: ${s.lastError}`);
  return s;
}

/**
 * FIX-943 standing rule: any script that bulk-rewrites a table ends by
 * vacuuming what it rewrote. Autovacuum tuning narrows the window, it does not
 * close it — a bulk rewrite lands its whole dead-tuple load inside the
 * threshold at once, and a heap page loses its all-visible mark if ANY tuple on
 * it is dead, so a few-percent dead ratio can un-mark most of the heap and turn
 * every index-only scan into a per-row heap fetch.
 */
async function vacuumArms(client: Client): Promise<void> {
  console.log(`[bulk] VACUUM (ANALYZE) on ${REWRITTEN_ARMS.length} rewritten arms (FIX-943 rule)`);
  for (const table of REWRITTEN_ARMS) {
    const t0 = Date.now();
    // VACUUM cannot run inside a transaction block; node-pg sends these
    // unwrapped, and statement_timeout is already 0 for this session.
    await client.query(`VACUUM (ANALYZE) ${table}`);
    console.log(`[bulk]   ${table} — ${Math.round((Date.now() - t0) / 1000)}s`);
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv);
  const isProd = /supabase\.co|pooler\.supabase\.com/i.test(args.dbUrl);

  if (isProd && !args.allowProd) {
    console.error("[bulk] refusing: --db-url points at prod but --allow-prod was not passed");
    return 1;
  }
  if (isProd && !args.statusOnly && !args.confirm) {
    console.error(
      "[bulk] refusing: a prod WRITE run needs --confirm. This rewrites six live " +
        "rollup tables and can run for hours — start it off-peak. Use --status for a read-only check.",
    );
    return 1;
  }

  const client = new Client({ connectionString: args.dbUrl, application_name: "civitics_donor_rollup_bulk" });
  await client.connect();

  // Cancel in-flight work on SIGTERM/SIGINT rather than orphaning a backend that
  // keeps writing after the runner is gone (FIX-591). Safe: chunks are committed
  // and cursor-tracked.
  const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
  let cleaning = false;
  const onSignal = (sig: string): void => {
    if (cleaning) return;
    cleaning = true;
    console.error(`[bulk] ${sig} — cancelling in-flight chunk; committed chunks are kept`);
    void (async () => {
      try {
        const c2 = new Client({ connectionString: args.dbUrl, application_name: "civitics_donor_rollup_bulk_cleanup" });
        await c2.connect();
        if (pid) await c2.query("SELECT pg_cancel_backend($1)", [pid]);
        await c2.end();
      } catch (e) {
        console.error(`[bulk] cancel failed (cursor still safe): ${errMsg(e)}`);
      } finally {
        process.exit(1);
      }
    })();
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  try {
    const before = await reportState(client, "before");
    if (args.statusOnly) return 0;

    // All session-scoped: nothing to restore, nothing that can strand and widen
    // the scheduled pg_cron run (FIX-944 decision 6).
    await client.query("SET statement_timeout = 0");
    await client.query("SET lock_timeout = '60s'");
    await client.query(`SET civitics.donor_rollup_bulk_budget_seconds = '${Math.floor(args.budgetSeconds)}'`);
    await client.query(`SET civitics.donor_rollup_bulk_mode = '${args.mode}'`);
    if (args.chunks !== null) {
      await client.query(`SET civitics.donor_rollup_bulk_chunks = '${Math.floor(args.chunks)}'`);
    }
    // Local Docker's /dev/shm is 64MB — a parallel gather spills and dies there.
    if (!isProd) await client.query("SET max_parallel_workers_per_gather = 0");

    const armed = await client.query<ArmedProbeRow>(ARMED_PROBE_SQL);
    if (!isTimeoutDisarmed(armed.rows[0])) {
      console.error(
        `[bulk] refusing: statement_timeout is ${armed.rows[0]?.st}, expected 0 — the sweep would be cancelled mid-flight`,
      );
      return 1;
    }
    console.log(
      `[bulk] session armed: statement_timeout=0, mode=${args.mode}, ` +
        `chunks=${args.chunks ?? "default"}, budget=${args.budgetSeconds}s`,
    );

    let iteration = 0;
    let lastCursor: number | null = before.chunkCursor;
    let completed = false;
    for (; iteration < args.maxIterations; iteration++) {
      const t0 = Date.now();
      console.log(`[bulk] CALL donor_rollup_rebuild_bulk() — iteration ${iteration + 1}`);
      await client.query("CALL public.donor_rollup_rebuild_bulk()");
      const mins = Math.round((Date.now() - t0) / 60000);

      const s = await reportState(client, `after iteration ${iteration + 1} (${mins}m)`);

      if (s.lastStatus === "complete") {
        console.log("[bulk] sweep COMPLETE — watermark advanced, incremental cursor cleared");
        completed = true;
        break;
      }
      if (s.lastStatus === "failed") {
        console.error("[bulk] sweep reported FAILED — cursor kept at the last committed chunk; fix the error and rerun");
        if (!args.skipVacuum) await vacuumArms(client);
        return 1;
      }
      if (s.lastStatus === "skipped") {
        console.error("[bulk] another donor-rollup refresh holds the advisory lock — nothing to do");
        return 1;
      }
      // 'partial' — resumable. Guard against a no-progress spin.
      if (s.chunkCursor !== null && s.chunkCursor === lastCursor) {
        console.error(
          `[bulk] cursor did not advance past chunk ${s.chunkCursor} — stopping rather than spinning. ` +
            "A single chunk is likely exceeding the whole budget; investigate that to_id range.",
        );
        if (!args.skipVacuum) await vacuumArms(client);
        return 1;
      }
      lastCursor = s.chunkCursor;
    }

    if (!completed && iteration >= args.maxIterations) {
      console.error(`[bulk] hit max iterations (${args.maxIterations}) still partial — rerun to continue from the cursor`);
      if (!args.skipVacuum) await vacuumArms(client);
      return 2;
    }

    if (args.skipVacuum) {
      console.warn("[bulk] --skip-vacuum: the six arms were bulk-rewritten and NOT vacuumed (FIX-943 rule waived)");
    } else {
      await vacuumArms(client);
    }
    return 0;
  } finally {
    await client.end().catch(() => {});
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[bulk] failed: ${errMsg(err)}`);
    process.exit(1);
  });
