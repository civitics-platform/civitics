/**
 * FIX-1384 — contract-flow reads the contract rows ONCE into
 * public.contract_flow_stage and derives both rollups from it.
 * cc-280, `20261116000000_fix1384_contract_flow_one_pass_stage.sql`.
 *
 * Runs via:  tsx --test src/__tests__/contract-flow-stage.test.ts
 *
 * Text anchors (no DB, run in CI):
 *   - the stage (D2): its seven columns, the UNIQUE NULLS NOT DISTINCT key,
 *     RLS on with no policy, nothing for PUBLIC / anon / authenticated,
 *     service_role DML, a COMMENT naming its one writer;
 *   - the stage INSERT groups by the five key columns, and the body names
 *     financial_relationships once in its code;
 *   - the two NAICS CASE copies (recipients on r.naics_code, agency x sector on
 *     s.naics_code), arm for arm the same;
 *   - D6–D8 in text: the START gate, the lock, the stand-down, both SETs, the
 *     running row and its COMMIT, the cancel / failure close and the final
 *     COMMIT are character-identical to the M3 body; the stage, both rollups
 *     and the state flip sit in the ONE sub-block;
 *   - what the run records: staged / source_fingerprint / stage_checksum on the
 *     state, staged / source_fingerprint / stage_seconds on the complete row;
 *   - no SET clause (the body COMMITs), the grants as M3 states them; the
 *     revert is the M3 body verbatim and leaves the stage.
 * Clone tests (CIVITICS_CLONE_TESTS=1), inside BEGIN … ROLLBACK: the live body
 * is this file's; the stage is filled by the body's own INSERT and the two
 * stage-derived SELECTs equal treemap_recipients_by_contracts_full(500) and
 * chord_contract_flows_full() — EXCEPT ALL both ways, zero rows, equal sums.
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

function one(suffix: string): string {
  const hits = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(suffix));
  assert.equal(hits.length, 1, `expected exactly one *${suffix}, found ${hits.join(", ") || "none"}`);
  return read(path.join(MIGRATIONS, hits[0] as string));
}

const SIG = "CREATE OR REPLACE PROCEDURE public.refresh_contract_flow_rollups()";
const FILE = () => one("_fix1384_contract_flow_one_pass_stage.sql");
const M3 = () => one("_fix1295_work_mem_m3.sql");
const REVERT = () => read(path.join(ROOT, "scripts", "fix1384-revert-contract-flow-one-pass.sql"));
const NEW = () => body(FILE(), SIG);
const OLD = () => body(M3(), SIG);
/** md5(prosrc) of the one-pass body: what the push's read-back prints and prod runs from 20261116000000. */
const BODY_MD5 = "e19b470b888726356e1df21ccf7f1bb6";
const M3_MD5 = "c699dc7d6acf1cf35a3164b71ec0a3aa";

const md5 = (s: string) => crypto.createHash("md5").update(s, "utf8").digest("hex");
const count = (s: string, needle: string) => s.split(needle).length - 1;
/** The text from `from` up to (not including) `to`; both must be present, in order. */
function between(s: string, from: string, to: string): string {
  const a = s.indexOf(from);
  assert.notEqual(a, -1, `not found: ${from}`);
  const b = s.indexOf(to, a + from.length);
  assert.notEqual(b, -1, `not found after ${from}: ${to}`);
  return s.slice(a, b);
}
/** One statement of the body's code, from its first words to its `;`. */
const statement = (code: string, start: string) => between(code, start, ";");

// ---------------------------------------------------------------------------
// Text — no database.
// ---------------------------------------------------------------------------

test("D2: the stage — seven columns, the NULLS NOT DISTINCT key, RLS on, service_role DML only", () => {
  const sql = stripComments(FILE());
  const ddl = between(sql, "CREATE TABLE IF NOT EXISTS public.contract_flow_stage (", ");");
  for (const col of [
    /from_id\s+uuid\s+NOT NULL/, /from_type\s+text\s+NOT NULL/, /to_id\s+uuid\s+NOT NULL/, /to_type\s+text\s+NOT NULL/,
    /naics_code\s+text,/, /total_cents\s+numeric\s+NOT NULL/, /award_count\s+bigint\s+NOT NULL/,
  ]) assert.match(ddl, col);
  assert.match(ddl, /CONSTRAINT contract_flow_stage_key\s+UNIQUE NULLS NOT DISTINCT \(from_id, from_type, to_id, to_type, naics_code\)/);
  assert.ok(sql.includes("ALTER TABLE public.contract_flow_stage ENABLE ROW LEVEL SECURITY;"));
  assert.ok(sql.includes("REVOKE ALL ON public.contract_flow_stage FROM PUBLIC, anon, authenticated;"));
  assert.ok(sql.includes("GRANT SELECT, INSERT, UPDATE, DELETE ON public.contract_flow_stage TO service_role;"));
  assert.doesNotMatch(sql, /CREATE POLICY/i, "RLS with no policy");
  assert.match(FILE(), /COMMENT ON TABLE public\.contract_flow_stage IS[\s\S]*Written ONLY by refresh_contract_flow_rollups\(\)/);
});

test("the file creates the stage and the one procedure, drops and writes nothing", () => {
  const sql = stripComments(FILE());
  assert.deepEqual([...sql.matchAll(/CREATE OR REPLACE (?:FUNCTION|PROCEDURE) public\.(\w+)\(/g)].map((m) => m[1]), ["refresh_contract_flow_rollups"]);
  assert.deepEqual([...sql.matchAll(/CREATE TABLE IF NOT EXISTS public\.(\w+)/g)].map((m) => m[1]), ["contract_flow_stage"]);
  const outside = sql.replace(NEW().replace(/--[^\n]*/g, ""), "");
  assert.doesNotMatch(outside, /\b(DROP|TRUNCATE|DELETE FROM|INSERT INTO|UPDATE public\.)/i, "no row written by the push (D5)");
  assert.doesNotMatch(outside, /job_registry|cron\.|platform_dials/, "no registry / cron / dial row");
});

test("D1: one pass — the stage INSERT groups by the five key columns; financial_relationships once in the code", () => {
  const code = stripComments(NEW());
  assert.equal(count(code, "public.financial_relationships"), 1);
  assert.equal(count(code, "financial_relationships"), 1);
  const ins = statement(code, "INSERT INTO public.contract_flow_stage");
  assert.match(ins, /\(from_id, from_type, to_id, to_type, naics_code, total_cents, award_count\)/);
  assert.match(ins, /SUM\(fr\.amount_cents\), COUNT\(\*\)/);
  assert.match(ins, /WHERE fr\.relationship_type = 'contract'\s+AND fr\.amount_cents > 0\s+GROUP BY fr\.from_id, fr\.from_type, fr\.to_id, fr\.to_type, fr\.metadata->>'naics_code'$/);
  // Both rollups read the stage, not the contract rows.
  assert.equal(count(code, "FROM public.contract_flow_stage s"), 3, "recipient_codes, classified and the checksum");
  assert.ok(code.includes("SELECT s.to_id AS entity_id, s.naics_code, SUM(s.total_cents) AS code_cents, SUM(s.award_count) AS code_rows"));
  assert.match(code, /WHERE s\.to_type = 'financial_entity'\s+GROUP BY s\.to_id, s\.naics_code/);
  assert.match(code, /JOIN public\.agencies a\s+ON a\.id = s\.from_id AND s\.from_type = 'agency'/);
  assert.match(code, /LEFT JOIN public\.financial_entities fe\s+ON fe\.id = s\.to_id AND s\.to_type = 'financial_entity'/);
  assert.match(code, /SUM\(amount_cents\)::BIGINT,\s+SUM\(award_count\)::BIGINT\s+FROM classified/);
});

test("the two NAICS CASE copies: r.naics_code and s.naics_code, arm for arm the same", () => {
  const code = stripComments(NEW());
  const opens = [...code.matchAll(/CASE SUBSTRING\(([a-z_.>'-]+) FROM 1 FOR 2\)/g)].map((m) => m[1]);
  assert.deepEqual(opens, ["r.naics_code", "s.naics_code"]);
  const arms = (i: number) => {
    const at = [...code.matchAll(/CASE SUBSTRING\(/g)][i]!.index!;
    return code.slice(at, code.indexOf("END", at)).replace(/^CASE SUBSTRING\([^)]*\)/, "").replace(/\s+/g, " ");
  };
  assert.equal(arms(0), arms(1));
  assert.equal(count(arms(0), " WHEN '"), 24);
});

test("D6–D8: everything outside the rollup statements is character-identical to the M3 body", () => {
  const [o, n] = [OLD(), NEW()];
  assert.equal(md5(o), M3_MD5, "the M3 body this one is cut from");
  const same: [string, string][] = [
    // DECLARE through the last M3 variable.
    ["\nDECLARE\n", "  -- FIX-1384 — the one-pass stage"],
    // The START gate (D7), the lock, the FIX-950 stand-down, both SETs (D8), the running row and its COMMIT.
    ["BEGIN\n  -- FIX-1194 P1-A — the START gate", "  -- FIX-1384 (D6)"],
    // recipient_industry, recipients and the final SELECT.
    ["  recipients AS (\n", "  v_t_flows := clock_timestamp();"],
    // classified's CASE arms and the sector alias.
    ["          WHEN '11' THEN 'Agriculture & Food'", "      s.total_cents"],
    // The state flip's upsert, the cancel / failure close, up to the complete row's metadata.
    ["  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();", "         metadata = metadata || jsonb_build_object('recipients', v_recipients, 'agency_sectors', v_flows"],
    // The complete row's WHERE, the final COMMIT, the unlock and the NOTICE.
    ["   WHERE id = v_log_id;\n  COMMIT;\n  PERFORM pg_advisory_unlock(c_lock_key);\n\n  RAISE NOTICE", "END;\n"],
  ];
  for (const [from, to] of same) {
    const oldTo = o.indexOf(to, o.indexOf(from) + from.length) >= 0 ? to : null;
    const seg = between(n, from, to);
    if (oldTo) assert.equal(seg, between(o, from, to), `differs from M3: ${from.trim().slice(0, 50)}`);
    else assert.ok(o.includes(seg), `not in M3: ${from.trim().slice(0, 50)}`);
  }
  assert.ok(n.includes("v_gate := public.box_backoff_gate('contract-flow-rollups-refresh', 1800);"), "D7");
  assert.ok(n.includes("  SET work_mem = '64MB';\n  SET max_parallel_workers_per_gather = 0;\n"), "D8");
});

test("D6: the stage, both rollups and the state flip sit in the ONE sub-block, stage first", () => {
  const code = stripComments(NEW());
  assert.equal(count(code, "WHEN query_canceled THEN"), 1);
  const commit = code.indexOf("COMMIT;");
  const at = (s: string) => {
    const i = code.indexOf(s);
    assert.ok(i > commit, `${s} after the running row's COMMIT`);
    assert.ok(i < code.indexOf("WHEN query_canceled THEN"), `${s} inside the sub-block`);
    return i;
  };
  const order = [
    "v_stage := 'contract_flow_stage';",
    "v_source_fp := public.ec_arm_source_fingerprint('rebuild_entity_connections_contracts');",
    "DELETE FROM public.contract_flow_stage;",
    "INSERT INTO public.contract_flow_stage",
    "GET DIAGNOSTICS v_staged = ROW_COUNT;",
    "ANALYZE public.contract_flow_stage;",
    "INTO v_stage_sum",
    "v_stage := 'contract_recipient_rollup';",
    "DELETE FROM public.contract_recipient_rollup;",
    "v_stage := 'contract_agency_sector_rollup';",
    "DELETE FROM public.contract_agency_sector_rollup;",
    "v_stage := 'pipeline_state';",
  ].map(at);
  assert.deepEqual(order, [...order].sort((x, y) => x - y), "in this order");
  assert.equal(count(code, "COMMIT;"), 3, "the running row, the cancel / failure close, the complete close — none added");
});

test("D4: the checksum is order-independent and builds no long string", () => {
  const code = stripComments(NEW());
  const sum = statement(code, "SELECT md5(format(");
  assert.match(sum, /count\(\*\), sum\(s\.total_cents\), sum\(s\.award_count\)/);
  assert.match(sum, /sum\(hashtextextended\(\(s\.from_id, s\.from_type, s\.to_id, s\.to_type,\s+s\.naics_code, s\.total_cents, s\.award_count\)::text, 0\)::numeric\)/);
  assert.doesNotMatch(sum, /string_agg|array_agg|ORDER BY/i);
  assert.doesNotMatch(code, /IF[^;]*v_source_fp[^;]*THEN/, "no skip on the fingerprint (D4)");
});

test("what the run records: the state's three new keys, the complete row's staged / source_fingerprint / stage_seconds", () => {
  const code = stripComments(NEW());
  assert.match(
    code,
    /jsonb_build_object\('bootstrapped', true, 'rebuilt_at', now\(\)::text,\s+'recipients', v_recipients, 'agency_sectors', v_flows,\s+'staged', v_staged, 'source_fingerprint', v_source_fp,\s+'stage_checksum', v_stage_sum\)\)/,
  );
  assert.ok(code.includes("rows_inserted = v_recipients + v_flows,"));
  assert.match(code, /'staged', v_staged, 'source_fingerprint', v_source_fp,\s+'stage_seconds', jsonb_build_object\(/);
  for (const [k, a, b] of [["stage", "v_t_recip", "v_t_stage"], ["recipients", "v_t_flows", "v_t_recip"], ["agency_sectors", "v_t_done", "v_t_flows"]]) {
    assert.match(code, new RegExp(`'${k}',\\s+round\\(EXTRACT\\(epoch FROM \\(${a} - ${b}\\)\\)::numeric, 1\\)`), k);
  }
  for (const t of ["v_t_stage", "v_t_recip", "v_t_flows", "v_t_done"]) assert.ok(code.includes(`${t} := clock_timestamp();`), t);
});

test("FIX-1128: no SET clause on the COMMITting procedure; grants as M3 states them", () => {
  assert.doesNotMatch(header(FILE(), SIG), /\bSET\s+\w+/);
  const sql = stripComments(FILE());
  assert.ok(sql.includes("REVOKE ALL ON PROCEDURE public.refresh_contract_flow_rollups() FROM PUBLIC, anon, authenticated;"));
  assert.ok(sql.includes("GRANT EXECUTE ON PROCEDURE public.refresh_contract_flow_rollups() TO service_role;"));
  assert.equal(md5(NEW()), BODY_MD5, "the md5 the push's read-back prints");
});

test("the revert is the M3 body verbatim, with its grants, and leaves the stage", () => {
  const rev = REVERT();
  const m3 = M3().split("\n").slice(77, 365).join("\n");
  assert.ok(m3.startsWith(SIG) && m3.endsWith("TO service_role;"));
  assert.ok(rev.includes(m3), "M3 :78–:365, character for character");
  assert.equal(md5(body(rev, SIG)), M3_MD5);
  assert.doesNotMatch(stripComments(rev), /contract_flow_stage|DROP /, "the stage stays (the M3 body never reads it)");
});

test("the file sorts above prod's head at writing (20261115000000)", () => {
  const all = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const at = all.indexOf("20261116000000_fix1384_contract_flow_one_pass_stage.sql");
  assert.ok(at > 0);
  assert.ok(all[at - 1]! >= "20261115000000", all[at - 1]);
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

test("clone: the live body is this file's; proconfig NULL; the stage exists with RLS on", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    const live: { m: string; cfg: string[] | null; rls: boolean; key: string } = (await c.query(
      `SELECT md5(p.prosrc) AS m, p.proconfig AS cfg,
              (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.contract_flow_stage'::regclass) AS rls,
              (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'contract_flow_stage_key') AS key
         FROM pg_proc p WHERE p.oid = 'public.refresh_contract_flow_rollups()'::regprocedure`,
    )).rows[0];
    assert.equal(live.m, BODY_MD5);
    assert.equal(live.cfg, null);
    assert.equal(live.rls, true);
    assert.equal(live.key, "UNIQUE NULLS NOT DISTINCT (from_id, from_type, to_id, to_type, naics_code)");
  } finally {
    await c.end();
  }
});

test("clone: the stage-derived SELECTs equal treemap_recipients_by_contracts_full(500) and chord_contract_flows_full()", async (t) => {
  const c = await clone(t);
  if (!c) return;
  const code = stripComments(NEW());
  const recipients = statement(code, "WITH recipient_industry AS (");
  const sectors = statement(code.slice(code.indexOf("INSERT INTO public.contract_agency_sector_rollup")), "WITH recipient_industry AS (");
  try {
    await c.query("BEGIN");
    try {
      // The body's own settings (D8), and a bound for chord_contract_flows_full()'s nested loop.
      await c.query("SET LOCAL work_mem = '64MB'");
      await c.query("SET LOCAL max_parallel_workers_per_gather = 0");
      await c.query("SET LOCAL statement_timeout = '15min'");
      await c.query("DELETE FROM public.contract_flow_stage");
      await c.query(statement(code, "INSERT INTO public.contract_flow_stage"));
      await c.query("ANALYZE public.contract_flow_stage");
      // Named columns: the agency SELECT's two aggregates are both `sum`.
      await c.query(`CREATE TEMP TABLE cfs_r (entity_id, entity_name, industry, naics_code, total_cents, award_count) ON COMMIT DROP AS ${recipients}`);
      await c.query(`CREATE TEMP TABLE cfs_a (agency_id, agency_name, agency_acronym, sector, total_cents, award_count) ON COMMIT DROP AS ${sectors}`);
      await c.query("CREATE TEMP TABLE cfs_r_full ON COMMIT DROP AS SELECT * FROM public.treemap_recipients_by_contracts_full(500)");
      await c.query("CREATE TEMP TABLE cfs_a_full ON COMMIT DROP AS SELECT * FROM public.chord_contract_flows_full()");
      const diff = async (a: string, b: string) =>
        (await c.query(`SELECT count(*)::int AS n FROM (SELECT * FROM ${a} EXCEPT ALL SELECT * FROM ${b}) x`)).rows[0].n as number;
      const sums = async (tbl: string) =>
        (await c.query(`SELECT count(*)::int AS n, sum(total_cents)::text AS cents, sum(award_count)::text AS awards FROM ${tbl}`)).rows[0];
      assert.equal(await diff("cfs_r", "cfs_r_full"), 0, "recipients: stage − full");
      assert.equal(await diff("cfs_r_full", "cfs_r"), 0, "recipients: full − stage");
      assert.equal(await diff("cfs_a", "cfs_a_full"), 0, "agency x sector: stage − full");
      assert.equal(await diff("cfs_a_full", "cfs_a"), 0, "agency x sector: full − stage");
      const [r, rf, a, af] = [await sums("cfs_r"), await sums("cfs_r_full"), await sums("cfs_a"), await sums("cfs_a_full")];
      assert.deepEqual(r, rf);
      assert.deepEqual(a, af);
      assert.equal(r.n, 500);
      // Every contract row is in the stage once: the chord's award count is the stage's.
      const staged: { awards: string } = (await c.query("SELECT sum(award_count)::text AS awards FROM public.contract_flow_stage WHERE from_type = 'agency'")).rows[0];
      assert.equal(a.awards, staged.awards);
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});
