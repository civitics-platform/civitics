/**
 * FIX-1378 — the four cutover holds converted to cadence rows on their first
 * slot receipts: run_rule_taggers → 24 h (gated in SQL on FIX-1338's
 * work-done verdict), donor-party / treemap / agency-staffing → 168 h. cc-259,
 * `20261104001000` … `20261104004000_fix1378_convert_*`.
 *
 * Runs via:  tsx --test src/__tests__/dispatcher-r12.test.ts
 *
 * Text anchors (no DB, run in CI):
 *   - each file touches exactly its one rollup_watch_overrides row, by
 *     pipeline, with its cadence; none writes job_registry, pipeline_state,
 *     cron or a dial, and none defines a routine;
 *   - the hold guard is FIX-1311's takeover hold or the push's own session
 *     hold; the verdict guard reads check_pipeline_rate_regression() and
 *     RAISEs on sustained_regression only; the note quotes the verdict;
 *   - the registry rows asserted are the ones read 6 read; the pins are the
 *     current four, derived from the files that define them;
 *   - the files sort between FIX-1338's and FIX-1375's, in this order;
 *   - the revert matches the FIX-1378 note and restores md5-pinned notes.
 * Clone tests (CIVITICS_CLONE_TESTS=1, inside BEGIN … ROLLBACK): from the
 * FIX-1311 hold each file converts exactly its row and nothing else, twice;
 * the verdict guard converts on ok / insufficient_data / absent (the clone's
 * four) and RAISEs on a seeded sustained_regression; a human hold RAISEs and
 * the session's own hold is admitted; the revert restores FIX-1311's
 * hold_reason and note byte-for-byte against a row captured before the apply.
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

const ROWS = [
  { suffix: "_fix1378_convert_run_rule_taggers_hold_cadence_24.sql", pipeline: "run_rule_taggers", hours: 24,
    registry: "rule-taggers-daily by 30 6 * * * daily | rule-taggers-weekly by 0 16 * * 2 weekly",
    noteMd5: "b5f50c7b92492ff4adc797a7b5501a5c" },
  { suffix: "_fix1378_convert_donor_party_rollup_refresh_hold_cadence_168.sql", pipeline: "donor_party_rollup_refresh", hours: 168,
    registry: "donor-party-rollup-refresh by 0 15 * * 2 -", noteMd5: "52c9937f9a54df553b41e162be301d7d" },
  { suffix: "_fix1378_convert_treemap_individuals_global_refresh_hold_cadence_168.sql", pipeline: "treemap_individuals_global_refresh", hours: 168,
    registry: "treemap-individuals-global-refresh by 0 14 * * 2 -", noteMd5: "ba0b81de306033426a8d0bc20747a491" },
  { suffix: "_fix1378_convert_agency_staffing_rollup_refresh_hold_cadence_168.sql", pipeline: "agency_staffing_rollup_refresh", hours: 168,
    registry: "agency-staffing-rollup-refresh by 5 0 * * 2 -", noteMd5: "0986fa9600678ef0ebcf8e7aa5d7cb04" },
] as const;
const FILE = (r: (typeof ROWS)[number]) => read(path.join(MIGRATIONS, one(r.suffix)));
const REVERT = () => read(path.join(ROOT, "scripts", "fix1378-revert-convert-cutover-holds.sql"));

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

test("FIX-1378: each file converts exactly its one row, by pipeline, with its cadence", () => {
  for (const r of ROWS) {
    const sql = stripComments(FILE(r));
    assert.ok(sql.includes(`c_pipeline CONSTANT text := '${r.pipeline}';`), r.pipeline);
    assert.ok(sql.includes(`c_hours    CONSTANT int  := ${r.hours};`), `${r.pipeline} ${r.hours} h`);
    assert.equal((sql.match(/\bUPDATE\b/g) ?? []).length, 1, `${r.pipeline}: one UPDATE`);
    assert.match(sql, /UPDATE public\.rollup_watch_overrides\s+SET held_since\s+= NULL,\s+hold_reason\s+= NULL,\s+cadence_hours = c_hours,/);
    assert.match(sql, /WHERE pipeline = c_pipeline\s+AND retired_at IS NULL/);
    assert.match(sql, /IF v_n <> 1 THEN\s+RAISE EXCEPTION '\[fix1378\] % conversion touched % rows, expected 1'/);
    assert.ok(FILE(r).includes("note          = format('FIX-1378 (cc-259) — "), "the note's prefix the read-back matches");
  }
});

test("FIX-1378: no job_registry, pipeline_state, cron or dial write; no routine; no DELETE/INSERT", () => {
  for (const r of ROWS) {
    const sql = stripComments(FILE(r));
    assert.doesNotMatch(sql, /UPDATE public\.job_registry|INSERT INTO|DELETE FROM|pipeline_state|platform_dials|cron\.(schedule|alter_job|unschedule)/, r.pipeline);
    assert.doesNotMatch(sql, /CREATE (OR REPLACE )?(FUNCTION|PROCEDURE)/, r.pipeline);
  }
});

test("FIX-1378: the hold guard is FIX-1311's takeover hold or the push's own session hold", () => {
  for (const r of ROWS) {
    const sql = stripComments(FILE(r)).replace(/\s+/g, " ");
    assert.ok(
      sql.includes(
        "IF NOT ((v_row.held_since IS NOT NULL AND v_row.hold_reason LIKE 'parked for the dispatcher cutover%' " +
          "AND v_row.cadence_hours IS NULL AND v_row.note LIKE 'FIX-1311 (cc-232)%') " +
          "OR v_row.hold_reason LIKE 'prod session held: %') OR v_row.retired_at IS NOT NULL THEN",
      ),
      `${r.pipeline}: the guard`,
    );
    assert.ok(sql.includes("— a human hold is resolved by a human"), r.pipeline);
    assert.ok(
      sql.includes("IF v_row.cadence_hours = c_hours AND v_row.note LIKE 'FIX-1378 (cc-259)%' AND v_row.retired_at IS NULL THEN"),
      `${r.pipeline}: the already-converted NOTICE path`,
    );
  }
});

test("FIX-1378: the verdict guard reads FIX-1338's body and RAISEs on sustained_regression only", () => {
  for (const r of ROWS) {
    const sql = stripComments(FILE(r)).replace(/\s+/g, " ");
    assert.ok(sql.includes("FROM jsonb_array_elements(public.check_pipeline_rate_regression()->'pipelines') e WHERE e->>'pipeline' = c_pipeline;"));
    assert.ok(sql.includes("IF v_el->>'verdict' = 'sustained_regression' THEN RAISE EXCEPTION '[fix1378] % reads sustained_regression"));
    assert.equal((sql.match(/sustained_regression/g) ?? []).length, 2, `${r.pipeline}: no other verdict refuses`);
    assert.ok(sql.includes("WHEN v_el IS NULL THEN 'no rated rows'"));
    assert.ok(sql.includes("and the rate verdict (%s)") || sql.includes("and the canary''s verdict (%s)"), `${r.pipeline}: the note quotes it`);
  }
});

test("FIX-1378: the registry rows asserted are read 6's; the four pins are current", () => {
  const pins = ["box_is_saturated", "dispatch_one_unit", "get_dispatcher_status", "prod_op_gate"].map(pinOf);
  assert.deepEqual(pins, [
    "ac8dbcddf71978e73d28c999433156b7",
    "d6a9073bcc4d9084b9d7994324a89b18",
    "4c30523742e280a4b48ea2ec390654d6",
    "1d3507cd4b71439f0cfff51cde49b9d8",
  ], "the files that define the four pins hash to prod's (cc-259 read 2)");
  for (const r of ROWS) {
    const sql = FILE(r);
    assert.ok(sql.includes(`IF v_reg IS DISTINCT FROM '${r.registry}' THEN`), `${r.pipeline}: ${r.registry}`);
    for (const p of pins) assert.ok(sql.includes(`'${p}'`), `${r.pipeline}: pin ${p}`);
    assert.ok(sql.includes("RAISE EXCEPTION '[fix1378] read-back failed: %'"));
    assert.ok(sql.includes(`v_fresh := public.check_rollup_freshness(c_pipeline, c_hours);`), "freshness printed");
    assert.doesNotMatch(stripComments(sql), /IF v_fresh|v_fresh->>'stale'\)::boolean THEN/, "freshness never RAISEs");
  }
});

test("FIX-1378: the files sort after FIX-1338's and before FIX-1375's, in this order, nothing between", () => {
  const all = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const at = all.indexOf(one("_fix1338_rate_regression_work_done_denominator.sql"));
  assert.ok(at > 0);
  assert.deepEqual(all.slice(at + 1, at + 6), [...ROWS.map((r) => one(r.suffix)), one("_fix1375_box_health_mem_whitelist_disk_rates.sql")]);
  assert.equal(all[at - 1], "20261102000000_fix1374_return_five_monthly_sweeps.sql", "the held fix1374 rides the same push");
});

test("cc-259: no read-back appends a bare literal to a text[] (it RAISEs 'malformed array literal', not the miss)", () => {
  // `v_missing || 'text'` resolves the unknown literal as text[] (array || array),
  // so the miss path errors with the wrong message. fix1368's read-back does this
  // (cc-259 found it on the clone); these six files must not.
  const six = [
    one("_fix1338_rate_regression_work_done_denominator.sql"),
    ...ROWS.map((r) => one(r.suffix)),
    one("_fix1375_box_health_mem_whitelist_disk_rates.sql"),
  ];
  for (const f of six) {
    assert.doesNotMatch(stripComments(read(path.join(MIGRATIONS, f))), /v_missing \|\| '[^']*'(?!::text)/, f);
  }
});

test("FIX-1378 revert: matches the FIX-1378 note only, restores md5-pinned notes, touches nothing else", () => {
  const sql = stripComments(REVERT());
  assert.equal((sql.match(/\bUPDATE\b/g) ?? []).length, 1);
  assert.match(sql, /UPDATE public\.rollup_watch_overrides/);
  assert.match(sql, /AND note LIKE 'FIX-1378 \(cc-259\)%';/);
  assert.match(sql, /hold_reason\s+= c_reason/);
  assert.ok(sql.includes("c_reason CONSTANT text := 'parked for the dispatcher cutover (cc-232, FIX-1311); returns via job_registry';"));
  assert.match(sql, /IF md5\(r\.note\) IS DISTINCT FROM r\.note_md5 THEN/);
  for (const r of ROWS) assert.ok(sql.includes(`'${r.noteMd5}'`), `${r.pipeline} note md5`);
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
const registry = async (c: Client): Promise<string> =>
  (await c.query<{ h: string }>("SELECT md5(string_agg(j::text, '|' ORDER BY j.job)) AS h FROM public.job_registry j")).rows[0]!.h;

test("clone: from the FIX-1311 hold each file converts exactly its row, twice; the revert restores it byte-for-byte", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    for (const r of ROWS) {
      await begin(c);
      try {
        await c.query(REVERT()); // the clone carries the applied files; start from the hold
        const before = await holds(c);
        const captured = before.find((h) => h.pipeline === r.pipeline)!;
        assert.equal(md5(captured.note), r.noteMd5, `${r.pipeline}: the revert restored the pre-conversion note`);
        assert.match(captured.hold_reason ?? "", /^parked for the dispatcher cutover \(cc-232, FIX-1311\)/);
        const reg = await registry(c);

        await c.query(FILE(r));
        await c.query(FILE(r)); // idempotent: the second run NOTICEs, 0 rows
        const after = await holds(c);
        const row = after.find((h) => h.pipeline === r.pipeline)!;
        assert.equal(row.held_since, null);
        assert.equal(row.hold_reason, null);
        assert.equal(Number(row.cadence_hours), r.hours);
        assert.match(row.note, /^FIX-1378 \(cc-259\) — /);
        assert.deepEqual(
          after.filter((h) => h.pipeline !== r.pipeline),
          before.filter((h) => h.pipeline !== r.pipeline),
          "every other override row unchanged",
        );
        assert.equal(await registry(c), reg, "job_registry unchanged");

        await c.query(REVERT());
        const back: Hold = (await holds(c)).find((h) => h.pipeline === r.pipeline)!;
        assert.equal(back.hold_reason, captured.hold_reason, "hold_reason byte-for-byte");
        assert.equal(back.note, captured.note, "note byte-for-byte");
        assert.equal(back.cadence_hours, null);
        assert.notEqual(back.held_since, null, "a hold again");
      } finally {
        await c.query("ROLLBACK");
      }
    }
  } finally {
    await c.end();
  }
});

test("clone: the verdict guard converts on the clone's ok / insufficient_data / absent and quotes it", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    const els = new Map(
      ((await c.query<{ r: { pipelines: { pipeline: string; verdict: string }[] } }>(
        "SELECT public.check_pipeline_rate_regression() AS r",
      )).rows[0]!.r.pipelines).map((e) => [e.pipeline, e.verdict]),
    );
    const seen = new Set<string>();
    for (const r of ROWS) {
      await begin(c);
      try {
        await c.query(REVERT());
        await c.query(FILE(r));
        const note = (await holds(c)).find((h) => h.pipeline === r.pipeline)!.note;
        const v = els.get(r.pipeline);
        seen.add(v ?? "absent");
        if (v) assert.ok(note.includes(`(${v}: recent_min `), `${r.pipeline}: the note quotes ${v}`);
        else assert.ok(note.includes("(no rated rows)"), `${r.pipeline}: absent → no rated rows`);
      } finally {
        await c.query("ROLLBACK");
      }
    }
    for (const v of ["ok", "insufficient_data", "absent"]) assert.ok(seen.has(v), `the clone exercises ${v}`);
  } finally {
    await c.end();
  }
});

test("clone: a seeded sustained_regression RAISEs and leaves the hold a hold", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    for (const r of ROWS.filter((x) => x.pipeline === "run_rule_taggers" || x.pipeline === "donor_party_rollup_refresh")) {
      await begin(c);
      let msg: string | null = null;
      try {
        await c.query(REVERT());
        // Three slow recent runs (3,600 s each) on the pipeline's own denominator.
        for (const h of [3, 2, 1]) {
          await c.query(
            `INSERT INTO public.data_sync_log (pipeline, started_at, completed_at, rows_inserted, rows_updated, status, metadata)
             VALUES ($1, now() - make_interval(hours => $2::int), now() - make_interval(hours => $2::int) + interval '3600 seconds',
                     1000, 0, 'complete', $3::jsonb)`,
            [r.pipeline, h, JSON.stringify(r.pipeline === "run_rule_taggers" ? { source: "pg_cron", desired_rows: 720256 } : { source: "pg_cron" })],
          );
        }
        const el: { pipeline: string; verdict: string } | undefined = ((await c.query<{ r: { pipelines: { pipeline: string; verdict: string }[] } }>(
          "SELECT public.check_pipeline_rate_regression() AS r",
        )).rows[0]!.r.pipelines).find((e) => e.pipeline === r.pipeline);
        assert.equal(el?.verdict, "sustained_regression", `${r.pipeline}: the seed reads sustained`);
        await c.query("SAVEPOINT s");
        try {
          await c.query(FILE(r));
        } catch (e) {
          msg = (e as Error).message;
          await c.query("ROLLBACK TO SAVEPOINT s");
        }
        assert.match(msg ?? "", new RegExp(`\\[fix1378\\] ${r.pipeline} reads sustained_regression`));
        const row: Hold = (await holds(c)).find((h) => h.pipeline === r.pipeline)!;
        assert.notEqual(row.held_since, null, "still held");
        assert.equal(row.cadence_hours, null);
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
  const attempt = async (r: (typeof ROWS)[number], setup: string): Promise<string | null> => {
    await begin(c);
    try {
      await c.query(REVERT());
      await c.query(setup, [r.pipeline]);
      await c.query(FILE(r));
      return null;
    } catch (e) {
      return (e as Error).message;
    } finally {
      await c.query("ROLLBACK");
    }
  };
  try {
    for (const r of ROWS) {
      assert.match(
        (await attempt(r, "UPDATE public.rollup_watch_overrides SET hold_reason = 'Craig: hands off' WHERE pipeline = $1")) ?? "",
        new RegExp(`\\[fix1378\\] ${r.pipeline} override is not FIX-1311's takeover hold`),
      );
      assert.equal(
        await attempt(r, "UPDATE public.rollup_watch_overrides SET hold_reason = 'prod session held: cc-259 clone test', note = 'x' WHERE pipeline = $1"),
        null,
        `${r.pipeline}: the session's own hold is admitted`,
      );
    }
  } finally {
    await c.end();
  }
});
