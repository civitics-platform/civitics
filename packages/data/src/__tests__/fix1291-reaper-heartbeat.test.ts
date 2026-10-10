/**
 * FIX-1291 (cc-214) — `*_fix1291_reaper_heartbeat_usaspending_hold.sql`.
 *
 * Runs via:  tsx --test src/__tests__/fix1291-reaper-heartbeat.test.ts
 *
 * Source anchors (no DB, run in CI): reap_stale_sync_log's age predicate reads
 * metadata.heartbeat_at before started_at; the hold rows for usaspending_bulk
 * and usaspending_bulk_assistance are present, with a `note` (NOT NULL) and a
 * hold_reason a FIX-950 session release cannot clear; no proconfig.
 *
 * Rule 34 — the body is 20260731000000's body with ONLY the intended lines
 * changed: an LCS line diff must remove and add exactly the lines in EDIT.
 *
 * Rule 105 — the predicate checker is also run against the 0731 body, and must
 * reject it.
 *
 * Against the local DB (skipped when unreachable): the live prosrc equals the
 * file's body, the two hold rows exist, and — inside a rolled-back transaction —
 * a row 2 h old with a fresh heartbeat survives reap_stale_sync_log(60) while
 * the same row with a 2-hour-old heartbeat is reaped. RED before
 * `migration up --local`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const SUFFIX = "_fix1291_reaper_heartbeat_usaspending_hold.sql";
const PRIOR = "20260731000000_fix944_resumable_donor_rollup.sql";
const SIGNATURE = "CREATE OR REPLACE FUNCTION public.reap_stale_sync_log(stale_minutes INT DEFAULT 10)";
const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const read = (f: string) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");

function migration(): string {
  const hits = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(SUFFIX));
  assert.equal(hits.length, 1, `expected exactly one *${SUFFIX}, found ${hits.join(", ") || "none"}`);
  return read(path.join(MIGRATIONS, hits[0] as string));
}

/** The routine body between `AS $$` and the closing `$$`. */
function body(src: string): string {
  const i = src.indexOf(SIGNATURE);
  assert.notEqual(i, -1, "reap_stale_sync_log not found");
  const m = src.slice(i).match(/AS (\$\w*\$)([\s\S]*?)\1/);
  assert.ok(m, "no dollar-quoted body");
  return m[2] as string;
}

const stripComments = (s: string) => s.replace(/--[^\n]*/g, "");

/** The checker: does this body measure staleness from the heartbeat first? */
function readsHeartbeatFirst(b: string): boolean {
  const code = stripComments(b).replace(/\s+/g, " ");
  return (
    /COALESCE\( CASE WHEN dsl\.metadata->>'heartbeat_at' ~ '[^']+' THEN \(dsl\.metadata->>'heartbeat_at'\)::timestamptz END, dsl\.started_at\) < NOW\(\) - \(stale_minutes::text \|\| ' minutes'\)::interval/.test(code) &&
    !/AND dsl\.started_at < NOW\(\)/.test(code)
  );
}

/** LCS line diff: the lines only in `a` (removed) and only in `b` (added). */
function lineDiff(a: string, b: string): { removed: string[]; added: string[] } {
  const A = a.split("\n");
  const B = b.split("\n");
  const n = A.length;
  const m = B.length;
  const L: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = L[i] as Uint16Array;
    const next = L[i + 1] as Uint16Array;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = A[i] === B[j] ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number);
    }
  }
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { i++; j++; }
    else if ((L[i + 1] as Uint16Array)[j]! >= (L[i] as Uint16Array)[j + 1]!) removed.push(A[i++] as string);
    else added.push(B[j++] as string);
  }
  while (i < n) removed.push(A[i++] as string);
  while (j < m) added.push(B[j++] as string);
  return { removed, added };
}

/** Rule 34: the complete list of lines the body may lose and gain against 0731. */
const EDIT = {
  removed: [
    "             'cron.job_run_details.end_time.')",
    "     AND dsl.started_at < NOW() - (stale_minutes::text || ' minutes')::interval",
  ],
  added: [
    "             'cron.job_run_details.end_time. Reaped because the row''s last '",
    "             'heartbeat (metadata.heartbeat_at, FIX-1291) - or started_at, '",
    "             'when it never stamped one - is older than reap_stale_minutes.')",
    "     -- FIX-1291: a row that heartbeats is alive, however old it is.",
    "     AND COALESCE(",
    "           CASE WHEN dsl.metadata->>'heartbeat_at' ~ '^\\d{4}-\\d{2}-\\d{2}[ T]'",
    "                THEN (dsl.metadata->>'heartbeat_at')::timestamptz END,",
    "           dsl.started_at)",
    "         < NOW() - (stale_minutes::text || ' minutes')::interval",
  ],
};

test("the reaper reads metadata.heartbeat_at before started_at (and the 0731 body does not — rule 105)", () => {
  assert.equal(readsHeartbeatFirst(body(migration())), true);
  assert.equal(readsHeartbeatFirst(body(read(path.join(MIGRATIONS, PRIOR)))), false, "the checker rejects the age-only body");
});

test("rule 34: the body is 0731's with exactly the predicate + reap_note lines changed", () => {
  const d = lineDiff(body(read(path.join(MIGRATIONS, PRIOR))), body(migration()));
  assert.deepEqual(d.removed, EDIT.removed);
  assert.deepEqual(d.added, EDIT.added);
});

test("no proconfig; grants restated as 0731 stated them; the signature is unchanged", () => {
  const src = migration();
  const header = src.slice(src.indexOf(SIGNATURE), src.indexOf("AS $$", src.indexOf(SIGNATURE)));
  assert.doesNotMatch(header, /\bSET\b/, "a proconfig would make the routine atomic and is not wanted here");
  assert.match(src, /^GRANT EXECUTE ON FUNCTION public\.reap_stale_sync_log\(INT\) TO service_role;$/m);
  assert.match(src, /^GRANT EXECUTE ON FUNCTION public\.reap_stale_sync_log\(INT\) TO authenticated;$/m);
  assert.match(src, /RETURNS TABLE\(id UUID, pipeline TEXT, reaped_at TIMESTAMPTZ\)/);
});

test("the hold rows: both usaspending pipelines, note present, not a session-release hold", () => {
  const code = stripComments(migration());
  const ins = code.slice(code.indexOf("INSERT INTO public.rollup_watch_overrides"));
  assert.match(ins, /\(pipeline, held_since, hold_reason, note\)/, "note is NOT NULL on this table");
  for (const p of ["usaspending_bulk", "usaspending_bulk_assistance"]) {
    assert.match(ins, new RegExp(`\\('${p}', now\\(\\),\\s*'FIX-1291 — dispatch-only since 2026-10-08`), p);
  }
  assert.match(ins, /ON CONFLICT \(pipeline\) DO NOTHING;/);
  assert.doesNotMatch(ins, /'prod session held: /, "clearGuardedHolds() would clear a hold spelled that way");
});

// ---------------------------------------------------------------------------
// Against the local DB
// ---------------------------------------------------------------------------

async function local(): Promise<Client | null> {
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 3000 });
  try {
    await c.connect();
    return c;
  } catch {
    return null;
  }
}

test("local: the live reaper is the file's body, and the hold rows exist", async (t) => {
  const c = await local();
  if (!c) { t.skip("local DB unreachable"); return; }
  try {
    const r = await c.query<{ prosrc: string; proconfig: string[] | null }>(
      `SELECT prosrc, proconfig FROM pg_proc WHERE oid = 'public.reap_stale_sync_log(integer)'::regprocedure`,
    );
    assert.equal(r.rows[0]?.prosrc.replace(/\r\n/g, "\n"), body(migration()), "migration up --local not applied?");
    assert.equal(r.rows[0]?.proconfig, null);
    const h = await c.query<{ pipeline: string }>(
      `SELECT pipeline FROM public.rollup_watch_overrides
        WHERE pipeline LIKE 'usaspending%' AND held_since IS NOT NULL AND hold_reason LIKE 'FIX-1291%'
        ORDER BY 1`,
    );
    assert.deepEqual(h.rows.map((x) => x.pipeline), ["usaspending_bulk", "usaspending_bulk_assistance"]);
  } finally {
    await c.end();
  }
});

test("local: a 2-hour-old row with a fresh heartbeat survives reap(60); a stale heartbeat is reaped (rolled back)", async (t) => {
  const c = await local();
  if (!c) { t.skip("local DB unreachable"); return; }
  try {
    await c.query("BEGIN");
    const ins = await c.query<{ id: string }>(
      `INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
       VALUES ('fix1291_test', 'running', now() - interval '2 hours',
               jsonb_build_object('heartbeat_at', now() - interval '30 seconds')),
              ('fix1291_test', 'running', now() - interval '2 hours',
               jsonb_build_object('heartbeat_at', now() - interval '2 hours')),
              ('fix1291_test', 'running', now() - interval '2 hours', '{}'::jsonb),
              ('fix1291_test', 'running', now() - interval '2 hours',
               jsonb_build_object('heartbeat_at', 'not a timestamp'))
       RETURNING id`,
    );
    const [fresh, stale, never, junk] = ins.rows.map((r) => r.id);
    const reaped = await c.query<{ id: string }>(`SELECT id FROM public.reap_stale_sync_log(60)`);
    const ids = new Set(reaped.rows.map((r) => r.id));
    assert.equal(ids.has(fresh!), false, "a heartbeat 30 s old: alive, not reaped");
    assert.equal(ids.has(stale!), true, "a heartbeat 2 h old: reaped on the same 60-min rule");
    assert.equal(ids.has(never!), true, "no heartbeat: judged on started_at, as before");
    assert.equal(ids.has(junk!), true, "a malformed stamp falls back to started_at instead of throwing");
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    await c.end();
  }
});
