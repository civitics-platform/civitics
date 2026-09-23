/**
 * FIX-1212 — the donor-party full rebuild in sixteen bounded, resumable windows.
 *
 * Runs via:  tsx --test src/__tests__/donor-party-full-rebuild.test.ts
 *
 * TWO HALVES, for the FIX-407 reason (the pre-vote-timing-merge shape).
 *
 * (v) Source anchors against the shipped migration TEXT — no database, so they
 *     run in CI: the procedure carries no SET clause (it COMMITs; FIX-1128), no
 *     statement_timeout is set anywhere, every EXCEPTION block names
 *     query_canceled before OTHERS (FIX-1028), parallel is off, and the window
 *     bound sits on all THREE sources. That last one is the trap measured in
 *     cc-146 read 4: bounding only financial_relationships leaves the planner
 *     hashing ALL of financial_entities (305,720 kB on the clone) in every
 *     window — the peak the windows exist to remove, sixteen times over.
 *
 * (i)-(iv) Behavioural, against the real procedure on the local prod-clone.
 *     The procedure COMMITs, so nothing here can be wrapped in a rolled-back
 *     transaction: each phase moves the watermark back, CALLs, reads what
 *     landed, and the `finally` restores pipeline_state exactly as found. The
 *     MV is left freshly rebuilt, which is what the cron would have done.
 *     DOUBLY gated: skips when the local DB is unreachable, and requires
 *     CIVITICS_DB_HEAVY_TESTS=1 because it runs four full rebuilds plus one
 *     whole-table aggregate (minutes on a clone, not milliseconds). Every
 *     phase prints its numbers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

// `__dirname`, not `import.meta.dirname`: tsx transforms this file to CJS.
const MIGRATION = path.join(
  __dirname, "..", "..", "..", "..",
  "supabase", "migrations", "20260920100000_fix1212_donor_party_full_rebuild_windowed.sql",
);

const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const HEAVY = process.env["CIVITICS_DB_HEAVY_TESTS"] === "1";

const SIG = "CREATE OR REPLACE PROCEDURE public.refresh_donor_party_rollup_incremental()";

/** The text between the CREATE line and `AS $procedure$`. */
function header(src: string): string {
  const i = src.indexOf(SIG);
  assert.notEqual(i, -1, "procedure not found in the migration");
  const rest = src.slice(i);
  const end = rest.indexOf("AS $procedure$");
  assert.notEqual(end, -1, "no AS $procedure$");
  return rest.slice(0, end);
}

/** The procedure body, between its dollar-quotes. */
function body(src: string): string {
  const i = src.indexOf(SIG);
  const m = src.slice(i).match(/AS \$procedure\$([\s\S]*?)\$procedure\$/);
  assert.ok(m, "no dollar-quoted body");
  return m[1] as string;
}

/** SQL with `--` comments removed, so an anchor cannot be satisfied by prose. */
function code(sql: string): string {
  return sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
}

// ---------------------------------------------------------------------------
// (v) Source anchors — no database.
// ---------------------------------------------------------------------------

test("FIX-1212 (v): the procedure takes no SET clause — it COMMITs, and a proconfig'd routine cannot", () => {
  const src = fs.readFileSync(MIGRATION, "utf8");
  assert.doesNotMatch(header(src), /\bSET\s+\w+/i);
});

test("FIX-1212 (v): no statement_timeout is SET anywhere in the migration (FIX-1128: inert in a routine)", () => {
  const src = code(fs.readFileSync(MIGRATION, "utf8"));
  assert.doesNotMatch(src, /SET\s+(LOCAL\s+)?statement_timeout/i);
  assert.doesNotMatch(src, /set_config\s*\(\s*'statement_timeout'/i);
});

test("FIX-1212 (v): every EXCEPTION block names query_canceled BEFORE OTHERS (FIX-1028)", () => {
  const b = code(body(fs.readFileSync(MIGRATION, "utf8")));
  const blocks = b.split(/\bEXCEPTION\b/).slice(1);
  assert.ok(blocks.length >= 2, `expected the window block and the slice block, found ${blocks.length}`);
  for (const [n, blk] of blocks.entries()) {
    const qc = blk.search(/WHEN\s+query_canceled\s+THEN/);
    const others = blk.search(/WHEN\s+OTHERS\s+THEN/);
    assert.ok(qc > -1, `EXCEPTION block ${n + 1} has no query_canceled handler`);
    assert.ok(others > -1, `EXCEPTION block ${n + 1} has no OTHERS handler`);
    assert.ok(qc < others, `EXCEPTION block ${n + 1}: WHEN OTHERS does not match 57014, so it must come second`);
  }
});

test("FIX-1212 (v): parallel is off, as a plain SET beside work_mem (survives the per-window COMMITs)", () => {
  const b = code(body(fs.readFileSync(MIGRATION, "utf8")));
  assert.match(b, /^\s*SET max_parallel_workers_per_gather = 0;/m);
  assert.match(b, /^\s*SET work_mem = '256MB';/m);
  assert.doesNotMatch(b, /SET LOCAL max_parallel_workers_per_gather/, "SET LOCAL would reset at the first COMMIT");
});

test("FIX-1212 (v): the window bound is on financial_relationships, entity_tags AND financial_entities", () => {
  const b = code(body(fs.readFileSync(MIGRATION, "utf8")));
  // The three bound fragments are built once each…
  assert.match(b, /v_fr_w := format\('fr\.from_id >= %L::uuid'/);
  assert.match(b, /v_et_w := format\('et\.entity_id >= %L::uuid'/);
  assert.match(b, /v_fe_w := format\('fe\.id >= %L::uuid'/);
  // …and each lands in its own source inside the stage.
  const stage = b.slice(b.indexOf("CREATE TEMP TABLE dpr_stage_w"), b.indexOf("$stage$, v_fr_w"));
  assert.match(stage, /AND fr\.from_type = 'financial_entity'\s+AND %1\$s/);
  assert.match(stage, /AND et\.tag_category = 'industry'\s+AND %2\$s/);
  assert.match(stage, /ON fe\.id = a\.donor_id AND %3\$s/, "unbounded, this join hashes ALL of financial_entities per window");
  assert.doesNotMatch(b, /CREATE TEMP TABLE dpr_stage AS/, "the whole-table stage is gone");
});

test("FIX-1212 (v): the cursor is written inside the window's block, after its apply — same transaction", () => {
  const b = code(body(fs.readFileSync(MIGRATION, "utf8")));
  const loop = b.slice(b.indexOf("FOR i IN 1..16 LOOP"), b.indexOf("END LOOP;"));
  const iInsert = loop.indexOf("INSERT INTO public.donor_party_rollup_mv");
  const iCursor = loop.indexOf("VALUES (c_cursor_key");
  const iExc = loop.indexOf("EXCEPTION");
  const iLocals = loop.indexOf("v_done     := v_done || i;");
  assert.ok(iInsert > -1 && iCursor > -1 && iExc > -1 && iLocals > -1);
  assert.ok(iInsert < iCursor, "the cursor may only name a window after its rows are in");
  assert.ok(iCursor < iLocals, "locals are not rolled back — they update only after every DB write");
  assert.ok(iLocals < iExc, "all of it inside the window's subtransaction");
});

test("FIX-1212 (v): the grants are restated — service_role only", () => {
  const src = fs.readFileSync(MIGRATION, "utf8");
  assert.match(src, /REVOKE ALL ON PROCEDURE public\.refresh_donor_party_rollup_incremental\(\) FROM PUBLIC, anon, authenticated;/);
  assert.match(src, /GRANT EXECUTE ON PROCEDURE public\.refresh_donor_party_rollup_incremental\(\) TO service_role;/);
});

// ---------------------------------------------------------------------------
// (i)-(iv) Behavioural — skipped without a DB, and without CIVITICS_DB_HEAVY_TESTS=1.
// ---------------------------------------------------------------------------

const BOUNDS = Array.from({ length: 16 }, (_, k) => `${k.toString(16)}0000000-0000-0000-0000-000000000000`);

type LogRow = {
  status: string;
  secs: number;
  metadata: Record<string, unknown>;
  error_message: string | null;
};

async function key(c: Client, k: string): Promise<Record<string, unknown> | null> {
  const r = await c.query<{ value: Record<string, unknown> }>(
    "SELECT value FROM public.pipeline_state WHERE key = $1", [k]);
  return r.rows[0]?.value ?? null;
}

async function putKey(c: Client, k: string, v: Record<string, unknown> | null): Promise<void> {
  if (v === null) {
    await c.query("DELETE FROM public.pipeline_state WHERE key = $1", [k]);
  } else {
    await c.query(
      `INSERT INTO public.pipeline_state (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = clock_timestamp()`,
      [k, JSON.stringify(v)]);
  }
}

async function watermark(c: Client): Promise<string | null> {
  const v = await key(c, "donor_party_rollup_watermark");
  return (v?.["last_indexed_at"] as string | undefined) ?? null;
}

async function setWatermarkDaysAgo(c: Client, days: number): Promise<string> {
  const r = await c.query<{ w: string }>(`SELECT (now() - make_interval(days => $1))::text AS w`, [days]);
  const w = r.rows[0]!.w;
  await putKey(c, "donor_party_rollup_watermark", { last_indexed_at: w });
  return w;
}

async function lastLog(c: Client): Promise<LogRow> {
  const r = await c.query<LogRow>(
    `SELECT status, round(extract(epoch FROM completed_at - started_at))::int AS secs,
            metadata, error_message
       FROM public.data_sync_log
      WHERE pipeline = 'donor_party_rollup_refresh'
      ORDER BY started_at DESC LIMIT 1`);
  return r.rows[0]!;
}

async function callProc(c: Client, notices?: string[]): Promise<number> {
  const onNotice = (m: { message?: string }) => notices?.push(m.message ?? "");
  c.on("notice", onNotice);
  const t0 = Date.now();
  try {
    await c.query("CALL public.refresh_donor_party_rollup_incremental()");
  } finally {
    c.off("notice", onNotice);
  }
  return Date.now() - t0;
}

async function windowCounts(c: Client): Promise<number[]> {
  const r = await c.query<{ i: number; n: string }>(`
    WITH b AS (
      SELECT i, $1::uuid[] AS bounds FROM generate_series(1, 16) i
    )
    SELECT b.i, (SELECT count(*) FROM public.donor_party_rollup_mv m
                  WHERE m.donor_id >= b.bounds[b.i]
                    AND (b.i = 16 OR m.donor_id < b.bounds[b.i + 1]))::text AS n
      FROM b ORDER BY b.i`, [BOUNDS]);
  return r.rows.map((x) => Number(x.n));
}

function num(v: unknown): number[] {
  return Array.isArray(v) ? v.map((x) => Number(x)) : [];
}

const SENTINEL_PARTY = "fix1212_sentinel";
const sentinel = (w: number) => `${(w - 1).toString(16)}1212f00-0000-4000-8000-000000001212`;

test("FIX-1212 (i)-(iv): windowed full rebuild — completes, resumes, survives a cancel, conserves to the cent",
  { timeout: 60 * 60 * 1000 },
  async (t) => {
    if (!HEAVY) {
      t.skip("CIVITICS_DB_HEAVY_TESTS=1 not set — four full rebuilds + one whole-table aggregate (minutes)");
      return;
    }
    const a = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
    const b = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
    try {
      await a.connect();
      await b.connect();
    } catch {
      t.skip("local Docker DB unreachable — behavioural half skipped (source anchors above still ran)");
      return;
    }

    const origWatermark = await key(a, "donor_party_rollup_watermark");
    const origCrawl = await key(a, "donor_party_crawl");
    const origCursor = await key(a, "donor_party_full_rebuild");
    assert.equal(origCursor, null, "a live cursor on the clone before the test would be resumed, not tested");

    try {
      // ── (i) a full rebuild, end to end ────────────────────────────────────
      const w0 = await setWatermarkDaysAgo(a, 60);
      const notices: string[] = [];
      const ms1 = await callProc(a, notices);
      const l1 = await lastLog(a);
      const md1 = l1.metadata;
      console.log(`[fix1212 (i)] ${l1.status} mode=${md1["mode"]} wall=${(ms1 / 1000).toFixed(1)} s ` +
        `rows=${md1["rollup_rows"]} windows_run=${JSON.stringify(md1["windows_run"])}`);
      console.log(`[fix1212 (i)] stage_seconds=${JSON.stringify(md1["stage_seconds"])}`);
      console.log(`[fix1212 (i)] apply_seconds=${JSON.stringify(md1["apply_seconds"])}`);
      assert.equal(md1["mode"], "full");
      assert.equal(l1.status, "complete");
      assert.equal(md1["caught_up"], true);
      assert.equal(md1["resumed"], false);
      assert.deepEqual(num(md1["windows_done"]), BOUNDS.map((_, k) => k + 1));
      assert.equal(num(md1["stage_seconds"]).length, 16);
      assert.equal(notices.filter((n) => /window \d+\/16 — stage/.test(n)).length, 16, "one NOTICE per window");
      assert.equal(await key(a, "donor_party_full_rebuild"), null, "the cursor is gone on completion");
      const w1 = await watermark(a);
      assert.ok(w1 !== null && new Date(w1) > new Date(w0), `watermark advanced: ${w0} -> ${w1}`);
      assert.equal(new Date(w1!).getTime(), new Date(md1["cycle_target"] as string).getTime(),
        "the watermark is the target fixed before window 1");

      // ── (iv) conservation: the windowed MV against one whole-table agg ─────
      const mv = await a.query<{ n: string; cents: string; tx: string }>(
        `SELECT count(*)::text AS n, sum(total_cents)::text AS cents, sum(tx_count)::text AS tx
           FROM public.donor_party_rollup_mv`);
      const t4 = Date.now();
      const whole = await a.query<{ n: string; cents: string; tx: string }>(`
        SELECT count(*)::text AS n, sum(total_cents)::text AS cents, sum(tx_count)::text AS tx FROM (
          SELECT fr.from_id, COALESCE(o.party::text, 'unknown'),
                 SUM(fr.amount_cents)::bigint AS total_cents, COUNT(*)::bigint AS tx_count
            FROM public.financial_relationships fr
            JOIN public.officials o ON o.id = fr.to_id AND fr.to_type = 'official'
           WHERE fr.relationship_type = 'donation' AND fr.from_type = 'financial_entity'
           GROUP BY 1, 2) g`);
      console.log(`[fix1212 (iv)] MV     rows=${mv.rows[0]!.n} cents=${mv.rows[0]!.cents} tx=${mv.rows[0]!.tx}`);
      console.log(`[fix1212 (iv)] whole  rows=${whole.rows[0]!.n} cents=${whole.rows[0]!.cents} tx=${whole.rows[0]!.tx} ` +
        `(one-shot agg ${((Date.now() - t4) / 1000).toFixed(1)} s)`);
      assert.equal(mv.rows[0]!.cents, whole.rows[0]!.cents, "SUM(total_cents) to the cent");
      assert.equal(mv.rows[0]!.tx, whole.rows[0]!.tx, "SUM(tx_count)");
      assert.equal(mv.rows[0]!.n, whole.rows[0]!.n, "one MV row per (donor, party) group");

      // ── (ii) the resume: cap after three windows, then finish ─────────────
      const w2 = await setWatermarkDaysAgo(a, 60);
      await putKey(a, "donor_party_crawl", { ...(origCrawl ?? {}), max_units: 3 });
      const ms2a = await callProc(a);
      const l2a = await lastLog(a);
      const cur2 = await key(a, "donor_party_full_rebuild");
      console.log(`[fix1212 (ii)] call 1: ${l2a.status} wall=${(ms2a / 1000).toFixed(1)} s ` +
        `windows_done=${JSON.stringify(l2a.metadata["windows_done"])} err=${l2a.error_message}`);
      assert.equal(l2a.status, "partial");
      assert.equal(l2a.metadata["unit_capped"], true);
      assert.deepEqual(num(l2a.metadata["windows_done"]), [1, 2, 3]);
      assert.deepEqual(num(cur2?.["windows_done"]), [1, 2, 3], "the cursor banked exactly the committed windows");
      assert.equal(await watermark(a), w2, "no watermark until all sixteen are in");

      await putKey(a, "donor_party_crawl", origCrawl);
      const ms2b = await callProc(a);
      const l2b = await lastLog(a);
      console.log(`[fix1212 (ii)] call 2: ${l2b.status} wall=${(ms2b / 1000).toFixed(1)} s resumed=${l2b.metadata["resumed"]} ` +
        `windows_run=${JSON.stringify(l2b.metadata["windows_run"])}`);
      assert.equal(l2b.metadata["resumed"], true);
      assert.deepEqual(num(l2b.metadata["windows_run"]), Array.from({ length: 13 }, (_, k) => k + 4));
      assert.equal(l2b.status, "complete");
      assert.equal(l2b.metadata["caught_up"], true);
      assert.equal(await key(a, "donor_party_full_rebuild"), null);
      assert.equal(new Date((await watermark(a))!).getTime(), new Date(cur2?.["target"] as string).getTime(),
        "the resumed cycle writes the target captured by the FIRST call, not a new one");

      // ── (iii) atomicity: cancel inside a window's apply ───────────────────
      await setWatermarkDaysAgo(a, 60);
      for (let w = 1; w <= 16; w++) {
        await a.query(
          `INSERT INTO public.donor_party_rollup_mv
             (donor_id, party_key, donor_name, entity_type, industry_tag, industry_label, total_cents, tx_count)
           VALUES ($1, $2, 'FIX-1212 sentinel', 'pac', NULL, NULL, 0, 0)`,
          [sentinel(w), SENTINEL_PARTY]);
      }
      const before = await windowCounts(a);
      const pidA = (await a.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;

      const running = callProc(a);
      // Wait for two windows to bank, then take a SHARE lock: the next window's
      // DELETE (ROW EXCLUSIVE) queues behind it, inside its EXCEPTION block —
      // so the cancel lands exactly where the design says it is safe.
      const deadline = Date.now() + 10 * 60 * 1000;
      for (;;) {
        const cur = await key(b, "donor_party_full_rebuild");
        if (num(cur?.["windows_done"]).length >= 2) break;
        assert.ok(Date.now() < deadline, "two windows never banked");
        await new Promise((r) => setTimeout(r, 200));
      }
      await b.query("BEGIN");
      await b.query("LOCK TABLE public.donor_party_rollup_mv IN SHARE MODE");
      for (;;) {
        const w = await b.query<{ wt: string | null }>(
          "SELECT wait_event_type AS wt FROM pg_stat_activity WHERE pid = $1", [pidA]);
        if (w.rows[0]?.wt === "Lock") break;
        assert.ok(Date.now() < deadline, "the CALL never queued on the lock");
        await new Promise((r) => setTimeout(r, 100));
      }
      await b.query("SELECT pg_cancel_backend($1)", [pidA]);
      await b.query("ROLLBACK");
      await running;

      const l3 = await lastLog(a);
      const cur3 = await key(a, "donor_party_full_rebuild");
      const done3 = num(cur3?.["windows_done"]);
      const m = /^window (\d+):/.exec(String(l3.metadata["cancel_detail"] ?? ""));
      const cancelled = m ? Number(m[1]) : NaN;
      const after = await windowCounts(a);
      const present = new Set(
        (await a.query<{ donor_id: string }>(
          "SELECT donor_id::text FROM public.donor_party_rollup_mv WHERE party_key = $1", [SENTINEL_PARTY]))
          .rows.map((r) => r.donor_id));
      console.log(`[fix1212 (iii)] ${l3.status} cancel_detail=${l3.metadata["cancel_detail"]} ` +
        `windows_done=${JSON.stringify(done3)} window ${cancelled} rows before=${before[cancelled - 1]} after=${after[cancelled - 1]}`);
      assert.equal(l3.status, "partial");
      assert.equal(l3.metadata["canceled"], true);
      assert.ok(Number.isInteger(cancelled), `cancel_detail names the window: ${l3.metadata["cancel_detail"]}`);
      assert.ok(!done3.includes(cancelled), "the cancelled window is not in the cursor");
      assert.ok(done3.length >= 2);
      assert.equal(after[cancelled - 1], before[cancelled - 1], "the cancelled window holds its PRIOR rows");
      for (let w = 1; w <= 16; w++) {
        assert.equal(present.has(sentinel(w)), !done3.includes(w),
          `window ${w}: sentinel present iff the window was NOT applied`);
      }

      // …and the next CALL resumes past it and clears every sentinel.
      const ms3b = await callProc(a);
      const l3b = await lastLog(a);
      const left = await a.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM public.donor_party_rollup_mv WHERE party_key = $1", [SENTINEL_PARTY]);
      console.log(`[fix1212 (iii)] resume: ${l3b.status} wall=${(ms3b / 1000).toFixed(1)} s ` +
        `windows_run=${JSON.stringify(l3b.metadata["windows_run"])} sentinels left=${left.rows[0]!.n}`);
      assert.equal(l3b.status, "complete");
      assert.ok(num(l3b.metadata["windows_run"]).includes(cancelled), "the cancelled window is retried");
      assert.equal(left.rows[0]!.n, "0");
      assert.equal(await key(a, "donor_party_full_rebuild"), null);
    } finally {
      await a.query("DELETE FROM public.donor_party_rollup_mv WHERE party_key = $1", [SENTINEL_PARTY]).catch(() => {});
      await putKey(a, "donor_party_rollup_watermark", origWatermark).catch(() => {});
      await putKey(a, "donor_party_crawl", origCrawl).catch(() => {});
      await putKey(a, "donor_party_full_rebuild", origCursor).catch(() => {});
      await a.end();
      await b.end();
    }
  },
);
