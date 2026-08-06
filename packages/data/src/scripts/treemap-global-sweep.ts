/**
 * FIX-965 — Break-glass single-pass sweep of the GLOBAL treemap rollup scope.
 *
 * The scheduled `treemap-individuals-global-refresh` pg_cron job (Tue 08:15
 * UTC, `CALL refresh_treemap_individuals_global()`) runs as the `postgres`
 * role, which carries `statement_timeout=6h` armed once at CALL start — the
 * procedure's per-chunk COMMITs do NOT re-arm it. FIX-965 made the procedure
 * resumable (64 cursor-tracked chunks, predictive wall-clock budget, exits
 * `partial` cleanly), so the scheduled job converges across runs on its own.
 *
 * This script is for when you want the refresh done in ONE sitting:
 *
 *   * `SET statement_timeout = 0` at SESSION level, BEFORE the CALL — the only
 *     place that ceiling can be lifted (FIX-944, measured).
 *   * `SET civitics.treemap_global_budget_seconds` widens the procedure's own
 *     between-chunk budget to match. Session GUC, not shared state: a crashed
 *     run cannot leave the scheduled job's budget widened.
 *
 * Everything the procedure does is committed per chunk and cursor-tracked
 * (pipeline_state key 'treemap_global_refresh'), so killing this script at any
 * point loses at most one chunk — the next CALL (scheduled or manual) resumes.
 *
 *   pnpm --filter @civitics/data data:treemap:sweep                # local Docker
 *   pnpm --filter @civitics/data data:treemap:sweep -- --status    # read-only
 *   pnpm --filter @civitics/data data:treemap:sweep:prod           # prod (has --confirm baked in)
 *
 * Prod runs rewrite the global treemap scope and are long post-indiv22. Run
 * them off-peak, clear of the 09:00-15:00 UTC donor-rollup window and the
 * nightly (~05:15-10:30 UTC) — see CLAUDE.md "Data-state changes vs schema
 * changes".
 */

import { Client } from "pg";

import { constructDbUrlFromEnv } from "./fec-orphan-classify";
import { ARMED_PROBE_SQL, isTimeoutDisarmed, type ArmedProbeRow } from "../lib/statement-timeout-probe";

const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const PIPELINE = "treemap_individuals_global_refresh";
const STATE_KEY = "treemap_global_refresh";

// One CALL's between-chunk budget when sweeping manually. Generous because this
// session has no statement_timeout; the procedure still stops cleanly between
// chunks rather than being cancelled mid-chunk.
const DEFAULT_BUDGET_SECONDS = 20 * 3600;

// Hard stop on the resume loop so a pathological "always partial, no progress"
// state can never spin forever. Each iteration is a full budget window.
const DEFAULT_MAX_ITERATIONS = 8;

interface Args {
  dbUrl: string;
  allowProd: boolean;
  confirm: boolean;
  statusOnly: boolean;
  budgetSeconds: number;
  maxIterations: number;
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

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--db-url" && args[i + 1]) dbUrl = args[++i]!;
    else if (a === "--allow-prod") allowProd = true;
    else if (a === "--confirm") confirm = true;
    else if (a === "--status") statusOnly = true;
    else if (a === "--budget-seconds" && args[i + 1]) budgetSeconds = Number(args[++i]);
    else if (a === "--max-iterations" && args[i + 1]) maxIterations = Number(args[++i]);
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: treemap-global-sweep [--status] [--allow-prod --confirm]\n" +
          "                           [--db-url URL] [--budget-seconds N] [--max-iterations N]\n\n" +
          "  --status          report sweep state and exit; writes nothing\n" +
          "  --allow-prod      permit a supabase.co --db-url\n" +
          "  --confirm         required for a prod WRITE run\n" +
          "  --budget-seconds  per-CALL between-chunk budget (default 72000)\n" +
          "  --max-iterations  CALLs before giving up (default 8; 1 = one budget\n" +
          "                    window then exit 2 if still partial — for runs that\n" +
          "                    must stop before a fixed wall-clock deadline)\n",
      );
      process.exit(0);
    }
  }
  return { dbUrl, allowProd, confirm, statusOnly, budgetSeconds, maxIterations };
}

interface SweepState {
  chunkCursor: number | null;
  sweepStartedAt: string | null;
  lastStatus: string | null;
  lastStartedAt: string | null;
  lastError: string | null;
}

async function readState(client: Client): Promise<SweepState> {
  const state = await client.query<{ value: { chunk_cursor?: number; sweep_started_at?: string } }>(
    "SELECT value FROM public.pipeline_state WHERE key = $1",
    [STATE_KEY],
  );
  const log = await client.query<{ status: string; started_at: string; error_message: string | null }>(
    "SELECT status, started_at, error_message FROM public.data_sync_log WHERE pipeline = $1 ORDER BY started_at DESC LIMIT 1",
    [PIPELINE],
  );
  const v = state.rows[0]?.value ?? {};
  return {
    chunkCursor: typeof v.chunk_cursor === "number" ? v.chunk_cursor : null,
    sweepStartedAt: v.sweep_started_at ?? null,
    lastStatus: log.rows[0]?.status ?? null,
    lastStartedAt: log.rows[0]?.started_at ?? null,
    lastError: log.rows[0]?.error_message ?? null,
  };
}

async function reportState(client: Client, label: string): Promise<SweepState> {
  const s = await readState(client);
  console.log(
    `[sweep] ${label}: last_status=${s.lastStatus ?? "-"} (${s.lastStartedAt ?? "never"})` +
      (s.chunkCursor !== null ? ` sweep_in_flight cursor=${s.chunkCursor}/63 since ${s.sweepStartedAt}` : " no sweep in flight"),
  );
  if (s.lastError) console.log(`[sweep]   last_error: ${s.lastError}`);
  return s;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv);
  const isProd = /supabase\.co|pooler\.supabase\.com/i.test(args.dbUrl);

  if (isProd && !args.allowProd) {
    console.error("[sweep] refusing: --db-url points at prod but --allow-prod was not passed");
    return 1;
  }
  if (isProd && !args.statusOnly && !args.confirm) {
    console.error(
      "[sweep] refusing: a prod WRITE run needs --confirm. " +
        "This rewrites the global treemap scope and can run for hours — " +
        "start it off-peak. Use --status for a read-only check.",
    );
    return 1;
  }

  const client = new Client({ connectionString: args.dbUrl, application_name: "civitics_treemap_global_sweep" });
  await client.connect();

  // Cancel in-flight work on SIGTERM/SIGINT rather than orphaning a backend
  // that keeps writing after the runner is gone (the FIX-591 lesson; the 08-05
  // treemap cancellation-wedge is exactly why nothing here relies on it as a
  // control path). Safe to interrupt: chunks are committed and cursor-tracked.
  const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
  let cleaning = false;
  const onSignal = (sig: string): void => {
    if (cleaning) return;
    cleaning = true;
    console.error(`[sweep] ${sig} — cancelling in-flight chunk; committed chunks are kept`);
    void (async () => {
      try {
        const c2 = new Client({ connectionString: args.dbUrl, application_name: "civitics_treemap_global_sweep_cleanup" });
        await c2.connect();
        if (pid) await c2.query("SELECT pg_cancel_backend($1)", [pid]);
        await c2.end();
      } catch (e) {
        console.error(`[sweep] cancel failed (cursor still safe): ${errMsg(e)}`);
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

    // THE point of this script. All session-scoped: nothing to restore,
    // nothing that can strand and widen the scheduled pg_cron run.
    await client.query("SET statement_timeout = 0");
    await client.query("SET lock_timeout = '60s'");
    await client.query(`SET civitics.treemap_global_budget_seconds = '${Math.floor(args.budgetSeconds)}'`);
    if (!isProd) await client.query("SET max_parallel_workers_per_gather = 0"); // local Docker /dev/shm is 64MB

    // FIX-968 — shared probe (was an inline `current_setting(...)` here, and a
    // broken `SHOW ... ` + `.st` in the donor-rollup sweep). One implementation
    // so a third sweep cannot reintroduce it. See lib/statement-timeout-probe.ts.
    const armed = await client.query<ArmedProbeRow>(ARMED_PROBE_SQL);
    if (!isTimeoutDisarmed(armed.rows[0])) {
      console.error(`[sweep] refusing: statement_timeout is ${armed.rows[0]?.st}, expected 0 — the sweep would be cancelled mid-flight`);
      return 1;
    }
    console.log(`[sweep] session armed: statement_timeout=0, budget=${args.budgetSeconds}s`);

    let iteration = 0;
    let lastCursor: number | null = before.chunkCursor;
    for (; iteration < args.maxIterations; iteration++) {
      const t0 = Date.now();
      console.log(`[sweep] CALL refresh_treemap_individuals_global() — iteration ${iteration + 1}`);
      await client.query("CALL public.refresh_treemap_individuals_global()");
      const mins = Math.round((Date.now() - t0) / 60000);

      const s = await reportState(client, `after iteration ${iteration + 1} (${mins}m)`);

      if (s.lastStatus === "complete") {
        console.log("[sweep] refresh COMPLETE — global scope published, sweep state cleared");
        break;
      }
      if (s.lastStatus === "failed") {
        console.error("[sweep] refresh reported FAILED — cursor kept at the last committed chunk; fix the error and rerun");
        return 1;
      }
      if (s.lastStatus === "skipped") {
        console.error("[sweep] another refresh holds the advisory lock — nothing to do");
        return 1;
      }
      // 'partial' — resumable. Guard against a no-progress spin.
      if (s.chunkCursor !== null && s.chunkCursor === lastCursor) {
        console.error(
          `[sweep] cursor did not advance past chunk ${s.chunkCursor} — stopping rather than spinning. ` +
            "A single chunk is likely exceeding the whole budget; investigate that from_id range.",
        );
        return 1;
      }
      lastCursor = s.chunkCursor;
    }

    if (iteration >= args.maxIterations) {
      console.error(`[sweep] hit max iterations (${args.maxIterations}) still partial — rerun to continue from the cursor`);
      return 2;
    }
    return 0;
  } finally {
    await client.end().catch(() => {});
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[sweep] failed: ${errMsg(err)}`);
    process.exit(1);
  });
