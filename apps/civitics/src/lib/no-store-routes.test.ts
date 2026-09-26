/**
 * FIX-1214 — every GET admin-client read path is no-store, anchored by source.
 *
 * box-health-route.test.ts pins ONE route's `createAdminClient({ fetch:
 * noStoreFetch })`. This pins every route the defect can reach, and it derives
 * that list with the same predicate the CI guard uses
 * (scripts/lib/no-store-routes.mjs), so a new GET route cannot slip between a
 * hand-kept list and the tree. The mechanism — why a supabase-js read in a GET
 * Route Handler is Data-Cached for a year even under force-dynamic, and which
 * calls lower `revalidate` to 0 first — is in that module's header.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { classifySource, scanApp } from "../../../../scripts/lib/no-store-routes.mjs";

const APP = join(__dirname, "..", "..", "app");
const routes = scanApp(APP) as Array<{
  file: string;
  calls: number;
  noStoreCalls: number;
  ok: boolean;
  escape: string | null;
}>;

test("FIX-1214: the derived set is the one cc-161 read 2 measured, not an empty walk", () => {
  const files = routes.map((r) => r.file);
  for (const f of [
    "api/graph/chord/route.ts",
    "api/browse/execute.ts",
    "api/cron/nightly-sync/route.ts",
    "api/cron/notify-followers/route.ts",
    "api/cron/platform-snapshot/route.ts",
    "api/cron/front-door-watch/route.ts",
  ]) {
    assert.ok(files.includes(f), `${f} is in scope`);
  }
  assert.ok(routes.length >= 46, `46 in scope at cc-161, got ${routes.length}`);
});

test("FIX-1214: every in-scope GET read path is protected", () => {
  const bare = routes.filter((r) => !r.ok).map((r) => `${r.file} (${r.noStoreCalls}/${r.calls} no-store)`);
  assert.deepEqual(bare, [], "createAdminClient({ fetch: noStoreFetch }) on every call, or a request-bound call, or `// no-store-exempt:`");
});

test("FIX-1214: the non-noStoreFetch escapes are exactly the reviewed ones", () => {
  const other = routes
    .filter((r) => r.escape !== "noStoreFetch")
    .map((r) => `${r.escape} ${r.file}`)
    .sort();
  assert.deepEqual(other, [
    // cookies() precedes the first admin read in each (cc-161 read 2)
    "request-bound api/admin/enrichment/pending/route.ts",
    "request-bound api/admin/kill-switches/recent/route.ts",
    "request-bound api/graph/my-representatives/route.ts",
    // getIp(request) reads request.headers on Next's tracking proxy first
    "exempt api/claude/status/core/route.ts",
    "exempt api/claude/status/quality/route.ts",
    "exempt api/claude/status/route.ts",
  ].sort());
});

test("FIX-1214: a module exporting a non-static method is out of scope; PUT is not one", () => {
  const get = "export async function GET() { const db = createAdminClient(); }\n";
  assert.equal(classifySource(get + "export async function POST() {}", { isRoute: true }).inScope, false);
  assert.equal(classifySource(get + "export async function PATCH() {}", { isRoute: true }).inScope, false);
  assert.equal(classifySource(get + "export async function PUT() {}", { isRoute: true }).inScope, true);
});
