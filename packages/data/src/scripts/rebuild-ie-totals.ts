/**
 * FIX-666 — One-shot backfill of financial_entities IE (Schedule E) totals.
 *
 * Recomputes total_ie_support_cents / total_ie_oppose_cents from the live
 * ie_support / ie_oppose financial_relationships rows by calling
 * rebuild_financial_entity_ie_totals() over a DIRECT session-pooler connection
 * (runHeavyRebuild raises the SESSION statement_timeout past the PostgREST
 * gateway cap — see lib/heavy-rebuild.ts for why a function-level ALTER alone
 * does not suffice).
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_DB_PASSWORD from the active env, so
 * it runs against whichever DB the loaded env points at:
 *
 *   # local Docker (active .env.local points local)
 *   pnpm --filter @civitics/data data:rebuild:ie-totals
 *
 *   # prod (off-peak only — see CLAUDE.md "no heavy prod ops during active hours")
 *   pnpm --filter @civitics/data exec \
 *     tsx --env-file=../../.env.local.prod src/scripts/rebuild-ie-totals.ts
 *
 * Always confirm the active env points where you intend before running.
 */

import { runHeavyRebuild } from "../lib/heavy-rebuild";

async function main(): Promise<void> {
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "(unset)";
  console.log(`Rebuilding financial_entities IE totals against: ${url}`);
  const t0 = Date.now();
  // Returns void → count 0; we run for the side effect.
  await runHeavyRebuild("rebuild_financial_entity_ie_totals");
  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`✓ rebuild_financial_entity_ie_totals complete (${dur}s)`);
}

main().catch((e) => {
  console.error("fatal:", e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
