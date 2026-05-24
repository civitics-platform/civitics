/**
 * IOWait Round 2 pre-flight verification — read-only.
 *
 *   tsx --env-file=.env.local.prod docs/audits/scratch/2026-05-24-round2-preflight.ts
 *
 * Confirms (against prod) that the FIX-A unused-index candidates are still
 * unused at ship time and that the FIX-C duplicate pairs still have
 * byte-identical indexdef strings. Also captures pg_total_relation_size
 * baselines for the three top tables so the migration's working-set delta
 * is measurable.
 *
 * No writes. SELECT-only. Belongs in docs/audits/scratch/ per the runbook.
 */

import { Client } from "pg";

function constructDbUrlFromEnv(): string {
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
    throw new Error("unrecognized supabase url");
  }
  if (!password) throw new Error("SUPABASE_DB_PASSWORD missing");
  const projectRef = m[1];
  const region = process.env["SUPABASE_DB_REGION"] ?? "us-west-2";
  return `postgresql://postgres.${projectRef}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

async function main() {
  const url = constructDbUrlFromEnv();
  const host = new URL(url).host;
  const c = new Client({
    connectionString: url,
    ssl: url.includes("supabase.") ? { rejectUnauthorized: false } : undefined,
    statement_timeout: 60_000,
  });
  await c.connect();
  console.log(`[preflight] connected to ${host}`);

  // FIX-A — verify unused-and-large indexes still unused.
  console.log("\n=== FIX-A: unused-index candidates ===");
  const fixA = await c.query(`
    SELECT
      indexrelname,
      idx_scan,
      pg_size_pretty(pg_relation_size(indexrelid)) AS size,
      pg_relation_size(indexrelid) AS size_bytes,
      pg_get_indexdef(indexrelid) AS indexdef
    FROM pg_stat_user_indexes
    WHERE schemaname = 'public'
      AND indexrelname IN (
        'entity_connections_strength',
        'financial_relationships_metadata_gin',
        'entity_connections_amount',
        'financial_entities_display_trgm_individual',
        'financial_relationships_occurred_at',
        'shadow_proposals_search_vector',
        'external_source_refs_metadata_gin'
      )
    ORDER BY pg_relation_size(indexrelid) DESC;
  `);
  for (const r of fixA.rows) {
    console.log(`  ${r.indexrelname.padEnd(50)} idx_scan=${String(r.idx_scan).padStart(8)} size=${String(r.size).padStart(8)}`);
  }

  // FIX-C — verify duplicate-pair indexdefs.
  console.log("\n=== FIX-C: duplicate-pair verification ===");
  const fixC = await c.query(`
    SELECT tablename, indexname,
           pg_size_pretty(pg_relation_size(format('%I.%I', schemaname, indexname)::regclass)) AS size,
           indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname IN (
        'idx_officials_name_trgm',
        'officials_full_name_trgm',
        'agencies_name_trgm',
        'idx_agencies_name_trgm',
        'idx_graph_snapshots_code',
        'graph_snapshots_code_key'
      )
    ORDER BY tablename, indexname;
  `);
  for (const r of fixC.rows) {
    console.log(`  ${r.tablename}.${r.indexname} (${r.size})`);
    console.log(`    ${r.indexdef}`);
  }

  // Total-relation-size baselines for the three top tables.
  console.log("\n=== Top-3 pg_total_relation_size baseline ===");
  const sizes = await c.query(`
    SELECT relname,
           pg_total_relation_size(c.oid) AS total_bytes,
           pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
           pg_relation_size(c.oid) AS heap_bytes,
           pg_size_pretty(pg_relation_size(c.oid)) AS heap,
           pg_indexes_size(c.oid) AS index_bytes,
           pg_size_pretty(pg_indexes_size(c.oid)) AS indexes
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname IN ('entity_connections', 'financial_relationships', 'financial_entities')
    ORDER BY pg_total_relation_size(c.oid) DESC;
  `);
  for (const r of sizes.rows) {
    console.log(`  ${r.relname.padEnd(28)} total=${String(r.total).padStart(8)}  heap=${String(r.heap).padStart(8)}  indexes=${String(r.indexes).padStart(8)}`);
    console.log(`    bytes: total=${r.total_bytes}  heap=${r.heap_bytes}  indexes=${r.index_bytes}`);
  }

  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
