#!/usr/bin/env node
// fix937-nonfederal-holder-manifest.mjs — set D of the 2026-09-05 prod data pass.
//
// FIX-937's DATA half. The design half (excluding non-electable roles from the
// FEC name pool) already shipped; this enumerates the residue those bindings
// left behind, at row level, so a cleanup acts on a reviewed manifest and never
// a bare DELETE.
//
// THE POPULATION. An officials row whose `role_title` is not in
// FEC_ELECTABLE_ROLE_TITLES (FIX-1025's ROLE_TO_OFFICE) but which CARRIES an
// H/S/P CAND_ID in source_ids.fec_candidate_id or .fec_id. A Council Member or
// an Article III judge cannot stand for federal office, so the id is not theirs
// and the `fec_bulk` donation rows that landed on it are another person's money.
// Measured on prod 2026-09-05: 119 such officials, ALL of role_title
// 'Council Member' — 4 active, 115 inactive.
//
// WHY THE CAND_ID IS NAMEABLE HERE AND NOT IN FIX-935. These officials CARRY the
// id, so the manifest can name it and can name the federal official who legitimately
// holds the same id. The FIX-935 UNIQUE HOLDER branch has no stored id and the
// donation rows do not record one (fec_bulk FR metadata carries fec_committee_id
// and never a cand_id — see scripts/fix935-unique-holder-manifest.mjs and the
// FIX-934 audit header), which is exactly why that branch cannot be remediated
// by derivation and this one can.
//
// SPLIT BY is_active, DELIBERATELY. The active rows are rendering on the site
// today; the inactive ones are not. They are separate manifests and separate
// decisions.
//
// READ-ONLY. This script writes manifests. It does not delete anything — any
// cleanup goes through the FIX-954 machinery (audit -> manifest -> apply ->
// rollup tail), so the deleted rows' recipients go dirty and the donor rollups
// are rebuilt for them.
//
// USAGE:
//   node scripts/fix937-nonfederal-holder-manifest.mjs --prod

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POOLER_FILE = join(ROOT, "supabase", ".temp", "pooler-url");
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const POOLER_FALLBACK = `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;
const LOCAL_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const TARGET = process.argv.includes("--local") ? "local" : "prod";
const STAMP = "2026-09-05";
const OUT_DIR = join(ROOT, "docs", "audits");

function readEnvVar(file, key) {
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[1] === key) return m[2].trim();
  }
  return null;
}

let url;
if (TARGET === "local") {
  url = LOCAL_URL;
} else {
  const password = readEnvVar(join(ROOT, ".env.local.prod"), "SUPABASE_DB_PASSWORD");
  if (!password) { console.error("[fix937] SUPABASE_DB_PASSWORD not found"); process.exit(2); }
  const baseUrl = existsSync(POOLER_FILE) ? readFileSync(POOLER_FILE, "utf8").trim() : POOLER_FALLBACK;
  url = baseUrl.replace(/^(postgresql:\/\/[^/@:]+)@/, `$1:${encodeURIComponent(password)}@`);
}

// See fix956-convert-merge-stub-markers.mjs: never pass `-F "\t"` — shell:true
// shreds a whitespace arg and psql then blocks. Emit one tab-joined column.
function psql(sql) {
  const res = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-At"], {
    input: sql, encoding: "utf8", shell: process.platform === "win32",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) { console.error(res.stderr || res.stdout); process.exit(res.status ?? 1); }
  return res.stdout;
}

const SQL = `
SET statement_timeout = '600s';
WITH holder AS MATERIALIZED (
  SELECT o.id, o.full_name, o.role_title, o.tier, o.is_active,
         COALESCE(j.short_name,'') AS juris,
         COALESCE(o.source_ids->>'fec_candidate_id', o.source_ids->>'fec_id') AS cand_id
  FROM public.officials o
  LEFT JOIN public.jurisdictions j ON j.id = o.jurisdiction_id
  WHERE COALESCE(o.source_ids->>'fec_candidate_id', o.source_ids->>'fec_id') ~ '^[HSP]'
    AND COALESCE(o.role_title,'') NOT IN
      ('Senator','Candidate for Senator','Representative','Candidate for Representative',
       'President','Candidate for President','Vice President')
),
-- the federal official who legitimately holds the same CAND_ID, if any
owner AS MATERIALIZED (
  SELECT x.id, x.full_name, x.role_title,
         COALESCE(x.source_ids->>'fec_candidate_id', x.source_ids->>'fec_id') AS cand_id
  FROM public.officials x
  WHERE COALESCE(x.source_ids->>'fec_candidate_id', x.source_ids->>'fec_id') ~ '^[HSP]'
    AND COALESCE(x.role_title,'') IN
      ('Senator','Candidate for Senator','Representative','Candidate for Representative',
       'President','Candidate for President','Vice President')
),
money AS (
  SELECT fr.to_id, count(*) AS n_rows, sum(fr.amount_cents) AS cents,
         min(fr.occurred_at) AS first_at, max(fr.occurred_at) AS last_at,
         count(DISTINCT fr.cycle_year) AS cycles
  FROM public.financial_relationships fr
  JOIN holder h ON h.id = fr.to_id
  WHERE fr.to_type = 'official' AND fr.relationship_type = 'donation'
    AND fr.metadata->>'source' LIKE 'fec_bulk%'
  GROUP BY fr.to_id
)
-- EVERY argument must be COALESCEd to a non-NULL string: concat_ws OMITS a NULL
-- argument entirely rather than emitting an empty field, which silently shifts
-- every later column left by one. Measured 2026-09-05: a NULL is_active did
-- exactly that, moving the money columns out from under the parser (0 active
-- rows and NaN totals) with no error anywhere.
SELECT concat_ws(chr(9),
  COALESCE(h.id::text,''), COALESCE(h.full_name,''), COALESCE(h.role_title,''),
  COALESCE(h.tier,''), COALESCE(h.is_active::text,''), COALESCE(h.juris,''),
  COALESCE(h.cand_id,''),
  COALESCE(ow.id::text,''), COALESCE(ow.full_name,''), COALESCE(ow.role_title,''),
  COALESCE(m.n_rows,0)::text,
  COALESCE(m.cents,0)::text,
  COALESCE(m.cycles,0)::text,
  COALESCE(m.first_at::text,''), COALESCE(m.last_at::text,''))
FROM holder h
LEFT JOIN money m ON m.to_id = h.id
LEFT JOIN LATERAL (
  SELECT o2.id, o2.full_name, o2.role_title FROM owner o2 WHERE o2.cand_id = h.cand_id LIMIT 1
) ow ON true
ORDER BY h.is_active DESC, COALESCE(m.cents,0) DESC;
`;

// psql echoes a command tag for every non-SELECT statement even under -At, so
// the `SET statement_timeout` above emits a bare "SET" line into the stream.
// Keep only lines that carry the full field count; a partial line is never data.
const N_FIELDS = 15;
const rows = psql(SQL)
  .split(/\r?\n/)
  .map((l) => l.split("\t"))
  .filter((f) => f.length === N_FIELDS);

const HEADER = [
  "official_id", "full_name", "role_title", "tier", "is_active", "jurisdiction",
  "carried_cand_id", "federal_owner_id", "federal_owner_name", "federal_owner_role",
  "fec_rows", "fec_cents", "cycles", "first_at", "last_at",
].join("\t");

const IS_ACTIVE = 4, ROWS = 10, CENTS = 11, OWNER = 7;
// `is_active::text` renders as 'true'/'false'. The bare t/f you see in psql is
// ALIGNED-output formatting of the boolean, not the cast's value — comparing
// against "t" here silently classified all 119 rows as inactive.
const isTrue   = (r) => r[IS_ACTIVE] === "true" || r[IS_ACTIVE] === "t";
const active   = rows.filter(isTrue);
const inactive = rows.filter((r) => !isTrue(r));
const withMoney = (rs) => rs.filter((r) => Number(r[ROWS]) > 0);
const sumRows  = (rs) => rs.reduce((s, r) => s + Number(r[ROWS]), 0);
const sumCents = (rs) => rs.reduce((s, r) => s + Number(r[CENTS]), 0);
const usd = (c) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function write(name, rs, label) {
  const p = join(OUT_DIR, name);
  mkdirSync(OUT_DIR, { recursive: true });
  const wm = withMoney(rs);
  writeFileSync(p, [
    `# FIX-937 — non-federal-role officials carrying an FEC H/S/P CAND_ID (${label}, ${TARGET}, ${STAMP})`,
    `# ${rs.length} officials, ${wm.length} holding fec_bulk donation rows`,
    `# ${sumRows(rs).toLocaleString()} rows / ${usd(sumCents(rs))}`,
    `# with a federal official legitimately holding the same CAND_ID: ${wm.filter((r) => r[OWNER] !== "").length}`,
    "#",
    "# A Council Member / Article III judge cannot stand for federal office, so the",
    "# carried CAND_ID is not theirs and these donation rows are another person's money.",
    "# REMEDIATION goes through the FIX-954 machinery (audit -> manifest -> apply ->",
    "# rollup tail), NEVER a bare DELETE — the deleted rows' recipients must go dirty",
    "# so jobid 24's donor-rollup regime rebuilds them.",
    "#",
    HEADER,
    ...rs.map((r) => r.join("\t")),
  ].join("\n") + "\n", "utf8");
  console.error(`[fix937] ${label.padEnd(8)} ${String(rs.length).padStart(4)} officials, ${String(wm.length).padStart(3)} with money, ${String(sumRows(rs)).padStart(5)} rows, ${usd(sumCents(rs))}  -> ${name}`);
  return { n: rs.length, wm: wm.length, rows: sumRows(rs), cents: sumCents(rs) };
}

console.error(`[fix937] ${TARGET.toUpperCase()} — ${rows.length} non-electable-role officials carrying an H/S/P CAND_ID`);
const A = write(`${STAMP}-fix937-nonfederal-holders-active.tsv`, active, "ACTIVE");
const I = write(`${STAMP}-fix937-nonfederal-holders-inactive.tsv`, inactive, "INACTIVE");

console.error("");
console.error(`[fix937] role_title distribution:`);
const byRole = {};
for (const r of rows) byRole[r[2] || "(none)"] = (byRole[r[2] || "(none)"] ?? 0) + 1;
for (const [k, v] of Object.entries(byRole).sort((a, b) => b[1] - a[1])) console.error(`[fix937]   ${String(v).padStart(4)}  ${k}`);
console.error("");
console.error(`[fix937] ACTIVE set (the applyable one): ${A.wm} officials with money, ${A.rows} rows, ${usd(A.cents)}`);
console.error(`[fix937] INACTIVE set (file as follow-up): ${I.wm} officials with money, ${I.rows} rows, ${usd(I.cents)}`);
