/**
 * FIX-1178 (a) — the pre-vote-timing MERGE, source anchors + behavioural proof.
 *
 * Runs via:  tsx --test src/pipelines/tags/pre-vote-timing-merge.test.ts
 *
 * TWO HALVES, for the FIX-407 reason. The source anchors assert properties of
 * the migration TEXT that no behavioural test can see — that the PROCEDURE
 * still carries no `SET` clause (FIX-1128: a proconfig'd routine cannot COMMIT,
 * and this one does), and that the planner GUCs sit on `_scan()` and nowhere
 * else. Those are claims about the shipped DDL, so they are tested against the
 * shipped DDL and they run everywhere, CI included.
 *
 * The behavioural half tests the three functions against real rows, because a
 * TypeScript reimplementation of a set difference would test a copy rather than
 * the shipped SQL. It is DOUBLY gated: it skips when the local Docker DB is
 * unreachable (the `detector-coverage.test.ts` shape, so CI is inert), and it
 * additionally requires CIVITICS_DB_HEAVY_TESTS=1 because it runs the FR x votes
 * scan THREE times and that is tens of seconds on a prod clone, not
 * milliseconds. Its own wall is printed so the cost is never a surprise.
 *
 * Every fixture is written inside a transaction that is ALWAYS rolled back.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

// `__dirname`, not `import.meta.dirname`: tsx transforms this file to CJS, where
// import.meta.dirname is undefined. The sibling source-anchor suite
// (promote-rpc-precedence.test.ts) resolves it the same way for the same reason.
const MIGRATION = path.join(
  __dirname, "..", "..", "..", "..", "..",
  "supabase", "migrations", "20260920080000_fix1178a_pre_vote_timing_merge.sql",
);

const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const HEAVY = process.env["CIVITICS_DB_HEAVY_TESTS"] === "1";

/** The text between a routine's CREATE line and its `AS $function$` / `AS $procedure$`. */
function header(src: string, signature: string): string {
  const i = src.indexOf(signature);
  assert.notEqual(i, -1, `routine header not found: ${signature}`);
  const rest = src.slice(i);
  const end = rest.search(/AS \$(function|procedure)\$/);
  assert.notEqual(end, -1, `no AS $...$ after ${signature}`);
  return rest.slice(0, end);
}

/** A routine's body, between its opening and closing dollar-quote. */
function body(src: string, signature: string): string {
  const i = src.indexOf(signature);
  assert.notEqual(i, -1, `routine not found: ${signature}`);
  const rest = src.slice(i);
  const m = rest.match(/AS \$(function|procedure)\$([\s\S]*?)\$\1\$/);
  assert.ok(m, `no dollar-quoted body after ${signature}`);
  return m[2] as string;
}

// ---------------------------------------------------------------------------
// (i) Source anchors — no database, so these run in CI.
// ---------------------------------------------------------------------------

test("FIX-1178 (a): the PROCEDURE takes no SET clause (FIX-1128 / transaction control)", () => {
  const src = fs.readFileSync(MIGRATION, "utf8");
  const h = header(src, "CREATE OR REPLACE PROCEDURE public.run_rule_taggers");
  assert.doesNotMatch(
    h,
    /\bSET\s+\w+\s*(=|TO)/,
    "run_rule_taggers COMMITs; ANY proconfig SET makes it atomic and it dies at the first COMMIT",
  );
});

test("FIX-1178 (a): no routine in this migration carries SET statement_timeout", () => {
  const src = fs.readFileSync(MIGRATION, "utf8");
  for (const sig of [
    "CREATE OR REPLACE FUNCTION public.rebuild_pre_vote_timing_tags_scan",
    "CREATE OR REPLACE FUNCTION public.rebuild_pre_vote_timing_tags_delete",
    "CREATE OR REPLACE FUNCTION public.rebuild_pre_vote_timing_tags_insert",
    "CREATE OR REPLACE FUNCTION public.rebuild_pre_vote_timing_tags(",
    "CREATE OR REPLACE PROCEDURE public.run_rule_taggers",
  ]) {
    assert.doesNotMatch(
      header(src, sig),
      /SET\s+statement_timeout/i,
      `${sig}: a routine-level statement_timeout is INERT (FIX-1128) — it bounds nothing and reads as if it did`,
    );
  }
});

test("FIX-1178 (a): the planner GUCs are on _scan() and on nothing else", () => {
  const src = fs.readFileSync(MIGRATION, "utf8");

  const scan = header(src, "CREATE OR REPLACE FUNCTION public.rebuild_pre_vote_timing_tags_scan");
  assert.match(scan, /SET enable_hashjoin TO 'off'/, "_scan owns the correlated EXISTS over votes");
  assert.match(scan, /SET enable_mergejoin TO 'off'/, "_scan owns the correlated EXISTS over votes");

  for (const sig of [
    "CREATE OR REPLACE FUNCTION public.rebuild_pre_vote_timing_tags_delete",
    "CREATE OR REPLACE FUNCTION public.rebuild_pre_vote_timing_tags_insert",
    "CREATE OR REPLACE FUNCTION public.rebuild_pre_vote_timing_tags(",
  ]) {
    const h = header(src, sig);
    assert.doesNotMatch(h, /enable_hashjoin/, `${sig}: there is no join here these could help`);
    assert.doesNotMatch(h, /enable_mergejoin/, `${sig}: the anti-join WANTS a hash anti-join`);
    // search_path is still mandatory on every SECURITY DEFINER routine.
    assert.match(h, /SET search_path TO 'public', 'pg_temp'/, `${sig}: SECURITY DEFINER needs a pinned search_path`);
  }
});

test("FIX-1178 (a): _delete carries the shrink guard, and it RAISEs rather than logging", () => {
  const src = fs.readFileSync(MIGRATION, "utf8");
  const b = body(src, "CREATE OR REPLACE FUNCTION public.rebuild_pre_vote_timing_tags_delete");
  assert.match(b, /v_des < v_cur \* 0\.5/, "the 50% floor is the guard");
  assert.match(b, /RAISE EXCEPTION/, "a WARNING would be wrong-but-green — the transaction must roll back");
  assert.match(b, /refusing a shrink past 50/, "the message has to say what it refused and why");
});

test("FIX-1178 (a): every temp-table reference is pg_temp-qualified", () => {
  const src = fs.readFileSync(MIGRATION, "utf8");
  for (const sig of [
    "CREATE OR REPLACE FUNCTION public.rebuild_pre_vote_timing_tags_scan",
    "CREATE OR REPLACE FUNCTION public.rebuild_pre_vote_timing_tags_delete",
    "CREATE OR REPLACE FUNCTION public.rebuild_pre_vote_timing_tags_insert",
  ]) {
    const b = body(src, sig);
    // `CREATE TEMP TABLE pvt_desired` is the one unqualified mention that is
    // correct — TEMP already names the schema. Every OTHER mention must carry
    // pg_temp., or a public.pvt_desired would silently win the search_path.
    const bare = b.match(/(?<!pg_temp\.)(?<!TEMP TABLE )\bpvt_desired\b/g) ?? [];
    assert.equal(
      bare.length,
      0,
      `${sig}: ${bare.length} unqualified pvt_desired reference(s) — search_path is 'public','pg_temp', so public wins`,
    );
  }
});

test("FIX-1178 (a): _insert's anti-join keys on the UNIQUE columns, not on generated_by", () => {
  const src = fs.readFileSync(MIGRATION, "utf8");
  const b = body(src, "CREATE OR REPLACE FUNCTION public.rebuild_pre_vote_timing_tags_insert");
  const anti = b.slice(b.indexOf("WHERE NOT EXISTS"), b.indexOf("ON CONFLICT"));
  assert.match(anti, /t\.entity_type\s*=\s*'financial_entity'/);
  assert.match(anti, /t\.entity_id\s*=\s*d\.entity_id/);
  assert.match(anti, /t\.tag\s*=\s*'pre_vote_timing'/);
  assert.match(anti, /t\.tag_category\s*=\s*'internal'/);
  assert.doesNotMatch(
    anti,
    /generated_by/,
    "generated_by is NOT in the unique key; including it would make the INSERT collide with a manual row every night",
  );
});

test("FIX-1178 (a): the wrapper calls scan, then delete, then insert, in that order", () => {
  const src = fs.readFileSync(MIGRATION, "utf8");
  const b = body(src, "CREATE OR REPLACE FUNCTION public.rebuild_pre_vote_timing_tags(");
  const iScan = b.indexOf("_tags_scan()");
  const iDel = b.indexOf("_tags_delete()");
  const iIns = b.indexOf("_tags_insert()");
  assert.ok(iScan > -1 && iDel > -1 && iIns > -1, "all three halves must be called");
  assert.ok(iScan < iDel, "the desired set must exist before the DELETE reads it");
  assert.ok(iDel < iIns, "delete current\\desired before inserting desired\\current");
});

test("FIX-1178 (a): the daily branch stamps three phases and the two set sizes", () => {
  const src = fs.readFileSync(MIGRATION, "utf8");
  const b = body(src, "CREATE OR REPLACE PROCEDURE public.run_rule_taggers");
  assert.match(b, /'scan',\s*round/, "scan is the phase FIX-1178 (a) adds");
  assert.match(b, /'delete',\s*round/);
  assert.match(b, /'insert',\s*round/);
  // Absent, not null, on a branch that measured nothing — the FIX-1178 (d)
  // discipline, extended rather than re-invented.
  assert.match(
    b,
    /CASE WHEN v_desired IS NULL THEN '\{\}'::jsonb/,
    "the weekly branch must not grow two misleading zeroes",
  );
});

// ---------------------------------------------------------------------------
// (ii) Behavioural — skipped without a DB, and without CIVITICS_DB_HEAVY_TESTS=1.
// ---------------------------------------------------------------------------

const CAT_COUNT = `
  SELECT count(*)::bigint AS n FROM public.entity_tags
   WHERE entity_type='financial_entity' AND generated_by='rule' AND tag_category='internal'`;

async function scalar(c: Client, sql: string, params: unknown[] = []): Promise<bigint> {
  const r = await c.query<{ n: string }>(sql, params as never[]);
  return BigInt(r.rows[0]?.["n"] ?? "0");
}

test("FIX-1178 (a): the merge converges, strands nothing, and refuses a shrink", async (t) => {
  if (!HEAVY) {
    t.skip("CIVITICS_DB_HEAVY_TESTS=1 not set — this runs the FR x votes scan 3x (tens of seconds)");
    return;
  }
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  try {
    await c.connect();
  } catch {
    t.skip("local Docker DB unreachable — behavioural half skipped (source anchors above still ran)");
    return;
  }

  const t0 = Date.now();
  try {
    await c.query("BEGIN");

    // ── (b) the fixtures, planted BEFORE the first pass ───────────────────
    // A real entity that IS in the desired set, so it is a "stayer".
    const stayer = await c.query<{ entity_id: string; id: string }>(`
      SELECT entity_id, id FROM public.entity_tags
       WHERE entity_type='financial_entity' AND generated_by='rule'
         AND tag_category='internal' AND tag='pre_vote_timing'
       LIMIT 1`);
    const stayerEntity = stayer.rows[0]?.["entity_id"];
    const stayerRowId = stayer.rows[0]?.["id"];
    assert.ok(stayerEntity, "no existing pre_vote_timing row to use as the stayer fixture");

    // A FOREIGN category row for that same real entity: rule + industry. The
    // merge must not touch it — it belongs to tagFinancialEntities().
    await c.query(
      `INSERT INTO public.entity_tags
         (entity_type, entity_id, tag, tag_category, display_label, visibility, generated_by, confidence)
       VALUES ('financial_entity', $1, 'fix1178_probe_industry', 'industry', 'Probe', 'internal', 'rule', 1.0)`,
      [stayerEntity],
    );

    // An internal/rule row for an entity that CANNOT be in the desired set.
    const orphan = await c.query<{ id: string }>(
      `INSERT INTO public.entity_tags
         (entity_type, entity_id, tag, tag_category, display_label, visibility, generated_by, confidence)
       VALUES ('financial_entity', gen_random_uuid(), 'pre_vote_timing', 'internal', 'Pre-Vote Timing', 'internal', 'rule', 1.0)
       RETURNING id`,
      [],
    );
    const orphanId = orphan.rows[0]?.["id"];
    assert.ok(orphanId, "orphan fixture did not insert");

    // ── (a) the first pass ────────────────────────────────────────────────
    const n1 = await scalar(c, "SELECT public.rebuild_pre_vote_timing_tags_scan()::bigint AS n");
    const d1 = await scalar(c, "SELECT public.rebuild_pre_vote_timing_tags_delete()::bigint AS n");
    const i1 = await scalar(c, "SELECT public.rebuild_pre_vote_timing_tags_insert()::bigint AS n");
    assert.ok(n1 > 0n, "the desired set must not be empty on a clone with data");

    // The category is now EXACTLY the desired set. This is the strand-proof
    // as an assertion rather than an argument.
    const after = await scalar(c, CAT_COUNT);
    assert.equal(after, n1, `category should equal |desired| (${n1}) but is ${after}`);

    // The planted orphan had no partner in pvt_desired, so it is gone.
    assert.ok(d1 >= 1n, `the orphan alone should have been deleted; d1=${d1}`);
    const orphanLeft = await scalar(
      c,
      "SELECT count(*)::bigint AS n FROM public.entity_tags WHERE id = $1",
      [orphanId],
    );
    assert.equal(orphanLeft, 0n, "the orphan internal/rule row survived the DELETE");

    // The foreign-category row is untouched.
    const probeLeft = await scalar(
      c,
      `SELECT count(*)::bigint AS n FROM public.entity_tags
        WHERE entity_type='financial_entity' AND entity_id=$1 AND tag='fix1178_probe_industry'`,
      [stayerEntity],
    );
    assert.equal(probeLeft, 1n, "the merge deleted a row from a category it does not own");

    // The stayer kept its ORIGINAL row — it was spared, not deleted and
    // reinserted. This is the whole point: a new id would mean a new heap
    // tuple and a fresh index entry in every index.
    const stayerSame = await scalar(
      c,
      "SELECT count(*)::bigint AS n FROM public.entity_tags WHERE id = $1",
      [stayerRowId],
    );
    assert.equal(stayerSame, 1n, "the stayer's row id changed — it was rewritten, not merged");

    // ── (c) the second pass moves nothing ─────────────────────────────────
    await c.query("SELECT public.rebuild_pre_vote_timing_tags_scan()");
    const d2 = await scalar(c, "SELECT public.rebuild_pre_vote_timing_tags_delete()::bigint AS n");
    const i2 = await scalar(c, "SELECT public.rebuild_pre_vote_timing_tags_insert()::bigint AS n");
    assert.equal(d2, 0n, "a second pass deleted rows — the DELETE predicate is not idempotent");
    assert.equal(i2, 0n, "a second pass inserted rows — the anti-join is not idempotent");

    // ── (d) the shrink guard ──────────────────────────────────────────────
    // An emptied desired set is the wrong-but-green shape: today's rewrite
    // would DELETE the whole category and report success.
    await c.query("SAVEPOINT guard_probe");
    await c.query("DELETE FROM pg_temp.pvt_desired");
    await assert.rejects(
      () => c.query("SELECT public.rebuild_pre_vote_timing_tags_delete()"),
      /refusing a shrink past 50/,
      "an empty desired set must RAISE, not delete the category",
    );
    await c.query("ROLLBACK TO SAVEPOINT guard_probe");

    console.log(
      `[fix1178a] behavioural half: desired=${n1} d1=${d1} i1=${i1} d2=${d2} i2=${i2} ` +
        `wall=${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    await c.end().catch(() => {});
  }
});

test("FIX-1178 (a): _delete without a desired set errors loudly rather than returning 0", async (t) => {
  if (!HEAVY) {
    t.skip("CIVITICS_DB_HEAVY_TESTS=1 not set");
    return;
  }
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  try {
    await c.connect();
  } catch {
    t.skip("local Docker DB unreachable");
    return;
  }
  try {
    // A fresh transaction, so pg_temp.pvt_desired does not exist. Calling the
    // halves out of order must be a 42P01, never a silent no-op that would
    // delete the whole category (v_des would read as 0).
    await c.query("BEGIN");
    await assert.rejects(
      () => c.query("SELECT public.rebuild_pre_vote_timing_tags_delete()"),
      /pvt_desired/,
      "out-of-order call must name the missing temp table",
    );
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    await c.end().catch(() => {});
  }
});
