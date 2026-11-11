/**
 * cc-270 — /api/cron/limiter-health, anchored by source.
 *
 * An instrument, not a job: bearer-gated like every cron route, never cached,
 * keyed by the SAME getClientIp the middleware uses, and scheduled by nothing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROUTE = readFileSync(join(__dirname, "..", "..", "app", "api", "cron", "limiter-health", "route.ts"), "utf8");
const MIDDLEWARE = readFileSync(join(__dirname, "..", "..", "middleware.ts"), "utf8");
const VERCEL = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "vercel.json"), "utf8"),
) as { crons: Array<{ path: string; schedule: string }> };

/** Comments stripped, so prose cannot satisfy or trip an anchor. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const CODE = strip(ROUTE);
const MW = strip(MIDDLEWARE);

test("cc-270: edge, dynamic, CRON_SECRET bearer, no-store on both answers", () => {
  assert.match(CODE, /export const runtime = "edge";/);
  assert.match(CODE, /export const dynamic = "force-dynamic";/);
  assert.match(CODE, /authHeader !== expected/);
  assert.match(CODE, /!process\.env\["CRON_SECRET"\]/);
  assert.match(CODE, /status: 401, headers: NO_STORE/);
  assert.match(CODE, /\{ headers: NO_STORE \}/);
  assert.match(CODE, /"Cache-Control": "no-store"/);
});

test("cc-270: key_in_use and the middleware's bucket key are one function", () => {
  assert.match(CODE, /import \{ getClientIp \} from "@\/lib\/client-ip";/);
  assert.match(CODE, /key_in_use: getClientIp\(headers\)/);
  assert.match(MW, /import \{ getClientIp \} from "@\/lib\/client-ip";/);
  assert.match(MW, /getClientIp\(request\.headers\)/);
  assert.doesNotMatch(MW, /function getClientIp/, "no second copy in middleware.ts");
});

test("cc-270: nothing schedules it", () => {
  assert.equal(VERCEL.crons.find((c) => c.path === "/api/cron/limiter-health"), undefined);
});
