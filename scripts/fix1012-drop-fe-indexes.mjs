#!/usr/bin/env node
// fix1012-drop-fe-indexes.mjs — the authorized prod DDL writes for FIX-1012.
//
// Drops ONE public.financial_entities index per invocation, CONCURRENTLY,
// out-of-band. The allowed names are exactly the DROP list of the census,
// docs/audits/2026-10-01-fe-index-census.md (rule 42: the doc's list IS this
// list), smallest first:
//
//   financial_entities_canonical             15 MB  btree (canonical_name) WHERE entity_type <> 'individual'
//   financial_entities_canonical_name_type   19 MB  btree (canonical_name, entity_type) WHERE entity_type <> 'individual'
//   financial_entities_individual_state_idx  74 MB  btree ((metadata->>'state')) WHERE entity_type = 'individual'
//   financial_entities_recipient_count_idx   87 MB  btree (recipient_count) WHERE entity_type = 'individual'
//
// One target per invocation so every drop gets its own pass of the gate
// (session:wait-for-gate:prod --census stop --then "node … --index <name>").
//
// THE ARGUMENT IS THE COUNTER, READ AGAINST ITS EPOCH. Each target read
// idx_scan 0 at cc-169 (2026-09-29 23:25 UTC) and at cc-175 read 2
// (2026-10-02 00:22 UTC), over a window that began at the 2026-09-15 15:09:48
// UTC crash and covered every reader that ran: the LittleSis resolver (20
// calls, all on financial_entities_canonical_trgm), jobid 14's Sweep C (19
// rows zeroed by a Seq Scan), the fe-crawl's pass 2 (pkey). The census has
// the with/without plans for the readers that did not run.
//
// THE EPOCH, PROVEN HERE rather than assumed. pg_stat_database.stats_reset is
// NULL on prod, and pg_postmaster_start_time() understates the epoch whenever
// the last restart was clean (a fast shutdown writes the cumulative stats out;
// crash recovery discards them). So:
//   * survived = min(last_idx_scan) on financial_entities < postmaster start.
//     A counter stamped before the restart can only be there if the stats
//     survived it (the fix1178c proof).
//   * When they survived, the epoch is bounded from data: data_sync_log is
//     insert-only (n_tup_del = 0), so its n_tup_ins counts the rows written
//     since the epoch, and the created_at of the n_tup_ins-th newest row is a
//     moment INSIDE the epoch. now() minus that is a lower bound on the
//     epoch's age. On prod 2026-10-02 it reads 3,238 = 3,238 rows since the
//     09-15 crash (and 1,773 since the 09-22 restart).
//   * When they did not survive, the epoch is the postmaster start.
// The DO block refuses on an epoch younger than MIN_EPOCH_DAYS.
//
// --accept-banked-evidence "<reason>" (rule 161, the fix1178c flag): a restart
// re-zeroes the counters and resets the epoch, and the evidence banked in the
// census does not change with it. The flag turns ONLY the epoch refusal into a
// notice and prints the banked readings. idx_scan > 0 NOW still aborts — there
// is no override for that half.
//
// WHY OUT-OF-BAND rather than a migration push: DROP INDEX CONCURRENTLY cannot
// run inside a transaction block, and `supabase db push` wraps each migration
// in one. A plain DROP INDEX takes ACCESS EXCLUSIVE on a 5.2M-row table for the
// duration, blocking every reader. The companion migration
// (20261002000000_fix1012_drop_unscanned_fe_indexes.sql) carries the same
// drops as DROP INDEX IF EXISTS — a no-op against prod afterwards, and the real
// drop path for a fresh local or a rebuilt clone. Mirrors FIX-1133 / FIX-1178c.
//
// SAFETY NOTES
//  * DROP INDEX CONCURRENTLY takes only SHARE UPDATE EXCLUSIVE, but it WAITS
//    for every transaction touching the table. The pre-flight prints old
//    xact_starts, running cron jobs and running data_sync_log rows.
//  * It cannot drop an index backing a constraint; the DO block refuses one.
//  * pg_get_indexdef is printed BEFORE the drop, so the recreate DDL is in the
//    scrollback. It is also in the census doc and in the migrations named there.
//  * statement_timeout 0 and lock_timeout 30s for this session only. A
//    lock_timeout failure exits non-zero and leaves the index intact or
//    INVALID; re-run under the next gate. An INVALID leftover is reported by
//    the pre-flight and dropped by the re-run (that is how it is cleaned).
//  * financial_entities_individual_state_idx also requires FIX-1034's two
//    statistics objects on (metadata->>'state') to exist: they carry the
//    planner's view of the expression once the expression index is gone.
//
// USAGE — run from the PRIMARY checkout, or pass --env-file, because a
// worktree's .env.local.prod is a stub with no SUPABASE_DB_PASSWORD. An
// --env-file whose NEXT_PUBLIC_SUPABASE_URL is loopback targets the LOCAL
// clone (127.0.0.1:54322) — the rehearsal:
//   node scripts/fix1012-drop-fe-indexes.mjs --index <name> --dry-run
//   node scripts/fix1012-drop-fe-indexes.mjs --index <name> --dry-run --env-file .env.local
//   node scripts/fix1012-drop-fe-indexes.mjs --index <name>

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POOLER_FILE = join(ROOT, "supabase", ".temp", "pooler-url");
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const POOLER_FALLBACK = `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;
const LOCAL_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// Smallest first. Each entry is a DROP verdict in docs/audits/2026-10-01-fe-index-census.md.
const TARGETS = [
  "financial_entities_canonical",
  "financial_entities_canonical_name_type",
  "financial_entities_individual_state_idx",
  "financial_entities_recipient_count_idx",
];
/** The expression index whose planner statistics FIX-1034's objects must keep. */
const STATE_IDX = "financial_entities_individual_state_idx";
/** The counter epoch must be at least this old for `idx_scan 0` to mean anything. */
const MIN_EPOCH_DAYS = 14;

/** Prod readings the census rests on, against the 2026-09-15 15:09:48 UTC epoch. */
const BANKED_READINGS = {
  financial_entities_canonical: [
    "cc-169  2026-09-29 23:25 UTC  idx_scan 0  15 MB",
    "cc-175  2026-10-02 00:22 UTC  idx_scan 0  16,146,432 bytes",
  ],
  financial_entities_canonical_name_type: [
    "cc-169  2026-09-29 23:25 UTC  idx_scan 0  19 MB",
    "cc-175  2026-10-02 00:22 UTC  idx_scan 0  19,914,752 bytes",
  ],
  financial_entities_individual_state_idx: [
    "cc-169  2026-09-29 23:25 UTC  idx_scan 0  74 MB",
    "cc-175  2026-10-02 00:22 UTC  idx_scan 0  77,611,008 bytes",
  ],
  financial_entities_recipient_count_idx: [
    "cc-169  2026-09-29 23:25 UTC  idx_scan 0  87 MB",
    "cc-175  2026-10-02 00:22 UTC  idx_scan 0  90,767,360 bytes (after jobid 14's 10-01 Sweep C zeroed 19 rows)",
  ],
};

const DRY_RUN = process.argv.includes("--dry-run");

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const TARGET = argValue("--index", "");
if (!TARGET || TARGET.startsWith("--")) {
  console.error(`[fix1012] --index <name> is required — one drop per invocation. Allowed: ${TARGETS.join(", ")}`);
  process.exit(2);
}
if (!TARGETS.includes(TARGET)) {
  console.error(`[fix1012] ${TARGET} is not on the census DROP list. Allowed: ${TARGETS.join(", ")}`);
  process.exit(2);
}

const ENV_FILE = argValue("--env-file", join(ROOT, ".env.local.prod"));

const ACCEPT_BANKED = process.argv.includes("--accept-banked-evidence");
const BANKED_REASON = argValue("--accept-banked-evidence", "").trim();
if (ACCEPT_BANKED && (!BANKED_REASON || BANKED_REASON.startsWith("--"))) {
  console.error(`[fix1012] --accept-banked-evidence needs a reason: --accept-banked-evidence "<why>"`);
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

const supabaseUrl = readEnvVar(ENV_FILE, "NEXT_PUBLIC_SUPABASE_URL") ?? "";
const IS_LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(supabaseUrl);

let url;
if (IS_LOCAL) {
  url = LOCAL_URL;
} else {
  const password = readEnvVar(ENV_FILE, "SUPABASE_DB_PASSWORD");
  if (!password) {
    console.error(`[fix1012] SUPABASE_DB_PASSWORD not found in ${ENV_FILE}`);
    console.error(`[fix1012] a worktree's .env.local.prod is a stub — pass --env-file <primary checkout>/.env.local.prod`);
    process.exit(2);
  }
  const baseUrl = existsSync(POOLER_FILE) ? readFileSync(POOLER_FILE, "utf8").trim() : POOLER_FALLBACK;
  url = baseUrl.replace(/^(postgresql:\/\/[^/@:]+)@/, `$1:${encodeURIComponent(password)}@`);
  if (url === baseUrl) {
    console.error(`[fix1012] could not inject password into pooler URL: ${baseUrl}`);
    process.exit(2);
  }
}
const LABEL = IS_LOCAL ? "LOCAL clone (127.0.0.1:54322)" : "PROD (Supabase Pro)";

// The epoch, as a CTE every step below can reuse. See the header.
const epochCte = `
WITH pm AS (SELECT pg_postmaster_start_time() AS pm_start),
     fe AS (SELECT min(last_idx_scan) AS oldest_last_idx_scan FROM pg_stat_user_indexes WHERE relname = 'financial_entities'),
     dsl AS (SELECT n_tup_ins, n_tup_del FROM pg_stat_user_tables WHERE relid = 'public.data_sync_log'::regclass),
     -- n_tup_ins = 0 means no row was written inside the epoch: no bound.
     tri AS (SELECT CASE WHEN (SELECT n_tup_ins FROM dsl) > 0 THEN
                      (SELECT created_at FROM public.data_sync_log ORDER BY created_at DESC
                       OFFSET (SELECT n_tup_ins FROM dsl) - 1 LIMIT 1) END AS inside_epoch_at),
     ep AS (
       SELECT pm.pm_start, fe.oldest_last_idx_scan, dsl.n_tup_ins, dsl.n_tup_del, tri.inside_epoch_at,
              (fe.oldest_last_idx_scan IS NOT NULL AND fe.oldest_last_idx_scan < pm.pm_start) AS survived,
              CASE WHEN fe.oldest_last_idx_scan IS NOT NULL AND fe.oldest_last_idx_scan < pm.pm_start
                        AND dsl.n_tup_del = 0 AND tri.inside_epoch_at IS NOT NULL
                   THEN LEAST(tri.inside_epoch_at, fe.oldest_last_idx_scan)
                   ELSE pm.pm_start END AS epoch_at_or_before
       FROM pm, fe, dsl, tri)`;

// NOTE: no explicit BEGIN anywhere — psql autocommit is what lets CONCURRENTLY
// run. NO psql meta-commands anywhere in this template: they need a doubled
// backslash to survive a JS template literal. Plain SELECTs carry the labels.
const preflight = `
SELECT '--- pre: ${TARGET} — definition, size, counter ---' AS step;
SELECT s.indexrelname, s.idx_scan, s.last_idx_scan, i.indisvalid, i.indisunique,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS size,
       pg_relation_size(s.indexrelid) AS size_bytes,
       pg_get_indexdef(s.indexrelid) AS indexdef
FROM pg_stat_user_indexes s JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.relname = 'financial_entities' AND s.indexrelname = '${TARGET}';

SELECT '--- pre: the epoch proof (survived = the counters predate the last restart) ---' AS step;
${epochCte}
SELECT pm_start AS postmaster_start, oldest_last_idx_scan, survived,
       n_tup_ins AS data_sync_log_n_tup_ins, n_tup_del AS data_sync_log_n_tup_del,
       inside_epoch_at AS data_sync_log_row_inside_epoch,
       epoch_at_or_before,
       round(EXTRACT(epoch FROM (now() - epoch_at_or_before))/86400.0, 2) AS epoch_age_days_at_least,
       (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()) AS db_stats_reset
FROM ep;

SELECT '--- pre: financial_entities index bytes BEFORE ---' AS step;
SELECT count(*) AS index_count,
       pg_size_pretty(sum(pg_relation_size(indexrelid))) AS total_index_size,
       sum(pg_relation_size(indexrelid)) AS total_index_bytes
FROM pg_index WHERE indrelid = 'public.financial_entities'::regclass;

SELECT '--- pre: financial_entities table state ---' AS step;
SELECT n_live_tup, n_dead_tup, n_tup_upd, n_tup_hot_upd,
       round(100.0 * n_tup_hot_upd / NULLIF(n_tup_upd, 0), 1) AS hot_pct,
       last_vacuum, last_autovacuum
FROM pg_stat_user_tables WHERE relid = 'public.financial_entities'::regclass;

SELECT '--- pre: transactions older than 60s (these STALL a CONCURRENTLY drop) ---' AS step;
SELECT pid, state, left(query, 60) AS query,
       round(EXTRACT(epoch FROM (now()-xact_start))::numeric,1) AS xact_age_s
FROM pg_stat_activity
WHERE datname = current_database() AND pid <> pg_backend_pid()
  AND xact_start IS NOT NULL AND now() - xact_start > interval '60 seconds'
ORDER BY xact_start;

SELECT '--- pre: any cron job currently running ---' AS step;
SELECT d.jobid, j.jobname, d.status, d.start_time FROM cron.job_run_details d
LEFT JOIN cron.job j ON j.jobid = d.jobid
WHERE d.status = 'running' ORDER BY d.start_time;

SELECT '--- pre: any pipeline currently running (data_sync_log, last 6 h) ---' AS step;
SELECT pipeline, started_at FROM public.data_sync_log
WHERE status = 'running' AND started_at > now() - interval '6 hours' ORDER BY started_at;

SELECT '--- pre: ABORT unless the target exists, is unused, is off-constraint, and the epoch is old enough ---' AS step;
DO $abort$
DECLARE
  v_scan    bigint;
  v_valid   boolean;
  v_days    numeric;
  v_survived boolean;
  v_con     text;
  v_found   boolean;
  v_stats   int;
BEGIN
  SELECT true, s.idx_scan, i.indisvalid INTO v_found, v_scan, v_valid
  FROM pg_stat_user_indexes s JOIN pg_index i ON i.indexrelid = s.indexrelid
  WHERE s.relname = 'financial_entities' AND s.indexrelname = '${TARGET}';

  IF v_found IS NOT TRUE THEN
    RAISE EXCEPTION '${TARGET} is not present on financial_entities — already dropped, or renamed. Nothing to do; do NOT force this.';
  END IF;

  IF v_valid IS NOT TRUE THEN
    RAISE NOTICE '[fix1012] ${TARGET} is INVALID — a leftover of a cancelled concurrent drop or build. Proceeding: the drop is how it is cleaned.';
  END IF;

  IF v_scan > 0 THEN
    RAISE EXCEPTION '${TARGET} has idx_scan = % — something reads it. KEEP it and re-write the census verdict (no override exists for this gate).', v_scan;
  END IF;

  ${epochCte.trim()}
  SELECT round(EXTRACT(epoch FROM (now() - ep.epoch_at_or_before))/86400.0, 2), ep.survived
    INTO v_days, v_survived FROM ep;
  IF v_days < ${MIN_EPOCH_DAYS} THEN
    ${
      ACCEPT_BANKED
        ? `RAISE NOTICE '[fix1012] counter epoch is only % days old (< ${MIN_EPOCH_DAYS}; survived=%) — NOT refusing: --accept-banked-evidence was given (reason and banked readings printed by the wrapper).', v_days, v_survived;`
        : `RAISE EXCEPTION 'counter epoch is only % days old (< ${MIN_EPOCH_DAYS}; survived=%) — a restart re-zeroed it, so idx_scan 0 proves nothing. STOP.', v_days, v_survived;`
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

  IF '${TARGET}' = '${STATE_IDX}' THEN
    SELECT count(*) INTO v_stats FROM pg_statistic_ext
    WHERE stxrelid = 'public.financial_entities'::regclass
      AND stxname IN ('fe_state_len_stats', 'fe_state_value_stats');
    IF v_stats <> 2 THEN
      RAISE EXCEPTION 'FIX-1034 statistics objects on (metadata->>''state'') are missing (% of 2) — the expression index carries the planner''s only view of it. STOP this index.', v_stats;
    END IF;
  END IF;

  RAISE NOTICE '[fix1012] gates clear for ${TARGET}: idx_scan 0, epoch >= % days (survived=%), no constraint.', v_days, v_survived;
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
SELECT '--- dropping ${TARGET} ---' AS step, clock_timestamp() AS at;
DROP INDEX CONCURRENTLY IF EXISTS public.${TARGET};
SELECT '--- dropped ---' AS step, clock_timestamp() AS at;`;

const post = `
SELECT '--- post: ${TARGET} MUST be gone from the catalog (valid or INVALID) ---' AS step;
SELECT c.relname, i.indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
WHERE c.relname = '${TARGET}';
SELECT count(*) AS pg_indexes_rows FROM pg_indexes WHERE schemaname = 'public' AND indexname = '${TARGET}';
SELECT count(*) AS pg_stat_user_indexes_rows FROM pg_stat_user_indexes WHERE indexrelname = '${TARGET}';

SELECT '--- post: financial_entities index bytes AFTER ---' AS step;
SELECT count(*) AS index_count,
       pg_size_pretty(sum(pg_relation_size(indexrelid))) AS total_index_size,
       sum(pg_relation_size(indexrelid)) AS total_index_bytes
FROM pg_index WHERE indrelid = 'public.financial_entities'::regclass;
`;

const sql = DRY_RUN
  ? `${preflight}\nSELECT '--- DRY RUN — would DROP INDEX CONCURRENTLY: ${TARGET} ---' AS step;\n`
  : `${preflight}\nSET statement_timeout = 0;\nSET lock_timeout = '30s';\n${drop}\n${post}`;

console.error(
  `[fix1012] ${LABEL} — ${DRY_RUN ? "DRY RUN" : `WRITE: DROP INDEX CONCURRENTLY public.${TARGET}`}`,
);
if (ACCEPT_BANKED) {
  console.error(`[fix1012] --accept-banked-evidence: the ${MIN_EPOCH_DAYS}-day epoch refusal becomes a notice; idx_scan > 0 still aborts.`);
  console.error(`[fix1012]   reason: ${BANKED_REASON}`);
  for (const r of BANKED_READINGS[TARGET]) console.error(`[fix1012]   banked: ${r}`);
}
if (!DRY_RUN) {
  console.error(`[fix1012] recreate DDL is printed by the pre-flight BEFORE the drop — keep the scrollback.`);
  console.error(`[fix1012] it is also in docs/audits/2026-10-01-fe-index-census.md.`);
}
const t0 = Date.now();
const res = spawnSync("psql", [url, "-X", "-v", "ON_ERROR_STOP=1"], {
  stdio: ["pipe", "inherit", "inherit"],
  input: sql,
  shell: process.platform === "win32",
});
if (res.error) {
  console.error(`[fix1012] failed to launch psql: ${res.error.message}`);
  process.exit(1);
}
console.error(`[fix1012] psql wall clock: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(res.status ?? 1);
