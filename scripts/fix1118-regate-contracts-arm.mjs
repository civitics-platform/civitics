#!/usr/bin/env node
// fix1118-regate-contracts-arm.mjs — ONE authorized prod DATA write (FIX-1118).
//
// Removes 'rebuild_entity_connections_contracts' from
//   pipeline_state.ec_arm_source_fingerprints -> disabled_arms
// so the arm rejoins the FIX-1117 source-fingerprint gate.
//
// PRECONDITION — DO NOT RUN THIS FIRST. The arm is in disabled_arms precisely
// because its fingerprint probe cost 98 s (a 3.9M-row Parallel Bitmap Heap Scan
// over a 12 GB table). Re-gating BEFORE the FIX-1118 partial index exists just
// reinstates that 98 s on every cycle, up to four times a day, which is worse
// than leaving the arm un-gated. Run
// scripts/fix1118-build-contract-grant-index.mjs first and confirm indisvalid.
// This script enforces that: it refuses unless the index exists AND is valid.
//
// WHY THIS IS DATA, NOT SCHEMA: disabled_arms is a runtime escape hatch stored
// in pipeline_state, which is exactly why FIX-1117 put it there — flipping an
// arm in or out of the gate needs no deploy. Per CLAUDE.md ("Data-state changes
// vs schema changes") that also means it does NOT propagate with the migration
// and must be run against EACH environment separately.
//
// WHAT TO EXPECT AFTER. On the next ec-crawl cycle where contract/grant rows
// have not changed, the arm should report 0 s in metadata.arm_timings and appear
// in metadata.gated_arms. The second-order effect is the one worth watching:
// because the arm stops rewriting entity_connections every cycle, the
// entity_connection_stats_windows fingerprint should stop being re-dirtied every
// cycle, so the 16-window stats arm should stop recurring on no-change cycles.
// That loop is the real cost (prod 2026-09-01: contracts 411 s at 09:45, then a
// single stats window burning 1,810 s at 10:00 for ZERO inserted rows).
//
// REVERSE (if the probe turns out still to be expensive): re-add the arm with
//   node scripts/fix1118-regate-contracts-arm.mjs --disable
//
// USAGE — run from the PRIMARY checkout, or pass --env-file, because a worktree's
// .env.local.prod is a stub with no SUPABASE_DB_PASSWORD:
//   node scripts/fix1118-regate-contracts-arm.mjs --dry-run
//   node scripts/fix1118-regate-contracts-arm.mjs --env-file c:/…/App/.env.local.prod

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POOLER_FILE = join(ROOT, "supabase", ".temp", "pooler-url");
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const POOLER_FALLBACK = `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;

const ARM = "rebuild_entity_connections_contracts";
const STATE_KEY = "ec_arm_source_fingerprints";
const INDEX_NAME = "financial_relationships_contract_grant_updated_at";
const DRY_RUN = process.argv.includes("--dry-run");
const DISABLE = process.argv.includes("--disable"); // the reverse: put the arm back

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const ENV_FILE = argValue("--env-file", join(ROOT, ".env.local.prod"));

function readEnvVar(file, key) {
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[1] === key) return m[2].trim();
  }
  return null;
}

const password = readEnvVar(ENV_FILE, "SUPABASE_DB_PASSWORD");
if (!password) {
  console.error(`[fix1118] SUPABASE_DB_PASSWORD not found in ${ENV_FILE}`);
  console.error(`[fix1118] a worktree's .env.local.prod is a stub — pass --env-file <primary checkout>/.env.local.prod`);
  process.exit(2);
}
const baseUrl = existsSync(POOLER_FILE)
  ? readFileSync(POOLER_FILE, "utf8").trim()
  : POOLER_FALLBACK;
const url = baseUrl.replace(/^(postgresql:\/\/[^/@:]+)@/, `$1:${encodeURIComponent(password)}@`);
if (url === baseUrl) {
  console.error(`[fix1118] could not inject password into pooler URL: ${baseUrl}`);
  process.exit(2);
}

// The arm-removal expression: rebuild disabled_arms without ARM, preserving every
// other key in the row (jsonb_set touches only {disabled_arms}). jsonb_agg over an
// empty set is NULL, hence the coalesce to '[]'.
const removeExpr = `
    jsonb_set(value, '{disabled_arms}',
      coalesce((SELECT jsonb_agg(a)
                FROM jsonb_array_elements_text(value->'disabled_arms') AS a
                WHERE a <> '${ARM}'), '[]'::jsonb))`;
const addExpr = `
    jsonb_set(value, '{disabled_arms}',
      coalesce(value->'disabled_arms', '[]'::jsonb) || to_jsonb('${ARM}'::text))`;

const sql = `
\\echo '--- BEFORE: disabled_arms ---'
SELECT value->'disabled_arms' AS disabled_arms FROM pipeline_state WHERE key = '${STATE_KEY}';

DO $$
DECLARE v_n int; v_valid boolean; v_present boolean;
BEGIN
  SELECT count(*) INTO v_n FROM pipeline_state WHERE key = '${STATE_KEY}';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '[fix1118] expected exactly 1 pipeline_state row for %, found %', '${STATE_KEY}', v_n;
  END IF;

  ${DISABLE ? "" : `
  -- Refuse to re-gate unless the FIX-1118 index exists AND is valid: without it
  -- the fingerprint probe is the 98 s bitmap heap scan this FIX exists to remove.
  SELECT i.indisvalid INTO v_valid
  FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
  WHERE c.relname = '${INDEX_NAME}';
  IF v_valid IS NULL THEN
    RAISE EXCEPTION '[fix1118] index % does not exist — build it CONCURRENTLY first (fix1118-build-contract-grant-index.mjs)', '${INDEX_NAME}';
  END IF;
  IF NOT v_valid THEN
    RAISE EXCEPTION '[fix1118] index % exists but indisvalid = false — a failed CONCURRENT build; resolve before re-gating', '${INDEX_NAME}';
  END IF;
  RAISE NOTICE '[fix1118] precondition ok: % is present and valid', '${INDEX_NAME}';`}

  SELECT EXISTS (
    SELECT 1 FROM pipeline_state, jsonb_array_elements_text(value->'disabled_arms') AS a
    WHERE key = '${STATE_KEY}' AND a = '${ARM}'
  ) INTO v_present;

  IF ${DISABLE ? "v_present" : "NOT v_present"} THEN
    RAISE NOTICE '[fix1118] no-op: % is already %', '${ARM}', ${DISABLE ? "'disabled'" : "'gated (not in disabled_arms)'"};
    RETURN;
  END IF;

  ${DRY_RUN
    ? `RAISE NOTICE '[fix1118] DRY RUN — would % the arm %', ${DISABLE ? "'disable'" : "'re-gate'"}, '${ARM}';`
    : `UPDATE pipeline_state SET value = ${DISABLE ? addExpr : removeExpr} WHERE key = '${STATE_KEY}';
  RAISE NOTICE '[fix1118] % the arm %', ${DISABLE ? "'disabled'" : "'re-gated'"}, '${ARM}';`}
END $$;

\\echo '--- AFTER: disabled_arms ---'
SELECT value->'disabled_arms' AS disabled_arms FROM pipeline_state WHERE key = '${STATE_KEY}';

\\echo '--- sanity: the arms map must still carry all its entries ---'
SELECT count(*) AS arm_fingerprints FROM pipeline_state, jsonb_object_keys(value->'arms') WHERE key = '${STATE_KEY}';
`;

console.error(
  `[fix1118] PROD (Supabase Pro) — ${DRY_RUN ? "DRY RUN" : `WRITE: ${DISABLE ? "disable" : "re-gate"} ${ARM}`}`,
);
const res = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1"], {
  stdio: ["pipe", "inherit", "inherit"],
  input: sql,
  shell: process.platform === "win32",
});
if (res.error) {
  console.error(`[fix1118] failed to launch psql: ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status ?? 1);
