/**
 * FIX-385 prod investigation gate — territory delegate name-mismatch.
 *
 * Determines:
 *   (1) Is Plaskett (P000610) actually on federalId vs canonical VI on prod?
 *   (2) Which territory abbrs in metadata.state currently appear on federalId
 *       with fec_candidate_id — sizing the FEC backfill set.
 *   (3) For each STATE_DATA territory name, does it match Congress.gov's
 *       member.state string for any current delegate (signature of the
 *       name-mismatch lookup miss).
 *
 * READ-ONLY against whichever DB .env points at — gate against prod with
 *   pnpm --filter @civitics/data tsx --env-file=../../.env.local.prod \
 *     src/scripts/investigate-territory-name-mismatch.ts
 */

import { Client } from "pg";

function dbUrl(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  if (/127\.0\.0\.1/.test(url)) return "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  const pw = process.env.SUPABASE_DB_PASSWORD!;
  const m = url.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i)!;
  const region = process.env.SUPABASE_DB_REGION ?? "us-west-2";
  return `postgresql://postgres.${m[1]}:${encodeURIComponent(pw)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

async function main(): Promise<void> {
  const c = new Client({ connectionString: dbUrl() });
  await c.connect();
  console.log(`target: ${process.env.NEXT_PUBLIC_SUPABASE_URL}\n`);

  try {
    // Resolve federal + territory canonical UUIDs from the live DB so this
    // works against any env (prod's federalId differs from local's).
    const refs = await c.query(`
      SELECT id, name, short_name, type, fips_code
      FROM jurisdictions
      WHERE (fips_code = '00' AND type = 'country')
         OR (short_name IN ('DC','AS','GU','MP','PR','VI') AND type = 'district');
    `);
    console.log("=== Canonical reference jurisdictions ===");
    console.table(refs.rows);

    const federal = refs.rows.find((r) => r.fips_code === "00" && r.type === "country");
    if (!federal) { console.error("could not resolve federal jurisdiction"); return; }
    const federalId = federal.id as string;

    // (1) Plaskett + any other current Congress.gov-sourced delegates on federalId
    console.log("\n=== 1. Congress.gov-sourced reps/delegates currently on federalId ===");
    const q1 = await c.query(`
      SELECT o.id, o.full_name, o.role_title, o.district_name,
             o.source_ids->>'congress_gov' AS bioguide,
             to_char(o.updated_at, 'YYYY-MM-DD HH24:MI') AS updated
      FROM officials o
      WHERE o.jurisdiction_id = $1
        AND o.source_ids ? 'congress_gov'
      ORDER BY o.full_name;
    `, [federalId]);
    console.log(`  ${q1.rowCount} rows`);
    console.table(q1.rows);

    // (2) FEC-bulk candidates with metadata.state in territory abbrs that
    //     landed on federalId. metadata.state for FEC rows comes from CAND_OFFICE_ST.
    console.log("\n=== 2. FEC candidates on federalId with territory metadata.state ===");
    const q2 = await c.query(`
      SELECT metadata->>'state' AS office_state, COUNT(*)::int AS n
      FROM officials
      WHERE source_ids ? 'fec_candidate_id'
        AND jurisdiction_id = $1
        AND metadata->>'state' IN ('VI','PR','GU','AS','MP','DC')
      GROUP BY metadata->>'state'
      ORDER BY office_state;
    `, [federalId]);
    console.table(q2.rows);

    // (2b) Per-row listing
    console.log("\n=== 2b. FEC candidate rows on federalId with territory metadata.state ===");
    const q2b = await c.query(`
      SELECT id, full_name, role_title, district_name,
             metadata->>'state' AS office_state,
             source_ids->>'fec_candidate_id' AS fec_cand,
             to_char(created_at, 'YYYY-MM-DD') AS created,
             to_char(updated_at, 'YYYY-MM-DD') AS updated
      FROM officials
      WHERE source_ids ? 'fec_candidate_id'
        AND jurisdiction_id = $1
        AND metadata->>'state' IN ('VI','PR','GU','AS','MP','DC')
      ORDER BY metadata->>'state', full_name;
    `, [federalId]);
    console.log(`  ${q2b.rowCount} rows`);
    console.table(q2b.rows);

    // (3) Inspect each territory short_name's full canonical name on this DB —
    //     these are the strings stateIds.get(member.state) is keyed off.
    console.log("\n=== 3. Canonical short_name → name mapping for each territory ===");
    const q3 = await c.query(`
      SELECT short_name, name FROM jurisdictions
      WHERE short_name IN ('DC','AS','GU','MP','PR','VI') AND type = 'district'
      ORDER BY short_name;
    `);
    console.table(q3.rows);

    // (4) For comparison: how many territory candidates are correctly placed?
    console.log("\n=== 4. Territory candidates correctly on canonical territory jurisdictions ===");
    for (const abbr of ["VI","PR","GU","AS","MP","DC"]) {
      const terr = refs.rows.find((r) => r.short_name === abbr && r.type === "district");
      if (!terr) { console.log(`  ${abbr}: canonical not resolved`); continue; }
      const q = await c.query(`
        SELECT COUNT(*)::int AS n_total,
               COUNT(*) FILTER (WHERE source_ids ? 'fec_candidate_id')::int AS n_fec,
               COUNT(*) FILTER (WHERE source_ids ? 'congress_gov')::int AS n_congress
        FROM officials WHERE jurisdiction_id = $1;
      `, [terr.id]);
      console.log(`  ${abbr} (${terr.id}): total=${q.rows[0].n_total} fec=${q.rows[0].n_fec} congress=${q.rows[0].n_congress}`);
    }

    // (5) Officials with metadata.state in territory list whose jurisdiction
    //     is NOT the territory canonical — broader "misattribution suspects".
    console.log("\n=== 5. metadata.state ∈ territories but jurisdiction_id NOT on canonical territory ===");
    const territoryIds = refs.rows
      .filter((r) => ["VI","PR","GU","AS","MP","DC"].includes(r.short_name) && r.type === "district")
      .map((r) => r.id);
    const q5 = await c.query(`
      SELECT metadata->>'state' AS office_state,
             COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE jurisdiction_id = $1)::int AS on_federal,
             COUNT(*) FILTER (WHERE jurisdiction_id IS NULL)::int AS on_null
      FROM officials
      WHERE metadata->>'state' IN ('VI','PR','GU','AS','MP','DC')
        AND (jurisdiction_id IS NULL OR jurisdiction_id NOT IN (SELECT unnest($2::uuid[])))
      GROUP BY metadata->>'state'
      ORDER BY office_state;
    `, [federalId, territoryIds]);
    console.table(q5.rows);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
