#!/usr/bin/env node
// fix1142-build-treemap-global-index.mjs — ONE authorized prod DDL write (FIX-1142).
//
// Builds, CONCURRENTLY and out-of-band, the covering partial index that turns
// refresh_treemap_individuals_global's per-chunk donor aggregation from an
// index-scan-plus-heap-fetch into an Index Only Scan:
//
//   CREATE INDEX CONCURRENTLY IF NOT EXISTS financial_relationships_treemap_global_rollup
//     ON public.financial_relationships (from_id) INCLUDE (amount_cents)
//     WHERE from_type = 'financial_entity'
//       AND relationship_type = 'donation'
//       AND to_type = 'official';
//
// WHY: financial_relationships_donation_size_rollup is the same shape MINUS the
// to_type predicate, so the planner cannot use it for the chunk's
// to_type='official' filter and falls back to financial_relationships_derivation
// plus a heap fetch per row for amount_cents. Measured under FIX-1142: 57,432
// reads per chunk on the derivation path against 2,423 on the covering path —
// 24x. Prod regressed from 43 s/chunk (2026-08-06, all 64 chunks in 2,779 s) to
// 451 s/chunk (2026-09-01, 12 chunks in 5,409.8 s) with no code change, as
// financial_entities grew past what 256 MB of shared_buffers can hold.
//
// WHY OUT-OF-BAND rather than a migration push: CREATE INDEX CONCURRENTLY cannot
// run inside a transaction block, and `supabase db push` wraps each migration in
// one. A plain (non-concurrent) CREATE INDEX would instead take ACCESS EXCLUSIVE
// on a 14M-row table for the whole build, blocking every reader of
// financial_relationships. So the index is pre-built here, in a supervised
// window, and the companion migration
// (20260904010000_fix1142_treemap_global_bounds_and_index.sql) carries the same
// DDL as CREATE INDEX IF NOT EXISTS — a no-op against prod afterwards, and the
// real build path for local / any rebuilt-from-zero environment. This mirrors
// the FIX-1118 precedent exactly.
//
// SAFETY NOTES
//  * CONCURRENTLY takes only SHARE UPDATE EXCLUSIVE: it does not block reads or
//    writes. It does two passes over the table and WAITS for transactions older
//    than each pass to finish, so a long-running transaction elsewhere stalls it.
//    Check pg_stat_activity for old xact_start values before running.
//  * statement_timeout is set to 0 for this session only — a multi-minute build
//    on a 14M-row table would otherwise be reaped by any role-level cap.
//  * IF A CIC FAILS OR IS CANCELLED it leaves an INVALID index behind, which
//    still costs writes but serves no reads. This script does NOT auto-drop it —
//    dropping is a destructive op needing explicit confirmation. It reports
//    indisvalid=false loudly and prints the exact DROP INDEX CONCURRENTLY to run.
//  * Re-running after a successful build is a no-op (IF NOT EXISTS).
//
// USAGE — run from the PRIMARY checkout, or pass --env-file, because a worktree's
// .env.local.prod is a stub with no SUPABASE_DB_PASSWORD:
//   node scripts/fix1142-build-treemap-global-index.mjs --dry-run
//   node scripts/fix1142-build-treemap-global-index.mjs

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POOLER_FILE = join(ROOT, "supabase", ".temp", "pooler-url");
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const POOLER_FALLBACK = `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;

const INDEX_NAME = "financial_relationships_treemap_global_rollup";
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
  console.error(`[fix1142] SUPABASE_DB_PASSWORD not found in ${ENV_FILE}`);
  console.error(`[fix1142] a worktree's .env.local.prod is a stub — pass --env-file <primary checkout>/.env.local.prod`);
  process.exit(2);
}
const baseUrl = existsSync(POOLER_FILE)
  ? readFileSync(POOLER_FILE, "utf8").trim()
  : POOLER_FALLBACK;
const url = baseUrl.replace(/^(postgresql:\/\/[^/@:]+)@/, `$1:${encodeURIComponent(password)}@`);
if (url === baseUrl) {
  console.error(`[fix1142] could not inject password into pooler URL: ${baseUrl}`);
  process.exit(2);
}

// NOTE: no explicit BEGIN anywhere — psql autocommit is what lets CONCURRENTLY run.
//
// NO psql META-COMMANDS (\timing, \echo) ANYWHERE IN THIS TEMPLATE, deliberately.
// They need a doubled backslash to survive a JS template literal, and that pair
// does not survive every shell/heredoc that might write or edit this file — a
// silently-singled `\t` becomes a literal TAB and psql then fails with
// `syntax error at or near "iming"`. Plain SELECTs carry the section labels
// instead, and the build is timed in JS below, which is more precise than
// \timing anyway.
const sql = `
SELECT '--- pre: any transaction older than the build would stall CONCURRENTLY ---' AS step;
SELECT pid, state, round(EXTRACT(epoch FROM (now()-xact_start))::numeric,1) AS xact_age_s
FROM pg_stat_activity
WHERE datname = current_database() AND pid <> pg_backend_pid() AND xact_start IS NOT NULL
ORDER BY xact_start LIMIT 10;

SELECT '--- pre: does the index already exist? ---' AS step;
SELECT c.relname, i.indisvalid, i.indisready, pg_size_pretty(pg_relation_size(c.oid)) AS size
FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
WHERE c.relname = '${INDEX_NAME}';

SET statement_timeout = 0;
${DRY_RUN
  ? `SELECT '--- DRY RUN — would CREATE INDEX CONCURRENTLY ${INDEX_NAME} ---' AS step;`
  : `SELECT '--- building CONCURRENTLY (no ACCESS EXCLUSIVE; reads and writes continue) ---' AS step;
CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}
  ON public.financial_relationships (from_id) INCLUDE (amount_cents)
  WHERE from_type = 'financial_entity'
    AND relationship_type = 'donation'
    AND to_type = 'official';

COMMENT ON INDEX public.${INDEX_NAME} IS
  'FIX-1142 — covering partial index over the ~6.6M individual-donation-to-official '
  'rows of financial_relationships. Makes refresh_treemap_individuals_global''s '
  'per-chunk donor aggregation an Index Only Scan (measured 57,432 reads/chunk on '
  'the derivation path vs 2,423 covering). Sibling of '
  'financial_relationships_donation_size_rollup, which lacks to_type and so cannot '
  'serve this query. Built CONCURRENTLY out-of-band 2026-09-04.';`}

SELECT '--- post: indisvalid MUST be t ---' AS step;
SELECT c.relname, i.indisvalid, i.indisready, pg_size_pretty(pg_relation_size(c.oid)) AS size
FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
WHERE c.relname = '${INDEX_NAME}';
`;

console.error(
  `[fix1142] PROD (Supabase Pro) — ${DRY_RUN ? "DRY RUN" : `WRITE: CREATE INDEX CONCURRENTLY ${INDEX_NAME}`}`,
);
if (!DRY_RUN) {
  console.error(`[fix1142] if this fails or is cancelled it leaves an INVALID index. The cleanup is:`);
  console.error(`[fix1142]   DROP INDEX CONCURRENTLY public.${INDEX_NAME};`);
}
const t0 = Date.now();
const res = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1"], {
  stdio: ["pipe", "inherit", "inherit"],
  input: sql,
  shell: process.platform === "win32",
});
if (res.error) {
  console.error(`[fix1142] failed to launch psql: ${res.error.message}`);
  process.exit(1);
}
console.error(`[fix1142] psql wall clock: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(res.status ?? 1);
