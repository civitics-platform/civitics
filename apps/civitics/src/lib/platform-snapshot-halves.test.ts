/**
 * FIX-1292 R7 — the platform-snapshot route's two halves on separate crons,
 * anchored by source.
 *
 * cc-203 found the half-hour swap-in burst follows the route's FIRING but no
 * Postgres statement in it. R7 asked which half carries it, so for 24 h the
 * usage half (vendor APIs + the alert passes) fired at 7,37 and the status
 * half (writeStatusSnapshot alone) at 22,52, 15 minutes apart. cc-216 read the
 * verdict (B, the status half) and put the single parent entry back. What this
 * pins:
 *
 *   - vercel.json carries the parent every 30 minutes and NEITHER half entry, so
 *     the route fires once per half hour with both halves in the pre-split order.
 *     The 10-minute gha-dispatch entry for platform-snapshot.yml is a different
 *     workflow and is left alone.
 *   - each half route stays thin: dynamic, maxDuration, and a GET that hands the
 *     request to the shared runner with its half. No cron fires them; they are
 *     kept for FIX-1292's fix.
 *   - the parent route runs both halves, so the revert is one vercel.json
 *     edit and a plain hit behaves as before the split.
 *   - the runner gates each write on the half, and the alert passes read the
 *     usage outcome only (D2).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const APP = join(__dirname, "..", "..");
const DIR = join(APP, "app", "api", "cron", "platform-snapshot");
const VERCEL = JSON.parse(readFileSync(join(APP, "vercel.json"), "utf8")) as {
  crons: Array<{ path: string; schedule: string }>;
};

/** A file's code with comments stripped, so prose cannot satisfy or trip an anchor. */
function code(path: string): string {
  assert.ok(existsSync(path), `${path} exists`);
  return readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

test("FIX-1292 R7: vercel.json fires the parent at */30 and neither half (cc-216's revert)", () => {
  const at = (p: string) => VERCEL.crons.filter((c) => c.path === p).map((c) => c.schedule);
  assert.deepEqual(at("/api/cron/platform-snapshot"), ["*/30 * * * *"], "the single parent entry is back");
  assert.deepEqual(at("/api/cron/platform-snapshot/usage"), [], "the usage half has no cron after R7");
  assert.deepEqual(at("/api/cron/platform-snapshot/status"), [], "the status half has no cron after R7");
  assert.deepEqual(at("/api/cron/gha-dispatch/platform-snapshot"), ["*/10 * * * *"], "the dispatcher is untouched");
});

for (const half of ["usage", "status"] as const) {
  test(`FIX-1292 R7: the ${half} route is thin — dynamic, bounded, and the shared runner with half "${half}"`, () => {
    const c = code(join(DIR, half, "route.ts"));
    assert.match(c, /export const dynamic = "force-dynamic";/);
    assert.match(c, /export const maxDuration = 300;/);
    assert.match(c, /export async function GET\(request: NextRequest\)/);
    assert.match(c, new RegExp(`return runPlatformSnapshot\\(request, \\{ half: "${half}" \\}\\);`));
    assert.doesNotMatch(c, /createAdminClient\(|writePlatformUsageSnapshot|writeStatusSnapshot/, "no work of its own");
  });
}

test("FIX-1292 R7: the parent route still runs both halves", () => {
  const c = code(join(DIR, "route.ts"));
  assert.match(c, /export const dynamic = "force-dynamic";/);
  assert.match(c, /return runPlatformSnapshot\(request, \{ half: "both" \}\);/);
});

test("FIX-1292 R7: the runner gates each write on its half; the alert passes read the usage outcome only", () => {
  const c = code(join(DIR, "_lib", "run-platform-snapshot.ts"));
  assert.match(c, /export type SnapshotHalf = "usage" \| "status" \| "both";/);
  assert.match(c, /export async function runPlatformSnapshot\(\s*request: NextRequest,\s*\{ half \}: \{ half: SnapshotHalf \},?\s*\)/);
  assert.match(c, /authHeader !== expected/);
  assert.match(c, /status: 401/);
  assert.equal((c.match(/createAdminClient\(\{ fetch: noStoreFetch \}\)/g) ?? []).length, 1);
  assert.equal((c.match(/createAdminClient\(/g) ?? []).length, 1);
  assert.match(c, /half !== "status"\s*\?\s*\(await Promise\.allSettled\(\[writePlatformUsageSnapshot\(db\)\]\)\)\[0\]!/);
  assert.match(c, /half !== "usage"\s*\?\s*\(await Promise\.allSettled\(\[writeStatusSnapshot\(db\)\]\)\)\[0\]!/);
  // Every alert pass sits behind a fulfilled usage outcome; none reads the status one.
  assert.equal((c.match(/if \(platformOutcome\?\.status === "fulfilled"/g) ?? []).length, 2);
  assert.doesNotMatch(c, /statusOutcome\.value\.payload/);
});
