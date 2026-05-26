/**
 * FIX-346 — one-off re-measure of autovacuum lag on financial_relationships.
 * Read-only. Discard after the FIX is closed.
 *
 *   tsx --env-file=../../.env.local.prod src/scripts/fix346-measure.ts
 */

import { Client } from "pg";

function constructDbUrl(): string {
  const explicit = process.env["SUPABASE_DB_URL"];
  if (explicit) return explicit;
  const password = process.env["SUPABASE_DB_PASSWORD"];
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  if (!supabaseUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL missing");
  const m = supabaseUrl.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!m) {
    if (/127\.0\.0\.1:54321/.test(supabaseUrl)) {
      return "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
    }
    throw new Error("Cannot infer DB URL");
  }
  if (!password) throw new Error("SUPABASE_DB_PASSWORD missing");
  const projectRef = m[1];
  const region = process.env["SUPABASE_DB_REGION"] ?? "us-west-2";
  return `postgresql://postgres.${projectRef}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

async function main(): Promise<void> {
  const c = new Client({ connectionString: constructDbUrl() });
  await c.connect();
  try {
    const res = await c.query(`
      SELECT
        relname,
        n_live_tup,
        n_dead_tup,
        ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 2) AS dead_pct,
        last_autovacuum,
        last_autoanalyze,
        autovacuum_count,
        analyze_count
      FROM pg_stat_user_tables
      WHERE relname = 'financial_relationships'
    `);
    console.log(JSON.stringify(res.rows, null, 2));
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
