/**
 * FIX-944 — Break-glass single-pass sweep of the six per-official money rollups.
 *
 * WHY THIS EXISTS
 * The scheduled `donor-rollup-refresh` pg_cron job (jobid 24 on prod,
 * `0 9,12 * * *` since FIX-968 — 09:00 primary, 12:00 same-day backstop for a
 * firing lost to a `job startup timeout`,
 * `CALL refresh_official_donor_rollup_incremental()`) runs as the `postgres`
 * role, which carries `statement_timeout=6h` via pg_db_role_setting. That
 * timeout is armed once at CALL start and is NOT re-armed by the procedure's
 * per-chunk COMMITs, so a sweep needing more than 6h of compute is cancelled
 * mid-flight no matter how it is chunked.
 *
 * FIX-944 made those runs resumable, so the scheduled job converges on its own.
 *
 * DO NOT reach for this script on the strength of the throughput numbers this
 * comment used to carry ("a 6h window completes ~1,000 recipients … roughly 50h
 * of work, ~9 nightly runs"). Those were a measurement artifact and are wrong by
 * ~2.5x — see FIX-951. They came from counting DISTINCT official_id in
 * official_small_dollar_rollup / official_donor_totals inside the run window,
 * and those tables hold 4,336 rows TOTAL (only recipients with donation rows get
 * one), so the proxy caps out far below any real recipient count. Measured
 * against a run whose true count is known — 2026-07-31 09:00, runid 135,
 * status `complete`, 8,381 recipients in 42 chunks in 3h08m — the same proxy
 * reports 3,339.
 *
 * What the scheduled job actually costs, measured on prod:
 *   07-22  1,992 recipients / 10 chunks / 1h54m = 685 s per 200-chunk
 *   07-31  8,381 recipients / 42 chunks / 3h08m = 269 s per 200-chunk
 * i.e. the whole dirty set clears inside ONE 6h window with ~2h52m to spare.
 * The 07-27..07-30 slowdown was FIX-943 — dead-tuple/visibility-map decay on
 * financial_relationships after the 07-26/27 bulk rewrite (930k rows), which
 * autovacuum never clears because its trigger is proportional (1.66M dead
 * required at 8.2M live). The one-off `VACUUM (ANALYZE)` at the end of the
 * FIX-933 merge script cleared it on 2026-07-31 02:35 and per-chunk cost
 * dropped 2.5x. If this job goes slow again, check
 * pg_stat_user_tables.n_dead_tup on financial_relationships BEFORE sweeping.
 *
 * This script is for when you genuinely want it done in ONE pass:
 *
 *   * `SET statement_timeout = 0` at SESSION level, BEFORE the CALL. This is
 *     the only place that ceiling can be lifted — neither `SET
 *     statement_timeout` inside the procedure body nor a function-level
 *     `ALTER PROCEDURE ... SET statement_timeout` re-arms the running timer
 *     (both measured 2026-07-31; the inner SET is silently ignored for the
 *     statements that follow it).
 *   * `SET civitics.donor_rollup_budget_seconds` widens the procedure's own
 *     between-chunk wall-clock budget to match. It is a session GUC, not shared
 *     state, so a crashed run cannot leave the scheduled job's budget widened.
 *
 * Everything the procedure does is committed per chunk and cursor-tracked, so
 * killing this script at any point loses at most one chunk — the next run
 * (scheduled or manual) picks up at the cursor.
 *
 *   pnpm --filter @civitics/data data:donor-rollup:sweep                # local Docker
 *   pnpm --filter @civitics/data data:donor-rollup:sweep -- --status    # read-only
 *   pnpm --filter @civitics/data data:donor-rollup:sweep:prod           # prod, needs --confirm
 *
 * Prod runs write six rollup tables and are long. Run them off-peak — see
 * CLAUDE.md "Data-state changes vs schema changes" and the no-heavy-prod-ops
 * -during-active-hours rule.
 */

import { Client } from "pg";
import { ARMED_PROBE_SQL, isTimeoutDisarmed, type ArmedProbeRow } from "../lib/statement-timeout-probe";

const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// One CALL's between-chunk budget when sweeping manually. Generous because this
// session has no statement_timeout; the procedure still stops cleanly between
// chunks rather than being cancelled mid-chunk.
const DEFAULT_BUDGET_SECONDS = 20 * 3600;

// Hard stop on the resume loop so a pathological "always partial, no progress"
// state can never spin forever. Each iteration is a full budget window.
const MAX_ITERATIONS = 12;

interface Args {
  dbUrl: string;
  allowProd: boolean;
  confirm: boolean;
  statusOnly: boolean;
  budgetSeconds: number;
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
  let dbUrl = process.env["SUPABASE_DB_URL"] ?? LOCAL_DB_URL;
  let allowProd = false;
  let confirm = false;
  let statusOnly = false;
  let budgetSeconds = DEFAULT_BUDGET_SECONDS;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--db-url" && args[i + 1]) dbUrl = args[++i]!;
    else if (a === "--allow-prod") allowProd = true;
    else if (a === "--confirm") confirm = true;
    else if (a === "--status") statusOnly = true;
    else if (a === "--budget-seconds" && args[i + 1]) budgetSeconds = Number(args[++i]);
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: donor-rollup-sweep [--status] [--allow-prod --confirm]\n" +
          "                         [--db-url URL] [--budget-seconds N]\n\n" +
          "  --status          report sweep state and exit; writes nothing\n" +
          "  --allow-prod      permit a supabase.co --db-url\n" +
          "  --confirm         required for a prod WRITE run\n" +
          "  --budget-seconds  per-CALL between-chunk budget (default 72000)\n",
      );
      process.exit(0);
    }
  }
  return { dbUrl, allowProd, confirm, statusOnly, budgetSeconds };
}

interface Freshness {
  last_complete_at: string | null;
  hours_since_complete: number | null;
  stale: boolean;
  last_status: string | null;
  last_error: string | null;
  sweep_in_progress: boolean | null;
  sweep_cursor: string | null;
  last_metadata: Record<string, unknown> | null;
}

async function readState(client: Client): Promise<Freshness> {
  const { rows } = await client.query<{ f: Freshness }>(
    "SELECT public.check_rollup_freshness('donor_rollup_refresh', 48) AS f",
  );
  return rows[0]!.f;
}

async function reportState(client: Client, label: string): Promise<Freshness> {
  const s = await readState(client);
  console.log(
    `[sweep] ${label}: last_complete=${s.last_complete_at ?? "never"} ` +
      `(${s.hours_since_complete ?? "?"}h ago, stale=${s.stale}) ` +
      `last_status=${s.last_status ?? "-"} sweep_in_progress=${s.sweep_in_progress ?? false}` +
      (s.sweep_cursor ? ` cursor=${s.sweep_cursor}` : ""),
  );
  if (s.last_error) console.log(`[sweep]   last_error: ${s.last_error}`);
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
        "This rebuilds six per-official rollup tables and can run for hours — " +
        "start it off-peak. Use --status for a read-only check.",
    );
    return 1;
  }

  const client = new Client({ connectionString: args.dbUrl, application_name: "civitics_donor_rollup_sweep" });
  await client.connect();

  // Cancel in-flight work on SIGTERM/SIGINT rather than orphaning a backend
  // that keeps writing after the runner is gone (the FIX-591 lesson). Safe to
  // interrupt at any point: chunks are committed and cursor-tracked.
  const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
  let cleaning = false;
  const onSignal = (sig: string): void => {
    if (cleaning) return;
    cleaning = true;
    console.error(`[sweep] ${sig} — cancelling in-flight chunk; committed chunks are kept`);
    void (async () => {
      try {
        const c2 = new Client({ connectionString: args.dbUrl, application_name: "civitics_donor_rollup_sweep_cleanup" });
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

    // THE point of this script. Both are session-scoped: nothing to restore,
    // nothing that can strand and widen the scheduled pg_cron run.
    await client.query("SET statement_timeout = 0");
    await client.query("SET lock_timeout = '60s'");
    await client.query(`SET civitics.donor_rollup_budget_seconds = '${Math.floor(args.budgetSeconds)}'`);
    await client.query("SET work_mem = '128MB'");

    // FIX-968 — shared probe. This gate used `SHOW statement_timeout` + `.st`,
    // which names its column after the setting, so `.st` was always undefined
    // and the gate ALWAYS refused: this script could never run. See
    // lib/statement-timeout-probe.ts.
    const armed = await client.query<ArmedProbeRow>(ARMED_PROBE_SQL);
    if (!isTimeoutDisarmed(armed.rows[0])) {
      console.error(`[sweep] refusing: statement_timeout is ${armed.rows[0]?.st}, expected 0 — the sweep would be cancelled mid-flight`);
      return 1;
    }
    console.log(`[sweep] session armed: statement_timeout=0, budget=${args.budgetSeconds}s`);

    let iteration = 0;
    let lastCursor: string | null = before.sweep_cursor;
    for (; iteration < MAX_ITERATIONS; iteration++) {
      const t0 = Date.now();
      console.log(`[sweep] CALL refresh_official_donor_rollup_incremental() — iteration ${iteration + 1}`);
      await client.query("CALL public.refresh_official_donor_rollup_incremental()");
      const mins = Math.round((Date.now() - t0) / 60000);

      const s = await reportState(client, `after iteration ${iteration + 1} (${mins}m)`);

      if (s.last_status === "complete") {
        console.log("[sweep] sweep COMPLETE — watermark advanced, cursor cleared");
        break;
      }
      if (s.last_status === "failed") {
        console.error("[sweep] sweep reported FAILED — chunk errors present; watermark deliberately not advanced");
        return 1;
      }
      if (s.last_status === "skipped") {
        console.error("[sweep] another refresh holds the advisory lock — nothing to do");
        return 1;
      }
      // 'partial' — resumable. Guard against a no-progress spin.
      if (s.sweep_cursor && s.sweep_cursor === lastCursor) {
        console.error(
          `[sweep] cursor did not advance past ${s.sweep_cursor} — stopping rather than spinning. ` +
            "A single chunk is likely exceeding the whole budget; investigate that recipient set.",
        );
        return 1;
      }
      lastCursor = s.sweep_cursor;
    }

    if (iteration >= MAX_ITERATIONS) {
      console.error(`[sweep] hit MAX_ITERATIONS (${MAX_ITERATIONS}) still partial — rerun to continue from the cursor`);
      return 1;
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
