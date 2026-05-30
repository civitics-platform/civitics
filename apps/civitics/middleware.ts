import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Bot pattern filtering
// ---------------------------------------------------------------------------

const BOT_PATTERNS = [
  /\.php$/i,
  /wp-content/i,
  /wp-admin/i,
  /wp-login/i,
  /xmlrpc/i,
  /\.env$/i,
  /\.git\//i,
  /actuator/i,
  /solr/i,
  /\.asp(x?)$/i,
  /\.cgi$/i,
  /phpmyadmin/i,
  /\.sql$/i,
  /admin\/config/i,
  /shell\.php/i,
];

// ---------------------------------------------------------------------------
// In-memory rate limiter (sliding window, per-IP)
//
// Vercel Edge instances share memory within a single instance but not across
// instances. This gives meaningful per-IP protection in practice — a single
// client hammering the API will always hit the same edge region.
//
// To upgrade to a distributed rate limiter (multi-region / multi-instance),
// swap this for @upstash/ratelimit + @upstash/redis.
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  count: number;
  resetAt: number; // ms timestamp
}

// Map key: `${ip}:${bucket}` where bucket groups routes into limit tiers
const rateLimitStore = new Map<string, RateLimitEntry>();

// Periodically clean up expired entries to prevent unbounded memory growth.
// Edge workers run continuously so this timer stays alive.
let lastCleanup = Date.now();
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function pruneExpiredEntries() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  for (const [key, entry] of rateLimitStore) {
    if (entry.resetAt < now) rateLimitStore.delete(key);
  }
}

interface RateLimitConfig {
  /** Maximum requests allowed per window */
  limit: number;
  /** Window duration in milliseconds */
  windowMs: number;
}

/**
 * Check rate limit for the given key.
 * Returns { allowed: true } or { allowed: false, retryAfterSec }.
 */
function checkRateLimit(
  key: string,
  config: RateLimitConfig
): { allowed: boolean; remaining: number; retryAfterSec?: number } {
  pruneExpiredEntries();

  const now = Date.now();
  const entry = rateLimitStore.get(key);

  if (!entry || entry.resetAt < now) {
    // New window
    rateLimitStore.set(key, { count: 1, resetAt: now + config.windowMs });
    return { allowed: true, remaining: config.limit - 1 };
  }

  if (entry.count >= config.limit) {
    const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
    return { allowed: false, remaining: 0, retryAfterSec };
  }

  entry.count++;
  return { allowed: true, remaining: config.limit - entry.count };
}

// ---------------------------------------------------------------------------
// Rate limit tiers
// ---------------------------------------------------------------------------

/**
 * Classify a pathname into a rate-limit bucket.
 * Returns null if the path should not be rate-limited.
 */
type RateLimitBucket = "search" | "graph_ai" | "graph";

function getRateLimitBucket(path: string): RateLimitBucket | null {
  if (path.startsWith("/api/search")) return "search";
  // AI narrative route is more expensive — stricter limit
  if (path.startsWith("/api/graph/narrative")) return "graph_ai";
  if (path.startsWith("/api/graph")) return "graph";
  return null;
}

const RATE_LIMIT_CONFIGS: Record<RateLimitBucket, RateLimitConfig> = {
  // Search: 30 requests per minute per IP
  search: { limit: 30, windowMs: 60_000 },
  // Graph AI narrative: 5 requests per minute per IP (Claude API calls)
  graph_ai: { limit: 5, windowMs: 60_000 },
  // Other graph routes: 60 requests per minute per IP
  graph: { limit: 60, windowMs: 60_000 },
};

function getClientIp(request: NextRequest): string {
  // Vercel sets x-forwarded-for; fall back to a generic key if unavailable
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

function rateLimitResponse(retryAfterSec: number): NextResponse {
  return new NextResponse(
    JSON.stringify({ error: "Too many requests. Please slow down." }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSec),
        "X-RateLimit-Limit": "see bucket",
        "X-RateLimit-Remaining": "0",
      },
    }
  );
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Canonical UUID v-any shape, case-insensitive. Shared by the agency redirect
// (FIX-418) and the jurisdiction 404 guard (FIX-G).
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// FIX-418: /agencies/<uuid> → /institutions/<uuid> as a request-level 308.
// Doing this in middleware (rather than in the [slug] page's redirect()) gives
// a true HTTP 308 status — when redirect() runs inside a Suspense boundary, it
// degrades to a meta-refresh + 200, which Google still honors but the prompt
// wanted a real permanent HTTP redirect for SEO.
const AGENCY_UUID_PATH_RE =
  /^\/agencies\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // ── Bot pattern filtering ──────────────────────────────────────────────────
  if (BOT_PATTERNS.some((p) => p.test(path))) {
    return new NextResponse(null, { status: 404 });
  }

  // ── FIX-418: /agencies/<uuid> → /institutions/<uuid> (308) ────────────────
  const agencyMatch = AGENCY_UUID_PATH_RE.exec(path);
  if (agencyMatch) {
    const dest = request.nextUrl.clone();
    dest.pathname = `/institutions/${agencyMatch[1]}`;
    return NextResponse.redirect(dest, 308);
  }

  // ── FIX-G: /jurisdictions/<malformed> → true 404 ──────────────────────────
  // Page-level notFound() degrades to a 200 under loading.tsx Suspense (same
  // root cause as the FIX-418 redirect). Validating UUID format here, before
  // streaming starts, returns a real HTTP 404 for malformed paths. A
  // well-formed UUID with no matching row still falls through to the page and
  // returns 200 + the not-found UI — by design: edge middleware can't do DB
  // lookups, and a format check is all we can do without one.
  const jurisdictionMatch = path.match(/^\/jurisdictions\/([^/]+)\/?$/);
  if (jurisdictionMatch && !UUID_RE.test(jurisdictionMatch[1] ?? "")) {
    return new NextResponse(null, { status: 404 });
  }

  // ── Rate limiting on public API routes ────────────────────────────────────
  const bucket = getRateLimitBucket(path);
  if (bucket) {
    const ip = getClientIp(request);
    const key = `${ip}:${bucket}`;
    const config = RATE_LIMIT_CONFIGS[bucket];
    const result = checkRateLimit(key, config);

    if (!result.allowed) {
      return rateLimitResponse(result.retryAfterSec!);
    }
  }

  // ── Auth routes: pass through untouched ───────────────────────────────────
  // Never refresh the session or modify cookies on /auth/* routes.
  // The PKCE code verifier cookie must reach the callback handler intact —
  // any Supabase client call here can overwrite it and break the exchange.
  if (path.startsWith("/auth/")) {
    return NextResponse.next({ request: { headers: request.headers } });
  }

  // ── PKCE code intercept ────────────────────────────────────────────────────
  // When Supabase's emailRedirectTo URL isn't in its allowed_redirect_urls
  // (common in local dev without a config.toml), it falls back to the site_url
  // and appends ?code= there instead. Intercept it here and forward to the
  // callback route which knows how to exchange it for a session.
  const code = request.nextUrl.searchParams.get("code");
  if (code) {
    const callbackUrl = request.nextUrl.clone();
    callbackUrl.pathname = "/auth/callback";
    // Pass the original path as `next` so the user lands back where they were
    callbackUrl.searchParams.set("code", code);
    callbackUrl.searchParams.set("next", path === "/" ? "/" : path);
    return NextResponse.redirect(callbackUrl);
  }

  const response = NextResponse.next({
    request: { headers: request.headers },
  });

  // Skip the Supabase Auth round-trip for anonymous visitors. No routes are
  // auth-protected today (all civic content is public), so refreshing a
  // non-existent session adds 50–150ms to every TTFB for nothing. When auth
  // gates are added, switch this to also check for a protected-route match.
  const hasSupabaseSession = request.cookies
    .getAll()
    .some((c) => c.name.startsWith("sb-"));
  if (!hasSupabaseSession) {
    return response;
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
