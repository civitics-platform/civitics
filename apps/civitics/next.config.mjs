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
  staticPageGenerationTimeout: 30,
  transpilePackages: [
    "@civitics/ui",
    "@civitics/db",
    "@civitics/auth",
    "@civitics/blockchain",
    "@civitics/maps",
    "@civitics/graph",
    "@civitics/ai",
  ],
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
    return [
      {
        // Static assets — allow CDN caching, they're content-hashed
        source: "/_next/static/(.*)",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
      {
        // All pages and API routes — no CDN caching (civic data changes frequently;
        // also ensures Claude and other scrapers always get fresh content)
        source: "/((?!_next/static).*)",
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      {
        // Dashboard — extra Vercel CDN cache-busting headers (FIX 8)
        source: "/dashboard",
        headers: [
          { key: "Cache-Control", value: "no-store, no-cache, must-revalidate, proxy-revalidate" },
          { key: "CDN-Cache-Control", value: "no-store" },
          { key: "Vercel-CDN-Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
};

export default nextConfig;
