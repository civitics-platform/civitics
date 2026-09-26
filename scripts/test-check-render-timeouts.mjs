#!/usr/bin/env node
// test-check-render-timeouts.mjs — FIX-1227
//
// Fixture suite for check-render-timeouts.mjs's second rule: a `revalidate`
// page that reads through withDbTimeout must call assertRenderNotDegraded().
// Dependency-free, same shape as the other scripts/test-*.mjs suites. The
// wrong-but-green shapes (rule 105) are the ones a lexical check could be
// fooled by: the helper named only in a comment, `revalidate` only in a
// comment, an opt-out with no reason.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { degradedHelperOffence } from "./check-render-timeouts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
}

const READ = `const { data } = await withDbTimeout(sb.from("t").select("x"), 3000, "p:t");\n`;
const HEADER = `export const revalidate = 300;\n`;

console.log("check:render-timeouts rule 2 — fixtures");

check("a revalidate page that reads and never calls the helper FAILS",
  degradedHelperOffence(HEADER + READ) !== null);
check("…the generic-typed call form counts as a read",
  degradedHelperOffence(HEADER + `await withDbTimeout<{ data: X }>(q, 3000, "p");\n`) !== null);
check("…and so does withDbTimeoutValue",
  degradedHelperOffence(HEADER + `await withDbTimeoutValue(p, 2000, "p");\n`) !== null);
check("calling the helper PASSES",
  degradedHelperOffence(HEADER + READ + `assertRenderNotDegraded();\n`) === null);
check("the helper named only in a comment still FAILS",
  degradedHelperOffence(HEADER + READ + `// TODO: assertRenderNotDegraded();\n`) !== null);
check("`revalidate` only in a comment is not a revalidate page",
  degradedHelperOffence(`// export const revalidate = 300;\n` + READ) === null);
check("a force-dynamic page (no revalidate) is out of scope",
  degradedHelperOffence(`export const dynamic = "force-dynamic";\n` + READ) === null);
check("a revalidate page with no withDbTimeout read is out of scope",
  degradedHelperOffence(HEADER + `export default function P() { return null; }\n`) === null);
check("`// degraded-ok: <reason>` PASSES",
  degradedHelperOffence(HEADER + READ + `// degraded-ok: static reference data, a stale empty list is fine\n`) === null);
check("`// degraded-ok:` with no reason still FAILS",
  degradedHelperOffence(HEADER + READ + `// degraded-ok:\nconst x = 1;\n`) !== null);

console.log("check:render-timeouts rule 2 — the live tree");
{
  const APP = join(HERE, "..", "apps", "civitics", "app");
  const pages = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) { if (n !== "api" && n !== "node_modules") walk(p); }
      else if (n === "page.tsx") pages.push(p);
    }
  };
  walk(APP);
  const scoped = pages.filter((p) => /\bexport\s+const\s+revalidate\s*=\s*\d+/.test(readFileSync(p, "utf8")));
  check("the 12 revalidate pages are found", scoped.length >= 12, `found ${scoped.length}`);
  const bad = scoped.filter((p) => degradedHelperOffence(readFileSync(p, "utf8")) !== null);
  check("…and every one calls the helper", bad.length === 0, bad.join(", "));
  // Each one would fail without it — the rule is not passing by accident.
  const bites = scoped.filter((p) => {
    const stripped = readFileSync(p, "utf8").replace(/\bassertRenderNotDegraded\s*\(\s*\)\s*;?/g, "");
    return degradedHelperOffence(stripped) !== null;
  });
  check("…and each FAILS with the helper removed", bites.length === scoped.length, `${bites.length}/${scoped.length}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
