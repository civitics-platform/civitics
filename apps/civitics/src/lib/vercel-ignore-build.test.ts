/**
 * FIX-1359 — the Ignored Build Step (`apps/civitics/vercel.json` "ignoreCommand"
 * → `scripts/vercel-ignore-build.sh`). Before it, `[skip vercel]` skipped
 * nothing: every tagged or docs-only push built production (cc-249).
 *
 * Behavioural: each case builds a throwaway git repo shaped like the monorepo
 * (apps/civitics, packages, docs, the root manifests), points
 * VERCEL_GIT_PREVIOUS_SHA at one commit and HEAD at another, and runs the
 * script from apps/civitics, the way Vercel does. Exit 0 = skip, 1 = build.
 *   - a range whose every commit is [skip vercel]-headed skips, app code or not;
 *   - an untagged docs-only range skips;
 *   - an untagged app change builds;
 *   - an EMPTY untagged tip above a tagged app commit builds — the case a
 *     `git diff HEAD^ HEAD` design gets wrong (every cc run's records push);
 *   - a Preview never builds (the dashboard rule this file overrides);
 *   - no previous sha, an unreachable one, or a redeploy of the same commit
 *     builds: a doubt builds.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP = join(__dirname, "..", "..");
const SCRIPT = join(APP, "scripts", "vercel-ignore-build.sh");
const VERCEL = JSON.parse(readFileSync(join(APP, "vercel.json"), "utf8")) as { ignoreCommand?: string };

test("vercel.json runs the script from the project root", () => {
  assert.equal(VERCEL.ignoreCommand, "bash scripts/vercel-ignore-build.sh");
  const src = readFileSync(SCRIPT, "utf8").replace(/^\s*#.*$/gm, "");
  assert.match(src, /VERCEL_GIT_PREVIOUS_SHA/);
  assert.doesNotMatch(src, /HEAD\^/, "the range is PREVIOUS..HEAD, never HEAD^");
  assert.match(src, /git diff --quiet "\$prev" HEAD -- \. \.\.\/\.\.\/packages \.\.\/\.\.\/package\.json \.\.\/\.\.\/pnpm-lock\.yaml \.\.\/\.\.\/pnpm-workspace\.yaml \.\.\/\.\.\/turbo\.json \.\.\/\.\.\/\.npmrc;/);
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "vercel-ignore-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
  git("init", "-q");
  for (const d of ["apps/civitics", "packages/db", "docs"]) mkdirSync(join(dir, d), { recursive: true });
  const put = (f: string, s: string) => writeFileSync(join(dir, f), s);
  const commit = (msg: string, files: Record<string, string> = {}) => {
    for (const [f, s] of Object.entries(files)) put(f, s);
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", msg);
    return git("rev-parse", "HEAD");
  };
  const run = (prev: string | null, head: string, vercelEnv = "production") => {
    git("checkout", "-q", "--detach", head);
    const env = { ...process.env, VERCEL_ENV: vercelEnv };
    delete env["VERCEL_GIT_PREVIOUS_SHA"];
    if (prev !== null) env["VERCEL_GIT_PREVIOUS_SHA"] = prev;
    return spawnSync("bash", [SCRIPT], { cwd: join(dir, "apps/civitics"), env, encoding: "utf8" });
  };
  return { dir, commit, run };
}

test("skip / build across the five shapes", (t) => {
  const r = repo();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  const base = r.commit("feat: base", {
    "package.json": "{}",
    "apps/civitics/page.tsx": "1",
    "packages/db/index.ts": "1",
    "docs/a.md": "1",
  });
  const tagged = r.commit("[skip vercel] feat(db): a tagged app change", { "packages/db/index.ts": "2" });
  const record = r.commit("chore(fixes): record FIX-1 landed");
  const docs = r.commit("docs(receipts): 2026-10-28", { "docs/a.md": "2" });
  const app = r.commit("feat(app): an untagged app change", { "apps/civitics/page.tsx": "2" });

  const cases: Array<[string, string | null, string, number]> = [
    ["every commit tagged → skip, even with app code", base, tagged, 0],
    ["an empty untagged tip above a tagged app commit → build", base, record, 1],
    ["an untagged docs-only range → skip", record, docs, 0],
    ["an untagged app change → build", docs, app, 1],
    ["no previous sha → build", null, app, 1],
    ["a redeploy of the same commit → build", app, app, 1],
    ["an unreachable previous sha → build", "0123456789abcdef0123456789abcdef01234567", app, 1],
  ];
  for (const [name, prev, head, want] of cases) {
    const res = r.run(prev, head);
    assert.equal(res.status, want, `${name}: ${res.stdout}${res.stderr}`);
  }
  // The dashboard rule vercel.json overrides: a Preview never builds, even an
  // untagged app change with no previous sha (the 01:33Z 10-28 preview did).
  for (const vercelEnv of ["preview", "development", ""]) {
    const res = r.run(null, app, vercelEnv);
    assert.equal(res.status, 0, `VERCEL_ENV=${vercelEnv}: ${res.stdout}${res.stderr}`);
  }
});
