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
  const counts: Record<string, number | string> = {};
  for (const [label, q] of [
    ["officials_total", () => db.from("officials").select("*", { count: "exact", head: true })],
    ["officials_tier_candidate", () => db.from("officials").select("*", { count: "exact", head: true }).eq("tier", "candidate")],
    ["officials_tier_elected", () => db.from("officials").select("*", { count: "exact", head: true }).eq("tier", "elected")],
    ["financial_entities_total", () => db.from("financial_entities").select("*", { count: "exact", head: true })],
    ["financial_entities_individuals", () => db.from("financial_entities").select("*", { count: "exact", head: true }).eq("entity_type", "individual")],
    ["financial_relationships_total", () => db.from("financial_relationships").select("*", { count: "exact", head: true })],
    ["fr_donation", () => db.from("financial_relationships").select("*", { count: "exact", head: true }).eq("relationship_type", "donation")],
    ["fr_ie_support", () => db.from("financial_relationships").select("*", { count: "exact", head: true }).eq("relationship_type", "ie_support")],
    ["fr_ie_oppose", () => db.from("financial_relationships").select("*", { count: "exact", head: true }).eq("relationship_type", "ie_oppose")],
    ["fr_source_fec_bulk_indiv", () => db.from("financial_relationships").select("*", { count: "exact", head: true }).eq("source", "fec_bulk_indiv")],
    ["fr_source_fec_bulk_indiv_to_committee", () => db.from("financial_relationships").select("*", { count: "exact", head: true }).eq("source", "fec_bulk_indiv_to_committee")],
    ["fr_source_fec_bulk_ie", () => db.from("financial_relationships").select("*", { count: "exact", head: true }).eq("source", "fec_bulk_ie")],
    ["entity_connections_total", () => db.from("entity_connections").select("*", { count: "exact", head: true })],
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
