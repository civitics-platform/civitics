// FIX-1038 / FIX-1040 unit tests for the edge rate limiter's integrity paths.
//
// Covers the three things the 2026-08-15 crawl incident made load-bearing:
//   * the deny-cache short-circuit (an over-cap identifier costs 0 Upstash commands)
//   * fail-OVER to the per-instance memory limiter (never allow-all, never throws)
//   * bounded per-instance maps + the state-transition signal and warn sampling
//
// Pure surface: no Redis, no network. The Upstash branch is driven through the
// __setUpstashLimitFnForTests seam, and time is driven by overriding Date.now so
// window rollovers are deterministic rather than slept for.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  checkRateLimit,
  getLimiterHealth,
  windowMs,
  __resetRateLimiterStateForTests,
  __setUpstashLimitFnForTests,
  __mapSizesForTests,
  type RateLimitBucket,
} from "./ratelimit";

// ── Harness ──────────────────────────────────────────────────────────────────

const realNow = Date.now;
let clock = 1_700_000_000_000;
const setClock = (ms: number) => {
  clock = ms;
};
const advance = (ms: number) => {
  clock += ms;
};

const realWarn = console.warn;
let warnings: string[] = [];

let savedUrl: string | undefined;
let savedToken: string | undefined;

beforeEach(() => {
  savedUrl = process.env.UPSTASH_REDIS_REST_URL;
  savedToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  __resetRateLimiterStateForTests();
  setClock(1_700_000_000_000);
  Date.now = () => clock;
  warnings = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
});

afterEach(() => {
  Date.now = realNow;
  console.warn = realWarn;
  __resetRateLimiterStateForTests();
  if (savedUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = savedUrl;
  if (savedToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = savedToken;
});

/** A stand-in Upstash limiter that counts calls and can be told how to answer. */
function fakeUpstash(answer: (identifier: string, call: number) => {
  success: boolean;
  remaining: number;
  reset: number;
}) {
  const calls: string[] = [];
  __setUpstashLimitFnForTests(() => async (identifier) => {
    calls.push(identifier);
    return answer(identifier, calls.length);
  });
  return calls;
}

/** An Upstash limiter that always throws — the exhausted-quota shape. */
function throwingUpstash(message = "ERR max requests limit exceeded. Limit: 500000, Usage: 500002.") {
  const calls: string[] = [];
  __setUpstashLimitFnForTests(() => async (identifier) => {
    calls.push(identifier);
    throw new Error(message);
  });
  return calls;
}

// ── windowMs ─────────────────────────────────────────────────────────────────

describe("windowMs", () => {
  it("parses every Duration form BUCKET_LIMITS actually uses", () => {
    assert.equal(windowMs("1 m"), 60_000);
    assert.equal(windowMs("10 m"), 600_000);
    assert.equal(windowMs("1 h"), 3_600_000);
  });

  it("parses the remaining units and tolerates missing whitespace", () => {
    assert.equal(windowMs("30 s"), 30_000);
    assert.equal(windowMs("500 ms"), 500);
    assert.equal(windowMs("1 d"), 86_400_000);
    assert.equal(windowMs("2m" as never), 120_000);
  });

  it("never returns 0 for an unparseable value — a 0-length window would allow everything", () => {
    assert.equal(windowMs("banana" as never), 60_000);
    assert.equal(windowMs("" as never), 60_000);
  });
});

// ── Deny-cache ───────────────────────────────────────────────────────────────

describe("deny-cache", () => {
  it("an Upstash rejection populates it, and the next call spends ZERO Upstash commands", async () => {
    const calls = fakeUpstash(() => ({ success: false, remaining: 0, reset: clock + 30_000 }));

    const first = await checkRateLimit("entity_leaf", "203.0.113.7");
    assert.equal(first.allowed, false);
    assert.equal(first.limited, true);
    assert.equal(first.source, "upstash");
    assert.equal(calls.length, 1);

    const second = await checkRateLimit("entity_leaf", "203.0.113.7");
    assert.equal(second.allowed, false);
    assert.equal(second.limited, true);
    assert.equal(second.source, "deny-cache");
    assert.equal(calls.length, 1, "deny-cache hit must not call Upstash");

    for (let i = 0; i < 50; i += 1) await checkRateLimit("entity_leaf", "203.0.113.7");
    assert.equal(calls.length, 1, "50 more requests in-window still cost 0 commands");
  });

  it("still reports a sane Retry-After that shrinks as the window elapses", async () => {
    fakeUpstash(() => ({ success: false, remaining: 0, reset: clock + 30_000 }));
    await checkRateLimit("entity_leaf", "203.0.113.7");

    const at0 = await checkRateLimit("entity_leaf", "203.0.113.7");
    assert.equal(at0.retryAfterSec, 30);
    advance(25_000);
    const at25 = await checkRateLimit("entity_leaf", "203.0.113.7");
    assert.equal(at25.retryAfterSec, 5);
    assert.equal(at25.source, "deny-cache");
  });

  it("expires at `reset` and re-checks Upstash after it", async () => {
    let reject = true;
    const calls = fakeUpstash(() => ({
      success: !reject,
      remaining: reject ? 0 : 44,
      reset: clock + 30_000,
    }));

    await checkRateLimit("entity_leaf", "203.0.113.7");
    assert.equal(calls.length, 1);
    await checkRateLimit("entity_leaf", "203.0.113.7");
    assert.equal(calls.length, 1, "cached inside the window");

    advance(30_001);
    reject = false;
    const after = await checkRateLimit("entity_leaf", "203.0.113.7");
    assert.equal(calls.length, 2, "window elapsed → a real check runs again");
    assert.equal(after.allowed, true);
    assert.equal(after.source, "upstash");
  });

  it("is keyed per (bucket, identifier) — one denial does not leak across either axis", async () => {
    const calls = fakeUpstash((identifier) => ({
      success: identifier !== "203.0.113.7",
      remaining: 0,
      reset: clock + 30_000,
    }));

    await checkRateLimit("entity_leaf", "203.0.113.7");
    assert.equal((await checkRateLimit("entity_leaf", "203.0.113.7")).source, "deny-cache");

    const otherIp = await checkRateLimit("entity_leaf", "198.51.100.4");
    assert.equal(otherIp.allowed, true);
    const otherBucket = await checkRateLimit("entity_pages", "203.0.113.7");
    assert.equal(otherBucket.source, "upstash", "a different bucket must re-check");
    assert.equal(calls.length, 3);
  });

  it("stays bounded — 3,000 distinct denied identifiers never exceed the cap", async () => {
    fakeUpstash(() => ({ success: false, remaining: 0, reset: clock + 600_000 }));
    const { caps } = __mapSizesForTests();
    for (let i = 0; i < 3_000; i += 1) {
      await checkRateLimit("entity_leaf", `10.0.${Math.floor(i / 256)}.${i % 256}`);
    }
    const { deny } = __mapSizesForTests();
    assert.ok(deny <= caps.deny, `deny cache ${deny} exceeded cap ${caps.deny}`);
    assert.ok(deny > 0);
  });

  it("evicts expired entries before live ones once the cap is reached", async () => {
    // Fill exactly to the cap with entries that expire almost immediately. The
    // sweep is deliberately lazy — it runs on insert only once the map is AT the
    // cap, so a per-request O(n) scan never lands on the hot path.
    const { caps } = __mapSizesForTests();
    fakeUpstash(() => ({ success: false, remaining: 0, reset: clock + 1_000 }));
    for (let i = 0; i < caps.deny; i += 1) {
      await checkRateLimit("entity_leaf", `10.1.${Math.floor(i / 256)}.${i % 256}`);
    }
    assert.equal(__mapSizesForTests().deny, caps.deny, "map should sit exactly at the cap");

    advance(2_000); // every entry above is now expired
    fakeUpstash(() => ({ success: false, remaining: 0, reset: clock + 600_000 }));
    await checkRateLimit("entity_leaf", "203.0.113.99");

    const { deny } = __mapSizesForTests();
    assert.equal(deny, 1, `expired sweep should have cleared the map, saw ${deny}`);
    assert.equal((await checkRateLimit("entity_leaf", "203.0.113.99")).source, "deny-cache");
  });
});

// ── Fail-over to memory ──────────────────────────────────────────────────────

describe("memory fail-over", () => {
  it("an Upstash throw yields a memory verdict, never a throw and never allow-all", async () => {
    throwingUpstash();
    const cap = 45; // entity_leaf
    for (let i = 0; i < cap; i += 1) {
      const r = await checkRateLimit("entity_leaf", "203.0.113.7");
      assert.equal(r.allowed, true, `request ${i + 1} should be allowed`);
      assert.equal(r.source, "memory");
    }
    const over = await checkRateLimit("entity_leaf", "203.0.113.7");
    assert.equal(over.allowed, false, "request 46 must 429 — the pre-FIX-1038 code allowed it");
    assert.equal(over.limited, true);
    assert.equal(over.source, "memory");
    assert.ok(over.retryAfterSec >= 1);
  });

  it("absent UPSTASH env falls over to memory rather than allowing everything", async () => {
    // No test seam installed and no env → getLimiter returns null.
    for (let i = 0; i < 120; i += 1) {
      const r = await checkRateLimit("entity_pages", "203.0.113.8");
      assert.equal(r.allowed, true);
      assert.equal(r.source, "memory");
    }
    const over = await checkRateLimit("entity_pages", "203.0.113.8");
    assert.equal(over.allowed, false);
    assert.equal(getLimiterHealth().mode, "memory");
  });

  it("the fixed window rolls — the same identifier is allowed again in the next window", async () => {
    throwingUpstash();
    for (let i = 0; i < 46; i += 1) await checkRateLimit("entity_leaf", "203.0.113.7");
    assert.equal((await checkRateLimit("entity_leaf", "203.0.113.7")).allowed, false);

    advance(60_001);
    const next = await checkRateLimit("entity_leaf", "203.0.113.7");
    assert.equal(next.allowed, true);
    assert.equal(next.remaining, 44);
  });

  it("counts per (bucket, identifier), and honours each bucket's own token count", async () => {
    throwingUpstash();
    for (let i = 0; i < 46; i += 1) await checkRateLimit("entity_leaf", "203.0.113.7");
    assert.equal((await checkRateLimit("entity_leaf", "203.0.113.7")).allowed, false);
    // Different IP, same bucket — untouched.
    assert.equal((await checkRateLimit("entity_leaf", "198.51.100.4")).allowed, true);
    // Same IP, generous bucket — untouched, and its own cap is 300.
    for (let i = 0; i < 300; i += 1) {
      assert.equal((await checkRateLimit("entity_prefetch", "203.0.113.7")).allowed, true);
    }
    assert.equal((await checkRateLimit("entity_prefetch", "203.0.113.7")).allowed, false);
  });

  it("a missing identifier still allows — there is nothing to key a counter on", async () => {
    throwingUpstash();
    const r = await checkRateLimit("entity_leaf", "");
    assert.equal(r.allowed, true);
    assert.equal(r.limited, false);
    assert.equal(r.source, undefined);
  });

  it("stays bounded — 8,000 distinct identifiers never exceed the memory cap", async () => {
    throwingUpstash();
    const { caps } = __mapSizesForTests();
    for (let i = 0; i < 8_000; i += 1) {
      await checkRateLimit("entity_leaf", `10.2.${Math.floor(i / 256)}.${i % 256}`);
    }
    const { memory } = __mapSizesForTests();
    assert.ok(memory <= caps.memory, `memory map ${memory} exceeded cap ${caps.memory}`);
  });

  it("never throws even when the limiter rejects with a non-Error", async () => {
    __setUpstashLimitFnForTests(() => async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "quota gone";
    });
    const r = await checkRateLimit("entity_leaf", "203.0.113.7");
    assert.equal(r.allowed, true);
    assert.equal(r.source, "memory");
  });
});

// ── FIX-1040: transition signal + warn sampling ──────────────────────────────

describe("state transitions (FIX-1040)", () => {
  it("records upstash→memory and memory→upstash, and logs each transition once", async () => {
    let broken = false;
    __setUpstashLimitFnForTests(() => async () => {
      if (broken) throw new Error("ERR max requests limit exceeded.");
      return { success: true, remaining: 44, reset: clock + 60_000 };
    });

    await checkRateLimit("entity_leaf", "203.0.113.7");
    assert.equal(getLimiterHealth().mode, "upstash");
    assert.equal(getLimiterHealth().transitions, 0, "the first observation is not a transition");

    broken = true;
    await checkRateLimit("entity_leaf", "203.0.113.7");
    await checkRateLimit("entity_leaf", "203.0.113.7");
    await checkRateLimit("entity_leaf", "203.0.113.7");
    const degraded = getLimiterHealth();
    assert.equal(degraded.mode, "memory");
    assert.equal(degraded.transitions, 1, "three degraded requests are ONE transition");
    assert.match(degraded.reason ?? "", /max requests limit exceeded/);
    assert.equal(
      warnings.filter((w) => w.includes("STATE upstash→memory")).length,
      1,
      "the transition line must not repeat per request",
    );

    broken = false;
    await checkRateLimit("entity_leaf", "203.0.113.7");
    const recovered = getLimiterHealth();
    assert.equal(recovered.mode, "upstash");
    assert.equal(recovered.transitions, 2);
    assert.equal(warnings.filter((w) => w.includes("STATE memory→upstash")).length, 1);
  });

  it("exposes a `since` timestamp that moves with the transition", async () => {
    throwingUpstash();
    await checkRateLimit("entity_leaf", "203.0.113.7");
    const since = getLimiterHealth().since;
    assert.ok(since, "since must be set once a mode is observed");
    assert.equal(since, new Date(clock).toISOString());
  });

  it("samples the per-request warn but ALWAYS warns on the first error per instance", async () => {
    throwingUpstash();
    await checkRateLimit("entity_leaf", "203.0.113.7");
    const upstashWarns = () =>
      warnings.filter((w) => w.includes("Upstash error on bucket=")).length;
    assert.equal(upstashWarns(), 1, "first error must warn — vercel logs presence check");

    for (let i = 0; i < 200; i += 1) await checkRateLimit("entity_leaf", `10.3.0.${i % 256}`);
    assert.equal(upstashWarns(), 1, "201 errors, still one warn — sampling is doing its job");

    for (let i = 0; i < 400; i += 1) await checkRateLimit("entity_leaf", `10.4.${i % 256}.1`);
    assert.equal(upstashWarns(), 2, "the 500th error emits the next sampled line");
  });

  it("health reports the per-instance map sizes for the snapshot to read", async () => {
    throwingUpstash();
    await checkRateLimit("entity_leaf", "203.0.113.7");
    const health = getLimiterHealth();
    assert.equal(health.memory_keys, 1);
    assert.equal(health.deny_cache_size, 0);
  });
});

// ── Caller-compatibility guard ───────────────────────────────────────────────

describe("public contract", () => {
  it("every bucket name still resolves to a real policy (no silent undefined cap)", async () => {
    throwingUpstash();
    const buckets: RateLimitBucket[] = [
      "search",
      "graph_ai",
      "graph",
      "write",
      "entity_pages",
      "entity_leaf",
      "entity_prefetch",
      "auth_send_ip",
      "auth_send_email",
    ];
    for (const bucket of buckets) {
      const r = await checkRateLimit(bucket, "probe@example.com");
      assert.equal(r.allowed, true, `${bucket} first request`);
      assert.ok(Number.isFinite(r.remaining), `${bucket} remaining must be finite on the memory path`);
    }
  });

  it("the auth_send_email bucket keys on the email and caps at 3 per hour", async () => {
    throwingUpstash();
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await checkRateLimit("auth_send_email", "a@example.com")).allowed, true);
    }
    assert.equal((await checkRateLimit("auth_send_email", "a@example.com")).allowed, false);
    assert.equal((await checkRateLimit("auth_send_email", "b@example.com")).allowed, true);
  });
});
