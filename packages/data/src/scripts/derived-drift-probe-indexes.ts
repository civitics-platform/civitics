/**
 * FIX-345 sub-probe — inspect financial_relationships indexes + EXPLAIN ANALYZE
 * the per-rule count shapes that checkDerivedDrift issues today, plus the
 * candidate GROUP BY shape for the replacement RPC.
 *
 * Read-only. Run after derived-drift-diagnose.ts narrows the cause to the
 * source-count side.
 */

import { Client } from "pg";

function constructDbUrlFromEnv(): string {
  const password = process.env.SUPABASE_DB_PASSWORD;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!password || !supabaseUrl) return "";
  const m = supabaseUrl.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!m) return "";
  const projectRef = m[1];
  const region = process.env.SUPABASE_DB_REGION ?? "us-west-2";
  return `postgresql://postgres.${projectRef}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

async function main(): Promise<void> {
  const dbUrl = constructDbUrlFromEnv();
  const cleanUrl = dbUrl.replace(/[?&]sslmode=[^&]*/g, "");
  const client = new Client({
    connectionString: cleanUrl,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.info(`Connected to: ${new URL(cleanUrl).host}\n`);

  console.info("=== indexes on financial_relationships ===");
  const idx = await client.query(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname='public' AND tablename='financial_relationships'
      ORDER BY indexname`,
  );
  for (const r of idx.rows) console.info(`  ${r.indexname}: ${r.indexdef}`);

  const explain = async (label: string, sql: string): Promise<void> => {
    console.info(`\n=== ${label} ===`);
    const start = Date.now();
    const res = await client.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`);
    const wall = Date.now() - start;
    console.info(`-- wall-clock: ${wall} ms --`);
    for (const r of res.rows) console.info(r["QUERY PLAN"]);
  };

  await explain(
    "count(*) WHERE relationship_type='donation' (the 8s rule)",
    `SELECT COUNT(*) FROM financial_relationships WHERE relationship_type = 'donation'`,
  );
  await explain(
    "count(*) WHERE relationship_type IN ('contract','grant') (the 12s rule)",
    `SELECT COUNT(*) FROM financial_relationships WHERE relationship_type IN ('contract','grant')`,
  );
  await explain(
    "count(*) WHERE relationship_type IN ('gift','honorarium') (the 422ms rule — control)",
    `SELECT COUNT(*) FROM financial_relationships WHERE relationship_type IN ('gift','honorarium')`,
  );
  await explain(
    "single GROUP BY relationship_type (replacement candidate)",
    `SELECT relationship_type, COUNT(*) FROM financial_relationships GROUP BY relationship_type`,
  );

  await client.end();
  console.info("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
