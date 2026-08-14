#!/usr/bin/env node
// fix1023-delete-non-official-arm1.mjs
//
// FIX-1023 — the one-off data half. The durable half (the invariant assertion in
// donor_rollup_bulk_assert_invariants()) shipped in migration
// 20260813020000_fix1023_arm_official_only_invariant.sql; that migration
// deliberately does NOT carry the delete, because a 438k-row DELETE plus its
// mandatory VACUUM is a data-state operation and data-state operations are run
// per-environment, not propagated by `supabase db push` (CLAUDE.md — "Data-state
// changes vs schema changes").
//
// WHAT IT DELETES. Rows in official_donor_rollup_mv (arm 1) whose official_id is
// not in `officials`. Arm 1 was the only arm written for every recipient rather
// than only officials; FIX-1018 then stopped enumerating non-official recipients
// entirely, so those rows are neither refreshed nor deleted — frozen at their
// 2026-08-08 values and drifting. Craig chose option (a) on 2026-08-12: delete
// them. Arms 2-6 already hold zero non-official ids, so this is arm 1 alone.
//
// WHY A SCRIPT AND NOT scripts/db-query.mjs. That helper hard-wires --prod to
// READ ONLY inside a single transaction, which is exactly the property worth
// keeping. Two things here need the opposite: the DELETE writes, and VACUUM
// cannot run inside a transaction block at all. So psql is invoked WITHOUT
// --single-transaction (statement-at-a-time autocommit) from a script whose
// blast radius is one hard-coded predicate.
//
// WHY THE VACUUM IS NOT OPTIONAL. Standing convention (FIX-943): any script that
// bulk-rewrites a table ends by vacuuming what it rewrote. 438k dead tuples land
// inside the autovacuum threshold window all at once, and a heap page loses its
// all-visible mark if ANY tuple on it is dead — which is how FIX-884 turned a
// 0.9% dead ratio into 34,534 heap fetches and 20.5s of a 22.1s query.
//
//   node scripts/fix1023-delete-non-official-arm1.mjs --prod  --confirm
//   node scripts/fix1023-delete-non-official-arm1.mjs --local --confirm
//   node scripts/fix1023-delete-non-official-arm1.mjs --prod            (dry run)
//
// Without --confirm it counts and reports, writing nothing.

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = join(ROOT, ".env.local.prod");
const POOLER_FILE = join(ROOT, "supabase", ".temp", "pooler-url");
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const POOLER_FALLBACK = `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;
const LOCAL_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const argv = process.argv.slice(2);
const target = argv.includes("--prod") ? "prod" : argv.includes("--local") ? "local" : null;
const confirm = argv.includes("--confirm");

if (!target) {
  console.error("usage: fix1023-delete-non-official-arm1.mjs --prod|--local [--confirm]");
  process.exit(2);
}

function readEnvVar(file, key) {
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[1] === key) return m[2].trim();
  }
  return null;
}

let url, label;
if (target === "local") {
  url = LOCAL_URL;
  label = "LOCAL (127.0.0.1:54322)";
} else {
  const password = readEnvVar(ENV_FILE, "SUPABASE_DB_PASSWORD");
  if (!password) {
    console.error(`[fix1023] SUPABASE_DB_PASSWORD not found in ${ENV_FILE}`);
    process.exit(2);
  }
  const baseUrl = existsSync(POOLER_FILE)
    ? readFileSync(POOLER_FILE, "utf8").trim()
    : POOLER_FALLBACK;
  url = baseUrl.replace(/^(postgresql:\/\/[^/@:]+)@/, `$1:${encodeURIComponent(password)}@`);
  label = "PROD (Supabase Pro) — WRITE";
}

// The DELETE, its VACUUM, and the invariant re-check. `officials` is the sole
// authority for "is this recipient an official" — same predicate the assertion
// in donor_rollup_bulk_assert_invariants() uses, so a pass afterwards is
// meaningful rather than tautological.
const DELETE_SQL = `
\\timing on
\\echo '--- BEFORE ---'
SELECT count(*) AS total_rows,
       count(*) FILTER (WHERE NOT EXISTS (
         SELECT 1 FROM officials o WHERE o.id = m.official_id)) AS non_official_rows,
       count(DISTINCT m.official_id) FILTER (WHERE NOT EXISTS (
         SELECT 1 FROM officials o WHERE o.id = m.official_id)) AS non_official_ids
FROM official_donor_rollup_mv m;

\\echo '--- DELETE ---'
SET statement_timeout = '30min';
DELETE FROM public.official_donor_rollup_mv m
WHERE NOT EXISTS (SELECT 1 FROM public.officials o WHERE o.id = m.official_id);

\\echo '--- VACUUM (ANALYZE) — FIX-943, not optional after a bulk rewrite ---'
VACUUM (ANALYZE) public.official_donor_rollup_mv;

\\echo '--- AFTER ---'
SELECT count(*) AS total_rows,
       count(*) FILTER (WHERE NOT EXISTS (
         SELECT 1 FROM officials o WHERE o.id = m.official_id)) AS non_official_rows
FROM official_donor_rollup_mv m;

SELECT last_vacuum, last_analyze, n_dead_tup, n_live_tup
FROM pg_stat_user_tables WHERE relname = 'official_donor_rollup_mv';

\\echo '--- INVARIANT GATE (expect: PASSED) ---'
DO $$
BEGIN
  PERFORM public.donor_rollup_bulk_assert_invariants();
  RAISE NOTICE 'donor_rollup_bulk_assert_invariants(): PASSED';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'donor_rollup_bulk_assert_invariants(): STILL REFUSES — %', left(SQLERRM, 300);
END $$;
`;

const DRY_SQL = `
SELECT count(*) AS total_rows,
       count(*) FILTER (WHERE NOT EXISTS (
         SELECT 1 FROM officials o WHERE o.id = m.official_id)) AS would_delete_rows,
       count(DISTINCT m.official_id) FILTER (WHERE NOT EXISTS (
         SELECT 1 FROM officials o WHERE o.id = m.official_id)) AS would_delete_ids
FROM official_donor_rollup_mv m;
`;

console.error(`[fix1023] ${label}`);
console.error(`[fix1023] mode: ${confirm ? "APPLY (delete + vacuum + assert)" : "DRY RUN (count only)"}`);

// No --single-transaction: VACUUM cannot run inside a transaction block.
const res = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1"], {
  stdio: ["pipe", "inherit", "inherit"],
  input: confirm ? DELETE_SQL : DRY_SQL,
  shell: process.platform === "win32",
});
if (res.error) {
  console.error(`[fix1023] failed to launch psql: ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status ?? 1);
