/**
 * FIX-1305 — middleware.ts runs the alias redirect, then the origin check,
 * before anything that costs a request money.
 *
 * Pinned by source, like notify-followers-route.test.ts: `next/server` does not
 * load under tsx, so the call order is read off the file. The decisions
 * themselves are unit-tested in origin-auth.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIDDLEWARE = readFileSync(join(__dirname, "..", "..", "middleware.ts"), "utf8");
const CORE = readFileSync(join(__dirname, "origin-auth.ts"), "utf8");

/**
 * Code only, so prose cannot satisfy or trip an anchor. Comments are stripped
 * only where they START a line: middleware.ts's prose says `/auth/*`, which a
 * global block-comment regex would read as an opener and eat code with, and
 * its strings carry `https://`, which a global line-comment regex would cut.
 */
function code(src: string): string {
  return src.replace(/^\s*\/\/.*$/gm, "").replace(/^\s*\/\*[\s\S]*?\*\//gm, "");
}

const MW = code(MIDDLEWARE);
const CORE_CODE = code(CORE);

/** The body of `export async function middleware(`, up to the next top-level function. */
function middlewareBody(): string {
  const start = MW.indexOf("export async function middleware(");
  assert.ok(start >= 0, "middleware() exists");
  const end = MW.indexOf("\nasync function ", start);
  assert.ok(end > start, "a top-level helper follows middleware()");
  return MW.slice(start, end);
}

test("FIX-1305: decideAliasRedirect( → decideOriginAuth( → BOT_PATTERNS.some( → checkRateLimit( in file order", () => {
  const alias = MW.indexOf("decideAliasRedirect(");
  const origin = MW.indexOf("decideOriginAuth(");
  const bots = MW.indexOf("BOT_PATTERNS.some(");
  const limiter = MW.indexOf("checkRateLimit(");
  assert.ok(alias > 0, "decideAliasRedirect( is called");
  assert.ok(alias < origin, "the alias redirect answers before the origin check");
  assert.ok(origin < bots, "the origin check runs before the BOT_PATTERNS 404");
  assert.ok(origin < limiter, "the origin check runs before checkRateLimit — a refusal costs no Upstash command");
});

test("FIX-1305: inside middleware(), both decisions run before the rest of the request is handled", () => {
  const body = middlewareBody();
  const alias = body.indexOf("decideAliasRedirect(");
  const origin = body.indexOf("decideOriginAuth(");
  const rest = body.indexOf("routeRequest(");
  assert.ok(alias >= 0 && origin > alias && rest > origin, "alias → origin → routeRequest");
  assert.doesNotMatch(body, /BOT_PATTERNS|checkRateLimit\(/, "nothing else runs in middleware() itself");
  // Each decision is made once, in middleware() — not repeated inside routeRequest.
  assert.equal((MW.match(/decideAliasRedirect\(/g) ?? []).length, 1);
  assert.equal((MW.match(/decideOriginAuth\(/g) ?? []).length, 1);
});

test("FIX-1305 D6: report mode stamps the miss on whatever routeRequest returns", () => {
  const body = middlewareBody();
  const rest = body.indexOf("routeRequest(");
  const stamp = body.indexOf("response.headers.set(ORIGIN_CHECK_HEADER");
  assert.ok(stamp > rest, "the stamp is applied after the response is computed");
  assert.match(CORE_CODE, /export const ORIGIN_CHECK_HEADER = "x-civitics-origin-check";/);
});

test("FIX-1305 D5: the refusal carries the 429's no-store trio and answers 403", () => {
  const start = MW.indexOf("function originRefusedResponse(");
  assert.ok(start >= 0, "originRefusedResponse exists");
  const fn = MW.slice(start, MW.indexOf("\n}\n", start));
  assert.match(fn, /status: 403/);
  assert.match(fn, /JSON\.stringify\(\{ error: "origin" \}\)/);
  assert.match(fn, /"Cache-Control": "no-store"/);
  assert.match(fn, /"CDN-Cache-Control": "no-store"/);
  assert.match(fn, /"Vercel-CDN-Cache-Control": "no-store"/);
});

test("FIX-1305 D0: the alias redirect is a 308 to the target helper", () => {
  const start = MW.indexOf("function aliasRedirectResponse(");
  assert.ok(start >= 0, "aliasRedirectResponse exists");
  const fn = MW.slice(start, MW.indexOf("\n}\n", start));
  assert.match(fn, /aliasRedirectTarget\(/);
  assert.match(fn, /status: 308/);
});

test("FIX-1305 D4: the exemption literal is exactly \"/api/cron/\", once, and both decisions use it", () => {
  assert.equal((CORE_CODE.match(/"\/api\/cron\/"/g) ?? []).length, 1, "one /api/cron/ literal in origin-auth.ts");
  assert.match(CORE_CODE, /export const CRON_PATH_PREFIX = "\/api\/cron\/";/);
  const uses = CORE_CODE.match(/path\.startsWith\(CRON_PATH_PREFIX\)/g) ?? [];
  assert.equal(uses.length, 2, "decideAliasRedirect and decideOriginAuth both test CRON_PATH_PREFIX");
  assert.doesNotMatch(MW, /"\/api\/cron\//, "middleware.ts carries no exemption literal of its own");
});

test("FIX-1305 D7: the core is edge-safe — no next/* and no Node imports", () => {
  assert.doesNotMatch(CORE_CODE, /from "next/);
  assert.doesNotMatch(CORE_CODE, /from "node:/);
  assert.doesNotMatch(CORE_CODE, /require\(/);
});

test("cc-231: every NextResponse.next( forwards the stripped header set, never request.headers", () => {
  const nexts = [...MW.matchAll(/NextResponse\.next\(/g)];
  assert.ok(nexts.length >= 1, "middleware forwards somewhere");
  // The one place that builds the forwarded set is forwardRequest(); every other
  // site calls it. A bare `headers: request.headers` would hand the secret to
  // route handlers (cc-230's contradiction 4).
  assert.equal(nexts.length, 1, "NextResponse.next( appears once — inside forwardRequest()");
  const start = MW.indexOf("function forwardRequest(");
  assert.ok(start >= 0, "forwardRequest exists");
  const fn = MW.slice(start, MW.indexOf("\n}\n", start));
  assert.match(fn, /NextResponse\.next\(\{\s*request: \{ headers: withoutOriginAuthHeader\(request\.headers\) \}/);
  assert.doesNotMatch(MW, /headers: request\.headers/, "no site forwards the raw request headers");
  assert.match(CORE_CODE, /export function withoutOriginAuthHeader\(/);
});
