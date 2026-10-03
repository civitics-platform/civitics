/**
 * FIX-1211 — rebuild_ec_donation_edges_for_donors(uuid[]).
 *
 * Runs via:  tsx --test src/__tests__/ec-donation-edges-for-donors.test.ts
 *
 * (v) Drift, against the migration TEXT — no database, so it runs in CI. The
 *     function's two aggregations are a COPY of rebuild_ec_donations_incr_window
 *     (20260819030000_fix1069, the body prod runs) with only the predicate
 *     changed. If either side's strength expression, relationship_type list,
 *     evidence cap or column list moves, this goes red rather than letting a
 *     scoped repair write a different edge than the crawl would.
 *
 * (i) Behavioural, against the local prod-clone, inside one transaction that is
 *     ROLLED BACK — the function does not COMMIT, so nothing persists. Skips
 *     when the local DB is unreachable. Synthetic donors (random uuids; FR has
 *     no FK), so no real edge is touched.
 *
 * The wrong-but-green line (rule 105): after the donation row is deleted the
 *     edge still reads 215399 / 2 — the pre-FIX-1211 state, which no writer
 *     repairs — and the test asserts that BEFORE calling the function.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

import { drainFrRewrite } from "../lib/fr-rewrite-drain";

const MIGRATIONS = path.join(__dirname, "..", "..", "..", "..", "supabase", "migrations");
const NEW_SRC = fs.readFileSync(
  path.join(MIGRATIONS, "20261003020000_fix1211_scoped_donation_edge_rebuild.sql"), "utf8");
const INCR_SRC = fs.readFileSync(
  path.join(MIGRATIONS, "20260819030000_fix1069_ec_incremental_donations_windowing.sql"), "utf8");

const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

function body(src: string, sig: string): string {
  const i = src.indexOf(sig);
  assert.notEqual(i, -1, `${sig} not found`);
  // fix1069 quotes its body with $$, the new migration with $function$.
  const m = src.slice(i).match(/AS (\$(?:function)?\$)([\s\S]*?)\1/);
  assert.ok(m, "no dollar-quoted body");
  return m[2]!;
}

/** The two `WITH agg AS ( … ) SELECT COUNT(*) INTO …` blocks, in order. */
function aggBlocks(b: string): string[] {
  return [...b.matchAll(/WITH agg AS \(([\s\S]*?)SELECT COUNT\(\*\) INTO \w+ FROM inserted;/g)].map((m) => m[1]!);
}

/** Drop the predicate lines — the one place the copy is allowed to differ. */
function normalised(block: string): string {
  return block
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter(
      (l) =>
        // incr_window's windowed dirty-set join
        !l.startsWith("INNER JOIN public.ec_donations_incr_dirty d") &&
        !l.startsWith("ON d.from_type = fr.from_type AND d.from_id = fr.from_id") &&
        !l.startsWith("AND d.from_id >= p_lo") &&
        !l.startsWith("AND (p_hi IS NULL OR d.from_id < p_hi)") &&
        // FIX-1211's donor list
        l !== "AND fr.from_type = 'financial_entity'" &&
        l !== "AND fr.from_id = ANY (p_from_ids)",
    )
    .join("\n");
}

const NEW = body(NEW_SRC, "FUNCTION public.rebuild_ec_donation_edges_for_donors(p_from_ids uuid[])");
const INCR = body(INCR_SRC, "FUNCTION public.rebuild_ec_donations_incr_window(");

// ---------------------------------------------------------------------------
// (v) drift
// ---------------------------------------------------------------------------

test("(v) both aggregations are the incr-window's, predicate aside", () => {
  const a = aggBlocks(NEW);
  const b = aggBlocks(INCR);
  assert.equal(a.length, 2, "expected the donation and the opposition arm");
  assert.equal(b.length, 2, "rebuild_ec_donations_incr_window changed shape");
  assert.equal(normalised(a[0]!), normalised(b[0]!), "donation arm drifted from the crawl's");
  assert.equal(normalised(a[1]!), normalised(b[1]!), "opposition arm drifted from the crawl's");
});

test("(v) the strength expression and relationship_type lists are the crawl's", () => {
  const strength = /LEAST\(0\.999, GREATEST\(0\.001,\s+LOG\(10, GREATEST\(a\.total_cents \/ 100\.0, 1\.0\)\) \/ 8\.0\s+\)\)::numeric\(4,3\)/g;
  assert.equal((NEW.match(strength) ?? []).length, 2);
  assert.equal((INCR.match(strength) ?? []).length, 2);
  for (const src of [NEW, INCR]) {
    assert.match(src, /WHERE fr\.relationship_type IN \('donation', 'ie_support'\)/);
    assert.match(src, /WHERE fr\.relationship_type = 'ie_oppose'/);
    assert.match(src, /\(ARRAY_AGG\(fr\.id ORDER BY fr\.occurred_at DESC NULLS LAST\)\)\[1:100\]/);
  }
});

test("(v) the lock is the crawl's key, transaction-scoped, 55P03 when held", () => {
  assert.match(NEW, /pg_try_advisory_xact_lock\(hashtext\('entity_connections_rebuild'\)::bigint\)/);
  assert.match(NEW, /ERRCODE = '55P03'/);
  // The delete is scoped by donor AND by the derived classes it rebuilds.
  assert.match(NEW, /ec\.from_id = ANY \(p_from_ids\)/);
  assert.match(NEW, /ec\.connection_type IN \('donation', 'opposition'\)/);
  assert.match(NEW, /ec\.evidence_source = 'financial_relationships'/);
  // No watermark moves: it is a repair of named donors, not a crawl window.
  assert.doesNotMatch(NEW, /pipeline_state/);
  assert.match(NEW_SRC, /REVOKE ALL ON FUNCTION public\.rebuild_ec_donation_edges_for_donors\(uuid\[\]\) FROM PUBLIC, anon, authenticated;/);
  assert.match(NEW_SRC, /GRANT EXECUTE ON FUNCTION public\.rebuild_ec_donation_edges_for_donors\(uuid\[\]\) TO service_role;/);
});

// ---------------------------------------------------------------------------
// (i) behavioural, local clone, rolled back
// ---------------------------------------------------------------------------

async function connect(t: { skip: (m: string) => void }): Promise<Client | null> {
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 3000 });
  try {
    await c.connect();
  } catch {
    t.skip("local Docker Postgres not reachable");
    return null;
  }
  const f = await c.query(
    `SELECT 1 FROM pg_proc WHERE proname = 'rebuild_ec_donation_edges_for_donors'`);
  if (f.rowCount === 0) {
    await c.end();
    t.skip("20261003020000 not applied locally");
    return null;
  }
  return c;
}

type Edge = { id: string; connection_type: string; amount_cents: string; evidence_count: number; strength: string; evidence_ids: string[] };

async function edges(c: Client, donor: string): Promise<Edge[]> {
  const r = await c.query<Edge>(
    `SELECT id, connection_type::text, amount_cents::text, evidence_count, strength::text, evidence_ids::text[]
       FROM public.entity_connections
      WHERE from_type = 'financial_entity' AND from_id = $1 ORDER BY connection_type`,
    [donor],
  );
  return r.rows;
}

async function fr(c: Client, rt: string, donor: string, official: string, cents: number): Promise<string> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO public.financial_relationships
       (relationship_type, from_type, from_id, to_type, to_id, amount_cents, occurred_at, metadata)
     VALUES ($1::public.financial_relationship_type, 'financial_entity', $2, 'official', $3, $4, '2026-04-30', '{"source":"fix1211-test"}')
     RETURNING id`,
    [rt, donor, official, cents],
  );
  return r.rows[0]!.id;
}

async function call(c: Client, donors: string[] | null) {
  const r = await c.query<{ connection_type: string; edges_deleted: string; edges_inserted: string }>(
    `SELECT connection_type, edges_deleted::text, edges_inserted::text
       FROM public.rebuild_ec_donation_edges_for_donors($1::uuid[])`,
    [donors],
  );
  return Object.fromEntries(r.rows.map((x) => [x.connection_type, [Number(x.edges_deleted), Number(x.edges_inserted)]]));
}

test("(i) the four fixtures: partial, opposition-only, no rows, and the empty call", async (t) => {
  const c = await connect(t);
  if (!c) return;
  try {
    await c.query("BEGIN");
    const ids = (await c.query<{ a: string; b: string; d: string; o: string }>(
      `SELECT gen_random_uuid()::text a, gen_random_uuid()::text b, gen_random_uuid()::text d, gen_random_uuid()::text o`,
    )).rows[0]!;

    // A — db99c5ef's shape: a $654 donation and a $1,499.99 ie_support.
    const don = await fr(c, "donation", ids.a, ids.o, 65400);
    const ie = await fr(c, "ie_support", ids.a, ids.o, 149999);
    assert.deepEqual(await call(c, [ids.a]), { donation: [0, 1], opposition: [0, 0] });
    const [seed] = await edges(c, ids.a);
    assert.equal(seed!.amount_cents, "215399");
    assert.equal(seed!.evidence_count, 2);
    assert.equal(seed!.strength, "0.417");

    // The deletion the FIX-1106 pac apply made. Nothing re-derives the edge.
    await c.query(`DELETE FROM public.financial_relationships WHERE id = $1`, [don]);
    const [stale] = await edges(c, ids.a);
    assert.equal(stale!.amount_cents, "215399", "the pre-FIX-1211 state: the deleted $654 is still counted");

    assert.deepEqual(await call(c, [ids.a]), { donation: [1, 1], opposition: [0, 0] });
    const after = await edges(c, ids.a);
    assert.equal(after.length, 1);
    assert.equal(after[0]!.connection_type, "donation");
    assert.equal(after[0]!.amount_cents, "149999");
    assert.equal(after[0]!.evidence_count, 1);
    assert.equal(after[0]!.strength, "0.397");
    assert.deepEqual(after[0]!.evidence_ids, [ie]);
    assert.notEqual(after[0]!.id, stale!.id, "DELETE + INSERT: the edge id changes");

    // B — only an ie_oppose row -> one 'opposition' edge, no donation edge.
    await fr(c, "ie_oppose", ids.b, ids.o, 50000);
    assert.deepEqual(await call(c, [ids.b]), { donation: [0, 0], opposition: [0, 1] });
    const opp = await edges(c, ids.b);
    assert.deepEqual(opp.map((e) => [e.connection_type, e.amount_cents]), [["opposition", "50000"]]);

    // D — an edge whose donor has no FR rows left: deleted, nothing re-derived.
    await c.query(
      `INSERT INTO public.entity_connections (from_type, from_id, to_type, to_id, connection_type, amount_cents,
                                              evidence_count, evidence_source, evidence_ids)
       VALUES ('financial_entity', $1, 'official', $2, 'donation', 1000, 1, 'financial_relationships',
               ARRAY[gen_random_uuid()])`,
      [ids.d, ids.o],
    );
    assert.deepEqual(await call(c, [ids.d]), { donation: [1, 0], opposition: [0, 0] });
    assert.equal((await edges(c, ids.d)).length, 0);

    // Empty and NULL lists are no-ops, not "every donor".
    assert.deepEqual(await call(c, []), { donation: [0, 0], opposition: [0, 0] });
    assert.deepEqual(await call(c, null), { donation: [0, 0], opposition: [0, 0] });
  } finally {
    await c.query("ROLLBACK");
    await c.end();
  }
});

test("(i) a held EC rebuild lock raises 55P03", async (t) => {
  const c = await connect(t);
  if (!c) return;
  const holder = new Client({ connectionString: LOCAL_DSN });
  await holder.connect();
  try {
    const got = await holder.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext('entity_connections_rebuild')::bigint) AS ok`);
    if (!got.rows[0]!.ok) {
      t.skip("the local EC crawl holds the lock right now");
      return;
    }
    await assert.rejects(
      c.query(`SELECT * FROM public.rebuild_ec_donation_edges_for_donors(ARRAY[gen_random_uuid()])`),
      { code: "55P03" },
    );
  } finally {
    await holder.query(`SELECT pg_advisory_unlock(hashtext('entity_connections_rebuild')::bigint)`);
    await holder.end();
    await c.end();
  }
});

test("(i) the drain's call path repairs a partial edge end to end", async (t) => {
  const c = await connect(t);
  if (!c) return;
  try {
    await c.query("BEGIN");
    const ids = (await c.query<{ a: string; o: string }>(
      `SELECT gen_random_uuid()::text a, gen_random_uuid()::text o`)).rows[0]!;
    const don = await fr(c, "donation", ids.a, ids.o, 65400);
    const ie = await fr(c, "ie_support", ids.a, ids.o, 149999);
    await call(c, [ids.a]);
    await c.query(`DELETE FROM public.financial_relationships WHERE id = $1`, [don]);
    await c.query(`CREATE TEMP TABLE _fix1211_aff (id uuid) ON COMMIT DROP`);
    await c.query(`CREATE TEMP TABLE _fix1211_don (id uuid) ON COMMIT DROP`);

    const { ran } = await drainFrRewrite(
      c,
      { affectedTable: "_fix1211_aff", affectedIdColumn: "id", donorTable: "_fix1211_don", deletedFrRowIds: [don] },
      { prod: false, defer: true, printTable: false, ecLockRetryMs: 0 },
    );
    assert.deepEqual(ran, ["entity_connections delete stale money edges", "rebuild_ec_donation_edges_for_donors(partial)"]);
    const after = await edges(c, ids.a);
    assert.deepEqual(after.map((e) => [e.amount_cents, e.evidence_count, e.strength, e.evidence_ids]),
      [["149999", 1, "0.397", [ie]]]);
  } finally {
    await c.query("ROLLBACK");
    await c.end();
  }
});
