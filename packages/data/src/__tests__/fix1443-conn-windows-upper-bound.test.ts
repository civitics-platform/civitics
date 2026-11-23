/**
 * FIX-1443 — rebuild_entity_connection_stats_window() and
 * entity_search_conn_window() bound their index scans on both sides. Built by
 * cc-311: `20261122002000_fix1443_conn_windows_upper_bound_index_condition.sql`.
 *
 * A LANGUAGE sql function that is not inlined has its body planned without its
 * argument values, so `p_hi IS NULL OR from_id < p_hi` was a Filter and window k
 * read (17 - k)/16 of each edge index. Each ranged read is now written twice,
 * gated on p_hi (a one-time filter).
 *
 * Runs via:  tsx --test src/__tests__/fix1443-conn-windows-upper-bound.test.ts
 *
 * Text anchors (no DB, run in CI):
 *   - the guard and the read-back name both md5s of both functions; the headers
 *     restate the live proconfig; neither new body holds `p_hi IS NULL OR`;
 *   - the gated branches, and nothing else in either body moved;
 *   - the revert is both old bodies verbatim and drops nothing; the file is the
 *     newest definer of both.
 * Clone tests (CIVITICS_CLONE_TESTS=1), inside BEGIN … ROLLBACK, the bodies
 * installed from these files inside the transaction:
 *   - D3: EXPLAIN (GENERIC_PLAN) of each body as pg_proc holds it, arguments as
 *     $1 / $2 under the function's own proconfig: every scan of the two
 *     relations carries both bounds in its Index Cond or sits under a one-time
 *     filter on $2 IS NULL, and no Filter names $2. The old bodies fail it.
 *   - D4 (stats): converged by the old body, perturbed in windows 1, 9 and 16,
 *     then the old pass and the new pass from that one state: the sixteen
 *     returns equal pairwise, the table equal by an ordered-row digest.
 *   - D4 (search): per window, old EXCEPT ALL new and new EXCEPT ALL old, 0.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { body, header, read, stripComments } from "./lib/migration-text";

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const FILE_NAME = "20261122002000_fix1443_conn_windows_upper_bound_index_condition.sql";
const FILE_PATH = path.join(MIGRATIONS, FILE_NAME);
const FILE = () => read(FILE_PATH);
const REVERT_PATH = path.join(ROOT, "scripts", "fix1443-revert-conn-windows-upper-bound.sql");
const REVERT = () => read(REVERT_PATH);

const STATS = {
  name: "rebuild_entity_connection_stats_window",
  sig: "CREATE OR REPLACE FUNCTION public.rebuild_entity_connection_stats_window(",
  live: () => read(path.join(MIGRATIONS, "20260828010000_fix1115_1117_ec_stats_arm_and_source_gate.sql")),
  oldMd5: "d17a1ba6ea62f552a957f5f2dd639f86",
  newMd5: "0c60c85fd0cc2b83086f8b77b112b9b1",
  sets: ["SET search_path = public, pg_catalog", "SET work_mem = '64MB'"],
};
const SEARCH = {
  name: "entity_search_conn_window",
  sig: "CREATE OR REPLACE FUNCTION public.entity_search_conn_window(",
  live: () => read(path.join(MIGRATIONS, "20260901000000_fix1123_search_index_bounded_conn_windows.sql")),
  oldMd5: "6ae88578e043e485014b33b933e6956a",
  newMd5: "4f1a3118d34dd424b6cbeda33fb875c4",
  sets: ["SET search_path = public, pg_catalog", "SET work_mem = '64MB'", "SET max_parallel_workers_per_gather = 0"],
};
const FNS = [STATS, SEARCH];

const md5 = (s: string) => crypto.createHash("md5").update(s, "utf8").digest("hex");
const setLines = (h: string) => h.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("SET "));
const gated = (col: string) => [
  `WHERE p_hi IS NOT NULL AND ${col} >= p_lo AND ${col} < p_hi`,
  `WHERE p_hi IS NULL AND ${col} >= p_lo`,
];

test("the guard and the read-back name both md5s of both functions; the headers restate the live proconfig", () => {
  const src = FILE();
  for (const f of FNS) {
    assert.equal(md5(body(f.live(), f.sig)), f.oldMd5, `${f.name}: the live definer's body`);
    assert.equal(md5(body(src, f.sig)), f.newMd5, `${f.name}: this file's body`);
    const guard = src.slice(0, src.indexOf(STATS.sig));
    assert.ok(guard.includes(`IS DISTINCT FROM '${f.oldMd5}' AND`) && guard.includes(`IS DISTINCT FROM '${f.newMd5}' THEN`), f.name);
    const readBack = src.slice(src.lastIndexOf("DO $$"));
    assert.ok(readBack.includes(`'${f.oldMd5}'`) && readBack.includes(`'${f.newMd5}'`), f.name);
    // CREATE OR REPLACE drops a SET it does not restate: the header is the live one's, SET for SET.
    assert.deepEqual(setLines(header(src, f.sig)), f.sets, f.name);
    assert.deepEqual(setLines(header(f.live(), f.sig)), f.sets, f.name);
    assert.doesNotMatch(header(src, f.sig), /SECURITY DEFINER|statement_timeout/);
  }
  assert.match(header(src, STATS.sig), /RETURNS jsonb\nLANGUAGE sql\n/);
  assert.match(header(src, SEARCH.sig), /RETURNS TABLE \(entity_id uuid, c int\)\nLANGUAGE sql\nSTABLE\n/);
  const readBack = src.slice(src.lastIndexOf("DO $$"));
  assert.ok(readBack.includes("c_stats_cfg   CONSTANT text[] := ARRAY['search_path=public, pg_catalog', 'work_mem=64MB'];"));
  assert.ok(readBack.includes("c_search_cfg  CONSTANT text[] := ARRAY['search_path=public, pg_catalog', 'work_mem=64MB', 'max_parallel_workers_per_gather=0'];"));
});

test("D3 (text): neither new body holds `p_hi IS NULL OR`; each ranged read is gated twice", () => {
  const src = FILE();
  for (const f of FNS) {
    assert.match(body(f.live(), f.sig), /p_hi IS NULL OR/, `${f.name}: the old body did`);
    const code = stripComments(body(src, f.sig));
    assert.doesNotMatch(code, /p_hi IS NULL OR/, f.name);
    assert.doesNotMatch(code, /\bOR\b[^\n]*p_hi|p_hi[^\n]*\bOR\b/, `${f.name}: no OR beside p_hi`);
    for (const col of ["from_id", "to_id"]) {
      const [bounded, open] = gated(col) as [string, string];
      const norm = code.replace(/ {2,}/g, " ");
      assert.equal(norm.split(bounded).length - 1, 1, `${f.name}: ${bounded}`);
      assert.equal(norm.split(open).length - 1, 1, `${f.name}: ${open}`);
    }
    assert.equal(code.split("UNION ALL").length - 1, 3, `${f.name}: four branches`);
  }
  const del = stripComments(body(src, STATS.sig));
  assert.ok(del.includes("WHERE p_hi IS NOT NULL AND d.entity_id >= p_lo AND d.entity_id < p_hi"));
  assert.ok(del.includes("WHERE p_hi IS NULL AND d.entity_id >= p_lo\n"));
  assert.equal(del.split("AND NOT EXISTS (SELECT 1 FROM agg a WHERE a.entity_id = d.entity_id)").length - 1, 2);
  assert.ok(del.includes("'deleted',  (SELECT count(*) FROM del_bounded) + (SELECT count(*) FROM del_open),"));
});

test("nothing else in either body moved: the aggregate's columns, the upsert and its guard, the returned object", () => {
  const was = body(STATS.live(), STATS.sig);
  const now = body(FILE(), STATS.sig);
  const between = (s: string, a: string, b: string) => {
    const i = s.indexOf(a);
    const j = s.indexOf(b, i);
    assert.ok(i >= 0 && j > i, `${a} … ${b}`);
    return s.slice(i, j);
  };
  // The select list and GROUP BY of agg.
  assert.equal(between(now, "WITH agg AS MATERIALIZED (", "FROM ("), between(was, "WITH agg AS MATERIALIZED (", "FROM ("));
  assert.equal(between(now, ") sub\n", "ups AS ("), between(was, ") sub\n", "ups AS ("));
  // ups, byte for byte.
  assert.equal(between(now, "ups AS (", "RETURNING 1"), between(was, "ups AS (", "RETURNING 1"));
  assert.ok(now.includes("'upserted', (SELECT count(*) FROM ups),") && now.includes("'groups',   (SELECT count(*) FROM agg));"));
  // The search window: the projection and the grouping.
  const sw = body(SEARCH.live(), SEARCH.sig);
  const sn = body(FILE(), SEARCH.sig);
  assert.ok(sw.startsWith("\n  SELECT sub.id, count(*)::int\n    FROM (\n") && sn.startsWith("\n  SELECT sub.id, count(*)::int\n    FROM (\n"));
  assert.ok(sw.endsWith("    ) sub\n   GROUP BY sub.id;\n") && sn.endsWith("    ) sub\n   GROUP BY sub.id;\n"));
});

test("grants restated, nothing outside the bodies writes; the revert is both old bodies verbatim and drops nothing", () => {
  const src = FILE();
  for (const f of FNS) {
    assert.ok(src.includes(`REVOKE ALL ON FUNCTION public.${f.name}(uuid, uuid) FROM PUBLIC, anon, authenticated;`), f.name);
    assert.ok(src.includes(`GRANT EXECUTE ON FUNCTION public.${f.name}(uuid, uuid) TO service_role;`), f.name);
  }
  const outside = (s: string) => stripComments(s).replace(/AS \$\$[\s\S]*?\$\$;/g, "").replace(/DO \$\$[\s\S]*?END \$\$;/g, "");
  assert.doesNotMatch(outside(src), /\b(DROP|TRUNCATE|DELETE FROM|INSERT INTO|UPDATE public\.|ALTER TABLE|ALTER FUNCTION|CREATE INDEX|COMMENT ON)\b/i);
  const rev = REVERT();
  for (const f of FNS) {
    assert.equal(body(rev, f.sig), body(f.live(), f.sig), `${f.name}: verbatim`);
    assert.deepEqual(setLines(header(rev, f.sig)), f.sets, f.name);
    assert.ok(rev.includes(`IS DISTINCT FROM '${f.newMd5}' AND`) && rev.includes(`IS DISTINCT FROM '${f.oldMd5}' THEN`), f.name);
  }
  assert.doesNotMatch(outside(rev), /\b(DROP|TRUNCATE|DELETE FROM|INSERT INTO|UPDATE public\.)\b/i);
});

test("the migration is the newest definer of both windows", () => {
  const all = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  for (const f of FNS) {
    const definers = all.filter((x) => read(path.join(MIGRATIONS, x)).includes(f.sig));
    assert.equal(definers[definers.length - 1], FILE_NAME, f.name);
  }
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

const BOUNDS = "0123456789abcdef".split("").map((h) => `${h}0000000-0000-0000-0000-000000000000`);
/** The sixteen c_bounds slices every caller passes (cc-311 read 5): NULL only as window 16's p_hi. */
const WINDOWS: ReadonlyArray<readonly [string, string | null]> = BOUNDS.map((lo, i) => [lo, BOUNDS[i + 1] ?? null] as const);
const RELS = new Set(["entity_connections", "entity_connection_stats_mv"]);

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Index Cond"?: string;
  "Recheck Cond"?: string;
  Filter?: string;
  "One-Time Filter"?: string;
  Plans?: PlanNode[];
}

/** D3 on one plan: each scan of the two relations, and what is wrong with it (empty = right). */
function scans(plan: PlanNode): { lines: string[]; problems: string[] } {
  const lines: string[] = [];
  const problems: string[] = [];
  const walk = (p: PlanNode, gates: string[]) => {
    const here = p["One-Time Filter"] ? [...gates, p["One-Time Filter"]] : gates;
    if (p["Node Type"] === "BitmapOr") problems.push("a BitmapOr");
    if (p.Filter?.includes("$2")) problems.push(`${p["Node Type"]} on ${p["Relation Name"]}: Filter ${p.Filter}`);
    const rel = p["Relation Name"];
    if (/Scan/.test(p["Node Type"]) && rel && RELS.has(rel)) {
      // A Bitmap Heap Scan's index condition is its Bitmap Index Scan child's.
      const cond = p["Index Cond"] ?? (p.Plans ?? []).map((k) => k["Index Cond"]).find(Boolean) ?? "";
      const open = here.some((g) => g === "($2 IS NULL)");
      const bounded = cond.includes(">= $1") && cond.includes("< $2");
      lines.push(`${p["Node Type"]}${p["Index Name"] ? ` using ${p["Index Name"]}` : ""} on ${rel} · ${here.join(" ") || "no gate"} · Index Cond ${cond || "-"}${p.Filter ? ` · Filter ${p.Filter}` : ""}`);
      if (!bounded && !open) problems.push(`${p["Node Type"]} on ${rel}: neither both bounds in its Index Cond (${cond || "none"}) nor under $2 IS NULL`);
    }
    for (const k of p.Plans ?? []) walk(k, here);
  };
  walk(plan, []);
  return { lines, problems };
}

/** The body as pg_proc holds it, planned as the function plans it: no argument values, under its own proconfig. */
async function genericPlan(c: Client, name: string): Promise<PlanNode> {
  const fn = (await c.query<{ prosrc: string; proconfig: string[] | null }>(
    "SELECT prosrc, proconfig FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace", [name])).rows[0]!;
  for (const kv of fn.proconfig ?? []) {
    const i = kv.indexOf("=");
    await c.query("SELECT set_config($1, $2, true)", [kv.slice(0, i), kv.slice(i + 1)]);
  }
  const sql = fn.prosrc.replace(/\bp_lo\b/g, () => "$1::uuid").replace(/\bp_hi\b/g, () => "$2::uuid");
  const res = await c.query<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>(`EXPLAIN (GENERIC_PLAN, FORMAT JSON) ${sql}`);
  return res.rows[0]!["QUERY PLAN"][0]!.Plan;
}

test("clone D3: as the function runs it, every scan is bounded on both sides or gated open; the old bodies are not", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await c.query("BEGIN");
    try {
      await c.query(fs.readFileSync(REVERT_PATH, "utf8"));
      for (const f of FNS) {
        const old = scans(await genericPlan(c, f.name));
        assert.ok(old.problems.some((p) => p.includes("Filter") && p.includes("$2")), `${f.name}: the old plan names $2 in a Filter: ${old.lines.join(" | ")}`);
      }
      await c.query(fs.readFileSync(FILE_PATH, "utf8"));
      for (const f of FNS) {
        const now = scans(await genericPlan(c, f.name));
        for (const l of now.lines) console.info(`[fix1443 D3] ${f.name}: ${l}`);
        assert.deepEqual(now.problems, [], f.name);
        const ec = now.lines.filter((l) => l.includes(" on entity_connections "));
        assert.equal(ec.filter((l) => l.includes("< $2")).length, 2, `${f.name}: two bounded edge scans`);
        assert.equal(ec.filter((l) => l.includes("($2 IS NULL)")).length, 2, `${f.name}: two open edge scans`);
      }
      const st = scans(await genericPlan(c, STATS.name)).lines.filter((l) => l.includes(" on entity_connection_stats_mv "));
      assert.equal(st.length, 2, `the delete reads the stats table twice, gated: ${st.join(" | ")}`);
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

type Ret = { upserted: number; deleted: number; groups: number };

async function statsPass(c: Client): Promise<Ret[]> {
  const out: Ret[] = [];
  for (const [lo, hi] of WINDOWS) {
    out.push((await c.query<{ r: Ret }>("SELECT public.rebuild_entity_connection_stats_window($1::uuid, $2::uuid) AS r", [lo, hi])).rows[0]!.r);
  }
  return out;
}

/** The stats table as 256 digests of ordered rows: md5 of each row's text, ordered by entity_id, per leading byte. */
async function statsImage(c: Client): Promise<string[]> {
  const res = await c.query<{ b: string; n: number; d: string }>(
    `SELECT left(s.entity_id::text, 2) AS b, count(*)::int AS n, md5(string_agg(s::text, E'\\n' ORDER BY s.entity_id)) AS d
       FROM public.entity_connection_stats_mv s GROUP BY 1 ORDER BY 1`);
  return res.rows.map((r) => `${r.b} ${r.n} ${r.d}`);
}

test("clone D4 (stats): from one perturbed state, the old and new sixteen returns and the resulting tables are equal", async (t) => {
  const c = await clone(t);
  if (!c) return;
  const log = (s: string) => console.info(`[fix1443 D4 stats] ${s}`);
  try {
    await c.query("BEGIN");
    try {
      await c.query("SET LOCAL statement_timeout = '30min'");
      await c.query(fs.readFileSync(REVERT_PATH, "utf8"));
      // (i) the old body until a pass writes nothing.
      let passes = 0;
      for (;;) {
        const r = await statsPass(c);
        passes++;
        const w = r.reduce((a, x) => a + x.upserted + x.deleted, 0);
        log(`old pass ${passes}: ${w} rows written`);
        if (w === 0) break;
        assert.ok(passes < 4, "the old body does not converge");
      }
      // (ii) in windows 1, 9 and 16: an entity loses its edges (del), a row is wrong (ups' update half),
      //      a row of an entity with edges is gone (ups' insert half).
      const planted: string[] = [];
      for (const k of [1, 9, 16]) {
        const [lo, hi] = WINDOWS[k - 1]!;
        const inWin = `entity_id >= $1::uuid AND ($2::uuid IS NULL OR entity_id < $2::uuid)`;
        const [y, z] = (await c.query<{ entity_id: string }>(
          `SELECT entity_id FROM public.entity_connection_stats_mv WHERE ${inWin} ORDER BY entity_id LIMIT 2`, [lo, hi])).rows.map((r) => r.entity_id);
        const x = (await c.query<{ entity_id: string }>(
          `SELECT entity_id FROM public.entity_connection_stats_mv WHERE ${inWin} AND connection_count <= 2 AND entity_id <> ALL($3::uuid[])
            ORDER BY entity_id LIMIT 1`, [lo, hi, [y, z]])).rows[0]!.entity_id;
        const gone = await c.query("DELETE FROM public.entity_connections WHERE from_id = $1 OR to_id = $1", [x]);
        assert.ok((gone.rowCount ?? 0) > 0, `window ${k}: ${x} had edges`);
        await c.query("UPDATE public.entity_connection_stats_mv SET connection_count = connection_count + 7 WHERE entity_id = $1", [y]);
        await c.query("DELETE FROM public.entity_connection_stats_mv WHERE entity_id = $1", [z]);
        planted.push(`w${k}: orphan ${x} (${gone.rowCount} edges) · wrong ${y} · missing ${z}`);
      }
      for (const p of planted) log(p);

      // (iii) from that one state: the old pass, then (rolled back to it) the new pass.
      await c.query("SAVEPOINT d4");
      const oldRet = await statsPass(c);
      const oldImg = await statsImage(c);
      await c.query("ROLLBACK TO SAVEPOINT d4");
      await c.query(fs.readFileSync(FILE_PATH, "utf8"));
      const newRet = await statsPass(c);
      const newImg = await statsImage(c);
      WINDOWS.forEach((_, i) => log(`window ${i + 1}: old ${JSON.stringify(oldRet[i])} · new ${JSON.stringify(newRet[i])}`));
      for (const k of [1, 9, 16]) {
        const r = oldRet[k - 1]!;
        assert.ok(r.deleted >= 1 && r.upserted >= 2, `window ${k} saw the perturbation: ${JSON.stringify(r)}`);
      }
      assert.deepEqual(newRet, oldRet, "the sixteen returns, pairwise");
      const diff = oldImg.filter((d, i) => d !== newImg[i]);
      assert.equal(oldImg.length, newImg.length);
      assert.deepEqual(diff, [], "the stats table, by its 256 ordered-row digests");
      log(`equal: 16 returns pairwise; ${oldImg.length} ordered-row digests over ${oldImg.reduce((a, d) => a + Number(d.split(" ")[1]), 0)} rows`);
      // And the new body converges: a second pass writes nothing.
      const again = await statsPass(c);
      assert.equal(again.reduce((a, x) => a + x.upserted + x.deleted, 0), 0, "a second new pass writes nothing");
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("clone D4 (search): per window, old EXCEPT ALL new and new EXCEPT ALL old are both 0", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await c.query("BEGIN");
    try {
      await c.query("SET LOCAL statement_timeout = '30min'");
      await c.query(fs.readFileSync(REVERT_PATH, "utf8"));
      await c.query("CREATE TEMP TABLE _f1443_old (w int, entity_id uuid, c int) ON COMMIT DROP");
      for (const [i, [lo, hi]] of WINDOWS.entries()) {
        await c.query("INSERT INTO _f1443_old SELECT $3, w.* FROM public.entity_search_conn_window($1::uuid, $2::uuid) w", [lo, hi, i + 1]);
      }
      await c.query(fs.readFileSync(FILE_PATH, "utf8"));
      let rows = 0;
      for (const [i, [lo, hi]] of WINDOWS.entries()) {
        const n = async (sql: string) => (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) z`, [lo, hi, i + 1])).rows[0]!.n;
        const oldSide = "SELECT entity_id, c FROM _f1443_old WHERE w = $3::int";
        const newSide = "SELECT entity_id, c FROM public.entity_search_conn_window($1::uuid, $2::uuid)";
        assert.deepEqual([await n(`${oldSide} EXCEPT ALL ${newSide}`), await n(`${newSide} EXCEPT ALL ${oldSide}`)], [0, 0], `window ${i + 1}`);
        rows += (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM _f1443_old WHERE w = $1", [i + 1])).rows[0]!.n;
      }
      console.info(`[fix1443 D4 search] 16 windows, ${rows} rows: old EXCEPT ALL new 0, new EXCEPT ALL old 0`);
      assert.ok(rows > 1_000_000, `${rows} rows`);
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});
