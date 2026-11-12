// The identifier the edge limiter keys its per-IP buckets on (FIX-570).
//
// One function, shared by middleware.ts's bucket check and its answer to
// /api/cron/limiter-health (src/lib/limiter-health.ts), so the health block's
// `key_in_use` and the `x-civitics-ip-key` stamp are exactly what the limiter
// keys that request on. Pure and edge-safe: it reads headers and nothing else.
//
// WHICH HEADER (FIX-1401, cc-272). Behind Cloudflare, Vercel overwrites
// x-forwarded-for and x-real-ip with the TCP peer — the Cloudflare edge that
// connected to it (cc-270's alias spoof test; the www probe read
// `cf=differs; key=xff` from two edges, IAD and ORD). So the old chain keyed
// every visitor through one edge into one bucket. cf-connecting-ip is the
// visitor, as Cloudflare saw them, and is used ONLY with
// `trustCfConnectingIp`, which middleware.ts sets when ORIGIN_AUTH_MODE is
// `enforce` and the request carried the origin secret (origin-auth.ts
// provedCloudflare). That is what makes it trustworthy: Vercel passes a
// client-sent cf-connecting-ip through untouched (cc-270), and only a request
// that crossed Cloudflare carries the secret, which Cloudflare's own Transform
// Rule stamps. If the mode is ever set back to `report` or `off`, the flag is
// false and the key falls back to the chain below, unchanged: per-edge buckets
// again, never a forgeable key.
//
// IPv6 keys on its /64 (the first four hextets of the expanded address, lower
// case): one subscriber's prefix is one bucket, so rotating through a /64
// neither dodges the cap nor spends a first-in-window command per address.
// IPv4 — and an IPv4-mapped IPv6 address, which is an IPv4 client — is used
// whole. A value that parses as neither falls back to the chain.

/** The request headers the identifier can come from, as the health path echoes them. */
export const CLIENT_IP_HEADERS = ["x-forwarded-for", "x-real-ip", "cf-connecting-ip"] as const;

/** Which header the key came from: the `key=` half of the `x-civitics-ip-key` stamp. */
export type ClientIpSource = "xff" | "real" | "cf" | "unknown";

export interface ClientIpOptions {
  /** True only when the request proved it came through Cloudflare under `enforce`. */
  trustCfConnectingIp?: boolean;
}

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HEXTET_RE = /^[0-9a-f]{1,4}$/;

/** An IPv6 address → its eight hextets as numbers, or null if it does not parse. */
function parseIpv6(value: string): number[] | null {
  if (!value.includes(":") || value.includes("%")) return null;
  const halves = value.split("::");
  if (halves.length > 2) return null;
  // A dotted quad is legal only as the last 32 bits of the whole address.
  const toGroups = (part: string, last32: boolean): string[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    const last = groups[groups.length - 1]!;
    if (last32 && last.includes(".")) {
      // A trailing dotted quad is the low 32 bits (e.g. ::ffff:203.0.113.7).
      if (!IPV4_RE.test(last)) return null;
      const o = last.split(".").map(Number);
      groups.splice(-1, 1, ((o[0]! << 8) | o[1]!).toString(16), ((o[2]! << 8) | o[3]!).toString(16));
    }
    return groups.every((g) => HEXTET_RE.test(g)) ? groups : null;
  };
  const head = toGroups(halves[0]!, halves.length === 1);
  const tail = halves.length === 2 ? toGroups(halves[1]!, true) : [];
  if (!head || !tail) return null;
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && head.length + tail.length > 7) return null;
  const zeros = Array<string>(8 - head.length - tail.length).fill("0");
  return [...head, ...zeros, ...tail].map((g) => parseInt(g, 16));
}

/**
 * A cf-connecting-ip value → the limiter key: IPv4 whole, IPv6 on its /64
 * (`2001:0db8:0000:0001::/64`), IPv4-mapped IPv6 as its IPv4. Null when the
 * value is empty or parses as neither.
 */
export function cfConnectingIpKey(raw: string | null): string | null {
  const value = raw?.trim().toLowerCase() ?? "";
  if (!value) return null;
  if (IPV4_RE.test(value)) return value;
  const h = parseIpv6(value);
  if (!h) return null;
  if (h.slice(0, 5).every((g) => g === 0) && h[5] === 0xffff) {
    return [h[6]! >> 8, h[6]! & 0xff, h[7]! >> 8, h[7]! & 0xff].join(".");
  }
  return `${h.slice(0, 4).map((g) => g.toString(16).padStart(4, "0")).join(":")}::/64`;
}

export function resolveClientIp(
  headers: Pick<Headers, "get">,
  options: ClientIpOptions = {},
): { ip: string; source: ClientIpSource } {
  if (options.trustCfConnectingIp) {
    const cf = cfConnectingIpKey(headers.get("cf-connecting-ip"));
    if (cf !== null) return { ip: cf, source: "cf" };
  }
  // Vercel sets x-forwarded-for; fall back to a generic key if unavailable
  const xff = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (xff !== undefined) return { ip: xff, source: "xff" };
  const real = headers.get("x-real-ip");
  if (real !== null) return { ip: real, source: "real" };
  return { ip: "unknown", source: "unknown" };
}

export function getClientIp(headers: Pick<Headers, "get">, options: ClientIpOptions = {}): string {
  return resolveClientIp(headers, options).ip;
}
