/**
 * cc-210 M1 — the `work_mem` step-down: the `postgres` role default and five
 * pg_cron bodies at 64MB, with parallel 0, plus FIX-1287's per-phase stamp
 * (`*_work_mem_m1.sql`; census: docs/audits/2026-10-09-work-mem-allowance-census.md).
 *
 * Runs via:  tsx --test src/__tests__/work-mem-allowances.test.ts
 *
 * Source anchors (no DB, run in CI), per body: the exact SET at its place, the
 * parallel-0 line beside it, no 256MB left. B0: the role ALTER, the DO block's
 * two read-back assertions, and no RESET (RESET lands on the 4MB boot value).
 * FIX-1287: three incremental `v_phase := v_phase ||` sites in each of
 * run_rule_taggers' two blocks, and no whole-object v_phase build left.
 *
 * Rule 34 — each body is its named source file's body with ONLY the intended
 * lines changed: an LCS line diff against that file must remove and add exactly
 * the lines listed in EDITS, nothing else.
 *
 * Rule 105 — every checker is also run against the body it replaces, and must
 * reject it.
 *
 * Against the local DB (skipped when unreachable): each live prosrc equals the
 * M1 file's body, proconfig is what it was (NULL on the three COMMITting
 * procedures), and the role row reads {statement_timeout=3h, work_mem=64MB}.
 * RED before `migration up --local`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
// Found by suffix so a version bump at landing time does not orphan the anchors.
const M1_SUFFIX = "_work_mem_m1.sql";
const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const read = (f: string) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");

function m1(): string {
  const hits = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(M1_SUFFIX));
  assert.equal(hits.length, 1, `expected exactly one *${M1_SUFFIX}, found ${hits.join(", ") || "none"}`);
  return read(path.join(MIGRATIONS, hits[0] as string));
}

/** A routine's body, between its opening and closing dollar-quote. */
function body(src: string, signature: string): string {
  const i = src.indexOf(signature);
  assert.notEqual(i, -1, `routine not found: ${signature}`);
  const m = src.slice(i).match(/AS \$(function|procedure)\$([\s\S]*?)\$\1\$/);
  assert.ok(m, `no dollar-quoted body after ${signature}`);
  return m[2] as string;
}

/** The header between the signature and `AS $…$` — where a SET clause would sit. */
function header(src: string, signature: string): string {
  const i = src.indexOf(signature);
  assert.notEqual(i, -1, `routine not found: ${signature}`);
  return src.slice(i, src.indexOf("AS $", i));
}

/** `--` comments removed, so an anchor never matches prose. */
const stripComments = (s: string) => s.replace(/--[^\n]*/g, "");
const count = (s: string, needle: string) => s.split(needle).length - 1;

const SET_64 = "SET work_mem = '64MB';";
const SET_256 = "SET work_mem = '256MB';";
const LOCAL_64 = "SET LOCAL work_mem = '64MB';";
const LOCAL_256 = "SET LOCAL work_mem = '256MB';";
const PAR_0 = "SET max_parallel_workers_per_gather = 0;";
const LOCAL_PAR_0 = "SET LOCAL max_parallel_workers_per_gather = 0;";

type Body = {
  name: string;
  sig: string;
  regproc: string;
  /** the file M1 copied the body from (rule 34's reference) */
  prior: string;
  /** `true` = COMMITs, so proconfig must stay NULL (FIX-1128) */
  commits: boolean;
};

const BODIES: Body[] = [
  {
    name: "run_entity_connections_rebuild",
    sig: "CREATE OR REPLACE PROCEDURE public.run_entity_connections_rebuild(",
    regproc: "public.run_entity_connections_rebuild(text, integer)",
    prior: "20261004100000_fix1269_1132_1270_search_index_stamp_stats_read_arm_park.sql",
    commits: true,
  },
  {
    name: "donor_rollup_rebuild_bulk",
    sig: "CREATE OR REPLACE PROCEDURE public.donor_rollup_rebuild_bulk(",
    regproc: "public.donor_rollup_rebuild_bulk()",
    prior: "20261004190000_fix1145_homepage_stats_mv_reads_rollups.sql",
    commits: true,
  },
  {
    name: "rebuild_entity_search_index",
    sig: "CREATE OR REPLACE FUNCTION public.rebuild_entity_search_index(",
    regproc: "public.rebuild_entity_search_index()",
    prior: "20261004100000_fix1269_1132_1270_search_index_stamp_stats_read_arm_park.sql",
    commits: false,
  },
  {
    name: "run_rule_taggers",
    sig: "CREATE OR REPLACE PROCEDURE public.run_rule_taggers(",
    regproc: "public.run_rule_taggers(text)",
    prior: "20261007010000_fix1284_weekly_merge_work_mem_box_gate.sql",
    commits: true,
  },
  {
    name: "rebuild_official_vote_stats",
    sig: "CREATE OR REPLACE PROCEDURE public.rebuild_official_vote_stats(",
    regproc: "public.rebuild_official_vote_stats()",
    prior: "20260911000200_fix950_guards_rebuild_family.sql",
    commits: false,
  },
];

const PRIOR_BODY = (b: Body) => body(read(path.join(MIGRATIONS, b.prior)), b.sig);
const byName = (n: string) => BODIES.find((b) => b.name === n) as Body;

// ---------------------------------------------------------------------------
// The checkers. Each returns [] for the M1 shape, else what is wrong.
// ---------------------------------------------------------------------------

/** B1 / B2 / B6 (vote stats): one plain SET 64MB, the parallel-0 line right after it, no 256MB. */
function plainSetProblems(def: string): string[] {
  const code = stripComments(def);
  const p: string[] = [];
  if (count(code, SET_256) > 0) p.push("still SETs work_mem 256MB");
  if (count(code, SET_64) !== 1) p.push(`${count(code, SET_64)} SETs of work_mem 64MB (want exactly 1)`);
  if (!new RegExp(`^ {2}${esc(SET_64)}\\n {2}${esc(PAR_0)}$`, "m").test(code)) {
    p.push("no SET max_parallel_workers_per_gather = 0 on the line after the 64MB SET");
  }
  if (/SET LOCAL (work_mem|max_parallel_workers_per_gather)/.test(code)) p.push("SET LOCAL would reset at the first COMMIT");
  return p;
}

/** B6 (search index): a FUNCTION run as unit 9 inside refresh_derived_mvs — SET LOCAL, as before. */
function searchIndexProblems(def: string): string[] {
  const code = stripComments(def);
  const p: string[] = [];
  if (count(code, LOCAL_256) > 0) p.push("still SET LOCAL work_mem 256MB");
  if (count(code, LOCAL_64) !== 1) p.push(`${count(code, LOCAL_64)} SET LOCAL work_mem 64MB (want exactly 1)`);
  if (!new RegExp(`^ {2}${esc(LOCAL_64)}\\n {2}${esc(LOCAL_PAR_0)}$`, "m").test(code)) {
    p.push("no SET LOCAL max_parallel_workers_per_gather = 0 on the line after the 64MB SET LOCAL");
  }
  if (count(code, "_conn (entity_id, c)") < 1 || code.indexOf(LOCAL_64) > code.indexOf("CREATE TEMP TABLE _conn")) {
    p.push("the SET LOCAL no longer precedes the _conn stage");
  }
  return p;
}

const WEEKLY_IF = "IF p_cadence = 'weekly' THEN";
const RUNNING_ROW = "VALUES ('run_rule_taggers', 'running'";
const SCAN_CALL = "public.rebuild_financial_entity_size_tags_scan()";

/** B6 (run_rule_taggers): 64MB + parallel 0 before the running row, for both cadences; the weekly's own 64MB kept, once. */
function ruleTaggersProblems(def: string): string[] {
  const code = stripComments(def);
  const p: string[] = [];
  if (count(code, SET_256) > 0) p.push("the daily still reads 256MB");
  const running = code.indexOf(RUNNING_ROW);
  const first64 = code.indexOf(SET_64);
  if (!(first64 >= 0 && first64 < running)) p.push("no SET work_mem = '64MB' before the running row (both cadences)");
  if (!new RegExp(`^ {2}${esc(SET_64)}\\n {2}${esc(PAR_0)}$`, "m").test(code)) {
    p.push("no SET max_parallel_workers_per_gather = 0 on the line after the daily 64MB SET");
  }
  const scan = code.indexOf(SCAN_CALL);
  const branch = code.lastIndexOf(WEEKLY_IF, scan);
  const weekly64 = code.indexOf(SET_64, branch);
  if (!(branch > running && weekly64 > branch && weekly64 < scan)) p.push("the weekly branch's own SET 64MB is gone");
  if (count(code, SET_64) !== 2) p.push(`${count(code, SET_64)} SETs of work_mem 64MB (want 2: both cadences, then the weekly's explicit one)`);
  return p;
}

const PHASE_SITE = /v_phase\s+:= v_phase \|\| jsonb_build_object\('(scan|delete|insert)',/g;

/** FIX-1287: each block stamps scan / delete / insert as each finishes, in that order. */
function phaseProblems(def: string): string[] {
  const code = stripComments(def);
  const p: string[] = [];
  if (/v_phase\s+:= jsonb_build_object\(/.test(code)) p.push("v_phase is still built whole after the INSERT");
  // The weekly block ends where the pre-vote block's scan call begins.
  const split = code.indexOf("public.rebuild_pre_vote_timing_tags_scan()");
  if (split < 0) return ["no pre-vote block"];
  const blocks = { weekly: code.slice(0, split), prevote: code.slice(split) };
  const calls = {
    weekly: ["size_tags_scan()", "size_tags_delete()", "size_tags_insert()"],
    prevote: ["timing_tags_scan()", "timing_tags_delete()", "timing_tags_insert()"],
  };
  for (const [k, src] of Object.entries(blocks) as [keyof typeof blocks, string][]) {
    const sites = [...src.matchAll(PHASE_SITE)].map((m) => ({ key: m[1], at: m.index ?? -1 }));
    if (sites.map((s) => s.key).join(",") !== "scan,delete,insert") {
      p.push(`${k}: phase sites ${sites.map((s) => s.key).join(",") || "none"} (want scan,delete,insert)`);
      continue;
    }
    const [c0, c1, c2] = calls[k].map((c) => src.indexOf(c));
    const [s0, s1, s2] = sites.map((s) => s.at);
    if (!(c0 < s0 && s0 < c1)) p.push(`${k}: 'scan' is not stamped between the scan and the delete`);
    if (!(c1 < s1 && s1 < c2)) p.push(`${k}: 'delete' is not stamped between the delete and the insert`);
    if (!(c2 < (s2 as number))) p.push(`${k}: 'insert' is not stamped after the insert returns`);
  }
  return p;
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

/** Rule 34: the complete list of lines each body may lose and gain against its source file. */
const PAR_LINE = `  ${PAR_0}`;
const PHASE_LINE = (indent: string, k: string, a: string, b: string) =>
  `${indent}v_phase   := v_phase || jsonb_build_object('${k}', round(EXTRACT(epoch FROM (${a} - ${b}))::numeric, 1));  -- FIX-1287`;
const OLD_PHASE = (indent: string) => [
  `${indent}v_phase   := jsonb_build_object(`,
  `${indent}               'scan',   round(EXTRACT(epoch FROM (v_t1 - v_t0))::numeric, 1),`,
  `${indent}               'delete', round(EXTRACT(epoch FROM (v_t2 - v_t1))::numeric, 1),`,
  `${indent}               'insert', round(EXTRACT(epoch FROM (clock_timestamp() - v_t2))::numeric, 1));`,
];
const EDITS: Record<string, { removed: string[]; added: (RegExp | string)[] }> = {
  run_entity_connections_rebuild: { removed: [`  ${SET_256}`], added: [`  ${SET_64}`, PAR_LINE] },
  donor_rollup_rebuild_bulk: { removed: [`  ${SET_256}`], added: [`  ${SET_64}`, PAR_LINE] },
  rebuild_official_vote_stats: { removed: [`  ${SET_256}`], added: [`  ${SET_64}`, PAR_LINE] },
  rebuild_entity_search_index: { removed: [`  ${LOCAL_256}`], added: [`  ${LOCAL_64}`, `  ${LOCAL_PAR_0}`] },
  run_rule_taggers: {
    removed: [`  ${SET_256}`, ...OLD_PHASE("        "), ...OLD_PHASE("      ")],
    added: [
      `  ${SET_64}`,
      PAR_LINE,
      /^ {8}-- FIX-\d+ M1 \(cc-210 B6\): the SET above is 64MB now too; kept so the weekly's allowance stays explicit\.$/,
      PHASE_LINE("        ", "scan", "v_t1", "v_t0"),
      PHASE_LINE("        ", "delete", "v_t2", "v_t1"),
      PHASE_LINE("        ", "insert", "clock_timestamp()", "v_t2"),
      PHASE_LINE("      ", "scan", "v_t1", "v_t0"),
      PHASE_LINE("      ", "delete", "v_t2", "v_t1"),
      PHASE_LINE("      ", "insert", "clock_timestamp()", "v_t2"),
    ],
  },
};

/**
 * The weekly block's `v_rows := v_inserted + v_updated;` moves below the insert
 * stamp, so the LCS reads it as removed + re-added at the same text. Drop such
 * pairs before comparing — a moved line is not a changed one.
 */
function netOfMoves(d: { removed: string[]; added: string[] }) {
  const removed = [...d.removed];
  const added: string[] = [];
  for (const a of d.added) {
    const k = removed.indexOf(a);
    if (k >= 0) removed.splice(k, 1);
    else added.push(a);
  }
  return { removed, added };
}

function editProblems(name: string, prior: string, now: string): string[] {
  const want = EDITS[name] as { removed: string[]; added: (RegExp | string)[] };
  const d = netOfMoves(lineDiff(prior, now));
  const p: string[] = [];
  const rem = [...d.removed];
  for (const r of want.removed) {
    const k = rem.indexOf(r);
    if (k < 0) p.push(`expected removal missing: ${r.trim()}`);
    else rem.splice(k, 1);
  }
  for (const r of rem) p.push(`unexpected removal: ${r.trim()}`);
  const add = [...d.added];
  for (const w of want.added) {
    const k = add.findIndex((a) => (typeof w === "string" ? a === w : w.test(a)));
    if (k < 0) p.push(`expected addition missing: ${String(w).trim()}`);
    else add.splice(k, 1);
  }
  for (const a of add) p.push(`unexpected addition: ${a.trim()}`);
  return p;
}

// ---------------------------------------------------------------------------
// Source anchors — no database.
// ---------------------------------------------------------------------------

test("B0: the postgres role default is 64MB by ALTER ROLE … SET, read back with both assertions, never RESET", () => {
  const src = m1();
  const code = stripComments(src);
  assert.match(code, /^ALTER ROLE postgres IN DATABASE postgres SET work_mem = '64MB';$/m);
  assert.doesNotMatch(code, /ALTER ROLE postgres[^;]*RESET/i, "RESET lands on the 4MB boot value and flips every ad-hoc plan");
  assert.match(code, /IF NOT \('statement_timeout=3h' = ANY\(cfg\)\) THEN\s+RAISE EXCEPTION/);
  assert.match(code, /IF NOT \('work_mem=64MB' = ANY\(cfg\)\) THEN\s+RAISE EXCEPTION/);
  assert.ok(code.indexOf("ALTER ROLE postgres IN DATABASE postgres SET work_mem") < code.indexOf("'work_mem=64MB' = ANY(cfg)"),
    "the read-back follows the ALTER");
});

test("B1 / B2 / B6: plain SET 64MB + parallel 0 in ec-crawl, donor-rollup and vote-stats", () => {
  for (const n of ["run_entity_connections_rebuild", "donor_rollup_rebuild_bulk", "rebuild_official_vote_stats"]) {
    assert.deepEqual(plainSetProblems(body(m1(), byName(n).sig)), [], n);
  }
});

test("B6: rebuild_entity_search_index SET LOCAL 64MB + SET LOCAL parallel 0, before the _conn stage", () => {
  assert.deepEqual(searchIndexProblems(body(m1(), byName("rebuild_entity_search_index").sig)), []);
});

test("B6: run_rule_taggers 64MB + parallel 0 for both cadences; the weekly's own 64MB kept, once", () => {
  assert.deepEqual(ruleTaggersProblems(body(m1(), byName("run_rule_taggers").sig)), []);
});

test("FIX-1287: v_phase is built incrementally — scan, delete, insert, each after its phase — in both blocks", () => {
  assert.deepEqual(phaseProblems(body(m1(), byName("run_rule_taggers").sig)), []);
});

test("rule 34: each body is its source file's body with exactly the intended lines changed", () => {
  for (const b of BODIES) {
    assert.deepEqual(editProblems(b.name, PRIOR_BODY(b), body(m1(), b.sig)), [], b.name);
  }
});

test("FIX-1128: no header SET clause on the three COMMITting procedures; the two that carried search_path keep it", () => {
  const src = m1();
  for (const b of BODIES) {
    const h = header(src, b.sig);
    const priorH = header(read(path.join(MIGRATIONS, b.prior)), b.sig);
    assert.equal(h, priorH, `${b.name}: header changed`);
    if (b.commits) assert.doesNotMatch(h, /\bSET\s+\w+/, `${b.name} COMMITs; ANY proconfig makes it atomic`);
  }
});

test("grants restated to the live ACL: service_role EXECUTE, nothing for PUBLIC / anon / authenticated", () => {
  const src = m1();
  for (const b of BODIES) {
    const kind = b.sig.includes("FUNCTION") ? "FUNCTION" : "PROCEDURE";
    assert.ok(src.includes(`REVOKE ALL ON ${kind} ${b.regproc} FROM PUBLIC, anon, authenticated;`), b.name);
    assert.ok(src.includes(`GRANT EXECUTE ON ${kind} ${b.regproc} TO service_role;`), b.name);
  }
});

// Rule 105 — each checker rejects the body it replaces.
test("rule 105 twins: the prior bodies fail every checker", () => {
  for (const n of ["run_entity_connections_rebuild", "donor_rollup_rebuild_bulk", "rebuild_official_vote_stats"]) {
    assert.ok(plainSetProblems(PRIOR_BODY(byName(n))).includes("still SETs work_mem 256MB"), n);
  }
  assert.ok(searchIndexProblems(PRIOR_BODY(byName("rebuild_entity_search_index"))).includes("still SET LOCAL work_mem 256MB"));
  const rt = PRIOR_BODY(byName("run_rule_taggers"));
  assert.ok(ruleTaggersProblems(rt).includes("the daily still reads 256MB"));
  const ph = phaseProblems(rt);
  assert.ok(ph.includes("v_phase is still built whole after the INSERT"), ph.join("; "));
  assert.ok(ph.some((x) => x.startsWith("weekly: phase sites none")), ph.join("; "));
  assert.ok(ph.some((x) => x.startsWith("prevote: phase sites none")), ph.join("; "));
});

test("rule 105 twins: a dropped parallel line, a moved stamp and an extra edit are each caught", () => {
  const ec = body(m1(), byName("run_entity_connections_rebuild").sig);
  assert.ok(plainSetProblems(ec.replace(`\n  ${PAR_0}`, "")).some((x) => x.startsWith("no SET max_parallel")));
  const rt = body(m1(), byName("run_rule_taggers").sig);
  // the 'scan' stamp moved after the delete call — the cancelled-in-delete row would claim no scan
  const scanLine = PHASE_LINE("        ", "scan", "v_t1", "v_t0");
  const moved = rt.replace(`\n${scanLine}`, "").replace(
    "        v_t2      := clock_timestamp();\n        v_phase",
    `        v_t2      := clock_timestamp();\n${scanLine}\n        v_phase`);
  assert.ok(phaseProblems(moved).some((x) => x.includes("'scan' is not stamped between")), phaseProblems(moved).join("; "));
  // the weekly's explicit SET dropped
  const noWeekly = rt.replace(/\n {8}SET work_mem = '64MB';/, "");
  assert.ok(ruleTaggersProblems(noWeekly).includes("the weekly branch's own SET 64MB is gone"));
  // an unrelated edit anywhere in a body breaks rule 34
  const tampered = ec.replace("c_budget := COALESCE(c_budget, c_budget_default);", "c_budget := c_budget_default;");
  assert.ok(editProblems("run_entity_connections_rebuild", PRIOR_BODY(byName("run_entity_connections_rebuild")), tampered)
    .some((x) => x.startsWith("unexpected")));
});

// ---------------------------------------------------------------------------
// The local DB — skipped when unreachable. RED before `migration up --local`.
// ---------------------------------------------------------------------------

async function connect(t: { skip: (m: string) => void }): Promise<Client | null> {
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  try {
    await c.connect();
    return c;
  } catch {
    t.skip("local Docker DB unreachable");
    return null;
  }
}

test("local: each live body is the M1 file's; proconfig NULL on the COMMITting three, search_path only on the other two", async (t) => {
  const c = await connect(t);
  if (!c) return;
  try {
    const src = m1();
    for (const b of BODIES) {
      type Row = { s: string; cfg: string[] | null };
      const res = await c.query<Row>(
        `SELECT prosrc AS s, proconfig AS cfg FROM pg_proc WHERE oid = '${b.regproc}'::regprocedure`);
      const row = res.rows[0] as Row;
      assert.equal(row.s.replace(/\r\n/g, "\n"), body(src, b.sig), `${b.name} live body is not the M1 file's`);
      if (b.commits) assert.equal(row.cfg, null, `${b.name} COMMITs; proconfig must stay NULL`);
      else assert.ok((row.cfg ?? []).every((x: string) => x.startsWith("search_path=")), `${b.name}: ${JSON.stringify(row.cfg)}`);
    }
  } finally {
    await c.end();
  }
});

test("local: the postgres@postgres role row reads statement_timeout=3h and work_mem=64MB", async (t) => {
  const c = await connect(t);
  if (!c) return;
  try {
    const cfg = (await c.query<{ cfg: string[] }>(
      `SELECT s.setconfig AS cfg FROM pg_db_role_setting s
         JOIN pg_roles r ON r.oid = s.setrole JOIN pg_database d ON d.oid = s.setdatabase
        WHERE r.rolname = 'postgres' AND d.datname = 'postgres'`)).rows[0]?.cfg ?? [];
    assert.ok(cfg.includes("statement_timeout=3h"), JSON.stringify(cfg));
    assert.ok(cfg.includes("work_mem=64MB"), JSON.stringify(cfg));
  } finally {
    await c.end();
  }
});
