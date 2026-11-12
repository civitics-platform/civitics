// The identifier the edge limiter keys its per-IP buckets on (FIX-570).
//
// One function, shared by middleware.ts's bucket check and its answer to
// /api/cron/limiter-health (src/lib/limiter-health.ts), so the health block's
// `key_in_use` and the `x-civitics-ip-key` stamp are exactly what the limiter
// keys that request on. Pure and edge-safe: it reads headers and nothing else.

/** The request headers the identifier can come from, as the health path echoes them. */
export const CLIENT_IP_HEADERS = ["x-forwarded-for", "x-real-ip", "cf-connecting-ip"] as const;

/** Which header the key came from: the `key=` half of the `x-civitics-ip-key` stamp. */
export type ClientIpSource = "xff" | "real" | "unknown";

export function resolveClientIp(headers: Pick<Headers, "get">): { ip: string; source: ClientIpSource } {
  // Vercel sets x-forwarded-for; fall back to a generic key if unavailable
  const xff = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (xff !== undefined) return { ip: xff, source: "xff" };
  const real = headers.get("x-real-ip");
  if (real !== null) return { ip: real, source: "real" };
  return { ip: "unknown", source: "unknown" };
}

export function getClientIp(headers: Pick<Headers, "get">): string {
  return resolveClientIp(headers).ip;
}
