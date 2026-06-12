/**
 * Cron-run baseline probe — READ-ONLY.
 *
 * Pulls pipeline_runtime_stats_mv + recent data_sync_log rows + anchor counts
 * from whichever DB .env.local points at. Used by docs/audits/cron_run_*.md
 * to establish a delta baseline before kicking off a weekly cron block.
 *
 * Exits non-zero if it can't reach the DB. No writes.
 */

import { createAdminClient } from "@civitics/db";
import { selectDirect } from "../lib/heavy-rebuild";

async function main(): Promise<void> {
  const db = createAdminClient();

  console.log("=== pipeline_runtime_stats_mv (p50/p95/max in ms) ===");
  {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from("pipeline_runtime_stats_mv")
      .select("*")
      .order("pipeline", { ascending: true });
    if (error) {
      console.error("  (MV query failed:", error.message, "—", error.details, ")");
    } else {
      for (const r of (data ?? [])) console.log(" ", JSON.stringify(r));
    }
  }

  console.log("\n=== data_sync_log — last 30 rows ===");
  {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from("data_sync_log")
      .select("pipeline, status, started_at, completed_at, rows_inserted, rows_updated, error_message")
      .order("started_at", { ascending: false })
      .limit(30);
    if (error) { console.error("  failed:", error.message); }
    else for (const r of (data ?? [])) console.log(" ", JSON.stringify(r));
  }

  console.log("\n=== data_sync_log — fec_bulk history (last 10) ===");
  {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from("data_sync_log")
      .select("pipeline, status, started_at, completed_at, rows_inserted, rows_updated, error_message, metadata")
      .eq("pipeline", "fec_bulk")
      .order("started_at", { ascending: false })
      .limit(10);
    if (error) { console.error("  failed:", error.message); }
    else for (const r of (data ?? [])) console.log(" ", JSON.stringify(r));
  }

  console.log("\n=== anchor counts ===");
  // FIX-511 triage — every number here is a delta-baseline magnitude, not a
  // boolean probe or a precision anchor:
  //   - table totals + the single entity_type filter → count:'estimated'
  //     (exact up to max_rows, planner estimate above — no table scan)
  //   - genuine per-group breakdowns (officials by tier; FR by
  //     relationship_type and by source) → one direct-pg GROUP BY scan per
  //     table instead of one exact PostgREST count per value (source is
  //     unindexed; common relationship_type values plan seq scans — FIX-345)
  const counts: Record<string, number | string> = {};
  for (const [label, q] of [
    ["officials_total_est", () => db.from("officials").select("*", { count: "estimated", head: true })],
    ["financial_entities_total_est", () => db.from("financial_entities").select("*", { count: "estimated", head: true })],
    ["financial_entities_individuals_est", () => db.from("financial_entities").select("*", { count: "estimated", head: true }).eq("entity_type", "individual")],
    ["financial_relationships_total_est", () => db.from("financial_relationships").select("*", { count: "estimated", head: true })],
    ["entity_connections_total_est", () => db.from("entity_connections").select("*", { count: "estimated", head: true })],
  ] as const) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { count, error } = await (q() as any);
      if (error) counts[label] = `error: ${error.message}`;
      else counts[label] = count ?? 0;
    } catch (e) {
      counts[label] = `throw: ${(e as Error).message}`;
    }
  }
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(40)} ${v}`);

  try {
    const tierRows = await selectDirect<{ tier: string | null; n: string }>(
      "SELECT tier, count(*) AS n FROM officials GROUP BY tier ORDER BY 1 NULLS LAST",
    );
    for (const r of tierRows) console.log(`  ${("officials_tier_" + (r.tier ?? "null")).padEnd(40)} ${r.n}`);

    // `source` is a metadata JSONB key, NOT a column (the prior labels
    // fr_source_* were PostgREST 42703 errors, not counts).
    const frRows = await selectDirect<{
      source: string | null;
      relationship_type: string | null;
      n: string;
      g_source: number;
      g_type: number;
    }>(`
      SELECT metadata->>'source' AS source, relationship_type, count(*) AS n,
             grouping(metadata->>'source') AS g_source,
             grouping(relationship_type)   AS g_type
        FROM financial_relationships
       GROUP BY GROUPING SETS ((metadata->>'source'), (relationship_type))
       ORDER BY 1 NULLS LAST, 2 NULLS LAST`);
    for (const r of frRows.filter((r) => r.g_type === 0)) {
      console.log(`  ${("fr_type_" + (r.relationship_type ?? "null")).padEnd(40)} ${r.n}`);
    }
    for (const r of frRows.filter((r) => r.g_source === 0)) {
      console.log(`  ${("fr_source_" + (r.source ?? "null")).padEnd(40)} ${r.n}`);
    }
  } catch (e) {
    console.error("  group-by breakdown failed:", e instanceof Error ? e.message : String(e));
  }

  console.log("\n=== pipeline_state — cron_last_run ===");
  {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from("pipeline_state")
      .select("key, value, updated_at")
      .eq("key", "cron_last_run")
      .maybeSingle();
    if (error) console.error("  failed:", error.message);
    else if (!data) console.log("  (no row)");
    else {
      console.log("  updated_at:", data.updated_at);
      const v = (data as { value?: { status?: string; started_at?: string; completed_at?: string; results?: { duration_ms?: number; errors?: string[] } } }).value ?? {};
      console.log("  status:    ", v.status);
      console.log("  started_at:", v.started_at);
      console.log("  completed: ", v.completed_at);
      console.log("  duration_ms:", v.results?.duration_ms);
      console.log("  errors:    ", JSON.stringify(v.results?.errors));
    }
  }

  console.log("\n=== Sunday cron prediction inputs ===");
  {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: fecLm, error: fecErr } = await (db as any)
      .from("pipeline_state")
      .select("key, value, updated_at")
      .ilike("key", "fec_bulk%");
    if (fecErr) console.error("  fec_bulk* failed:", fecErr.message);
    else for (const r of (fecLm ?? [])) console.log(" ", JSON.stringify(r));
  }

  setTimeout(() => process.exit(0), 250);
}

main().catch((e) => {
  console.error("probe failed:", e instanceof Error ? e.message : String(e));
  setTimeout(() => process.exit(1), 250);
});
