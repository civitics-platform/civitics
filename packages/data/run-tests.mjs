// Discovers and runs every `src/**/*.test.ts` suite via tsx's node:test integration.
//
// Why a runner instead of `tsx --test "src/**/*.test.ts"`: the glob-pattern form
// of node's --test was added in Node v21. CI pins Node 20 (see tests.yml), where
// a literal "src/**/*.test.ts" arg matches nothing and the suite silently passes
// with zero tests. readdirSync({recursive}) (stable since v20.1) discovers files
// the same way on every supported Node and on both Windows (local) and Linux (CI).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pkgDir = fileURLToPath(new URL(".", import.meta.url));
const srcDir = join(pkgDir, "src");

const files = readdirSync(srcDir, { recursive: true })
  .filter((f) => typeof f === "string" && f.endsWith(".test.ts"))
  .map((f) => join("src", f))
  .sort();

if (files.length === 0) {
  console.error("No *.test.ts files found under src/ — refusing to pass an empty test run.");
  process.exit(1);
}

console.log(`Running ${files.length} test file(s):`);
for (const f of files) console.log(`  ${f}`);

// FIX-1263: the opt-in DB-heavy run (CIVITICS_DB_HEAVY_TESTS=1) serialises test
// FILES. node --test runs each file in its own child process, concurrently by
// default, and several heavy files hold advisory keys that prod_session_state()
// reads cluster-wide (entity_connections_rebuild, prod_supervised_session, the
// rollup refresh keys) — so one file's lock made another file's prod-session
// claim refuse. The default run stays concurrent: the EC test's key-holding
// cases moved behind the heavy gate, as did pipeline-lock.test.ts's
// fec_bulk_pipeline cases (FIX-1267) and prod-session.test.ts's writers-live
// case, which takes financial_entity_totals_refresh (FIX-1275). No default-run
// test holds a c_writer_locks key now. The writers-live proof runs only under
//   CIVITICS_DB_HEAVY_TESTS=1 pnpm --filter @civitics/data test
//
// FIX-1388: the same class, the other way round. A file naming
// CIVITICS_CLONE_TESTS is clone-class: it shares the local clone's lock, label
// and hold rows, and a transaction does not isolate them. pg_locks is visible
// across dispatcher-r9's open BEGIN, so a real claim in prod-session.test.ts
// read as `gated: prod_session` there, 1–3 failures per run; the tick's FIX-1337
// sweep then held the claim test's hold rows until r9's ROLLBACK. So the run has
// two passes: everything else concurrently, then those files one at a time. Both
// always run, and the exit is the first failure. The list is read from the
// files, so a new clone-gated file joins it by naming the variable. Every run
// takes both passes. Without the variable the clone cases skip, so the serial
// pass costs little, and CI (no database) exercises the runner the same way.
const heavy = process.env.CIVITICS_DB_HEAVY_TESTS === "1";

function runPass(args) {
  const res = spawnSync("tsx", ["--test", ...args], {
    stdio: "inherit",
    // tsx resolves from node_modules/.bin (pnpm puts it on PATH); shell:true is
    // required on Windows to find the .cmd shim, harmless on POSIX.
    shell: process.platform === "win32",
  });
  return res.status ?? 1;
}

if (heavy) {
  console.log("CIVITICS_DB_HEAVY_TESTS=1 — running files serially (--test-concurrency=1)");
  process.exit(runPass(["--test-concurrency=1", ...files]));
}

const cloneClass = files.filter((f) => readFileSync(join(pkgDir, f), "utf8").includes("CIVITICS_CLONE_TESTS"));
const concurrent = files.filter((f) => !cloneClass.includes(f));

// An empty list must not reach tsx: `--test` with no files discovers its own.
console.log(`\n── pass 1 of 2: ${concurrent.length} file(s), concurrent`);
const first = concurrent.length > 0 ? runPass(concurrent) : 0;
console.log(`\n── pass 2 of 2: ${cloneClass.length} clone-class file(s), serial (FIX-1388)`);
const second = cloneClass.length > 0 ? runPass(["--test-concurrency=1", ...cloneClass]) : 0;

process.exit(first || second);
