#!/usr/bin/env node
// fix956-convert-merge-stub-markers.mjs — set B of the 2026-09-05 prod data pass.
//
// Converts the legacy SCALAR merge-stub marker to the FIX-956 ARRAY shape and
// adds the FIX-939 survivor POINTER, in one transaction, from a manifest that is
// written to disk BEFORE the UPDATE and is itself the reversal recipe.
//
//   source_ids := (source_ids - 'merged_fec_candidate_id')
//                 || jsonb_build_object(
//                      'merged_fec_candidate_ids', jsonb_build_array(<scalar>),
//                      'merged_into',              <survivor uuid>)
//
// WHY THE ARRAY (FIX-956): the scalar holds exactly one retired id, which is
// wrong for anyone who has run for two different federal seats — a House member
// who later wins a Senate race retires an H-id at one merge and an S-id at
// another, and the second write silently overwrote the first, un-retiring the
// earlier claim for the pipeline to re-bind on its next pass. Readers already
// accept BOTH shapes (retiredClaims(), packages/data/src/pipelines/fec-bulk/
// index.ts) and persistNewFecIds already guards on both; this is the DATA half
// that FIX-956's code comment explicitly deferred.
//
// WHY THE POINTER (FIX-939): a merge stub records WHAT it retired but not WHO
// absorbed it, so nothing can navigate from the stub to the surviving official.
// 'merged_into' is that edge. It is a POINTER, NOT A DELETE — the stub rows stay
// (FIX-940's votes hang off 16 of them).
//
// SURVIVOR RULE: the tier='elected' official whose source_ids->>'fec_candidate_id'
// equals the stub's retired scalar. FIX-933 moved the id onto the survivor first,
// so exactly one is expected. Rows with 0 or >1 matches are NOT written — they are
// listed in the manifest with the reason and left on the scalar, which readers
// still accept. Measured on prod 2026-09-05: 86 stubs, ALL 86 with exactly one
// survivor, 0 refusals.
//
// The search index does NOT need rebuilding for this. rebuild_entity_search_index's
// stub filter is
//   source_ids ?| array['merged_fec_candidate_id','merged_fec_candidate_ids','merged_into']
// (migration 20260905010000, line 197) — it keys on presence of ANY of the three,
// so the -86 outcome is identical before or after this conversion.
//
// USAGE — manifest is always written; --apply is what makes it write to the DB:
//   node scripts/fix956-convert-merge-stub-markers.mjs --prod             (dry run)
//   node scripts/fix956-convert-merge-stub-markers.mjs --prod  --apply
//   node scripts/fix956-convert-merge-stub-markers.mjs --local --apply

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POOLER_FILE = join(ROOT, "supabase", ".temp", "pooler-url");
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const POOLER_FALLBACK = `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;
const LOCAL_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const APPLY = process.argv.includes("--apply");
const TARGET = process.argv.includes("--local") ? "local"
             : process.argv.includes("--prod") ? "prod" : null;
if (!TARGET) {
  console.error("[fix956] must pass --local or --prod");
  process.exit(2);
}

const STAMP = "2026-09-05";
const OUT_DIR = join(ROOT, "docs", "audits");
const OUT_TSV = join(OUT_DIR, `${STAMP}-merge-stub-markers${TARGET === "local" ? "-local" : ""}.tsv`);

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
  if (!password) {
    console.error("[fix956] SUPABASE_DB_PASSWORD not found in .env.local.prod");
    process.exit(2);
  }
  const baseUrl = existsSync(POOLER_FILE) ? readFileSync(POOLER_FILE, "utf8").trim() : POOLER_FALLBACK;
  url = baseUrl.replace(/^(postgresql:\/\/[^/@:]+)@/, `$1:${encodeURIComponent(password)}@`);
}

// NOTE: never pass `-F "\t"` here. spawn with shell:true (needed for PATH
// resolution of psql on Windows) re-parses the arg list and shreds any arg
// containing WHITESPACE — a tab included — so `-F <TAB>` arrives as a bare `-F`
// and psql then blocks. Measured 2026-09-05: two runs killed at 100 s and 110 s
// with no output. The SQL below emits ONE already-tab-joined column instead, so
// `-At` alone is enough and no separator arg is needed. (Same class as the
// FIX-1142 note about spaces in args.)
function psql(sql, { tuples = false } = {}) {
  const args = [url, "-v", "ON_ERROR_STOP=1"];
  if (tuples) args.push("-At");
  const res = spawnSync("psql", args, {
    input: sql,
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    console.error(res.stderr || res.stdout);
    process.exit(res.status ?? 1);
  }
  return res.stdout;
}

// ── 1. Build the manifest (read-only) ───────────────────────────────────────
// One row per stub: its id, name, tier, active flag, the retired scalar, the
// survivor uuid (or empty), the survivor's name, how many survivors matched, and
// the action this script will take. n_survivors <> 1 => action=REFUSED.
// NOTE ON SHAPE: the stub set is materialised in a CTE FIRST, then the survivor
// is looked up per stub with scalar subqueries. The obvious LATERAL spelling
// (CROSS JOIN LATERAL over public.officials with the `? 'merged_fec_candidate_id'`
// filter in the outer WHERE) does NOT get the filter pushed below the lateral —
// it evaluates the survivor count for all ~37k officials against all ~37k, and
// hangs. Measured 2026-09-05: this shape returns in under a second on prod,
// the LATERAL shape ran >2 min on local before being killed.
const MANIFEST_SQL = `
WITH stub AS MATERIALIZED (
  SELECT o.id, o.full_name, o.tier, o.is_active, o.source_ids,
         o.source_ids->>'merged_fec_candidate_id' AS retired_id
  FROM public.officials o
  WHERE o.source_ids ? 'merged_fec_candidate_id'
)
, elected AS MATERIALIZED (
  -- ONE pass over officials, hash-joined below. The correlated-subquery
  -- spelling is 86 separate scans of a 37k-row table with a jsonb extraction
  -- per row and did not return inside 100 s on local.
  SELECT x.id, x.full_name, x.source_ids->>'fec_candidate_id' AS fid
  FROM public.officials x
  WHERE x.tier = 'elected' AND x.source_ids ? 'fec_candidate_id'
), m AS (
  SELECT s.id, s.full_name, s.tier, s.is_active, s.source_ids, s.retired_id,
         count(e.id)             AS cnt,
         min(e.id::text)         AS survivor_id,
         min(e.full_name)        AS survivor_name
  FROM stub s
  LEFT JOIN elected e ON e.fid = s.retired_id
  GROUP BY s.id, s.full_name, s.tier, s.is_active, s.source_ids, s.retired_id
)
SELECT concat_ws(chr(9),
       m.id::text,
       m.full_name,
       COALESCE(m.tier,''),
       m.is_active::text,
       m.retired_id,
       COALESCE(CASE WHEN m.cnt = 1 THEN m.survivor_id END, ''),
       COALESCE(CASE WHEN m.cnt = 1 THEN m.survivor_name END, ''),
       m.cnt::text,
       CASE WHEN m.cnt = 1 THEN 'CONVERT' ELSE 'REFUSED' END,
       CASE WHEN m.cnt = 1 THEN ''
            WHEN m.cnt = 0 THEN 'no elected official carries this fec_candidate_id'
            ELSE 'ambiguous: ' || m.cnt::text || ' elected officials carry this fec_candidate_id'
       END,
       m.source_ids::text) AS line
FROM m
ORDER BY m.full_name;
`;

const HEADER = [
  "stub_id", "stub_name", "stub_tier", "stub_is_active", "retired_fec_candidate_id",
  "survivor_id", "survivor_name", "n_survivors", "action", "refusal_reason",
  "source_ids_before",
].join("\t");

const rows = psql(MANIFEST_SQL, { tuples: true })
  .split(/\r?\n/)
  .filter((l) => l.trim() !== "");

const convert = rows.filter((r) => r.split("\t")[8] === "CONVERT");
const refused = rows.filter((r) => r.split("\t")[8] === "REFUSED");

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  OUT_TSV,
  [
    `# FIX-956 + FIX-939 — merge-stub marker conversion manifest (${TARGET}, ${STAMP})`,
    `# ${rows.length} stubs carrying the legacy scalar 'merged_fec_candidate_id'`,
    `# ${convert.length} CONVERT (exactly one elected survivor) / ${refused.length} REFUSED (0 or >1)`,
    "#",
    "# REVERSAL RECIPE — source_ids_before is the verbatim pre-write value of each row.",
    "# To undo a single row:",
    "#   UPDATE public.officials SET source_ids = '<source_ids_before>'::jsonb WHERE id = '<stub_id>';",
    "# To undo the whole set, replay that statement for every CONVERT row in this file.",
    "#",
    HEADER,
    ...rows,
  ].join("\n") + "\n",
  "utf8",
);

console.error(`[fix956] ${TARGET.toUpperCase()} — ${rows.length} stubs: ${convert.length} CONVERT, ${refused.length} REFUSED`);
console.error(`[fix956] manifest written: ${OUT_TSV}`);
for (const r of refused) {
  const c = r.split("\t");
  console.error(`[fix956]   REFUSED  ${c[1]} (${c[4]}) — ${c[9]}`);
}

if (!APPLY) {
  console.error("[fix956] DRY RUN — no write. Re-run with --apply to convert the CONVERT rows.");
  process.exit(0);
}

// ── 2. Apply, one transaction, CONVERT rows only ────────────────────────────
// The predicate re-derives the survivor inside the UPDATE rather than trusting
// the manifest's uuid, so a row that changed between manifest and apply simply
// fails the `cnt.n = 1` join and is skipped rather than written wrong.
const APPLY_SQL = `
BEGIN;

SELECT '--- before ---' AS step;
SELECT count(*) FILTER (WHERE source_ids ? 'merged_fec_candidate_id')  AS scalar_rows,
       count(*) FILTER (WHERE source_ids ? 'merged_fec_candidate_ids') AS array_rows,
       count(*) FILTER (WHERE source_ids ? 'merged_into')              AS pointer_rows
FROM public.officials;

WITH survivor AS (
  SELECT s.id AS stub_id,
         s.source_ids->>'merged_fec_candidate_id' AS retired_id,
         (SELECT x.id FROM public.officials x
           WHERE x.tier = 'elected'
             AND x.source_ids->>'fec_candidate_id' = s.source_ids->>'merged_fec_candidate_id') AS survivor_id
  FROM public.officials s
  WHERE s.source_ids ? 'merged_fec_candidate_id'
    AND (SELECT count(*) FROM public.officials x
          WHERE x.tier = 'elected'
            AND x.source_ids->>'fec_candidate_id' = s.source_ids->>'merged_fec_candidate_id') = 1
)
UPDATE public.officials o
   SET source_ids = (o.source_ids - 'merged_fec_candidate_id')
                    || jsonb_build_object(
                         'merged_fec_candidate_ids', jsonb_build_array(sv.retired_id),
                         'merged_into',              sv.survivor_id::text),
       updated_at = now()
  FROM survivor sv
 WHERE o.id = sv.stub_id;

SELECT '--- after ---' AS step;
SELECT count(*) FILTER (WHERE source_ids ? 'merged_fec_candidate_id')  AS scalar_rows,
       count(*) FILTER (WHERE source_ids ? 'merged_fec_candidate_ids') AS array_rows,
       count(*) FILTER (WHERE source_ids ? 'merged_into')              AS pointer_rows
FROM public.officials;

SELECT '--- sample converted row ---' AS step;
SELECT full_name, source_ids::text
FROM public.officials
WHERE source_ids ? 'merged_into'
ORDER BY full_name
LIMIT 3;

COMMIT;
`;

console.error(`[fix956] APPLYING to ${TARGET.toUpperCase()} — ${convert.length} rows, one transaction`);
const t0 = Date.now();
const out = psql(APPLY_SQL);
console.log(out);
console.error(`[fix956] wall clock: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
