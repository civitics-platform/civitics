#!/usr/bin/env node
// fix1180-build-votes-index.mjs — ONE authorized prod DDL write (FIX-1180).
//
// Builds, CONCURRENTLY and out-of-band, the index that lets get_official_page's
// `recent_votes` sub-query use an index scan instead of scanning an official's
// entire vote history:
//
//   CREATE INDEX CONCURRENTLY IF NOT EXISTS votes_official_voted_at_desc
//     ON public.votes (official_id, voted_at DESC NULLS LAST);
//
// WHY THIS INDEX AND NOT THE ONE THAT EXISTS: `votes_official_voted_at` is
// (official_id, voted_at) ASC. `recent_votes` orders by `voted_at DESC NULLS
// LAST`, and scanning an ASC index backwards yields DESC NULLS *FIRST* — a
// different ordering, so the planner cannot use it. Measured on the clone
// (cc-137 §3): Warnock's page bitmap-scans all 1,875 of his votes and top-N
// sorts to 100, at 6,034 buffers for that section; with this index it is 731.
// Whole-RPC 13,274 -> 7,989 buffers (-40 %); the worst official measured on the
// clone (2,530 votes) 14,882 -> 7,702 (-48 %). 408 officials have >1,000 votes.
// `voted_at` has ZERO nulls (0 of 982,966 on prod), so NULLS LAST buys nothing
// today — but the RPC body is NOT being changed, so the index matches its exact
// text. That is the whole point of option (A): it cannot change which rows a
// page shows.
//
// WHY OUT-OF-BAND rather than a migration push: CREATE INDEX CONCURRENTLY cannot
// run inside a transaction block, and `supabase db push` wraps each migration in
// one. A plain CREATE INDEX would take ACCESS EXCLUSIVE on a 571 MB / 983k-row
// table for the whole build, blocking every reader of `votes` — which is every
// official page. So the index is pre-built here, in a supervised window, and the
// companion migration (20260920020000_fix1180_votes_official_voted_at_desc.sql)
// carries the same DDL as CREATE INDEX IF NOT EXISTS: a no-op against prod
// afterwards, and the real build path for local / any rebuilt-from-zero
// environment. This mirrors the FIX-1118 and FIX-883 precedents.
//
// SAFETY NOTES
//  * CONCURRENTLY takes only SHARE UPDATE EXCLUSIVE: it does not block reads or
//    writes. It does two passes over the table and WAITS for transactions older
//    than each pass to finish, so a long-running transaction elsewhere stalls it.
//    The script prints the oldest transactions before it starts.
//  * statement_timeout is set as its OWN statement before the build (FIX-1128:
//    a routine-level SET bounds nothing; the caller's statement is what carries
//    the timer). 30 min is a runaway backstop, not an expectation — the build is
//    seconds-to-a-minute on a table this size.
//  * IF A CIC FAILS OR IS CANCELLED it leaves an INVALID index behind, which
//    still costs writes but serves no reads. This script does NOT auto-drop it —
//    dropping is a destructive op needing explicit confirmation. It reports
//    indisvalid=false loudly and prints the exact DROP INDEX CONCURRENTLY to run.
//  * Re-running after a successful build is a no-op (IF NOT EXISTS).
//
// USAGE — run from the PRIMARY checkout, or pass --env-file, because a worktree's
// .env.local.prod is a stub with no SUPABASE_DB_PASSWORD:
//   node scripts/fix1180-build-votes-index.mjs --dry-run
//   node scripts/fix1180-build-votes-index.mjs --env-file c:/…/App/.env.local.prod

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POOLER_FILE = join(ROOT, "supabase", ".temp", "pooler-url");
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const POOLER_FALLBACK = `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;

const INDEX_NAME = "votes_official_voted_at_desc";
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
  console.error(`[fix1180] SUPABASE_DB_PASSWORD not found in ${ENV_FILE}`);
  console.error(
    `[fix1180] a worktree's .env.local.prod is a stub — pass --env-file <primary checkout>/.env.local.prod`,
  );
  process.exit(2);
}
const baseUrl = existsSync(POOLER_FILE) ? readFileSync(POOLER_FILE, "utf8").trim() : POOLER_FALLBACK;
const url = baseUrl.replace(/^(postgresql:\/\/[^/@:]+)@/, `$1:${encodeURIComponent(password)}@`);
if (url === baseUrl) {
  console.error(`[fix1180] could not inject password into pooler URL: ${baseUrl}`);
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

SET statement_timeout = '30min';
${
  DRY_RUN
    ? `\\echo '--- DRY RUN — would CREATE INDEX CONCURRENTLY ${INDEX_NAME} ---'`
    : `\\echo '--- building CONCURRENTLY (no ACCESS EXCLUSIVE; reads and writes continue) ---'
CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}
  ON public.votes (official_id, voted_at DESC NULLS LAST);

COMMENT ON INDEX public.${INDEX_NAME} IS
  'FIX-1180 (A) — matches get_official_page recent_votes ORDER BY voted_at DESC '
  'NULLS LAST exactly, which votes_official_voted_at (ASC) cannot serve: a '
  'backward scan of it is DESC NULLS FIRST. Turns a full per-official vote-history '
  'bitmap scan + top-N sort into an index scan (clone: section 6,034 -> 731 '
  'buffers, whole RPC -40 to -48 %). Built CONCURRENTLY out-of-band 2026-09-20.';`
}

\\echo '--- post: indisvalid MUST be t ---'
SELECT c.relname, i.indisvalid, i.indisready, pg_size_pretty(pg_relation_size(c.oid)) AS size
FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
WHERE c.relname = '${INDEX_NAME}';

\\echo '--- post: pg_stat_user_indexes (idx_scan starts at 0; the planner has to pick it up) ---'
SELECT relname, indexrelname, idx_scan, idx_tup_read, idx_tup_fetch
FROM pg_stat_user_indexes
WHERE indexrelname = '${INDEX_NAME}';
`;

console.error(
  `[fix1180] PROD (Supabase Pro) — ${DRY_RUN ? "DRY RUN" : `WRITE: CREATE INDEX CONCURRENTLY ${INDEX_NAME}`}`,
);
if (!DRY_RUN) {
  console.error(`[fix1180] if this fails or is cancelled it leaves an INVALID index. The cleanup is:`);
  console.error(`[fix1180]   DROP INDEX CONCURRENTLY public.${INDEX_NAME};`);
}
const res = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1"], {
  stdio: ["pipe", "inherit", "inherit"],
  input: sql,
  shell: process.platform === "win32",
});
if (res.error) {
  console.error(`[fix1180] failed to launch psql: ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status ?? 1);
