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
  LIMITER_BUDGET_KEY,
  LIMITER_BUDGET_PCT_DEFAULT,
  resolveLimiterBudgetPct,
  budgetFor,
  resolveLimiterState,
  limiterBudgetFlag,
  writeLimiterBudgetFlag,
  clearLimiterBudgetFlag,
  estimateUsedCommands,
  readUsageHistory,
  runLimiterBudgetTick,
  USAGE_HISTORY_WINDOW_HOURS,
  type UpstashLimiterState,
  type UsageTick,
  type UsedEstimate,
} from "./upstash-usage";
import { MIDNIGHT_1104, MONTH_RESET, NOV_05_06, type UsageRow } from "./__fixtures__/upstash-usage-ticks";

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

// ── FIX-1304: the limiter's budget and its flag ──────────────────────────────

/** A management-API reading, at the vendor's cap unless told otherwise. */
const usageAt = (used: number, limit = 500_000) => ({
  limit_commands: limit,
  used_commands: used,
  used_pct: Math.round((used / limit) * 10000) / 100,
});

const healthy = {
  state: "healthy" as const,
  detail: null,
  limit_commands: null,
  usage_commands: null,
  attempts: 3,
  refusals: 0,
  latency_ms: 40,
  checked_at: "2026-10-14T00:00:00.000Z",
};

const fakeCreds = { url: "https://example.upstash.io", token: "test-token" };

/** FIX-1304's own cases read the counter alone; FIX-1313's estimate has its suite below. */
const ON_COUNTER: UsedEstimate = { basis: "counter", used_estimate: null, note: "test: counter only" };

/** A fetch stand-in for upstashRequest: records each command, answers `reply`. */
function flagFetch(reply: { status?: number; body: unknown }): { commands: unknown[]; impl: typeof fetch } {
  const commands: unknown[] = [];
  const impl = (async (_url: string, init?: RequestInit) => {
    commands.push(JSON.parse(String(init?.body)));
    const status = reply.status ?? 200;
    return { ok: status < 400, status, json: async () => reply.body } as unknown as Response;
  }) as unknown as typeof fetch;
  return { commands, impl };
}

describe("FIX-1304 — the limiter budget", () => {
  it("UPSTASH_LIMITER_BUDGET_PCT defaults to 70 and is validated to 10–95", () => {
    assert.equal(LIMITER_BUDGET_PCT_DEFAULT, 70);
    assert.deepEqual(resolveLimiterBudgetPct(undefined), { pct: 70, invalid: null });
    assert.deepEqual(resolveLimiterBudgetPct(""), { pct: 70, invalid: null });
    assert.deepEqual(resolveLimiterBudgetPct("60"), { pct: 60, invalid: null });
    assert.deepEqual(resolveLimiterBudgetPct("10"), { pct: 10, invalid: null });
    assert.deepEqual(resolveLimiterBudgetPct("95"), { pct: 95, invalid: null });
    for (const bad of ["9", "96", "100", "0", "-5", "seventy", "NaN", "Infinity"]) {
      const r = resolveLimiterBudgetPct(bad);
      assert.equal(r.pct, 70, `${bad} must fall back to the default`);
      assert.match(r.invalid ?? "", /UPSTASH_LIMITER_BUDGET_PCT/, `${bad} must say why`);
    }
  });

  it("the threshold sits at floor(limit × pct / 100), read off the vendor's cap: budget − 1 clear, budget and budget + 1 hold", () => {
    const at = (used: number) => budgetFor(usageAt(used), 70, ON_COUNTER);
    assert.equal(at(0).commands, 350_000);
    assert.equal(at(349_999).state, "clear");
    assert.equal(at(350_000).state, "hold");
    assert.equal(at(350_001).state, "hold");
    assert.deepEqual(at(350_000), {
      pct: 70,
      commands: 350_000,
      used: 350_000,
      used_pct: 70,
      used_counter: 350_000,
      used_estimate: null,
      basis: "counter",
      estimate_note: "test: counter only",
      state: "hold",
    });
    // The denominator is the vendor's own number, never a hard-coded 500,000.
    assert.equal(budgetFor(usageAt(0, 1_000_000), 70, ON_COUNTER).commands, 700_000);
    assert.equal(budgetFor(usageAt(0, 333_333), 70, ON_COUNTER).commands, 233_333, "floored, never rounded up");
  });

  it("the recorded state: quota_exhausted > budget_hold > unreachable > healthy", () => {
    const quota = { ...healthy, state: "quota_exhausted" as const, detail: "2/3 PINGs refused — " + QUOTA_ERROR, refusals: 2 };
    const unreachable = { ...healthy, state: "unreachable" as const, detail: "fetch failed" };
    const hold = budgetFor(usageAt(400_000), 70, ON_COUNTER);
    const clear = budgetFor(usageAt(100_000), 70, ON_COUNTER);
    const landed = { ok: true, error: null };
    const refused = { ok: false, error: `upstash 200: ${QUOTA_ERROR}` };
    const other = { ok: false, error: "upstash: fetch failed" };

    const table: [Parameters<typeof resolveLimiterState>[0], string][] = [
      [{ health: healthy, budget: clear, flagWrite: landed }, "healthy"],
      [{ health: healthy, budget: null, flagWrite: null }, "healthy"],
      [{ health: healthy, budget: clear, flagWrite: other }, "healthy"],
      [{ health: unreachable, budget: clear, flagWrite: other }, "unreachable"],
      [{ health: healthy, budget: hold, flagWrite: landed }, "budget_hold"],
      [{ health: unreachable, budget: hold, flagWrite: other }, "budget_hold"],
      [{ health: quota, budget: hold, flagWrite: landed }, "quota_exhausted"],
      [{ health: quota, budget: clear, flagWrite: landed }, "quota_exhausted"],
      [{ health: healthy, budget: hold, flagWrite: refused }, "quota_exhausted"],
      [{ health: healthy, budget: clear, flagWrite: refused }, "quota_exhausted"],
      [{ health: unreachable, budget: null, flagWrite: null }, "unreachable"],
    ];
    for (const [input, want] of table) {
      assert.equal(resolveLimiterState(input).state, want, JSON.stringify(input));
    }
    assert.match(resolveLimiterState({ health: healthy, budget: hold, flagWrite: landed }).detail ?? "", /400000.*350000/);
  });

  it("the flag: SET civitics:limiter:budget <json> EX 7200 on hold, DEL on clear, neither throws", async () => {
    const hold = budgetFor(usageAt(360_000), 70, ON_COUNTER);
    const flag = limiterBudgetFlag(hold, 500_000, "2026-10-14T00:00:00.000Z");
    assert.deepEqual(flag, {
      state: "hold",
      used: 360_000,
      basis: "counter",
      used_counter: 360_000,
      limit: 500_000,
      budget: 350_000,
      pct: 70,
      at: "2026-10-14T00:00:00.000Z",
    });

    const set = flagFetch({ body: { result: "OK" } });
    assert.deepEqual(await writeLimiterBudgetFlag(fakeCreds, flag, set.impl), { ok: true, error: null });
    assert.deepEqual(set.commands, [["SET", LIMITER_BUDGET_KEY, JSON.stringify(flag), "EX", "7200"]]);
    assert.equal(LIMITER_BUDGET_KEY, "civitics:limiter:budget");

    const del = flagFetch({ body: { result: 1 } });
    assert.deepEqual(await clearLimiterBudgetFlag(fakeCreds, del.impl), { ok: true, error: null });
    assert.deepEqual(del.commands, [["DEL", LIMITER_BUDGET_KEY]]);

    const thrown = (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    const r = await writeLimiterBudgetFlag(fakeCreds, flag, thrown);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /fetch failed/);
  });

  it("a refused flag write records quota_exhausted with the write detail while the PINGs read healthy", async () => {
    const hold = budgetFor(usageAt(499_774), 70, ON_COUNTER);
    const refused = flagFetch({ body: { error: QUOTA_ERROR } });
    const write = await writeLimiterBudgetFlag(
      fakeCreds,
      limiterBudgetFlag(hold, 500_000, "2026-10-14T00:00:00.000Z"),
      refused.impl,
    );
    assert.equal(write.ok, false);
    const resolved = resolveLimiterState({ health: healthy, budget: hold, flagWrite: write });
    assert.equal(resolved.state, "quota_exhausted");
    assert.match(resolved.detail ?? "", /^write refused: .*max requests limit exceeded/);
  });
});

// ── FIX-1313: the estimate the hold keys on ──────────────────────────────────

const toTicks = (rows: UsageRow[]): UsageTick[] =>
  rows.map(([ms, used, daily]) => ({ at: new Date(ms).toISOString(), used, daily }));
/** What the snapshot sees at tick k: the tick, and every earlier one newest first. */
const tickAt = (ticks: UsageTick[], k: number) => ({ now: ticks[k]!, prior: ticks.slice(0, k).reverse() });
const usageOf = (t: UsageTick) => ({ limit_commands: 500_000, used_commands: t.used });

type HistorySource = UsageTick[] | { error: { message: string } } | Error;

/** Stand-in for the one PostgREST read readUsageHistory makes; records its shape. */
function historyDb(source: HistorySource) {
  const seen: { table?: string; select?: string; gte?: [string, string]; order?: [string, unknown]; limit?: number } = {};
  const db = {
    from(table: string) {
      seen.table = table;
      const q = {
        select(s: string) {
          seen.select = s;
          return q;
        },
        gte(col: string, v: string) {
          seen.gte = [col, v];
          return q;
        },
        order(col: string, opts: unknown) {
          seen.order = [col, opts];
          return q;
        },
        async limit(n: number) {
          seen.limit = n;
          if (source instanceof Error) throw source;
          if (!Array.isArray(source)) return { data: null, error: source.error };
          const since = seen.gte![1];
          const rows = source
            .filter((t) => t.at >= since)
            .sort((a, b) => (a.at < b.at ? 1 : -1))
            .slice(0, n)
            .map((t) => ({ fetched_at: t.at, used: t.used, daily: t.daily }));
          return { data: rows, error: null };
        },
      };
      return q;
    },
  };
  return { db, seen };
}

describe("FIX-1313 — the estimate the hold keys on", () => {
  it("prod's 11-05 → 11-06 ticks: a 35 % budget engages at 13:31:06Z on the estimate, 16:01:11Z on the counter", () => {
    // cc-279 read 3. 10-12 itself is past the table's 30 days, so the real
    // series is November's, against a budget it actually crossed.
    const ticks = toTicks(NOV_05_06);
    const firstHold = (estimate: (k: number) => UsedEstimate) =>
      ticks.findIndex((t, k) => budgetFor(usageOf(t), 35, estimate(k)).state === "hold");
    const onEstimate = firstHold((k) => estimateUsedCommands(tickAt(ticks, k).now, tickAt(ticks, k).prior));
    const onCounter = firstHold(() => ON_COUNTER);
    assert.equal(ticks[onEstimate]!.at, "2026-11-06T13:31:06.613Z");
    assert.equal(ticks[onCounter]!.at, "2026-11-06T16:01:11.630Z");
    assert.equal(onCounter - onEstimate, 5, "five ticks, 2.5 h, earlier");

    const { now, prior } = tickAt(ticks, onEstimate);
    const b = budgetFor(usageOf(now), 35, estimateUsedCommands(now, prior));
    // The counter last moved to 174,906 at 13:01:15Z; daily grew 21,048 → 21,635 since.
    assert.deepEqual(
      { used: b.used, used_counter: b.used_counter, used_estimate: b.used_estimate, basis: b.basis, state: b.state },
      { used: 175_493, used_counter: 174_906, used_estimate: 175_493, basis: "estimate", state: "hold" },
    );
  });

  it("on every counter move in that series, the estimate at the tick before runs low by under 3 %, never high", () => {
    // Read 3's finding on 119 moves (p95 |2.92 %|, never above), held on the fixture.
    const ticks = toTicks(NOV_05_06);
    let moves = 0;
    for (let k = 3; k < ticks.length; k += 1) {
      if (ticks[k]!.used === ticks[k - 1]!.used) continue;
      const { now, prior } = tickAt(ticks, k - 1);
      const e = estimateUsedCommands(now, prior);
      if (e.basis !== "estimate") continue;
      const err = (e.used_estimate - ticks[k]!.used) / ticks[k]!.used;
      assert.ok(err <= 0 && err > -0.03, `${ticks[k]!.at}: estimate ${e.used_estimate} vs ${ticks[k]!.used}`);
      moves += 1;
    }
    assert.ok(moves >= 7, `only ${moves} moves checked`);
  });

  it("a counter move followed by flat daily → the estimate is the counter", () => {
    const ticks: UsageTick[] = [
      { at: "2026-11-14T01:01:00.000Z", used: 290_000, daily: 600 },
      { at: "2026-11-14T01:31:00.000Z", used: 290_985, daily: 683 },
      { at: "2026-11-14T02:01:00.000Z", used: 290_985, daily: 683 },
      { at: "2026-11-14T02:31:00.000Z", used: 290_985, daily: 683 },
    ];
    const { now, prior } = tickAt(ticks, 3);
    assert.deepEqual(estimateUsedCommands(now, prior), { basis: "estimate", used_estimate: 290_985, note: null });
    // And a move on THIS tick: nothing has grown since, so the estimate is the counter too.
    const real = toTicks(NOV_05_06);
    const move = tickAt(real, real.findIndex((t) => t.at === "2026-11-06T13:01:15.463Z"));
    assert.deepEqual(estimateUsedCommands(move.now, move.prior), { basis: "estimate", used_estimate: 174_906, note: null });
  });

  it("the 00:00Z daily reset adds the later tick's daily, never the negative difference", () => {
    // MIDNIGHT_1104 with the counter's own 00:01Z move masked (derived from the
    // real rows: on every November midnight the counter did move, so the reset
    // branch is the safety net for a midnight it does not). Last move 22:01:12Z.
    const ticks = toTicks(MIDNIGHT_1104).map((t) => (t.used === 77_771 ? { ...t, used: 72_568 } : t));
    const { now, prior } = tickAt(ticks, ticks.findIndex((t) => t.at === "2026-11-04T00:31:15.649Z"));
    // (31,413 − 28,483) up to 23:31Z, then 0 at 00:01Z, then 657.
    const e = estimateUsedCommands(now, prior);
    assert.deepEqual(e, { basis: "estimate", used_estimate: 72_568 + 2_930 + 0 + 657, note: null });
    // The counter's real value after midnight was 77,771: the estimate is 2.1 %
    // low by the 23:31 → 24:00 tail, which no tick saw.
    assert.ok((e.used_estimate! - 77_771) / 77_771 > -0.03);
  });

  it("a month reset: the estimate follows the counter down and the 70 % hold clears", () => {
    const ticks = toTicks(MONTH_RESET);
    const decide = (iso: string) => {
      const { now, prior } = tickAt(ticks, ticks.findIndex((t) => t.at === iso));
      return budgetFor(usageOf(now), 70, estimateUsedCommands(now, prior));
    };
    const before = decide("2026-10-31T23:31:07.193Z");
    assert.equal(before.state, "hold");
    assert.equal(before.used, 503_289 + (209 - 191), "the over-cap counter plus daily since its 22:01Z move");
    const reset = decide("2026-11-01T00:00:58.290Z");
    assert.deepEqual([reset.state, reset.used, reset.basis], ["clear", 0, "estimate"]);
    assert.deepEqual([decide("2026-11-01T00:30:58.766Z").used, decide("2026-11-01T01:00:58.810Z").used], [725, 1_033]);
  });

  it("no estimate → the counter, with the reason: failed read, fewer than two ticks, stale newest tick, no move", () => {
    const now: UsageTick = { at: "2026-11-14T04:01:11.000Z", used: 291_658, daily: 1_078 };
    const p1: UsageTick = { at: "2026-11-14T03:31:05.000Z", used: 290_985, daily: 1_009 };
    const p2: UsageTick = { at: "2026-11-14T03:01:19.000Z", used: 290_985, daily: 919 };
    const stale = [{ ...p1, at: "2026-11-14T02:01:11.000Z" }, { ...p2, at: "2026-11-14T01:31:11.000Z" }];
    const flatNow = { ...now, used: 290_985 };
    const cases: [UsageTick, Parameters<typeof estimateUsedCommands>[1], RegExp][] = [
      [now, { error: "connection refused" }, /^history read failed: connection refused$/],
      [now, [], /^fewer than two prior ticks \(0\)$/],
      [now, [p1], /^fewer than two prior ticks \(1\)$/],
      [now, stale, /^newest prior tick is 120 min old \(> 90\)$/],
      [flatNow, [p1, p2], /^no counter move in the window \(2 prior ticks\)$/],
    ];
    for (const [tick, prior, note] of cases) {
      const e = estimateUsedCommands(tick, prior);
      assert.equal(e.basis, "counter");
      assert.equal(e.used_estimate, null);
      assert.match(e.note ?? "", note);
      const b = budgetFor(usageOf(tick), 70, e);
      assert.equal(b.used, tick.used, "the hold reads the counter, as before FIX-1313");
      assert.equal(b.basis, "counter");
      assert.match(b.estimate_note ?? "", note);
    }
    // 90 min exactly is still a basis.
    assert.equal(estimateUsedCommands(now, [{ ...p1, at: "2026-11-14T02:31:11.000Z" }, p2]).basis, "estimate");
  });

  it("budgetFor holds on max(counter, estimate) and records both", () => {
    const est = (n: number): UsedEstimate => ({ basis: "estimate", used_estimate: n, note: null });
    assert.deepEqual(budgetFor(usageAt(340_000), 70, est(351_000)), {
      pct: 70,
      commands: 350_000,
      used: 351_000,
      used_pct: 70.2,
      used_counter: 340_000,
      used_estimate: 351_000,
      basis: "estimate",
      estimate_note: null,
      state: "hold",
    });
    assert.equal(budgetFor(usageAt(340_000), 70, est(349_999)).state, "clear");
    // estimateUsedCommands never returns one below the counter; budgetFor does not trust that.
    assert.equal(budgetFor(usageAt(352_000), 70, est(1)).used, 352_000);
  });

  it("the flag's used and the state's detail name the basis", () => {
    const onEstimate = budgetFor(usageAt(340_000), 70, { basis: "estimate", used_estimate: 351_000, note: null });
    assert.deepEqual(limiterBudgetFlag(onEstimate, 500_000, "2026-11-14T04:01:11.000Z"), {
      state: "hold",
      used: 351_000,
      basis: "estimate",
      used_counter: 340_000,
      limit: 500_000,
      budget: 350_000,
      pct: 70,
      at: "2026-11-14T04:01:11.000Z",
    });
    const landed = { ok: true, error: null };
    assert.equal(
      resolveLimiterState({ health: healthy, budget: onEstimate, flagWrite: landed }).detail,
      "budget hold: used 351000 (estimate: counter 340000 + daily's growth since its last move) ≥ budget 350000 (70 % of the cap)",
    );
    const onCounter = budgetFor(
      usageAt(360_000),
      70,
      estimateUsedCommands({ at: "2026-11-14T04:01:11.000Z", used: 360_000, daily: 9 }, { error: "timeout" }),
    );
    assert.equal(
      resolveLimiterState({ health: healthy, budget: onCounter, flagWrite: landed }).detail,
      "budget hold: used 360000 (counter; no estimate — history read failed: timeout) ≥ budget 350000 (70 % of the cap)",
    );
  });

  it("readUsageHistory: one read of the last 24 h, the two counters only, newest first, rows with no usage skipped", async () => {
    const ticks = toTicks(NOV_05_06);
    const now = ticks.at(-1)!;
    const { db, seen } = historyDb(ticks.slice(0, -1));
    const out = await readUsageHistory(db, now.at);
    assert.ok(Array.isArray(out));
    assert.equal(seen.table, "platform_usage_snapshot");
    assert.equal(
      seen.select,
      "fetched_at, used:payload->upstash->usage->used_commands, daily:payload->upstash->usage->daily_commands",
    );
    assert.deepEqual(seen.gte, ["fetched_at", new Date(Date.parse(now.at) - 24 * 3_600_000).toISOString()]);
    assert.deepEqual(seen.order, ["fetched_at", { ascending: false }]);
    assert.equal(USAGE_HISTORY_WINDOW_HOURS, 24);
    assert.ok(out.length > 40 && out.length < 49, `${out.length} ticks inside 24 h`);
    assert.ok(out[0]!.at > out[1]!.at, "newest first");

    // The 11-12T07:01Z row had no usage block (the management API failed that tick).
    const rows = [
      { fetched_at: "2026-11-12T07:31:05Z", used: 277_000, daily: 3_100 },
      { fetched_at: "2026-11-12T07:01:14Z", used: null, daily: null },
      { fetched_at: "2026-11-12T06:31:05Z", used: "276500", daily: "2900" },
    ];
    const chain = { select: () => chain, gte: () => chain, order: () => chain, limit: async () => ({ data: rows, error: null }) };
    assert.deepEqual(await readUsageHistory({ from: () => chain }, "2026-11-12T08:01:00Z"), [
      { at: "2026-11-12T07:31:05Z", used: 277_000, daily: 3_100 },
      { at: "2026-11-12T06:31:05Z", used: 276_500, daily: 2_900 },
    ]);

    assert.deepEqual(await readUsageHistory(historyDb({ error: { message: "permission denied" } }).db, now.at), {
      error: "permission denied",
    });
    assert.deepEqual(await readUsageHistory(historyDb(new Error("fetch failed")).db, now.at), { error: "fetch failed" });
  });

  it("runLimiterBudgetTick issues exactly one flag command in every case, and none without creds", async () => {
    const ticks = toTicks(NOV_05_06);
    const k = ticks.findIndex((t) => t.at === "2026-11-06T13:31:06.613Z");
    const now = ticks[k]!;
    const usage = { limit_commands: 500_000, used_commands: now.used, daily_commands: now.daily, fetched_at: now.at };
    const flatHistory: UsageTick[] = [1, 2, 3].map((i) => ({
      at: new Date(Date.parse(now.at) - i * 1_800_000).toISOString(),
      used: now.used,
      daily: now.daily,
    }));
    const cases: [string, HistorySource, number, "SET" | "DEL", "estimate" | "counter"][] = [
      ["estimate, hold", ticks.slice(0, k), 35, "SET", "estimate"],
      ["estimate, clear", ticks.slice(0, k), 70, "DEL", "estimate"],
      ["read failed (error)", { error: { message: "permission denied" } }, 35, "DEL", "counter"],
      ["read failed (throw), counter over budget", new Error("fetch failed"), 30, "SET", "counter"],
      ["fewer than two ticks", ticks.slice(k - 1, k), 35, "DEL", "counter"],
      ["stale newest tick", ticks.slice(0, k - 4), 35, "DEL", "counter"],
      ["no move in the window", flatHistory, 35, "DEL", "counter"],
    ];
    for (const [name, source, pct, verb, basis] of cases) {
      const flag = flagFetch({ body: { result: verb === "SET" ? "OK" : 1 } });
      const { budget, flagWrite } = await runLimiterBudgetTick({
        db: historyDb(source).db,
        usage,
        pct,
        creds: fakeCreds,
        fetchImpl: flag.impl,
      });
      assert.equal(flag.commands.length, 1, `${name}: one flag command`);
      assert.equal((flag.commands[0] as string[])[0], verb, name);
      assert.equal(budget.basis, basis, name);
      assert.equal(flagWrite?.ok, true, name);
      if (verb === "SET") {
        const value = JSON.parse((flag.commands[0] as string[])[2]!);
        assert.equal(value.basis, basis, `${name}: the flag names its basis`);
        assert.equal(value.used, budget.used);
      }
    }
    const none = flagFetch({ body: { result: "OK" } });
    const r = await runLimiterBudgetTick({
      db: historyDb(ticks.slice(0, k)).db,
      usage,
      pct: 35,
      creds: null,
      fetchImpl: none.impl,
    });
    assert.equal(none.commands.length, 0);
    assert.equal(r.flagWrite, null);
    assert.equal(r.budget.state, "hold");
  });
});
