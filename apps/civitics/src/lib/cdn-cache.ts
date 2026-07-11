// FIX-796 — handler-owned CDN cache headers for public API routes.
//
// next.config.mjs headers() rules are method- and status-blind: a config rule
// on an API path stamps POST responses and error statuses just as happily as
// GET 200s (captured live on prod before FIX-796). So public API routes set
// their own cache headers HERE, on the exact response object that qualifies:
// a GET returning 200 with a payload that has ZERO viewer-dependence.
//
// Contract for callers (the FIX-788 discipline):
//   - The payload must be identical for every caller — built on
//     createPublicClient (or provably viewer-independent aggregates) and, for
//     list payloads, passed through stripViewerKeys (public-payload.test.ts).
//   - Stamp ONLY the success return. Error responses, redirects and mutating
//     verbs must never carry a public cache header.
//   - Anything personalized belongs in the no-store /api/viewer overlay —
//     never in a cached payload.
//
// Both headers are set: Vercel's edge consumes Vercel-CDN-Cache-Control (and
// strips it), CDN-Cache-Control is honored by downstream CDNs (Cloudflare
// fronts the site). The framework's browser-facing Cache-Control is left
// alone — browsers revalidate, edges serve the s-maxage window.

export const CDN_HOT_S_MAXAGE = 300;
export const CDN_HOT_SWR = 600;

/**
 * Stamp shared-CDN cache headers onto a response and return it. Use on GET
 * 200 responses of viewer-independent public API routes only.
 */
export function withPublicCdnCache<T extends Response>(
  res: T,
  sMaxAge: number = CDN_HOT_S_MAXAGE,
  swr: number = CDN_HOT_SWR,
): T {
  const value = `public, s-maxage=${sMaxAge}, stale-while-revalidate=${swr}`;
  res.headers.set("CDN-Cache-Control", value);
  res.headers.set("Vercel-CDN-Cache-Control", value);
  return res;
}
