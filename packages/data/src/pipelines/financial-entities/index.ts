/**
 * Financial entities migration pipeline.
 *
 * Creates financial_entities records from existing financial_relationships,
 * then re-runs the connections pipeline to derive donation edges.
 *
 * Run after FEC data has been ingested (data:fec-bulk).
 * Safe to run multiple times — upserts on (name, entity_type).
 *
 * Note: financial_relationships does not have a donor_entity_id FK column.
 *       The entity→official mapping is maintained in entity_connections.
 *       To add the FK backlink, a schema migration is needed first.
 *
 * Run standalone:
 *   pnpm --filter @civitics/data data:financial-entities
 */

import { createAdminClient } from "@civitics/db";
import {
  startSync,
  completeSync,
  failSync,
  type PipelineResult,
} from "../sync-log";
import { runConnectionsPipeline } from "../connections";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DonorAggregate {
  donor_name:    string;
  donor_type:    string;
  donor_industry: string | null;
  total_cents:   number;
  officials_funded: number;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runFinancialEntitiesPipeline(): Promise<PipelineResult> {
  console.log("\n=== Financial entities pipeline ===");
  const logId = await startSync("financial-entities");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;

  let created = 0;
  let updated = 0;
  let failed  = 0;

  try {
    // ── 1. Aggregate donors from financial_relationships ──────────────────
    console.log("\n  [1/3] Aggregating donors from financial_relationships...");

    const { data: rows, error: fetchErr } = await db
      .from("financial_relationships")
      .select("donor_name, donor_type, industry, amount_cents, official_id")
      .not("official_id", "is", null);

    if (fetchErr) throw fetchErr;
    if (!rows || rows.length === 0) {
      console.log("  No financial_relationships found. Run data:fec-bulk first.");
      await completeSync(logId, { inserted: 0, updated: 0, failed: 0, estimatedMb: 0 });
      return { inserted: 0, updated: 0, failed: 0, estimatedMb: 0 };
    }

    console.log(`  Loaded ${rows.length} financial_relationship rows`);

    // Aggregate in memory: key = "donor_name|donor_type|industry"
    const aggregates = new Map<string, DonorAggregate>();
    const officialsByKey = new Map<string, Set<string>>();

    for (const row of rows) {
      const name     = String(row.donor_name ?? "").trim().toUpperCase();
      const type     = String(row.donor_type ?? "other");
      const industry = row.industry ? String(row.industry) : null;
      const cents    = Number(row.amount_cents ?? 0);
      const offId    = String(row.official_id);
      const key      = `${name}|${type}|${industry ?? ""}`;

      const agg = aggregates.get(key);
      if (agg) {
        agg.total_cents += cents;
      } else {
        aggregates.set(key, {
          donor_name:      name,
          donor_type:      type,
          donor_industry:  industry,
          total_cents:     cents,
          officials_funded: 0,
        });
        officialsByKey.set(key, new Set());
      }
      officialsByKey.get(key)!.add(offId);
    }

    // Fill officials_funded count
    for (const [key, agg] of aggregates) {
      agg.officials_funded = officialsByKey.get(key)?.size ?? 0;
    }

    console.log(`  ${aggregates.size} unique donors identified`);

    // Print summary table
    console.log("\n  ┌─────────────────────────────────────────────────────────────────────┐");
    console.log("  │ Donor summary                                                       │");
    console.log("  ├──────────────────────────────────┬──────────┬──────────┬────────────┤");
    console.log("  │ Name                             │ Type     │ Officials│ Total ($)  │");
    console.log("  ├──────────────────────────────────┼──────────┼──────────┼────────────┤");
    for (const agg of aggregates.values()) {
      const name = agg.donor_name.slice(0, 32).padEnd(32);
      const type = agg.donor_type.slice(0, 8).padEnd(8);
      const offs = String(agg.officials_funded).padStart(8);
      const amt  = `$${(agg.total_cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`.padStart(10);
      console.log(`  │ ${name} │ ${type} │ ${offs} │ ${amt} │`);
    }
    console.log("  └──────────────────────────────────┴──────────┴──────────┴────────────┘");

    // ── 2. Upsert financial_entities ──────────────────────────────────────
    console.log("\n  [2/3] Upserting financial_entities...");

    for (const agg of aggregates.values()) {
      try {
        const { data: existing } = await db
          .from("financial_entities")
          .select("id, total_donated_cents")
          .eq("name", agg.donor_name)
          .eq("entity_type", agg.donor_type)
          .maybeSingle();

        if (existing) {
          const { error: updErr } = await db
            .from("financial_entities")
            .update({
              industry:             agg.donor_industry,
              total_donated_cents:  agg.total_cents,
              updated_at:           new Date().toISOString(),
            })
            .eq("id", existing.id);

          if (updErr) {
            console.error(`  Update failed for "${agg.donor_name}":`, updErr.message);
            failed++;
          } else {
            updated++;
          }
        } else {
          const { error: insErr } = await db
            .from("financial_entities")
            .insert({
              name:                agg.donor_name,
              entity_type:         agg.donor_type,
              industry:            agg.donor_industry,
              total_donated_cents: agg.total_cents,
              source_ids:          {},
            });

          if (insErr) {
            console.error(`  Insert failed for "${agg.donor_name}":`, insErr.message);
            failed++;
          } else {
            created++;
          }
        }
      } catch (err) {
        console.error("  Upsert threw:", err instanceof Error ? err.message : err);
        failed++;
      }
    }

    console.log(`  Created: ${created}  Updated: ${updated}  Failed: ${failed}`);

    // Note: financial_relationships has no donor_entity_id column.
    // The donor→official mapping is stored in entity_connections (donation edges).
    // To add the FK backlink, a schema migration adding donor_entity_id UUID is needed.
    console.log("\n  NOTE: donor_entity_id FK not set — column does not exist on");
    console.log("        financial_relationships. Relationship stored in entity_connections.");

    // ── 3. Re-run connections pipeline ────────────────────────────────────
    console.log("\n  [3/3] Re-running connections pipeline to derive donation edges...");

    const { data: beforeCount } = await db
      .from("entity_connections")
      .select("id", { count: "exact", head: true })
      .eq("connection_type", "donation");

    await runConnectionsPipeline();

    const { data: afterCount } = await db
      .from("entity_connections")
      .select("id", { count: "exact", head: true })
      .eq("connection_type", "donation");

    // ── Final report ──────────────────────────────────────────────────────
    const { data: feCount } = await db
      .from("financial_entities")
      .select("id", { count: "exact", head: true });

    const { data: totalConnections } = await db
      .from("entity_connections")
      .select("connection_type")
      .then(({ data }: { data: { connection_type: string }[] | null }) => {
        const counts: Record<string, number> = {};
        for (const row of data ?? []) {
          counts[row.connection_type] = (counts[row.connection_type] ?? 0) + 1;
        }
        return { data: counts };
      });

    console.log("\n  ══════════════════════════════════════════════");
    console.log("  Financial entities pipeline — final report");
    console.log("  ══════════════════════════════════════════════");
    console.log(`  financial_entities rows created:   ${created}`);
    console.log(`  financial_entities rows updated:   ${updated}`);
    console.log(`  financial_entities total in DB:    ${(feCount as unknown as { count: number } | null)?.count ?? "?"}`);
    console.log(`  Donation connections before:       ${(beforeCount as unknown as { count: number } | null)?.count ?? "?"}`);
    console.log(`  Donation connections after:        ${(afterCount as unknown as { count: number } | null)?.count ?? "?"}`);
    console.log("\n  entity_connections by type:");
    for (const [type, count] of Object.entries(totalConnections ?? {})) {
      console.log(`    ${type.padEnd(20)} ${count}`);
    }
    console.log("  ══════════════════════════════════════════════");

    const result: PipelineResult = {
      inserted: created,
      updated,
      failed,
      estimatedMb: 0,
    };

    await completeSync(logId, result);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("  Financial entities pipeline fatal error:", msg);
    await failSync(logId, msg);
    return { inserted: 0, updated: 0, failed: failed + 1, estimatedMb: 0 };
  }
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  runFinancialEntitiesPipeline()
    .then(() => { setTimeout(() => process.exit(0), 500); })
    .catch((err) => {
      console.error("Pipeline failed:", err);
      setTimeout(() => process.exit(1), 500);
    });
}
