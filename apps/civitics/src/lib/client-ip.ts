// The identifier the edge limiter keys its per-IP buckets on (FIX-570).
//
// One function, shared by middleware.ts and /api/cron/limiter-health (cc-270),
// so the route's `key_in_use` is exactly what the limiter keys that request
// on. Pure and edge-safe: it reads headers and nothing else.

/** The request headers the identifier can come from, as the health route echoes them. */
export const CLIENT_IP_HEADERS = ["x-forwarded-for", "x-real-ip", "cf-connecting-ip"] as const;

export function getClientIp(headers: Pick<Headers, "get">): string {
  // Vercel sets x-forwarded-for; fall back to a generic key if unavailable
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    headers.get("x-real-ip") ??
    "unknown"
  );
}
