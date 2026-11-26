/**
 * cc-303 — one class-P file, a PIN MOVE:
 *   *_fix1444_fix1445_dispatcher_hold_and_restarted_run_reap.sql   (FIX-1444 + FIX-1445)
 *
 * Runs via:  tsx --test src/__tests__/dispatcher-r18.test.ts
 *
 * Text (no DB, run in CI): the body is FIX-1421's plus ONLY the fourteen hunks
 * (a line diff), each where D2 puts it; pause precedes every hold read; 4b
 * follows step 4 and its unchanged skip; the caps and windows are constants;
 * the census, the cooldown ladder, the headroom rung, step 7, the error path
 * and c_running_win are byte-equal; the guard, the read-back, the four dials,
 * the revert (FIX-1421's text) and the model manual hold.
 * Clone (CIVITICS_CLONE_TESTS=1), each inside BEGIN … ROLLBACK: dispatch_one_unit
 * takes no clock, so every fabrication is relative to clock_timestamp() — a
 * nightly request and its nightly_cron phase rows (L), a one-shot's failed run
 * as r17 fabricates one (S i), dispatch_log skip rows and a box_health probe that
 * reads fork_failures (S ii), the key by hand (D6, the ramp, manual), a run with
 * end_time NULL started before pg_postmaster_start_time() (FIX-1445), and the
 * mirror's throttle hold (D13).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PIN_LINEAGE, atCurrentPins, read, stripComments } from "./lib/migration-text";

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

function one(suffix: string): string {
  const hits = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(suffix));
  assert.equal(hits.length, 1, `expected exactly one *${suffix}, found ${hits.join(", ") || "none"}`);
  return read(path.join(MIGRATIONS, hits[0] as string));
}
const script = (f: string) => read(path.join(ROOT, "scripts", f));

const FILE = () => one("_fix1444_fix1445_dispatcher_hold_and_restarted_run_reap.sql");
const BASE = () => one("_fix1421_reap_closes_a_failed_units_running_rows.sql");
const REVERT = () => script("fix1444-revert-dispatcher-hold.sql");
const MODEL = () => script("fix1444-manual-hold-six-minutes.sql");

/** FIX-1421's body (history, the revert's target) and this file's. */
const WAS = "142869d4f55f8eae73c7dd49ceae4b7a";
const NOW = "1f001294265b03c09db34aa47311954c";
/** The three pins this file leaves where cc-267 put them. */
const PINS = {
  get_dispatcher_status: "d6bb02aab3eb8c9625275227f564c5c9",
  box_is_saturated: "b05961ca6d1cf7e56874071bfe334da1",
  prod_op_gate: "70a799ab3df2484fc424fe2762ffa797",
};

const md5 = (s: string) => crypto.createHash("md5").update(s).digest("hex");

/** A routine's prosrc: the LAST definition in the text, between its dollar quotes. */
function prosrc(src: string): string {
  const i = src.lastIndexOf("CREATE OR REPLACE FUNCTION public.dispatch_one_unit");
  assert.notEqual(i, -1, "dispatch_one_unit is defined");
  const m = src.slice(i).match(/AS (\$\w*\$)([\s\S]*?)\1/);
  assert.ok(m, "no dollar-quoted body");
  return m[2] as string;
}

type Hunk = { at: number; removed: string[]; added: string[] };
/** An LCS line diff of `a` → `b`, grouped into hunks (`at` = the hunk's first line in `b`, 1-based). */
function hunks(a: string, b: string): Hunk[] {
  const x = a.split("\n");
  const y = b.split("\n");
  const L = Array.from({ length: x.length + 1 }, () => new Int32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      L[i]![j] = x[i] === y[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
    }
  }
  const out: Hunk[] = [];
  let cur: Hunk | null = null;
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { cur = null; i++; j++; continue; }
    if (!cur) { cur = { at: j + 1, removed: [], added: [] }; out.push(cur); }
    if (j >= y.length || (i < x.length && L[i + 1]![j]! >= L[i]![j + 1]!)) cur.removed.push(x[i++]!);
    else cur.added.push(y[j++]!);
  }
  return out;
}

/** The text between two markers of a body (the start marker included). */
function section(body: string, from: string, to: string): string {
  const i = body.indexOf(from);
  const k = body.indexOf(to, i + from.length);
  assert.ok(i !== -1 && k !== -1, `section ${from} … ${to}`);
  return body.slice(i, k);
}

const firstCode = (h: Hunk) => (h.added.find((l) => l.trim() !== "" && !l.trim().startsWith("--")) ?? "").trim();

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

test("the body is FIX-1421's plus ONLY the fourteen hunks, and hashes to the read-back's pin", () => {
  const was = prosrc(BASE());
  const now = prosrc(FILE());
  assert.equal(md5(was), WAS, "the history file's body");
  assert.equal(md5(now), NOW, "this file's body");
  const hs = hunks(was, now);
  assert.deepEqual(hs.flatMap((h) => h.removed), [
    "                       completed_at  = r.run_end,",
    "                   AND l.started_at >= r.run_start AND l.started_at <= r.run_end;",
    "                 round(EXTRACT(epoch FROM (r.run_end - r.run_start)) * 1000)::int);",
    "          ELSIF v_live_units >= v_dials.max_concurrent_units THEN",
    "            v_why := format('units: %s live of %s', v_live_units, v_dials.max_concurrent_units);",
  ]);
  const want: RegExp[] = [
    /^c_hold_key\s+CONSTANT text\s+:= 'dispatcher_hold';/,          // DECLARE: the constants
    /^v_run_end\s+timestamptz;/,                                      // DECLARE: step 3's
    /^v_hold\s+jsonb;/,                                               // DECLARE: step 4's
    /^v_run_end := r\.run_end;/,                                      // D11: the end
    /^completed_at\s+= v_run_end,/,                                   // D11: the close's completed_at
    /^AND l\.started_at >= r\.run_start AND l\.started_at <= v_run_end;/, // D11: the close's bound
    /^round\(EXTRACT\(epoch FROM \(v_run_end - r\.run_start\)\) \* 1000\)::int\);/, // D11: unit_ms + D5 (i)
    /^IF r\.job = c_landing_job AND v_dials\.landing_after_minutes > 0/,  // D3: provisional
    /^IF r\.job = c_landing_job AND v_g_dec = 'reaped'/,                 // D3: the quiet
    /^SELECT value INTO v_hold FROM public\.pipeline_state WHERE key = c_hold_key;/, // D5 (ii) + the strike
    /^SELECT h\.kind, h\.until INTO v_hold_kind, v_hold_until/,         // 4b + D7
    /^ELSIF v_live_units >= v_max_units THEN/,                          // D7: the units rung
    /^IF v_decision = 'armed' AND v_ramp_until > v_now THEN/,           // D7: the arm's suffix
    /^IF v_strike_box AND v_decision = 'skipped' THEN/,                 // D5 (ii): strike_at re-dated
  ];
  assert.equal(hs.length, want.length, hs.map((h) => `+${h.at} ${firstCode(h)}`).join("\n"));
  hs.forEach((h, k) => assert.match(firstCode(h), want[k]!, `hunk ${k + 1} at +${h.at}`));
  const added = hs.reduce((s, h) => s + h.added.length, 0);
  console.info(`[r18] body ${was.split("\n").length} → ${now.split("\n").length} lines; −5 +${added}; ${hs.length} hunks at ` +
    hs.map((h) => `+${h.at}`).join(" "));
});

test("D2: pause precedes every hold read; reap → 3b → the box → 4b → census → pick → arm, in that order", () => {
  const body = prosrc(FILE());
  const code = stripComments(body);
  const at = (s: string) => {
    const i = body.indexOf(s);
    assert.notEqual(i, -1, s);
    return i;
  };
  const order = [
    "IF v_dials.pause THEN", "-- ── 3. reap", "-- ── 3b. reap a GHA arm", "-- ── 4. the box",
    "-- ── 4b. the hold (FIX-1444, cc-303)", "-- ── 5. the census", "-- ── 6. pick", "-- ── 7. ARM", "END body;",
  ].map(at);
  assert.ok(order.every((x, i) => i === 0 || x > order[i - 1]!), order.join(","));
  assert.ok(code.indexOf("c_hold_key", code.indexOf("BEGIN\n")) > code.indexOf("IF v_dials.pause THEN"), "no key read before pause");

  const step3 = section(body, "-- ── 3. reap", "-- ── 3b. reap a GHA arm");
  const arm = section(step3, "IF r.run_status IN ('succeeded', 'failed') THEN", "ELSIF r.run_status IS NOT NULL THEN");
  assert.ok(arm.indexOf("v_run_end := r.run_end;") < arm.indexOf("v_closed := 0;"), "D11's end before the close");
  assert.ok(arm.indexOf("INSERT INTO public.dispatch_log") < arm.indexOf("v_strike_why := r.job"), "D5 (i) after the reap row");
  assert.match(stripComments(arm), /NOT LIKE '%server restarted%'/, "a restart is never a strike");

  const g = section(body, "-- ── 3b. reap a GHA arm", "-- ── 4. the box");
  const occ = section(g, "IF v_g_dec IS NULL THEN", "CONTINUE;");
  assert.match(occ, /'landing_set_by', format\('provisional: nightly live since %s; its start \+ %s s budget'/);
  assert.ok(g.indexOf("WHERE key = r.req_key;") < g.indexOf("IF r.job = c_landing_job AND v_g_dec = 'reaped'"), "the quiet after the stamp's reap");

  const box = section(body, "-- ── 4. the box", "-- ── 4b. the hold");
  const skip = section(box, "IF COALESCE((v_box->>'saturated')::boolean, true) THEN", "-- FIX-1354 (D2): the mirror");
  const wasSkip = section(prosrc(BASE()), "IF COALESCE((v_box->>'saturated')::boolean, true) THEN", "-- FIX-1354 (D2): the mirror");
  assert.equal(skip, wasSkip, "the box skip is logged exactly as before");
  assert.ok(box.indexOf("v_strike_box := true;") < box.indexOf("IF COALESCE((v_box->>'saturated')::boolean, true) THEN"), "D5 (ii) before the skip");

  const hold = section(body, "-- ── 4b. the hold", "-- ── 5. the census");
  assert.ok(hold.indexOf("EXIT body;") < hold.indexOf("IF v_dials.ramp_minutes > 0 THEN"), "the hold, then the ramp");
  assert.match(hold, /v_reason\s+:= format\('hold: %s until %s \(%s\)', v_hold_kind, date_trunc\('second', v_hold_until\),/);
  assert.match(hold, /v_decision := 'skipped';/);
  assert.match(hold, /v_box_out\s+:= v_box->'readings';/);
});

test("the caps and windows are constants, and no executable line carries their values", () => {
  const body = prosrc(FILE());
  for (const c of [
    /c_hold_key\s+CONSTANT text\s+:= 'dispatcher_hold';/,
    /c_landing_job CONSTANT text\s+:= 'nightly';/,
    /c_landing_cap CONSTANT interval := interval '12 hours';/,
    /c_stall_cap\s+CONSTANT int\s+:= 480;/,
    /c_strike_win\s+CONSTANT interval := interval '24 hours';/,
    /c_skip_n\s+CONSTANT int\s+:= 2;/,
    /c_skip_win\s+CONSTANT interval := interval '10 minutes';/,
    /c_io_recent\s+CONSTANT interval := interval '5 minutes';/,
    /c_stall_re\s+CONSTANT text\s+:= '\(job startup timeout\|canceling statement due to user request\|transaction timeout\|statement timeout\|ssl connection has been closed unexpectedly\|server closed the connection unexpectedly\)';/,
  ]) assert.match(body, c);
  const exec = (b: string) => stripComments(b.slice(b.indexOf("\nBEGIN\n")));
  for (const lit of ["480", "'12 hours'", "'24 hours'", "'10 minutes'", "'5 minutes'", "'dispatcher_hold'", "'nightly'"]) {
    assert.equal(exec(body).split(lit).length, exec(prosrc(BASE())).split(lit).length, `${lit}: no new executable use`);
  }
});

test("D10: c_running_win, the census, the pick (bar the units rung), step 7 and the error path are FIX-1421's", () => {
  const was = prosrc(BASE());
  const now = prosrc(FILE());
  assert.match(now, /c_running_win CONSTANT interval := interval '6 hours';/);
  for (const [from, to] of [
    ["-- ── 5. the census", "-- ── 6. pick"],
    ["-- ── 7. ARM", "END body;"],
    ["END body;", "IF v_purged > 0 THEN"],
  ] as const) assert.equal(section(now, from, to), section(was, from, to), `${from} unchanged`);
  const rung = (s: string) => s.replace(/ {10}ELSIF v_live_units >= [\s\S]*?\n(?= {10}ELSIF v_live_caps)/, "<units>\n");
  assert.equal(rung(section(now, "-- ── 6. pick", "-- ── 7. ARM")), rung(section(was, "-- ── 6. pick", "-- ── 7. ARM")),
    "the cooldown ladder, the headroom rung and every other rung unchanged");
  assert.equal(now.slice(0, now.indexOf("DECLARE")), was.slice(0, was.indexOf("DECLARE")));
  const tail = (s: string) => s.slice(s.indexOf("  INSERT INTO public.dispatch_log\n    (source, job, decision, reason, live_caps_mb"));
  assert.equal(tail(now).replace(/ {2}-- FIX-1444 D5 \(ii\)[\s\S]*?\n {2}END IF;\n/, ""), tail(was), "the final row and the return");
});

test("the guard admits FIX-1421's body or this file's; the read-back pins all four and the dials; every v_missing element is ::text", () => {
  const sql = FILE();
  const guard = sql.slice(0, sql.indexOf("ALTER TABLE public.platform_dials"));
  assert.ok(guard.includes(`v_d IS DISTINCT FROM '${WAS}' AND v_d IS DISTINCT FROM '${NOW}'`));
  const rb = sql.slice(sql.lastIndexOf("DO $$"));
  assert.ok(rb.includes(`c_new_d CONSTANT text := '${NOW}'`));
  assert.ok(rb.includes(`c_old_d CONSTANT text := '${WAS}'`));
  for (const [name, m] of Object.entries(PINS)) {
    assert.ok(rb.includes(`'${m}'`), `${name} pinned at ${m}`);
    assert.ok(rb.includes(`proname = '${name}'`), name);
  }
  assert.ok(rb.includes("'landing_after_minutes integer NO 30; landing_quiet_factor numeric NO 3; ramp_minutes integer NO 60; stall_hold_minutes integer NO 120'"));
  const appends = [...rb.matchAll(/v_missing := v_missing \|\| ([^;]+);/g)].map((m) => m[1]!);
  assert.equal(appends.length, 6);
  for (const a of appends) assert.match(a, /::text$/, a);
  assert.match(rb, /search_path=public, pg_catalog, cron/);
  const outside = sql.slice(0, sql.indexOf("CREATE OR REPLACE FUNCTION")) + sql.slice(sql.indexOf("\n$function$;\n"));
  assert.doesNotMatch(stripComments(outside), /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP)\b/i, "the dials, a body and two reads; no row written");
});

test("D9: four dials, NOT NULL with a constant default, a >= 0 CHECK and a comment each", () => {
  const sql = stripComments(FILE());
  for (const [col, type, def] of [
    ["landing_after_minutes", "int", "30"], ["landing_quiet_factor", "numeric", "3"],
    ["stall_hold_minutes", "int", "120"], ["ramp_minutes", "int", "60"],
  ] as const) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${col} ${type} NOT NULL DEFAULT ${def}\\s+CONSTRAINT platform_dials_${col}_check CHECK \\(${col} >= 0\\)`), col);
    assert.match(FILE(), new RegExp(`COMMENT ON COLUMN public\\.platform_dials\\.${col} IS\\n\\s+'FIX-1444 — [^\\n]*0 = no [^\\n]*';`), `${col} comment names its off switch`);
  }
});

test("owner and grants are FIX-1421's; the comment gains one sentence; the revert is FIX-1421's text and asserts its pin", () => {
  const tail = (s: string) => {
    const i = s.lastIndexOf("ALTER FUNCTION public.dispatch_one_unit(text) OWNER TO postgres;");
    return s.slice(i, s.indexOf("';\n", i) + 3);
  };
  const now = tail(FILE());
  const was = tail(BASE());
  assert.ok(now.startsWith(was.slice(0, was.lastIndexOf("sibling''s.';"))), "the same owner, grants and comment up to its last sentence");
  assert.match(now, /'FIX-1444 \/ FIX-1445 \(cc-303\): with the box clear, step 4b skips the tick as hold: <kind> until … while '/);
  const rev = REVERT();
  assert.equal(prosrc(rev), prosrc(BASE()), "the revert's body is FIX-1421's, byte for byte");
  assert.equal(tail(rev), was);
  assert.ok(rev.includes(`IF v_d IS DISTINCT FROM '${WAS}' THEN`));
  assert.match(rev, /It supersedes\n-- scripts\/fix1421-revert-reap-close\.sql/);
  assert.equal(PIN_LINEAGE[WAS], NOW, "PIN_LINEAGE carries the move");
});

test("D8: the model manual hold merges manual_until = now() + 6 minutes and manual_set_by, and nothing else", () => {
  const sql = stripComments(MODEL());
  assert.equal(sql.split(/\bINSERT INTO\b/).length - 1, 1);
  assert.doesNotMatch(sql, /\b(UPDATE public|DELETE|platform_dials)\b/);
  assert.match(sql, /INSERT INTO public\.pipeline_state AS ps \(key, value, updated_at\)\s+VALUES \('dispatcher_hold',/);
  assert.match(sql, /jsonb_build_object\('manual_until', now\(\) \+ interval '6 minutes',\s+'manual_set_by', '[^']+'\)/);
  assert.equal([...sql.matchAll(/'([a-z_]+)',\s/g)].map((m) => m[1]).filter((k) => k !== "dispatcher_hold").join(","), "manual_until,manual_set_by");
  assert.match(sql, /ON CONFLICT \(key\) DO UPDATE SET value = ps\.value \|\| EXCLUDED\.value, updated_at = now\(\)/);
});

// ---------------------------------------------------------------------------
// Clone
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

/** One rolled-back transaction, the registry's table lock FIRST (r9's reason). */
async function inTx(t: { skip: (m: string) => void }, fn: (c: Client) => Promise<void>): Promise<void> {
  const c = await clone(t);
  if (!c) return;
  try {
    await c.query("BEGIN");
    try {
      await c.query("LOCK TABLE public.job_registry IN SHARE ROW EXCLUSIVE MODE");
      await fn(c);
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
}

type Dials = Partial<Record<"landing_after_minutes" | "landing_quiet_factor" | "stall_hold_minutes" | "ramp_minutes" | "max_concurrent_units", number>>;

/**
 * prod's dials (the four at their DEFAULTs, max_concurrent_units 2), the cooldown
 * off, a caps ceiling that never binds; no mirror, no session, no key, no
 * request, an empty dispatch_log and a fresh probe. Every row parked but
 * ec-crawl and fe-crawl, both DUE on an hour-old anchor.
 */
async function stage(c: Client, d: Dials = {}): Promise<void> {
  const dl = { landing_after_minutes: 30, landing_quiet_factor: 3, stall_hold_minutes: 120, ramp_minutes: 60, max_concurrent_units: 2, ...d };
  await c.query(
    `UPDATE public.platform_dials SET pause = false, rearm_cooldown_seconds = 0, max_live_caps_mb = 100000,
            landing_after_minutes = $1, landing_quiet_factor = $2, stall_hold_minutes = $3, ramp_minutes = $4, max_concurrent_units = $5`,
    [dl.landing_after_minutes, dl.landing_quiet_factor, dl.stall_hold_minutes, dl.ramp_minutes, dl.max_concurrent_units],
  );
  await c.query("DELETE FROM public.pipeline_state WHERE key IN ('box_health_mem', 'prod_session', 'dispatcher_hold') OR key LIKE 'gha_dispatch_request_%'");
  await c.query("DELETE FROM public.dispatch_log");
  await box(c, { timeouts: 0 });
  await c.query("UPDATE public.job_registry SET deadline_rule = 'at 0 0 1 1 *' WHERE deadline_rule NOT LIKE 'at %' AND job NOT IN ('ec-crawl', 'fe-crawl', 'dispatcher-tick')");
  await c.query("UPDATE public.job_registry SET deadline_rule = 'stale_after 25 minutes' WHERE job IN ('ec-crawl', 'fe-crawl')");
  await c.query("DELETE FROM public.data_sync_log WHERE pipeline IN ('entity_connections_rebuild', 'financial_entity_totals_refresh', 'nightly_cron') AND started_at > now() - interval '7 days'");
  await c.query(
    `INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
     SELECT p, 'complete', clock_timestamp() - interval '61 minutes', clock_timestamp() - interval '60 minutes', '{"cc303": "anchor"}'
       FROM unnest(ARRAY['entity_connections_rebuild', 'financial_entity_totals_refresh']) p`,
  );
}

/** The probe: fresh, with `timeouts` startup timeouts in 10 min (>= 3 reads fork_failures). */
async function box(c: Client, o: { timeouts: number }): Promise<void> {
  await c.query(
    `INSERT INTO public.pipeline_state (key, value, updated_at)
     VALUES ('box_health', jsonb_build_object('at', clock_timestamp(), 'startup_timeouts_10m', $1::int,
                                              'watchdog_max_wall_10m', jsonb_build_object('unit', 0, 'budget', 0)), now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [o.timeouts],
  );
}

type Tick = { id: number; decision: string; job: string | null; reason: string; excluded: string[] };
async function tick(c: Client): Promise<Tick> {
  const id = (await c.query("SELECT public.dispatch_one_unit('manual') AS d")).rows[0].d.id;
  const r = (await c.query("SELECT decision, job, reason, excluded FROM public.dispatch_log WHERE id = $1", [id])).rows[0];
  return { id, decision: r.decision, job: r.job, reason: r.reason, excluded: (r.excluded as string[] | null) ?? [] };
}
type Hold = Record<string, string | number | undefined>;
async function hold(c: Client): Promise<Hold | null> {
  return (await c.query("SELECT value FROM public.pipeline_state WHERE key = 'dispatcher_hold'")).rows[0]?.value ?? null;
}
/** Minutes from now (clock_timestamp) to a key field. */
async function minutesTo(c: Client, field: string): Promise<number> {
  return Number((await c.query(
    `SELECT EXTRACT(epoch FROM ((value->>$1)::timestamptz - clock_timestamp())) / 60 AS m FROM public.pipeline_state WHERE key = 'dispatcher_hold'`,
    [field],
  )).rows[0].m);
}
/** Minutes between two key fields (b − a). */
async function between(c: Client, a: string, b: string): Promise<number> {
  return Number((await c.query(
    `SELECT EXTRACT(epoch FROM ((value->>$2)::timestamptz - (value->>$1)::timestamptz)) / 60 AS m FROM public.pipeline_state WHERE key = 'dispatcher_hold'`,
    [a, b],
  )).rows[0].m);
}
async function setKey(c: Client, sqlObject: string): Promise<void> {
  await c.query(
    `INSERT INTO public.pipeline_state AS ps (key, value, updated_at) VALUES ('dispatcher_hold', ${sqlObject}, now())
     ON CONFLICT (key) DO UPDATE SET value = ps.value || EXCLUDED.value, updated_at = now()`,
  );
}
const near = (got: number, want: number, tol = 0.25) => assert.ok(Math.abs(got - want) <= tol, `${got} ≉ ${want} (±${tol})`);

/** The nightly's request stamp, consumed (outcome dispatched) `minAgo` minutes ago. */
async function request(c: Client, minAgo: number, outcome: string | null = "dispatched"): Promise<void> {
  await c.query(
    `INSERT INTO public.pipeline_state (key, value, updated_at)
     VALUES ('gha_dispatch_request_nightly',
             jsonb_build_object('job', 'nightly', 'requested_at', clock_timestamp() - make_interval(mins => $1::int),
                                'dispatch_log_id', NULL, 'consumed_at', NULL, 'outcome', $2::text, 'http_status', NULL, 'reaped_at', NULL), now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [minAgo, outcome],
  );
}
/** One nightly_cron phase row: started `start` minutes ago, completed `end` minutes ago (null = running). */
async function phase(c: Client, ph: string, start: number, end: number | null, status = "complete"): Promise<void> {
  await c.query(
    `INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
     VALUES ('nightly_cron', $4, clock_timestamp() - make_interval(secs => $2::float8 * 60),
             CASE WHEN $3::float8 IS NULL THEN NULL ELSE clock_timestamp() - make_interval(secs => $3::float8 * 60) END,
             jsonb_build_object('phase', $1::text, 'cc303', true))`,
    [ph, start, end, end === null ? "running" : status],
  );
}

let jobid = 990_303_000;
/**
 * A one-shot as step 3 reads one (r17's shape): an `armed` row with a jobid no
 * cron.job carries, and its run row above the floor, 5 → 2 min ago. `restarted`:
 * started 5 min before pg_postmaster_start_time(), end_time NULL.
 */
async function run(c: Client, job: string, status: "failed" | "succeeded", message: string, restarted = false): Promise<number> {
  const id = jobid++;
  const floor = (await c.query("SELECT COALESCE(max(runid), 0)::bigint AS f FROM cron.job_run_details")).rows[0].f;
  await c.query(
    `INSERT INTO public.dispatch_log (source, job, decision, reason, armed_jobid, armed_jobname, armed_for, runid_floor, ticked_at)
     VALUES ('manual', $1, 'armed', 'synthetic (cc-303)', $2, $3, clock_timestamp() - interval '5 minutes', $4, clock_timestamp() - interval '6 minutes')`,
    [job, id, `disp-${job}-cc303-${id}`, floor],
  );
  await c.query(
    `INSERT INTO cron.job_run_details (jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time)
     SELECT $1, $2::bigint + 1, 1, 'postgres', 'postgres', 'synthetic cc-303', $3, $4,
            CASE WHEN $5 THEN pg_postmaster_start_time() - interval '5 minutes' ELSE clock_timestamp() - interval '5 minutes' END,
            CASE WHEN $5 THEN NULL ELSE clock_timestamp() - interval '2 minutes' END`,
    [id, floor, status, message, restarted],
  );
  return id;
}
/** A box skip row `minAgo` minutes ago. */
async function skipRow(c: Client, reason: string, minAgo: number): Promise<void> {
  await c.query(
    `INSERT INTO public.dispatch_log (source, decision, reason, ticked_at) VALUES ('pg_cron', 'skipped', $1, clock_timestamp() - make_interval(secs => $2::float8 * 60))`,
    [reason, minAgo],
  );
}
const armedJobs = async (c: Client) =>
  (await c.query("SELECT job FROM public.dispatch_log WHERE decision = 'armed' AND reason <> 'synthetic (cc-303)' ORDER BY id")).rows.map((r: { job: string }) => r.job);
const ex = (t: Tick, job: string) => t.excluded.find((e) => e.endsWith(`(${job})`));

test("clone L: 29 min live holds nothing; 31 min holds to start + budget and arms nothing", async (t) => {
  await inTx(t, async (c) => {
    await stage(c);
    await request(c, 30);
    await phase(c, "fec", 29, null);
    const t1 = await tick(c);
    assert.notEqual(t1.decision, "skipped", t1.reason);
    assert.equal(await hold(c), null, "no key under the threshold");
  });
  await inTx(t, async (c) => {
    await stage(c);
    await request(c, 32);
    await phase(c, "fec", 31, null);
    const t1 = await tick(c);
    assert.equal(t1.decision, "skipped");
    assert.match(t1.reason, /^hold: landing until \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\+00 \(provisional: nightly live since .+; its start \+ 18000 s budget\)$/);
    const capped = (await c.query(
      `SELECT (h.value->>'landing_until')::timestamptz = l.started_at + interval '18000 seconds' AS eq
         FROM public.pipeline_state h, public.data_sync_log l
        WHERE h.key = 'dispatcher_hold' AND l.pipeline = 'nightly_cron' AND l.metadata->>'cc303' = 'true'`,
    )).rows[0].eq;
    assert.equal(capped, true, "landing_until = the first phase's start + budget_seconds");
    assert.deepEqual(await armedJobs(c), [], "a due row is not armed");
    console.info(`[r18] L 31 min: ${t1.reason}`);
  });
});

test("clone L: a reap sets now + 3 × wall — 150 min → 450, 31 min → 93 (earlier than the cap), 5 h → the 12 h cap; 14 min and a miss set nothing", async (t) => {
  for (const [wall, want] of [[150, 450], [300, 720]] as const) {
    await inTx(t, async (c) => {
      await stage(c);
      await request(c, wall + 3);
      await phase(c, "fec", wall + 2, wall);
      await phase(c, "enrichment-tail", wall - 1, 2);
      const t1 = await tick(c);
      assert.equal(t1.decision, "skipped", t1.reason);
      near(await minutesTo(c, "landing_until"), want);
      const by = (await hold(c))!["landing_set_by"] as string;
      assert.match(by, new RegExp(`^nightly wall ${wall * 60} s × 3 from its reap${want === 720 ? ", capped at 12 h" : ""}$`), by);
      assert.equal((await c.query("SELECT reason FROM public.dispatch_log WHERE job = 'nightly' AND decision = 'reaped'")).rows[0].reason, "succeeded: GHA");
    });
  }
  await inTx(t, async (c) => {
    await stage(c);
    await request(c, 34);
    await phase(c, "fec", 33, 20);
    await phase(c, "enrichment-tail", 20, null);
    await tick(c);
    const cap = await minutesTo(c, "landing_until");
    near(cap, 300 - 33, 0.5);
    await c.query("UPDATE public.data_sync_log SET status = 'complete', completed_at = started_at + interval '18 minutes' WHERE pipeline = 'nightly_cron' AND metadata->>'phase' = 'enrichment-tail'");
    const t2 = await tick(c);
    near(await minutesTo(c, "landing_until"), 93, 0.5);
    assert.ok(await minutesTo(c, "landing_until") < cap, "the reap moves the provisional cap EARLIER");
    assert.match(t2.reason, /^hold: landing until .+ \(nightly wall 1860 s × 3 from its reap\)$/);
  });
  await inTx(t, async (c) => {
    await stage(c);
    await request(c, 17);
    await phase(c, "fec", 16, 8);
    await phase(c, "enrichment-tail", 8, 2);
    const t1 = await tick(c);
    assert.notEqual(t1.decision, "skipped", t1.reason);
    assert.equal(await hold(c), null, "a 14-minute nightly sets nothing");
  });
  await inTx(t, async (c) => {
    await stage(c);
    await request(c, 25, null);
    await tick(c);
    assert.equal((await c.query("SELECT decision FROM public.dispatch_log WHERE job = 'nightly' AND decision IN ('reaped', 'missed')")).rows[0].decision, "missed");
    assert.equal(await hold(c), null, "a missed request sets nothing");
  });
});

test("clone L (cc-303): a request that wrote no phase row for 50 min, then a 14-min run, ends its provisional cap at the reap", async (t) => {
  await inTx(t, async (c) => {
    await stage(c);
    await request(c, 50);
    const t1 = await tick(c);
    assert.match(t1.reason, /^hold: landing until .+ \(provisional: /, "no row yet: the request's own instant is the start");
    await phase(c, "fec", 16, 8);
    await phase(c, "enrichment-tail", 8, 2);
    const t2 = await tick(c);
    assert.notEqual(t2.decision, "skipped", t2.reason);
    const h = (await hold(c))!;
    assert.match(h["landing_set_by"] as string, /^nightly reaped at wall 840 s, under 30 min: its provisional cap ends$/);
    near(await minutesTo(c, "landing_until"), 0, 0.1);
    near(await between(c, "landing_until", "ramp_until"), 60, 0.01);
  });
});

test("clone S (i): a stall-class failure strikes — 120, then 240, the 480 cap by the third; 25 h later it is strike 1 again", async (t) => {
  await inTx(t, async (c) => {
    await stage(c);
    const id = await run(c, "ec-crawl", "failed", "job startup timeout");
    const t1 = await tick(c);
    const reap = (await c.query("SELECT reason FROM public.dispatch_log WHERE armed_jobid = $1 AND decision = 'reaped'", [id])).rows[0];
    assert.equal(reap.reason, "failed: job startup timeout", "the reap row is written");
    let h = (await hold(c))!;
    assert.equal(h["strikes"], 1);
    assert.equal(h["stall_set_by"], "strike 1: ec-crawl: job startup timeout");
    near(await between(c, "strike_at", "stall_until"), 120, 0.001);
    assert.match(t1.reason, /^hold: stall until .+ \(strike 1: ec-crawl: job startup timeout\)$/, "the striking tick is held");
    const msgs = ["ERROR:  canceling statement due to user request\nCONTEXT:  synthetic", "SSL connection has been closed unexpectedly", "ERROR:  canceling statement due to statement timeout", "FATAL:  terminating connection due to transaction timeout"];
    const caps = [240, 480, 480, 480];
    for (let k = 0; k < msgs.length; k++) {
      await run(c, "fe-crawl", "failed", msgs[k]!);
      await tick(c);
      h = (await hold(c))!;
      assert.equal(h["strikes"], k + 2, msgs[k]);
      near(await between(c, "strike_at", "stall_until"), caps[k]!, 0.001);
    }
    assert.equal(h["stall_set_by"], "strike 5: fe-crawl: transaction timeout");
    await c.query("UPDATE public.pipeline_state SET value = value || jsonb_build_object('strike_at', clock_timestamp() - interval '25 hours') WHERE key = 'dispatcher_hold'");
    await run(c, "ec-crawl", "failed", "job startup timeout");
    await tick(c);
    h = (await hold(c))!;
    assert.equal(h["strikes"], 1, "past the 24 h window: strike 1");
    near(await between(c, "strike_at", "stall_until"), 120, 0.001);
  });
});

test("clone S (i): a succeeded run, a non-stall failure and `server restarted` never strike", async (t) => {
  for (const [status, msg] of [["succeeded", "1 row"], ["failed", "ERROR:  duplicate key value violates unique constraint"], ["failed", "server restarted"]] as const) {
    await inTx(t, async (c) => {
      await stage(c);
      await run(c, "ec-crawl", status, msg);
      await tick(c);
      assert.equal((await hold(c))?.["strikes"], undefined, msg);
    });
  }
});

test("clone S (ii): two fork_failures skips inside 10 min + this tick's → one strike; the same skips cannot strike twice; the next clear tick reads hold: stall", async (t) => {
  await inTx(t, async (c) => {
    await stage(c);
    await skipRow(c, "box: fork_failures", 4);
    await skipRow(c, "box: stale", 2);
    await box(c, { timeouts: 5 });
    const t1 = await tick(c);
    assert.equal(t1.decision, "skipped");
    assert.equal(t1.reason, "box: fork_failures", "the box skip is logged exactly as before");
    let h = (await hold(c))!;
    assert.equal(h["strikes"], 1);
    assert.equal(h["stall_set_by"], "strike 1: 3 box skips");
    const dated = (await c.query(
      `SELECT (h.value->>'strike_at')::timestamptz = l.ticked_at AS eq FROM public.pipeline_state h, public.dispatch_log l WHERE h.key = 'dispatcher_hold' AND l.id = $1`,
      [t1.id],
    )).rows[0].eq;
    assert.equal(dated, true, "strike_at is the striking row's own ticked_at");
    const t2 = await tick(c);
    assert.equal(t2.reason, "box: fork_failures");
    h = (await hold(c))!;
    assert.equal(h["strikes"], 1, "the same three skips cannot strike twice");
    await box(c, { timeouts: 0 });
    const t3 = await tick(c);
    assert.match(t3.reason, /^hold: stall until .+ \(strike 1: 3 box skips\)$/);
    assert.deepEqual(await armedJobs(c), []);
  });
  await inTx(t, async (c) => {
    await stage(c);
    await skipRow(c, "box: fork_failures", 11);
    await skipRow(c, "box: memory", 2);
    await box(c, { timeouts: 5 });
    await tick(c);
    assert.equal(await hold(c), null, "a skip outside 10 min, and a memory skip, do not count");
  });
});

test("clone D6: a strike under a longer landing counts and the row reads landing; the landing's reap leaves stall_until; a shorter landing yields to the stall", async (t) => {
  await inTx(t, async (c) => {
    await stage(c);
    await setKey(c, "jsonb_build_object('landing_until', clock_timestamp() + interval '400 minutes', 'landing_set_by', 'cc-303 test')");
    await run(c, "ec-crawl", "failed", "job startup timeout");
    const t1 = await tick(c);
    assert.match(t1.reason, /^hold: landing until .+ \(cc-303 test\)$/);
    assert.equal((await hold(c))!["strikes"], 1, "and it counts");
    await c.query("UPDATE public.pipeline_state SET value = value || jsonb_build_object('stall_until', clock_timestamp() + interval '480 minutes', 'stall_set_by', 'strike 3: test') WHERE key = 'dispatcher_hold'");
    const stall = (await hold(c))!["stall_until"];
    await request(c, 34);
    await phase(c, "fec", 33, 20);
    await phase(c, "enrichment-tail", 20, 2);
    const t2 = await tick(c);
    assert.equal((await hold(c))!["stall_until"], stall, "the landing's reap does not touch stall_until");
    near(await minutesTo(c, "landing_until"), 93, 0.5);
    assert.match(t2.reason, /^hold: stall until .+ \(strike 3: test\)$/, "the later until is in force");
  });
});

test("clone ramp: an expiry ramps to its until + 60; one long past starts none; (ramp) caps the units at 1; an arm says so; the dial's 2 after; io_throttled starts one", async (t) => {
  await inTx(t, async (c) => {
    await stage(c);
    await setKey(c, "jsonb_build_object('manual_until', clock_timestamp() - interval '10 minutes', 'manual_set_by', 'test')");
    await c.query("INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata) VALUES ('entity_connections_rebuild', 'running', clock_timestamp() - interval '1 minute', '{\"cc303\": \"live\"}')");
    const t1 = await tick(c);
    near(await between(c, "manual_until", "ramp_until"), 60, 0.001);
    assert.equal(ex(t1, "ec-crawl"), "live (ec-crawl)");
    assert.equal(ex(t1, "fe-crawl"), "units: 1 live of 1 (ramp) (fe-crawl)", JSON.stringify(t1.excluded));
    assert.equal(t1.decision, "nothing_due");
    await c.query("DELETE FROM public.data_sync_log WHERE metadata->>'cc303' = 'live'");
    const t2 = await tick(c);
    assert.equal(t2.decision, "armed");
    assert.match(t2.reason, /^stale_after 25 minutes → .+; ramp until \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\+00$/, t2.reason);
  });
  await inTx(t, async (c) => {
    await stage(c);
    await setKey(c, "jsonb_build_object('manual_until', clock_timestamp() - interval '3 hours', 'manual_set_by', 'test')");
    await c.query("INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata) VALUES ('entity_connections_rebuild', 'running', clock_timestamp() - interval '1 minute', '{\"cc303\": \"live\"}')");
    const t1 = await tick(c);
    assert.ok((await minutesTo(c, "ramp_until")) < 0, "the ramp it writes is already past");
    assert.equal(ex(t1, "fe-crawl"), undefined, "an expiry 3 h ago starts no ramp: the dial's 2 admits fe-crawl");
    assert.equal(t1.decision, "armed");
    assert.doesNotMatch(t1.reason, /ramp/);
  });
  await inTx(t, async (c) => {
    await stage(c);
    await setKey(c, "jsonb_build_object('ramp_until', clock_timestamp() - interval '1 second')");
    await c.query("INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata) VALUES ('entity_connections_rebuild', 'running', clock_timestamp() - interval '1 minute', '{\"cc303\": \"live\"}')");
    const t1 = await tick(c);
    assert.equal(t1.job, "fe-crawl", "after ramp_until the dial's 2 applies again");
    assert.equal(t1.decision, "armed");
  });
  await inTx(t, async (c) => {
    await stage(c);
    await skipRow(c, "box: io_throttled", 4);
    const t1 = await tick(c);
    near(await minutesTo(c, "ramp_until"), 60, 0.25);
    assert.match(t1.reason, /; ramp until /, "a clear tick 4 min after an io_throttled skip ramps");
  });
});

test("clone manual: the model file holds; a finished one-shot is still reaped under it; under a later landing it writes only its own fields", async (t) => {
  await inTx(t, async (c) => {
    await stage(c);
    const id = await run(c, "ec-crawl", "succeeded", "1 row");
    const set = (await c.query(MODEL())).rows[0];
    assert.equal(set.key, "dispatcher_hold");
    const t1 = await tick(c);
    assert.match(t1.reason, /^hold: manual until .+ \(cc-303: the six-minute manual hold exercise \(by hand, scripts\/fix1444-manual-hold-six-minutes\.sql\)\)$/);
    near(await minutesTo(c, "manual_until"), 6, 0.25);
    assert.equal((await c.query("SELECT reason FROM public.dispatch_log WHERE armed_jobid = $1 AND decision = 'reaped'", [id])).rows[0]?.reason, "succeeded: 1 row", "reaped in the held tick");
    assert.deepEqual(await armedJobs(c), []);
  });
  await inTx(t, async (c) => {
    await stage(c);
    await setKey(c, "jsonb_build_object('landing_until', clock_timestamp() + interval '400 minutes', 'landing_set_by', 'cc-303 test', 'strikes', 2)");
    const before = (await hold(c))!;
    await c.query(MODEL());
    const after = (await hold(c))!;
    assert.deepEqual(Object.keys(after).sort(), ["landing_set_by", "landing_until", "manual_set_by", "manual_until", "strikes"]);
    for (const k of ["landing_until", "landing_set_by", "strikes"]) assert.equal(after[k], before[k], k);
    assert.match((await tick(c)).reason, /^hold: landing until /);
  });
});

test("clone dials: each at 0 turns its part off and leaves the others", async (t) => {
  for (const off of ["landing_after_minutes", "landing_quiet_factor"] as const) {
    await inTx(t, async (c) => {
      await stage(c, { [off]: 0 });
      await request(c, 32);
      await phase(c, "fec", 31, null);
      await run(c, "ec-crawl", "failed", "job startup timeout");
      const t1 = await tick(c);
      assert.equal((await hold(c))!["landing_until"], undefined, `${off} 0: no L`);
      assert.match(t1.reason, /^hold: stall /, `${off} 0: S still strikes`);
    });
  }
  await inTx(t, async (c) => {
    await stage(c, { stall_hold_minutes: 0 });
    await request(c, 32);
    await phase(c, "fec", 31, null);
    await run(c, "ec-crawl", "failed", "job startup timeout");
    const t1 = await tick(c);
    assert.equal((await hold(c))!["strikes"], undefined, "stall 0: no strike");
    assert.match(t1.reason, /^hold: landing /, "stall 0: L still holds");
  });
  await inTx(t, async (c) => {
    await stage(c, { ramp_minutes: 0 });
    await setKey(c, "jsonb_build_object('manual_until', clock_timestamp() - interval '10 minutes', 'manual_set_by', 'test', 'ramp_until', clock_timestamp() + interval '30 minutes')");
    await c.query("INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata) VALUES ('entity_connections_rebuild', 'running', clock_timestamp() - interval '1 minute', '{\"cc303\": \"live\"}')");
    const t1 = await tick(c);
    assert.equal(t1.job, "fe-crawl", "ramp 0: a standing ramp_until is ignored");
    assert.doesNotMatch(t1.reason, /ramp/);
    near(await between(c, "manual_until", "ramp_until"), 40, 0.01);
    await run(c, "ec-crawl", "failed", "job startup timeout");
    await tick(c);
    assert.equal((await hold(c))!["strikes"], 1, "ramp 0: S still strikes");
  });
});

test("clone FIX-1445: a restarted run (end_time NULL) closes its running row at the postmaster's start, says so, and is not a strike; FIX-1421's case still closes", async (t) => {
  await inTx(t, async (c) => {
    await stage(c);
    const id = await run(c, "ec-crawl", "failed", "server restarted", true);
    const row = (await c.query(
      `INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
       SELECT 'entity_connections_rebuild', 'running', d.start_time + interval '1 second', '{"cc303": "restarted"}'
         FROM cron.job_run_details d WHERE d.jobid = $1 RETURNING id`,
      [id],
    )).rows[0].id;
    await tick(c);
    const r = (await c.query(
      `SELECT status, completed_at = pg_postmaster_start_time() AS at_start, error_message FROM public.data_sync_log WHERE id = $1`,
      [row],
    )).rows[0];
    assert.equal(r.status, "reaped");
    assert.equal(r.at_start, true, "completed_at = pg_postmaster_start_time()");
    assert.equal(r.error_message, "reaped_orphan — the unit's cron run ended failed: server restarted");
    const reap = (await c.query("SELECT reason, unit_ms FROM public.dispatch_log WHERE armed_jobid = $1 AND decision = 'reaped'", [id])).rows[0];
    assert.equal(reap.reason, "failed: server restarted; closed 1 running row(s)");
    assert.equal(reap.unit_ms, 300000, "unit_ms reads the postmaster's start");
    assert.equal((await hold(c))?.["strikes"], undefined, "not a strike");
  });
  await inTx(t, async (c) => {
    await stage(c);
    const id = await run(c, "ec-crawl", "failed", "ERROR:  canceling statement due to user request");
    await c.query(
      `INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
       SELECT 'entity_connections_rebuild', 'running', d.start_time + interval '0.4 milliseconds', '{"cc303": "1421"}'
         FROM cron.job_run_details d WHERE d.jobid = $1`,
      [id],
    );
    const t1 = await tick(c);
    assert.equal((await c.query("SELECT reason FROM public.dispatch_log WHERE armed_jobid = $1 AND decision = 'reaped'", [id])).rows[0].reason,
      "failed: ERROR:  canceling statement due to user request; closed 1 running row(s)");
    assert.equal((await c.query("SELECT completed_at = (SELECT end_time FROM cron.job_run_details WHERE jobid = $1) AS eq FROM public.data_sync_log WHERE metadata->>'cc303' = '1421'", [id])).rows[0].eq, true);
    assert.match(t1.reason, /^hold: stall until .+ \(strike 1: ec-crawl: canceling statement due to user request\)$/, "and, from cc-303 on, the cancel strikes");
  });
});

test("clone 11-22/23: the nightly live 138 min holds fe-crawl; three fork_failures skips two minutes apart hold ec-crawl on the clear box after", async (t) => {
  await inTx(t, async (c) => {
    await stage(c);
    await request(c, 139);
    await phase(c, "fec", 138, 120);
    await phase(c, "enrichment-heavy", 120, null);
    const t1 = await tick(c);
    assert.match(t1.reason, /^hold: landing until /, t1.reason);
    assert.deepEqual(await armedJobs(c), [], "fe-crawl is not armed (11-23 00:37Z)");
  });
  await inTx(t, async (c) => {
    await stage(c);
    await skipRow(c, "box: fork_failures", 4);
    await skipRow(c, "box: fork_failures", 2);
    await box(c, { timeouts: 6 });
    assert.equal((await tick(c)).reason, "box: fork_failures");
    await box(c, { timeouts: 0 });
    const t2 = await tick(c);
    assert.match(t2.reason, /^hold: stall until /, t2.reason);
    assert.deepEqual(await armedJobs(c), [], "ec-crawl is not armed (11-22 23:43Z)");
  });
});

test("clone: the revert restores FIX-1421's body, which ignores the key; the file re-applies, idempotent", async (t) => {
  await inTx(t, async (c) => {
    const pin = async () => (await c.query("SELECT md5(prosrc) AS m FROM pg_proc WHERE proname = 'dispatch_one_unit' AND pronamespace = 'public'::regnamespace")).rows[0].m;
    assert.equal(await pin(), atCurrentPins(NOW), "the clone carries this file (cc-318 moved the pin on: PIN_LINEAGE)");
    await stage(c);
    await c.query(MODEL());
    await c.query(REVERT());
    assert.equal(await pin(), WAS);
    assert.doesNotMatch((await tick(c)).reason, /^hold: /, "the old body never reads dispatcher_hold");
    await c.query(FILE());
    assert.equal(await pin(), NOW);
    await c.query(FILE());
    assert.equal(await pin(), NOW, "idempotent");
    assert.match((await tick(c)).reason, /^hold: manual until /, "and the key it left is read again");
  });
});

/** r15's sample shape: the mirror's memory, and the rates a sample carries. */
const MB = 1048576;
const MEM = { mem_available_bytes: 450 * MB, mem_total_bytes: 948191232, swap_total_bytes: 1073737728, swap_free_bytes: 1073737728 - 490 * MB };
const sample = (c: Client, rates: Record<string, unknown>) =>
  c.query("SELECT public.record_box_health_mem($1::jsonb)", [JSON.stringify({ ...MEM, ...rates })]);
const mirror = async (c: Client) => (await c.query("SELECT value FROM public.pipeline_state WHERE key = 'box_health_mem'")).rows[0].value as Record<string, unknown>;

test("clone D13 (the no-build fallback): a hand-written 8 h io_throttle_until survives a sample and reads io_throttled on a stale mirror; a throttle-shaped streak cuts it to now + 60 min", async (t) => {
  await inTx(t, async (c) => {
    await stage(c);
    await c.query("UPDATE public.platform_dials SET io_time_pct_ceiling = 90, io_samples = 2, io_mbps_floor = 12, io_throttle_hold_min = 60");
    await sample(c, { io_time_pct: 10, disk_all_read_mbps: 30, disk_all_write_mbps: 1, disk_reads_ps: 800 });
    await c.query("UPDATE public.pipeline_state SET value = value || jsonb_build_object('io_throttle_until', clock_timestamp() + interval '8 hours') WHERE key = 'box_health_mem'");
    const hand = (await mirror(c))["io_throttle_until"];
    await sample(c, { io_time_pct: 10, disk_all_read_mbps: 30, disk_all_write_mbps: 1, disk_reads_ps: 800 });
    assert.equal((await mirror(c))["io_throttle_until"], hand, "(1) a normal sample keeps the hand-written hold");
    await c.query("UPDATE public.pipeline_state SET value = value || jsonb_build_object('at', clock_timestamp() - interval '600 seconds') WHERE key = 'box_health_mem'");
    const v = (await c.query("SELECT public.box_is_saturated(p_include_watchdog_wall := false) AS b")).rows[0].b;
    assert.equal(v.reason, "io_throttled", "(2) read at a mirror 600 s old");
    assert.equal(v.readings.thresholds.memory.mem_stale, true);
    assert.equal((await tick(c)).reason, "box: io_throttled", "the tick skips on it");
    const THROTTLED = { io_time_pct: 99, disk_all_read_mbps: 4, disk_all_write_mbps: 1, disk_reads_ps: 300 };
    await sample(c, THROTTLED);
    await sample(c, THROTTLED);
    const m = await mirror(c);
    assert.equal(Date.parse(m["io_throttle_until"] as string) - Date.parse(m["at"] as string), 60 * 60_000, "(3) the streak's hold REPLACES it: at + 60 min");
    console.info(`[r18] D13: hand ${hand} → after a throttle streak ${m["io_throttle_until"]}`);
  });
});
