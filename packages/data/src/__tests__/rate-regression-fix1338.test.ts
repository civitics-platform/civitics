/**
 * FIX-1338 — check_pipeline_rate_regression() rates work done
 * (`metadata.desired_rows` when a body stamps it) and admits registry-owned
 * rows that stamp no source. cc-259, `20261104000000_fix1338_…`.
 *
 * Runs via:  tsx --test src/__tests__/rate-regression-fix1338.test.ts
 *
 * Text anchors (no DB, run in CI):
 *   - the file is the LATEST definer; the 4-arg signature, STABLE, SECURITY
 *     DEFINER and the search_path are fix978's; REVOKE/GRANT restated;
 *   - the guarded CASE (`~ '^[0-9]+$'`, NULLIF 0) and the COALESCEd work, with
 *     the `> 0` filter on the COALESCE; the D3 predicate with the job_registry
 *     EXISTS; `denominator` in every element;
 *   - every other line of fix978's body survives, in order (rule 34);
 *   - the read-back RAISEs on the taggers' denominator.
 * Clone tests (CIVITICS_CLONE_TESTS=1, inside BEGIN … ROLLBACK): the two eras
 * rate alike (0.6 s/1k, `ok`); a non-digit or zero stamp rates on rows written
 * without erroring and the window reads `mixed`; a no-source row is IN for a
 * registry pipeline and OUT otherwise, and `pg_cron/backfill` stays OUT; the
 * live run_rule_taggers element reads `desired_rows` and is not sustained.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { body, read, stripComments } from "./lib/migration-text";

const MIGRATIONS = path.join(__dirname, "..", "..", "..", "..", "supabase", "migrations");
const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SIG = "CREATE OR REPLACE FUNCTION public.check_pipeline_rate_regression(";

function one(suffix: string): string {
  const hits = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(suffix));
  assert.equal(hits.length, 1, `expected exactly one *${suffix}, found ${hits.join(", ") || "none"}`);
  return hits[0] as string;
}
const FILE_NAME = one("_fix1338_rate_regression_work_done_denominator.sql");
const SRC = read(path.join(MIGRATIONS, FILE_NAME));
const OLD = read(path.join(MIGRATIONS, "20260808002000_fix978_pipeline_rate_regression.sql"));

test("FIX-1338: this file is the latest definer of check_pipeline_rate_regression", () => {
  const definers = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => read(path.join(MIGRATIONS, f)).includes(SIG));
  assert.equal(definers[definers.length - 1], FILE_NAME);
});

test("FIX-1338: fix978's signature, STABLE, SECURITY DEFINER, search_path; REVOKE/GRANT restated", () => {
  const head = SRC.slice(SRC.indexOf(SIG), SRC.indexOf("AS $$", SRC.indexOf(SIG)));
  assert.match(head, /p_lookback_days\s+int\s+DEFAULT 90,\s*p_recent_runs\s+int\s+DEFAULT 3,\s*p_min_baseline_runs int\s+DEFAULT 5,\s*p_factor\s+numeric DEFAULT 2\.0/);
  assert.match(head, /RETURNS jsonb\s+LANGUAGE plpgsql\s+STABLE\s+SECURITY DEFINER\s+SET search_path = public, pg_catalog/);
  assert.equal((head.match(/\bSET\s+\w+/g) ?? []).length, 1, "search_path is the only SET (FIX-1128)");
  assert.match(SRC, /REVOKE ALL ON FUNCTION public\.check_pipeline_rate_regression\(int, int, int, numeric\)\s+FROM PUBLIC, anon, authenticated;/);
  assert.match(SRC, /GRANT EXECUTE ON FUNCTION public\.check_pipeline_rate_regression\(int, int, int, numeric\)\s+TO service_role;/);
});

test("FIX-1338 D1: the guarded CASE, the COALESCEd work, and shape 1 on the COALESCE", () => {
  const b = stripComments(body(SRC, SIG));
  assert.match(b, /CASE WHEN l\.metadata->>'desired_rows' ~ '\^\[0-9\]\+\$'\s+THEN NULLIF\(\(l\.metadata->>'desired_rows'\)::numeric, 0\)\s+END AS desired/);
  // The cast sits only inside the THEN: nowhere else is desired_rows cast.
  assert.equal((b.match(/'desired_rows'\)::numeric/g) ?? []).length, 1);
  assert.match(b, /COALESCE\(d\.desired, \(COALESCE\(l\.rows_inserted, 0\) \+ COALESCE\(l\.rows_updated, 0\)\)::numeric\) AS work/);
  assert.match(b, /AND COALESCE\(d\.desired, COALESCE\(l\.rows_inserted, 0\) \+ COALESCE\(l\.rows_updated, 0\)\) > 0/);
  assert.doesNotMatch(b, /AND \(COALESCE\(l\.rows_inserted, 0\) \+ COALESCE\(l\.rows_updated, 0\)\) > 0/, "the old shape-1 filter is gone");
});

test("FIX-1338 D3: pg_cron, or no source on a job_registry pipeline", () => {
  const b = stripComments(body(SRC, SIG)).replace(/\s+/g, " ");
  assert.ok(
    b.includes(
      "AND (l.metadata->>'source' = 'pg_cron' OR (l.metadata->>'source' IS NULL " +
        "AND EXISTS (SELECT 1 FROM public.job_registry j WHERE j.pipeline = l.pipeline)))",
    ),
    "the D3 predicate",
  );
  assert.doesNotMatch(b, /AND l\.metadata->>'source' = 'pg_cron' AND/, "the old bare source filter is gone");
});

test("FIX-1338: `denominator` is the recent window's mode, in every element", () => {
  const b = stripComments(body(SRC, SIG));
  assert.match(b, /CASE WHEN bool_and\(desired IS NOT NULL\) THEN 'desired_rows'\s+WHEN bool_or\(desired IS NOT NULL\)\s+THEN 'mixed'\s+ELSE\s+'rows_written'\s+END AS denominator,/);
  assert.match(b, /r\.denominator,/);
  assert.match(b, /'denominator',\s+denominator,/);
});

test("FIX-1338 rule 34: every other line of fix978's body survives, in order", () => {
  const lines = (s: string) =>
    stripComments(s)
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() !== "");
  const replaced = new Set([
    "      (COALESCE(l.rows_inserted, 0) + COALESCE(l.rows_updated, 0))::numeric AS work",
    "      AND l.metadata->>'source' = 'pg_cron'",
    "      AND (COALESCE(l.rows_inserted, 0) + COALESCE(l.rows_updated, 0)) > 0",
  ]);
  const want = lines(body(OLD, SIG)).filter((l) => !replaced.has(l));
  const got = lines(body(SRC, SIG));
  assert.equal(lines(body(OLD, SIG)).length - want.length, 3, "exactly the three changed lines are replaced");
  let i = 0;
  for (const l of got) if (i < want.length && l === want[i]) i += 1;
  assert.equal(i, want.length, `fix978 line not found in order: ${want[i]}`);
});

test("FIX-1338 read-back: grants, proconfig, one call, and a RAISE on the taggers' denominator", () => {
  const rb = SRC.slice(SRC.indexOf("-- ── read-back"));
  assert.match(rb, /v_config IS DISTINCT FROM ARRAY\['search_path=public, pg_catalog'\]/);
  assert.match(rb, /has_function_privilege\('service_role', v_oid, 'EXECUTE'\)/);
  assert.match(rb, /v_result := public\.check_pipeline_rate_regression\(\);/);
  assert.match(rb, /e->>'pipeline' = 'run_rule_taggers'/);
  assert.match(rb, /IF v_el->>'denominator' IS DISTINCT FROM 'desired_rows' THEN/);
  assert.match(rb, /RAISE EXCEPTION '\[fix1338\] read-back failed: %'/);
});

// ---------------------------------------------------------------------------
// Behavioural — the clone (CIVITICS_CLONE_TESTS=1 only)
// ---------------------------------------------------------------------------

async function clone(t: { skip: (m: string) => void }): Promise<Client | null> {
  if (process.env["CIVITICS_CLONE_TESTS"] !== "1") {
    t.skip("set CIVITICS_CLONE_TESTS=1 to run against the migrated clone");
    return null;
  }
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  await c.connect();
  return c;
}

/** BEGIN, then the registry's table lock FIRST (r9's lesson: 40P01 on job_registry). */
async function begin(c: Client): Promise<void> {
  await c.query("BEGIN");
  await c.query("LOCK TABLE public.job_registry IN SHARE ROW EXCLUSIVE MODE");
}

/** A registry row for a throwaway pipeline, copied from an existing row (every NOT NULL column filled). */
async function registryRow(c: Client, pipeline: string): Promise<void> {
  await c.query(
    `INSERT INTO public.job_registry (job, runner, pipeline, unit_shape, unit_call, priority, deadline_rule, cost_class, cap_mb, exclusion_group, budget_seconds, gates, note)
     SELECT replace($1, '_', '-'), runner, $1, unit_shape, unit_call, priority, 'at 0 0 1 1 *', cost_class, cap_mb, exclusion_group, budget_seconds, gates, 'cc-259 clone test'
       FROM public.job_registry WHERE job = 'treemap-individuals-global-refresh'`,
    [pipeline],
  );
}

/** A complete run `daysAgo` back, span `span` s, `inserted` rows, and the given metadata. */
async function run(c: Client, pipeline: string, daysAgo: number, span: number, inserted: number, metadata: object): Promise<void> {
  await c.query(
    `INSERT INTO public.data_sync_log (pipeline, started_at, completed_at, rows_inserted, rows_updated, status, metadata)
     VALUES ($1, now() - make_interval(days => $2::int), now() - make_interval(days => $2::int) + make_interval(secs => $3::int),
             $4, 0, 'complete', $5::jsonb)`,
    [pipeline, daysAgo, span, inserted, JSON.stringify(metadata)],
  );
}

type El = {
  pipeline: string;
  verdict: string;
  denominator: string;
  baseline_runs: number;
  baseline_p90_s_per_1k: number;
  baseline_median_s_per_1k: number;
  recent_min_s_per_1k: number;
  recent_max_s_per_1k: number;
};

async function elements(c: Client, minBaseline = 5): Promise<Map<string, El>> {
  const r = await c.query<{ r: { pipelines: El[] } }>(
    "SELECT public.check_pipeline_rate_regression(90, 3, $1, 2.0) AS r",
    [minBaseline],
  );
  return new Map((r.rows[0]?.r.pipelines ?? []).map((e) => [e.pipeline, e]));
}

test("clone: the DELETE-all era and the merge era rate alike — 0.6 s/1k, ok, no baseline reset", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await begin(c);
    try {
      const P = "fix1338_t";
      await registryRow(c, P);
      // The DELETE-all era: inserted = the whole desired set, no stamp.
      for (const d of [30, 25, 20]) await run(c, P, d, 60, 100000, { source: "pg_cron" });
      // The merge era: one row written, the desired set stamped.
      for (const d of [6, 4, 2]) await run(c, P, d, 60, 1, { source: "pg_cron", desired_rows: 100000 });
      const e = (await elements(c, 3)).get(P);
      assert.ok(e, "rated");
      for (const k of ["baseline_p90_s_per_1k", "baseline_median_s_per_1k", "recent_min_s_per_1k", "recent_max_s_per_1k"] as const) {
        assert.equal(Number(e[k]), 0.6, `${k} reads 0.6 s/1k`);
      }
      assert.equal(e.verdict, "ok", "the eras agree");
      assert.equal(e.denominator, "desired_rows");

      // A seventh, newest row whose stamp is not digits rates on rows written
      // without erroring; a zero stamp is NULLIF'd the same way.
      await run(c, P, 1, 60, 100000, { source: "pg_cron", desired_rows: "abc" });
      await run(c, P, 0, 60, 100000, { source: "pg_cron", desired_rows: "0" });
      const m = (await elements(c, 3)).get(P);
      assert.ok(m, "still rated: a bad stamp must not error the check");
      assert.equal(Number(m.recent_min_s_per_1k), 0.6);
      assert.equal(Number(m.recent_max_s_per_1k), 0.6);
      assert.equal(m.denominator, "mixed", "two rows_written + one desired_rows in the recent window");
      assert.equal(m.verdict, "ok");
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("clone D3: a no-source row is IN for a registry pipeline, OUT without one; pg_cron/backfill stays OUT", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await begin(c);
    try {
      await registryRow(c, "fix1338_reg");
      await registryRow(c, "fix1338_backfill");
      for (const d of [30, 25, 20, 15, 10, 6, 4, 2]) {
        await run(c, "fix1338_reg", d, 60, 1000, {});
        await run(c, "fix1338_noreg", d, 60, 1000, {});
        await run(c, "fix1338_backfill", d, 60, 1000, { source: "pg_cron/backfill" });
      }
      const els = await elements(c);
      const reg = els.get("fix1338_reg");
      assert.ok(reg, "a registry pipeline's no-source rows are rated (D3)");
      assert.equal(reg.denominator, "rows_written");
      assert.equal(Number(reg.recent_min_s_per_1k), 60);
      assert.equal(els.has("fix1338_noreg"), false, "no source and no registry row stays out");
      assert.equal(els.has("fix1338_backfill"), false, "a stamped non-pg_cron source stays out, registry or not");
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("clone: the live run_rule_taggers element reads desired_rows and is not sustained", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    const e = (await elements(c)).get("run_rule_taggers");
    assert.ok(e, "the taggers are rated on the clone");
    assert.equal(e.denominator, "desired_rows");
    assert.notEqual(e.verdict, "sustained_regression");
  } finally {
    await c.end();
  }
});
