#!/usr/bin/env node
// fix1297-build-fr-donation-updated-at-index.mjs — ONE authorized prod DDL write (FIX-1297, FIX-1293).
//
// Builds, CONCURRENTLY and out-of-band, the partial index that makes the
// donation-types MAX(updated_at) one probe and bounds the EC crawl tile's count
// by qualifying rows:
//
//   CREATE INDEX CONCURRENTLY IF NOT EXISTS financial_relationships_donation_updated_at
//     ON public.financial_relationships (updated_at)
//     WHERE relationship_type IN ('donation', 'ie_support', 'ie_oppose');
//
// WHY: three readers ask financial_relationships for donation-type rows by
// updated_at, and the only updated_at index is the unpartial
// financial_relationships_updated_at, with relationship_type as a Filter:
//
//   rebuild_ec_donations_incr_prepare  (20260903010000:2562-2564 the MAX,
//                                       :2577-2582 the dirty INSERT's range)
//   donor_rollup_rebuild_bulk          (20261009030000:1726-1728 the MAX)
//   get_ec_crawl_health                (20261010030000:86-94 the tile's count)
//
// When anything other than a donation row sits at the head of that index (the
// 10-08 USASpending contract rewrite, FIX-1291), the MAX walks backward through
// every non-donation row first. Measured on prod: ec-crawl's prepare was
// cancelled at 1,800 s and its retry took 1,280 s; every caught-up exit of
// ec-crawl and donor-rollup took 361-399 s to find nothing to do (0.1-0.2 s
// before 10-08); and the */30 status tile's count was cancelled at service_role's
// 8 s. The stop-gap (FIX-1297, cc-218/cc-217) re-stamped one donation row to the
// head; the next non-donation landing undoes it. With the type in the PREDICATE,
// the MAX is `Index Only Scan Backward` over donation rows only, whatever lands
// above it. The enum stays in the predicate, not the key, for the same reason as
// FIX-1217: enum_eq is not leakproof (cc-158 §2 A).
//
// WHY OUT-OF-BAND rather than a migration push: CREATE INDEX CONCURRENTLY cannot
// run inside a transaction block, and `supabase db push` wraps each migration in
// one. A plain (non-concurrent) CREATE INDEX would instead hold a SHARE lock on
// a 15.6M-row table for the whole build, blocking every writer of
// financial_relationships. So the index is pre-built here, in a supervised
// window, and the twin migration (20261014010000) carries the same DDL as CREATE
// INDEX IF NOT EXISTS — a no-op against prod afterwards, and the real build path
// for local / any rebuilt-from-zero environment. This mirrors FIX-1142/FIX-1217.
//
// SAFETY NOTES
//  * --apply runs only under a FIX-950 claim (fix1269's gate): it refuses unless
//    CIVITICS_PROD_SESSION_CLAIMANT is set, i.e. unless it is the --then of
//    session:wait-for-gate:prod. Without --apply it is a dry run.
//  * CONCURRENTLY takes only SHARE UPDATE EXCLUSIVE: it does not block reads or
//    writes. It DOES block VACUUM on the table — fr-vacuum-analyze (03:00 UTC)
//    and FR autovacuum wait behind it — which is why it runs under
//    session:wait-for-gate, whose span must not contain 03:00. It does two
//    passes over the table and WAITS for transactions older than each pass to
//    finish, so a long-running transaction elsewhere stalls it.
//  * statement_timeout is set to 0 for this session only — a multi-minute build
//    on a 15.6M-row table would otherwise be reaped by any role-level cap.
//  * IF A CIC FAILS OR IS CANCELLED it leaves an INVALID index behind, which
//    still costs writes but serves no reads. This script does NOT auto-drop it —
//    dropping is a destructive op needing explicit confirmation. It reads
//    indisvalid after the build, prints the exact DROP INDEX CONCURRENTLY to run,
//    and exits 3.
//  * An INVALID index already present is refused before the build (exit 3): IF
//    NOT EXISTS would treat it as done and leave it invalid.
//  * Re-running after a successful build is a no-op (IF NOT EXISTS).
//
// USAGE — run from the PRIMARY checkout, or pass --env-file, because a worktree's
// .env.local.prod is a stub with no SUPABASE_DB_PASSWORD. A relative --env-file
// resolves against the cwd (session:wait-for-gate --then runs in packages/data):
//   node scripts/fix1297-build-fr-donation-updated-at-index.mjs --dry-run
//   (from packages/data, as the --then of session:wait-for-gate:prod)
//     node ../../scripts/fix1297-build-fr-donation-updated-at-index.mjs --apply --env-file ../../.env.local.prod

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POOLER_FILE = join(ROOT, "supabase", ".temp", "pooler-url");
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const POOLER_FALLBACK = `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;

const INDEX_NAME = "financial_relationships_donation_updated_at";
const DROP_SQL = `DROP INDEX CONCURRENTLY public.${INDEX_NAME};`;
const APPLY = process.argv.includes("--apply");
const DRY_RUN = !APPLY;

function usage(msg) {
  console.error(`[fix1297] ${msg}`);
  console.error("usage: node scripts/fix1297-build-fr-donation-updated-at-index.mjs (--dry-run | --apply) [--env-file <path>]");
  process.exit(64);
}
if (APPLY && process.argv.includes("--dry-run")) usage("--apply and --dry-run are exclusive");

const claimant = process.env.CIVITICS_PROD_SESSION_CLAIMANT ?? null;
if (APPLY && claimant === null) {
  usage("--apply runs only under a FIX-950 claim — run it as the --then of session:wait-for-gate:prod");
}

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const ENV_FILE = resolve(argValue("--env-file", join(ROOT, ".env.local.prod")));

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
  console.error(`[fix1297] SUPABASE_DB_PASSWORD not found in ${ENV_FILE}`);
  console.error(`[fix1297] a worktree's .env.local.prod is a stub — pass --env-file <primary checkout>/.env.local.prod`);
  process.exit(2);
}
const baseUrl = existsSync(POOLER_FILE)
  ? readFileSync(POOLER_FILE, "utf8").trim()
  : POOLER_FALLBACK;
const url = baseUrl.replace(/^(postgresql:\/\/[^/@:]+)@/, `$1:${encodeURIComponent(password)}@`);
if (url === baseUrl) {
  console.error(`[fix1297] could not inject password into pooler URL: ${baseUrl}`);
  process.exit(2);
}

const utc = (d = new Date()) => d.toISOString().replace("T", " ").slice(0, 19) + " UTC";

function psql(input, extraArgs = []) {
  return spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1", ...extraArgs], {
    stdio: ["pipe", extraArgs.includes("-At") ? "pipe" : "inherit", "inherit"],
    input,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
}

// One machine-readable reading: `absent` or `<indisvalid>|<indisready>|<bytes>`.
const STATE_SQL = `
SELECT coalesce(
  (SELECT i.indisvalid::text || '|' || i.indisready::text || '|' || pg_relation_size(c.oid)::text
     FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
    WHERE c.relname = '${INDEX_NAME}' AND c.relnamespace = 'public'::regnamespace),
  'absent');
`;

function readState(label) {
  const r = psql(STATE_SQL, ["-At"]);
  if (r.error || r.status !== 0) {
    console.error(`[fix1297] ${label}: could not read the index state (psql exit ${r.status})`);
    return null;
  }
  const s = String(r.stdout).trim();
  if (s === "absent") {
    console.error(`[fix1297] ${label}: ${INDEX_NAME} absent`);
    return { present: false };
  }
  const [valid, ready, bytes] = s.split("|");
  const state = { present: true, valid: valid === "true", ready: ready === "true", bytes: Number(bytes) };
  console.error(
    `[fix1297] ${label}: ${INDEX_NAME} indisvalid=${state.valid} indisready=${state.ready} ` +
      `size=${state.bytes} B (${(state.bytes / 1048576).toFixed(1)} MB)`,
  );
  return state;
}

// The statement the index exists for. Parallel off, so the plan read back is the
// one the definer readers get from a pg_cron backend.
const MAX_SQL = `SELECT MAX(fr.updated_at) FROM public.financial_relationships fr
 WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose');`;

// NOTE: no explicit BEGIN anywhere — psql autocommit is what lets CONCURRENTLY run.
//
// NO psql META-COMMANDS (\timing, \echo) ANYWHERE IN THIS TEMPLATE, deliberately
// (the FIX-1142 note: a doubled backslash does not survive every shell/heredoc
// that might write this file). Plain SELECTs carry the section labels, and the
// build is timed in JS.
const sql = `
SELECT '--- pre: any transaction older than the build would stall CONCURRENTLY ---' AS step;
SELECT pid, state, round(EXTRACT(epoch FROM (now()-xact_start))::numeric,1) AS xact_age_s,
       left(query, 80) AS query
FROM pg_stat_activity
WHERE datname = current_database() AND pid <> pg_backend_pid() AND xact_start IS NOT NULL
ORDER BY xact_start LIMIT 10;

SET statement_timeout = 0;
SET max_parallel_workers_per_gather = 0;
${DRY_RUN
  ? `SELECT '--- DRY RUN — would CREATE INDEX CONCURRENTLY ${INDEX_NAME} ---' AS step;
SELECT '--- the MAX today (plan only) ---' AS step;
EXPLAIN (COSTS OFF) ${MAX_SQL}`
  : `SELECT '--- building CONCURRENTLY (no ACCESS EXCLUSIVE; reads and writes continue) ---' AS step;
CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}
  ON public.financial_relationships (updated_at)
  WHERE relationship_type IN ('donation', 'ie_support', 'ie_oppose');

COMMENT ON INDEX public.${INDEX_NAME} IS
  'FIX-1297, FIX-1293 — partial index over the donation-type rows of '
  'financial_relationships, keyed (updated_at). Makes MAX(updated_at) over the '
  'donation types one probe (rebuild_ec_donations_incr_prepare, '
  'donor_rollup_rebuild_bulk) whatever non-donation landing sits above it, and '
  'bounds get_ec_crawl_health''s count by qualifying rows. The enum is in the '
  'predicate, not the key (enum_eq is not leakproof; cc-158 §2). Built '
  'CONCURRENTLY out-of-band by scripts/fix1297-build-fr-donation-updated-at-index.mjs.';

SELECT '--- read-back: the MAX on the new index ---' AS step;
EXPLAIN (ANALYZE, BUFFERS) ${MAX_SQL}`}
`;

console.error(
  `[fix1297] PROD (Supabase Pro) — ${DRY_RUN ? "DRY RUN" : `WRITE: CREATE INDEX CONCURRENTLY ${INDEX_NAME} (claimant ${claimant})`}`,
);

const before = readState("pre");
if (before === null) process.exit(1);
if (before.present && !before.valid) {
  console.error(`[fix1297] REFUSING: an INVALID ${INDEX_NAME} already exists; IF NOT EXISTS would keep it.`);
  console.error(`[fix1297] drop it first (a destructive op — under the next gate):`);
  console.error(`[fix1297]   ${DROP_SQL}`);
  process.exit(3);
}
if (!DRY_RUN) {
  console.error(`[fix1297] if this fails or is cancelled it leaves an INVALID index. The cleanup is:`);
  console.error(`[fix1297]   ${DROP_SQL}`);
}

const start = new Date();
console.error(`[fix1297] start ${utc(start)}`);
const res = psql(sql);
const end = new Date();
const wallS = (end.getTime() - start.getTime()) / 1000;
console.error(`[fix1297] end   ${utc(end)} — wall ${wallS.toFixed(1)} s (${(wallS / 60).toFixed(2)} min)`);
if (res.error) {
  console.error(`[fix1297] failed to launch psql: ${res.error.message}`);
  process.exit(1);
}

const after = readState("post");
if (DRY_RUN) process.exit(res.status ?? 1);

if (res.status !== 0 || after === null || !after.present || !after.valid) {
  console.error(`[fix1297] BUILD DID NOT LEAVE A VALID INDEX (psql exit ${res.status}).`);
  if (after?.present) {
    console.error(`[fix1297] an INVALID index remains; it is NOT dropped here. Run, under the next gate:`);
    console.error(`[fix1297]   ${DROP_SQL}`);
  }
  process.exit(3);
}
console.error(`[fix1297] OK — ${INDEX_NAME} is valid.`);
process.exit(0);
