/**
 * FIX-1357 (cc-252) — `*_fix1357_cap_mb_rederived_for_hash_mem_one.sql` and its
 * revert `scripts/fix1357-revert-cap-mb.sql`: job_registry.cap_mb halved for
 * the multiplier-derived rows once hash_mem_multiplier is 1 (FIX-1356).
 *
 * Runs via:  tsx --test src/__tests__/fix1357-caps.test.ts
 *
 * The fixture is cc-252 read 6, the census of all 55 rows on prod
 * (2026-10-28 00:58Z), each classified by where its cap came from. Source
 * anchors (no DB, run in CI):
 *   - the file's UPDATE set equals the fixture's halved set exactly — every
 *     `body`/`callee`/`role` row, at old → old / 2, and nothing else;
 *   - each UPDATE matches the job AND the exact old cap; 0 rows is a NOTICE
 *     only when the row already reads the new cap, else RAISE;
 *   - the read-back names all 55 rows at their post-file caps (the LEFT rows
 *     at their old ones) and never lowers the dial;
 *   - the revert is the same set in reverse, matched on the new value.
 * Behavioural (CIVITICS_CLONE_TESTS=1): the clone's registry reads the
 * fixture's post-file caps when the file is applied.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { read, stripComments } from "./lib/migration-text";

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const SUFFIX = "_fix1357_cap_mb_rederived_for_hash_mem_one.sql";
const REVERT = path.join(ROOT, "scripts", "fix1357-revert-cap-mb.sql");
const LOCAL_URL =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Where each row's cap came from. `body` / `callee` / `role` are 2 × a work_mem
 * (the multiplier-derived set, halved); `vacuum` is maintenance_work_mem and
 * `gha` a runner row (both LEFT).
 */
type Src = "body" | "callee" | "role" | "vacuum" | "gha";
const READ6: Array<[job: string, cap: number, src: Src]> = [
  ["abuse-events-retention", 128, "role"],
  ["agency-staffing-rollup-refresh", 256, "body"],
  ["audit", 128, "gha"],
  ["box-health-probe", 128, "role"],
  ["contract-flow-rollups-refresh", 128, "body"],
  ["cron-job-budget-watchdog", 128, "role"],
  ["cron-job-run-details-retention", 128, "role"],
  ["crs-summaries", 128, "gha"],
  ["derived-mvs-unit-watchdog", 128, "role"],
  ["dispatcher-tick", 128, "role"],
  ["donation-edge-orphan-sweep", 128, "body"],
  ["donor-party-rollup-orphan-sweep", 128, "body"],
  ["donor-party-rollup-refresh", 128, "body"],
  ["donor-rollup-orphan-sweep", 128, "body"],
  ["donor-rollup-refresh", 128, "callee"],
  ["dpr-vacuum-analyze", 64, "vacuum"],
  ["ec-crawl", 128, "body"],
  ["ec-vacuum-analyze", 64, "vacuum"],
  ["ecs-vacuum-analyze", 64, "vacuum"],
  ["entity-connection-stats-orphan-sweep", 128, "body"],
  ["entity-connection-stats-rebuild", 128, "callee"],
  ["fe-crawl", 128, "callee"],
  ["fe-inbound-rollup-refresh", 128, "callee"],
  ["fe-vacuum-analyze", 64, "vacuum"],
  ["financial-entity-totals-incremental", 256, "body"],
  ["financial-entity-totals-reconcile", 128, "body"],
  ["fixes-housekeep", 128, "gha"],
  ["fr-vacuum-analyze", 64, "vacuum"],
  ["group-donor-rollup-refresh", 128, "callee"],
  ["irs990", 128, "gha"],
  ["nightly", 128, "gha"],
  ["odbt-vacuum-analyze", 64, "vacuum"],
  ["odr-mv-vacuum-analyze", 64, "vacuum"],
  ["odt-vacuum-analyze", 64, "vacuum"],
  ["officials-vacuum-analyze", 64, "vacuum"],
  ["osar-vacuum-analyze", 64, "vacuum"],
  ["osdr-vacuum-analyze", 64, "vacuum"],
  ["platform-counts-daily", 128, "role"],
  ["platform-snapshot", 128, "gha"],
  ["rebuild-ec-incremental", 128, "body"],
  ["rebuild-ec-incremental-mon", 128, "body"],
  ["refresh-derived-mvs-daily", 256, "body"],
  ["refresh-derived-mvs-weekly", 256, "body"],
  ["refresh-disposable-emails", 128, "gha"],
  ["rule-taggers-daily", 128, "body"],
  ["rule-taggers-weekly", 128, "body"],
  ["sync-canary-check", 128, "gha"],
  ["treemap-individuals-global-refresh", 128, "body"],
  ["treemap-individuals-vacuum-analyze", 64, "vacuum"],
  ["vm-probe-pre-ec", 128, "role"],
  ["vm-probe-pre-fe", 128, "role"],
  ["vm-probe-pre-fr", 128, "role"],
  ["vote-stats-refresh", 128, "body"],
  ["votes-vacuum-analyze", 64, "vacuum"],
  ["xsr-vacuum-analyze", 64, "vacuum"],
];
const HALVED = READ6.filter(([, , s]) => s === "body" || s === "callee" || s === "role");
const AFTER = new Map(READ6.map(([j, cap, s]) => [j, s === "vacuum" || s === "gha" ? cap : cap / 2]));

const FILE = () => {
  const hits = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(SUFFIX));
  assert.equal(hits.length, 1, `expected exactly one *${SUFFIX}, found ${hits.join(", ") || "none"}`);
  return read(path.join(MIGRATIONS, hits[0] as string));
};

/** The (job, old, new) triples of the first VALUES list in `sql`. */
function triples(sql: string): string[] {
  const block = sql.match(/FROM \(VALUES([\s\S]*?)\) AS h\(job, old_cap, new_cap\)/);
  assert.ok(block, "no VALUES … AS h(job, old_cap, new_cap)");
  return [...(block[1] as string).matchAll(/\('([a-z0-9-]+)',\s*(\d+),\s*(\d+)\)/g)].map((m) => `${m[1]} ${m[2]}→${m[3]}`).sort();
}

test("the fixture: 55 rows, 33 halved, 22 left, Σ 6656 → 4288", () => {
  assert.equal(READ6.length, 55);
  assert.equal(new Set(READ6.map(([j]) => j)).size, 55);
  assert.equal(HALVED.length, 33);
  for (const [j, cap, s] of READ6) {
    if (s === "vacuum") assert.equal(cap, 64, j);
    if (s === "gha") assert.equal(cap, 128, j);
  }
  assert.equal(READ6.reduce((t, [, c]) => t + c, 0), 6656);
  assert.equal([...AFTER.values()].reduce((t, c) => t + c, 0), 4288);
});

test("the file's UPDATE set equals read 6's halved set exactly", () => {
  const want = HALVED.map(([j, cap]) => `${j} ${cap}→${cap / 2}`).sort();
  assert.deepEqual(triples(stripComments(FILE())), want);
});

test("each UPDATE matches the job AND the exact old cap; 0 rows is a NOTICE only at the new cap", () => {
  const sql = stripComments(FILE());
  assert.match(sql, /UPDATE public\.job_registry\s+SET cap_mb\s+= r\.new_cap,[\s\S]*?WHERE job = r\.job\s+AND cap_mb = r\.old_cap;/);
  assert.ok(sql.includes("GET DIAGNOSTICS v_n = ROW_COUNT;"));
  assert.ok(sql.includes("IF v_cap = r.new_cap THEN"));
  assert.match(sql, /RAISE EXCEPTION '\[fix1357\] % reads cap_mb %/);
  assert.doesNotMatch(sql, /UPDATE public\.platform_dials/, "the dial stays");
  assert.doesNotMatch(sql, /\b(DELETE|INSERT)\b/);
});

test("the read-back names all 55 rows at their post-file caps", () => {
  const sql = stripComments(FILE());
  const block = sql.match(/FROM \(VALUES([\s\S]*?)\) AS e\(job, want\)/);
  assert.ok(block);
  const got = [...(block[1] as string).matchAll(/\('([a-z0-9-]+)',\s*(\d+)\)/g)].map((m) => `${m[1]}=${m[2]}`).sort();
  assert.deepEqual(got, [...AFTER].map(([j, c]) => `${j}=${c}`).sort());
  assert.ok(sql.includes("WHERE j.cap_mb IS DISTINCT FROM e.want;"), "a missing row reads NULL and fails");
  assert.match(sql, /RAISE EXCEPTION '\[fix1357\] read-back failed: %'/);
});

test("the revert is the same set, back to the old caps, matched on the new value", () => {
  const rv = read(REVERT);
  const code = stripComments(rv);
  assert.deepEqual(triples(code), HALVED.map(([j, cap]) => `${j} ${cap}→${cap / 2}`).sort());
  assert.match(code, /SET cap_mb = r\.old_cap, updated_at = now\(\)\s+WHERE job = r\.job AND cap_mb = r\.new_cap;/);
  assert.match(code, /RAISE EXCEPTION '\[fix1357 revert\]/);
  assert.ok(rv.includes("--prod --call --yes-i-mean-prod --file scripts/fix1357-revert-cap-mb.sql"));
});

test("clone: the registry reads the post-file caps", async (t) => {
  if (process.env["CIVITICS_CLONE_TESTS"] !== "1") {
    t.skip("set CIVITICS_CLONE_TESTS=1 to run against the migrated clone");
    return;
  }
  const c = new Client({ connectionString: LOCAL_URL });
  try {
    await c.connect();
  } catch {
    t.skip("local clone unreachable");
    return;
  }
  try {
    const rows = (await c.query<{ job: string; cap_mb: number; note: string }>(
      "SELECT job, cap_mb, note FROM public.job_registry",
    )).rows;
    if (!rows.some((r) => /FIX-1357/.test(r.note))) {
      t.skip("FIX-1357 not applied on the clone");
      return;
    }
    for (const [j, want] of AFTER) {
      const r = rows.find((x) => x.job === j);
      assert.ok(r, `${j} missing on the clone`);
      assert.equal(r.cap_mb, want, j);
    }
  } finally {
    await c.end();
  }
});
