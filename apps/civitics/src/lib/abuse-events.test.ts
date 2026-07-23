// FIX-880 unit tests for the abuse-event capture helper. Pure surface only —
// HMAC hashing, pepper-unset fail-open, meta sanitization, IP extraction, and the
// fail-open guarantee of recordAbuseEvent(). No DB is touched.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  hashIdentifier,
  sanitizeMeta,
  clientIpFromHeaders,
  recordAbuseEvent,
} from "./abuse-events";

const PEPPER = "test-pepper-0123456789abcdef";

// Snapshot + restore the three env vars these tests toggle.
let savedPepper: string | undefined;
let savedUrl: string | undefined;
let savedKey: string | undefined;

beforeEach(() => {
  savedPepper = process.env.ABUSE_EVENT_PEPPER;
  savedUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  savedKey = process.env.SUPABASE_SECRET_KEY;
});
afterEach(() => {
  if (savedPepper === undefined) delete process.env.ABUSE_EVENT_PEPPER;
  else process.env.ABUSE_EVENT_PEPPER = savedPepper;
  if (savedUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = savedUrl;
  if (savedKey === undefined) delete process.env.SUPABASE_SECRET_KEY;
  else process.env.SUPABASE_SECRET_KEY = savedKey;
});

describe("hashIdentifier", () => {
  it("is deterministic — same value + same pepper ⇒ same digest", () => {
    process.env.ABUSE_EVENT_PEPPER = PEPPER;
    const a = hashIdentifier("203.0.113.7");
    const b = hashIdentifier("203.0.113.7");
    assert.equal(a, b);
    assert.equal(typeof a, "string");
  });

  it("matches a reference HMAC-SHA256(pepper) hex digest", () => {
    process.env.ABUSE_EVENT_PEPPER = PEPPER;
    const expected = createHmac("sha256", PEPPER).update("203.0.113.7").digest("hex");
    assert.equal(hashIdentifier("203.0.113.7"), expected);
    assert.match(hashIdentifier("203.0.113.7")!, /^[0-9a-f]{64}$/);
  });

  it("distinct inputs ⇒ distinct digests (no collision on the linkage key)", () => {
    process.env.ABUSE_EVENT_PEPPER = PEPPER;
    assert.notEqual(hashIdentifier("203.0.113.7"), hashIdentifier("203.0.113.8"));
  });

  it("changing the pepper changes the digest (pepper is load-bearing)", () => {
    process.env.ABUSE_EVENT_PEPPER = PEPPER;
    const withA = hashIdentifier("203.0.113.7");
    process.env.ABUSE_EVENT_PEPPER = "a-different-pepper";
    const withB = hashIdentifier("203.0.113.7");
    assert.notEqual(withA, withB);
  });

  it("returns null when the pepper is unset (fail-open, never a raw fallback)", () => {
    delete process.env.ABUSE_EVENT_PEPPER;
    const h = hashIdentifier("203.0.113.7");
    assert.equal(h, null);
    // Crucially: the raw value is never returned as a fallback.
    assert.notEqual(h, "203.0.113.7");
  });

  it("returns null for an empty / null value even with a pepper set", () => {
    process.env.ABUSE_EVENT_PEPPER = PEPPER;
    assert.equal(hashIdentifier(""), null);
    assert.equal(hashIdentifier(null), null);
    assert.equal(hashIdentifier(undefined), null);
  });
});

describe("sanitizeMeta", () => {
  it("strips raw ip/ua identifier keys (case-insensitive)", () => {
    const out = sanitizeMeta({
      route: "positions",
      ip: "203.0.113.7",
      UA: "Mozilla/5.0",
      user_agent: "curl/8",
      "X-Forwarded-For": "203.0.113.7",
      ip_hash: "deadbeef",
    });
    assert.deepEqual(out, { route: "positions" });
    for (const k of Object.keys(out)) {
      assert.ok(!["ip", "ua", "user_agent", "x-forwarded-for", "ip_hash"].includes(k.toLowerCase()));
    }
  });

  it("drops undefined values and keeps legitimate detail keys", () => {
    const out = sanitizeMeta({ route: "comments", cap: "comment_daily", outcome: undefined });
    assert.deepEqual(out, { route: "comments", cap: "comment_daily" });
  });

  it("returns {} for no meta", () => {
    assert.deepEqual(sanitizeMeta(), {});
    assert.deepEqual(sanitizeMeta(undefined), {});
  });
});

describe("clientIpFromHeaders", () => {
  it("takes the first x-forwarded-for hop", () => {
    const h = new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1, 10.0.0.2" });
    assert.equal(clientIpFromHeaders(h), "203.0.113.7");
  });

  it("falls back to x-real-ip when no xff", () => {
    const h = new Headers({ "x-real-ip": "198.51.100.4" });
    assert.equal(clientIpFromHeaders(h), "198.51.100.4");
  });

  it("returns null when neither header is present or value is 'unknown'", () => {
    assert.equal(clientIpFromHeaders(new Headers()), null);
    assert.equal(clientIpFromHeaders(new Headers({ "x-forwarded-for": "unknown" })), null);
  });
});

describe("recordAbuseEvent (fail-open)", () => {
  it("never throws and resolves void even when the admin client can't be built", async () => {
    // No supabase env ⇒ createAdminClient() throws ⇒ the helper must swallow it.
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
    const result = await recordAbuseEvent({
      action: "position_set",
      headers: new Headers({ "x-forwarded-for": "203.0.113.7", "user-agent": "test" }),
      userId: "00000000-0000-0000-0000-000000000001",
      targetType: "proposal",
      targetId: "not-a-uuid", // exercises the UUID guard → dropped to null, no throw
      meta: { route: "positions", ip: "should-be-stripped" },
    });
    assert.equal(result, undefined);
  });
});
