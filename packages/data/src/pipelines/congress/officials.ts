/**
 * Congress.gov officials pipeline.
 *
 * Fetches all current members of Congress and upserts them into the officials
 * table. Uses a single pre-fetch of existing records to avoid N+1 queries.
 *
 * Run standalone:  pnpm --filter @civitics/data data:officials
 */

import { createAdminClient, refreshPrimarySourceForEntities, selectAllOrThrow } from "@civitics/db";
import type { Database } from "@civitics/db";
import {
  fetchAllMembers,
  parseMemberName,
  mapParty,
  CURRENT_CONGRESS,
} from "./members";
import { startSync, completeSync, failSync } from "../sync-log";
import { runCandidateToElectedPromotion } from "./promote-candidates";
import { runReconcileFormerMembers } from "./reconcile-former-members";

type OfficialInsert = Database["public"]["Tables"]["officials"]["Insert"];

// FIX-403: xsr upsert chunk size — mirrors REFS_CHUNK in littlesis/writer.ts.
// House+Senate is ~565 members, so this is one or two chunks in practice.
const XSR_CHUNK = 500;

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
  const logId = await startSync("congress_officials");

  try {
  // --- Fetch members from Congress.gov ---
  const members = await fetchAllMembers(apiKey);
  console.log(`Fetched ${members.length} members from Congress.gov`);

  // --- Pre-fetch existing officials with a congress_gov source_id ---
  const db = createAdminClient();

  const existingMap = new Map<string, string>(); // bioguideId → official UUID

  // FIX-545: this preload used to log-and-continue ("treat everything as
  // new") on error — i.e. a transient gateway blip would re-INSERT every
  // member as a duplicate. Fail the run instead; paginate while we're here
  // (the congress_gov-bound set grows past 1k as former members accumulate).
  const existingOfficials = await selectAllOrThrow(
    "congress officials preload (congress_gov source_ids)",
    (from, to) => db
      .from("officials")
      .select("id, source_ids")
      .not("source_ids->>congress_gov", "is", null)
      .order("id")
      .range(from, to),
  );
  for (const row of existingOfficials) {
    const sourceIds = row.source_ids as Record<string, string> | null;
    if (sourceIds?.congress_gov) {
      existingMap.set(sourceIds.congress_gov, row.id);
    }
  }
  console.log(
    `Found ${existingMap.size} existing officials with Congress.gov IDs`
  );

  // --- Process members ---
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  // FIX-403: collect (officialId, bioguideId) for every successfully
  // processed member so we can bulk-upsert external_source_refs after the
  // main loop and call refreshPrimarySourceForEntities once per run.
  const processedMembers: Array<{ officialId: string; bioguideId: string }> = [];

  // Collect inserts; flush in batches of 50
  const insertBatch: OfficialInsert[] = [];

  const flushInserts = async () => {
    if (insertBatch.length === 0) return;

    const batch = insertBatch.splice(0, insertBatch.length);

    try {
      const { data, error } = await db
        .from("officials")
        .insert(batch)
        .select("id, source_ids");

      if (error) {
        console.error(
          `  Error inserting batch of ${batch.length} officials:`,
          error
        );
        skipped += batch.length;
      } else {
        inserted += batch.length;
        // FIX-403: capture bioguideId → official.id for the post-loop xsr write.
        for (const row of (data ?? []) as Array<{
          id:         string;
          source_ids: Record<string, string> | null;
        }>) {
          const bioguideId = row.source_ids?.["congress_gov"];
          if (bioguideId) {
            processedMembers.push({ officialId: row.id, bioguideId });
          }
        }
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
      // FIX-409: keep tier in lockstep with is_active. A member present in the
      // feed is, by definition, a sitting elected official — so restore
      // tier='elected' on every upsert. Without this, a member who previously
      // fell out of the feed (flipped to is_active=false, tier='former' by the
      // reconciliation pass) and later returned would be re-activated to
      // is_active=true but stay stuck at tier='former'. Only ever applied to
      // current congress members, so it can never mislabel a candidate row.
      tier: "elected",
      is_verified: false,
      website_url: `https://www.congress.gov/member/${member.bioguideId}`,
      source_ids: { congress_gov: member.bioguideId },
      metadata: {},
    };

    const existingId = existingMap.get(member.bioguideId);

    if (existingId) {
      // FIX-755: omit source_ids from the UPDATE payload. `.update()` replaces
      // the whole jsonb, and this row was matched BY source_ids->>congress_gov,
      // so re-sending `{ congress_gov }` adds nothing while wholesale-stripping
      // every key other writers merged in — promotion's fec_candidate_id
      // (FIX-248) and fec_bulk's weball fec_id persist. That nightly strip made
      // every cn{yy} ingest re-insert ~278 candidate rows for sitting members,
      // and the next nightly re-promote them (~2h of FK rewrites, new UUIDs for
      // most of Congress every week). Insert path below still sets it.
      const updateData = { ...officialData };
      delete updateData.source_ids;
      try {
        const { error } = await db
          .from("officials")
          .update(updateData)
          .eq("id", existingId);

        if (error) {
          console.error(
            `  Error updating official ${member.bioguideId}:`,
            error
          );
          skipped++;
        } else {
          updated++;
          // FIX-403: track for the post-loop xsr write.
          processedMembers.push({
            officialId: existingId,
            bioguideId: member.bioguideId,
          });
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

  // FIX-403: dual-write external_source_refs for every processed member,
  // then materialize primary_source on the affected officials. Runs BEFORE
  // promote-candidates so its FK-rewrite step (which covers external_*)
  // remaps any xsr bindings whose officials get collapsed in the same run.
  if (processedMembers.length > 0) {
    const nowIso = new Date().toISOString();
    let xsrFailed = 0;
    for (let i = 0; i < processedMembers.length; i += XSR_CHUNK) {
      const chunk = processedMembers.slice(i, i + XSR_CHUNK);
      const payload = chunk.map((m) => ({
        source:       "congress_gov",
        external_id:  m.bioguideId,
        entity_type:  "official",
        entity_id:    m.officialId,
        source_url:   `https://www.congress.gov/member/${m.bioguideId}`,
        last_seen_at: nowIso,
        metadata:     {},
      }));
      const { error } = await db
        .from("external_source_refs")
        .upsert(payload, { onConflict: "source,external_id" });
      if (error) {
        console.error(
          `  [xsr] external_source_refs chunk ${i}-${i + chunk.length} failed: ${error.message}`
        );
        xsrFailed += chunk.length;
      }
    }
    if (xsrFailed > 0) {
      console.log(`  [xsr] ${xsrFailed} bindings failed to upsert (non-fatal)`);
    }

    await refreshPrimarySourceForEntities(
      db,
      "official",
      processedMembers.map((m) => m.officialId),
    );
  }

  // FIX-248: unify (Senator|Representative, Candidate for X) pairs that
  // resolve to the same person. Non-fatal — a failure here doesn't void the
  // upstream ingest. The resolver band-aid (sections.ts subtitle filter)
  // stays in place as defense-in-depth.
  try {
    await runCandidateToElectedPromotion({ db });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  promote-candidates step failed (non-fatal): ${msg}`);
  }

  // FIX-409: deactivate members who fell out of the Congress.gov feed —
  // flip them is_active=false, tier='former'. Guarded by a roster-completeness
  // floor (decision #5): a truncated/failed fetch must never mass-deactivate.
  // Non-fatal — a failure here doesn't void the upstream ingest. The normal
  // in-loop path already re-activated every present member, so a returning
  // member is is_active=true again and won't be flagged here.
  try {
    const feedBioguideIds = new Set<string>();
    for (const m of members) {
      if (m?.bioguideId) feedBioguideIds.add(m.bioguideId);
    }
    await runReconcileFormerMembers({
      db,
      feedBioguideIds,
      feedMemberCount: members.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  reconcile-former-members step failed (non-fatal): ${msg}`);
  }

    const estimatedMb = +(((inserted + updated) * 350) / 1024 / 1024).toFixed(2);
    await completeSync(logId, { inserted, updated, failed: skipped, estimatedMb });

    return { inserted, updated, skipped };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failSync(logId, msg);
    throw err;
  }
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
