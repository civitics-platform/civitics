/**
 * cc-264 — FIX-1375's io: rung, FIX-1376's estimates and FIX-1381's registry row:
 *   *_fix1375_io_rung_box_is_saturated_mirror_streak_dials.sql
 *   *_fix1376_platform_counts_estimated_four_tables_connection_type_mcv.sql
 *   *_fix1381_entity_tags_vacuum_analyze_registry_row.sql
 * prod_op_gate()'s (d) re-cut (FIX-1377, FIX-1353) is in prod-op-gate-recut.test.ts.
 *
 * Runs via:  tsx --test src/__tests__/dispatcher-r15.test.ts
 *
 * Text (no DB, run in CI):
 *   - the two reasons sit after memory and before watchdog_wall, io_throttled first;
 *   - every line of the base bodies survives, so the rung is purely additive;
 *   - the dials' defaults and CHECKs, and the brake (101) inside its CHECK;
 *   - the guards and the read-backs name the current md5s; the dispatcher pair stays;
 *   - the derived keys are stripped from the input.
 *
 * Clone (CIVITICS_CLONE_TESTS=1), inside BEGIN … ROLLBACK with the registry's table
 * lock first, as r9 does:
 *   - the streak, the carry, the reset; the hold set, kept and gone;
 *   - box_is_saturated's verdicts; a tick under a streak skips with NO arm;
 *   - the estimates' method mix; the row's due computation; the reverts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
const RUNG = () => one("_fix1375_io_rung_box_is_saturated_mirror_streak_dials.sql");
const COUNTS = () => one("_fix1376_platform_counts_estimated_four_tables_connection_type_mcv.sql");
const ROW = () => one("_fix1381_entity_tags_vacuum_analyze_registry_row.sql");
const BASE_BOX = () => one("_fix1354_box_gate_memory_rules.sql");
const BASE_MEM = () => one("_fix1375_box_health_mem_whitelist_disk_rates.sql");
const script = (f: string) => read(path.join(ROOT, "scripts", f));

type Checker = {
  parseSeedFences: (src: string, file: string) => { rows: Record<string, unknown>[]; problems: string[] };
  checkRegistry: (o: { fencesOnly?: boolean }) => { problems: string[]; warnings: string[] };
};
const checker = async () =>
  (await import(pathToFileURL(path.join(ROOT, "scripts", "check-job-registry.mjs")).href)) as Checker;

/** The pins: two move here, two do not. */
const PINS = {
  dispatch_one_unit: "d6a9073bcc4d9084b9d7994324a89b18",
  get_dispatcher_status: "4c30523742e280a4b48ea2ec390654d6",
  box_is_saturated: { was: "ac8dbcddf71978e73d28c999433156b7", now: "aaf6cc6552df532eff4a9b21e9780670" },
  prod_op_gate: { was: "1d3507cd4b71439f0cfff51cde49b9d8", now: "6488601cf8c09287d540989c0e0fd074" },
};
const MIRROR = { was: "b6a472e5ccabbf65e4f05106563ce6f4", now: "de9ebee733077a59dfe2959981f8e0c3" };
const COUNTS_MD5 = {
  platform: { prod: "a7fdc22d4da0da94b95ca2f35374a7f4", repo: "0c36e1f6231e3188370277c759883eb1", now: "0e5c3e7cbddaa50474a25f5f943a9272" },
  types: { was: "467bd98ff2f4f45358cb9b43ea05376e", now: "a188f729dcdcc7a2c32067da436bfbd5" },
};
const JOB = "entity-tags-vacuum-analyze";
const RULE = "dead_tuples > 60% of trigger + floor 24 hours";

const md5 = (s: string) => crypto.createHash("md5").update(s).digest("hex");

/** A routine's prosrc: the LAST definition in the file, between its dollar quotes. */
function prosrc(src: string, kind: "FUNCTION" | "PROCEDURE", name: string): string {
  const i = src.lastIndexOf(`CREATE OR REPLACE ${kind} public.${name}`);
  assert.notEqual(i, -1, `${name} is defined`);
  const m = src.slice(i).match(/AS (\$\w*\$)([\s\S]*?)\1/);
  assert.ok(m, `no dollar-quoted body after ${name}`);
  return m[2] as string;
}

// ---------------------------------------------------------------------------
// Text — the rung
// ---------------------------------------------------------------------------

test("the two reasons sit after memory and before watchdog_wall, io_throttled first (D1)", () => {
  const b = stripComments(prosrc(RUNG(), "FUNCTION", "box_is_saturated"));
  const at = (s: string) => {
    const i = b.indexOf(s);
    assert.notEqual(i, -1, s);
    return i;
  };
  assert.ok(at("v_reason := 'stale'") < at("v_reason := 'fork_failures'"));
  assert.ok(at("v_reason := 'fork_failures'") < at("v_reason := 'memory'"));
  assert.ok(at("v_reason := 'memory'") < at("v_reason := 'io_throttled'"));
  assert.ok(at("v_reason := 'io_throttled'") < at("v_reason := 'io_saturated'"));
  assert.ok(at("v_reason := 'io_saturated'") < at("v_reason := 'watchdog_wall'"));
  assert.match(b, /ELSIF NOT v_mem_stale AND v_io_until > p_now THEN/, "fresh mirrors only, on p_now");
  assert.match(b, /ELSIF NOT v_mem_stale AND v_io_streak >= v_io_samples THEN/);
});

test("box_is_saturated: readings.io and thresholds.io carry the keys the status surface reads", () => {
  const b = prosrc(RUNG(), "FUNCTION", "box_is_saturated");
  for (const k of ["'io_time_pct'", "'all_mbps'", "'reads_ps'", "'busy_streak'", "'throttle_until'"]) assert.ok(b.includes(k), k);
  for (const k of ["'ceiling'", "'samples'", "'mbps_floor'", "'hold_min'"]) assert.ok(b.includes(k), k);
  assert.match(b, /'io',\s+v_io,/, "readings.io");
});

test("the rung is additive: every line of both base bodies survives (one edited line in the mirror)", () => {
  const lines = (s: string) => new Set(s.split("\n"));
  const boxNew = lines(prosrc(RUNG(), "FUNCTION", "box_is_saturated"));
  const boxLost = prosrc(BASE_BOX(), "FUNCTION", "box_is_saturated").split("\n").filter((l) => !boxNew.has(l));
  assert.deepEqual(boxLost, [
    "  SELECT d.swap_ceiling_mb, d.headroom_target_mb INTO v_ceiling, v_headroom",
    "                                      'mem_stale',          v_mem_stale))));",
  ], "only the dial SELECT and the closing parens move");

  const memNew = lines(prosrc(RUNG(), "FUNCTION", "record_box_health_mem"));
  const memLost = prosrc(BASE_MEM(), "FUNCTION", "record_box_health_mem").split("\n").filter((l) => !memNew.has(l));
  assert.deepEqual(memLost, ["  FOR v_k IN SELECT jsonb_object_keys(p) LOOP"], "only the whitelist loop's input changes");
});

test("the derived keys are stripped from the input before the whitelist (D2)", () => {
  const b = stripComments(prosrc(RUNG(), "FUNCTION", "record_box_health_mem"));
  assert.match(b, /c_derived\s+CONSTANT text\[\]\s+:= ARRAY\['io_busy_streak', 'io_throttle_until'\]/);
  assert.match(b, /FOR v_k IN SELECT jsonb_object_keys\(p - c_derived\) LOOP/);
  assert.match(b, /IF p \? 'io_time_pct' THEN/, "an unrated sample carries the streak");
  assert.match(b, /IF v_streak >= v_samples AND v_all_mbps <= v_floor THEN/);
  assert.match(b, /make_interval\(mins => v_hold\)/);
});

test("the four dials: defaults, CHECKs, comments; the brake (101) is inside its own CHECK", () => {
  const s = RUNG();
  assert.match(s, /ADD COLUMN IF NOT EXISTS io_time_pct_ceiling numeric NOT NULL DEFAULT 90\s+CONSTRAINT \S+ CHECK \(io_time_pct_ceiling BETWEEN 50 AND 101\)/);
  assert.match(s, /ADD COLUMN IF NOT EXISTS io_samples int NOT NULL DEFAULT 3\s+CONSTRAINT \S+ CHECK \(io_samples BETWEEN 1 AND 30\)/);
  assert.match(s, /ADD COLUMN IF NOT EXISTS io_mbps_floor numeric NOT NULL DEFAULT 12\s+CONSTRAINT \S+ CHECK \(io_mbps_floor BETWEEN 0 AND 200\)/);
  assert.match(s, /ADD COLUMN IF NOT EXISTS io_throttle_hold_min int NOT NULL DEFAULT 60\s+CONSTRAINT \S+ CHECK \(io_throttle_hold_min BETWEEN 0 AND 1440\)/);
  for (const d of ["io_time_pct_ceiling", "io_samples", "io_mbps_floor", "io_throttle_hold_min"]) {
    assert.ok(s.includes(`COMMENT ON COLUMN public.platform_dials.${d} IS`), d);
  }
  // Both routines fall back to the DEFAULTs when the row is absent.
  for (const fn of ["box_is_saturated", "record_box_health_mem"]) {
    const b = prosrc(s, "FUNCTION", fn);
    assert.match(b, /c_io_time_pct_ceiling CONSTANT numeric := 90;/, fn);
    assert.match(b, /c_io_samples\s+CONSTANT int\s+:= 3;/, fn);
    assert.match(b, /c_io_mbps_floor\s+CONSTANT numeric := 12;/, fn);
    assert.match(b, /c_io_throttle_hold_min CONSTANT int\s+:= 60;/, fn);
  }
});

test("the md5s: the bodies hash to what the read-back names; the guards name the live pins", () => {
  const s = RUNG();
  assert.equal(md5(prosrc(s, "FUNCTION", "box_is_saturated")), PINS.box_is_saturated.now);
  assert.equal(md5(prosrc(s, "FUNCTION", "record_box_health_mem")), MIRROR.now);
  assert.equal(md5(prosrc(BASE_BOX(), "FUNCTION", "box_is_saturated")), PINS.box_is_saturated.was);
  assert.equal(md5(prosrc(BASE_MEM(), "FUNCTION", "record_box_health_mem")), MIRROR.was);
  for (const m of [MIRROR.was, MIRROR.now, PINS.box_is_saturated.was, PINS.box_is_saturated.now,
                   PINS.dispatch_one_unit, PINS.get_dispatcher_status, PINS.prod_op_gate.was, PINS.prod_op_gate.now]) {
    assert.ok(s.includes(m), m);
  }
  assert.match(s, /RAISE EXCEPTION '\[fix1375\] read-back failed/);
  assert.match(s, /column_default::text/, "::text in the read-back (rule 421)");
});

test("file A touches neither dispatcher body; a new box reason needs no dispatch_one_unit change", () => {
  const s = stripComments(RUNG());
  assert.doesNotMatch(s, /CREATE OR REPLACE FUNCTION public\.(dispatch_one_unit|get_dispatcher_status|prod_op_gate)/);
  const live = one("_fix1361_dispatcher_anchor_cadence_and_headroom_rung_after_live.sql");
  assert.match(live, /v_reason\s+:= 'box: ' \|\| COALESCE\(v_box->>'reason', 'unknown'\);/, "`box: ` + reason is already its rendering");
});

test("the rung's revert restores both bodies, refuses while the gate reads the dial, and drops ×4", () => {
  const r = script("fix1375-revert-io-rung.sql");
  assert.equal(md5(prosrc(r, "FUNCTION", "box_is_saturated")), PINS.box_is_saturated.was);
  assert.equal(md5(prosrc(r, "FUNCTION", "record_box_health_mem")), MIRROR.was);
  assert.match(r, /v_gate LIKE '%io_samples%'/);
  for (const d of ["io_time_pct_ceiling", "io_samples", "io_mbps_floor", "io_throttle_hold_min"]) {
    assert.ok(r.includes(`DROP COLUMN IF EXISTS ${d}`), d);
  }
  assert.ok(r.lastIndexOf("CREATE OR REPLACE FUNCTION public.box_is_saturated") < r.lastIndexOf("DROP COLUMN IF EXISTS"), "bodies first");
});

// ---------------------------------------------------------------------------
// Text — FIX-1376
// ---------------------------------------------------------------------------

test("FIX-1376: the four tables read reltuples, as 'estimated' (the CHECK's value, never 'approx')", () => {
  const s = COUNTS();
  const b = stripComments(prosrc(s, "PROCEDURE", "refresh_platform_counts"));
  for (const t of ["entity_connections", "financial_relationships", "financial_entities", "entity_tags"]) {
    assert.ok(b.includes(`'SELECT count(*) FROM public.${t}', 'public.${t}')`), t);
  }
  assert.match(b, /v_method := 'estimated';/);
  assert.doesNotMatch(stripComments(s), /'approx'/);
  assert.match(b, /v_reltuples::bigint/, "direct: real::numeric would keep six significant digits");
  assert.match(b, /IF v_reltuples >= 0 THEN/, "never-analyzed (-1) falls back");
  assert.match(b, /'method_mix', jsonb_build_object\('estimated', to_jsonb\(v_estimated\), 'exact', to_jsonb\(v_exact\)\)/);
});

test("FIX-1376: the small metrics stay exact; vote_connection_total sums the rollup after the refresh", () => {
  const b = stripComments(prosrc(COUNTS(), "PROCEDURE", "refresh_platform_counts"));
  for (const m of ["officials", "proposals", "votes", "ai_summary_cache"]) {
    assert.match(b, new RegExp(`\\('${m}',\\s+'SELECT count\\(\\*\\) FROM public\\.${m}', NULL(::text)?\\)`), m);
  }
  assert.doesNotMatch(b, /FROM public\.entity_connections\s+WHERE connection_type/, "no Seq Scan left for the vote total");
  assert.ok(b.indexOf("PERFORM public.refresh_connection_type_counts()") < b.indexOf("SELECT 'vote_connection_total'"));
});

test("FIX-1376: the rollup reads pg_stats through float8, upserts, and keeps the exact fallback", () => {
  const s = COUNTS();
  const b = stripComments(prosrc(s, "FUNCTION", "refresh_connection_type_counts"));
  assert.match(b, /most_common_freqs/);
  assert.match(b, /round\(m\.freq::float8 \* v_reltuples::float8\)::bigint/);
  assert.match(b, /ON CONFLICT \(connection_type\) DO UPDATE/, "a type outside the MCV list keeps its row");
  assert.match(b, /IF v_vals IS NULL OR v_reltuples < 0 THEN/);
  assert.ok(b.indexOf("TRUNCATE") > b.indexOf("IF v_vals IS NULL") && b.indexOf("TRUNCATE") < b.indexOf("RETURN;"), "TRUNCATE only on the exact path");
  assert.match(s, /ADD COLUMN IF NOT EXISTS method text NOT NULL DEFAULT 'exact'\s+CONSTRAINT \S+ CHECK \(method IN \('exact', 'estimated', 'planned'\)\)/);
});

test("FIX-1376: the md5s, both of fix1126's, and the revert's LF twin", () => {
  const s = COUNTS();
  assert.equal(md5(prosrc(s, "PROCEDURE", "refresh_platform_counts")), COUNTS_MD5.platform.now);
  assert.equal(md5(prosrc(s, "FUNCTION", "refresh_connection_type_counts")), COUNTS_MD5.types.now);
  for (const m of [COUNTS_MD5.platform.prod, COUNTS_MD5.platform.repo, COUNTS_MD5.platform.now, COUNTS_MD5.types.was, COUNTS_MD5.types.now]) {
    assert.ok(s.includes(m), m);
  }
  const r = script("fix1376-revert-platform-counts-exact.sql");
  assert.equal(md5(prosrc(r, "PROCEDURE", "refresh_platform_counts")), COUNTS_MD5.platform.repo);
  assert.equal(md5(prosrc(r, "FUNCTION", "refresh_connection_type_counts")), COUNTS_MD5.types.was);
});

// ---------------------------------------------------------------------------
// Text — FIX-1381
// ---------------------------------------------------------------------------

test("FIX-1381: the row parses from its fence on the ec/fe shape, group tags (the table's writers)", async () => {
  const { rows, problems } = (await checker()).parseSeedFences(ROW(), "fix1381");
  assert.deepEqual(problems, []);
  assert.equal(rows.length, 1);
  const r = rows[0] as Record<string, unknown>;
  assert.equal(r["job"], JOB);
  assert.equal(r["runner"], "pg_cron");
  assert.equal(r["pipeline"], null);
  assert.equal(r["unit_shape"], "bare");
  assert.equal(r["unit_call"], "VACUUM (ANALYZE) public.entity_tags;");
  assert.equal(r["priority"], 4);
  assert.equal(r["deadline_rule"], RULE);
  assert.equal(r["cost_class"], "io");
  assert.equal(r["cap_mb"], 64);
  assert.equal(r["exclusion_group"], "tags");
  assert.equal(r["budget_seconds"], null);
  assert.equal(r["idempotent_refire"], true);
  assert.equal(r["phase_lock"], true);
  assert.match(String(r["note"]), /FIX-1381/);
  assert.match(String(r["note"]), /no-band/);
});

test("FIX-1381: the registry check needs no cron job for a dispatched row", async () => {
  const { problems, warnings } = (await checker()).checkRegistry({ fencesOnly: true });
  assert.deepEqual(problems.filter((p) => p.includes(JOB)), []);
  assert.deepEqual(warnings.filter((w) => w.includes(JOB)), []);
});

test("FIX-1381: the read-back names the rung's bodies; the revert deletes by job", () => {
  const s = ROW();
  for (const m of [PINS.box_is_saturated.now, PINS.prod_op_gate.now, MIRROR.now, PINS.dispatch_one_unit, PINS.get_dispatcher_status]) {
    assert.ok(s.includes(m), m);
  }
  assert.match(script("fix1381-revert-entity-tags-vacuum-row.sql"), /DELETE FROM public\.job_registry WHERE job = 'entity-tags-vacuum-analyze';/);
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

/** The registry's table lock FIRST (r9's reason: r4 / r5 / r7 write it in another order). */
async function begin(c: Client): Promise<void> {
  await c.query("BEGIN");
  await c.query("LOCK TABLE public.job_registry IN SHARE ROW EXCLUSIVE MODE");
}

const MB = 1048576;
const MEM = { mem_available_bytes: 450 * MB, mem_total_bytes: 948191232, swap_total_bytes: 1073737728, swap_free_bytes: 1073737728 - 490 * MB };

/** A fresh probe and no mirror, with the dials at their DEFAULTs. */
async function freshBox(c: Client): Promise<void> {
  await c.query("UPDATE public.platform_dials SET io_time_pct_ceiling = 90, io_samples = 3, io_mbps_floor = 12, io_throttle_hold_min = 60, pause = false");
  await c.query("DELETE FROM public.pipeline_state WHERE key IN ('box_health_mem', 'prod_session')");
  await c.query(
    `INSERT INTO public.pipeline_state (key, value, updated_at)
     VALUES ('box_health', jsonb_build_object('at', clock_timestamp(), 'startup_timeouts_10m', 0,
                                              'watchdog_max_wall_10m', jsonb_build_object('unit', 0, 'budget', 0)), now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
  );
}

async function sample(c: Client, rates: Record<string, unknown>): Promise<void> {
  await c.query("SELECT public.record_box_health_mem($1::jsonb)", [JSON.stringify({ ...MEM, ...rates })]);
}
async function mirror(c: Client): Promise<Record<string, unknown>> {
  return (await c.query("SELECT value FROM public.pipeline_state WHERE key = 'box_health_mem'")).rows[0].value;
}
async function verdict(c: Client): Promise<{ saturated: boolean; reason: string; readings: Record<string, unknown> }> {
  return (await c.query("SELECT public.box_is_saturated(p_include_watchdog_wall := false) AS b")).rows[0].b;
}
const BUSY = { io_time_pct: 97, disk_all_read_mbps: 30, disk_all_write_mbps: 1, disk_reads_ps: 2800 };
const THROTTLED = { io_time_pct: 99, disk_all_read_mbps: 4, disk_all_write_mbps: 1, disk_reads_ps: 300 };

test("clone: the streak climbs 0→1→2→3, an unrated sample carries it, a sample at 10 % resets it", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await begin(c);
    try {
      await freshBox(c);
      await sample(c, {});
      assert.equal((await mirror(c))["io_busy_streak"], 0, "no prior row, no rate: 0");
      await sample(c, BUSY);
      assert.equal((await mirror(c))["io_busy_streak"], 1);
      await sample(c, BUSY);
      assert.equal((await mirror(c))["io_busy_streak"], 2);
      assert.equal((await verdict(c)).reason, "clear", "two samples are not a streak");
      await sample(c, {});
      assert.equal((await mirror(c))["io_busy_streak"], 2, "unrated: carried");
      await sample(c, BUSY);
      assert.equal((await mirror(c))["io_busy_streak"], 3);
      const v = await verdict(c);
      assert.equal(v.reason, "io_saturated");
      assert.equal(v.saturated, true);
      assert.equal((v.readings["io"] as { busy_streak: number }).busy_streak, 3);
      assert.deepEqual((v.readings["thresholds"] as { io: unknown }).io, { ceiling: 90, samples: 3, mbps_floor: 12, hold_min: 60 });
      await sample(c, { ...BUSY, io_time_pct: 10 });
      assert.equal((await mirror(c))["io_busy_streak"], 0);
      assert.equal((await verdict(c)).reason, "clear");
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("clone: the hold is set at streak 3 under the floor, kept while future, gone after; a caller cannot forge it", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await begin(c);
    try {
      await freshBox(c);
      await sample(c, THROTTLED);
      await sample(c, THROTTLED);
      assert.equal((await mirror(c))["io_throttle_until"], undefined, "no hold before the streak stands");
      await sample(c, THROTTLED);
      const m = await mirror(c);
      const until = Date.parse(m["io_throttle_until"] as string);
      assert.equal(until - Date.parse(m["at"] as string), 60 * 60_000, "at + 60 min");
      assert.equal((await verdict(c)).reason, "io_throttled");

      await sample(c, { ...BUSY, io_time_pct: 10 });
      const kept = await mirror(c);
      assert.equal(kept["io_busy_streak"], 0, "the streak resets");
      assert.ok(kept["io_throttle_until"], "the hold outlives it");
      assert.equal((await verdict(c)).reason, "io_throttled");

      await c.query(
        `UPDATE public.pipeline_state
            SET value = value || jsonb_build_object('io_throttle_until', now() - interval '1 second')
          WHERE key = 'box_health_mem'`,
      );
      await sample(c, { ...BUSY, io_time_pct: 10 });
      assert.equal((await mirror(c))["io_throttle_until"], undefined, "expired: absent");
      assert.equal((await verdict(c)).reason, "clear");

      await sample(c, { ...BUSY, io_busy_streak: 50, io_throttle_until: "2099-01-01T00:00:00Z" });
      const forged = await mirror(c);
      assert.equal(forged["io_busy_streak"], 1, "derived, not accepted");
      assert.equal(forged["io_throttle_until"], undefined);
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("clone: memory outranks the rung, a stale mirror leaves it silent, and the brake (101) disarms it", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await begin(c);
    try {
      await freshBox(c);
      for (let i = 0; i < 3; i++) await sample(c, BUSY);
      await c.query(
        `UPDATE public.pipeline_state SET value = value || jsonb_build_object('swap_free_bytes', 0) WHERE key = 'box_health_mem'`,
      );
      assert.equal((await verdict(c)).reason, "memory");

      await freshBox(c);
      for (let i = 0; i < 3; i++) await sample(c, BUSY);
      await c.query(
        `UPDATE public.pipeline_state SET value = value || jsonb_build_object('at', now() - interval '10 minutes') WHERE key = 'box_health_mem'`,
      );
      assert.equal((await verdict(c)).reason, "clear", "a stale mirror never saturates");

      await freshBox(c);
      await c.query("UPDATE public.platform_dials SET io_time_pct_ceiling = 101");
      for (let i = 0; i < 4; i++) await sample(c, { ...BUSY, io_time_pct: 100 });
      assert.equal((await mirror(c))["io_busy_streak"], 0, "the sampler clamps at 100, so no sample reaches 101");
      assert.equal((await verdict(c)).reason, "clear");
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("clone: a tick under a streak skips with `box: io_saturated` and arms nothing; the pair's md5s stand", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await begin(c);
    try {
      await freshBox(c);
      for (let i = 0; i < 3; i++) await sample(c, BUSY);
      const d = (await c.query("SELECT public.dispatch_one_unit('manual') AS d")).rows[0].d;
      assert.equal(d.decision, "skipped", JSON.stringify(d));
      assert.equal(d.reason, "box: io_saturated");
      assert.equal(d.armed_jobid, null);

      await freshBox(c);
      for (let i = 0; i < 3; i++) await sample(c, THROTTLED);
      const e = (await c.query("SELECT public.dispatch_one_unit('manual') AS d")).rows[0].d;
      assert.equal(e.reason, "box: io_throttled");
      assert.equal(e.armed_jobid, null);

      const pins = (await c.query(
        `SELECT proname, md5(prosrc) AS m FROM pg_proc
          WHERE pronamespace = 'public'::regnamespace AND proname IN ('dispatch_one_unit', 'get_dispatcher_status')`,
      )).rows as { proname: "dispatch_one_unit" | "get_dispatcher_status"; m: string }[];
      for (const p of pins) assert.equal(p.m, PINS[p.proname], p.proname);
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("clone: the tick row's box carries readings.io; get_dispatcher_status()->'box' does not, and its pin stays", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await begin(c);
    try {
      await freshBox(c);
      for (let i = 0; i < 3; i++) await sample(c, BUSY);
      const id = (await c.query("SELECT public.dispatch_one_unit('manual') AS d")).rows[0].d.id;
      const box = (await c.query("SELECT box FROM public.dispatch_log WHERE id = $1", [id])).rows[0].box;
      assert.equal(box.io.busy_streak, 3, JSON.stringify(box));
      assert.equal(box.io.all_mbps, 31);
      assert.equal(box.thresholds.io.ceiling, 90);
      const s = (await c.query("SELECT public.get_dispatcher_status() AS s")).rows[0].s;
      assert.deepEqual(Object.keys(s.box).sort(), ["decision", "memory", "thresholds_memory", "ticked_at"], "fix1354's projection");
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("clone: the CALL writes the four totals and the vote total as estimated; method_mix reports them", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await begin(c);
    try {
      await c.query("CALL public.refresh_platform_counts()");
      const rows = (await c.query(
        "SELECT metric, method FROM public.platform_counts WHERE metric NOT LIKE 'vote_category:%' ORDER BY metric",
      )).rows as { metric: string; method: string }[];
      const by = Object.fromEntries(rows.map((r) => [r.metric, r.method]));
      for (const m of ["entity_connections", "financial_relationships", "financial_entities", "entity_tags", "vote_connection_total"]) {
        assert.equal(by[m], "estimated", m);
      }
      for (const m of ["officials", "proposals", "proposals_bills", "proposals_regulations", "votes", "ai_summary_cache", "total_pacs", "tagged_pacs"]) {
        assert.equal(by[m], "exact", m);
      }
      const mix = (await c.query(
        "SELECT metadata->'method_mix' AS m FROM public.data_sync_log WHERE pipeline = 'platform_counts_daily' ORDER BY completed_at DESC LIMIT 1",
      )).rows[0].m;
      assert.ok(mix.estimated.includes("connection_type_counts"), JSON.stringify(mix));
      assert.ok(mix.estimated.includes("vote_connection_total"), JSON.stringify(mix));
      assert.ok(mix.exact.includes("officials"), JSON.stringify(mix));

      const types = (await c.query("SELECT connection_type, total, method FROM public.connection_type_counts")).rows as { connection_type: string; method: string }[];
      assert.ok(types.filter((r) => r.method === "estimated").length >= 12, "the MCV types");
      assert.ok(types.some((r) => r.connection_type === "revolving_door"), "a type outside the MCV list keeps its row");
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

/** The tick's own row: `job` is the pick, or the first blocked due row (a claim elsewhere reads `gated:`). */
async function tickSees(c: Client, job: string): Promise<boolean> {
  const id = (await c.query("SELECT public.dispatch_one_unit('manual') AS d")).rows[0].d.id;
  const r = (await c.query("SELECT job, excluded FROM public.dispatch_log WHERE id = $1", [id])).rows[0];
  return r.job === job || ((r.excluded as string[] | null) ?? []).some((e) => e.includes(job));
}

test("clone: the row's due computation — above the trigger due, below not, the floor due", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await begin(c);
    try {
      await freshBox(c);
      await sample(c, { io_time_pct: 1, disk_all_read_mbps: 1, disk_all_write_mbps: 1 });
      await c.query(
        "UPDATE public.job_registry SET deadline_rule = 'at 0 0 1 1 *' WHERE deadline_rule NOT LIKE 'at %' AND job <> $1",
        [JOB],
      );
      await c.query("UPDATE public.platform_dials SET max_concurrent_units = 10, max_live_caps_mb = 100000, rearm_cooldown_seconds = 0");

      // A recent reaped run, so the floor is not due and only the percentage term can be.
      const recent = await c.query(
        `INSERT INTO public.dispatch_log (source, job, decision, reason, armed_jobid, ticked_at)
         VALUES ('manual', $1, 'reaped', 'succeeded: CALL', 999999, clock_timestamp()) RETURNING id`,
        [JOB],
      );

      await c.query("ALTER TABLE public.entity_tags SET (autovacuum_vacuum_threshold = 2000000000)");
      assert.equal(await tickSees(c, JOB), false, "below 60 % of the trigger, inside the floor: not due");

      await c.query("ALTER TABLE public.entity_tags SET (autovacuum_vacuum_threshold = 0, autovacuum_vacuum_scale_factor = 0)");
      assert.equal(await tickSees(c, JOB), true, "at the trigger: due");

      await c.query("ALTER TABLE public.entity_tags SET (autovacuum_vacuum_threshold = 2000000000, autovacuum_vacuum_scale_factor = 0.05)");
      await c.query("DELETE FROM public.dispatch_log WHERE job = $1 AND id >= $2", [JOB, recent.rows[0].id]);
      await c.query("UPDATE public.job_registry SET phase_due_at = NULL WHERE job = $1", [JOB]);
      const last = (await c.query(
        `SELECT GREATEST(s.last_vacuum, s.last_autovacuum) AS at FROM pg_stat_user_tables s
          WHERE s.relid = 'public.entity_tags'::regclass`,
      )).rows[0].at as Date | null;
      if (last && Date.now() - last.getTime() < 24 * 3600_000) {
        console.info("[r15] the clone vacuumed entity_tags inside 24 h — floor case not exercised");
      } else {
        assert.equal(await tickSees(c, JOB), true, "past the floor: due");
      }
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("clone: the reverts restore every md5, the row and the dials, in order", async (t) => {
  const c = await clone(t);
  if (!c) return;
  const md5s = async () => Object.fromEntries((await c.query(
    `SELECT proname, md5(prosrc) AS m FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('box_is_saturated', 'record_box_health_mem', 'prod_op_gate', 'refresh_platform_counts', 'refresh_connection_type_counts')`,
  )).rows.map((r: { proname: string; m: string }) => [r.proname, r.m]));
  try {
    await begin(c);
    try {
      await assert.rejects(() => c.query("SAVEPOINT s; " + script("fix1375-revert-io-rung.sql")), /run scripts\/fix1377-revert-prod-op-gate-d\.sql first/);
      await c.query("ROLLBACK TO SAVEPOINT s");

      await c.query(script("fix1381-revert-entity-tags-vacuum-row.sql"));
      await c.query(script("fix1376-revert-platform-counts-exact.sql"));
      await c.query(script("fix1377-revert-prod-op-gate-d.sql"));
      await c.query(script("fix1375-revert-io-rung.sql"));

      assert.deepEqual(await md5s(), {
        box_is_saturated: PINS.box_is_saturated.was,
        prod_op_gate: PINS.prod_op_gate.was,
        record_box_health_mem: MIRROR.was,
        refresh_platform_counts: COUNTS_MD5.platform.repo,
        refresh_connection_type_counts: COUNTS_MD5.types.was,
      });
      assert.equal((await c.query("SELECT 1 FROM public.job_registry WHERE job = $1", [JOB])).rowCount, 0);
      assert.equal((await c.query(
        "SELECT 1 FROM information_schema.columns WHERE table_name = 'platform_dials' AND column_name LIKE 'io\\_%'",
      )).rowCount, 0);
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});
