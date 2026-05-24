/**
 * IOWait Round 2 prod measurement — read-only.
 *
 *   tsx --env-file=.env.local.prod docs/audits/scratch/2026-05-24-round2-prod-measurement.ts <mode>
 *
 * <mode> is "before" or "after". Captures pg_total_relation_size for the
 * three top tables (entity_connections, financial_relationships,
 * financial_entities) and total index bytes for each, plus EXPLAIN ANALYZE
 * BUFFERS for the two sunburst route shapes flagged in the FIX-360 report.
 *
 * Output: stdout — paste into docs/audits/2026-05-24-iowait-diagnosis.md
 * "Round 2 - drops" and "Round 2 - sunburst route measurement" sections.
 *
 * SELECT/EXPLAIN-only. No writes.
 */

import { Client } from "pg";

function constructDbUrlFromEnv(): string {
  const explicit = process.env["SUPABASE_DB_URL"];
  if (explicit) return explicit;
  const password = process.env["SUPABASE_DB_PASSWORD"];
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  if (!supabaseUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL missing");
  const m = supabaseUrl.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!m) throw new Error("not a prod supabase url: " + supabaseUrl);
  if (!password) throw new Error("SUPABASE_DB_PASSWORD missing");
  const region = process.env["SUPABASE_DB_REGION"] ?? "us-west-2";
  return `postgresql://postgres.${m[1]}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

// Pick the highest-degree from_id on prod at runtime so the EXPLAIN ANALYZE
// rows reflect a real busy entity. FIX-360's local test used Warren's local
// UUID which doesn't exist on prod (different DB, different IDs).
async function pickHighDegreeFromId(c: Client): Promise<string> {
  const r = await c.query(`
    SELECT from_id, count(*) AS n
    FROM public.entity_connections
    GROUP BY from_id
    ORDER BY count(*) DESC
    LIMIT 1;
  `);
  if (r.rows.length === 0) throw new Error("no from_id rows");
  console.log(`  high-degree from_id = ${r.rows[0].from_id} (${r.rows[0].n} connections)`);
  return r.rows[0].from_id;
}

async function main() {
  const mode = (process.argv[2] ?? "before") as "before" | "after";
  if (mode !== "before" && mode !== "after") {
    console.error(`mode must be "before" or "after"`);
    process.exit(2);
  }
  const url = constructDbUrlFromEnv();
  const host = new URL(url).host;
  const c = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 60_000,
  });
  await c.connect();
  console.log(`[round2-measurement mode=${mode}] connected to ${host}`);
  console.log(`[round2-measurement mode=${mode}] timestamp: ${new Date().toISOString()}`);

  // Top-3 pg_total_relation_size
  console.log(`\n=== ${mode.toUpperCase()}: Top-3 pg_total_relation_size ===`);
  const sizes = await c.query(`
    SELECT relname,
           pg_total_relation_size(c.oid)::bigint AS total_bytes,
           pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
           pg_relation_size(c.oid)::bigint AS heap_bytes,
           pg_size_pretty(pg_relation_size(c.oid)) AS heap,
           pg_indexes_size(c.oid)::bigint AS index_bytes,
           pg_size_pretty(pg_indexes_size(c.oid)) AS indexes
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname IN ('entity_connections', 'financial_relationships', 'financial_entities')
    ORDER BY pg_total_relation_size(c.oid) DESC;
  `);
  let totalSum = 0n;
  let indexSum = 0n;
  for (const r of sizes.rows) {
    console.log(`  ${String(r.relname).padEnd(28)} total=${String(r.total).padStart(8)}  heap=${String(r.heap).padStart(8)}  indexes=${String(r.indexes).padStart(8)}`);
    totalSum += BigInt(r.total_bytes);
    indexSum += BigInt(r.index_bytes);
  }
  console.log(`  ${"SUM".padEnd(28)} total=${(Number(totalSum) / 1024 / 1024).toFixed(0).padStart(5)} MB indexes=${(Number(indexSum) / 1024 / 1024).toFixed(0).padStart(5)} MB`);
  console.log(`  RAW SUMS bytes: total=${totalSum}  indexes=${indexSum}`);

  const fromId = await pickHighDegreeFromId(c);

  // Sunburst shape 1: from_id eq + connection_type in (...) — route line 372-378.
  console.log(`\n=== ${mode.toUpperCase()}: Sunburst shape 1 (vote_categories, route line 372-378) ===`);
  const plan1 = await c.query({
    text: `
      EXPLAIN (ANALYZE, BUFFERS)
      SELECT connection_type, to_id, strength
      FROM public.entity_connections
      WHERE from_id = $1
        AND connection_type = ANY($2::connection_type[])
      LIMIT 200;
    `,
    values: [fromId, ["vote_yes", "vote_no", "vote_abstain", "nomination_vote_yes", "nomination_vote_no"]],
  });
  for (const r of plan1.rows) console.log("  " + (r as Record<string, string>)["QUERY PLAN"]);

  // Sunburst shape 2: from_id eq + no connection_type filter — route line 431-434.
  console.log(`\n=== ${mode.toUpperCase()}: Sunburst shape 2 (connection_types default, route line 431-434) ===`);
  const plan2 = await c.query({
    text: `
      EXPLAIN (ANALYZE, BUFFERS)
      SELECT connection_type, to_id, strength, amount_cents
      FROM public.entity_connections
      WHERE from_id = $1
      LIMIT 200;
    `,
    values: [fromId],
  });
  for (const r of plan2.rows) console.log("  " + (r as Record<string, string>)["QUERY PLAN"]);

  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
