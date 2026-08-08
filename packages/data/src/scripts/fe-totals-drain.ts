/**
 * FIX-977 — manual drain of financial_entity_totals_refresh.
 *
 * WHY A MANUAL DRAIN IS NEEDED AT ALL — the ratchet.
 * `refresh_financial_entity_totals_incremental()` (pg_cron jobid 13, weekly
 * `0 9 * * 2`) is watermark-driven: it reads
 * `pipeline_state.financial_entity_totals_watermark`, builds the set of
 * financial_relationships donation rows written since, and advances the
 * watermark ONLY on a clean finish. So a failed run does not just lose a week —
 * it hands its entire dirty set to the next run PLUS another week of writes.
 * Each retry is strictly larger than the one that just failed, against a fixed
 * 6 h statement_timeout. Measured on prod 2026-08-08:
 *
 *   2026-07-21 09:00  complete   dirty_donors     28,884   7m04s
 *   2026-07-28 09:00  FAILED     dirty_donors    827,122   6h00m11s (statement timeout)
 *   2026-08-04 09:00  FAILED     (no data_sync_log row at all — "job startup timeout")
 *   2026-08-08 00:47  dirty_donors now        1,879,245   and still climbing
 *
 * The watermark has sat at 2026-07-20 05:46:53 since the last success. That is
 * why the canary reads 403.8 h stale on a weekly job: it is not one missed
 * firing, it is a job that can no longer finish inside its own ceiling.
 *
 * This script runs the same procedure over a direct session-pooler connection
 * with the session statement_timeout raised past the cron's 6 h, so the drain
 * can complete once and reset the watermark to current. It is a catch-up, not a
 * replacement — the weekly cron stays the ongoing path.
 *
 *   tsx --env-file=../../.env.local.prod src/scripts/fe-totals-drain.ts --allow-prod
 *   tsx --env-file=../../.env.local  src/scripts/fe-totals-drain.ts          # local
 *   ... --timeout 0     # unlimited (default '5h')
 *   ... --status        # report state and exit, run nothing
 *
 * Cost note: this is a multi-hour prod write. Run it clear of the 05:50-08:00
 * UTC nightly and of 09:00-17:40 UTC active hours.
 */

import { Client } from "pg";
import { buildDbUrl } from "../lib/heavy-rebuild";

const PIPELINE = "financial_entity_totals_refresh";
const WATERMARK_KEY = "financial_entity_totals_watermark";

const STATE_SQL = `
  SELECT
    (SELECT value->>'last_indexed_at' FROM public.pipeline_state WHERE key = $1) AS watermark,
    (SELECT max(completed_at) FROM public.data_sync_log
      WHERE pipeline = $2 AND status = 'complete')                              AS last_complete,
    ROUND(EXTRACT(epoch FROM now() - (SELECT max(completed_at) FROM public.data_sync_log
      WHERE pipeline = $2 AND status = 'complete')) / 3600.0, 1)                AS hours_stale
`;

const DIRTY_SQL = `
  SELECT count(DISTINCT fr.from_id) AS dirty_donors
  FROM public.financial_relationships fr
  WHERE fr.relationship_type = 'donation'
    AND fr.from_type = 'financial_entity'
    AND fr.updated_at > $1::timestamptz
`;

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? (process.argv[i + 1] ?? null) : null;
}

async function reportState(c: Client, label: string): Promise<string | null> {
  const st = await c.query(STATE_SQL, [WATERMARK_KEY, PIPELINE]);
  const row = st.rows[0] as { watermark: string | null; last_complete: string | null; hours_stale: string | null };
  console.log(`[fe-drain] ${label}: watermark=${row.watermark ?? "(none)"} last_complete=${row.last_complete ?? "(none)"} hours_stale=${row.hours_stale ?? "?"}`);
  if (row.watermark) {
    const d = await c.query(DIRTY_SQL, [row.watermark]);
    console.log(`[fe-drain] ${label}: dirty_donors=${Number((d.rows[0] as { dirty_donors: string }).dirty_donors).toLocaleString()}`);
  }
  return row.watermark;
}

async function main(): Promise<number> {
  const dsn = buildDbUrl();
  const isProd = /supabase\.co|pooler\.supabase\.com/i.test(dsn);
  if (isProd && !process.argv.includes("--allow-prod")) {
    console.error("[fe-drain] refusing to run against PROD without --allow-prod");
    return 1;
  }
  const timeout = argValue("--timeout") ?? "5h";
  console.log(`[fe-drain] target: ${isProd ? "PROD (Supabase Pro)" : "LOCAL Docker"}  statement_timeout=${timeout}`);

  const c = new Client({ connectionString: dsn });
  await c.connect();
  try {
    const before = await reportState(c, "BEFORE");
    if (process.argv.includes("--status")) return 0;
    if (!before) {
      console.log("[fe-drain] no watermark — the procedure will bootstrap (16-window full pass).");
    }

    // Session-level, and it survives the procedure's internal COMMITs. The cron
    // dies at 6h; a drain that has to make up five weeks needs more headroom
    // than the steady-state run it is catching up for.
    await c.query(`SET statement_timeout = ${timeout === "0" ? "0" : `'${timeout}'`}`);
    if (!isProd) {
      // Local Docker /dev/shm is 64MB — a parallel aggregate plan fails with
      // "could not resize shared memory segment".
      await c.query("SET max_parallel_workers_per_gather = 0");
    }

    console.log(`[fe-drain] CALL public.refresh_financial_entity_totals_incremental() ...`);
    const t0 = Date.now();
    // Autocommit at top level: the procedure COMMITs per window, which is
    // illegal inside an explicit transaction block.
    await c.query("CALL public.refresh_financial_entity_totals_incremental()");
    console.log(`[fe-drain] done in ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`);

    await reportState(c, "AFTER ");

    const log = await c.query(
      `SELECT status, started_at, completed_at, metadata
         FROM public.data_sync_log WHERE pipeline = $1
        ORDER BY started_at DESC LIMIT 1`,
      [PIPELINE],
    );
    console.log(`[fe-drain] last run row: ${JSON.stringify(log.rows[0])}`);

    // FIX-975 / FIX-943 standing rule: this procedure mass-UPDATEs
    // financial_entities across every dirty window, so the pass owns its
    // vacuum tail. VACUUM cannot run inside the procedure.
    console.log("[fe-drain] VACUUM (ANALYZE) public.financial_entities (FIX-943 rule)");
    const t1 = Date.now();
    await c.query("VACUUM (ANALYZE) public.financial_entities");
    console.log(`[fe-drain] vacuum done in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
    return 0;
  } finally {
    await c.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
