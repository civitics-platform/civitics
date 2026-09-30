#!/usr/bin/env node
// scripts/session-held.mjs — `pnpm session:held` (FIX-1250)
//
// Rule 180 says: read `prod_session_state()` and see `held=false` immediately
// before every push to main. Until this script, that read lived only in prompt
// text. Nothing EXITED on `held=true`: cc-167 pushed into cc-166's hold, and
// three sessions printed `(1 row)` without the value. A rule a script does not
// enforce is a rule a truncated output can defeat.
//
// So this reads the state, prints ONE line, and exits on it:
//
//   0  held=false        — push away
//   1  held=true         — a supervised prod session holds the box; wait and re-run
//   2  state unreadable  — no DSN, psql missing, connection or query error
//
//   held=<bool> reason=<…> claimant=<…> claimed_at=<…> expected_minutes=<…> live_writers=<n>
//
// (`claimant` is `prod_session_state()`'s `claimed_by` key.)
//
// `.githooks/pre-push` runs `pnpm -s session:held --pre-push` with git's ref
// lines on stdin (`<local ref> <local sha> <remote ref> <remote sha>`). Only a
// push whose REMOTE ref is refs/heads/main is gated; a feature branch or a tag
// exits 0 without touching the database. The hook refuses the push on 1 AND 2:
// rule 180 REQUIRES the read, so "could not read it" is not "free".
//
// WHERE THE DSN COMES FROM: the PRIMARY checkout's `.env.local.prod`
// (`SUPABASE_DB_PASSWORD`, injected into `supabase/.temp/pooler-url`) — the
// same resolution as `scripts/db-query.mjs --prod`. A worktree's own
// `.env.local.prod` is a stub (reference_worktree_prod_push_env_split), so the
// primary checkout is found through `git rev-parse --git-common-dir`
// (`mainCheckoutRoot`, scripts/lib/cc-config.mjs).
//
// The read is READ ONLY (`default_transaction_read_only = on`) with a 15 s
// statement timeout and a 10 s connect timeout: a hook must not hang a push.
//
// Dependency-free Node, matching its siblings in scripts/; psql does the
// talking, as it does for db-query.mjs.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mainCheckoutRoot } from "./lib/cc-config.mjs";

export const EXIT_FREE = 0;
export const EXIT_HELD = 1;
export const EXIT_UNREADABLE = 2;

const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const POOLER_FALLBACK = `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;
export const MAIN_REF = "refs/heads/main";

const one = (v) => (v === null || v === undefined || v === "" ? "-" : String(v).replace(/\s+/g, "_"));

/**
 * The verdict over a `prod_session_state()` value (or null when it could not be
 * read). Pure — the three exits are asserted from fixtures.
 * @returns {{ exit: 0|1|2, line: string }}
 */
export function judge(state, whyUnreadable = "state unreadable") {
  if (state === null || typeof state !== "object" || typeof state.held !== "boolean") {
    return { exit: EXIT_UNREADABLE, line: `held=unknown — ${whyUnreadable}` };
  }
  const writers = Array.isArray(state.live_writers) ? state.live_writers.length : 0;
  const line =
    `held=${state.held} reason=${one(state.reason)} claimant=${one(state.claimed_by)} ` +
    `claimed_at=${one(state.claimed_at)} expected_minutes=${one(state.expected_minutes)} live_writers=${writers}`;
  return state.held ? { exit: EXIT_HELD, line: `${line} — a supervised prod session holds the box; wait and re-run` } : { exit: EXIT_FREE, line };
}

/**
 * git's pre-push stdin: one `<local ref> <local sha> <remote ref> <remote sha>`
 * line per ref being pushed.
 */
export function parsePushRefs(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(/\s+/))
    .filter((p) => p.length >= 4)
    .map(([localRef, localSha, remoteRef, remoteSha]) => ({ localRef, localSha, remoteRef, remoteSha }));
}

/** True when any ref line pushes to refs/heads/main on the remote. */
export function pushTargetsMain(refs) {
  return refs.some((r) => r.remoteRef === MAIN_REF);
}

function readEnvVar(file, key) {
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[1] === key) return m[2].trim();
  }
  return null;
}

/**
 * The prod DSN from the primary checkout, or `{ error }` saying why not.
 * Mirrors db-query.mjs --prod: the password goes into the cached pooler URL.
 */
export function resolveProdDsn(primaryRoot) {
  const envFile = join(primaryRoot, ".env.local.prod");
  const password = readEnvVar(envFile, "SUPABASE_DB_PASSWORD");
  if (!password) return { error: `SUPABASE_DB_PASSWORD not found in ${envFile}` };
  const poolerFile = join(primaryRoot, "supabase", ".temp", "pooler-url");
  const base = existsSync(poolerFile) ? readFileSync(poolerFile, "utf8").trim() : POOLER_FALLBACK;
  const url = base.replace(/^(postgresql:\/\/[^/@:]+)@/, `$1:${encodeURIComponent(password)}@`);
  if (url === base) return { error: `could not inject the password into the pooler URL (${base})` };
  return { dsn: url };
}

/** Read `prod_session_state()` through psql. Returns `{ state }` or `{ error }`. */
export function queryHeldState(dsn) {
  const sql =
    "SET default_transaction_read_only = on;\n" +
    "SET statement_timeout = '15s';\n" +
    "SELECT public.prod_session_state()::text;\n";
  const res = spawnSync("psql", [dsn, "-q", "-At", "-v", "ON_ERROR_STOP=1"], {
    input: sql,
    encoding: "utf8",
    env: { ...process.env, PGCONNECT_TIMEOUT: "10" },
    // Windows needs a shell to resolve psql on PATH; the args carry no spaces.
    shell: process.platform === "win32",
    timeout: 30_000,
  });
  if (res.error) return { error: `could not run psql (${res.error.message})` };
  if (res.status !== 0) {
    const msg = String(res.stderr || "").trim().split(/\r?\n/).pop() || `psql exited ${res.status}`;
    return { error: msg.replace(/postgresql:\/\/\S+/g, "postgresql://…") };
  }
  const last = String(res.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop();
  try {
    return { state: JSON.parse(last ?? "") };
  } catch {
    return { error: `unparseable prod_session_state() output: ${JSON.stringify((last ?? "").slice(0, 80))}` };
  }
}

/**
 * The whole run, with every side effect injected (the tests pass fakes).
 * @returns {{ exit: number, lines: string[] }}
 */
export function run(argv, deps) {
  const lines = [];
  if (argv.includes("--pre-push")) {
    const refs = parsePushRefs(deps.stdinText ?? "");
    if (!pushTargetsMain(refs)) {
      lines.push(`[session:held] not a push to ${MAIN_REF} — not gated`);
      return { exit: EXIT_FREE, lines };
    }
  }
  const root = deps.primaryRoot();
  const d = deps.resolveDsn(root);
  if (d.error) {
    const v = judge(null, d.error);
    lines.push(`[session:held] ${v.line}`);
    return { exit: v.exit, lines };
  }
  const q = deps.query(d.dsn);
  const v = q.error ? judge(null, q.error) : judge(q.state);
  lines.push(`[session:held] ${v.line}`);
  return { exit: v.exit, lines };
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const argv = process.argv.slice(2);
  const r = run(argv, {
    stdinText: argv.includes("--pre-push") ? readStdin() : "",
    primaryRoot: () => mainCheckoutRoot(),
    resolveDsn: resolveProdDsn,
    query: queryHeldState,
  });
  for (const l of r.lines) (r.exit === EXIT_FREE ? console.log : console.error)(l);
  process.exit(r.exit);
}
