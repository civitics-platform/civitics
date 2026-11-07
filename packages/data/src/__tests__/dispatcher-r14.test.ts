/**
 * FIX-1382 — contract_flow_rollups_rebuild's cutover hold converted to a 168 h
 * cadence row on its first dispatched Thu slot receipt (11-05 14:00Z). cc-263,
 * `20261106000000_fix1382_convert_contract_flow_rollups_refresh_hold_cadence_168`,
 * the sixth conversion and the ninth file of cc-263's manifest. r13's fixture
 * is FIX-1380's, so this file is its own suite.
 *
 * Runs via:  tsx --test src/__tests__/dispatcher-r14.test.ts
 *
 * Text anchors (no DB, run in CI):
 *   - the file touches exactly its one rollup_watch_overrides row, by
 *     pipeline, with cadence 168; it writes no job_registry, pipeline_state,
 *     cron or dial row and defines no routine;
 *   - the hold guard is FIX-1311's takeover hold or the push's own session
 *     hold; the verdict guard RAISEs on sustained_regression only;
 *   - the registry row asserted is read 4's; the pins are the current four;
 *   - the nine files from fix1374 on are cc-263's manifest in version order;
 *   - the revert matches the FIX-1382 note and restores an md5-pinned note.
 * Clone tests (CIVITICS_CLONE_TESTS=1, inside BEGIN … ROLLBACK): from the
 * FIX-1311 hold the file converts exactly its row, twice; it converts on absent,
 * insufficient_data (the clone as it stands) and seeded ok, and RAISEs on a
 * seeded sustained_regression; a human hold RAISEs and the session's own hold is
 * admitted; the revert restores FIX-1311's hold_reason and note byte-for-byte
 * against a row captured before the apply.
 * FIX-1383 (the same run's tenth file, the sweeps' 744 h conversions) follows, on
 * the same fixture: text anchors, then the clone (it already carries fix1374).
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
  return hits[0] as string;
}
const md5 = (s: string) => crypto.createHash("md5").update(s, "utf8").digest("hex");

const PIPELINE = "contract_flow_rollups_rebuild";
const NOTE_MD5 = "e244409743016116d42147d29c4d9744"; // cc-263 read 4, prod = clone
const SUFFIX = "_fix1382_convert_contract_flow_rollups_refresh_hold_cadence_168.sql";
const FILE = () => read(path.join(MIGRATIONS, one(SUFFIX)));
const REVERT = () => read(path.join(ROOT, "scripts", "fix1382-revert-convert-contract-flow-hold.sql"));

/** md5(prosrc) of a function, from the LATEST migration that defines it. */
function pinOf(fn: string): string {
  const sig = `CREATE OR REPLACE FUNCTION public.${fn}(`;
  const f = fs
    .readdirSync(MIGRATIONS)
    .filter((x) => x.endsWith(".sql"))
    .sort()
    .filter((x) => read(path.join(MIGRATIONS, x)).includes(sig))
    .pop()!;
  const src = read(path.join(MIGRATIONS, f));
  const at = src.lastIndexOf(sig);
  const m = src.slice(at).match(/AS (\$\w*\$)([\s\S]*?)\1/);
  assert.ok(m, `${fn}: a dollar-quoted body in ${f}`);
  return md5(m[2] as string);
}

test("FIX-1382: the file converts exactly its one row, by pipeline, to 168 h", () => {
  const sql = stripComments(FILE());
  assert.ok(sql.includes(`c_pipeline CONSTANT text := '${PIPELINE}';`));
  assert.ok(sql.includes("c_hours    CONSTANT int  := 168;"));
  assert.equal((sql.match(/\bUPDATE\b/g) ?? []).length, 1, "one UPDATE");
  assert.match(sql, /UPDATE public\.rollup_watch_overrides\s+SET held_since\s+= NULL,\s+hold_reason\s+= NULL,\s+cadence_hours = c_hours,/);
  assert.match(sql, /WHERE pipeline = c_pipeline\s+AND retired_at IS NULL/);
  assert.match(sql, /IF v_n <> 1 THEN\s+RAISE EXCEPTION '\[fix1382\] % conversion touched % rows, expected 1'/);
  assert.ok(FILE().includes("note          = format('FIX-1382 (cc-263) — "), "the note's prefix the read-back matches");
});

test("FIX-1382: no job_registry, pipeline_state, cron or dial write; no routine; no DELETE/INSERT", () => {
  const sql = stripComments(FILE());
  assert.doesNotMatch(sql, /UPDATE public\.job_registry|INSERT INTO|DELETE FROM|pipeline_state|platform_dials|cron\.(schedule|alter_job|unschedule)/);
  assert.doesNotMatch(sql, /CREATE (OR REPLACE )?(FUNCTION|PROCEDURE)/);
});

test("FIX-1382: the hold guard is FIX-1311's takeover hold or the push's own session hold", () => {
  const sql = stripComments(FILE()).replace(/\s+/g, " ");
  assert.ok(
    sql.includes(
      "IF NOT ((v_row.held_since IS NOT NULL AND v_row.hold_reason LIKE 'parked for the dispatcher cutover%' " +
        "AND v_row.cadence_hours IS NULL AND v_row.note LIKE 'FIX-1311 (cc-232)%') " +
        "OR v_row.hold_reason LIKE 'prod session held: %') OR v_row.retired_at IS NOT NULL THEN",
    ),
  );
  assert.ok(sql.includes("— a human hold is resolved by a human"));
  assert.ok(sql.includes("IF v_row.cadence_hours = c_hours AND v_row.note LIKE 'FIX-1382 (cc-263)%' AND v_row.retired_at IS NULL THEN"));
});

test("FIX-1382: the verdict guard reads the rate check and RAISEs on sustained_regression only", () => {
  const sql = stripComments(FILE()).replace(/\s+/g, " ");
  assert.ok(sql.includes("FROM jsonb_array_elements(public.check_pipeline_rate_regression()->'pipelines') e WHERE e->>'pipeline' = c_pipeline;"));
  assert.ok(sql.includes("IF v_el->>'verdict' = 'sustained_regression' THEN RAISE EXCEPTION '[fix1382] % reads sustained_regression"));
  assert.equal((sql.match(/sustained_regression/g) ?? []).length, 2, "no other verdict refuses");
  assert.ok(sql.includes("WHEN v_el IS NULL THEN 'no rated rows'"));
  assert.ok(sql.includes("and the rate verdict (%s)"), "the note quotes it");
});

test("FIX-1382: the registry row asserted is read 4's; the four pins are current; freshness is printed", () => {
  const pins = ["box_is_saturated", "dispatch_one_unit", "get_dispatcher_status", "prod_op_gate"].map(pinOf);
  assert.deepEqual(pins, [
    "ac8dbcddf71978e73d28c999433156b7",
    "d6a9073bcc4d9084b9d7994324a89b18",
    "4c30523742e280a4b48ea2ec390654d6",
    "1d3507cd4b71439f0cfff51cde49b9d8",
  ], "the files that define the four pins hash to prod's (cc-263 read 2)");
  const sql = FILE();
  assert.ok(sql.includes("IF v_reg IS DISTINCT FROM 'contract-flow-rollups-refresh by 0 14 * * 4 -' THEN"));
  for (const p of pins) assert.ok(sql.includes(`'${p}'`), `pin ${p}`);
  assert.ok(sql.includes("RAISE EXCEPTION '[fix1382] read-back failed: %'"));
  assert.ok(sql.includes("v_fresh := public.check_rollup_freshness(c_pipeline, c_hours);"));
  assert.doesNotMatch(stripComments(sql), /IF v_fresh|v_fresh->>'stale'\)::boolean THEN/, "freshness never RAISEs");
  assert.doesNotMatch(stripComments(sql), /v_missing \|\| '[^']*'(?!::text)/, "no bare literal appended to a text[] (cc-259 §8)");
});

test("FIX-1382: fix1374 → fix1382 is cc-263's nine-file manifest in version order", () => {
  const all = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const at = all.indexOf("20261102000000_fix1374_return_five_monthly_sweeps.sql");
  assert.ok(at > 0);
  assert.deepEqual(all.slice(at, at + 9), [
    "20261102000000_fix1374_return_five_monthly_sweeps.sql",
    one("_fix1338_rate_regression_work_done_denominator.sql"),
    one("_fix1378_convert_run_rule_taggers_hold_cadence_24.sql"),
    one("_fix1378_convert_donor_party_rollup_refresh_hold_cadence_168.sql"),
    one("_fix1378_convert_treemap_individuals_global_refresh_hold_cadence_168.sql"),
    one("_fix1378_convert_agency_staffing_rollup_refresh_hold_cadence_168.sql"),
    one("_fix1375_box_health_mem_whitelist_disk_rates.sql"),
    one("_fix1380_convert_group_donor_rollup_refresh_hold_cadence_168.sql"),
    one(SUFFIX),
  ]);
});

test("FIX-1382 revert: matches the FIX-1382 note only, restores the md5-pinned note, touches nothing else", () => {
  const raw = REVERT();
  const sql = stripComments(raw);
  assert.equal((sql.match(/\bUPDATE\b/g) ?? []).length, 1);
  assert.match(sql, /UPDATE public\.rollup_watch_overrides/);
  assert.match(sql, /AND note LIKE 'FIX-1382 \(cc-263\)%';/);
  assert.ok(sql.includes("c_reason   CONSTANT text := 'parked for the dispatcher cutover (cc-232, FIX-1311); returns via job_registry';"));
  assert.ok(sql.includes(`c_note_md5 CONSTANT text := '${NOTE_MD5}';`));
  assert.match(sql, /IF md5\(c_note\) IS DISTINCT FROM c_note_md5 THEN/);
  // The restore text, reassembled from its adjacent literals, hashes to the captured note.
  const m = sql.match(/c_note\s+CONSTANT text := ((?:'(?:[^']|'')*'\s*)+);/);
  assert.ok(m, "the c_note constant");
  const note = [...(m[1] as string).matchAll(/'((?:[^']|'')*)'/g)].map((x) => (x[1] as string).replace(/''/g, "'")).join("");
  assert.equal(md5(note), NOTE_MD5, "the restore text is FIX-1311's note + FIX-1371's appendix");
  assert.doesNotMatch(sql, /job_registry\s+SET|cron\.(schedule|alter_job)|DELETE FROM/);
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

/** BEGIN, then the registry's table lock FIRST (r9's lesson: 40P01 on job_registry). */
async function begin(c: Client): Promise<void> {
  await c.query("BEGIN");
  await c.query("LOCK TABLE public.job_registry IN SHARE ROW EXCLUSIVE MODE");
}

type Hold = { pipeline: string; held_since: Date | null; hold_reason: string | null; cadence_hours: string | null; retired_at: Date | null; note: string };
const holds = async (c: Client): Promise<Hold[]> =>
  (await c.query<Hold>("SELECT pipeline, held_since, hold_reason, cadence_hours::text, retired_at, note FROM public.rollup_watch_overrides ORDER BY pipeline")).rows;
const mine = async (c: Client): Promise<Hold> => (await holds(c)).find((h) => h.pipeline === PIPELINE)!;
const registry = async (c: Client): Promise<string> =>
  (await c.query<{ h: string }>("SELECT md5(string_agg(j::text, '|' ORDER BY j.job)) AS h FROM public.job_registry j")).rows[0]!.h;
const verdict = async (c: Client): Promise<string> => {
  const els = (await c.query<{ r: { pipelines: { pipeline: string; verdict: string }[] } }>(
    "SELECT public.check_pipeline_rate_regression() AS r",
  )).rows[0]!.r.pipelines;
  return els.find((e) => e.pipeline === PIPELINE)?.verdict ?? "absent";
};

/** Seed complete rows as the body writes them (no metadata source): [hours ago, span seconds, rows written]. */
async function seed(c: Client, rows: [number, number, number][]): Promise<void> {
  for (const [h, span, n] of rows) {
    await c.query(
      `INSERT INTO public.data_sync_log (pipeline, started_at, completed_at, rows_inserted, rows_updated, status, metadata)
       VALUES ($1, now() - make_interval(hours => $2::int), now() - make_interval(hours => $2::int) + make_interval(secs => $3::int),
               $4, 0, 'complete', '{"recipients": 500, "agency_sectors": 1201}'::jsonb)`,
      [PIPELINE, h, span, n],
    );
  }
}

test("clone: from the FIX-1311 hold the file converts exactly its row, twice; the revert restores it byte-for-byte", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await begin(c);
    try {
      await c.query(REVERT()); // the clone carries the applied file; start from the hold
      const before = await holds(c);
      const captured = before.find((h) => h.pipeline === PIPELINE)!;
      assert.equal(md5(captured.note), NOTE_MD5, "the revert restored the pre-conversion note");
      assert.match(captured.hold_reason ?? "", /^parked for the dispatcher cutover \(cc-232, FIX-1311\)/);
      const reg = await registry(c);

      await c.query(FILE());
      await c.query(FILE()); // idempotent: the second run NOTICEs, 0 rows
      const after = await holds(c);
      const row = after.find((h) => h.pipeline === PIPELINE)!;
      assert.equal(row.held_since, null);
      assert.equal(row.hold_reason, null);
      assert.equal(Number(row.cadence_hours), 168);
      assert.match(row.note, /^FIX-1382 \(cc-263\) — /);
      assert.deepEqual(
        after.filter((h) => h.pipeline !== PIPELINE),
        before.filter((h) => h.pipeline !== PIPELINE),
        "every other override row unchanged",
      );
      assert.equal(await registry(c), reg, "job_registry unchanged");

      await c.query(REVERT());
      const back = await mine(c);
      assert.equal(back.hold_reason, captured.hold_reason, "hold_reason byte-for-byte");
      assert.equal(back.note, captured.note, "note byte-for-byte");
      assert.equal(back.cadence_hours, null);
      assert.notEqual(back.held_since, null, "a hold again");
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("clone: the verdict guard converts on absent / insufficient_data / ok and quotes it; RAISEs on sustained_regression", async (t) => {
  const c = await clone(t);
  if (!c) return;
  // Each case seeds on top of the clone's own 7 rated rows (4 baseline + 3 recent), inside a rolled-back transaction.
  const cases: { want: string; rows: [number, number, number][] }[] = [
    { want: "absent", rows: [] },
    { want: "insufficient_data", rows: [] },
    // Three recent runs at the clone's own rate: its 7 rows become the baseline.
    { want: "ok", rows: [[3, 60, 1701], [2, 60, 1701], [1, 60, 1701]] },
    // Three recent runs at 3,600 s / 1,000 rows, far above the 7-row baseline.
    { want: "sustained_regression", rows: [[3, 3600, 1000], [2, 3600, 1000], [1, 3600, 1000]] },
  ];
  try {
    for (const k of cases) {
      await begin(c);
      let msg: string | null = null;
      try {
        await c.query(REVERT());
        if (k.want === "absent") await c.query("DELETE FROM public.data_sync_log WHERE pipeline = $1", [PIPELINE]);
        await seed(c, k.rows);
        assert.equal(await verdict(c), k.want, `the seed reads ${k.want}`);
        await c.query("SAVEPOINT s");
        try {
          await c.query(FILE());
        } catch (e) {
          msg = (e as Error).message;
          await c.query("ROLLBACK TO SAVEPOINT s");
        }
        const row = await mine(c);
        if (k.want === "sustained_regression") {
          assert.match(msg ?? "", /\[fix1382\] contract_flow_rollups_rebuild reads sustained_regression/);
          assert.notEqual(row.held_since, null, "still held");
          assert.equal(row.cadence_hours, null);
        } else {
          assert.equal(msg, null, `${k.want} converts`);
          assert.equal(Number(row.cadence_hours), 168);
          if (k.want === "absent") assert.ok(row.note.includes("(no rated rows)"), "absent → no rated rows");
          else assert.ok(row.note.includes(`(${k.want}: recent_min `), `the note quotes ${k.want}`);
        }
      } finally {
        await c.query("ROLLBACK");
      }
    }
  } finally {
    await c.end();
  }
});

test("clone: a human hold RAISEs; the session's own hold is admitted", async (t) => {
  const c = await clone(t);
  if (!c) return;
  const attempt = async (setup: string): Promise<string | null> => {
    await begin(c);
    try {
      await c.query(REVERT());
      await c.query(setup, [PIPELINE]);
      await c.query(FILE());
      return null;
    } catch (e) {
      return (e as Error).message;
    } finally {
      await c.query("ROLLBACK");
    }
  };
  try {
    assert.match(
      (await attempt("UPDATE public.rollup_watch_overrides SET hold_reason = 'Craig: hands off' WHERE pipeline = $1")) ?? "",
      /\[fix1382\] contract_flow_rollups_rebuild override is not FIX-1311's takeover hold/,
    );
    assert.equal(
      await attempt("UPDATE public.rollup_watch_overrides SET hold_reason = 'prod session held: cc-263 clone test', note = 'x' WHERE pipeline = $1"),
      null,
      "the session's own hold is admitted",
    );
  } finally {
    await c.end();
  }
});

// ---------------------------------------------------------------------------
// FIX-1383 — the sweeps' 744 h conversions, the tenth file of cc-263, pushed alone
// ---------------------------------------------------------------------------

/** The chain's `complete` rows: the file's VALUES list, not the prompt's. */
const SWEEPS: [pipeline: string, job: string, rule: string][] = [
  ["donation_edge_orphan_sweep", "donation-edge-orphan-sweep", "by 30 11 1 * *"],
  ["financial_entity_totals_reconcile", "financial-entity-totals-reconcile", "by 0 12 1 * *"],
  ["donor_rollup_orphan_sweep", "donor-rollup-orphan-sweep", "by 30 12 1 * *"],
  ["donor_party_rollup_orphan_sweep", "donor-party-rollup-orphan-sweep", "by 0 13 1 * *"],
  ["entity_connection_stats_orphan_sweep", "entity-connection-stats-orphan-sweep", "by 30 13 1 * *"],
];
const NOTE_MD5S: Record<string, string> = {
  donation_edge_orphan_sweep: "3a15dbd19f239e2227bd15c8f8b077c1",
  financial_entity_totals_reconcile: "c42acc47de09a7193acd23a6113bf176",
  donor_rollup_orphan_sweep: "db7d506a714da4d5e580db8f4aebffad",
  donor_party_rollup_orphan_sweep: "0b7f31ed835e71e27fdf8cea6fcc266a",
  entity_connection_stats_orphan_sweep: "eb7847f437b9511cb8fe917b3c0d4c78",
};
const FILE_744 = () => read(path.join(MIGRATIONS, one("_fix1383_convert_five_monthly_sweeps_hold_cadence_744.sql")));
const REVERT_744 = () => read(path.join(ROOT, "scripts", "fix1383-revert-convert-five-sweeps-holds.sql"));

test("FIX-1383: one UPDATE in a loop over exactly the chain's complete rows, at 744 h", () => {
  const sql = stripComments(FILE_744());
  assert.ok(sql.includes("c_hours CONSTANT int := 744;"));
  assert.equal((sql.match(/\bUPDATE\b/g) ?? []).length, 1, "one UPDATE");
  assert.match(sql, /UPDATE public\.rollup_watch_overrides\s+SET held_since\s+= NULL,\s+hold_reason\s+= NULL,\s+cadence_hours = c_hours,/);
  assert.match(sql, /WHERE pipeline = r\.pipeline\s+AND retired_at IS NULL/);
  assert.match(sql, /IF v_n <> 1 THEN\s+RAISE EXCEPTION '\[fix1383\] % conversion touched % rows, expected 1'/);
  for (const [p, j, rule] of SWEEPS) assert.ok(sql.includes(`('${p}', '${j}', '${rule}',`), p);
  assert.equal((sql.match(/_orphan_sweep'|financial_entity_totals_reconcile'/g) ?? []).length, SWEEPS.length, "exactly the listed pipelines");
  assert.ok(FILE_744().includes("note          = format('FIX-1383 (cc-263) — "), "the note's prefix the read-back matches");
  assert.doesNotMatch(sql, /recipient_count_reconcile/, "FIX-736's retired row is not named");
});

test("FIX-1383: no job_registry, pipeline_state, cron or dial write; no routine; no DELETE/INSERT", () => {
  const sql = stripComments(FILE_744());
  assert.doesNotMatch(sql, /UPDATE public\.job_registry|INSERT INTO|DELETE FROM|pipeline_state|platform_dials|cron\.(schedule|alter_job|unschedule)/);
  assert.doesNotMatch(sql, /CREATE (OR REPLACE )?(FUNCTION|PROCEDURE)/);
});

test("FIX-1383: the guards — FIX-1311's hold WITH FIX-1374's appendix or the session's own; RAISE on sustained_regression only", () => {
  const sql = stripComments(FILE_744()).replace(/\s+/g, " ");
  assert.ok(
    sql.includes(
      "IF NOT ((v_row.held_since IS NOT NULL AND v_row.hold_reason LIKE 'parked for the dispatcher cutover%' " +
        "AND v_row.cadence_hours IS NULL AND v_row.note LIKE 'FIX-1311 (cc-232)%' AND v_row.note LIKE '%RETURNED%(FIX-1374)%') " +
        "OR v_row.hold_reason LIKE 'prod session held: %') OR v_row.retired_at IS NOT NULL THEN",
    ),
  );
  assert.ok(sql.includes("— a human hold is resolved by a human"));
  assert.ok(sql.includes("IF v_el->>'verdict' = 'sustained_regression' THEN RAISE EXCEPTION '[fix1383] % reads sustained_regression"));
  assert.equal((sql.match(/sustained_regression/g) ?? []).length, 2, "no other verdict refuses");
  assert.ok(sql.includes("WHEN v_el IS NULL THEN 'no rated rows'"));
  assert.ok(sql.includes("v_el := NULL;"), "a row with no element never inherits the last row's");
});

test("FIX-1383: the pins are the current four; every v_missing append is ::text; freshness is printed", () => {
  const sql = FILE_744();
  for (const p of [
    "ac8dbcddf71978e73d28c999433156b7",
    "d6a9073bcc4d9084b9d7994324a89b18",
    "4c30523742e280a4b48ea2ec390654d6",
    "1d3507cd4b71439f0cfff51cde49b9d8",
  ]) assert.ok(sql.includes(`'${p}'`), `pin ${p}`);
  assert.ok(sql.includes("RAISE EXCEPTION '[fix1383] read-back failed: %'"));
  assert.ok(sql.includes("v_fresh := public.check_rollup_freshness(r.pipeline, c_hours);"));
  const code = stripComments(sql);
  assert.doesNotMatch(code, /IF v_fresh/, "freshness never RAISEs");
  assert.doesNotMatch(code, /v_missing \|\| '[^']*'(?!::text)/, "no bare literal appended to a text[]");
  for (const m of code.matchAll(/v_missing := v_missing \|\| format\(([\s\S]*?)\)::text;/g)) assert.ok(m[1]);
  assert.equal((code.match(/v_missing := v_missing \|\|/g) ?? []).length, (code.match(/\)::text;/g) ?? []).length, "every append casts");
});

test("FIX-1383: it is the newest file, one after cc-263's nine", () => {
  const all = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  assert.equal(all[all.length - 1], one("_fix1383_convert_five_monthly_sweeps_hold_cadence_744.sql"));
  assert.equal(all[all.length - 2], one(SUFFIX));
});

test("FIX-1383 revert: matches the FIX-1383 note only, and each restore text hashes to the note read after push 1", () => {
  const sql = stripComments(REVERT_744());
  assert.equal((sql.match(/\bUPDATE\b/g) ?? []).length, 1);
  assert.match(sql, /AND note LIKE 'FIX-1383 \(cc-263\)%';/);
  assert.ok(sql.includes("c_reason CONSTANT text := 'parked for the dispatcher cutover (cc-232, FIX-1311); returns via job_registry';"));
  assert.match(sql, /IF md5\(r\.note\) IS DISTINCT FROM r\.note_md5 THEN/);
  const rows = [...sql.matchAll(/\('(\w+)',\s+'((?:[^']|'')*)',\s+'([0-9a-f]{32})'\)/g)];
  assert.equal(rows.length, SWEEPS.length);
  for (const m of rows) {
    const note = (m[2] as string).replace(/''/g, "'");
    assert.equal(md5(note), m[3], `${m[1]}: the constant hashes to its md5`);
    assert.equal(m[3], NOTE_MD5S[m[1] as string], `${m[1]}: the md5 is the one read on prod`);
    assert.match(note, /^FIX-1311 \(cc-232\) — .*RETURNED 2026-11-07 \(FIX-1374\) — hold kept, conversion to cadence_hours 744 owed \(cc-259\)$/);
  }
  assert.doesNotMatch(sql, /job_registry\s+SET|cron\.(schedule|alter_job)|DELETE FROM/);
});

/** The clone's RETURN note carries its apply's date; the revert's text carries prod's. */
const onProdDate = (note: string) => note.replace("RETURNED 2026-11-02 (FIX-1374)", "RETURNED 2026-11-07 (FIX-1374)");

test("clone FIX-1383: from the RETURN's hold the file converts exactly its rows, twice; the revert restores them", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await begin(c);
    try {
      await c.query(REVERT_744()); // the clone carries the applied file; start from the hold
      const before = await holds(c);
      for (const [p] of SWEEPS) {
        await c.query(
          `INSERT INTO public.data_sync_log (pipeline, started_at, completed_at, rows_inserted, rows_updated, status, metadata)
           VALUES ($1, now() - interval '30 minutes', now() - interval '25 minutes', 0, 0, 'complete', '{"source": "pg_cron"}'::jsonb)`,
          [p],
        );
      }
      const reg = await registry(c);
      await c.query(FILE_744());
      await c.query(FILE_744()); // idempotent: the second run NOTICEs, 0 rows
      const after = await holds(c);
      const names = SWEEPS.map(([p]) => p);
      for (const p of names) {
        const row = after.find((h) => h.pipeline === p)!;
        assert.equal(row.held_since, null, p);
        assert.equal(row.hold_reason, null, p);
        assert.equal(Number(row.cadence_hours), 744, p);
        assert.match(row.note, /^FIX-1383 \(cc-263\) — /);
        assert.ok(row.note.includes("(no rated rows)"), `${p}: a sweep's rows written are its deletes`);
      }
      assert.deepEqual(after.filter((h) => !names.includes(h.pipeline)), before.filter((h) => !names.includes(h.pipeline)), "every other override row unchanged");
      assert.equal(await registry(c), reg, "job_registry unchanged");

      await c.query(REVERT_744());
      const back = await holds(c);
      for (const p of names) {
        const was = before.find((h) => h.pipeline === p)!;
        const now = back.find((h) => h.pipeline === p)!;
        assert.equal(now.hold_reason, was.hold_reason, `${p}: hold_reason byte-for-byte`);
        assert.equal(now.note, onProdDate(was.note), `${p}: note byte-for-byte, on prod's date`);
        assert.equal(now.cadence_hours, null);
        assert.notEqual(now.held_since, null, `${p}: a hold again`);
      }
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("clone FIX-1383: a human hold RAISEs; a bare FIX-1311 note without the appendix RAISEs; the session's own hold is admitted; sustained_regression RAISEs", async (t) => {
  const c = await clone(t);
  if (!c) return;
  const p0 = SWEEPS[0]![0];
  const attempt = async (setup: string, params: unknown[]): Promise<string | null> => {
    await begin(c);
    try {
      await c.query(REVERT_744());
      await c.query(setup, params);
      await c.query(FILE_744());
      return null;
    } catch (e) {
      return (e as Error).message;
    } finally {
      await c.query("ROLLBACK");
    }
  };
  try {
    assert.match(
      (await attempt("UPDATE public.rollup_watch_overrides SET hold_reason = 'Craig: hands off' WHERE pipeline = $1", [p0])) ?? "",
      /\[fix1383\] \w+ override is not FIX-1311's takeover hold/,
    );
    assert.match(
      (await attempt("UPDATE public.rollup_watch_overrides SET note = split_part(note, '; ', 1) WHERE pipeline = $1", [p0])) ?? "",
      /\[fix1383\] \w+ override is not FIX-1311's takeover hold with FIX-1374's appendix/,
    );
    assert.equal(
      await attempt("UPDATE public.rollup_watch_overrides SET hold_reason = 'prod session held: cc-263 clone test', note = 'x' WHERE pipeline = $1", [p0]),
      null,
      "the session's own hold is admitted",
    );
    assert.match(
      (await attempt(
        `INSERT INTO public.data_sync_log (pipeline, started_at, completed_at, rows_inserted, rows_updated, status, metadata)
         SELECT $1, now() - make_interval(hours => h), now() - make_interval(hours => h) + make_interval(secs => s), n, 0, 'complete', '{"source": "pg_cron"}'::jsonb
           FROM (VALUES (240, 10, 50000), (200, 10, 50000), (160, 10, 50000), (120, 10, 50000), (80, 10, 50000), (40, 10, 50000),
                        (3, 3600, 1000), (2, 3600, 1000), (1, 3600, 1000)) AS v(h, s, n)`,
        [p0],
      )) ?? "",
      /\[fix1383\] \w+ reads sustained_regression/,
    );
  } finally {
    await c.end();
  }
});
