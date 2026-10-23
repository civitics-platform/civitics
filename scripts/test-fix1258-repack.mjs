#!/usr/bin/env node
// test-fix1258-repack.mjs — FIX-1258 (cc-244)
//
// Fixture suite for scripts/lib/fix1258-repack.mjs, the pure parts of
// scripts/fix1258-repack-entity-tags.mjs. Dependency-free, no database, no
// docker — same shape as the other scripts/test-*.mjs suites. The clone
// rehearsal is the test of the SQL and of pg_repack itself; this covers the
// parts that decide whether anything runs at all.

import {
  EXIT, GB,
  parseArgs, parseClientVersion, versionMatches, defaultImage,
  containerConn, repackArgs, dockerRunArgs, dockerVersionArgs,
  diskGate, compareAfterSwap, compareAfterTail, prodBracket, cleanupSql,
} from "./lib/fix1258-repack.mjs";

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
}
const CLAIM = { CIVITICS_PROD_SESSION_CLAIMANT: "cc-244 FIX-1258 pg_repack entity_tags" };

console.log("fix1258 — the arg parser");
{
  const a = parseArgs(["--prod"], {});
  check("--prod alone is a dry run", a.ok && a.dryRun && !a.apply && a.target === "prod", JSON.stringify(a));
}
check("neither --prod nor --local is refused", parseArgs([], {}).ok === false);
check("both --prod and --local are refused", parseArgs(["--prod", "--local"], {}).ok === false);
{
  const a = parseArgs(["--local", "--apply", "--dry-run"], {});
  check("--apply and --dry-run are exclusive (exit 64)", !a.ok && a.exitCode === EXIT.usage && /exclusive/.test(a.error), JSON.stringify(a));
}
{
  const a = parseArgs(["--prod", "--apply", "--disk-total-gb", "56.95"], {});
  check("--prod --apply without the claimant env is refused (exit 64)", !a.ok && a.exitCode === 64 && /FIX-950 claim/.test(a.error), JSON.stringify(a));
}
{
  const a = parseArgs(["--prod", "--apply", "--disk-total-gb", "56.95"], { CIVITICS_PROD_SESSION_CLAIMANT: "  " });
  check("a blank claimant is no claimant", !a.ok && /FIX-950 claim/.test(a.error));
}
{
  const a = parseArgs(["--prod", "--apply"], CLAIM);
  check("--prod --apply requires --disk-total-gb", !a.ok && /--disk-total-gb is required/.test(a.error), JSON.stringify(a));
}
{
  const a = parseArgs(["--prod", "--apply", "--disk-total-gb", "56.95", "--env-file", "../../.env.local.prod", "--image", "civitics/pg_repack:1.5.2"], CLAIM);
  check("the full prod apply parses", a.ok && a.apply && a.diskTotalGb === 56.95 && a.image === "civitics/pg_repack:1.5.2" && a.claimant === CLAIM.CIVITICS_PROD_SESSION_CLAIMANT, JSON.stringify(a));
}
{
  const a = parseArgs(["--local", "--apply"], {});
  check("--local --apply needs no claimant and no disk size", a.ok && a.apply && a.target === "local" && a.claimant === null && a.diskTotalGb === null, JSON.stringify(a));
}
check("--disk-total-gb must be positive", parseArgs(["--local", "--disk-total-gb", "0"], {}).ok === false);
check("--disk-total-gb must be a number", parseArgs(["--local", "--disk-total-gb", "lots"], {}).ok === false);
check("a flag missing its value is refused", parseArgs(["--local", "--image"], {}).ok === false);
check("an unknown flag is refused", parseArgs(["--local", "--force"], {}).ok === false);
check("there is no --version-override", parseArgs(["--local", "--version-override", "1.5.3"], {}).ok === false);
check("a malformed --image is refused", parseArgs(["--local", "--image", "pg_repack latest"], {}).ok === false);

console.log("fix1258 — the version comparison");
check("parses `pg_repack 1.5.2`", parseClientVersion("pg_repack 1.5.2\n") === "1.5.2");
check("an unreadable banner parses to null", parseClientVersion("docker: Error response from daemon") === null);
check("1.5.2 = 1.5.2", versionMatches("pg_repack 1.5.2", "1.5.2"));
check("1.5.3 ≠ 1.5.2", !versionMatches("pg_repack 1.5.3", "1.5.2"));
check("1.5.20 ≠ 1.5.2 (exact, not prefix)", !versionMatches("pg_repack 1.5.20", "1.5.2"));
check("no server version never matches", !versionMatches("pg_repack 1.5.2", null));
check("the default image follows the server version", defaultImage("1.5.2") === "civitics/pg_repack:1.5.2");

console.log("fix1258 — the docker argv");
const POOLER = "postgresql://postgres.xsazcoxinpgttgquwvuf@aws-0-us-west-2.pooler.supabase.com:5432/postgres";
const SECRET = "s3cr3t-Pa55word";
{
  const c = containerConn("prod", POOLER);
  check("prod connects through the session pooler with TLS",
    c.host === "aws-0-us-west-2.pooler.supabase.com" && c.port === "5432" && c.user === "postgres.xsazcoxinpgttgquwvuf" && c.db === "postgres" && c.sslmode === "require", JSON.stringify(c));
  const real = dockerRunArgs("civitics/pg_repack:1.5.2", c, repackArgs(c, { dryRun: false }));
  const dry = dockerRunArgs("civitics/pg_repack:1.5.2", c, repackArgs(c, { dryRun: true }));
  const joined = [...real, ...dry, ...dockerVersionArgs("civitics/pg_repack:1.5.2")].join(" ");
  check("no password on the command line (asserted by string)", !joined.includes(SECRET) && !/PGPASSWORD=/.test(joined) && !/:[^@\s]+@/.test(joined), joined);
  check("PGPASSWORD is passed BY NAME", real.includes("-e") && real[real.indexOf("PGPASSWORD") - 1] === "-e");
  check("--rm, so no container is left behind", real[0] === "run" && real[1] === "--rm");
  check("the dry run carries -N, the real run does not", dry.includes("-N") && !real.includes("-N"));
  check("the real run carries --elevel INFO", real.join(" ").includes("--elevel INFO"));
  const tail = real.slice(real.indexOf("pg_repack") + 1).join(" ");
  check("scope: one table, -k, --no-order, --jobs 1, --no-kill-backend, --wait-timeout 60",
    tail.includes("--table public.entity_tags") && tail.includes("-k") && tail.includes("--no-order") &&
    tail.includes("--jobs 1") && tail.includes("--no-kill-backend") && tail.includes("--wait-timeout 60"), tail);
  check("never --all, never -a, never a second table", !/(^| )(-a|--all|--schema|-c)( |$)/.test(tail) && (tail.match(/--table/g) ?? []).length === 1, tail);
}
{
  let threw = false;
  try { containerConn("prod", POOLER.replace("@", `:${SECRET}@`)); } catch { threw = true; }
  check("a pooler URL carrying a password is refused", threw);
}
{
  const c = containerConn("local", null);
  check("local reaches the clone through host.docker.internal:54322, no TLS",
    c.host === "host.docker.internal" && c.port === "54322" && c.user === "postgres" && c.sslmode === "disable", JSON.stringify(c));
}

console.log("fix1258 — the disk gate");
const TOTAL_REL = 4637048832; // prod's pg_total_relation_size, cc-244 read 4
{
  const d = diskGate({ totalGb: 56.95, dbSizeBytes: 38890581139, diskUsedBytes: 40167645184, totalRelBytes: TOTAL_REL });
  check("prod tonight: 56.95 GB − 40.17 GB used = 3.6× → go", d.verdict === "go" && d.ratio > 3.5 && d.ratio < 3.7, JSON.stringify(d));
  check("used is the LARGER of pg_database_size and /data", d.usedBytes === 40167645184);
}
{
  const d = diskGate({ totalGb: 56.95, dbSizeBytes: 38890581139, diskUsedBytes: null, totalRelBytes: TOTAL_REL });
  check("no /data reading falls back to pg_database_size", d.usedBytes === 38890581139);
}
{
  const free = 1.5 * TOTAL_REL;
  const d = diskGate({ totalGb: (40e9 + free) / GB, dbSizeBytes: 40e9, totalRelBytes: TOTAL_REL });
  check("1.5× → ask", d.verdict === "ask", JSON.stringify(d));
  const a = diskGate({ totalGb: (40e9 + free) / GB, dbSizeBytes: 40e9, totalRelBytes: TOTAL_REL, ack: true });
  check("1.5× with --disk-ack → go", a.verdict === "go");
}
{
  const d = diskGate({ totalGb: 1, dbSizeBytes: 24e9, totalRelBytes: 2.27e9 });
  check("--disk-total-gb 1 on the clone → stop (negative free)", d.verdict === "stop" && d.freeBytes < 0, JSON.stringify(d));
  const near = diskGate({ totalGb: (40e9 + 1.2 * TOTAL_REL) / GB, dbSizeBytes: 40e9, totalRelBytes: TOTAL_REL, ack: true });
  check("< 1.25× is a stop even with --disk-ack", near.verdict === "stop");
}

console.log("fix1258 — the before/after comparator");
const BEFORE = {
  oid: 44155, relfilenode: 44155, count: 5443091, relpages: 226259, heapBytes: 1853513728,
  reloptions: ["autovacuum_vacuum_scale_factor=0.05", "autovacuum_analyze_scale_factor=0.02"],
  indexes: {
    entity_tags_pkey: { def: "CREATE UNIQUE INDEX entity_tags_pkey ON public.entity_tags USING btree (id)", valid: true },
    idx_entity_tags_tag: { def: "CREATE INDEX idx_entity_tags_tag ON public.entity_tags USING btree (tag, tag_category)", valid: true },
  },
  policies: { public_read_tags: { cmd: "r", roles: ["anon", "authenticated"], qual: "true", check: null } },
  statsExt: { entity_tags_type_cat_tag: { kind: ["f", "m"], keys: "2 4 5" } },
  statTargets: { tag: 1000 },
  grants: { anon: "SELECT", postgres: "DELETE,INSERT,SELECT,UPDATE" },
  constraints: { entity_tags_pkey: "PRIMARY KEY (id)" },
  repackRelations: [], repackTriggers: [],
  lastVacuum: null,
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const CLEAN_AFTER = { ...clone(BEFORE), relfilenode: 9123456, relpages: 131759, heapBytes: 1079369728 };
{
  const r = compareAfterSwap(BEFORE, CLEAN_AFTER);
  check("the clean pair PASSES", r.failures.length === 0 && !r.indexSetWrong, JSON.stringify(r.failures));
}
{
  const a = clone(CLEAN_AFTER); delete a.indexes.idx_entity_tags_tag;
  const r = compareAfterSwap(BEFORE, a);
  check("a dropped index FAILS and marks the index set wrong (the tail stops)", r.failures.some((f) => /idx_entity_tags_tag MISSING/.test(f)) && r.indexSetWrong, JSON.stringify(r));
}
{
  const a = clone(CLEAN_AFTER); a.indexes.idx_entity_tags_tag.valid = false;
  const r = compareAfterSwap(BEFORE, a);
  check("an invalid index FAILS and marks the index set wrong", r.indexSetWrong && r.failures.some((f) => /indisvalid=false/.test(f)));
}
{
  const a = clone(CLEAN_AFTER); a.indexes.idx_entity_tags_tag.def = a.indexes.idx_entity_tags_tag.def.replace("(tag, tag_category)", "(tag)");
  const r = compareAfterSwap(BEFORE, a);
  check("a changed index definition FAILS (byte-equal, not similar)", r.indexSetWrong && r.failures.some((f) => /definition changed/.test(f)));
}
{
  const a = clone(CLEAN_AFTER); a.reloptions = ["autovacuum_vacuum_scale_factor=0.2", "autovacuum_analyze_scale_factor=0.02"];
  const r = compareAfterSwap(BEFORE, a);
  check("a changed reloption FAILS but leaves the index set right (the tail still runs)", r.failures.some((f) => /reloptions/.test(f)) && !r.indexSetWrong, JSON.stringify(r));
}
{
  const a = clone(CLEAN_AFTER); a.repackRelations = ["repack.log_123"];
  const r = compareAfterSwap(BEFORE, a);
  check("a leftover repack.log_123 FAILS", r.failures.some((f) => /repack\.log_123/.test(f)));
}
{
  const a = clone(CLEAN_AFTER); a.repackTriggers = ["repack_trigger"];
  check("a leftover repack_trigger FAILS", compareAfterSwap(BEFORE, a).failures.some((f) => /repack_trigger/.test(f)));
}
{
  const a = clone(CLEAN_AFTER); a.count = BEFORE.count - 1;
  check("count(*) off by one FAILS", compareAfterSwap(BEFORE, a).failures.some((f) => /count/.test(f)));
}
{
  const a = clone(CLEAN_AFTER); a.policies = {};
  check("a lost policy FAILS", compareAfterSwap(BEFORE, a).failures.some((f) => /policies/.test(f)));
}
{
  const a = clone(CLEAN_AFTER); a.statsExt = {};
  check("lost extended statistics FAIL", compareAfterSwap(BEFORE, a).failures.some((f) => /extended statistics/.test(f)));
}
{
  const a = clone(CLEAN_AFTER); a.statTargets = {};
  check("a reset statistics target FAILS", compareAfterSwap(BEFORE, a).failures.some((f) => /statistics targets/.test(f)));
}
{
  const a = clone(CLEAN_AFTER); a.grants = { anon: "SELECT" };
  check("a lost grant FAILS", compareAfterSwap(BEFORE, a).failures.some((f) => /grants/.test(f)));
}
{
  const a = clone(CLEAN_AFTER); a.relpages = BEFORE.relpages; a.heapBytes = BEFORE.heapBytes;
  const r = compareAfterSwap(BEFORE, a);
  check("a heap that did not shrink FAILS", r.failures.some((f) => /relpages/.test(f)) && r.failures.some((f) => /pg_relation_size/.test(f)));
}
{
  const a = clone(CLEAN_AFTER); a.relfilenode = BEFORE.relfilenode;
  check("an unchanged relfilenode FAILS (no swap)", compareAfterSwap(BEFORE, a).failures.some((f) => /no swap/.test(f)));
}
{
  const a = clone(CLEAN_AFTER); a.indexes.brand_new = { def: "CREATE INDEX brand_new ON public.entity_tags USING btree (tag)", valid: true };
  check("an index that appeared FAILS", compareAfterSwap(BEFORE, a).indexSetWrong);
}

console.log("fix1258 — the tail");
{
  const t = compareAfterTail({ lastVacuum: null }, { lastVacuum: "2026-10-24T00:59:00Z", relpages: 131759, relallvisible: 131759, nDeadTup: 0 });
  check("a moved last_vacuum, 100 % all-visible, 0 dead PASSES", t.failures.length === 0 && t.visibleFraction === 1, JSON.stringify(t));
}
{
  const t = compareAfterTail({ lastVacuum: null }, { lastVacuum: null, relpages: 131759, relallvisible: 131759, nDeadTup: 0 });
  check("last_vacuum still NULL FAILS", t.failures.some((f) => /last_vacuum/.test(f)));
}
{
  const t = compareAfterTail({ lastVacuum: null }, { lastVacuum: "x", relpages: 131759, relallvisible: 100000, nDeadTup: 0 });
  check("all-visible below 99 % FAILS", t.failures.some((f) => /relallvisible/.test(f)));
}
{
  const t = compareAfterTail({ lastVacuum: null }, { lastVacuum: "x", relpages: 131759, relallvisible: 131759, nDeadTup: 50000 });
  check("50k dead after the tail FAILS", t.failures.some((f) => /n_dead_tup/.test(f)));
}

console.log("fix1258 — sizing (D-f) and the printed cleanup");
{
  const b = prodBracket({ cloneWallS: 300, prodRelpages: 226259, cloneRelpages: 108719 });
  check("5 min on the clone × 2.08 × 2 = 20.8 min bracket → 32 min expected", Math.abs(b.bracketMin - 20.81) < 0.05 && b.expectedMinutes === 32 && !b.stop, JSON.stringify(b));
}
check("a tiny bracket clamps to 20 min", prodBracket({ cloneWallS: 30, prodRelpages: 2, cloneRelpages: 1 }).expectedMinutes === 20);
{
  const b = prodBracket({ cloneWallS: 1000, prodRelpages: 226259, cloneRelpages: 108719 });
  check("a bracket over 60 min is a stop-and-ask, clamped to 60", b.stop && b.expectedMinutes === 60, JSON.stringify(b));
}
{
  const s = cleanupSql(44155).join("\n");
  check("the cleanup names repack.table_<oid>, repack.log_<oid> and both triggers",
    s.includes("repack.table_44155") && s.includes("repack.log_44155") && s.includes("repack_trigger") && s.includes("z_repack_trigger"), s);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
