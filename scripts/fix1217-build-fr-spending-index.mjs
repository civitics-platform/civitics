#!/usr/bin/env node
// fix1217-build-fr-spending-index.mjs — ONE authorized prod DDL write (FIX-1217).
//
// Builds, CONCURRENTLY and out-of-band, the partial index that bounds the donor
// page's spending read (apps/civitics/app/donors/[id]/page.tsx, "donors:spending"):
//
//   CREATE INDEX CONCURRENTLY IF NOT EXISTS financial_relationships_fe_spending_idx
//     ON public.financial_relationships (to_id, amount_cents DESC)
//     WHERE relationship_type IN ('contract', 'grant')
//       AND to_type = 'financial_entity';
//
// WHY: the page reads `to_type='financial_entity' AND to_id=$1 AND
// relationship_type IN ('contract','grant') ORDER BY amount_cents DESC LIMIT 50`
// as anon. Today that is a BitmapAnd of _to and contract_grant_updated_at plus a
// sort — AmerisourceBergen's 246,005 rows cold-read in 8.3 s on the clone. The
// enum lives in the PREDICATE, not the key, because enum_eq is not leakproof and
// under RLS a key-column enum equality cannot become an equivalence-class
// constant, so the index's order would be lost (cc-158 §2 A). With it in the
// predicate the plan is `Limit <- Index Scan`, no Sort. cc-159 D1 measured both
// candidates cold on the clone and this narrower one won: 111,951,872 B against
// partial-A's 178,782,208 B, and the plan flips for the RNC (0.15 ms) and for
// AmerisourceBergen (20.6 ms). Every contract/grant row on prod is
// to_type='financial_entity' (cc-159 read 6: 0 otherwise), so the predicate
// loses nothing.
//
// WHY OUT-OF-BAND rather than a migration push: CREATE INDEX CONCURRENTLY cannot
// run inside a transaction block, and `supabase db push` wraps each migration in
// one. A plain (non-concurrent) CREATE INDEX would instead hold a SHARE lock on
// a 14M-row table for the whole build, blocking every writer of
// financial_relationships. So the index is pre-built here, in a supervised
// window, and the FE inbound rollup migration carries the same DDL as CREATE
// INDEX IF NOT EXISTS — a no-op against prod afterwards, and the real build path
// for local / any rebuilt-from-zero environment. This mirrors FIX-1142.
//
// SAFETY NOTES
//  * CONCURRENTLY takes only SHARE UPDATE EXCLUSIVE: it does not block reads or
//    writes. It DOES block VACUUM on the table — fr-vacuum-analyze (03:00 UTC)
//    and FR autovacuum wait behind it — which is why it runs under
//    session:wait-for-gate, whose span must not contain 03:00. It does two
//    passes over the table and WAITS for transactions older than each pass to
//    finish, so a long-running transaction elsewhere stalls it.
//  * statement_timeout is set to 0 for this session only — a multi-minute build
//    on a 14M-row table would otherwise be reaped by any role-level cap.
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
//   node scripts/fix1217-build-fr-spending-index.mjs --dry-run
//   node scripts/fix1217-build-fr-spending-index.mjs
//   (from packages/data) node ../../scripts/fix1217-build-fr-spending-index.mjs --env-file ../../.env.local.prod

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POOLER_FILE = join(ROOT, "supabase", ".temp", "pooler-url");
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const POOLER_FALLBACK = `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;

const INDEX_NAME = "financial_relationships_fe_spending_idx";
const DROP_SQL = `DROP INDEX CONCURRENTLY public.${INDEX_NAME};`;
const DRY_RUN = process.argv.includes("--dry-run");

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
  console.error(`[fix1217] SUPABASE_DB_PASSWORD not found in ${ENV_FILE}`);
  console.error(`[fix1217] a worktree's .env.local.prod is a stub — pass --env-file <primary checkout>/.env.local.prod`);
  process.exit(2);
}
const baseUrl = existsSync(POOLER_FILE)
  ? readFileSync(POOLER_FILE, "utf8").trim()
  : POOLER_FALLBACK;
const url = baseUrl.replace(/^(postgresql:\/\/[^/@:]+)@/, `$1:${encodeURIComponent(password)}@`);
if (url === baseUrl) {
  console.error(`[fix1217] could not inject password into pooler URL: ${baseUrl}`);
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
    console.error(`[fix1217] ${label}: could not read the index state (psql exit ${r.status})`);
    return null;
  }
  const s = String(r.stdout).trim();
  if (s === "absent") {
    console.error(`[fix1217] ${label}: ${INDEX_NAME} absent`);
    return { present: false };
  }
  const [valid, ready, bytes] = s.split("|");
  const state = { present: true, valid: valid === "true", ready: ready === "true", bytes: Number(bytes) };
  console.error(
    `[fix1217] ${label}: ${INDEX_NAME} indisvalid=${state.valid} indisready=${state.ready} ` +
      `size=${state.bytes} B (${(state.bytes / 1048576).toFixed(1)} MB)`,
  );
  return state;
}

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
${DRY_RUN
  ? `SELECT '--- DRY RUN — would CREATE INDEX CONCURRENTLY ${INDEX_NAME} ---' AS step;`
  : `SELECT '--- building CONCURRENTLY (no ACCESS EXCLUSIVE; reads and writes continue) ---' AS step;
CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}
  ON public.financial_relationships (to_id, amount_cents DESC)
  WHERE relationship_type IN ('contract', 'grant')
    AND to_type = 'financial_entity';

COMMENT ON INDEX public.${INDEX_NAME} IS
  'FIX-1217 — partial index over the ~3.9M contract/grant rows of '
  'financial_relationships, keyed (to_id, amount_cents DESC). Bounds the donor '
  'page''s spending read (to_type=financial_entity, to_id, relationship_type IN '
  '(contract, grant) ORDER BY amount_cents DESC LIMIT 50) to Limit <- Index Scan as '
  'anon. The enum is in the predicate, not the key: enum_eq is not leakproof, so '
  'under RLS a key-column enum cannot give up its order (cc-158 §2). Built '
  'CONCURRENTLY out-of-band by scripts/fix1217-build-fr-spending-index.mjs.';`}
`;

console.error(
  `[fix1217] PROD (Supabase Pro) — ${DRY_RUN ? "DRY RUN" : `WRITE: CREATE INDEX CONCURRENTLY ${INDEX_NAME}`}`,
);

const before = readState("pre");
if (before === null) process.exit(1);
if (before.present && !before.valid) {
  console.error(`[fix1217] REFUSING: an INVALID ${INDEX_NAME} already exists; IF NOT EXISTS would keep it.`);
  console.error(`[fix1217] drop it first (a destructive op — under the next gate):`);
  console.error(`[fix1217]   ${DROP_SQL}`);
  process.exit(3);
}
if (!DRY_RUN) {
  console.error(`[fix1217] if this fails or is cancelled it leaves an INVALID index. The cleanup is:`);
  console.error(`[fix1217]   ${DROP_SQL}`);
}

const start = new Date();
console.error(`[fix1217] start ${utc(start)}`);
const res = psql(sql);
const end = new Date();
const wallS = (end.getTime() - start.getTime()) / 1000;
console.error(`[fix1217] end   ${utc(end)} — wall ${wallS.toFixed(1)} s (${(wallS / 60).toFixed(2)} min)`);
if (res.error) {
  console.error(`[fix1217] failed to launch psql: ${res.error.message}`);
  process.exit(1);
}

const after = readState("post");
if (DRY_RUN) process.exit(res.status ?? 1);

if (res.status !== 0 || after === null || !after.present || !after.valid) {
  console.error(`[fix1217] BUILD DID NOT LEAVE A VALID INDEX (psql exit ${res.status}).`);
  if (after?.present) {
    console.error(`[fix1217] an INVALID index remains; it is NOT dropped here. Run, under the next gate:`);
    console.error(`[fix1217]   ${DROP_SQL}`);
  }
  process.exit(3);
}
console.error(`[fix1217] OK — ${INDEX_NAME} is valid.`);
process.exit(0);
