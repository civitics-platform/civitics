/**
 * FIX-778 — one-shot bootstrap of public.agency_staffing_rollup against the
 * active DB via the vetted direct-pg path (callHeavyProcedure: allow-listed CALL,
 * session statement_timeout 90min). Runs refresh_agency_staffing_rollup() — the
 * SAME full chunked recompute the weekly pg_cron job runs (50 agencies/chunk,
 * COMMIT each), so this is both the per-env bootstrap and an idempotent rebuild.
 *
 * agency_staffing_rollup is the per-agency {appointment_count, contract_cents,
 * grant_cents} that /api/graph/agency-staffing now reads instead of paginating
 * entity_connections + the ~1.28M agency contract/grant FR rows per request.
 *
 * Run:
 *   pnpm --filter @civitics/data data:backfill-agency-staffing
 *   pnpm --filter @civitics/data data:backfill-agency-staffing:prod   # off-peak preferred
 */

import { callHeavyProcedure, selectDirect } from "../lib/heavy-rebuild";

async function main(): Promise<void> {
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "(unset)";
  console.log(`[backfill-agency-staffing] target: ${url}`);
  console.log(
    `[backfill-agency-staffing] CALL refresh_agency_staffing_rollup() ` +
      `(full recompute, chunked 50 agencies/chunk, COMMIT each) ...`,
  );
  const t0 = Date.now();
  await callHeavyProcedure("refresh_agency_staffing_rollup");
  const rows = await selectDirect<{ n: string }>(
    "SELECT count(*)::text AS n FROM public.agency_staffing_rollup",
  );
  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[backfill-agency-staffing] ✓ ${Number(rows[0]?.n ?? 0).toLocaleString()} agency rows in ${dur}s`,
  );
}

main().catch((e) => {
  console.error("[backfill-agency-staffing] fatal:", e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
