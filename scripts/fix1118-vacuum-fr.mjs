#!/usr/bin/env node
// fix1118-vacuum-fr.mjs — ONE authorized prod maintenance write (FIX-1118).
//
//   VACUUM (ANALYZE) public.financial_relationships;
//
// WHY THIS IS PART OF FIX-1118 AND NOT HOUSEKEEPING. The FIX-1118 partial index
// makes the contracts-arm source fingerprint an INDEX-ONLY scan — the 3.9M-row
// Bitmap Heap Scan is gone from the plan. But an index-only scan may only skip
// the heap for pages the VISIBILITY MAP marks all-visible, and a heap page loses
// that mark if ANY tuple on it is dead. Measured on prod 2026-09-01 immediately
// after the index was built:
//
//   max(updated_at)  271.9 ms   <- Index Only Scan Backward, O(1). Fixed.
//   count(*)         cancelled at 4m27s, stalled on IO/DataFileRead. NOT fixed.
//
// The real probe (public.ec_arm_source_fingerprint) computes BOTH in a single
// query, so count(*) sets the price and the index alone buys nothing. The heap
// fetches are the whole cost, and the visibility map is why: financial_relationships
// showed vacuum_count = 1 for all time, last_autovacuum NULL, and 187,000 updates
// plus 37,838 inserts accumulated since its only vacuum (2026-08-31 01:03). Same
// coupling as FIX-884 (0.9% all-visible -> 34,534 heap fetches, 20.5 s of a 22.1 s
// query) and the FIX-943 bulk-rewrite vacuum rule.
//
// So: the index is necessary, the vacuum makes it sufficient. Re-gating the arm
// before this runs would reinstate a multi-minute probe on every cycle — which is
// worse than the un-gated arm it replaces. fix1118-regate-contracts-arm.mjs is
// deliberately run AFTER this.
//
// COST AND SAFETY. This is the identical statement the weekly jobid 38
// (fr-vacuum-analyze, Mondays 01:00 UTC) already issues; running it here is that
// job five days early. Its last three firings took 227.2 s, 20.3 s and 97.8 s, so
// budget ~4 minutes. VACUUM (never VACUUM FULL) takes only SHARE UPDATE EXCLUSIVE:
// it does not block reads or writes and does not rewrite the table. It cannot run
// inside a transaction block, hence psql autocommit rather than a migration.
// Schedule it against a quiet box — this run went out with ec-crawl and fe-crawl
// both peer-backed-off, i.e. no crawl unit competing for the same I/O.
//
// USAGE — run from the PRIMARY checkout, or pass --env-file, because a worktree's
// .env.local.prod is a stub with no SUPABASE_DB_PASSWORD:
//   node scripts/fix1118-vacuum-fr.mjs --dry-run
//   node scripts/fix1118-vacuum-fr.mjs --env-file c:/…/App/.env.local.prod

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POOLER_FILE = join(ROOT, "supabase", ".temp", "pooler-url");
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const POOLER_FALLBACK = `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;

const TABLE = "public.financial_relationships";
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

const sql = `
\\timing on
\\echo '--- BEFORE ---'
SELECT n_live_tup, n_dead_tup, n_tup_ins, n_tup_upd, vacuum_count, last_vacuum
FROM pg_stat_user_tables WHERE relname = 'financial_relationships';

SET statement_timeout = 0;
${DRY_RUN
  ? `\\echo '--- DRY RUN — would VACUUM (ANALYZE) ${TABLE} ---'`
  : `\\echo '--- VACUUM (ANALYZE) — SHARE UPDATE EXCLUSIVE only; reads and writes continue ---'
VACUUM (ANALYZE) ${TABLE};`}

\\echo '--- AFTER: last_vacuum must have moved, n_dead_tup must have dropped ---'
SELECT n_live_tup, n_dead_tup, vacuum_count, last_vacuum, last_analyze
FROM pg_stat_user_tables WHERE relname = 'financial_relationships';
`;

console.error(`[fix1118] PROD (Supabase Pro) — ${DRY_RUN ? "DRY RUN" : `WRITE: VACUUM (ANALYZE) ${TABLE}`}`);
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
