/**
 * FIX-776 — one-shot chunked bootstrap of public.official_small_dollar_rollup
 * against the active DB via the vetted direct-pg path (callHeavyProcedure:
 * allow-listed CALL, session statement_timeout raised to 90min; the procedure
 * commits per 500-official chunk so it never holds a whole-table aggregate).
 *
 * official_small_dollar_rollup is the per-official small-dollar (<$500) donation
 * summary {small_dollar_cents, small_dollar_count} that /api/graph/small-dollar
 * now reads by PK instead of paginating the donation table on every request. The
 * incremental daily refresh (donor_rollup_rebuild_recipients on the FIX-704/832
 * donor_rollup_watermark) keeps it fresh; this backfill is the initial per-env
 * population (and an idempotent break-glass full rebuild).
 *
 * Run:
 *   # local Docker (active .env.local points local)
 *   pnpm --filter @civitics/data data:backfill-small-dollar
 *
 *   # prod — off-peak preferred; chunked so it is gentle (~4.2k officials).
 *   pnpm --filter @civitics/data data:backfill-small-dollar:prod
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL (+ SUPABASE_DB_PASSWORD for prod) from the
 * active env. Confirm the target printed below before letting it write to prod.
 */

import { callHeavyProcedure, selectDirect } from "../lib/heavy-rebuild";

async function main(): Promise<void> {
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "(unset)";
  console.log(`[backfill-small-dollar] target: ${url}`);
  console.log(
    `[backfill-small-dollar] CALL backfill_official_small_dollar_rollup() ` +
      `(chunked, 500 officials/chunk, COMMIT each) ...`,
  );
  const t0 = Date.now();
  await callHeavyProcedure("backfill_official_small_dollar_rollup");
  const rows = await selectDirect<{ n: string }>(
    "SELECT count(*)::text AS n FROM public.official_small_dollar_rollup",
  );
  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[backfill-small-dollar] ✓ ${Number(rows[0]?.n ?? 0).toLocaleString()} official rows in ${dur}s`,
  );
}

main().catch((e) => {
  console.error("[backfill-small-dollar] fatal:", e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
