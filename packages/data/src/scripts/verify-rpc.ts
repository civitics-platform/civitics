/**
 * FIX-345 — quick wall-clock verification of get_drift_source_presence().
 * Read-only. Throwaway script — delete after the fix is verified in prod.
 */

import { Client } from "pg";

async function main(): Promise<void> {
  const url = `postgresql://postgres.xsazcoxinpgttgquwvuf:${encodeURIComponent(process.env.SUPABASE_DB_PASSWORD ?? "")}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  for (let i = 0; i < 3; i++) {
    const start = Date.now();
    const r = await c.query("SELECT * FROM public.get_drift_source_presence()");
    console.log(`run ${i + 1}: ${Date.now() - start} ms, rows=${r.rows.length}`);
    if (i === 0) console.table(r.rows);
  }
  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
