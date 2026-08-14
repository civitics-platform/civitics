#!/usr/bin/env node
// fix1034-stats-ab.mjs — FIX-1034's landing gate, executed.
//
// FIX-1034 corrects two planner-statistics defects on financial_entities /
// financial_relationships:
//   DEFECT 1  LENGTH(metadata->>'state') = 2 on financial_entities is an
//             expression no index or statistics object covers, so the planner
//             uses DEFAULT_EQ_SEL = 0.005 against a measured 87.10% truth.
//   DEFECT 2  pg_stats.n_distinct for financial_relationships.from_id is 42,267
//             against a measured table-wide truth of 2,810,356 of 10,478,133
//             rows — a 66.5x underestimate.
// Together these priced a Memoize-backed nested loop below the hash join, and
// that plan wedged prod for 14h22m on 2026-08-11 and crashed it on 08-13.
//
// The bullet's own gate: "land only if none regresses". So --dry runs BOTH
// passes inside ONE transaction and ROLLS BACK. CREATE STATISTICS, ALTER TABLE
// ... SET (n_distinct) and ANALYZE are all transactional (VACUUM is not), and
// ANALYZE's pg_statistic rows are visible to the transaction that wrote them —
// so the "after" EXPLAINs plan against the corrected statistics on live prod
// data, and prod keeps the old ones when the transaction unwinds.
//
//   node scripts/fix1034-stats-ab.mjs --prod            # A/B, rolled back
//   node scripts/fix1034-stats-ab.mjs --prod --apply    # land it (commits)
//   node scripts/fix1034-stats-ab.mjs --prod --revert   # undo a landed apply
//
// n_distinct is expressed NEGATIVE — postgres reads a negative value as a
// fraction of reltuples, so it stays correct as the table grows. A positive
// absolute would go stale exactly the way the sampled one did.

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AB_SQL = join(ROOT, "scripts", "fix1034-stats-ab.sql");
const ENV_FILE = join(ROOT, ".env.local.prod");
const POOLER_FILE = join(ROOT, "supabase", ".temp", "pooler-url");
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const POOLER_FALLBACK = `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;
const LOCAL_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// 2,810,356 distinct / 10,478,133 rows, measured table-wide on prod 2026-08-14.
const N_DISTINCT = "-0.268211";

const argv = process.argv.slice(2);
const target = argv.includes("--prod") ? "prod" : argv.includes("--local") ? "local" : null;
const apply = argv.includes("--apply");
const revert = argv.includes("--revert");

if (!target) {
  console.error("usage: fix1034-stats-ab.mjs --prod|--local [--apply|--revert]");
  process.exit(2);
}

function readEnvVar(file, key) {
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[1] === key) return m[2].trim();
  }
  return null;
}

let url, label;
if (target === "local") {
  url = LOCAL_URL;
  label = "LOCAL (127.0.0.1:54322)";
} else {
  const password = readEnvVar(ENV_FILE, "SUPABASE_DB_PASSWORD");
  if (!password) {
    console.error(`[fix1034] SUPABASE_DB_PASSWORD not found in ${ENV_FILE}`);
    process.exit(2);
  }
  const baseUrl = existsSync(POOLER_FILE)
    ? readFileSync(POOLER_FILE, "utf8").trim()
    : POOLER_FALLBACK;
  url = baseUrl.replace(/^(postgresql:\/\/[^/@:]+)@/, `$1:${encodeURIComponent(password)}@`);
  label = "PROD (Supabase Pro)";
}

// Both statistics objects: FIX-1034 notes that stats on LENGTH(expr) do not help
// the bare expr and vice versa — they are separate expressions to the planner.
const APPLY_STATS = `
SET statement_timeout = '45min';
CREATE STATISTICS IF NOT EXISTS fe_state_len_stats
  ON (length(metadata->>'state')) FROM public.financial_entities;
CREATE STATISTICS IF NOT EXISTS fe_state_value_stats
  ON (metadata->>'state') FROM public.financial_entities;
ALTER TABLE public.financial_relationships
  ALTER COLUMN from_id SET (n_distinct = ${N_DISTINCT});
ANALYZE public.financial_entities;
ANALYZE public.financial_relationships;
`;

const REVERT_STATS = `
SET statement_timeout = '45min';
DROP STATISTICS IF EXISTS public.fe_state_len_stats;
DROP STATISTICS IF EXISTS public.fe_state_value_stats;
ALTER TABLE public.financial_relationships ALTER COLUMN from_id RESET (n_distinct);
ANALYZE public.financial_entities;
ANALYZE public.financial_relationships;
`;

const abBody = readFileSync(AB_SQL, "utf8");

let stdin;
if (revert) {
  stdin = `\\timing on\nBEGIN;\n${REVERT_STATS}\nCOMMIT;\n` +
    `SELECT attname, attoptions FROM pg_attribute WHERE attrelid='public.financial_relationships'::regclass AND attname='from_id';\n` +
    `SELECT stxname FROM pg_statistic_ext WHERE stxname LIKE 'fe_state%';\n`;
} else if (apply) {
  stdin = `\\timing on\nBEGIN;\n${APPLY_STATS}\nCOMMIT;\n` +
    `SELECT attname, attoptions FROM pg_attribute WHERE attrelid='public.financial_relationships'::regclass AND attname='from_id';\n` +
    `SELECT stxname FROM pg_statistic_ext WHERE stxname LIKE 'fe_state%';\n` +
    `SELECT tablename, attname, n_distinct FROM pg_stats WHERE tablename='financial_relationships' AND attname='from_id';\n`;
} else {
  stdin =
    "BEGIN;\n" +
    "\\echo '=================== PASS 1 — BASELINE (current statistics) ==================='\n" +
    abBody +
    "\n\\echo '=================== APPLYING FIX-1034 STATISTICS (rolled back) ==================='\n" +
    APPLY_STATS +
    "\n\\echo '=================== PASS 2 — AFTER (corrected statistics) ==================='\n" +
    abBody +
    "\nROLLBACK;\n" +
    "\\echo '=================== ROLLED BACK — prod statistics unchanged ==================='\n" +
    "SELECT attname, attoptions FROM pg_attribute WHERE attrelid='public.financial_relationships'::regclass AND attname='from_id';\n" +
    "SELECT count(*) AS leftover_stats_objects FROM pg_statistic_ext WHERE stxname LIKE 'fe_state%';\n";
}

console.error(`[fix1034] ${label}`);
console.error(
  `[fix1034] mode: ${revert ? "REVERT (commits)" : apply ? "APPLY (commits)" : "A/B DRY RUN (rolled back)"}`,
);

const res = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1"], {
  stdio: ["pipe", "inherit", "inherit"],
  input: stdin,
  shell: process.platform === "win32",
});
if (res.error) {
  console.error(`[fix1034] failed to launch psql: ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status ?? 1);
