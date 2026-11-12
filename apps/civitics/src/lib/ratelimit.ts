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
//   * FIXED WINDOW ON THE READ BUCKETS (FIX-1391). An allowed check is what
//     spends, and the read buckets are where the checks are. The installed
//     @upstash/ratelimit v2.0.8 sliding window runs EVALSHA + GET + GET +
//     INCRBY per allowed check, + PEXPIRE on a key's first check in its window:
//     4.13 commands a check, fitted on 11-02 → 11-08
//     (docs/audits/2026-11-09-upstash-spend-census.md §1, §8). Its fixed window
//     runs EVALSHA + INCRBY (+ PEXPIRE): 2.13 at that week's ~13 %
//     first-in-window share, 3 if every check is a first. So −40 % to −48 %.
//     The price is the boundary: a client can land `tokens` at the end of one
//     window and `tokens` more at the start of the next, 2× the cap across an
//     edge. memoryLimit below already makes that trade, and these caps sit
//     25–50× above any single IP measured (see the next bullet). `write` and
//     the two auth buckets stay sliding: they spend ~0 and their burst
//     semantics are the point. The choice is `algorithm` in BUCKET_LIMITS, and
//     a fixed bucket keys under its own `:fw` prefix, so no sliding counter
//     left from the deploy overlap is ever read as a fixed one.
//
//   * THE KEY IS THE CLIENT, NOT THE EDGE (FIX-1401). Until cc-272 the
//     per-IP identifier was x-forwarded-for, which Vercel sets to the
//     Cloudflare edge that connected to it, so every visitor through one PoP
//     shared a bucket (the www probe read `cf=differs; key=xff` through IAD and
//     ORD). Under ORIGIN_AUTH_MODE=enforce, a request that carried the origin
//     secret now keys on cf-connecting-ip, IPv6 on its /64
//     (src/lib/client-ip.ts). Per-client keys are sparser than per-edge ones,
//     so more checks are first-in-window: k moves toward 3 under the fixed
//     window, not toward 2.13. That is the price of limiting clients at all.
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
  // /get_official_page (the 8s statement-timeout cancels on Pro Micro). A stricter
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
// fixedWindow takes the same (tokens, Duration).
type Window = Parameters<typeof Ratelimit.slidingWindow>[1];

/** FIX-1391: which @upstash/ratelimit algorithm a bucket's durable limiter runs. */
export type LimiterAlgorithm = "fixed" | "sliding";

// Per-bucket policy. (default — tune) — these are fixed policy values, not
// data-shape-dependent. Read limits match the prior Map limiter. `algorithm`
// is FIX-1391's: fixed on the six read buckets, sliding on the rest (header).
const BUCKET_LIMITS: Record<
  RateLimitBucket,
  { tokens: number; window: Window; algorithm: LimiterAlgorithm }
> = {
  search: { tokens: 30, window: "1 m", algorithm: "fixed" },
  graph_ai: { tokens: 5, window: "1 m", algorithm: "fixed" },
  graph: { tokens: 60, window: "1 m", algorithm: "fixed" },
  write: { tokens: 30, window: "1 m", algorithm: "sliding" },
  // Generous: a real reader almost never opens >120 distinct entity pages in a
  // minute, but a crawler walking distinct IDs blows past it. Tune up if a power
  // user (or a tab-restore burst) trips it; tune down if a crawl still gets through.
  entity_pages: { tokens: 120, window: "1 m", algorithm: "fixed" },
  // Stricter than entity_pages (FIX-683): 45 distinct leaf pages/min = one every
  // ~1.3s sustained for a full minute — above any real reader (these are dense
  // civic profiles humans dwell on), well below a crawler walking thousands of
  // empty district/county/official shells. Tune down if a crawl still gets
  // through; tune up if a power-user tab-restore burst trips it.
  entity_leaf: { tokens: 45, window: "1 m", algorithm: "fixed" },
  // FIX-797: generous — a link-dense page can legitimately queue 50–100
  // prefetches as the viewport scrolls, and prefetch responses are cheap RSC
  // payloads that usually hit the edge cache. 300/min still hard-caps a
  // header-spoofing crawler at ~5 pages/s, far below an unthrottled walk.
  entity_prefetch: { tokens: 300, window: "1 m", algorithm: "fixed" },
  auth_send_ip: { tokens: 5, window: "10 m", algorithm: "sliding" },
  auth_send_email: { tokens: 3, window: "1 h", algorithm: "sliding" },
};

/**
 * A bucket's durable-limiter settings. A fixed bucket keys under
 * `civitics:rl:<bucket>:fw`, a sliding one under `civitics:rl:<bucket>` as
 * before (FIX-1391). Both algorithms name their keys `<prefix>:<id>:<window #>`,
 * so a shared prefix would hand a fixed check the sliding counter of the same
 * minute during the deploy overlap. The old keys expire on their own TTL.
 */
export function limiterSettings(bucket: RateLimitBucket): {
  tokens: number;
  window: Window;
  algorithm: LimiterAlgorithm;
  prefix: string;
} {
  const cfg = BUCKET_LIMITS[bucket];
  const prefix = cfg.algorithm === "fixed" ? `civitics:rl:${bucket}:fw` : `civitics:rl:${bucket}`;
  return { ...cfg, prefix };
}

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
    const cfg = limiterSettings(bucket);
    limiter = new Ratelimit({
      redis,
      limiter:
        cfg.algorithm === "fixed"
          ? Ratelimit.fixedWindow(cfg.tokens, cfg.window)
          : Ratelimit.slidingWindow(cfg.tokens, cfg.window),
      prefix: cfg.prefix,
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
// packages/db/src/upstash-usage.ts probes Upstash every 30 minutes from a Node
// runtime that CAN write to the DB, and platform-snapshot.ts records the
// transition in pipeline_state + the snapshot payload. An edge instance cannot
// durably record anything cheaply or safely (no admin client at the edge), so
// the cron probe is the system of record and this is the per-instance view.
//
// Reading it (FIX-1402, cc-272): middleware.ts answers /api/cron/limiter-health
// itself (src/lib/limiter-health.ts), because an edge ROUTE is its own bundle
// with its own copy of this module and only ever saw zeros. getLimiterIsolate()
// says which copy answered: an id minted when this module loaded, and how many
// checkRateLimit calls it has served. Isolates are many and short-lived, so a
// health read lands on a cold one (checks 0, mode null) as often as not.

export type LimiterMode = "upstash" | "memory";

const isolateId =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().slice(0, 13)
    : Math.random().toString(16).slice(2, 15);
const isolateStartedAt = new Date().toISOString();
let checkCount = 0;

/** This module instance: its id, when it loaded, and the checkRateLimit calls it has served. */
export function getLimiterIsolate(): { id: string; started_at: string; checks: number } {
  return { id: isolateId, started_at: isolateStartedAt, checks: checkCount };
}

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
  /** FIX-1304. null until this instance has read the flag once. */
  budget_hold: boolean | null;
  budget_checked_at: string | null;
  /** "<used>/<limit>" from the flag while it holds; null otherwise. */
  budget_detail: string | null;
  /** Flag GETs this instance has issued — the overhead, as a count. */
  budget_reads: number;
} {
  return {
    mode,
    since: modeSince === null ? null : new Date(modeSince).toISOString(),
    reason: modeReason,
    transitions: transitionCount,
    deny_cache_size: denyCache.size,
    memory_keys: memoryCounters.size,
    budget_hold: budgetHold,
    budget_checked_at: budgetCheckedAt === null ? null : new Date(budgetCheckedAt).toISOString(),
    budget_detail: budgetDetail,
    budget_reads: budgetReads,
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

// ── Budget flag (FIX-1304) ───────────────────────────────────────────────────
//
// THE LIMITER SHARES ITS DATABASE. The box-health ring, the front-door
// restart arm and the snapshot probe live in the same Upstash database (the
// free tier allows one) and spend a flat 2,449 commands a day between them,
// ~73k a month (census §1). The ring and the arm went dark for the rest of the
// billing period both times a crawl spent this limiter's share and theirs
// (08-15, 10-12). This limiter is the only tenant whose spend scales
// with traffic, so it is the one that gets a budget.
//
// The platform-snapshot probe (packages/db/src/upstash-usage.ts, every 30 min)
// writes BUDGET_FLAG_KEY with a 2 h TTL once the month's usage reaches the
// budget (default 70 % of the vendor's cap) and DELetes it below. While it is
// set, checkRateLimit takes the memory path BEFORE the quota is gone.
//
// Reading the flag costs next to nothing: one GET when an instance first
// reaches the Upstash step, then again only once BOTH 200 calls AND 60 s have
// passed since the last read, so ≤ 0.5 % of the limiter's own spend and ≤ 1
// GET/min per instance. Calls served from the hold count toward the 200 too, or
// a held instance would never see the flag go. A cold burst shares one
// in-flight read. A read never throws into the request: a quota refusal is the
// FIX-1038 fail-over for that call, and any other failure keeps the last state.
//
// All of this is per instance and assumes module state survives between
// requests on an edge isolate, as the deny-cache and memory counters already
// do. Where it does not, every cold start costs one GET; `budget_reads` in
// getLimiterHealth() is the count. A bearer GET of /api/cron/limiter-health
// adds one forced read (forceBudgetFlagRead, FIX-1402), counted there too.

/** Must equal LIMITER_BUDGET_KEY in packages/db/src/upstash-usage.ts. */
export const BUDGET_FLAG_KEY = "civitics:limiter:budget";
const BUDGET_REFRESH_CALLS = 200;
const BUDGET_REFRESH_MS = 60_000;

/** isQuotaExhaustedMessage's pattern (packages/db/src/upstash-usage.ts). Copied
 *  rather than imported: this module is in the edge bundle, and @civitics/db's
 *  index is not edge-safe. */
const QUOTA_MESSAGE = /max\s+requests\s+limit\s+exceeded|max\s+daily\s+request\s+limit|quota\s+exceeded/i;

type BudgetFlagReader = () => Promise<unknown>;
let testBudgetReader: BudgetFlagReader | null = null;

let budgetHold: boolean | null = null;
let budgetCheckedAt: number | null = null;
let budgetDetail: string | null = null;
let spendSinceCheck = 0;
let budgetReads = 0;
let budgetErrorCount = 0;
let budgetInFlight: Promise<string | null> | null = null;

function resolveBudgetReader(): BudgetFlagReader | null {
  if (testBudgetReader) return testBudgetReader;
  // A faked limiter with no faked flag reads no flag — never the real Redis.
  if (testLimitFn) return null;
  const redis = getRedis();
  return redis ? () => redis.get<unknown>(BUDGET_FLAG_KEY) : null;
}

/** Only `{state: "hold"}` holds. @upstash/redis parses JSON values itself;
 *  a raw string is parsed here in case it ever does not. */
function parseBudgetFlag(value: unknown): { hold: boolean; detail: string | null } {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return { hold: false, detail: null };
    }
  }
  if (v && typeof v === "object" && (v as { state?: unknown }).state === "hold") {
    const flag = v as { used?: unknown; limit?: unknown };
    return { hold: true, detail: `${String(flag.used)}/${String(flag.limit)}` };
  }
  return { hold: false, detail: null };
}

async function readBudgetFlag(read: BudgetFlagReader): Promise<string | null> {
  budgetReads += 1;
  try {
    const parsed = parseBudgetFlag(await read());
    budgetHold = parsed.hold;
    budgetDetail = parsed.detail;
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (QUOTA_MESSAGE.test(message)) return message;
    budgetErrorCount += 1;
    if (budgetErrorCount === 1 || budgetErrorCount % WARN_SAMPLE_RATE === 0) {
      console.warn(
        `[ratelimit] budget flag read failed — keeping the last state ` +
          `(hold=${String(budgetHold)}; sampled 1-in-${WARN_SAMPLE_RATE}; ` +
          `${budgetErrorCount} on this instance):`,
        message,
      );
    }
    return null;
  } finally {
    budgetCheckedAt = Date.now();
    spendSinceCheck = 0;
  }
}

/**
 * Count this call and re-read the flag when it is due. Resolves to the quota
 * message when the read was refused for quota (the caller fails over), else
 * null. Never throws.
 */
function refreshBudgetIfDue(now: number): Promise<string | null> | null {
  spendSinceCheck += 1;
  if (budgetInFlight) return budgetInFlight;
  const due =
    budgetCheckedAt === null ||
    (spendSinceCheck >= BUDGET_REFRESH_CALLS && now - budgetCheckedAt >= BUDGET_REFRESH_MS);
  if (!due) return null;
  const read = resolveBudgetReader();
  if (!read) return null;
  // `.finally` always runs a tick later, so the pointer is set before it clears.
  const inFlight = readBudgetFlag(read).finally(() => {
    budgetInFlight = null;
  });
  budgetInFlight = inFlight;
  return inFlight;
}

/** What forceBudgetFlagRead did: read the flag, found no reader (no Upstash env), or was refused for quota. */
export type BudgetForcedRead = "read" | "no-reader" | "quota-refused";

/**
 * FIX-1402: read the flag NOW, whatever the 200-call / 60 s schedule says, so a
 * bearer GET of /api/cron/limiter-health reports `budget_hold` / `budget_detail`
 * as of that call on any isolate, cold or warm. The same readBudgetFlag path,
 * so it also resets this isolate's schedule; a read already in flight is shared,
 * not doubled. Never throws.
 *
 * COST: one Upstash GET per bearer call. Nothing schedules the health path, so
 * this is hand-run reads only, never per request.
 */
export async function forceBudgetFlagRead(): Promise<BudgetForcedRead> {
  if (!budgetInFlight) {
    const read = resolveBudgetReader();
    if (!read) return "no-reader";
    budgetInFlight = readBudgetFlag(read).finally(() => {
      budgetInFlight = null;
    });
  }
  const refused = await budgetInFlight;
  return refused === null ? "read" : "quota-refused";
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
 *   2. budget     — the FIX-1304 flag holds → memory, for 0 limiter commands
 *   3. Upstash    — the durable, cross-instance limiter
 *   4. memory     — per-instance fail-over on Upstash error or missing env
 *
 * A missing identifier is the one case that still allows unconditionally: there
 * is nothing to key a counter on.
 */
export async function checkRateLimit(
  bucket: RateLimitBucket,
  identifier: string,
): Promise<RateLimitResult> {
  checkCount += 1;
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

  const limit = resolveLimitFn(bucket);
  if (!limit) {
    noteMode("memory", "UPSTASH_REDIS_REST_URL/TOKEN absent");
    return memoryLimit(bucket, identifier);
  }

  // 2. Budget hold (FIX-1304). The flag read is usually skipped (not due).
  const refresh = refreshBudgetIfDue(now);
  const refused = refresh ? await refresh : null;
  if (refused !== null) {
    noteMode("memory", refused);
    if (shouldWarnForUpstashError()) {
      console.warn(
        `[ratelimit] Upstash refused the budget flag read on bucket=${bucket} — failing ` +
          `over to the per-instance memory limiter (sampled 1-in-${WARN_SAMPLE_RATE}; ` +
          `${upstashErrorCount} on this instance):`,
        refused,
      );
    }
    return memoryLimit(bucket, identifier);
  }
  if (budgetHold === true) {
    noteMode("memory", `budget hold: ${budgetDetail ?? "flag set"}`);
    return memoryLimit(bucket, identifier);
  }

  // 3. Upstash.
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
    // 4. Fail OVER, not open.
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
  testBudgetReader = null;
  budgetHold = null;
  budgetCheckedAt = null;
  budgetDetail = null;
  spendSinceCheck = 0;
  budgetReads = 0;
  budgetErrorCount = 0;
  budgetInFlight = null;
  checkCount = 0;
}

/** TEST-ONLY. Installs a stand-in for the budget flag GET (FIX-1304): resolves
 *  to the stored value (null = absent) or throws. Null restores real Upstash. */
export function __setBudgetFlagReaderForTests(fn: (() => Promise<unknown>) | null): void {
  testBudgetReader = fn;
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
