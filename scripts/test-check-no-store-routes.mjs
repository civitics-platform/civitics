#!/usr/bin/env node
// test-check-no-store-routes.mjs — FIX-1214
//
// Fixture suite for scripts/check-no-store-routes.mjs (the predicate is
// scripts/lib/no-store-routes.mjs). Dependency-free, no database, same shape
// as test-check-proconfig.mjs. Fixture names end _fails / _passes /
// _out_of_scope; a `.helper.txt` fixture is scanned as an app/api/ helper
// rather than a route.ts.
//
// The wrong-but-green shapes (rule 105) are the point: a `no-store` on the
// RESPONSE (03), a `no-store` on an unrelated fetch (04), a noStoreFetch that
// exists only in a comment (12), an exemption with no reason (08).

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifySource, scanApp } from "./lib/no-store-routes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "no-store-routes");

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
}

console.log("check:no-store-routes — fixtures");

const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".txt")).sort();
check("the fixture set is present", files.length >= 14, `found ${files.length}`);

for (const f of files) {
  const r = classifySource(readFileSync(join(FIXTURES, f), "utf8"), { isRoute: !f.endsWith(".helper.txt") });
  const detail = JSON.stringify(r);
  if (f.includes("_out_of_scope")) check(`${f} is out of scope`, r.inScope === false, detail);
  else if (f.includes("_passes")) check(`${f} PASSES`, r.inScope === true && r.ok === true, detail);
  else if (f.includes("_fails")) check(`${f} FAILS`, r.inScope === true && r.ok === false, detail);
  else check(`${f} is named _fails / _passes / _out_of_scope`, false);
}

// The escape each passing fixture takes is the one it was written for.
{
  const esc = (f) => classifySource(readFileSync(join(FIXTURES, f), "utf8"), { isRoute: true }).escape;
  check("02 passes by noStoreFetch", esc("02_nostorefetch_passes.txt") === "noStoreFetch");
  check("06 passes as request-bound", esc("06_cookies_passes.txt") === "request-bound");
  check("07 passes by exemption", esc("07_exempt_passes.txt") === "exempt");
}

// The GET+POST reason names the mechanism, so the audit output says why.
{
  const r = classifySource(readFileSync(join(FIXTURES, "09_get_post_out_of_scope.txt"), "utf8"), { isRoute: true });
  check("09's reason names the module-level revalidate", /POST.*revalidate 0/.test(r.why), r.why);
}

console.log("check:no-store-routes — the live tree");
{
  const ROOT = join(HERE, "..");
  const results = scanApp(join(ROOT, "apps", "civitics", "app"), ROOT);
  const bad = results.filter((r) => !r.ok).map((r) => r.file);
  check("apps/civitics/app has in-scope files", results.length > 0, `got ${results.length}`);
  check("…and none is unprotected", bad.length === 0, bad.join(", "));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
