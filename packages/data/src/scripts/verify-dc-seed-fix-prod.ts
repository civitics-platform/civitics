/**
 * FIX-383 prod verification — calls seedJurisdictions() against prod via the
 * same admin-client path fec_bulk uses. Pre-existing rows mean no inserts;
 * effectively read-only. Asserts DC + 5 territories resolve to canonical ids.
 *
 *   pnpm --filter @civitics/data tsx --env-file=../../.env.local.prod src/scripts/verify-dc-seed-fix-prod.ts
 */

import { createAdminClient } from "@civitics/db";
import { seedJurisdictions } from "../jurisdictions/us-states";

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!/xsazcoxinpgttgquwvuf\.supabase\.co/.test(url)) {
    console.error(`ERROR: expected prod URL, got ${url}`);
    process.exit(2);
  }
  console.log(`target: ${url}`);

  const db = createAdminClient();
  const { federalId, stateIds } = await seedJurisdictions(db);
  console.log(`federalId: ${federalId}`);

  const expected = [
    ["DC", "4d2aac54-6d83-4736-b446-2970e98439f5"],
    // FIX-376 territories — canonical ids from FIX-321 migration on prod
    ["AS", "6361925c-45c4-47f8-a0c2-918b2a5cf4a2"],
    ["GU", "1d3253d6-681d-49fb-bd72-7fa6148460bb"],
    ["MP", "7664d668-150c-4f78-ac78-a79b0dec2ba2"],
    ["PR", "1283fdc6-fb3b-494c-81c9-1aaf4104cadc"],
    ["VI", "8bf8f0d5-c895-4f6a-9372-55f6a05baab7"],
  ];

  let fail = 0;
  for (const [abbr, expectedId] of expected) {
    const got = stateIds.get(abbr);
    if (got === expectedId) {
      console.log(`  ✓ ${abbr} → ${got}`);
    } else {
      console.error(`  ✗ ${abbr} → ${got ?? "(undefined)"}  (expected ${expectedId})`);
      fail++;
    }
  }

  if (fail > 0) {
    console.error(`\nFAIL: ${fail} of ${expected.length} did not resolve to canonical`);
    process.exit(3);
  }
  console.log(`\nPASS: all ${expected.length} type='district' state-equivalents resolved to canonical`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
