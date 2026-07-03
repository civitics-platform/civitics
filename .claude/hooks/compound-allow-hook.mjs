#!/usr/bin/env node
/*
 * Claude Code PreToolUse hook — auto-approve SAFE compound Bash commands. (v6)
 *
 * WHY: a Claude Code security fix (the `cd && <anything>` bypass) made wildcard
 * allow-rules like `Bash(*)` stop auto-approving any command containing a shell
 * operator (&&, ||, |, ;). Every chained command now prompts. This hook restores
 * the convenience WITHOUT reopening the hole: it auto-approves a compound command
 * only when EVERY segment's leading word is in the SAFE list AND nothing trips
 * the DANGER/TRICKY checks. It NEVER denies — anything it doesn't approve falls
 * through to Claude Code's normal permission flow (deny-list + prompts).
 *
 * History (each version fixed a real prompt in the Civitics psql workflow):
 *   v2  source/set/export/psql in SAFE; mask quoted strings before splitting (so
 *       a grep alternation "a|b" isn't read as a pipe); VAR=val-only segments are
 *       safe; allow redirects (>, 2>&1) and ${VAR}; DANGER covers SQL writes/DDL.
 *   v3  $(...) command substitution allowed when its inner command is also all-
 *       SAFE (resolved innermost-first), instead of blanket-blocking it.
 *   v4  $(...) extraction is now quote- and paren-aware (matchClose), so a
 *       substitution whose body contains SQL parens — e.g.
 *       EMPTY=$(psql -c "... NOT EXISTS (SELECT 1 ...) ...") — is handled instead
 *       of bailing. Innermost-first via lastIndexOf, so nesting works too.
 *   v5  heredoc bodies are stripped before segment-splitting (stripHeredocs), so
 *       `psql ... <<'SQL' ...multi-line SELECT... SQL` auto-approves on its
 *       leading `psql` instead of prompting on every SQL body line. DANGER still
 *       scans the raw command first, so write/DDL heredocs keep deferring.
 *   v6  split DANGER: NON_SQL_DANGER (rm/git-force/pnpm-add/…) still scans the
 *       raw command; SQL write/DDL (SQL_DANGER) now defers ONLY when a raw psql
 *       is aimed at a non-local DB — so db-query.mjs (prod is read-only, local
 *       disposable) and SQL keywords in prose (fix:add bodies) stop prompting.
 *       Added netstat/sleep/jq/taskkill/kill to SAFE, plus host-scoped curl
 *       (localhost + our supabase/vercel hosts, read methods only).
 *
 * The shell-PARSING classes (quotes, pipes, redirects, ${VAR}, $(...), nesting)
 * are now handled. If something still prompts, it's almost always a real leading
 * word that isn't in SAFE (jq, xargs, find, a for-loop, etc.) — add it to SAFE.
 *
 * SECURITY SURFACE = the SAFE set, applied at top level AND inside $(...).
 * node/tsx/pnpm/git/psql/source are SAFE, so $(node -e '...') / $(psql -c '...')
 * auto-approve and node -e/tsx can run arbitrary code — intentional, since those
 * already auto-run as single commands under your Bash(*) allow. `curl … | sh`,
 * `wget`, backticks, and process substitution <( ) >( ) still PROMPT.
 * NON_SQL_DANGER scans the RAW command (substitution bodies included), so
 * rm/git-force/etc. anywhere defer. SQL_DANGER (DROP/DELETE/…) defers only when a
 * raw non-local psql carries it (db-query.mjs and local psql are exempt). Trim
 * SAFE/*_DANGER to taste — e.g. drop node/psql for a tighter gate.
 *
 * INSTALL: point .claude/settings.local.json hooks.PreToolUse (matcher "Bash")
 * at this file's absolute path, then restart Claude Code or run /hooks.
 * `claude doctor` validates the JSON (but not that this file exists — check the path).
 */

import { readFileSync } from "node:fs";

// Leading command words safe to auto-approve (top level and inside $(...)).
const SAFE = new Set([
  "cd", "ls", "pwd", "echo", "printf", "cat", "head", "tail", "wc", "sort",
  "uniq", "grep", "rg", "sed", "awk", "cut", "tr", "stat", "test", "true", ":",
  "mkdir", "date", "which", "dirname", "basename",
  "git", "pnpm", "node", "tsx", "npx", "tsc",
  "set", "source", "export", "psql",
  // read-only / harmless additions:
  "netstat", "sleep", "jq",
  // process kill (recoverable; clears orphaned dev servers) + curl (host-guarded below):
  "taskkill", "kill", "curl",
]);

// If any of these appears ANYWHERE in the raw command, never auto-approve.
// These are context-free hazards (filesystem, shell, git, package managers) — a
// literal match is dangerous no matter which tool it rides on.
const NON_SQL_DANGER = [
  /\brm\b/, /\brmdir\b/, /\bdd\b/, /\bmkfs/, /\bshutdown\b/, /\breboot\b/,
  /:\(\)\s*\{/,                              // fork bomb
  // mirrors settings.local.json deny + ask lists:
  /git\s+push\b[^\n]*(--force|-f\b)/, /git\s+reset\s+--hard/, /git\s+clean\b/,
  /git\s+checkout\s+--/,
  /\bnpm\s+(install|i|ci|update)\b/, /\bpnpm\s+(add|dlx|install)\b/, /\byarn\s+add\b/,
  /--no-verify/,
];

// SQL write / DDL. These only pose a risk when a raw `psql` is aimed at a
// NON-local DB (see the call site). db-query.mjs is exempt: its --prod wraps
// SET TRANSACTION READ ONLY (writes fail closed) and --local is disposable
// Docker state; and SQL keywords sitting in prose (e.g. a `pnpm fix:add --body`
// describing a DELETE) can't execute anything. So we DON'T scan these against
// the raw command unconditionally — only against a prod-writable psql invocation.
const SQL_DANGER = [
  /\bDROP\b/i, /\bTRUNCATE\b/i, /\bDELETE\s+FROM/i, /\bUPDATE\s+\w+\s+SET/i,
  /\bINSERT\s+INTO/i, /\bGRANT\b/i, /\bREVOKE\b/i,
  /\bALTER\s+(TABLE|ROLE|DATABASE|SCHEMA|FUNCTION|VIEW|MATERIALIZED|INDEX|POLICY|PUBLICATION)/i,
  /\bCREATE\s+(OR\s+REPLACE\s+)?(TABLE|ROLE|DATABASE|SCHEMA|FUNCTION|VIEW|MATERIALIZED|EXTENSION|INDEX|POLICY|TRIGGER)/i,
  /\\copy\b/i, /\bCOPY\b[^\n]*\bFROM\b/i,
];

// curl auto-approves ONLY for our own hosts (localhost / local + prod Supabase /
// the Vercel app) and read methods. Anything else (external host, no explicit
// URL, or a write method) falls through to a prompt — see the call site.
const ALLOWED_CURL_HOST =
  /^(https?:\/\/)?(127\.0\.0\.1|localhost|([\w-]+\.)?xsazcoxinpgttgquwvuf\.supabase\.co|civitics-civitics\.vercel\.app)([:/]|$)/i;

// Backticks and process substitution <( ) >( ) defer (too hard to reason about).
// $(...) is NOT here — it is validated below.
const TRICKY = /`|<\(|>\(/;

// A segment that is ONLY VAR=val assignments (PW="x" URL="y") is safe on its own.
const ASSIGN_ONLY = /^([A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S+)\s*)+$/;

function defer() { process.exit(0); }                       // no stdout = normal flow
function allow(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

// True iff every &&/||/;/|/newline segment of `text` leads with a SAFE word,
// after masking quoted strings (so operators/parens inside quotes don't split)
// and stripping leading VAR=val prefixes.
function allSegmentsSafe(text) {
  const masked = text
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'[^']*'/g, "''");
  const segs = masked.split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean);
  if (segs.length === 0) return false;
  for (const seg of segs) {
    if (ASSIGN_ONLY.test(seg)) continue;
    const s = seg.replace(/^([A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, "").trim();
    const word = s.split(/\s+/)[0] || "";
    const base = word.replace(/^.*[\\/]/, ""); // strip any path prefix
    if (!SAFE.has(base)) return false;
  }
  return true;
}

// Strip heredoc BODIES so their content lines (SQL: SELECT/FROM/WHERE, etc.) are
// not treated as command segments by allSegmentsSafe's newline split. Matches
//   <<DELIM | <<-DELIM | <<'DELIM' | <<"DELIM"   (rest of opener line) \n body \n DELIM
// and collapses the whole thing to the opener token `<<HEREDOC`. SAFETY: DANGER
// already scanned the RAW command (heredoc body included) before this runs, so a
// write/DDL heredoc still defers; only read-only heredocs (no DANGER hit) survive
// to here, and collapsing the body lets the leading `psql`/`cat`/etc. word decide.
function stripHeredocs(text) {
  return text.replace(
    /<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2\b/g,
    "<<HEREDOC",
  );
}

// Argument window of each `curl` invocation: the text from just after the curl
// token up to the next top-level separator (| ; newline &&) or substitution
// start ($(). Scoping write-method detection to this window stops a sibling
// command's flag — e.g. `tr -d ' '` or `cut -d=` elsewhere on the line — from
// being mistaken for curl's own `-d`/`-T` upload flags.
function curlWindows(s) {
  const wins = [];
  const re = /(^|[\s;&|(=])curl\b/g;
  let m;
  while ((m = re.exec(s))) {
    const rest = s.slice(m.index + m[0].length);
    const end = rest.search(/[|;\n]|&&|\$\(/);
    wins.push(end === -1 ? rest : rest.slice(0, end));
  }
  return wins;
}

// Index of the ) matching the ( at parenIdx, skipping quoted text. -1 if none.
function matchClose(str, parenIdx) {
  let depth = 0, q = null;
  for (let i = parenIdx; i < str.length; i++) {
    const c = str[i];
    if (q) {
      if (q === '"' && c === "\\") { i++; continue; } // skip escaped char in "..."
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

let input;
try { input = JSON.parse(readFileSync(0, "utf8")); } catch { defer(); }

if (!input || input.tool_name !== "Bash") defer();
const cmd = (input.tool_input && input.tool_input.command) || "";
if (!cmd.trim()) defer();
if (TRICKY.test(cmd)) defer();
if (NON_SQL_DANGER.some((re) => re.test(cmd))) defer();

// SQL write/DDL only matters when a raw `psql` targets a non-local DB. A raw
// psql invocation (not the word "psql" in prose) that isn't provably the local
// Docker DB, carrying destructive SQL, defers. db-query.mjs (no `psql ` token)
// and local psql ("...127.0.0.1...") are exempt — see SQL_DANGER note.
const hasRawPsql = /(^|[\s;&|(=])psql\s/.test(cmd);
const provablyLocal = /127\.0\.0\.1|localhost/.test(cmd);
if (hasRawPsql && !provablyLocal && SQL_DANGER.some((re) => re.test(cmd))) defer();

// curl is in SAFE, but auto-approve only for our own hosts + read methods.
// Fail-closed: needs >=1 explicit http(s):// URL, all to allowed hosts, no write
// method. Otherwise (external host, no URL, POST/PUT/-d/-T upload) → prompt.
if (/(^|[\s;&|(=])curl\b/.test(cmd)) {
  const urls = cmd.match(/https?:\/\/[^\s"'`]+/gi) || [];
  const curlWrite = curlWindows(cmd).some((w) =>
    /-X\s*(POST|PUT|PATCH|DELETE)\b|--data\b|--upload-file\b|\s-[dT](\s|=|"|')/i.test(w));
  if (urls.length === 0 || curlWrite || !urls.every((u) => ALLOWED_CURL_HOST.test(u))) defer();
}

// Resolve $(...) substitutions innermost-first (lastIndexOf -> nothing after it,
// so its body has no further $(). Its inner command must also be all-SAFE; then
// collapse it to a token so the outer pass sees e.g. PW=_SUBST_ (an assignment).
// Unbalanced $(...) -> defer. DANGER already scanned the raw command, so a
// dangerous token inside any substitution defers above.
let work = stripHeredocs(cmd);
let guard = 0;
while (true) {
  const open = work.lastIndexOf("$(");
  if (open === -1) break;
  if (++guard > 100) defer();
  const close = matchClose(work, open + 1);
  if (close === -1) defer();
  if (!allSegmentsSafe(work.slice(open + 2, close))) defer();
  work = work.slice(0, open) + "_SUBST_" + work.slice(close + 1);
}

if (!allSegmentsSafe(work)) defer();
allow(`compound-allow v6: all segments + $() inners in safe list (heredocs stripped)`);
