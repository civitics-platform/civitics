/**
 * One-shot: REFRESH MATERIALIZED VIEW CONCURRENTLY official_donor_rollup_mv
 * against the active DB via a DIRECT postgres connection.
 *
 * Why direct-pg and not a .rpc() call: an in-body / function-level
 * `SET statement_timeout` does NOT raise the top-level PostgREST/gateway
 * limit. The service_role admin client is effectively ~8s-capped and the
 * gateway ~100s, so refreshing this ~1M-row MV through PostgREST times out.
 * A direct session with statement_timeout raised is the only reliable path
 * (same pattern run-rebuild-chunks-prod.ts uses).
 *
 * CONCURRENTLY is non-blocking for readers; the required unique index on
 * official_donor_rollup_mv already exists. A stale MV is what drops the
 * officials page into its 50k-row live-scan fallback — this refresh is the
 * fix for that.
 *
 * Run:
 *   # local Docker (active .env.local points local)
 *   pnpm --filter @civitics/data data:refresh-donor-mv
 *
 *   # prod (off-peak only — see CLAUDE.md "no heavy prod ops during active hours")
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
    const before = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM official_donor_rollup_mv"
    );
    console.log(`Before: official_donor_rollup_mv = ${Number(before.rows[0]!.count).toLocaleString()} rows`);

    await client.query("SET statement_timeout = '30min'");
    const t0 = Date.now();
    console.log(`[${new Date().toISOString()}] REFRESH MATERIALIZED VIEW CONCURRENTLY official_donor_rollup_mv ...`);
    await client.query("REFRESH MATERIALIZED VIEW CONCURRENTLY public.official_donor_rollup_mv");
    const dur = ((Date.now() - t0) / 1000).toFixed(1);

    const after = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM official_donor_rollup_mv"
    );
    console.log(`After:  official_donor_rollup_mv = ${Number(after.rows[0]!.count).toLocaleString()} rows (${dur}s)`);
    console.log(`Done.`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("fatal:", e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
