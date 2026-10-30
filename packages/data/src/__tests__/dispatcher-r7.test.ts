/**
 * FIX-1365 — RETURN donor-party-rollup-refresh as `by 0 15 * * 2`, crawl-first
 * on the dial prod already carries (donor_party_crawl.full_rebuild_lag_days
 * 30, FIX-1249). cc-254, `*_fix1365_return_donor_party_rollup_refresh_crawl_first.sql`.
 *
 * Runs via:  tsx --test src/__tests__/dispatcher-r7.test.ts
 *
 * Text anchors (no DB, run in CI):
 *   - the file touches exactly the one registry row, by name, matched on the
 *     exact old text; the pick's `by` parse reads it as a weekly slot;
 *   - the dial and the cursor are ASSERTED, never written (Craig 10-30: keep
 *     30, no write): no pipeline_state write of any kind;
 *   - the FIX-1311 hold row is asserted, never converted or deleted: only its
 *     note is appended to; the guard admits the gated push's own session hold;
 *   - one owner: the cron by NAME, no un-park;
 *   - the read-back pins the current four bodies (dispatch_one_unit = the
 *     md5 of FIX-1361's body) and exactly one registry row on the pipeline;
 *   - the revert matches the new text and touches only the rule.
 * Clone tests (CIVITICS_CLONE_TESTS=1): the file applies from the un-RETURNed
 * row (and under a session hold), leaves a dial fixture's other keys intact,
 * RAISEs on a moved dial / an open cursor / a human hold; the body's own mode
 * decision reads crawl at 30 and full at 14 with the watermark 16 d back; and
 * one manual tick at MemAvailable 300 arms the row as DUE.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { read, stripComments } from "./lib/migration-text";

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

function one(suffix: string): string {
  const hits = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(suffix));
  assert.equal(hits.length, 1, `expected exactly one *${suffix}, found ${hits.join(", ") || "none"}`);
  return read(path.join(MIGRATIONS, hits[0] as string));
}
const DP = () => one("_fix1365_return_donor_party_rollup_refresh_crawl_first.sql");
const ANCHOR = () => one("_fix1361_dispatcher_anchor_cadence_and_headroom_rung_after_live.sql");
const BODY = () => one("_fix1295_work_mem_m2.sql");
const REVERT = () => read(path.join(ROOT, "scripts", "fix1365-revert-return-donor-party-rollup.sql"));

const md5 = (s: string) => crypto.createHash("md5").update(s, "utf8").digest("hex");
function prosrc(src: string, sig: string, quote: string): string {
  const start = src.indexOf(sig);
  assert.notEqual(start, -1, `not found: ${sig}`);
  const open = src.indexOf(`AS ${quote}`, start) + `AS ${quote}`.length;
  return src.slice(open, src.indexOf(quote, open));
}
const anchorPin = () => md5(prosrc(ANCHOR(), "CREATE OR REPLACE FUNCTION public.dispatch_one_unit(", "$function$"));
/** The live body (cc-254 read 2: prod = clone = 7bf24bc1…). */
const LIVE_BODY_MD5 = "7bf24bc1476db8e0e82b7cf4afb6a280";
const incrementalBody = () => prosrc(BODY(), "CREATE OR REPLACE PROCEDURE public.refresh_donor_party_rollup_incremental()", "$procedure$");

test("RETURN: exactly one rule write, the row by name, matched on at 0 15 * * 2", () => {
  const sql = stripComments(DP());
  const sets = [...sql.matchAll(/SET deadline_rule = '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(sets, ["by 0 15 * * 2"]);
  assert.match(sql, /WHERE job = 'donor-party-rollup-refresh'\s+AND deadline_rule = 'at 0 15 \* \* 2';/);
  assert.equal([...sql.matchAll(/UPDATE public\.job_registry/g)].length, 1, "one registry write");
  assert.ok(sql.includes(
    "note || '; RETURNED 2026-10-30 (FIX-1365, cc-254): by 0 15 * * 2 = its cron slot; crawl-first (full_rebuild_lag_days 30, FIX-1249)'",
  ));
  assert.ok(sql.includes("IF v_rule = 'by 0 15 * * 2' THEN"), "already returned → NOTICE");
  assert.doesNotMatch(sql, /SET anchor_cadence|anchor_cadence\s*=\s*'/, "its own pipeline: no anchor_cadence (rule 378)");
  const slot = /^by\s+(.+)$/.exec("by 0 15 * * 2")?.[1];
  assert.equal(slot, "0 15 * * 2");
  assert.match(slot!, /^\d+ \d+ \* \* \d$/, "a weekly M H * * D slot (D-d, FIX-1329)");
});

test("the dial and the cursor are ASSERTED, never written (Craig 10-30: keep 30)", () => {
  const sql = stripComments(DP());
  assert.doesNotMatch(sql, /(INSERT INTO|UPDATE|DELETE FROM)\s+public\.pipeline_state/i, "no pipeline_state write");
  assert.ok(sql.includes("SELECT value INTO v_cfg FROM public.pipeline_state WHERE key = 'donor_party_crawl';"));
  assert.ok(sql.includes("(v_cfg->>'full_rebuild_lag_days') IS DISTINCT FROM '30'"), "the dial asserted at read 3's value");
  assert.ok(sql.includes("SELECT value INTO v_cursor FROM public.pipeline_state WHERE key = 'donor_party_full_rebuild';"));
  assert.match(sql, /IF FOUND THEN\s+RAISE EXCEPTION '\[fix1365\] a donor_party_full_rebuild cursor is open/, "an open cycle refuses");
  assert.doesNotMatch(sql, /'(unit_budget_seconds|max_units|slice_rows)'/, "one variable: the body's defaults stand");
});

test("the file's mode arithmetic is the body's, character for character, and the body is the live one", () => {
  const b = incrementalBody();
  assert.equal(md5(b), LIVE_BODY_MD5, "the last CREATE of the body is the one prod runs");
  // The decision the file re-computes for its NOTICE.
  assert.ok(b.includes("COALESCE((v_cfg->>'full_rebuild_lag_days')::int, 14), 1));"));
  assert.ok(b.includes("v_target := LEAST(v_target, public.fr_watermark_horizon());"));
  assert.match(b, /WHEN v_watermark IS NULL\s+THEN 'bootstrap'\s+WHEN v_lag > v_full_lag\s+THEN 'full'\s+ELSE\s+'crawl'/);
  assert.ok(b.includes("c_cycle_max_age  interval := interval '22 days';"), "the cursor-expiry bound the header cites");
  const sql = stripComments(DP());
  assert.ok(sql.includes("v_target := LEAST(v_target, public.fr_watermark_horizon());"));
  assert.ok(sql.includes("v_full := make_interval(days => GREATEST(COALESCE((v_cfg->>'full_rebuild_lag_days')::int, 14), 1));"));
  assert.match(sql, /WHEN v_wm IS NULL THEN 'bootstrap'\s+WHEN v_lag > v_full THEN 'full'\s+ELSE 'crawl'/);
  assert.ok(sql.includes(`'${LIVE_BODY_MD5}'`), "the NOTICE says whether the body is still the one the arithmetic copies");
});

test("the hold row: asserted as FIX-1311's takeover hold (or the push's own session hold); only the note appended", async () => {
  const { SESSION_HOLD_PREFIX } = await import("../lib/prod-session");
  assert.equal(SESSION_HOLD_PREFIX, "prod session held: ");
  const sql = stripComments(DP());
  assert.doesNotMatch(sql, /SET\s+held_since|cadence_hours\s*=\s*\d+|hold_reason\s*=\s*(NULL|')|retired_at\s*=/, "no hold conversion");
  assert.doesNotMatch(sql, /DELETE FROM/i, "rule 289: never DELETE");
  assert.match(sql, /v_row\.hold_reason LIKE 'parked for the dispatcher cutover%'/);
  assert.match(sql, /v_row\.cadence_hours IS NULL/);
  assert.match(sql, /v_row\.note LIKE 'FIX-1311 \(cc-232\)%'/);
  assert.ok(sql.includes(`OR v_row.hold_reason LIKE '${SESSION_HOLD_PREFIX}%'`), "the gate's own hold is admitted, not refused");
  assert.match(
    sql,
    /UPDATE public\.rollup_watch_overrides\s+SET note\s+= note \|\| '; donor-party RETURNED 2026-10-30 \(FIX-1365\) — hold kept, conversion to cadence_hours 168 owed with the catch-up receipt',/,
  );
  assert.match(sql, /AND note LIKE 'FIX-1311 \(cc-232\)%'\s+AND note NOT LIKE '%donor-party RETURNED 2026-10-30 \(FIX-1365\)%';/, "idempotent");
  assert.ok(sql.includes("a human hold is resolved by a human"));
});

test("one owner: the cron by NAME, inactive; no un-park, no dial, no pause", () => {
  const sql = stripComments(DP());
  assert.ok(sql.includes("SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'donor-party-rollup-refresh';"));
  assert.ok(sql.includes("SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = 'donor-party-rollup-refresh';"));
  assert.doesNotMatch(sql, /cron\.(alter_job|unschedule|schedule)\s*\(/);
  assert.doesNotMatch(sql, /UPDATE public\.platform_dials/);
  assert.doesNotMatch(sql, /jobid\s*=\s*17\b/, "by name, never by jobid (FIX-946)");
  assert.doesNotMatch(sql, /CREATE (OR REPLACE )?(FUNCTION|PROCEDURE)/i, "no routine");
});

test("the read-back: every other column unchanged, one row on the pipeline, the four pins current", () => {
  const sql = stripComments(DP());
  assert.ok(sql.includes("AND unit_shape = 'resumable' AND unit_call = 'CALL public.refresh_donor_party_rollup_incremental();'"));
  assert.ok(sql.includes("AND priority = 3 AND cost_class = 'memory' AND cap_mb = 64 AND exclusion_group = 'rollups'"));
  assert.ok(sql.includes("AND budget_seconds = 1800 AND gates = '{prod_session}' AND NOT phase_lock AND phase_due_at IS NULL"));
  assert.ok(sql.includes("AND by_window_minutes IS NULL AND yield_to = '{}' AND NOT idempotent_refire"));
  assert.ok(sql.includes("AND anchor_cadence IS NULL;"));
  assert.ok(sql.includes("SELECT count(*) INTO v_n FROM public.job_registry WHERE pipeline = 'donor_party_rollup_refresh';"), "rule 378");
  assert.ok(DP().includes(`c_pin_d CONSTANT text := '${anchorPin()}'`), "the asserted pin is FIX-1361's body");
  assert.equal(anchorPin(), "d6a9073bcc4d9084b9d7994324a89b18");
  for (const pin of ["ac8dbcddf71978e73d28c999433156b7", "4c30523742e280a4b48ea2ec390654d6", "1d3507cd4b71439f0cfff51cde49b9d8"]) {
    assert.ok(sql.includes(`'${pin}'`), pin);
  }
  assert.match(sql, /RAISE EXCEPTION '\[fix1365\] read-back failed: %'/);
  assert.ok(sql.includes("v_prev := public.cron_prev_slot('0 15 * * 2', now());"), "the pick's arithmetic, printed");
  assert.ok(sql.includes("WHEN v_avail - 64 < v_head THEN"), "the 64-cap headroom reading");
});

test("the revert matches the new text, touches only the rule, and leaves the dial, the hold row and the cron alone", () => {
  const sql = stripComments(REVERT());
  assert.match(sql, /SET deadline_rule = 'at 0 15 \* \* 2'/);
  assert.match(sql, /WHERE job = 'donor-party-rollup-refresh'\s+AND deadline_rule = 'by 0 15 \* \* 2';/);
  assert.doesNotMatch(sql, /pipeline_state/, "the dial was never written");
  assert.doesNotMatch(sql, /UPDATE public\.rollup_watch_overrides/);
  assert.doesNotMatch(sql, /cron\.(alter_job|unschedule|schedule)\s*\(/, "the cron stays parked");
  assert.doesNotMatch(sql, /platform_dials/, "pause is the operator's, not the payload's");
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

/** Apply the file inside the caller's transaction, from the un-RETURNed row. */
async function applyFresh(c: Client): Promise<void> {
  await c.query(REVERT());
  await c.query(DP());
}

test("clone: the file applies from the un-RETURNed row; a dial fixture's other keys survive (no write)", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await c.query("BEGIN");
    try {
      await c.query(
        `INSERT INTO public.pipeline_state (key, value) VALUES ('donor_party_crawl', '{"full_rebuild_lag_days": 30, "unit_budget_seconds": 900}')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      );
      await applyFresh(c);
      const reg = (await c.query("SELECT deadline_rule FROM public.job_registry WHERE job = 'donor-party-rollup-refresh'")).rows[0];
      assert.equal(reg.deadline_rule, "by 0 15 * * 2");
      const dial = (await c.query("SELECT value FROM public.pipeline_state WHERE key = 'donor_party_crawl'")).rows[0];
      assert.deepEqual(dial.value, { full_rebuild_lag_days: 30, unit_budget_seconds: 900 });
      const hold = (await c.query("SELECT held_since, cadence_hours, note FROM public.rollup_watch_overrides WHERE pipeline = 'donor_party_rollup_refresh'")).rows[0];
      assert.notEqual(hold.held_since, null, "still a hold");
      assert.equal(hold.cadence_hours, null, "not converted");
      assert.match(hold.note, /^FIX-1311 \(cc-232\)/);
      assert.match(hold.note, /donor-party RETURNED 2026-10-30 \(FIX-1365\) — hold kept/);
      await c.query(DP());  // idempotent: a second run NOTICEs and changes nothing
      const n = (await c.query("SELECT count(*)::int AS n FROM regexp_matches((SELECT note FROM public.rollup_watch_overrides WHERE pipeline = 'donor_party_rollup_refresh'), 'FIX-1365', 'g')")).rows[0];
      assert.equal(n.n, 1, "the note is appended once");
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("clone: the file applies under the gate's own session hold; RAISEs on a human hold, a moved dial, an absent dial, an open cursor", async (t) => {
  const c = await clone(t);
  if (!c) return;
  const attempt = async (setup: string, params: unknown[] = []): Promise<string | null> => {
    await c.query("BEGIN");
    try {
      await c.query(REVERT());
      await c.query(setup, params);
      await c.query(DP());
      return null;
    } catch (e) {
      return (e as Error).message;
    } finally {
      await c.query("ROLLBACK");
    }
  };
  try {
    assert.equal(
      await attempt(`UPDATE public.rollup_watch_overrides SET hold_reason = 'prod session held: cc-254 clone test', held_since = now()
                      WHERE pipeline = 'donor_party_rollup_refresh'`),
      null,
      "the session's own hold is admitted",
    );
    assert.match(
      (await attempt(`UPDATE public.rollup_watch_overrides SET hold_reason = 'Craig: hands off' WHERE pipeline = 'donor_party_rollup_refresh'`)) ?? "",
      /\[fix1365\] donor_party_rollup_refresh override is not FIX-1311's takeover hold/,
    );
    assert.match(
      (await attempt(`UPDATE public.pipeline_state SET value = '{"full_rebuild_lag_days": 35}' WHERE key = 'donor_party_crawl'`)) ?? "",
      /\[fix1365\] pipeline_state donor_party_crawl reads .*35/,
    );
    assert.match(
      (await attempt(`DELETE FROM public.pipeline_state WHERE key = 'donor_party_crawl'`)) ?? "",
      /\[fix1365\] pipeline_state donor_party_crawl reads \(no row/,
    );
    assert.match(
      (await attempt(
        `INSERT INTO public.pipeline_state (key, value) VALUES ('donor_party_full_rebuild', '{"mode": "full", "started_at": "2026-10-29T00:00:00Z", "windows_done": [1]}')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      )) ?? "",
      /\[fix1365\] a donor_party_full_rebuild cursor is open/,
    );
  } finally {
    await c.end();
  }
});

test("clone: with the watermark 16 d behind the body's own target, the live body's decision reads crawl at 30 and full at 14", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    const live = (await c.query(
      "SELECT md5(prosrc) AS m FROM pg_proc WHERE proname = 'refresh_donor_party_rollup_incremental' AND pronamespace = 'public'::regnamespace",
    )).rows[0];
    assert.equal(live.m, LIVE_BODY_MD5, "the decision below is this body's (text test 3 pins its lines)");
    // The decision, as the body computes it (20261010010000:477-528), against the clone's own target.
    const decide = async (dial: number | null): Promise<string> => {
      await c.query("BEGIN");
      try {
        await c.query(
          `INSERT INTO public.pipeline_state (key, value)
           VALUES ('donor_party_rollup_watermark',
                   jsonb_build_object('last_indexed_at',
                     (LEAST((SELECT max(updated_at) FROM public.financial_relationships), public.fr_watermark_horizon())
                      - interval '16 days')::text))
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        );
        await c.query("DELETE FROM public.pipeline_state WHERE key IN ('donor_party_crawl', 'donor_party_full_rebuild')");
        if (dial !== null) {
          await c.query("INSERT INTO public.pipeline_state (key, value) VALUES ('donor_party_crawl', jsonb_build_object('full_rebuild_lag_days', $1::int))", [dial]);
        }
        const r = (await c.query(
          `WITH cfg AS (SELECT COALESCE((SELECT value FROM public.pipeline_state WHERE key = 'donor_party_crawl'), '{}'::jsonb) AS v),
                w AS (SELECT (value->>'last_indexed_at')::timestamptz AS wm FROM public.pipeline_state WHERE key = 'donor_party_rollup_watermark'),
                tgt AS (SELECT LEAST((SELECT max(updated_at) FROM public.financial_relationships), public.fr_watermark_horizon()) AS t)
           SELECT CASE WHEN w.wm IS NULL THEN 'bootstrap'
                       WHEN tgt.t - w.wm > make_interval(days => GREATEST(COALESCE((cfg.v->>'full_rebuild_lag_days')::int, 14), 1)) THEN 'full'
                       ELSE 'crawl' END AS mode
             FROM cfg, w, tgt`,
        )).rows[0];
        return r.mode as string;
      } finally {
        await c.query("ROLLBACK");
      }
    };
    assert.equal(await decide(30), "crawl", "prod's dial (FIX-1249): a 16-day park crawls");
    assert.equal(await decide(14), "full", "the absent-key default would enter the windowed rebuild");
    assert.equal(await decide(null), "full", "absent key = 14");
  } finally {
    await c.end();
  }
});

test("clone: one manual tick at MemAvailable 300 arms the RETURNed row as DUE since its prev slot", async (t) => {
  const c = await clone(t);
  if (!c) return;
  const MB = 1048576;
  const SWAP_TOTAL = 1073737728;
  try {
    await c.query("BEGIN");
    try {
      await applyFresh(c);
      // Every other dispatched row parked for the tick; donor-party is the only candidate.
      await c.query(
        "UPDATE public.job_registry SET deadline_rule = 'at 0 0 1 1 *' WHERE deadline_rule NOT LIKE 'at %' AND job <> 'donor-party-rollup-refresh'",
      );
      await c.query("UPDATE public.platform_dials SET pause = false, max_concurrent_units = 10, max_live_caps_mb = 100000, rearm_cooldown_seconds = 0");
      await c.query("DELETE FROM public.pipeline_state WHERE key = 'prod_session'");
      await c.query(
        `INSERT INTO public.pipeline_state (key, value, updated_at)
         VALUES ('box_health', jsonb_build_object('at', clock_timestamp(), 'startup_timeouts_10m', 0,
                                                  'watchdog_max_wall_10m', jsonb_build_object('unit', 0, 'budget', 0)), now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      );
      await c.query(
        `INSERT INTO public.pipeline_state (key, value, updated_at)
         VALUES ('box_health_mem', jsonb_build_object('at', clock_timestamp(),
                                                      'mem_total_bytes', 948191232, 'mem_available_bytes', $1::bigint,
                                                      'swap_total_bytes', $2::bigint, 'swap_free_bytes', $3::bigint, 'load1', 0.1), now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [300 * MB, SWAP_TOTAL, SWAP_TOTAL - 450 * MB],
      );
      // Its own last advancing run: before this week's slot (prod: 10-13 15:00:48Z).
      await c.query(
        `DELETE FROM public.data_sync_log WHERE pipeline = 'donor_party_rollup_refresh' AND completed_at >= public.cron_prev_slot('0 15 * * 2', now())`,
      );
      await c.query("DELETE FROM public.data_sync_log WHERE pipeline = 'donor_party_rollup_refresh' AND status = 'running'");
      await c.query("SELECT public.dispatch_one_unit('manual')");
      const row = (await c.query("SELECT decision, job, reason, excluded FROM public.dispatch_log ORDER BY id DESC LIMIT 1")).rows[0];
      assert.equal(row.decision, "armed", JSON.stringify(row));
      assert.equal(row.job, "donor-party-rollup-refresh");
      assert.match(row.reason, /^by 0 15 \* \* 2 → -/, "DUE: ttd negative, since its prev slot");
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});
