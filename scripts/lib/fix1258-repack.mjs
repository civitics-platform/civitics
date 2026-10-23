// fix1258-repack.mjs — the pure parts of scripts/fix1258-repack-entity-tags.mjs
// (FIX-1258, cc-244). No I/O here: the arg parser, the version comparison, the
// docker argv, the disk gate, the before/after comparator and the sizing
// arithmetic. Tested by scripts/test-fix1258-repack.mjs.

export const TABLE = "public.entity_tags";
export const IMAGE_REPO = "civitics/pg_repack";
export const GB = 1e9;

export const EXIT = {
  ok: 0,
  failed: 1,
  env: 2,
  version: 3,
  disk: 4,
  quiet: 5,
  dryRunRefused: 6,
  assertion: 7,
  repack: 8,
  usage: 64,
};

const FLAGS_WITH_VALUE = new Set(["--env-file", "--disk-total-gb", "--image"]);
const BARE_FLAGS = new Set(["--prod", "--local", "--apply", "--dry-run", "--disk-ack"]);

export const USAGE =
  "usage: node scripts/fix1258-repack-entity-tags.mjs (--prod | --local) [--dry-run | --apply]\n" +
  "         [--env-file <path>] [--disk-total-gb <GB>] [--disk-ack] [--image civitics/pg_repack:<v>]\n" +
  "  --dry-run is the default. --apply on --prod requires --disk-total-gb and runs only\n" +
  "  as the --then of session:wait-for-gate:prod (it needs CIVITICS_PROD_SESSION_CLAIMANT):\n" +
  "    pnpm --filter @civitics/data session:wait-for-gate:prod --expected-minutes <N> --census stop \\\n" +
  "      --reason \"cc-244 FIX-1258 pg_repack entity_tags\" \\\n" +
  "      --then \"node ../../scripts/fix1258-repack-entity-tags.mjs --prod --apply --env-file ../../.env.local.prod --disk-total-gb <GB> --image civitics/pg_repack:<v>\"";

/**
 * Parse argv (without node + script). Returns { ok: true, ...opts } or
 * { ok: false, error, exitCode }. There is deliberately no --version-override:
 * the client version follows the server's default_version, read live.
 */
export function parseArgs(argv, env = {}) {
  const seen = new Map();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FLAGS_WITH_VALUE.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) return bad(`${a} needs a value`);
      seen.set(a, v);
      i++;
    } else if (BARE_FLAGS.has(a)) {
      seen.set(a, true);
    } else {
      return bad(`unknown argument ${JSON.stringify(a)}`);
    }
  }
  const prod = seen.has("--prod");
  const local = seen.has("--local");
  if (prod === local) return bad("exactly one of --prod or --local is required");
  const apply = seen.has("--apply");
  if (apply && seen.has("--dry-run")) return bad("--apply and --dry-run are exclusive");
  const target = prod ? "prod" : "local";

  const claimant = env.CIVITICS_PROD_SESSION_CLAIMANT ?? null;
  if (apply && prod && (claimant === null || String(claimant).trim() === "")) {
    return bad("--prod --apply runs only under a FIX-950 claim — run it as the --then of session:wait-for-gate:prod");
  }

  let diskTotalGb = null;
  if (seen.has("--disk-total-gb")) {
    diskTotalGb = Number(seen.get("--disk-total-gb"));
    if (!Number.isFinite(diskTotalGb) || diskTotalGb <= 0) return bad("--disk-total-gb must be a positive number of GB (1 GB = 1e9 bytes)");
  }
  if (apply && prod && diskTotalGb === null) return bad("--disk-total-gb is required with --prod --apply (the dashboard's / Prometheus' provisioned disk size)");

  const image = seen.has("--image") ? seen.get("--image") : null;
  if (image !== null && !/^[a-z0-9._/-]+:[A-Za-z0-9._-]+$/.test(image)) return bad(`--image ${JSON.stringify(image)} is not repo:tag`);

  return {
    ok: true,
    target,
    apply,
    dryRun: !apply,
    envFile: seen.get("--env-file") ?? null,
    diskTotalGb,
    diskAck: seen.has("--disk-ack"),
    image,
    claimant: prod ? claimant : null,
  };

  function bad(error) {
    return { ok: false, error, exitCode: EXIT.usage };
  }
}

/** `pg_repack 1.5.2` (or `pg_repack 1.5.2\n`) → "1.5.2"; anything else → null. */
export function parseClientVersion(output) {
  const m = String(output ?? "").match(/^\s*pg_repack\s+(\d+\.\d+\.\d+)\s*$/m);
  return m ? m[1] : null;
}

/** Exact match only — 1.5.2 ≠ 1.5.20 ≠ 1.5. */
export function versionMatches(clientOutput, serverDefaultVersion) {
  const v = parseClientVersion(clientOutput);
  return v !== null && typeof serverDefaultVersion === "string" && v === serverDefaultVersion.trim();
}

export function defaultImage(version) {
  return `${IMAGE_REPO}:${version}`;
}

/**
 * The connection the CONTAINER uses. Prod: the session pooler (IPv4), TLS
 * required. Local: Docker Desktop's host alias for the clone on 54322.
 */
export function containerConn(target, poolerUrl) {
  if (target === "local") {
    return { host: "host.docker.internal", port: "54322", user: "postgres", db: "postgres", sslmode: "disable" };
  }
  const u = new URL(poolerUrl);
  if (u.password) throw new Error("the pooler URL must not carry a password (it goes in PGPASSWORD)");
  return {
    host: u.hostname,
    port: u.port || "5432",
    user: decodeURIComponent(u.username),
    db: u.pathname.replace(/^\//, "") || "postgres",
    sslmode: "require",
  };
}

/** pg_repack's own flags (D-e). dryRun adds -N; the real run adds --elevel INFO. */
export function repackArgs(conn, { dryRun }) {
  return [
    "-k",
    ...(dryRun ? ["-N"] : ["--elevel", "INFO"]),
    "--no-order",
    "--jobs", "1",
    "--no-kill-backend",
    "--wait-timeout", "60",
    "--table", TABLE,
    "-d", conn.db,
    "-h", conn.host,
    "-p", conn.port,
    "-U", conn.user,
  ];
}

/**
 * `docker run` argv. The password is passed BY NAME (`-e PGPASSWORD`) so docker
 * copies it from the spawn env — it never appears on a command line. PGAPPNAME
 * likewise, so the census and pg_stat_activity can name the backends.
 */
export function dockerRunArgs(image, conn, args) {
  return ["run", "--rm", "-e", "PGPASSWORD", "-e", "PGAPPNAME", "-e", `PGSSLMODE=${conn.sslmode}`, image, "pg_repack", ...args];
}

export function dockerVersionArgs(image) {
  return ["run", "--rm", image, "pg_repack", "--version"];
}

/**
 * D-d. free = total − used, where used is the larger of pg_database_size and
 * the newest /data reading when one is given (WAL and temp files live on /data
 * and are not in pg_database_size). Bars against the table's TOTAL relation
 * size: ≥ 2× go; ≥ 1.25× ask (go only on Craig's word: --disk-ack); else stop.
 */
export function diskGate({ totalGb, dbSizeBytes, diskUsedBytes = null, totalRelBytes, ack = false }) {
  const totalBytes = totalGb * GB;
  const usedBytes = Math.max(dbSizeBytes, diskUsedBytes ?? 0);
  const freeBytes = totalBytes - usedBytes;
  const ratio = freeBytes / totalRelBytes;
  let verdict;
  if (ratio >= 2) verdict = "go";
  else if (ratio >= 1.25) verdict = ack ? "go" : "ask";
  else verdict = "stop";
  return { totalBytes, usedBytes, freeBytes, ratio, verdict };
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sortedKeys = (o) => Object.keys(o ?? {}).sort();

/**
 * D-c, part 1 — after the swap, before the tail. Returns { failures, indexSetWrong }.
 * A failure here is a REPORT, not a revert (there is none); the caller stops
 * the tail only when indexSetWrong.
 */
export function compareAfterSwap(before, after) {
  const failures = [];
  const fail = (m) => failures.push(m);

  if (after.count !== before.count) fail(`count(*) ${before.count} → ${after.count} (must be equal)`);

  let indexSetWrong = false;
  for (const name of sortedKeys(before.indexes)) {
    const a = after.indexes?.[name];
    if (!a) { fail(`index ${name} MISSING after`); indexSetWrong = true; continue; }
    if (a.def !== before.indexes[name].def) { fail(`index ${name} definition changed:\n      before ${before.indexes[name].def}\n      after  ${a.def}`); indexSetWrong = true; }
    if (a.valid !== true) { fail(`index ${name} indisvalid=${a.valid}`); indexSetWrong = true; }
  }
  for (const name of sortedKeys(after.indexes)) {
    if (!before.indexes?.[name]) { fail(`index ${name} is NEW after (not in the before set)`); indexSetWrong = true; }
  }

  if (!sameJson(before.reloptions ?? [], after.reloptions ?? [])) fail(`reloptions ${JSON.stringify(before.reloptions)} → ${JSON.stringify(after.reloptions)}`);
  if (!sameJson(before.policies, after.policies)) fail(`policies ${JSON.stringify(before.policies)} → ${JSON.stringify(after.policies)}`);
  if (!sameJson(before.statsExt, after.statsExt)) fail(`extended statistics ${JSON.stringify(before.statsExt)} → ${JSON.stringify(after.statsExt)}`);
  if (!sameJson(before.statTargets, after.statTargets)) fail(`column statistics targets ${JSON.stringify(before.statTargets)} → ${JSON.stringify(after.statTargets)}`);
  if (!sameJson(before.grants, after.grants)) fail(`grants ${JSON.stringify(before.grants)} → ${JSON.stringify(after.grants)}`);
  if (!sameJson(before.constraints, after.constraints)) fail(`constraints ${JSON.stringify(before.constraints)} → ${JSON.stringify(after.constraints)}`);
  if (after.oid !== before.oid) fail(`table OID ${before.oid} → ${after.oid} (pg_repack keeps the OID)`);

  if ((after.repackRelations ?? []).length > 0) fail(`repack.* relations left: ${after.repackRelations.join(", ")}`);
  if ((after.repackTriggers ?? []).length > 0) fail(`pg_repack triggers left on ${TABLE}: ${after.repackTriggers.join(", ")}`);
  if (!(after.relpages < before.relpages)) fail(`relpages ${before.relpages} → ${after.relpages} (must shrink)`);
  if (!(after.heapBytes < before.heapBytes)) fail(`pg_relation_size ${before.heapBytes} → ${after.heapBytes} (must shrink)`);
  if (after.relfilenode === before.relfilenode) fail(`relfilenode unchanged (${after.relfilenode}) — no swap happened`);

  return { failures, indexSetWrong };
}

/** D-c, part 2 — after the tail VACUUM (ANALYZE). */
export function compareAfterTail(afterSwap, afterTail) {
  const failures = [];
  if (afterTail.lastVacuum === null || afterTail.lastVacuum === afterSwap.lastVacuum) {
    failures.push(`last_vacuum did not move (${afterSwap.lastVacuum} → ${afterTail.lastVacuum})`);
  }
  const vis = afterTail.relpages > 0 ? afterTail.relallvisible / afterTail.relpages : 0;
  if (vis < 0.99) failures.push(`relallvisible/relpages ${afterTail.relallvisible}/${afterTail.relpages} = ${(vis * 100).toFixed(2)} % (< 99 %)`);
  if (afterTail.nDeadTup > 1000) failures.push(`n_dead_tup ${afterTail.nDeadTup} after the tail (expected ≈ 0, bar 1000)`);
  return { failures, visibleFraction: vis };
}

/**
 * D-f. The clone's real repack wall × the page ratio × 2 (prod is IOWait-bound,
 * the clone is warm NVMe) = the prod bracket; --expected-minutes = bracket ×
 * 1.5, clamped to [20, 60]. A bracket over 60 min is a stop-and-ask.
 */
export function prodBracket({ cloneWallS, prodRelpages, cloneRelpages }) {
  const pageRatio = prodRelpages / cloneRelpages;
  const bracketMin = (cloneWallS * pageRatio * 2) / 60;
  const expectedMinutes = Math.min(60, Math.max(20, Math.ceil(bracketMin * 1.5)));
  return { pageRatio, bracketMin, expectedMinutes, stop: bracketMin > 60 };
}

/** The documented cleanup after a pre-swap failure — PRINTED, never run (D-h). */
export function cleanupSql(oid) {
  return [
    `DROP TABLE IF EXISTS repack.table_${oid};`,
    `DROP TABLE IF EXISTS repack.log_${oid};`,
    `DROP TRIGGER IF EXISTS repack_trigger ON ${TABLE};`,
    `DROP TRIGGER IF EXISTS z_repack_trigger ON ${TABLE};`,
  ];
}
