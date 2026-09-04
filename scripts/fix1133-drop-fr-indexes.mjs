#!/usr/bin/env node
// fix1133-drop-fr-indexes.mjs — the ONE authorized prod DDL write for FIX-1133.
//
// Drops the financial_relationships indexes that the index census
// (docs/audits/fr-index-census-2026-09.md) classified as Class C — unreferenced
// AND safe to remove — one statement at a time, CONCURRENTLY, out-of-band.
//
// THE SET IS ONE INDEX. That is the census's finding, not a shortcut:
//
//   financial_relationships_fec_filing_unique   8192 bytes
//     UNIQUE partial on a column with ZERO non-NULL rows (prod and clone),
//     referenced nowhere in pg_proc.prosrc / pg_matviews / apps/ / packages/
//     outside the generated database.ts, arbitrating no ON CONFLICT.
//
// The prior "six never scanned, ~1,224 MB" read did not survive the window
// check: statistics were discarded at the 2026-08-29 outage, so the window is
// 6.6 days, and 1,091 of those 1,224 MB are financial_relationships_pkey (a
// PRIMARY KEY) plus financial_relationships_usaspending_unique (a live
// ON CONFLICT arbiter whose pipeline is manual-only). idx_scan never counts
// uniqueness enforcement — role decides those, not the counter.
//
// WHY OUT-OF-BAND rather than a migration push: DROP INDEX CONCURRENTLY cannot
// run inside a transaction block, and `supabase db push` wraps each migration in
// one. A plain DROP INDEX takes ACCESS EXCLUSIVE on a 14.5M-row table for the
// duration, blocking every reader. The companion migration
// (20260904030000_fix1133_drop_dead_fr_indexes.sql) carries the same drop as
// DROP INDEX IF EXISTS — a no-op against prod afterwards, and the real build
// path for local. This mirrors FIX-1118 and FIX-1142 exactly.
//
// SAFETY NOTES
//  * DROP INDEX CONCURRENTLY takes only SHARE UPDATE EXCLUSIVE, but it WAITS for
//    every transaction currently touching the table. A long-running transaction
//    elsewhere stalls it. The pre-flight below reports old xact_start values and
//    any running pipeline; read it before answering the prompt.
//  * It CANNOT drop an index backing a constraint. financial_relationships_pkey
//    is such an index and is not in this set; the pre-flight asserts every
//    target has no pg_constraint row, and the script aborts if one does.
//  * Each target's pg_get_indexdef, size and idx_scan are printed BEFORE its
//    drop, so the recreate DDL is in the terminal scrollback even if this
//    session is lost. It is also recorded in the census doc.
//  * statement_timeout is 0 and lock_timeout is 30s for this session only: we
//    would rather fail to acquire the lock than sit on a lock queue in front of
//    the front door.
//  * Targets are dropped smallest-first.
//
// WINDOW: run in the 18:00-01:00 UTC slack window. Not during a Tuesday receipt
// firing (00:05 / 00:47 / 14:00 / 15:00 UTC) and not inside the 05:45-09:00 UTC
// blackout stack. jobid 38 fr-vacuum-analyze fires Mondays 01:00 UTC.
//
// USAGE — run from the PRIMARY checkout, or pass --env-file, because a
// worktree's .env.local.prod is a stub with no SUPABASE_DB_PASSWORD:
//   node scripts/fix1133-drop-fr-indexes.mjs --dry-run
//   node scripts/fix1133-drop-fr-indexes.mjs

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POOLER_FILE = join(ROOT, "supabase", ".temp", "pooler-url");
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const POOLER_FALLBACK = `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;

// Smallest first. Each entry is Class C in docs/audits/fr-index-census-2026-09.md.
const TARGETS = ["financial_relationships_fec_filing_unique"];

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
  console.error(`[fix1133] SUPABASE_DB_PASSWORD not found in ${ENV_FILE}`);
  console.error(`[fix1133] a worktree's .env.local.prod is a stub — pass --env-file <primary checkout>/.env.local.prod`);
  process.exit(2);
}
const baseUrl = existsSync(POOLER_FILE)
  ? readFileSync(POOLER_FILE, "utf8").trim()
  : POOLER_FALLBACK;
const url = baseUrl.replace(/^(postgresql:\/\/[^/@:]+)@/, `$1:${encodeURIComponent(password)}@`);
if (url === baseUrl) {
  console.error(`[fix1133] could not inject password into pooler URL: ${baseUrl}`);
  process.exit(2);
}

const nameList = TARGETS.map((t) => `'${t}'`).join(", ");

// NOTE: no explicit BEGIN anywhere — psql autocommit is what lets CONCURRENTLY
// run. NO psql meta-commands (\timing, \echo) anywhere in this template: they
// need a doubled backslash to survive a JS template literal and that pair does
// not survive every shell/heredoc that might edit this file. Plain SELECTs carry
// the section labels; the run is timed in JS below.
const preflight = `
SELECT '--- pre: total FR index bytes BEFORE ---' AS step;
SELECT count(*) AS index_count,
       pg_size_pretty(sum(pg_relation_size(indexrelid))) AS total_index_size,
       sum(pg_relation_size(indexrelid)) AS total_index_bytes
FROM pg_index WHERE indrelid = 'public.financial_relationships'::regclass;

SELECT '--- pre: FR table state ---' AS step;
SELECT n_live_tup, n_dead_tup, n_tup_upd, n_tup_hot_upd, last_vacuum, vacuum_count
FROM pg_stat_user_tables WHERE relname = 'financial_relationships';

SELECT '--- pre: transactions older than 60s (these STALL a CONCURRENTLY drop) ---' AS step;
SELECT pid, state, left(query, 60) AS query,
       round(EXTRACT(epoch FROM (now()-xact_start))::numeric,1) AS xact_age_s
FROM pg_stat_activity
WHERE datname = current_database() AND pid <> pg_backend_pid()
  AND xact_start IS NOT NULL AND now() - xact_start > interval '60 seconds'
ORDER BY xact_start;

SELECT '--- pre: any cron job currently running ---' AS step;
SELECT jobid, status, start_time FROM cron.job_run_details
WHERE status = 'running' ORDER BY start_time;

SELECT '--- pre: jobid 38 fr-vacuum-analyze — must not be due within the hour ---' AS step;
SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobid = 38;

SELECT '--- pre: ABORT IF ANY TARGET BACKS A CONSTRAINT ---' AS step;
DO $abort$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO v_bad
  FROM pg_class c
  JOIN pg_index i ON i.indexrelid = c.oid
  JOIN pg_constraint k ON k.conindid = c.oid
  WHERE c.relname IN (${nameList});
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'target(s) back a constraint and cannot be dropped concurrently: %', v_bad;
  END IF;
END
$abort$;

SELECT '--- RECREATE DDL — saved before any drop ---' AS step;
SELECT pg_get_indexdef(i.indexrelid) || ';' AS recreate_ddl,
       pg_size_pretty(pg_relation_size(i.indexrelid)) AS size,
       s.idx_scan
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = i.indexrelid
WHERE c.relname IN (${nameList})
ORDER BY pg_relation_size(i.indexrelid);
`;

const drops = TARGETS.map(
  (t) => `
SELECT '--- dropping ${t} ---' AS step;
DROP INDEX CONCURRENTLY IF EXISTS public.${t};`,
).join("\n");

const post = `
SELECT '--- post: targets MUST be gone ---' AS step;
SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
WHERE c.relname IN (${nameList});

SELECT '--- post: total FR index bytes AFTER ---' AS step;
SELECT count(*) AS index_count,
       pg_size_pretty(sum(pg_relation_size(indexrelid))) AS total_index_size,
       sum(pg_relation_size(indexrelid)) AS total_index_bytes
FROM pg_index WHERE indrelid = 'public.financial_relationships'::regclass;

SELECT '--- post: FR table state ---' AS step;
SELECT n_live_tup, n_dead_tup, n_tup_upd, n_tup_hot_upd, last_vacuum, vacuum_count
FROM pg_stat_user_tables WHERE relname = 'financial_relationships';
`;

const sql = DRY_RUN
  ? `${preflight}\nSELECT '--- DRY RUN — would DROP INDEX CONCURRENTLY: ${TARGETS.join(", ")} ---' AS step;\n`
  : `${preflight}\nSET statement_timeout = 0;\nSET lock_timeout = '30s';\n${drops}\n${post}`;

console.error(
  `[fix1133] PROD (Supabase Pro) — ${DRY_RUN ? "DRY RUN" : `WRITE: DROP INDEX CONCURRENTLY ${TARGETS.length} index(es)`}`,
);
console.error(`[fix1133] targets: ${TARGETS.join(", ")}`);
if (!DRY_RUN) {
  console.error(`[fix1133] recreate DDL is printed by the pre-flight BEFORE any drop — keep the scrollback.`);
  console.error(`[fix1133] it is also recorded in docs/audits/fr-index-census-2026-09.md`);
}
const t0 = Date.now();
const res = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1"], {
  stdio: ["pipe", "inherit", "inherit"],
  input: sql,
  shell: process.platform === "win32",
});
if (res.error) {
  console.error(`[fix1133] failed to launch psql: ${res.error.message}`);
  process.exit(1);
}
console.error(`[fix1133] psql wall clock: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(res.status ?? 1);
