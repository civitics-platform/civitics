// cc-270 / cc-272 — the limiter's identifier (src/lib/client-ip.ts), as
// middleware.ts's bucket check and its /api/cron/limiter-health answer call it.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getClientIp, resolveClientIp } from "./client-ip";

const h = (init: Record<string, string>) => new Headers(init);

describe("getClientIp", () => {
  it("keys on x-forwarded-for's first hop, trimmed", () => {
    assert.equal(getClientIp(h({ "x-forwarded-for": " 203.0.113.7 , 172.70.1.1" })), "203.0.113.7");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", () => {
    assert.equal(getClientIp(h({ "x-real-ip": "198.51.100.4" })), "198.51.100.4");
  });

  it("is `unknown` with neither — one shared bucket", () => {
    assert.equal(getClientIp(h({})), "unknown");
  });
});

describe("resolveClientIp names the header it used (the stamp's key=)", () => {
  it("xff / real / unknown", () => {
    assert.deepEqual(resolveClientIp(h({ "x-forwarded-for": "203.0.113.7", "x-real-ip": "198.51.100.4" })), {
      ip: "203.0.113.7",
      source: "xff",
    });
    assert.deepEqual(resolveClientIp(h({ "x-real-ip": "198.51.100.4" })), { ip: "198.51.100.4", source: "real" });
    assert.deepEqual(resolveClientIp(h({})), { ip: "unknown", source: "unknown" });
  });

  it("a cf-connecting-ip alone is not a key source", () => {
    assert.deepEqual(resolveClientIp(h({ "cf-connecting-ip": "203.0.113.7" })), { ip: "unknown", source: "unknown" });
  });
});
