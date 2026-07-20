/**
 * FIX-838 — one-shot bootstrap of the two contract-flow rollups against the
 * active DB via the vetted direct-pg path (callHeavyProcedure: allow-listed CALL,
 * session statement_timeout raised past the ~1-2min aggregation).
 *
 * public.contract_recipient_rollup (top-500 recipients) and
 * public.contract_agency_sector_rollup (full agency x sector chord) are what
 * /api/graph/spending's treemap_recipients_by_contracts() / chord_contract_flows()
 * now read instead of a >45s scan over ~3.24M contract financial_relationships.
 * The weekly FULL rebuild (pg_cron contract-flow-rollups-refresh, Thu 14:00 UTC,
 * after the Thu 10:00 USASpending ingest) keeps them fresh; this script is the
 * initial per-env population (and an idempotent break-glass full rebuild). The
 * rebuild is a SINGLE transaction (atomic DELETE + INSERT per table + bootstrap
 * flag), so a reader never sees an empty/partial set.
 *
 * Run:
 *   # local Docker (active .env.local points local)
 *   pnpm --filter @civitics/data data:backfill-contract-flow-rollups
 *
 *   # prod — off-peak preferred; ~1-2min aggregation on the Small instance.
 *   pnpm --filter @civitics/data data:backfill-contract-flow-rollups:prod
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL (+ SUPABASE_DB_PASSWORD for prod) from the
 * active env. Confirm the target printed below before letting it write to prod.
 */

import { callHeavyProcedure, selectDirect } from "../lib/heavy-rebuild";

async function main(): Promise<void> {
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "(unset)";
  console.log(`[backfill-contract-flow-rollups] target: ${url}`);
  console.log(
    `[backfill-contract-flow-rollups] CALL refresh_contract_flow_rollups() ` +
      `(single-txn full rebuild of both contract-flow rollups; ~1-2min on prod) ...`,
  );
  const t0 = Date.now();
  await callHeavyProcedure("refresh_contract_flow_rollups");
  const rows = await selectDirect<{ recipients: string; flows: string }>(
    "SELECT (SELECT count(*)::text FROM public.contract_recipient_rollup)     AS recipients, " +
      "       (SELECT count(*)::text FROM public.contract_agency_sector_rollup) AS flows",
  );
  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[backfill-contract-flow-rollups] ✓ ${Number(rows[0]?.recipients ?? 0).toLocaleString()} recipient rows, ` +
      `${Number(rows[0]?.flows ?? 0).toLocaleString()} agency×sector rows in ${dur}s`,
  );
}

main().catch((e) => {
  console.error("[backfill-contract-flow-rollups] fatal:", e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
