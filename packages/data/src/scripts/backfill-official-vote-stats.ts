/**
 * FIX-837 — one-shot bootstrap of public.official_vote_stats against the active
 * DB via the vetted direct-pg path (callHeavyProcedure: allow-listed CALL,
 * session statement_timeout raised to 90min past the ~2min whole-votes agg).
 *
 * official_vote_stats is the per-official vote summary
 * {total_votes,yes_votes,bipartisan_yes} that get_official_bipartisan_stats() now
 * reads instead of scanning the whole votes table (~114s, FIX-651) on every
 * rule-tagger run. The nightly FULL rebuild (pg_cron vote-stats-refresh, 03:30
 * UTC) keeps it fresh; this script is the initial per-env population (and an
 * idempotent break-glass full rebuild). Unlike the chunked donor backfills the
 * rebuild is a SINGLE transaction (atomic DELETE + INSERT + bootstrap flag).
 *
 * Run:
 *   # local Docker (active .env.local points local)
 *   pnpm --filter @civitics/data data:backfill-vote-stats
 *
 *   # prod — off-peak preferred; ~2min whole-votes aggregation.
 *   pnpm --filter @civitics/data data:backfill-vote-stats:prod
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL (+ SUPABASE_DB_PASSWORD for prod) from the
 * active env. Confirm the target printed below before letting it write to prod.
 */

import { callHeavyProcedure, selectDirect } from "../lib/heavy-rebuild";

async function main(): Promise<void> {
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "(unset)";
  console.log(`[backfill-vote-stats] target: ${url}`);
  console.log(
    `[backfill-vote-stats] CALL rebuild_official_vote_stats() ` +
      `(single-txn full rebuild of the votes summary; ~2min on prod) ...`,
  );
  const t0 = Date.now();
  await callHeavyProcedure("rebuild_official_vote_stats");
  const rows = await selectDirect<{ n: string }>(
    "SELECT count(*)::text AS n FROM public.official_vote_stats",
  );
  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[backfill-vote-stats] ✓ ${Number(rows[0]?.n ?? 0).toLocaleString()} official rows in ${dur}s`,
  );
}

main().catch((e) => {
  console.error("[backfill-vote-stats] fatal:", e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
