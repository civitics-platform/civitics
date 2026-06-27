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
    // We set both so it works on Vercel today and any future generic CDN
    // (Cloudflare, Fastly) we might layer in.
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
    return [
      {
        // Static assets — content-hashed, immutable. Cache-Control here is
        // what the browser respects, which is exactly what we want.
        source: "/_next/static/(.*)",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
      {
        // Auth + admin + mutating routes — never cache anywhere. Auth
        // callbacks set session cookies; admin endpoints expose privileged
        // reads.
        source: "/api/auth/:path*",
        headers: [...cdnNoStore, ...securityHeaders],
      },
      {
        source: "/api/admin/:path*",
        headers: [...cdnNoStore, ...securityHeaders],
      },
      {
        source: "/auth/:path*",
        headers: [...cdnNoStore, ...securityHeaders],
      },
      {
        source: "/profile/:path*",
        headers: [...cdnNoStore, ...securityHeaders],
      },
      {
        // Dashboard is an admin/transparency tool; content is stable.
        // Hold on the edge for 30 min, serve stale up to an hour.
        source: "/dashboard",
        headers: [...cdnHot(1800, 3600), ...securityHeaders],
      },
      {
        // Read-heavy public pages — Vercel edge holds the response for 5 min
        // and serves stale while revalidating for another 10. Civic data
        // changes slowly; SWR keeps freshness acceptable.
        source: "/((?!_next/static|api/auth|api/admin|auth|profile|dashboard).*)",
        headers: [...cdnHot(300, 600), ...securityHeaders],
      },
    ];
  },
};

export default nextConfig;
