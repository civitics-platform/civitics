/**
 * FIX-777 — one-shot chunked bootstrap of public.official_sector_affinity_rollup
 * against the active DB via the vetted direct-pg path (callHeavyProcedure:
 * allow-listed CALL, session statement_timeout 90min; the procedure commits per
 * 500-official chunk so it never holds a whole-table aggregate).
 *
 * official_sector_affinity_rollup is the per-(official, industry) donor-sector
 * summary {total_cents, donor_count} that /api/graph/sector-affinity now reads
 * instead of paginating the donation table + batching a tag lookup on every
 * request. The incremental daily refresh (donor_rollup_rebuild_recipients on the
 * FIX-704/832 donor_rollup_watermark) keeps it fresh; this is the per-env
 * bootstrap (and an idempotent break-glass full rebuild).
 *
 * Run:
 *   pnpm --filter @civitics/data data:backfill-sector-affinity
 *   pnpm --filter @civitics/data data:backfill-sector-affinity:prod   # off-peak preferred
 */

import { callHeavyProcedure, selectDirect } from "../lib/heavy-rebuild";

async function main(): Promise<void> {
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "(unset)";
  console.log(`[backfill-sector-affinity] target: ${url}`);
  console.log(
    `[backfill-sector-affinity] CALL backfill_official_sector_affinity_rollup() ` +
      `(chunked, 500 officials/chunk, COMMIT each) ...`,
  );
  const t0 = Date.now();
  await callHeavyProcedure("backfill_official_sector_affinity_rollup");
  const rows = await selectDirect<{ n: string }>(
    "SELECT count(*)::text AS n FROM public.official_sector_affinity_rollup",
  );
  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[backfill-sector-affinity] ✓ ${Number(rows[0]?.n ?? 0).toLocaleString()} (official,industry) rows in ${dur}s`,
  );
}

main().catch((e) => {
  console.error("[backfill-sector-affinity] fatal:", e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
