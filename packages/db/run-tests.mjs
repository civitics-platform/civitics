// Discovers and runs every `src/**/*.test.ts` suite via tsx's node:test integration.
//
// Byte-for-byte the same discovery as packages/data/run-tests.mjs and
// apps/civitics/run-tests.mjs: the glob form of node's --test needs Node 21, CI
// pins Node 20, and a literal glob there matches nothing and passes with zero
// tests. readdirSync({recursive}) behaves identically on every supported Node
// and on Windows + CI Linux.
//
// FIX-1038 added the first suite here (upstash-usage). Before that this package
// had no runner at all, which is why nothing in packages/db was covered.
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

const res = spawnSync("tsx", ["--test", ...files], {
  stdio: "inherit",
  // tsx resolves from node_modules/.bin (pnpm puts it on PATH); shell:true is
  // required on Windows to find the .cmd shim, harmless on POSIX.
  shell: process.platform === "win32",
});

process.exit(res.status ?? 1);
