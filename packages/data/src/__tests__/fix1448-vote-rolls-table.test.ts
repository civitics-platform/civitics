/**
 * FIX-1448 (cc-331 D1) — `20261127000000_fix1448_vote_rolls.sql`: the
 * vote_rolls table, one row per federal roll.
 *
 * Runs via:  tsx --test src/__tests__/fix1448-vote-rolls-table.test.ts
 *
 * Text (no DB, run in CI): the table's columns are exactly the row
 * vote-roll-row.ts builds plus metadata / created_at / updated_at; RLS on with
 * one SELECT policy; the REVOKE names all four grantees and the GRANTs are
 * SELECT to anon and authenticated, SELECT / INSERT / UPDATE to service_role;
 * nothing written or dropped outside the read-back; the newest file at its
 * landing.
 * Clone (CIVITICS_CLONE_TESTS=1), inside BEGIN … ROLLBACK: the grants as
 * written; a row the parser built round-trips through the walker's insert form
 * (jsonb_populate_recordset) field for field; set_updated_at stamps an UPDATE.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { read, stripComments } from "./lib/migration-text";
import { parseSenateRoll } from "../pipelines/congress/votes";
import {
  detailUpsertRow,
  rollIdentity,
  seedRow,
  senateRollFields,
  FIELD_COLUMNS,
  IDENTITY_COLUMNS,
} from "../pipelines/congress/vote-roll-row";

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const FILE_NAME = "20261127000000_fix1448_vote_rolls.sql";
const FILE = () => read(path.join(MIGRATIONS, FILE_NAME));
const FIXTURE = path.join(__dirname, "..", "pipelines", "congress", "__fixtures__", "lis-senate-119-2-00243-cloture-three-fifths.xml");

function tableColumns(): string[] {
  const sql = stripComments(FILE());
  const m = /CREATE TABLE IF NOT EXISTS public\.vote_rolls \(([\s\S]*?)\n\);/.exec(sql);
  assert.ok(m, "the CREATE TABLE");
  return m[1]!.split("\n").map((l) => /^\s+([a-z_]+)\s/.exec(l)?.[1]).filter((c): c is string => !!c);
}

test("D1: the table's columns are the row the parser builds, plus metadata, created_at and updated_at", () => {
  const row = seedRow(rollIdentity("senate-119-2-00243")!);
  assert.deepEqual(tableColumns().sort(), [...Object.keys(row), "metadata", "created_at", "updated_at"].sort());
  for (const c of [...FIELD_COLUMNS, ...IDENTITY_COLUMNS]) assert.ok(tableColumns().includes(c), c);
  assert.match(FILE(), /IF v_cols IS DISTINCT FROM 29 THEN/);
  assert.equal(tableColumns().length, 29);
});

test("D1: RLS with one SELECT policy; SELECT to anon and authenticated, SELECT / INSERT / UPDATE to service_role, nothing else", () => {
  const sql = stripComments(FILE());
  assert.ok(sql.includes("ALTER TABLE public.vote_rolls ENABLE ROW LEVEL SECURITY;"));
  assert.ok(sql.includes("CREATE POLICY vote_rolls_select ON public.vote_rolls\n  FOR SELECT TO anon, authenticated USING (true);"));
  assert.equal(sql.match(/CREATE POLICY/g)?.length, 1);
  assert.ok(sql.includes("REVOKE ALL ON TABLE public.vote_rolls FROM PUBLIC, anon, authenticated, service_role;"));
  assert.deepEqual(sql.match(/GRANT [^;]+;/g), [
    "GRANT SELECT ON TABLE public.vote_rolls TO anon, authenticated;",
    "GRANT SELECT, INSERT, UPDATE ON TABLE public.vote_rolls TO service_role;",
  ]);
  assert.ok(sql.includes("FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();"));
});

test("nothing written or dropped outside the read-back; the read-back RAISEs on any miss and keeps the dispatcher pin", () => {
  const sql = stripComments(FILE());
  const outside = sql.replace(/DO \$\$[\s\S]*?END \$\$;/g, "");
  assert.doesNotMatch(outside, /\b(INSERT INTO|UPDATE public\.|DELETE FROM|DROP TABLE|TRUNCATE|ALTER TABLE public\.votes)\b/i);
  const readBack = sql.slice(sql.lastIndexOf("DO $$"));
  assert.ok(readBack.includes("RAISE EXCEPTION '[fix1448] read-back failed: %'"));
  assert.ok(readBack.includes("c_disp CONSTANT text := 'd0f5bf5b59120716ab15e73c805435d2';"));
});

test("the version is above 20261126008000, and it was the newest file at its landing", () => {
  const all = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f < "20261127001000").sort(); // cc-331's registry row lands after
  assert.equal(all[all.length - 1], FILE_NAME);
  assert.equal(all[all.length - 2], "20261126008000_fix1453_bill_details_registry_row.sql");
});

// ---------------------------------------------------------------------------
// Clone
// ---------------------------------------------------------------------------

async function inTx(t: { skip: (m: string) => void }, fn: (c: Client) => Promise<void>): Promise<void> {
  if (process.env["CIVITICS_CLONE_TESTS"] !== "1") {
    t.skip("set CIVITICS_CLONE_TESTS=1 to run against the migrated clone");
    return;
  }
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  await c.connect();
  try {
    if (!(await c.query("SELECT to_regclass('public.vote_rolls') AS r")).rows[0].r) {
      t.skip("20261127000000 is not applied on the clone");
      return;
    }
    await c.query("BEGIN");
    try {
      await fn(c);
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
}

test("clone: the grants as written", async (t) => {
  await inTx(t, async (c) => {
    const r = (await c.query(
      `SELECT g, p, has_table_privilege(g, 'public.vote_rolls', p) AS ok
         FROM unnest(ARRAY['anon','authenticated','service_role']) g
        CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p ORDER BY 1, 2`,
    )).rows.filter((x: { ok: boolean }) => x.ok).map((x: { g: string; p: string }) => `${x.g}:${x.p}`);
    assert.deepEqual(r, ["anon:SELECT", "authenticated:SELECT", "service_role:INSERT", "service_role:SELECT", "service_role:UPDATE"]);
  });
});

test("clone: a parsed roll round-trips through the walker's insert form field for field; set_updated_at stamps an UPDATE", async (t) => {
  await inTx(t, async (c) => {
    const id = { ...rollIdentity("senate-119-2-00243")!, roll_call_id: "senate-999-2-00243" };
    const row = detailUpsertRow(id, "lis_roll_xml", "2026-11-27T08:00:00.000Z", senateRollFields(parseSenateRoll(fs.readFileSync(FIXTURE, "utf8"))!));
    const cols = Object.keys(row);
    await c.query(
      `INSERT INTO public.vote_rolls (${cols.join(", ")})
       SELECT ${cols.join(", ")} FROM jsonb_populate_recordset(NULL::public.vote_rolls, $1::jsonb)`,
      [JSON.stringify([row])],
    );
    const back = (await c.query(
      `SELECT to_jsonb(v) - 'created_at' - 'updated_at' - 'metadata' - 'list_fetched_at' AS j, created_at = updated_at AS fresh
         FROM public.vote_rolls v WHERE roll_call_id = $1`, [id.roll_call_id],
    )).rows[0];
    const norm = (x: Record<string, unknown>) => ({
      ...x,
      voted_at: new Date(x["voted_at"] as string).toISOString(),
      detail_fetched_at: new Date(x["detail_fetched_at"] as string).toISOString(),
      source_modified_at: new Date(x["source_modified_at"] as string).toISOString(),
    });
    assert.deepEqual(norm(back.j), norm(row as unknown as Record<string, unknown>));
    assert.equal(back.fresh, true);
    // now() is the transaction's, so the trigger shows as overwriting a stale value.
    const stamped = (await c.query(
      `UPDATE public.vote_rolls SET list_fetched_at = clock_timestamp(), updated_at = '2000-01-01'
        WHERE roll_call_id = $1 RETURNING updated_at = now() AS stamped`, [id.roll_call_id],
    )).rows[0].stamped;
    assert.equal(stamped, true, "set_updated_at stamps the row");
  });
});
