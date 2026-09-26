#!/usr/bin/env node
// scripts/check-no-store-routes.mjs — FIX-1214 CI guard
//
// Flags a GET Route Handler (or an app/api/ helper) whose admin-client reads
// Next 14 can answer from its Data Cache: a supabase-js read from a GET handler
// is "auto cache" with revalidate false — a one-year entry — even under
// `dynamic = "force-dynamic"`, unless something earlier in the request lowered
// revalidate to 0. The cron-watchdog route answered from one cached payload for
// 17 h that way (FIX-1208); cc-146 then found 36 more routes of the same shape
// (FIX-1214) and cc-161 read 4 measured one live on prod: two calls to
// /api/graph/chord, zero gateway requests.
//
// The predicate — what is in scope, what counts as protection, and the Next
// source it rests on — lives in scripts/lib/no-store-routes.mjs, shared with
// the app's source-anchored test. In short: every createAdminClient( call is
// createAdminClient({ fetch: noStoreFetch }), or the file makes a request-bound
// call (cookies() / headers() / noStore()), or it carries
// `// no-store-exempt: <reason>`. A bare `no-store` string is NOT an escape.
//
// Modes:
//   node scripts/check-no-store-routes.mjs          → check, exit 1 on offenders
//   node scripts/check-no-store-routes.mjs --audit  → every in-scope file + its escape

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanApp } from "./lib/no-store-routes.mjs";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const APP = join(ROOT, "apps", "civitics", "app");

const results = scanApp(APP, ROOT);

if (process.argv.includes("--audit")) {
  console.log("file | admin calls | noStoreFetch calls | escape");
  for (const r of results) console.log(`${r.file} | ${r.calls} | ${r.noStoreCalls} | ${r.escape ?? "NONE"}`);
  console.log(`\n${results.length} in-scope file(s).`);
  process.exit(0);
}

const offenders = results.filter((r) => !r.ok);
if (offenders.length === 0) {
  console.log(`check:no-store-routes — OK (${results.length} GET admin-client read paths scanned, 0 unprotected)`);
  process.exit(0);
}

console.error(`check:no-store-routes — ${offenders.length} unprotected GET admin-client read path(s):\n`);
for (const r of offenders) {
  console.error(`  ${r.file}  (${r.noStoreCalls}/${r.calls} createAdminClient calls pass noStoreFetch)`);
}
console.error(
  [
    "",
    "Next 14 caches a supabase-js read made from a GET Route Handler for a year,",
    "even under force-dynamic, unless something earlier in the request lowered",
    "revalidate to 0. Build the client as createAdminClient({ fetch: noStoreFetch })",
    "(import noStoreFetch from @civitics/db) — or, if a 5-minute/1-year cache is",
    "genuinely this route's design, add `// no-store-exempt: <reason>`.",
    "Mechanism: scripts/lib/no-store-routes.mjs.",
  ].join("\n"),
);
process.exit(1);
