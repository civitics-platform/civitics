/**
 * FIX-1354 — the dispatcher's box gate reads memory: the swap ceiling
 * (box_is_saturated reason 'memory', platform_dials.swap_ceiling_mb 1018) and
 * the D8 headroom test per due row (dispatch_one_unit step 6), plus
 * get_dispatcher_status()'s two new keys. FIX-1355 — refresh-derived-mvs-daily
 * RETURNED as `by 0 6 * * *` behind them, and the shared hold row converted.
 * cc-251, `*_fix1354_box_gate_memory_rules.sql` + `*_fix1355_return_refresh_derived_mvs_daily.sql`.
 *
 * Runs via:  tsx --test src/__tests__/dispatcher-r4.test.ts
 *
 * A suffix-globbed test never sees a later CREATE OR REPLACE (rule 305), so
 * this file reads THIS migration's bodies. Text anchors (no DB, run in CI):
 *   - one CREATE OR REPLACE per routine; box_is_saturated keeps prod's
 *     signature and SET clause (the revert file IS prod's definitions);
 *   - md5(prosrc) of the new bodies = the read-back's pins, and of the revert's
 *     = the pre-push pins (494240af / 7b4e3f66 / 2716fcca);
 *   - nothing else touched: a line diff against the revert's bodies is exactly
 *     the D1 / D2 / status hunks;
 *   - D1's ladder order, fail-open on a stale mirror, the thresholds object;
 *   - D2's rung (after the cooldown, before 'live', every runner), read off
 *     step 4's readings once;
 *   - the RETURN: matched on the exact old text, the pick's `by` parse, the
 *     hold row's three-way guard, one owner, no DELETE, the new pins asserted;
 *   - both reverts' predicates match the new text.
 * The clone tests (CIVITICS_CLONE_TESTS=1) run the routines on fixtures inside
 * rolled-back transactions: swap at the ceiling → `box: memory`; a 256-cap row
 * at MemAvailable 300 → `headroom: 300 MB avail − 256 MB cap < 150 MB` while a
 * 64-cap row arms; a stale mirror → the on-box reasons only + mem_stale.
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

/** Exactly one file per suffix. Lazy, so a missing file fails each test, not the load. */
function one(suffix: string): string {
  const hits = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(suffix));
  assert.equal(hits.length, 1, `expected exactly one *${suffix}, found ${hits.join(", ") || "none"}`);
  return read(path.join(MIGRATIONS, hits[0] as string));
}
const MEM = () => one("_fix1354_box_gate_memory_rules.sql");
const RDM = () => one("_fix1355_return_refresh_derived_mvs_daily.sql");
const N2 = () => one("_fix1336_n2_nightly_start_blackout_retired_yield_next_due.sql");
const REVERT_MEM = () => read(path.join(ROOT, "scripts", "fix1354-revert-box-gate-memory-rules.sql"));
const REVERT_RDM = () => read(path.join(ROOT, "scripts", "fix1355-revert-return-refresh-derived-mvs-daily.sql"));

const OLD_PINS = {
  box_is_saturated: "494240afcd3860cd71066c6dbd7a0776",
  dispatch_one_unit: "7b4e3f66105a49d030c41539e4cd2d56",
  get_dispatcher_status: "2716fcca9ba97b683963cd499bc78136",
} as const;
type Routine = keyof typeof OLD_PINS;
const ROUTINES = Object.keys(OLD_PINS) as Routine[];
const CEILING = 1018;

/** The `CREATE OR REPLACE FUNCTION public.<name>(` … `$function$` definition (comments outside it untouched). */
function def(src: string, name: Routine): string {
  const start = src.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  assert.notEqual(start, -1, `${name}: no CREATE OR REPLACE`);
  const open = src.indexOf("AS $function$", start);
  const close = src.indexOf("$function$", open + "AS $function$".length);
  assert.ok(open > start && close > open, `${name}: dollar-quoted body`);
  return src.slice(start, close + "$function$".length);
}
/** prosrc: the text between the dollar quotes, exactly as Postgres stores it. */
const prosrc = (d: string) => d.slice(d.indexOf("AS $function$") + "AS $function$".length, d.lastIndexOf("$function$"));
const md5 = (s: string) => crypto.createHash("md5").update(s, "utf8").digest("hex");
const header = (d: string) => d.slice(0, d.indexOf("AS $function$"));

/** Lines removed / added between two texts (an LCS line diff). */
function lineDiff(a: string, b: string): { removed: string[]; added: string[] } {
  const x = a.split("\n");
  const y = b.split("\n");
  const n = x.length;
  const m = y.length;
  const L: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i]![j] = x[i] === y[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { i++; j++; }
    else if (L[i + 1]![j]! >= L[i]![j + 1]!) removed.push(x[i++]!);
    else added.push(y[j++]!);
  }
  while (i < n) removed.push(x[i++]!);
  while (j < m) added.push(y[j++]!);
  return { removed, added };
}

/** Each added line must come from the change and from nothing else. */
const ADDED_OK = /FIX-1354|^\s+'memory',\s+jsonb_build_object\($|v_mem_avail|v_mem_stale|v_swap_used|v_ceiling|v_headroom|c_swap_ceiling_mb|c_headroom_mb|swap_ceiling_mb|headroom_target_mb|headroom:|COALESCE\(r\.cap_mb, c_cap_default\), v_dials\.headroom_target_mb|v_box|v_stale|mem_stale|v_reason|v_to10 >= p_fork_failures_10m|v_age IS NULL OR v_age > p_stale_seconds|v_walls AND v_wall > c_watchdog_wall_s|^\s*ELSE$|^\s*END IF;$|^\s*$|FROM public\.platform_dials d WHERE d\.id|FROM public\.dispatch_log l|WHERE l\.box IS NOT NULL|ORDER BY l\.ticked_at DESC|LIMIT 1;|WHERE l\.ticked_at > v_now - interval '24 hours'|- \(v_mem->>'swap_free_bytes'\)::numeric\) \/ 1048576\);|^\s*--/;

// ---------------------------------------------------------------------------
// The pair's shape
// ---------------------------------------------------------------------------

test("FIX-1354 redefines exactly the three routines; FIX-1355 redefines none", () => {
  const mem = stripComments(MEM());
  for (const r of ROUTINES) {
    assert.equal(mem.split(`CREATE OR REPLACE FUNCTION public.${r}(`).length - 1, 1, `${r}: one CREATE OR REPLACE`);
  }
  assert.equal([...mem.matchAll(/CREATE (OR REPLACE )?(FUNCTION|PROCEDURE)/g)].length, 3);
  assert.doesNotMatch(stripComments(RDM()), /CREATE (OR REPLACE )?(FUNCTION|PROCEDURE)/);
  assert.doesNotMatch(mem, /DROP FUNCTION/, "same signature: CREATE OR REPLACE, never a DROP + CREATE");
});

test("the dial: ADD COLUMN IF NOT EXISTS swap_ceiling_mb int NOT NULL DEFAULT 1018 + the range CHECK; no trigger DDL", () => {
  const mem = stripComments(MEM());
  assert.match(mem, /ALTER TABLE public\.platform_dials\s+ADD COLUMN IF NOT EXISTS swap_ceiling_mb int NOT NULL DEFAULT 1018\s+CHECK \(swap_ceiling_mb BETWEEN 0 AND 1048576\);/);
  assert.doesNotMatch(mem, /(CREATE|DROP|ALTER)( OR REPLACE)? TRIGGER|platform_dials_tick_reschedule/i,
    "platform_dials_tick_reschedule keys on tick_seconds; untouched");
  assert.doesNotMatch(mem, /UPDATE public\.platform_dials/, "no dial set by hand: the DEFAULT is the value");
  assert.ok(mem.indexOf("ALTER TABLE public.platform_dials") < mem.indexOf("CREATE OR REPLACE FUNCTION"), "the column first");
});

test("each routine keeps prod's signature + SET clause (the revert IS prod's pg_get_functiondef)", () => {
  // box_is_saturated spells out its two defaults, VOLATILE and SECURITY INVOKER, as
  // P1-A did (box-health-probe.test.ts asserts them); pg_get_functiondef omits both.
  const spelled = (h: string) => h.replace(" VOLATILE\n SECURITY INVOKER\n", "");
  for (const r of ROUTINES) {
    assert.equal(spelled(header(def(MEM(), r))), header(def(REVERT_MEM(), r)), `${r}: header byte-equal`);
  }
  assert.ok(header(def(MEM(), "box_is_saturated")).includes(" VOLATILE\n SECURITY INVOKER\n SET search_path TO 'public', 'pg_catalog'\n"));
  assert.ok(header(def(MEM(), "box_is_saturated")).includes(
    "(p_stale_seconds integer DEFAULT 180, p_fork_failures_10m integer DEFAULT 3, p_now timestamp with time zone DEFAULT clock_timestamp(), p_include_watchdog_wall boolean DEFAULT true)"));
});

test("md5(prosrc): the new bodies = the read-back's pins (≠ the old); the revert's = the pre-push pins", () => {
  const mem = MEM();
  const rdm = RDM();
  for (const r of ROUTINES) {
    const now = md5(prosrc(def(mem, r)));
    assert.notEqual(now, OLD_PINS[r], `${r} moved`);
    assert.ok(mem.includes(`'${now}'`), `${r}: FIX-1354's read-back pins ${now}`);
    assert.ok(rdm.includes(`'${now}'`), `${r}: FIX-1355's read-back asserts ${now}`);
    assert.equal(md5(prosrc(def(REVERT_MEM(), r))), OLD_PINS[r], `${r}: the revert restores ${OLD_PINS[r]}`);
  }
  for (const pin of Object.values(OLD_PINS)) assert.ok(mem.includes(`'${pin}'`), `the read-back asserts ≠ ${pin}`);
});

test("nothing else touched: the line diff against prod's bodies is the D1 / D2 / status hunks only", () => {
  const removedOk: Record<Routine, RegExp> = {
    box_is_saturated: /v_reason|v_age IS NULL OR v_age > p_stale_seconds|v_to10 >= p_fork_failures_10m|v_walls AND v_wall > c_watchdog_wall_s|^\s*ELSE$|^\s*END IF;$|^\s*$|'swap_used_mb'|- \(v_mem->>'swap_free_bytes'\)::numeric\) \/ 1048576\),|report-only/,
    dispatch_one_unit: /^ {10}-- D8: headroom test here \(FIX-1125\)$/,
    get_dispatcher_status: /^$/,
  };
  for (const r of ROUTINES) {
    const { removed, added } = lineDiff(prosrc(def(REVERT_MEM(), r)), prosrc(def(MEM(), r)));
    for (const l of removed) assert.match(l, removedOk[r], `${r}: removed line outside the hunks: ${JSON.stringify(l)}`);
    for (const l of added) assert.match(l, ADDED_OK, `${r}: added line outside the hunks: ${JSON.stringify(l)}`);
    assert.ok(added.length > 0, `${r}: something changed`);
  }
  const d = lineDiff(prosrc(def(REVERT_MEM(), "dispatch_one_unit")), prosrc(def(MEM(), "dispatch_one_unit")));
  assert.deepEqual(d.removed, ["          -- D8: headroom test here (FIX-1125)"], "dispatch_one_unit: only the marker line goes");
  assert.equal(d.added.length, 14, "dispatch_one_unit: 1 declare + 6 step-4 + 1 marker + 6 rung lines");
});

// ---------------------------------------------------------------------------
// D1 — box_is_saturated
// ---------------------------------------------------------------------------

test("D1: the ladder is stale → fork_failures → memory → watchdog_wall → clear; memory needs a FRESH mirror", () => {
  const b = stripComments(prosrc(def(MEM(), "box_is_saturated")));
  const at = (s: string) => {
    const i = b.indexOf(s);
    assert.notEqual(i, -1, `missing: ${s}`);
    return i;
  };
  const order = [
    "v_reason := 'stale'", "v_reason := 'fork_failures'", "v_reason := 'memory'",
    "v_reason := 'watchdog_wall'", "v_reason := 'clear'",
  ].map(at);
  assert.deepEqual([...order].sort((p, q) => p - q), order, "the reason order");
  assert.ok(b.includes("ELSIF NOT v_mem_stale AND v_swap_used >= v_ceiling THEN"));
  assert.ok(b.includes("v_mem_stale := v_mem_age IS NULL OR v_mem_age > p_stale_seconds;"), "fresh = the probe's own freshness");
  assert.ok(at("v_mem_stale := ") < at("IF v_age IS NULL OR v_age > p_stale_seconds THEN"), "memory is read before the ladder");
  assert.match(b, /SELECT d\.swap_ceiling_mb, d\.headroom_target_mb INTO v_ceiling, v_headroom\s+FROM public\.platform_dials d WHERE d\.id;/);
  assert.ok(b.includes("c_swap_ceiling_mb CONSTANT int := 1018;"), "the fallback = the column's DEFAULT");
  assert.match(b, /'memory',\s+jsonb_build_object\(\s+'swap_ceiling_mb',\s+v_ceiling,\s+'headroom_target_mb', v_headroom,\s+'mem_stale',\s+v_mem_stale\)/);
  assert.ok(!b.includes("report-only"), "the report-only string is gone");
  assert.ok(b.includes("'swap_used_mb',     v_swap_used,"), "the readings report the same number the ladder compares");
});

// ---------------------------------------------------------------------------
// D2 — dispatch_one_unit
// ---------------------------------------------------------------------------

test("D2: the mirror is read ONCE, from step 4's readings, and only when fresh", () => {
  const d = stripComments(prosrc(def(MEM(), "dispatch_one_unit")));
  assert.equal(d.split("public.box_is_saturated(").length - 1, 1, "still one box_is_saturated call (step 4)");
  assert.doesNotMatch(d, /box_health_mem/, "pipeline_state is never re-read per row");
  const step4 = d.indexOf("v_reason   := 'box: ' || COALESCE(v_box->>'reason', 'unknown');");
  const mirror = d.indexOf("IF NOT COALESCE((v_box->'readings'->'thresholds'->'memory'->>'mem_stale')::boolean, true) THEN");
  const census = d.indexOf("SELECT COALESCE(array_agg(a.job ORDER BY a.id), '{}'),");
  assert.ok(step4 > 0 && mirror > step4 && census > mirror, "between step 4's skip and step 5's census");
  assert.ok(d.includes("v_mem_avail := (v_box->'readings'->'memory'->>'mem_available_mb')::int;"));
});

test("D2: the headroom rung sits after the I6 cooldown and before 'live', with the prompt's exact text, for every runner", () => {
  const d = stripComments(prosrc(def(MEM(), "dispatch_one_unit")));
  const cooldown = d.indexOf("NULL;  \n          ELSIF v_mem_avail IS NOT NULL");
  const rung = d.indexOf("ELSIF v_mem_avail IS NOT NULL\n                AND v_mem_avail - COALESCE(r.cap_mb, c_cap_default) < v_dials.headroom_target_mb THEN");
  const live = d.indexOf("ELSIF r.job = ANY (v_live_jobs) THEN\n            v_why := 'live';");
  assert.ok(rung > 0 && live > rung, "the rung, then 'live'");
  assert.ok(cooldown > 0 && cooldown < rung, "right after the cooldown's NULL branch (the cooldown stays the first reason)");
  assert.ok(d.includes("v_why := format('headroom: %s MB avail − %s MB cap < %s MB', v_mem_avail,\n                            COALESCE(r.cap_mb, c_cap_default), v_dials.headroom_target_mb);"));
  const block = d.slice(rung, live);
  assert.doesNotMatch(block, /runner/, "decision (a): no github_actions exemption");
  // The rendered exclusion for the prompt's two rows at MemAvailable 300 (the format above, in TS):
  const why = (avail: number, cap: number, dial = 150) =>
    avail - cap < dial ? `headroom: ${avail} MB avail − ${cap} MB cap < ${dial} MB` : null;
  assert.equal(why(300, 256), "headroom: 300 MB avail − 256 MB cap < 150 MB");
  assert.equal(why(300, 64), null, "219 + 17 ≥ 150: a 64-cap row is admitted");
  assert.equal(why(405, 256), "headroom: 405 MB avail − 256 MB cap < 150 MB");
  assert.equal(why(406, 256), null, "the daily arms at MemAvailable ≥ 406");
});

test("D1 at step 4 skips every pick, the GHA nightly included (decision a): the skip has no runner clause", () => {
  const d = stripComments(prosrc(def(MEM(), "dispatch_one_unit")));
  assert.match(d, /v_box := public\.box_is_saturated\(p_include_watchdog_wall := false\);\s+IF COALESCE\(\(v_box->>'saturated'\)::boolean, true\) THEN\s+v_decision := 'skipped';/);
});

test("get_dispatcher_status carries dials.swap_ceiling_mb, box and mem_stale_ticks_24h", () => {
  const g = stripComments(prosrc(def(MEM(), "get_dispatcher_status")));
  assert.ok(g.includes("'swap_ceiling_mb',      v_dials.swap_ceiling_mb,"));
  assert.match(g, /'box', CASE WHEN v_box\.ticked_at IS NULL THEN NULL ELSE jsonb_build_object\(/);
  assert.ok(g.includes("'memory',            v_box.box->'memory',"));
  assert.ok(g.includes("'thresholds_memory', v_box.box->'thresholds'->'memory'"));
  assert.ok(g.includes("'mem_stale_ticks_24h', v_stale,"));
  assert.ok(g.includes("AND l.box->'thresholds'->'memory'->>'mem_stale' = 'true';"));
});

test("the read-back RAISEs on any miss and pins prod_op_gate / in_blackout / record_box_health_mem", () => {
  const mem = stripComments(MEM());
  assert.match(mem, /RAISE EXCEPTION '\[fix1354\] read-back failed: %'/);
  assert.ok(mem.includes("'1d3507cd4b71439f0cfff51cde49b9d8'"), "prod_op_gate");
  assert.ok(mem.includes("'a0010a4751a4cf35ae88945262bc0a74'"), "in_blackout");
  assert.ok(mem.includes("'98fba835ce2f00e9d04dc3658060f934'"), "record_box_health_mem");
  assert.ok(mem.includes("v_dial IS DISTINCT FROM 1018"));
  assert.ok(mem.includes("v_box := public.box_is_saturated(p_include_watchdog_wall := false);"), "the dry call");
  for (const r of ROUTINES) {
    assert.match(mem, new RegExp(`REVOKE ALL ON FUNCTION public\\.${r}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`), `${r}: REVOKE`);
    assert.match(mem, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${r}\\([^)]*\\) TO service_role;`), `${r}: GRANT`);
  }
});

// ---------------------------------------------------------------------------
// FIX-1355 — the RETURN
// ---------------------------------------------------------------------------

test("RETURN: by 0 6 * * * matched on the exact old text; the pick's own by parse accepts it as a daily slot", () => {
  const sql = stripComments(RDM());
  const sets = [...sql.matchAll(/SET deadline_rule = '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(sets, ["by 0 6 * * *"], "exactly one rule write");
  assert.match(sql, /WHERE job = 'refresh-derived-mvs-daily'\s+AND deadline_rule = 'at 0 6 \* \* \*';/);
  assert.ok(sql.includes("note || '; RETURNED 2026-10-26 (FIX-1355, cc-251): by 0 6 * * * = its cron slot'"));
  // The pick: deadline_rule LIKE 'by %' → substring FROM '^by\s+(.+)$' → cron_prev_slot / cron_next_slot.
  const n2 = N2();
  assert.ok(n2.includes("ELSIF r.deadline_rule LIKE 'by %' THEN"));
  const lit = /substring\(r\.deadline_rule FROM '(\^by\\s\+\(\.\+\)\$)'\)/.exec(n2);
  assert.ok(lit, "N2 parses by with ^by\\s+(.+)$");
  assert.equal(new RegExp(lit[1]!).exec("by 0 6 * * *")?.[1], "0 6 * * *");
  assert.match("0 6 * * *", /^\d+ \d+ \* \* \*$/, "a daily M H * * * slot (D-d)");
  assert.match("by 0 6 * * *", /^(at |by |stale_after |dead_tuples > )/, "the deadline_rule CHECK");
});

test("RETURN: the hold row CONVERTS under fix1316's three-way guard, never deleted; the cron stays parked by NAME", () => {
  const sql = stripComments(RDM());
  assert.match(sql, /UPDATE public\.rollup_watch_overrides\s+SET held_since\s+= NULL,\s+hold_reason\s+= NULL,\s+cadence_hours = 24,/);
  assert.match(sql, /WHERE pipeline = 'refresh_derived_mvs'\s+AND hold_reason LIKE 'parked for the dispatcher cutover \(cc-232%';/);
  assert.ok(sql.includes("ELSIF v_row.held_since IS NULL AND v_row.cadence_hours = 24 THEN"), "already converted → NOTICE");
  assert.ok(sql.includes("a human hold is resolved by a human"), "anything else → RAISE");
  assert.doesNotMatch(sql, /DELETE FROM/i, "rule 289: never DELETE");
  assert.ok(sql.includes("SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'refresh-derived-mvs-daily';"));
  assert.doesNotMatch(sql, /cron\.(alter_job|unschedule|schedule)\s*\(/, "no cron un-park, ever");
  assert.doesNotMatch(sql, /UPDATE public\.platform_dials/);
  assert.ok(sql.includes("AND by_window_minutes IS NULL AND yield_to = '{}' AND NOT idempotent_refire;"), "the unchanged columns asserted");
  assert.ok(sql.includes("AND priority = 2 AND cost_class = 'mixed' AND cap_mb = 256 AND exclusion_group = 'mvs'"));
  assert.ok(sql.includes("AND budget_seconds = 5400 AND gates = '{prod_session}' AND NOT phase_lock"));
  assert.match(sql, /RAISE EXCEPTION '\[fix1355\] read-back failed: %'/);
  assert.ok(sql.includes("v_prev := public.cron_prev_slot('0 6 * * *', now());"), "the pick's arithmetic, printed");
});

// ---------------------------------------------------------------------------
// The reverts
// ---------------------------------------------------------------------------

test("the FIX-1354 revert: the three prod bodies, then DROP COLUMN, then the old pins asserted", () => {
  const sql = stripComments(REVERT_MEM());
  assert.equal([...sql.matchAll(/CREATE OR REPLACE FUNCTION/g)].length, 3);
  const last = Math.max(...ROUTINES.map((r) => sql.indexOf(`CREATE OR REPLACE FUNCTION public.${r}(`)));
  assert.ok(sql.indexOf("ALTER TABLE public.platform_dials DROP COLUMN IF EXISTS swap_ceiling_mb;") > last, "the bodies first");
  for (const pin of Object.values(OLD_PINS)) assert.ok(sql.includes(`'${pin}'`));
  assert.ok(!sql.includes("swap_ceiling_mb >="), "no old body reads the column");
  assert.doesNotMatch(sql, /SET pause/, "pause is the operator's, not the payload's");
});

test("the FIX-1355 revert matches the new text and touches only what FIX-1355 wrote", () => {
  const sql = stripComments(REVERT_RDM());
  assert.match(sql, /SET deadline_rule = 'at 0 6 \* \* \*'/);
  assert.match(sql, /WHERE job = 'refresh-derived-mvs-daily'\s+AND deadline_rule = 'by 0 6 \* \* \*';/);
  assert.match(sql, /WHERE pipeline = 'refresh_derived_mvs'\s+AND note LIKE 'FIX-1355 \(cc-251\)%';/, "the hold row only if FIX-1355 converted it");
  assert.ok(RDM().includes("note          = 'FIX-1355 (cc-251) — "), "the note the revert keys on");
  assert.ok(sql.includes("hold_reason   = 'parked for the dispatcher cutover (cc-232, FIX-1311); returns via job_registry'"),
    "back to the literal the RETURN's guard matches");
  assert.doesNotMatch(sql, /cron\.(alter_job|unschedule|schedule)\s*\(/);
  assert.doesNotMatch(sql, /platform_dials/);
});

// ---------------------------------------------------------------------------
// Behavioural — the clone, after apply (CIVITICS_CLONE_TESTS=1 only)
// ---------------------------------------------------------------------------

const MB = 1048576;
const SWAP_TOTAL = 1073737728;
/** A fresh probe and a mirror at the given reading, inside the caller's transaction. */
async function fixtures(c: Client, o: { swapMb: number; availMb: number; ageS?: number }): Promise<void> {
  await c.query(
    `INSERT INTO public.pipeline_state (key, value, updated_at)
     VALUES ('box_health', jsonb_build_object('at', clock_timestamp(), 'startup_timeouts_10m', 0,
                                              'watchdog_max_wall_10m', jsonb_build_object('unit', 0, 'budget', 0)), now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
  );
  await c.query(
    `INSERT INTO public.pipeline_state (key, value, updated_at)
     VALUES ('box_health_mem', jsonb_build_object('at', clock_timestamp() - make_interval(secs => $1::int),
                                                  'mem_total_bytes', 948191232, 'mem_available_bytes', $2::bigint,
                                                  'swap_total_bytes', $3::bigint, 'swap_free_bytes', $4::bigint, 'load1', 0.1), now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [o.ageS ?? 0, o.availMb * MB, SWAP_TOTAL, SWAP_TOTAL - o.swapMb * MB],
  );
}

async function clone(t: { skip: (m: string) => void }): Promise<Client | null> {
  if (process.env["CIVITICS_CLONE_TESTS"] !== "1") {
    t.skip("set CIVITICS_CLONE_TESTS=1 to run against the migrated clone");
    return null;
  }
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  await c.connect();
  return c;
}

test("clone: box_is_saturated — memory at the ceiling, clear below it, fail-open on a stale mirror", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    const sat = async () =>
      (await c.query("SELECT public.box_is_saturated(p_include_watchdog_wall := false) AS b")).rows[0].b;
    await c.query("BEGIN");
    try {
      await fixtures(c, { swapMb: CEILING + 2, availMb: 400 });
      let b = await sat();
      assert.equal(b.reason, "memory");
      assert.equal(b.saturated, true);
      assert.deepEqual(b.readings.thresholds.memory, { swap_ceiling_mb: CEILING, headroom_target_mb: 150, mem_stale: false });
      assert.equal(b.readings.memory.swap_used_mb, CEILING + 2);

      await fixtures(c, { swapMb: CEILING - 8, availMb: 400 });
      b = await sat();
      assert.equal(b.reason, "clear");

      await fixtures(c, { swapMb: CEILING + 2, availMb: 100, ageS: 3600 });
      b = await sat();
      assert.equal(b.reason, "clear", "a stale mirror never saturates");
      assert.equal(b.readings.thresholds.memory.mem_stale, true);
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("clone: the tick — headroom excludes the 256-cap row and arms the 64-cap one; the ceiling skips the tick; stale fails open", async (t) => {
  const c = await clone(t);
  if (!c) return;
  /** One tick on an isolated registry: only the two test rows are eligible. */
  const tick = async (o: { swapMb: number; availMb: number; ageS?: number }) => {
    await c.query("BEGIN");
    try {
      await c.query("UPDATE public.job_registry SET deadline_rule = 'at 0 0 1 1 *' WHERE deadline_rule NOT LIKE 'at %'");
      await c.query(
        `INSERT INTO public.job_registry (job, runner, pipeline, unit_shape, unit_call, priority, deadline_rule, cost_class, cap_mb, note)
         VALUES ('cc251-test-256', 'pg_cron', 'cc251_test_256', 'atomic', 'SELECT 1', 2, 'stale_after 1 minutes', 'mixed', 256, 'cc-251 test'),
                ('cc251-test-64',  'pg_cron', 'cc251_test_64',  'atomic', 'SELECT 1', 3, 'stale_after 1 minutes', 'io',     64, 'cc-251 test')`,
      );
      await c.query(
        "UPDATE public.platform_dials SET pause = false, max_concurrent_units = 10, max_live_caps_mb = 100000, rearm_cooldown_seconds = 0",
      );
      await fixtures(c, o);
      await c.query("SELECT public.dispatch_one_unit('manual')");
      const row = (await c.query(
        "SELECT decision, job, reason, excluded, box FROM public.dispatch_log ORDER BY id DESC LIMIT 1",
      )).rows[0];
      const status = (await c.query("SELECT public.get_dispatcher_status() AS s")).rows[0].s;
      return { row, status };
    } finally {
      await c.query("ROLLBACK");
    }
  };
  try {
    let r = await tick({ swapMb: CEILING - 28, availMb: 300 });
    assert.equal(r.row.decision, "armed");
    assert.equal(r.row.job, "cc251-test-64");
    assert.ok((r.row.excluded ?? []).includes("headroom: 300 MB avail − 256 MB cap < 150 MB (cc251-test-256)"),
      JSON.stringify(r.row.excluded));
    assert.equal(r.row.box.thresholds.memory.mem_stale, false);
    assert.equal(r.status.box.decision, "armed");
    assert.equal(r.status.box.memory.mem_available_mb, 300);
    assert.equal(r.status.dials.swap_ceiling_mb, CEILING);
    assert.equal(typeof r.status.mem_stale_ticks_24h, "number");

    r = await tick({ swapMb: CEILING + 2, availMb: 500 });
    assert.equal(r.row.decision, "skipped");
    assert.equal(r.row.reason, "box: memory");
    assert.equal(r.row.box.thresholds.memory.swap_ceiling_mb, CEILING);

    r = await tick({ swapMb: CEILING + 2, availMb: 100, ageS: 3600 });
    assert.equal(r.row.decision, "armed", "a stale mirror gates nothing");
    assert.equal(r.row.job, "cc251-test-256", "priority 2 wins with no headroom test");
    assert.ok(!(r.row.excluded ?? []).some((e: string) => e.startsWith("headroom:")));
    assert.equal(r.row.box.thresholds.memory.mem_stale, true);
    assert.ok(r.status.mem_stale_ticks_24h >= 1, "the stale tick is counted");
  } finally {
    await c.end();
  }
});

test("clone: the RETURNed row, the converted hold row, jobid 9 parked", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    const reg = (await c.query(
      "SELECT deadline_rule, gates, cap_mb, priority, exclusion_group, budget_seconds FROM public.job_registry WHERE job = 'refresh-derived-mvs-daily'",
    )).rows[0];
    assert.equal(reg.deadline_rule, "by 0 6 * * *");
    assert.deepEqual(reg.gates, ["prod_session"]);
    assert.equal(reg.cap_mb, 256);
    const hold = (await c.query(
      "SELECT held_since, hold_reason, cadence_hours, note FROM public.rollup_watch_overrides WHERE pipeline = 'refresh_derived_mvs'",
    )).rows[0];
    assert.equal(hold.held_since, null);
    assert.equal(Number(hold.cadence_hours), 24, "numeric comes back as a string");
    assert.match(hold.note, /^FIX-1355 \(cc-251\)/);
    const cron = (await c.query("SELECT active FROM cron.job WHERE jobname = 'refresh-derived-mvs-daily'")).rows;
    assert.equal(cron.length, 1);
    assert.equal(cron[0].active, false);
  } finally {
    await c.end();
  }
});
