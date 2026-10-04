#!/usr/bin/env node
// fix1269-create-snapshot-index.mjs — ONE authorized prod DDL write (FIX-1269, cc-188 W1).
//
// Builds, CONCURRENTLY and out-of-band, the partial index that lets the */30
// status snapshot count enrichment_queue's in-flight claims without reading the
// whole table:
//
//   CREATE INDEX CONCURRENTLY IF NOT EXISTS enrichment_queue_processing_claimed_idx
//     ON public.enrichment_queue (claimed_at)
//     WHERE status = 'processing';
//
// WHY: apps/civitics/app/api/claude/status/_lib/sections.ts counts
// `status = 'processing'` and `status = 'processing' AND claimed_at < cutoff`
// on every snapshot tick. Nothing indexes either, so both are a Seq Scan of the
// 274 MB heap for ~44 rows — prod pgss since 2026-09-22: 58,009 and 55,446
// blocks read per call, mean 4.8 s, max 7.99 s against the 8 s service_role
// bound (cc-188 read 3). The census (docs/audits/2026-10-04-measure-first-census.md
// §6) puts the snapshot's reads at 34.7 % of the day's swap-in. On the clone the
// partial turns both into an Index Only Scan: 19,144 buffers -> 2.
//
// WHY OUT-OF-BAND rather than a migration push: CREATE INDEX CONCURRENTLY cannot
// run inside a transaction block, and `supabase db push` wraps each migration in
// one. The twin migration (cc-188 M-C) carries the same DDL as CREATE INDEX IF
// NOT EXISTS — a no-op on prod once this has run, and the real build path for
// local / any rebuilt-from-zero environment. Pushed only after indisvalid. The
// fix1217 / fix1142 shape.
//
// SAFETY NOTES
//  * CONCURRENTLY takes only SHARE UPDATE EXCLUSIVE: reads and writes continue
//    (the drain's FOR UPDATE SKIP LOCKED claim is not blocked). It does block
//    VACUUM on enrichment_queue for the build's few seconds, and it WAITS for
//    transactions older than each pass, so it runs under session:wait-for-gate.
//  * statement_timeout = 0 for this session only.
//  * IF A CIC FAILS OR IS CANCELLED it leaves an INVALID index. This script does
//    NOT auto-drop it (a destructive op); it prints the DROP INDEX CONCURRENTLY
//    to run under the next gate and exits 3. An INVALID index already present is
//    refused before the build (IF NOT EXISTS would keep it).
//  * --apply refuses without CIVITICS_PROD_SESSION_CLAIMANT: it runs only as the
//    --then of `session:wait-for-gate:prod`, under a FIX-950 claim.
//  * Re-running after a successful build is a no-op (IF NOT EXISTS).
//
// USAGE — from the PRIMARY checkout, or pass --env-file (a worktree's
// .env.local.prod is a stub). --then runs in packages/data:
//   node scripts/fix1269-create-snapshot-index.mjs --prod --dry-run
//   pnpm --filter @civitics/data session:wait-for-gate:prod --expected-minutes 2 --census stop \
//     --reason "FIX-1269 W1 (cc-188)" \
//     --then "node ../../scripts/fix1269-create-snapshot-index.mjs --prod --apply --env-file ../../.env.local.prod"

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POOLER_FILE = join(ROOT, "supabase", ".temp", "pooler-url");
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const POOLER_FALLBACK = `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;

const INDEX_NAME = "enrichment_queue_processing_claimed_idx";
const DROP_SQL = `DROP INDEX CONCURRENTLY public.${INDEX_NAME};`;
const APPLY = process.argv.includes("--apply");
const DRY_RUN = !APPLY;

function usage(msg) {
  console.error(`[fix1269] ${msg}`);
  console.error("usage: node scripts/fix1269-create-snapshot-index.mjs --prod (--dry-run | --apply) [--env-file <path>]");
  process.exit(64);
}
if (!process.argv.includes("--prod")) usage("--prod is required (this script has one target)");
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
  console.error(`[fix1269] SUPABASE_DB_PASSWORD not found in ${ENV_FILE}`);
  console.error(`[fix1269] a worktree's .env.local.prod is a stub — pass --env-file <primary checkout>/.env.local.prod`);
  process.exit(2);
}
const baseUrl = existsSync(POOLER_FILE)
  ? readFileSync(POOLER_FILE, "utf8").trim()
  : POOLER_FALLBACK;
const url = baseUrl.replace(/^(postgresql:\/\/[^/@:]+)@/, `$1:${encodeURIComponent(password)}@`);
if (url === baseUrl) {
  console.error(`[fix1269] could not inject password into pooler URL: ${baseUrl}`);
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
    console.error(`[fix1269] ${label}: could not read the index state (psql exit ${r.status})`);
    return null;
  }
  const s = String(r.stdout).trim();
  if (s === "absent") {
    console.error(`[fix1269] ${label}: ${INDEX_NAME} absent`);
    return { present: false };
  }
  const [valid, ready, bytes] = s.split("|");
  const state = { present: true, valid: valid === "true", ready: ready === "true", bytes: Number(bytes) };
  console.error(
    `[fix1269] ${label}: ${INDEX_NAME} indisvalid=${state.valid} indisready=${state.ready} ` +
      `size=${state.bytes} B (${(state.bytes / 1024).toFixed(1)} kB)`,
  );
  return state;
}

// No explicit BEGIN anywhere — psql autocommit is what lets CONCURRENTLY run.
// No psql meta-commands (the FIX-1142 note); the build is timed in JS. The
// plain EXPLAIN after the build is the read-back that the planner TAKES it
// (rule 26/27) — the clone-proven plan, now on prod.
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const sql = `
SET application_name = 'fix1269-create-snapshot-index';
${claimant !== null ? `SET civitics.prod_session_claimant = ${lit(claimant)};` : ""}
SELECT '--- pre: any transaction older than the build would stall CONCURRENTLY ---' AS step;
SELECT pid, state, round(EXTRACT(epoch FROM (now()-xact_start))::numeric,1) AS xact_age_s,
       left(query, 80) AS query
FROM pg_stat_activity
WHERE datname = current_database() AND pid <> pg_backend_pid() AND xact_start IS NOT NULL
ORDER BY xact_start LIMIT 10;

SET statement_timeout = 0;
${DRY_RUN
  ? `SELECT '--- DRY RUN — would CREATE INDEX CONCURRENTLY ${INDEX_NAME} ---' AS step;`
  : `SELECT '--- building CONCURRENTLY (no ACCESS EXCLUSIVE; reads and writes continue) ---' AS step;
CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}
  ON public.enrichment_queue (claimed_at)
  WHERE status = 'processing';

COMMENT ON INDEX public.${INDEX_NAME} IS
  'FIX-1269 — partial index over the in-flight claims of enrichment_queue. '
  'Bounds the */30 status snapshot''s two processing counts (sections.ts) to an '
  'Index Only Scan instead of a Seq Scan of the whole heap for ~44 rows. Built '
  'CONCURRENTLY out-of-band by scripts/fix1269-create-snapshot-index.mjs; the '
  'cc-188 twin migration carries the same DDL as IF NOT EXISTS.';`}

SELECT '--- plan read-back (plain EXPLAIN, parallel off as the snapshot reads) ---' AS step;
SET max_parallel_workers_per_gather = 0;
EXPLAIN SELECT count(*) FROM public.enrichment_queue WHERE status = 'processing';
EXPLAIN SELECT count(*) FROM public.enrichment_queue
  WHERE status = 'processing' AND claimed_at < now() - interval '30 minutes';
`;

console.error(
  `[fix1269] PROD (Supabase Pro) — ${DRY_RUN ? "DRY RUN" : `WRITE: CREATE INDEX CONCURRENTLY ${INDEX_NAME}`}` +
    (claimant ? `; claimant ${claimant}` : ""),
);

const before = readState("pre");
if (before === null) process.exit(1);
if (before.present && !before.valid) {
  console.error(`[fix1269] REFUSING: an INVALID ${INDEX_NAME} already exists; IF NOT EXISTS would keep it.`);
  console.error(`[fix1269] drop it first (a destructive op — under the next gate):`);
  console.error(`[fix1269]   ${DROP_SQL}`);
  process.exit(3);
}
if (!DRY_RUN) {
  console.error(`[fix1269] if this fails or is cancelled it leaves an INVALID index. The cleanup is:`);
  console.error(`[fix1269]   ${DROP_SQL}`);
}

const start = new Date();
console.error(`[fix1269] start ${utc(start)}`);
const res = psql(sql);
const end = new Date();
const wallS = (end.getTime() - start.getTime()) / 1000;
console.error(`[fix1269] end   ${utc(end)} — wall ${wallS.toFixed(1)} s`);
if (res.error) {
  console.error(`[fix1269] failed to launch psql: ${res.error.message}`);
  process.exit(1);
}

const after = readState("post");
if (DRY_RUN) process.exit(res.status ?? 1);

if (res.status !== 0 || after === null || !after.present || !after.valid) {
  console.error(`[fix1269] BUILD DID NOT LEAVE A VALID INDEX (psql exit ${res.status}).`);
  if (after?.present) {
    console.error(`[fix1269] an INVALID index remains; it is NOT dropped here. Run, under the next gate:`);
    console.error(`[fix1269]   ${DROP_SQL}`);
  }
  process.exit(3);
}
console.error(`[fix1269] OK — ${INDEX_NAME} is valid.`);
process.exit(0);
