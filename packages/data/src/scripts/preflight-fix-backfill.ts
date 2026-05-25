/**
 * Pre-migration preflight for FIX-389 backfill: confirm Norton + 34 DC FEC
 * candidates are still mis-attributed to federalId before applying the
 * backfill migration. READ-ONLY.
 *
 * DC-389 specific (hardcoded Norton + DC UUIDs). Copy as template for
 * future backfill migrations — swap the FIX-ID + UUIDs.
 *
 *   pnpm --filter @civitics/data diag:dc-backfill-preflight
 *   (override env via `--env-file=../../.env.local.prod` for prod check)
 */

import { Client } from "pg";

const FED    = "eb075dd5-038f-4b21-82f7-30f5c9e1d49a";
const DC_CAN = "4d2aac54-6d83-4736-b446-2970e98439f5";
const NORTON = "af77d55d-d593-4a29-a5fd-6648992fa463";

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
    console.log("=== Norton row state ===");
    const q1 = await c.query(`
      SELECT id, full_name, jurisdiction_id,
             to_char(updated_at, 'YYYY-MM-DD HH24:MI') AS updated
      FROM officials WHERE id = $1;
    `, [NORTON]);
    console.table(q1.rows);
    const nortonJur = q1.rows[0]?.jurisdiction_id;
    if (nortonJur === FED) console.log("  → Norton still on federalId (backfill needed)");
    else if (nortonJur === DC_CAN) console.log("  → Norton already self-healed to canonical DC (drop Norton UPDATE)");
    else console.log(`  → Norton on unexpected jurisdiction ${nortonJur} — investigate`);

    console.log("\n=== 34 DC FEC candidates on federalId ===");
    const q2 = await c.query(`
      SELECT COUNT(*)::int AS n FROM officials
      WHERE jurisdiction_id = $1
        AND metadata->>'state' = 'DC'
        AND source_ids ? 'fec_candidate_id';
    `, [FED]);
    console.log(`  count on federalId with metadata.state=DC + fec_candidate_id: ${q2.rows[0].n}`);

    console.log("\n=== DC FEC candidates already on canonical DC (sanity) ===");
    const q3 = await c.query(`
      SELECT COUNT(*)::int AS n FROM officials
      WHERE jurisdiction_id = $1
        AND metadata->>'state' = 'DC'
        AND source_ids ? 'fec_candidate_id';
    `, [DC_CAN]);
    console.log(`  count on DC canonical with metadata.state=DC + fec_candidate_id: ${q3.rows[0].n}`);

    console.log("\n=== financial_relationships referencing Norton ===");
    const q4 = await c.query(`
      SELECT COUNT(*)::int AS n FROM financial_relationships
      WHERE from_id = $1 OR to_id = $1;
    `, [NORTON]);
    console.log(`  rows: ${q4.rows[0].n}`);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
