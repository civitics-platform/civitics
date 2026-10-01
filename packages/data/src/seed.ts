/**
 * Master seed script — runs all Congress.gov ingestion pipelines in order.
 *
 * Usage:  pnpm --filter @civitics/data data:seed
 *
 * Required environment variables (in .env.local):
 *   CONGRESS_API_KEY
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SECRET_KEY
 */

import { createAdminClient } from "@civitics/db";
import { seedJurisdictions, seedGoverningBodies } from "./jurisdictions/us-states";
import { runOfficialsPipeline } from "./pipelines/congress/officials";
import { runVotesPipeline } from "./pipelines/congress/votes";

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(
      `\nFatal: Required environment variable "${name}" is not set.` +
        "\nAdd it to .env.local and re-run.\n"
    );
    process.exit(1);
  }
  return val;
}

// Check all required vars upfront before doing any work
requireEnv("CONGRESS_API_KEY");
requireEnv("NEXT_PUBLIC_SUPABASE_URL");
requireEnv("SUPABASE_SECRET_KEY");

const apiKey = process.env["CONGRESS_API_KEY"] as string;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.info("===================================");
  console.info("  Civitics Data Seed");
  console.info("  Congress.gov Pipeline");
  console.info("===================================");
  console.info();

  const db = createAdminClient();

  // [1/4] Jurisdictions
  console.info("[1/4] Seeding jurisdictions...");
  const { federalId, stateIds } = await seedJurisdictions(db);
  const jurisdictionCount = stateIds.size + 1; // states/DC + federal
  console.info(
    `  → Seeded ${jurisdictionCount} jurisdictions (50 states + DC + federal)`
  );
  console.info();

  // [2/4] Governing bodies
  console.info("[2/4] Seeding governing bodies...");
  const { senateId, houseId } = await seedGoverningBodies(db, federalId);
  console.info(`  → US Senate ID: ${senateId}`);
  console.info(`  → US House ID:  ${houseId}`);
  console.info();

  // [3/4] Officials
  console.info("[3/4] Running officials pipeline...");
  const officialsResult = await runOfficialsPipeline({
    apiKey,
    stateIds,
    senateId,
    houseId,
    federalId,
  });
  console.info(
    `  Inserted ${officialsResult.inserted}, Updated ${officialsResult.updated} officials`
  );
  console.info();

  // [4/4] Votes
  console.info("[4/4] Running votes pipeline...");
  const votesResult = await runVotesPipeline({
    apiKey,
    federalId,
    senateGovBodyId: senateId,
    houseGovBodyId: houseId,
  });
  console.info();

  // Summary
  console.info("===================================");
  console.info("  Seed complete!");
  console.info(`  Jurisdictions: ${jurisdictionCount}`);
  console.info(
    `  Officials: ${officialsResult.inserted} inserted, ${officialsResult.updated} updated`
  );
  console.info(`  Proposals: ${votesResult.proposalsUpserted} upserted`);
  console.info(`  Votes: ${votesResult.votesInserted} inserted`);
  console.info("===================================");
}

main().catch((err) => {
  console.error("\nFatal error during seed:", err);
  process.exit(1);
});
