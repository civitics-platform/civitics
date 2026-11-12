// FIX-1402 (cc-272) — /api/cron/limiter-health, answered by the middleware from
// the limiter's own module state (src/lib/limiter-health.ts). Replaces cc-270's
// source-anchored route test: the route is gone, and the handler is pure enough
// to call directly. The middleware's call order is still read off the file
// (`next/server` does not load under tsx), as origin-auth-middleware.test.ts does.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  IP_KEY_HEADER,
  LIMITER_HEALTH_PATH,
  answerLimiterHealth,
  classifyCfConnectingIp,
  ipKeyStamp,
} from "./limiter-health";
import {
  checkRateLimit,
  __resetRateLimiterStateForTests,
  __setBudgetFlagReaderForTests,
  __setUpstashLimitFnForTests,
} from "./ratelimit";

/** The 200's payload, as far as these cases read it. */
type Body = {
  health: { mode: string | null; budget_hold: boolean | null; budget_detail: string | null; budget_reads: number };
  health_scope: string;
  budget_read: string;
  isolate: { id: string; started_at: string; checks: number };
  ip: Record<string, string | null>;
  at: string;
};

const SECRET = "test-cron-secret";
const h = (init: Record<string, string>) => new Headers(init);
const bearer = (extra: Record<string, string> = {}) => h({ authorization: `Bearer ${SECRET}`, ...extra });

const realWarn = console.warn;
beforeEach(() => {
  __resetRateLimiterStateForTests();
  console.warn = () => {};
});
afterEach(() => {
  __resetRateLimiterStateForTests();
  console.warn = realWarn;
});

/** A flag GET that resolves on the next tick, counting its calls. */
function fakeFlag(value: unknown) {
  const reads = { n: 0 };
  __setBudgetFlagReaderForTests(async () => {
    reads.n += 1;
    await new Promise((r) => setTimeout(r, 5));
    if (value instanceof Error) throw value;
    return value;
  });
  return reads;
}

describe("the bearer (D2)", () => {
  for (const [label, headers, secret] of [
    ["no authorization header", h({}), SECRET],
    ["a wrong bearer", h({ authorization: "Bearer nope" }), SECRET],
    ["the bearer without its scheme", h({ authorization: SECRET }), SECRET],
    ["CRON_SECRET unset, even with an empty bearer", h({ authorization: "Bearer " }), undefined],
  ] as const) {
    it(`401 on ${label}, no-store, stamped, and no flag read`, async () => {
      const reads = fakeFlag(null);
      const res = await answerLimiterHealth(headers, secret);
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: "Unauthorized" });
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(res.headers.get(IP_KEY_HEADER), "cf=absent; key=unknown");
      assert.equal(reads.n, 0, "an unauthenticated call costs no Upstash command");
    });
  }

  it("200 with the bearer: the middleware's isolate, the forced read, the ip block", async () => {
    fakeFlag(null);
    const res = await answerLimiterHealth(
      bearer({ "x-forwarded-for": "203.0.113.7, 172.70.1.1", "x-real-ip": "203.0.113.7", "cf-connecting-ip": "198.51.100.4" }),
      SECRET,
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get(IP_KEY_HEADER), "cf=differs; key=xff");
    const body = (await res.json()) as Body;
    assert.deepEqual(Object.keys(body).sort(), ["at", "budget_read", "health", "health_scope", "ip", "isolate"]);
    assert.equal(body.health_scope, "middleware");
    assert.equal(body.budget_read, "read");
    assert.equal(body.health.budget_hold, false);
    assert.equal(body.health.budget_reads, 1);
    assert.equal(body.health.mode, null, "no checkRateLimit on this isolate yet — mode does not pretend");
    assert.equal(typeof body.isolate.id, "string");
    assert.ok(body.isolate.id.length >= 8);
    assert.ok(!Number.isNaN(Date.parse(body.isolate.started_at)));
    assert.equal(body.isolate.checks, 0);
    assert.deepEqual(body.ip, {
      x_forwarded_for: "203.0.113.7, 172.70.1.1",
      x_real_ip: "203.0.113.7",
      cf_connecting_ip: "198.51.100.4",
      key_in_use: "203.0.113.7",
    });
    assert.ok(!Number.isNaN(Date.parse(body.at)));
  });
});

describe("the stamp (D1): cf=<absent|same|differs>; key=<xff|real|unknown>", () => {
  const cases: Array<[Record<string, string>, string]> = [
    [{ "x-forwarded-for": "203.0.113.7" }, "cf=absent; key=xff"],
    [{ "x-forwarded-for": "203.0.113.7", "cf-connecting-ip": "203.0.113.7" }, "cf=same; key=xff"],
    [{ "x-forwarded-for": " 203.0.113.7 , 172.70.1.1", "cf-connecting-ip": " 203.0.113.7 " }, "cf=same; key=xff"],
    [{ "x-forwarded-for": "172.70.1.1", "cf-connecting-ip": "203.0.113.7" }, "cf=differs; key=xff"],
    [{ "x-real-ip": "198.51.100.4" }, "cf=absent; key=real"],
    [{ "x-real-ip": "198.51.100.4", "cf-connecting-ip": "198.51.100.4" }, "cf=differs; key=real"],
    [{ "cf-connecting-ip": "203.0.113.7" }, "cf=differs; key=unknown"],
    [{ "x-forwarded-for": "203.0.113.7", "cf-connecting-ip": "" }, "cf=absent; key=xff"],
    [{}, "cf=absent; key=unknown"],
  ];
  for (const [headers, stamp] of cases) {
    it(`${JSON.stringify(headers)} → ${stamp}`, async () => {
      assert.equal(ipKeyStamp(h(headers)), stamp);
      const res = await answerLimiterHealth(h(headers), SECRET);
      assert.equal(res.headers.get(IP_KEY_HEADER), stamp, "the 401 carries it too");
    });
  }

  it("under trustCfConnectingIp (FIX-1401) the key is cf, and key_in_use is the client — v4 whole, v6 /64", async () => {
    const trusted = { trustCfConnectingIp: true };
    const viaCf = { "x-forwarded-for": "172.70.1.1", "cf-connecting-ip": "203.0.113.7" };
    assert.equal(ipKeyStamp(h(viaCf), trusted), "cf=differs; key=cf");
    assert.equal(ipKeyStamp(h(viaCf)), "cf=differs; key=xff", "no flag, no cf key");
    assert.equal(ipKeyStamp(h({ "x-forwarded-for": "172.70.1.1" }), trusted), "cf=absent; key=xff");
    assert.equal(ipKeyStamp(h({ ...viaCf, "cf-connecting-ip": "junk" }), trusted), "cf=differs; key=xff");
    fakeFlag(null);
    const res = await answerLimiterHealth(bearer({ ...viaCf, "cf-connecting-ip": "2001:db8:a:b::1" }), SECRET, trusted);
    assert.equal(res.headers.get(IP_KEY_HEADER), "cf=differs; key=cf");
    assert.equal(((await res.json()) as Body).ip.key_in_use, "2001:0db8:000a:000b::/64");
    const unauth = await answerLimiterHealth(h(viaCf), SECRET, trusted);
    assert.equal(unauth.status, 401);
    assert.equal(unauth.headers.get(IP_KEY_HEADER), "cf=differs; key=cf", "the 401 carries the class too");
  });

  it("the stamp is a class, never an address", () => {
    const stamp = ipKeyStamp(h({ "x-forwarded-for": "203.0.113.7", "cf-connecting-ip": "198.51.100.4" }));
    assert.doesNotMatch(stamp, /\d+\.\d+\.\d+\.\d+|:/);
    assert.equal(classifyCfConnectingIp(h({ "cf-connecting-ip": "2001:db8::1", "x-forwarded-for": "2001:db8::1" })), "same");
  });
});

describe("the forced budget-flag read (D3)", () => {
  it("reads the flag as of THIS call on a cold isolate: the hold and its detail", async () => {
    fakeFlag({ state: "hold", used: 360_000, limit: 500_000 });
    const body = (await (await answerLimiterHealth(bearer(), SECRET)).json()) as Body;
    assert.equal(body.health.budget_hold, true);
    assert.equal(body.health.budget_detail, "360000/500000");
    assert.equal(body.health.mode, null, "the hold is the flag; mode is still this isolate's history");
  });

  it("a burst of bearer calls shares ONE in-flight read", async () => {
    const reads = fakeFlag(null);
    const bodies = await Promise.all(
      Array.from({ length: 6 }, async () => (await answerLimiterHealth(bearer(), SECRET)).json()),
    );
    assert.equal(reads.n, 1);
    for (const b of bodies as Body[]) {
      assert.equal(b.budget_read, "read");
      assert.equal(b.health.budget_reads, 1);
    }
  });

  it("forces a read even when the 200-call / 60 s schedule says not due", async () => {
    const reads = fakeFlag(null);
    __setUpstashLimitFnForTests(() => async () => ({ success: true, remaining: 10, reset: Date.now() + 60_000 }));
    await checkRateLimit("entity_leaf", "203.0.113.7"); // the schedule's first read
    assert.equal(reads.n, 1);
    await answerLimiterHealth(bearer(), SECRET);
    assert.equal(reads.n, 2);
  });

  it("a quota refusal is reported, never thrown, and is not a reading", async () => {
    fakeFlag(new Error("ERR max requests limit exceeded. Limit: 500000, Usage: 500002"));
    const res = await answerLimiterHealth(bearer(), SECRET);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Body;
    assert.equal(body.budget_read, "quota-refused");
    assert.equal(body.health.budget_hold, null);
  });

  it("no Upstash env → no-reader, and no read attempted", async () => {
    const body = (await (await answerLimiterHealth(bearer(), SECRET)).json()) as Body;
    assert.equal(body.budget_read, "no-reader");
    assert.equal(body.health.budget_reads, 0);
  });
});

describe("isolate.checks counts this module's checkRateLimit calls", () => {
  it("three checks → checks 3, mode upstash", async () => {
    fakeFlag(null);
    __setUpstashLimitFnForTests(() => async () => ({ success: true, remaining: 10, reset: Date.now() + 60_000 }));
    for (let i = 0; i < 3; i += 1) await checkRateLimit("entity_pages", "203.0.113.7");
    const body = (await (await answerLimiterHealth(bearer(), SECRET)).json()) as Body;
    assert.equal(body.isolate.checks, 3);
    assert.equal(body.health.mode, "upstash");
  });
});

// ── The middleware answers it; the route is gone (D2, D4) ────────────────────

const APP = join(__dirname, "..", "..");
const code = (src: string) => src.replace(/^\s*\/\/.*$/gm, "").replace(/^\s*\/\*[\s\S]*?\*\//gm, "");
const MW = code(readFileSync(join(APP, "middleware.ts"), "utf8"));

describe("the middleware branch", () => {
  it("answers after the origin decision and before routeRequest", () => {
    const start = MW.indexOf("export async function middleware(");
    const body = MW.slice(start, MW.indexOf("\nasync function ", start));
    const origin = body.indexOf("decideOriginAuth(");
    const proof = body.indexOf("provedCloudflare(");
    const branch = body.indexOf("path === LIMITER_HEALTH_PATH");
    const answer = body.indexOf(
      "answerLimiterHealth(request.headers, process.env[\"CRON_SECRET\"], { trustCfConnectingIp })",
    );
    const rest = body.indexOf("routeRequest(request, path, trustCfConnectingIp)");
    assert.ok(origin > 0 && proof > origin && branch > proof && answer > branch && rest > answer);
  });

  it("FIX-1401: the bucket check and the health answer key under ONE flag", () => {
    assert.match(MW, /const trustCfConnectingIp = provedCloudflare\(\{/);
    assert.match(MW, /mode: setting\.mode,/);
    assert.match(MW, /getClientIp\(request\.headers, \{ trustCfConnectingIp \}\)/);
    assert.equal((MW.match(/getClientIp\(/g) ?? []).length, 1, "one bucket-key call site");
  });

  it("the path is the one the origin door exempts", () => {
    assert.ok(LIMITER_HEALTH_PATH.startsWith("/api/cron/"));
  });

  it("cc-270's route and its test are gone; nothing schedules the path", () => {
    assert.equal(existsSync(join(APP, "app", "api", "cron", "limiter-health", "route.ts")), false);
    assert.equal(existsSync(join(__dirname, "limiter-health-route.test.ts")), false);
    const vercel = JSON.parse(readFileSync(join(APP, "vercel.json"), "utf8")) as { crons: Array<{ path: string }> };
    assert.equal(vercel.crons.find((c) => c.path === LIMITER_HEALTH_PATH), undefined);
  });

  it("limiter-health.ts is edge-safe: no next/* and no node: import", () => {
    const src = readFileSync(join(__dirname, "limiter-health.ts"), "utf8");
    assert.doesNotMatch(src, /from "(next\/|node:)/);
  });
});
