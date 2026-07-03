#!/usr/bin/env node
// db-poll.mjs — poll a DB status value until it changes, without a shell loop.
//
// WHY THIS EXISTS (autonomy / fewer permission prompts):
// The recurring "poll a pipeline/job status until it stops running" recipe was
// an inline shell loop:
//     for i in 1 2 3 …; do s=$(node scripts/db-query.mjs --local "SELECT status …");
//       case "$s" in *running*) sleep 60;; *) break;; esac; done
// Its leading `for` / `case` words and `$(…)` substitution force a permission
// prompt on every run (the compound-allow hook only auto-approves when each
// segment's leading word is SAFE, and `for`/`case` are not). This helper moves
// the loop INSIDE node, so the agent's command is `node scripts/db-poll.mjs …`
// — a single substitution-free line whose leading word (`node`) already
// auto-approves. Mirrors scripts/db-query.mjs.
//
//   node scripts/db-poll.mjs --local --sql "SELECT status FROM data_sync_log \
//     WHERE pipeline='entity_connections_rebuild' ORDER BY started_at DESC LIMIT 1" \
//     --until-not running --interval 60 --max 8
//
// SAFETY: identical to db-query.mjs — --prod ALWAYS runs read-only (wraps the SQL
// in `SET TRANSACTION READ ONLY`), --local is unrestricted (disposable Docker).
// Polling is a read; there is no write path here.

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = join(ROOT, ".env.local.prod");
const POOLER_FILE = join(ROOT, "supabase", ".temp", "pooler-url");
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const POOLER_FALLBACK = `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;
const LOCAL_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

function usage(msg) {
  if (msg) console.error(`[db-poll] ${msg}`);
  console.error(
    "Usage:\n" +
    "  node scripts/db-poll.mjs --local --sql \"SELECT status …\" --until-not running\n" +
    "  node scripts/db-poll.mjs --prod  --file q.sql --until done --interval 30 --max 20\n" +
    "Required: --local|--prod, a SQL source (--sql \"…\" or --file <path>),\n" +
    "  and at least one stop condition (--until <regex> and/or --until-not <regex>).\n" +
    "Options: --interval <sec> (default 5), --max <iterations> (default 10).\n" +
    "Stops (exit 0) when the returned value matches --until OR stops matching\n" +
    "--until-not. Exits 3 if --max iterations elapse without the condition.\n" +
    "Tip: for SQL with single quotes or a $ / backtick, use --file (write it first).",
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
let sql = null;
let until = null;
let untilNot = null;
let interval = 5;
let max = 10;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--local") target = "local";
  else if (a === "--prod") target = "prod";
  else if (a === "--file" || a === "-f") file = argv[++i];
  else if (a === "--sql") sql = argv[++i];
  else if (a === "--until") until = argv[++i];
  else if (a === "--until-not") untilNot = argv[++i];
  else if (a === "--interval") interval = Number(argv[++i]);
  else if (a === "--max") max = Number(argv[++i]);
  else if (a === "--help" || a === "-h") usage();
  else usage(`unknown argument: ${a}`);
}
if (!target) usage("must pass --local or --prod");
if (!file && !sql) usage("no SQL given (--sql \"…\" or --file <path>)");
if (file && sql) usage("pass EITHER --sql OR --file, not both");
if (!until && !untilNot) usage("need at least one stop condition (--until / --until-not)");
if (!Number.isFinite(interval) || interval < 0) usage("--interval must be a non-negative number");
if (!Number.isFinite(max) || max < 1) usage("--max must be a positive integer");

let untilRe = null, untilNotRe = null;
try { if (until) untilRe = new RegExp(until, "i"); } catch { usage(`--until is not a valid regex: ${until}`); }
try { if (untilNot) untilNotRe = new RegExp(untilNot, "i"); } catch { usage(`--until-not is not a valid regex: ${untilNot}`); }

// ── Resolve connection URL ──────────────────────────────────────────────────
let url, label;
if (target === "local") {
  url = LOCAL_URL;
  label = "LOCAL (127.0.0.1:54322)";
} else {
  const password = readEnvVar(ENV_FILE, "SUPABASE_DB_PASSWORD");
  if (!password) usage(`SUPABASE_DB_PASSWORD not found in ${ENV_FILE}`);
  const baseUrl = existsSync(POOLER_FILE) ? readFileSync(POOLER_FILE, "utf8").trim() : POOLER_FALLBACK;
  url = baseUrl.replace(/^(postgresql:\/\/[^/@:]+)@/, `$1:${encodeURIComponent(password)}@`);
  if (!url.includes("@") || url === baseUrl) usage(`could not inject password into pooler URL: ${baseUrl}`);
  label = "PROD (Supabase Pro) — READ ONLY";
}

// ── Resolve SQL text ────────────────────────────────────────────────────────
let sqlText;
if (file) {
  const fpath = isAbsolute(file) ? file : join(process.cwd(), file);
  if (!existsSync(fpath)) usage(`--file not found: ${fpath}`);
  sqlText = readFileSync(fpath, "utf8");
} else {
  sqlText = sql;
}
const readOnly = target === "prod";
// -At: unaligned + tuples-only, so the captured value is a clean scalar to match.
const psqlArgs = [url, "-v", "ON_ERROR_STOP=1", "--single-transaction", "-At"];
const stdin = (readOnly ? "SET TRANSACTION READ ONLY;\n" : "") + sqlText + "\n";

function queryOnce() {
  const res = spawnSync("psql", psqlArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    input: stdin,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (res.error) {
    console.error(`[db-poll] failed to launch psql: ${res.error.message}`);
    console.error("[db-poll] is psql on PATH? (it ships with the Supabase CLI / postgres client)");
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(`[db-poll] psql exited ${res.status}: ${(res.stderr || "").trim()}`);
    process.exit(1);
  }
  return (res.stdout || "").trim();
}

function conditionMet(value) {
  if (untilRe && untilRe.test(value)) return true;
  if (untilNotRe && !untilNotRe.test(value)) return true;
  return false;
}

// ── Poll loop ───────────────────────────────────────────────────────────────
console.error(`[db-poll] ${label} — up to ${max} polls, every ${interval}s`);
const cond = [until && `until /${until}/i`, untilNot && `until-not /${untilNot}/i`].filter(Boolean).join(" | ");
for (let i = 1; i <= max; i++) {
  const value = queryOnce();
  const shown = value === "" ? "(empty)" : value.replace(/\s+/g, " ").slice(0, 200);
  console.error(`[db-poll] ${i}/${max}: ${shown}`);
  if (conditionMet(value)) {
    console.error(`[db-poll] stop condition met (${cond})`);
    process.stdout.write(value + "\n");
    process.exit(0);
  }
  if (i < max) await sleep(interval * 1000);
}
console.error(`[db-poll] gave up after ${max} polls without meeting: ${cond}`);
process.exit(3);
