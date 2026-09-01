#!/usr/bin/env node
// fix1118-build-contract-grant-index.mjs — ONE authorized prod DDL write (FIX-1118).
//
// Builds, CONCURRENTLY and out-of-band, the partial index that makes the
// FIX-1117 source fingerprint for rebuild_entity_connections_contracts an
// index-only probe:
//
//   CREATE INDEX CONCURRENTLY IF NOT EXISTS financial_relationships_contract_grant_updated_at
//     ON public.financial_relationships (updated_at)
//     WHERE relationship_type IN ('contract','grant');
//
// WHY OUT-OF-BAND rather than a migration push: CREATE INDEX CONCURRENTLY cannot
// run inside a transaction block, and `supabase db push` wraps each migration in
// one. A plain (non-concurrent) CREATE INDEX would instead take ACCESS EXCLUSIVE
// on a 12 GB / 14.5M-row table for the whole build, blocking every reader of
// financial_relationships. So the index is pre-built here, in a supervised
// window, and the companion migration
// (20260901230000_fix1118_fr_contract_grant_updated_at_index.sql) carries the
// same DDL as CREATE INDEX IF NOT EXISTS — a no-op against prod afterwards, and
// the real build path for local / any rebuilt-from-zero environment. This
// mirrors the FIX-883 precedent.
//
// SAFETY NOTES
//  * CONCURRENTLY takes only SHARE UPDATE EXCLUSIVE: it does not block reads or
//    writes. It does two passes over the table and WAITS for transactions older
//    than each pass to finish, so a long-running transaction elsewhere stalls it.
//    Check pg_stat_activity for old xact_start values before running.
//  * statement_timeout is set to 0 for this session only — a multi-minute build
//    on a 12 GB table would otherwise be reaped by any role-level cap.
//  * IF A CIC FAILS OR IS CANCELLED it leaves an INVALID index behind, which
//    still costs writes but serves no reads. This script does NOT auto-drop it —
//    dropping is a destructive op needing explicit confirmation. It reports
//    indisvalid=false loudly and prints the exact DROP INDEX CONCURRENTLY to run.
//  * Re-running after a successful build is a no-op (IF NOT EXISTS).
//
// USAGE — run from the PRIMARY checkout, or pass --env-file, because a worktree's
// .env.local.prod is a stub with no SUPABASE_DB_PASSWORD:
//   node scripts/fix1118-build-contract-grant-index.mjs --dry-run
//   node scripts/fix1118-build-contract-grant-index.mjs --env-file c:/…/App/.env.local.prod

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POOLER_FILE = join(ROOT, "supabase", ".temp", "pooler-url");
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const POOLER_FALLBACK = `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;

const INDEX_NAME = "financial_relationships_contract_grant_updated_at";
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
  console.error(`[fix1118] SUPABASE_DB_PASSWORD not found in ${ENV_FILE}`);
  console.error(`[fix1118] a worktree's .env.local.prod is a stub — pass --env-file <primary checkout>/.env.local.prod`);
  process.exit(2);
}
const baseUrl = existsSync(POOLER_FILE)
  ? readFileSync(POOLER_FILE, "utf8").trim()
  : POOLER_FALLBACK;
const url = baseUrl.replace(/^(postgresql:\/\/[^/@:]+)@/, `$1:${encodeURIComponent(password)}@`);
if (url === baseUrl) {
  console.error(`[fix1118] could not inject password into pooler URL: ${baseUrl}`);
  process.exit(2);
}

// NOTE: no explicit BEGIN anywhere — psql autocommit is what lets CONCURRENTLY run.
const sql = `
\\timing on
\\echo '--- pre: any transaction older than the build would stall CONCURRENTLY ---'
SELECT pid, state, round(EXTRACT(epoch FROM (now()-xact_start))::numeric,1) AS xact_age_s
FROM pg_stat_activity
WHERE datname = current_database() AND pid <> pg_backend_pid() AND xact_start IS NOT NULL
ORDER BY xact_start LIMIT 10;

\\echo '--- pre: does the index already exist? ---'
SELECT c.relname, i.indisvalid, i.indisready, pg_size_pretty(pg_relation_size(c.oid)) AS size
FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
WHERE c.relname = '${INDEX_NAME}';

SET statement_timeout = 0;
${DRY_RUN
  ? `\\echo '--- DRY RUN — would CREATE INDEX CONCURRENTLY ${INDEX_NAME} ---'`
  : `\\echo '--- building CONCURRENTLY (no ACCESS EXCLUSIVE; reads and writes continue) ---'
CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}
  ON public.financial_relationships (updated_at)
  WHERE relationship_type IN ('contract', 'grant');

COMMENT ON INDEX public.${INDEX_NAME} IS
  'FIX-1118 — partial index on financial_relationships(updated_at) over the '
  '~3.9M contract/grant rows. Makes the FIX-1117 source fingerprint for '
  'rebuild_entity_connections_contracts an index-only probe (prod: 98s -> ms-class). '
  'Built CONCURRENTLY out-of-band 2026-09-01.';`}

\\echo '--- post: indisvalid MUST be t ---'
SELECT c.relname, i.indisvalid, i.indisready, pg_size_pretty(pg_relation_size(c.oid)) AS size
FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
WHERE c.relname = '${INDEX_NAME}';
`;

console.error(
  `[fix1118] PROD (Supabase Pro) — ${DRY_RUN ? "DRY RUN" : `WRITE: CREATE INDEX CONCURRENTLY ${INDEX_NAME}`}`,
);
if (!DRY_RUN) {
  console.error(`[fix1118] if this fails or is cancelled it leaves an INVALID index. The cleanup is:`);
  console.error(`[fix1118]   DROP INDEX CONCURRENTLY public.${INDEX_NAME};`);
}
const res = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1"], {
  stdio: ["pipe", "inherit", "inherit"],
  input: sql,
  shell: process.platform === "win32",
});
if (res.error) {
  console.error(`[fix1118] failed to launch psql: ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status ?? 1);
