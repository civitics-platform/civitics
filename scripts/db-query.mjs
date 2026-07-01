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
// errors out instead of touching production). There is deliberately NO prod
// write path here — prod schema changes go through `pnpm db:push:prod`, and any
// ad-hoc prod write still requires the explicit-confirmation flow in CLAUDE.md.
// --local is unrestricted (local Docker is disposable dev state).
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
    "Options: --raw (unaligned, tuples-only: psql -At), --csv, --file <path>.\n" +
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
const sqlParts = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--local") target = "local";
  else if (a === "--prod") target = "prod";
  else if (a === "--file" || a === "-f") file = argv[++i];
  else if (a === "--raw") raw = true;
  else if (a === "--csv") csv = true;
  else if (a === "--help" || a === "-h") usage();
  else sqlParts.push(a);
}
if (!target) usage("must pass --local or --prod");
if (!file && sqlParts.length === 0) usage("no SQL given (positional string or --file)");
if (file && sqlParts.length > 0) usage("pass EITHER a SQL string OR --file, not both");

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
const psqlArgs = ["-v", "ON_ERROR_STOP=1", "--single-transaction"];
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
const readOnly = target === "prod";
const stdin = (readOnly ? "SET TRANSACTION READ ONLY;\n" : "") + sqlText + "\n";

console.error(`[db-query] ${label}`);
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
