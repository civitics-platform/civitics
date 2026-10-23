#!/usr/bin/env node
// fix1258-repack-entity-tags.mjs — compact public.entity_tags ONCE with pg_repack
// (FIX-1258, cc-244). ONE authorized prod maintenance write, under a FIX-950 claim.
//
// WHY. entity_tags' heap is 1,768 MB / relpages 226,259 against ~131k packed
// (1.72×), the residue of the weekly DELETE-all + INSERT-all that FIX-1248's
// merge retired. The merge stops the ratchet; it does not return the slack, and
// every scan pays for the 42 % of air — the daily tagger's `scan` phase, the tag
// pills, the graph routes, autovacuum.
//
// WHY pg_repack, NEVER VACUUM (FULL). FULL holds ACCESS EXCLUSIVE for the whole
// rewrite (15–40 min on a table every entity page reads). pg_repack copies under
// ACCESS SHARE and takes ACCESS EXCLUSIVE only to install its trigger and at the
// relfilenode swap — seconds, twice. The table keeps its OID, so grants, the RLS
// policy, reloptions, the column statistics target and the extended statistics
// survive; this script asserts every one of them after.
//
// THE CLIENT is a container (scripts/pg_repack/Dockerfile) pinned to the server's
// pg_available_extensions.default_version — pg_repack refuses a version mismatch.
// It connects through the session pooler (IPv4; session mode keeps pg_repack's two
// connections and its advisory lock on fixed backends). The password reaches the
// container as PGPASSWORD through the spawn env, NEVER on a command line.
//
// THE STEPS (each printed with its instant):
//   (1) version gate   docker run … pg_repack --version = default_version, else exit 3
//   (2) pre-state      the before table (count(*) except on a --prod dry run —
//                      outside the claim the one full read was Phase 0's)
//   (3) disk + quiet   free ≥ 2 × total relation (1.25–2× needs --disk-ack, on
//                      Craig's word), no VACUUM on entity_tags in progress (polls
//                      60 s, up to 10 min), else exit 4 / 5
//   (4) CREATE EXTENSION IF NOT EXISTS pg_repack   ← the first write
//   (5) pg_repack -N   its own dry run; exit 0 + `INFO: repacking table` or exit 6
//   (6) pg_repack      the copy, index builds, swap; output captured verbatim
//   (7) post-state     + the assertions (exit 7 on any failure, the state printed first)
//   (8) VACUUM (ANALYZE) public.entity_tags   the FIX-943 tail
//   (9) the receipt    before → after
// --dry-run = (1) + (2) + (3) + (5) if the extension is already installed.
// The gates run BEFORE the first write (cc-244 put the disk/quiet gate after the
// CREATE EXTENSION; it moved up so a refused gate writes nothing at all).
//
// THERE IS NO REVERT for a compaction. The nets:
//   * pg_repack's own -N run, through the same container and pooler, before the real one
//   * the FIX-950 claim (--prod --apply refuses without CIVITICS_PROD_SESSION_CLAIMANT)
//   * the disk gate, re-read at apply time
//   * --no-kill-backend --wait-timeout 60: pg_repack waits for readers' ACCESS SHARE
//     and gives up rather than cancelling anyone
//   * a failure BEFORE the swap leaves the original untouched (the swap is the last
//     catalog step); its leftovers are listed and the cleanup SQL PRINTED, never run
//   * PITR, 7 days
// NOT a net: the postgres role's 3 h statement_timeout. The client issues its own
// `SET statement_timeout = 0` (read off the 1.5.2 binary, cc-244), so nothing
// in-backend bounds the repack; the claim's supervision does.
//
// USAGE — from the PRIMARY checkout's packages/data (a worktree's .env.local.prod
// is a stub):
//   node ../../scripts/fix1258-repack-entity-tags.mjs --prod --dry-run --env-file ../../.env.local.prod --image civitics/pg_repack:1.5.2
//   pnpm --filter @civitics/data session:wait-for-gate:prod --expected-minutes <N> --census stop \
//     --reason "cc-244 FIX-1258 pg_repack entity_tags" \
//     --then "node ../../scripts/fix1258-repack-entity-tags.mjs --prod --apply --env-file ../../.env.local.prod --disk-total-gb <GB> --image civitics/pg_repack:1.5.2"
// Against the clone (no claim): --local [--apply] [--disk-total-gb <GB>].

import { readFileSync, existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXIT, GB, TABLE, USAGE,
  parseArgs, parseClientVersion, versionMatches, defaultImage,
  containerConn, repackArgs, dockerRunArgs, dockerVersionArgs,
  diskGate, compareAfterSwap, compareAfterTail, cleanupSql,
} from "./lib/fix1258-repack.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const POOLER_FILE = join(ROOT, "supabase", ".temp", "pooler-url");
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const POOLER_FALLBACK = `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;
const LOCAL_URL = "postgresql://postgres@127.0.0.1:54322/postgres";
const TAG = "[fix1258]";

const args = parseArgs(process.argv.slice(2), process.env);
if (!args.ok) {
  console.error(`${TAG} ${args.error}`);
  console.error(USAGE);
  process.exit(args.exitCode);
}
const PROD = args.target === "prod";

function readEnvVar(file, key) {
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[1] === key) return m[2].trim();
  }
  return null;
}

let password;
let psqlUrl;
let sslmode;
let poolerUrl = null;
if (PROD) {
  const envFile = resolve(args.envFile ?? join(ROOT, ".env.local.prod"));
  password = readEnvVar(envFile, "SUPABASE_DB_PASSWORD");
  if (!password) {
    console.error(`${TAG} SUPABASE_DB_PASSWORD not found in ${envFile}`);
    console.error(`${TAG} a worktree's .env.local.prod is a stub — pass --env-file <primary checkout>/.env.local.prod`);
    process.exit(EXIT.env);
  }
  poolerUrl = existsSync(POOLER_FILE) ? readFileSync(POOLER_FILE, "utf8").trim() : POOLER_FALLBACK;
  if (new URL(poolerUrl).password) {
    console.error(`${TAG} ${POOLER_FILE} carries a password; refusing to put it on a command line`);
    process.exit(EXIT.env);
  }
  psqlUrl = poolerUrl;
  sslmode = "require";
} else {
  password = "postgres";
  psqlUrl = LOCAL_URL;
  sslmode = "disable";
}
const conn = containerConn(args.target, poolerUrl);
// The password travels in the env only — psql and docker both read PGPASSWORD.
const childEnv = { ...process.env, PGPASSWORD: password, PGSSLMODE: sslmode, PGAPPNAME: "fix1258-repack" };

const iso = (d = new Date()) => d.toISOString();
const step = (n, what) => console.error(`\n${TAG} (${n}) ${iso()} — ${what}`);
const mb = (b) => (b / 1048576).toFixed(1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** psql over stdin, autocommit, no psqlrc. `json` returns the last JSON line of -qAt output. */
function psql(sql, { json = false } = {}) {
  const r = spawnSync("psql", [psqlUrl, "-X", "-v", "ON_ERROR_STOP=1", ...(json ? ["-qAt"] : [])], {
    input: sql,
    env: childEnv,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  if (r.error) throw new Error(`psql failed to launch: ${r.error.message}`);
  if (!json) {
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    return { status: r.status };
  }
  if (r.status !== 0) {
    if (r.stderr) process.stderr.write(r.stderr);
    throw new Error(`psql exited ${r.status}`);
  }
  const line = String(r.stdout).split(/\r?\n/).filter((l) => l.startsWith("{")).pop();
  if (!line) throw new Error(`psql returned no JSON line:\n${r.stdout}`);
  return JSON.parse(line);
}

/** docker, output streamed live AND captured (the real repack runs for minutes). */
function docker(argv) {
  return new Promise((resolveP) => {
    const child = spawn("docker", argv, { env: childEnv });
    let out = "";
    const tee = (chunk, stream) => { const s = chunk.toString(); out += s; stream.write(s); };
    child.stdout.on("data", (c) => tee(c, process.stdout));
    child.stderr.on("data", (c) => tee(c, process.stderr));
    child.on("error", (e) => resolveP({ code: -1, out: out + `\n(docker failed to launch: ${e.message})` }));
    child.on("close", (code) => resolveP({ code, out }));
  });
}

const STATE_SQL = (withCount) => `
SET max_parallel_workers_per_gather = 0;
SELECT jsonb_build_object(
  'at', clock_timestamp(),
  'oid', c.oid::bigint,
  'relfilenode', c.relfilenode::bigint,
  'owner', c.relowner::regrole::text,
  'relpages', c.relpages,
  'reltuples', c.reltuples::bigint,
  'relallvisible', c.relallvisible,
  'reloptions', coalesce(to_jsonb(c.reloptions), '[]'::jsonb),
  'rls', c.relrowsecurity,
  'heapBytes', pg_relation_size(c.oid),
  'totalBytes', pg_total_relation_size(c.oid),
  'idxBytes', pg_indexes_size(c.oid),
  'count', ${withCount ? "(SELECT count(*) FROM public.entity_tags)" : "NULL"},
  'nLiveTup', s.n_live_tup,
  'nDeadTup', s.n_dead_tup,
  'lastVacuum', s.last_vacuum,
  'lastAutovacuum', s.last_autovacuum,
  'vacuumCount', s.vacuum_count,
  'autovacuumCount', s.autovacuum_count,
  'lastAnalyze', s.last_analyze,
  'indexes', (SELECT coalesce(jsonb_object_agg(i.relname, jsonb_build_object(
                'def', pg_get_indexdef(x.indexrelid), 'valid', x.indisvalid, 'unique', x.indisunique,
                'primary', x.indisprimary, 'bytes', pg_relation_size(x.indexrelid))), '{}'::jsonb)
                FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid WHERE x.indrelid = c.oid),
  'constraints', (SELECT coalesce(jsonb_object_agg(conname, pg_get_constraintdef(oid)), '{}'::jsonb)
                    FROM pg_constraint WHERE conrelid = c.oid),
  'triggers', (SELECT coalesce(jsonb_agg(tgname ORDER BY tgname), '[]'::jsonb) FROM pg_trigger WHERE tgrelid = c.oid),
  'fksIn', (SELECT count(*) FROM pg_constraint WHERE confrelid = c.oid AND contype = 'f'),
  'policies', (SELECT coalesce(jsonb_object_agg(polname, jsonb_build_object(
                 'cmd', polcmd,
                 'roles', (SELECT jsonb_agg(r::regrole::text ORDER BY r::regrole::text) FROM unnest(polroles) r),
                 'qual', pg_get_expr(polqual, polrelid), 'check', pg_get_expr(polwithcheck, polrelid))), '{}'::jsonb)
                 FROM pg_policy WHERE polrelid = c.oid),
  'statsExt', (SELECT coalesce(jsonb_object_agg(stxname, jsonb_build_object('kind', stxkind, 'keys', stxkeys::text)), '{}'::jsonb)
                 FROM pg_statistic_ext WHERE stxrelid = c.oid),
  'statTargets', (SELECT coalesce(jsonb_object_agg(attname, attstattarget), '{}'::jsonb)
                    FROM pg_attribute WHERE attrelid = c.oid AND attnum > 0 AND NOT attisdropped
                     AND attstattarget IS NOT NULL AND attstattarget >= 0),
  'grants', (SELECT coalesce(jsonb_object_agg(grantee, privs), '{}'::jsonb) FROM (
               SELECT grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
                 FROM information_schema.role_table_grants
                WHERE table_schema = 'public' AND table_name = 'entity_tags' GROUP BY grantee) g),
  'repackRelations', (SELECT coalesce(jsonb_agg(n.nspname || '.' || r.relname ORDER BY r.relname), '[]'::jsonb)
                        FROM pg_class r JOIN pg_namespace n ON n.oid = r.relnamespace
                       WHERE n.nspname = 'repack' AND r.relkind IN ('r', 'i')),
  'repackTriggers', (SELECT coalesce(jsonb_agg(tgname ORDER BY tgname), '[]'::jsonb) FROM pg_trigger
                       WHERE tgrelid = c.oid AND tgname IN ('repack_trigger', 'z_repack_trigger')),
  'installedVersion', (SELECT extversion FROM pg_extension WHERE extname = 'pg_repack'),
  'defaultVersion', (SELECT default_version FROM pg_available_extensions WHERE name = 'pg_repack'),
  'dbSizeBytes', pg_database_size(current_database()),
  'diskUsedBytes', ${PROD
    ? `(SELECT value::bigint FROM public.platform_usage WHERE service = 'supabase' AND metric = 'disk_used_bytes'
          AND recorded_at > now() - interval '2 hours' ORDER BY recorded_at DESC LIMIT 1)`
    : "NULL"}
) FROM pg_class c LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
 WHERE c.oid = 'public.entity_tags'::regclass;
`;

const QUIET_SQL = `
SELECT jsonb_build_object(
  'vacuumInProgress', (SELECT count(*) FROM pg_stat_progress_vacuum WHERE relid = 'public.entity_tags'::regclass),
  'autovacuumWorkers', (SELECT coalesce(jsonb_agg(pid), '[]'::jsonb) FROM pg_stat_activity
                          WHERE backend_type = 'autovacuum worker' AND query ILIKE '%entity_tags%'),
  'otherTxOnTable', (SELECT coalesce(jsonb_agg(jsonb_build_object('pid', a.pid, 'state', a.state,
                        'xact_s', round(EXTRACT(epoch FROM clock_timestamp() - a.xact_start)::numeric, 1),
                        'query', left(a.query, 80)) ORDER BY a.xact_start), '[]'::jsonb)
                       FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
                      WHERE l.relation = 'public.entity_tags'::regclass AND a.pid <> pg_backend_pid())
);
`;

function printState(label, s) {
  const vis = s.relpages > 0 ? ((s.relallvisible / s.relpages) * 100).toFixed(2) : "n/a";
  console.error(`${TAG} ${label} @ ${s.at}`);
  console.error(`    oid ${s.oid} relfilenode ${s.relfilenode} owner ${s.owner}`);
  console.error(`    heap ${s.heapBytes} B (${mb(s.heapBytes)} MB) · indexes ${s.idxBytes} B (${mb(s.idxBytes)} MB) · total ${s.totalBytes} B (${mb(s.totalBytes)} MB)`);
  console.error(`    relpages ${s.relpages} · reltuples ${s.reltuples} · relallvisible ${s.relallvisible} (${vis} %) · count(*) ${s.count ?? "(not taken)"}`);
  console.error(`    n_live ${s.nLiveTup} n_dead ${s.nDeadTup} · last_vacuum ${s.lastVacuum} · last_autovacuum ${s.lastAutovacuum} · vacuum_count ${s.vacuumCount} autovacuum_count ${s.autovacuumCount}`);
  console.error(`    reloptions ${JSON.stringify(s.reloptions)} · rls ${s.rls} · triggers ${JSON.stringify(s.triggers)} · fks in ${s.fksIn}`);
  for (const [name, i] of Object.entries(s.indexes)) {
    console.error(`    index ${name}: valid=${i.valid} unique=${i.unique} primary=${i.primary} ${mb(i.bytes)} MB — ${i.def}`);
  }
  console.error(`    constraints ${JSON.stringify(s.constraints)}`);
  console.error(`    policies ${JSON.stringify(s.policies)}`);
  console.error(`    extended statistics ${JSON.stringify(s.statsExt)} · column stat targets ${JSON.stringify(s.statTargets)}`);
  console.error(`    grants ${JSON.stringify(s.grants)}`);
  console.error(`    repack.* relations ${JSON.stringify(s.repackRelations)} · repack triggers ${JSON.stringify(s.repackTriggers)}`);
  console.error(`    pg_repack installed ${s.installedVersion ?? "(none)"} / available ${s.defaultVersion ?? "(none)"} · db ${s.dbSizeBytes} B` +
    (s.diskUsedBytes != null ? ` · /data used ${s.diskUsedBytes} B (newest Prometheus tick)` : ""));
}

async function main() {
  console.error(
    `${TAG} ${PROD ? "PROD (Supabase Pro)" : "LOCAL clone (127.0.0.1:54322)"} — ${args.apply ? `WRITE: pg_repack ${TABLE}` : "DRY RUN"}` +
      (args.claimant ? `; claimant ${args.claimant}` : "") +
      ` · container → ${conn.host}:${conn.port} as ${conn.user} (sslmode ${conn.sslmode})`,
  );
  console.error(`${TAG} nets: pg_repack -N first · the FIX-950 claim · the disk gate · --no-kill-backend --wait-timeout 60 · a pre-swap failure leaves the original · PITR 7 d. NOT a net: the role's 3 h ceiling (pg_repack sets statement_timeout = 0).`);

  // (1) version gate — before any database contact that could write.
  step(1, "version gate");
  const versionRow = psql(`SELECT jsonb_build_object('defaultVersion', (SELECT default_version FROM pg_available_extensions WHERE name = 'pg_repack'),
                                                    'installedVersion', (SELECT extversion FROM pg_extension WHERE extname = 'pg_repack'));`, { json: true });
  if (!versionRow.defaultVersion) {
    console.error(`${TAG} pg_repack is not in pg_available_extensions on this server — STOP`);
    return EXIT.version;
  }
  const image = args.image ?? defaultImage(versionRow.defaultVersion);
  const v = spawnSync("docker", dockerVersionArgs(image), { encoding: "utf8" });
  const clientOut = `${v.stdout ?? ""}${v.stderr ?? ""}`.trim();
  console.error(`${TAG} server default_version ${versionRow.defaultVersion} · installed ${versionRow.installedVersion ?? "(none)"} · ${image} prints "${clientOut}"`);
  if (v.status !== 0 || !versionMatches(clientOut, versionRow.defaultVersion)) {
    console.error(`${TAG} client ${parseClientVersion(clientOut) ?? "(unreadable)"} ≠ server ${versionRow.defaultVersion} — rebuild the image with --build-arg PG_REPACK_VERSION=${versionRow.defaultVersion}; nothing written`);
    return EXIT.version;
  }

  // (2) pre-state — the receipt's "before".
  const withCount = !(PROD && args.dryRun);
  step(2, `pre-state${withCount ? " (incl. count(*))" : " (count(*) skipped outside the claim)"}`);
  const before = psql(STATE_SQL(withCount), { json: true });
  printState("BEFORE", before);
  if (before.constraints.entity_tags_pkey !== "PRIMARY KEY (id)") {
    console.error(`${TAG} STOP: entity_tags_pkey is ${JSON.stringify(before.constraints.entity_tags_pkey)}, not PRIMARY KEY (id)`);
    return EXIT.failed;
  }
  if (before.triggers.length > 0) {
    console.error(`${TAG} STOP: ${TABLE} has triggers ${JSON.stringify(before.triggers)} (a leftover pg_repack trigger means a previous run died mid-flight)`);
    return EXIT.failed;
  }
  const invalid = Object.entries(before.indexes).filter(([, i]) => i.valid !== true).map(([n]) => n);
  if (invalid.length > 0) {
    console.error(`${TAG} STOP: invalid index(es) ${invalid.join(", ")}`);
    return EXIT.failed;
  }
  if (before.repackRelations.length > 0) {
    console.error(`${TAG} STOP: repack.* relations already present ${JSON.stringify(before.repackRelations)}`);
    return EXIT.failed;
  }

  // (3) disk gate + quiet gate — reads only, before the first write.
  step(3, "disk gate + quiet gate");
  if (args.diskTotalGb !== null) {
    const d = diskGate({ totalGb: args.diskTotalGb, dbSizeBytes: before.dbSizeBytes, diskUsedBytes: before.diskUsedBytes, totalRelBytes: before.totalBytes, ack: args.diskAck });
    console.error(`${TAG} disk: total ${args.diskTotalGb} GB − used ${(d.usedBytes / GB).toFixed(2)} GB ` +
      `(max of pg_database_size ${(before.dbSizeBytes / GB).toFixed(2)} GB${before.diskUsedBytes != null ? ` and /data ${(before.diskUsedBytes / GB).toFixed(2)} GB` : ""}) ` +
      `= free ${(d.freeBytes / GB).toFixed(2)} GB = ${d.ratio.toFixed(2)} × the total relation ${(before.totalBytes / GB).toFixed(2)} GB → ${d.verdict}`);
    if (d.verdict === "ask") {
      console.error(`${TAG} STOP: free is 1.25–2× the relation — go only on Craig's word, re-run with --disk-ack; nothing written`);
      return EXIT.disk;
    }
    if (d.verdict === "stop") {
      console.error(`${TAG} STOP: free < 1.25× the relation — the op moves to a larger-disk day; nothing written`);
      return EXIT.disk;
    }
  } else {
    console.error(`${TAG} disk: no --disk-total-gb (allowed on ${args.target} ${args.apply ? "apply" : "dry run"}) — gate not evaluated`);
  }
  let quiet = null;
  for (let i = 0; i <= 10; i++) {
    quiet = psql(QUIET_SQL, { json: true });
    const busy = quiet.vacuumInProgress > 0 || quiet.autovacuumWorkers.length > 0;
    console.error(`${TAG} quiet ${iso()}: vacuum in progress ${quiet.vacuumInProgress} · autovacuum workers ${JSON.stringify(quiet.autovacuumWorkers)} · lock holders ${JSON.stringify(quiet.otherTxOnTable)}`);
    if (!busy) break;
    if (i === 10 || args.dryRun) {
      console.error(`${TAG} STOP: a VACUUM on ${TABLE} is in progress${args.dryRun ? "" : " after 10 min of polling"}; nothing written`);
      return EXIT.quiet;
    }
    await sleep(60_000);
  }

  // (4) CREATE EXTENSION — the first write.
  if (args.apply) {
    step(4, "CREATE EXTENSION IF NOT EXISTS pg_repack");
    const r = psql(`SET application_name = 'fix1258-repack';\nCREATE EXTENSION IF NOT EXISTS pg_repack;\nSELECT extname, extversion, extnamespace::regnamespace FROM pg_extension WHERE extname = 'pg_repack';\n`);
    if (r.status !== 0) {
      console.error(`${TAG} CREATE EXTENSION failed (psql exit ${r.status}) — nothing else written`);
      return EXIT.failed;
    }
  } else {
    console.error(`\n${TAG} (4) skipped — dry run (the extension is ${before.installedVersion ? `installed, ${before.installedVersion}` : "NOT installed"})`);
  }

  // (5) pg_repack's own dry run.
  const installedNow = args.apply ? true : Boolean(before.installedVersion);
  if (!installedNow) {
    console.error(`\n${TAG} (5) skipped — pg_repack -N needs the extension, which --apply installs at (4); the apply runs -N itself`);
    console.error(`\n${TAG} DRY RUN complete ${iso()} — nothing written`);
    return EXIT.ok;
  }
  step(5, `pg_repack -N (dry run) via ${image}`);
  const n = await docker(dockerRunArgs(image, conn, repackArgs(conn, { dryRun: true })));
  const sawTable = /INFO: repacking table "public\.entity_tags"/.test(n.out);
  console.error(`${TAG} -N exit ${n.code} · saw 'INFO: repacking table "public.entity_tags"': ${sawTable}`);
  if (n.code !== 0 || !sawTable) {
    console.error(`${TAG} STOP: pg_repack -N refused — nothing repacked (the extension, if just created, stays: D6)`);
    return EXIT.dryRunRefused;
  }
  if (args.dryRun) {
    console.error(`\n${TAG} DRY RUN complete ${iso()} — nothing written`);
    return EXIT.ok;
  }

  // (6) the repack.
  step(6, `pg_repack ${TABLE} via ${image} (copy under ACCESS SHARE; ACCESS EXCLUSIVE at trigger install and swap)`);
  const t6 = Date.now();
  const rp = await docker(dockerRunArgs(image, conn, repackArgs(conn, { dryRun: false })));
  const wall6 = (Date.now() - t6) / 1000;
  console.error(`${TAG} (6) end ${iso()} — pg_repack exit ${rp.code}, wall ${wall6.toFixed(1)} s`);

  const mid = psql(STATE_SQL(false), { json: true });
  if (rp.code !== 0 || mid.relfilenode === before.relfilenode) {
    console.error(`${TAG} STOP: ${rp.code !== 0 ? `pg_repack exited ${rp.code}` : "pg_repack exited 0 but the relfilenode did not change (skipped on --wait-timeout?)"} — tail NOT run`);
    printState("STATE NOW (is the original intact?)", mid);
    console.error(`${TAG} original intact: relfilenode ${mid.relfilenode} ${mid.relfilenode === before.relfilenode ? "=" : "≠"} before ${before.relfilenode}; relpages ${mid.relpages} vs ${before.relpages}`);
    if (mid.repackRelations.length > 0 || mid.repackTriggers.length > 0) {
      console.error(`${TAG} leftovers — the documented cleanup, PRINTED NOT RUN (Craig's call, under a gate):`);
      for (const s of cleanupSql(before.oid)) console.error(`    ${s}`);
    }
    return EXIT.repack;
  }

  // (7) post-state + assertions.
  step(7, "post-state (incl. count(*)) + assertions");
  const after = psql(STATE_SQL(true), { json: true });
  printState("AFTER SWAP", after);
  const swap = compareAfterSwap(before, after);
  for (const f of swap.failures) console.error(`${TAG} ASSERTION FAILED: ${f}`);
  if (swap.failures.length === 0) console.error(`${TAG} assertions after the swap: ALL PASS (count, ${Object.keys(before.indexes).length} indexes byte-equal + valid, reloptions, policy, extended stats, stat targets, grants, constraints, OID, no repack.* left, relpages and heap shrank, relfilenode moved)`);
  if (swap.indexSetWrong) {
    console.error(`${TAG} STOP: the index set is wrong — tail NOT run. A missing index is rebuilt by a follow-up CIC prompt, never inline.`);
    return EXIT.assertion;
  }

  // (8) the FIX-943 tail.
  step(8, `VACUUM (ANALYZE) ${TABLE}`);
  const t8 = Date.now();
  const vr = psql(`SET application_name = 'fix1258-vacuum-tail';\nSET statement_timeout = 0;\nSET lock_timeout = '30s';\nVACUUM (ANALYZE) ${TABLE};\n`);
  const wall8 = (Date.now() - t8) / 1000;
  console.error(`${TAG} (8) end ${iso()} — psql exit ${vr.status}, wall ${wall8.toFixed(1)} s`);
  const tail = psql(STATE_SQL(false), { json: true });
  printState("AFTER TAIL", tail);
  const tailCheck = vr.status === 0 ? compareAfterTail(after, tail) : { failures: [`VACUUM (ANALYZE) exited ${vr.status}`], visibleFraction: 0 };
  for (const f of tailCheck.failures) console.error(`${TAG} ASSERTION FAILED (tail): ${f}`);

  // (9) the receipt.
  step(9, "receipt (before → after)");
  const row = (k, b, a) => console.error(`    ${k.padEnd(26)} ${String(b).padStart(16)} → ${String(a).padStart(16)}`);
  row("pg_relation_size (MB)", mb(before.heapBytes), mb(tail.heapBytes));
  row("relpages", before.relpages, tail.relpages);
  row("pg_indexes_size (MB)", mb(before.idxBytes), mb(tail.idxBytes));
  row("pg_total_relation_size (MB)", mb(before.totalBytes), mb(tail.totalBytes));
  row("relallvisible / relpages", `${((before.relallvisible / before.relpages) * 100).toFixed(2)} %`, `${(tailCheck.visibleFraction * 100).toFixed(2)} %`);
  row("count(*)", before.count, after.count);
  row("relfilenode", before.relfilenode, tail.relfilenode);
  console.error(`    repack wall ${wall6.toFixed(1)} s · tail VACUUM (ANALYZE) wall ${wall8.toFixed(1)} s · indexes ${Object.values(tail.indexes).filter((i) => i.valid).length}/${Object.keys(tail.indexes).length} valid`);
  const ok = swap.failures.length === 0 && tailCheck.failures.length === 0;
  console.error(`\n${TAG} ${ok ? "OK" : "COMPLETED WITH ASSERTION FAILURES (a report, not a revert)"} ${iso()}`);
  return ok ? EXIT.ok : EXIT.assertion;
}

main().then(
  (code) => process.exit(code),
  (e) => { console.error(`${TAG} ${e.stack ?? e}`); process.exit(EXIT.failed); },
);
