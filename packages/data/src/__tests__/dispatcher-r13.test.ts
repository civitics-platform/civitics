/**
 * FIX-1380 — group_donor_rollup_refresh's cutover hold converted to a 168 h
 * cadence row on its first Wed slot receipt (11-04 03:10Z). cc-255,
 * `20261104006000_fix1380_convert_group_donor_rollup_refresh_hold_cadence_168`,
 * the fifth conversion after FIX-1378's four (dispatcher-r12) and the eighth
 * file of cc-263's manifest. r12's fixture is FIX-1378's (its note prefix,
 * `[fix1378]` tag and four-row revert), so this file is its own suite.
 *
 * Runs via:  tsx --test src/__tests__/dispatcher-r13.test.ts
 *
 * Text anchors (no DB, run in CI):
 *   - the file touches exactly its one rollup_watch_overrides row, by
 *     pipeline, with cadence 168; it writes no job_registry, pipeline_state,
 *     cron or dial row and defines no routine;
 *   - the hold guard is FIX-1311's takeover hold or the push's own session
 *     hold; the verdict guard RAISEs on sustained_regression only;
 *   - the registry row asserted is read 7's; the pins are the current four;
 *   - it sorts after FIX-1375's, and the eight files from fix1374 on open
 *     cc-263's manifest in version order;
 *   - the revert matches the FIX-1380 note and restores an md5-pinned note.
 * Clone tests (CIVITICS_CLONE_TESTS=1, inside BEGIN … ROLLBACK): from the
 * FIX-1311 hold the file converts exactly its row, twice; it converts on
 * absent (the clone as it stands) and on seeded insufficient_data and ok, and
 * RAISEs on a seeded sustained_regression; a human hold RAISEs and the
 * session's own hold is admitted; the revert restores FIX-1311's hold_reason
 * and note byte-for-byte against a row captured before the apply.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { read, stripComments, withCurrentPins } from "./lib/migration-text";

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

const PIPELINE = "group_donor_rollup_refresh";
const NOTE_MD5 = "e67f34916a2e78870b90b4528f2ed7a9"; // cc-255 read 7, prod = clone
const SUFFIX = "_fix1380_convert_group_donor_rollup_refresh_hold_cadence_168.sql";
const FILE = () => read(path.join(MIGRATIONS, one(SUFFIX)));
const REVERT = () => read(path.join(ROOT, "scripts", "fix1380-revert-convert-group-donor-hold.sql"));

/** md5(prosrc) of a function, from the LATEST migration that defines it. */
function pinOf(fn: string): string {
  const sig = `CREATE OR REPLACE FUNCTION public.${fn}(`;
  const f = fs
    .readdirSync(MIGRATIONS)
    .filter((x) => x.endsWith(".sql") && x < "20261108000000") // the pins these files asserted; cc-264 moved two
    .sort()
    .filter((x) => read(path.join(MIGRATIONS, x)).includes(sig))
    .pop()!;
  const src = read(path.join(MIGRATIONS, f));
  const at = src.lastIndexOf(sig);
  const m = src.slice(at).match(/AS (\$\w*\$)([\s\S]*?)\1/);
  assert.ok(m, `${fn}: a dollar-quoted body in ${f}`);
  return md5(m[2] as string);
}

test("FIX-1380: the file converts exactly its one row, by pipeline, to 168 h", () => {
  const sql = stripComments(FILE());
  assert.ok(sql.includes(`c_pipeline CONSTANT text := '${PIPELINE}';`));
  assert.ok(sql.includes("c_hours    CONSTANT int  := 168;"));
  assert.equal((sql.match(/\bUPDATE\b/g) ?? []).length, 1, "one UPDATE");
  assert.match(sql, /UPDATE public\.rollup_watch_overrides\s+SET held_since\s+= NULL,\s+hold_reason\s+= NULL,\s+cadence_hours = c_hours,/);
  assert.match(sql, /WHERE pipeline = c_pipeline\s+AND retired_at IS NULL/);
  assert.match(sql, /IF v_n <> 1 THEN\s+RAISE EXCEPTION '\[fix1380\] % conversion touched % rows, expected 1'/);
  assert.ok(FILE().includes("note          = format('FIX-1380 (cc-255) — "), "the note's prefix the read-back matches");
});

test("FIX-1380: no job_registry, pipeline_state, cron or dial write; no routine; no DELETE/INSERT", () => {
  const sql = stripComments(FILE());
  assert.doesNotMatch(sql, /UPDATE public\.job_registry|INSERT INTO|DELETE FROM|pipeline_state|platform_dials|cron\.(schedule|alter_job|unschedule)/);
  assert.doesNotMatch(sql, /CREATE (OR REPLACE )?(FUNCTION|PROCEDURE)/);
});

test("FIX-1380: the hold guard is FIX-1311's takeover hold or the push's own session hold", () => {
  const sql = stripComments(FILE()).replace(/\s+/g, " ");
  assert.ok(
    sql.includes(
      "IF NOT ((v_row.held_since IS NOT NULL AND v_row.hold_reason LIKE 'parked for the dispatcher cutover%' " +
        "AND v_row.cadence_hours IS NULL AND v_row.note LIKE 'FIX-1311 (cc-232)%') " +
        "OR v_row.hold_reason LIKE 'prod session held: %') OR v_row.retired_at IS NOT NULL THEN",
    ),
  );
  assert.ok(sql.includes("— a human hold is resolved by a human"));
  assert.ok(sql.includes("IF v_row.cadence_hours = c_hours AND v_row.note LIKE 'FIX-1380 (cc-255)%' AND v_row.retired_at IS NULL THEN"));
});

test("FIX-1380: the verdict guard reads the rate check and RAISEs on sustained_regression only", () => {
  const sql = stripComments(FILE()).replace(/\s+/g, " ");
  assert.ok(sql.includes("FROM jsonb_array_elements(public.check_pipeline_rate_regression()->'pipelines') e WHERE e->>'pipeline' = c_pipeline;"));
  assert.ok(sql.includes("IF v_el->>'verdict' = 'sustained_regression' THEN RAISE EXCEPTION '[fix1380] % reads sustained_regression"));
  assert.equal((sql.match(/sustained_regression/g) ?? []).length, 2, "no other verdict refuses");
  assert.ok(sql.includes("WHEN v_el IS NULL THEN 'no rated rows'"));
  assert.ok(sql.includes("and the rate verdict (%s)"), "the note quotes it");
});

test("FIX-1380: the registry row asserted is read 7's; the four pins are current; freshness is printed", () => {
  const pins = ["box_is_saturated", "dispatch_one_unit", "get_dispatcher_status", "prod_op_gate"].map(pinOf);
  assert.deepEqual(pins, [
    "ac8dbcddf71978e73d28c999433156b7",
    "d6a9073bcc4d9084b9d7994324a89b18",
    "4c30523742e280a4b48ea2ec390654d6",
    "1d3507cd4b71439f0cfff51cde49b9d8",
  ], "the files that define the four pins hash to prod's (cc-255 read 2)");
  const sql = FILE();
  assert.ok(sql.includes("IF v_reg IS DISTINCT FROM 'group-donor-rollup-refresh by 10 3 * * 3 -' THEN"));
  for (const p of pins) assert.ok(sql.includes(`'${p}'`), `pin ${p}`);
  assert.ok(sql.includes("RAISE EXCEPTION '[fix1380] read-back failed: %'"));
  assert.ok(sql.includes("v_fresh := public.check_rollup_freshness(c_pipeline, c_hours);"));
  assert.doesNotMatch(stripComments(sql), /IF v_fresh|v_fresh->>'stale'\)::boolean THEN/, "freshness never RAISEs");
  assert.doesNotMatch(stripComments(sql), /v_missing \|\| '[^']*'(?!::text)/, "no bare literal appended to a text[] (cc-259 §8)");
});

test("FIX-1380: fix1374 → fix1380 opens cc-263's manifest in version order (r14 pins the ninth file)", () => {
  const all = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const at = all.indexOf("20261102000000_fix1374_return_five_monthly_sweeps.sql");
  assert.ok(at > 0);
  assert.deepEqual(all.slice(at, at + 8), [
    "20261102000000_fix1374_return_five_monthly_sweeps.sql",
    one("_fix1338_rate_regression_work_done_denominator.sql"),
    one("_fix1378_convert_run_rule_taggers_hold_cadence_24.sql"),
    one("_fix1378_convert_donor_party_rollup_refresh_hold_cadence_168.sql"),
    one("_fix1378_convert_treemap_individuals_global_refresh_hold_cadence_168.sql"),
    one("_fix1378_convert_agency_staffing_rollup_refresh_hold_cadence_168.sql"),
    one("_fix1375_box_health_mem_whitelist_disk_rates.sql"),
    one(SUFFIX),
  ]);
});

test("FIX-1380 revert: matches the FIX-1380 note only, restores the md5-pinned note, touches nothing else", () => {
  const raw = REVERT();
  const sql = stripComments(raw);
  assert.equal((sql.match(/\bUPDATE\b/g) ?? []).length, 1);
  assert.match(sql, /UPDATE public\.rollup_watch_overrides/);
  assert.match(sql, /AND note LIKE 'FIX-1380 \(cc-255\)%';/);
  assert.ok(sql.includes("c_reason   CONSTANT text := 'parked for the dispatcher cutover (cc-232, FIX-1311); returns via job_registry';"));
  assert.ok(sql.includes(`c_note_md5 CONSTANT text := '${NOTE_MD5}';`));
  assert.match(sql, /IF md5\(c_note\) IS DISTINCT FROM c_note_md5 THEN/);
  // The restore text, reassembled from its adjacent literals, hashes to the captured note.
  const m = sql.match(/c_note\s+CONSTANT text := ((?:'(?:[^']|'')*'\s*)+);/);
  assert.ok(m, "the c_note constant");
  const note = [...(m[1] as string).matchAll(/'((?:[^']|'')*)'/g)].map((x) => (x[1] as string).replace(/''/g, "'")).join("");
  assert.equal(md5(note), NOTE_MD5, "the restore text is FIX-1311's note + FIX-1370's appendix");
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
  const c = withCurrentPins(new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 }));
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

/** Seed complete pg_cron rows: [hours ago, span seconds, rows written]. */
async function seed(c: Client, rows: [number, number, number][]): Promise<void> {
  for (const [h, span, n] of rows) {
    await c.query(
      `INSERT INTO public.data_sync_log (pipeline, started_at, completed_at, rows_inserted, rows_updated, status, metadata)
       VALUES ($1, now() - make_interval(hours => $2::int), now() - make_interval(hours => $2::int) + make_interval(secs => $3::int),
               $4, 0, 'complete', '{"source": "pg_cron", "cohorts": 581}'::jsonb)`,
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
      assert.match(row.note, /^FIX-1380 \(cc-255\) — /);
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
  // Each case seeds on top of the clone's own rows (one rated 09-07 refresh), inside a rolled-back transaction.
  const cases: { want: string; rows: [number, number, number][] }[] = [
    { want: "absent", rows: [] },
    // Three recent runs; the clone's 09-07 row is the only baseline (1 < 5).
    { want: "insufficient_data", rows: [[3, 100, 47208], [2, 100, 47208], [1, 100, 47208]] },
    // Six baseline + three recent at one rate.
    { want: "ok", rows: [[240, 100, 47208], [200, 100, 47208], [160, 100, 47208], [120, 100, 47208], [80, 100, 47208], [40, 100, 47208], [3, 100, 47208], [2, 100, 47208], [1, 100, 47208]] },
    // Six fast baseline runs, then three at 3,600 s / 1,000 rows.
    { want: "sustained_regression", rows: [[240, 10, 50000], [200, 10, 50000], [160, 10, 50000], [120, 10, 50000], [80, 10, 50000], [40, 10, 50000], [3, 3600, 1000], [2, 3600, 1000], [1, 3600, 1000]] },
  ];
  try {
    for (const k of cases) {
      await begin(c);
      let msg: string | null = null;
      try {
        await c.query(REVERT());
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
          assert.match(msg ?? "", /\[fix1380\] group_donor_rollup_refresh reads sustained_regression/);
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
      /\[fix1380\] group_donor_rollup_refresh override is not FIX-1311's takeover hold/,
    );
    assert.equal(
      await attempt("UPDATE public.rollup_watch_overrides SET hold_reason = 'prod session held: cc-255 clone test', note = 'x' WHERE pipeline = $1"),
      null,
      "the session's own hold is admitted",
    );
  } finally {
    await c.end();
  }
});
