/**
 * FIX-1307 — the job_registry seed's invariants (`*_job_registry.sql`).
 *
 * Runs via:  tsx --test src/__tests__/job-registry-seed.test.ts
 *
 * Source anchors only (no DB, run in CI). The seed is parsed from its
 * `-- job-registry-seed:begin … end` fence by a local row-per-line parser (the
 * same contract scripts/check-job-registry.mjs enforces) and checked against:
 *   - the CHECK vocabularies of the table it seeds;
 *   - D5/D12: every deadline_rule is `at …`, so the seed changes no behaviour;
 *   - rule 120/275: a bare VACUUM row carries no budget and maintenance_work_mem's
 *     64 as its cap;
 *   - the six resumable rows each name their cursor key;
 *   - D3: a CALL row's cap_mb is 2 × the work_mem its body's NEWEST migration
 *     sets (or its one callee's, or the role's 64MB);
 *   - the banked prod read docs/audits/2026-10-12-cc223-cron-job-read.json:
 *     unit_call = the live command, budget_seconds = the live budget row,
 *     pipeline = the derivation's, gates carry prod_session iff guarded, and a
 *     row for every job in the read and vice versa (minus the 7 GHA rows).
 *
 * Rule 105: JOB_REGISTRY_SEED=<path> points the suite at a mutated copy. cc-223
 * ran it against one with a row deleted and one deadline_rule 'by …', and both
 * failed by name.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { body, header, read, stripComments } from "./lib/migration-text";

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const BANKED = path.join(ROOT, "docs", "audits", "2026-10-12-cc223-cron-job-read.json");

function seedFile(): string {
  const override = process.env["JOB_REGISTRY_SEED"];
  if (override) return override;
  const hits = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith("_job_registry.sql"));
  assert.equal(hits.length, 1, `expected exactly one *_job_registry.sql, found ${hits.join(", ") || "none"}`);
  return path.join(MIGRATIONS, hits[0] as string);
}

type Value = string | number | boolean | null;
type Row = Record<string, Value>;

/** The fence's rows, keyed by the INSERT column list. One tuple per line, job literal first. */
function parseSeed(text: string): Row[] {
  const lines = text.split("\n");
  const begin = lines.findIndex((l) => l.trim() === "-- job-registry-seed:begin");
  const end = lines.findIndex((l) => l.trim() === "-- job-registry-seed:end");
  assert.ok(begin !== -1 && end > begin, "no job-registry-seed fence");
  let cols: string[] = [];
  const rows: Row[] = [];
  for (const raw of lines.slice(begin + 1, end)) {
    const t = raw.trim();
    const ins = /^INSERT INTO public\.job_registry \(([^)]*)\) VALUES$/.exec(t);
    if (ins) { cols = (ins[1] as string).split(",").map((c) => c.trim()); continue; }
    if (!t.startsWith("(")) continue; // comments, ON CONFLICT
    const vals: Value[] = [];
    // A quoted string ('' escapes), or a bare token up to the next comma.
    for (const m of t.replace(/\),?$/, "").slice(1).matchAll(/\s*(?:'((?:[^']|'')*)'|([^,]+))\s*(?:,|$)/g)) {
      if (m[1] !== undefined) vals.push(m[1].replace(/''/g, "'"));
      else { const b = (m[2] as string).trim(); vals.push(b === "NULL" ? null : b === "true" ? true : b === "false" ? false : Number(b)); }
    }
    assert.equal(vals.length, cols.length, `row does not have ${cols.length} values: ${t}`);
    rows.push(Object.fromEntries(cols.map((c, i) => [c, vals[i] as Value])));
  }
  return rows;
}

type BankedJob = { jobname: string; command: string; pipeline: string | null; guarded: boolean; budget_seconds: number | null };
const banked = (JSON.parse(read(BANKED)) as { cron_job: { rows: BankedJob[] } }).cron_job.rows;
const rows = parseSeed(read(seedFile()));
const byJob = new Map(rows.map((r) => [r["job"] as string, r]));
const pgCron = rows.filter((r) => r["runner"] === "pg_cron");

/** Seeded ahead of its prod landing (cc-219's 41 1 * * 2 job); not in the 10-12 read. */
const SEEDED_AHEAD = new Set(["xsr-vacuum-analyze"]);
/** D4: a persisted cursor and a bounded unit, read from each body (audit §1). */
const RESUMABLE: Record<string, string> = {
  "donor-rollup-refresh": "donor_rollup_bulk_sweep",
  "ec-crawl": "entity_connections_rebuild_cursor",
  "fe-crawl": "fe_crawl",
  "donor-party-rollup-refresh": "donor_party_full_rebuild",
  "fe-inbound-rollup-refresh": "financial_entity_inbound_rollup_watermark",
  "treemap-individuals-global-refresh": "treemap_global_refresh",
};
/** The one-callee hop for bodies that SET nothing themselves (read 2). */
const CALLEE: Record<string, string> = {
  run_fe_totals_crawl: "refresh_fe_totals_slice",
  run_fe_inbound_rollup: "refresh_fe_inbound_rollup_unit",
  run_group_donor_rollup_refresh: "refresh_group_donor_rollup",
  rebuild_entity_connection_stats: "rebuild_entity_connection_stats_window",
};

test("PK: every job appears once", () => {
  assert.equal(byJob.size, rows.length, "duplicate job literal in the seed");
  assert.ok(rows.length >= 53, `expected at least 53 rows, got ${rows.length}`);
});

test("every value is in its CHECK vocabulary", () => {
  for (const r of rows) {
    const j = r["job"];
    assert.ok(["pg_cron", "github_actions", "vercel", "manual"].includes(r["runner"] as string), `${j}: runner ${r["runner"]}`);
    assert.ok(["resumable", "atomic", "bare"].includes(r["unit_shape"] as string), `${j}: unit_shape ${r["unit_shape"]}`);
    assert.ok(["io", "memory", "cpu", "mixed"].includes(r["cost_class"] as string), `${j}: cost_class ${r["cost_class"]}`);
    const p = r["priority"] as number;
    assert.ok(Number.isInteger(p) && p >= 1 && p <= 5, `${j}: priority ${p}`);
    const gates = /^\{(.*)\}$/.exec(r["gates"] as string);
    assert.ok(gates, `${j}: gates is not an array literal: ${r["gates"]}`);
    for (const g of (gates[1] as string).split(",").filter(Boolean)) {
      assert.ok(["box", "peer", "prod_session", "blackout"].includes(g), `${j}: gate ${g}`);
    }
    assert.ok(typeof r["note"] === "string" && (r["note"] as string).length > 0, `${j}: note is NOT NULL`);
  }
});

test("D5/D12: every deadline_rule is 'at …' — the seed changes no behaviour", () => {
  for (const r of rows) assert.ok(String(r["deadline_rule"]).startsWith("at "), `${r["job"]}: deadline_rule '${r["deadline_rule"]}' is not 'at …'`);
});

test("a bare VACUUM row has no budget and cap_mb 64 (maintenance_work_mem)", () => {
  const vacuums = rows.filter((r) => /^VACUUM /.test(String(r["unit_call"])));
  assert.equal(vacuums.length, 14, "13 prod vacuums + xsr-vacuum-analyze");
  for (const r of vacuums) {
    assert.equal(r["unit_shape"], "bare", `${r["job"]}`);
    assert.equal(r["budget_seconds"], null, `${r["job"]}: a bare VACUUM job carries no cron_job_budget row (rule 120)`);
    assert.equal(r["cap_mb"], 64, `${r["job"]}: cap_mb`);
  }
});

test("the six resumable rows each name their cursor key", () => {
  const resumable = rows.filter((r) => r["unit_shape"] === "resumable").map((r) => r["job"] as string).sort();
  assert.deepEqual(resumable, Object.keys(RESUMABLE).sort());
  for (const [job, key] of Object.entries(RESUMABLE)) {
    assert.ok(String(byJob.get(job)?.["note"]).includes(key), `${job}: note does not name cursor ${key}`);
  }
});

test("parity with the banked prod read: a row per job, and the live command, budget, pipeline and guard", () => {
  for (const b of banked) {
    const r = byJob.get(b.jobname);
    assert.ok(r, `missing registry row for prod cron job ${b.jobname}`);
    assert.equal(r["runner"], "pg_cron", b.jobname);
    assert.equal(r["unit_call"], b.command, `${b.jobname}: unit_call is not the live command`);
    assert.equal(r["budget_seconds"], b.budget_seconds, `${b.jobname}: budget_seconds is not the live cron_job_budget row`);
    assert.equal(r["pipeline"], b.pipeline, `${b.jobname}: pipeline is not the derivation's`);
    assert.equal(String(r["gates"]).includes("prod_session"), b.guarded, `${b.jobname}: prod_session gate vs guarded=${b.guarded}`);
  }
  const live = new Set(banked.map((b) => b.jobname));
  for (const r of pgCron) {
    const j = r["job"] as string;
    assert.ok(live.has(j) || SEEDED_AHEAD.has(j), `registry row ${j} is in no prod read`);
  }
  assert.equal(rows.length - pgCron.length, 7, "one row per scheduled GHA workflow");
});

/** The newest migration's text for one routine (header + body), comments stripped. */
function routineText(name: string): string {
  const re = new RegExp(String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+public\.${name}\s*\(`, "gi");
  let src = "";
  for (const f of fs.readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    const t = read(path.join(MIGRATIONS, f));
    const all = [...t.matchAll(re)];
    if (all.length) src = t.slice((all[all.length - 1] as RegExpMatchArray).index);
  }
  assert.ok(src, `no migration defines public.${name}`);
  const sig = (src.match(re) as RegExpMatchArray)[0];
  return header(src, sig) + stripComments(body(src, sig));
}
const setMb = (s: string) => Math.max(0, ...[...s.matchAll(/work_mem\s*(?:=|TO)\s*'(\d+)MB'/gi)].map((m) => Number(m[1])));

test("D3: a CALL row's cap_mb is 2 × the work_mem its body's newest migration sets", () => {
  const m1 = fs.readdirSync(MIGRATIONS).find((f) => f.endsWith("_work_mem_m1.sql")) as string;
  assert.match(read(path.join(MIGRATIONS, m1)), /ALTER ROLE postgres IN DATABASE postgres SET work_mem = '64MB';/);
  const ROLE_MB = 64;
  for (const r of pgCron) {
    const m = /^CALL public\.([a-z_0-9]+)\(/.exec(String(r["unit_call"]));
    if (!m) continue;
    const proc = m[1] as string;
    let mb = setMb(routineText(proc));
    if (!mb && CALLEE[proc]) mb = setMb(routineText(CALLEE[proc] as string));
    if (!mb) mb = ROLE_MB;
    if (r["job"] === "group-donor-rollup-refresh" && mb === 256) {
      // Seeded at cc-219's landed 64MB (20261013010000); main still reads the
      // 20261004070000 body's SET LOCAL 256MB until that push lands.
      assert.equal(r["cap_mb"], 128, "group-donor-rollup-refresh is seeded at cc-219's value");
      continue;
    }
    assert.equal(r["cap_mb"], 2 * mb, `${r["job"]}: cap_mb ${r["cap_mb"]} ≠ 2 × ${mb}MB (${proc})`);
  }
});
