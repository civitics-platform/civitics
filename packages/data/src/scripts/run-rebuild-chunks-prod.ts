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
    // FIX-650 — startup reconcile: heal a stranded autovacuum_enabled=false on
    // entity_connections before doing any churn. This script is the manual "2b"
    // recovery path operators run after a GHA full rebuild is cancelled/SIGKILLed
    // at the 4h cap (the FIX-591 dirty-exit case). The full rebuild
    // (rebuild-entity-connections.ts) pauses autovacuum (FIX-590) and re-enables
    // it in a finally + startup reconcile — but a SIGKILL skips the finally, and
    // THIS recovery script never managed autovacuum, so the flag stayed off and
    // the DELETE+INSERT churn's dead tuples were never reaped (entity_connections
    // sat at ~70% dead tuples, FIX-650). Re-enabling here is idempotent and cheap;
    // it never sets the flag false, so this path can only heal, never strand.
    try {
      await client.query("ALTER TABLE public.entity_connections SET (autovacuum_enabled = true)");
      console.log("  [reconcile] autovacuum_enabled=true on entity_connections (idempotent heal)");
    } catch (reErr) {
      console.warn(`  [reconcile] autovacuum re-enable warning: ${reErr instanceof Error ? reErr.message : String(reErr)}`);
    }
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

    // FIX-650 — reap the dead tuples this rebuild's DELETE+INSERT churn produced,
    // now that the chunks are done. Mirrors the FIX-590 post-rebuild VACUUM tail
    // in rebuild-entity-connections.ts. Plain VACUUM (ANALYZE) is online (SHARE
    // UPDATE EXCLUSIVE — does not block graph reads/writes) and refreshes the
    // planner stats + visibility map. Wrapped so a VACUUM failure doesn't mask a
    // good rebuild. (It does NOT shrink the on-disk file — that needs VACUUM FULL
    // / pg_repack, a separate gated decision.)
    try {
      await client.query("SET statement_timeout = '30min'");
      await client.query("VACUUM (ANALYZE) public.entity_connections");
      console.log("  [post] VACUUM (ANALYZE) entity_connections — complete");
    } catch (vacErr) {
      console.warn(`  [post] post-rebuild VACUUM — FAILED: ${vacErr instanceof Error ? vacErr.message : String(vacErr)}`);
    }
  } finally {
    // FIX-650 — belt-and-braces: ensure autovacuum is on even if a chunk threw
    // mid-run. This script never disables it, but a future edit might, and an
    // operator killing the run must never leave it stranded (the FIX-650 incident).
    try {
      await client.query("ALTER TABLE public.entity_connections SET (autovacuum_enabled = true)");
    } catch {
      /* connection may already be dead — manual re-enable then needed */
    }
    await client.end();
  }
}

main().catch((e) => {
  console.error("fatal:", e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
