#!/usr/bin/env node
// fix1031-pause-fe-totals-cron.mjs — ONE authorized prod write (FIX-1031).
//
// Pauses the pg_cron job `financial-entity-totals-incremental` by NAME:
//   SELECT cron.alter_job(job_id := (SELECT jobid FROM cron.job WHERE jobname = ...),
//                         active := false);
//
// WHY (measured 2026-08-26, cc-prompt-89): the job's watermark
// (pipeline_state.financial_entity_totals_watermark) has been frozen at
// 2026-08-07 04:41:54 since 2026-08-08, because a query cancellation raises
// QUERY_CANCELED, which plpgsql's `WHEN OTHERS` deliberately does NOT catch —
// so the procedure aborts before its end-of-run watermark write. Every Tuesday
// firing therefore rebuilds a dirty set that has only grown: 4,654,818
// financial_relationships rows as of this writing, and the dirty-set build
// alone (count(DISTINCT from_id) over that slice) blows a 120s statement
// timeout on an otherwise idle box. The 2026-08-25 firing pinned prod's disk at
// its 3,000 IOPS cap for ~75 minutes and left the box I/O-starved until ~18:00.
// Each failure makes the next firing strictly more expensive. Pausing stops the
// ratchet; it does NOT fix the job. See FIX-1031 / FIX-969.
//
// NEVER unschedule — `cron.job_run_details` history is the only instrument we
// have for this job, and unscheduling discards it.
//
// TO UN-PAUSE: this needs BOTH (a) the FIX-969 regime (per-run wall-clock
// budget + resume cursor, so a cancel banks progress) AND (b) a watermark
// reset/bootstrap, because the frozen watermark is now itself the cost driver.
// Re-enabling without (b) reproduces the starvation on the next Tuesday.
//   SELECT cron.alter_job(job_id := (SELECT jobid FROM cron.job
//     WHERE jobname = 'financial-entity-totals-incremental'), active := true);

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = join(ROOT, ".env.local.prod");
const POOLER_FILE = join(ROOT, "supabase", ".temp", "pooler-url");
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const POOLER_FALLBACK = `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;

const JOB_NAME = "financial-entity-totals-incremental";
const DRY_RUN = process.argv.includes("--dry-run");

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
  console.error(`[fix1031] SUPABASE_DB_PASSWORD not found in ${ENV_FILE}`);
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
  console.error(`[fix1031] could not inject password into pooler URL: ${baseUrl}`);
  process.exit(2);
}

// Guard: resolve by name and refuse unless exactly one job matches. The
// alter_job is wrapped so a 0- or 2-row name match aborts instead of guessing.
const sql = `
\\echo '--- BEFORE ---'
SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = '${JOB_NAME}';

DO $$
DECLARE v_jobid bigint; v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = '${JOB_NAME}';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '[fix1031] expected exactly 1 job named %, found %', '${JOB_NAME}', v_n;
  END IF;
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = '${JOB_NAME}';
  ${DRY_RUN
    ? `RAISE NOTICE '[fix1031] DRY RUN — would pause jobid % (%)', v_jobid, '${JOB_NAME}';`
    : `PERFORM cron.alter_job(job_id := v_jobid, active := false);
  RAISE NOTICE '[fix1031] paused jobid % (%)', v_jobid, '${JOB_NAME}';`}
END $$;

\\echo '--- AFTER ---'
SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = '${JOB_NAME}';
`;

console.error(`[fix1031] PROD (Supabase Pro) — ${DRY_RUN ? "DRY RUN" : "WRITE: pause " + JOB_NAME}`);
const res = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1"], {
  stdio: ["pipe", "inherit", "inherit"],
  input: sql,
  shell: process.platform === "win32",
});
if (res.error) {
  console.error(`[fix1031] failed to launch psql: ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status ?? 1);
