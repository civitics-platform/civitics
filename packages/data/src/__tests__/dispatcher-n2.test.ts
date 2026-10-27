/**
 * cc-243 — N2 (`*_fix1336_n2_nightly_start_blackout_retired_yield_next_due.sql`):
 * the nightly's START becomes a dispatched unit (a github_actions row whose
 * unit_call is gha-dispatch:<stem> arms a request stamp the 5-minute route fires,
 * FIX-1336); the blackout retires (FIX-1124 part 2: prod_op_gate's constants
 * go, ec_crawl.blackout := []); the crawls' yield moves into the pick
 * (FIX-1331); a stale_after row honours its unit's own metadata.next_due_at
 * and the ec procedure writes it on the cycle-closing unit (FIX-1330); the
 * GHA reap sweeps leftover session holds (FIX-1337).
 *
 * Runs via:  tsx --test src/__tests__/dispatcher-n2.test.ts
 *
 * dispatcher-b1.test.ts reads only `*_fix1329_dispatcher_b1.sql`, so it keeps
 * passing against B1's text. This file anchors N2 (rule 305; no DB, run in CI):
 *   - the base is B1 verbatim (the file's bodies hash to the pair prod carried
 *     at cc-243 read 3), and an LCS line diff removes exactly the pinned lines
 *     and adds a pinned number;
 *   - each hunk, by anchor; prod_op_gate's and the ec procedure's diffs
 *     against their own base files, line for line;
 *   - the data edits match on exact old values; the read-back RAISEs;
 *   - the reverts carry the old bodies (md5) verbatim.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { read, stripComments } from "./lib/migration-text";

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");

/** Exactly one file per suffix. Lazy, so a missing file fails each test, not the load. */
function one(suffix: string): string {
  const hits = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(suffix));
  assert.equal(hits.length, 1, `expected exactly one *${suffix}, found ${hits.join(", ") || "none"}`);
  return read(path.join(MIGRATIONS, hits[0] as string));
}
const N2 = () => one("_fix1336_n2_nightly_start_blackout_retired_yield_next_due.sql");
const B1 = () => one("_fix1329_dispatcher_b1.sql");
const GATE = () => one("_fix1220_1194_streak_minutes_gate_d_one_scan_revoke.sql");
const EC = () => one("_fix1294_fix1295_fix1287_work_mem_m1.sql");
const script = (name: string) => read(path.join(ROOT, "scripts", name));

const B1_MD5 = { dispatch_one_unit: "cfc9ed48517cd7de6fa76cf807dd1f37", get_dispatcher_status: "1cf4b7745f4c89ce978935648c87c92b" };
const GATE_MD5 = "6c036a1c4d35dc0b33a1f99ec405ff4a";
const EC_MD5 = "38227eeb0969ca825db74e4dcc4cd2e0";
/** prod_op_gate's live body: N2's, or FIX-1342's (cc-247) once 20261025000000 is applied. */
const GATE_N2_MD5 = "e3e543cd9a30a4b0dca2b52b159410a0";
const GATE_RECUT_MD5 = "1d3507cd4b71439f0cfff51cde49b9d8";
/** dispatch_one_unit / get_dispatcher_status live: N2's, or FIX-1354's (cc-251) once 20261027000000 is applied (its pins: dispatcher-r4.test.ts). */
const R4_MD5: Record<string, string> = {
  dispatch_one_unit: "64c8271e7601095d275c68eff5187931",
  get_dispatcher_status: "4c30523742e280a4b48ea2ec390654d6",
};
/** dispatch_one_unit's added lines vs B1 (the hunks, nothing else). */
const ADDED_DISPATCH_LINES = 203;

/** The LAST definition of a routine in a file: CREATE through its closing dollar-quote. */
function definition(src: string, name: string, kind: "FUNCTION" | "PROCEDURE" = "FUNCTION"): string {
  const i = src.lastIndexOf(`CREATE OR REPLACE ${kind} public.${name}(`);
  assert.notEqual(i, -1, `${name} is defined`);
  const tag = /AS (\$[a-z_]*\$)/.exec(src.slice(i))!;
  const a = i + tag.index + tag[0].length;
  return src.slice(i, src.indexOf(tag[1]!, a));
}
/** What pg_proc.prosrc will hold: everything between the dollar-quotes. */
function prosrc(src: string, name: string, kind: "FUNCTION" | "PROCEDURE" = "FUNCTION"): string {
  const d = definition(src, name, kind);
  const tag = /AS (\$[a-z_]*\$)/.exec(d)!;
  return d.slice(tag.index + tag[0].length);
}
const md5 = (s: string) => crypto.createHash("md5").update(s).digest("hex");
const headerOf = (src: string, name: string) => definition(src, name).split(/\nAS \$/)[0] as string;
const bodyOf = (src: string, name: string, kind: "FUNCTION" | "PROCEDURE" = "FUNCTION") => stripComments(prosrc(src, name, kind));

/** The old lines an LCS line diff removes, and the new lines it adds. */
function lineDiff(oldText: string, newText: string): { removed: string[]; added: string[] } {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  const L: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i]![j] = a[i] === b[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; }
    else if (L[i + 1]![j]! >= L[i]![j + 1]!) removed.push(a[i++] as string);
    else added.push(b[j++] as string);
  }
  while (i < n) removed.push(a[i++] as string);
  while (j < m) added.push(b[j++] as string);
  return { removed, added };
}

// ---------------------------------------------------------------------------
// (1) the bases, and nothing else moved
// ---------------------------------------------------------------------------

test("(1) the bases are what prod carried at cc-243 read 3", () => {
  assert.equal(md5(prosrc(B1(), "dispatch_one_unit")), B1_MD5.dispatch_one_unit);
  assert.equal(md5(prosrc(B1(), "get_dispatcher_status")), B1_MD5.get_dispatcher_status);
  assert.equal(md5(prosrc(GATE(), "prod_op_gate")), GATE_MD5);
  assert.equal(md5(prosrc(EC(), "run_entity_connections_rebuild", "PROCEDURE")), EC_MD5);
});

test("(1) dispatch_one_unit's LCS diff against B1 removes only the hunk-touched lines", () => {
  const d = lineDiff(prosrc(B1(), "dispatch_one_unit"), prosrc(N2(), "dispatch_one_unit"));
  assert.deepEqual(d.removed.map((l) => l.trim()), [
    // GHA admission + the yield order
    "WHERE j.runner = 'pg_cron'",
    "ORDER BY j.priority, j.job",
    // FIX-1330: v_last and next_due_at in one read
    "SELECT max(l.completed_at) INTO v_last",
    "WHERE l.pipeline = r.pipeline AND l.status IN ('complete', 'partial');",
    // FIX-1330: GREATEST(last + interval, next_due_at)
    "WHEN v_locked THEN (r.phase_due_at + v_iv) - v_now",
    "ELSE (v_last + v_iv) - v_now END;",
    // the by window
    "THEN v_slot_prev - v_now",
  ]);
  // The added side, pinned: the constants and variables, the 3b reap + sweep,
  // the census append, the loop's columns / admission / order, the next_due
  // read, the by window, the ttd map, the GHA cooldown read, the yield, the
  // GHA arm, the stamp's dispatch_log_id. A change anywhere else moves this.
  assert.equal(d.added.length, ADDED_DISPATCH_LINES, d.added.join("\n"));
});

test("(1) get_dispatcher_status differs from B1 by the GHA live rows and the eligible filter only", () => {
  const g = lineDiff(prosrc(B1(), "get_dispatcher_status"), prosrc(N2(), "get_dispatcher_status"));
  assert.deepEqual(g.removed.map((l) => l.trim()), [
    "'eligible',  count(*) FILTER (WHERE j.deadline_rule NOT LIKE 'at %'),",
  ]);
  assert.equal(g.added.length, 10, g.added.join("\n"));
  assert.ok(g.added.some((l) => l.includes("WHERE ps.key LIKE 'gha_dispatch_request_%' AND ps.value->>'reaped_at' IS NULL;")));
  assert.ok(g.added.some((l) => l.includes("AND (j.runner = 'pg_cron' OR j.unit_call ~ '^gha-dispatch:[a-z0-9-]+$')),")));
});

test("(1) prod_op_gate: the constants and their fallback go; an empty array is no window", () => {
  const g = lineDiff(prosrc(GATE(), "prod_op_gate"), prosrc(N2(), "prod_op_gate"));
  assert.deepEqual(g.removed.map((l) => l.trim()), [
    "-- (c) FIX-1124 / rule 2: the fallback when pipeline_state.ec_crawl has none.",
    "c_blackout_from   CONSTANT time     := '05:45';",
    "c_blackout_to     CONSTANT time     := '09:00';",
    "v_windows := jsonb_build_array(jsonb_build_object('from', c_blackout_from::text, 'to', c_blackout_to::text));",
    "v_source  := 'constant 05:45-09:00 (FIX-1124 fallback: pipeline_state.ec_crawl has no blackout)';",
  ]);
  assert.deepEqual(g.added.map((l) => l.trim()).filter((l) => !l.startsWith("--")), [
    "v_windows := '[]'::jsonb;",
    "v_source  := 'none (FIX-1124 part 2)';",
  ]);
  assert.equal(headerOf(N2(), "prod_op_gate").replace(/\s+/g, " "), headerOf(GATE(), "prod_op_gate").replace(/\s+/g, " "));
});

test("(1) the ec procedure: ≤ 12 added lines, none removed — the flag at the cursor clear, the UPDATE after the terminal row", () => {
  const src = N2();
  const e = lineDiff(prosrc(EC(), "run_entity_connections_rebuild", "PROCEDURE"), prosrc(src, "run_entity_connections_rebuild", "PROCEDURE"));
  assert.equal(e.removed.length, 0);
  assert.ok(e.added.length <= 12, `${e.added.length} added`);
  const b = bodyOf(src, "run_entity_connections_rebuild", "PROCEDURE");
  assert.match(b, /DELETE FROM public\.pipeline_state WHERE key = c_cursor_key;\s+v_cycle_closed := true;/, "set where the cycle closes");
  const terminal = b.indexOf("'unparked_arms', to_jsonb(v_unparked_arms)");
  const upd = b.indexOf("UPDATE public.data_sync_log l\n     SET metadata = l.metadata || jsonb_build_object('next_due_at'");
  const raise = b.indexOf("RAISE NOTICE '[rebuild] % in mode=%");
  assert.ok(terminal > 0 && upd > terminal && raise > upd, "after the terminal UPDATE, before the NOTICE");
  assert.match(b, /clock_timestamp\(\) \+ make_interval\(mins => c\.gap\)/);
  assert.match(b, /WHERE v_cycle_closed AND l\.id = v_log_id AND l\.status = 'complete' AND c\.gap > 0;/,
    "only the cycle-closing COMPLETE row (crawl_gate's cooldown clock), only when the gap > 0");
});

// ---------------------------------------------------------------------------
// (2) the invariants
// ---------------------------------------------------------------------------

test("(2) both dispatcher bodies keep B1's header, ownership and grants; no statement_timeout anywhere", () => {
  const src = N2();
  const code = stripComments(src);
  for (const name of ["dispatch_one_unit", "get_dispatcher_status"]) {
    assert.equal(headerOf(src, name).replace(/\s+/g, " "), headerOf(B1(), name).replace(/\s+/g, " "), `${name}: B1's header verbatim`);
  }
  assert.match(code, /ALTER FUNCTION public\.dispatch_one_unit\(text\) OWNER TO postgres;/);
  assert.match(code, /GRANT EXECUTE ON FUNCTION public\.dispatch_one_unit\(text\) TO service_role;/);
  assert.match(code, /ALTER FUNCTION public\.get_dispatcher_status\(\) OWNER TO postgres;/);
  assert.match(code, /GRANT EXECUTE ON FUNCTION public\.get_dispatcher_status\(\) TO service_role;/);
  for (const name of ["dispatch_one_unit", "get_dispatcher_status", "consume_gha_dispatch_request", "prod_op_gate"]) {
    assert.doesNotMatch(headerOf(src, name), /statement_timeout/, `${name}: no statement_timeout proconfig (check:proconfig)`);
  }
  assert.doesNotMatch(definition(src, "run_entity_connections_rebuild", "PROCEDURE").split(/\nAS \$/)[0] as string, /\bSET\b/,
    "the ec procedure keeps no SET clause (it COMMITs)");
  assert.doesNotMatch(code, /CREATE OR REPLACE FUNCTION public\.crawl_gate\(/, "crawl_gate is not touched");
});

test("(2) consume_gha_dispatch_request: SECURITY DEFINER, service_role only, moves only an unconsumed request", () => {
  const src = N2();
  const h = headerOf(src, "consume_gha_dispatch_request");
  assert.match(h, /SECURITY DEFINER/);
  assert.match(h, /SET search_path TO 'public', 'pg_catalog'/);
  const b = bodyOf(src, "consume_gha_dispatch_request");
  assert.match(b, /WHERE key = 'gha_dispatch_request_' \|\| p_stem\s+AND value->>'consumed_at' IS NULL/);
  assert.match(b, /p_outcome NOT IN \('dispatched', 'refused', 'error'\)/);
  const code = stripComments(src);
  assert.match(code, /REVOKE ALL ON FUNCTION public\.consume_gha_dispatch_request\(text, text, integer\) FROM PUBLIC, anon, authenticated;/);
  assert.match(code, /GRANT EXECUTE ON FUNCTION public\.consume_gha_dispatch_request\(text, text, integer\) TO service_role;/);
});

// ---------------------------------------------------------------------------
// (3) the hunks, by anchor
// ---------------------------------------------------------------------------

test("(3) GHA admission: github_actions only when unit_call is gha-dispatch:<stem>; yielding rows are looped last", () => {
  const b = bodyOf(N2(), "dispatch_one_unit");
  assert.match(b, /WHERE \(j\.runner = 'pg_cron'\s+OR \(j\.runner = 'github_actions' AND j\.unit_call ~ '\^gha-dispatch:\[a-z0-9-\]\+\$'\)\)\s+AND j\.deadline_rule NOT LIKE 'at %'/);
  assert.match(b, /ORDER BY cardinality\(j\.yield_to\) > 0, j\.priority, j\.job/);
});

test("(3) the by window: due only inside [slot, slot + window); past it the next slot", () => {
  const b = bodyOf(N2(), "dispatch_one_unit");
  assert.match(b, /THEN CASE WHEN r\.by_window_minutes IS NOT NULL\s+AND v_now >= v_slot_prev \+ make_interval\(mins => r\.by_window_minutes\)\s+THEN v_slot_next - v_now\s+ELSE v_slot_prev - v_now END\s+ELSE v_slot_next - v_now END;/);
});

test("(3) the GHA arm writes the request stamp, no one-shot and no budget row, and exits before the pg_cron ARM", () => {
  const b = bodyOf(N2(), "dispatch_one_unit");
  const gha = b.indexOf("IF v_pick_call ~ '^gha-dispatch:[a-z0-9-]+$' THEN");
  const fire = b.indexOf("v_fire := date_trunc('minute', v_now + interval '60 seconds');");
  assert.ok(gha > 0 && fire > gha);
  const block = b.slice(gha, fire);
  assert.match(block, /INSERT INTO public\.pipeline_state \(key, value, updated_at\)[\s\S]*ON CONFLICT \(key\) DO UPDATE SET value = EXCLUDED\.value, updated_at = now\(\);/);
  assert.match(block, /'consumed_at', NULL/);
  assert.match(block, /v_armed_name := v_req_key;/);
  assert.match(block, /EXIT body;/);
  assert.doesNotMatch(block, /cron\.schedule|cron_job_budget/);
  assert.equal((b.match(/cron\.schedule\(/g) ?? []).length, 1, "only B1's ARM schedules");
  assert.match(b, /IF v_decision = 'armed' AND v_req_key IS NOT NULL THEN\s+UPDATE public\.pipeline_state\s+SET value = value \|\| jsonb_build_object\('dispatch_log_id', v_row\.id\)/);
});

test("(3) the GHA reap: before the box, keyed on unreaped stamps; the outcomes and their order", () => {
  const b = bodyOf(N2(), "dispatch_one_unit");
  const reap = b.indexOf("JOIN public.pipeline_state ps\n              ON ps.key = 'gha_dispatch_request_'");
  const box = b.indexOf("v_box := public.box_is_saturated(");
  assert.ok(reap > 0 && box > reap, "3b runs before the box skip, every tick");
  const block = b.slice(reap, box);
  const order = [
    "IF v_g_status IN ('refused', 'error') THEN",
    "ELSIF COALESCE(v_g_running, false) THEN",
    "ELSIF v_g_phase = c_gha_tail THEN",
    "ELSIF v_g_end IS NOT NULL AND v_g_end < v_now - c_gha_quiet THEN",
    "ELSIF v_g_first IS NULL AND v_g_status IS NULL AND v_now > r.req_at + c_gha_fire_lapse THEN",
    "ELSIF v_g_first IS NULL AND v_now > r.req_at + make_interval(secs => COALESCE(r.budget_seconds, 18000)) THEN",
  ].map((s) => block.indexOf(s));
  assert.ok(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1]!)), `the outcome chain in order: ${order.join(",")}`);
  assert.match(block, /v_g_why := CASE WHEN v_g_st = 'failed' THEN 'failed: GHA ' \|\| c_gha_tail \|\| ' failed'\s+ELSE 'succeeded: GHA' END;/);
  assert.match(block, /v_g_ms {2}:= round\(EXTRACT\(epoch FROM \(v_g_end - v_g_first\)\) \* 1000\)::int;/);
  assert.match(block, /v_g_dec := 'missed';/);
  assert.match(block, /v_gha_jobs {2}:= v_gha_jobs {2}\|\| r\.job;/, "a live request is an occupant");
  assert.match(b, /c_gha_fire_lapse CONSTANT interval := interval '20 minutes';/);
  assert.match(b, /c_gha_quiet {3}CONSTANT interval := interval '10 minutes';/);
  assert.match(b, /c_gha_tail {4}CONSTANT text {5}:= 'enrichment-tail';/);
  assert.match(b, /v_armed_jobs {2}:= v_armed_jobs {2}\|\| v_gha_jobs;/, "the census sees them");
});

test("(3) the sweep: clearGuardedHolds' SQL verbatim, only when no session is HELD, never a human hold", () => {
  const src = N2();
  const b = bodyOf(src, "dispatch_one_unit");
  const ts = read(path.join(ROOT, "packages", "data", "src", "lib", "prod-session.ts"));
  const note = /export const SESSION_HOLD_NOTE =\s+"([^"]+)" \+\s+"([^"]+)";/.exec(ts)!;
  assert.ok(note, "SESSION_HOLD_NOTE readable");
  assert.ok(src.includes(`c_sweep_note  CONSTANT text     := '${note[1]}${note[2]}';`), "the note constant is the TS constant");
  assert.match(b, /AND NOT COALESCE\(\(public\.prod_session_state\(\)->>'held'\)::boolean, true\) THEN/, "keyed on the lock, fail-closed");
  assert.match(b, /UPDATE public\.rollup_watch_overrides\s+SET held_since = NULL, hold_reason = NULL, updated_at = now\(\)\s+WHERE hold_reason LIKE 'prod session held: %';/);
  assert.match(b, /DELETE FROM public\.rollup_watch_overrides\s+WHERE note = c_sweep_note AND held_since IS NULL AND retired_at IS NULL AND cadence_hours IS NULL;/);
  assert.match(b, /DELETE FROM public\.pipeline_state WHERE key = 'prod_session';/);
  assert.match(b, /format\('; swept %s hold\(s\)', v_swept\)/);
});

test("(3) the yield: after cooldown / live / io, before group busy; ± the lead; only a looped peer", () => {
  const b = bodyOf(N2(), "dispatch_one_unit");
  const live = b.indexOf("v_why := 'live';");
  const io = b.indexOf("v_why := 'io: vacuum live (' || v_vacuum_live || ')';");
  const y = b.indexOf("ELSIF v_yield IS NOT NULL THEN\n            v_why := v_yield;");
  const group = b.indexOf("v_why := 'group busy: ' || r.exclusion_group;");
  assert.ok(live > 0 && io > live && y > io && group > y, "cooldown → live → io: → yield → group busy");
  assert.match(b, /WHERE v_ttds \? y\.job\s+AND \(y\.job = ANY \(v_live_jobs\)\s+OR abs\(EXTRACT\(epoch FROM \(v_ttds->>y\.job\)::interval\)\) <= r\.yield_lead_seconds\)/);
  assert.match(b, /format\('yield: %s live', y\.job\)/);
  assert.match(b, /format\('yield: %s due in %s', y\.job, date_trunc\('second', \(v_ttds->>y\.job\)::interval\)\)/);
  assert.match(b, /v_ttds := v_ttds \|\| jsonb_build_object\(r\.job, v_ttd\);/);
});

test("(3) next_due_at: one read with v_last; GREATEST(last + interval, next_due_at); a malformed value is ignored", () => {
  const b = bodyOf(N2(), "dispatch_one_unit");
  assert.match(b, /SELECT l\.completed_at, l\.metadata->>'next_due_at' INTO v_last, v_next_due\s+FROM public\.data_sync_log l\s+WHERE l\.pipeline = r\.pipeline AND l\.status IN \('complete', 'partial'\)\s+AND l\.completed_at IS NOT NULL\s+ORDER BY l\.completed_at DESC\s+LIMIT 1;/);
  assert.equal((b.match(/GREATEST\((r\.phase_due_at|v_last) \+ v_iv,\s+CASE WHEN v_next_due ~ '\^\\d\{4\}-\\d\\d-\\d\\d\[ T\]' THEN v_next_due::timestamptz END\) - v_now/g) ?? []).length, 2);
  assert.match(b, /v_next_due := NULL;/, "reset per row");
});

test("(3) the I6 ladder counts a GHA reap by its request key", () => {
  const b = bodyOf(N2(), "dispatch_one_unit");
  assert.match(b, /IF r\.runner = 'github_actions' THEN\s+SELECT count\(\*\), max\(x\.ticked_at\), \(array_agg\(x\.reason ORDER BY x\.ticked_at DESC\)\)\[1\]\s+INTO v_cd_n, v_cd_at, v_cd_reason\s+FROM public\.dispatch_log x\s+WHERE x\.armed_jobid IS NULL AND x\.armed_jobname LIKE 'gha_dispatch_request_%'/);
});

// ---------------------------------------------------------------------------
// (4) the data edits and the read-back
// ---------------------------------------------------------------------------

test("(4) the data edits match on exact old values", () => {
  const code = stripComments(N2());
  assert.match(code, /WHERE job = 'nightly' AND deadline_rule = 'at 0 21 \* \* \*';/);
  assert.match(code, /SET deadline_rule {5}= 'by 0 21 \* \* \*',\s+by_window_minutes = 120,\s+idempotent_refire = true,/);
  assert.match(code, /WHERE job IN \('ec-crawl', 'fe-crawl'\) AND gates = '\{prod_session,blackout\}';/);
  assert.match(code, /yield_to {11}= '\{rule-taggers-daily,refresh-derived-mvs-daily\}',\s+yield_lead_seconds = 1800,/);
  assert.match(code, /WHERE key = 'ec_crawl' AND value->'blackout' = '\[\{"from": "05:45", "to": "09:00"\}\]'::jsonb;/);
  assert.match(code, /AND value->'yield_to' = '\[\{"job": "refresh-derived-mvs-daily", "lead_s": 1800, "pipeline": "refresh_derived_mvs"\},\s+\{"job": "rule-taggers-daily", "lead_s": 1800, "pipeline": "run_rule_taggers"\}\]'::jsonb;/);
  assert.match(code, /ADD COLUMN IF NOT EXISTS by_window_minutes {2}int,\s+ADD COLUMN IF NOT EXISTS yield_to {11}text\[\] NOT NULL DEFAULT '\{\}',\s+ADD COLUMN IF NOT EXISTS yield_lead_seconds int {4}NOT NULL DEFAULT 0;/);
  assert.match(code, /CHECK \(by_window_minutes > 0\)/);
  assert.doesNotMatch(code, /ALTER TABLE public\.dispatch_log/, "no dispatch_log column: armed_jobname carries the request key");
});

test("(4) the read-back RAISEs on a miss and prints the new md5s", () => {
  const code = stripComments(N2());
  assert.match(code, /RAISE EXCEPTION '\[fix1336\] read-back failed: %'/);
  assert.match(code, /RAISE NOTICE '\[fix1336\] md5 dispatch_one_unit % \/ get_dispatcher_status %'/);
  assert.match(code, /RAISE NOTICE '\[fix1336\] md5 prod_op_gate % \/ run_entity_connections_rebuild %'/);
  assert.match(code, /IF \(v_reg->>'eligible'\)::int IS DISTINCT FROM v_pg_elig \+ 1 THEN/);
  assert.match(code, /IF public\.in_blackout\('ec_crawl', '2026-10-23 06:00Z'\) THEN/);
  assert.match(code, /v_gate := public\.prod_op_gate\(600, '2026-10-23 06:00:00Z'\);/);
  assert.match(code, new RegExp(`v_md5_d = '${B1_MD5.dispatch_one_unit}'`), "the B1 body must have moved");
  assert.match(code, new RegExp(`v_md5_g = '${B1_MD5.get_dispatcher_status}'`));
});

// ---------------------------------------------------------------------------
// (5) the reverts
// ---------------------------------------------------------------------------

test("(5) the dispatcher revert: the B1 pair verbatim, the rows and config back, the B1 md5s asserted", () => {
  const src = script("fix1336-revert-dispatcher-n2.sql");
  assert.equal(md5(prosrc(src, "dispatch_one_unit")), B1_MD5.dispatch_one_unit);
  assert.equal(md5(prosrc(src, "get_dispatcher_status")), B1_MD5.get_dispatcher_status);
  const code = stripComments(src);
  assert.match(code, /SET deadline_rule = 'at 0 21 \* \* \*', by_window_minutes = NULL, idempotent_refire = false,/);
  assert.match(code, /SET gates = '\{prod_session,blackout\}', yield_to = '\{\}', yield_lead_seconds = 0,/);
  assert.match(code, /jsonb_set\(value, '\{blackout\}', '\[\{"from": "05:45", "to": "09:00"\}\]'::jsonb\)/);
  assert.match(code, new RegExp(`v_d IS DISTINCT FROM '${B1_MD5.dispatch_one_unit}' OR v_g IS DISTINCT FROM '${B1_MD5.get_dispatcher_status}'`));
  assert.match(code, /^BEGIN;$/m);
  assert.match(code, /^COMMIT;$/m);
  assert.doesNotMatch(code, /UPDATE\s+public\.platform_dials/i, "pause is set by hand, never by the payload");
});

test("local: when N2 is applied, the live bodies are this file's (the ec procedure's pin moved here from work-mem-allowances)", async (t) => {
  const { Client } = await import("pg");
  const c = new Client({
    connectionString: process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    connectionTimeoutMillis: 2500,
  });
  try {
    await c.connect();
  } catch {
    t.skip("local Docker DB unreachable");
    return;
  }
  try {
    const has = await c.query("SELECT 1 FROM pg_proc WHERE proname = 'consume_gha_dispatch_request' AND pronamespace = 'public'::regnamespace");
    if (has.rowCount === 0) {
      t.skip("FIX-1336 not applied on this DB");
      return;
    }
    const src = N2();
    for (const [name, regproc, kind] of [
      ["dispatch_one_unit", "public.dispatch_one_unit(text)", "FUNCTION"],
      ["get_dispatcher_status", "public.get_dispatcher_status()", "FUNCTION"],
      ["prod_op_gate", "public.prod_op_gate(integer, timestamptz)", "FUNCTION"],
      ["run_entity_connections_rebuild", "public.run_entity_connections_rebuild(text, integer)", "PROCEDURE"],
    ] as const) {
      const r = await c.query<{ s: string; cfg: string[] | null }>(
        `SELECT prosrc AS s, proconfig AS cfg FROM pg_proc WHERE oid = '${regproc}'::regprocedure`);
      const live = r.rows[0]?.s.replace(/\r\n/g, "\n");
      // 20261025000000 (cc-247, FIX-1342) replaced prod_op_gate; its pin is
      // prod-op-gate-recut.test.ts. Either body passes here, nothing else.
      if (name === "prod_op_gate") assert.ok([GATE_N2_MD5, GATE_RECUT_MD5].includes(md5(live ?? "")), `${name} live body is neither N2's nor FIX-1342's`);
      // 20261027000000 (cc-251, FIX-1354) replaced these two; either body passes, nothing else.
      else if (R4_MD5[name] !== undefined && md5(live ?? "") === R4_MD5[name]) continue;
      else assert.equal(live, prosrc(src, name, kind), `${name} live body is neither the N2 file's nor FIX-1354's`);
      if (kind === "PROCEDURE") assert.equal(r.rows[0]?.cfg, null, `${name} COMMITs; proconfig must stay NULL`);
    }
  } finally {
    await c.end();
  }
});

test("(5) the prod_op_gate and ec reverts carry their old bodies verbatim and assert the md5", () => {
  const g = script("fix1336-revert-prod-op-gate.sql");
  assert.equal(md5(prosrc(g, "prod_op_gate")), GATE_MD5);
  assert.match(stripComments(g), new RegExp(`v IS DISTINCT FROM '${GATE_MD5}'`));
  const e = script("fix1330-revert-ec-rebuild-next-due.sql");
  assert.equal(md5(prosrc(e, "run_entity_connections_rebuild", "PROCEDURE")), EC_MD5);
  assert.match(stripComments(e), new RegExp(`v IS DISTINCT FROM '${EC_MD5}'`));
});
