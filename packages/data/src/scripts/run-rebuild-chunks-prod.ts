/**
 * One-shot: run each rebuild_entity_connections_<chunk>() function in
 * sequence against the active DB, capturing per-chunk timings and edge
 * counts. Mirrors what the nightly orchestrator does, but standalone so
 * it can be run manually after a prod migration to verify FIX-263 lands.
 *
 * Run:
 *   pnpm exec tsx packages/data/src/scripts/run-rebuild-chunks-prod.ts
 *
 * Reads SUPABASE_DB_PASSWORD + NEXT_PUBLIC_SUPABASE_URL from the active
 * env. Always confirm the active env points where you intend before
 * running — this DELETEs ~5M rows.
 */

import { Client } from "pg";

function buildDbUrl(): string {
  const explicit = process.env["SUPABASE_DB_URL"];
  if (explicit) return explicit;
  const password = process.env["SUPABASE_DB_PASSWORD"];
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  if (!password || !supabaseUrl) throw new Error("SUPABASE_DB_PASSWORD or NEXT_PUBLIC_SUPABASE_URL not set");
  const m = supabaseUrl.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!m) {
    // local Docker
    return "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  }
  const projectRef = m[1];
  const region = process.env["SUPABASE_DB_REGION"] ?? "us-west-2";
  return `postgresql://postgres.${projectRef}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

const chunkFns = [
  "rebuild_entity_connections_donations",
  "rebuild_entity_connections_votes",
  "rebuild_entity_connections_cosponsors",
  "rebuild_entity_connections_appointments",
  "rebuild_entity_connections_oversight",
  "rebuild_entity_connections_holds",
  "rebuild_entity_connections_gifts",
  "rebuild_entity_connections_contracts",
  "rebuild_entity_connections_lobbying",
  "rebuild_entity_connections_external",
];

async function main(): Promise<void> {
  const url = buildDbUrl();
  const masked = url.replace(/:[^:@/]+@/, ":***@");
  console.log(`Connecting: ${masked}`);
  const client = new Client({ connectionString: url });
  await client.connect();

  let grandTotalEdges = 0;
  const t0 = Date.now();
  try {
    for (const fn of chunkFns) {
      const chunkStart = Date.now();
      console.log(`\n[${new Date().toISOString()}] running ${fn}()`);
      try {
        await client.query("SET statement_timeout = '60min'");
        const res = await client.query<{ connection_type: string; edges_upserted: string | number }>(
          `SELECT * FROM public.${fn}()`
        );
        const dur = Date.now() - chunkStart;
        for (const r of res.rows) {
          const edges = Number(r.edges_upserted ?? 0);
          grandTotalEdges += edges;
          console.log(`  ${r.connection_type}: ${edges.toLocaleString()} edges (${(dur / 1000).toFixed(1)}s)`);
        }
      } catch (err) {
        const dur = Date.now() - chunkStart;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  FAILED in ${(dur / 1000).toFixed(1)}s: ${msg}`);
      }
    }

    const totalDur = Date.now() - t0;
    console.log(`\nTotal: ${grandTotalEdges.toLocaleString()} edges in ${(totalDur / 1000 / 60).toFixed(2)} min`);

    const total = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM entity_connections");
    console.log(`entity_connections.count(*) = ${Number(total.rows[0]!.count).toLocaleString()}`);

    const breakdown = await client.query<{ connection_type: string; n: string }>(
      "SELECT connection_type, count(*)::text AS n FROM entity_connections GROUP BY connection_type ORDER BY count(*) DESC"
    );
    console.log(`\nPer-type breakdown:`);
    for (const r of breakdown.rows) console.log(`  ${r.connection_type}: ${Number(r.n).toLocaleString()}`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("fatal:", e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
