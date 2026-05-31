/**
 * FIX-407 — drift guard for the duplicated source_priority ranking.
 *
 * Runs via:  tsx --test src/__tests__/source-priority-drift.test.ts
 *            (also wired into CI — see .github/workflows/tests.yml)
 *
 * source_priority is hand-duplicated in two places that MUST stay identical or
 * the attribution API's `is_primary` flag diverges from the materialized
 * primary_source column:
 *
 *   1. SQL  — public.source_priority(src) in the latest migration that defines
 *             it (currently 20260526000001_primary_source_materialization.sql,
 *             FIX-397). PostgREST can't apply a SQL function inside .select(),
 *             so the API route can't lean on the DB-side function.
 *   2. TS   — the inlined sourcePriority() const in
 *             apps/civitics/app/api/attribution/[type]/[id]/route.ts (FIX-398).
 *
 * This is option (d) from FIX-407: parse both source files as TEXT, normalize
 * each into an ordered (matcher → priority) list, and assert the two lists are
 * identical. No shared module, no codegen — the const stays inlined; this test
 * is the safety net that fails the moment the two copies drift.
 *
 * Both copies are parsed from disk so the test pins the REAL definitions, not a
 * snapshot. The SQL side scans every migration and uses the LAST file that
 * (re)defines public.source_priority, so a future redefinition migration keeps
 * the guard pointed at the live definition instead of going stale.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type PriorityEntry = { match: string; priority: number };

// Walk up from this file until we find the repo root (the dir that holds
// supabase/migrations). Robust against the test file being relocated.
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "supabase", "migrations"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not locate repo root (no supabase/migrations ancestor)");
}

const REPO_ROOT = findRepoRoot();

/**
 * Parse the latest SQL public.source_priority() CASE block into an ordered list.
 *
 * Normalization (so SQL and TS forms compare equal):
 *   WHEN src = 'X'      THEN N  →  { match: "X",          priority: N }
 *   WHEN src LIKE 'P%'  THEN N  →  { match: "P%",         priority: N }
 *   ELSE N                      →  { match: "*", priority: N }
 */
function parseSqlPriority(): { file: string; entries: PriorityEntry[] } {
  const migrationsDir = join(REPO_ROOT, "supabase", "migrations");
  const sqlFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // timestamp-prefixed → lexical sort is chronological

  // Newest-first: use the last migration that defines the function.
  let chosen: { file: string; text: string } | null = null;
  for (const file of [...sqlFiles].reverse()) {
    const text = readFileSync(join(migrationsDir, file), "utf8");
    if (/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.source_priority\b/i.test(text)) {
      chosen = { file, text };
      break;
    }
  }
  assert.ok(chosen, "no migration defines public.source_priority()");

  // If a single file redefines it more than once, take the LAST definition.
  const defRe = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.source_priority\b/gi;
  let defIdx = -1;
  for (let m = defRe.exec(chosen.text); m; m = defRe.exec(chosen.text)) defIdx = m.index;
  const fromDef = chosen.text.slice(defIdx);

  const caseBlock = fromDef.match(/CASE([\s\S]*?)\bEND\b/i);
  assert.ok(caseBlock, `no CASE block in source_priority() (${chosen.file})`);

  const entries: PriorityEntry[] = [];
  const branchRe = /WHEN\s+src\s*(=|LIKE)\s*'([^']+)'\s+THEN\s+(\d+)|ELSE\s+(\d+)/gi;
  for (let m = branchRe.exec(caseBlock[1]); m; m = branchRe.exec(caseBlock[1])) {
    if (m[4] !== undefined) {
      entries.push({ match: "*", priority: Number(m[4]) });
    } else {
      // m[2] keeps its trailing '%' for the LIKE form; exact form has none.
      entries.push({ match: m[2], priority: Number(m[3]) });
    }
  }
  return { file: chosen.file, entries };
}

/**
 * Parse the inlined TS sourcePriority() into the same normalized ordered list.
 *
 *   if (src === "X")             return N;  →  { match: "X",          priority: N }
 *   if (src.startsWith("P"))     return N;  →  { match: "P%",         priority: N }
 *   return N;            (trailing default) →  { match: "*", priority: N }
 */
function parseTsPriority(): { file: string; entries: PriorityEntry[] } {
  const rel = join("apps", "civitics", "app", "api", "attribution", "[type]", "[id]", "route.ts");
  const file = join(REPO_ROOT, rel);
  const text = readFileSync(file, "utf8");

  const fn = text.match(/function\s+sourcePriority\s*\([^)]*\)\s*:\s*number\s*\{([\s\S]*?)\n\}/);
  assert.ok(fn, `could not locate sourcePriority() in ${rel}`);
  const body = fn[1];

  const entries: PriorityEntry[] = [];
  const branchRe =
    /if\s*\(\s*src\s*===\s*"([^"]+)"\s*\)\s*return\s+(\d+)|if\s*\(\s*src\.startsWith\(\s*"([^"]+)"\s*\)\s*\)\s*return\s+(\d+)|return\s+(\d+)\s*;/g;
  for (let m = branchRe.exec(body); m; m = branchRe.exec(body)) {
    if (m[1] !== undefined) entries.push({ match: m[1], priority: Number(m[2]) });
    else if (m[3] !== undefined) entries.push({ match: `${m[3]}%`, priority: Number(m[4]) });
    else if (m[5] !== undefined) entries.push({ match: "*", priority: Number(m[5]) });
  }
  return { file: rel, entries };
}

test("FIX-407 source_priority SQL function and TS const are in sync", () => {
  const sql = parseSqlPriority();
  const ts = parseTsPriority();

  // Guard against a broken parser silently producing two empty lists that
  // would deep-equal each other and pass vacuously.
  assert.ok(
    sql.entries.length >= 5,
    `SQL parse produced too few branches (${sql.entries.length}) from ${sql.file} — parser likely broke`,
  );
  assert.ok(
    ts.entries.length >= 5,
    `TS parse produced too few branches (${ts.entries.length}) from ${ts.file} — parser likely broke`,
  );

  // Both must terminate in the catch-all default (SQL ELSE / TS trailing return).
  assert.deepEqual(
    sql.entries.at(-1),
    { match: "*", priority: 9999 },
    `SQL source_priority() default branch is not '*'→9999 (${sql.file})`,
  );
  assert.deepEqual(
    ts.entries.at(-1),
    { match: "*", priority: 9999 },
    `TS sourcePriority() default branch is not '*'→9999 (${ts.file})`,
  );

  assert.deepEqual(
    ts.entries,
    sql.entries,
    `source_priority drift: TS const (${ts.file}) and SQL function (${sql.file}) disagree.\n` +
      `  SQL: ${JSON.stringify(sql.entries)}\n` +
      `  TS:  ${JSON.stringify(ts.entries)}`,
  );
});
