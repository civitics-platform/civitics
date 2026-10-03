#!/usr/bin/env node
// fix1211-rebuild-partial-edges.mjs — ONE authorized prod data set (FIX-1211, cc-182).
//
// An entity_connections money edge that lost SOME of its financial_relationships
// evidence keeps the deleted rows' dollars: every EC writer keys its dirty set on
// fr.updated_at, and a deleted row has none. cc-182's census (read 5, prod
// 2026-10-03 04:07 UTC, all 9,179,144 money edges) found exactly one: edge
// db99c5ef (TURN LEFT PAC -> official d798e047) at 215399 / 2 / 0.417, which
// still counts a 65400 fec_bulk_pac donation the FIX-1106 pac apply deleted.
// The correct edge is its surviving ie_support row: 149999 / 1 / 0.397.
//
// This runs rebuild_ec_donation_edges_for_donors() (20261003020000) for the
// manifest's donors. That function DELETEs each donor's donation + opposition
// edges and re-derives them from the donor's full FR history, so EVERY money
// edge of the donor gets a new id; only the partial edge's VALUES change.
//
// MODES (exactly one; target --local or --prod, always explicit):
//   --dry-run   READ ONLY. Per manifest donor: its money edges now, the evidence
//               ids each one is missing, and what the function will write (the
//               same aggregation, as a SELECT). Says whether each manifest edge
//               still reads its `before` values, already reads `expected_after`
//               (repaired — the apply will skip), or neither (the world moved —
//               the apply refuses).
//   --apply     The same plan, then ONE statement:
//                 SELECT * FROM rebuild_ec_donation_edges_for_donors(<ids>)
//               retried on 55P03 (the EC crawl holds the lock for its unit; it
//               fires every 15 min) up to 5 times, 60 s apart. Then the read-back:
//               the manifest edge id is gone, and every one of the donors' money
//               edges equals the plan. On --prod it refuses unless it runs under
//               a FIX-950 claim (session:wait-for-gate --then sets
//               CIVITICS_PROD_SESSION_CLAIMANT).
// --manifest P (default docs/audits/2026-10-03-fix1211-partial-edges.json); an
// apply refuses a manifest built on the other database.
//
// USAGE — prod reads the password from .env.local.prod; a worktree's copy is a
// stub, so run prod from the PRIMARY checkout (or pass --env-file):
//   node scripts/fix1211-rebuild-partial-edges.mjs --prod --dry-run
//   (from packages/data) pnpm session:wait-for-gate:prod --expected-minutes 2 --census stop \
//     --reason "cc-182 FIX-1211 scoped edge rebuild (1 donors)" \
//     --then "node ../../scripts/fix1211-rebuild-partial-edges.mjs --prod --apply"
//
// No VACUUM: nine deleted edges are entity_connections' own autovacuum's and
// ec-vacuum-analyze's (rule 41).

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POOLER_FILE = join(ROOT, "supabase", ".temp", "pooler-url");
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const POOLER_FALLBACK = `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;
const LOCAL_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const DEFAULT_MANIFEST = join(ROOT, "docs", "audits", "2026-10-03-fix1211-partial-edges.json");
const STATEMENT_TIMEOUT = "60s";
const LOCK_ATTEMPTS = 5;
const LOCK_RETRY_MS = 60_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ── args / connection ────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
function argValue(flag, fallback) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}
const MODES = ["--dry-run", "--apply"];
const modes = MODES.filter(has);
if (modes.length !== 1) usage(`pass exactly one of ${MODES.join(" | ")}`);
const MODE = modes[0];
if (has("--local") === has("--prod")) usage("pass exactly one of --local | --prod");
const TARGET = has("--prod") ? "prod" : "local";
const MANIFEST = resolve(argValue("--manifest", DEFAULT_MANIFEST));
const ENV_FILE = resolve(argValue("--env-file", join(ROOT, ".env.local.prod")));

function usage(msg) {
  console.error(`[fix1211] ${msg}`);
  console.error("[fix1211] see the header of scripts/fix1211-rebuild-partial-edges.mjs");
  process.exit(64);
}

function readEnvVar(file, key) {
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[1] === key) return m[2].trim();
  }
  return null;
}

function prodUrl() {
  const password = readEnvVar(ENV_FILE, "SUPABASE_DB_PASSWORD");
  if (!password) {
    console.error(`[fix1211] SUPABASE_DB_PASSWORD not found in ${ENV_FILE}`);
    console.error("[fix1211] a worktree's .env.local.prod is a stub — run from the primary checkout or pass --env-file");
    process.exit(2);
  }
  const base = existsSync(POOLER_FILE) ? readFileSync(POOLER_FILE, "utf8").trim() : POOLER_FALLBACK;
  const u = base.replace(/^(postgresql:\/\/[^/@:]+)@/, `$1:${encodeURIComponent(password)}@`);
  if (u === base) {
    console.error("[fix1211] could not inject the password into the pooler URL");
    process.exit(2);
  }
  return u;
}
const url = TARGET === "local" ? LOCAL_URL : prodUrl();
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const TARGET_LABEL = TARGET === "prod" ? "PROD (Supabase Pro)" : "LOCAL (127.0.0.1:54322)";

/** Run SQL through psql; returns {status, stdout, stderr}. VERBOSITY=verbose puts the SQLSTATE in stderr. */
function psql(sql, { readOnly = false } = {}) {
  const args = [url, "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-q", "-At"];
  if (readOnly) args.push("--single-transaction");
  const res = spawnSync("psql", args, {
    input: (readOnly ? "SET TRANSACTION READ ONLY;\n" : "") + sql,
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    console.error(`[fix1211] failed to launch psql: ${res.error.message}`);
    process.exit(1);
  }
  return res;
}

function json(stdout) {
  const start = stdout.search(/[{[]/);
  if (start < 0) {
    console.error("[fix1211] read returned no JSON value");
    process.exit(1);
  }
  return JSON.parse(stdout.slice(start));
}

function readJson(sql) {
  const res = psql(sql, { readOnly: true });
  if (res.status !== 0) {
    process.stderr.write(res.stderr);
    console.error(`[fix1211] read failed (psql exit ${res.status})`);
    process.exit(1);
  }
  return json(res.stdout);
}

// ── the manifest ─────────────────────────────────────────────────────────────
function loadManifest() {
  if (!existsSync(MANIFEST)) usage(`no manifest at ${MANIFEST}`);
  const m = JSON.parse(readFileSync(MANIFEST, "utf8"));
  if (m.database !== TARGET) usage(`the manifest was built on ${m.database}; this run targets ${TARGET}`);
  if (!Array.isArray(m.donors) || m.donors.length === 0) usage("the manifest names no donors");
  for (const d of m.donors) {
    if (!UUID_RE.test(d.from_id)) usage(`bad from_id ${d.from_id}`);
    for (const e of d.partial_edges ?? []) if (!UUID_RE.test(e.id)) usage(`bad edge id ${e.id}`);
  }
  return m;
}

// ── the plan (READ ONLY) ─────────────────────────────────────────────────────
// What the donors' money edges are now, and what the function will write: the
// rebuild_ec_donations_incr_window aggregation (= the function's), as a SELECT.
function readPlan(m) {
  const ids = `ARRAY[${m.donors.map((d) => lit(d.from_id)).join(", ")}]::uuid[]`;
  return readJson(`
SELECT json_build_object(
  'read_at', now(),
  'edges', COALESCE((SELECT json_agg(e ORDER BY e.from_id, e.connection_type, e.to_id) FROM (
    SELECT ec.id, ec.from_id, ec.to_type, ec.to_id, ec.connection_type::text AS connection_type,
           ec.amount_cents, ec.evidence_count, ec.strength::text AS strength, ec.evidence_ids,
           ARRAY(SELECT x FROM unnest(ec.evidence_ids) AS x
                  WHERE NOT EXISTS (SELECT 1 FROM public.financial_relationships fr WHERE fr.id = x)) AS missing
      FROM public.entity_connections ec
     WHERE ec.from_type = 'financial_entity' AND ec.from_id = ANY (${ids})
       AND ec.connection_type IN ('donation', 'opposition')
       AND ec.evidence_source = 'financial_relationships') e), '[]'),
  'expected', COALESCE((SELECT json_agg(a ORDER BY a.from_id, a.connection_type, a.to_id) FROM (
    SELECT fr.from_id, fr.to_type, fr.to_id,
           CASE WHEN fr.relationship_type = 'ie_oppose' THEN 'opposition' ELSE 'donation' END AS connection_type,
           SUM(COALESCE(fr.amount_cents, 0)) AS amount_cents,
           COUNT(*) AS evidence_count,
           LEAST(0.999, GREATEST(0.001,
             LOG(10, GREATEST(SUM(COALESCE(fr.amount_cents, 0)) / 100.0, 1.0)) / 8.0
           ))::numeric(4,3)::text AS strength,
           (ARRAY_AGG(fr.id ORDER BY fr.occurred_at DESC NULLS LAST))[1:100] AS evidence_ids
      FROM public.financial_relationships fr
     WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
       AND fr.from_type = 'financial_entity' AND fr.from_id = ANY (${ids})
     GROUP BY fr.from_id, fr.to_type, fr.to_id,
              CASE WHEN fr.relationship_type = 'ie_oppose' THEN 'opposition' ELSE 'donation' END) a), '[]')
);`);
}

const key = (r) => `${r.from_id}|${r.connection_type}|${r.to_type}|${r.to_id}`;
const vals = (r) => `${r.amount_cents} / ${r.evidence_count} / ${r.strength}`;
const sameIds = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** Classify each manifest edge: before | repaired | moved. */
function classify(m, plan) {
  const now = new Map(plan.edges.map((e) => [e.id, e]));
  const exp = new Map(plan.expected.map((e) => [key(e), e]));
  const out = [];
  for (const d of m.donors) {
    for (const p of d.partial_edges) {
      const cur = now.get(p.id);
      const want = exp.get(`${d.from_id}|${p.connection_type}|${p.to_type}|${p.to_id}`);
      const wantOk =
        want &&
        Number(want.amount_cents) === p.expected_after.amount_cents &&
        Number(want.evidence_count) === p.expected_after.evidence_count &&
        want.strength === p.expected_after.strength &&
        sameIds(want.evidence_ids, p.expected_after.evidence_ids);
      let state;
      if (!wantOk) state = "moved";
      else if (cur && Number(cur.amount_cents) === p.before.amount_cents && Number(cur.evidence_count) === p.before.evidence_count) state = "before";
      else if (!cur && plan.edges.some((e) => key(e) === key(want) && Number(e.amount_cents) === p.expected_after.amount_cents)) state = "repaired";
      else state = "moved";
      out.push({ donor: d, edge: p, cur, want, state });
    }
  }
  return out;
}

function printPlan(m, plan) {
  console.log(`[fix1211] ${TARGET_LABEL} read at ${plan.read_at}`);
  for (const d of m.donors) {
    const mine = plan.edges.filter((e) => e.from_id === d.from_id);
    const exp = plan.expected.filter((e) => e.from_id === d.from_id);
    console.log(`[fix1211] donor ${d.from_id} (${d.display_name}): ${mine.length} money edge(s) now -> ${exp.length} after`);
    const byKey = new Map(mine.map((e) => [key(e), e]));
    for (const x of exp) {
      const cur = byKey.get(key(x));
      const change = !cur ? "NEW" : vals(cur) === vals(x) && sameIds(cur.evidence_ids, x.evidence_ids) ? "same values, new id" : "CHANGES";
      console.log(
        `   ${x.connection_type.padEnd(10)} -> ${x.to_type} ${x.to_id}  ${cur ? vals(cur) : "-"}  =>  ${vals(x)}  [${change}]` +
          (cur && cur.missing.length ? `  missing evidence: ${cur.missing.join(", ")}` : ""),
      );
    }
    for (const cur of mine) {
      if (!exp.some((x) => key(x) === key(cur))) console.log(`   ${cur.connection_type.padEnd(10)} -> ${cur.to_id}  ${vals(cur)}  =>  DELETED (no FR rows left)`);
    }
  }
}

// ── --dry-run ────────────────────────────────────────────────────────────────
function dryRun() {
  const m = loadManifest();
  const plan = readPlan(m);
  console.log(`[fix1211] DRY RUN — READ ONLY, nothing written`);
  printPlan(m, plan);
  for (const c of classify(m, plan)) {
    console.log(`[fix1211] manifest edge ${c.edge.id}: ${c.state}` +
      (c.state === "before" ? ` (${vals(c.cur)} -> ${vals(c.want)})` : ""));
  }
  const deletes = plan.edges.length;
  const inserts = plan.expected.length;
  console.log(`[fix1211] the apply will DELETE ${deletes} edge(s) and INSERT ${inserts}, in one statement`);
}

// ── --apply ──────────────────────────────────────────────────────────────────
async function apply() {
  const m = loadManifest();
  const claimant = process.env.CIVITICS_PROD_SESSION_CLAIMANT ?? null;
  if (TARGET === "prod" && claimant === null) {
    usage("--prod --apply runs only under a FIX-950 claim — run it as session:wait-for-gate:prod --then");
  }
  if (claimant !== null && /[\r\n\0]/.test(claimant)) usage("CIVITICS_PROD_SESSION_CLAIMANT must be one line");

  const plan = readPlan(m);
  printPlan(m, plan);
  const states = classify(m, plan);
  if (states.some((s) => s.state === "moved")) {
    for (const s of states) console.error(`[fix1211] ${s.edge.id}: ${s.state}`);
    console.error("[fix1211] REFUSED — a manifest edge no longer reads its `before` values and is not repaired. Re-read before re-running.");
    process.exit(3);
  }
  if (states.every((s) => s.state === "repaired")) {
    console.log("[fix1211] every manifest edge already reads expected_after — nothing to do");
    process.exit(0);
  }

  const ids = `ARRAY[${m.donors.map((d) => lit(d.from_id)).join(", ")}]::uuid[]`;
  let pre = `SET statement_timeout = '${STATEMENT_TIMEOUT}';\nSET application_name = 'fix1211-rebuild';\n`;
  if (claimant !== null) pre += `SET civitics.prod_session_claimant = ${lit(claimant)};\n`;
  const sql = `${pre}SELECT json_agg(r) FROM public.rebuild_ec_donation_edges_for_donors(${ids}) r;\n`;

  console.log(`[fix1211] ${TARGET_LABEL} — WRITE: rebuild_ec_donation_edges_for_donors for ${m.donors.length} donor(s)${claimant ? `; claimant ${claimant}` : ""}`);
  let res;
  for (let attempt = 1; ; attempt++) {
    const t0 = Date.now();
    res = psql(sql);
    const ms = Date.now() - t0;
    if (res.status === 0) {
      console.log(`[fix1211] applied at ${new Date().toISOString()} (${ms} ms): ${JSON.stringify(json(res.stdout))}`);
      break;
    }
    if (/\b55P03\b/.test(res.stderr) && attempt < LOCK_ATTEMPTS) {
      console.log(`[fix1211] EC rebuild lock held (attempt ${attempt}/${LOCK_ATTEMPTS}) — retrying in ${LOCK_RETRY_MS / 1000}s`);
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
      continue;
    }
    process.stderr.write(res.stderr);
    console.error(`[fix1211] FAILED (psql exit ${res.status}) — nothing committed (one statement)`);
    process.exit(1);
  }

  // ── read-back ──
  const after = readPlan(m);
  const gone = m.donors.flatMap((d) => d.partial_edges).filter((p) => after.edges.some((e) => e.id === p.id));
  const exp = new Map(plan.expected.map((e) => [key(e), e]));
  const bad = after.edges.filter((e) => {
    const x = exp.get(key(e));
    return !x || vals(x) !== vals(e) || !sameIds(x.evidence_ids, e.evidence_ids) || e.missing.length > 0;
  });
  const reused = after.edges.filter((e) => plan.edges.some((p) => p.id === e.id));
  console.log(`[fix1211] read-back at ${after.read_at}: ${after.edges.length} edge(s) (plan ${plan.expected.length}); ` +
    `manifest edge ids still present: ${gone.length}; edges off-plan: ${bad.length}; old ids reused: ${reused.length}`);
  for (const d of m.donors) {
    for (const p of d.partial_edges) {
      const n = after.edges.find((e) => e.from_id === d.from_id && e.to_id === p.to_id && e.connection_type === p.connection_type);
      console.log(`[fix1211] ${p.id} -> ${n ? `${n.id} ${vals(n)} evidence ${JSON.stringify(n.evidence_ids)}` : "NO EDGE"}`);
    }
  }
  const ok = gone.length === 0 && bad.length === 0 && after.edges.length === plan.expected.length;
  console.log(`[fix1211] ${ok ? "OK" : "READ-BACK MISMATCH"}`);
  process.exit(ok ? 0 : 1);
}

if (MODE === "--dry-run") dryRun();
else await apply();
