#!/usr/bin/env node
// scripts/test-session-held.mjs — `pnpm session:held:test` (FIX-1250)
//
// session:held is the only thing standing between a push to main and a held
// supervised prod session, so each exit is asserted from a fixture state, the
// ref parser is asserted on the three shapes git hands a pre-push hook, and the
// primary-checkout resolution is asserted from a REAL throwaway worktree —
// the case the script exists for (a worktree's .env.local.prod is a stub).
//
// No database, no network: `run()` takes its side effects injected.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  EXIT_FREE,
  EXIT_HELD,
  EXIT_UNREADABLE,
  judge,
  parsePushRefs,
  pushTargetsMain,
  resolveProdDsn,
  run,
} from "./session-held.mjs";
import { mainCheckoutRoot } from "./lib/cc-config.mjs";

const failures = [];
let passes = 0;
function check(label, cond, detail = "") {
  if (cond) {
    passes++;
    console.log(`  ok ${label}`);
  } else failures.push(`  x ${label}${detail ? `\n     ${detail}` : ""}`);
}

const FREE = {
  held: false, defer: false, reason: null, claimed_by: null, claimed_at: null,
  expected_minutes: null, live_writers: [], pid: null,
};
const HELD = {
  held: true, defer: true, reason: "cc-166 FIX-918 landing", claimed_by: "cc-166 FIX-918 landing",
  claimed_at: "2026-09-27T14:02:11Z", expected_minutes: 45, live_writers: [], pid: 12345,
};

// -- judge: the three exits ---------------------------------------------------
console.log("judge:");
{
  const v = judge(FREE);
  check("held=false ⇒ exit 0", v.exit === EXIT_FREE && EXIT_FREE === 0, JSON.stringify(v));
  check("the one line carries every field", v.line === "held=false reason=- claimant=- claimed_at=- expected_minutes=- live_writers=0", v.line);
}
{
  // Rule 105: a live writer is not a hold. held=false must still exit 0.
  const v = judge({ ...FREE, live_writers: ["fec_bulk"] });
  check("held=false with a live writer ⇒ still exit 0, writer counted", v.exit === EXIT_FREE && / live_writers=1$/.test(v.line), v.line);
}
{
  const v = judge(HELD);
  check("held=true ⇒ exit 1", v.exit === EXIT_HELD && EXIT_HELD === 1, JSON.stringify(v));
  check("held=true names who and says wait", /claimant=cc-166_FIX-918_landing/.test(v.line) && /expected_minutes=45/.test(v.line) && /wait and re-run/.test(v.line), v.line);
}
{
  const v = judge(null, "SUPABASE_DB_PASSWORD not found");
  check("unreadable ⇒ exit 2 and says why", v.exit === EXIT_UNREADABLE && EXIT_UNREADABLE === 2 && /SUPABASE_DB_PASSWORD not found/.test(v.line), JSON.stringify(v));
  check("a state with no boolean held is unreadable, never free", judge({ reason: "x" }).exit === EXIT_UNREADABLE);
  check("held as the STRING 'false' is unreadable, never free", judge({ ...FREE, held: "false" }).exit === EXIT_UNREADABLE);
}

// -- the ref-pair parser -------------------------------------------------------
console.log("ref parser:");
{
  const main = parsePushRefs("refs/heads/feature/fix-1238 abc123 refs/heads/main def456\n");
  check("feature:main parses", main.length === 1 && main[0].remoteRef === "refs/heads/main", JSON.stringify(main));
  check("a push to main is gated", pushTargetsMain(main) === true);
  const feat = parsePushRefs("refs/heads/feature/fix-1238 abc123 refs/heads/feature/fix-1238 0000000\n");
  check("a push to a feature branch is NOT gated", pushTargetsMain(feat) === false);
  const tag = parsePushRefs("refs/tags/v1 abc123 refs/tags/v1 0000000\n");
  check("a tag push is NOT gated", pushTargetsMain(tag) === false);
  const mixed = parsePushRefs("refs/tags/v1 a refs/tags/v1 b\r\nrefs/heads/x c refs/heads/main d\r\n");
  check("CRLF + several lines: any line to main gates the push", mixed.length === 2 && pushTargetsMain(mixed));
  check("a branch merely NAMED like main is not main", !pushTargetsMain(parsePushRefs("refs/heads/x a refs/heads/main-old b")));
  check("empty stdin parses to nothing", parsePushRefs("\n\n").length === 0 && parsePushRefs(undefined).length === 0);
}

// -- run(): the pre-push path end to end, fakes injected ----------------------
console.log("run:");
const boom = () => { throw new Error("must not be called"); };
const dsnOk = () => ({ dsn: "postgresql://postgres.x:pw@h:5432/postgres" });
{
  const r = run(["--pre-push"], {
    stdinText: "refs/heads/feature/x a refs/heads/feature/x b\n",
    primaryRoot: boom, resolveDsn: boom, query: boom,
  });
  check("--pre-push to a feature branch ⇒ 0 without touching the DSN or the DB", r.exit === 0 && /not gated/.test(r.lines[0]), JSON.stringify(r));
}
{
  const r = run(["--pre-push"], {
    stdinText: "refs/heads/feature/x a refs/heads/main b\n",
    primaryRoot: () => "/primary", resolveDsn: dsnOk, query: () => ({ state: HELD }),
  });
  check("--pre-push to main under a hold ⇒ 1", r.exit === EXIT_HELD, JSON.stringify(r));
}
{
  const r = run(["--pre-push"], {
    stdinText: "refs/heads/feature/x a refs/heads/main b\n",
    primaryRoot: () => "/primary", resolveDsn: dsnOk, query: () => ({ state: FREE }),
  });
  check("--pre-push to main, free ⇒ 0", r.exit === EXIT_FREE, JSON.stringify(r));
}
{
  const r = run([], {
    primaryRoot: () => "/primary", resolveDsn: () => ({ error: "SUPABASE_DB_PASSWORD not found in /primary/.env.local.prod" }), query: boom,
  });
  check("no DSN ⇒ 2, and the line says which file", r.exit === EXIT_UNREADABLE && /\/primary\/\.env\.local\.prod/.test(r.lines[0]), JSON.stringify(r));
}
{
  const r = run([], {
    primaryRoot: () => "/primary", resolveDsn: dsnOk, query: () => ({ error: "connection refused" }),
  });
  check("a connection error ⇒ 2, never 0", r.exit === EXIT_UNREADABLE && /connection refused/.test(r.lines[0]), JSON.stringify(r));
}
{
  let asked = null;
  const r = run([], {
    primaryRoot: () => "/the/primary", resolveDsn: (root) => { asked = root; return dsnOk(); }, query: () => ({ state: FREE }),
  });
  check("the DSN is resolved against the PRIMARY root", r.exit === 0 && asked === "/the/primary");
}

// -- resolveProdDsn over a temp dir -------------------------------------------
console.log("resolveProdDsn:");
const tmpRoot = mkdtempSync(join(tmpdir(), "cc174-held-"));
{
  const root = join(tmpRoot, "nodsn");
  mkdirSync(root);
  check("no .env.local.prod ⇒ error", /SUPABASE_DB_PASSWORD not found/.test(resolveProdDsn(root).error ?? ""));
}
{
  const root = join(tmpRoot, "withdsn");
  mkdirSync(join(root, "supabase", ".temp"), { recursive: true });
  writeFileSync(join(root, ".env.local.prod"), "OTHER=1\r\nSUPABASE_DB_PASSWORD=p@ss word\r\n");
  writeFileSync(join(root, "supabase", ".temp", "pooler-url"), "postgresql://postgres.ref@pooler.example:5432/postgres\n");
  const d = resolveProdDsn(root);
  check("password injected (URL-encoded) into the cached pooler URL", d.dsn === "postgresql://postgres.ref:p%40ss%20word@pooler.example:5432/postgres", JSON.stringify(d));
}

// -- the primary checkout from a real worktree --------------------------------
console.log("primary checkout from a worktree:");
{
  const repo = join(tmpRoot, "primary");
  mkdirSync(repo);
  const git = (args, cwd = repo) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.invalid"]);
  git(["config", "user.name", "T"]);
  writeFileSync(join(repo, "f.txt"), "x\n");
  git(["add", "f.txt"]);
  git(["commit", "-qm", "root"]);
  const wt = join(tmpRoot, "wt-fix-1");
  git(["worktree", "add", "-q", "-b", "feature/fix-1", wt]);
  const norm = (p) => realpathSync.native(p).toLowerCase().replace(/\\/g, "/");
  const fromWt = mainCheckoutRoot(wt);
  check("mainCheckoutRoot(<worktree>) is the PRIMARY checkout", norm(fromWt) === norm(repo), `${fromWt} vs ${repo}`);
  check("mainCheckoutRoot(<primary>) is itself", norm(mainCheckoutRoot(repo)) === norm(repo));
  try { git(["worktree", "remove", "--force", wt]); } catch {}
}

try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

console.log("");
if (failures.length) {
  console.error(`✗ ${failures.length} assertion(s) failed:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`✓ session:held suite passed (${passes} assertions).`);
