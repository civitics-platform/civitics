/**
 * cc-241 — FIX-1293: get_ec_crawl_health reads the crawl's staged cycle
 * (`*_fix1293_ec_crawl_health_reads_staged_cycle.sql`) instead of counting
 * financial_relationships on every 30-minute status roll.
 *
 * Runs via:  tsx --test src/__tests__/ec-crawl-health-1293.test.ts
 *
 * work-mem-allowances.test.ts reads only `*_ec_crawl_health_bounded_dirty_set.sql`,
 * so its text checks keep passing against that file whatever replaces it. This
 * file anchors the new body (rule 305; no DB, run in CI; rule 105):
 *   - the count is gone: no financial_relationships, no EXECUTE in the body;
 *   - it reads pipeline_state 'entity_connections_donations' -> 'cycle';
 *   - dirty_set keeps rows / donors / capped and adds source / since_at /
 *     target_at / staged_at;
 *   - the header is 20261010030000's (SECURITY DEFINER, the search_path, one
 *     SET clause, no statement_timeout) and the grants are restated;
 *   - nothing else moved: an LCS line diff against 20261010030000 removes
 *     exactly the count block and the dirty_set line, and adds a pinned number;
 *   - the read-back DO block; the revert is the old body verbatim.
 * Behavioural, against the local clone when the migration is applied there:
 * the live body is this file's, and dirty_set follows the cycle key both ways
 * (in a rolled-back transaction). Skips when unreachable or unmigrated.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { body, header, read, stripComments } from "./lib/migration-text";

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
const NEW = () => one("_fix1293_ec_crawl_health_reads_staged_cycle.sql");
const OLD = () => one("_fix1293_ec_crawl_health_bounded_dirty_set.sql");
const REVERT = () => read(path.join(ROOT, "scripts", "fix1293-revert-ec-crawl-health-to-bounded-count.sql"));

const SIG = "CREATE OR REPLACE FUNCTION public.get_ec_crawl_health(";
/** prod's prosrc at cc-241 read 3 = the 20261010030000 file's body. */
const OLD_MD5 = "7c837519c78b25f38a550cde4bb3947a";
/** The new body's added lines vs 20261010030000 (the hunks, nothing else). */
const ADDED_LINES = 17;

const md5 = (s: string) => crypto.createHash("md5").update(s).digest("hex");
const newBody = () => body(NEW(), SIG);
const oldBody = () => body(OLD(), SIG);

/** The old lines an LCS line diff removes, and the new lines it adds (dispatcher-b1.test.ts's shape). */
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

/** Everything the new body must and must not do. Empty = conforms. */
function stagedCycleProblems(def: string): string[] {
  const code = stripComments(def);
  const p: string[] = [];
  if (/financial_relationships/.test(code)) p.push("the body still reads financial_relationships");
  if (/\bEXECUTE\b/.test(code)) p.push("the body still EXECUTEs a dynamic statement");
  if (!/SELECT value->'cycle' INTO v_cycle\s+FROM public\.pipeline_state WHERE key = 'entity_connections_donations';/.test(code)) {
    p.push("does not read pipeline_state entity_connections_donations -> 'cycle'");
  }
  if (/ec_donations_incr_dirty/.test(code)) p.push("counts ec_donations_incr_dirty (a second source of the key's number)");
  if (!code.includes("v_dirty_rows   := NULL;")) p.push("rows is not null");
  if (!code.includes("v_dirty_dons   := COALESCE((v_cycle->>'dirty_donors')::bigint, 0);")) p.push("donors is not the cycle's dirty_donors");
  if (!code.includes("v_dirty_capped := false;")) p.push("capped is not false");
  if (!code.includes("v_dirty_src    := CASE WHEN v_cycle IS NULL THEN 'caught_up' ELSE 'crawl_cycle' END;")) {
    p.push("source is not caught_up | crawl_cycle");
  }
  const ds = /'dirty_set',\s+jsonb_build_object\(([\s\S]*?)\),\n\s+'firings_7d'/.exec(code)?.[1] ?? "";
  for (const k of ["rows", "donors", "capped", "source", "since_at", "target_at", "staged_at"]) {
    if (!ds.includes(`'${k}'`)) p.push(`dirty_set does not carry '${k}'`);
  }
  return p;
}

// ---------------------------------------------------------------------------
// (1) the base is 20261010030000 verbatim, and only the dirty-set lines moved
// ---------------------------------------------------------------------------

test("(1) the base: 20261010030000's body hashes to prod's prosrc at cc-241 read 3", () => {
  assert.equal(md5(oldBody()), OLD_MD5);
});

test("(1) the file defines get_ec_crawl_health exactly once, and nothing else", () => {
  const code = stripComments(NEW());
  assert.equal(code.split(SIG).length - 1, 1);
  assert.equal((code.match(/CREATE OR REPLACE (FUNCTION|PROCEDURE)/g) ?? []).length, 1);
  assert.doesNotMatch(code, /CREATE\s+(UNIQUE\s+)?INDEX|DROP\s+INDEX|ALTER\s+TABLE/i, "D-b: no index or table change");
});

test("(1) the LCS diff against 20261010030000 removes only the count block and the dirty_set line", () => {
  const d = lineDiff(oldBody(), newBody());
  assert.deepEqual(d.removed.map((l) => l.trim()), [
    "IF v_wm IS NOT NULL THEN",
    "-- FIX-1293: bounded, and planned per call with v_wm's value. A cached generic",
    "-- plan for \"updated_at > $1\" under LIMIT is a Seq Scan, and below the cap it",
    "-- reads all of financial_relationships (cc-211 clone: 7.1 s from the 6th call).",
    "EXECUTE 'SELECT count(*), count(DISTINCT from_id)",
    "FROM (SELECT from_id",
    "FROM public.financial_relationships",
    "WHERE relationship_type IN (''donation'',''ie_support'',''ie_oppose'')",
    "AND updated_at > $1",
    "LIMIT 100001) s'",
    "INTO v_dirty_rows, v_dirty_dons",
    "USING v_wm;",
    "v_dirty_capped := v_dirty_rows > 100000;   -- then rows/donors are LOWER BOUNDS",
    "'dirty_set',      jsonb_build_object('rows', v_dirty_rows, 'donors', v_dirty_dons, 'capped', v_dirty_capped),",
  ]);
  // The added side, pinned: two declarations, the cycle read + its object
  // guard (its END IF pairs with the old block's), the four assignments, and
  // the five-line dirty_set build: 2 + 10 + 5. A change
  // anywhere else in the body moves this number.
  assert.equal(d.added.length, ADDED_LINES, d.added.join("\n"));
  const allowed = /v_cycle|v_dirty_src|key = 'entity_connections_donations';$|v_dirty_rows|v_dirty_dons|v_dirty_capped|FIX-1293 \(cc-241\)|rebuild_ec_donations_incr_prepare|^\s*END IF;$|'source'|'since_at'|'target_at'|'staged_at'|'dirty_set'/;
  for (const l of d.added) assert.match(l, allowed, `an added line outside the dirty-set hunks: ${l}`);
});

test("(1) the firings block — the dirty-set block's end to v_lag_days — is byte-identical", () => {
  const slice = (b: string, from: string) => {
    const i = b.indexOf(from);
    assert.notEqual(i, -1, from);
    return b.slice(i, b.indexOf("  v_lag_days  :=", i));
  };
  const firings = "  SELECT count(*),\n         count(*) FILTER (WHERE d.status <> 'succeeded')";
  assert.equal(slice(newBody(), firings), slice(oldBody(), firings));
  // ... and the tail from v_lag_days to the RETURN's dirty_set line, likewise.
  const tail = (b: string) => b.slice(b.indexOf("  v_lag_days  :="), b.indexOf("    'dirty_set',"));
  assert.equal(tail(newBody()), tail(oldBody()));
  const after = (b: string) => b.slice(b.indexOf("    'firings_7d',"));
  assert.equal(after(newBody()), after(oldBody()));
});

// ---------------------------------------------------------------------------
// (2) the body's shape
// ---------------------------------------------------------------------------

test("(2) D-a: no count over financial_relationships; dirty_set is the crawl's staged cycle", () => {
  assert.deepEqual(stagedCycleProblems(newBody()), []);
});

test("(2) the object guard: a JSON-null or non-object cycle reads as caught up", () => {
  assert.match(stripComments(newBody()),
    /IF jsonb_typeof\(v_cycle\) IS DISTINCT FROM 'object' THEN\n\s+v_cycle := NULL;\n\s+END IF;/);
});

test("(2) v_signal still reads only the lag and the backoff rate", () => {
  const sig = /v_signal := CASE([\s\S]*?)END;/.exec(stripComments(newBody()))?.[1] ?? "";
  assert.notEqual(sig, "");
  assert.doesNotMatch(sig, /v_dirty|v_cycle/);
});

// ---------------------------------------------------------------------------
// (3) header + grants (FIX-1128)
// ---------------------------------------------------------------------------

test("(3) the header is 20261010030000's: SECURITY DEFINER, the search_path, one SET clause, no statement_timeout", () => {
  const h = header(NEW(), SIG);
  assert.equal(h, header(OLD(), SIG));
  assert.match(h, /\nSECURITY DEFINER\n/);
  assert.match(h, /\nSET search_path = public, cron, pg_temp\n/);
  assert.equal((h.match(/\nSET /g) ?? []).length, 1);
  assert.doesNotMatch(NEW(), /^\s*SET\s+(LOCAL\s+)?statement_timeout/im);
});

test("(3) grants restated: service_role EXECUTE, nothing for PUBLIC / anon / authenticated", () => {
  const src = NEW();
  assert.ok(src.includes("REVOKE ALL ON FUNCTION public.get_ec_crawl_health() FROM PUBLIC, anon, authenticated;"));
  assert.ok(src.includes("GRANT EXECUTE ON FUNCTION public.get_ec_crawl_health() TO service_role;"));
  assert.doesNotMatch(stripComments(src), /GRANT [^;]* TO (PUBLIC|anon|authenticated)/);
});

// ---------------------------------------------------------------------------
// (4) the read-back; (5) the revert
// ---------------------------------------------------------------------------

test("(4) the read-back: the header, every section key, the dirty_set keys, source in two values, the md5", () => {
  const src = NEW();
  const doBlock = src.slice(src.indexOf("DO $fix1293$"));
  assert.ok(doBlock.length > 0, "no read-back DO block");
  assert.match(doBlock, /v_out := public\.get_ec_crawl_health\(\);/);
  assert.match(doBlock, /IF v_def IS DISTINCT FROM true THEN/);
  assert.match(doBlock, /IF v_cfg IS DISTINCT FROM ARRAY\['search_path=public, cron, pg_temp'\] THEN/);
  for (const k of ["watermark", "dirty_set", "firings_7d", "signal", "decision_rule"]) assert.ok(doBlock.includes(`'${k}'`), k);
  assert.match(doBlock, /v_ds \?& ARRAY\['rows','donors','capped','source','since_at','target_at','staged_at'\]/);
  assert.match(doBlock, /NOT IN \('crawl_cycle', 'caught_up'\)/);
  assert.match(doBlock, /RAISE NOTICE '\[fix1293\] md5 get_ec_crawl_health %', v_md5;/);
});

test("(5) the revert is 20261010030000's body verbatim, with its grants and the md5 asserted", () => {
  const src = REVERT();
  assert.equal(md5(body(src, SIG)), OLD_MD5);
  assert.equal(header(src, SIG), header(OLD(), SIG));
  assert.ok(src.includes("REVOKE ALL ON FUNCTION public.get_ec_crawl_health() FROM PUBLIC, anon, authenticated;"));
  assert.ok(src.includes("GRANT EXECUTE ON FUNCTION public.get_ec_crawl_health() TO service_role;"));
  assert.ok(src.includes(`IF v_md5 IS DISTINCT FROM '${OLD_MD5}' THEN`));
  assert.ok(src.includes("20261022000000_fix1293_ec_crawl_health_reads_staged_cycle.sql"), "names the migration it mirrors");
});

// ---------------------------------------------------------------------------
// (6) rule 105 twins: the old body fails the new checker, and tampering is caught
// ---------------------------------------------------------------------------

test("(6) rule 105: the 20261010030000 body fails every staged-cycle check that names the count", () => {
  const p = stagedCycleProblems(oldBody());
  assert.ok(p.includes("the body still reads financial_relationships"), p.join("; "));
  assert.ok(p.includes("the body still EXECUTEs a dynamic statement"), p.join("; "));
  assert.ok(p.includes("dirty_set does not carry 'source'"), p.join("; "));
});

test("(6) rule 105: a count of the staged table, or a dropped key, is caught", () => {
  const b = newBody();
  const counted = b.replace("v_dirty_rows   := NULL;", "SELECT count(*) INTO v_dirty_rows FROM public.ec_donations_incr_dirty;");
  assert.notEqual(counted, b);
  assert.ok(stagedCycleProblems(counted).some((x) => x.startsWith("counts ec_donations_incr_dirty")));
  const noStaged = b.replace(",\n                                         'staged_at', v_cycle->'staged_at'", "");
  assert.notEqual(noStaged, b);
  assert.ok(stagedCycleProblems(noStaged).includes("dirty_set does not carry 'staged_at'"));
  assert.notEqual(lineDiff(oldBody(), noStaged).added.length, ADDED_LINES);
});

// ---------------------------------------------------------------------------
// (7) local clone — behavioural, skipped when unreachable or unmigrated
// ---------------------------------------------------------------------------

async function connect(t: { skip: (m: string) => void }): Promise<Client | null> {
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  try {
    await c.connect();
  } catch {
    t.skip("local Docker DB unreachable");
    return null;
  }
  const s = (await c.query<{ s: string }>(
    "SELECT prosrc AS s FROM pg_proc WHERE oid = 'public.get_ec_crawl_health()'::regprocedure")).rows[0]?.s ?? "";
  if (md5(s.replace(/\r\n/g, "\n")) === OLD_MD5) {
    await c.end();
    t.skip("local clone does not carry 20261022000000 yet");
    return null;
  }
  return c;
}

test("local (7): the live body is this file's; proconfig the search_path only", async (t) => {
  const c = await connect(t);
  if (!c) return;
  try {
    type Row = { s: string; cfg: string[] | null; def: boolean };
    const row = (await c.query<Row>(
      "SELECT prosrc AS s, proconfig AS cfg, prosecdef AS def FROM pg_proc WHERE oid = 'public.get_ec_crawl_health()'::regprocedure")).rows[0] as Row;
    assert.equal(row.s.replace(/\r\n/g, "\n"), newBody());
    assert.deepEqual(row.cfg, ["search_path=public, cron, pg_temp"]);
    assert.equal(row.def, true);
  } finally {
    await c.end();
  }
});

test("local (7): dirty_set follows the cycle key both ways (rolled back)", async (t) => {
  const c = await connect(t);
  if (!c) return;
  try {
    await c.query("BEGIN");
    await c.query(`UPDATE public.pipeline_state
                      SET value = value || jsonb_build_object('cycle', jsonb_build_object(
                            'since_at', '2026-10-18T21:53:00Z', 'target_at', '2026-10-18T22:31:59Z',
                            'staged_at', now(), 'dirty_donors', 16969))
                    WHERE key = 'entity_connections_donations'`);
    type DS = { ds: Record<string, unknown> };
    const staged = (await c.query<DS>("SELECT public.get_ec_crawl_health()->'dirty_set' AS ds")).rows[0]!.ds;
    assert.equal(staged["source"], "crawl_cycle");
    assert.equal(staged["donors"], 16969);
    assert.equal(staged["rows"], null);
    assert.equal(staged["capped"], false);
    assert.equal(staged["since_at"], "2026-10-18T21:53:00Z");
    assert.equal(staged["target_at"], "2026-10-18T22:31:59Z");
    assert.notEqual(staged["staged_at"], null);

    await c.query("UPDATE public.pipeline_state SET value = value - 'cycle' WHERE key = 'entity_connections_donations'");
    const caught = (await c.query<DS>("SELECT public.get_ec_crawl_health()->'dirty_set' AS ds")).rows[0]!.ds;
    assert.deepEqual(caught, {
      rows: null, donors: 0, capped: false, source: "caught_up", since_at: null, target_at: null, staged_at: null,
    });

    await c.query("UPDATE public.pipeline_state SET value = value || '{\"cycle\": null}'::jsonb WHERE key = 'entity_connections_donations'");
    const jsonNull = (await c.query<DS>("SELECT public.get_ec_crawl_health()->'dirty_set' AS ds")).rows[0]!.ds;
    assert.equal(jsonNull["source"], "caught_up");
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await c.end();
  }
});
