#!/usr/bin/env node
// fix1152-rebuild-search-index-prod.mjs — ONE authorized prod DATA write.
//
// Set A of the 2026-09-05 prod data pass: a supervised, receipt-bearing manual
// call of public.rebuild_entity_search_index() against Supabase Pro.
//
// WHY OUT-OF-BAND: the function is a unit of refresh_derived_mvs('daily')
// (jobid 9, 06:00 UTC) and has been cancelled by the FIX-1030 per-unit watchdog
// on 09-03 (1017.4 s) and 09-04 (1015.0 s) against a 900 s unit budget, after
// running 202.5 s on 09-02. entity_search_index.refreshed_at has been frozen at
// 2026-09-02 06:05:15 ever since, so every search / typeahead / browse surface
// serves a stale index, and the prod receipts for FIX-942 (the index reading
// official_donor_totals instead of the deprecated officials.total_received_cents)
// and the FIX-939 read half (86 merge stubs leaving the index) are both blocked
// behind a rebuild that completes.
//
// THE CAUSE IS NOT THIS SCRIPT'S PROBLEM TO FIX (FIX-1152 stays open). Measured
// on prod 2026-09-05 02:18 UTC, one of the sixteen entity_search_conn_window()
// windows (00000000... -> 10000000...):
//
//   HashAggregate (actual time=62870.161..62951.818 rows=301858)
//     ->  Index Only Scan ..._from_id_connection_type   Heap Fetches: 208809
//     ->  Index Only Scan ..._to_id_connection_type     Heap Fetches: 163717
//   Execution Time: 62971.513 ms
//
// entity_connections carries 325,127 dead tuples (3.00%) and relallvisible /
// relpages = 296,885 / 373,641 = 79.46%. A heap page loses its all-visible mark
// if ANY tuple on it is dead, so both index-only scans degrade to a per-row heap
// fetch — the FIX-884 / FIX-943 class exactly. The window holds 1,302,740 of the
// ~21M id-slots, i.e. exactly 1/16, and 16 x 62.97 s = 1,007 s against the
// observed unit of 1,015.0 s. The arithmetic closes; the durable fix is vacuum
// cadence on entity_connections (jobid 6, Sun/Wed 02:00 UTC), not a bigger
// budget. Do NOT raise the budget or the timeout here.
//
// SAFETY NOTES
//  * SESSION-level statement_timeout, not the function's. The function carries
//    SET statement_timeout TO '1200s' in proconfig, but per the FIX-748 note in
//    scratchpad/prod_rebuild_search.sql the function-level SET is a no-op for the
//    statement that ENTERS the function — the timeout is armed at statement
//    start. So the cap is set on the session here, explicitly, at 1200 s.
//  * The function is ONE statement. A cancel rolls it back cleanly and
//    entity_search_index keeps its existing rows — no corruption, no partial
//    index. That is why a timeout is a measurement, not an incident.
//  * NOT watched by the FIX-1030 unit watchdog (it publishes no backend_pid),
//    so nothing external will reap it before 1200 s. It prints its own backend
//    pid on start so a second session can watch it.
//  * Read-only pre/post receipts run in the SAME session as the rebuild.
//
// USAGE — from the PRIMARY checkout (a worktree's .env.local.prod is a stub):
//   node scripts/fix1152-rebuild-search-index-prod.mjs --dry-run
//   node scripts/fix1152-rebuild-search-index-prod.mjs

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POOLER_FILE = join(ROOT, "supabase", ".temp", "pooler-url");
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const POOLER_FALLBACK = `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;

const DRY_RUN = process.argv.includes("--dry-run");

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const ENV_FILE = argValue("--env-file", join(ROOT, ".env.local.prod"));

function readEnvVar(file, key) {
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[1] === key) return m[2].trim();
  }
  return null;
}

const password = readEnvVar(ENV_FILE, "SUPABASE_DB_PASSWORD");
if (!password) {
  console.error(`[fix1152] SUPABASE_DB_PASSWORD not found in ${ENV_FILE}`);
  process.exit(2);
}
const baseUrl = existsSync(POOLER_FILE)
  ? readFileSync(POOLER_FILE, "utf8").trim()
  : POOLER_FALLBACK;
const url = baseUrl.replace(/^(postgresql:\/\/[^/@:]+)@/, `$1:${encodeURIComponent(password)}@`);
if (url === baseUrl) {
  console.error(`[fix1152] could not inject password into pooler URL: ${baseUrl}`);
  process.exit(2);
}

// NO psql META-COMMANDS anywhere in this template (the FIX-1142 note): a
// singled backslash becomes a literal TAB in some heredoc/shell paths and psql
// then fails on it. Plain SELECTs carry the labels; timing is done in JS.
const RECEIPTS = `
SELECT '--- receipt: entity_search_index ---' AS step;
SELECT count(*) AS rows, max(refreshed_at) AS max_refreshed FROM public.entity_search_index;

SELECT '--- receipt: merge-stub rows resident in the index (FIX-939, want 0 after) ---' AS step;
SELECT count(*) AS stub_rows_in_index
FROM public.entity_search_index esi
JOIN public.officials o ON o.id = esi.entity_id
WHERE o.source_ids ?| array['merged_fec_candidate_id','merged_fec_candidate_ids','merged_into'];

SELECT '--- receipt: indexed money vs rollup for merge survivors (FIX-942, want drift 0) ---' AS step;
SELECT o.full_name,
       o.total_received_cents AS deprecated_col,
       odt.total_cents        AS rollup_cents,
       esi.amount_cents       AS indexed_cents,
       (esi.amount_cents - COALESCE(odt.total_cents,0)) AS drift
FROM public.officials o
JOIN public.entity_search_index esi ON esi.entity_id = o.id AND esi.kind = 'official'
LEFT JOIN public.official_donor_totals odt ON odt.official_id = o.id
WHERE o.tier = 'elected'
  AND EXISTS (SELECT 1 FROM public.officials s
               WHERE s.source_ids->>'merged_fec_candidate_id' = o.source_ids->>'fec_candidate_id')
ORDER BY abs(COALESCE(esi.amount_cents,0) - COALESCE(odt.total_cents,0)) DESC
LIMIT 6;
`;

const sql = `
SELECT '=== PRE ===' AS phase;
${RECEIPTS}
SELECT '--- pre: pipelines running / long transactions ---' AS step;
SELECT count(*) AS running_pipelines FROM public.data_sync_log WHERE status = 'running';
SELECT pid, state, round(EXTRACT(epoch FROM (now()-xact_start))::numeric,1) AS xact_age_s
FROM pg_stat_activity
WHERE datname = current_database() AND pid <> pg_backend_pid() AND xact_start IS NOT NULL
ORDER BY xact_start LIMIT 5;

SELECT '--- this backend pid (watch it from another session) ---' AS step;
SELECT pg_backend_pid() AS rebuild_pid, now() AT TIME ZONE 'utc' AS started_utc;

SET statement_timeout = '1200s';
${DRY_RUN
  ? `SELECT '=== DRY RUN — would SELECT public.rebuild_entity_search_index() ===' AS phase;`
  : `SELECT '=== REBUILD (session statement_timeout = 1200s) ===' AS phase;
SELECT public.rebuild_entity_search_index() AS index_rows;`}

SELECT '=== POST ===' AS phase;
${RECEIPTS}
`;

console.error(
  `[fix1152] PROD (Supabase Pro) — ${DRY_RUN ? "DRY RUN" : "WRITE: rebuild_entity_search_index()"}`,
);
console.error(`[fix1152] expected wall time ~1000-1100 s (16 windows x ~63 s); session cap 1200 s.`);
console.error(`[fix1152] a timeout is a clean rollback — the index keeps its existing rows.`);
const t0 = Date.now();
const res = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1"], {
  stdio: ["pipe", "inherit", "inherit"],
  input: sql,
  shell: process.platform === "win32",
});
if (res.error) {
  console.error(`[fix1152] failed to launch psql: ${res.error.message}`);
  process.exit(1);
}
console.error(`[fix1152] psql wall clock: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(res.status ?? 1);
