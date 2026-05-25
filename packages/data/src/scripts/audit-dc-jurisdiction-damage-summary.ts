/**
 * FIX-383 damage audit — summary-only (no per-row dumps). Run after
 * audit-dc-jurisdiction-damage.ts to get aggregate counts that scale.
 * READ-ONLY.
 *
 * DC-specific (hardcoded DC + federal UUIDs). Copy as template for future
 * jurisdiction-attribution incidents — swap UUIDs and window dates.
 *
 *   pnpm --filter @civitics/data diag:dc-jurisdiction-damage-summary
 *   (override env via `--env-file=../../.env.local.prod` for prod audit)
 */

import { Client } from "pg";

const FED      = "eb075dd5-038f-4b21-82f7-30f5c9e1d49a";
const DC_CAN   = "4d2aac54-6d83-4736-b446-2970e98439f5";
const DC_SUB   = "6145e924-257a-4ddf-9c42-175e5de27665";
const WIN_LO   = "2026-05-09";
const WIN_HI   = "2026-05-26";

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
  console.log(`target: ${process.env.NEXT_PUBLIC_SUPABASE_URL}`);
  console.log(`window: ${WIN_LO} → ${WIN_HI} (exclusive)\n`);

  try {
    // 1. Officials on federalId broken down by source — federalId is correct
    //    for federal judges/executives/SCOTUS/presidents/VP. The signature of
    //    FIX-383 misattribution: 'elected' + role_title in (Senator, Representative,
    //    Delegate) but on federalId.
    console.log("=== 1. Suspected mis-attributed officials on federalId ===");
    const q1 = await c.query(`
      SELECT role_title, tier, party,
             COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE updated_at >= $2 AND updated_at < $3)::int AS upd_in_win,
             COUNT(*) FILTER (WHERE created_at >= $2 AND created_at < $3)::int AS new_in_win
      FROM officials
      WHERE jurisdiction_id = $1
        AND role_title IN ('Senator','Representative','Delegate',
                            'Candidate for Senator','Candidate for Representative')
      GROUP BY role_title, tier, party
      ORDER BY role_title, n DESC;
    `, [FED, WIN_LO, WIN_HI]);
    console.table(q1.rows);

    // 2. Full per-row list of those suspects (small set — likely just Norton + Plaskett +
    //    some candidates)
    console.log("\n=== 2. Suspect rows (full list) ===");
    const q2 = await c.query(`
      SELECT id, full_name, role_title, tier, party, district_name,
             source_ids->>'congress_gov' AS bioguide,
             source_ids->>'fec_candidate_id' AS fec_cand,
             metadata->>'state' AS meta_state,
             metadata->>'fec_office_state' AS fec_office_state,
             to_char(created_at, 'YYYY-MM-DD') AS created,
             to_char(updated_at, 'YYYY-MM-DD HH24:MI') AS updated
      FROM officials
      WHERE jurisdiction_id = $1
        AND role_title IN ('Senator','Representative','Delegate',
                            'Candidate for Senator','Candidate for Representative')
      ORDER BY role_title, full_name;
    `, [FED]);
    console.log(`  ${q2.rowCount} rows`);
    console.table(q2.rows);

    // 3. Officials with metadata->>'state'='DC' or fec_office_state='DC' that
    //    are on federalId rather than DC canonical — direct mis-attribution
    //    signature, regardless of role_title.
    console.log("\n=== 3. Officials whose metadata says DC but jurisdiction_id ≠ DC ===");
    const q3 = await c.query(`
      SELECT o.id, o.full_name, o.role_title, o.tier, o.party,
             o.jurisdiction_id, j.name AS jname,
             o.source_ids->>'congress_gov' AS bioguide,
             o.source_ids->>'fec_candidate_id' AS fec_cand,
             o.metadata->>'state' AS meta_state,
             to_char(o.created_at, 'YYYY-MM-DD') AS created,
             to_char(o.updated_at, 'YYYY-MM-DD HH24:MI') AS updated
      FROM officials o
      LEFT JOIN jurisdictions j ON j.id = o.jurisdiction_id
      WHERE (
              o.metadata->>'state' IN ('DC','District of Columbia')
              OR o.metadata->>'fec_office_state' = 'DC'
            )
        AND o.jurisdiction_id <> $1
      ORDER BY o.role_title, o.full_name;
    `, [DC_CAN]);
    console.log(`  ${q3.rowCount} rows`);
    console.table(q3.rows);

    // 4. Same as 3 but inverted: any officials currently on DC canonical that
    //    look NOT-DC.
    console.log("\n=== 4. Officials on DC canonical (sanity) ===");
    const q4 = await c.query(`
      SELECT id, full_name, role_title, tier, district_name,
             metadata->>'state' AS meta_state,
             source_ids->>'openstates_id' AS openstates,
             to_char(created_at, 'YYYY-MM-DD') AS created,
             to_char(updated_at, 'YYYY-MM-DD HH24:MI') AS updated
      FROM officials WHERE jurisdiction_id = $1
      ORDER BY role_title, full_name;
    `, [DC_CAN]);
    console.table(q4.rows);

    // 5. NULL jurisdiction_id rows in the window
    console.log("\n=== 5. NULL jurisdiction_id in window ===");
    for (const t of ["officials", "bill_proposals", "votes", "governing_bodies"]) {
      try {
        const q = await c.query(`
          SELECT COUNT(*) FILTER (WHERE jurisdiction_id IS NULL)::int AS null_all,
                 COUNT(*) FILTER (WHERE jurisdiction_id IS NULL AND updated_at >= $1 AND updated_at < $2)::int AS null_win
          FROM ${t};
        `, [WIN_LO, WIN_HI]);
        console.log(`  ${t}: null_all=${q.rows[0].null_all}, null_in_window=${q.rows[0].null_win}`);
      } catch (e) {
        console.log(`  ${t}: ${(e as Error).message.split("\n")[0]}`);
      }
    }

    // 6. data_sync_log DC error scan (in window)
    console.log("\n=== 6. data_sync_log entries with DC-error signature ===");
    const q6 = await c.query(`
      SELECT * FROM (
        SELECT * FROM data_sync_log
        WHERE started_at >= $1 AND started_at < $2
      ) s
      WHERE s::text ILIKE '%District of Columbia%'
         OR s::text ILIKE '%PGRST116%'
         OR s::text ILIKE '%JSON object requested%'
      ORDER BY started_at
      LIMIT 50;
    `, [WIN_LO, WIN_HI]);
    console.log(`  rows: ${q6.rowCount}`);
    console.table(q6.rows);

    // 7. FK tables: do any rows reference DC-related FKs?
    console.log("\n=== 7. financial_relationships referencing officials on federalId in window ===");
    const q7 = await c.query(`
      SELECT COUNT(*)::int AS n
      FROM financial_relationships fr
      JOIN officials o ON o.id = fr.to_id
      WHERE o.jurisdiction_id = $1
        AND fr.to_type = 'official'
        AND o.role_title IN ('Senator','Representative','Delegate')
        AND fr.updated_at >= $2 AND fr.updated_at < $3;
    `, [FED, WIN_LO, WIN_HI]);
    console.log(`  rows in window flowing into officials-on-federalId (Sen/Rep/Del): ${q7.rows[0].n}`);

    // 8. votes by officials currently on federalId who are Sen/Rep/Del
    console.log("\n=== 8. votes by suspect officials in window ===");
    const q8 = await c.query(`
      SELECT COUNT(*)::int AS n
      FROM votes v
      JOIN officials o ON o.id = v.official_id
      WHERE o.jurisdiction_id = $1
        AND o.role_title IN ('Senator','Representative','Delegate')
        AND v.voted_at >= $2 AND v.voted_at < $3;
    `, [FED, WIN_LO, WIN_HI]);
    console.log(`  votes cast in window by Sen/Rep/Del-on-federalId: ${q8.rows[0].n}`);

    // 9. Norton-specific: full history of jurisdiction_id and source of writes
    console.log("\n=== 9. Norton (N000147) row state ===");
    const q9 = await c.query(`
      SELECT id, full_name, role_title, jurisdiction_id, source_ids,
             metadata, to_char(created_at, 'YYYY-MM-DD HH24:MI') AS created,
             to_char(updated_at, 'YYYY-MM-DD HH24:MI') AS updated
      FROM officials
      WHERE source_ids->>'congress_gov' = 'N000147';
    `);
    console.dir(q9.rows, { depth: null });

    // 10. Plaskett-specific
    console.log("\n=== 10. Plaskett (P000610) row state ===");
    const q10 = await c.query(`
      SELECT id, full_name, role_title, jurisdiction_id, source_ids,
             metadata, to_char(created_at, 'YYYY-MM-DD HH24:MI') AS created,
             to_char(updated_at, 'YYYY-MM-DD HH24:MI') AS updated
      FROM officials
      WHERE source_ids->>'congress_gov' = 'P000610';
    `);
    console.dir(q10.rows, { depth: null });

    // 11. Other House delegates (territories) — bioguides for AS/GU/MP/PR/VI
    console.log("\n=== 11. All territorial delegates (AS/GU/MP/PR/VI/DC) ===");
    const q11 = await c.query(`
      SELECT o.id, o.full_name, o.role_title,
             j.name AS jname, j.short_name, j.type,
             o.source_ids->>'congress_gov' AS bioguide,
             o.metadata->>'state' AS meta_state,
             to_char(o.updated_at, 'YYYY-MM-DD HH24:MI') AS updated
      FROM officials o
      LEFT JOIN jurisdictions j ON j.id = o.jurisdiction_id
      WHERE o.source_ids->>'congress_gov' IN
        ('N000147','P000610','S001177','M001236','U000031','S001204','R000600')
        OR (o.role_title IN ('Representative','Delegate','Resident Commissioner')
            AND o.tier = 'elected'
            AND j.fips_code IN ('11','60','66','69','72','78','00'));
    `);
    console.table(q11.rows);

    // 12. Total FEC candidates updated in window with office state DC, on federalId
    console.log("\n=== 12. FEC candidates with office_state=DC ===");
    const q12 = await c.query(`
      SELECT COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE jurisdiction_id = $1)::int AS on_fed,
             COUNT(*) FILTER (WHERE jurisdiction_id = $2)::int AS on_dc
      FROM officials
      WHERE source_ids ? 'fec_candidate_id'
        AND metadata->>'fec_office_state' = 'DC';
    `, [FED, DC_CAN]);
    console.table(q12.rows);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
