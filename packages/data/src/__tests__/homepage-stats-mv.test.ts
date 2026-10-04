/**
 * FIX-1145 — official_homepage_stats_mv reads official_donor_totals +
 * official_vote_stats instead of scanning financial_relationships, and
 * donor_rollup_rebuild_bulk (jobid 24) refreshes it after a run that moved the
 * watermark (20261004190000_fix1145_homepage_stats_mv_reads_rollups.sql, cc-195).
 *
 * Runs via:  tsx --test src/__tests__/homepage-stats-mv.test.ts
 *
 * (v) Source anchors (no DB, run in CI). The MV body reads the two rollups and
 * no financial_relationships, and its columns are the four the readers use plus
 * refreshed_at (financial_relationship_count dropped; database.ts agrees). The
 * hook is the ONE refresh in the procedure. It sits after the watermark write
 * and the final COMMIT, before the last unlock, with no RETURN after it. So the
 * caught-up exit and the canceled / failed / backoff / budget closes never
 * reach it. The body minus the hook is 20261003030000's body byte for byte
 * (rule 34: +N / -0), with no proconfig and the grants restated.
 *
 * Rule 105 — every checker is also run against the twin it must reject: the
 * OLD body (20260902120000's FR scan, which still "has the right columns" for
 * the readers), and the hook moved INTO the caught-up branch (which still
 * refreshes the MV, just on the path that moved nothing). A checker that
 * passes everything fails here.
 *
 * (i) Behavioural, against the local clone, only with CIVITICS_DB_HEAVY_TESTS=1
 * (two CALLs that COMMIT, so no BEGIN … ROLLBACK). Both bodies in one snapshot
 * agree for every official. A run that moves the watermark stamps
 * homepage_mv_refreshed=true and advances the MV's refreshed_at. A caught-up
 * run does neither. Skips when the DB is unreachable or the migration is not
 * applied.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const MIGRATION = path.join(MIGRATIONS, "20261004190000_fix1145_homepage_stats_mv_reads_rollups.sql");
const PRIOR_PROC = path.join(MIGRATIONS, "20261003030000_fix1194_p1a_box_backoff_gates.sql");
const PRIOR_MV = path.join(MIGRATIONS, "20260902120000_fix1134_1032_official_homepage_stats_single_fr_scan.sql");
const DATABASE_TS = path.join(ROOT, "packages", "db", "src", "types", "database.ts");
const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const HEAVY = process.env["CIVITICS_DB_HEAVY_TESTS"] === "1";

const SRC = fs.readFileSync(MIGRATION, "utf8");

const HOOK_OPEN = "  -- >>> FIX-1145";
const HOOK_CLOSE = "  -- <<< FIX-1145\n";
const REFRESH = "REFRESH MATERIALIZED VIEW CONCURRENTLY public.official_homepage_stats_mv;";
const CAUGHT_UP = "IF v_watermark IS NOT NULL AND v_sweep_tgt <= v_watermark THEN";

/** `--` comments removed, so an anchor never matches prose. */
const stripComments = (s: string) => s.replace(/--[^\n]*/g, "");

/** The procedure's definition: CREATE through its closing `$procedure$;`. */
function procedure(src: string): string {
  const i = src.indexOf("CREATE OR REPLACE PROCEDURE public.donor_rollup_rebuild_bulk()");
  assert.notEqual(i, -1, "donor_rollup_rebuild_bulk is defined");
  const end = src.indexOf("$procedure$;", src.indexOf("AS $procedure$", i) + 1);
  return src.slice(i, end + "$procedure$;".length);
}

/** The `CREATE MATERIALIZED VIEW public.official_homepage_stats_mv_new AS … DATA;` statement. */
function mvBody(src: string): string {
  const i = src.indexOf("CREATE MATERIALIZED VIEW public.official_homepage_stats_mv_new AS");
  assert.notEqual(i, -1, "the _new twin is created");
  const end = src.slice(i).search(/WITH (NO )?DATA;/);
  return stripComments(src.slice(i, i + end));
}

const READER_COLUMNS = ["official_id", "vote_count", "donor_count", "total_donations_cents", "refreshed_at"];

/** Everything wrong with an MV body; [] = the FIX-1145 shape. */
function mvBodyProblems(body: string): string[] {
  const p: string[] = [];
  if (/\bfinancial_relationships\b/.test(body)) p.push("reads financial_relationships");
  if (!/\bpublic\.official_donor_totals\b/.test(body)) p.push("does not read official_donor_totals");
  if (!/\bpublic\.official_vote_stats\b/.test(body)) p.push("does not read official_vote_stats");
  // The output columns: the aliases of the outermost SELECT (the one FROM officials).
  const from = body.lastIndexOf("FROM public.officials o");
  const select = body.lastIndexOf("SELECT", from);
  const cols = [...body.slice(select, from).matchAll(/\bAS\s+(\w+)/g)].map((m) => m[1]);
  if (JSON.stringify(cols) !== JSON.stringify(READER_COLUMNS)) p.push(`columns ${cols.join(", ")}`);
  return p;
}

/** Everything wrong with the hook's placement in a procedure body; [] = correct. */
function hookProblems(proc: string): string[] {
  const p: string[] = [];
  const code = stripComments(proc);
  const hits = code.split(REFRESH).length - 1;
  if (hits !== 1) p.push(`${hits} refreshes of the MV (want exactly 1)`);
  const at = code.indexOf(REFRESH);
  if (at < 0) return p;
  const watermark = code.indexOf("VALUES ('donor_rollup_watermark'");
  if (watermark < 0 || at < watermark) p.push("refresh precedes the watermark write");
  const lastCommit = code.lastIndexOf("COMMIT;");
  if (at < lastCommit) p.push("refresh precedes the final COMMIT (it would ride the sweep's transaction)");
  const unlock = code.lastIndexOf("PERFORM pg_advisory_unlock(c_lock_key);");
  if (at > unlock) p.push("refresh follows the last unlock");
  if (/\bRETURN\b/.test(code.slice(at))) p.push("a RETURN follows the refresh (an exit path reaches the hook)");
  const cu = code.indexOf(CAUGHT_UP);
  const cuEnd = code.indexOf("RETURN;", cu);
  if (cu >= 0 && at > cu && at < cuEnd) p.push("refresh is inside the caught-up branch");
  // The receipt key, both ways, and a handler that also catches a cancel.
  if (!/'homepage_mv_refreshed', true/.test(code)) p.push("no homepage_mv_refreshed=true stamp");
  if (!/'homepage_mv_refreshed', false/.test(code)) p.push("no homepage_mv_refreshed=false stamp");
  if (!/EXCEPTION WHEN query_canceled OR OTHERS THEN/.test(code.slice(at))) p.push("handler misses query_canceled");
  return p;
}

/** The procedure with the FIX-1145 block removed. */
function withoutHook(proc: string): string {
  const a = proc.indexOf(HOOK_OPEN);
  const b = proc.indexOf(HOOK_CLOSE);
  assert.ok(a > 0 && b > a, "the hook is fenced by its markers");
  return proc.slice(0, a) + proc.slice(b + HOOK_CLOSE.length);
}

function hookBlock(proc: string): string {
  return proc.slice(proc.indexOf(HOOK_OPEN), proc.indexOf(HOOK_CLOSE) + HOOK_CLOSE.length);
}

// ---------------------------------------------------------------------------
// (v) Source anchors — no database.
// ---------------------------------------------------------------------------

test("FIX-1145 (v): the MV body reads the two rollups, not financial_relationships; four reader columns", () => {
  assert.deepEqual(mvBodyProblems(mvBody(SRC)), []);
  // LEFT JOINs from officials, COALESCEd to 0 (officials with no donation have no rollup row).
  const body = mvBody(SRC);
  assert.match(body, /LEFT JOIN public\.official_vote_stats\s+vs ON vs\.official_id = o\.id/);
  assert.match(body, /LEFT JOIN public\.official_donor_totals dt ON dt\.official_id = o\.id/);
  assert.match(body, /COALESCE\(dt\.donor_count, 0\)::BIGINT AS donor_count/);
  assert.match(body, /COALESCE\(dt\.total_cents, 0\)::BIGINT AS total_donations_cents/);
  assert.match(body, /COALESCE\(vs\.total_votes, 0\)::BIGINT AS vote_count/);
});

test("FIX-1145 (v) rule 105 twin: the OLD FR-scan body is rejected by the same checker", () => {
  const old = mvBodyProblems(mvBody(fs.readFileSync(PRIOR_MV, "utf8")));
  assert.ok(old.includes("reads financial_relationships"), old.join("; "));
  assert.ok(old.some((x) => x.startsWith("columns ")), "the dropped column is caught too");
});

test("FIX-1145 (v): the swap — populated twin, pk index, grants, atomic DROP + RENAME, idempotent guard", () => {
  assert.match(SRC, /pg_get_viewdef\('public\.official_homepage_stats_mv'::regclass\) NOT LIKE '%financial_relationships%'/);
  assert.match(SRC, /CREATE UNIQUE INDEX official_homepage_stats_mv_new_pk\s+ON public\.official_homepage_stats_mv_new \(official_id\);/);
  assert.match(SRC, /GRANT SELECT ON public\.official_homepage_stats_mv_new\s+TO anon, authenticated, service_role;/);
  const cut = SRC.slice(SRC.indexOf("DO $swap_cutover$"));
  const drop = cut.indexOf("DROP MATERIALIZED VIEW public.official_homepage_stats_mv;");
  const rename = cut.indexOf("RENAME TO official_homepage_stats_mv;");
  const idx = cut.indexOf("RENAME TO official_homepage_stats_mv_pk;");
  assert.ok(drop > 0 && rename > drop && idx > rename, "DROP → RENAME → index RENAME in one DO block");
  assert.ok(cut.indexOf("IF v_differing > v_bound THEN") < drop, "the equivalence refusal precedes the DROP");
  assert.ok(cut.indexOf("$swap_cutover$;") > idx, "all three inside the cutover block");
});

test("FIX-1145 (v): database.ts — the MV's Row type is the four reader columns plus refreshed_at", () => {
  const ts = fs.readFileSync(DATABASE_TS, "utf8");
  const i = ts.indexOf("      official_homepage_stats_mv: {");
  assert.notEqual(i, -1);
  const row = ts.slice(ts.indexOf("Row: {", i), ts.indexOf("}", ts.indexOf("Row: {", i)));
  const keys = [...row.matchAll(/^\s+(\w+): /gm)].map((m) => m[1]).sort();
  assert.deepEqual(keys, [...READER_COLUMNS].sort());
});

test("FIX-1145 (v): the hook — one refresh, after the watermark write and the final COMMIT, never on an exit", () => {
  assert.deepEqual(hookProblems(procedure(SRC)), []);
});

test("FIX-1145 (v) rule 105 twin: the hook moved into the caught-up branch is rejected", () => {
  const proc = procedure(SRC);
  const hook = hookBlock(proc);
  const bare = withoutHook(proc);
  const at = bare.indexOf(CAUGHT_UP) + CAUGHT_UP.length + 1;
  const twin = bare.slice(0, at) + hook + bare.slice(at);
  const problems = hookProblems(twin);
  assert.ok(problems.includes("refresh is inside the caught-up branch"), problems.join("; "));
  // …and the twin that refreshes inside the sweep's own last transaction.
  const tail = bare.lastIndexOf("  COMMIT;\n");
  const twin2 = bare.slice(0, tail) + hook + bare.slice(tail);
  assert.ok(hookProblems(twin2).some((x) => x.startsWith("refresh precedes the final COMMIT")));
});

test("FIX-1145 (v) rule 34: the body minus the hook is 20261003030000's body byte for byte; no proconfig; grants restated", () => {
  const proc = procedure(SRC);
  assert.equal(withoutHook(proc), procedure(fs.readFileSync(PRIOR_PROC, "utf8")));
  const head = proc.slice(0, proc.indexOf("AS $procedure$"));
  assert.doesNotMatch(head, /\bSET\s+\w+/, "a COMMITting procedure carries no SET clause (FIX-1128)");
  assert.match(SRC, /REVOKE ALL ON PROCEDURE public\.donor_rollup_rebuild_bulk\(\) FROM PUBLIC, anon, authenticated;/);
  assert.match(SRC, /GRANT EXECUTE ON PROCEDURE public\.donor_rollup_rebuild_bulk\(\) TO service_role;/);
  // No SET of statement_timeout in the routine (the inert form, FIX-1128).
  assert.doesNotMatch(stripComments(proc), /\bSET\s+(LOCAL\s+)?statement_timeout/i);
});

// ---------------------------------------------------------------------------
// (i) Behavioural — skipped without a DB, and without CIVITICS_DB_HEAVY_TESTS=1.
// ---------------------------------------------------------------------------

type RunRow = { status: string; metadata: Record<string, unknown> };

async function lastRun(c: Client): Promise<RunRow> {
  const r = await c.query<RunRow>(
    `SELECT status, metadata FROM public.data_sync_log
      WHERE pipeline = 'donor_rollup_refresh' ORDER BY started_at DESC LIMIT 1`);
  return r.rows[0]!;
}

async function mvRefreshedAt(c: Client): Promise<string> {
  const r = await c.query<{ t: string }>(
    "SELECT min(refreshed_at)::text AS t FROM public.official_homepage_stats_mv");
  return r.rows[0]!.t;
}

test("FIX-1145 (i): clone — both bodies agree per official; moved run refreshes + stamps; caught-up run does neither",
  { timeout: 30 * 60 * 1000 },
  async (t) => {
    if (!HEAVY) {
      t.skip("CIVITICS_DB_HEAVY_TESTS=1 not set — one whole-FR aggregate and two bulk CALLs (minutes)");
      return;
    }
    const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
    try {
      await c.connect();
    } catch {
      t.skip("local Docker DB unreachable — behavioural half skipped (source anchors above still ran)");
      return;
    }
    try {
      const def = await c.query<{ d: string }>(
        "SELECT pg_get_viewdef('public.official_homepage_stats_mv'::regclass) AS d");
      if (/financial_relationships/.test(def.rows[0]!.d)) {
        t.skip("20261004190000 not applied locally (the MV still scans FR)");
        return;
      }
      const sweep = await c.query<{ v: Record<string, unknown> | null }>(
        "SELECT value AS v FROM public.pipeline_state WHERE key = 'donor_rollup_bulk_sweep'");
      const cursor = Number(sweep.rows[0]?.v?.["chunk_cursor"] ?? -1);
      assert.ok(cursor < 0, "an in-flight bulk sweep on the clone would be resumed, not tested");

      // ── Equality: the FR-scan body and the rollup body, one snapshot. ──────
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await c.query("SET LOCAL max_parallel_workers_per_gather = 0");
      const eq = await c.query<{ n: string; differing: string }>(`
        WITH fr AS (
          SELECT to_id AS official_id,
                 (COUNT(*) FILTER (WHERE relationship_type = 'donation'))::bigint AS donor_count,
                 (SUM(amount_cents) FILTER (WHERE relationship_type = 'donation' AND amount_cents IS NOT NULL))::bigint AS cents
          FROM public.financial_relationships WHERE to_type = 'official' GROUP BY to_id),
        vc AS (SELECT official_id, COUNT(*)::bigint AS n FROM public.votes GROUP BY official_id)
        SELECT count(*)::text AS n,
               count(*) FILTER (WHERE (COALESCE(vc.n, 0), COALESCE(fr.donor_count, 0), COALESCE(fr.cents, 0))
                                  IS DISTINCT FROM
                                  (COALESCE(vs.total_votes, 0), COALESCE(dt.donor_count, 0), COALESCE(dt.total_cents, 0)))::text AS differing
        FROM public.officials o
        LEFT JOIN vc ON vc.official_id = o.id
        LEFT JOIN fr ON fr.official_id = o.id
        LEFT JOIN public.official_vote_stats vs ON vs.official_id = o.id
        LEFT JOIN public.official_donor_totals dt ON dt.official_id = o.id`);
      await c.query("COMMIT");
      assert.equal(eq.rows[0]!.differing, "0", `${eq.rows[0]!.differing} of ${eq.rows[0]!.n} officials differ`);

      // ── Path A: a run that moves the watermark. ────────────────────────────
      const orig = await c.query<{ v: Record<string, unknown> }>(
        "SELECT value AS v FROM public.pipeline_state WHERE key = 'donor_rollup_watermark'");
      const origWatermark = orig.rows[0]!.v;
      try {
        await c.query(`
          UPDATE public.pipeline_state
             SET value = jsonb_build_object('last_indexed_at', (
               SELECT (max(updated_at) - interval '1 millisecond')::text
               FROM public.financial_relationships
               WHERE relationship_type IN ('donation', 'ie_support', 'ie_oppose')
                 AND from_type = 'financial_entity' AND to_type = 'official'
                 AND updated_at <= public.fr_watermark_horizon()))
           WHERE key = 'donor_rollup_watermark'`);
        await c.query("SET civitics.donor_rollup_ignore_start_window = 'true'");
        await c.query("SET civitics.box_gate_wait_max_s = '5'");
        const beforeA = await mvRefreshedAt(c);
        await c.query("CALL public.donor_rollup_rebuild_bulk()");
        const a = await lastRun(c);
        if (a.status === "skipped") {
          t.skip(`the run was refused before any work (${String(a.metadata["skip_reason"])}) — environment, not the hook`);
          return;
        }
        assert.equal(a.status, "complete");
        assert.ok(a.metadata["watermark_advanced_to"], "path A moved the watermark");
        assert.equal(a.metadata["homepage_mv_refreshed"], true, "path A stamps the receipt key");
        const afterA = await mvRefreshedAt(c);
        assert.ok(afterA > beforeA, `MV refreshed_at advanced (${beforeA} → ${afterA})`);

        // ── Path B: caught up — no refresh, no key. ──────────────────────────
        await c.query("CALL public.donor_rollup_rebuild_bulk()");
        const b = await lastRun(c);
        assert.equal(b.status, "complete");
        assert.match(String(b.metadata["skip_reason"]), /^caught up at the FIX-983 horizon/);
        assert.equal("homepage_mv_refreshed" in b.metadata, false, "the caught-up path carries no key");
        assert.equal(await mvRefreshedAt(c), afterA, "the caught-up path did not refresh");
      } finally {
        // Never leave the watermark behind where the test found it.
        await c.query(`
          UPDATE public.pipeline_state
             SET value = jsonb_build_object('last_indexed_at', GREATEST(
                   (value->>'last_indexed_at')::timestamptz, ($1::jsonb->>'last_indexed_at')::timestamptz)::text)
           WHERE key = 'donor_rollup_watermark'`, [JSON.stringify(origWatermark)]);
      }
    } finally {
      await c.end();
    }
  });
