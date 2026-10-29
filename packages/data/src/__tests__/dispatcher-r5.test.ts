/**
 * FIX-1361 — dispatch_one_unit anchors a stale_after / by row that shares its
 * pipeline on its OWN cadence's data_sync_log rows (job_registry.anchor_cadence),
 * so a sibling's completion never satisfies its slot. FIX-1362 — the headroom
 * rung moves below 'live', so a running unit reads `live`, never
 * `headroom: … (<its own job>)`. cc-253,
 * `*_fix1361_dispatcher_anchor_cadence_and_headroom_rung_after_live.sql`.
 *
 * Runs via:  tsx --test src/__tests__/dispatcher-r5.test.ts
 *
 * A suffix-globbed test never sees a later CREATE OR REPLACE (rule 305), so
 * this file reads THIS migration's body. Text anchors (no DB, run in CI):
 *   - one CREATE OR REPLACE (dispatch_one_unit), the column before it, no
 *     other routine; the header byte-equal to prod's (the revert IS prod's
 *     pg_get_functiondef);
 *   - md5(prosrc) = the read-back's pin (≠ 64c8271e…), the revert's = 64c8271e…;
 *   - nothing else touched: a line diff against the revert is the select-list
 *     line, the two predicates, the moved 'live' branch and their comments;
 *   - the four shared rows, the CHECK, the read-back's pins;
 *   - the revert: the body first, the column last, the old pin asserted.
 * The clone tests (CIVITICS_CLONE_TESTS=1) run the tick on fixtures inside
 * rolled-back transactions: two rows sharing a pipeline, the daily's row newer
 * than the weekly's prev slot → the weekly is DUE with anchor_cadence 'weekly'
 * and NOT due with NULL; a due row that is live at a MemAvailable failing the
 * headroom test → `live (…)`, while an idle sibling still reads `headroom: …`.
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
const ANCHOR = () => one("_fix1361_dispatcher_anchor_cadence_and_headroom_rung_after_live.sql");
const WEEKLY = () => one("_fix1363_return_refresh_derived_mvs_weekly.sql");
const REVERT = () => read(path.join(ROOT, "scripts", "fix1361-revert-dispatcher-anchor-rung.sql"));

const OLD_PIN = "64c8271e7601095d275c68eff5187931";
const UNCHANGED = {
  get_dispatcher_status: "4c30523742e280a4b48ea2ec390654d6",
  box_is_saturated: "ac8dbcddf71978e73d28c999433156b7",
  prod_op_gate: "1d3507cd4b71439f0cfff51cde49b9d8",
} as const;
const SHARED = [
  ["refresh-derived-mvs-daily", "daily"],
  ["refresh-derived-mvs-weekly", "weekly"],
  ["rule-taggers-daily", "daily"],
  ["rule-taggers-weekly", "weekly"],
] as const;
const PREDICATE = "AND (r.anchor_cadence IS NULL OR l.metadata->>'cadence' = r.anchor_cadence)";

/** The `CREATE OR REPLACE FUNCTION public.<name>(` … `$function$` definition. */
function def(src: string, name: string): string {
  const start = src.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  assert.notEqual(start, -1, `${name}: no CREATE OR REPLACE`);
  const open = src.indexOf("AS $function$", start);
  const close = src.indexOf("$function$", open + "AS $function$".length);
  assert.ok(open > start && close > open, `${name}: dollar-quoted body`);
  return src.slice(start, close + "$function$".length);
}
const prosrc = (d: string) => d.slice(d.indexOf("AS $function$") + "AS $function$".length, d.lastIndexOf("$function$"));
const md5 = (s: string) => crypto.createHash("md5").update(s, "utf8").digest("hex");
const header = (d: string) => d.slice(0, d.indexOf("AS $function$"));
const body = () => prosrc(def(ANCHOR(), "dispatch_one_unit"));

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

// ---------------------------------------------------------------------------
// The file's shape
// ---------------------------------------------------------------------------

test("FIX-1361 redefines exactly dispatch_one_unit; no CREATE OR REPLACE text in its comments; FIX-1363 redefines none", () => {
  const raw = ANCHOR();
  const code = stripComments(raw);
  assert.equal(code.split("CREATE OR REPLACE FUNCTION public.dispatch_one_unit(").length - 1, 1);
  assert.equal([...code.matchAll(/CREATE (OR REPLACE )?(FUNCTION|PROCEDURE)/g)].length, 1, "one routine");
  assert.equal([...raw.matchAll(/CREATE OR REPLACE/g)].length, 1,
    "latest('dispatch_one_unit') readers glob the raw text: no CREATE OR REPLACE inside a comment");
  for (const r of ["get_dispatcher_status", "box_is_saturated", "prod_op_gate"]) {
    assert.ok(!raw.includes(`FUNCTION public.${r}(`), `${r} is not redefined`);
  }
  assert.doesNotMatch(code, /DROP FUNCTION/, "same signature: replaced in place");
  assert.doesNotMatch(stripComments(WEEKLY()), /CREATE (OR REPLACE )?(FUNCTION|PROCEDURE)/);
});

test("the column: ADD COLUMN IF NOT EXISTS anchor_cadence text + the named CHECK, before the body; no DEFAULT", () => {
  const code = stripComments(ANCHOR());
  assert.match(code, /ALTER TABLE public\.job_registry\s+ADD COLUMN IF NOT EXISTS anchor_cadence text\s+CONSTRAINT job_registry_anchor_cadence_check CHECK \(anchor_cadence IN \('daily', 'weekly', 'monthly'\)\);/);
  assert.ok(code.indexOf("ADD COLUMN IF NOT EXISTS anchor_cadence") < code.indexOf("CREATE OR REPLACE FUNCTION"), "the column first");
  assert.doesNotMatch(code, /anchor_cadence text\s+(NOT NULL|DEFAULT)/, "NULL = the old arithmetic for every unshared row");
  assert.match(code, /COMMENT ON COLUMN public\.job_registry\.anchor_cadence IS/);
});

test("the four shared rows, each matched on anchor_cadence IS NULL; no other registry write", () => {
  // Outside the body: the routine's own writes (phase_due_at, the budget rows) are not this file's.
  const all = stripComments(ANCHOR());
  const code = all.slice(0, all.indexOf("CREATE OR REPLACE FUNCTION")) + all.slice(all.indexOf("ALTER FUNCTION public.dispatch_one_unit"));
  for (const [job, cadence] of SHARED) {
    assert.match(code, new RegExp(`\\('${job}',\\s+'${cadence}'\\)`), `${job} → ${cadence}`);
  }
  assert.equal([...code.matchAll(/\('[a-z-]+',\s+'(daily|weekly|monthly)'\)/g)].length, 4, "exactly four pairs");
  assert.match(code, /SET anchor_cadence = r\.cadence,\s+updated_at\s+= now\(\)\s+WHERE job = r\.job\s+AND anchor_cadence IS NULL;/);
  assert.equal([...code.matchAll(/UPDATE public\.job_registry/g)].length, 1, "one UPDATE, the loop's");
  assert.doesNotMatch(code, /deadline_rule\s*=/, "no rule moves here (FIX-1363 is the next file)");
  assert.doesNotMatch(code, /UPDATE public\.platform_dials|DELETE FROM/i);
});

test("the header keeps prod's signature + SET clause byte-for-byte (the revert IS prod's pg_get_functiondef)", () => {
  assert.equal(header(def(ANCHOR(), "dispatch_one_unit")), header(def(REVERT(), "dispatch_one_unit")));
  assert.ok(header(def(ANCHOR(), "dispatch_one_unit")).includes(
    " LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'public', 'pg_catalog', 'cron'\n"));
});

test("md5(prosrc): the new body = the read-back's pin and FIX-1363's; the revert's = 64c8271e…", () => {
  const now = md5(body());
  assert.notEqual(now, OLD_PIN);
  assert.ok(ANCHOR().includes(`c_new_d CONSTANT text := '${now}'`), `FIX-1361's read-back pins ${now}`);
  assert.ok(ANCHOR().includes(`c_old_d CONSTANT text := '${OLD_PIN}'`));
  assert.ok(WEEKLY().includes(`c_pin_d CONSTANT text := '${now}'`), `FIX-1363's read-back asserts ${now}`);
  assert.equal(md5(prosrc(def(REVERT(), "dispatch_one_unit"))), OLD_PIN, "the revert restores 64c8271e…");
  for (const [r, pin] of Object.entries(UNCHANGED)) assert.ok(ANCHOR().includes(`'${pin}'`), `${r} asserted unchanged`);
});

test("nothing else touched: the line diff against 64c8271e… is the two edits and their comments", () => {
  const { removed, added } = lineDiff(prosrc(def(REVERT(), "dispatch_one_unit")), body());
  assert.deepEqual(removed, [
    "                 AND l.completed_at = v_last;",
    "          -- D8 (FIX-1354): the headroom test is the ladder's second rung, below.",
    "            -- headroom dial, or the row waits. Before 'live'; every runner.",
    "          ELSIF r.job = ANY (v_live_jobs) THEN",
    "            v_why := 'live';",
  ]);
  const ok = /^\s+j\.anchor_cadence,$|FIX-1361|FIX-1362|^\s+-- D8 \(FIX-1354\): the headroom test is the ladder's third rung, below$|^\s+-- anchors on its OWN cadence's rows|^\s+-- never satisfies its slot\.$|^\s+AND l\.completed_at = v_last$|^\s+AND \(r\.anchor_cadence IS NULL OR l\.metadata->>'cadence' = r\.anchor_cadence\)$|^\s+ELSIF r\.job = ANY \(v_live_jobs\) THEN$/;
  for (const l of added) assert.match(l, ok, `added line outside the two edits: ${JSON.stringify(l)}`);
  assert.equal(added.length, 12, "1 select + 3 comment + 1 predicate · 2 predicate · 2 marker · 2 live + 1 comment");
});

// ---------------------------------------------------------------------------
// (i) the anchor
// ---------------------------------------------------------------------------

test("(i) the loop selects j.anchor_cadence; v_last's read and v_adv_start's carry the cadence predicate", () => {
  const b = stripComments(body());
  assert.match(b, /j\.runner, j\.by_window_minutes, j\.yield_to, j\.yield_lead_seconds,\s+j\.anchor_cadence,\s+CASE WHEN j\.unit_shape = 'bare'/);
  assert.ok(b.includes(
    "SELECT l.completed_at, l.metadata->>'next_due_at' INTO v_last, v_next_due\n" +
    "                FROM public.data_sync_log l\n" +
    "               WHERE l.pipeline = r.pipeline AND l.status IN ('complete', 'partial')\n" +
    "                 AND l.completed_at IS NOT NULL\n" +
    `                 ${PREDICATE}\n` +
    "               ORDER BY l.completed_at DESC\n" +
    "               LIMIT 1;"), "v_last / v_next_due");
  assert.ok(b.includes(
    "SELECT max(l.started_at) INTO v_adv_start\n" +
    "                FROM public.data_sync_log l\n" +
    "               WHERE l.pipeline = r.pipeline AND l.status IN ('complete', 'partial')\n" +
    "                 AND l.completed_at = v_last\n" +
    `                 ${PREDICATE};`), "v_adv_start (the phase lock reads the row v_last came from)");
  assert.equal(b.split(PREDICATE).length - 1, 2, "exactly the two reads");
});

test("(i) the anchor in TS: the sibling's newer row satisfies the slot only when anchor_cadence is NULL", () => {
  // step 6's `by` arithmetic: due iff v_last IS NULL OR v_last < v_slot_prev.
  type Row = { completed_at: string; cadence: string };
  const rows: Row[] = [
    { completed_at: "2026-10-06T01:10:27Z", cadence: "weekly" },
    { completed_at: "2026-10-28T06:06:32Z", cadence: "daily" },
  ];
  const prev = Date.parse("2026-10-27T00:47:00Z");
  const due = (anchor: string | null) => {
    const own = rows.filter((r) => anchor === null || r.cadence === anchor).map((r) => Date.parse(r.completed_at));
    const last = own.length ? Math.max(...own) : null;
    return last === null || last < prev;
  };
  assert.equal(due(null), false, "cc-253 read 3: the old body reads the daily's Wed row → NOT due");
  assert.equal(due("weekly"), true, "the filter: the weekly's 10-06 row < Tue 00:47Z → DUE");
  assert.equal(due("monthly"), true, "a cadence with no row is a null anchor → due");
});

// ---------------------------------------------------------------------------
// (ii) the rung
// ---------------------------------------------------------------------------

test("(ii) the ladder: the cooldown, then 'live', then the headroom rung; live precedes every headroom: text", () => {
  const b = stripComments(body());
  const cooldown = b.indexOf("IF v_why IS NOT NULL THEN\n            NULL;");
  const live = b.indexOf("ELSIF r.job = ANY (v_live_jobs) THEN\n            v_why := 'live';");
  const rung = b.indexOf("ELSIF v_mem_avail IS NOT NULL\n                AND v_mem_avail - COALESCE(r.cap_mb, c_cap_default) < v_dials.headroom_target_mb THEN");
  const vac = b.indexOf("ELSIF r.unit_shape = 'bare' AND r.unit_call ~* '^\\s*VACUUM' AND v_vacuum_live IS NOT NULL THEN");
  assert.ok(cooldown > 0 && live > cooldown && rung > live && vac > rung, "cooldown → live → headroom → io");
  assert.match(b, /IF v_why IS NOT NULL THEN\s+NULL;\s+ELSIF r\.job = ANY \(v_live_jobs\) THEN\s+v_why := 'live';\s+ELSIF v_mem_avail IS NOT NULL/);
  assert.equal(b.split("v_why := 'live';").length - 1, 1, "one live branch");
  assert.ok(live < b.indexOf("v_why := format('headroom: "), "live precedes headroom:");
  assert.ok(b.includes("v_why := format('headroom: %s MB avail − %s MB cap < %s MB', v_mem_avail,\n                            COALESCE(r.cap_mb, c_cap_default), v_dials.headroom_target_mb);"),
    "the reason text unchanged (the s15b sensor reads it)");
});

// ---------------------------------------------------------------------------
// The read-back and the revert
// ---------------------------------------------------------------------------

test("the read-back RAISEs on any miss: column + CHECK, the four rows only, the pins, proconfig", () => {
  const code = stripComments(ANCHOR());
  assert.match(code, /RAISE EXCEPTION '\[fix1361\] read-back failed: %'/);
  assert.ok(code.includes(
    "'refresh-derived-mvs-daily=daily, refresh-derived-mvs-weekly=weekly, rule-taggers-daily=daily, rule-taggers-weekly=weekly'"));
  assert.ok(code.includes("conname = 'job_registry_anchor_cadence_check'"));
  assert.ok(code.includes("v_cfg IS DISTINCT FROM 'search_path=public, pg_catalog, cron'"));
  assert.match(code, /REVOKE ALL ON FUNCTION public\.dispatch_one_unit\(text\) FROM PUBLIC, anon, authenticated;/);
  assert.match(code, /GRANT EXECUTE ON FUNCTION public\.dispatch_one_unit\(text\) TO service_role;/);
  assert.match(code, /ALTER FUNCTION public\.dispatch_one_unit\(text\) OWNER TO postgres;/);
});

test("the revert: 64c8271e… first, DROP COLUMN last, the old pin asserted, no pause write", () => {
  const sql = stripComments(REVERT());
  assert.equal([...sql.matchAll(/CREATE OR REPLACE FUNCTION/g)].length, 1);
  const drop = sql.indexOf("ALTER TABLE public.job_registry DROP COLUMN IF EXISTS anchor_cadence;");
  assert.ok(drop > sql.indexOf("CREATE OR REPLACE FUNCTION public.dispatch_one_unit("), "the body first");
  assert.ok(sql.includes(`'${OLD_PIN}'`));
  assert.ok(!prosrc(def(REVERT(), "dispatch_one_unit")).includes("anchor_cadence"), "the old body never reads the column");
  assert.doesNotMatch(sql, /SET pause/, "pause is the operator's, not the payload's");
});

// ---------------------------------------------------------------------------
// Behavioural — the clone, after apply (CIVITICS_CLONE_TESTS=1 only)
// ---------------------------------------------------------------------------

const MB = 1048576;
const SWAP_TOTAL = 1073737728;
async function fixtures(c: Client, o: { swapMb: number; availMb: number }): Promise<void> {
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
    [o.availMb * MB, SWAP_TOTAL, SWAP_TOTAL - o.swapMb * MB],
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

/** Park every real row, open the dials, and reach a quiet box — inside the caller's transaction. */
async function isolate(c: Client, availMb: number): Promise<void> {
  await c.query("UPDATE public.job_registry SET deadline_rule = 'at 0 0 1 1 *' WHERE deadline_rule NOT LIKE 'at %'");
  await c.query(
    "UPDATE public.platform_dials SET pause = false, max_concurrent_units = 10, max_live_caps_mb = 100000, rearm_cooldown_seconds = 0",
  );
  await c.query("DELETE FROM public.pipeline_state WHERE key = 'prod_session'");
  await fixtures(c, { swapMb: 400, availMb });
}
const lastTick = async (c: Client) =>
  (await c.query("SELECT decision, job, reason, excluded FROM public.dispatch_log ORDER BY id DESC LIMIT 1")).rows[0];

test("clone: two rows share a pipeline; the daily's row is newer than the weekly's prev slot → DUE under 'weekly', NOT due under NULL", async (t) => {
  const c = await clone(t);
  if (!c) return;
  const tick = async (anchor: string | null) => {
    await c.query("BEGIN");
    try {
      await isolate(c, 500);
      await c.query(
        `INSERT INTO public.job_registry (job, runner, pipeline, unit_shape, unit_call, priority, deadline_rule, cost_class, cap_mb, anchor_cadence, note)
         VALUES ('cc253-test-weekly', 'pg_cron', 'cc253_test_shared', 'atomic', 'SELECT 1', 3, 'by 47 0 * * 2', 'mixed', 64, $1, 'cc-253 test')`,
        [anchor],
      );
      // The weekly's own last run: the week before its prev slot. The daily's: one second ago.
      await c.query(
        `INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata) VALUES
           ('cc253_test_shared', 'complete', public.cron_prev_slot('47 0 * * 2', now()) - interval '7 days',
            public.cron_prev_slot('47 0 * * 2', now()) - interval '7 days' + interval '20 minutes', '{"cadence": "weekly"}'),
           ('cc253_test_shared', 'complete', clock_timestamp() - interval '4 minutes',
            clock_timestamp() - interval '1 second', '{"cadence": "daily"}')`,
      );
      await c.query("SELECT public.dispatch_one_unit('manual')");
      return await lastTick(c);
    } finally {
      await c.query("ROLLBACK");
    }
  };
  try {
    let row = await tick("weekly");
    assert.equal(row.decision, "armed", JSON.stringify(row));
    assert.equal(row.job, "cc253-test-weekly");
    assert.match(row.reason, /^by 47 0 \* \* 2 → -/, "DUE: ttd negative, since its prev slot");

    row = await tick(null);
    assert.notEqual(row.decision, "armed", `the sibling's row satisfies the slot: ${JSON.stringify(row)}`);
    assert.ok(!(row.excluded ?? []).some((e: string) => e.endsWith("(cc253-test-weekly)")), "not due: no exclusion either");
    assert.match(row.reason ?? "", /next: cc253-test-weekly in /, "its next slot is the next Tuesday");
  } finally {
    await c.end();
  }
});

test("clone: a due row that is LIVE reads `live`, not `headroom:`, at a MemAvailable that fails the test; an idle sibling still reads headroom", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await c.query("BEGIN");
    try {
      await isolate(c, 200);  // 200 − 128 = 72 < 150: the rung fails for both rows
      await c.query(
        `INSERT INTO public.job_registry (job, runner, pipeline, unit_shape, unit_call, priority, deadline_rule, cost_class, cap_mb, note)
         VALUES ('cc253-test-live', 'pg_cron', 'cc253_test_live', 'atomic', 'SELECT 1', 2, 'stale_after 1 minutes', 'mixed', 128, 'cc-253 test'),
                ('cc253-test-idle', 'pg_cron', 'cc253_test_idle', 'atomic', 'SELECT 1', 3, 'stale_after 1 minutes', 'mixed', 128, 'cc-253 test')`,
      );
      // Live by the census: its pipeline has a `running` row inside c_running_win.
      await c.query(
        `INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
         VALUES ('cc253_test_live', 'running', clock_timestamp() - interval '30 seconds', '{"source": "cc-253 test"}')`,
      );
      await c.query("SELECT public.dispatch_one_unit('manual')");
      const row = await lastTick(c);
      const ex: string[] = row.excluded ?? [];
      assert.equal(row.decision, "nothing_due", JSON.stringify(row));
      assert.ok(ex.includes("live (cc253-test-live)"), JSON.stringify(ex));
      assert.ok(!ex.some((e) => e.startsWith("headroom:") && e.endsWith("(cc253-test-live)")), "a live unit never reads headroom");
      assert.ok(ex.includes("headroom: 200 MB avail − 128 MB cap < 150 MB (cc253-test-idle)"), JSON.stringify(ex));
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("clone: the four shared rows carry anchor_cadence and every other row is NULL", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    const rows = (await c.query(
      "SELECT job, anchor_cadence FROM public.job_registry WHERE anchor_cadence IS NOT NULL ORDER BY job",
    )).rows.map((r) => [r.job, r.anchor_cadence]);
    assert.deepEqual(rows, [...SHARED].sort((a, b) => a[0].localeCompare(b[0])));
    // A DISPATCHED row sharing its pipeline with another dispatched row carries a cadence
    // (OPERATIONS: a row that shares MUST). The crawls share with parked `at` rows only
    // (ec-crawl / rebuild-ec-incremental*, fe-crawl / financial-entity-totals-incremental):
    // an `at` row never reads the clock, so they are not siblings until one RETURNs.
    const bare = (await c.query(
      `SELECT j.job FROM public.job_registry j
        WHERE j.pipeline IS NOT NULL AND j.anchor_cadence IS NULL AND j.deadline_rule NOT LIKE 'at %'
          AND EXISTS (SELECT 1 FROM public.job_registry k
                       WHERE k.pipeline = j.pipeline AND k.job <> j.job AND k.deadline_rule NOT LIKE 'at %')`,
    )).rows.map((r) => r.job);
    assert.deepEqual(bare, [], "a dispatched registry row sharing its pipeline without anchor_cadence");
  } finally {
    await c.end();
  }
});
