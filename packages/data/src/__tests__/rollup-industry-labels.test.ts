/**
 * FIX-1240 — the two donor rollups' industry labels follow a tag change.
 *
 * Runs via:  tsx --test src/__tests__/rollup-industry-labels.test.ts
 *
 * TWO HALVES, the FIX-1212 shape.
 *
 * (v) Source anchors against the shipped migration TEXT — no database, so they
 *     run in CI. The redefinition of refresh_sector_affinity_from_tag_changes()
 *     is +N/-0 against the body it replaces (rule 34: built on the prod body,
 *     byte-equal to 20260927020000_fix918:2461-2739 on 2026-10-03), carries no
 *     SET clause (it COMMITs — FIX-1128), and places the Path 3 hook after the
 *     chunk loop and BEFORE the shadow gate, guarded on v_n_donors, with
 *     query_canceled named before OTHERS (FIX-1028).
 *
 * (i)-(ii) Behavioural, against the local prod-clone. (i) is the function alone
 *     in a rolled-back transaction. (ii) is the real procedure, which COMMITs,
 *     so it changes one donor's tags, CALLs, reads, and the `finally` puts the
 *     tags back and CALLs again so the shadow ends where it started. DOUBLY
 *     gated: skips when the local DB is unreachable, and requires
 *     CIVITICS_DB_HEAVY_TESTS=1 (four CALLs of the nightly procedure).
 *
 * (ii) is the wrong-but-green test (rule 105): against the pre-FIX-1240 body
 *     the CALL completes, the stamp reads complete, and the donor's rows in
 *     both tables still carry the OLD label — the assertions below are what go
 *     red.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

// `__dirname`, not `import.meta.dirname`: tsx transforms this file to CJS.
const MIGRATIONS = path.join(__dirname, "..", "..", "..", "..", "supabase", "migrations");
const MIGRATION = path.join(MIGRATIONS, "20261003010000_fix1240_rollup_industry_labels_follow_tags.sql");
const PRIOR = path.join(MIGRATIONS, "20260927020000_fix918_primary_industry_tag.sql");

const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const HEAVY = process.env["CIVITICS_DB_HEAVY_TESTS"] === "1";

const PROC_SIG = "CREATE OR REPLACE PROCEDURE public.refresh_sector_affinity_from_tag_changes()";
const FN_SIG = "CREATE OR REPLACE FUNCTION public.sync_rollup_industry_labels(p_donors uuid[])";

/** The whole CREATE ... $procedure$; statement for the sector-affinity refresh. */
function procedure(src: string): string {
  const i = src.lastIndexOf(PROC_SIG);
  assert.notEqual(i, -1, "procedure not found");
  const rest = src.slice(i);
  const end = rest.indexOf("$procedure$;");
  assert.notEqual(end, -1, "no closing $procedure$;");
  return rest.slice(0, end + "$procedure$;".length);
}

function fn(src: string): string {
  const i = src.indexOf(FN_SIG);
  assert.notEqual(i, -1, "sync_rollup_industry_labels not found in the migration");
  const rest = src.slice(i);
  const end = rest.indexOf("$function$;");
  return rest.slice(0, end + "$function$;".length);
}

const SRC = fs.readFileSync(MIGRATION, "utf8");
const NEW = procedure(SRC);
const OLD = procedure(fs.readFileSync(PRIOR, "utf8"));

// ---------------------------------------------------------------------------
// (v) source anchors
// ---------------------------------------------------------------------------

test("(v) the redefinition is +N/-0 against the body it replaces (rule 34)", () => {
  // Every line of the prior body appears, in order, in the new one: nothing was
  // edited or dropped, only added. A subsequence check, not a diff library.
  const oldLines = OLD.split(/\r?\n/);
  const newLines = NEW.split(/\r?\n/);
  let j = 0;
  for (const line of oldLines) {
    while (j < newLines.length && newLines[j] !== line) j++;
    assert.ok(j < newLines.length, `prior line missing or reordered: ${JSON.stringify(line)}`);
    j++;
  }
  assert.ok(newLines.length > oldLines.length, "the hook added no lines");
});

test("(v) the procedure carries no SET clause and keeps its SET work_mem statement", () => {
  const header = NEW.slice(0, NEW.indexOf("AS $procedure$"));
  assert.doesNotMatch(header, /\bSET\b/, "a SET clause makes the procedure atomic; its COMMITs would fail");
  assert.match(NEW, /^ {2}SET work_mem = '128MB';$/m);
  assert.match(NEW, /pg_try_advisory_lock\(c_lock_key\)/);
  assert.match(NEW, /prod_session_state\(\)->>'defer'/);
});

test("(v) Path 3 syncs the changed donors after the chunk loop and before the shadow gate", () => {
  const loopEnd = NEW.indexOf("  END LOOP;");
  const hook = NEW.indexOf("sync_rollup_industry_labels(v_donors)");
  const gate = NEW.indexOf("IF v_canceled IS NULL AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN");
  assert.ok(loopEnd > 0 && hook > 0 && gate > 0);
  assert.ok(loopEnd < hook && hook < gate, "the hook must sit between the chunk loop and the shadow gate");

  const block = NEW.slice(loopEnd, gate);
  // v_donors is NULL when nothing changed, and NULL means "every row" to the sync.
  assert.match(block, /IF v_canceled IS NULL AND v_n_donors > 0 THEN/);
  const canceled = block.indexOf("WHEN query_canceled THEN");
  const others = block.indexOf("WHEN OTHERS THEN");
  assert.ok(canceled > 0 && others > canceled, "query_canceled must be named before OTHERS (FIX-1028)");
  assert.match(block.slice(canceled, others), /v_canceled := /);
  assert.match(block.slice(others), /v_failures := v_failures \|\| /);
});

test("(v) Path 2 syncs every row after the backfill and before the shadow is seeded", () => {
  const backfill = NEW.indexOf("CALL public.backfill_official_sector_affinity_rollup();");
  const sync = NEW.indexOf("sync_rollup_industry_labels(NULL)");
  const seed = NEW.indexOf("DELETE FROM public.donor_industry_tag_state;");
  assert.ok(backfill > 0 && sync > backfill && seed > sync);
});

test("(v) both stamps carry rollup_labels_updated", () => {
  assert.equal((NEW.match(/'rollup_labels_updated', v_labels/g) ?? []).length, 2);
});

test("(v) the sync function: definer, pinned search_path, no timeout, cron/service grants only", () => {
  const f = fn(SRC);
  const header = f.slice(0, f.indexOf("AS $function$"));
  assert.match(header, /SECURITY DEFINER/);
  assert.match(header, /SET search_path = public/);
  assert.doesNotMatch(header, /statement_timeout/);
  assert.match(SRC, /REVOKE ALL ON FUNCTION public\.sync_rollup_industry_labels\(uuid\[\]\) FROM PUBLIC, anon, authenticated;/);
  assert.match(SRC, /GRANT EXECUTE ON FUNCTION public\.sync_rollup_industry_labels\(uuid\[\]\) TO service_role;/);
  // Both arms touch only what differs, and only donor rows (201 is the tail).
  assert.equal((f.match(/IS DISTINCT FROM \((?:pit|x)\.tag, (?:pit|x)\.display_label\)/g) ?? []).length, 4);
  assert.equal((f.match(/rank <= 200/g) ?? []).length, 2);
  // Only the two label columns are ever SET.
  for (const m of f.matchAll(/SET ([^\n]+)\n\s+FROM x/g)) {
    assert.equal(m[1]!.trim(), "industry_tag = x.tag, industry_label = x.display_label");
  }
});

// ---------------------------------------------------------------------------
// (i)-(ii) behavioural, local clone
// ---------------------------------------------------------------------------

async function connect(t: { skip: (m: string) => void }): Promise<Client | null> {
  if (!HEAVY) {
    t.skip("set CIVITICS_DB_HEAVY_TESTS=1 to run against the local clone");
    return null;
  }
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 3000 });
  try {
    await c.connect();
  } catch {
    t.skip("local Docker Postgres not reachable");
    return null;
  }
  return c;
}

type Row = { tag: string | null; label: string | null; rank: number; total: string; tx: string };

async function rows(c: Client, donor: string): Promise<{ odr: Row[]; dpr: Row[] }> {
  const odr = await c.query<Row>(
    `SELECT industry_tag AS tag, industry_label AS label, rank, total_cents::text AS total, tx_count::text AS tx
       FROM public.official_donor_rollup_mv
      WHERE donor_id = $1 AND rank <= 200
      ORDER BY official_id, relationship_type, rank`,
    [donor],
  );
  const dpr = await c.query<Row>(
    `SELECT industry_tag AS tag, industry_label AS label, 0 AS rank, total_cents::text AS total, tx_count::text AS tx
       FROM public.donor_party_rollup_mv WHERE donor_id = $1 ORDER BY party_key`,
    [donor],
  );
  return { odr: odr.rows, dpr: dpr.rows };
}

async function pick(c: Client, donor: string): Promise<{ tag: string | null; label: string | null }> {
  const r = await c.query<{ tag: string; display_label: string }>(
    `SELECT tag, display_label FROM public.primary_industry_tag(ARRAY[$1::uuid])`,
    [donor],
  );
  return { tag: r.rows[0]?.tag ?? null, label: r.rows[0]?.display_label ?? null };
}

/** A one-tag donor with rows in BOTH tables, and an industry it does not have. */
async function fixtureDonor(c: Client): Promise<{ donor: string; other: { tag: string; label: string; icon: string | null } }> {
  const d = await c.query<{ donor_id: string; tag: string }>(
    `WITH o AS (SELECT DISTINCT donor_id FROM public.official_donor_rollup_mv
                 WHERE rank <= 200 AND donor_id IS NOT NULL)
     SELECT s.donor_id, et.tag
       FROM public.donor_industry_tag_state s
       JOIN o ON o.donor_id = s.donor_id
       JOIN public.entity_tags et ON et.entity_id = s.donor_id
            AND et.entity_type = 'financial_entity' AND et.tag_category = 'industry'
            AND et.generated_by <> 'curated'
      WHERE s.tag_count = 1
        AND EXISTS (SELECT 1 FROM public.donor_party_rollup_mv p WHERE p.donor_id = s.donor_id)
      ORDER BY s.donor_id
      LIMIT 1`,
  );
  assert.equal(d.rows.length, 1, "no fixture donor on the clone");
  const { donor_id, tag } = d.rows[0]!;
  const o = await c.query<{ tag: string; display_label: string; display_icon: string | null }>(
    `SELECT tag, display_label, display_icon FROM public.entity_tags
      WHERE entity_type = 'financial_entity' AND tag_category = 'industry' AND tag <> $1
      GROUP BY tag, display_label, display_icon ORDER BY count(*) DESC LIMIT 1`,
    [tag],
  );
  const x = o.rows[0]!;
  return { donor: donor_id, other: { tag: x.tag, label: x.display_label, icon: x.display_icon } };
}

function assertLabels(r: { odr: Row[]; dpr: Row[] }, want: { tag: string | null; label: string | null }, what: string) {
  for (const [name, set] of [["official_donor_rollup_mv", r.odr], ["donor_party_rollup_mv", r.dpr]] as const) {
    for (const row of set) {
      assert.equal(row.tag, want.tag, `${what}: ${name}.industry_tag`);
      assert.equal(row.label, want.label, `${what}: ${name}.industry_label`);
    }
  }
}

function assertMoneyUnchanged(before: { odr: Row[]; dpr: Row[] }, after: { odr: Row[]; dpr: Row[] }) {
  const strip = (x: Row[]) => x.map((r) => `${r.rank}|${r.total}|${r.tx}`);
  assert.deepEqual(strip(after.odr), strip(before.odr), "rank / total_cents / tx_count moved in official_donor_rollup_mv");
  assert.deepEqual(strip(after.dpr), strip(before.dpr), "total_cents / tx_count moved in donor_party_rollup_mv");
}

test("(i) the function relabels a donor in both tables, clears a de-tagged one, touches nothing else", async (t) => {
  const c = await connect(t);
  if (!c) return;
  try {
    await c.query("BEGIN");
    const { donor } = await fixtureDonor(c);
    const counts = async () =>
      (await c.query<{ o: string; d: string }>(
        `SELECT (SELECT count(*) FROM public.official_donor_rollup_mv)::text o,
                (SELECT count(*) FROM public.donor_party_rollup_mv)::text d`,
      )).rows[0]!;
    const n0 = await counts();
    const before = await rows(c, donor);
    console.info(`    fixture donor ${donor}: ${before.odr.length} odr rows, ${before.dpr.length} dpr rows`);

    // Stale both tables' labels, as a tag change the owners never saw would.
    await c.query(`UPDATE public.official_donor_rollup_mv SET industry_tag = 'zz_stale', industry_label = 'Stale'
                    WHERE donor_id = $1 AND rank <= 200`, [donor]);
    await c.query(`UPDATE public.donor_party_rollup_mv SET industry_tag = 'zz_stale', industry_label = 'Stale'
                    WHERE donor_id = $1`, [donor]);

    const r1 = await c.query<{ table_name: string; rows_updated: string }>(
      `SELECT table_name, rows_updated::text FROM public.sync_rollup_industry_labels(ARRAY[$1::uuid])`, [donor]);
    const got = Object.fromEntries(r1.rows.map((r) => [r.table_name, Number(r.rows_updated)]));
    assert.equal(got["official_donor_rollup_mv"], before.odr.length);
    assert.equal(got["donor_party_rollup_mv"], before.dpr.length);
    const after = await rows(c, donor);
    assertLabels(after, await pick(c, donor), "relabelled");
    assertMoneyUnchanged(before, after);

    // Idempotent: a second call updates nothing.
    const r2 = await c.query<{ rows_updated: string }>(
      `SELECT rows_updated::text FROM public.sync_rollup_industry_labels(ARRAY[$1::uuid])`, [donor]);
    assert.deepEqual(r2.rows.map((r) => Number(r.rows_updated)), [0, 0]);

    // A donor whose every industry tag is removed reads NULL labels.
    await c.query(`DELETE FROM public.entity_tags WHERE entity_type = 'financial_entity'
                    AND tag_category = 'industry' AND entity_id = $1`, [donor]);
    await c.query(`SELECT * FROM public.sync_rollup_industry_labels(ARRAY[$1::uuid])`, [donor]);
    assertLabels(await rows(c, donor), { tag: null, label: null }, "de-tagged");

    // rule 116: the hook never adds or removes a row.
    assert.deepEqual(await counts(), n0, "row counts moved");
  } finally {
    await c.query("ROLLBACK");
    await c.end();
  }
});

test("(ii) Path 3 of the real procedure carries a re-pick and a de-tag into both tables", async (t) => {
  const c = await connect(t);
  if (!c) return;

  const call = async (what: string) => {
    await c.query("CALL public.refresh_sector_affinity_from_tag_changes()");
    const s = await c.query<{ status: string; path: string; labels: Record<string, number> | null }>(
      `SELECT status, metadata->>'path' AS path, metadata->'rollup_labels_updated' AS labels
         FROM public.data_sync_log WHERE pipeline = 'sector_affinity_tag_refresh'
        ORDER BY started_at DESC LIMIT 1`,
    );
    const row = s.rows[0]!;
    console.info(`    ${what}: ${row.status} ${row.path} rollup_labels_updated=${JSON.stringify(row.labels)}`);
    return row;
  };

  const { donor, other } = await fixtureDonor(c);
  const saved = await c.query(
    `SELECT * FROM public.entity_tags WHERE entity_type = 'financial_entity'
      AND tag_category = 'industry' AND entity_id = $1`, [donor]);
  const original = await pick(c, donor);
  const before = await rows(c, donor);
  console.info(`    fixture donor ${donor}: ${original.tag} -> ${other.tag}`);
  let inserted: string | null = null;
  try {
    // A curated row outranks any rule or ai row: the pick moves to `other`.
    const ins = await c.query<{ id: string }>(
      `INSERT INTO public.entity_tags (entity_type, entity_id, tag, tag_category, display_label, display_icon,
                                       generated_by, confidence, pipeline_version)
       VALUES ('financial_entity', $1, $2, 'industry', $3, $4, 'curated', 1.0, 'fix1240-test')
       RETURNING id`,
      [donor, other.tag, other.label, other.icon],
    );
    inserted = ins.rows[0]!.id;

    const s1 = await call("re-pick");
    assert.equal(s1.status, "complete");
    assert.equal(s1.path, "targeted");
    // The wrong-but-green line: the pre-FIX-1240 body gets this far, complete.
    const repicked = await rows(c, donor);
    assertLabels(repicked, { tag: other.tag, label: other.label }, "after the re-pick");
    assertMoneyUnchanged(before, repicked);
    assert.ok(s1.labels, "the stamp must carry rollup_labels_updated");

    // De-tag: every industry row gone -> NULL labels in both tables.
    await c.query(`DELETE FROM public.entity_tags WHERE entity_type = 'financial_entity'
                    AND tag_category = 'industry' AND entity_id = $1`, [donor]);
    inserted = null;
    await call("de-tag");
    assertLabels(await rows(c, donor), { tag: null, label: null }, "after the de-tag");
  } finally {
    if (inserted) await c.query(`DELETE FROM public.entity_tags WHERE id = $1`, [inserted]);
    // Put the donor's own rows back exactly, ids and all.
    for (const r of saved.rows as Record<string, unknown>[]) {
      const cols = Object.keys(r);
      await c.query(
        `INSERT INTO public.entity_tags (${cols.join(", ")})
         VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})
         ON CONFLICT (id) DO NOTHING`,
        cols.map((k) => r[k]),
      );
    }
    await call("restore");
    await c.end();
  }
  // Read on a fresh connection: the restore CALL must have put the labels back.
  const c2 = new Client({ connectionString: LOCAL_DSN });
  await c2.connect();
  try {
    assertLabels(await rows(c2, donor), original, "after the restore");
  } finally {
    await c2.end();
  }
});
