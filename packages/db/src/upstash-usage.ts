/**
 * Upstash edge-limiter health — for the Platform Costs card (FIX-1038).
 *
 * WHY THIS EXISTS. On 2026-08-15 the Upstash free-tier allotment (500,000
 * commands per billing period) was spent in 15.5 hours by a crawler, every bucket
 * in `apps/civitics/src/lib/ratelimit.ts` began erroring, and **nothing
 * anywhere noticed** — Upstash was the one vendor in the cost chain that
 * `platform_usage_snapshot` did not track. A hard $0-ceiling cost control
 * switched itself off silently. See docs/audits/2026-08-15-traffic-cost-spike.md.
 *
 * ── Two independent readings, and they do NOT agree ──────────────────────────
 *
 * This module exposes both, because each sees something the other cannot:
 *
 *   getUpstashHealth()  — data plane. PINGs the REST endpoint with the
 *                         per-database token. Answers "is the limiter working
 *                         RIGHT NOW", which is the only question that matters
 *                         during an incident.
 *   getUpstashUsage()   — control plane. Reads the management API with an
 *                         account-level key. Answers "how close are we", which
 *                         is the only question that lets you act BEFORE one.
 *
 * They are not redundant and they measurably disagree. At 2026-08-16 03:5x UTC
 * the management API reported `total_monthly_requests: 498964` — i.e. *under*
 * the 500,000 cap — while the data plane was already refusing commands with
 * `Usage: 500002`. **The billing counter lags enforcement.** So the usage number
 * is a leading indicator and never a liveness verdict: never conclude "we are
 * under quota, therefore the limiter works" from it. That is what the PING is
 * for, and it is why both survive.
 *
 * ── The health probe ─────────────────────────────────────────────────────────
 *
 * A few cheap `PING`s per snapshot tick resolve to one of three states:
 *
 *   healthy         — every PING answered PONG.
 *   quota_exhausted — at least one PING drew "ERR max requests limit exceeded".
 *                     This is the 2026-08-15 condition, verbatim. Buckets are
 *                     dropping to the per-instance memory fail-over.
 *   unreachable     — network/auth failure. Same practical consequence.
 *
 * ── Why MORE THAN ONE ping, measured 2026-08-16 03:10 UTC ────────────────────
 *
 * Over-quota Upstash does **not** refuse deterministically. Eight probes 3 s
 * apart, same credentials, same process, returned:
 *
 *   healthy, healthy, QUOTA, healthy, healthy, QUOTA, healthy, QUOTA
 *
 * — a ~38% refusal rate while the counter sat frozen at `Usage: 500002`. So a
 * PONG is **not** evidence of health, while a single refusal **is** proof the
 * cap has been crossed. A one-ping probe would have reported "healthy" through
 * roughly 60% of ticks of the very incident it exists to catch, which is the
 * FIX-1038 blindness reproduced in the instrument.
 *
 * PROBE_ATTEMPTS = 3 therefore: P(all three miss) ≈ 0.62³ ≈ 24% for one tick
 * — and `refusals`/`attempts` ride in the payload so severity is visible, not
 * just the boolean. The tick is the half-hourly Vercel cron (FIX-1127), not the
 * 10 minutes this was written against: 3 commands × 48 ticks = 144/day against
 * 500,000. Note this also softens the audit's "the limiter is FULLY open"
 * reading: over quota it is intermittently open, not uniformly dead.
 *
 * 24 % per tick was not a bound in practice: 10-13 → 10-15 the recorded state
 * flipped healthy ↔ quota_exhausted every 30–90 min while the allotment stayed
 * spent. FIX-1304's flag write is the deterministic half (resolveLimiterState).
 *
 * ── THE ALLOTMENT IS MONTHLY. Settled 2026-08-16, do not re-litigate ─────────
 *
 * The triage prompt assumed 500,000 commands/**day**. It is per month. Measured
 * straight off the vendor, not inferred:
 *
 *   GET /v2/redis/database/{id}  →  db_request_limit: 500000, auto_upgrade: false
 *   GET /v2/redis/stats/{id}     →  total_monthly_requests: 498964
 *                                   (read 230550 / write 268414)
 *                                   daily_net_commands: 1
 *
 * Corroborated by the earlier data-plane observation that the counter had NOT
 * reset 5h38m after exhaustion, across a 00:00 UTC boundary, and by the audit's
 * own "~55 days at baseline" figure — which only parses against a per-month cap.
 *
 * **The consequence is the whole reason FIX-1038's fail-over matters.** One
 * 16-hour crawl did not cost a day of rate limiting; it cost the REST OF THE
 * BILLING CYCLE. `daily_net_commands: 1` against `total_monthly_requests:
 * 498964` is that fact in two numbers: nothing is being spent today because
 * nothing CAN be. A daily reset would have self-healed by breakfast. This one
 * does not, which is exactly why `checkRateLimit` now fails OVER instead of open.
 *
 * The quota error also discloses numbers (`Limit: 500000, Usage: 500002`) and
 * they are still parsed here — that path is the fallback when the management
 * key is absent, and it is the only reading available at all in that case. Note
 * the enforcement counter FREEZES on crossing (hence "500002" — two over, not a
 * running total), so it confirms the cap was reached and dates nothing.
 *
 * Neither function throws. Missing env returns `{ error }` matching the
 * convention every other vendor helper here uses, so the snapshot writer treats
 * it as benign and the whole block simply does not appear in the payload.
 *
 * ── FIX-1304: the budget, and a write-class probe ────────────────────────────
 *
 * One Upstash database (the free tier allows one; pay-as-you-go is ruled out)
 * carries three tenants: the edge limiter (traffic-proportional, unbounded
 * under a crawl), the box-health ring and the front-door restart arm (both
 * flat). This probe holds the limiter to a share of the vendor's cap — see
 * "The limiter's budget" below — so a crawl cannot spend the other two's share.
 * The flag SET/DEL it issues every tick is also the write-class reading the
 * PINGs cannot give: over quota, reads land intermittently and writes do not
 * (cc-229: the ring's last write landed 20:30:22Z on 10-12, the PINGs read
 * healthy until 22:30:46Z).
 */

import { upstashRequest, type UpstashCreds } from "./box-health-store";

const CACHE_TTL_MS = 60 * 1000;
const PROBE_TIMEOUT_MS = 5_000;
/** See the header: a PONG does not prove health, a refusal proves exhaustion. */
const PROBE_ATTEMPTS = 3;

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * `budget_hold` (FIX-1304): the management API reads used ≥ the limiter's
 * budget, so the probe has written the flag that sends the edge limiter to its
 * per-instance memory path. Deliberately a non-healthy state: the limiter IS
 * weaker while it holds, and the transition is the early warning FIX-1038 asked
 * for — it fires at 70 % of the cap, not at 100 %.
 */
export type UpstashLimiterState = "healthy" | "quota_exhausted" | "budget_hold" | "unreachable";

export type UpstashHealth = {
  state: UpstashLimiterState;
  /** Vendor message on a non-healthy state; null when healthy. */
  detail: string | null;
  /** Parsed from the quota error only — null whenever Upstash is not refusing. */
  limit_commands: number | null;
  usage_commands: number | null;
  /** How many PINGs were issued, and how many Upstash refused. Over quota the
   *  refusal rate is partial (~38% measured), so the ratio is the severity. */
  attempts: number;
  refusals: number;
  latency_ms: number;
  checked_at: string;
};

export type UpstashHealthError = { error: string };

// ── Probe ─────────────────────────────────────────────────────────────────────

let cache: { at: number; value: UpstashHealth } | null = null;

/** `ERR max requests limit exceeded. Limit: 500000, Usage: 500002.` → the pair. */
export function parseQuotaError(
  message: string,
): { limit: number; usage: number } | null {
  const m = /Limit:\s*(\d+)[,.\s]+Usage:\s*(\d+)/i.exec(message);
  if (!m) return null;
  return { limit: Number(m[1]), usage: Number(m[2]) };
}

/** True for the exhausted-allotment message Upstash returns once the cap is hit. */
export function isQuotaExhaustedMessage(message: string): boolean {
  return /max\s+requests\s+limit\s+exceeded|max\s+daily\s+request\s+limit|quota\s+exceeded/i.test(
    message,
  );
}

export async function getUpstashHealth(): Promise<UpstashHealth | UpstashHealthError> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return { error: "UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN not set" };
  }

  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const startedAt = Date.now();
  const finish = (
    state: UpstashLimiterState,
    detail: string | null,
    quota: { limit: number; usage: number } | null,
    attempts: number,
    refusals: number,
  ): UpstashHealth => {
    const value: UpstashHealth = {
      state,
      detail,
      limit_commands: quota?.limit ?? null,
      usage_commands: quota?.usage ?? null,
      attempts,
      refusals,
      latency_ms: Date.now() - startedAt,
      checked_at: new Date().toISOString(),
    };
    cache = { at: Date.now(), value };
    return value;
  };

  /** One PING. Never throws — every failure mode is a classified outcome. */
  async function ping(): Promise<
    | { kind: "ok" }
    | { kind: "quota"; detail: string; quota: { limit: number; usage: number } | null }
    | { kind: "bad"; detail: string }
  > {
    try {
      const res = await fetch(url!, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token!}`,
          "Content-Type": "application/json",
        },
        // Deliberately the cheapest command Upstash offers — this probe must
        // never be a meaningful share of the budget it is watching.
        body: JSON.stringify(["PING"]),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });

      // Upstash returns quota/auth failures as {"error": "..."} — sometimes with
      // HTTP 200, sometimes 4xx — so the body is checked either way.
      let body: { result?: unknown; error?: string } | null = null;
      try {
        body = (await res.json()) as { result?: unknown; error?: string };
      } catch {
        body = null;
      }

      const vendorError = body?.error ?? null;
      if (vendorError) {
        if (isQuotaExhaustedMessage(vendorError)) {
          return { kind: "quota", detail: vendorError, quota: parseQuotaError(vendorError) };
        }
        return { kind: "bad", detail: `${res.status}: ${vendorError}` };
      }
      if (!res.ok) return { kind: "bad", detail: `HTTP ${res.status} ${res.statusText}` };
      if (body?.result !== "PONG") {
        return { kind: "bad", detail: `unexpected PING result: ${JSON.stringify(body?.result)}` };
      }
      return { kind: "ok" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A fetch rejection can still carry the quota message on some transports.
      if (isQuotaExhaustedMessage(message)) {
        return { kind: "quota", detail: message, quota: parseQuotaError(message) };
      }
      return { kind: "bad", detail: message };
    }
  }

  let attempts = 0;
  let refusals = 0;
  let anyOk = false;
  let lastBad: string | null = null;
  let quotaDetail: string | null = null;
  let quotaNumbers: { limit: number; usage: number } | null = null;

  for (let i = 0; i < PROBE_ATTEMPTS; i += 1) {
    attempts += 1;
    const r = await ping();
    if (r.kind === "quota") {
      refusals += 1;
      quotaDetail = r.detail;
      quotaNumbers = quotaNumbers ?? r.quota;
      // A single refusal is proof the cap is crossed — but keep probing so
      // `refusals/attempts` reports the severity rather than just the fact.
    } else if (r.kind === "ok") {
      anyOk = true;
    } else {
      lastBad = r.detail;
    }
  }

  if (refusals > 0) {
    return finish(
      "quota_exhausted",
      `${refusals}/${attempts} PINGs refused — ${quotaDetail}`,
      quotaNumbers,
      attempts,
      refusals,
    );
  }
  if (anyOk) return finish("healthy", null, null, attempts, refusals);
  return finish("unreachable", lastBad ?? "no successful PING", null, attempts, refusals);
}

/** Test hook — drops the module cache so a suite can probe twice. */
export function __resetUpstashHealthCache(): void {
  cache = null;
  usageCache = null;
}

// ── Control plane: how close to the cap are we? ───────────────────────────────
//
// The LEADING indicator the health probe cannot be. The probe tells you the
// limiter is dead; this tells you it is going to be, while there is still time
// to do something. Two GETs against the management API per tick, cached 5 min
// (the snapshot cron runs every 30) — these do NOT count against the Redis
// command allotment, they are a different API.
//
// SECURITY. UPSTASH_API_KEY is an UNSCOPED account-level credential — Upstash
// lists per-privilege keys as a roadmap item, not a shipped feature — so it can
// delete databases. Everything here is a GET, the key is never logged, and the
// response's `read_only_rest_token` / `password` fields are never read or
// surfaced. Treat it as a higher-privilege secret than UPSTASH_REDIS_REST_TOKEN.

const USAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const MGMT_API = "https://api.upstash.com/v2";
const MGMT_TIMEOUT_MS = 8_000;

export type UpstashUsage = {
  database_id: string;
  database_name: string | null;
  /** Vendor's own cap (`db_request_limit`) — read, never hardcoded. */
  limit_commands: number;
  /** `total_monthly_requests`. LAGS enforcement; see the header. */
  used_commands: number;
  used_pct: number;
  read_commands: number;
  write_commands: number;
  /** Today only. Near-zero while over quota — nothing can be spent. */
  daily_commands: number;
  /** false = hard $0 ceiling (exhaustion throttles instead of billing). */
  auto_upgrade: boolean;
  plan: string | null;
  /**
   * FIX-1089: `creation_time` (epoch SECONDS) as an ISO string — the anchor for
   * the billing cycle. The allotment is per BILLING PERIOD, and the period is
   * the monthly anniversary of this date, NOT the calendar month: measured
   * 1781337093 = 2026-06-13T07:51:33Z, so it rolls on the 13th.
   *
   * That gap is the whole point. On 2026-08-15 a crawler spent the entire
   * 500,000 in 15.5 hours; "99.8% used" with no cycle end cannot answer the
   * only question anyone had — when does the rate limiter come back — and the
   * calendar-month answer (Sep 1) is wrong by twelve days.
   *
   * CONTRADICTED since (FIX-1314): the only observed reset was 09-01T00:01:16Z,
   * and 10-13 07:51Z passed with used still at 499,693. The reset reads as
   * calendar. The field stays; the cycle built from it is FIX-1314's.
   */
  created_at: string | null;
  fetched_at: string;
};

export type UpstashUsageError = { error: string };

let usageCache: { at: number; value: UpstashUsage } | null = null;

function num(value: unknown, fallback = 0): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

export async function getUpstashUsage(): Promise<UpstashUsage | UpstashUsageError> {
  const email = process.env.UPSTASH_EMAIL;
  const apiKey = process.env.UPSTASH_API_KEY;
  const dbId = process.env.UPSTASH_DATABASE_ID;
  if (!email || !apiKey) {
    return { error: "UPSTASH_EMAIL/UPSTASH_API_KEY not set" };
  }
  if (!dbId) {
    // Deliberately NOT auto-discovered here. Resolving it means listing every
    // database on the account on every tick; `node scripts/upstash-db-id.mjs`
    // does that once and prints the line to paste.
    return { error: "UPSTASH_DATABASE_ID not set (run scripts/upstash-db-id.mjs)" };
  }

  if (usageCache && Date.now() - usageCache.at < USAGE_CACHE_TTL_MS) {
    return usageCache.value;
  }

  const auth = `Basic ${Buffer.from(`${email}:${apiKey}`).toString("base64")}`;
  // Tagged union, not `{ __error }` on the payload type: the payload is a
  // Record<string, unknown>, whose index signature makes `"__error" in x`
  // useless for narrowing (it resolves to `unknown`, not `string`).
  type Fetched =
    | { ok: true; data: Record<string, unknown> }
    | { ok: false; error: string };

  async function get(path: string): Promise<Fetched> {
    try {
      const res = await fetch(`${MGMT_API}${path}`, {
        headers: { Authorization: auth },
        signal: AbortSignal.timeout(MGMT_TIMEOUT_MS),
      });
      if (!res.ok) {
        // Never echo the body — an auth failure response can be noisy and the
        // status is the actionable part.
        return { ok: false, error: `HTTP ${res.status} on ${path}` };
      }
      return { ok: true, data: (await res.json()) as Record<string, unknown> };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const [detailRes, statsRes] = await Promise.all([
    get(`/redis/database/${dbId}`),
    get(`/redis/stats/${dbId}`),
  ]);
  if (!detailRes.ok) return { error: detailRes.error };
  if (!statsRes.ok) return { error: statsRes.error };
  const detail = detailRes.data;
  const stats = statsRes.data;

  // db_request_limit is the vendor's own cap. If it is ever absent, fail rather
  // than substituting 500000 — a wrong denominator produces a confidently wrong
  // percentage, which is worse than no percentage.
  const limit = num(detail.db_request_limit, 0);
  if (limit <= 0) {
    return { error: "db_request_limit missing from /redis/database response" };
  }
  const used = num(stats.total_monthly_requests, 0);

  const value: UpstashUsage = {
    database_id: dbId,
    database_name: typeof detail.database_name === "string" ? detail.database_name : null,
    limit_commands: limit,
    used_commands: used,
    used_pct: Math.round((used / limit) * 10000) / 100,
    read_commands: num(stats.total_monthly_read_requests),
    write_commands: num(stats.total_monthly_write_requests),
    daily_commands: num(stats.daily_net_commands),
    auto_upgrade: detail.auto_upgrade === true,
    plan: typeof detail.type === "string" ? detail.type : null,
    created_at: (() => {
      const t = num(detail.creation_time, 0);
      // Epoch SECONDS, not ms — a raw pass-through would date the account to
      // 1970 and put the cycle anchor on the wrong day of the month.
      return t > 0 ? new Date(t * 1000).toISOString() : null;
    })(),
    fetched_at: new Date().toISOString(),
  };
  usageCache = { at: Date.now(), value };
  return value;
}

/** Test hook — drops the usage cache independently of the health cache. */
export function __resetUpstashUsageCache(): void {
  usageCache = null;
}

// ── FIX-1304: the limiter's budget ────────────────────────────────────────────
//
// THE HOG IS BUDGETED; NOTHING MOVES. The limiter spends ~150k commands a month
// at human traffic and has no ceiling under a crawl; the box-health ring (2 per
// */2 sample, ~43k/month) and the front-door restart arm (one MGET per */2
// tick, ~25k/month) are flat. Twice (08-15, 10-12) a crawl spent all 500,000 and
// the ring and the arm went dark for the rest of the billing period. So once the
// management API reads used ≥ pct of the vendor's cap, this probe writes a flag
// and the edge limiter (apps/civitics/src/lib/ratelimit.ts) takes its
// per-instance memory path BEFORE the quota is gone. At the default 70 % the
// other two keep 150,000 commands: twice their monthly 68k.
//
// The flag lives in the same database, under LIMITER_BUDGET_KEY, with a 2 h TTL
// rewritten every tick while the hold lasts and DELeted once used < budget. The
// TTL is what keeps a dead probe from pinning the limiter in memory forever:
// four missed */30 ticks and the limiter spends again, which is the pre-FIX
// behaviour rather than a new failure. The edge has no admin client, and
// Postgres is the thing a wedge takes down, so the flag cannot live there.
//
// LAG. The hold engages one probe tick (≤ 30 min) after `total_monthly_requests`
// crosses the budget — and that counter is itself stale: on 10-12 it moved in
// ~3 h steps (241,414 → 375,889 at 19:00Z → 499,669 at 22:00Z) while
// `daily_commands` climbed every tick. See FIX-1313.

/** Must equal BUDGET_FLAG_KEY in apps/civitics/src/lib/ratelimit.ts. */
export const LIMITER_BUDGET_KEY = "civitics:limiter:budget";
export const LIMITER_BUDGET_TTL_SECONDS = 7_200;
export const LIMITER_BUDGET_PCT_DEFAULT = 70;
const LIMITER_BUDGET_PCT_MIN = 10;
const LIMITER_BUDGET_PCT_MAX = 95;
const FLAG_TIMEOUT_MS = 5_000;

/**
 * UPSTASH_LIMITER_BUDGET_PCT, validated. Absent or empty is the default and is
 * not an error; anything else outside 10–95 falls back to the default and says
 * why, so a typo cannot silently disable the hold (0) or make it permanent.
 */
export function resolveLimiterBudgetPct(raw: string | undefined): { pct: number; invalid: string | null } {
  if (raw === undefined || raw.trim() === "") return { pct: LIMITER_BUDGET_PCT_DEFAULT, invalid: null };
  const n = Number(raw);
  if (Number.isFinite(n) && n >= LIMITER_BUDGET_PCT_MIN && n <= LIMITER_BUDGET_PCT_MAX) {
    return { pct: n, invalid: null };
  }
  return {
    pct: LIMITER_BUDGET_PCT_DEFAULT,
    invalid:
      `UPSTASH_LIMITER_BUDGET_PCT=${JSON.stringify(raw)} is not a number in ` +
      `${LIMITER_BUDGET_PCT_MIN}–${LIMITER_BUDGET_PCT_MAX}; using ${LIMITER_BUDGET_PCT_DEFAULT}`,
  };
}

export type LimiterBudget = {
  pct: number;
  /** floor(limit_commands × pct / 100) — the vendor's cap, never a constant. */
  commands: number;
  used: number;
  used_pct: number;
  state: "clear" | "hold";
};

export function budgetFor(
  usage: Pick<UpstashUsage, "limit_commands" | "used_commands" | "used_pct">,
  pct: number,
): LimiterBudget {
  const commands = Math.floor((usage.limit_commands * pct) / 100);
  return {
    pct,
    commands,
    used: usage.used_commands,
    used_pct: usage.used_pct,
    state: usage.used_commands >= commands ? "hold" : "clear",
  };
}

/** The flag's value. `pct` is the budget's percentage, not usage. */
export type LimiterBudgetFlag = {
  state: "hold";
  used: number;
  limit: number;
  budget: number;
  pct: number;
  at: string;
};

export function limiterBudgetFlag(budget: LimiterBudget, limit: number, at: string): LimiterBudgetFlag {
  return { state: "hold", used: budget.used, limit, budget: budget.commands, pct: budget.pct, at };
}

export type LimiterFlagWrite = { ok: boolean; error: string | null };

/** SET the flag with its TTL. One command. Never throws. */
export async function writeLimiterBudgetFlag(
  creds: UpstashCreds,
  flag: LimiterBudgetFlag,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = FLAG_TIMEOUT_MS,
): Promise<LimiterFlagWrite> {
  const r = await upstashRequest(
    creds,
    "",
    ["SET", LIMITER_BUDGET_KEY, JSON.stringify(flag), "EX", String(LIMITER_BUDGET_TTL_SECONDS)],
    fetchImpl,
    timeoutMs,
  );
  if (!r.ok) return { ok: false, error: r.error };
  const result = (r.reply as { result?: unknown } | null)?.result;
  return result === "OK" ? { ok: true, error: null } : { ok: false, error: `upstash SET: unexpected ${JSON.stringify(result)}` };
}

/** DEL the flag. One command; deleting an absent key is a success. Never throws. */
export async function clearLimiterBudgetFlag(
  creds: UpstashCreds,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = FLAG_TIMEOUT_MS,
): Promise<LimiterFlagWrite> {
  const r = await upstashRequest(creds, "", ["DEL", LIMITER_BUDGET_KEY], fetchImpl, timeoutMs);
  return r.ok ? { ok: true, error: null } : { ok: false, error: r.error };
}

/**
 * The state this tick records. Precedence: quota_exhausted > budget_hold >
 * unreachable > healthy.
 *
 * A refused flag write means quota_exhausted even when every PING answered:
 * over quota, reads land intermittently and writes do not, and the limiter's
 * sliding window is writes. A write that fails for any other reason does not
 * change the state; the payload's budget.flag_error carries it.
 */
export function resolveLimiterState(input: {
  health: Pick<UpstashHealth, "state" | "detail">;
  budget: LimiterBudget | null;
  flagWrite: LimiterFlagWrite | null;
}): { state: UpstashLimiterState; detail: string | null } {
  const { health, budget, flagWrite } = input;
  const writeRefused =
    flagWrite !== null && !flagWrite.ok && isQuotaExhaustedMessage(flagWrite.error ?? "");
  if (writeRefused) {
    const pings = health.state === "quota_exhausted" ? ` · ${health.detail}` : "";
    return { state: "quota_exhausted", detail: `write refused: ${flagWrite.error}${pings}` };
  }
  if (health.state === "quota_exhausted") return { state: "quota_exhausted", detail: health.detail };
  if (budget?.state === "hold") {
    const unwritten = flagWrite && !flagWrite.ok ? ` — flag NOT written: ${flagWrite.error}` : "";
    return {
      state: "budget_hold",
      detail: `budget hold: used ${budget.used} ≥ budget ${budget.commands} (${budget.pct} % of the cap)${unwritten}`,
    };
  }
  if (health.state === "unreachable") return { state: "unreachable", detail: health.detail };
  return { state: "healthy", detail: null };
}

// ── Durable state-TRANSITION record (FIX-1040) ────────────────────────────────
//
// FIX-1040's rule: durable signals are state TRANSITIONS, not per-request rows.
// A per-request durable write at the 7,200 req/hr this incident ran at is a
// second self-inflicted incident, so nothing here scales with traffic — one
// read + at most one write per 30-minute snapshot tick, and the write only
// happens when the state actually changes.
//
// It lives on the SNAPSHOT side rather than in the edge limiter on purpose: an
// edge instance has no admin client and cannot durably record anything cheaply
// or safely, and its view is per-instance anyway. This probe sees the shared
// cause (Upstash unusable) from a Node runtime that can write to the DB. The
// cost is latency — up to one cron interval, not instant. `getLimiterHealth()`
// in the app is the per-instance complement.

const LIMITER_STATE_KEY = "upstash_limiter_health";
const MAX_TRANSITION_HISTORY = 20;

export type UpstashLimiterTransition = {
  at: string;
  from: UpstashLimiterState | null;
  to: UpstashLimiterState;
};

export type UpstashLimiterHistory = {
  /** When the CURRENT state began — the "DEGRADED since 14:32 UTC" the card shows. */
  since: string;
  previous_state: UpstashLimiterState | null;
  last_transition_at: string | null;
  /** Most recent first, capped so the row cannot grow without bound. */
  transitions: UpstashLimiterTransition[];
};

/**
 * Compare `state` against the last recorded one and, on a change, append a
 * durable transition to `pipeline_state.upstash_limiter_health`. Returns the
 * history either way so the caller can put it in the snapshot payload.
 *
 * Never throws: a failure here must not cost the snapshot tick.
 */
export async function recordUpstashLimiterState(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  state: UpstashLimiterState,
): Promise<UpstashLimiterHistory> {
  const now = new Date().toISOString();
  const fresh: UpstashLimiterHistory = {
    since: now,
    previous_state: null,
    last_transition_at: null,
    transitions: [],
  };

  try {
    const { data } = await db
      .from("pipeline_state")
      .select("value")
      .eq("key", LIMITER_STATE_KEY)
      .maybeSingle();

    const stored = (data?.value ?? null) as
      | (UpstashLimiterHistory & { state?: UpstashLimiterState })
      | null;

    if (stored?.state === state) {
      // Unchanged — no write at all. The overwhelmingly common tick.
      return {
        since: stored.since ?? now,
        previous_state: stored.previous_state ?? null,
        last_transition_at: stored.last_transition_at ?? null,
        transitions: Array.isArray(stored.transitions) ? stored.transitions : [],
      };
    }

    const previous = stored?.state ?? null;
    const transitions: UpstashLimiterTransition[] = [
      { at: now, from: previous, to: state },
      ...(Array.isArray(stored?.transitions) ? stored.transitions : []),
    ].slice(0, MAX_TRANSITION_HISTORY);

    const next: UpstashLimiterHistory = {
      since: now,
      previous_state: previous,
      last_transition_at: now,
      transitions,
    };

    await db
      .from("pipeline_state")
      .upsert(
        { key: LIMITER_STATE_KEY, value: { state, ...next }, updated_at: now },
        { onConflict: "key" },
      );

    return next;
  } catch {
    return fresh;
  }
}
