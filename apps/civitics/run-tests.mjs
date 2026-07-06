// Discovers and runs every `src/**/*.test.ts` suite via tsx's node:test integration.
//
// Mirrors packages/data/run-tests.mjs (same Node-20-safe discovery): the glob form
// of node's --test needs Node 21, and CI pins 20, where a literal glob matches
// nothing and the suite silently passes with zero tests. readdirSync({recursive})
// discovers files identically on every supported Node and on Windows + CI Linux.
//
// FIX-749 — the browse registry / scope compiler / cursor codec / BrowseState
// (de)serialization are pure (no next/*), so they run here under tsx --test.
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
  shell: process.platform === "win32",
});

process.exit(res.status ?? 1);
