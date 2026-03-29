/**
 * PAC Industry Classification pipeline.
 *
 * Classifies financial_entities with entity_type 'pac' or 'party_committee'
 * by matching their names against industry keyword lists. Stores the result
 * in metadata->>'industry_category'.
 *
 * Run standalone:
 *   pnpm --filter @civitics/data data:pac-classify
 */

import { createAdminClient } from "@civitics/db";

// ---------------------------------------------------------------------------
// Keyword map
// ---------------------------------------------------------------------------

const INDUSTRY_KEYWORDS: Record<string, string[]> = {
  Finance: [
    "bank", "financial", "capital", "investment", "securities",
    "credit union", "mortgage", "insurance", "wall street",
    "asset management",
  ],
  "Real Estate": [
    "realtor", "realtors", "real estate", "housing", "homebuilder",
    "apartment", "multifamily", "property",
  ],
  Energy: [
    "gas", "oil", "energy", "petroleum", "coal", "electric", "utility",
    "utilities", "pipeline", "nuclear", "solar", "wind",
    "chevron", "exxon", "shell",
  ],
  Healthcare: [
    "health", "medical", "hospital", "physician", "doctor", "pharma",
    "drug", "dental", "nurse", "biotech", "medicare", "clinic",
  ],
  Defense: [
    "defense", "military", "aerospace", "veteran", "army", "navy",
    "lockheed", "boeing", "raytheon", "northrop", "general dynamics",
  ],
  Tech: [
    "technology", "tech", "software", "internet", "digital", "data",
    "cyber", "telecom", "wireless", "broadband", "semiconductor",
  ],
  Agriculture: [
    "farm", "farmer", "agriculture", "agri", "crop", "grain", "cotton",
    "rice", "dairy", "livestock", "beef", "pork", "poultry", "seed",
  ],
  Transportation: [
    "transport", "auto", "automobile", "dealer", "truck", "airline",
    "aviation", "railroad", "shipping", "maritime", "transit",
  ],
  Legal: [
    "attorney", "lawyer", "legal", "trial", "litigation", "law firm",
    "justice", "association of trial",
  ],
  Education: [
    "education", "school", "college", "university", "teacher", "faculty",
    "student loan", "learning",
  ],
  Labor: [
    "union", "workers", "labor", "teamster", "employee", "seiu",
    "afl", "cio", "brotherhood", "federation of teachers",
    "firefighter", "police",
  ],
  Construction: [
    "construction", "builder", "contractor", "engineer",
    "infrastructure", "cement", "steel", "lumber", "plumber",
    "electrician",
  ],
  Retail: [
    "retail", "store", "restaurant", "food service", "grocery",
    "franchise", "hospitality", "hotel", "tourism",
  ],
};

// ---------------------------------------------------------------------------
// Classify
// ---------------------------------------------------------------------------

function classifyPac(name: string): string {
  const lower = name.toLowerCase();

  for (const [industry, keywords] of Object.entries(INDUSTRY_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      return industry;
    }
  }

  if (
    lower.includes("democrat") ||
    lower.includes("republican") ||
    lower.includes("gop") ||
    lower.includes("dccc") ||
    lower.includes("nrcc") ||
    lower.includes("dscc") ||
    lower.includes("nrsc")
  ) {
    return "Party Committee";
  }

  return "Other";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("[pac-classify] Starting PAC classification pipeline…");

  const supabase = createAdminClient();

  const { data: entities, error } = await supabase
    .from("financial_entities")
    .select("id, name, entity_type, metadata")
    .in("entity_type", ["pac", "party_committee"]);

  if (error) {
    console.error("[pac-classify] Failed to fetch entities:", error.message);
    process.exit(1);
  }

  if (!entities || entities.length === 0) {
    console.log("[pac-classify] No PAC/party_committee entities found.");
    return;
  }

  console.log(`[pac-classify] Classifying ${entities.length} entities…`);

  const industryCount: Record<string, number> = {};

  // Classify all entities
  const updates = entities.map((entity) => {
    const industry = classifyPac(entity.name as string);
    industryCount[industry] = (industryCount[industry] ?? 0) + 1;
    return {
      id: entity.id as string,
      industry,
      // Merge industry_category into existing metadata (preserve other fields)
      metadata: {
        ...((entity.metadata as Record<string, unknown>) ?? {}),
        industry_category: industry,
      },
    };
  });

  // Batch update in groups of 100
  const BATCH_SIZE = 100;
  let processed = 0;
  let errors = 0;

  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = updates.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(({ id, metadata }) =>
        supabase
          .from("financial_entities")
          .update({ metadata })
          .eq("id", id)
      )
    );

    for (const result of results) {
      if (result.status === "rejected") {
        errors++;
      } else if (result.value.error) {
        errors++;
        console.error("[pac-classify] Row error:", result.value.error.message);
      } else {
        processed++;
      }
    }

    console.log(
      `[pac-classify] Progress: ${Math.min(i + BATCH_SIZE, updates.length)}/${updates.length}`
    );
  }

  console.log(`\n[pac-classify] Classified ${processed} PACs (${errors} errors)`);
  console.log("[pac-classify] Industry breakdown:");

  const sorted = Object.entries(industryCount).sort(([, a], [, b]) => b - a);
  for (const [industry, count] of sorted) {
    console.log(`  ${industry.padEnd(20)} ${count}`);
  }
}

main().catch((err) => {
  console.error("[pac-classify] Fatal error:", err);
  process.exit(1);
});
