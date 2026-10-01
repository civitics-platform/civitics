/**
 * FIX-1248 — the weekly `size`-tag MERGE, behavioural proof.
 *
 * Runs via:  tsx --test src/pipelines/tags/size-tags-merge.test.ts
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
import { Client } from "pg";

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
