/**
 * FIX-1248 — the weekly `size`-tag MERGE, source anchors + behavioural proof.
 *
 * Runs via:  tsx --test src/pipelines/tags/size-tags-merge.test.ts
 *
 * TWO HALVES, as in pre-vote-timing-merge.test.ts. The source anchors assert
 * what only the migration TEXT can show: the PROCEDURE still carries no `SET`
 * clause (FIX-1128: it COMMITs), no routine carries planner GUCs or an inert
 * statement_timeout, and the daily branch is byte-identical to the one
 * 20260920080000 shipped. They need no database, so they run in CI.
 *
 * The three functions are tested against real rows, because a TypeScript
 * reimplementation of a set difference would test a copy rather than the
 * shipped SQL. DOUBLY gated, like pre-vote-timing-merge.test.ts: it skips when
 * the local Docker DB is unreachable (so CI is inert), and it additionally
 * requires CIVITICS_DB_HEAVY_TESTS=1, because every pass re-aggregates every
 * donation row and that is tens of seconds on a prod clone. Its own wall is
 * printed so the cost is never a surprise.
 *
 * Every fixture is written inside a transaction that is ALWAYS rolled back.
 *
 * The wrong-but-green shapes the fixtures exist to catch (rule 105):
 *   (b) a same-tier donor whose total moved MUST be updated in place. The
 *       daily's `ON CONFLICT DO NOTHING` would leave its total stale forever.
 *   (c) a tier change is a DELETE of the old tag and an INSERT of the new one,
 *       because `tag` is in the UNIQUE key.
 *   (f) a row from a category the merge does not own survives it.
 *   (g) a NON-rule row on a desired key is left alone, which is what today's
 *       DO NOTHING has always done.
 *   and a truncated scan, or a delete past 10 %, must RAISE.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

// `__dirname`, not `import.meta.dirname`: tsx transforms this file to CJS.
const MIGRATIONS = path.join(__dirname, "..", "..", "..", "..", "..", "supabase", "migrations");
// Found by suffix so a version bump at landing time does not orphan the anchors.
const MIGRATION_SUFFIX = "_fix1248_weekly_size_tags_merge.sql";
const DAILY_MIGRATION = "20260920080000_fix1178a_pre_vote_timing_merge.sql";

function migration(): string {
  const hits = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(MIGRATION_SUFFIX));
  assert.equal(hits.length, 1, `expected exactly one *${MIGRATION_SUFFIX}, found ${hits.join(", ") || "none"}`);
  return fs.readFileSync(path.join(MIGRATIONS, hits[0] as string), "utf8").replace(/\r\n/g, "\n");
}

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

const SIG = {
  scan: "CREATE OR REPLACE FUNCTION public.rebuild_financial_entity_size_tags_scan(",
  del: "CREATE OR REPLACE FUNCTION public.rebuild_financial_entity_size_tags_delete(",
  ins: "CREATE OR REPLACE FUNCTION public.rebuild_financial_entity_size_tags_insert(",
  wrap: "CREATE OR REPLACE FUNCTION public.rebuild_financial_entity_size_tags(",
  proc: "CREATE OR REPLACE PROCEDURE public.run_rule_taggers",
};

// ---------------------------------------------------------------------------
// (i) Source anchors — no database, so these run in CI.
// ---------------------------------------------------------------------------

test("FIX-1248: the PROCEDURE takes no SET clause (FIX-1128 / transaction control)", () => {
  assert.doesNotMatch(
    header(migration(), SIG.proc),
    /\bSET\s+\w+\s*(=|TO)/,
    "run_rule_taggers COMMITs; ANY proconfig SET makes it atomic and it dies at the first COMMIT",
  );
});

test("FIX-1248: every function pins search_path and carries no planner GUC or statement_timeout", () => {
  const src = migration();
  for (const sig of [SIG.scan, SIG.del, SIG.ins, SIG.wrap]) {
    const h = header(src, sig);
    assert.match(h, /SECURITY DEFINER/, `${sig}: the three halves and the wrapper stay SECURITY DEFINER`);
    assert.match(h, /SET search_path TO 'public', 'pg_temp'/, `${sig}: SECURITY DEFINER needs a pinned search_path`);
    assert.doesNotMatch(h, /enable_(hashjoin|mergejoin|nestloop)/, `${sig}: the anti-joins WANT hash joins`);
    assert.doesNotMatch(h, /statement_timeout/i, `${sig}: a routine-level statement_timeout is INERT (FIX-1128)`);
  }
  assert.doesNotMatch(header(src, SIG.proc), /statement_timeout/i);
});

test("FIX-1248: _delete carries BOTH guards, checked before the DELETE, and they RAISE", () => {
  const b = body(migration(), SIG.del);
  const iShrink = b.indexOf("v_des < v_cur * 0.5");
  const iTen = b.indexOf("v_gone > v_cur * 0.10");
  const iDelete = b.indexOf("DELETE FROM public.entity_tags");
  assert.ok(iShrink > -1, "the 50 % shrink floor");
  assert.ok(iTen > -1, "the 10 % delete ceiling");
  assert.ok(iShrink < iDelete && iTen < iDelete, "a guard after the DELETE would have already deleted");
  assert.equal((b.match(/RAISE EXCEPTION/g) ?? []).length, 2, "a WARNING would be wrong-but-green");
  assert.match(b, /refusing a shrink past 50/);
  assert.match(b, /refusing a delete past 10/);
});

test("FIX-1248: both anti-joins key on (entity_id, tag) — a tier change is a delete plus an insert", () => {
  const src = migration();
  const del = body(src, SIG.del);
  const delAnti = del.slice(del.indexOf("AND NOT EXISTS"));
  assert.match(delAnti, /d\.entity_id\s*=\s*t\.entity_id/);
  assert.match(delAnti, /d\.tag\s*=\s*t\.tag/, "keyed on entity_id alone, a tier change would strand the old tag");

  const ins = body(src, SIG.ins);
  const insAnti = ins.slice(ins.indexOf("WHERE NOT EXISTS"), ins.indexOf("ON CONFLICT"));
  assert.match(insAnti, /t\.entity_type\s*=\s*'financial_entity'/);
  assert.match(insAnti, /t\.entity_id\s*=\s*d\.entity_id/);
  assert.match(insAnti, /t\.tag\s*=\s*d\.tag/);
  assert.match(insAnti, /t\.tag_category\s*=\s*'size'/);
  assert.match(insAnti, /t\.metadata\s*=\s*d\.metadata/, "a same-key row with a stale total must get past the anti-join");
  assert.doesNotMatch(insAnti, /generated_by/, "generated_by is NOT in the unique key");
});

test("FIX-1248: the conflict arm UPDATEs a moved total, only on a rule row, only when it differs", () => {
  const ins = body(migration(), SIG.ins);
  const arm = ins.slice(ins.indexOf("ON CONFLICT"));
  assert.match(arm, /DO UPDATE/, "DO NOTHING would leave a moved total stale forever");
  assert.match(arm, /SET metadata\s*=\s*EXCLUDED\.metadata/);
  assert.match(arm, /entity_tags\.metadata IS DISTINCT FROM EXCLUDED\.metadata/, "an unconditional UPDATE rewrites every conflicting row");
  assert.match(arm, /entity_tags\.generated_by = 'rule'/, "a manual row on a size key is not this job's to overwrite");
  assert.match(arm, /RETURNING \(xmax = 0\)/, "the inserted/updated split");
});

test("FIX-1248: every temp-table reference is pg_temp-qualified", () => {
  const src = migration();
  for (const sig of [SIG.scan, SIG.del, SIG.ins]) {
    const bare = body(src, sig).match(/(?<!pg_temp\.)(?<!TEMP TABLE )\bfes_desired\b/g) ?? [];
    assert.equal(bare.length, 0, `${sig}: unqualified fes_desired — search_path is 'public','pg_temp', so public wins`);
  }
});

test("FIX-1248: the wrapper and the weekly branch call scan, then delete, then insert", () => {
  const src = migration();
  for (const b of [body(src, SIG.wrap), body(src, SIG.proc)]) {
    const iScan = b.indexOf("rebuild_financial_entity_size_tags_scan()");
    const iDel = b.indexOf("rebuild_financial_entity_size_tags_delete()");
    const iIns = b.indexOf("rebuild_financial_entity_size_tags_insert()");
    assert.ok(iScan > -1 && iDel > -1 && iIns > -1, "all three halves must be called");
    assert.ok(iScan < iDel && iDel < iIns, "scan, then delete, then insert");
  }
});

test("FIX-1248: the weekly branch stamps three phases and four counts, absent when unmeasured", () => {
  const b = body(migration(), SIG.proc);
  const weekly = b.slice(b.indexOf("IF p_cadence = 'weekly' THEN"), b.indexOf("-- ── pre-vote timing"));
  assert.match(weekly, /'scan',\s*round/);
  assert.match(weekly, /'delete',\s*round/);
  assert.match(weekly, /'insert',\s*round/);
  assert.match(b, /CASE WHEN v_inserted IS NULL THEN '\{\}'::jsonb/, "the daily's row must not grow two misleading zeroes");
  assert.match(b, /'inserted_rows', v_inserted/);
  assert.match(b, /'updated_rows', v_updated/);
  // The gate, the advance and the subtransaction's handlers are kept.
  assert.match(weekly, /IF v_stored_sig IS DISTINCT FROM v_current_sig THEN/);
  assert.match(weekly, /ON CONFLICT \(key\) DO UPDATE SET value = EXCLUDED\.value/);
  assert.match(weekly, /WHEN query_canceled THEN/);
});

test("FIX-1248: the DAILY branch is byte-identical to the one 20260920080000 shipped", () => {
  const daily = (src: string) => {
    const b = body(src, SIG.proc);
    const i = b.indexOf("  ELSE\n    -- ── pre-vote timing");
    const j = b.indexOf("    COMMIT;\n  END IF;", i);
    assert.ok(i > -1 && j > i, "daily branch not found");
    return b.slice(i, j);
  };
  const before = fs.readFileSync(path.join(MIGRATIONS, DAILY_MIGRATION), "utf8").replace(/\r\n/g, "\n");
  assert.equal(daily(migration()), daily(before), "FIX-1248 must not touch the daily branch (rule 138)");
});

// ---------------------------------------------------------------------------
// (ii) Behavioural — skipped without a DB, and without CIVITICS_DB_HEAVY_TESTS=1.
// ---------------------------------------------------------------------------

const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const HEAVY = process.env["CIVITICS_DB_HEAVY_TESTS"] === "1";

const RULE_SIZE = `
  entity_type = 'financial_entity' AND generated_by = 'rule' AND tag_category = 'size'`;

const CAT_COUNT = `SELECT count(*)::bigint AS n FROM public.entity_tags WHERE ${RULE_SIZE}`;

/**
 * The expected delta, computed independently of the three functions: set
 * semantics over the same desired set, with no anti-join shared with the
 * shipped SQL. The functions' counts must reconcile with it exactly
 * (rule 116), which is also what proves the `xmax = 0` split.
 */
const EXPECTED = `
  WITH don AS (
    SELECT fr.from_id AS entity_id, SUM(COALESCE(fr.amount_cents, 0))::bigint AS total_cents
    FROM public.financial_relationships fr
    WHERE fr.from_type = 'financial_entity' AND fr.relationship_type = 'donation'
    GROUP BY fr.from_id
  ), d AS (
    SELECT entity_id,
           CASE WHEN total_cents <    500000 THEN 'small_donation'
                WHEN total_cents <   5000000 THEN 'medium_donation'
                WHEN total_cents <  50000000 THEN 'large_donation'
                ELSE                              'major_donation' END AS tag,
           jsonb_build_object('total_cents', total_cents) AS metadata
    FROM don
  ), k AS (
    SELECT d.*, t.generated_by AS held_by, t.metadata AS held_md
    FROM d LEFT JOIN public.entity_tags t
      ON t.entity_type = 'financial_entity' AND t.tag_category = 'size'
     AND t.entity_id = d.entity_id AND t.tag = d.tag
  )
  SELECT
    (SELECT count(*) FROM d)::bigint                                              AS desired,
    (SELECT count(*) FROM (
       SELECT entity_id, tag FROM public.entity_tags WHERE ${RULE_SIZE}
       EXCEPT
       SELECT entity_id, tag FROM d) x)::bigint                                   AS deleted,
    (SELECT count(*) FROM k WHERE held_by IS NULL)::bigint                        AS inserted,
    (SELECT count(*) FROM k WHERE held_by = 'rule' AND held_md IS DISTINCT FROM metadata)::bigint AS updated,
    (SELECT count(*) FROM k WHERE held_by <> 'rule')::bigint                      AS blocked`;

type Expected = { desired: bigint; deleted: bigint; inserted: bigint; updated: bigint; blocked: bigint };

async function scalar(c: Client, sql: string, params: unknown[] = []): Promise<bigint> {
  const r = await c.query<{ n: string }>(sql, params as never[]);
  return BigInt(r.rows[0]?.["n"] ?? "0");
}

async function expected(c: Client): Promise<Expected> {
  const r = await c.query<Record<keyof Expected, string>>(EXPECTED);
  const row = r.rows[0];
  assert.ok(row, "expected-delta query returned no row");
  return {
    desired: BigInt(row.desired),
    deleted: BigInt(row.deleted),
    inserted: BigInt(row.inserted),
    updated: BigInt(row.updated),
    blocked: BigInt(row.blocked),
  };
}

async function merge(c: Client): Promise<{ desired: bigint; deleted: bigint; inserted: bigint; updated: bigint }> {
  const desired = await scalar(c, "SELECT public.rebuild_financial_entity_size_tags_scan()::bigint AS n");
  const deleted = await scalar(c, "SELECT public.rebuild_financial_entity_size_tags_delete()::bigint AS n");
  const r = await c.query<{ inserted: string; updated: string }>(
    "SELECT inserted, updated FROM public.rebuild_financial_entity_size_tags_insert()",
  );
  return {
    desired,
    deleted,
    inserted: BigInt(r.rows[0]?.["inserted"] ?? "-1"),
    updated: BigInt(r.rows[0]?.["updated"] ?? "-1"),
  };
}

async function connect(t: { skip: (msg: string) => void }): Promise<Client | null> {
  if (!HEAVY) {
    t.skip("CIVITICS_DB_HEAVY_TESTS=1 not set — every pass re-aggregates every donation row (tens of seconds)");
    return null;
  }
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  try {
    await c.connect();
  } catch {
    t.skip("local Docker DB unreachable — behavioural suite skipped");
    return null;
  }
  return c;
}

/** Plant a scratch donor: one donation row per amount, tagged so it is findable. */
async function donate(c: Client, entityId: string, amountCents: number): Promise<void> {
  await c.query(
    `INSERT INTO public.financial_relationships
       (relationship_type, from_type, from_id, to_type, to_id, amount_cents, occurred_at, metadata)
     VALUES ('donation', 'financial_entity', $1, 'official', gen_random_uuid(), $2, '2026-01-15',
             '{"seed": "cc179"}'::jsonb)`,
    [entityId, amountCents],
  );
}

/** Plant a size row as the previous run would have left it. Returns its id. */
async function sizeRow(
  c: Client,
  entityId: string,
  tag: string,
  label: string,
  totalCents: number,
  generatedBy = "rule",
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO public.entity_tags
       (entity_type, entity_id, tag, tag_category, display_label, visibility,
        confidence, generated_by, pipeline_version, metadata)
     VALUES ('financial_entity', $1, $2, 'size', $3, 'internal', 1.0, $4, 'v1',
             jsonb_build_object('total_cents', $5::bigint))
     RETURNING id`,
    [entityId, tag, label, generatedBy, totalCents],
  );
  const id = r.rows[0]?.["id"];
  assert.ok(id, `size fixture did not insert for ${entityId}`);
  return id;
}

/** id, ctid and payload of one row, or null. ctid moves on ANY update, HOT included. */
async function row(c: Client, id: string) {
  const r = await c.query<{ ctid: string; tag: string; metadata: { total_cents: number } }>(
    "SELECT ctid::text AS ctid, tag, metadata FROM public.entity_tags WHERE id = $1",
    [id],
  );
  return r.rows[0] ?? null;
}

test("FIX-1248: the weekly size merge — six fixtures, reconciled counts, second pass moves nothing", async (t) => {
  const c = await connect(t);
  if (!c) return;

  const t0 = Date.now();
  try {
    await c.query("BEGIN");

    const ids = await c.query<{ a: string; b: string; cc: string; d: string; e: string; g: string }>(
      "SELECT gen_random_uuid() a, gen_random_uuid() b, gen_random_uuid() cc, gen_random_uuid() d, gen_random_uuid() e, gen_random_uuid() g",
    );
    const E = ids.rows[0];
    assert.ok(E);

    // (a) STAYS — same tier, same total.
    await donate(c, E.a, 60_000);
    await donate(c, E.a, 40_000); // two rows: the aggregate must sum them
    const aId = await sizeRow(c, E.a, "small_donation", "Small Donation", 100_000);
    // (b) MOVED TOTAL, same tier — the stored total is stale.
    await donate(c, E.b, 200_000);
    const bId = await sizeRow(c, E.b, "small_donation", "Small Donation", 150_000);
    // (c) CROSSED A TIER — was medium at 3,000,000; now 6,000,000 = large.
    await donate(c, E.cc, 6_000_000);
    const cId = await sizeRow(c, E.cc, "medium_donation", "Medium Donation", 3_000_000);
    // (d) LEFT — a size row with no donation rows behind it.
    const dId = await sizeRow(c, E.d, "small_donation", "Small Donation", 1_000);
    // (e) NEW — donations, no size row yet. 60,000,000 = major.
    await donate(c, E.e, 60_000_000);
    // (f) FOREIGN — an industry/rule row on the stayer's entity.
    const f = await c.query<{ id: string }>(
      `INSERT INTO public.entity_tags
         (entity_type, entity_id, tag, tag_category, display_label, visibility, generated_by, confidence, metadata)
       VALUES ('financial_entity', $1, 'cc179_probe_industry', 'industry', 'Probe', 'internal', 'rule', 1.0,
               '{"seed": "cc179"}'::jsonb)
       RETURNING id`,
      [E.a],
    );
    const fId = f.rows[0]?.["id"];
    assert.ok(fId);
    // (g) A MANUAL row on a desired key, with a total that disagrees.
    await donate(c, E.g, 300_000);
    const gId = await sizeRow(c, E.g, "small_donation", "Small Donation", 1, "manual");

    const before = { a: await row(c, aId), b: await row(c, bId), f: await row(c, fId), g: await row(c, gId) };
    const catBefore = await scalar(c, CAT_COUNT);
    const exp = await expected(c);
    assert.ok(exp.blocked >= 1n, "fixture (g) must register as a key held by a non-rule row");
    assert.ok(exp.deleted * 10n <= catBefore, `the clone's own delta trips the 10 % guard (${exp.deleted}/${catBefore}) — converge it first`);

    // ── the first pass ──────────────────────────────────────────────────────
    const p1 = await merge(c);

    // Rule 116: the counts reconcile with an independent computation, and the
    // category is the desired set minus the keys a non-rule row holds.
    assert.equal(p1.desired, exp.desired, "_scan's |desired| disagrees with the independent aggregate");
    assert.equal(p1.deleted, exp.deleted, "deleted ≠ |current \\ desired| on (entity_id, tag)");
    assert.equal(p1.inserted, exp.inserted, "inserted ≠ desired keys with no row at all");
    assert.equal(p1.updated, exp.updated, "updated ≠ rule rows on a desired key whose metadata moved");
    const catAfter = await scalar(c, CAT_COUNT);
    assert.equal(catAfter, catBefore - p1.deleted + p1.inserted, "current_after ≠ current_before − deleted + inserted");
    assert.equal(catAfter, p1.desired - exp.blocked, `|category| (${catAfter}) ≠ |desired| − blocked (${p1.desired} − ${exp.blocked})`);
    // The fixtures alone contribute at least this much to each count.
    assert.ok(p1.deleted >= 2n, "(c)'s old tier and (d) are both deletes");
    assert.ok(p1.inserted >= 2n, "(c)'s new tier and (e) are both inserts");
    assert.ok(p1.updated >= 1n, "(b) is an update");

    // (a) the stayer is untouched: same id, same tuple, same total.
    const a = await row(c, aId);
    assert.ok(a, "(a) the stayer was deleted");
    assert.equal(a.ctid, before.a?.ctid, "(a) the stayer was rewritten — a merge must not touch an unchanged row");
    assert.equal(a.metadata.total_cents, 100_000);

    // (b) same id, new tuple, the moved total.
    const b = await row(c, bId);
    assert.ok(b, "(b) the moved-total row was deleted instead of updated");
    assert.equal(b.metadata.total_cents, 200_000, "(b) the stale total survived — the DO NOTHING shape");
    assert.notEqual(b.ctid, before.b?.ctid, "(b) the row was not rewritten");

    // (c) the old tier is gone; the new tier is a different row with the right payload.
    assert.equal(await row(c, cId), null, "(c) the old medium_donation row survived a tier change");
    const cNew = await c.query<{ id: string; display_label: string; display_icon: string | null; visibility: string; metadata: { total_cents: number } }>(
      `SELECT id, display_label, display_icon, visibility, metadata FROM public.entity_tags
        WHERE entity_type='financial_entity' AND entity_id=$1 AND tag_category='size'`,
      [E.cc],
    );
    assert.equal(cNew.rows.length, 1, "(c) the entity should have exactly one size row");
    assert.notEqual(cNew.rows[0]?.id, cId);
    assert.deepEqual(
      { label: cNew.rows[0]?.display_label, icon: cNew.rows[0]?.display_icon, vis: cNew.rows[0]?.visibility, total: cNew.rows[0]?.metadata.total_cents },
      { label: "Large Donation", icon: "💰", vis: "primary", total: 6_000_000 },
    );

    // (d) left.
    assert.equal(await row(c, dId), null, "(d) a donor with no donation rows kept its size tag");

    // (e) new, with the major-tier payload.
    const eNew = await c.query<{ tag: string; display_label: string; display_icon: string | null; visibility: string; generated_by: string; metadata: { total_cents: number } }>(
      `SELECT tag, display_label, display_icon, visibility, generated_by, metadata FROM public.entity_tags
        WHERE entity_type='financial_entity' AND entity_id=$1 AND tag_category='size'`,
      [E.e],
    );
    assert.equal(eNew.rows.length, 1, "(e) the new donor was not tagged");
    assert.deepEqual(
      { tag: eNew.rows[0]?.tag, label: eNew.rows[0]?.display_label, icon: eNew.rows[0]?.display_icon, vis: eNew.rows[0]?.visibility, by: eNew.rows[0]?.generated_by, total: eNew.rows[0]?.metadata.total_cents },
      { tag: "major_donation", label: "Major Donation", icon: "💰💰", vis: "primary", by: "rule", total: 60_000_000 },
    );

    // (f) the foreign-category row is untouched.
    assert.equal((await row(c, fId))?.ctid, before.f?.ctid, "(f) the merge touched a category it does not own");

    // (g) the manual row is untouched, and no rule row was squeezed in beside it.
    const g = await row(c, gId);
    assert.equal(g?.ctid, before.g?.ctid, "(g) the DO UPDATE overwrote a non-rule row");
    assert.equal(g?.metadata.total_cents, 1);

    // ── the second pass moves nothing ───────────────────────────────────────
    const p2 = await merge(c);
    assert.equal(p2.desired, p1.desired, "a second pass changed |desired|");
    assert.equal(p2.deleted, 0n, "a second pass deleted rows — the DELETE is not idempotent");
    assert.equal(p2.inserted, 0n, "a second pass inserted rows — the anti-join is not idempotent");
    assert.equal(p2.updated, 0n, "a second pass updated rows — the DO UPDATE's WHERE is not idempotent");

    console.info(
      `[fix1248] merge: before=${catBefore} desired=${p1.desired} deleted=${p1.deleted} inserted=${p1.inserted} ` +
        `updated=${p1.updated} blocked=${exp.blocked} after=${catAfter} | pass2 ${p2.deleted}/${p2.inserted}/${p2.updated} ` +
        `wall=${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    await c.end().catch(() => {});
  }
});

test("FIX-1248: both delete guards RAISE — a truncated scan, and a delete past 10 %", async (t) => {
  const c = await connect(t);
  if (!c) return;

  const t0 = Date.now();
  try {
    await c.query("BEGIN");
    const cur = await scalar(c, CAT_COUNT);
    assert.ok(cur > 0n, "the guards need a populated category to guard");
    await scalar(c, "SELECT public.rebuild_financial_entity_size_tags_scan()::bigint AS n");

    // Truncated scan: keep 20 % of the desired set, which is under half the
    // current category even on a clone whose desired set has outgrown it.
    await c.query("SAVEPOINT shrink");
    await c.query(`
      DELETE FROM pg_temp.fes_desired
       WHERE ctid IN (SELECT ctid FROM pg_temp.fes_desired
                       LIMIT (SELECT (count(*) * 8 / 10) FROM pg_temp.fes_desired))`);
    const kept = await scalar(c, "SELECT count(*)::bigint AS n FROM pg_temp.fes_desired");
    assert.ok(kept * 2n < cur, `fixture precondition: ${kept} kept must be under half of ${cur}`);
    await assert.rejects(
      () => c.query("SELECT public.rebuild_financial_entity_size_tags_delete()"),
      /refusing a shrink past 50/,
      "a truncated scan must RAISE, not delete the category",
    );
    await c.query("ROLLBACK TO SAVEPOINT shrink");

    // Same size, but 15 % of the desired keys no longer match the current tag:
    // the shrink guard passes and the 10 % guard must fire.
    await c.query("SAVEPOINT tenpct");
    await c.query(`
      UPDATE pg_temp.fes_desired SET tag = 'cc179_bogus_tier'
       WHERE ctid IN (SELECT ctid FROM pg_temp.fes_desired
                       LIMIT (SELECT (count(*) * 15 / 100) FROM pg_temp.fes_desired))`);
    await assert.rejects(
      () => c.query("SELECT public.rebuild_financial_entity_size_tags_delete()"),
      /refusing a delete past 10/,
      "a delete of more than 10 % of the category must RAISE",
    );
    await c.query("ROLLBACK TO SAVEPOINT tenpct");

    // And the category is exactly what it was: a guard rolls back, it does not half-delete.
    assert.equal(await scalar(c, CAT_COUNT), cur, "a guard left the category changed");

    console.info(`[fix1248] guards: current=${cur} wall=${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    await c.end().catch(() => {});
  }
});

test("FIX-1248: _delete without a desired set errors loudly rather than deleting the category", async (t) => {
  const c = await connect(t);
  if (!c) return;
  try {
    // A fresh transaction, so pg_temp.fes_desired does not exist. Out of order
    // must be a 42P01 naming the table, never a v_des = 0 that deletes everything.
    await c.query("BEGIN");
    await assert.rejects(
      () => c.query("SELECT public.rebuild_financial_entity_size_tags_delete()"),
      /fes_desired/,
      "an out-of-order call must name the missing temp table",
    );
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    await c.end().catch(() => {});
  }
});
