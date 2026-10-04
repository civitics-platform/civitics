/**
 * FIX-1177 + FIX-1172 — check_rollup_freshness() honours a FIX-950 hold and
 * restarts its clock at a deliberate stand-down.
 *
 * Runs via:  tsx --test src/__tests__/rollup-freshness-holds.test.ts
 *
 * Source anchors (no DB, run in CI): the latest migration defining the
 * function reads rollup_watch_overrides, keys the held skip on the FIX-950
 * prefix, carries status / hours_since_data, and keeps LANGUAGE sql STABLE
 * with search_path as its only SET.
 *
 * Behavioural, against the local clone, inside BEGIN … ROLLBACK: synthetic
 * data_sync_log + rollup_watch_overrides rows under pipeline names no real job
 * uses. The PRE-FIX body (20260903060000_fix973b) is loaded into pg_temp beside
 * the live one and asserted on the same fixtures — rule 105: the fixtures must
 * read RED on the old body, or they prove nothing. Skips when the DB is
 * unreachable or unmigrated.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "..", "..", "supabase", "migrations");
const DEFINES = "CREATE OR REPLACE FUNCTION public.check_rollup_freshness(";
const OLD_MIGRATION = path.join(MIGRATIONS_DIR, "20260903060000_fix973b_freshness_reads_its_own_pipeline.sql");
const MIGRATION = path.join(
  MIGRATIONS_DIR,
  fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8").includes(DEFINES))
    .pop()!,
);
const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

function createStatement(file: string): string {
  const src = fs.readFileSync(file, "utf8");
  const i = src.indexOf(DEFINES);
  const end = src.indexOf("$function$;", src.indexOf("AS $function$", i)) + "$function$;".length;
  return src.slice(i, end);
}

test("FIX-1177/1172: the latest body reads the hold and the held skip; sql STABLE, one SET", () => {
  const f = createStatement(MIGRATION);
  const header = f.slice(0, f.indexOf("AS $function$"));
  assert.match(header, /LANGUAGE sql\s+STABLE/);
  assert.doesNotMatch(header, /SECURITY DEFINER/);
  assert.equal((header.match(/\bSET\s+\w+/g) ?? []).length, 1, "exactly one SET clause");
  assert.match(header, /SET search_path TO 'public'/);
  assert.match(f, /FROM public\.rollup_watch_overrides\s+WHERE pipeline = p_pipeline/);
  assert.match(f, /l\.metadata->>'skip_reason' LIKE 'prod session held: %'/);
  assert.match(f, /AND l\.started_at > g\.completed_at/, "a skip older than the last complete changes nothing");
  for (const key of ["'status'", "'hold_reason'", "'held_since'", "'hours_since_data'", "'last_held_skip_at'"]) {
    assert.ok(f.includes(key), `emits ${key}`);
  }
  // The batch is not redefined by the FIX-1177 migration — it passes through.
  assert.ok(!fs.readFileSync(MIGRATION, "utf8").includes("CREATE OR REPLACE FUNCTION public.check_rollup_freshness_batch("));
});

type Fresh = {
  stale: boolean;
  status?: string;
  hours_since_complete: number | null;
  hours_since_data?: number | null;
  last_held_skip_at?: string | null;
  hold_reason?: string | null;
};

test("FIX-1177/1172: holds and held skips on the clone (rolled back); the old body reads red", async (t) => {
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  try {
    await c.connect();
  } catch {
    t.skip("local Docker DB unreachable");
    return;
  }
  try {
    const fn = await c.query(
      "SELECT prosrc FROM pg_proc WHERE proname = 'check_rollup_freshness' AND pronamespace = 'public'::regnamespace",
    );
    if (fn.rowCount === 0 || !String(fn.rows[0].prosrc).includes("hours_since_data")) {
      t.skip("check_rollup_freshness() without FIX-1177 on this DB");
      return;
    }
    await c.query("BEGIN");
    await c.query(createStatement(OLD_MIGRATION).replace(DEFINES, "CREATE FUNCTION pg_temp.old_check_rollup_freshness("));

    const P = "fix1177_test";
    const row = (pipeline: string, status: string, agoMin: number, skipReason?: string) =>
      c.query(
        `INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
         VALUES ($1, $2, now() - make_interval(mins => $3), now() - make_interval(mins => $3),
                 CASE WHEN $4::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('skip_reason', $4::text) END)`,
        [pipeline, status, agoMin, skipReason ?? null],
      );
    const fresh = async (pipeline: string, maxH = 1): Promise<Fresh> =>
      (await c.query<{ f: Fresh }>("SELECT public.check_rollup_freshness($1, $2) AS f", [pipeline, maxH])).rows[0]!.f;
    const old = async (pipeline: string, maxH = 1): Promise<Fresh> =>
      (await c.query<{ f: Fresh }>("SELECT pg_temp.old_check_rollup_freshness($1, $2) AS f", [pipeline, maxH])).rows[0]!.f;

    // (1) A complete 3 h ago, cadence threshold 1 h: stale on both bodies.
    await row(`${P}_a`, "complete", 180);
    let f = await fresh(`${P}_a`);
    assert.equal(f.stale, true);
    assert.equal(f.status, "stale");
    assert.equal(f.last_held_skip_at, null);

    // (2) FIX-1172 — a held skip 10 min ago restarts the clock; the data age stays.
    await row(`${P}_a`, "skipped", 10, "prod session held: fix1177 test session");
    f = await fresh(`${P}_a`);
    assert.equal(f.stale, false, "a deliberate stand-down 10 min ago is not stale");
    assert.equal(f.status, "fresh");
    assert.ok(Number(f.hours_since_complete) < 0.2, `clock from the skip, got ${f.hours_since_complete}`);
    assert.ok(Number(f.hours_since_data) > 2.9, `data age kept, got ${f.hours_since_data}`);
    assert.ok(f.last_held_skip_at);
    const o2 = await old(`${P}_a`);
    assert.equal(o2.stale, true, "rule 105 red: the OLD body reads the post-release pipeline stale");
    assert.ok(Number(o2.hours_since_complete) > 2.9);

    // (3) A held skip OLDER than the last complete changes nothing.
    await row(`${P}_b`, "skipped", 300, "prod session held: older than the complete");
    await row(`${P}_b`, "complete", 180);
    f = await fresh(`${P}_b`);
    assert.equal(f.stale, true);
    assert.equal(f.last_held_skip_at, null);
    assert.ok(Number(f.hours_since_complete) > 2.9);

    // (4) A skip for any OTHER reason is not a stand-down.
    await row(`${P}_c`, "complete", 180);
    await row(`${P}_c`, "skipped", 10, "advisory lock held");
    f = await fresh(`${P}_c`);
    assert.equal(f.stale, true, "lock contention is not a deliberate stand-down");

    // (5) No complete at all: a held skip does not invent one.
    await row(`${P}_d`, "skipped", 10, "prod session held: never completed");
    f = await fresh(`${P}_d`);
    assert.equal(f.stale, true);
    assert.equal(f.status, "missing");
    assert.equal(f.hours_since_complete, null);

    // (6) FIX-1177 — a held pipeline (the claim's upsert shape) is 'held', never stale.
    await row(`${P}_e`, "complete", 600);
    await c.query(
      `INSERT INTO public.rollup_watch_overrides (pipeline, held_since, hold_reason, note)
       VALUES ($1, now() - interval '50 minutes', 'prod session held: fix1177 test session', 'test')`,
      [`${P}_e`],
    );
    f = await fresh(`${P}_e`);
    assert.equal(f.stale, false);
    assert.equal(f.status, "held");
    assert.equal(f.hold_reason, "prod session held: fix1177 test session");
    assert.ok(Number(f.hours_since_data) > 9.9, "the hold hides nothing: data age still reported");
    assert.equal((await old(`${P}_e`)).stale, true, "rule 105 red: the OLD body reads a held pipeline stale");

    // (7) A retired pipeline is 'retired', never stale.
    await row(`${P}_f`, "complete", 6000);
    await c.query(
      `INSERT INTO public.rollup_watch_overrides (pipeline, retired_at, note) VALUES ($1, now() - interval '1 day', 'test')`,
      [`${P}_f`],
    );
    f = await fresh(`${P}_f`);
    assert.equal(f.stale, false);
    assert.equal(f.status, "retired");

    // (8) The batch passes the new keys through, element for element.
    const items = ["a", "b", "c", "d", "e", "f"].map((s) => ({ pipeline: `${P}_${s}`, cadence_hours: 1 }));
    const batch = (await c.query<{ b: Fresh[] }>("SELECT public.check_rollup_freshness_batch($1::jsonb) AS b", [
      JSON.stringify(items),
    ])).rows[0]!.b;
    assert.deepEqual(
      batch.map((e) => e.status),
      ["fresh", "stale", "stale", "missing", "held", "retired"],
    );
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    await c.end();
  }
});
