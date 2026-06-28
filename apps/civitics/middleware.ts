import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { checkRateLimit, type RateLimitBucket } from "@/lib/ratelimit";

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
// Durable edge rate limiter (FIX-570)
//
// The per-IP counters live in Upstash Redis (src/lib/ratelimit.ts) so they span
// edge instances/regions and survive cold starts — the distributed upgrade this
// file's previous in-memory `Map` comment always named. checkRateLimit FAILS
// OPEN: if the Upstash env is absent or Upstash errors, every check allows the
// request (the per-user DB caps in FIX-569 are the real integrity control), so
// middleware builds and serves with UPSTASH_* unset.
//
// NB on auth: the browser's signInWithOtp call goes straight to Supabase GoTrue,
// not through this app, so the OTP-send throttle can't live here — it's enforced
// by the auth/actions.ts preflight (FIX-568) + Supabase `[auth.rate_limit]`.
// /auth/* requests that DO reach middleware are magic-link callbacks, which must
// never be throttled, so this limiter intentionally skips them.
// ---------------------------------------------------------------------------

// Participation write surfaces the edge backstops: /api/comments, /api/positions,
// /api/statements and their nested /[id]/rate, /[id]/flag, /[id]/vote children.
// Reads of these same paths (GET comment/statement lists) are NOT bucketed — only
// the mutating verbs are, so normal browsing isn't throttled by the write limit.
const WRITE_PATH_RE = /^\/api\/(comments|positions|statements)(\/|$)/;
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// SSR entity DETAIL pages (FIX-637). Each of these renders the full per-entity
// fan-out, and the 2026-06-21 crawl walked hundreds of distinct IDs across them.
// Matches a collection prefix followed by at least one more path segment, so the
// per-entity detail page (and its sub-routes) is bucketed but the cheap, few
// param-free list pages (/officials, /jurisdictions, …) are NOT. agencies uses a
// [slug] segment; the rest are [id]. donors/initiatives/investigations are the
// same render-fan-out class as the enumerated routes, so they're bucketed too.
const ENTITY_PAGE_RE =
  /^\/(jurisdictions|officials|proposals|institutions|agencies|districts|meetings|donors|initiatives|investigations)\/[^/]+/;

// FIX-683: the high-cardinality LEAF families — /jurisdictions/*, /districts/*,
// /officials/* — carry the ~10k empty district/county/official shells a
// non-compliant crawler walks id-by-id, each cold-reading the heavy
// get_jurisdiction_page/get_official_page RPC. They get the STRICTER entity_leaf
// bucket instead of (not in addition to) entity_pages, so a leaf GET costs one
// Upstash check, not two.
const LEAF_PAGE_RE = /^\/(jurisdictions|districts|officials)\/[^/]+/;

/**
 * Classify a request into a rate-limit bucket, or null to skip. Reads are
 * method-agnostic (preserved from the prior limiter); the `write` bucket applies
 * only to mutating verbs on the participation routes; `entity_pages` applies only
 * to GETs of the per-entity detail pages.
 */
function getRateLimitBucket(path: string, method: string): RateLimitBucket | null {
  if (path.startsWith("/api/search")) return "search";
  // AI narrative route is more expensive — stricter limit.
  if (path.startsWith("/api/graph/narrative")) return "graph_ai";
  if (path.startsWith("/api/graph")) return "graph";
  if (WRITE_METHODS.has(method) && WRITE_PATH_RE.test(path)) return "write";
  // Coarse per-IP cap on SSR entity detail-page renders (FIX-637). GET only — a
  // crawl is GETs; never bucket a participation POST behind this read limit.
  // FIX-683: the leaf families get the stricter entity_leaf bucket first; the
  // rest fall through to entity_pages. Order matters — leaf check precedes.
  if (method === "GET") {
    if (LEAF_PAGE_RE.test(path)) return "entity_leaf";
    if (ENTITY_PAGE_RE.test(path)) return "entity_pages";
  }
  return null;
}

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

  // ── FIX-H: same malformed-UUID → 404 guard for the other [id] routes that
  // pair loading.tsx (Suspense) with a page-level notFound(). Each returns 200
  // on a malformed path without this. /institutions/[id] is deliberately
  // EXCLUDED — its page resolves non-UUID slugs to UUIDs via a DB lookup
  // (governing_bodies.slug → permanentRedirect), so a format guard here would
  // 404 legitimate slug URLs. The edge can't do that DB lookup, so the page
  // keeps ownership of /institutions/[id] not-found handling.
  const idGuardMatch = path.match(/^\/(districts|officials|proposals|meetings)\/([^/]+)\/?$/);
  if (idGuardMatch && !UUID_RE.test(idGuardMatch[2] ?? "")) {
    return new NextResponse(null, { status: 404 });
  }

  // ── Rate limiting on public API + participation-write routes (FIX-570) ─────
  // Durable (Upstash) and fail-open: an Upstash outage/quota allows the request
  // and logs `[ratelimit]`; the per-user DB caps remain the real backstop.
  const bucket = getRateLimitBucket(path, request.method);
  if (bucket) {
    const ip = getClientIp(request);
    const result = await checkRateLimit(bucket, ip);
    if (!result.allowed) {
      return rateLimitResponse(result.retryAfterSec);
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
