/**
 * FIX-1439 — rebuild_entity_connections_contracts() merges its aggregate
 * instead of deleting and re-inserting every contract_award edge. cc-308,
 * `20261122001000_fix1439_ec_contracts_arm_merge.sql`.
 *
 * HELD by cc-308: D8 (f)'s equivalence, evidence_ids compared as a SET, found
 * 791 of the clone's 188,234 edges different — every one an edge with more
 * than a hundred rows whose 100th and 101st share occurred_at, so D5's
 * tiebreak picks other ids of that same date. The clone test below asserts
 * the reading that ruling would ratify: a set difference is allowed only
 * there, with the occurred_at multiset equal.
 *
 * Runs via:  tsx --test src/__tests__/fix1439-ec-contracts-merge.test.ts
 *
 * Text anchors (no DB, run in CI):
 *   - D8 (g): the guard names the md5 it replaces and this file's; the
 *     read-back names both; the header is the live body's (20260905000000's
 *     less the SET FIX-1128 RESET);
 *   - the aggregation is the live one but for D5's `, fr.id`; the strength
 *     formula (/ 9.0) is the live INSERT's;
 *   - D3: delete-gone / update-changed / insert-new, each scoped as FIX-1136
 *     scoped the arm, no key column written, derived_at stamped; the trailing
 *     ANALYZE stays; D4: edges_upserted is the set's size;
 *   - the revert is the live body verbatim and drops nothing.
 * Clone tests (CIVITICS_CLONE_TESTS=1), inside BEGIN … ROLLBACK, the body
 * installed from this file inside the transaction:
 *   - (f) the old body over the same rows leaves the same edges on the key,
 *     the scalars, and evidence_ids (as above); a second run writes 0; 18
 *     planted grant rows write at most 18 edges.
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

const FILE_NAME = "20261122001000_fix1439_ec_contracts_arm_merge.sql";
const FILE_PATH = path.join(MIGRATIONS, FILE_NAME);
const FILE = () => read(FILE_PATH);
const LIVE = () => read(path.join(MIGRATIONS, "20260905000000_fix1136_ec_arm_delete_scopes.sql"));
const REVERT_PATH = path.join(ROOT, "scripts", "fix1439-revert-ec-contracts-arm.sql");
const REVERT = () => read(REVERT_PATH);

const SIG = "CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_contracts()";
const NEW_MD5 = "cfbbd4d1b38be4529947a5646111d55a";
const OLD_MD5 = "88990e414b485a8ac1148d7f9b1a1444";
const LIVE_SET = " SET statement_timeout TO '30min'\n";

const md5 = (s: string) => crypto.createHash("md5").update(s, "utf8").digest("hex");
const squash = (s: string) => s.split("\n").map((l) => l.trim()).filter((l) => l.length > 0).join("\n");
const D5_ORDER = "ORDER BY fr.occurred_at DESC NULLS LAST, fr.id))[1:100]";
const OLD_ORDER = "ORDER BY fr.occurred_at DESC NULLS LAST))[1:100]";
const aggs = (b: string) => [...b.matchAll(/WITH agg AS \(([\s\S]*?)\n {2}\)/g)].map((m) => m[1] as string);

test("D8 (g): the guard names the md5 it replaces and this file's; the header is the live one", () => {
  const src = FILE();
  assert.equal(md5(body(LIVE(), SIG)), OLD_MD5);
  assert.equal(md5(body(src, SIG)), NEW_MD5);
  const guard = src.slice(0, src.indexOf(SIG));
  assert.ok(guard.includes(`IF v_d IS DISTINCT FROM '${OLD_MD5}' AND v_d IS DISTINCT FROM '${NEW_MD5}' THEN`));
  const readBack = src.slice(src.lastIndexOf("DO $$"));
  assert.ok(readBack.includes(`c_new CONSTANT text := '${NEW_MD5}';`));
  assert.ok(readBack.includes(`c_old CONSTANT text := '${OLD_MD5}';`));
  // The newest definer re-stated SET statement_timeout; FIX-1128 RESET it, so the live header has none.
  assert.ok(header(LIVE(), SIG).includes(LIVE_SET));
  assert.equal(header(src, SIG), header(LIVE(), SIG).replace(LIVE_SET, ""));
  assert.doesNotMatch(header(src, SIG), /\bSET\b|SECURITY DEFINER/);
});

test("the aggregation is the live one but for D5; the strength formula and the returned row are the live body's", () => {
  const live = body(LIVE(), SIG);
  const now = body(FILE(), SIG);
  const [la, lb] = [aggs(live), aggs(now)];
  assert.equal(la.length, 1);
  assert.equal(lb.length, 1);
  assert.ok(lb[0]!.includes(D5_ORDER));
  assert.equal(lb[0]!.replace(D5_ORDER, OLD_ORDER), la[0]!);
  const strength = /LEAST\(0\.999, GREATEST\(0\.001,\s+LOG\(10, GREATEST\(a\.total_cents \/ 100\.0, 1\.0\)\) \/ 9\.0\s+\)\)::numeric\(4,3\)/;
  assert.match(live, strength);
  assert.match(now, strength);
  const tail = "  connection_type := 'contract_award'; edges_upserted := v_count; RETURN NEXT;\n\n  ANALYZE public.entity_connections;\n  RETURN;\nEND;\n";
  assert.ok(live.endsWith(tail) && now.endsWith(tail), "D3: the returned row and the trailing ANALYZE");
  assert.ok(now.startsWith("\nDECLARE v_count BIGINT;\n") && live.startsWith("\nDECLARE v_count BIGINT;\n"));
});

test("D3: delete-gone / update-changed / insert-new, each scoped as FIX-1136 scoped the arm", () => {
  const code = stripComments(body(FILE(), SIG));
  const at = (needle: string) => {
    const i = code.indexOf(needle);
    assert.notEqual(i, -1, needle);
    return i;
  };
  const order = [
    at("CREATE TEMP TABLE _ec_contracts_set ("),
    at("ANALYZE _ec_contracts_set;"),
    at("WITH gone AS (\n    DELETE FROM public.entity_connections ec"),
    at("WITH changed AS (\n    UPDATE public.entity_connections ec"),
    at("WITH added AS (\n    INSERT INTO public.entity_connections ("),
    at("DROP TABLE _ec_contracts_set;"),
  ];
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(code, /\) ON COMMIT DROP;/);
  assert.equal(code.split("DELETE FROM public.entity_connections").length - 1, 1, "no delete-all");
  assert.equal(code.split("ec.connection_type = 'contract_award'").length - 1, 3, "every step in the arm's scope");
  assert.equal(code.split("ec.evidence_source = 'financial_relationships'").length - 1, 3);
  const upd = code.slice(at("WITH changed AS ("), at("SELECT COUNT(*) INTO v_updated FROM changed;"));
  const set = upd.slice(upd.indexOf("SET "), upd.indexOf("FROM _ec_contracts_set s"));
  assert.doesNotMatch(set, /connection_type|from_id|to_id|from_type|to_type|evidence_source/);
  for (const col of ["strength", "amount_cents", "occurred_at", "ended_at", "evidence_count", "evidence_ids"]) {
    assert.match(set, new RegExp(`\\b${col}\\s+= s\\.${col}\\b`), col);
    assert.match(upd, new RegExp(`ec\\.${col}\\s+IS DISTINCT FROM s\\.${col}\\b`), col);
  }
  assert.match(set, /derived_at\s+= NOW\(\)/);
  assert.ok(code.includes("RAISE NOTICE '[contracts] merge: deleted % / updated % / inserted % / untouched %'"));
  // connection_type is an OUT column here: never unqualified in a statement.
  assert.doesNotMatch(code.replace(/INSERT INTO public\.entity_connections \([\s\S]*?\)\n/, ""), /[^.\w]connection_type\s*(=|<>|IN)\b/);
});

test("grants restated; the revert is the live body verbatim without the inert SET, and drops nothing", () => {
  const src = FILE();
  assert.ok(src.includes("REVOKE ALL ON FUNCTION public.rebuild_entity_connections_contracts() FROM PUBLIC, anon, authenticated;"));
  assert.ok(src.includes("GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_contracts() TO service_role;"));
  const sql = stripComments(src);
  const outside = sql.replace(/AS \$function\$[\s\S]*?\$function\$;/g, "").replace(/DO \$\$[\s\S]*?END \$\$;/g, "");
  assert.doesNotMatch(outside, /\b(DROP|TRUNCATE|DELETE FROM|INSERT INTO|UPDATE public\.|ALTER TABLE|ALTER FUNCTION|CREATE INDEX)/i);
  const rev = REVERT();
  assert.equal(body(rev, SIG), body(LIVE(), SIG));
  assert.equal(header(rev, SIG), header(LIVE(), SIG).replace(LIVE_SET, ""));
  assert.ok(rev.includes(`IF v_d IS DISTINCT FROM '${NEW_MD5}' AND v_d IS DISTINCT FROM '${OLD_MD5}' THEN`));
  assert.doesNotMatch(stripComments(rev).replace(/AS \$function\$[\s\S]*?\$function\$;/g, ""), /\bDROP\b/i);
});

test("the migration is the newest definer of the contracts arm", () => {
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
  WHERE ec.connection_type = 'contract_award' AND ec.evidence_source = 'financial_relationships'`;

type Merge = { deleted: number; updated: number; inserted: number; untouched: number; returned: number };

async function arm(c: Client): Promise<Merge> {
  const notices: string[] = [];
  const on = (n: { message?: string }) => notices.push(n.message ?? "");
  c.on("notice", on);
  let rows: { connection_type: string; edges_upserted: string }[];
  try {
    rows = (await c.query("SELECT * FROM public.rebuild_entity_connections_contracts()")).rows;
  } finally {
    c.off("notice", on);
  }
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.connection_type, "contract_award");
  const m: Merge = { deleted: 0, updated: 0, inserted: 0, untouched: 0, returned: Number(rows[0]!.edges_upserted) };
  const line = notices.find((x) => x.startsWith("[contracts] merge:"));
  if (line) {
    const x = line.match(/deleted (\d+) \/ updated (\d+) \/ inserted (\d+) \/ untouched (\d+)$/);
    assert.ok(x, line);
    [m.deleted, m.updated, m.inserted, m.untouched] = x.slice(1).map(Number) as [number, number, number, number];
  }
  return m;
}

test("clone (f): equal to the old body, then 0 written, then 18 planted grants write at most 18", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await c.query("BEGIN");
    try {
      await c.query("SET LOCAL statement_timeout = '20min'");
      await c.query(fs.readFileSync(FILE_PATH, "utf8"));
      const n = async (sql: string) => (await c.query(`SELECT count(*)::int AS n FROM (${sql}) z`)).rows[0].n as number;

      const m1 = await arm(c);
      assert.ok(m1.returned > 100_000, `${m1.returned} contract edges`);
      assert.equal(m1.untouched + m1.updated + m1.inserted, m1.returned);
      await c.query(`CREATE TEMP TABLE _f1439_new ON COMMIT DROP AS ${SCOPE}`);

      // A second run writes nothing, and every row is the same tuple.
      const m2 = await arm(c);
      assert.deepEqual(m2, { deleted: 0, updated: 0, inserted: 0, untouched: m1.returned, returned: m1.returned });
      assert.equal(await n(`SELECT 1 FROM (${SCOPE}) a JOIN _f1439_new s USING (id) WHERE a.tid = s.tid AND a.derived_at = s.derived_at`), m1.returned);

      // The old body over the same rows.
      await c.query(fs.readFileSync(REVERT_PATH, "utf8"));
      await arm(c);
      await c.query(`CREATE TEMP TABLE _f1439_old ON COMMIT DROP AS ${SCOPE}`);
      const scalars = "from_type, from_id, to_type, to_id, connection_type, strength, amount_cents, occurred_at, ended_at, evidence_count, evidence_source";
      assert.deepEqual(
        [await n(`SELECT ${scalars} FROM _f1439_old EXCEPT ALL SELECT ${scalars} FROM _f1439_new`),
         await n(`SELECT ${scalars} FROM _f1439_new EXCEPT ALL SELECT ${scalars} FROM _f1439_old`)],
        [0, 0],
        "the key and every scalar",
      );
      // evidence_ids as a set, except where a tie straddles the hundredth row: there
      // the same dates are kept, other ids of the tied date fill the cap.
      const occ = (ids: string) => `(SELECT array_agg(fr.occurred_at ORDER BY fr.occurred_at) FROM public.financial_relationships fr WHERE fr.id = ANY (${ids}))`;
      const bad = await n(`
        SELECT 1 FROM _f1439_old o JOIN _f1439_new w USING (from_type, from_id, to_type, to_id)
         WHERE NOT (o.evidence_ids @> w.evidence_ids AND o.evidence_ids <@ w.evidence_ids)
           AND NOT (o.evidence_count > 100 AND ${occ("o.evidence_ids")} = ${occ("w.evidence_ids")})`);
      assert.equal(bad, 0, "a set difference only at a boundary tie, dates equal");

      // Back to the merge; 18 grants: 9 on existing pairs, 9 on new ones.
      await c.query(fs.readFileSync(FILE_PATH, "utf8"));
      await arm(c);
      const pairs = (await c.query(`SELECT from_type, from_id::text, to_type, to_id::text FROM public.entity_connections
          WHERE connection_type = 'contract_award' AND evidence_source = 'financial_relationships' AND evidence_count < 50
          ORDER BY md5(id::text) LIMIT 9`)).rows;
      assert.equal(pairs.length, 9);
      for (let i = 0; i < 18; i++) {
        const p = i < 9 ? pairs[i]! : { from_type: "agency", from_id: crypto.randomUUID(), to_type: "financial_entity", to_id: crypto.randomUUID() };
        await c.query(`INSERT INTO public.financial_relationships
            (relationship_type, from_type, from_id, to_type, to_id, amount_cents, occurred_at, metadata)
          VALUES ('grant', $1, $2, $3, $4, 1000000, '2026-11-18', '{"source":"fix1439-test"}')`,
          [p.from_type, p.from_id, p.to_type, p.to_id]);
      }
      const m3 = await arm(c);
      assert.equal(m3.deleted, 0);
      assert.equal(m3.inserted, 9);
      assert.equal(m3.updated, 9);
      assert.ok(m3.deleted + m3.updated + m3.inserted <= 18);
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});
