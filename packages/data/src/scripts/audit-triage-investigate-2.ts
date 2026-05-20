/**
 * Follow-up investigation for senators_per_state — confirm jurisdiction JOIN path
 * since metadata is empty.
 */

import { Client } from "pg";

function constructDbUrlFromEnv(): string {
  const password = process.env.SUPABASE_DB_PASSWORD;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!password || !supabaseUrl) return "";
  const m = supabaseUrl.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!m) {
    if (/127\.0\.0\.1:54321/.test(supabaseUrl)) {
      return "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
    }
    return "";
  }
  const projectRef = m[1];
  const region = process.env.SUPABASE_DB_REGION ?? "us-west-2";
  return `postgresql://postgres.${projectRef}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

async function main(): Promise<void> {
  const dbUrl =
    process.env.COWORK_READONLY_DB_URL ??
    process.env.SUPABASE_DB_URL ??
    constructDbUrlFromEnv();
  const cleanUrl = dbUrl.replace(/[?&]sslmode=[^&]*/g, "");
  const wantsSsl = /[?&]sslmode=/.test(dbUrl) || dbUrl.includes("supabase.");
  const client = new Client({
    connectionString: cleanUrl,
    ssl: wantsSsl ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  console.log(`Connected to: ${new URL(cleanUrl).host}\n`);

  // Sample senator with full jurisdiction join
  console.log("=== senators_per_state: sample JOIN to jurisdictions ===");
  const senJoin = await client.query(
    `SELECT o.id, o.full_name, j.id AS juris_id, j.name AS juris_name, j.metadata AS juris_metadata
       FROM officials o
       LEFT JOIN jurisdictions j ON j.id = o.jurisdiction_id
      WHERE o.is_active = true
        AND o.role_title ILIKE '%senator%'
        AND o.source_ids ? 'congress_gov'
      LIMIT 6`,
  );
  for (const row of senJoin.rows) {
    console.log(`-- ${row.full_name} (juris=${row.juris_name}) --`);
    console.log("  juris_metadata:", JSON.stringify(row.juris_metadata));
  }

  // Try the grouping with jurisdictions.metadata->>'state_abbr' or similar
  console.log("\n=== senators_per_state: explore jurisdiction metadata keys ===");
  const jurisKeys = await client.query(
    `SELECT k, COUNT(*)::int AS n
       FROM officials o
       LEFT JOIN jurisdictions j ON j.id = o.jurisdiction_id,
            jsonb_object_keys(j.metadata) AS k
      WHERE o.is_active = true
        AND o.role_title ILIKE '%senator%'
        AND o.source_ids ? 'congress_gov'
      GROUP BY k
      ORDER BY n DESC`,
  );
  console.table(jurisKeys.rows);

  // Look at jurisdictions table top-level columns
  console.log("\n=== jurisdictions: columns ===");
  const jCols = await client.query(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'jurisdictions'
      ORDER BY ordinal_position`,
  );
  console.table(jCols.rows);

  // Now try grouping
  console.log("\n=== senators_per_state: group by jurisdictions.metadata->>'state_abbr' (or whatever) ===");
  const senGrouped = await client.query(
    `SELECT j.metadata->>'state_abbr' AS state_abbr,
            j.metadata->>'state' AS state,
            j.metadata->>'state_code' AS state_code,
            j.name AS juris_name,
            COUNT(*)::int AS n
       FROM officials o
       LEFT JOIN jurisdictions j ON j.id = o.jurisdiction_id
      WHERE o.is_active = true
        AND o.role_title ILIKE '%senator%'
        AND o.source_ids ? 'congress_gov'
      GROUP BY 1, 2, 3, 4
      ORDER BY n DESC
      LIMIT 60`,
  );
  console.table(senGrouped.rows);

  // Look at congress.gov officials pipeline — what jurisdiction is each senator mapped to?
  console.log("\n=== Senator -> jurisdiction.name list ===");
  const jurisList = await client.query(
    `SELECT j.name, COUNT(*)::int AS n
       FROM officials o
       LEFT JOIN jurisdictions j ON j.id = o.jurisdiction_id
      WHERE o.is_active = true
        AND o.role_title ILIKE '%senator%'
        AND o.source_ids ? 'congress_gov'
      GROUP BY j.name
      ORDER BY j.name`,
  );
  console.table(jurisList.rows);

  // Rep state breakdown via JOIN
  console.log("\n=== rep_count: jurisdiction breakdown ===");
  const repJuris = await client.query(
    `SELECT j.name AS juris_name, COUNT(*)::int AS n
       FROM officials o
       LEFT JOIN jurisdictions j ON j.id = o.jurisdiction_id
      WHERE o.is_active = true
        AND o.role_title ILIKE '%representative%'
        AND o.source_ids ? 'congress_gov'
      GROUP BY j.name
      ORDER BY n DESC`,
  );
  console.table(repJuris.rows);

  // Total reps without congress_gov filter to see if any non-matched delegates exist
  console.log("\n=== rep_count: any other 'Representative' rows missing congress_gov source? ===");
  const repNoFed = await client.query(
    `SELECT role_title, tier, COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE source_ids ? 'openstates_id') AS w_openstates,
            COUNT(*) FILTER (WHERE source_ids ? 'fec_candidate_id') AS w_fec
       FROM officials
      WHERE is_active = true
        AND role_title ILIKE '%representative%'
        AND NOT (source_ids ? 'congress_gov')
      GROUP BY role_title, tier
      ORDER BY n DESC
      LIMIT 20`,
  );
  console.table(repNoFed.rows);

  await client.end();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
