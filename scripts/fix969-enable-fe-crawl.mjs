#!/usr/bin/env node
// fix969-enable-fe-crawl.mjs — ONE authorized prod write (FIX-969 / FIX-1031).
//
// Activates the pg_cron job `fe-crawl` by NAME:
//   SELECT cron.alter_job(job_id := (SELECT jobid FROM cron.job WHERE jobname = 'fe-crawl'),
//                         active := true);
//
// WHY THIS IS SAFE NOW (and was not, for `financial-entity-totals-incremental`):
// scripts/fix1031-pause-fe-totals-cron.mjs paused the OLD unbounded job because
// its watermark had frozen at 2026-08-07 04:41:54 — a cancellation raises
// QUERY_CANCELED, which plpgsql's `WHEN OTHERS` does not catch, so the procedure
// aborted before its end-of-run watermark write and every firing rebuilt a
// strictly larger dirty set. That un-pause was gated on BOTH:
//   (a) the FIX-969 regime — per-run wall-clock budget + resume cursor, so a
//       cancel BANKS progress instead of discarding it, and
//   (b) a watermark reset/bootstrap.
// (a) shipped as the `fe-crawl` job (FIX-1031/FIX-969): bounded slices
// (slice_rows 50000, chunk_ids 500, unit_budget_seconds 1800, cadence 30 min)
// with peer-backoff against ec-crawl. (b) turns out NOT to be needed: the frozen
// watermark 2026-08-07 04:41:54 is the CORRECT repair cursor — it is exactly the
// point the old job last committed, so the crawl resumes from there and walks
// forward. DO NOT RESET THE WATERMARK. Resetting it would re-scan ~4.6M rows of
// already-reconciled history for nothing.
//
// The old jobid 13 (`financial-entity-totals-incremental`) stays INACTIVE and is
// never unscheduled — `cron.job_run_details` history is the only instrument that
// job has.
//
// ABORT PATH (stated before enabling, per the session's decision 3):
//   node scripts/fix969-enable-fe-crawl.mjs --disable --env-file <path>
// which is the exact reverse: alter_job(active := false). Nothing else is
// touched, so the abort is total — the watermark is not written by this script
// in either direction.
//
// USAGE — run from the PRIMARY checkout, or pass --env-file, because a worktree's
// .env.local.prod is a stub with no SUPABASE_DB_PASSWORD:
//   node scripts/fix969-enable-fe-crawl.mjs --dry-run
//   node scripts/fix969-enable-fe-crawl.mjs --env-file c:/…/App/.env.local.prod

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POOLER_FILE = join(ROOT, "supabase", ".temp", "pooler-url");
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const POOLER_FALLBACK = `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;

const JOB_NAME = "fe-crawl";
const DRY_RUN = process.argv.includes("--dry-run");
const DISABLE = process.argv.includes("--disable");
const TARGET = DISABLE ? "false" : "true";

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
  console.error(`[fix969] SUPABASE_DB_PASSWORD not found in ${ENV_FILE}`);
  console.error(`[fix969] a worktree's .env.local.prod is a stub — pass --env-file <primary checkout>/.env.local.prod`);
  process.exit(2);
}
const baseUrl = existsSync(POOLER_FILE)
  ? readFileSync(POOLER_FILE, "utf8").trim()
  : POOLER_FALLBACK;
const url = baseUrl.replace(
  /^(postgresql:\/\/[^/@:]+)@/,
  `$1:${encodeURIComponent(password)}@`,
);
if (url === baseUrl) {
  console.error(`[fix969] could not inject password into pooler URL: ${baseUrl}`);
  process.exit(2);
}

// Guard: resolve by name and refuse unless exactly one job matches, so a 0- or
// 2-row name match aborts instead of guessing which job to flip.
const sql = `
\\echo '--- BEFORE ---'
SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = '${JOB_NAME}';
\\echo '--- watermark (must NOT change) ---'
SELECT value FROM pipeline_state WHERE key = 'financial_entity_totals_watermark';

DO $$
DECLARE v_jobid bigint; v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = '${JOB_NAME}';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '[fix969] expected exactly 1 job named %, found %', '${JOB_NAME}', v_n;
  END IF;
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = '${JOB_NAME}';
  ${DRY_RUN
    ? `RAISE NOTICE '[fix969] DRY RUN — would set active := ${TARGET} on jobid % (%)', v_jobid, '${JOB_NAME}';`
    : `PERFORM cron.alter_job(job_id := v_jobid, active := ${TARGET});
  RAISE NOTICE '[fix969] set active := ${TARGET} on jobid % (%)', v_jobid, '${JOB_NAME}';`}
END $$;

\\echo '--- AFTER ---'
SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = '${JOB_NAME}';
`;

console.error(
  `[fix969] PROD (Supabase Pro) — ${DRY_RUN ? "DRY RUN" : `WRITE: set ${JOB_NAME} active := ${TARGET}`}`,
);
const res = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1"], {
  stdio: ["pipe", "inherit", "inherit"],
  input: sql,
  shell: process.platform === "win32",
});
if (res.error) {
  console.error(`[fix969] failed to launch psql: ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status ?? 1);
