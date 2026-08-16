// FIX-1038 / FIX-1040 unit tests for the Upstash limiter-health probe and the
// durable state-transition record. Pure surface — `fetch` is stubbed and the
// Supabase client is a hand-rolled in-memory stand-in. No network, no DB.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  getUpstashHealth,
  getUpstashUsage,
  recordUpstashLimiterState,
  isQuotaExhaustedMessage,
  parseQuotaError,
  __resetUpstashHealthCache,
  __resetUpstashUsageCache,
  type UpstashLimiterState,
} from "./upstash-usage";

// The message Upstash actually returned on 2026-08-15, verbatim from prod logs.
const QUOTA_ERROR =
  "ERR max requests limit exceeded. Limit: 500000, Usage: 500002.";

const realFetch = globalThis.fetch;
let savedUrl: string | undefined;
let savedToken: string | undefined;

beforeEach(() => {
  savedUrl = process.env.UPSTASH_REDIS_REST_URL;
  savedToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
  __resetUpstashHealthCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  __resetUpstashHealthCache();
  if (savedUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = savedUrl;
  if (savedToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = savedToken;
});

function stubFetch(
  responder: () => { status?: number; ok?: boolean; body: unknown } | Promise<never>,
): { calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    calls.push(init ?? {});
    const r = await responder();
    return {
      ok: r.ok ?? (r.status ?? 200) < 400,
      status: r.status ?? 200,
      statusText: "",
      json: async () => r.body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls };
}

// ── Message parsing ──────────────────────────────────────────────────────────

describe("parseQuotaError", () => {
  it("extracts Limit and Usage from the 2026-08-15 message verbatim", () => {
    assert.deepEqual(parseQuotaError(QUOTA_ERROR), { limit: 500000, usage: 500002 });
  });

  it("returns null when the message carries no numbers", () => {
    assert.equal(parseQuotaError("ERR max requests limit exceeded."), null);
    assert.equal(parseQuotaError("WRONGPASS invalid credentials"), null);
  });
});

describe("isQuotaExhaustedMessage", () => {
  it("matches the exhaustion message and not an auth or network failure", () => {
    assert.equal(isQuotaExhaustedMessage(QUOTA_ERROR), true);
    assert.equal(isQuotaExhaustedMessage("ERR max daily request limit reached"), true);
    assert.equal(isQuotaExhaustedMessage("WRONGPASS invalid credentials"), false);
    assert.equal(isQuotaExhaustedMessage("fetch failed"), false);
  });
});

// ── The probe ────────────────────────────────────────────────────────────────

describe("getUpstashHealth", () => {
  it("returns the benign {error} shape when the env is absent — never a false alarm", async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const r = await getUpstashHealth();
    assert.ok("error" in r);
    assert.match(r.error, /UPSTASH_REDIS_REST/);
  });

  it("all PONGs ⇒ healthy, and spends only the probe's own commands", async () => {
    const { calls } = stubFetch(() => ({ body: { result: "PONG" } }));
    const r = await getUpstashHealth();
    assert.ok(!("error" in r));
    assert.equal(r.state, "healthy");
    assert.equal(r.detail, null);
    assert.equal(r.usage_commands, null, "usage is UNKNOWN when healthy — never an invented 0");
    assert.equal(r.refusals, 0);
    assert.equal(calls.length, r.attempts);
    assert.ok(r.attempts >= 1 && r.attempts <= 3, `attempts was ${r.attempts}`);
    assert.deepEqual(JSON.parse(String(calls[0]!.body)), ["PING"]);
  });

  it("the quota error ⇒ quota_exhausted, WITH the disclosed numbers", async () => {
    stubFetch(() => ({ body: { error: QUOTA_ERROR } }));
    const r = await getUpstashHealth();
    assert.ok(!("error" in r));
    assert.equal(r.state, "quota_exhausted");
    assert.equal(r.limit_commands, 500000);
    assert.equal(r.usage_commands, 500002);
    assert.equal(r.refusals, r.attempts);
    assert.match(r.detail ?? "", /PINGs refused/);
    assert.match(r.detail ?? "", /Limit: 500000, Usage: 500002/);
  });

  // The regression this whole multi-probe design exists for: measured
  // 2026-08-16 03:10 UTC, an over-quota Upstash refused only ~38% of PINGs.
  // A single-ping probe reports "healthy" through most ticks of a real outage.
  it("ONE refusal among successes still reports quota_exhausted", async () => {
    let n = 0;
    stubFetch(() => {
      n += 1;
      return n === 2 ? { body: { error: QUOTA_ERROR } } : { body: { result: "PONG" } };
    });
    const r = await getUpstashHealth();
    assert.ok(!("error" in r));
    assert.equal(r.state, "quota_exhausted", "a PONG does not prove health; a refusal proves exhaustion");
    assert.equal(r.refusals, 1);
    assert.ok(r.attempts > 1, "must issue more than one PING or the flap is invisible");
    assert.equal(r.usage_commands, 500002, "the numbers survive even from a single refusal");
  });

  it("reports the refusal RATIO so severity is visible, not just the boolean", async () => {
    let n = 0;
    stubFetch(() => {
      n += 1;
      return n % 2 === 0 ? { body: { result: "PONG" } } : { body: { error: QUOTA_ERROR } };
    });
    const r = await getUpstashHealth();
    assert.ok(!("error" in r));
    assert.ok(r.refusals > 0 && r.refusals < r.attempts, `${r.refusals}/${r.attempts}`);
  });

  it("classifies a quota error delivered with a 4xx status, not just a 200 body", async () => {
    stubFetch(() => ({ status: 429, body: { error: QUOTA_ERROR } }));
    const r = await getUpstashHealth();
    assert.ok(!("error" in r));
    assert.equal(r.state, "quota_exhausted");
  });

  it("an auth failure is unreachable, NOT quota_exhausted", async () => {
    stubFetch(() => ({ status: 401, body: { error: "WRONGPASS invalid credentials" } }));
    const r = await getUpstashHealth();
    assert.ok(!("error" in r));
    assert.equal(r.state, "unreachable");
    assert.match(r.detail ?? "", /401/);
  });

  it("a thrown fetch is unreachable and never propagates", async () => {
    globalThis.fetch = (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    const r = await getUpstashHealth();
    assert.ok(!("error" in r));
    assert.equal(r.state, "unreachable");
    assert.equal(r.detail, "fetch failed");
  });

  it("an unexpected PING result is unreachable rather than silently healthy", async () => {
    stubFetch(() => ({ body: { result: "" } }));
    const r = await getUpstashHealth();
    assert.ok(!("error" in r));
    assert.equal(r.state, "unreachable");
  });

  it("caches inside the TTL so a second consumer in the same tick costs 0 commands", async () => {
    const { calls } = stubFetch(() => ({ body: { result: "PONG" } }));
    const first = await getUpstashHealth();
    assert.ok(!("error" in first));
    await getUpstashHealth();
    assert.equal(calls.length, first.attempts, "the second call must not re-probe");
  });
});

// ── Control plane: getUpstashUsage ───────────────────────────────────────────

// The real shapes, trimmed to the fields the helper reads. Captured live
// 2026-08-16 from the civitics_limiter_db database.
const DB_DETAIL = {
  database_id: "d2f01ee0-0000-0000-0000-000000000000",
  database_name: "civitics_limiter_db",
  type: "free",
  auto_upgrade: false,
  db_request_limit: 500000,
  read_only_rest_token: "SECRET-SHOULD-NEVER-SURFACE",
};
const DB_STATS = {
  total_monthly_requests: 498964,
  total_monthly_read_requests: 230550,
  total_monthly_write_requests: 268414,
  daily_net_commands: 1,
};

function stubMgmt(
  responder: (path: string) => { status?: number; body: unknown },
): { paths: string[] } {
  const paths: string[] = [];
  globalThis.fetch = (async (url: string) => {
    const path = String(url);
    paths.push(path);
    const r = responder(path);
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      statusText: "",
      json: async () => r.body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { paths };
}

describe("getUpstashUsage", () => {
  beforeEach(() => {
    process.env.UPSTASH_EMAIL = "ops@example.com";
    process.env.UPSTASH_API_KEY = "mgmt-key";
    process.env.UPSTASH_DATABASE_ID = "d2f01ee0-0000-0000-0000-000000000000";
    __resetUpstashUsageCache();
  });
  afterEach(() => {
    delete process.env.UPSTASH_EMAIL;
    delete process.env.UPSTASH_API_KEY;
    delete process.env.UPSTASH_DATABASE_ID;
    __resetUpstashUsageCache();
  });

  it("reads monthly usage against the VENDOR's cap, not a hardcoded 500000", async () => {
    stubMgmt((p) => ({ body: p.includes("/stats/") ? DB_STATS : DB_DETAIL }));
    const r = await getUpstashUsage();
    assert.ok(!("error" in r));
    assert.equal(r.limit_commands, 500000);
    assert.equal(r.used_commands, 498964);
    assert.equal(r.used_pct, 99.79);
    assert.equal(r.read_commands, 230550);
    assert.equal(r.write_commands, 268414);
    assert.equal(r.auto_upgrade, false, "hard $0 ceiling — the FIX-570 design premise");
    assert.equal(r.plan, "free");
  });

  it("tracks a tier change instead of pinning the seeded limit", async () => {
    stubMgmt((p) => ({
      body: p.includes("/stats/")
        ? { ...DB_STATS, total_monthly_requests: 500000 }
        : { ...DB_DETAIL, db_request_limit: 10_000_000, type: "payg" },
    }));
    const r = await getUpstashUsage();
    assert.ok(!("error" in r));
    assert.equal(r.limit_commands, 10_000_000);
    assert.equal(r.used_pct, 5, "5% of the NEW cap, not 100% of the old one");
  });

  it("daily_net_commands near zero while monthly is at the cap is the real signature", async () => {
    // The 2026-08-16 reading: nothing is spent today because nothing CAN be.
    stubMgmt((p) => ({ body: p.includes("/stats/") ? DB_STATS : DB_DETAIL }));
    const r = await getUpstashUsage();
    assert.ok(!("error" in r));
    assert.equal(r.daily_commands, 1);
    assert.ok(r.used_pct > 99);
  });

  it("refuses to invent a denominator when db_request_limit is missing", async () => {
    stubMgmt((p) => ({
      body: p.includes("/stats/") ? DB_STATS : { ...DB_DETAIL, db_request_limit: undefined },
    }));
    const r = await getUpstashUsage();
    assert.ok("error" in r, "a wrong denominator is worse than no percentage");
    assert.match(r.error, /db_request_limit/);
  });

  it("returns the benign {error} shape for each missing credential", async () => {
    delete process.env.UPSTASH_API_KEY;
    const noKey = await getUpstashUsage();
    assert.ok("error" in noKey);
    assert.match(noKey.error, /UPSTASH_EMAIL\/UPSTASH_API_KEY/);

    process.env.UPSTASH_API_KEY = "mgmt-key";
    delete process.env.UPSTASH_DATABASE_ID;
    const noId = await getUpstashUsage();
    assert.ok("error" in noId);
    assert.match(noId.error, /UPSTASH_DATABASE_ID/);
    assert.match(noId.error, /upstash-db-id/, "the error must name the way to fix it");
  });

  it("surfaces an auth failure as a status, never echoing the response body", async () => {
    stubMgmt(() => ({ status: 401, body: { message: "unauthorized" } }));
    const r = await getUpstashUsage();
    assert.ok("error" in r);
    assert.match(r.error, /HTTP 401/);
    assert.doesNotMatch(r.error, /unauthorized/);
  });

  it("never surfaces the read_only_rest_token the detail endpoint returns", async () => {
    stubMgmt((p) => ({ body: p.includes("/stats/") ? DB_STATS : DB_DETAIL }));
    const r = await getUpstashUsage();
    assert.ok(!("error" in r));
    assert.doesNotMatch(JSON.stringify(r), /SECRET-SHOULD-NEVER-SURFACE/);
  });

  it("a thrown fetch degrades to {error} rather than propagating", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ENOTFOUND api.upstash.com");
    }) as unknown as typeof fetch;
    const r = await getUpstashUsage();
    assert.ok("error" in r);
    assert.match(r.error, /ENOTFOUND/);
  });

  it("caches across ticks — two calls issue one pair of GETs", async () => {
    const { paths } = stubMgmt((p) => ({ body: p.includes("/stats/") ? DB_STATS : DB_DETAIL }));
    await getUpstashUsage();
    await getUpstashUsage();
    assert.equal(paths.length, 2, "one /database and one /stats, not four");
  });
});

// ── Durable transitions ──────────────────────────────────────────────────────

/** Minimal stand-in for the two PostgREST calls recordUpstashLimiterState makes. */
function fakeDb(initial: unknown = null) {
  const store = { value: initial as Record<string, unknown> | null };
  const upserts: unknown[] = [];
  const db = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({
                  data: store.value === null ? null : { value: store.value },
                }),
              };
            },
          };
        },
        upsert: async (row: { value: Record<string, unknown> }) => {
          upserts.push(row);
          store.value = row.value;
          return { error: null };
        },
      };
    },
  };
  return { db, upserts, store };
}

describe("recordUpstashLimiterState", () => {
  it("the first observation records a transition from null", async () => {
    const { db, upserts } = fakeDb(null);
    const h = await recordUpstashLimiterState(db, "healthy");
    assert.equal(upserts.length, 1);
    assert.equal(h.previous_state, null);
    assert.equal(h.transitions.length, 1);
    assert.equal(h.transitions[0]!.to, "healthy");
    assert.ok(h.since);
  });

  it("an UNCHANGED state writes nothing at all — no per-tick write amplification", async () => {
    const { db, upserts } = fakeDb(null);
    await recordUpstashLimiterState(db, "healthy");
    assert.equal(upserts.length, 1);
    for (let i = 0; i < 20; i += 1) await recordUpstashLimiterState(db, "healthy");
    assert.equal(upserts.length, 1, "20 identical ticks must not write 20 rows");
  });

  it("`since` pins the start of the CURRENT state and does not move on a no-op tick", async () => {
    const { db } = fakeDb(null);
    const first = await recordUpstashLimiterState(db, "healthy");
    const again = await recordUpstashLimiterState(db, "healthy");
    assert.equal(again.since, first.since);
  });

  it("healthy → quota_exhausted → healthy appends both transitions, newest first", async () => {
    const { db } = fakeDb(null);
    await recordUpstashLimiterState(db, "healthy");
    const degraded = await recordUpstashLimiterState(db, "quota_exhausted");
    assert.equal(degraded.previous_state, "healthy");
    assert.equal(degraded.last_transition_at, degraded.since);

    const recovered = await recordUpstashLimiterState(db, "healthy");
    assert.equal(recovered.previous_state, "quota_exhausted");
    assert.equal(recovered.transitions.length, 3);
    assert.deepEqual(
      recovered.transitions.map((t) => t.to),
      ["healthy", "quota_exhausted", "healthy"],
    );
  });

  it("caps the stored history so the pipeline_state row cannot grow without bound", async () => {
    const { db } = fakeDb(null);
    const states: UpstashLimiterState[] = ["healthy", "quota_exhausted"];
    let last = { transitions: [] as { to: UpstashLimiterState }[] };
    for (let i = 0; i < 60; i += 1) {
      last = await recordUpstashLimiterState(db, states[i % 2]!);
    }
    assert.equal(last.transitions.length, 20);
  });

  it("a DB failure degrades to a fresh history instead of throwing the snapshot tick", async () => {
    const broken = {
      from() {
        throw new Error("connection refused");
      },
    };
    const h = await recordUpstashLimiterState(broken, "quota_exhausted");
    assert.equal(h.previous_state, null);
    assert.deepEqual(h.transitions, []);
  });
});
