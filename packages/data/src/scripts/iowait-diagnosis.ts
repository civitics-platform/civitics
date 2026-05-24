/**
 * FIX-352 — Supabase IOWait diagnosis (read-only).
 *
 * Runs a panel of read-only Postgres probes against the DB pointed at by the
 * active `.env.local` and emits a JSON dump of everything the audit doc needs
 * for sections A–F. The doc-side authoring (Sections G–I, narrative wrappers,
 * findings table) is done by hand from the JSON.
 *
 * NO writes. Only SELECTs against pg_stat_statements, pg_stat_user_tables,
 * pg_stat_user_indexes, pg_stat_activity, pg_class, pg_settings, pg_indexes.
 *
 *   pnpm --filter @civitics/data data:iowait-diagnosis
 *
 * Output: docs/audits/2026-05-24-iowait-diagnosis.json  (consumed by hand).
 */

import { Client } from "pg";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const AUDITS_DIR = resolve(__dirname, "../../../../docs/audits");

function constructDbUrlFromEnv(): string {
  const explicit = process.env["SUPABASE_DB_URL"];
  if (explicit) return explicit;
  const password = process.env["SUPABASE_DB_PASSWORD"];
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  if (!supabaseUrl) return "";
  const m = supabaseUrl.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!m) {
    if (/127\.0\.0\.1:54321/.test(supabaseUrl)) {
      return "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
    }
    return "";
  }
  if (!password) return "";
  const projectRef = m[1];
  const region = process.env["SUPABASE_DB_REGION"] ?? "us-west-2";
  return `postgresql://postgres.${projectRef}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

async function q<T = unknown>(c: Client, sql: string): Promise<T[]> {
  const res = await c.query(sql);
  return res.rows as T[];
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

interface AuditDump {
  run_at: string;
  db_host: string;
  active_supabase_url: string;
  section_a: {
    version: string;
    shared_buffers: string;
    work_mem: string;
    effective_cache_size: string;
    max_connections: string;
    autovacuum: string;
    maintenance_work_mem: string;
    effective_io_concurrency: string;
    random_page_cost: string;
    server_encoding: string;
    pg_stat_statements_max?: string;
    track_io_timing: string;
  };
  section_b_top25: unknown[];
  section_c_activity_samples: { sample_at: string; rows: unknown[] }[];
  section_c_contention_samples: { sample_at: string; row: unknown }[];
  section_d_top_tables: unknown[];
  section_d_hot_tables: unknown[];
  section_e_low_idx: unknown[];
  section_e_duplicate_idx: unknown[];
  section_f_bloat: unknown[];
}

async function main(): Promise<void> {
  const dbUrl = constructDbUrlFromEnv();
  if (!dbUrl) {
    console.error("ERROR: no DB URL constructible from env");
    process.exit(2);
  }
  const wantsSsl = dbUrl.includes("supabase.");
  const client = new Client({
    connectionString: dbUrl,
    ssl: wantsSsl ? { rejectUnauthorized: false } : undefined,
    // We only run SELECTs and they need ≤5 min worst case (pg_stat_statements
    // scans a few thousand normalized queries — fast). Cap at 90s defensively.
    statement_timeout: 90_000,
  });
  await client.connect();
  const dbHost = new URL(dbUrl).host;
  console.log(`[iowait-diagnosis] connected to ${dbHost}`);

  // ── Section A ────────────────────────────────────────────────────────────
  const settingsSql = (name: string) =>
    `SELECT setting FROM pg_settings WHERE name = '${name}'`;
  const get = async (name: string): Promise<string> => {
    const rows = await q<{ setting: string }>(client, settingsSql(name));
    return rows[0]?.setting ?? "<unknown>";
  };
  const versionRows = await q<{ version: string }>(client, "SELECT version()");

  // pg_stat_statements_max requires the extension to be loaded; some Supabase
  // tiers expose it, some don't. Tolerate missing.
  let pssMax: string | undefined;
  try {
    pssMax = await get("pg_stat_statements.max");
  } catch {
    pssMax = undefined;
  }

  const sectionA: AuditDump["section_a"] = {
    version: versionRows[0]?.version ?? "<unknown>",
    shared_buffers: await get("shared_buffers"),
    work_mem: await get("work_mem"),
    effective_cache_size: await get("effective_cache_size"),
    max_connections: await get("max_connections"),
    autovacuum: await get("autovacuum"),
    maintenance_work_mem: await get("maintenance_work_mem"),
    effective_io_concurrency: await get("effective_io_concurrency"),
    random_page_cost: await get("random_page_cost"),
    server_encoding: await get("server_encoding"),
    pg_stat_statements_max: pssMax,
    track_io_timing: await get("track_io_timing"),
  };

  // ── Section B — pg_stat_statements top 25 ────────────────────────────────
  const sectionB = await q(
    client,
    `SELECT
       substring(query, 1, 4000) AS query,
       calls,
       total_exec_time::bigint AS total_ms,
       (total_exec_time / NULLIF(calls,0))::bigint AS mean_ms,
       shared_blks_read,
       shared_blks_hit,
       ROUND(100.0 * shared_blks_hit / NULLIF(shared_blks_hit + shared_blks_read, 0), 1) AS hit_pct,
       shared_blks_dirtied,
       shared_blks_written,
       temp_blks_read,
       temp_blks_written,
       rows
     FROM pg_stat_statements
     WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
     ORDER BY shared_blks_read DESC
     LIMIT 25`,
  );
  console.log(`[iowait-diagnosis] pg_stat_statements top 25: ${sectionB.length} rows`);

  // ── Section C — pg_stat_activity samples ─────────────────────────────────
  // Take 6 samples ~5s apart so we span 30s of wall clock. If we miss a cron
  // tick this run, future Cowork can re-run on the next 10-min boundary.
  const activitySamples: { sample_at: string; rows: unknown[] }[] = [];
  const contentionSamples: { sample_at: string; row: unknown }[] = [];
  for (let i = 0; i < 6; i++) {
    const ts = new Date().toISOString();
    const rows = await q(
      client,
      `SELECT
         pid, state, wait_event_type, wait_event,
         EXTRACT(EPOCH FROM (now() - xact_start))::int AS xact_age_s,
         EXTRACT(EPOCH FROM (now() - query_start))::int AS query_age_s,
         substring(query, 1, 400) AS query,
         application_name,
         client_addr::text AS client_addr
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND state IS NOT NULL
         AND pid <> pg_backend_pid()
       ORDER BY query_start NULLS LAST`,
    );
    const contention = await q(
      client,
      `SELECT
         count(*) FILTER (WHERE wait_event_type IN ('IO', 'BufferPin')) AS io_waiting,
         count(*) FILTER (WHERE wait_event_type = 'Lock') AS lock_waiting,
         count(*) FILTER (WHERE state = 'active') AS active,
         count(*) FILTER (WHERE state = 'idle') AS idle,
         count(*) FILTER (WHERE state = 'idle in transaction') AS idle_in_xact,
         count(*) AS total
       FROM pg_stat_activity
       WHERE datname = current_database()`,
    );
    activitySamples.push({ sample_at: ts, rows });
    contentionSamples.push({ sample_at: ts, row: contention[0] });
    if (i < 5) await sleep(5_000);
  }
  console.log(`[iowait-diagnosis] activity/contention samples: ${activitySamples.length}`);

  // ── Section D — top tables by total size + hot table proxy ──────────────
  const sectionDSize = await q(
    client,
    `SELECT
       relname,
       pg_total_relation_size(c.oid) AS total_bytes,
       pg_relation_size(c.oid) AS heap_bytes,
       pg_indexes_size(c.oid) AS index_bytes,
       reltuples::bigint AS approx_rows
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY pg_total_relation_size(c.oid) DESC
     LIMIT 25`,
  );
  const sectionDHot = await q(
    client,
    `SELECT
       relname,
       seq_scan, seq_tup_read,
       idx_scan, idx_tup_fetch,
       n_live_tup, n_dead_tup,
       n_tup_ins, n_tup_upd, n_tup_del, n_tup_hot_upd
     FROM pg_stat_user_tables
     WHERE schemaname = 'public'
     ORDER BY (COALESCE(seq_tup_read,0) + COALESCE(idx_tup_fetch,0)) DESC
     LIMIT 25`,
  );

  // ── Section E — low-scan and duplicate indexes ──────────────────────────
  const sectionELowIdx = await q(
    client,
    `SELECT
       schemaname, relname AS table_name, indexrelname AS index_name,
       idx_scan, idx_tup_read, idx_tup_fetch,
       pg_relation_size(indexrelid) AS size_bytes
     FROM pg_stat_user_indexes
     WHERE schemaname = 'public'
     ORDER BY idx_scan ASC, pg_relation_size(indexrelid) DESC
     LIMIT 60`,
  );
  // Duplicate-shape indexes: same table + same indkey column list.
  const sectionEDupIdx = await q(
    client,
    `WITH idx AS (
       SELECT
         i.indrelid::regclass::text AS table_name,
         c.relname AS index_name,
         array_to_string(i.indkey, ' ') AS keylist,
         pg_relation_size(c.oid) AS size_bytes,
         i.indisunique AS is_unique,
         i.indisprimary AS is_primary,
         pg_get_indexdef(c.oid) AS indexdef
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
     )
     SELECT a.table_name, a.index_name, a.size_bytes, a.is_unique, a.is_primary,
            b.index_name AS dup_of, b.size_bytes AS dup_size,
            a.indexdef, b.indexdef AS dup_indexdef
     FROM idx a
     JOIN idx b
       ON a.table_name = b.table_name
      AND a.keylist = b.keylist
      AND a.index_name < b.index_name
     ORDER BY a.size_bytes + b.size_bytes DESC`,
  );

  // ── Section F — bloat / vacuum status ───────────────────────────────────
  const sectionF = await q(
    client,
    `SELECT
       relname,
       n_live_tup, n_dead_tup,
       ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
       last_vacuum, last_autovacuum,
       last_analyze, last_autoanalyze,
       vacuum_count, autovacuum_count
     FROM pg_stat_user_tables
     WHERE schemaname = 'public'
     ORDER BY n_dead_tup DESC NULLS LAST
     LIMIT 25`,
  );

  await client.end();

  const dump: AuditDump = {
    run_at: new Date().toISOString(),
    db_host: dbHost,
    active_supabase_url: process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "<unset>",
    section_a: sectionA,
    section_b_top25: sectionB,
    section_c_activity_samples: activitySamples,
    section_c_contention_samples: contentionSamples,
    section_d_top_tables: sectionDSize,
    section_d_hot_tables: sectionDHot,
    section_e_low_idx: sectionELowIdx,
    section_e_duplicate_idx: sectionEDupIdx,
    section_f_bloat: sectionF,
  };

  await mkdir(AUDITS_DIR, { recursive: true });
  const outPath = join(AUDITS_DIR, "2026-05-24-iowait-diagnosis.json");
  await writeFile(outPath, JSON.stringify(dump, null, 2), "utf8");
  console.log(`[iowait-diagnosis] wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
