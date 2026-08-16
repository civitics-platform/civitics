// FIX-570: durable, cross-instance edge rate limiter backed by Upstash Redis —
// replaces the in-memory `Map` in middleware.ts (which only held per-edge-instance
// counters that reset on cold start and never spanned regions).
//
// DESIGN — Claude/civitics/design-bot-protection-gate.md §3.3, as amended by the
// 2026-08-15 crawl incident (docs/audits/2026-08-15-traffic-cost-spike.md):
//
//   * THE EDGE OWNS VOLUME; THIS LAYER OWNS INTEGRITY AND COST. Cloudflare is
//     the primary volumetric defense. This limiter is the SECONDARY layer, for
//     humans and small-scale abuse. It is structurally incapable of being the
//     volumetric defense and must never be designed as one: the Upstash free
//     tier is 500,000 commands per billing period, which the 2026-08-15 crawl
//     spent in 15.5 hours at ~7,200 req/hr — and which had STILL not reset
//     5h38m later, across a 00:00 UTC boundary (probed 2026-08-16 03:08 UTC:
//     "Limit: 500000, Usage: 500002"). So one crawl can disable the durable
//     limiter for a long time. Measured, not assumed — see FIX-1038.
//
//   * PER-IP LIMITING IS A HUMAN-SCALE CONTROL. Measured on the 2026-08-15
//     crawl (Cloudflare httpRequestsAdaptiveGroups, 06:00–22:00 UTC): 116,636
//     requests spread over **569 distinct client IPs**, 140 of them inside
//     Meta's 2a03:2880::/32 carrying 98% of the volume. The busiest single IP
//     averaged **1.82 req/min** against a 45/min `entity_leaf` cap — 25× under
//     the strictest bucket. A distributed crawler defeats per-IP limiting by
//     arithmetic, not by evasion. Do not tune the caps down chasing one: that
//     hurts humans and still misses the crawl. Cloudflare owns this class.
//
//   * FAIL-OVER, NOT FAIL-OPEN (FIX-1038). Any Upstash error OR missing env
//     degrades to a per-instance in-memory limiter — NOT to allow-all. The
//     original fail-open decision was about availability, and availability is
//     preserved exactly: the memory path can only ever 429 a request, never
//     500 it, and it still never throws. What does not survive is the
//     allow-all implementation of it, which on 2026-08-15 deleted the defense
//     at precisely peak load. Per-instance counters are weaker than global
//     ones; weaker limiting beats no limiting.
//
//   * DENY-CACHE (FIX-1038). An identifier already over its cap costs ZERO
//     further Upstash commands until its window resets. Honest sizing: this
//     would have saved ~nothing on 2026-08-15, because that crawl never
//     tripped a bucket at all (see the per-IP rate above) — every one of its
//     commands was spent issuing *allows*. It is a correctness/longevity fix
//     for the case the limiter is actually built for: a single noisy
//     identifier, where the limiter would otherwise burn its own budget
//     issuing 429s to a client that is not listening.
//
//   * Edge-runtime safe: middleware.ts imports this; `@upstash/*` are built for
//     the edge (REST transport, no node net), and nothing here touches a Node
//     API. Build + serve with the env ABSENT.
//
// Reused by the FIX-568 auth-send preflight (auth/actions.ts) via the
// `auth_send_ip` / `auth_send_email` buckets, so there is one limiter, one fail
// behaviour, one place to tune.

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

export type RateLimitBucket =
  // Reads — preserved verbatim from the in-memory limiter.
  | "search"
  | "graph_ai"
  | "graph"
  // Writes — the IP-layer backstop for the participation surfaces. Per-user DB
  // caps (FIX-569) remain the PRIMARY integrity control; this only blunts raw
  // per-IP volume. Applied only to write verbs (see getRateLimitBucket).
  | "write"
  // SSR entity DETAIL pages (FIX-637). The 2026-06-21 crawl walked hundreds of
  // distinct /jurisdictions/[id], /officials/[id], … URLs — each a full render
  // fan-out — and the buckets above don't cover page routes, only /api + writes.
  // A coarse per-IP cap on the per-entity detail pages returns 429 at the edge
  // BEFORE any Supabase query fires. Per-IP only: a distributed crawl evades it
  // (the Vercel/Cloudflare front door is the volumetric complement).
  | "entity_pages"
  // High-cardinality LEAF route families (FIX-683): /jurisdictions/*,
  // /districts/*, /officials/* — the ~10k empty district/county/official shells a
  // non-compliant crawler walks id-by-id, each cold-reading get_jurisdiction_page
  // /get_official_page (the 8s statement-timeout cancels on Pro Small). A stricter
  // per-IP bucket than entity_pages, applied to JUST these three families.
  // Mutually exclusive with entity_pages (one check per request — keeps the
  // Upstash free-tier command budget cheap), so a leaf hit counts only here.
  | "entity_leaf"
  // Router prefetches on the entity-page families (FIX-797). Link-dense pages
  // (e.g. the USA jurisdiction page) fire dozens of Next-Router-Prefetch RSC
  // GETs on load — enough to drain the 45/min entity_leaf cap so a single
  // human's browser 429s its own subsequent navigations. Prefetch-tagged GETs
  // count against this SEPARATE, generous bucket instead — a bucket, NOT an
  // exemption: a crawler spoofing the prefetch header just moves itself to a
  // different capped bucket, it never bypasses limiting.
  | "entity_prefetch"
  // Auth-send throttles (FIX-568). NB: the browser's signInWithOtp call goes
  // straight to Supabase GoTrue, not through this app — so these buckets are
  // enforced in the auth/actions.ts preflight, not in middleware.
  | "auth_send_ip"
  | "auth_send_email";

// @upstash/ratelimit's Duration string type, sourced from the call signature so
// we never drift from the package's accepted union (e.g. "1 m", "10 m", "1 h").
type Window = Parameters<typeof Ratelimit.slidingWindow>[1];

// Per-bucket policy (sliding window). (default — tune) — these are fixed policy
// values, not data-shape-dependent. Read limits match the prior Map limiter.
const BUCKET_LIMITS: Record<RateLimitBucket, { tokens: number; window: Window }> = {
  search: { tokens: 30, window: "1 m" },
  graph_ai: { tokens: 5, window: "1 m" },
  graph: { tokens: 60, window: "1 m" },
  write: { tokens: 30, window: "1 m" },
  // Generous: a real reader almost never opens >120 distinct entity pages in a
  // minute, but a crawler walking distinct IDs blows past it. Tune up if a power
  // user (or a tab-restore burst) trips it; tune down if a crawl still gets through.
  entity_pages: { tokens: 120, window: "1 m" },
  // Stricter than entity_pages (FIX-683): 45 distinct leaf pages/min = one every
  // ~1.3s sustained for a full minute — above any real reader (these are dense
  // civic profiles humans dwell on), well below a crawler walking thousands of
  // empty district/county/official shells. Tune down if a crawl still gets
  // through; tune up if a power-user tab-restore burst trips it.
  entity_leaf: { tokens: 45, window: "1 m" },
  // FIX-797: generous — a link-dense page can legitimately queue 50–100
  // prefetches as the viewport scrolls, and prefetch responses are cheap RSC
  // payloads that usually hit the edge cache. 300/min still hard-caps a
  // header-spoofing crawler at ~5 pages/s, far below an unthrottled walk.
  entity_prefetch: { tokens: 300, window: "1 m" },
  auth_send_ip: { tokens: 5, window: "10 m" },
  auth_send_email: { tokens: 3, window: "1 h" },
};

const DURATION_UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** "1 m" / "10 m" / "1 h" → milliseconds. Falls back to 1 minute on an
 *  unparseable value so a future BUCKET_LIMITS edit can never produce a
 *  zero-length window (which would make the memory limiter allow everything). */
export function windowMs(window: Window): number {
  const m = /^\s*(\d+)\s*(ms|s|m|h|d)\s*$/.exec(String(window));
  if (!m) return 60_000;
  return Number(m[1]) * (DURATION_UNIT_MS[m[2]!] ?? 60_000);
}

// Lazy singletons. `undefined` = not yet checked; `null` = env absent → memory
// fallback. Built once per edge instance and reused across requests.
let redisSingleton: Redis | null | undefined;
const limiters = new Map<RateLimitBucket, Ratelimit>();

function getRedis(): Redis | null {
  if (redisSingleton !== undefined) return redisSingleton;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  redisSingleton = url && token ? new Redis({ url, token }) : null;
  if (!redisSingleton) {
    console.warn(
      "[ratelimit] UPSTASH_REDIS_REST_URL/TOKEN absent — falling over to the " +
        "per-instance in-memory limiter (weaker: counters are per edge instance " +
        "and reset on cold start). Per-user DB caps still apply.",
    );
  }
  return redisSingleton;
}

function getLimiter(bucket: RateLimitBucket): Ratelimit | null {
  const redis = getRedis();
  if (!redis) return null;
  let limiter = limiters.get(bucket);
  if (!limiter) {
    const cfg = BUCKET_LIMITS[bucket];
    limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(cfg.tokens, cfg.window),
      prefix: `civitics:rl:${bucket}`,
      // Analytics issues extra Redis commands per check — off to protect the
      // free-tier command budget (cost ceiling, design §5).
      analytics: false,
    });
    limiters.set(bucket, limiter);
  }
  return limiter;
}

/** The only shape checkRateLimit needs from the durable limiter. */
type UpstashLimitFn = (
  identifier: string,
) => Promise<{ success: boolean; remaining: number; reset: number }>;

// Test seam: lets a unit test drive the Upstash branch (reject / throw) without
// a live Redis or a stubbed global fetch. Null in production — resolveLimitFn
// then goes through getLimiter exactly as before.
let testLimitFn: ((bucket: RateLimitBucket) => UpstashLimitFn | null) | null = null;

function resolveLimitFn(bucket: RateLimitBucket): UpstashLimitFn | null {
  if (testLimitFn) return testLimitFn(bucket);
  const limiter = getLimiter(bucket);
  return limiter ? (identifier) => limiter.limit(identifier) : null;
}

/** Where the verdict came from. Observability only — callers must not branch on it. */
export type RateLimitSource = "upstash" | "deny-cache" | "memory";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
  /** true ONLY when the request was actually rejected — distinguishes a real 429
   *  from an allow, so callers can log/observe quota pressure without breaking. */
  limited: boolean;
  /** Which layer produced this verdict. Absent when no check ran (no identifier). */
  source?: RateLimitSource;
}

const ALLOW: RateLimitResult = {
  allowed: true,
  remaining: Number.POSITIVE_INFINITY,
  retryAfterSec: 0,
  limited: false,
};

// ── Bounded per-instance maps ────────────────────────────────────────────────
//
// Both maps are per edge instance and unbounded growth is a real memory risk on
// a memory-constrained runtime, so both are capped. Caps are sized against the
// only distribution we have actually measured: the 2026-08-15 crawl presented
// **569 distinct client IPs zone-wide across 16 hours** (Cloudflare
// httpRequestsAdaptiveGroups). A single edge instance sees a fraction of that
// inside one 1-minute window, so these caps are roughly an order of magnitude
// above the worst case observed on this site, while each entry is a short
// string key plus one or two numbers (well under 200 bytes) — a full DENY cache
// is ≲0.4 MB and a full MEMORY map ≲1 MB.
const DENY_CACHE_MAX = 2_000;
const MEMORY_MAX = 5_000;

/** Reset timestamps (unix ms) for identifiers Upstash has already rejected. */
const denyCache = new Map<string, number>();
/** Fixed-window counters for the fail-over path. */
const memoryCounters = new Map<string, { count: number; resetAt: number }>();

/**
 * Keep `map` under `cap`. Sweeps entries whose window has already elapsed
 * first; only if that is not enough does it evict oldest-first (Map iteration
 * order is insertion order). Called on insert, so the maps can never exceed the
 * cap by more than the one entry being added.
 */
function evictTo<T>(
  map: Map<string, T>,
  cap: number,
  expiresAt: (value: T) => number,
  now: number,
): void {
  if (map.size < cap) return;
  for (const [k, v] of map) {
    if (expiresAt(v) <= now) map.delete(k);
  }
  while (map.size >= cap) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

// ── Health state + transition signal (FIX-1040) ──────────────────────────────
//
// Durable per-request rows are NOT the answer here: at the observed 7,200 req/hr
// a per-request durable write is a second self-inflicted incident. What is worth
// recording is the STATE TRANSITION — Upstash→memory and memory→Upstash — which
// happens a handful of times per instance lifetime at most. It is logged
// UNSAMPLED (the transition IS the signal) and exposed via getLimiterHealth().
//
// The durable, cross-instance half of this lives on the platform-snapshot side:
// packages/db/src/upstash-usage.ts probes Upstash every 10 minutes from a Node
// runtime that CAN write to the DB, and platform-snapshot.ts records the
// transition in pipeline_state + the snapshot payload. An edge instance cannot
// durably record anything cheaply or safely (no admin client at the edge), so
// the cron probe is the system of record and this is the per-instance view.

export type LimiterMode = "upstash" | "memory";

let mode: LimiterMode | null = null;
let modeSince: number | null = null;
let modeReason: string | null = null;
let transitionCount = 0;

function noteMode(next: LimiterMode, reason: string | null): void {
  if (mode === next) return;
  const previous = mode;
  mode = next;
  modeSince = Date.now();
  modeReason = reason;
  if (previous !== null) {
    transitionCount += 1;
    console.warn(
      `[ratelimit] STATE ${previous}→${next}` +
        (reason ? ` — ${reason}` : "") +
        ` (transition #${transitionCount} on this instance)`,
    );
  }
}

/** Snapshot of this instance's limiter health. Observability only. */
export function getLimiterHealth(): {
  mode: LimiterMode | null;
  since: string | null;
  reason: string | null;
  transitions: number;
  deny_cache_size: number;
  memory_keys: number;
} {
  return {
    mode,
    since: modeSince === null ? null : new Date(modeSince).toISOString(),
    reason: modeReason,
    transitions: transitionCount,
    deny_cache_size: denyCache.size,
    memory_keys: memoryCounters.size,
  };
}

// Sampled per-request warn (FIX-1040). Once Upstash is exhausted, EVERY bucketed
// request takes the error path, so an unsampled warn emits one Vercel
// observability event per request — 7,200/hr per fleet at the 2026-08-15 rate.
// 1-in-500 turns that into ~14/hr while the FIRST error on every cold instance
// still warns unconditionally, so a `vercel logs` presence check ("is the
// limiter degraded right now?") keeps working. Presence is preserved; only
// volume is cut. This is a hygiene fix worth $0.03–0.30/day, not a cost fix —
// the alarm that actually matters is the FIX-1038 snapshot probe, which ships
// in the same commit as this sampling. Never silence first.
const WARN_SAMPLE_RATE = 500;
let upstashErrorCount = 0;

function shouldWarnForUpstashError(): boolean {
  upstashErrorCount += 1;
  return upstashErrorCount === 1 || upstashErrorCount % WARN_SAMPLE_RATE === 0;
}

// ── Fail-over limiter (per instance, fixed window) ───────────────────────────

/**
 * Fixed-window counter using the SAME BUCKET_LIMITS policy values as the
 * Upstash path.
 *
 * Fixed window, not sliding: a caller can land `tokens` requests at the end of
 * one window and `tokens` more at the start of the next, i.e. up to 2× the cap
 * across a window boundary. That is the accepted cost of a dependency-free,
 * allocation-cheap fallback — this path only runs when the durable limiter is
 * already unavailable, and 2× the cap is still a cap.
 */
function memoryLimit(bucket: RateLimitBucket, identifier: string): RateLimitResult {
  const cfg = BUCKET_LIMITS[bucket];
  const now = Date.now();
  const key = `${bucket}:${identifier}`;

  let entry = memoryCounters.get(key);
  if (!entry || entry.resetAt <= now) {
    memoryCounters.delete(key);
    evictTo(memoryCounters, MEMORY_MAX, (v) => v.resetAt, now);
    entry = { count: 0, resetAt: now + windowMs(cfg.window) };
    memoryCounters.set(key, entry);
  }
  entry.count += 1;

  const allowed = entry.count <= cfg.tokens;
  return {
    allowed,
    remaining: Math.max(0, cfg.tokens - entry.count),
    retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    limited: !allowed,
    source: "memory",
  };
}

/**
 * Rate-limit check. NEVER throws.
 *
 * `identifier` is the client IP for per-IP buckets, or the email for
 * `auth_send_email`. Resolution order:
 *
 *   1. deny-cache — already over cap in this window → 429 for 0 Upstash commands
 *   2. Upstash    — the durable, cross-instance limiter
 *   3. memory     — per-instance fail-over on Upstash error or missing env
 *
 * A missing identifier is the one case that still allows unconditionally: there
 * is nothing to key a counter on.
 */
export async function checkRateLimit(
  bucket: RateLimitBucket,
  identifier: string,
): Promise<RateLimitResult> {
  if (!identifier) return ALLOW;

  const key = `${bucket}:${identifier}`;
  const now = Date.now();

  // 1. Deny-cache. Zero Upstash commands for an identifier already over its cap.
  const deniedUntil = denyCache.get(key);
  if (deniedUntil !== undefined) {
    if (deniedUntil > now) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSec: Math.max(1, Math.ceil((deniedUntil - now) / 1000)),
        limited: true,
        source: "deny-cache",
      };
    }
    // Window elapsed — drop the entry and fall through to a real check.
    denyCache.delete(key);
  }

  // 2. Upstash.
  const limit = resolveLimitFn(bucket);
  if (!limit) {
    noteMode("memory", "UPSTASH_REDIS_REST_URL/TOKEN absent");
    return memoryLimit(bucket, identifier);
  }

  try {
    const { success, remaining, reset } = await limit(identifier);
    noteMode("upstash", null);
    if (!success) {
      // Populate the deny-cache so the rest of this window is free. Only
      // Upstash rejections land here — a memory rejection already costs no
      // commands, so caching it would buy nothing and only blur the source.
      evictTo(denyCache, DENY_CACHE_MAX, (v) => v, now);
      denyCache.set(key, reset);
    }
    return {
      allowed: success,
      remaining,
      // reset is a unix-ms timestamp; Date.now() is available in the edge runtime.
      retryAfterSec: success ? 0 : Math.max(1, Math.ceil((reset - Date.now()) / 1000)),
      limited: !success,
      source: "upstash",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 3. Fail OVER, not open.
    noteMode("memory", message);
    if (shouldWarnForUpstashError()) {
      console.warn(
        `[ratelimit] Upstash error on bucket=${bucket} — failing over to the ` +
          `per-instance memory limiter (sampled 1-in-${WARN_SAMPLE_RATE}; ` +
          `${upstashErrorCount} on this instance):`,
        message,
      );
    }
    return memoryLimit(bucket, identifier);
  }
}

/**
 * TEST-ONLY. Drops every per-instance map and health counter so a unit test can
 * start from a known state. Not called from application code.
 */
export function __resetRateLimiterStateForTests(): void {
  denyCache.clear();
  memoryCounters.clear();
  limiters.clear();
  redisSingleton = undefined;
  testLimitFn = null;
  mode = null;
  modeSince = null;
  modeReason = null;
  transitionCount = 0;
  upstashErrorCount = 0;
}

/** TEST-ONLY. Installs a stand-in for the durable limiter. Null restores real Upstash. */
export function __setUpstashLimitFnForTests(
  fn: ((bucket: RateLimitBucket) => UpstashLimitFn | null) | null,
): void {
  testLimitFn = fn;
}

/** TEST-ONLY. Current per-instance map sizes, for the bounding assertions. */
export function __mapSizesForTests(): { deny: number; memory: number; caps: { deny: number; memory: number } } {
  return {
    deny: denyCache.size,
    memory: memoryCounters.size,
    caps: { deny: DENY_CACHE_MAX, memory: MEMORY_MAX },
  };
}
