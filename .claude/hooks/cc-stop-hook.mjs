#!/usr/bin/env node
// .claude/hooks/cc-stop-hook.mjs — Stop hook (FIX-1175).
//
// Before CC declares itself done, check two things the tree can settle on its
// own:
//
//   1. `pnpm fixes:check` — done.log in sync with trunk trailers, no off-trunk
//      completion, no checkbox contradicting the derived status.
//   2. `pnpm cc:verify <n>` for every report this run wrote that is newer than
//      the session started — so a report whose claims the tree contradicts
//      never reaches the chat unremarked.
//
// ── What it does NOT do ─────────────────────────────────────────────────────
// It does not block. It writes what it found to stderr, which Claude Code
// surfaces, and exits 0. A Stop hook that blocks turns every genuine
// "I stopped because the prompt said to stop" into a fight, and the failure it
// is guarding against — a wrong claim in a report — is one a human should see
// rather than one a script should silently retry past. Surfaced, not swallowed;
// surfaced, not enforced.
//
// It is also quiet when there is nothing to say. A hook that prints on every
// stop trains you to ignore it.
//
// Wired from .claude/settings.local.json (the tracked settings file in this
// repo — .claude/settings.json is gitignored, so a hook there would live on one
// machine only).

import { execSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const notes = [];
const problems = [];

function run(cmd) {
  try {
    return { ok: true, out: execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function repoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

const root = repoRoot();
if (!root) process.exit(0); // not in a repo — nothing to check

// ── 1. fixes:check ──────────────────────────────────────────────────────────
const fc = run(`node "${resolve(root, "scripts/fixes-sync.mjs")}" --check`);
if (!fc.ok) {
  problems.push("fixes:check FAILED — docs/done.log is out of sync with the trailers on trunk,");
  problems.push("or a completion is backed only by off-trunk commits, or a bullet's checkbox");
  problems.push("contradicts the derived status. Run `pnpm fixes:check` for the detail.");
}

// ── 2. cc:verify on reports touched this session ────────────────────────────
// "This session" is approximated by mtime within the last 12 hours. A report
// from an older run is not this run's claim to defend, and re-verifying the
// whole directory on every stop would be noise.
const reportsDir = resolve(root, "docs/cc/reports");
if (existsSync(reportsDir)) {
  const cutoff = Date.now() - 12 * 3600_000;
  const recent = readdirSync(reportsDir)
    .filter((f) => /^cc-\d+\.md$/.test(f))
    .filter((f) => {
      try {
        return statSync(resolve(reportsDir, f)).mtimeMs >= cutoff;
      } catch {
        return false;
      }
    });
  for (const f of recent) {
    const n = f.match(/^cc-(\d+)\.md$/)[1];
    const res = run(`node "${resolve(root, "scripts/cc-verify.mjs")}" ${n}`);
    if (!res.ok) {
      problems.push(`cc:verify ${n} FAILED — the report claims something the tree contradicts:`);
      for (const line of res.out.split("\n").filter((l) => l.includes("FAIL"))) {
        problems.push(`  ${line.trim()}`);
      }
      problems.push(`  Run \`pnpm cc:verify ${n}\` for the full list.`);
    } else {
      notes.push(`cc:verify ${n} — all claims consistent with the tree.`);
    }
  }
}

if (problems.length) {
  process.stderr.write(`\n[cc-stop-hook] ${problems.length} thing(s) to look at before this is done:\n`);
  for (const p of problems) process.stderr.write(`  ${p}\n`);
  process.stderr.write("\n");
} else if (notes.length) {
  process.stderr.write(`[cc-stop-hook] ${notes.join(" ")}\n`);
}
// Never blocks. See the header.
process.exit(0);
