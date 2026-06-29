/**
 * seed-agency-officials.ts
 *
 * Creates entity_connections rows linking officials to agencies for testing.
 * Uses known Senate committee oversight assignments and revolving-door relationships.
 *
 * Run:
 *   npx tsx scripts/seed-agency-officials.ts
 *
 * Requires:
 *   NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY in your .env.local
 *
 * Safe to re-run — uses ON CONFLICT DO NOTHING via the unique triple constraint.
 */

import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import { resolve } from "path";

dotenv.config({ path: resolve(process.cwd(), "apps/civitics/.env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY!;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------------------------------------------------------------------------
// Seed data — known committee oversight / revolving door relationships
//
// Format: [official_name_fragment, agency_acronym, connection_type, strength]
//   strength: 0.0–1.0 (1.0 = appointed head, 0.7 = committee chair, 0.5 = member)
// ---------------------------------------------------------------------------

type SeedRow = {
  official: string;       // substring matched against full_name (case-insensitive)
  agency: string;         // agency acronym
  type: "appointment" | "oversight" | "revolving_door";
  strength: number;
};

const SEED_CONNECTIONS: SeedRow[] = [
  // Senate Commerce Committee → FAA, FCC, DOT
  { official: "Roger F. Wicker",     agency: "FAA",  type: "oversight",  strength: 0.7 },
  { official: "Roger F. Wicker",     agency: "FCC",  type: "oversight",  strength: 0.7 },
  { official: "Roger F. Wicker",     agency: "DOT",  type: "oversight",  strength: 0.7 },

  // Senate Environment & Public Works → EPA, NOAA
  { official: "Sheldon Whitehouse",  agency: "EPA",  type: "oversight",  strength: 0.7 },
  { official: "Sheldon Whitehouse",  agency: "NOAA", type: "oversight",  strength: 0.6 },
  { official: "Edward J. Markey",    agency: "EPA",  type: "oversight",  strength: 0.6 },
  { official: "Edward J. Markey",    agency: "NOAA", type: "oversight",  strength: 0.6 },

  // Senate Banking Committee → FDIC, SEC, FTC
  { official: "Mike Rounds",         agency: "FDIC", type: "oversight",  strength: 0.7 },
  { official: "Rick Scott",          agency: "FDIC", type: "oversight",  strength: 0.6 },
  { official: "Mark R. Warner",      agency: "SEC",  type: "oversight",  strength: 0.6 },

  // Senate HELP Committee → HHS, OPM, OSHA
  { official: "Markwayne Mullin",    agency: "OPM",  type: "oversight",  strength: 0.7 },
  { official: "Markwayne Mullin",    agency: "OPM",  type: "appointment", strength: 0.5 },
  { official: "Chris Van Hollen",    agency: "HHS",  type: "oversight",  strength: 0.6 },

  // Senate Finance → IRS, Treasury
  { official: "Mike Rounds",         agency: "IRS",  type: "oversight",  strength: 0.5 },
  { official: "Charles E. Schumer",  agency: "IRS",  type: "oversight",  strength: 0.5 },

  // Senate Commerce → FTC
  { official: "Brian Schatz",        agency: "FCC",  type: "oversight",  strength: 0.5 },

  // Senate Intelligence → DOJ
  { official: "Mark R. Warner",      agency: "DOJ",  type: "oversight",  strength: 0.6 },

  // Senate Agriculture → USDA
  { official: "John Thune",          agency: "USDA", type: "oversight",  strength: 0.6 },

  // Senate Energy Committee → DOE
  { official: "Jeanne Shaheen",      agency: "DOE",  type: "oversight",  strength: 0.6 },
  { official: "Brian Schatz",        agency: "DOE",  type: "oversight",  strength: 0.5 },

  // Revolving door examples (reps who previously worked in regulated industries)
  { official: "David Schweikert",    agency: "FAA",  type: "revolving_door", strength: 0.4 },
];

async function run() {
  console.log("Fetching agencies by acronym...");

  const acronyms = [...new Set(SEED_CONNECTIONS.map((r) => r.agency))];
  const { data: agencies, error: agencyErr } = await supabase
    .from("agencies")
    .select("id, acronym")
    .in("acronym", acronyms);

  if (agencyErr || !agencies) {
    console.error("Failed to fetch agencies:", agencyErr?.message);
    process.exit(1);
  }

  const agencyByAcronym = new Map(agencies.map((a) => [a.acronym!, a.id]));
  console.log(`  Found ${agencies.length} matching agencies.`);

  console.log("Fetching officials by name...");

  const officialNames = [...new Set(SEED_CONNECTIONS.map((r) => r.official))];
  const officialIdMap = new Map<string, string>();

  // Look up each name individually (ILIKE)
  for (const name of officialNames) {
    const { data } = await supabase
      .from("officials")
      .select("id, full_name")
      .ilike("full_name", `%${name}%`)
      .limit(1)
      .maybeSingle();

    if (data) {
      officialIdMap.set(name, data.id);
      console.log(`  ✓ Found: ${data.full_name}`);
    } else {
      console.log(`  ⬜ Not found: ${name}`);
    }
  }

  console.log(`\nInserting connections...`);

  let inserted = 0;
  let skipped = 0;

  for (const row of SEED_CONNECTIONS) {
    const officialId = officialIdMap.get(row.official);
    const agencyId = agencyByAcronym.get(row.agency);

    if (!officialId) {
      console.log(`  ⬜ Skip (official not found): ${row.official}`);
      skipped++;
      continue;
    }
    if (!agencyId) {
      console.log(`  ⬜ Skip (agency not found): ${row.agency}`);
      skipped++;
      continue;
    }

    const { error } = await supabase.from("entity_connections").upsert(
      {
        from_type: "official",
        from_id: officialId,
        to_type: "agency",
        to_id: agencyId,
        connection_type: row.type,
        strength: row.strength,
        metadata: { source: "seed-script", seed_version: "v1" },
      },
      { onConflict: "from_id,to_id,connection_type", ignoreDuplicates: true }
    );

    if (error) {
      console.error(`  ✗ ${row.official} → ${row.agency} (${row.type}):`, error.message);
    } else {
      console.log(`  ✓ ${row.official} → ${row.agency} (${row.type})`);
      inserted++;
    }
  }

  console.log(`\nDone. Inserted: ${inserted}, Skipped: ${skipped}`);
  console.log("\nVerify with:");
  console.log("  SELECT ec.connection_type, o.full_name, a.name");
  console.log("  FROM entity_connections ec");
  console.log("  JOIN officials o ON o.id = ec.from_id");
  console.log("  JOIN agencies a ON a.id = ec.to_id");
  console.log("  WHERE ec.from_type = 'official' AND ec.to_type = 'agency';");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
