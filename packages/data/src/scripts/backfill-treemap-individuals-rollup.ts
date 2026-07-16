/**
 * FIX-779 — one-shot bootstrap of public.treemap_individuals_rollup against the
 * active DB via the vetted direct-pg path (callHeavyProcedure: allow-listed CALLs,
 * session statement_timeout 90min). Runs BOTH:
 *   1. backfill_treemap_individuals_focused() — chunked per-official (300/chunk,
 *      COMMIT each), the same top-50/state recompute the daily donor dirty set
 *      keeps fresh incrementally.
 *   2. refresh_treemap_individuals_global() — the TRUE uncapped global scope
 *      (single memory-bounded pass), the same the weekly cron runs.
 *
 * treemap_individuals_rollup serves /api/graph/treemap-individuals via the
 * cap-proof get_treemap_individuals(scope) RPC, instead of paging + JS-aggregating
 * the individual-donor set per request (and — for global — instead of the old
 * 20k-row scan cap that showed <1% of the data).
 *
 * Run:
 *   pnpm --filter @civitics/data data:backfill-treemap-individuals
 *   pnpm --filter @civitics/data data:backfill-treemap-individuals:prod   # off-peak preferred (heaviest of the FIX-775 set)
 */

import { callHeavyProcedure, selectDirect } from "../lib/heavy-rebuild";

async function main(): Promise<void> {
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "(unset)";
  // --global-only / --focused-only run a single phase (e.g. re-run just the
  // global uncapped aggregate without re-doing the ~50-min focused pass).
  const argv = process.argv.slice(2);
  const globalOnly = argv.includes("--global-only");
  const focusedOnly = argv.includes("--focused-only");
  console.log(`[backfill-treemap-individuals] target: ${url}${globalOnly ? " (global-only)" : focusedOnly ? " (focused-only)" : ""}`);

  const t0 = Date.now();
  if (!globalOnly) {
    console.log(`[backfill-treemap-individuals] CALL backfill_treemap_individuals_focused() (chunked 300 officials/chunk) ...`);
    await callHeavyProcedure("backfill_treemap_individuals_focused");
    const tf = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[backfill-treemap-individuals]   focused done in ${tf}s`);
  }

  if (!focusedOnly) {
    const t1 = Date.now();
    console.log(`[backfill-treemap-individuals] CALL refresh_treemap_individuals_global() (uncapped global aggregate) ...`);
    await callHeavyProcedure("refresh_treemap_individuals_global");
    const tg = ((Date.now() - t1) / 1000).toFixed(1);
    console.log(`[backfill-treemap-individuals]   global done in ${tg}s`);
  }

  const rows = await selectDirect<{ n: string; g: string }>(
    "SELECT count(*)::text AS n, " +
      "count(*) FILTER (WHERE scope_id = '00000000-0000-0000-0000-000000000000')::text AS g " +
      "FROM public.treemap_individuals_rollup",
  );
  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[backfill-treemap-individuals] ✓ ${Number(rows[0]?.n ?? 0).toLocaleString()} rows ` +
      `(${Number(rows[0]?.g ?? 0).toLocaleString()} global) in ${dur}s`,
  );
}

main().catch((e) => {
  console.error("[backfill-treemap-individuals] fatal:", e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
