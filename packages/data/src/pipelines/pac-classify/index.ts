/**
 * PAC Sector Classification pipeline.
 *
 * Classifies financial_relationships rows where donor_type = 'pac'
 * by matching donor_name + industry against keyword lists.
 * Stores the result in metadata->>'sector'.
 *
 * Safe to re-run — overwrites existing sector values.
 *
 * Run standalone:
 *   pnpm --filter @civitics/data data:pac-classify
 */

import { createAdminClient } from "@civitics/db";

// ---------------------------------------------------------------------------
// Keyword map
// ---------------------------------------------------------------------------

const SECTOR_KEYWORDS: Record<string, string[]> = {
  Labor: [
    "union", "workers", "labor", "teamster", "brotherhood",
    "seiu", "afl", "cio", "machinists", "carpenters",
    "electricians", "plumbers", "steamfitters", "firefighter",
    "police", "teachers", "federation of teachers", "sheet metal",
    "laborers", "longshoremen", "ironworkers", "painters",
    "bricklayers", "operating engineers",
    "air line pilots", "pilots association", "flight attendant", "air traffic",
  ],
  Finance: [
    "bank", "financial", "capital", "investment", "securities",
    "credit union", "mortgage", "insurance", "wall street",
    "asset management", "fund", "equity", "venture", "ubs",
    "goldman", "morgan", "citi", "jpmorgan", "blackstone",
    "accounting", "accountants", "cpa", "actuari",
    "bankers", "brokers", "traders", "exchange",
    "lending", "loans", "commercial", "advisors",
  ],
  "Real Estate": [
    "realtor", "realtors", "real estate", "housing", "homebuilder",
    "home builder", "apartment", "multifamily", "property",
    "mortgage", "home depot", "lowe's",
    "builders", "developers", "development", "properties",
    "commercial real",
  ],
  Energy: [
    "gas", "oil", "energy", "petroleum", "coal", "electric",
    "utility", "utilities", "pipeline", "nuclear", "solar", "wind",
    "chevron", "exxon", "shell", "bp", "refin", "mining", "crystal sugar",
  ],
  Healthcare: [
    "health", "medical", "hospital", "physician", "doctor", "pharma",
    "drug", "dental", "nurse", "biotech", "medicare", "clinic",
    "surgeons", "psychiatr", "chiropractic", "optometr",
    "veterinar", "hospice",
  ],
  Defense: [
    "defense", "military", "aerospace", "veteran", "lockheed",
    "boeing", "raytheon", "northrop", "general dynamics", "l3",
    "leidos", "saic", "caci",
  ],
  Tech: [
    "technology", "tech", "software", "internet", "digital", "cyber",
    "telecom", "wireless", "broadband", "semiconductor",
    "microsoft", "google", "amazon", "apple", "meta",
    "ibm", "oracle", "intel",
    "comcast", "nbcuniversal", "charter communications", "cable", "media",
    "broadcast", "at&t", "verizon", "sprint", "t-mobile",
  ],
  Agriculture: [
    "farm", "farmer", "agriculture", "agri", "crop", "grain",
    "cotton", "rice", "dairy", "livestock", "beef", "pork",
    "poultry", "seed", "sugar", "soybean", "corn", "wheat",
    "tobacco", "nursery",
    "john deere", "deere", "caterpillar", "cnh", "agco",
    "pioneer", "monsanto", "bayer crop", "syngenta",
  ],
  Transportation: [
    "transport", "automobile", "auto dealers", "truck", "airline",
    "aviation", "railroad", "shipping", "maritime", "transit",
    "uber", "lyft", "fedex", "ups", "freight",
  ],
  Legal: [
    "attorney", "lawyer", "legal", "trial", "litigation",
    "law firm", "justice", "association of trial", "plaintiff",
  ],
  Education: [
    "education", "school", "college", "university", "teacher",
    "faculty", "student loan", "learning", "academic",
  ],
  Construction: [
    "construction", "builder", "contractor", "engineer",
    "infrastructure", "cement", "steel", "lumber", "plumber",
    "electrician", "mason", "roofing", "flooring",
    "stone", "sand", "gravel", "aggregate", "quarry",
    "minerals", "rockpac", "concrete",
  ],
  "Retail & Food": [
    "retail", "restaurant", "food service", "grocery", "franchise",
    "hospitality", "hotel", "tourism", "beverage", "alcohol",
    "beer", "wine", "spirits", "supermarket",
  ],
  "Party Committee": [
    "democrat", "republican", "gop", "dccc", "nrcc",
    "dscc", "nrsc", "dlcc", "victory fund", "pac fund",
    "liberty fund", "freedom fund", "leadership pac",
    "liberty pac", "opportunity pac", "progress pac",
    "future pac", "majority pac", "bold pac",
    "collective pac", "country pac",
    "caucus", "committee", "congressional",
    "senate victory", "house victory",
  ],
};

// ---------------------------------------------------------------------------
// Classify
// ---------------------------------------------------------------------------

function classifySector(donorName: string, industryField: string | null): string {
  const text = [donorName, industryField ?? ""].join(" ").toLowerCase();

  for (const [sector, keywords] of Object.entries(SECTOR_KEYWORDS)) {
    if (keywords.some((kw) => text.includes(kw.toLowerCase()))) {
      return sector;
    }
  }
  return "Other";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n=== PAC Classification ===");

  const supabase = createAdminClient();

  const FETCH_BATCH  = 1000;
  const UPDATE_BATCH = 500;

  let offset      = 0;
  let total       = 0;
  let classified  = 0;
  let unclassified = 0;
  const sectorCount: Record<string, number> = {};

  while (true) {
    const { data: rows, error } = await supabase
      .from("financial_relationships")
      .select("id, donor_name, industry, metadata")
      .eq("donor_type", "pac")
      .not("donor_name", "is", null)
      .range(offset, offset + FETCH_BATCH - 1);

    if (error) {
      console.error("Fetch error:", error.message);
      process.exit(1);
    }

    if (!rows || rows.length === 0) break;

    total += rows.length;

    // Classify all rows in this batch
    const updates = rows.map((row) => {
      const sector = classifySector(
        row.donor_name as string,
        row.industry as string | null
      );
      sectorCount[sector] = (sectorCount[sector] ?? 0) + 1;
      if (sector === "Other") unclassified++;
      else classified++;

      return {
        id: row.id as string,
        metadata: {
          ...((row.metadata as Record<string, unknown>) ?? {}),
          sector,
        },
      };
    });

    // Batch update in groups of UPDATE_BATCH (parallel within each group)
    for (let i = 0; i < updates.length; i += UPDATE_BATCH) {
      const batch = updates.slice(i, i + UPDATE_BATCH);
      await Promise.all(
        batch.map(({ id, metadata }) =>
          supabase
            .from("financial_relationships")
            .update({ metadata })
            .eq("id", id)
        )
      );
    }

    console.log(`  Processed: ${total}`);

    if (rows.length < FETCH_BATCH) break;
    offset += FETCH_BATCH;
  }

  console.log(`\nTotal PACs:           ${total.toLocaleString()}`);
  console.log(`Classified:           ${classified.toLocaleString()}`);
  console.log(`Unclassified (Other): ${unclassified.toLocaleString()}`);
  console.log("\nSector breakdown:");

  const sorted = Object.entries(sectorCount).sort(([, a], [, b]) => b - a);
  for (const [sector, count] of sorted) {
    const pct = total > 0 ? ((count / total) * 100).toFixed(1) : "0.0";
    console.log(`  ${sector.padEnd(22)} ${count.toLocaleString().padStart(7)} (${pct}%)`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
