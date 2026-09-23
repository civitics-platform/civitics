#!/usr/bin/env node
// fix1178c-drop-entity-tags-visibility-index.mjs — the ONE authorized prod DDL
// write for FIX-1178 (c).
//
// Drops public.idx_entity_tags_visibility (visibility, confidence), 450 MB,
// CONCURRENTLY, out-of-band. Craig's decision D4 on cc-136's proposal (c),
// taken on the COMPLETED counter cycle the proposal asked for.
//
// THE COUNTER, TWO OBSERVATIONS, ONE EPOCH. pg_stat_database.stats_reset is
// NULL on prod, so pg_postmaster_start_time() IS the epoch — that is cc-136's
// own correction, after cc-135 read the same counters as lifetime figures when
// they were 3.5 days old. The epoch is 2026-09-15 15:09:48 UTC:
//
//   cc-141  2026-09-21 23:37 UTC   idx_scan 0   450 MB
//   cc-143  2026-09-22 03:15 UTC   idx_scan 0   471,678,976 bytes
//
// cc-136 refused to act on 3.5 days of counters and named the proving read: a
// second idx_scan sample after a FULL weekly cycle. The pre-flight below
// re-reads the counter and the epoch one final time and ABORTS on either
// failure — idx_scan above zero, or an epoch younger than 7 days (a restart
// would have re-zeroed the counter, and a 0 then proves nothing).
//
// WHY IT READS ZERO, which matters more than that it does. The index is
// (visibility, confidence). The one query shaped for it is
// snapshot/route.ts fetchEntityTags, and FIX-503 re-pointed that query at
// idx_entity_tags_entity by threading entity_type through so the leading column
// could be used (prod cost 26989 -> 2.8). So the zero is a consequence of a
// fix that landed, not an accident waiting to be depended on. No code path
// names the index: the only non-prose references in the tree are its own
// CREATE INDEX in 0012_entity_tags.sql (and the packages/db mirror) and a
// historical comment in that same route.
//
// WHY OUT-OF-BAND rather than a migration push: DROP INDEX CONCURRENTLY cannot
// run inside a transaction block, and `supabase db push` wraps each migration
// in one. A plain DROP INDEX takes ACCESS EXCLUSIVE on a 5.36M-row table for
// the duration, blocking every reader. The companion migration
// (20260920080000_fix1178a_pre_vote_timing_merge.sql) carries the same drop as
// DROP INDEX IF EXISTS — a no-op against prod afterwards, and the real drop
// path for a fresh local or a rebuilt clone. Mirrors FIX-1133 / FIX-1118 /
// FIX-1142 exactly.
//
// SAFETY NOTES
//  * DROP INDEX CONCURRENTLY takes only SHARE UPDATE EXCLUSIVE, but it WAITS
//    for every transaction currently touching the table. A long-running
//    transaction elsewhere stalls it. The pre-flight reports old xact_start
//    values and any running cron job; read it before answering the prompt.
//  * It CANNOT drop an index backing a constraint. entity_tags has two such
//    indexes (entity_tags_pkey and the UNIQUE key) and neither is the target;
//    the pre-flight asserts the target has no pg_constraint row and aborts if
//    it does.
//  * pg_get_indexdef is printed BEFORE the drop, so the recreate DDL is in the
//    scrollback even if this session is lost. It is also in 0012_entity_tags.sql.
//  * statement_timeout is 0 and lock_timeout is 30s for this session only: we
//    would rather fail to acquire the lock than sit on a lock queue in front of
//    the front door.
//
// WINDOW: the conditions in cc-prompt-143's header. Not inside 05:45-09:00 UTC,
// not inside 06:00-07:45 UTC (the daily tagger's own window — jobid for
// rule-taggers-daily fires 06:30 UTC), no nightly_cron phase running, and the
// epoch at least 7 days old (which it becomes at 2026-09-22 15:09:48 UTC).
//
// --accept-banked-evidence "<reason>" (cc-145, Craig 2026-09-22). The epoch
// gate reads pg_postmaster_start_time(), and that is only the counter epoch
// after an UNCLEAN restart: crash recovery discards the cumulative stats, a
// clean shutdown writes them out and reloads them. The 2026-09-22 22:28 UTC
// restart was a `fast shutdown` after the box hung, so the counters SURVIVED it
// (the UNIQUE key read 9,579,952 on 09-21 and 10,519,860 after the restart;
// last_idx_scan values predate the restart) — yet the gate saw a 0-day epoch and
// would refuse until 09-29 on evidence that had not changed. The flag replaces
// ONLY the epoch refusal with a printed notice; everything else still aborts,
// idx_scan > 0 above all. It requires a reason, prints the banked readings and
// whether the counters predate the last restart, and the default path is
// unchanged: without the flag the 7-day gate refuses exactly as before.
//
// USAGE — run from the PRIMARY checkout, or pass --env-file, because a
// worktree's .env.local.prod is a stub with no SUPABASE_DB_PASSWORD:
//   node scripts/fix1178c-drop-entity-tags-visibility-index.mjs --dry-run
//   node scripts/fix1178c-drop-entity-tags-visibility-index.mjs
//   node scripts/fix1178c-drop-entity-tags-visibility-index.mjs --dry-run --accept-banked-evidence "<why>"

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POOLER_FILE = join(ROOT, "supabase", ".temp", "pooler-url");
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const POOLER_FALLBACK = `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;

const TARGET = "idx_entity_tags_visibility";
/** The counter epoch must be at least this old for `idx_scan 0` to mean anything. */
const MIN_EPOCH_DAYS = 7;

/** The two zero readings the flag rests on, against the 2026-09-15 15:09:48 UTC epoch. */
const BANKED_READINGS = [
  "cc-141  2026-09-21 23:37 UTC  idx_scan 0  450 MB",
  "cc-143  2026-09-22 03:15 UTC  idx_scan 0  471,678,976 bytes",
];

const DRY_RUN = process.argv.includes("--dry-run");

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const ENV_FILE = argValue("--env-file", join(ROOT, ".env.local.prod"));

const ACCEPT_BANKED = process.argv.includes("--accept-banked-evidence");
const BANKED_REASON = argValue("--accept-banked-evidence", "").trim();
if (ACCEPT_BANKED && (!BANKED_REASON || BANKED_REASON.startsWith("--"))) {
  console.error(`[fix1178c] --accept-banked-evidence needs a reason: --accept-banked-evidence "<why>"`);
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

const password = readEnvVar(ENV_FILE, "SUPABASE_DB_PASSWORD");
if (!password) {
  console.error(`[fix1178c] SUPABASE_DB_PASSWORD not found in ${ENV_FILE}`);
  console.error(`[fix1178c] a worktree's .env.local.prod is a stub — pass --env-file <primary checkout>/.env.local.prod`);
  process.exit(2);
}
const baseUrl = existsSync(POOLER_FILE)
  ? readFileSync(POOLER_FILE, "utf8").trim()
  : POOLER_FALLBACK;
const url = baseUrl.replace(/^(postgresql:\/\/[^/@:]+)@/, `$1:${encodeURIComponent(password)}@`);
if (url === baseUrl) {
  console.error(`[fix1178c] could not inject password into pooler URL: ${baseUrl}`);
  process.exit(2);
}

// NOTE: no explicit BEGIN anywhere — psql autocommit is what lets CONCURRENTLY
// run. NO psql meta-commands anywhere in this template: they need a doubled
// backslash to survive a JS template literal. Plain SELECTs carry the labels.
const preflight = `
SELECT '--- pre: the counter and its epoch (the whole argument) ---' AS step;
SELECT s.indexrelname, s.idx_scan,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS size,
       pg_relation_size(s.indexrelid) AS size_bytes,
       pg_postmaster_start_time() AS epoch,
       (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()) AS stats_reset,
       round(EXTRACT(epoch FROM (now() - pg_postmaster_start_time()))/86400.0, 2) AS epoch_age_days
FROM pg_stat_user_indexes s
WHERE s.relname = 'entity_tags' AND s.indexrelname = '${TARGET}';

SELECT '--- pre: did the counters survive the last restart? (true = the epoch is OLDER than pg_postmaster_start_time) ---' AS step;
SELECT pg_postmaster_start_time() AS postmaster_start,
       min(last_idx_scan) AS oldest_last_idx_scan,
       min(last_idx_scan) < pg_postmaster_start_time() AS counters_predate_restart,
       sum(idx_scan) AS entity_tags_idx_scan_total
FROM pg_stat_user_indexes WHERE relname = 'entity_tags';

SELECT '--- pre: every entity_tags index, for the before/after picture ---' AS step;
SELECT indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes WHERE relname = 'entity_tags' ORDER BY idx_scan DESC;

SELECT '--- pre: entity_tags table state ---' AS step;
SELECT n_live_tup, n_dead_tup, last_autovacuum, autovacuum_count, vacuum_count
FROM pg_stat_user_tables WHERE relname = 'entity_tags';

SELECT '--- pre: transactions older than 60s (these STALL a CONCURRENTLY drop) ---' AS step;
SELECT pid, state, left(query, 60) AS query,
       round(EXTRACT(epoch FROM (now()-xact_start))::numeric,1) AS xact_age_s
FROM pg_stat_activity
WHERE datname = current_database() AND pid <> pg_backend_pid()
  AND xact_start IS NOT NULL AND now() - xact_start > interval '60 seconds'
ORDER BY xact_start;

SELECT '--- pre: any cron job currently running ---' AS step;
SELECT jobid, status, start_time FROM cron.job_run_details
WHERE status = 'running' ORDER BY start_time;

SELECT '--- pre: the two entity_tags writers — neither may be due within the hour ---' AS step;
SELECT jobid, jobname, schedule, active FROM cron.job
WHERE jobname IN ('rule-taggers-daily', 'rule-taggers-weekly') ORDER BY jobname;

SELECT '--- pre: ABORT unless the target exists, is unused, is off-constraint, and the epoch is old enough ---' AS step;
DO $abort$
DECLARE
  v_scan  bigint;
  v_days  numeric;
  v_con   text;
  v_found boolean;
BEGIN
  SELECT true, s.idx_scan INTO v_found, v_scan
  FROM pg_stat_user_indexes s
  WHERE s.relname = 'entity_tags' AND s.indexrelname = '${TARGET}';

  IF v_found IS NOT TRUE THEN
    RAISE EXCEPTION '${TARGET} is not present on entity_tags — already dropped, or renamed. Nothing to do; do NOT force this.';
  END IF;

  IF v_scan > 0 THEN
    RAISE EXCEPTION '${TARGET} has idx_scan = % — something reads it. STOP (cc-prompt-143 read 10).', v_scan;
  END IF;

  SELECT round(EXTRACT(epoch FROM (now() - pg_postmaster_start_time()))/86400.0, 2) INTO v_days;
  IF v_days < ${MIN_EPOCH_DAYS} THEN
    ${
      ACCEPT_BANKED
        ? `RAISE NOTICE '[fix1178c] postmaster epoch is only % days old (< ${MIN_EPOCH_DAYS}) — NOT refusing: --accept-banked-evidence was given (reason and banked readings printed by the wrapper).', v_days;`
        : `RAISE EXCEPTION 'counter epoch is only % days old (< ${MIN_EPOCH_DAYS}) — a restart re-zeroed it, so idx_scan 0 proves nothing. STOP.', v_days;`
    }
  END IF;

  SELECT string_agg(k.conname, ', ') INTO v_con
  FROM pg_class c
  JOIN pg_index i ON i.indexrelid = c.oid
  JOIN pg_constraint k ON k.conindid = c.oid
  WHERE c.relname = '${TARGET}';
  IF v_con IS NOT NULL THEN
    RAISE EXCEPTION '${TARGET} backs constraint(s) % and cannot be dropped concurrently', v_con;
  END IF;

  RAISE NOTICE '[fix1178c] gates clear: idx_scan 0, epoch % days, no constraint.', v_days;
END
$abort$;

SELECT '--- RECREATE DDL — saved before the drop ---' AS step;
SELECT pg_get_indexdef(i.indexrelid) || ';' AS recreate_ddl,
       pg_size_pretty(pg_relation_size(i.indexrelid)) AS size
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
WHERE c.relname = '${TARGET}';
`;

const drop = `
SELECT '--- dropping ${TARGET} ---' AS step;
DROP INDEX CONCURRENTLY IF EXISTS public.${TARGET};`;

const post = `
SELECT '--- post: target MUST be gone from the catalog ---' AS step;
SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
WHERE c.relname = '${TARGET}';

SELECT '--- post: entity_tags indexes — expect SEVEN ---' AS step;
SELECT count(*) AS index_count,
       pg_size_pretty(sum(pg_relation_size(indexrelid))) AS total_index_size,
       sum(pg_relation_size(indexrelid)) AS total_index_bytes
FROM pg_index WHERE indrelid = 'public.entity_tags'::regclass;

SELECT indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes WHERE relname = 'entity_tags' ORDER BY idx_scan DESC;
`;

const sql = DRY_RUN
  ? `${preflight}\nSELECT '--- DRY RUN — would DROP INDEX CONCURRENTLY: ${TARGET} ---' AS step;\n`
  : `${preflight}\nSET statement_timeout = 0;\nSET lock_timeout = '30s';\n${drop}\n${post}`;

console.error(
  `[fix1178c] PROD (Supabase Pro) — ${DRY_RUN ? "DRY RUN" : `WRITE: DROP INDEX CONCURRENTLY public.${TARGET}`}`,
);
if (ACCEPT_BANKED) {
  console.error(`[fix1178c] --accept-banked-evidence: the ${MIN_EPOCH_DAYS}-day epoch refusal becomes a notice; idx_scan > 0 still aborts.`);
  console.error(`[fix1178c]   reason: ${BANKED_REASON}`);
  for (const r of BANKED_READINGS) console.error(`[fix1178c]   banked: ${r}`);
}
if (!DRY_RUN) {
  console.error(`[fix1178c] recreate DDL is printed by the pre-flight BEFORE the drop — keep the scrollback.`);
  console.error(`[fix1178c] it is also in supabase/migrations/0012_entity_tags.sql:90-91.`);
}
const t0 = Date.now();
const res = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1"], {
  stdio: ["pipe", "inherit", "inherit"],
  input: sql,
  shell: process.platform === "win32",
});
if (res.error) {
  console.error(`[fix1178c] failed to launch psql: ${res.error.message}`);
  process.exit(1);
}
console.error(`[fix1178c] psql wall clock: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(res.status ?? 1);
