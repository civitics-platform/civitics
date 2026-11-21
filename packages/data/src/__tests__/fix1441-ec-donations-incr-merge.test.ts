/**
 * FIX-1441 — rebuild_ec_donations_incr_window() merges a dirty donor's edges
 * instead of deleting and re-inserting all of them. cc-308,
 * `20261122000000_fix1441_ec_donations_incr_window_merge.sql`.
 *
 * Runs via:  tsx --test src/__tests__/fix1441-ec-donations-incr-merge.test.ts
 *
 * Text anchors (no DB, run in CI):
 *   - D8 (g): the guard names the md5 it replaces and this file's; the
 *     read-back names both; the header is 20260819030000's verbatim, no SET;
 *   - the body is the live one with only the edge set + merge changed: the
 *     head (DECLARE + the already-at-target skip) and the ratchet are the live
 *     text, the two aggregations are the live ones but for D5's `, fr.id`, the
 *     strength formula and column list are the live INSERTs';
 *   - D2: delete-gone / update-changed / insert-new in that order, the delete
 *     scoped exactly as the live DELETE, no key column in the SET list, the
 *     seven value columns compared IS DISTINCT FROM, derived_at stamped;
 *   - D4: it returns the set's size because crawl_record_unit()'s backoff
 *     divides seconds by it;
 *   - D6: ON COMMIT DROP, ANALYZEd, DROPped;
 *   - the revert is the live body verbatim and drops nothing;
 *   - FIX-1211's scoped repair derives the same set but for D5's tiebreak.
 * Clone tests (CIVITICS_CLONE_TESTS=1), each inside BEGIN … ROLLBACK:
 *   - the live body is this file's, proconfig NULL;
 *   - on the clone's 08-20 landing (read 4's dirty set): (b) every row the
 *     merge did not write keeps its id, ctid and derived_at; (c) the same
 *     windows again write 0 rows; (a) the old body over the same set leaves
 *     the same edges — key, the six scalars, evidence_ids as a set, and as an
 *     array wherever the evidence holds no occurred_at tie;
 *   - (d) each branch on synthetic donors: a new pair → 1 insert, an amount
 *     change → 1 update whose derived_at moved, a donor's only row to one
 *     recipient removed → 1 delete, a donor with no rows left → every edge
 *     deleted; (e) a donation and an opposition edge to one recipient coexist.
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

const FILE_NAME = "20261122000000_fix1441_ec_donations_incr_window_merge.sql";
const FILE = () => read(path.join(MIGRATIONS, FILE_NAME));
const LIVE = () => read(path.join(MIGRATIONS, "20260819030000_fix1069_ec_incremental_donations_windowing.sql"));
const REVERT_PATH = path.join(ROOT, "scripts", "fix1441-revert-ec-donations-incr-window.sql");
const REVERT = () => read(REVERT_PATH);
const REPAIR = () => read(path.join(MIGRATIONS, "20261003020000_fix1211_scoped_donation_edge_rebuild.sql"));
const SENSOR = () => read(path.join(MIGRATIONS, "20260828020000_fix1031_969_fe_totals_crawl.sql"));

const SIG = "CREATE OR REPLACE FUNCTION public.rebuild_ec_donations_incr_window(";
const SIG_REPAIR = "FUNCTION public.rebuild_ec_donation_edges_for_donors(p_from_ids uuid[])";

/** md5(prosrc) of the body this file installs: what the push's read-back prints. */
const NEW_MD5 = "419d941075843c7e0b8f3eab72b95e49";
/** md5(prosrc) of the body it replaces (the clone at cc-308 read 0). */
const OLD_MD5 = "2e70260b6f3cb1c0bfb913d4fce212a9";

const md5 = (s: string) => crypto.createHash("md5").update(s, "utf8").digest("hex");
const squash = (s: string) => s.split("\n").map((l) => l.trim()).filter((l) => l.length > 0).join("\n");

const D5_ORDER = "ORDER BY fr.occurred_at DESC NULLS LAST, fr.id))[1:100]";
const OLD_ORDER = "ORDER BY fr.occurred_at DESC NULLS LAST))[1:100]";
const DECLARE_ADDED =
  "  v_deleted  bigint := 0;   -- FIX-1441: the merge's counts\n  v_updated  bigint := 0;\n  v_inserted bigint := 0;\n";
const RETURN_COMMENT =
  "  -- FIX-1441 (D4): the set's size, as the delete-all + insert returned it — the\n" +
  "  -- crawl sensor's throughput denominator. The rows written are in the NOTICE.\n";

/** The `WITH agg AS ( … )` CTE bodies, in order. */
const aggs = (b: string) => [...b.matchAll(/WITH agg AS \(([\s\S]*?)\n  \)/g)].map((m) => m[1] as string);
/** The SELECT lists that turn `agg a` into edge rows, whitespace-squashed. */
const selects = (b: string) => [...b.matchAll(/SELECT\s+(a\.from_type[\s\S]*?FROM agg a)/g)].map((m) => squash(m[1] as string));
/** The INSERT column lists, whitespace-squashed. */
const columnLists = (b: string) =>
  [...b.matchAll(/\(\s*(from_type, from_id, to_type, to_id, connection_type,[\s\S]*?evidence_ids)\s*\)/g)].map((m) => squash(m[1] as string));

// ---------------------------------------------------------------------------
// Text — no database.
// ---------------------------------------------------------------------------

test("D8 (g): the guard names the md5 it replaces and this file's; the header is the live definer's verbatim", () => {
  const src = FILE();
  assert.equal(md5(body(LIVE(), SIG)), OLD_MD5);
  assert.equal(md5(body(src, SIG)), NEW_MD5);
  const guard = src.slice(0, src.indexOf(SIG));
  assert.ok(guard.includes(`IF v_d IS DISTINCT FROM '${OLD_MD5}' AND v_d IS DISTINCT FROM '${NEW_MD5}' THEN`));
  assert.match(guard, /RAISE EXCEPTION '\[fix1441\]/);
  const readBack = src.slice(src.lastIndexOf("DO $$"));
  assert.ok(readBack.includes(`c_new CONSTANT text := '${NEW_MD5}';`));
  assert.ok(readBack.includes(`c_old CONSTANT text := '${OLD_MD5}';`));
  assert.match(readBack, /IF v_cfg IS NOT NULL THEN/);
  assert.equal(header(src, SIG), header(LIVE(), SIG));
  assert.match(header(src, SIG), /\)\nRETURNS bigint\nLANGUAGE plpgsql\n$/);
  assert.doesNotMatch(header(src, SIG), /\bSET\b|SECURITY DEFINER/);
});

test("the body is the live one with only the edge set and the merge changed", () => {
  const live = body(LIVE(), SIG);
  const now = body(FILE(), SIG);
  // The head: DECLARE (plus the three counts) and the already-at-target skip.
  const liveHead = live.slice(0, live.indexOf("  -- ── Clear both derived classes"));
  const nowHead = now.slice(0, now.indexOf("  -- ── FIX-1441 — the window's edge set"));
  assert.ok(liveHead.length > 400 && nowHead.includes(DECLARE_ADDED));
  assert.equal(nowHead.replace(DECLARE_ADDED, ""), liveHead);
  // The ratchet, byte for byte; only the return gains its comment.
  const tail = (s: string) => s.slice(s.indexOf("  -- ── The ratchet"));
  assert.ok(tail(live).length > 600);
  assert.equal(tail(now).replace(RETURN_COMMENT, ""), tail(live));
  // The two aggregations: the live ones but for D5's tiebreak.
  const [la, lb] = [aggs(live), aggs(now)];
  assert.equal(la.length, 2);
  assert.equal(lb.length, 2);
  for (let i = 0; i < 2; i++) {
    assert.ok(lb[i]!.includes(D5_ORDER), `agg ${i} carries D5's order`);
    assert.equal(lb[i]!.replace(D5_ORDER, OLD_ORDER), la[i]!, `agg ${i} drifted from the live aggregation`);
  }
  // The strength formula and the column list are the live INSERTs'.
  assert.deepEqual(selects(now), selects(live));
  assert.equal(selects(now).length, 2);
  assert.ok(selects(now).every((s) => s.includes("LOG(10, GREATEST(a.total_cents / 100.0, 1.0)) / 8.0")));
  const lc = columnLists(live);
  assert.equal(lc.length, 2);
  for (const cols of columnLists(now)) assert.equal(cols, lc[0]);
});

test("D2 + D6: delete what left the set, update what moved, insert what is new — scoped as the live DELETE", () => {
  const code = stripComments(body(FILE(), SIG));
  const at = (needle: string) => {
    const i = code.indexOf(needle);
    assert.notEqual(i, -1, needle);
    return i;
  };
  const order = [
    at("CREATE TEMP TABLE _ec_donations_window_set ("),
    at("ANALYZE _ec_donations_window_set;"),
    at("WITH gone AS (\n    DELETE FROM public.entity_connections ec"),
    at("WITH changed AS (\n    UPDATE public.entity_connections ec"),
    at("WITH added AS (\n    INSERT INTO public.entity_connections ("),
    at("DROP TABLE _ec_donations_window_set;"),
    at("RETURN v_count + v_opp;"),
  ];
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(code, /\) ON COMMIT DROP;/);
  // One DELETE, and its scope is the live DELETE's plus the set test.
  assert.equal(code.split("DELETE FROM public.entity_connections").length - 1, 1, "no delete-all");
  const liveDelete = stripComments(body(LIVE(), SIG)).match(/DELETE FROM public\.entity_connections ec\n([\s\S]*?);/)![1]!;
  const gone = code.slice(at("WITH gone AS ("), at("SELECT COUNT(*) INTO v_deleted FROM gone;"));
  assert.ok(squash(gone).includes(squash(liveDelete)), "the live DELETE's scope, verbatim");
  assert.match(gone, /AND NOT EXISTS \(\n\s+SELECT 1 FROM _ec_donations_window_set s\n\s+WHERE s\.from_type = ec\.from_type AND s\.from_id = ec\.from_id\n\s+AND s\.to_type = ec\.to_type AND s\.to_id = ec\.to_id\n\s+AND s\.connection_type = ec\.connection_type\)/);
  // The UPDATE: the seven values IS DISTINCT FROM, derived_at stamped, no key column written.
  const upd = code.slice(at("WITH changed AS ("), at("SELECT COUNT(*) INTO v_updated FROM changed;"));
  const set = upd.slice(upd.indexOf("SET "), upd.indexOf("FROM _ec_donations_window_set s"));
  assert.doesNotMatch(set, /connection_type|from_id|to_id|from_type|to_type/);
  for (const col of ["strength", "amount_cents", "occurred_at", "ended_at", "evidence_count", "evidence_source", "evidence_ids"]) {
    assert.match(set, new RegExp(`\\b${col}\\s+= s\\.${col}\\b`), col);
    assert.match(upd, new RegExp(`ec\\.${col}\\s+IS DISTINCT FROM s\\.${col}\\b`), col);
  }
  assert.match(set, /derived_at\s+= now\(\)/);
  assert.equal((upd.match(/IS DISTINCT FROM/g) ?? []).length, 7);
  const added = code.slice(at("WITH added AS ("), at("SELECT COUNT(*) INTO v_inserted FROM added;"));
  assert.match(added, /WHERE NOT EXISTS \(\n\s+SELECT 1 FROM public\.entity_connections ec\n\s+WHERE ec\.from_type = s\.from_type AND ec\.from_id = s\.from_id\n\s+AND ec\.to_type = s\.to_type AND ec\.to_id = s\.to_id\n\s+AND ec\.connection_type = s\.connection_type\)/);
  assert.ok(code.includes("RAISE NOTICE '    [donations/incr] window %/16 merge: deleted % / updated % / inserted % / untouched %'"));
});

test("D4: the window returns its set's size, because the crawl sensor's backoff divides seconds by it", () => {
  // The reader of meaning read 1 found: crawl_record_unit()'s throughput rate.
  const sensor = SENSOR();
  assert.ok(sensor.includes("v_ratable := v_rows >= v_minrows;"));
  assert.ok(sensor.includes("v_rate    := CASE WHEN v_ratable THEN p_seconds * 1000.0 / v_rows END;"));
  assert.match(sensor, /AND v_rate >= v_mult \* v_median THEN/);
  const code = stripComments(body(FILE(), SIG));
  assert.ok(code.includes("GET DIAGNOSTICS v_count = ROW_COUNT;"));
  assert.ok(code.includes("GET DIAGNOSTICS v_opp = ROW_COUNT;"));
  assert.deepEqual((code.match(/\bRETURN\b[^;]*;/g) ?? []).sort(), ["RETURN 0;", "RETURN v_count + v_opp;"]);
});

test("grants restated; nothing written or dropped outside the body and the two DO blocks", () => {
  const src = FILE();
  const sig = "public.rebuild_ec_donations_incr_window(int, uuid, uuid, timestamptz)";
  assert.ok(src.includes(`REVOKE ALL ON FUNCTION ${sig}\n  FROM PUBLIC, anon, authenticated;`));
  assert.ok(src.includes(`GRANT EXECUTE ON FUNCTION ${sig}\n  TO service_role;`));
  const sql = stripComments(src);
  assert.deepEqual(
    [...sql.matchAll(/CREATE OR REPLACE (?:FUNCTION|PROCEDURE|VIEW) public\.(\w+)/g)].map((m) => m[1]),
    ["rebuild_ec_donations_incr_window"],
  );
  const outside = sql.replace(/AS \$\$[\s\S]*?\$\$;/g, "").replace(/DO \$\$[\s\S]*?END \$\$;/g, "");
  assert.doesNotMatch(outside, /\b(DROP|TRUNCATE|DELETE FROM|INSERT INTO|UPDATE public\.|ALTER TABLE|ALTER FUNCTION|CREATE INDEX)/i);
  assert.doesNotMatch(outside, /job_registry|cron\.|platform_dials|pipeline_state/);
});

test("the revert is the live body verbatim, header verbatim, guarded, and drops nothing", () => {
  const rev = REVERT();
  assert.equal(body(rev, SIG), body(LIVE(), SIG));
  assert.equal(header(rev, SIG), header(LIVE(), SIG));
  assert.ok(rev.includes(`IF v_d IS DISTINCT FROM '${NEW_MD5}' AND v_d IS DISTINCT FROM '${OLD_MD5}' THEN`));
  assert.ok(rev.includes(`IF v_md5 IS DISTINCT FROM '${OLD_MD5}' THEN`));
  const code = stripComments(rev).replace(/AS \$\$[\s\S]*?\$\$;/g, "");
  assert.doesNotMatch(code, /\bDROP\b/i);
  assert.match(rev, /It DROPS NOTHING/);
});

test("the migration is the newest definer of the window, after every file before it", () => {
  const all = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const at = all.indexOf(FILE_NAME);
  assert.ok(at > 0);
  assert.ok(all[at - 1]! >= "20261120001000", all[at - 1]);
  const definers = all.filter((f) => read(path.join(MIGRATIONS, f)).includes(SIG));
  assert.equal(definers[definers.length - 1], FILE_NAME);
});

test("FIX-1211's scoped repair derives the window's set but for D5's tiebreak and its own predicate", () => {
  // rebuild_ec_donation_edges_for_donors() copies the window's aggregation
  // (ec-donation-edges-for-donors.test.ts holds it to 20260819030000's text).
  // D5 changes the crawl's evidence order on a tie; the repair keeps the old
  // one, so an edge it repairs is rewritten once when its donor is next dirty.
  const strip = (agg: string) =>
    squash(agg)
      .split("\n")
      .filter((l) =>
        !l.startsWith("INNER JOIN public.ec_donations_incr_dirty d") &&
        !l.startsWith("ON d.from_type = fr.from_type AND d.from_id = fr.from_id") &&
        !l.startsWith("AND d.from_id >= p_lo") &&
        !l.startsWith("AND (p_hi IS NULL OR d.from_id < p_hi)") &&
        l !== "AND fr.from_type = 'financial_entity'" &&
        l !== "AND fr.from_id = ANY (p_from_ids)")
      .join("\n");
  const repair = aggs(body(REPAIR(), SIG_REPAIR));
  const now = aggs(body(FILE(), SIG));
  assert.equal(repair.length, 2);
  for (let i = 0; i < 2; i++) {
    assert.equal(strip(now[i]!.replace(D5_ORDER, OLD_ORDER)), strip(repair[i]!), `agg ${i}`);
    assert.ok(repair[i]!.includes(OLD_ORDER), "the repair still orders by occurred_at alone");
  }
  assert.deepEqual(selects(body(REPAIR(), SIG_REPAIR)), selects(body(FILE(), SIG)));
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

const BOUNDS = [..."0123456789abcdef"].map((h) => `${h}0000000-0000-0000-0000-000000000000`);
const TARGET = "2099-01-01 00:00:00+00";
const EDGE_SCOPE = `SELECT ec.*, ec.ctid::text AS tid FROM public.entity_connections ec
  JOIN public.ec_donations_incr_dirty x ON x.from_type = ec.from_type AND x.from_id = ec.from_id
 WHERE ec.connection_type IN ('donation', 'opposition')`;
const KEY = (a: string, b: string) =>
  `${a}.from_type = ${b}.from_type AND ${a}.from_id = ${b}.from_id AND ${a}.to_type = ${b}.to_type AND ${a}.to_id = ${b}.to_id AND ${a}.connection_type = ${b}.connection_type`;
const AS_SET = (t: string) =>
  `SELECT from_type, from_id, to_type, to_id, connection_type, strength, amount_cents, occurred_at, ended_at,
          evidence_count, evidence_source, (SELECT array_agg(x ORDER BY x) FROM unnest(evidence_ids) x) AS ids FROM ${t}`;

type Merge = { deleted: number; updated: number; inserted: number; untouched: number; returned: number };

/** Every window back below TARGET, then all sixteen: the NOTICE counts summed. */
async function windows(c: Client): Promise<Merge> {
  await c.query(`UPDATE public.pipeline_state
      SET value = jsonb_set(value, '{windows}', (SELECT jsonb_object_agg(i::text, '2000-01-01 00:00:00+00') FROM generate_series(0, 15) i))
    WHERE key = 'entity_connections_donations'`);
  const notices: string[] = [];
  const on = (n: { message?: string }) => notices.push(n.message ?? "");
  c.on("notice", on);
  let returned = 0;
  try {
    for (let i = 0; i < 16; i++) {
      const r = await c.query("SELECT public.rebuild_ec_donations_incr_window($1, $2::uuid, $3::uuid, $4::timestamptz) AS n",
        [i, BOUNDS[i], i < 15 ? BOUNDS[i + 1] : null, TARGET]);
      returned += Number(r.rows[0].n);
    }
  } finally {
    c.off("notice", on);
  }
  const m: Merge = { deleted: 0, updated: 0, inserted: 0, untouched: 0, returned };
  let seen = 0;
  for (const line of notices) {
    const x = line.match(/window (\d+)\/16 merge: deleted (\d+) \/ updated (\d+) \/ inserted (\d+) \/ untouched (\d+)$/);
    if (!x) continue;
    seen++;
    m.deleted += Number(x[2]);
    m.updated += Number(x[3]);
    m.inserted += Number(x[4]);
    m.untouched += Number(x[5]);
  }
  if (seen > 0) assert.equal(seen, 16, "one merge NOTICE per window");
  return m;
}

const ecWrites = async (c: Client) =>
  (await c.query(`SELECT (n_tup_ins + n_tup_upd + n_tup_del)::bigint AS n FROM pg_stat_xact_user_tables
    WHERE relid = 'public.entity_connections'::regclass`)).rows.map((r) => Number(r.n))[0] ?? 0;

test("clone: the live body is this file's; proconfig NULL", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    const { rows } = await c.query(
      `SELECT md5(p.prosrc) AS m, p.proconfig AS cfg FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'rebuild_ec_donations_incr_window'`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].m, NEW_MD5);
    assert.equal(rows[0].cfg, null);
  } finally {
    await c.end();
  }
});

test("clone: on the 08-20 landing, untouched rows keep id/ctid/derived_at, a second pass writes 0, and the old body leaves the same edges", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await c.query("BEGIN");
    try {
      await c.query("SET LOCAL statement_timeout = '20min'");
      // Read 4's dirty set: the donors of the clone's last real landing.
      await c.query("TRUNCATE public.ec_donations_incr_dirty");
      await c.query(`INSERT INTO public.ec_donations_incr_dirty (from_id, from_type)
        SELECT DISTINCT fr.from_id, fr.from_type FROM public.financial_relationships fr
         WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
           AND fr.updated_at >= '2026-08-20' AND fr.updated_at < '2026-08-21'`);
      await c.query("ANALYZE public.ec_donations_incr_dirty");
      const donors: number = (await c.query("SELECT count(*)::int AS n FROM public.ec_donations_incr_dirty")).rows[0].n;
      assert.ok(donors > 1000, `${donors} dirty donors`);
      // The state before: every derived_at predates this transaction, so a write shows as a later one.
      await c.query(`CREATE TEMP TABLE _f1441_s0 ON COMMIT DROP AS ${EDGE_SCOPE}`);
      const s0: number = (await c.query("SELECT count(*)::int AS n FROM _f1441_s0")).rows[0].n;

      // The merge.
      const w0 = await ecWrites(c);
      const m1 = await windows(c);
      const written1 = (await ecWrites(c)) - w0;
      assert.equal(written1, m1.deleted + m1.updated + m1.inserted, "the NOTICE counts are the writes");
      assert.equal(m1.untouched + m1.updated + m1.inserted, m1.returned, "the return is the set's size");
      await c.query(`CREATE TEMP TABLE _f1441_new ON COMMIT DROP AS ${EDGE_SCOPE}`);
      assert.equal((await c.query("SELECT count(*)::int AS n FROM _f1441_new")).rows[0].n, m1.returned);
      assert.equal(s0 - m1.deleted + m1.inserted, m1.returned);

      // (b) every row the merge did not write is the same tuple: id, ctid, derived_at.
      const b = (await c.query(`SELECT
          count(*) FILTER (WHERE a.id = s.id AND a.tid = s.tid AND a.derived_at = s.derived_at)::int AS same,
          count(*) FILTER (WHERE a.id = s.id AND a.derived_at > s.derived_at)::int AS rewritten,
          count(*) FILTER (WHERE a.id <> s.id)::int AS new_id
        FROM _f1441_new a JOIN _f1441_s0 s ON ${KEY("a", "s")}`)).rows[0];
      assert.deepEqual(b, { same: m1.untouched, rewritten: m1.updated, new_id: 0 });

      // (c) the same windows again: nothing written.
      const w1 = await ecWrites(c);
      const m2 = await windows(c);
      assert.deepEqual({ ...m2, returned: 0 }, { deleted: 0, updated: 0, inserted: 0, untouched: m1.returned, returned: 0 });
      assert.equal((await ecWrites(c)) - w1, 0);

      // (a) the old body over the same set, against the merge's result.
      await c.query(fs.readFileSync(REVERT_PATH, "utf8"));
      const old = await windows(c);
      assert.equal(old.returned, m1.returned);
      await c.query(`CREATE TEMP TABLE _f1441_old ON COMMIT DROP AS ${EDGE_SCOPE}`);
      const n = async (sql: string) => (await c.query(`SELECT count(*)::int AS n FROM (${sql}) z`)).rows[0].n as number;
      assert.deepEqual(
        [await n(`${AS_SET("_f1441_old")} EXCEPT ALL ${AS_SET("_f1441_new")}`), await n(`${AS_SET("_f1441_new")} EXCEPT ALL ${AS_SET("_f1441_old")}`)],
        [0, 0],
        "symmetric difference, evidence_ids as a set",
      );
      // As an array wherever the edge's evidence holds no occurred_at tie in its first hundred.
      const untiedDiffer = await n(`
        WITH r AS (
          SELECT fr.from_type, fr.from_id, fr.to_type, fr.to_id,
                 (CASE WHEN fr.relationship_type = 'ie_oppose' THEN 'opposition' ELSE 'donation' END) AS ct,
                 rank() OVER (PARTITION BY fr.from_type, fr.from_id, fr.to_type, fr.to_id, (fr.relationship_type = 'ie_oppose')
                              ORDER BY fr.occurred_at DESC NULLS LAST) AS rk
            FROM public.financial_relationships fr
            JOIN public.ec_donations_incr_dirty x ON x.from_type = fr.from_type AND x.from_id = fr.from_id
           WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')),
        tied AS (
          SELECT from_type, from_id, to_type, to_id, ct FROM r WHERE rk <= 100
           GROUP BY 1, 2, 3, 4, 5 HAVING count(*) > count(DISTINCT rk))
        SELECT 1 FROM _f1441_old o JOIN _f1441_new w ON ${KEY("o", "w")}
         WHERE o.evidence_ids IS DISTINCT FROM w.evidence_ids
           AND NOT EXISTS (SELECT 1 FROM tied WHERE tied.from_type = o.from_type AND tied.from_id = o.from_id
                             AND tied.to_type = o.to_type AND tied.to_id = o.to_id AND tied.ct = o.connection_type::text)`);
      assert.equal(untiedDiffer, 0, "an untied edge's array is the old body's, in order");
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("clone: each branch — insert, update (derived_at moves), delete, a donor emptied — and donation beside opposition", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await c.query("BEGIN");
    try {
      const ids = (await c.query(`SELECT gen_random_uuid()::text a, gen_random_uuid()::text b,
          gen_random_uuid()::text o1, gen_random_uuid()::text o2, gen_random_uuid()::text o3, gen_random_uuid()::text o4`)).rows[0];
      const fr = async (rt: string, donor: string, official: string, cents: number) =>
        (await c.query(`INSERT INTO public.financial_relationships
            (relationship_type, from_type, from_id, to_type, to_id, amount_cents, occurred_at, metadata)
          VALUES ($1::public.financial_relationship_type, 'financial_entity', $2, 'official', $3, $4, '2026-04-30', '{"source":"fix1441-test"}')
          RETURNING id`, [rt, donor, official, cents])).rows[0].id as string;
      const edges = async (donor: string) =>
        (await c.query(`SELECT to_id::text AS to, connection_type::text AS ct, id::text, amount_cents::text AS cents, derived_at
            FROM public.entity_connections WHERE from_type = 'financial_entity' AND from_id = $1 ORDER BY to_id, connection_type`, [donor])).rows;

      // A: donations to o1, o2; an ie_support to o3; an ie_oppose to o1 (e). B: donations to o1, o2.
      await fr("donation", ids.a, ids.o1, 1000);
      const a2 = await fr("donation", ids.a, ids.o2, 2000);
      const a3 = await fr("ie_support", ids.a, ids.o3, 500);
      await fr("ie_oppose", ids.a, ids.o1, 700);
      const b1 = await fr("donation", ids.b, ids.o1, 300);
      const b2 = await fr("donation", ids.b, ids.o2, 400);
      await c.query("TRUNCATE public.ec_donations_incr_dirty");
      await c.query("INSERT INTO public.ec_donations_incr_dirty (from_id, from_type) VALUES ($1, 'financial_entity'), ($2, 'financial_entity')", [ids.a, ids.b]);

      assert.deepEqual(await windows(c), { deleted: 0, updated: 0, inserted: 6, untouched: 0, returned: 6 });
      // (e) one donor, one recipient: a donation edge and an opposition edge.
      const toO1 = (await edges(ids.a)).filter((e) => e.to === ids.o1).map((e) => [e.ct, e.cents]);
      assert.deepEqual(toO1.sort(), [["donation", "1000"], ["opposition", "700"]]);

      // Backdate so a write inside this transaction is visible as a moved derived_at.
      await c.query("UPDATE public.entity_connections SET derived_at = derived_at - interval '1 day' WHERE from_id IN ($1, $2)", [ids.a, ids.b]);
      const before = new Map((await edges(ids.a)).map((e) => [`${e.to}:${e.ct}`, e]));

      await fr("donation", ids.a, ids.o4, 100);                                                   // new pair -> insert
      await c.query("UPDATE public.financial_relationships SET amount_cents = 2500 WHERE id = $1", [a2]);  // -> update
      await c.query("DELETE FROM public.financial_relationships WHERE id = $1", [a3]);            // only row to o3 -> delete
      await c.query("DELETE FROM public.financial_relationships WHERE id IN ($1, $2)", [b1, b2]); // B emptied -> both deleted

      assert.deepEqual(await windows(c), { deleted: 3, updated: 1, inserted: 1, untouched: 2, returned: 4 });
      const after = await edges(ids.a);
      assert.deepEqual(after.map((e) => [e.to, e.ct, e.cents]).sort(), [
        [ids.o1, "donation", "1000"], [ids.o1, "opposition", "700"], [ids.o2, "donation", "2500"], [ids.o4, "donation", "100"],
      ].sort());
      for (const e of after) {
        const was = before.get(`${e.to}:${e.ct}`);
        if (e.to === ids.o4) {
          assert.equal(was, undefined);
          continue;
        }
        assert.equal(e.id, was!.id, "never a delete + insert of a kept key");
        if (e.to === ids.o2) assert.ok(e.derived_at > was!.derived_at, "the updated row's derived_at moved");
        else assert.equal(e.derived_at.getTime(), was!.derived_at.getTime(), "an untouched row's derived_at holds");
      }
      assert.deepEqual(await edges(ids.b), [], "a donor with no rows left keeps no edge");
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});
