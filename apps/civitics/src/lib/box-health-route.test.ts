/**
 * FIX-1125 — /api/cron/box-health, anchored by source.
 *
 * The route is a thin wrapper around runBoxHealth() (packages/db), whose every
 * branch is tested there with a fake fetch. What only THIS file can get wrong
 * is the wiring, so the wiring is what is pinned:
 *
 *   - rule 171 / FIX-1208: Next 14 Data-Caches an identical-body POST made from
 *     a GET Route Handler even under force-dynamic, so no fetch in the route may
 *     be a plain `fetch`. The store gets noStoreFetch and so does the admin
 *     client. There is no bare `fetch(` anywhere in the file.
 *   - the cron-watchdog template: force-dynamic, maxDuration 30, CRON_DISABLED,
 *     an inline CRON_SECRET check, and the client built lazily inside the try.
 *   - vercel.json schedules it at 2-minute cadence, next to cron-watchdog.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROUTE = readFileSync(join(__dirname, "..", "..", "app", "api", "cron", "box-health", "route.ts"), "utf8");
const VERCEL = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "vercel.json"), "utf8"),
) as { crons: Array<{ path: string; schedule: string }> };

/** The route's code, comments stripped, so prose cannot satisfy or trip an anchor. */
const CODE = ROUTE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("FIX-1125: every fetch in the route is no-store (rule 171) — no bare fetch(", () => {
  assert.doesNotMatch(CODE, /(?<![\w.])fetch\(/, "a bare fetch( call");
  assert.match(CODE, /fetchImpl: noStoreFetch/);
  assert.match(CODE, /createAdminClient\(\{ fetch: noStoreFetch \}\)/);
  assert.equal((CODE.match(/createAdminClient\(/g) ?? []).length, 1);
});

test("FIX-1125: the cron-watchdog template — dynamic, bounded, killable, authenticated, lazy", () => {
  assert.match(CODE, /export const dynamic = "force-dynamic";/);
  assert.match(CODE, /export const maxDuration = 30;/);
  assert.match(CODE, /process\.env\["CRON_DISABLED"\] === "true"/);
  assert.match(CODE, /authHeader !== expected/);
  assert.match(CODE, /status: 401/);
  const tryAt = CODE.indexOf("try {");
  assert.ok(tryAt > 0 && CODE.indexOf('await import("@civitics/db")') > tryAt, "the client is built inside the try");
  assert.doesNotMatch(CODE, /status: 5\d\d/, "answers 200 on failure");
});

test("FIX-1125: the on-box stamp is the DEFINER RPC, raced, and cannot fail the route", () => {
  assert.match(CODE, /db\.rpc\("record_box_health_mem", \{ p: sample \}\)/);
  assert.match(CODE, /withDbTimeout\(/);
  assert.doesNotMatch(CODE, /data_sync_log/, "no breadcrumb row at 720/day");
});

test("FIX-1125: vercel.json fires it every 2 minutes", () => {
  const c = VERCEL.crons.find((x) => x.path === "/api/cron/box-health");
  assert.ok(c, "scheduled");
  assert.equal(c!.schedule, "*/2 * * * *");
});
