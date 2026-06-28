// FIX-570: durable, cross-instance edge rate limiter backed by Upstash Redis —
// replaces the in-memory `Map` in middleware.ts (which only held per-edge-instance
// counters that reset on cold start and never spanned regions).
//
// DESIGN — Claude/civitics/design-bot-protection-gate.md §3.3:
//   * Upstash free tier, auto-upgrade OFF → hard $0 ceiling: when the free
//     allotment is exhausted Upstash rate-limits the DATABASE itself instead of
//     billing. The app never pays for a spike.
//   * FAIL-OPEN is load-bearing: any Upstash error, OR missing env, ALLOWS the
//     request and logs a `[ratelimit]` warning. A quota breach / outage degrades
//     to "per-user DB caps only" (the real integrity control — FIX-569), never to
//     a broken site. Turnstile + Supabase `[auth.rate_limit]` cover the front door
//     server-side (FIX-568); Cloudflare WAF absorbs volumetric upstream (FIX-513).
//     This limiter is the SECONDARY cost/volumetric layer, not load-bearing alone.
//   * Edge-runtime safe: middleware.ts imports this; `@upstash/*` are built for
//     the edge (REST transport, no node net). Build + serve with the env ABSENT.
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
  auth_send_ip: { tokens: 5, window: "10 m" },
  auth_send_email: { tokens: 3, window: "1 h" },
};

// Lazy singletons. `undefined` = not yet checked; `null` = env absent → fail-open.
// Built once per edge instance and reused across requests.
let redisSingleton: Redis | null | undefined;
const limiters = new Map<RateLimitBucket, Ratelimit>();

function getRedis(): Redis | null {
  if (redisSingleton !== undefined) return redisSingleton;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  redisSingleton = url && token ? new Redis({ url, token }) : null;
  if (!redisSingleton) {
    console.warn(
      "[ratelimit] UPSTASH_REDIS_REST_URL/TOKEN absent — edge limiter disabled " +
        "(fail-open: allow-all at the edge; per-user DB caps still apply).",
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

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
  /** true ONLY when Upstash actually rejected — distinguishes a real 429 from a
   *  fail-open allow, so callers can log/observe quota pressure without breaking. */
  limited: boolean;
}

const ALLOW: RateLimitResult = {
  allowed: true,
  remaining: Number.POSITIVE_INFINITY,
  retryAfterSec: 0,
  limited: false,
};

/**
 * Fail-open rate-limit check. `identifier` is the client IP for per-IP buckets,
 * or the email for `auth_send_email`. NEVER throws — any Upstash error or missing
 * env resolves to ALLOW (logged). The boolean integrity controls live in the DB.
 */
export async function checkRateLimit(
  bucket: RateLimitBucket,
  identifier: string,
): Promise<RateLimitResult> {
  const limiter = getLimiter(bucket);
  if (!limiter || !identifier) return ALLOW;
  try {
    const { success, remaining, reset } = await limiter.limit(identifier);
    return {
      allowed: success,
      remaining,
      // reset is a unix-ms timestamp; Date.now() is available in the edge runtime.
      retryAfterSec: success ? 0 : Math.max(1, Math.ceil((reset - Date.now()) / 1000)),
      limited: !success,
    };
  } catch (err) {
    console.warn(
      `[ratelimit] Upstash error on bucket=${bucket} — failing open (allow):`,
      err instanceof Error ? err.message : err,
    );
    return ALLOW;
  }
}
