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
 * ── What can and cannot be measured, honestly ────────────────────────────────
 *
 * Upstash exposes command counts only through its **management** API
 * (`api.upstash.com/v2/redis/stats/{id}`), which needs an account-level
 * `UPSTASH_EMAIL` + `UPSTASH_API_KEY` pair. This repo holds only the per-database
 * REST credentials (`UPSTASH_REDIS_REST_URL` / `_TOKEN`) — verified against
 * `.env.example`, `.env.local` and `.env.local.prod`. Minting a management key
 * is a dashboard action and out of scope for the code that ships this file.
 *
 * So this helper measures the thing that actually matters and that we CAN see
 * from here: **is the limiter's backing store usable right now?** A few cheap
 * `PING`s per snapshot tick resolve to one of three states:
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
 * PROBE_ATTEMPTS = 3 therefore: P(all three miss) ≈ 0.62³ ≈ 24% for one tick,
 * and ≈ 1e-4 across an hour of 10-minute ticks — and `refusals`/`attempts` ride
 * in the payload so severity is visible, not just the boolean. Worst case 3
 * commands × 144 ticks = 432/day against 500,000: 0.09% of the allotment it is
 * watching. Note this also softens the audit's "the limiter is FULLY open"
 * reading: over quota it is intermittently open, not uniformly dead.
 *
 * NB the allotment period is NOT confirmed daily. Probed live at 2026-08-16
 * 03:08 UTC — 5h38m after exhaustion and past the 00:00 UTC boundary — Upstash
 * still answered `Limit: 500000, Usage: 500002`. If the period is monthly, a
 * single crawl takes the durable limiter out for the rest of the cycle, which
 * is precisely why `checkRateLimit` now fails OVER instead of open.
 *
 * ── The one place the real numbers ARE observable ────────────────────────────
 *
 * Upstash's quota error carries them: `"ERR max requests limit exceeded.
 * Limit: 500000, Usage: 500002."` They are parsed out here, which means
 * `upstash.daily_commands` gets a real measured value at exactly the moment it
 * matters and stays unknown otherwise. Note the counter FREEZES on crossing
 * (hence "500002" — two over, not a running total), so the value dates nothing;
 * it only confirms the cap was reached.
 *
 * Never throws. Missing env returns `{ error }` matching the convention every
 * other vendor helper here uses, so the snapshot writer treats it as benign.
 */

const CACHE_TTL_MS = 60 * 1000;
const PROBE_TIMEOUT_MS = 5_000;
/** See the header: a PONG does not prove health, a refusal proves exhaustion. */
const PROBE_ATTEMPTS = 3;

// ── Public types ──────────────────────────────────────────────────────────────

export type UpstashLimiterState = "healthy" | "quota_exhausted" | "unreachable";

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
}

// ── Durable state-TRANSITION record (FIX-1040) ────────────────────────────────
//
// FIX-1040's rule: durable signals are state TRANSITIONS, not per-request rows.
// A per-request durable write at the 7,200 req/hr this incident ran at is a
// second self-inflicted incident, so nothing here scales with traffic — one
// read + at most one write per 10-minute snapshot tick, and the write only
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
