/**
 * cc-239 — dispatcher B1: the first change to the pick's BODY since M1
 * (`*_fix1329_dispatcher_b1.sql`): one VACUUM at a time (FIX-1322), the
 * per-row phase lock (FIX-1323), a NULL floor anchor is due (FIX-1326), `by`
 * reads daily / weekly / monthly slots (FIX-1329), every due row not armed in
 * dispatch_log.excluded (FIX-1333), the cooldown honours a unit's own
 * backoff_until (FIX-1332).
 *
 * Runs via:  tsx --test src/__tests__/dispatcher-b1.test.ts
 *
 * dispatcher-m1.test.ts reads only `*_fix1316_return_donor_rollup_refresh.sql`,
 * so it keeps passing against M1's text whatever replaces it later. This file
 * anchors the B1 body (rule 305; no DB, run in CI; rule 105):
 *   - nothing else moved: an LCS line diff of each body against M1 removes
 *     exactly the lines the hunks touch, and adds a pinned number;
 *   - the invariants M1 pinned are unchanged (SECURITY DEFINER, the cron
 *     search_path, one SET clause, the grants);
 *   - each hunk's shape, by anchor;
 *   - the slot functions: the three regexes, no SET clause, the wrapper;
 *   - the revert pairs the migration (the M1 bodies verbatim, the M1 md5s).
 * Behavioural, against the local clone when the migration is applied there:
 * the slot functions on fixed instants. Skips when unreachable or unmigrated.
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
const B1 = () => one("_fix1329_dispatcher_b1.sql");
const M1 = () => one("_fix1316_return_donor_rollup_refresh.sql");
const YIELD = () => one("_fix1124_crawl_yield_to_peers.sql");
const REVERT_B1 = () => read(path.join(ROOT, "scripts", "fix1329-revert-dispatcher-b1.sql"));

/** dispatch_one_unit's added lines vs M1 (the hunks, nothing else). */
const ADDED_DISPATCH_LINES = 129;
const M1_MD5 = { dispatch_one_unit: "98660b34c17c5c537fc3d2e03d021440", get_dispatcher_status: "4c9d0eb0cd85f9f46b38a9947cc94785" };

/** One routine's definition: CREATE through its closing dollar-quote. */
function definition(src: string, name: string): string {
  const i = src.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  assert.notEqual(i, -1, `${name} is defined`);
  const tag = /AS (\$[a-z_]*\$)\n/.exec(src.slice(i))!;
  const a = i + tag.index + tag[0].length;
  return src.slice(i, src.indexOf(tag[1]!, a));
}
const headerOf = (src: string, name: string) => definition(src, name).split(/\nAS \$/)[0] as string;
const rawBody = (src: string, name: string) => definition(src, name).split(/\nAS \$[a-z_]*\$\n/)[1] as string;
const bodyOf = (src: string, name: string) => stripComments(rawBody(src, name));
/** md5 of the text pg_proc.prosrc will hold: everything between the dollar-quotes. */
function prosrcMd5(src: string, name: string): string {
  const i = src.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const a = src.indexOf("AS $function$", i) + "AS $function$".length;
  return crypto.createHash("md5").update(src.slice(a, src.indexOf("$function$", a))).digest("hex");
}

/** The old lines an LCS line diff removes, and the new lines it adds. */
function lineDiff(oldText: string, newText: string): { removed: string[]; added: string[] } {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
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
// (1) nothing else moved
// ---------------------------------------------------------------------------

test("(1) the base is M1 verbatim: the M1 file's bodies hash to the md5 pair prod carried at cc-239 read 3", () => {
  const m1 = M1();
  assert.equal(prosrcMd5(m1, "dispatch_one_unit"), M1_MD5.dispatch_one_unit);
  assert.equal(prosrcMd5(m1, "get_dispatcher_status"), M1_MD5.get_dispatcher_status);
});

test("(1) dispatch_one_unit's LCS diff against M1 removes only the hunk-touched lines", () => {
  const d = lineDiff(rawBody(M1(), "dispatch_one_unit"), rawBody(B1(), "dispatch_one_unit"));
  assert.deepEqual(d.removed.map((l) => l.trim()), [
    // D-d: the by branch's daily-only read and its 1-day shortcut
    "v_slot_next := public.cron_next_daily(substring(r.deadline_rule FROM '^by\\s+(.+)$'), v_now);",
    "IF v_slot_next IS NULL THEN",
    "v_bad := 'by: not a daily-form schedule (cron_next_daily reads M H * * * only)';",
    "v_slot_prev := CASE WHEN v_slot_next = v_now THEN v_slot_next",
    "ELSE v_slot_next - interval '1 day' END;",
    // D-b / D-c: the dead_tuples terms, split apart
    "v_ttd := LEAST(",
    "CASE WHEN v_dead >= v_trigger * v_m[1]::numeric / 100",
    "THEN interval '-1 second' END,",
    "CASE WHEN v_m[2] IS NOT NULL AND v_lastvac IS NOT NULL",
    "THEN (v_lastvac + v_m[2]::interval) - v_now END);",
    // D-f: the cooldown's reason becomes the ELSIF after `backoff:`
    "IF v_cd_until > v_now THEN",
    // D-e: the final INSERT gains `excluded`
    "armed_jobid, armed_jobname, armed_for, runid_floor)",
    "v_armed_id, v_armed_name, v_armed_for, v_floor)",
  ]);
  // The added side, pinned: the declarations, the D-a occupant read, the
  // loop's two columns, the per-row resets, the phase-lock block, the
  // stale_after / by / dead_tuples terms, the D-f block, the io: branch, the
  // D-e appends, the ARM UPDATE, the error reset and the INSERT. A change
  // anywhere else in the body moves this number.
  assert.equal(d.added.length, ADDED_DISPATCH_LINES, d.added.join("\n"));
});

test("(1) get_dispatcher_status differs from M1 by the last_excluded key only", () => {
  const g = lineDiff(rawBody(M1(), "get_dispatcher_status"), rawBody(B1(), "get_dispatcher_status"));
  assert.deepEqual(g.removed.map((l) => l.trim()), [
    "SELECT l.ticked_at, l.source, l.decision, l.job, l.reason INTO v_last",
  ]);
  assert.deepEqual(g.added.map((l) => l.trim()), [
    "SELECT l.ticked_at, l.source, l.decision, l.job, l.reason, l.excluded INTO v_last",
    "'last_excluded',      v_last.excluded,",
  ]);
});

// ---------------------------------------------------------------------------
// (2) the invariants M1 pinned
// ---------------------------------------------------------------------------

test("(2) both bodies keep SECURITY DEFINER, the cron search_path, one SET clause, postgres ownership and the grants", () => {
  const src = B1();
  const code = stripComments(src);
  for (const name of ["dispatch_one_unit", "get_dispatcher_status"]) {
    const h = headerOf(src, name);
    assert.equal(h.replace(/\s+/g, " "), headerOf(M1(), name).replace(/\s+/g, " "), `${name}: M1's header verbatim`);
    assert.match(h, /\bSECURITY DEFINER\b/, name);
    assert.match(h, /SET search_path TO 'public', 'pg_catalog', 'cron'/, name);
    assert.equal((h.match(/^\s*SET /gm) ?? []).length, 1, `${name}: one SET clause, never statement_timeout`);
  }
  assert.match(code, /ALTER FUNCTION public\.dispatch_one_unit\(text\) OWNER TO postgres;/);
  assert.match(code, /REVOKE ALL ON FUNCTION public\.dispatch_one_unit\(text\) FROM PUBLIC, anon, authenticated;/);
  assert.match(code, /GRANT EXECUTE ON FUNCTION public\.dispatch_one_unit\(text\) TO service_role;/);
  assert.match(code, /ALTER FUNCTION public\.get_dispatcher_status\(\) OWNER TO postgres;/);
  assert.match(code, /REVOKE ALL ON FUNCTION public\.get_dispatcher_status\(\) FROM PUBLIC, anon, authenticated;/);
  assert.match(code, /GRANT EXECUTE ON FUNCTION public\.get_dispatcher_status\(\) TO service_role;/);
  assert.doesNotMatch(code, /statement_timeout/, "check:proconfig — the migration carries no statement_timeout");
});

// ---------------------------------------------------------------------------
// (3) D-a — one VACUUM at a time
// ---------------------------------------------------------------------------

test("(3) D-a: the io: branch sits between live and group busy and keys on the VACUUM unit_call, never on cost_class", () => {
  const b = bodyOf(B1(), "dispatch_one_unit");
  const live = b.indexOf("v_why := 'live';");
  const io = b.indexOf("ELSIF r.unit_shape = 'bare' AND r.unit_call ~* '^\\s*VACUUM' AND v_vacuum_live IS NOT NULL THEN");
  const group = b.indexOf("v_why := 'group busy: ' || r.exclusion_group;");
  assert.ok(live > 0 && io > live && group > io, "live → io: → group busy");
  assert.match(b, /v_why := 'io: vacuum live \(' \|\| v_vacuum_live \|\| '\)';/);
  assert.doesNotMatch(b, /cost_class/, "the pick never reads cost_class (fe-crawl is io too)");
});

test("(3) D-a: the occupant is read once per tick — pg_stat_progress_vacuum for this database, else an armed VACUUM one-shot", () => {
  const b = bodyOf(B1(), "dispatch_one_unit");
  const census = b.indexOf("v_held := COALESCE((public.prod_session_state()->>'held')::boolean, true);");
  const occ = b.indexOf("FROM pg_stat_progress_vacuum p\n          LEFT JOIN pg_class c ON c.oid = p.relid");
  const loop = b.indexOf("FOR r IN\n          SELECT j.job, j.pipeline, j.unit_shape");
  assert.ok(census > 0 && occ > census && loop > occ, "after the census, before the pick loop — once, not per row");
  assert.match(b, /SELECT 'vacuum:' \|\| COALESCE\(c\.relname::text, p\.relid::text, 'pid ' \|\| p\.pid\)\s+INTO v_vacuum_live/);
  assert.match(b, /WHERE p\.datname = current_database\(\)\s+ORDER BY p\.pid\s+LIMIT 1;/);
  assert.match(b, /IF v_vacuum_live IS NULL THEN\s+SELECT j\.job INTO v_vacuum_live\s+FROM public\.job_registry j\s+WHERE j\.job = ANY \(v_armed_jobs\) AND j\.unit_call ~\* '\^\\s\*VACUUM'/);
});

// ---------------------------------------------------------------------------
// (4) D-b — the per-row phase lock
// ---------------------------------------------------------------------------

test("(4) D-b: the phase-lock read is gated on r.phase_lock AND r.phase_due_at IS NOT NULL and the window is 4 ticks", () => {
  const b = bodyOf(B1(), "dispatch_one_unit");
  assert.match(b, /SELECT j\.job, j\.pipeline, j\.unit_shape, j\.unit_call, j\.priority, j\.deadline_rule,\s+j\.cap_mb, j\.exclusion_group, j\.budget_seconds, j\.gates,\s+j\.phase_lock, j\.phase_due_at,/);
  const gate = b.indexOf("IF r.phase_lock AND r.phase_due_at IS NOT NULL THEN");
  assert.ok(gate > 0);
  const block = b.slice(gate, b.indexOf("BEGIN\n            IF r.deadline_rule LIKE 'stale_after %' THEN", gate));
  assert.match(block, /SELECT max\(l\.started_at\) INTO v_adv_start\s+FROM public\.data_sync_log l\s+WHERE l\.pipeline = r\.pipeline AND l\.status IN \('complete', 'partial'\)\s+AND l\.completed_at = v_last;/,
    "a pipeline row: the start of the row v_last came from");
  assert.match(block, /SELECT x\.armed_for INTO v_adv_start\s+FROM public\.dispatch_log x[\s\S]*?x\.reason LIKE 'succeeded%'\s+ORDER BY x\.ticked_at DESC\s+LIMIT 1;/,
    "a bare row: the newest reaped succeeded one-shot's armed_for");
  assert.match(block, /v_locked := COALESCE\(v_adv_start >= r\.phase_due_at\s+AND v_adv_start < r\.phase_due_at \+ make_interval\(secs => 4 \* v_dials\.tick_seconds\),\s+false\);/);
  assert.match(b, /v_locked := false;/, "reset per row");
});

test("(4) D-b: a locked stale_after / floor anchors to phase_due_at; otherwise the fixed-delay form", () => {
  const b = bodyOf(B1(), "dispatch_one_unit");
  assert.match(b, /v_ttd := CASE WHEN v_last IS NULL THEN interval '-1 second'\s+WHEN v_locked THEN \(r\.phase_due_at \+ v_iv\) - v_now\s+ELSE \(v_last \+ v_iv\) - v_now END;/);
  assert.match(b, /WHEN v_locked THEN \(r\.phase_due_at \+ v_m\[2\]::interval\) - v_now\s+ELSE \(v_lastvac \+ v_m\[2\]::interval\) - v_now END;/);
});

test("(4) D-b: ARM writes phase_due_at only for a locked stale_after / floor arm, only on change, after cron.schedule", () => {
  const b = bodyOf(B1(), "dispatch_one_unit");
  const sched = b.indexOf("v_armed_id := cron.schedule(v_armed_name, v_sched, v_pick_call);");
  const upd = b.indexOf("UPDATE public.job_registry\n           SET phase_due_at = ");
  assert.ok(sched > 0 && upd > sched);
  assert.match(b, /SET phase_due_at = CASE WHEN v_pick_lock AND v_pick_term IN \('stale_after', 'floor'\)\s+THEN v_now \+ v_pick_ttd END\s+WHERE job = v_pick_job\s+AND phase_due_at IS DISTINCT FROM \(CASE WHEN v_pick_lock AND v_pick_term IN \('stale_after', 'floor'\)\s+THEN v_now \+ v_pick_ttd END\);/);
  assert.equal((b.match(/UPDATE public\.job_registry/g) ?? []).length, 1, "the only registry write in the body");
  assert.match(b, /v_pick_term   := v_term;\s+v_pick_lock   := r\.phase_lock;/);
  // the terms: by and pct never lock
  assert.match(b, /v_term := CASE WHEN v_last IS NULL THEN 'null_anchor' ELSE 'stale_after' END;/);
  assert.match(b, /v_term := 'by';/);
  assert.match(b, /THEN CASE WHEN v_lastvac IS NULL THEN 'null_anchor' ELSE 'floor' END\s+WHEN v_pct_ttd IS NOT NULL THEN 'pct' END;/);
});

// ---------------------------------------------------------------------------
// (5) D-c — a NULL floor anchor is due
// ---------------------------------------------------------------------------

test("(5) D-c: a dead_tuples floor with no anchor yields interval '-1 second'", () => {
  const b = bodyOf(B1(), "dispatch_one_unit");
  assert.match(b, /v_floor_ttd := CASE WHEN v_m\[2\] IS NULL THEN NULL\s+WHEN v_lastvac IS NULL THEN interval '-1 second'/);
  assert.match(b, /v_ttd := LEAST\(v_pct_ttd, v_floor_ttd\);/);
  assert.doesNotMatch(b, /v_m\[2\] IS NOT NULL AND v_lastvac IS NOT NULL/, "the old NULL-anchor exclusion is gone");
});

// ---------------------------------------------------------------------------
// (6) D-d — the slot functions
// ---------------------------------------------------------------------------

const RE_DAILY = "'^\\d+ \\d+ \\* \\* \\*$'";
const RE_WEEKLY = "'^\\d+ \\d+ \\* \\* [0-6]$'";
const RE_MONTHLY = "'^\\d+ \\d+ ([1-9]|1\\d|2[0-8]) \\* \\*$'";

test("(6) D-d: cron_next_slot / cron_prev_slot carry exactly the three regexes, LANGUAGE sql, STABLE, no SET clause", () => {
  const src = B1();
  for (const name of ["cron_next_slot", "cron_prev_slot"]) {
    const h = headerOf(src, name);
    assert.match(h, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(p_schedule text, p_now timestamptz\\)`));
    assert.match(h, /LANGUAGE sql/);
    assert.match(h, /\bSTABLE\b/);
    assert.doesNotMatch(h, /\bSET\b/, `${name}: no SET clause (inlinable)`);
    assert.doesNotMatch(h, /SECURITY DEFINER/);
    const b = bodyOf(src, name);
    for (const re of [RE_DAILY, RE_WEEKLY, RE_MONTHLY]) assert.ok(b.includes(`p_schedule ~ ${re}`), `${name} carries ${re}`);
    assert.equal((b.match(/p_schedule ~ /g) ?? []).length, 3, `${name}: no other form is accepted`);
    assert.match(b, /split_part\(p_schedule, ' ', 1\)::numeric <= 59\s+AND split_part\(p_schedule, ' ', 2\)::numeric <= 23/);
    assert.doesNotMatch(b, /\(SELECT/, `${name}: no sub-select (a SubLink blocks inlining)`);
    assert.match(b, /AT TIME ZONE 'UTC'/);
  }
  // the regexes refuse lists, ranges and steps
  for (const re of [RE_DAILY, RE_WEEKLY, RE_MONTHLY].map((r) => new RegExp(r.slice(1, -1)))) {
    for (const bad of ["0 9,12 * * *", "*/15 * * * *", "0 16 * * 1-5", "0 16 1,15 * *", "0 16 29 * *", "0 16 * * 7"]) {
      assert.doesNotMatch(bad, re, `${bad} refused`);
    }
  }
});

test("(6) D-d: cron_next_daily is a daily-only wrapper over cron_next_slot with its 20261004075000 header", () => {
  const src = B1();
  assert.equal(headerOf(src, "cron_next_daily").replace(/\s+/g, " "), headerOf(YIELD(), "cron_next_daily").replace(/\s+/g, " "));
  const b = bodyOf(src, "cron_next_daily");
  assert.match(b, /IF p_schedule IS NULL OR p_schedule !~ '\^\\d\+ \\d\+ \\\* \\\* \\\*\$' THEN\s+RETURN NULL;\s+END IF;\s+RETURN public\.cron_next_slot\(p_schedule, p_now\);/);
});

test("(6) D-d: the by branch reads cron_prev_slot / cron_next_slot and names the three forms when it refuses", () => {
  const b = bodyOf(B1(), "dispatch_one_unit");
  assert.match(b, /v_slot_prev := public\.cron_prev_slot\(substring\(r\.deadline_rule FROM '\^by\\s\+\(\.\+\)\$'\), v_now\);/);
  assert.match(b, /v_slot_next := public\.cron_next_slot\(substring\(r\.deadline_rule FROM '\^by\\s\+\(\.\+\)\$'\), v_now\);/);
  assert.match(b, /IF v_slot_prev IS NULL OR v_slot_next IS NULL THEN\s+v_bad := 'by: unsupported schedule \(daily M H \* \* \*, weekly M H \* \* D, monthly M H D \* \* only\)';/);
  assert.match(b, /v_ttd := CASE WHEN v_last IS NULL OR v_last < v_slot_prev\s+THEN v_slot_prev - v_now\s+ELSE v_slot_next - v_now END;/, "I3 unchanged in meaning");
  assert.doesNotMatch(b, /cron_next_daily/);
  assert.doesNotMatch(b, /interval '1 day'/, "the daily shortcut is gone");
});

// ---------------------------------------------------------------------------
// (7) D-e — excluded[]; D-f — backoff_until
// ---------------------------------------------------------------------------

test("(7) D-e: every due row not armed lands in v_excluded; the final INSERT writes it; the status JSON carries last_excluded", () => {
  const src = B1();
  const b = bodyOf(src, "dispatch_one_unit");
  assert.match(b, /v_excluded    text\[\] := '\{\}';/);
  assert.match(b, /IF v_pick_job IS NOT NULL THEN\s+v_excluded := v_excluded \|\| \('queued \(' \|\| v_pick_job \|\| '\)'\);\s+END IF;\s+v_pick_job    := r\.job;/,
    "the row a better one displaces is queued");
  assert.match(b, /ELSE\s+v_excluded := v_excluded \|\| \('queued \(' \|\| r\.job \|\| '\)'\);\s+END IF;/, "an outranked row is queued");
  assert.match(b, /ELSE\s+v_excluded := v_excluded \|\| \(v_why \|\| ' \(' \|\| r\.job \|\| '\)'\);\s+IF v_blk_job IS NULL THEN/, "a blocked row keeps its reason");
  assert.match(b, /armed_jobid, armed_jobname, armed_for, runid_floor, excluded\)\s+VALUES\s+\([^;]*v_armed_id, v_armed_name, v_armed_for, v_floor, NULLIF\(v_excluded, '\{\}'\)\)/);
  assert.match(b, /v_floor      := NULL;\s+v_excluded   := '\{\}';/, "an error row logs no excluded");
  assert.match(b, /v_reason   := concat_ws\('; ',\s+CASE WHEN v_blk_job IS NOT NULL THEN v_blk_why \|\| ' \(' \|\| v_blk_job \|\| '\)' END,/, "reason keeps the single best-ranked blocker");
  assert.match(bodyOf(src, "get_dispatcher_status"), /'last_excluded',      v_last\.excluded,/);
  assert.match(stripComments(src), /ALTER TABLE public\.dispatch_log\s+ADD COLUMN IF NOT EXISTS excluded text\[\];/);
  const code = stripComments(src);
  assert.ok(code.indexOf("ALTER TABLE public.dispatch_log") < code.indexOf("ALTER TABLE public.job_registry"), "dispatch_log before job_registry — the tick's lock order");
  assert.match(code, /ALTER TABLE public\.job_registry\s+ADD COLUMN IF NOT EXISTS phase_lock boolean NOT NULL DEFAULT false,\s+ADD COLUMN IF NOT EXISTS phase_due_at timestamptz;/);
});

test("(7) D-f: inside the cooldown, a pipeline unit's own metadata.gate.backoff_until wins over the ladder", () => {
  const b = bodyOf(B1(), "dispatch_one_unit");
  const cd = b.indexOf("IF v_cd_n >= 1 THEN");
  const live = b.indexOf("v_why := 'live';");
  const block = b.slice(cd, live);
  assert.match(block, /IF r\.pipeline IS NOT NULL THEN\s+BEGIN\s+SELECT \(l\.metadata->'gate'->>'backoff_until'\)::timestamptz INTO v_cd_bo\s+FROM public\.data_sync_log l\s+WHERE l\.pipeline = r\.pipeline AND l\.status = 'skipped'\s+AND l\.started_at > COALESCE\(v_adv, '-infinity'::timestamptz\)\s+ORDER BY l\.started_at DESC\s+LIMIT 1;\s+EXCEPTION WHEN OTHERS THEN\s+v_cd_bo := NULL;\s+END;/);
  assert.match(block, /v_cd_until := GREATEST\(v_cd_bo \+ interval '60 seconds', v_now\);/);
  assert.match(block, /IF v_cd_until > v_now AND v_cd_bo IS NOT NULL THEN\s+v_why := format\('backoff: %s \(unit says until %s; %s non-advancing reap\(s\)\)',\s+r\.job, date_trunc\('second', v_cd_bo\), v_cd_n\);\s+ELSIF v_cd_until > v_now THEN\s+v_why := format\('cooldown: /);
  assert.ok(block.indexOf("v_cd_until := v_cd_at + make_interval") < block.indexOf("v_cd_bo := NULL;"), "the ladder is computed first, then overridden");
});

// ---------------------------------------------------------------------------
// (8) no scheduling, no vacuum-name loop; (10) the revert
// ---------------------------------------------------------------------------

test("(8) the body file schedules nothing outside the dispatcher's own ARM and adds no vacuum-name loop", () => {
  const src = B1();
  const outside = stripComments(src.replace(definition(src, "dispatch_one_unit"), ""));
  assert.doesNotMatch(outside, /cron\.(schedule|alter_job|unschedule)\s*\(/);
  assert.doesNotMatch(stripComments(src), /ILIKE '%vacuum%'/i);
  const b = bodyOf(src, "dispatch_one_unit");
  assert.equal((b.match(/cron\.schedule\(/g) ?? []).length, 1, "only M1's ARM");
});

test("(5) the read-back RAISEs on a miss, asserts the slot fixtures and prints the md5 pair", () => {
  const code = stripComments(B1());
  assert.match(code, /RAISE EXCEPTION '\[fix1329\] read-back failed: %'/);
  assert.match(code, /RAISE NOTICE '\[fix1329\] md5 dispatch_one_unit % \/ get_dispatcher_status %'/);
  assert.match(code, /public\.cron_next_slot\('0 16 \* \* 2', '2026-10-19 00:00Z'\) IS DISTINCT FROM '2026-10-20 16:00:00\+00'/);
  assert.match(code, /public\.cron_prev_slot\('0 16 \* \* 2', '2026-10-19 00:00Z'\) IS DISTINCT FROM '2026-10-13 16:00:00\+00'/);
  assert.match(code, /public\.cron_next_slot\('30 6 \* \* \*', '2026-10-20 06:30Z'\) IS DISTINCT FROM '2026-10-20 06:30:00\+00'/);
  assert.match(code, /public\.cron_prev_slot\('5 3 15 \* \*', '2026-10-19 00:00Z'\) IS DISTINCT FROM '2026-10-15 03:05:00\+00'/);
  assert.match(code, /public\.cron_next_slot\('0 9,12 \* \* \*', now\(\)\) IS NOT NULL/);
  assert.match(code, /public\.cron_next_slot\('\*\/15 \* \* \* \*', now\(\)\) IS NOT NULL/);
  assert.match(code, new RegExp(`v_md5_d = '${M1_MD5.dispatch_one_unit}'`), "the M1 body must have moved");
  assert.match(code, new RegExp(`v_md5_g = '${M1_MD5.get_dispatcher_status}'`));
});

test("(10) the body revert: the M1 bodies verbatim, cron_next_daily's original body, DROP the slots + columns, the M1 md5 pair asserted", () => {
  const src = REVERT_B1();
  assert.equal(prosrcMd5(src, "dispatch_one_unit"), M1_MD5.dispatch_one_unit);
  assert.equal(prosrcMd5(src, "get_dispatcher_status"), M1_MD5.get_dispatcher_status);
  assert.equal(rawBody(src, "cron_next_daily"), rawBody(YIELD(), "cron_next_daily"), "cron_next_daily's 20261004075000 body");
  const code = stripComments(src);
  assert.match(code, /DROP FUNCTION IF EXISTS public\.cron_next_slot\(text, timestamptz\);/);
  assert.match(code, /DROP FUNCTION IF EXISTS public\.cron_prev_slot\(text, timestamptz\);/);
  assert.match(code, /ALTER TABLE public\.dispatch_log DROP COLUMN IF EXISTS excluded;/);
  assert.match(code, /ALTER TABLE public\.job_registry\s+DROP COLUMN IF EXISTS phase_lock,\s+DROP COLUMN IF EXISTS phase_due_at;/);
  assert.ok(code.indexOf("CREATE OR REPLACE FUNCTION public.cron_next_daily(") < code.indexOf("DROP FUNCTION IF EXISTS public.cron_next_slot"),
    "the wrapper is replaced before the function it calls is dropped");
  assert.match(code, new RegExp(`v_md5_d IS DISTINCT FROM '${M1_MD5.dispatch_one_unit}'`));
  assert.match(code, new RegExp(`v_md5_g IS DISTINCT FROM '${M1_MD5.get_dispatcher_status}'`));
  assert.match(code, /^BEGIN;$/m);
  assert.match(code, /^COMMIT;$/m);
  assert.doesNotMatch(code, /UPDATE\s+public\.platform_dials/i, "pause is set by hand, never by the payload");
});

// ---------------------------------------------------------------------------
// Behavioural — the clone, when migrated
// ---------------------------------------------------------------------------

test("clone: the slot functions on fixed instants, and NULL for refused forms", async (t) => {
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  try {
    await c.connect();
  } catch {
    t.skip("local Docker DB unreachable");
    return;
  }
  try {
    const fn = await c.query("SELECT 1 FROM pg_proc WHERE proname = 'cron_prev_slot' AND pronamespace = 'public'::regnamespace");
    if (fn.rowCount === 0) {
      t.skip("FIX-1329 not applied on this DB");
      return;
    }
    // UTC wall time, so the session TimeZone cannot move the expected text.
    const cases: [string, string, string | null, string | null][] = [
      ["0 16 * * 2", "2026-10-19 00:00Z", "2026-10-20 16:00:00", "2026-10-13 16:00:00"],
      ["0 16 * * 2", "2026-10-20 16:00Z", "2026-10-20 16:00:00", "2026-10-20 16:00:00"],
      ["30 6 * * *", "2026-10-20 00:45Z", "2026-10-20 06:30:00", "2026-10-19 06:30:00"],
      ["5 3 15 * *", "2026-10-15 03:04Z", "2026-10-15 03:05:00", "2026-09-15 03:05:00"],
      ["0 0 1 * *", "2026-12-31 23:59Z", "2027-01-01 00:00:00", "2026-12-01 00:00:00"],
      ["0 9,12 * * *", "2026-10-19 00:00Z", null, null],
      ["*/15 * * * *", "2026-10-19 00:00Z", null, null],
      ["60 1 * * *", "2026-10-19 00:00Z", null, null],
    ];
    for (const [s, now, next, prev] of cases) {
      const r = await c.query(
        "SELECT to_char(public.cron_next_slot($1, $2::timestamptz) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS n, " +
          "to_char(public.cron_prev_slot($1, $2::timestamptz) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS p",
        [s, now],
      );
      const row = r.rows[0];
      assert.equal(row.n, next, `next ${s} @ ${now}`);
      assert.equal(row.p, prev, `prev ${s} @ ${now}`);
    }
  } finally {
    await c.end();
  }
});
