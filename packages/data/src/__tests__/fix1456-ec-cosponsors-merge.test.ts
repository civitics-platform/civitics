/**
 * FIX-1456 — rebuild_entity_connections_cosponsors() merges its set instead of
 * deleting and re-inserting every co_sponsorship edge. cc-328:
 * `20261126007000_fix1456_ec_cosponsors_arm_merge.sql`, on FIX-1439's shape.
 *
 * Runs via:  tsx --test src/__tests__/fix1456-ec-cosponsors-merge.test.ts
 *
 * Text anchors (no DB, run in CI):
 *   - D4: the guard names the md5 it replaces and this file's; the read-back
 *     names both; the header is the live body's (20260905000000's less the SET
 *     FIX-1128 RESET);
 *   - the set is the live INSERT's SELECT: the same columns, the strength
 *     (0.700 / 0.600), date_added, ARRAY[pc.id], the withdrawn filter;
 *   - D1: delete-gone / update-changed / insert-new, each scoped as FIX-1136
 *     scoped the arm, no key column written, derived_at stamped; D2:
 *     edges_upserted is the set's size; D3: the trailing ANALYZE only when the
 *     merge wrote a row;
 *   - the revert is the live body verbatim and drops nothing.
 * Clone tests (CIVITICS_CLONE_TESTS=1), inside BEGIN … ROLLBACK, the body
 * installed from this file inside the transaction:
 *   - the new body's edge set equals the old body's on the same source, from
 *     empty and over the old body's own output; a second run writes nothing
 *     and analyzes nothing; an inserted row inserts one edge; a withdrawn row
 *     deletes its edge; a flipped is_original_cosponsor updates the strength
 *     and nothing else; edges_upserted equals the set's size throughout.
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

const FILE_NAME = "20261126007000_fix1456_ec_cosponsors_arm_merge.sql";
const FILE_PATH = path.join(MIGRATIONS, FILE_NAME);
const FILE = () => read(FILE_PATH);
const LIVE = () => read(path.join(MIGRATIONS, "20260905000000_fix1136_ec_arm_delete_scopes.sql"));
const REVERT_PATH = path.join(ROOT, "scripts", "fix1456-revert-ec-cosponsors-arm.sql");
const REVERT = () => read(REVERT_PATH);

const SIG = "CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_cosponsors()";
const NEW_MD5 = "675d2a6836402c235107e0f8a1686ae8";
const OLD_MD5 = "d534e1637a5b49d2e6ef852a34b3bbdd";
const LIVE_SET = " SET statement_timeout TO '10min'\n";

const md5 = (s: string) => crypto.createHash("md5").update(s, "utf8").digest("hex");

test("D4: the guard names the md5 it replaces and this file's; the header is the live one", () => {
  const src = FILE();
  assert.equal(md5(body(LIVE(), SIG)), OLD_MD5);
  assert.equal(md5(body(src, SIG)), NEW_MD5);
  const guard = src.slice(0, src.indexOf(SIG));
  assert.ok(guard.includes(`IF v_d IS DISTINCT FROM '${OLD_MD5}' AND v_d IS DISTINCT FROM '${NEW_MD5}' THEN`));
  const readBack = src.slice(src.lastIndexOf("DO $$"));
  assert.ok(readBack.includes(`c_new CONSTANT text := '${NEW_MD5}';`));
  assert.ok(readBack.includes(`c_old CONSTANT text := '${OLD_MD5}';`));
  assert.ok(readBack.includes("IF v_cfg IS NOT NULL THEN"), "the read-back refuses a SET clause");
  // The newest definer re-stated SET statement_timeout; FIX-1128 RESET it, so the live header has none.
  assert.ok(header(LIVE(), SIG).includes(LIVE_SET));
  assert.equal(header(src, SIG), header(LIVE(), SIG).replace(LIVE_SET, ""));
  assert.doesNotMatch(header(src, SIG), /\bSET\b|SECURITY DEFINER/);
});

test("the set is the live INSERT's SELECT: the columns, the strength, date_added, ARRAY[pc.id], the withdrawn filter", () => {
  const live = stripComments(body(LIVE(), SIG));
  const now = stripComments(body(FILE(), SIG));
  const strength = "CASE WHEN pc.is_original_cosponsor THEN 0.700 ELSE 0.600 END::numeric(4,3)";
  for (const b of [live, now]) {
    assert.ok(b.includes(strength));
    assert.ok(b.includes("'official', pc.official_id, 'proposal', pc.proposal_id,"));
    assert.ok(b.includes("FROM public.proposal_cosponsors pc\n"));
    assert.ok(b.includes("WHERE pc.date_withdrawn IS NULL"));
  }
  assert.match(live, /pc\.date_added,\n\s+1, 'cosponsorship', ARRAY\[pc\.id\]/);
  assert.match(now, /pc\.date_added,\n\s+1, ARRAY\[pc\.id\]/);
  // The live INSERT's column list is the merge's INSERT's, column for column.
  const cols = (b: string) => /INSERT INTO public\.entity_connections \(([\s\S]*?)\)/.exec(b)![1]!.replace(/\s+/g, " ").trim();
  assert.equal(cols(now), cols(live));
  assert.equal(cols(now), "from_type, from_id, to_type, to_id, connection_type, strength, occurred_at, evidence_count, evidence_source, evidence_ids");
  assert.ok(now.startsWith("\nDECLARE v_count BIGINT;\n") && live.startsWith("\nDECLARE v_count BIGINT;\n"));
});

test("D1–D3: delete-gone / update-changed / insert-new in the arm's scope; the set's size returned; ANALYZE only on a write", () => {
  const code = stripComments(body(FILE(), SIG));
  const at = (needle: string) => {
    const i = code.indexOf(needle);
    assert.notEqual(i, -1, needle);
    return i;
  };
  const order = [
    at("CREATE TEMP TABLE _ec_cosponsors_set ("),
    at("GET DIAGNOSTICS v_count = ROW_COUNT;"),
    at("ANALYZE _ec_cosponsors_set;"),
    at("WITH gone AS (\n    DELETE FROM public.entity_connections ec"),
    at("WITH changed AS (\n    UPDATE public.entity_connections ec"),
    at("WITH added AS (\n    INSERT INTO public.entity_connections ("),
    at("DROP TABLE _ec_cosponsors_set;"),
    at("connection_type := 'co_sponsorship'; edges_upserted := v_count; RETURN NEXT;"),
    at("IF v_deleted + v_updated + v_inserted > 0 THEN\n    ANALYZE public.entity_connections;\n  END IF;"),
  ];
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(code, /\) ON COMMIT DROP;/);
  assert.equal(code.split("DELETE FROM public.entity_connections").length - 1, 1, "no delete-all");
  assert.equal(code.split("ANALYZE public.entity_connections;").length - 1, 1, "one ANALYZE, inside the IF");
  assert.equal(code.split("ec.connection_type = 'co_sponsorship'").length - 1, 3, "every step in the arm's scope");
  assert.equal(code.split("ec.evidence_source = 'cosponsorship'").length - 1, 3);
  const upd = code.slice(at("WITH changed AS ("), at("SELECT COUNT(*) INTO v_updated FROM changed;"));
  const set = upd.slice(upd.indexOf("SET "), upd.indexOf("FROM _ec_cosponsors_set s"));
  assert.doesNotMatch(set, /connection_type|from_id|to_id|from_type|to_type|evidence_source/);
  for (const col of ["strength", "occurred_at", "evidence_count", "evidence_ids"]) {
    assert.match(set, new RegExp(`\\b${col}\\s+= s\\.${col}\\b`), col);
    assert.match(upd, new RegExp(`ec\\.${col}\\s+IS DISTINCT FROM s\\.${col}\\b`), col);
  }
  assert.doesNotMatch(set, /amount_cents|ended_at|metadata/, "D1 names four value columns, as the INSERT writes them");
  assert.match(set, /derived_at\s+= NOW\(\)/);
  assert.ok(code.includes("RAISE NOTICE '[cosponsors] merge: deleted % / updated % / inserted % / untouched %'"));
  // connection_type is an OUT column here: never unqualified in a statement.
  assert.doesNotMatch(code.replace(/INSERT INTO public\.entity_connections \([\s\S]*?\)\n/, ""), /[^.\w]connection_type\s*(=|<>|IN)\b/);
});

test("grants restated; the revert is the live body verbatim without the inert SET, and drops nothing", () => {
  const src = FILE();
  assert.ok(src.includes("REVOKE ALL ON FUNCTION public.rebuild_entity_connections_cosponsors() FROM PUBLIC, anon, authenticated;"));
  assert.ok(src.includes("GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_cosponsors() TO service_role;"));
  const sql = stripComments(src);
  const outside = sql.replace(/AS \$function\$[\s\S]*?\$function\$;/g, "").replace(/DO \$\$[\s\S]*?END \$\$;/g, "");
  assert.doesNotMatch(outside, /\b(DROP|TRUNCATE|DELETE FROM|INSERT INTO|UPDATE public\.|ALTER TABLE|ALTER FUNCTION|CREATE INDEX)/i);
  const rev = REVERT();
  assert.equal(body(rev, SIG), body(LIVE(), SIG));
  assert.equal(header(rev, SIG), header(LIVE(), SIG).replace(LIVE_SET, ""));
  assert.ok(rev.includes(`IF v_d IS DISTINCT FROM '${NEW_MD5}' AND v_d IS DISTINCT FROM '${OLD_MD5}' THEN`));
  assert.ok(rev.includes("GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_cosponsors() TO service_role;"));
  assert.doesNotMatch(stripComments(rev).replace(/AS \$function\$[\s\S]*?\$function\$;/g, ""), /\bDROP\b/i);
});

test("the migration is the newest definer of the cosponsors arm", () => {
  const all = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const definers = all.filter((f) => read(path.join(MIGRATIONS, f)).includes(SIG));
  assert.equal(definers[definers.length - 1], FILE_NAME);
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

const SCOPE = `SELECT ec.*, ec.ctid::text AS tid FROM public.entity_connections ec
  WHERE ec.connection_type = 'co_sponsorship' AND ec.evidence_source = 'cosponsorship'`;
const VALUES = "from_type, from_id, to_type, to_id, connection_type, strength, amount_cents, occurred_at, ended_at, evidence_count, evidence_source, evidence_ids, metadata";

type Merge = { deleted: number; updated: number; inserted: number; untouched: number; returned: number; analyzed: boolean };

/** The arm once: its returned row, its NOTICE, and whether it analyzed entity_connections (a newer pg_statistic cmin). */
async function arm(c: Client): Promise<Merge> {
  const cmin = async () =>
    (await c.query<{ m: number | null }>(
      "SELECT max(cmin::text::int) AS m FROM pg_statistic WHERE starelid = 'public.entity_connections'::regclass AND xmin::text = (pg_current_xact_id()::text)",
    )).rows[0]!.m;
  const before = await cmin();
  const notices: string[] = [];
  const on = (n: { message?: string }) => notices.push(n.message ?? "");
  c.on("notice", on);
  let rows: { connection_type: string; edges_upserted: string }[];
  try {
    rows = (await c.query("SELECT * FROM public.rebuild_entity_connections_cosponsors()")).rows;
  } finally {
    c.off("notice", on);
  }
  const after = await cmin();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.connection_type, "co_sponsorship");
  const m: Merge = {
    deleted: 0, updated: 0, inserted: 0, untouched: 0,
    returned: Number(rows[0]!.edges_upserted),
    analyzed: after !== null && (before === null || after > before),
  };
  const line = notices.find((x) => x.startsWith("[cosponsors] merge:"));
  if (line) {
    const x = line.match(/deleted (\d+) \/ updated (\d+) \/ inserted (\d+) \/ untouched (\d+)$/);
    assert.ok(x, line);
    [m.deleted, m.updated, m.inserted, m.untouched] = x.slice(1).map(Number) as [number, number, number, number];
  }
  return m;
}

test("clone: equal to the old body from empty and over its own output; again writes 0; one insert, one withdrawal, one flip", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await c.query("BEGIN");
    try {
      await c.query("SET LOCAL statement_timeout = '10min'");
      const n = async (sql: string) => (await c.query(`SELECT count(*)::int AS n FROM (${sql}) z`)).rows[0].n as number;
      const live = () => n("SELECT 1 FROM public.proposal_cosponsors WHERE date_withdrawn IS NULL");
      const rows = await live();
      if (rows < 10) {
        t.skip(`the clone holds ${rows} non-withdrawn proposal_cosponsors rows; run the bill-details walker locally first`);
        return;
      }
      const differ = async (a: string, b: string) =>
        [await n(`SELECT ${VALUES} FROM ${a} EXCEPT ALL SELECT ${VALUES} FROM ${b}`),
         await n(`SELECT ${VALUES} FROM ${b} EXCEPT ALL SELECT ${VALUES} FROM ${a}`)];

      // From empty: the old body's edges, then the merge's over none.
      await c.query("DELETE FROM public.entity_connections WHERE connection_type = 'co_sponsorship' AND evidence_source = 'cosponsorship'");
      await c.query(fs.readFileSync(REVERT_PATH, "utf8"));
      await arm(c);
      await c.query(`CREATE TEMP TABLE _f1456_old ON COMMIT DROP AS ${SCOPE}`);
      await c.query("DELETE FROM public.entity_connections WHERE connection_type = 'co_sponsorship' AND evidence_source = 'cosponsorship'");
      await c.query(fs.readFileSync(FILE_PATH, "utf8"));
      const m0 = await arm(c);
      assert.deepEqual(m0, { deleted: 0, updated: 0, inserted: rows, untouched: 0, returned: rows, analyzed: true });
      await c.query(`CREATE TEMP TABLE _f1456_new ON COMMIT DROP AS ${SCOPE}`);
      assert.deepEqual(await differ("_f1456_old", "_f1456_new"), [0, 0], "from empty: every value of every edge");

      // Over the old body's own output: nothing to write.
      await c.query("DELETE FROM public.entity_connections WHERE connection_type = 'co_sponsorship' AND evidence_source = 'cosponsorship'");
      await c.query(fs.readFileSync(REVERT_PATH, "utf8"));
      await arm(c);
      await c.query(fs.readFileSync(FILE_PATH, "utf8"));
      const m1 = await arm(c);
      assert.deepEqual(m1, { deleted: 0, updated: 0, inserted: 0, untouched: rows, returned: rows, analyzed: false });
      await c.query(`CREATE TEMP TABLE _f1456_a ON COMMIT DROP AS ${SCOPE}`);
      assert.deepEqual(await differ("_f1456_old", "_f1456_a"), [0, 0], "over the old output");

      // Again: 0 written, the same tuples, no ANALYZE.
      const m2 = await arm(c);
      assert.deepEqual(m2, { deleted: 0, updated: 0, inserted: 0, untouched: rows, returned: rows, analyzed: false });
      assert.equal(await n(`SELECT 1 FROM (${SCOPE}) a JOIN _f1456_a s USING (id) WHERE a.tid = s.tid AND a.derived_at = s.derived_at`), rows);

      // One inserted row: one edge inserted.
      const pick = (await c.query<{ official_id: string; proposal_id: string }>(`
        SELECT o.id AS official_id, p.proposal_id
          FROM public.officials o
          CROSS JOIN (SELECT DISTINCT proposal_id FROM public.proposal_cosponsors ORDER BY proposal_id LIMIT 20) p
         WHERE o.source_ids ? 'congress_gov'
           AND NOT EXISTS (SELECT 1 FROM public.proposal_cosponsors pc WHERE pc.official_id = o.id AND pc.proposal_id = p.proposal_id)
           AND NOT EXISTS (SELECT 1 FROM public.entity_connections ec
                            WHERE ec.from_type = 'official' AND ec.from_id = o.id AND ec.to_type = 'proposal'
                              AND ec.to_id = p.proposal_id AND ec.connection_type = 'co_sponsorship')
         ORDER BY o.id LIMIT 1`)).rows[0];
      assert.ok(pick, "an official / proposal pair with no cosponsor row");
      await c.query(
        `INSERT INTO public.proposal_cosponsors (proposal_id, official_id, is_original_cosponsor, date_added, source)
         VALUES ($1, $2, true, '2026-11-26', 'fix1456-test')`,
        [pick.proposal_id, pick.official_id],
      );
      const m3 = await arm(c);
      assert.deepEqual(m3, { deleted: 0, updated: 0, inserted: 1, untouched: rows, returned: rows + 1, analyzed: true });
      const added = (await c.query(`${SCOPE} AND ec.from_id = $1 AND ec.to_id = $2`, [pick.official_id, pick.proposal_id])).rows;
      assert.equal(added.length, 1);
      assert.equal(added[0].strength, "0.700");
      assert.equal(added[0].evidence_count, 1);

      // One withdrawn row: its edge deleted.
      const w = (await c.query<{ id: string; official_id: string; proposal_id: string }>(
        "SELECT id, official_id, proposal_id FROM public.proposal_cosponsors WHERE date_withdrawn IS NULL AND source <> 'fix1456-test' ORDER BY id LIMIT 1",
      )).rows[0]!;
      await c.query("UPDATE public.proposal_cosponsors SET date_withdrawn = '2026-11-26' WHERE id = $1", [w.id]);
      const m4 = await arm(c);
      assert.deepEqual(m4, { deleted: 1, updated: 0, inserted: 0, untouched: rows, returned: rows, analyzed: true });
      assert.equal(await n(`${SCOPE} AND ec.from_id = '${w.official_id}' AND ec.to_id = '${w.proposal_id}'`), 0);

      // One flipped is_original_cosponsor: that edge's strength, and nothing else.
      const f = (await c.query<{ id: string; official_id: string; proposal_id: string; is_original_cosponsor: boolean }>(
        "SELECT id, official_id, proposal_id, is_original_cosponsor FROM public.proposal_cosponsors WHERE date_withdrawn IS NULL AND source <> 'fix1456-test' ORDER BY id DESC LIMIT 1",
      )).rows[0]!;
      const one = `${SCOPE} AND ec.from_id = '${f.official_id}' AND ec.to_id = '${f.proposal_id}'`;
      const was = (await c.query(one)).rows[0];
      await c.query("UPDATE public.proposal_cosponsors SET is_original_cosponsor = NOT is_original_cosponsor WHERE id = $1", [f.id]);
      const m5 = await arm(c);
      assert.deepEqual(m5, { deleted: 0, updated: 1, inserted: 0, untouched: rows - 1, returned: rows, analyzed: true });
      const now = (await c.query(one)).rows[0];
      assert.equal(now.id, was.id, "the same edge, updated in place");
      assert.equal(now.strength, f.is_original_cosponsor ? "0.600" : "0.700");
      for (const k of ["from_type", "from_id", "to_type", "to_id", "connection_type", "amount_cents", "ended_at", "evidence_count", "evidence_source", "metadata"]) {
        assert.deepEqual(now[k], was[k], k);
      }
      assert.deepEqual(now.occurred_at, was.occurred_at);
      assert.deepEqual(now.evidence_ids, was.evidence_ids);

      // The old body over this state is the reference.
      await c.query(`CREATE TEMP TABLE _f1456_b ON COMMIT DROP AS ${SCOPE}`);
      await c.query(fs.readFileSync(REVERT_PATH, "utf8"));
      await arm(c);
      await c.query(`CREATE TEMP TABLE _f1456_c ON COMMIT DROP AS ${SCOPE}`);
      assert.deepEqual(await differ("_f1456_b", "_f1456_c"), [0, 0], "after the three edits");
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});
