/**
 * One-off investigation for FIX-300 / FIX-318 audit-check triage.
 *
 * Read-only against whichever DB the constructed connection points at (typically
 * prod). Prints sample rows + counts that drive the bucket decision for each of
 * the 4 suspected audit-check bugs: president_count, vp_count,
 * senators_per_state (state field path), rep_count.
 *
 * Usage:
 *   pnpm --filter @civitics/data tsx --env-file=../../.env.local src/scripts/audit-triage-investigate.ts
 */

import { Client } from "pg";

function constructDbUrlFromEnv(): string {
  const password = process.env.SUPABASE_DB_PASSWORD;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!password || !supabaseUrl) return "";
  const m = supabaseUrl.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!m) {
    // Local Docker fallback
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
  if (!dbUrl) {
    console.error("ERROR: no DB URL constructible from env");
    process.exit(2);
  }
  const cleanUrl = dbUrl.replace(/[?&]sslmode=[^&]*/g, "");
  const wantsSsl = /[?&]sslmode=/.test(dbUrl) || dbUrl.includes("supabase.");
  const client = new Client({
    connectionString: cleanUrl,
    ssl: wantsSsl ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  console.log(`Connected to: ${new URL(cleanUrl).host}\n`);

  // 1. President matches — current check has no FED_FILTER
  console.log("=== president_count: breakdown by role_title ===");
  const presBreakdown = await client.query(
    `SELECT role_title, tier, COUNT(*)::int AS n,
            (source_ids ? 'congress_gov') AS has_congress_gov
       FROM officials
      WHERE is_active = true
        AND role_title ILIKE '%president%'
        AND role_title NOT ILIKE '%vice%'
      GROUP BY role_title, tier, has_congress_gov
      ORDER BY n DESC
      LIMIT 30`,
  );
  console.table(presBreakdown.rows);

  console.log("\n=== president_count: with FED_FILTER applied ===");
  const presFed = await client.query(
    `SELECT role_title, COUNT(*)::int AS n
       FROM officials
      WHERE is_active = true
        AND role_title ILIKE '%president%'
        AND role_title NOT ILIKE '%vice%'
        AND source_ids ? 'congress_gov'
      GROUP BY role_title`,
  );
  console.table(presFed.rows);

  console.log("\n=== president_count: candidates (cn24 tier=candidate) ===");
  const presCand = await client.query(
    `SELECT COUNT(*)::int AS n
       FROM officials
      WHERE is_active = true
        AND tier = 'candidate'
        AND role_title ILIKE '%president%'
        AND role_title NOT ILIKE '%vice%'`,
  );
  console.table(presCand.rows);

  // 2. VP matches
  console.log("\n=== vp_count: breakdown by role_title ===");
  const vpBreakdown = await client.query(
    `SELECT role_title, tier, COUNT(*)::int AS n,
            (source_ids ? 'congress_gov') AS has_congress_gov
       FROM officials
      WHERE is_active = true
        AND role_title ILIKE '%vice president%'
      GROUP BY role_title, tier, has_congress_gov
      ORDER BY n DESC
      LIMIT 30`,
  );
  console.table(vpBreakdown.rows);

  console.log("\n=== vp_count: with FED_FILTER applied ===");
  const vpFed = await client.query(
    `SELECT role_title, COUNT(*)::int AS n
       FROM officials
      WHERE is_active = true
        AND role_title ILIKE '%vice president%'
        AND source_ids ? 'congress_gov'
      GROUP BY role_title`,
  );
  console.table(vpFed.rows);

  // 3. Senator state field path
  console.log("\n=== senators_per_state: sample 5 federal senators' metadata ===");
  const senSample = await client.query(
    `SELECT id, full_name, role_title, jsonb_pretty(metadata) AS metadata
       FROM officials
      WHERE is_active = true
        AND role_title ILIKE '%senator%'
        AND source_ids ? 'congress_gov'
      LIMIT 5`,
  );
  for (const row of senSample.rows) {
    console.log(`-- ${row.full_name} (${row.role_title}) [${row.id}] --`);
    console.log(row.metadata);
  }

  console.log("\n=== senators_per_state: discover top-level metadata keys ===");
  const senKeys = await client.query(
    `SELECT k, COUNT(*)::int AS n
       FROM officials, jsonb_object_keys(metadata) AS k
      WHERE is_active = true
        AND role_title ILIKE '%senator%'
        AND source_ids ? 'congress_gov'
      GROUP BY k
      ORDER BY n DESC
      LIMIT 30`,
  );
  console.table(senKeys.rows);

  // Try a few plausible state-field candidates and see what works
  console.log("\n=== senators_per_state: test candidate state field paths ===");
  const senFieldsTest = await client.query(
    `SELECT
        COUNT(*) FILTER (WHERE metadata ? 'state') AS has_state,
        COUNT(*) FILTER (WHERE metadata ? 'state_abbr') AS has_state_abbr,
        COUNT(*) FILTER (WHERE metadata ? 'state_code') AS has_state_code,
        COUNT(*) FILTER (WHERE metadata ? 'state_name') AS has_state_name,
        COUNT(*) FILTER (WHERE metadata ? 'us_state') AS has_us_state,
        COUNT(*) AS total
       FROM officials
      WHERE is_active = true
        AND role_title ILIKE '%senator%'
        AND source_ids ? 'congress_gov'`,
  );
  console.table(senFieldsTest.rows);

  // Also check state column on officials (might be a top-level column not in metadata)
  console.log("\n=== senators_per_state: check officials.state column existence ===");
  const colsCheck = await client.query(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'officials'
        AND column_name IN ('state', 'state_abbr', 'state_code', 'district_id', 'jurisdiction_id')
      ORDER BY column_name`,
  );
  console.table(colsCheck.rows);

  // 4. Rep_count: count by state, look for missing seats / delegates
  console.log("\n=== rep_count: total + breakdown ===");
  const repTotal = await client.query(
    `SELECT COUNT(*)::int AS n
       FROM officials
      WHERE is_active = true
        AND role_title ILIKE '%representative%'
        AND source_ids ? 'congress_gov'`,
  );
  console.table(repTotal.rows);

  console.log("\n=== rep_count: distinct role_title shapes ===");
  const repTitles = await client.query(
    `SELECT role_title, COUNT(*)::int AS n
       FROM officials
      WHERE is_active = true
        AND role_title ILIKE '%representative%'
        AND source_ids ? 'congress_gov'
      GROUP BY role_title
      ORDER BY n DESC`,
  );
  console.table(repTitles.rows);

  // Try to bucket by state via metadata (will only work if metadata has state key)
  console.log("\n=== rep_count: per-state count via metadata->>'state' ===");
  const repByMetaState = await client.query(
    `SELECT metadata->>'state' AS state, COUNT(*)::int AS n
       FROM officials
      WHERE is_active = true
        AND role_title ILIKE '%representative%'
        AND source_ids ? 'congress_gov'
      GROUP BY 1
      ORDER BY n DESC NULLS LAST
      LIMIT 60`,
  );
  console.table(repByMetaState.rows);

  // Look for non-voting delegate role_titles (territories)
  console.log("\n=== rep_count: search for delegate role_titles (without congress_gov filter) ===");
  const delegates = await client.query(
    `SELECT role_title, COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE source_ids ? 'congress_gov') AS with_congress_gov
       FROM officials
      WHERE is_active = true
        AND (
          role_title ILIKE '%delegate%'
          OR role_title ILIKE '%resident commissioner%'
          OR role_title ILIKE '%non-voting%'
          OR role_title ILIKE '%nonvoting%'
        )
      GROUP BY role_title
      ORDER BY n DESC`,
  );
  console.table(delegates.rows);

  // Sanity: districts represented (looking for vacancies)
  console.log("\n=== rep_count: distinct (state, district) coverage ===");
  const districts = await client.query(
    `SELECT
        COUNT(DISTINCT (metadata->>'state' || '-' || COALESCE(metadata->>'district', district_name, 'AL'))) AS distinct_district_keys,
        COUNT(*) AS total_reps
       FROM officials
      WHERE is_active = true
        AND role_title ILIKE '%representative%'
        AND source_ids ? 'congress_gov'`,
  );
  console.table(districts.rows);

  // Look for vacant seats — list states that have <expected number of reps>
  console.log("\n=== rep_count: states by count ===");
  const stateRepCount = await client.query(
    `SELECT
        COALESCE(metadata->>'state', metadata->>'state_abbr') AS state,
        COUNT(*)::int AS reps
       FROM officials
      WHERE is_active = true
        AND role_title ILIKE '%representative%'
        AND source_ids ? 'congress_gov'
      GROUP BY 1
      ORDER BY reps DESC NULLS LAST`,
  );
  console.table(stateRepCount.rows);

  await client.end();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
