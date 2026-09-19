/**
 * FIX-1198 — where a script's relative output path resolves to.
 *
 * `path.join("docs","audits")` resolves against the CWD, and
 * `pnpm --filter @civitics/data …` runs with the CWD set to `packages/data`.
 * So a script that means "the repo's docs/audits" and says it relatively
 * writes `packages/data/docs/audits/` instead — into a directory nothing reads,
 * with a success line on stdout either way. That is the same shape as the drain
 * hazard in CLAUDE.md ("pnpm resolves --output paths from package cwd; running
 * from repo root claims 12 batches then fails to write the files").
 *
 * The walk-up for `pnpm-workspace.yaml` is the answer receipts-daily.ts
 * (FIX-1176) already arrived at; this is that function, lifted so both callers
 * share one copy rather than two that can drift.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The monorepo root — the nearest ancestor of THIS file holding
 * `pnpm-workspace.yaml`. Anchored on the module's own location, never on the
 * CWD, because the CWD is exactly what is unreliable here.
 *
 * `label` prefixes the warning emitted when the walk-up fails, so a caller is
 * identifiable in a log.
 */
export function repoRoot(label = "repo-root"): string {
  // fileURLToPath, not URL.pathname — the latter keeps percent-encoding and a
  // leading slash before a Windows drive letter, and both are silent wrong
  // answers rather than errors.
  let dir = resolve(dirname(fileURLToPath(import.meta.url)));
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  // Falling back to cwd is wrong in the pnpm --filter case, so say so loudly
  // rather than writing somewhere surprising.
  console.warn(
    `[${label}] could not locate the repo root (no pnpm-workspace.yaml above this file) — resolving against the cwd`,
  );
  return process.cwd();
}

/**
 * Resolve a caller-supplied output directory. An ABSOLUTE path is taken
 * verbatim — an operator who names a directory means that directory. A
 * relative one is resolved against the repo root, never the CWD.
 */
export function resolveUnderRepoRoot(outDir: string, label = "repo-root"): string {
  return isAbsolute(outDir) ? outDir : join(repoRoot(label), outDir);
}
