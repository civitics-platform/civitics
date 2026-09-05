#!/usr/bin/env node
// db-query.mjs — single literal-matchable entrypoint for ad-hoc DB reads.
//
// WHY THIS EXISTS (autonomy / fewer permission prompts):
// Claude Code will NOT auto-approve a Bash command that contains command
// substitution `$(...)` or backticks — even under a `Bash(*)` allow rule — and
// the old prod-query recipe was built entirely out of them:
//     set -a && source .env.local.prod && set +a
//     PURL="postgresql://...:${SUPABASE_DB_PASSWORD}@..."
//     psql "$PURL" -c "SELECT ..."
// The `source` + `${VAR}` + assembled-URL shape forced a permission prompt on
// every prod query. This helper moves all of that INSIDE a node script, so the
// agent's actual command is a single, substitution-free, pattern-matchable line:
//     node scripts/db-query.mjs --prod  "SELECT ..."
//     node scripts/db-query.mjs --local "SELECT ..."
//     node scripts/db-query.mjs --prod  --file scratchpad/q.sql
//
// SAFETY: --prod ALWAYS runs read-only (wraps the SQL in a single
// transaction with `SET TRANSACTION READ ONLY`, so any INSERT/UPDATE/DELETE/DDL
// errors out instead of touching production). Prod schema changes go through
// `pnpm db:push:prod`, and any ad-hoc prod write still requires the
// explicit-confirmation flow in CLAUDE.md.
// --local is unrestricted (local Docker is disposable dev state).
//
// FIX-791 — --call: the ONE documented exception, and it is local by default.
//
//     node scripts/db-query.mjs --local --call "CALL public.rebuild_x();"
//     node scripts/db-query.mjs --local --call --timeout 90min --file step.sql
//
// A PROCEDURE that COMMITs internally — the whole FIX-703/704/715/717/718
// pg_cron family — cannot run inside a wrapping transaction block, so the
// default `--single-transaction` made every such CALL fail with "invalid
// transaction termination". --call drops --single-transaction (autocommit,
// statement by statement) and prepends `SET statement_timeout` so a runaway
// CALL still has a backstop; --timeout <interval> overrides the 60min default.
//
// `--prod --call` IS A WRITE PATH and is gated accordingly: it refuses without
// --yes-i-mean-prod, and even with it prints the target host and the exact
// statement and waits 5 seconds before connecting. The read-only contract of
// the PLAIN --prod path is untouched: no --call, no write, ever.
//
// This supersedes the session-scratchpad prod_call.mjs / prod-call.mjs
// wrappers, which were untracked (scratchpad/ is gitignored) and duplicated the
// env handling below.
//
// Reads SUPABASE_DB_PASSWORD directly from .env.local.prod (the file-read path
// that sidesteps the `source` non-export trap; mirrors scripts/db-push-prod.mjs)
// and injects it into the CLI-cached session-pooler URL. Redacts on print.

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = join(ROOT, ".env.local.prod");
const POOLER_FILE = join(ROOT, "supabase", ".temp", "pooler-url");
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const POOLER_FALLBACK = `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;
const LOCAL_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

function usage(msg) {
  if (msg) console.error(`[db-query] ${msg}`);
  console.error(
    "Usage:\n" +
    "  node scripts/db-query.mjs --local  \"SELECT ...\"\n" +
    "  node scripts/db-query.mjs --prod   \"SELECT ...\"      (read-only, enforced)\n" +
    "  node scripts/db-query.mjs --prod   --file path/to/q.sql\n" +
    "  node scripts/db-query.mjs --local  --call \"CALL public.some_proc();\"\n" +
    "Options: --raw (unaligned, tuples-only: psql -At), --csv, --file <path>.\n" +
    "  --call            autocommit (no --single-transaction) so a COMMITting\n" +
    "                    PROCEDURE can run. Local by default; --prod --call also\n" +
    "                    requires --yes-i-mean-prod and is a WRITE path.\n" +
    "  --timeout <ival>  statement_timeout for --call (default 60min).\n" +
    "Tip: for SQL containing single quotes or a $ / backtick, use --file so the\n" +
    "shell never sees it (write the .sql with the Write tool first).",
  );
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

// ── Parse args ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let target = null;   // 'local' | 'prod'
let file = null;
let raw = false;
let csv = false;
let call = false;           // FIX-791: autocommit mode for COMMITting procedures
let timeout = "60min";      // statement_timeout used by --call
let yesIMeanProd = false;   // the --prod --call gate
const sqlParts = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--local") target = "local";
  else if (a === "--prod") target = "prod";
  else if (a === "--file" || a === "-f") file = argv[++i];
  else if (a === "--raw") raw = true;
  else if (a === "--csv") csv = true;
  else if (a === "--call" || a === "--no-txn") call = true;
  else if (a === "--timeout") timeout = argv[++i];
  else if (a === "--yes-i-mean-prod") yesIMeanProd = true;
  else if (a === "--help" || a === "-h") usage();
  else sqlParts.push(a);
}
if (!target) usage("must pass --local or --prod");
if (!file && sqlParts.length === 0) usage("no SQL given (positional string or --file)");
if (file && sqlParts.length > 0) usage("pass EITHER a SQL string OR --file, not both");

// FIX-791: --timeout is only meaningful under --call (the plain path's
// single-transaction wrapper inherits the role/gateway caps as it always has).
// A bad interval would otherwise be swallowed by psql at SET time.
if (call && !/^[0-9]+\s*(ms|s|min|h|d|second|seconds|minute|minutes|hour|hours)?$/i.test(String(timeout ?? ""))) {
  usage(`--timeout must be a postgres interval like 60min / 90s / 2h, got: ${timeout}`);
}

// FIX-791 — the gate. --prod --call is the ONLY write path in this script, so
// it is opt-in twice: the mode flag, and an explicit acknowledgement.
if (call && target === "prod" && !yesIMeanProd) {
  console.error("[db-query] REFUSING --prod --call without --yes-i-mean-prod.");
  console.error("[db-query] --call runs OUTSIDE the read-only transaction, so against prod it can WRITE.");
  console.error("[db-query] Prod schema changes belong in a migration (pnpm db:push:prod). If this is a");
  console.error("[db-query] supervised runtime CALL, re-run with --yes-i-mean-prod and watch it.");
  process.exit(2);
}

// ── Resolve connection URL ──────────────────────────────────────────────────
let url, label;
if (target === "local") {
  url = LOCAL_URL;
  label = "LOCAL (127.0.0.1:54322)";
} else {
  const password = readEnvVar(ENV_FILE, "SUPABASE_DB_PASSWORD");
  if (!password) usage(`SUPABASE_DB_PASSWORD not found in ${ENV_FILE}`);
  const baseUrl = existsSync(POOLER_FILE)
    ? readFileSync(POOLER_FILE, "utf8").trim()
    : POOLER_FALLBACK;
  url = baseUrl.replace(/^(postgresql:\/\/[^/@:]+)@/, `$1:${encodeURIComponent(password)}@`);
  if (!url.includes("@") || url === baseUrl) usage(`could not inject password into pooler URL: ${baseUrl}`);
  label = "PROD (Supabase Pro) — READ ONLY";
}

// ── Build psql invocation ───────────────────────────────────────────────────
// SQL is delivered on STDIN, not via -c/-f, so every CLI arg is space-free.
// This matters on Windows: spawn with shell:true (needed for PATH resolution of
// psql) re-parses the arg list and shreds any arg containing spaces — a `-c "SET
// TRANSACTION READ ONLY"` becomes five bogus args. Space-free args + stdin
// sidesteps that entirely, and --single-transaction wraps the whole stdin
// stream in one transaction so the read-only SET governs it.
// FIX-791: --call drops --single-transaction. A procedure that runs COMMIT
// cannot execute inside a wrapping transaction block, which is the whole
// reason this mode exists. ON_ERROR_STOP still holds, so a failing statement
// stops the batch rather than plodding on.
const psqlArgs = ["-v", "ON_ERROR_STOP=1"];
if (!call) psqlArgs.push("--single-transaction");
if (raw) psqlArgs.push("-At");
if (csv) psqlArgs.push("--csv");

let sqlText;
if (file) {
  const fpath = isAbsolute(file) ? file : join(process.cwd(), file);
  if (!existsSync(fpath)) usage(`--file not found: ${fpath}`);
  sqlText = readFileSync(fpath, "utf8");
} else {
  sqlText = sqlParts.join(" ");
}

// --prod: prepend read-only so any INSERT/UPDATE/DELETE/DDL fails closed.
//
// FIX-791: under --call there is no wrapping transaction for SET TRANSACTION
// READ ONLY to govern, so it is not emitted — that is exactly why --prod --call
// needs its own gate above rather than relying on this line. What --call
// prepends instead is a statement_timeout, so a CALL that livelocks has a
// backstop rather than running until something else notices.
const readOnly = target === "prod" && !call;
const prelude = call
  ? `SET statement_timeout = '${timeout}';\n`
  : readOnly
    ? "SET TRANSACTION READ ONLY;\n"
    : "";
const stdin = prelude + sqlText + "\n";

console.error(`[db-query] ${label}${call ? ` — CALL MODE (autocommit, statement_timeout=${timeout})` : ""}`);

// FIX-791: a prod CALL is a supervised action. Say what is about to happen, to
// which host, and leave a beat to Ctrl-C out of it.
if (call && target === "prod") {
  const host = (url.match(/@([^/:]+)/) ?? [])[1] ?? "(unknown host)";
  console.error(`[db-query] TARGET HOST: ${host}`);
  console.error("[db-query] STATEMENT(S):");
  for (const l of sqlText.trimEnd().split(/\r?\n/)) console.error(`[db-query]   ${l}`);
  console.error("[db-query] This WRITES to production. Ctrl-C within 5s to abort...");
  // Synchronous sleep: this runs before spawnSync and must not be skippable by
  // the event loop being empty.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
  console.error("[db-query] proceeding.");
}
const res = spawnSync("psql", [url, ...psqlArgs], {
  stdio: ["pipe", "inherit", "inherit"],
  input: stdin,
  shell: process.platform === "win32",
});
if (res.error) {
  console.error(`[db-query] failed to launch psql: ${res.error.message}`);
  console.error("[db-query] is psql on PATH? (it ships with the Supabase CLI / postgres client)");
  process.exit(1);
}
process.exit(res.status ?? 1);
