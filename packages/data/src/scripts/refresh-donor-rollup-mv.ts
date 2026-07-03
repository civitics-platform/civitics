/**
 * One-shot: CALL public.refresh_official_donor_rollup_incremental() against
 * the active DB via a DIRECT postgres connection.
 *
 * FIX-704 — official_donor_rollup_mv is now an incrementally-maintained TABLE
 * (the name kept its `_mv` suffix for read compat). The old
 * `REFRESH MATERIALIZED VIEW CONCURRENTLY` here built a full second copy of
 * the donor set and OOM-wedged prod Micro (2026-07-01 incident); the chunked
 * procedure (dirty recipients since the donor_rollup_watermark, 200 per chunk,
 * COMMIT per chunk, bounded work_mem) replaces it. NULL watermark → full
 * chunked bootstrap over every recipient.
 *
 * Why direct-pg and not a .rpc() call: the service_role admin client is
 * effectively ~8s-capped and the gateway ~100s (FIX-444), and PostgREST can't
 * CALL a COMMIT-ing procedure usefully anyway. The `SET statement_timeout` as
 * its OWN top-level statement BEFORE the CALL is the one mechanism that arms
 * the CALL's budget (FIX-703 — in-procedure SET / per-COMMIT / proconfig are
 * all no-ops on the already-armed timer).
 *
 * Run:
 *   # local Docker (active .env.local points local)
 *   pnpm --filter @civitics/data data:refresh-donor-mv
 *
 *   # prod (off-peak only — see CLAUDE.md "no heavy prod ops during active hours").
 *   # Prefer a one-off pg_cron job for the prod BOOTSTRAP (survives disconnect —
 *   # the 2026-07-01 orphaning lesson); this script is fine for incremental runs.
 *   pnpm --filter @civitics/data exec tsx --env-file=<ABS>/.env.local.prod \
 *     <ABS>/src/scripts/refresh-donor-rollup-mv.ts
 *
 * Reads SUPABASE_DB_PASSWORD + NEXT_PUBLIC_SUPABASE_URL from the active env.
 * Always confirm the active env points where you intend before running.
 */

import { Client } from "pg";

function buildDbUrl(): string {
  const explicit = process.env["SUPABASE_DB_URL"];
  if (explicit) return explicit;
  const password = process.env["SUPABASE_DB_PASSWORD"];
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  if (!supabaseUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL not set");
  const m = supabaseUrl.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!m) {
    // local Docker
    return "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  }
  if (!password) throw new Error("SUPABASE_DB_PASSWORD not set (required for prod)");
  const projectRef = m[1];
  const region = process.env["SUPABASE_DB_REGION"] ?? "us-west-2";
  return `postgresql://postgres.${projectRef}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

async function main(): Promise<void> {
  const url = buildDbUrl();
  const masked = url.replace(/:[^:@/]+@/, ":***@");
  console.log(`Connecting: ${masked}`);
  const client = new Client({ connectionString: url, application_name: "refresh_donor_rollup_mv" });
  await client.connect();

  try {
    const before = await client.query<{ count: string; watermark: string | null }>(
      "SELECT count(*)::text AS count, " +
        "(SELECT value->>'last_indexed_at' FROM pipeline_state WHERE key = 'donor_rollup_watermark') AS watermark " +
        "FROM official_donor_rollup_mv"
    );
    console.log(
      `Before: official_donor_rollup_mv = ${Number(before.rows[0]!.count).toLocaleString()} rows, ` +
        `watermark = ${before.rows[0]!.watermark ?? "NULL (bootstrap)"}`
    );

    // Top-level SET before the CALL is what arms the CALL's runtime budget
    // (FIX-703). 6h covers the full chunked bootstrap on a cache-starved Micro.
    await client.query("SET statement_timeout = '6h'");
    const t0 = Date.now();
    console.log(`[${new Date().toISOString()}] CALL public.refresh_official_donor_rollup_incremental() ...`);
    await client.query("CALL public.refresh_official_donor_rollup_incremental()");
    const dur = ((Date.now() - t0) / 1000).toFixed(1);

    const after = await client.query<{ count: string; watermark: string | null }>(
      "SELECT count(*)::text AS count, " +
        "(SELECT value->>'last_indexed_at' FROM pipeline_state WHERE key = 'donor_rollup_watermark') AS watermark " +
        "FROM official_donor_rollup_mv"
    );
    console.log(
      `After:  official_donor_rollup_mv = ${Number(after.rows[0]!.count).toLocaleString()} rows, ` +
        `watermark = ${after.rows[0]!.watermark ?? "NULL"} (${dur}s)`
    );
    console.log(`Done.`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("fatal:", e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
