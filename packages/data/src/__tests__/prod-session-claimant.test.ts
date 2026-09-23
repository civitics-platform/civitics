/**
 * FIX-1213 — prod_session_state() honours a claimant GUC.
 *
 * Runs via:  tsx --test src/__tests__/prod-session-claimant.test.ts
 *
 * TWO HALVES, for the FIX-407 reason (the donor-party-full-rebuild shape).
 *
 * Source anchors against the shipped migration TEXT — no database, so they run
 * in CI: `defer` carries `v_claimant IS NULL`, `held` is the bare lock, the
 * search_path SET clause is restated (rule 34), and the bypass branch comes
 * FIRST in reason_text.
 *
 * Behavioural, against the real reader and a real guarded procedure on the
 * local prod-clone, with three connections:
 *   A — holds pg_advisory_lock(hashtext('prod_supervised_session')), the claim.
 *   B — the CALLer.
 *   C — a bystander (what every pg_cron firing looks like).
 * (i)   B CALLs without the GUC → `skipped`, skip_reason 'prod session held:…'
 *       — the FIX-1213 defect, reproduced (cc-146 §4).
 * (ii)  B SETs the GUC, then CALLs → the terminal row is NOT skipped; from B the
 *       reader says held=true defer=false claimant_bypass=true; from C it still
 *       says defer=true claimant=null.
 * (iii) the GUC set with NO lock → defer=false, claimant_bypass=false.
 * The procedure is refresh_donor_party_rollup_incremental(), with its watermark
 * pinned to max(financial_relationships.updated_at) for the duration so the
 * un-deferred CALL is a caught-up crawl (seconds) rather than the clone's
 * 14-day-lag full rebuild — and restored exactly in `finally`.
 * DOUBLY gated like its sibling: skips when the local DB is unreachable, and
 * requires CIVITICS_DB_HEAVY_TESTS=1.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

// `__dirname`, not `import.meta.dirname`: tsx transforms this file to CJS.
const MIGRATION = path.join(
  __dirname, "..", "..", "..", "..",
  "supabase", "migrations", "20260920110000_fix1213_prod_session_claimant_opt_in.sql",
);

const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const HEAVY = process.env["CIVITICS_DB_HEAVY_TESTS"] === "1";

const SIG = "CREATE OR REPLACE FUNCTION public.prod_session_state()";
const GUC = "civitics.prod_session_claimant";

/** The text between the CREATE line and `AS $function$`. */
function header(src: string): string {
  const i = src.indexOf(SIG);
  assert.notEqual(i, -1, "function not found in the migration");
  const rest = src.slice(i);
  const end = rest.indexOf("AS $function$");
  assert.notEqual(end, -1, "no AS $function$");
  return rest.slice(0, end);
}

/** The function body with `--` comments removed, so prose cannot satisfy an anchor. */
function code(src: string): string {
  const i = src.indexOf(SIG);
  const m = src.slice(i).match(/AS \$function\$([\s\S]*?)\$function\$/);
  assert.ok(m, "no dollar-quoted body");
  return (m[1] as string).split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
}

// ---------------------------------------------------------------------------
// Source anchors — no database.
// ---------------------------------------------------------------------------

test("FIX-1213: defer = held AND the claimant GUC is unset", () => {
  const b = code(fs.readFileSync(MIGRATION, "utf8"));
  assert.match(b, /'defer',\s+v_held AND v_claimant IS NULL,/);
  assert.match(b, /v_claimant := NULLIF\(current_setting\('civitics\.prod_session_claimant', true\), ''\);/);
});

test("FIX-1213: held is still the bare lock — the claim preflight must keep refusing a second claim", () => {
  const b = code(fs.readFileSync(MIGRATION, "utf8"));
  assert.match(b, /'held',\s+v_held,/);
});

test("FIX-1213: the new keys and the bypass branch, first in reason_text", () => {
  const b = code(fs.readFileSync(MIGRATION, "utf8"));
  assert.match(b, /'claimant',\s+v_claimant,/);
  assert.match(b, /'claimant_bypass',\s+v_held AND v_claimant IS NOT NULL,/);
  const rt = b.slice(b.indexOf("'reason_text'"));
  const bypass = rt.indexOf("WHEN v_held AND v_claimant IS NOT NULL");
  const held = rt.indexOf("WHEN v_held AND v_label IS NOT NULL");
  assert.ok(bypass > -1 && held > -1 && bypass < held, "the bypass branch must come before the plain held branch");
  assert.match(rt, /'prod session held by this claimant: ' \|\| v_claimant/);
});

test("FIX-1213: the SET search_path clause is restated (rule 34) and nothing else is SET", () => {
  const h = header(fs.readFileSync(MIGRATION, "utf8"));
  assert.match(h, /SET search_path TO 'public', 'pg_catalog'/);
  assert.doesNotMatch(h, /statement_timeout/);
});

// ---------------------------------------------------------------------------
// Behavioural — skipped without a DB, and without CIVITICS_DB_HEAVY_TESTS=1.
// ---------------------------------------------------------------------------

type State = {
  held: boolean; defer: boolean; claimant: string | null; claimant_bypass: boolean; reason_text: string;
};

async function state(c: Client): Promise<State> {
  const r = await c.query<{ s: State }>("SELECT public.prod_session_state() AS s");
  return r.rows[0]!.s;
}

async function lastRow(c: Client, since: string) {
  const r = await c.query<{ status: string; skip_reason: string | null; mode: string | null; rows: number | null }>(
    `SELECT status, metadata->>'skip_reason' AS skip_reason, metadata->>'mode' AS mode,
            rows_inserted AS rows
       FROM public.data_sync_log
      WHERE pipeline = 'donor_party_rollup_refresh' AND started_at >= $1::timestamptz
      ORDER BY started_at DESC LIMIT 1`, [since]);
  return r.rows[0] ?? null;
}

test("FIX-1213 (i)-(iii): the claimant's own CALL runs; everyone else still defers",
  { timeout: 15 * 60 * 1000 },
  async (t) => {
    if (!HEAVY) {
      t.skip("CIVITICS_DB_HEAVY_TESTS=1 not set — CALLs a guarded procedure twice on the clone");
      return;
    }
    const a = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
    const b = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
    const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
    try {
      await a.connect(); await b.connect(); await c.connect();
    } catch {
      t.skip("local Docker DB unreachable — behavioural half skipped (source anchors above still ran)");
      return;
    }

    const orig = await a.query<{ value: unknown }>(
      "SELECT value FROM public.pipeline_state WHERE key = 'donor_party_rollup_watermark'");
    const origWatermark = orig.rows[0]?.value ?? null;
    const cursor = await a.query("SELECT 1 FROM public.pipeline_state WHERE key = 'donor_party_full_rebuild'");
    assert.equal(cursor.rowCount, 0, "a live full-rebuild cursor on the clone would be resumed, not tested");
    let locked = false;
    try {
      // A caught-up crawl, so the un-deferred CALL costs seconds.
      await a.query(`
        INSERT INTO public.pipeline_state (key, value)
        SELECT 'donor_party_rollup_watermark', jsonb_build_object('last_indexed_at', max(updated_at)::text)
          FROM public.financial_relationships
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = clock_timestamp()`);
      await b.query("SET max_parallel_workers_per_gather = 0"); // local /dev/shm is 64MB

      await a.query("SELECT pg_advisory_lock(hashtext('prod_supervised_session')::bigint)");
      locked = true;

      // (i) no GUC → the defect, reproduced.
      const t1 = (await b.query<{ t: string }>("SELECT clock_timestamp()::text AS t")).rows[0]!.t;
      await b.query("CALL public.refresh_donor_party_rollup_incremental()");
      const r1 = await lastRow(b, t1);
      console.log(`[fix1213 (i)] no GUC: status=${r1?.status} skip_reason=${r1?.skip_reason}`);
      assert.equal(r1?.status, "skipped");
      assert.match(r1?.skip_reason ?? "", /^prod session held:/);

      // (ii) the claimant opts in, as its own statement, in front of the CALL.
      await b.query(`SET ${GUC} = 'fix1213 heavy test'`);
      const sb = await state(b);
      const sc = await state(c);
      console.log(`[fix1213 (ii)] from B: ${JSON.stringify(sb)}`);
      console.log(`[fix1213 (ii)] from C: defer=${sc.defer} claimant=${sc.claimant}`);
      assert.equal(sb.held, true);
      assert.equal(sb.defer, false);
      assert.equal(sb.claimant, "fix1213 heavy test");
      assert.equal(sb.claimant_bypass, true);
      assert.equal(sb.reason_text, "prod session held by this claimant: fix1213 heavy test");
      assert.equal(sc.held, true);
      assert.equal(sc.defer, true, "a bystander must still defer");
      assert.equal(sc.claimant, null);
      assert.equal(sc.claimant_bypass, false);

      const t2 = (await b.query<{ t: string }>("SELECT clock_timestamp()::text AS t")).rows[0]!.t;
      await b.query("CALL public.refresh_donor_party_rollup_incremental()");
      const r2 = await lastRow(b, t2);
      console.log(`[fix1213 (ii)] with GUC: status=${r2?.status} mode=${r2?.mode} rows=${r2?.rows}`);
      assert.notEqual(r2?.status, "skipped", "the claimant's own CALL must run");
      assert.equal(r2?.status, "complete");
      assert.equal(r2?.mode, "crawl");

      // (iii) GUC set, no lock → nothing to bypass.
      await a.query("SELECT pg_advisory_unlock(hashtext('prod_supervised_session')::bigint)");
      locked = false;
      const s3 = await state(b);
      console.log(`[fix1213 (iii)] GUC, no lock: held=${s3.held} defer=${s3.defer} bypass=${s3.claimant_bypass}`);
      assert.equal(s3.held, false);
      assert.equal(s3.defer, false);
      assert.equal(s3.claimant_bypass, false);
      assert.equal(s3.reason_text, "clear");
    } finally {
      if (locked) await a.query("SELECT pg_advisory_unlock(hashtext('prod_supervised_session')::bigint)").catch(() => {});
      if (origWatermark === null) {
        await a.query("DELETE FROM public.pipeline_state WHERE key = 'donor_party_rollup_watermark'");
      } else {
        await a.query(
          `UPDATE public.pipeline_state SET value = $1::jsonb, updated_at = clock_timestamp()
            WHERE key = 'donor_party_rollup_watermark'`, [JSON.stringify(origWatermark)]);
      }
      await a.end(); await b.end(); await c.end();
    }
  });
