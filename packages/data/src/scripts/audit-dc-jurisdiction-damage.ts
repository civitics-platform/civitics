/**
 * FIX-383 post-fix damage audit (READ-ONLY against prod).
 *
 * DC-specific (hardcoded DC + federal-fallback UUIDs at top of file). Copy
 * as template for future jurisdiction-attribution incidents — swap the
 * UUIDs and window dates, leave the per-table query shapes intact.
 *
 * Purpose: quantify the data impact of the 16-day window (2026-05-09 →
 * 2026-05-25) during which seedJurisdictions() returned stateIds.get('DC')
 * = undefined. Identifies the mystery `eb075dd5-038f-4b21-82f7-30f5c9e1d49a`
 * jurisdiction and counts affected rows per table.
 *
 * Run:  pnpm --filter @civitics/data diag:dc-jurisdiction-damage
 *       (use `--env-file=../../.env.local.prod` override for prod audit)
 *
 * NO writes. NO updates. Pure SELECTs.
 */

import { Client } from "pg";

const DC_CANONICAL = "4d2aac54-6d83-4736-b446-2970e98439f5";
const DC_SUBDISTRICT = "6145e924-257a-4ddf-9c42-175e5de27665";
const MYSTERY = "eb075dd5-038f-4b21-82f7-30f5c9e1d49a";
const WINDOW_START = "2026-05-09";
const WINDOW_END   = "2026-05-26"; // exclusive upper bound

function constructDbUrlFromEnv(): string {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) return "";
  if (/127\.0\.0\.1:54321/.test(supabaseUrl)) {
    return "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  }
  const password = process.env.SUPABASE_DB_PASSWORD;
  const m = supabaseUrl.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!password || !m) return "";
  const projectRef = m[1];
  const region = process.env.SUPABASE_DB_REGION ?? "us-west-2";
  return `postgresql://postgres.${projectRef}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

async function main(): Promise<void> {
  const dbUrl =
    process.env.COWORK_READONLY_DB_URL ??
    process.env.SUPABASE_DB_URL ??
    constructDbUrlFromEnv();
  if (!dbUrl) {
    console.error("ERROR: no DB URL constructible");
    process.exit(2);
  }
  console.log(`target: ${process.env.NEXT_PUBLIC_SUPABASE_URL}`);

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    // -------------------------------------------------------------------
    // 1. Identify eb075dd5 — full row + parent chain
    // -------------------------------------------------------------------
    console.log("\n=== 1. eb075dd5 identity ===");
    const mystery = await client.query(`
      SELECT id, name, short_name, type, fips_code, parent_id, country_code,
             metadata, created_at
      FROM jurisdictions
      WHERE id = $1;
    `, [MYSTERY]);
    console.dir(mystery.rows[0], { depth: null });

    if (mystery.rows[0]?.parent_id) {
      const parent = await client.query(`
        SELECT id, name, short_name, type, fips_code FROM jurisdictions WHERE id = $1;
      `, [mystery.rows[0].parent_id]);
      console.log("\n  parent of eb075dd5:");
      console.dir(parent.rows[0], { depth: null });
    }

    // -------------------------------------------------------------------
    // 2. Canonical references for comparison
    // -------------------------------------------------------------------
    console.log("\n=== 2. Reference jurisdictions ===");
    const refs = await client.query(`
      SELECT id, name, short_name, type, fips_code, parent_id, created_at
      FROM jurisdictions
      WHERE id IN ($1, $2, $3)
         OR (fips_code = '00' AND type = 'country');
    `, [DC_CANONICAL, DC_SUBDISTRICT, MYSTERY]);
    console.table(refs.rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      fips: r.fips_code,
      parent_id: r.parent_id,
      created_at: r.created_at,
    })));

    // -------------------------------------------------------------------
    // 3. Per-jurisdiction counts of officials touched in window
    //    Pre-FIX-383 'DC' lookup returned undefined → callers either:
    //      - fell back to federalId   (congress/officials, fec-bulk candidates)
    //      - skipped the row          (openstates*, districts-tiger)
    //      - never used stateIds at all (votes, committees, regulations,
    //        courtlistener — these only use federalId regardless)
    // -------------------------------------------------------------------
    console.log("\n=== 3. Officials updated in window (2026-05-09 → 2026-05-25) ===");
    const officialsInWindow = await client.query(`
      SELECT o.jurisdiction_id, j.name AS jname, j.short_name, j.type,
             COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE o.created_at >= $1)::int AS new_in_window
      FROM officials o
      LEFT JOIN jurisdictions j ON j.id = o.jurisdiction_id
      WHERE o.updated_at >= $1 AND o.updated_at < $2
      GROUP BY o.jurisdiction_id, j.name, j.short_name, j.type
      ORDER BY n DESC
      LIMIT 20;
    `, [WINDOW_START, WINDOW_END]);
    console.table(officialsInWindow.rows);

    // -------------------------------------------------------------------
    // 4. Officials *currently* on the mystery + federal + DC ids
    // -------------------------------------------------------------------
    console.log("\n=== 4. Officials currently on each candidate fallback id ===");
    const targets = [
      { id: MYSTERY,       label: "eb075dd5 (mystery)" },
      { id: DC_CANONICAL,  label: "DC canonical (4d2aac54)" },
      { id: DC_SUBDISTRICT,label: "DC sub-district (6145e924)" },
    ];
    for (const t of targets) {
      const q = await client.query(`
        SELECT id, full_name, role_title, tier, party, district_name,
               source_ids, created_at, updated_at
        FROM officials
        WHERE jurisdiction_id = $1
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 25;
      `, [t.id]);
      console.log(`\n  -- ${t.label} -- (${q.rowCount} rows shown, capped at 25)`);
      console.table(q.rows.map((r) => ({
        id: r.id,
        full_name: r.full_name,
        role_title: r.role_title,
        tier: r.tier,
        party: r.party,
        district_name: r.district_name,
        congress_gov: r.source_ids?.congress_gov,
        fec_candidate_id: r.source_ids?.fec_candidate_id,
        created_at: r.created_at,
        updated_at: r.updated_at,
      })));
    }

    // -------------------------------------------------------------------
    // 5. Total counts per fallback bucket
    // -------------------------------------------------------------------
    console.log("\n=== 5. Officials count per candidate jurisdiction (total) ===");
    const totals = await client.query(`
      SELECT j.id, j.name AS jname, j.short_name, j.type, COUNT(o.id)::int AS officials
      FROM jurisdictions j
      LEFT JOIN officials o ON o.jurisdiction_id = j.id
      WHERE j.id IN ($1, $2, $3) OR (j.fips_code = '00' AND j.type = 'country')
      GROUP BY j.id, j.name, j.short_name, j.type
      ORDER BY officials DESC;
    `, [MYSTERY, DC_CANONICAL, DC_SUBDISTRICT]);
    console.table(totals.rows);

    // -------------------------------------------------------------------
    // 6. Federal jurisdiction id (so we can check fallback-to-federal flow)
    // -------------------------------------------------------------------
    console.log("\n=== 6. Federal jurisdiction (fallback target for officials/fec-bulk callers) ===");
    const fed = await client.query(`
      SELECT id, name, type, fips_code FROM jurisdictions
      WHERE fips_code = '00' AND type = 'country';
    `);
    console.dir(fed.rows[0], { depth: null });
    const federalId = fed.rows[0]?.id;

    // -------------------------------------------------------------------
    // 7. Norton's specific row
    // -------------------------------------------------------------------
    console.log("\n=== 7. Eleanor Holmes Norton — current state ===");
    const norton = await client.query(`
      SELECT o.id, o.full_name, o.role_title, o.party, o.district_name,
             o.jurisdiction_id, j.name AS jurisdiction_name, j.short_name, j.type,
             o.source_ids, o.created_at, o.updated_at, o.metadata
      FROM officials o
      LEFT JOIN jurisdictions j ON j.id = o.jurisdiction_id
      WHERE o.full_name ILIKE '%norton%' OR o.last_name ILIKE 'norton';
    `);
    console.table(norton.rows.map((r) => ({
      id: r.id,
      full_name: r.full_name,
      role_title: r.role_title,
      jurisdiction_id: r.jurisdiction_id,
      jurisdiction_name: r.jurisdiction_name,
      jurisdiction_short: r.short_name,
      jurisdiction_type: r.type,
      congress_gov: r.source_ids?.congress_gov,
      updated_at: r.updated_at,
    })));

    // -------------------------------------------------------------------
    // 8. Rows landing on `eb075dd5` — cluster details
    // -------------------------------------------------------------------
    console.log("\n=== 8. All officials on eb075dd5 ===");
    const cluster = await client.query(`
      SELECT id, full_name, role_title, tier, party, district_name,
             source_ids, metadata, created_at, updated_at
      FROM officials WHERE jurisdiction_id = $1
      ORDER BY created_at;
    `, [MYSTERY]);
    console.log(`  total rows: ${cluster.rowCount}`);
    console.table(cluster.rows.map((r) => ({
      id: r.id,
      full_name: r.full_name,
      role_title: r.role_title,
      tier: r.tier,
      district_name: r.district_name,
      congress_gov: r.source_ids?.congress_gov,
      fec_candidate_id: r.source_ids?.fec_candidate_id,
      state_meta: r.metadata?.state,
      created_at: r.created_at,
      updated_at: r.updated_at,
    })));

    // -------------------------------------------------------------------
    // 9. Counts per affected table: federal-fallback signature
    //    Officials with jurisdiction_id = federalId and Congress.gov source —
    //    EXPECTED to be only Norton (DC delegate) and possibly some president
    //    candidates from FEC. Anyone else is a misattribution suspect.
    // -------------------------------------------------------------------
    if (federalId) {
      console.log("\n=== 9. Officials on federalId by source — fallback signature ===");
      const fedOfficials = await client.query(`
        SELECT
          role_title,
          tier,
          COUNT(*)::int AS n,
          COUNT(*) FILTER (WHERE source_ids ? 'congress_gov')::int AS has_congress,
          COUNT(*) FILTER (WHERE source_ids ? 'fec_candidate_id')::int AS has_fec_cand,
          COUNT(*) FILTER (WHERE updated_at >= $2 AND updated_at < $3)::int AS updated_in_window,
          COUNT(*) FILTER (WHERE created_at >= $2 AND created_at < $3)::int AS created_in_window
        FROM officials
        WHERE jurisdiction_id = $1
        GROUP BY role_title, tier
        ORDER BY n DESC;
      `, [federalId, WINDOW_START, WINDOW_END]);
      console.table(fedOfficials.rows);

      console.log("\n=== 9b. Specific suspect rows on federalId in window ===");
      const fedSusp = await client.query(`
        SELECT id, full_name, role_title, tier, district_name,
               source_ids->>'congress_gov' AS bioguide,
               source_ids->>'fec_candidate_id' AS fec_cand,
               metadata->>'state' AS meta_state,
               created_at, updated_at
        FROM officials
        WHERE jurisdiction_id = $1
          AND (created_at >= $2 OR updated_at >= $2)
          AND created_at < $3
        ORDER BY created_at
        LIMIT 50;
      `, [federalId, WINDOW_START, WINDOW_END]);
      console.log(`  rows in window on federalId: ${fedSusp.rowCount}`);
      console.table(fedSusp.rows);
    }

    // -------------------------------------------------------------------
    // 10. Votes / committees / financial_relationships / proposals — DC scoping
    //    These tables either join to officials (so jurisdiction flows through
    //    officials.jurisdiction_id) or have their own jurisdiction_id column.
    //    Check whether any FK columns directly reference jurisdiction_id.
    // -------------------------------------------------------------------
    console.log("\n=== 10. Tables with jurisdiction_id column ===");
    const tables = await client.query(`
      SELECT table_schema, table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name IN ('jurisdiction_id')
      ORDER BY table_name;
    `);
    console.table(tables.rows);

    // -------------------------------------------------------------------
    // 11. Counts of NULL jurisdiction_id in window (case b)
    // -------------------------------------------------------------------
    console.log("\n=== 11. NULL jurisdiction_id rows in window by table ===");
    const nullableTables = ["officials", "bill_proposals", "votes", "governing_bodies"];
    for (const t of nullableTables) {
      try {
        const q = await client.query(`
          SELECT
            COUNT(*) FILTER (WHERE jurisdiction_id IS NULL)::int AS null_total,
            COUNT(*) FILTER (WHERE jurisdiction_id IS NULL AND updated_at >= $1 AND updated_at < $2)::int AS null_in_window
          FROM ${t}
          WHERE 1 = 1;
        `, [WINDOW_START, WINDOW_END]);
        console.log(`  ${t}: ${JSON.stringify(q.rows[0])}`);
      } catch (e) {
        console.log(`  ${t}: skipped (${(e as Error).message.split("\n")[0]})`);
      }
    }

    // -------------------------------------------------------------------
    // 12. data_sync_log scan for DC-related errors in window
    // -------------------------------------------------------------------
    console.log("\n=== 12. data_sync_log errors in window referencing 'DC' or 'District of Columbia' ===");
    const errs = await client.query(`
      SELECT id, source, started_at, finished_at, status, errors
      FROM data_sync_log
      WHERE started_at >= $1 AND started_at < $2
        AND (
          errors::text ILIKE '%District of Columbia%'
          OR errors::text ILIKE '%PGRST116%'
          OR errors::text ILIKE '%multiple (or no) rows returned%'
          OR errors::text ILIKE '%DC %'
        )
      ORDER BY started_at;
    `, [WINDOW_START, WINDOW_END]);
    console.log(`  matching sync_log rows: ${errs.rowCount}`);
    console.table(errs.rows);

    // -------------------------------------------------------------------
    // 13. proposals tied to DC?
    // -------------------------------------------------------------------
    console.log("\n=== 13. proposal-like tables on each fallback id (created in window) ===");
    const proposalTables = ["bill_proposals", "proposals"];
    for (const t of proposalTables) {
      try {
        const q = await client.query(`
          SELECT COUNT(*)::int AS n FROM ${t}
          WHERE jurisdiction_id IN ($1, $2, $3)
            AND created_at >= $4 AND created_at < $5;
        `, [MYSTERY, DC_CANONICAL, DC_SUBDISTRICT, WINDOW_START, WINDOW_END]);
        console.log(`  ${t} on any fallback id, created in window: ${q.rows[0].n}`);
      } catch (e) {
        console.log(`  ${t}: skipped (${(e as Error).message.split("\n")[0]})`);
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
