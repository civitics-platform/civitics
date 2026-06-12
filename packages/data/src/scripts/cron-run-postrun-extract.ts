/**
 * Post-run state extractor — READ-ONLY.
 *
 * After the forced-Sunday cron wrapper completes (or halts), pulls:
 *  - data_sync_log rows for the run window (started_at >= RUN_START_ISO)
 *  - pipeline_state.cron_last_run + fec_bulk watermark keys
 *  - financial_relationships counts broken down by source + relationship_type
 *  - MV row counts
 *
 * RUN_START_ISO is passed via env so it's traceable.
 */

import { createAdminClient } from "@civitics/db";
import { selectDirect } from "../lib/heavy-rebuild";

const RUN_START = process.env["RUN_START_ISO"] ?? new Date(Date.now() - 60 * 60 * 1000).toISOString();

// FIX-511 — one GROUPING SETS scan via direct pg replaces the prior 12
// sequential PostgREST exact head-counts (7 sources + 5 types), each of which
// planned its own pass over multi-million-row financial_relationships (counts
// over common relationship_type values plan seq scans — FIX-345). NOTE:
// `source` is a metadata JSONB key, NOT a column — the prior PostgREST
// `.eq("source", …)` loop silently printed a 42703 error per source, so this
// also restores the source axis. grouping() flags disambiguate "grouped by
// source, type collapsed" from a genuine NULL source value.
type AxisRow = {
  source: string | null;
  relationship_type: string | null;
  n: string;
  g_source: number;
  g_type: number;
};
const FR_AXIS_SQL = `
  SELECT metadata->>'source' AS source, relationship_type, count(*) AS n,
         grouping(metadata->>'source') AS g_source,
         grouping(relationship_type)   AS g_type
    FROM financial_relationships
   GROUP BY GROUPING SETS ((metadata->>'source'), (relationship_type))
   ORDER BY 1 NULLS LAST, 2 NULLS LAST`;

async function main(): Promise<void> {
  const db = createAdminClient();
  console.log(`Run window: ${RUN_START} → now`);

  console.log("\n=== data_sync_log rows for this run window ===");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from("data_sync_log")
    .select("pipeline, status, started_at, completed_at, rows_inserted, rows_updated, rows_failed, error_message, metadata")
    .gte("started_at", RUN_START)
    .order("started_at", { ascending: true });
  if (error) {
    console.error("query failed:", error.message);
  } else {
    for (const r of (data ?? [])) {
      const dur = r.completed_at && r.started_at ? ((new Date(r.completed_at).getTime() - new Date(r.started_at).getTime()) / 1000).toFixed(1) + "s" : "open";
      const rss = (r.metadata as { peak_rss_mb?: number } | null | undefined)?.peak_rss_mb ?? "-";
      console.log(`  ${r.started_at} | ${(r.pipeline as string).padEnd(28)} | ${(r.status as string).padEnd(10)} | dur=${dur.padStart(8)} | ins=${r.rows_inserted} upd=${r.rows_updated} fail=${r.rows_failed} | rss_peak=${rss}MB${r.error_message ? " | ERR: " + (r.error_message as string).slice(0, 120) : ""}`);
    }
  }

  console.log("\n=== pipeline_state.cron_last_run ===");
  {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: ps } = await (db as any)
      .from("pipeline_state")
      .select("key, value, updated_at")
      .eq("key", "cron_last_run")
      .maybeSingle();
    if (!ps) console.log("  (no row)");
    else {
      console.log("  updated_at:", ps.updated_at);
      console.log(JSON.stringify(ps.value, null, 2));
    }
  }

  console.log("\n=== pipeline_state — FEC + IRS990 + USASpending watermarks ===");
  {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // reads-ok: post-run report extract — empty pipeline_state renders visibly in the JSON report
    const { data } = await (db as any)
      .from("pipeline_state")
      .select("key, value, updated_at");
    for (const r of (data ?? [])) console.log(" ", r.key, "|", r.updated_at, "|", typeof r.value === "string" ? r.value.slice(0, 120) : JSON.stringify(r.value).slice(0, 200));
  }

  console.log("\n=== financial_relationships by source + relationship_type (post-halt) ===");
  try {
    const rows = await selectDirect<AxisRow>(FR_AXIS_SQL);
    for (const r of rows.filter((r) => r.g_source === 0)) {
      console.log(`  source=${(r.source ?? "(null)").padEnd(35)} count=${r.n}`);
    }
    for (const r of rows.filter((r) => r.g_type === 0)) {
      console.log(`  type=${(r.relationship_type ?? "(null)").padEnd(15)}  count=${r.n}`);
    }
  } catch (e) {
    console.error("  FR axis breakdown failed:", e instanceof Error ? e.message : String(e));
  }

  console.log("\n=== entity_connections totals ===");
  {
    // FIX-511: order-of-magnitude display — planner estimate instead of an
    // exact full count over the multi-million-row table.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { count } = await (db as any).from("entity_connections").select("id", { count: "estimated", head: true });
    console.log(`  total (estimated): ${count}`);
  }

  console.log("\n=== refreshed MV freshness — row counts ===");
  for (const m of [
    "chord_industry_flows_mv",
    "chord_donor_type_party_flows_mv",
    "chord_donor_state_party_flows_mv",
    "chord_subject_party_flows_mv",
    "official_sector_dollars_mv",
    "homepage_stats_mv",
    "official_homepage_stats_mv",
    "pipeline_runtime_stats_mv",
    "proposal_trending_24h",
    "proposal_popularity_24h",
  ]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { count, error: e2 } = await (db as any).from(m).select("*", { count: "exact", head: true });
    console.log(`  ${m.padEnd(40)} rows=${count ?? "err: " + (e2?.message ?? "?")}`);
  }

  setTimeout(() => process.exit(0), 250);
}

main().catch((e) => {
  console.error("extract failed:", e instanceof Error ? e.message : String(e));
  setTimeout(() => process.exit(1), 250);
});
