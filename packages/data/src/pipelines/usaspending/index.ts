/**
 * USASpending.gov pipeline.
 *
 * No API key required.
 *
 * Fetches the top 100 awards over $1M for each of the top 20 federal
 * agencies in fiscal year 2024 and upserts them into spending_records.
 *
 * Storage target: ~100 MB
 * Rate limit:     Conservative — 500ms delay between calls
 *
 * Run standalone:
 *   pnpm --filter @civitics/data data:usaspending
 */

import { createAdminClient } from "@civitics/db";
import type { Database } from "@civitics/db";
import { sleep, postJson } from "../utils";
import { startSync, completeSync, failSync, getDbSizeMb, type PipelineResult } from "../sync-log";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SpendingInsert = Database["public"]["Tables"]["spending_records"]["Insert"];

interface AwardResult {
  "Award ID":                          string | null;
  "Recipient Name":                    string | null;
  "Award Amount":                      number | null;
  "Award Type":                        string | null;
  "Action Date":                       string | null;
  "Awarding Agency":                   string | null;
  "Description":                       string | null;
  "Place of Performance State Code":   string | null;
  "Period of Performance Start Date":  string | null;
  "Period of Performance Current End Date": string | null;
  "NAICS Code":                        string | null;
  "CFDA Number":                       string | null;
}

interface AwardSearchResponse {
  results: AwardResult[];
  page_metadata: { total: number; page: number; limit: number; next?: string };
}

// ---------------------------------------------------------------------------
// Top 20 agencies (toptier name + toptier code for matching agencies table)
// ---------------------------------------------------------------------------

const TOP_AGENCIES: Array<{ name: string; acronym: string }> = [
  { name: "Department of Defense",                    acronym: "DOD"   },
  { name: "Department of Health and Human Services",  acronym: "HHS"   },
  { name: "Department of Energy",                     acronym: "DOE"   },
  { name: "National Aeronautics and Space Administration", acronym: "NASA" },
  { name: "Department of Transportation",             acronym: "DOT"   },
  { name: "Department of Agriculture",                acronym: "USDA"  },
  { name: "Department of Justice",                    acronym: "DOJ"   },
  { name: "Department of Homeland Security",          acronym: "DHS"   },
  { name: "Department of Veterans Affairs",           acronym: "VA"    },
  { name: "Department of Commerce",                   acronym: "DOC"   },
  { name: "Department of the Treasury",               acronym: "TREAS" },
  { name: "Department of State",                      acronym: "DOS"   },
  { name: "Environmental Protection Agency",          acronym: "EPA"   },
  { name: "Department of the Interior",               acronym: "DOI"   },
  { name: "Department of Labor",                      acronym: "DOL"   },
  { name: "Department of Education",                  acronym: "ED"    },
  { name: "Department of Housing and Urban Development", acronym: "HUD" },
  { name: "Small Business Administration",            acronym: "SBA"   },
  { name: "General Services Administration",          acronym: "GSA"   },
  { name: "Social Security Administration",           acronym: "SSA"   },
];

// FY2024: Oct 1 2023 → Sep 30 2024
const FY_START = "2023-10-01";
const FY_END   = "2024-09-30";

const USA_BASE = "https://api.usaspending.gov/api/v2";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function searchAwards(agencyName: string): Promise<AwardResult[]> {
  await sleep(500);
  const body = {
    subawards: false,
    filters: {
      time_period:      [{ start_date: FY_START, end_date: FY_END }],
      award_type_codes: ["A", "B", "C", "D"],   // procurement contracts only
      agencies:         [{ type: "awarding", tier: "toptier", name: agencyName }],
      award_amounts:    [{ lower_bound: 1_000_000 }],
    },
    fields: [
      "Award ID", "Recipient Name", "Award Amount", "Award Type",
      "Action Date", "Awarding Agency", "Description",
      "Place of Performance State Code",
      "Period of Performance Start Date",
      "Period of Performance Current End Date",
      "NAICS Code", "CFDA Number",
    ],
    sort:  "Award Amount",
    order: "desc",
    limit: 100,
    page:  1,
  };

  const data = await postJson<AwardSearchResponse>(
    `${USA_BASE}/search/spending_by_award/`,
    body,
    {},
    1
  );
  return data.results ?? [];
}

function toDate(s: string | null): string | null {
  if (!s) return null;
  try { return new Date(s).toISOString().split("T")[0]!; } catch { return null; }
}

function dollarsToCents(amount: number | null): number {
  return Math.round((amount ?? 0) * 100);
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export async function runUsaSpendingPipeline(federalId: string): Promise<PipelineResult> {
  console.log("\n=== USASpending.gov pipeline ===");
  const logId = await startSync("usaspending");
  const db = createAdminClient();
  let inserted = 0, updated = 0, failed = 0;

  const STORAGE_BUDGET_MB = 100;

  try {
    // Pre-load state jurisdiction map for recipient_location linking
    const { data: stateJurisdictions } = await db
      .from("jurisdictions")
      .select("id, short_name")
      .eq("type", "state")
      .not("short_name", "is", null);

    const stateMap = new Map<string, string>();
    for (const j of stateJurisdictions ?? []) {
      if (j.short_name) stateMap.set(j.short_name, j.id as string);
    }

    for (const agency of TOP_AGENCIES) {
      // Check storage budget
      const dbMb = await getDbSizeMb();
      if (dbMb > 200 + STORAGE_BUDGET_MB) {
        console.log(`  Storage budget reached (${dbMb} MB). Stopping USASpending pipeline.`);
        break;
      }

      console.log(`  Fetching awards for ${agency.acronym}...`);

      let awards: AwardResult[] = [];
      try {
        awards = await searchAwards(agency.name);
        console.log(`    Got ${awards.length} awards`);
      } catch (err) {
        console.error(`    ${agency.acronym}: fetch error —`, err instanceof Error ? err.message : err);
        failed++;
        continue;
      }

      for (const award of awards) {
        if (!award["Recipient Name"] || !award["Award Amount"]) continue;

        const awardId = award["Award ID"];
        const stateCode = award["Place of Performance State Code"];

        const record: SpendingInsert = {
          jurisdiction_id:                  federalId,
          awarding_agency:                  award["Awarding Agency"] ?? agency.name,
          recipient_name:                   (award["Recipient Name"] ?? "").slice(0, 500),
          award_type:                       award["Award Type"] ?? null,
          amount_cents:                     dollarsToCents(award["Award Amount"]),
          total_amount_cents:               dollarsToCents(award["Award Amount"]),
          award_date:                       toDate(award["Action Date"]),
          period_of_performance_start:      toDate(award["Period of Performance Start Date"]),
          period_of_performance_end:        toDate(award["Period of Performance Current End Date"]),
          usaspending_award_id:             awardId ?? null,
          naics_code:                       award["NAICS Code"] ?? null,
          cfda_number:                      award["CFDA Number"] ?? null,
          description:                      (award["Description"] ?? "").slice(0, 500) || null,
          recipient_location_jurisdiction_id: stateCode ? (stateMap.get(stateCode) ?? null) : null,
          source_ids: { usaspending_award_id: awardId ?? "", agency_acronym: agency.acronym },
          metadata:   { fiscal_year: 2024, agency_acronym: agency.acronym },
        };

        try {
          if (awardId) {
            const { data: existing } = await db
              .from("spending_records")
              .select("id")
              .eq("usaspending_award_id", awardId)
              .maybeSingle();

            if (existing) {
              const { error } = await db
                .from("spending_records")
                .update({ amount_cents: record.amount_cents, updated_at: new Date().toISOString() })
                .eq("id", existing.id);
              if (error) { failed++; } else { updated++; }
              continue;
            }
          }

          const { error } = await db.from("spending_records").insert(record);
          if (error) {
            console.error(`    Award ${awardId}: insert error — ${error.message}`);
            failed++;
          } else {
            inserted++;
          }
        } catch (err) {
          console.error(`    Award ${awardId}: unexpected error —`, err);
          failed++;
        }
      }

      console.log(`    ${agency.acronym}: inserted ${inserted} total so far`);
    }

    const estimatedMb = +((inserted + updated) * 600 / 1024 / 1024).toFixed(2);
    const result: PipelineResult = { inserted, updated, failed, estimatedMb };

    console.log(`  Done — inserted: ${inserted}, updated: ${updated}, failed: ${failed}`);
    console.log(`  Estimated storage: ~${estimatedMb} MB`);

    await completeSync(logId, result);
    return result;

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("  USASpending pipeline fatal error:", msg);
    await failSync(logId, msg);
    return { inserted, updated, failed, estimatedMb: 0 };
  }
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const { seedJurisdictions } = require("../../jurisdictions/us-states");
  const db = createAdminClient();

  (async () => {
    const { federalId } = await seedJurisdictions(db);
    await runUsaSpendingPipeline(federalId);
  })()
    .then(() => { setTimeout(() => process.exit(0), 500); })
    .catch((err) => {
      console.error("Pipeline failed:", err);
      setTimeout(() => process.exit(1), 500);
    });
}
