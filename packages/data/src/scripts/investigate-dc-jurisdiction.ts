/**
 * Investigate DC jurisdiction PGRST116 failure in fec_bulk and check whether
 * the same shape affects the FIX-376 territories.
 *
 * Read-only. Pattern B:
 *   pnpm --filter @civitics/data tsx --env-file=../../.env.local.prod src/scripts/investigate-dc-jurisdiction.ts
 */

import { Client } from "pg";

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
    console.error("ERROR: no DB URL constructible from env");
    process.exit(2);
  }

  console.log(`target: ${process.env.NEXT_PUBLIC_SUPABASE_URL}`);

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    // Reproduces exactly what seedJurisdictions() does in us-states.ts:144-152
    // for each STATE_DATA entry: existence check is (fips_code, type).
    // We want to find every entry whose existence check would return >1 row.
    console.log("\n=== STATE_DATA-shaped existence-check collisions ===");
    console.log("(matches (fips_code, type) ignoring parent_id/country_code)");
    const dupes = await client.query(`
      WITH state_data(fips, type) AS (
        VALUES
          ('11', 'district'),       -- DC
          ('60', 'district'),       -- AS
          ('66', 'district'),       -- GU
          ('69', 'district'),       -- MP
          ('72', 'district'),       -- PR
          ('78', 'district')        -- VI
      )
      SELECT
        sd.fips, sd.type, COUNT(j.id)::int AS n,
        array_agg(j.name ORDER BY j.created_at) AS names,
        array_agg(j.id::text ORDER BY j.created_at) AS ids
      FROM state_data sd
      LEFT JOIN public.jurisdictions j
        ON j.fips_code = sd.fips AND j.type = sd.type::jurisdiction_type
      GROUP BY sd.fips, sd.type
      ORDER BY n DESC, sd.fips;
    `);
    console.table(dupes.rows);

    console.log("\n=== effect of adding parent_id = federal filter ===");
    const narrowed = await client.query(`
      WITH fed AS (
        SELECT id FROM public.jurisdictions WHERE fips_code = '00' AND type = 'country'
      ),
      state_data(fips, type) AS (
        VALUES
          ('11', 'district'),
          ('60', 'district'),
          ('66', 'district'),
          ('69', 'district'),
          ('72', 'district'),
          ('78', 'district')
      )
      SELECT
        sd.fips, sd.type, COUNT(j.id)::int AS n,
        array_agg(j.name ORDER BY j.created_at) AS names
      FROM state_data sd
      LEFT JOIN public.jurisdictions j
        ON j.fips_code = sd.fips
       AND j.type = sd.type::jurisdiction_type
       AND j.parent_id = (SELECT id FROM fed)
      GROUP BY sd.fips, sd.type
      ORDER BY n DESC, sd.fips;
    `);
    console.table(narrowed.rows);

    console.log("\n=== DC sub-district row (the collider) ===");
    const sub = await client.query(`
      SELECT id, name, short_name, type, fips_code, parent_id, country_code,
             metadata, created_at
      FROM public.jurisdictions
      WHERE id = '6145e924-257a-4ddf-9c42-175e5de27665';
    `);
    console.dir(sub.rows[0], { depth: null });
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
