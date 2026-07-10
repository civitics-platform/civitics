#!/usr/bin/env node
/*
 * Claude Code PreToolUse hook — auto-approve SAFE compound Bash commands. (v8)
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
 *   v7  join backslash-newline continuations before splitting (multi-line
 *       `psql -c … \<nl> -c …` no longer defers on a `-c` leading word). Added
 *       supabase/gh/python/python3 to SAFE, with NON_SQL_DANGER guards that keep
 *       outward/prod-mutating verbs deferring (supabase db push/reset/link, gh
 *       workflow run / run cancel / pr merge / release / secret / api -X POST).
 *   v8  real prompts from the FIX-784/785 sessions: (1) shell control flow —
 *       `for x in …` word lists, do/done/then/fi/break as bare or prefix words,
 *       `exec`/`xargs`/`nohup` wrappers, and `# comment` lines — is handled, so
 *       port-kill loops and `cd X && exec pnpm dev` auto-approve; (2) tee + seq
 *       added to SAFE; (3) backtick/process-substitution detection is now a
 *       quote-aware scanner (a template literal inside a single-quoted
 *       `node -e '…'` program is inert to the shell and no longer defers;
 *       backticks in double quotes or bare still do); (4) curl write methods
 *       (-X POST/-d/-T) auto-approve when EVERY url in the command is loopback
 *       (127.0.0.1/localhost — local dev server + local Supabase are
 *       disposable); write-to-remote still prompts.
 *
 * The shell-PARSING classes (quotes, pipes, redirects, ${VAR}, $(...), nesting)
 * are now handled. If something still prompts, it's almost always a real leading
 * word that isn't in SAFE (jq, xargs, find, a for-loop, etc.) — add it to SAFE.
 *
 * SECURITY SURFACE = the SAFE set, applied at top level AND inside $(...).
 * node/tsx/pnpm/git/psql/source are SAFE, so $(node -e '...') / $(psql -c '...')
 * auto-approve and node -e/tsx can run arbitrary code — intentional, since those
 * already auto-run as single commands under your Bash(*) allow. `curl … | sh`,
 * `wget`, unquoted/double-quoted backticks, and process substitution <( ) >( )
 * still PROMPT (single-quoted backticks are inert to the shell and pass).
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
  "netstat", "sleep", "jq", "seq", "tee",
  // process kill (recoverable; clears orphaned dev servers) + curl (host-guarded below):
  "taskkill", "kill", "curl",
  // CLIs whose read/monitor subcommands dominate — their outward/mutating verbs
  // (supabase db push/reset, gh workflow run / pr merge / api -X POST, …) are
  // gated in NON_SQL_DANGER below. python -c is arbitrary-code, same as node -e.
  "supabase", "gh", "python", "python3",
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
  // supabase/gh: read + local-migration subcommands ride SAFE; these outward or
  // prod-mutating verbs defer to a prompt. (pnpm db:push:prod is the sanctioned
  // prod-apply wrapper and carries no literal "supabase db push", so it's unaffected.)
  /\bsupabase\s+db\s+(push|reset|remote)\b/i, /\bsupabase\s+(link|unlink)\b/i,
  /\bsupabase\s+(secrets|projects|orgs)\b/i, /\bsupabase\s+functions\s+deploy\b/i,
  /\bgh\s+workflow\s+run\b/i, /\bgh\s+run\s+(cancel|rerun|delete)\b/i,
  /\bgh\s+pr\s+(create|merge|close|edit|comment|review|ready)\b/i,
  /\bgh\s+release\s+(create|delete|edit|upload)\b/i,
  /\bgh\s+repo\s+(create|delete|archive|edit|sync)\b/i,
  /\bgh\s+(secret|variable)\s+(set|delete|remove)\b/i,
  /\bgh\s+issue\s+(create|close|edit|comment|delete|reopen)\b/i,
  /\bgh\s+api\b[^\n]*(-X\s*(POST|PUT|PATCH|DELETE)|--method[ =](POST|PUT|PATCH|DELETE))/i,
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

// Hosts where curl WRITE methods (-X POST/-d/-T) are still auto-approvable:
// the local dev server and local Docker Supabase are disposable state.
const LOOPBACK_URL = /^(https?:\/\/)?(127\.0\.0\.1|localhost)([:/]|$)/i;

// Backticks and process substitution <( ) >( ) defer (too hard to reason
// about) — but only OUTSIDE single quotes, where the shell would actually
// execute them. A backtick inside '…' (e.g. a JS template literal in a
// `node -e '…'` program) is inert. Inside "…" backticks DO execute, so they
// still defer. The scanner mirrors bash quoting exactly, including \-escapes.
// $(...) is NOT handled here — it is validated below.
function trickyOutsideSingleQuotes(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") { if (c === "'") q = null; continue; }
    if (q === '"') {
      if (c === "\\") { i++; continue; }
      if (c === '"') { q = null; continue; }
      if (c === "`") return true;
      continue;
    }
    if (c === "\\") { i++; continue; }
    if (c === "'") { q = "'"; continue; }
    if (c === '"') { q = '"'; continue; }
    if (c === "`") return true;
    if ((c === "<" || c === ">") && s[i + 1] === "(") return true;
  }
  return false;
}

// A segment that is ONLY VAR=val assignments (PW="x" URL="y") is safe on its own.
const ASSIGN_ONLY = /^([A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S+)\s*)+$/;
// Leading VAR=val assignments before a command (`PW=x psql …`).
const ASSIGN_PREFIX = /^([A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/;
// Shell control-flow / wrapper words that may PRECEDE the real command in a
// segment (`do curl …`, `if [ -f x ]`, `exec pnpm dev`, `xargs grep …`) —
// strip them, then judge what's left. `for` is NOT here: what follows it is a
// word list, not a command, so it gets its own inert-pattern check instead.
const KEYWORD_PREFIX = /^((?:if|then|elif|else|do|while|until|exec|xargs|nohup|!)\s+)+/;
// Segments that are ONLY a control-flow word carry no command at all.
const BARE_KEYWORDS = new Set(["then", "do", "done", "fi", "else", "esac", "break", "continue", "!"]);

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
    if (seg.startsWith("#")) continue;                  // comment line
    if (ASSIGN_ONLY.test(seg)) continue;
    let s = seg.replace(ASSIGN_PREFIX, "").trim();
    // `for x in <words>` — the word list is inert data ($(…) inside it was
    // already resolved/validated); the loop BODY arrives as do/… segments.
    if (/^for\s+[A-Za-z_]\w*\s+in\b/.test(s)) continue;
    s = s.replace(KEYWORD_PREFIX, "").trim();
    s = s.replace(ASSIGN_PREFIX, "").trim();            // `do PW=x psql …`
    if (!s || BARE_KEYWORDS.has(s)) continue;
    const word = s.split(/\s+/)[0] || "";
    const base = word.replace(/^.*[\\/]/, ""); // strip any path prefix
    if (base === "[" || base === "[[") continue;        // test brackets: [ -f x ]
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
const rawCmd = (input.tool_input && input.tool_input.command) || "";
if (!rawCmd.trim()) defer();
// Join backslash-newline line continuations (the shell removes them) so a
// wrapped command — e.g. a psql with several `-c`/`-f` args across lines — is
// one logical line instead of segments that lead with `-c`/`-f` (not in SAFE).
const cmd = rawCmd.replace(/\\\r?\n/g, " ");
if (trickyOutsideSingleQuotes(cmd)) defer();
if (NON_SQL_DANGER.some((re) => re.test(cmd))) defer();

// SQL write/DDL only matters when a raw `psql` targets a non-local DB. A raw
// psql invocation (not the word "psql" in prose) that isn't provably the local
// Docker DB, carrying destructive SQL, defers. db-query.mjs (no `psql ` token)
// and local psql ("...127.0.0.1...") are exempt — see SQL_DANGER note.
const hasRawPsql = /(^|[\s;&|(=])psql\s/.test(cmd);
const provablyLocal = /127\.0\.0\.1|localhost/.test(cmd);
if (hasRawPsql && !provablyLocal && SQL_DANGER.some((re) => re.test(cmd))) defer();

// curl is in SAFE, but auto-approve only for our own hosts. Read methods may
// target any allowed host; WRITE methods (-X POST/PUT/PATCH/DELETE, --data,
// -d, -T) auto-approve only when EVERY url in the command is loopback — the
// local dev server / local Supabase are disposable, the prod hosts are not.
// Fail-closed: needs >=1 explicit http(s):// URL. Otherwise (external host,
// no URL, write-to-remote) → prompt.
if (/(^|[\s;&|(=])curl\b/.test(cmd)) {
  const urls = cmd.match(/https?:\/\/[^\s"'`]+/gi) || [];
  const curlWrite = curlWindows(cmd).some((w) =>
    /-X\s*(POST|PUT|PATCH|DELETE)\b|--data\b|--upload-file\b|\s-[dT](\s|=|"|')/i.test(w));
  if (urls.length === 0 || !urls.every((u) => ALLOWED_CURL_HOST.test(u))) defer();
  if (curlWrite && !urls.every((u) => LOOPBACK_URL.test(u))) defer();
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
allow(`compound-allow v8: all segments + $() inners in safe list (heredocs stripped)`);
