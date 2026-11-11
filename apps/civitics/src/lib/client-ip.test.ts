// cc-270 — the limiter's identifier (src/lib/client-ip.ts), as middleware.ts
// and /api/cron/limiter-health both call it.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getClientIp } from "./client-ip";

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
