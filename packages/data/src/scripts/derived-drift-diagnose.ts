/**
 * Diagnostic for FIX-345 — derived_drift regression investigation.
 *
 * Tonight's status_snapshot pull showed derived_drift median ~9 s
 * (vs ~361-1047 ms in the FIX-338 post-deploy memory note). This script
 * runs Probes 1, 2, 3, 6 from the CC prompt to localize the cause.
 *
 * Read-only. Confirm .env.local points at prod before running.
 *
 * Usage:
 *   pnpm --filter @civitics/data tsx --env-file=../../.env.local src/scripts/derived-drift-diagnose.ts
 */

import { Client } from "pg";

function constructDbUrlFromEnv(): string {
  const password = process.env.SUPABASE_DB_PASSWORD;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!password || !supabaseUrl) return "";
  const m = supabaseUrl.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!m) {
    if (/127\.0\.0\.1:54321/.test(supabaseUrl)) {
      return "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
    }
    return "";
  }
  const projectRef = m[1];
  const region = process.env.SUPABASE_DB_REGION ?? "us-west-2";
  return `postgresql://postgres.${projectRef}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

async function main(): Promise<void> {
  const dbUrl =
    process.env.COWORK_READONLY_DB_URL ??
    process.env.SUPABASE_DB_URL ??
    constructDbUrlFromEnv();
  if (!dbUrl) {
    console.error("ERROR: no DB URL constructible from env");
    process.exit(2);
  }
  const cleanUrl = dbUrl.replace(/[?&]sslmode=[^&]*/g, "");
  const wantsSsl = /[?&]sslmode=/.test(dbUrl) || dbUrl.includes("supabase.");
  const client = new Client({
    connectionString: cleanUrl,
    ssl: wantsSsl ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  console.log(`Connected to: ${new URL(cleanUrl).host}\n`);

  // === Probe 1: connection_type_counts table populated and fresh? ===
  console.log("=== Probe 1: connection_type_counts row count + freshness ===");
  const probe1 = await client.query(
    `SELECT COUNT(*)::int AS row_count,
            MAX(refreshed_at) AS most_recent_refresh,
            NOW() - MAX(refreshed_at) AS age
       FROM public.connection_type_counts`,
  );
  console.table(probe1.rows);

  console.log("\n=== Probe 1b: connection_type_counts contents ===");
  const probe1b = await client.query(
    `SELECT connection_type, total
       FROM public.connection_type_counts
       ORDER BY total DESC`,
  );
  console.table(probe1b.rows);

  // === Probe 2: RPC body — does it read the materialized table? ===
  console.log("\n=== Probe 2: get_connection_type_counts() body ===");
  const probe2 = await client.query(
    `SELECT prosrc
       FROM pg_proc
      WHERE proname = 'get_connection_type_counts'
        AND pronamespace = 'public'::regnamespace`,
  );
  for (const row of probe2.rows) {
    console.log(row.prosrc);
  }

  console.log("\n=== Probe 2b: refresh_connection_type_counts() body + config ===");
  const probe2b = await client.query(
    `SELECT proname, proconfig, prosrc
       FROM pg_proc
      WHERE proname = 'refresh_connection_type_counts'
        AND pronamespace = 'public'::regnamespace`,
  );
  for (const row of probe2b.rows) {
    console.log(`config: ${JSON.stringify(row.proconfig)}`);
    console.log(`body:\n${row.prosrc}`);
  }

  // === Probe 3: EXPLAIN ANALYZE on RPC — 3 runs (cold + 2 warm) ===
  console.log("\n=== Probe 3: EXPLAIN ANALYZE get_connection_type_counts() (3 runs) ===");
  for (let i = 1; i <= 3; i++) {
    const start = Date.now();
    const probe3 = await client.query(
      `EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM public.get_connection_type_counts()`,
    );
    const elapsed = Date.now() - start;
    console.log(`-- run ${i} (wall-clock ${elapsed} ms) --`);
    for (const row of probe3.rows) {
      console.log(row["QUERY PLAN"]);
    }
  }

  // === Probe 6: recent section_times for derived_drift + rebuild_last_run ===
  // Column is `fetched_at` (not created_at). `section_times` is a top-level JSONB
  // column added by 20260522000000_status_snapshot_section_times.sql (FIX-328).
  console.log("\n=== Probe 6: last 10 status_snapshot rows — derived_drift vs rebuild_last_run ===");
  const probe6 = await client.query(
    `SELECT fetched_at,
            section_times->>'self_tests:derived_drift'   AS derived_drift_ms,
            section_times->>'self_tests:rebuild_last_run' AS rebuild_last_run_ms,
            query_time_ms
       FROM status_snapshot
      ORDER BY fetched_at DESC
      LIMIT 10`,
  );
  console.table(probe6.rows);

  // Per-rule sub-key dump from the most recent row (FIX-332 instrumentation)
  console.log("\n=== Probe 6b: latest status_snapshot — full section_times keys ===");
  const probe6b = await client.query(
    `SELECT fetched_at,
            jsonb_pretty(section_times) AS section_times
       FROM status_snapshot
      ORDER BY fetched_at DESC
      LIMIT 1`,
  );
  for (const row of probe6b.rows) {
    console.log(`fetched_at: ${row.fetched_at}`);
    console.log(row.section_times);
  }

  await client.end();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
