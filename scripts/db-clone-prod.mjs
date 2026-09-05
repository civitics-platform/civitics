#!/usr/bin/env node
// `pnpm db:clone:prod` — refresh the LOCAL Docker database from a PRODUCTION
// data dump, repeatably and date-stamped.
//
// WHY THIS EXISTS
// The local prod-clone drifts. Because pg_cron runs locally too, DERIVED data
// keeps getting rebuilt on schedule while its SOURCES sit months stale — so the
// clone looks fresh (recent data_sync_log rows, recent MV refreshes) while
// answering questions wrong. Worse, the restore date was never recorded, so no
// session could tell how stale it was; three separate workstreams paid for that
// before this script existed. Step 9 below writes a `local_clone_restore` stamp
// into pipeline_state so staleness is a query, not a guess.
//
// WHAT IT DOES (in order)
//   0. Refuse to run unless .env.local points at local Docker. Restoring prod
//      data ONTO prod is the catastrophic failure mode; the guard makes it
//      structurally impossible rather than merely unlikely.
//   1. pg_dump  public, DATA ONLY, custom format, from prod.
//   2. Preflight the privileges the destructive half needs — while the database
//      is still intact.
//   3. Snapshot cron.job, then park every active job.
//   4. TRUNCATE every public regular table, then pg_restore --data-only
//      --disable-triggers (as a superuser; see LOCAL_SUPERUSER_URL).
//   5. Un-park exactly the cron jobs that were active before, and print the
//      FIX-946 banner.
//
// FIX-946 — cron.job IS NOT CLONED, AND NEVER WAS.
//
// The dump is `--schema=public --data-only`; `cron.job` lives in the `cron`
// schema and is not in it. Steps 3 and 5 above snapshot and restore the LOCAL
// cron.job around the destructive half — they park local jobs so a nightly
// rebuild cannot fire into a half-loaded database, and put back exactly what
// was there. Prod's schedule is never read and never copied.
//
// So the clone's cron.job is LOCAL history: rows created by whichever
// migrations have been applied here, in local order, with whatever `active`
// flags local runs left behind. Two consequences, both load-bearing:
//
//   - jobids DIFFER. Measured 2026-09-05: ec-vacuum-analyze is jobid 6 on prod
//     and 15 locally; platform-counts-daily is 48 on prod and 69 locally;
//     donor-rollup-refresh is 24 on prod and 42 locally. Any runbook or query
//     that names a job by jobid is silently wrong against one of the two.
//   - `active` DIFFERS. Same date: 33 of 37 jobs active on prod, 21 of 37
//     locally. The twelve that are ON in prod and OFF here:
//     donation-edge-orphan-sweep, donor-party-rollup-orphan-sweep,
//     donor-party-rollup-refresh, donor-rollup-orphan-sweep, ec-crawl,
//     ec-vacuum-analyze, entity-connection-stats-orphan-sweep, fe-crawl,
//     refresh-derived-mvs-daily, refresh-derived-mvs-weekly, rule-taggers-daily,
//     rule-taggers-weekly. FIX-944 nearly went the wrong way on exactly this —
//     the clone suggested half the prod schedule was disabled and that the
//     per-official money rollups were stranded on a job that could not run,
//     which would have justified re-enabling prod jobs that were never off.
//
// The clone is deliberately NOT made to mirror prod's flags: a live pg_cron
// here would run prod-shaped jobs against local data, which is the thing steps
// 3 and 5 exist to prevent. cron.job is a PROD-ONLY READ. Get it with
// `node scripts/db-query.mjs --prod "SELECT jobid, jobname, active, schedule
// FROM cron.job ORDER BY jobname;"` and diff by NAME, never by jobid.
//   6. CALL refresh_derived_mvs('daily'|'weekly') — repopulates all 13 true
//      matviews (pg_dump --data-only does NOT carry matview contents).
//   7. VACUUM (ANALYZE) every public table — a bulk load leaves no stats, and
//      local EXPLAIN output is worthless without them.
//   8. Write the pipeline_state stamp. Always last: the dump carries PROD's
//      pipeline_state rows, so a stamp written earlier is clobbered by step 4.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   - Does not drop or recreate the database, and does not `supabase db reset`.
//   - Does not touch auth.*, storage.*, or supabase_migrations.* — wiping auth
//     destroys the local auth-testing harness (FIX-659/660) and Craig has to
//     re-mint every session token by hand.
//   - Does not exclude "derived" tables. Excluding entity_connections et al
//     would save ~3 GB of a 12 GB transfer and buy back a multi-hour local
//     rebuild_entity_connections() over 8.3M financial_relationships rows —
//     plus a fresh source of local/prod divergence, which is the exact thing
//     this script exists to eliminate. Take everything.
//
// USAGE
//   pnpm db:clone:prod                      # full refresh
//   pnpm db:clone:prod -- --dry-run         # sizes + resolved command, writes nothing
//   pnpm db:clone:prod -- --jobs 8          # parallel restore workers (default 4)
//   pnpm db:clone:prod -- --skip-dump       # reuse the dump file from a previous run
//   pnpm db:clone:prod -- --dump-file PATH  # explicit dump location
//   pnpm db:clone:prod -- --env-file PATH   # where to read SUPABASE_DB_PASSWORD
//
// The --env-file override exists for git worktrees: `pnpm session:worktree`
// seeds a worktree's .env.local.prod as a LOCAL stub with no password, so a
// clone run from a worktree must point at the primary checkout's copy.

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const POOLER_FILE = join(ROOT, "supabase", ".temp", "pooler-url");
const POOLER_FALLBACK = `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;
const LOCAL_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
// pg_restore --disable-triggers issues ALTER TABLE … DISABLE TRIGGER ALL, which
// touches internal RI constraint triggers and therefore requires SUPERUSER. The
// local `postgres` role is NOT superuser (local Docker mirrors prod's role
// model) — it owns the tables, which is enough for TRUNCATE but not for this.
// `supabase_admin` is the local superuser. These are throwaway local Docker
// credentials, same as the postgres:postgres pair above; nothing secret.
const LOCAL_SUPERUSER_URL = "postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres";
const LOCAL_API_URL = "http://127.0.0.1:54321";
const TAG = "[db:clone:prod]";

// On Windows, spawn without a shell cannot resolve a bare `psql` from PATH, and
// spawn WITH a shell re-parses the arg list and shreds any argument containing
// a space (dump paths under C:\Users\... are a live example). Naming the .exe
// explicitly gets PATH resolution without the shell, so args survive intact.
const bin = (n) => (process.platform === "win32" ? `${n}.exe` : n);

function die(msg) {
  console.error(`${TAG} ${msg}`);
  process.exit(1);
}
function log(msg) {
  console.log(`${TAG} ${msg}`);
}
const started = Date.now();
const elapsed = () => {
  const s = Math.round((Date.now() - started) / 1000);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};
function step(n, msg) {
  console.log(`\n${TAG} ── ${n}. ${msg}  (t+${elapsed()})`);
}

function readEnvVar(file, key) {
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[1] === key) return m[2].trim();
  }
  return null;
}

// ── Args ────────────────────────────────────────────────────────────────────
let argv = process.argv.slice(2);
while (argv[0] === "--") argv = argv.slice(1); // pnpm forwards the separator itself
let dryRun = false;
let skipDump = false;
let keepDump = false;
let jobs = 4;
let dumpFile = null;
let envFile = null;
let restoreUrl = LOCAL_SUPERUSER_URL;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--dry-run") dryRun = true;
  else if (a === "--skip-dump") skipDump = true;
  else if (a === "--keep-dump") keepDump = true;
  else if (a === "--jobs" || a === "-j") jobs = Number(argv[++i]);
  else if (a === "--dump-file") dumpFile = argv[++i];
  else if (a === "--env-file") envFile = argv[++i];
  else if (a === "--restore-url") restoreUrl = argv[++i];
  else die(`unknown argument: ${a}`);
}
if (!Number.isInteger(jobs) || jobs < 1 || jobs > 32) die(`--jobs must be an integer 1..32 (got ${jobs})`);

// ── 0. Local-target guard ───────────────────────────────────────────────────
// The one non-negotiable check. Everything below writes destructively (TRUNCATE
// of every public table); it must only ever land on local Docker.
const activeUrl = readEnvVar(join(ROOT, ".env.local"), "NEXT_PUBLIC_SUPABASE_URL");
if (!activeUrl) {
  die(`could not read NEXT_PUBLIC_SUPABASE_URL from ${join(ROOT, ".env.local")} — refusing to run.`);
}
if (activeUrl !== LOCAL_API_URL) {
  console.error(`${TAG} REFUSING TO RUN — .env.local does not point at local Docker.`);
  console.error(`${TAG}   NEXT_PUBLIC_SUPABASE_URL = ${activeUrl}`);
  console.error(`${TAG}   expected                 = ${LOCAL_API_URL}`);
  console.error(`${TAG} This script TRUNCATEs every public table on its target. Switch first:`);
  console.error(`${TAG}   Copy-Item .env.local.dev .env.local`);
  process.exit(1);
}
log(`target guard OK — .env.local points at local Docker (${activeUrl}).`);

// ── Resolve the prod connection string ──────────────────────────────────────
const ENV_FILE = envFile ? (isAbsolute(envFile) ? envFile : join(process.cwd(), envFile)) : join(ROOT, ".env.local.prod");
const password = readEnvVar(ENV_FILE, "SUPABASE_DB_PASSWORD");
if (!password) {
  console.error(`${TAG} SUPABASE_DB_PASSWORD not found in ${ENV_FILE}`);
  console.error(`${TAG} In a worktree, .env.local.prod is a local stub — point at the primary checkout:`);
  console.error(`${TAG}   pnpm db:clone:prod -- --env-file C:/Users/Craig/Documents/Civitics/App/.env.local.prod`);
  process.exit(1);
}
const baseUrl = existsSync(POOLER_FILE) ? readFileSync(POOLER_FILE, "utf8").trim() : POOLER_FALLBACK;
const PROD_URL = baseUrl.replace(/^(postgresql:\/\/[^/@:]+)@/, `$1:${encodeURIComponent(password)}@`);
if (!PROD_URL.includes("@") || PROD_URL === baseUrl) die(`could not inject password into pooler URL: ${baseUrl}`);
const redact = (s) => s.split(encodeURIComponent(password)).join("********");

// ── Dump path ───────────────────────────────────────────────────────────────
const DUMP_DIR = join(tmpdir(), "civitics-clone");
if (!existsSync(DUMP_DIR)) mkdirSync(DUMP_DIR, { recursive: true });
const stampDay = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const DUMP = dumpFile
  ? isAbsolute(dumpFile)
    ? dumpFile
    : join(process.cwd(), dumpFile)
  : join(DUMP_DIR, `prod-public-${stampDay}.dump`);
const CRON_SNAPSHOT = join(DUMP_DIR, `cron-job-${stampDay}.json`);

// ── psql helpers ────────────────────────────────────────────────────────────
// SQL always arrives on stdin so every CLI argument stays space-free.
// singleTransaction=false is REQUIRED for CALL (the refresh procedures COMMIT
// internally) and for VACUUM (non-transactional).
function psql(url, sql, { capture = false, singleTransaction = true, label = "" } = {}) {
  const args = [url, "-v", "ON_ERROR_STOP=1"];
  if (singleTransaction) args.push("--single-transaction");
  if (capture) args.push("-At");
  const res = spawnSync(bin("psql"), args, {
    input: sql + "\n",
    encoding: "utf8",
    stdio: ["pipe", capture ? "pipe" : "inherit", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) die(`failed to launch psql (${label}): ${res.error.message}`);
  if (res.status !== 0) die(`psql failed${label ? ` during ${label}` : ""} (exit ${res.status}).`);
  return capture ? res.stdout.trim() : "";
}
const psqlLocal = (sql, opts) => psql(LOCAL_URL, sql, opts);
const q1 = (url, sql) => psql(url, sql, { capture: true });

// ── Dry run ─────────────────────────────────────────────────────────────────
const SIZE_SQL = `
SELECT (SELECT pg_size_pretty(pg_database_size(current_database())))
  || ' | tables=' || (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                      WHERE n.nspname='public' AND c.relkind='r')
  || ' | heap='   || (SELECT pg_size_pretty(coalesce(sum(pg_table_size(c.oid)),0)) FROM pg_class c
                      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r')
  || ' | idx='    || (SELECT pg_size_pretty(coalesce(sum(pg_indexes_size(c.oid)),0)) FROM pg_class c
                      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r')
  || ' | matviews=' || (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                        WHERE n.nspname='public' AND c.relkind='m');`;

const dumpArgs = [
  "--format=custom",
  "--data-only",
  "--schema=public",
  "--no-owner",
  "--no-privileges",
  "--verbose",
  `--file=${DUMP}`,
  PROD_URL,
];
const restoreArgs = [
  "--data-only",
  "--disable-triggers",
  "--no-owner",
  "--no-privileges",
  `--jobs=${jobs}`,
  "--verbose",
  `--dbname=${restoreUrl}`,
  DUMP,
];

if (dryRun) {
  log("DRY RUN — nothing will be written.\n");
  log(`prod  : ${q1(PROD_URL, SIZE_SQL)}`);
  log(`local : ${q1(LOCAL_URL, SIZE_SQL)}`);
  log(`local cron.job: ${q1(LOCAL_URL, "SELECT count(*)||' jobs, '||count(*) FILTER (WHERE active)||' active' FROM cron.job;")}`);
  // FIX-946: say it here too. A dry run is exactly when someone is deciding
  // whether the clone can answer a scheduling question. It cannot.
  log("cron.job is NOT part of the dump (--schema=public) — the local jobids and");
  log("'active' flags are local history, never prod's. Read cron state from prod:");
  log('  node scripts/db-query.mjs --prod "SELECT jobid, jobname, active, schedule FROM cron.job ORDER BY jobname;"');
  const stamp = q1(LOCAL_URL, "SELECT coalesce((SELECT value::text FROM public.pipeline_state WHERE key='local_clone_restore'),'(never stamped)');");
  log(`existing stamp: ${stamp}`);
  console.log("");
  log(`would dump    : pg_dump ${redact(dumpArgs.join(" "))}`);
  log(`would restore : pg_restore ${redact(restoreArgs.join(" "))}`);
  log(`dump file     : ${DUMP}`);
  process.exit(0);
}

// ── 1. Dump ─────────────────────────────────────────────────────────────────
// pg_dump takes an MVCC-consistent snapshot, so a dump pulled mid-nightly is
// never corrupt — but it IS "prod halfway through rewriting itself", which is a
// poor thing to reason from later. Record which pipelines were in flight so the
// stamp says so, rather than leaving a future session to rediscover it.
// FIX-989 — liveness comes from pg_stat_activity, not from a status column.
// This probe used to read `data_sync_log.status = 'running'` within 6h, which
// is not liveness (playbook D2): a dead process leaves the row set, and a
// process that never wrote a start row is invisible. Both directions matter
// here — a false "in flight" makes an operator postpone a clone for a corpse,
// and a false "quiet" is exactly the mid-nightly snapshot this warning exists
// to catch. A backend leaves pg_stat_activity when it dies, by construction,
// and pg_cron job executors appear there too, so one read covers both the
// GHA-launched (pooled) pipelines and the in-DB cron work.
step(1, `pg_dump public (data only) from PROD → ${DUMP}`);
const liveBackends = q1(
  PROD_URL,
  `SELECT coalesce(string_agg(
            coalesce(nullif(application_name, ''), backend_type) ||
            ' pid=' || pid ||
            ' (' || state || ', ' ||
            coalesce(to_char(now() - coalesce(xact_start, query_start, backend_start), 'HH24:MI:SS'), '?') || ' in)',
            ', ' ORDER BY coalesce(xact_start, query_start, backend_start)), '')
     FROM pg_stat_activity
    WHERE datname       = current_database()
      AND pid          <> pg_backend_pid()
      AND backend_type  = 'client backend'
      AND state IS DISTINCT FROM 'idle';`,
);
// Advisory only — kept because a self-reported pipeline NAME is more legible
// than a pid, but it never decides anything on its own.
const runningRows = q1(
  PROD_URL,
  `SELECT coalesce(string_agg(pipeline || ' (since ' || started_at::time(0) || ' UTC)', ', ' ORDER BY started_at), '')
     FROM public.data_sync_log
    WHERE status = 'running' AND started_at > now() - interval '6 hours';`,
);
if (liveBackends) {
  console.warn(`${TAG} ⚠ PROD WORK IN FLIGHT (live backends): ${liveBackends}`);
  if (runningRows) console.warn(`${TAG}   self-reported as: ${runningRows}`);
  console.warn(`${TAG}   The snapshot is consistent but mid-update. Tables those pipelines`);
  console.warn(`${TAG}   write will land part-way through tonight's run. Re-run outside the`);
  console.warn(`${TAG}   nightly window for a fully quiescent clone. Recorded in the stamp.`);
} else if (runningRows) {
  log(`no live prod backends — clean snapshot window.`);
  console.warn(
    `${TAG} note: data_sync_log still shows '${runningRows}' as running, but no backend is` +
      ` alive behind it — that is a STALE ORPHAN row, not work in flight (FIX-989). Not a reason to wait.`,
  );
} else {
  log("no live prod backends and no running rows — clean snapshot window.");
}
// Stamp shape kept: '' = quiescent, non-empty = mid-update. The value is now
// the LIVE-backend list; the self-reported names ride alongside it.
const runningPipelines = liveBackends;
if (skipDump) {
  if (!existsSync(DUMP)) die(`--skip-dump given but no dump at ${DUMP}`);
  log(`--skip-dump — reusing existing dump (${(statSync(DUMP).size / 1e9).toFixed(2)} GB).`);
} else {
  if (existsSync(DUMP)) {
    log(`removing stale dump at ${DUMP}`);
    rmSync(DUMP);
  }
  log(`pg_dump ${redact(dumpArgs.join(" "))}`);
  const d = spawnSync(bin("pg_dump"), dumpArgs, { stdio: ["ignore", "inherit", "inherit"] });
  if (d.error) die(`failed to launch pg_dump: ${d.error.message}`);
  if (d.status !== 0) die(`pg_dump failed (exit ${d.status}) — nothing was changed locally.`);
}
const dumpBytes = statSync(DUMP).size;
log(`dump ready: ${(dumpBytes / 1e9).toFixed(2)} GB on disk (t+${elapsed()})`);

// ── 2. Preflight ────────────────────────────────────────────────────────────
// Everything from step 3 on is destructive. Check the privileges it needs FIRST,
// so a permissions problem fails while the database is still intact rather than
// between the TRUNCATE and the restore.
step(2, "preflight — privileges required by the destructive half");
const su = q1(restoreUrl, "SELECT current_user || '|' || (SELECT rolsuper::text FROM pg_roles WHERE rolname = current_user);");
const [suUser, suSuper] = su.split("|");
if (suSuper !== "true") {
  die(
    `restore role "${suUser}" is NOT superuser.\n` +
      `${TAG} pg_restore --disable-triggers must disable internal RI constraint triggers,\n` +
      `${TAG} which only a superuser may do. Pass --restore-url with a superuser connection.`,
  );
}
log(`restore role: ${suUser} (superuser ✓)`);
// cron.job is owned by supabase_admin and grants postgres SELECT but not UPDATE,
// so parking has to go through the SECURITY DEFINER cron.alter_job() API rather
// than a direct UPDATE.
if (
  Number(
    q1(LOCAL_URL, "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname='cron' AND p.proname='alter_job';"),
  ) < 1
) {
  die("cron.alter_job() not found — cannot park the scheduler safely.");
}
log("cron.alter_job present ✓");

/**
 * FIX-946 — which jobs' `active` flag changed across the restore, by NAME.
 *
 * The expected answer is "none": step 5 un-parks exactly what step 3 parked. A
 * non-empty result means un-parking did not fully land, which would leave the
 * local scheduler silently stopped — the failure this clone script exists to
 * avoid, showing up as "derived data mysteriously stopped updating" weeks later.
 *
 * Pure and name-keyed on purpose: jobids are not stable across environments (or
 * across a local `supabase db reset`), so a jobid-keyed diff would report
 * phantom changes.
 */
function diffCronActive(before, after) {
  const beforeByName = new Map(before.map((j) => [j.jobname, j.active]));
  const afterByName = new Map(after.map((j) => [j.jobname, j.active]));
  const changed = [];
  for (const [name, wasActive] of beforeByName) {
    if (!afterByName.has(name)) {
      changed.push({ jobname: name, before: wasActive, after: null, kind: "vanished" });
      continue;
    }
    const isActive = afterByName.get(name);
    if (isActive !== wasActive) {
      changed.push({ jobname: name, before: wasActive, after: isActive, kind: "flag_changed" });
    }
  }
  for (const [name, isActive] of afterByName) {
    if (!beforeByName.has(name)) {
      changed.push({ jobname: name, before: null, after: isActive, kind: "appeared" });
    }
  }
  return changed.sort((a, b) => a.jobname.localeCompare(b.jobname));
}

// ── 3. Park pg_cron ─────────────────────────────────────────────────────────
// pg_cron 1.6.4 is installed AND live locally. A nightly rebuild firing partway
// through a multi-GB load corrupts the result silently. Parking via active=false
// (rather than unschedule/reschedule) preserves each row byte-for-byte — there
// is no command string to re-derive and get wrong.
step(3, "park pg_cron jobs for the duration of the restore");
const cronJson = q1(LOCAL_URL, "SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY j.jobid),'[]'::jsonb) FROM cron.job j;");
writeFileSync(CRON_SNAPSHOT, cronJson);
const cronAll = JSON.parse(cronJson);
const activeIds = cronAll.filter((j) => j.active).map((j) => j.jobid);
log(`snapshot: ${cronAll.length} jobs (${activeIds.length} active) → ${CRON_SNAPSHOT}`);
psqlLocal("SELECT cron.alter_job(jobid, active := false) FROM cron.job WHERE active;", { label: "cron park" });
log(`parked ${activeIds.length} active cron job(s).`);

// Un-parking must survive EVERY exit path. A `finally` alone is not enough:
// die() calls process.exit(), which skips finally blocks entirely — so a failed
// TRUNCATE would leave the scheduler parked with no sign of it. spawnSync works
// inside an 'exit' handler, so this is the belt to the finally's braces.
let cronRestored = false;
function unparkCron() {
  if (cronRestored) return;
  cronRestored = true;
  if (activeIds.length === 0) return;
  spawnSync(bin("psql"), [LOCAL_URL, "-v", "ON_ERROR_STOP=1", "--single-transaction"], {
    input: `SELECT cron.alter_job(j, active := true) FROM unnest(ARRAY[${activeIds.join(",")}]::bigint[]) AS j;\n`,
    encoding: "utf8",
    stdio: ["pipe", "ignore", "inherit"],
  });
}
process.on("exit", unparkCron);

let restoreStatus = null;
try {
  // ── 4. Truncate + restore ─────────────────────────────────────────────────
  step(4, "TRUNCATE every public regular table, then restore");
  psqlLocal(
    `DO $$
DECLARE stmt text;
BEGIN
  SELECT 'TRUNCATE TABLE ' || string_agg(format('public.%I', c.relname), ', ' ORDER BY c.relname) || ' CASCADE'
    INTO stmt
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r';
  RAISE NOTICE 'truncating: %', left(stmt, 200) || '...';
  EXECUTE stmt;
END $$;`,
    { label: "truncate" },
  );
  log("truncate complete.");

  log(`pg_restore ${redact(restoreArgs.join(" "))}`);
  const r = spawnSync(bin("pg_restore"), restoreArgs, { stdio: ["ignore", "inherit", "inherit"] });
  if (r.error) die(`failed to launch pg_restore: ${r.error.message}`);
  restoreStatus = r.status;
  if (r.status !== 0) {
    console.error(`${TAG} pg_restore exited ${r.status} — see errors above.`);
    console.error(`${TAG} The database is in a PARTIALLY RESTORED state. cron will be un-parked,`);
    console.error(`${TAG} but NO stamp is written. Re-run with --skip-dump to retry the restore.`);
  } else {
    log(`restore complete (t+${elapsed()})`);
  }
  // pg_restore re-enables triggers per table after loading it; a worker that
  // dies mid-table leaves them disabled, which silently switches FK enforcement
  // off for that table until someone notices. Check rather than assume.
  const stillDisabled = q1(
    LOCAL_URL,
    `SELECT coalesce(string_agg(DISTINCT c.relname, ', '), '')
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND t.tgenabled = 'D';`,
  );
  if (stillDisabled) {
    console.error(`${TAG} ⚠ TRIGGERS LEFT DISABLED on: ${stillDisabled}`);
    console.error(`${TAG}   FK enforcement is OFF for those tables. Re-enable with:`);
    console.error(`${TAG}   ALTER TABLE public.<name> ENABLE TRIGGER ALL;   (as supabase_admin)`);
    restoreStatus = restoreStatus === 0 ? 1 : restoreStatus;
  } else {
    log("all triggers re-enabled ✓");
  }
} finally {
  // ── 5. Un-park pg_cron ────────────────────────────────────────────────────
  // In `finally` so a failed restore never leaves the scheduler parked. Only the
  // jobs that were active before are re-activated — a job Craig had deliberately
  // disabled stays disabled.
  step(5, "restore the pg_cron schedule");
  unparkCron();
  const after = q1(LOCAL_URL, "SELECT count(*)||'/'||count(*) FILTER (WHERE active) FROM cron.job;");
  log(`cron.job now ${after} (jobs/active) — snapshot was ${cronAll.length}/${activeIds.length}`);
  if (Number(after.split("/")[0]) !== cronAll.length) {
    console.error(`${TAG} WARNING: cron.job row count changed across the restore. Snapshot: ${CRON_SNAPSHOT}`);
  }

  // ── FIX-946 banner ───────────────────────────────────────────────────────
  const cronAfter = JSON.parse(
    q1(LOCAL_URL, "SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY j.jobid),'[]'::jsonb) FROM cron.job j;"),
  );
  const changed = diffCronActive(cronAll, cronAfter);
  const activeNow = cronAfter.filter((j) => j.active).length;

  console.error("");
  console.error(`${TAG} ══════════════════════════════════════════════════════════════`);
  console.error(`${TAG}  FIX-946 — THIS CLONE'S cron.job IS NOT PROD'S.`);
  console.error(`${TAG} ══════════════════════════════════════════════════════════════`);
  console.error(`${TAG}  The dump is --schema=public --data-only. cron.job lives in the`);
  console.error(`${TAG}  'cron' schema and was NEVER restored from prod. What you see`);
  console.error(`${TAG}  locally is local history: ${cronAfter.length} job(s), ${activeNow} active.`);
  console.error(`${TAG}`);
  console.error(`${TAG}  Steps 3 and 5 park and un-park the LOCAL schedule so a nightly`);
  console.error(`${TAG}  rebuild cannot fire into a half-loaded database. They do not`);
  console.error(`${TAG}  copy prod's flags, deliberately: a prod-shaped schedule running`);
  console.error(`${TAG}  against local data is the thing they exist to prevent.`);
  console.error(`${TAG}`);
  console.error(`${TAG}  => jobids DIFFER from prod. => 'active' DIFFERS from prod.`);
  console.error(`${TAG}  => cron.job is a PROD-ONLY READ. Diff by NAME, never by jobid:`);
  console.error(`${TAG}     node scripts/db-query.mjs --prod "SELECT jobid, jobname,`);
  console.error(`${TAG}       active, schedule FROM cron.job ORDER BY jobname;"`);
  console.error(`${TAG} ──────────────────────────────────────────────────────────────`);
  if (changed.length === 0) {
    console.error(`${TAG}  Un-park integrity: OK — every job's 'active' flag is back to`);
    console.error(`${TAG}  what it was before the restore.`);
  } else {
    console.error(`${TAG}  ⚠ Un-park integrity: ${changed.length} job(s) CHANGED across the restore.`);
    console.error(`${TAG}    This should be empty. The local scheduler may be stopped.`);
    for (const c of changed) {
      console.error(`${TAG}    - ${c.jobname}: ${c.before} -> ${c.after} (${c.kind})`);
    }
    console.error(`${TAG}    Snapshot to repair from: ${CRON_SNAPSHOT}`);
  }
  console.error(`${TAG} ══════════════════════════════════════════════════════════════`);
  console.error("");
}
if (restoreStatus !== 0) process.exit(1);

// ── 6. Matviews ─────────────────────────────────────────────────────────────
// pg_dump --data-only does NOT carry materialized-view contents, so the 13 true
// matviews (relkind='m') still hold pre-restore data and must be refreshed.
// refresh_derived_mvs covers exactly those 13 across its two cadences.
// max_parallel_workers_per_gather=0: local Docker gives Postgres a 64MB
// /dev/shm, and a parallel-plan REFRESH dies on it.
step(6, "refresh materialized views (refresh_derived_mvs daily + weekly)");
psqlLocal(
  `SET max_parallel_workers_per_gather = 0;
CALL public.refresh_derived_mvs('daily');
CALL public.refresh_derived_mvs('weekly');`,
  { singleTransaction: false, label: "matview refresh" },
);
const mvReport = q1(
  LOCAL_URL,
  `SELECT string_agg(relname || '=' || n, ', ' ORDER BY relname) FROM (
     SELECT c.relname, c.reltuples::bigint AS n
     FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public' AND c.relkind = 'm') s;`,
);
log(`matviews (reltuples): ${mvReport}`);

// ── 7. VACUUM ANALYZE ───────────────────────────────────────────────────────
// A bulk load leaves zero planner stats. Ordered smallest-first so the log
// shows progress early. \gexec runs each generated statement; VACUUM cannot run
// inside a transaction block, hence singleTransaction:false.
step(7, "VACUUM (ANALYZE) every public table");
psqlLocal(
  `SELECT format('VACUUM (ANALYZE) public.%I;', c.relname)
   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r','m')
   ORDER BY pg_table_size(c.oid)
   \\gexec`,
  { singleTransaction: false, label: "vacuum analyze" },
);
log(`vacuum analyze complete (t+${elapsed()})`);

// ── 8. Stamp ────────────────────────────────────────────────────────────────
// LAST, always. pipeline_state arrives in the dump carrying PROD's rows, so a
// stamp written any earlier is silently clobbered by the restore in step 4.
step(8, "write the local_clone_restore stamp");
const cliVersion = (() => {
  const v = spawnSync(bin("pg_dump"), ["--version"], { encoding: "utf8" });
  return (v.stdout || "").trim() || "unknown";
})();
const tablesRestored = Number(
  q1(LOCAL_URL, "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r';"),
);
const stampValue = {
  restored_at: new Date().toISOString(),
  prod_project_ref: PROJECT_REF,
  dump_bytes: dumpBytes,
  tables_restored: tablesRestored,
  cli_version: cliVersion,
  restore_jobs: jobs,
  elapsed: elapsed(),
  // FIX-989: LIVE backends at dump time, from pg_stat_activity. Empty string =
  // prod was genuinely quiescent. Non-empty = real work was mid-run, so those
  // tables are a part-way snapshot.
  pipelines_running_at_dump: runningPipelines,
  // Self-reported names for the same moment. Advisory: a value here with an
  // empty pipelines_running_at_dump means stale orphan rows, not in-flight work.
  sync_log_running_rows_at_dump: runningRows,
};
psqlLocal(
  `INSERT INTO public.pipeline_state (key, value, updated_at)
   VALUES ('local_clone_restore', $stamp$${JSON.stringify(stampValue)}$stamp$::jsonb, now())
   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();`,
  { label: "stamp" },
);
log(`stamp written: ${JSON.stringify(stampValue)}`);

// ── 8. Summary ──────────────────────────────────────────────────────────────
step(9, "summary");
psqlLocal(
  `\\echo '── top 20 tables by rows (post-ANALYZE reltuples) ──'
SELECT c.relname AS table, c.reltuples::bigint AS rows, pg_size_pretty(pg_table_size(c.oid)) AS heap
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.reltuples DESC LIMIT 20;
\\echo '── freshness signals ──'
SELECT (SELECT max(voted_at)::date FROM public.votes) AS max_voted_at,
       (SELECT count(*) FROM public.officials) AS officials,
       (SELECT count(*) FROM public.officials WHERE metadata->>'district_jurisdiction_id' IS NOT NULL) AS officials_district_linked;
SELECT key, value, updated_at FROM public.pipeline_state WHERE key='local_clone_restore';
\\echo '── tables still missing planner stats ──'
SELECT count(*) AS tables_without_last_analyze
FROM pg_stat_user_tables WHERE schemaname='public' AND last_analyze IS NULL AND last_autoanalyze IS NULL;`,
  { label: "summary" },
);

if (!keepDump && !dumpFile) {
  log(`removing dump ${DUMP} (pass --keep-dump to retain it)`);
  rmSync(DUMP, { force: true });
}
console.log("");
log(`DONE in ${elapsed()}.`);
