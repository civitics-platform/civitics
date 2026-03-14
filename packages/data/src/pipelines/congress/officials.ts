/**
 * Congress.gov officials pipeline.
 *
 * Fetches all current members of Congress and upserts them into the officials
 * table. Uses a single pre-fetch of existing records to avoid N+1 queries.
 *
 * Run standalone:  pnpm --filter @civitics/data data:officials
 */

import { createAdminClient } from "@civitics/db";
import type { Database } from "@civitics/db";
import {
  fetchAllMembers,
  parseMemberName,
  mapParty,
  CURRENT_CONGRESS,
} from "./members";

type OfficialInsert = Database["public"]["Tables"]["officials"]["Insert"];

export interface OfficialsPipelineOptions {
  apiKey: string;
  stateIds: Map<string, string>;
  senateId: string;
  houseId: string;
  federalId: string;
}

export interface OfficialsPipelineResult {
  inserted: number;
  updated: number;
  skipped: number;
}

/**
 * Fetch all current members and upsert them into the officials table.
 *
 * Strategy:
 *  1. Pre-fetch all existing officials that have a congress_gov source_id.
 *  2. Build a bioguideId → existing record ID map.
 *  3. For each member: update if known, insert (in batches of 50) if new.
 */
export async function runOfficialsPipeline(
  options: OfficialsPipelineOptions
): Promise<OfficialsPipelineResult> {
  const { apiKey, stateIds, senateId, houseId, federalId } = options;

  console.log("Starting Congress.gov officials pipeline...");

  // --- Fetch members from Congress.gov ---
  const members = await fetchAllMembers(apiKey);
  console.log(`Fetched ${members.length} members from Congress.gov`);

  // --- Pre-fetch existing officials with a congress_gov source_id ---
  const db = createAdminClient();

  let existingMap = new Map<string, string>(); // bioguideId → official UUID

  try {
    const { data: existingOfficials, error } = await db
      .from("officials")
      .select("id, source_ids")
      .not("source_ids->>congress_gov", "is", null);

    if (error) {
      console.error("Error fetching existing officials:", error);
      // Continue — we'll treat everything as new
    } else if (existingOfficials) {
      for (const row of existingOfficials) {
        const sourceIds = row.source_ids as Record<string, string> | null;
        if (sourceIds?.congress_gov) {
          existingMap.set(sourceIds.congress_gov, row.id);
        }
      }
      console.log(
        `Found ${existingMap.size} existing officials with Congress.gov IDs`
      );
    }
  } catch (err) {
    console.error("Unexpected error fetching existing officials:", err);
  }

  // --- Process members ---
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  // Collect inserts; flush in batches of 50
  const insertBatch: OfficialInsert[] = [];

  const flushInserts = async () => {
    if (insertBatch.length === 0) return;

    const batch = insertBatch.splice(0, insertBatch.length);

    try {
      const { error } = await db.from("officials").insert(batch);

      if (error) {
        console.error(
          `  Error inserting batch of ${batch.length} officials:`,
          error
        );
        skipped += batch.length;
      } else {
        inserted += batch.length;
      }
    } catch (err) {
      console.error(`  Unexpected error inserting batch:`, err);
      skipped += batch.length;
    }
  };

  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    if (!member) continue;

    const { firstName, lastName, fullName } = parseMemberName(member.name);
    const party = mapParty(member.partyName);
    // chamber is absent on some API responses; fall back to last term's chamber
    const chamber =
      member.chamber ??
      member.terms?.item?.slice(-1)[0]?.chamber ??
      "";
    const isSenator = chamber.toLowerCase().includes("senate");

    // Resolve jurisdiction: fall back to federal for DC, territories, etc.
    const jurisdictionId = stateIds.get(member.state) ?? federalId;
    const governingBodyId = isSenator ? senateId : houseId;

    // Determine term dates from last item in terms array
    const termItems = member.terms?.item ?? [];
    const lastTerm = termItems[termItems.length - 1];
    const startYear = lastTerm?.startYear;
    const termStart = startYear ? `${startYear}-01-03` : null;
    // Representatives end 2027-01-03 (119th Congress); Senators end varies
    const termEnd = isSenator ? null : "2027-01-03";

    const officialData: OfficialInsert = {
      full_name: fullName,
      first_name: firstName,
      last_name: lastName,
      role_title: isSenator ? "Senator" : "Representative",
      governing_body_id: governingBodyId,
      jurisdiction_id: jurisdictionId,
      // mapParty returns values that match the DB enum — cast is safe
      party: party as OfficialInsert["party"],
      district_name:
        member.district != null ? `District ${member.district}` : null,
      photo_url: member.depiction?.imageUrl ?? null,
      term_start: termStart,
      term_end: termEnd,
      is_active: true,
      is_verified: false,
      website_url: `https://www.congress.gov/member/${member.bioguideId}`,
      source_ids: { congress_gov: member.bioguideId },
      metadata: {},
    };

    const existingId = existingMap.get(member.bioguideId);

    if (existingId) {
      // Update existing record
      try {
        const { error } = await db
          .from("officials")
          .update(officialData)
          .eq("id", existingId);

        if (error) {
          console.error(
            `  Error updating official ${member.bioguideId}:`,
            error
          );
          skipped++;
        } else {
          updated++;
        }
      } catch (err) {
        console.error(
          `  Unexpected error updating official ${member.bioguideId}:`,
          err
        );
        skipped++;
      }
    } else {
      // Queue for batch insert
      insertBatch.push(officialData);

      // Flush every 50
      if (insertBatch.length >= 50) {
        await flushInserts();
      }
    }
  }

  // Flush any remaining inserts
  await flushInserts();

  console.log(`Inserted ${inserted}, Updated ${updated} officials`);
  if (skipped > 0) {
    console.log(`Skipped ${skipped} officials due to errors`);
  }

  return { inserted, updated, skipped };
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const apiKey = process.env["CONGRESS_API_KEY"];
  if (!apiKey) {
    console.error(
      "Error: CONGRESS_API_KEY environment variable is not set.\n" +
        "Add it to .env.local and re-run."
    );
    process.exit(1);
  }

  // When run standalone we need jurisdiction/governing body IDs.
  // Import and run the jurisdiction seed first.
  const { seedJurisdictions, seedGoverningBodies } = require("../../jurisdictions/us-states");
  const db = createAdminClient();

  (async () => {
    try {
      const { federalId, stateIds } = await seedJurisdictions(db);
      const { senateId, houseId } = await seedGoverningBodies(db, federalId);

      const result = await runOfficialsPipeline({
        apiKey,
        stateIds,
        senateId,
        houseId,
        federalId,
      });

      console.log("Officials pipeline complete:", result);
      process.exit(0);
    } catch (err) {
      console.error("Fatal error:", err);
      process.exit(1);
    }
  })();
}

// Suppress unused import warning — CURRENT_CONGRESS is re-exported for
// convenience when this module is imported by other pipelines.
export { CURRENT_CONGRESS };
