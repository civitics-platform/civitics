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
 *
 * cc-211 M2 + M3 (`*_work_mem_m2.sql`, `*_work_mem_m3.sql`) and FIX-1293
 * (`*_ec_crawl_health_bounded_dirty_set.sql`) — the second half of the file:
 * the same anchors, rule-34 diffs, rule-105 twins and live checks for the ten
 * remaining allowance bodies and get_ec_crawl_health. The donor-party slice's
 * allowance is a PROCONFIG, so its edit is a header edit (HEADER_EDITS), and its
 * body must be byte-identical.
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

/** A routine's body, between its opening and closing dollar-quote (`$function$`, `$procedure$` or `$$`). */
function body(src: string, signature: string): string {
  const i = src.indexOf(signature);
  assert.notEqual(i, -1, `routine not found: ${signature}`);
  const m = src.slice(i).match(/AS (\$\w*\$)([\s\S]*?)\1/);
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

// ===========================================================================
// cc-211 — M2 (B4 treemap, B5 donor-party + its slice), M3 (B3 contract-flow,
// B7 the five monthly sweeps, B8 group-donor), and FIX-1293 (get_ec_crawl_health
// bounds its dirty-set count). Census: §7 of the M1 census; verdicts: cc-211 R5.
// ===========================================================================

const bySuffix = (suffix: string) => () => {
  const hits = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(suffix));
  assert.equal(hits.length, 1, `expected exactly one *${suffix}, found ${hits.join(", ") || "none"}`);
  return read(path.join(MIGRATIONS, hits[0] as string));
};
const m2 = bySuffix("_work_mem_m2.sql");
const m3 = bySuffix("_work_mem_m3.sql");
const fix1293 = bySuffix("_ec_crawl_health_bounded_dirty_set.sql");
const FILES = { m2, m3, fix1293 };

type Kind = "plain" | "parallelAlready" | "slice" | "crawlHealth";
type Body2 = Body & { file: keyof typeof FILES; kind: Kind };

const F950_ROLLUP = "20260911000100_fix950_guards_rollup_family.sql";
const F950_REBUILD = "20260911000200_fix950_guards_rebuild_family.sql";
const sweep = (name: string): Body2 => ({
  name, sig: `CREATE OR REPLACE PROCEDURE public.${name}(`, regproc: `public.${name}()`,
  prior: F950_REBUILD, commits: true, file: "m3", kind: "plain",
});

const BODIES2: Body2[] = [
  {
    name: "refresh_treemap_individuals_global", sig: "CREATE OR REPLACE PROCEDURE public.refresh_treemap_individuals_global(",
    regproc: "public.refresh_treemap_individuals_global()", prior: F950_ROLLUP, commits: true, file: "m2", kind: "plain",
  },
  {
    name: "refresh_donor_party_rollup_incremental", sig: "CREATE OR REPLACE PROCEDURE public.refresh_donor_party_rollup_incremental(",
    regproc: "public.refresh_donor_party_rollup_incremental()", prior: "20260927020000_fix918_primary_industry_tag.sql",
    commits: true, file: "m2", kind: "parallelAlready",
  },
  {
    name: "refresh_donor_party_rollup_slice", sig: "CREATE OR REPLACE FUNCTION public.refresh_donor_party_rollup_slice(",
    regproc: "public.refresh_donor_party_rollup_slice()", prior: "20260903010000_fix983_fr_watermark_horizon.sql",
    commits: false, file: "m2", kind: "slice",
  },
  {
    name: "refresh_contract_flow_rollups", sig: "CREATE OR REPLACE PROCEDURE public.refresh_contract_flow_rollups(",
    regproc: "public.refresh_contract_flow_rollups()", prior: "20261003030000_fix1194_p1a_box_backoff_gates.sql",
    commits: true, file: "m3", kind: "plain",
  },
  sweep("reconcile_donation_edge_orphans"),
  sweep("reconcile_donor_party_rollup_orphans"),
  sweep("reconcile_donor_rollup_orphans"),
  sweep("reconcile_entity_connection_stats_orphans"),
  sweep("reconcile_financial_entity_totals"),
  // B8 group-donor is NOT here: R5 STOPped it (see the STOP test below).
  {
    name: "get_ec_crawl_health", sig: "CREATE OR REPLACE FUNCTION public.get_ec_crawl_health(",
    regproc: "public.get_ec_crawl_health()", prior: "20260828000200_fix1114c_crawl_health_symmetric_join.sql",
    commits: false, file: "fix1293", kind: "crawlHealth",
  },
];

const byName2 = (n: string) => BODIES2.find((b) => b.name === n) as Body2;
const now2 = (b: Body2) => body(FILES[b.file](), b.sig);

/** B5: ONE line changes — the SET to 64MB; the FIX-1212 parallel-0 line a comment block below stays, once. */
function donorPartyProblems(def: string): string[] {
  const code = stripComments(def);
  const p: string[] = [];
  if (count(code, SET_256) > 0) p.push("still SETs work_mem 256MB");
  if (count(code, SET_64) !== 1) p.push(`${count(code, SET_64)} SETs of work_mem 64MB (want exactly 1)`);
  if (count(code, PAR_0) !== 1) p.push(`${count(code, PAR_0)} SETs of parallel 0 (want exactly the FIX-1212 one)`);
  if (!(code.indexOf(SET_64) >= 0 && code.indexOf(SET_64) < code.indexOf(PAR_0))) {
    p.push("the 64MB SET no longer precedes the FIX-1212 parallel-0 line");
  }
  if (/SET LOCAL (work_mem|max_parallel_workers_per_gather)/.test(code)) p.push("SET LOCAL would reset at the first COMMIT");
  return p;
}

const SLICE_64 = " SET work_mem TO '64MB'";
const SLICE_256 = " SET work_mem TO '256MB'";

/** B5 slice: the allowance is the proconfig — 64MB in the header, search_path kept, nothing in the body. */
function sliceHeaderProblems(h: string): string[] {
  const p: string[] = [];
  if (h.includes(SLICE_256)) p.push("the header still SETs work_mem TO 256MB");
  if (count(h, SLICE_64) !== 1) p.push(`${count(h, SLICE_64)} header SETs of work_mem TO 64MB (want exactly 1)`);
  if (!h.includes(" SET search_path TO 'public', 'pg_catalog'")) p.push("the header lost its search_path");
  if (/max_parallel_workers_per_gather/.test(h)) {
    p.push("the slice inherits the procedure's parallel 0 — the header names work_mem only");
  }
  return p;
}

const BOUNDED_COUNT =
  /EXECUTE 'SELECT count\(\*\), count\(DISTINCT from_id\)\s+FROM \(SELECT from_id\s+FROM public\.financial_relationships\s+WHERE relationship_type IN \(''donation'',''ie_support'',''ie_oppose''\)\s+AND updated_at > \$1\s+LIMIT 100001\) s'\s+INTO v_dirty_rows, v_dirty_dons\s+USING v_wm;/;
const UNBOUNDED_COUNT = /count\(DISTINCT from_id\)\s+INTO v_dirty_rows, v_dirty_dons\s+FROM public\.financial_relationships/;
/** The bounded count as STATIC SQL — the shape the cc-211 clone rejected (a cached generic plan seq-scans FR below the cap). */
const STATIC_BOUNDED = /^\s+SELECT count\(\*\), count\(DISTINCT from_id\)\s+INTO v_dirty_rows, v_dirty_dons\s+FROM \(SELECT/m;

/**
 * FIX-1293: the dirty-set count runs over a LIMIT-ed subquery, through EXECUTE … USING
 * (a one-shot plan with v_wm's value, every call), and reports the cap.
 */
function crawlHealthProblems(def: string): string[] {
  const code = stripComments(def);
  const p: string[] = [];
  if (!BOUNDED_COUNT.test(code)) p.push("the dirty-set count is not an EXECUTE … USING v_wm over a LIMIT 100001 subquery");
  if (STATIC_BOUNDED.test(code)) p.push("the bounded count is static SQL — its cached generic plan seq-scans FR below the cap");
  if (UNBOUNDED_COUNT.test(code)) p.push("the dirty-set count still reads financial_relationships unbounded");
  if (!code.includes("v_dirty_capped := v_dirty_rows > 100000;")) p.push("no capped flag at the 100,000 bound");
  if (!code.includes("v_dirty_capped boolean := false;")) p.push("v_dirty_capped not declared false");
  if (!code.includes("jsonb_build_object('rows', v_dirty_rows, 'donors', v_dirty_dons, 'capped', v_dirty_capped)")) {
    p.push("dirty_set does not carry 'capped'");
  }
  return p;
}

/** The measured-result line each B7 sweep with an existing SET comment gains under it. */
const R5_LINE = /^ {2}-- FIX-1295 M3 \(cc-211 R5\): .+$/;
const PLAIN_EDIT = { removed: [`  ${SET_256}`], added: [`  ${SET_64}`, PAR_LINE] as (RegExp | string)[] };
Object.assign(EDITS, {
  refresh_treemap_individuals_global: PLAIN_EDIT,
  refresh_donor_party_rollup_incremental: { removed: [`  ${SET_256}`], added: [`  ${SET_64}`] },
  refresh_donor_party_rollup_slice: { removed: [], added: [] },
  refresh_contract_flow_rollups: PLAIN_EDIT,
  reconcile_donation_edge_orphans: { removed: [`  ${SET_256}`], added: [R5_LINE, `  ${SET_64}`, PAR_LINE] },
  reconcile_donor_party_rollup_orphans: PLAIN_EDIT,
  reconcile_donor_rollup_orphans: PLAIN_EDIT,
  reconcile_entity_connection_stats_orphans: PLAIN_EDIT,
  reconcile_financial_entity_totals: { removed: [`  ${SET_256}`], added: [R5_LINE, `  ${SET_64}`, PAR_LINE] },
  get_ec_crawl_health: {
    removed: [
      "    SELECT count(*), count(DISTINCT from_id)",
      "      FROM public.financial_relationships",
      "     WHERE relationship_type IN ('donation','ie_support','ie_oppose')",
      "       AND updated_at > v_wm;",
      "    'dirty_set',      jsonb_build_object('rows', v_dirty_rows, 'donors', v_dirty_dons),",
    ],
    added: [
      "  v_dirty_capped boolean := false;",
      /^ {4}-- FIX-1293: bounded, and planned per call with v_wm's value\. .+$/,
      /^ {4}-- plan for "updated_at > \$1" under LIMIT is a Seq Scan, .+$/,
      /^ {4}-- reads all of financial_relationships \(cc-211 clone: .+\)\.$/,
      "    EXECUTE 'SELECT count(*), count(DISTINCT from_id)",
      "      FROM (SELECT from_id",
      "              FROM public.financial_relationships",
      "             WHERE relationship_type IN (''donation'',''ie_support'',''ie_oppose'')",
      "               AND updated_at > $1",
      "             LIMIT 100001) s'",
      "      USING v_wm;",
      "    v_dirty_capped := v_dirty_rows > 100000;   -- then rows/donors are LOWER BOUNDS",
      "    'dirty_set',      jsonb_build_object('rows', v_dirty_rows, 'donors', v_dirty_dons, 'capped', v_dirty_capped),",
    ],
  },
});

/** Rule 34 for HEADERS: the only header that may change is the slice's, and only its work_mem line. */
const HEADER_EDITS: Record<string, { removed: string[]; added: string[] }> = {
  refresh_donor_party_rollup_slice: { removed: [SLICE_256], added: [SLICE_64] },
};

function headerProblems(b: Body2, src: string): string[] {
  const h = header(src, b.sig);
  const priorH = header(read(path.join(MIGRATIONS, b.prior)), b.sig);
  const want = HEADER_EDITS[b.name] ?? { removed: [], added: [] };
  const d = lineDiff(priorH, h);
  const p: string[] = [];
  if (JSON.stringify(d.removed) !== JSON.stringify(want.removed)) {
    p.push(`header removed ${JSON.stringify(d.removed)} (want ${JSON.stringify(want.removed)})`);
  }
  if (JSON.stringify(d.added) !== JSON.stringify(want.added)) {
    p.push(`header added ${JSON.stringify(d.added)} (want ${JSON.stringify(want.added)})`);
  }
  if (b.commits && /\bSET\s+\w+/.test(h)) p.push("COMMITs, but the header carries a SET clause (ANY proconfig makes it atomic — FIX-1128)");
  return p;
}

test("M2 / M3 / FIX-1293: each file defines exactly its bodies, nothing else", () => {
  for (const [f, get] of Object.entries(FILES)) {
    const code = stripComments(get());
    const defined = [...code.matchAll(/CREATE OR REPLACE (?:FUNCTION|PROCEDURE) public\.(\w+)\(/g)].map((m) => m[1]).sort();
    const want = BODIES2.filter((b) => b.file === f).map((b) => b.name).sort();
    assert.deepEqual(defined, want, f);
  }
});

test("B4 / B3 / B7: plain SET 64MB + parallel 0 in treemap, contract-flow and the five sweeps", () => {
  for (const b of BODIES2.filter((x) => x.kind === "plain")) assert.deepEqual(plainSetProblems(now2(b)), [], b.name);
});

test("B5: donor-party's ONE line — SET 64MB; the FIX-1212 parallel-0 line kept, once", () => {
  assert.deepEqual(donorPartyProblems(now2(byName2("refresh_donor_party_rollup_incremental"))), []);
});

test("B5: the slice's proconfig reads work_mem 64MB; search_path kept; nothing else named", () => {
  assert.deepEqual(sliceHeaderProblems(header(m2(), byName2("refresh_donor_party_rollup_slice").sig)), []);
});

/**
 * B8 group-donor — R5 STOP. Its _gdr_agg HashAggregate (2.07M rows, B1 188 MB) became an
 * external-merge Sort + GroupAggregate at 64MB and at 128MB: 2.30 / 2.35 s -> 4.61 s (2.0x),
 * over the 1.5x bar, though the function whole read 42.7 -> 43.3 s. It keeps SET LOCAL 256MB.
 */
const GD = {
  sig: "CREATE OR REPLACE FUNCTION public.refresh_group_donor_rollup(",
  regproc: "public.refresh_group_donor_rollup()",
  file: "20261004070000_fix501_group_donor_topn_fix1204_null_committee_overrides.sql",
};

test("B8 R5 STOP: group-donor is in no cc-211 file and its source body keeps SET LOCAL work_mem 256MB", () => {
  for (const [f, get] of Object.entries(FILES)) assert.ok(!get().includes(GD.sig), `${f} redefines group-donor`);
  assert.equal(count(stripComments(body(read(path.join(MIGRATIONS, GD.file)), GD.sig)), LOCAL_256), 1);
});

test("FIX-1293: get_ec_crawl_health counts the dirty set over LIMIT 100001 and reports 'capped'", () => {
  assert.deepEqual(crawlHealthProblems(now2(byName2("get_ec_crawl_health"))), []);
});

test("rule 34 (M2/M3/FIX-1293): each body is its source file's body with exactly the intended lines changed", () => {
  for (const b of BODIES2) assert.deepEqual(editProblems(b.name, PRIOR_BODY(b), now2(b)), [], b.name);
});

test("FIX-1128 (M2/M3/FIX-1293): headers unchanged but the slice's work_mem line; no SET clause on a COMMITting procedure", () => {
  for (const b of BODIES2) assert.deepEqual(headerProblems(b, FILES[b.file]()), [], b.name);
});

test("grants (M2/M3/FIX-1293) restated: service_role EXECUTE, nothing for PUBLIC / anon / authenticated", () => {
  for (const b of BODIES2) {
    const src = FILES[b.file]();
    const kind = b.sig.includes("FUNCTION") ? "FUNCTION" : "PROCEDURE";
    assert.ok(src.includes(`REVOKE ALL ON ${kind} ${b.regproc} FROM PUBLIC, anon, authenticated;`), b.name);
    assert.ok(src.includes(`GRANT EXECUTE ON ${kind} ${b.regproc} TO service_role;`), b.name);
  }
});

test("rollback is stated per body as SET … '256MB', and no file RESETs a memory GUC", () => {
  for (const [f, get] of Object.entries(FILES)) {
    assert.doesNotMatch(stripComments(get()), /\bRESET\s+(work_mem|max_parallel_workers_per_gather)/i, f);
  }
  for (const b of BODIES2.filter((x) => x.file !== "fix1293")) {
    assert.match(FILES[b.file](), new RegExp(`-- +ROLLBACK[^\\n]*\\b${b.name}\\b`), `${b.name}: no rollback line in its file's header`);
  }
});

test("rule 105 twins (M2/M3/FIX-1293): the prior bodies fail every checker", () => {
  for (const b of BODIES2.filter((x) => x.kind === "plain")) {
    assert.ok(plainSetProblems(PRIOR_BODY(b)).includes("still SETs work_mem 256MB"), b.name);
  }
  assert.ok(donorPartyProblems(PRIOR_BODY(byName2("refresh_donor_party_rollup_incremental"))).includes("still SETs work_mem 256MB"));
  const slice = byName2("refresh_donor_party_rollup_slice");
  assert.ok(sliceHeaderProblems(header(read(path.join(MIGRATIONS, slice.prior)), slice.sig))
    .includes("the header still SETs work_mem TO 256MB"));
  const ch = crawlHealthProblems(PRIOR_BODY(byName2("get_ec_crawl_health")));
  assert.ok(ch.includes("the dirty-set count still reads financial_relationships unbounded"), ch.join("; "));
  assert.ok(ch.includes("dirty_set does not carry 'capped'"), ch.join("; "));
});

test("rule 105 twins (M2/M3/FIX-1293): a dropped parallel line, a header SET on a procedure and a tampered edit are each caught", () => {
  const cf = now2(byName2("refresh_contract_flow_rollups"));
  assert.ok(plainSetProblems(cf.replace(`\n  ${PAR_0}`, "")).some((x) => x.startsWith("no SET max_parallel")));
  // a second parallel-0 added to donor-party (the FIX-1212 one already zeroes it)
  const dp = now2(byName2("refresh_donor_party_rollup_incremental"));
  assert.ok(donorPartyProblems(dp.replace(`  ${SET_64}\n`, `  ${SET_64}\n  ${PAR_0}\n`))
    .some((x) => x.includes("want exactly the FIX-1212 one")));
  // a slice header that also names parallel
  const sliceH = header(m2(), byName2("refresh_donor_party_rollup_slice").sig);
  assert.ok(sliceHeaderProblems(sliceH.replace(SLICE_64, `${SLICE_64}\n SET max_parallel_workers_per_gather TO '0'`))
    .some((x) => x.includes("names work_mem only")));
  // a proconfig smuggled onto a COMMITting procedure
  const tm = byName2("refresh_treemap_individuals_global");
  const smuggled = m2().replace(`${tm.sig})\n LANGUAGE plpgsql\n`, `${tm.sig})\n LANGUAGE plpgsql\n SET work_mem TO '64MB'\n`);
  assert.ok(headerProblems(tm, smuggled).some((x) => x.startsWith("COMMITs, but the header")), headerProblems(tm, smuggled).join("; "));
  // an unrelated edit anywhere breaks rule 34; so does a cap at another number
  const sw = byName2("reconcile_donor_rollup_orphans");
  assert.ok(editProblems(sw.name, PRIOR_BODY(sw), now2(sw).replace("'ie_oppose'", "'ie_other'")).some((x) => x.startsWith("unexpected")));
  const ch = byName2("get_ec_crawl_health");
  assert.ok(crawlHealthProblems(now2(ch).replace("LIMIT 100001", "LIMIT 20001"))
    .some((x) => x.startsWith("the dirty-set count is not an EXECUTE")));
  // the bounded count as static SQL (the clone's generic-plan cliff) is caught
  const asStatic = now2(ch).replace(
    /EXECUTE 'SELECT count\(\*\), count\(DISTINCT from_id\)\n([\s\S]*?)''donation'',''ie_support'',''ie_oppose''([\s\S]*?)updated_at > \$1\n([\s\S]*?) s'\n {6}INTO v_dirty_rows, v_dirty_dons\n {6}USING v_wm;/,
    "SELECT count(*), count(DISTINCT from_id)\n      INTO v_dirty_rows, v_dirty_dons\n$1'donation','ie_support','ie_oppose'$2updated_at > v_wm\n$3 s;");
  assert.notEqual(asStatic, now2(ch), "the static-form fixture did not apply");
  assert.ok(crawlHealthProblems(asStatic).includes("the bounded count is static SQL — its cached generic plan seq-scans FR below the cap"),
    crawlHealthProblems(asStatic).join("; "));
});

const PROCONFIG2: Record<string, string[] | null> = {
  refresh_donor_party_rollup_slice: ["search_path=public, pg_catalog", "work_mem=64MB"],
  get_ec_crawl_health: ["search_path=public, cron, pg_temp"],
};

test("local (B8 R5 STOP): the live group-donor body still SET LOCALs work_mem 256MB", async (t) => {
  const c = await connect(t);
  if (!c) return;
  try {
    const s = (await c.query<{ s: string }>(`SELECT prosrc AS s FROM pg_proc WHERE oid = '${GD.regproc}'::regprocedure`)).rows[0]?.s ?? "";
    assert.equal(count(stripComments(s.replace(/\r\n/g, "\n")), LOCAL_256), 1);
  } finally {
    await c.end();
  }
});

test("local (M2/M3/FIX-1293): each live body is its file's; proconfig NULL x8, the slice at 64MB, search_path only on crawl health", async (t) => {
  const c = await connect(t);
  if (!c) return;
  try {
    for (const b of BODIES2) {
      type Row = { s: string; cfg: string[] | null };
      const res = await c.query<Row>(
        `SELECT prosrc AS s, proconfig AS cfg FROM pg_proc WHERE oid = '${b.regproc}'::regprocedure`);
      const row = res.rows[0] as Row;
      assert.equal(row.s.replace(/\r\n/g, "\n"), now2(b), `${b.name} live body is not the ${b.file} file's`);
      assert.deepEqual(row.cfg, PROCONFIG2[b.name] ?? null, `${b.name}: proconfig ${JSON.stringify(row.cfg)}`);
    }
  } finally {
    await c.end();
  }
});
