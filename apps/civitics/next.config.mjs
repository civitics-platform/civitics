import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// ── Load root .env.local for monorepo ────────────────────────────────────────
// Next.js only looks for .env.local in the app directory (apps/civitics/).
// In this monorepo the single .env.local lives at the repo root, so we load
// it manually here before Next.js initialises — covering both dev and build.
const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const content = readFileSync(resolve(__dirname, "../../.env.local"), "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
} catch {
  // Root .env.local not present — fall through to app-level .env.local
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Note: `output: "standalone"` would shrink the Vercel cold-start image but
  // breaks `pnpm build` on Windows (EPERM on symlink without Developer Mode).
  // Re-enable once Windows Dev Mode is on or builds move to Linux/CI only.
  // raised per FIX-581 — insurance so one slow build-time jurisdiction render
  // can't fail the whole deploy (structural fix already landed via FIX-634
  // single RPC + withDbTimeout + the generateStaticParams discipline).
  staticPageGenerationTimeout: 120,
  transpilePackages: [
    "@civitics/ui",
    "@civitics/db",
    "@civitics/auth",
    "@civitics/blockchain",
    "@civitics/maps",
    "@civitics/graph",
    "@civitics/ai",
  ],
  // Tree-shake icon and util packages aggressively. Without this, importing
  // a single icon from lucide-react pulls in the whole barrel.
  experimental: {
    optimizePackageImports: [
      "@civitics/graph",
      "@civitics/maps",
      "@civitics/ui",
      "lucide-react",
      "d3",
    ],
    // Mapbox + Deck.gl are browser-only; keep them out of the server bundle so
    // SSR builds don't try to evaluate WebGL/window references. FIX-549: on
    // Next 14.2 this lives under experimental.serverComponentsExternalPackages
    // — the top-level serverExternalPackages key is Next 15+ and was silently
    // unrecognized here. Rename when upgrading to Next 15.
    serverComponentsExternalPackages: [
      "mapbox-gl",
      "@deck.gl/core",
      "@deck.gl/layers",
      "@deck.gl/mapbox",
    ],
  },
  images: {
    remotePatterns: [
      // Official photos from Congress.gov
      { protocol: "https", hostname: "bioguide.congress.gov" },
      // Cloudflare R2 bucket (no egress fees)
      { protocol: "https", hostname: "*.r2.cloudflarestorage.com" },
    ],
  },
  async redirects() {
    return [
      {
        source: "/:path*.php",
        destination: "/404",
        permanent: false,
      },
      {
        source: "/wp-:path*",
        destination: "/404",
        permanent: false,
      },
      {
        source: "/.env:path*",
        destination: "/404",
        permanent: false,
      },
    ];
  },
  async headers() {
    // Why CDN-Cache-Control + Vercel-CDN-Cache-Control instead of plain
    // Cache-Control:
    //
    // For dynamic routes (anything force-dynamic, anything that calls
    // cookies()/headers()), Next.js sets Cache-Control: private, no-cache,
    // no-store on the response itself, and that header *overrides* whatever
    // we put in the next.config.mjs headers() rule. Result: the Vercel edge
    // never caches the page, every visitor pays the full SSR cost.
    //
    // CDN-Cache-Control and Vercel-CDN-Cache-Control are NOT subject to that
    // override. They tell the edge "cache this" while leaving the framework's
    // browser-side Cache-Control alone. The browser still revalidates on
    // reload (correct for civic data), but the edge serves cached responses
    // to everyone else for the s-maxage window. This was the mechanism FIX-8
    // used in reverse to *bust* the dashboard cache.
    //
    // We set both so it works on Vercel today and any future generic CDN we
    // might layer in. Cloudflare (which fronts the site) honors
    // CDN-Cache-Control as well, so public responses are held at BOTH layers
    // (observe x-vercel-cache and cf-cache-status when verifying).
    //
    // ──────────────────────────────────────────────────────────────────────
    // CDN CACHE POLICY — ALLOWLIST MODEL (FIX-796)
    //
    // THE RULE: cache headers only on payloads with ZERO viewer-dependence,
    // set as close to the response as possible.
    //
    // History (why this is an allowlist, not a denylist):
    //   FIX-786 — saved-views "reverts on refresh": per-user API responses sat
    //     in the shared edge cache (which does NOT vary by Cookie) under an
    //     earlier cdnHot catch-all → stale read-your-own-writes AND cross-user
    //     leaks. Fix then: denylist + pinned no-store for per-user API routes.
    //   FIX-787 — audit of the ambiguous authed GETs: api/investigations
    //     (RLS varies by viewer) pinned no-store; api/positions split (own
    //     stance no-store, /rollup public).
    //   FIX-788 — api/statements + api/questions split into viewer-independent
    //     cached lists (createPublicClient + stripViewerKeys — pinned by
    //     public-payload.test.ts) + the no-store api/viewer overlay for the
    //     caller's own state.
    //   FIX-795 (2026-07-11) — the same incident class found AGAIN, at PAGE
    //     scope: /desk, /admin, /dashboard/notifications and the /initiatives
    //     family were cross-user cached, and /api/comments caching broke
    //     read-your-own-writes for every commenter. Proof that a denylist
    //     fails unsafe: every new per-user route is a latent leak until
    //     someone remembers to list it. Config rules are also method- and
    //     status-blind — cdnHot was captured on POST responses and a 429.
    //
    // The model is therefore INVERTED (FIX-796):
    //   1. PAGES — cdnHot applies ONLY to the explicit allowlist of
    //      viewer-independent public page prefixes below. Unlisted routes get
    //      NOTHING stamped, so Next's own `private, no-cache, no-store` for
    //      dynamic routes stands. A new route is safe by default; forgetting
    //      to list it costs performance, never correctness.
    //   2. API — config stamps NO cache headers on /api. Public API routes own
    //      their cache headers in the handler (src/lib/cdn-cache.ts →
    //      withPublicCdnCache), where they can be method-aware (GET only) and
    //      status-aware (200 only). The pinned no-store guards below stay as
    //      belt-and-braces for the known per-user surfaces.
    //   3. Anything personalized goes under api/viewer (or another no-store
    //      surface) — never into a cached payload.
    //
    // Route → cache policy (complete map, post-FIX-796):
    //   /_next/static/*             browser immutable (content-hashed)
    //   PAGE ALLOWLIST (publicPages
    //   + `/` + /dashboard)         edge 300/600 (dashboard: 1800/3600)
    //   PINNED NO-STORE             /auth, /profile, /desk, /admin,
    //                               /dashboard/notifications, /initiatives*,
    //                               /api/auth, /api/admin, /api/comments*,
    //                               userScopedApi (api/viewer et al.),
    //                               /api/positions (exact)
    //   HANDLER-OWNED (in route
    //   code, GET 200 only)         api/statements, api/questions,
    //                               api/positions/rollup, api/browse/typeahead,
    //                               api/browse/jurisdictions,
    //                               api/officials|proposals [id]/summary,
    //                               api/officials/[id]/responsiveness,
    //                               api/attribution, api/dashboard/stats;
    //                               api/browse keeps its own Cache-Control
    //                               s-maxage=60 (predates this, same idea)
    //   EVERYTHING ELSE             nothing stamped → uncached by default.
    //                               Deliberate: all api/graph/* reads
    //                               (interactive, param-heavy → low hit rate;
    //                               the `graph` rate bucket bounds cost),
    //                               api/initiatives* (read-your-own-writes),
    //                               platform/claude/cron/track/moderation/
    //                               evidence routes, OG images (Next stamps
    //                               its own — see app/_og/cards.ts).
    // ──────────────────────────────────────────────────────────────────────
    const securityHeaders = [
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    ];
    const cdnNoStore = [
      { key: "CDN-Cache-Control", value: "no-store" },
      { key: "Vercel-CDN-Cache-Control", value: "no-store" },
    ];
    const cdnHot = (sMaxAge, swr) => [
      { key: "CDN-Cache-Control", value: `public, s-maxage=${sMaxAge}, stale-while-revalidate=${swr}` },
      { key: "Vercel-CDN-Cache-Control", value: `public, s-maxage=${sMaxAge}, stale-while-revalidate=${swr}` },
    ];
    // Per-user, auth-dependent API endpoints (FIX-786/787/788) — belt-and-
    // braces no-store pins. The response varies by the signed-in user, so a
    // shared-cache hit is a cross-user leak.
    const userScopedApi = [
      "api/graph/custom-groups",
      "api/graph/me",
      "api/graph/my-representatives",
      "api/notifications",
      "api/follows",
      "api/profile",
      "api/constituent-status",
      "api/officials/claim-status",
      "api/representatives",
      // FIX-787 — RLS varies by viewer (creators see their own archived rows).
      "api/investigations",
      // FIX-788 — the per-viewer overlay prefix for the cached public list
      // routes (statements ballots, Q&A can_answer, and any future overlay).
      "api/viewer",
    ];
    // Per-user PAGES (FIX-795) — same class, page scope:
    //   desk                    — auth-redirect + the signed-in user's inbox
    //   admin                   — admin pages (api/admin alone was not enough)
    //   dashboard/notifications — per-user follows/notifications (the
    //                             /dashboard cdnHot rule is EXACT-match)
    //   initiatives             — whole family: index has the per-user "Mine"
    //                             tab (?mine=1 is its own cache key), /new and
    //                             /problem are auth-redirect pages, /[id] SSRs
    //                             isAuthor + the viewer's own engagement state.
    const userScopedPages = [
      "desk",
      "admin",
      "dashboard/notifications",
      "initiatives",
    ];
    // The page allowlist (FIX-796): viewer-independent public page prefixes.
    // Every entry was verified to have NO cookies()/auth read in its SSR
    // render path (per-viewer UI is client islands; engagement state hydrates
    // from the no-store api/viewer overlay). Before adding a prefix here,
    // verify the same — a viewer-dependent page in this list is the FIX-786
    // incident. `/` (home) and /dashboard get exact-match rules below.
    // NB: prefixes also cover sub-resources (RSC payloads, opengraph-image
    // routes) under them — all viewer-independent by the same audit.
    const publicPages = [
      "officials",
      "proposals",
      "jurisdictions",
      "institutions",
      "agencies",
      "donors",
      "districts",
      "meetings",
      "search",
      "graph",
      "commons",
      "franklin",
      "investigations",
      "about",
    ];
    return [
      {
        // Security headers on every route. Cache headers are deliberately NOT
        // part of this rule — they come only from the explicit rules below.
        source: "/:path*",
        headers: securityHeaders,
      },
      {
        // Static assets — content-hashed, immutable. Cache-Control here is
        // what the browser respects, which is exactly what we want.
        source: "/_next/static/(.*)",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
      // ── Pinned no-store guards ─────────────────────────────────────────────
      // Auth + admin + mutating routes — never cache anywhere. Auth callbacks
      // set session cookies; admin endpoints expose privileged reads.
      {
        source: "/api/auth/:path*",
        headers: cdnNoStore,
      },
      {
        source: "/api/admin/:path*",
        headers: cdnNoStore,
      },
      {
        source: "/auth/:path*",
        headers: cdnNoStore,
      },
      {
        source: "/profile/:path*",
        headers: cdnNoStore,
      },
      // FIX-786 — per-user API endpoints. `:path*` also covers the bare base
      // path (e.g. /api/graph/custom-groups with no sub-segment).
      ...userScopedApi.map((p) => ({
        source: `/${p}/:path*`,
        headers: cdnNoStore,
      })),
      // FIX-795 — per-user pages (see userScopedPages above).
      ...userScopedPages.map((p) => ({
        source: `/${p}/:path*`,
        headers: cdnNoStore,
      })),
      // FIX-795 — /api/comments/*: public payload (FIX-787 audited it), but a
      // 300s edge hold breaks read-your-own-writes for every commenter. No-store
      // is the durable answer, not a shorter TTL — comments are client-island
      // fetches, crawlers don't execute JS, so edge-caching them never reduced
      // crawler load. Page HTML/RSC caching is where the crawler defense lives.
      {
        source: "/api/comments/:path*",
        headers: cdnNoStore,
      },
      // FIX-787 — /api/positions returns the caller's own stance; no-store it.
      // EXACT source (no `/:path*`) so the PUBLIC /api/positions/rollup
      // (handler-owned cache headers since FIX-796) is not caught.
      {
        source: "/api/positions",
        headers: cdnNoStore,
      },
      // ── Page allowlist ─────────────────────────────────────────────────────
      // Read-heavy public pages — Vercel edge holds the response for 5 min and
      // serves stale while revalidating for another 10. Civic data changes
      // slowly; SWR keeps freshness acceptable. This caching is the crawler
      // defense — crawlers fetch page HTML, not client-island APIs.
      {
        // Home. EXACT match — `/` only.
        source: "/",
        headers: cdnHot(300, 600),
      },
      ...publicPages.map((p) => ({
        source: `/${p}/:path*`,
        headers: cdnHot(300, 600),
      })),
      {
        // Dashboard is a public transparency tool; content is stable. Hold on
        // the edge for 30 min, serve stale up to an hour. EXACT match — its
        // /notifications sub-page is per-user and pinned no-store above.
        source: "/dashboard",
        headers: cdnHot(1800, 3600),
      },
    ];
  },
};

export default nextConfig;
