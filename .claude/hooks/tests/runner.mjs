// Pipe-tests compound-allow-hook.mjs against the case files in ./cases.
// allow-*.txt must produce a permissionDecision:"allow"; defer-*.txt must
// produce no output (hook exits 0 silently → normal permission flow).
// Run: node .claude/hooks/tests/runner.mjs
// Add a case: drop a .txt file in cases/ named for the expected verdict.
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, "..", "compound-allow-hook.mjs");
const casesDir = join(here, "cases");

let pass = 0, fail = 0;
for (const f of readdirSync(casesDir).sort()) {
  const cmd = readFileSync(join(casesDir, f), "utf8").replace(/\r\n/g, "\n").trimEnd();
  const input = JSON.stringify({ tool_name: "Bash", tool_input: { command: cmd } });
  const res = spawnSync("node", [HOOK], { input, encoding: "utf8", timeout: 15000 });
  const out = (res.stdout || "").trim();
  const allowed = out.includes('"permissionDecision":"allow"') || out.includes('"permissionDecision": "allow"');
  const expectAllow = f.startsWith("allow-");
  const ok = expectAllow === allowed && res.status === 0;
  console.log(`${ok ? "PASS" : "FAIL"}  ${f}  (expected ${expectAllow ? "allow" : "defer"}, got ${allowed ? "allow" : "defer"}${res.status !== 0 ? `, exit=${res.status}` : ""})`);
  if (!ok && res.stderr) console.log(`      stderr: ${res.stderr.slice(0, 300)}`);
  ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
