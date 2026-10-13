/**
 * FIX-1308 — the unit dispatcher (`*_fix1308_dispatcher.sql`, cc-224).
 *
 * Runs via:  tsx --test src/__tests__/dispatcher.test.ts
 *
 * Source anchors (no DB, run in CI; rule 105), each a claim the design rests on:
 *   - D1/C2: dispatch_one_unit() is a SECURITY DEFINER FUNCTION owned by
 *     postgres, search_path public, pg_catalog, cron, EXECUTE revoked from
 *     PUBLIC/anon/authenticated and granted to service_role; dispatch_tick() is
 *     a PROCEDURE with NO proconfig (rule 237), EXECUTE to postgres only.
 *   - C3: the tick job's schedule is '1-59/N * * * *' — odd minutes at N = 2,
 *     never '*' + '/2' (the watchdogs' even minutes).
 *   - C1: a unit is ARMED with cron.schedule and a four-field one-shot schedule
 *     + '*'; never EXECUTEd inline; the budget row is INSERTed BEFORE
 *     cron.schedule, and the reap (and the missed path) DELETE it.
 *   - the fence row for dispatcher-tick parses with check:job-registry's own
 *     parser, and is `at …` (never dispatched) with its 120 s budget.
 *   - in_blackout() fails OPEN.
 * Behavioural, against the local clone inside BEGIN … ROLLBACK when the
 * migration is applied there: in_blackout's window arithmetic and its
 * fail-open answers. Skips when the DB is unreachable or not migrated.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { read, stripComments } from "./lib/migration-text";

/** check:job-registry's own fence parser (FIX-1307) — one contract, one reader. */
type ParseSeedFences = (text: string, file: string) => { rows: Array<Record<string, unknown>>; problems: string[] };
const CHECKER = path.join(__dirname, "..", "..", "..", "..", "scripts", "check-job-registry.mjs");

const MIGRATIONS = path.join(__dirname, "..", "..", "..", "..", "supabase", "migrations");
const FILE = (() => {
  const hits = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith("_fix1308_dispatcher.sql"));
  assert.equal(hits.length, 1, `expected exactly one *_fix1308_dispatcher.sql, found ${hits.join(", ") || "none"}`);
  return path.join(MIGRATIONS, hits[0] as string);
})();
const SRC = read(FILE);
const CODE = stripComments(SRC);
const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/** One routine's definition: CREATE through its closing dollar-quote (the box-backoff-gate shape). */
function definition(name: string): string {
  const fn = SRC.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const i = fn >= 0 ? fn : SRC.indexOf(`CREATE OR REPLACE PROCEDURE public.${name}(`);
  assert.notEqual(i, -1, `${name} is defined in the migration`);
  const tag = /AS (\$[a-z_]*\$)\n/.exec(SRC.slice(i))!;
  const a = i + tag.index + tag[0].length;
  return SRC.slice(i, SRC.indexOf(tag[1]!, a));
}
/** The header between the signature and `AS $…$` — where a SET clause would sit. */
const headerOf = (name: string) => definition(name).split(/\nAS \$/)[0] as string;
const bodyOf = (name: string) => stripComments(definition(name).split(/\nAS \$[a-z_]*\$\n/)[1] as string);

// ---------------------------------------------------------------------------
// D1 / C2 — the function, the procedure, the grants
// ---------------------------------------------------------------------------

test("D1/C2: dispatch_one_unit is a VOLATILE SECURITY DEFINER function with the cron search_path", () => {
  const h = headerOf("dispatch_one_unit");
  assert.match(h, /CREATE OR REPLACE FUNCTION public\.dispatch_one_unit\(p_source text DEFAULT 'pg_cron'\)/);
  assert.match(h, /RETURNS jsonb/);
  assert.match(h, /\bVOLATILE\b/);
  assert.match(h, /\bSECURITY DEFINER\b/);
  assert.match(h, /SET search_path TO 'public', 'pg_catalog', 'cron'/);
  assert.equal((h.match(/^\s*SET /gm) ?? []).length, 1, "one SET clause: search_path, never statement_timeout");
});

test("D1/C2: dispatch_one_unit is owned by postgres, revoked from anon/authenticated, granted to service_role", () => {
  assert.match(CODE, /ALTER FUNCTION public\.dispatch_one_unit\(text\) OWNER TO postgres;/);
  assert.match(CODE, /REVOKE ALL ON FUNCTION public\.dispatch_one_unit\(text\) FROM PUBLIC, anon, authenticated;/);
  assert.match(CODE, /GRANT EXECUTE ON FUNCTION public\.dispatch_one_unit\(text\) TO service_role;/);
});

test("rule 237: dispatch_tick is a PROCEDURE with no proconfig that PERFORMs the function as 'pg_cron'", () => {
  const h = headerOf("dispatch_tick");
  assert.match(h, /CREATE OR REPLACE PROCEDURE public\.dispatch_tick\(\)/);
  assert.doesNotMatch(h, /\bSET\b/, "a SET clause would make the procedure atomic");
  assert.doesNotMatch(h, /SECURITY DEFINER/);
  assert.match(bodyOf("dispatch_tick"), /PERFORM public\.dispatch_one_unit\('pg_cron'\);/);
  assert.match(CODE, /REVOKE ALL ON PROCEDURE public\.dispatch_tick\(\) FROM PUBLIC, anon, authenticated, service_role;/);
  assert.doesNotMatch(CODE, /GRANT [^;]*ON PROCEDURE public\.dispatch_tick/, "EXECUTE stays with postgres");
});

test("get_dispatcher_status and the tick_seconds trigger function are DEFINER, owned by postgres", () => {
  for (const name of ["get_dispatcher_status", "platform_dials_tick_reschedule"]) {
    assert.match(headerOf(name), /SECURITY DEFINER/, name);
    assert.match(headerOf(name), /SET search_path TO 'public', 'pg_catalog', 'cron'/, name);
    assert.match(CODE, new RegExp(`ALTER FUNCTION public\\.${name}\\(\\) OWNER TO postgres;`), name);
  }
  assert.match(CODE, /GRANT EXECUTE ON FUNCTION public\.get_dispatcher_status\(\) TO service_role;/);
});

// ---------------------------------------------------------------------------
// C3 — odd minutes
// ---------------------------------------------------------------------------

test("C3: the tick job is scheduled by NAME on '1-59/N', never on the watchdogs' even minutes", () => {
  assert.match(CODE, /c_jobname CONSTANT text := 'dispatcher-tick';/);
  assert.match(CODE, /c_cmd\s+CONSTANT text := 'CALL public\.dispatch_tick\(\);';/);
  assert.match(CODE, /SELECT '1-59\/' \|\| GREATEST\(1, ceil\(COALESCE\(max\(tick_seconds\), 120\) \/ 60\.0\)\)::int \|\| ' \* \* \* \*'/);
  assert.match(CODE, /SELECT jobid INTO v_jobid FROM cron\.job WHERE jobname = c_jobname;/);
  assert.match(CODE, /cron\.alter_job\(job_id := v_jobid, schedule := v_sched, command := c_cmd\)/);
  assert.doesNotMatch(CODE, /'\*\/2 \* \* \* \*'/, "never the even-minute */2");
  // The guard the migration itself carries, and the trigger's schedule.
  assert.match(CODE, /schedule ~ '\^1-59\/\[0-9\]\+ \\\* \\\* \\\* \\\*\$'/);
  assert.match(bodyOf("platform_dials_tick_reschedule"), /v_sched := '1-59\/' \|\| v_n \|\| ' \* \* \* \*';/);
  assert.match(bodyOf("platform_dials_tick_reschedule"), /SELECT jobid INTO v_jobid FROM cron\.job WHERE jobname = 'dispatcher-tick';/);
  // At the default 120 s the derived N is 2 → odd minutes 1,3,…,59.
  assert.equal(Math.max(1, Math.ceil(120 / 60)), 2);
  assert.match(`1-59/${Math.max(1, Math.ceil(120 / 60))} * * * *`, /^1-59\/\d+ \* \* \* \*$/);
});

test("C3: the tick's budget row is 120 s", () => {
  assert.match(CODE, /INSERT INTO public\.cron_job_budget \(jobname, budget_seconds, note\)\s*VALUES \('dispatcher-tick', 120,/);
});

// ---------------------------------------------------------------------------
// C1 — ARM, never EXECUTE inline; the budget row's life
// ---------------------------------------------------------------------------

test("C1: a unit is armed with cron.schedule on a four-field one-shot schedule + '*', never EXECUTEd", () => {
  const b = bodyOf("dispatch_one_unit");
  assert.match(b, /v_sched\s+:= format\('%s %s %s %s \*',/);
  assert.match(b, /v_armed_id := cron\.schedule\(v_armed_name, v_sched, v_pick_call\);/);
  assert.match(b, /v_armed_name := 'disp-' \|\| v_pick_job \|\| '-' \|\| floor\(EXTRACT\(epoch FROM v_now\)\)::bigint;/);
  assert.doesNotMatch(b, /\bEXECUTE\b/, "the dispatcher never EXECUTEs a unit inline (C1)");
  // The next ODD minute that is not :15/:45, in UTC.
  assert.match(b, /% 2 = 1/);
  assert.match(b, /NOT IN \(15, 45\)/);
  assert.match(b, /v_fire AT TIME ZONE 'UTC'/);
});

test("C1: the one-shot's budget row is INSERTed before cron.schedule", () => {
  const b = bodyOf("dispatch_one_unit");
  const ins = b.indexOf("INSERT INTO public.cron_job_budget (jobname, budget_seconds, note)");
  const sched = b.indexOf("cron.schedule(v_armed_name");
  assert.ok(ins > 0 && sched > ins, "budget INSERT precedes cron.schedule");
  assert.match(b.slice(b.lastIndexOf("IF v_pick_budget IS NOT NULL THEN", ins), ins), /IF v_pick_budget IS NOT NULL THEN/);
});

test("C1: the reap and the missed path DELETE the one-shot's budget row and unschedule it", () => {
  const b = bodyOf("dispatch_one_unit");
  const reaped = b.indexOf("(v_source, r.job, 'reaped',");
  const missed = b.indexOf("(v_source, r.job, 'missed',");
  assert.ok(reaped > 0 && missed > 0);
  const del = "DELETE FROM public.cron_job_budget WHERE jobname = r.armed_jobname;";
  const firstDel = b.indexOf(del);
  assert.ok(firstDel > 0 && firstDel < reaped, "the terminal reap deletes the budget row before it logs");
  assert.ok(b.lastIndexOf(del, missed) > reaped, "the missed path deletes it too");
  assert.ok(b.lastIndexOf("PERFORM cron.unschedule(r.armed_jobid);", missed) > reaped, "the missed path unschedules");
  assert.match(b, /IF r\.job_exists THEN PERFORM cron\.unschedule\(r\.armed_jobid\); END IF;/);
});

test("D12: `at` rows are never dispatched; the dispatcher's own row is excluded; R2 dispatches pg_cron rows only", () => {
  const b = bodyOf("dispatch_one_unit");
  assert.match(b, /WHERE j\.runner = 'pg_cron'\s+AND j\.deadline_rule NOT LIKE 'at %'\s+AND j\.job <> c_tick_job/);
});

test("pause and the box end the tick before anything is armed", () => {
  const b = bodyOf("dispatch_one_unit");
  const pause = b.indexOf("v_decision := 'paused';");
  const box = b.indexOf("public.box_is_saturated(p_include_watchdog_wall := false)");
  const arm = b.indexOf("cron.schedule(v_armed_name");
  assert.ok(pause > 0 && box > pause && arm > box);
  // D8: the headroom test is a named placeholder until FIX-1125's sensor, nothing else.
  assert.match(definition("dispatch_one_unit"), /-- D8: headroom test here \(FIX-1125\)\n/);
  assert.doesNotMatch(b, /headroom_target_mb/, "no headroom arithmetic in R2");
});

// ---------------------------------------------------------------------------
// The registry fence (FIX-1307's shape, its own parser)
// ---------------------------------------------------------------------------

test("the dispatcher-tick fence row parses with check:job-registry's parser and is never dispatchable", async () => {
  const { parseSeedFences } = (await import(pathToFileURL(CHECKER).href)) as { parseSeedFences: ParseSeedFences };
  const { rows, problems } = parseSeedFences(SRC, path.basename(FILE));
  assert.deepEqual(problems, []);
  assert.equal(rows.length, 1);
  const r = rows[0]!;
  assert.equal(r["job"], "dispatcher-tick");
  assert.equal(r["runner"], "pg_cron");
  assert.equal(r["unit_call"], "CALL public.dispatch_tick();");
  assert.equal(r["deadline_rule"], "at 1-59/2 * * * *");
  assert.equal(r["budget_seconds"], 120);
  assert.match(String(r["note"]), /no-band/);
});

// ---------------------------------------------------------------------------
// in_blackout — fails OPEN
// ---------------------------------------------------------------------------

test("in_blackout fails OPEN: null key/now, an absent or non-array config, an unparseable entry", () => {
  const h = headerOf("in_blackout");
  assert.match(h, /\bSTABLE\b/);
  assert.match(h, /SECURITY INVOKER/);
  const b = bodyOf("in_blackout");
  assert.match(b, /IF p_config_key IS NULL OR p_now IS NULL THEN\s+RETURN false;/);
  assert.match(b, /IF v_cfg IS NULL OR jsonb_typeof\(v_cfg->'blackout'\) IS DISTINCT FROM 'array' THEN\s+RETURN false;/);
  assert.match(b, /EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING[^;]*;\s+CONTINUE;/);
  assert.match(b, /RETURN false;\s*END;\s*$/);
});

async function connect(t: { skip: (m: string) => void }): Promise<Client | null> {
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  try {
    await c.connect();
  } catch {
    t.skip("local Docker DB unreachable");
    return null;
  }
  const fn = await c.query(
    "SELECT 1 FROM pg_proc WHERE proname = 'in_blackout' AND pronamespace = 'public'::regnamespace",
  );
  if (fn.rowCount === 0) {
    await c.end();
    t.skip("FIX-1308 not applied on this DB");
    return null;
  }
  return c;
}

test("in_blackout on the clone: inside, outside, wrap-around, and fail-open (BEGIN … ROLLBACK)", async (t) => {
  const c = await connect(t);
  if (!c) return;
  try {
    await c.query("BEGIN");
    const key = "cc224_blackout_probe";
    const set = (v: unknown) =>
      c.query(
        "INSERT INTO public.pipeline_state (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        [key, JSON.stringify(v)],
      );
    const at = async (iso: string) =>
      (await c.query("SELECT public.in_blackout($1, $2::timestamptz) AS b", [key, iso])).rows[0].b as boolean;

    await set({ blackout: [{ from: "06:45", to: "09:00" }] });
    assert.equal(await at("2026-10-15T07:00:00Z"), true, "inside");
    assert.equal(await at("2026-10-15T09:00:00Z"), false, "the end is exclusive");
    assert.equal(await at("2026-10-15T06:44:59Z"), false, "before");

    await set({ blackout: [{ from: "23:00", to: "01:00" }] });
    assert.equal(await at("2026-10-15T23:30:00Z"), true, "wrap-around, before midnight");
    assert.equal(await at("2026-10-16T00:30:00Z"), true, "wrap-around, after midnight");
    assert.equal(await at("2026-10-15T12:00:00Z"), false, "wrap-around, outside");

    await set({ blackout: "06:45-09:00" });
    assert.equal(await at("2026-10-15T07:00:00Z"), false, "non-array → open");
    await set({ blackout: [{ from: "nope", to: "09:00" }] });
    assert.equal(await at("2026-10-15T07:00:00Z"), false, "unparseable entry → ignored");
    assert.equal(
      (await c.query("SELECT public.in_blackout('cc224_no_such_key') AS b")).rows[0].b,
      false,
      "absent key → open",
    );
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    await c.end();
  }
});
