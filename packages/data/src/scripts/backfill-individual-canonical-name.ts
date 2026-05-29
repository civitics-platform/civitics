/**
 * FIX-238: rewrite existing individual donor canonical_name to natural
 * "FIRST [MI] LAST" form (canonicalDonorName applied to display_name).
 *
 * Uses pg.Client directly because PostgREST's `.upsert()` issues an INSERT
 * with ON CONFLICT, which fails on the NOT NULL display_name when only
 * (id, canonical_name) is supplied. A bare UPDATE via VALUES-join is both
 * faster and side-steps that constraint.
 *
 * Idempotent — re-running it after it lands is a no-op (rows whose
 * canonical_name already matches the target are skipped in the WHERE clause).
 *
 * Run against whichever env .env.local points at:
 *   pnpm --filter @civitics/data data:backfill:individual-canonical
 */

import { Client, type QueryResult } from "pg";
import { canonicalDonorName } from "../pipelines/fec-bulk/indiv";

const PAGE_SIZE    = 5000;
const UPDATE_CHUNK = 1000;

function buildDbUrl(): string {
  const explicit = process.env["SUPABASE_DB_URL"];
  if (explicit) return explicit;
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "";
  // Local Docker Supabase
  if (supabaseUrl.includes("127.0.0.1") || supabaseUrl.includes("localhost")) {
    return "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  }
  const password = process.env["SUPABASE_DB_PASSWORD"];
  const m = supabaseUrl.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!password || !m) {
    throw new Error("Need SUPABASE_DB_URL or (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_DB_PASSWORD)");
  }
  const region = process.env["SUPABASE_DB_REGION"] ?? "us-west-2";
  return `postgresql://postgres.${m[1]}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

interface Row {
  id:             string;
  display_name:   string;
  canonical_name: string | null;
}

async function main() {
  const dbUrl = buildDbUrl();
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  console.log("FIX-238 backfill — rewriting individual canonical_name to natural FIRST-LAST form");
  console.log(`  Target: ${process.env["NEXT_PUBLIC_SUPABASE_URL"]}`);

  const totalRes = await client.query<{ c: string }>(
    "SELECT count(*)::text AS c FROM public.financial_entities WHERE entity_type = 'individual'",
  );
  const total = Number(totalRes.rows[0]?.c ?? 0);
  console.log(`  ${total.toLocaleString()} individuals to scan`);

  let cursor: string | null = null;
  let scanned   = 0;
  let updated   = 0;
  let unchanged = 0;
  let failed    = 0;
  const t0 = Date.now();

  while (true) {
    const pageRes: QueryResult<Row> = cursor
      ? await client.query<Row>(
          `SELECT id::text, display_name, canonical_name
             FROM public.financial_entities
            WHERE entity_type = 'individual' AND id > $1
            ORDER BY id
            LIMIT $2`,
          [cursor, PAGE_SIZE],
        )
      : await client.query<Row>(
          `SELECT id::text, display_name, canonical_name
             FROM public.financial_entities
            WHERE entity_type = 'individual'
            ORDER BY id
            LIMIT $1`,
          [PAGE_SIZE],
        );
    const rows = pageRes.rows;
    if (rows.length === 0) break;

    const updates: Array<[string, string]> = [];
    for (const row of rows) {
      const newCanonical = canonicalDonorName(row.display_name);
      if (newCanonical && newCanonical !== row.canonical_name) {
        updates.push([row.id, newCanonical]);
      } else {
        unchanged++;
      }
    }

    for (let i = 0; i < updates.length; i += UPDATE_CHUNK) {
      const chunk = updates.slice(i, i + UPDATE_CHUNK);
      // VALUES-join UPDATE: one round-trip per chunk.
      const valuesSql = chunk
        .map((_, idx) => `($${idx * 2 + 1}::uuid, $${idx * 2 + 2}::text)`)
        .join(",");
      const params: string[] = [];
      for (const [id, name] of chunk) { params.push(id, name); }
      const sql =
        `UPDATE public.financial_entities AS fe
            SET canonical_name = v.canonical_name
           FROM (VALUES ${valuesSql}) AS v(id, canonical_name)
          WHERE fe.id = v.id`;
      try {
        const r = await client.query(sql, params);
        updated += r.rowCount ?? 0;
      } catch (err) {
        console.error(`  chunk ${i}-${i + chunk.length} failed: ${(err as Error).message}`);
        failed += chunk.length;
      }
    }

    scanned += rows.length;
    cursor = rows[rows.length - 1].id;
    const dtSec = (Date.now() - t0) / 1000;
    const rate  = scanned / Math.max(1, dtSec);
    const eta   = total ? Math.round((total - scanned) / Math.max(1, rate)) : null;
    console.log(
      `  scanned ${scanned.toLocaleString()} ` +
      `(updated ${updated.toLocaleString()}, unchanged ${unchanged.toLocaleString()}, failed ${failed}) ` +
      `${rate.toFixed(0)} rows/s${eta !== null ? ` eta ${eta}s` : ""}`,
    );

    if (rows.length < PAGE_SIZE) break;
  }

  await client.end();

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("");
  console.log(`Done in ${dt}s — updated ${updated.toLocaleString()}, unchanged ${unchanged.toLocaleString()}, failed ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
