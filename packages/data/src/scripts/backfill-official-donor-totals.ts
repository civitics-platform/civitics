/**
 * FIX-836 — one-shot bootstrap of public.official_donor_totals against the
 * active DB via the vetted direct-pg path (runHeavyRebuild: allow-listed fn,
 * session statement_timeout raised to 90min past the ~16min whole-table agg).
 *
 * official_donor_totals is the exact per-official donation summary
 * {total,pac,individual,count} that get_official_donor_rollup() now reads
 * instead of scanning the whole donation table on every tagger run. The
 * incremental daily refresh (refresh_official_donor_rollup_incremental, FIX-704/
 * 832) keeps it fresh via donor_rollup_rebuild_recipients(); this backfill is the
 * initial per-env population (and a break-glass full rebuild).
 *
 * Run:
 *   # local Docker (active .env.local points local)
 *   pnpm --filter @civitics/data data:backfill-donor-totals
 *
 *   # prod — off-peak only (CLAUDE.md "no heavy prod ops during active hours");
 *   #        ~16min whole-table aggregation.
 *   pnpm --filter @civitics/data data:backfill-donor-totals:prod
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL (+ SUPABASE_DB_PASSWORD for prod) from the
 * active env. Confirm the target printed below before letting it write to prod.
 */

import { runHeavyRebuild } from "../lib/heavy-rebuild";

async function main(): Promise<void> {
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "(unset)";
  console.log(`[backfill-donor-totals] target: ${url}`);
  console.log(
    `[backfill-donor-totals] CALL official_donor_totals_backfill() ` +
      `(TRUNCATE + whole-table donation aggregation; ~16min on prod) ...`,
  );
  const t0 = Date.now();
  const count = await runHeavyRebuild("official_donor_totals_backfill");
  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[backfill-donor-totals] ✓ ${count.toLocaleString()} official rows in ${dur}s`);
}

main().catch((e) => {
  console.error("[backfill-donor-totals] fatal:", e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
