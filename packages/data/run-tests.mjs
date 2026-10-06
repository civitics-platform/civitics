// Discovers and runs every `src/**/*.test.ts` suite via tsx's node:test integration.
//
// Why a runner instead of `tsx --test "src/**/*.test.ts"`: the glob-pattern form
// of node's --test was added in Node v21. CI pins Node 20 (see tests.yml), where
// a literal "src/**/*.test.ts" arg matches nothing and the suite silently passes
// with zero tests. readdirSync({recursive}) (stable since v20.1) discovers files
// the same way on every supported Node and on both Windows (local) and Linux (CI).
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const srcDir = fileURLToPath(new URL("./src", import.meta.url));

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
// The default run still has two prod_supervised_session claimers in
// prod-session.test.ts. They hold no writer key. Their risk is the
// FIX-1263 class, being refused by another file's writer key, and no
// default-run file holds one now.
const heavy = process.env.CIVITICS_DB_HEAVY_TESTS === "1";
if (heavy) console.log("CIVITICS_DB_HEAVY_TESTS=1 — running files serially (--test-concurrency=1)");

const res = spawnSync("tsx", ["--test", ...(heavy ? ["--test-concurrency=1"] : []), ...files], {
  stdio: "inherit",
  // tsx resolves from node_modules/.bin (pnpm puts it on PATH); shell:true is
  // required on Windows to find the .cmd shim, harmless on POSIX.
  shell: process.platform === "win32",
});

process.exit(res.status ?? 1);
