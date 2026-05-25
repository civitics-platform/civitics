/**
 * Verify FIX-383 by simulating the prod DC-98 collider locally:
 *   1. Insert a fake DC-98 sub-district row (parent_id = canonical DC)
 *   2. Call seedJurisdictions() — should NOT error on DC
 *   3. Assert stateIds.get('DC') matches canonical (not collider) id
 *   4. Roll back the test insert
 *
 * Local DB only.
 *   pnpm --filter @civitics/data tsx --env-file=../../.env.local src/scripts/verify-dc-seed-fix.ts
 */

import { Client } from "pg";
import { createAdminClient } from "@civitics/db";
import { seedJurisdictions } from "../jurisdictions/us-states";

function localUrl(): string {
  return "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
}

async function main(): Promise<void> {
  if (!/127\.0\.0\.1/.test(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "")) {
    console.error("ERROR: refusing to run unless NEXT_PUBLIC_SUPABASE_URL points at local");
    process.exit(2);
  }

  const pg = new Client({ connectionString: localUrl() });
  await pg.connect();

  let canonicalDcId: string | null = null;
  let colliderId: string | null = null;

  try {
    const dcRes = await pg.query(
      `SELECT id FROM public.jurisdictions WHERE fips_code='11' AND type='district' LIMIT 1`,
    );
    canonicalDcId = dcRes.rows[0]?.id ?? null;
    if (!canonicalDcId) {
      console.error("ERROR: no canonical DC row locally — run seedJurisdictions first");
      process.exit(2);
    }

    console.log(`canonical DC id: ${canonicalDcId}`);

    // Insert collider mimicking prod DC-98
    const ins = await pg.query(
      `INSERT INTO public.jurisdictions
         (name, short_name, type, country_code, fips_code, parent_id, is_active, metadata)
       VALUES
         ($1, $2, 'district', NULL, '11', $3, TRUE,
          jsonb_build_object('source','test','chamber','congressional','district_id','98'))
       RETURNING id`,
      ["[TEST] DC Delegate District (at Large)", "DC-98", canonicalDcId],
    );
    colliderId = ins.rows[0].id;
    console.log(`inserted collider id: ${colliderId}`);

    // Sanity: pre-fix query (no parent_id filter) finds 2 rows
    const pre = await pg.query(
      `SELECT id FROM public.jurisdictions WHERE fips_code='11' AND type='district'`,
    );
    console.log(`pre-fix shape: ${pre.rows.length} rows match (fips=11, type=district)`);
    if (pre.rows.length < 2) {
      console.error("ERROR: collider insert didn't create the duplicate shape");
      process.exit(3);
    }

    // Run the actual seed via PostgREST admin client (same path fec_bulk uses)
    const db = createAdminClient();
    const { stateIds } = await seedJurisdictions(db);
    const seededDcId = stateIds.get("DC");
    console.log(`seedJurisdictions returned DC id: ${seededDcId}`);

    if (!seededDcId) {
      console.error("FAIL: stateIds.get('DC') returned undefined — seed swallowed an error");
      process.exit(4);
    }
    if (seededDcId !== canonicalDcId) {
      console.error(
        `FAIL: seed picked ${seededDcId} but canonical is ${canonicalDcId} — narrowing didn't pick the right row`,
      );
      process.exit(5);
    }

    console.log("PASS: seedJurisdictions resolved DC to the canonical row with collider present");
  } finally {
    if (colliderId) {
      await pg.query(`DELETE FROM public.jurisdictions WHERE id = $1`, [colliderId]);
      console.log(`cleaned up collider ${colliderId}`);
    }
    await pg.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
