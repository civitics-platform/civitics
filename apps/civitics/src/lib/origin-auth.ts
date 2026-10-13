// ---------------------------------------------------------------------------
// Origin auth (FIX-1305) — did this request come through Cloudflare?
//
// Two doors reach the Vercel origin without passing Cloudflare (cc-229 §G1):
// the civitics-civitics.vercel.app alias, and Vercel's anycast IP with
// `Host: www.civitics.com`. The 2026-10-12 crawl came through the first —
// four search engines indexing it as an un-canonicalised mirror — and
// Cloudflare saw 0.4 % of it, so the WAF, Under Attack mode and the FIX-1045
// loop were blind while the limiter spent 357k Upstash commands.
//
// Two decisions live here, both pure and edge-safe (no next/*, no Node API —
// middleware.ts imports this):
//
//   * decideAliasRedirect — the alias host is 308'd to www.civitics.com, so the
//     crawlers' index moves to where Cloudflare can see them. 308, not 403:
//     they are wanted crawlers on the wrong host.
//   * decideOriginAuth — a Cloudflare Transform Rule stamps
//     `x-civitics-origin: <ORIGIN_AUTH_SECRET>` on every civitics.com request;
//     a request without it did not come through Cloudflare. Keys on the path
//     taken, not the hostname, so it closes the anycast door too.
//
// Both exempt the same one path family, CRON_PATH_PREFIX: Vercel's scheduler
// calls the cron routes directly, and each route's own CRON_SECRET bearer gate
// (FIX-1230) is what makes the exemption safe.
// ---------------------------------------------------------------------------

export const ALIAS_HOST = "civitics-civitics.vercel.app";
export const CANONICAL_ORIGIN = "https://www.civitics.com";
export const CRON_PATH_PREFIX = "/api/cron/";

/** Set by the Cloudflare Transform Rule `Origin auth (FIX-1305)`. */
export const ORIGIN_AUTH_HEADER = "x-civitics-origin";
/** Stamped on the response in report mode on a miss. `ok` is never stamped. */
export const ORIGIN_CHECK_HEADER = "x-civitics-origin-check";
/** First miss, then 1-in-N per isolate (the FIX-1040 shape). */
export const ORIGIN_MISS_SAMPLE_RATE = 100;

export type OriginAuthMode = "off" | "report" | "enforce";

export type OriginAuthReason =
  | "not-production"
  | "mode-off"
  | "no-secret"
  | "cron-exempt"
  | "match"
  | "missing"
  | "mismatch";

export interface OriginAuthDecision {
  action: "pass" | "report" | "refuse";
  reason: OriginAuthReason;
}

// ── D0: the alias host ──────────────────────────────────────────────────────

export function decideAliasRedirect(input: {
  host: string | null | undefined;
  path: string;
}): { redirect: boolean } {
  if (!input.host) return { redirect: false };
  const hostname = input.host.trim().toLowerCase().replace(/:\d+$/, "");
  return { redirect: hostname === ALIAS_HOST && !input.path.startsWith(CRON_PATH_PREFIX) };
}

/**
 * The 308's Location. Built by assigning the path onto a fixed-origin URL, not
 * by `new URL(path, origin)`: a request path of `//evil.com/x` would parse as
 * protocol-relative there and turn the alias into an open redirect.
 */
export function aliasRedirectTarget(path: string, search: string): URL {
  const target = new URL(CANONICAL_ORIGIN);
  target.pathname = path;
  target.search = search;
  return target;
}

// ── D1–D4: the origin header ────────────────────────────────────────────────

/** `ORIGIN_AUTH_MODE` → a mode. Unset is `off`; so is anything unrecognised. */
export function parseOriginAuthMode(raw: string | null | undefined): {
  mode: OriginAuthMode;
  reason: "unset" | "known" | "unknown";
} {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return { mode: "off", reason: "unset" };
  if (value === "off" || value === "report" || value === "enforce") {
    return { mode: value, reason: "known" };
  }
  return { mode: "off", reason: "unknown" };
}

/**
 * Constant-time string equality. The edge runtime has no `timingSafeEqual`.
 * The loop runs over `expected` (the secret) whatever `actual`'s length, and a
 * length difference is folded into the result rather than returned early, so
 * neither the time taken nor an early exit says how long the secret is.
 */
export function constantTimeEqual(actual: string, expected: string): boolean {
  let diff = actual.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) {
    // Past the end of `actual`, charCodeAt is NaN, which `^` reads as 0.
    diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export function decideOriginAuth(input: {
  path: string;
  headerValue: string | null;
  secret: string | undefined;
  mode: OriginAuthMode;
  vercelEnv: string | undefined;
}): OriginAuthDecision {
  // D2: production only — previews and local dev have no Cloudflare in front.
  if (input.vercelEnv !== "production") return { action: "pass", reason: "not-production" };
  if (input.mode === "off") return { action: "pass", reason: "mode-off" };
  // D2: a missing secret lets traffic through; it never refuses.
  if (!input.secret) return { action: "pass", reason: "no-secret" };
  // D4: the one exemption.
  if (input.path.startsWith(CRON_PATH_PREFIX)) return { action: "pass", reason: "cron-exempt" };
  if (input.headerValue !== null && constantTimeEqual(input.headerValue, input.secret)) {
    return { action: "pass", reason: "match" };
  }
  const reason = input.headerValue === null ? "missing" : "mismatch";
  return { action: input.mode === "report" ? "report" : "refuse", reason };
}

// ── D6: the sampled log ─────────────────────────────────────────────────────

/** True on the first call, then on every `rate`-th. One counter per sampler. */
export function createSampler(rate: number): () => boolean {
  let count = 0;
  return () => {
    count += 1;
    return count === 1 || count % rate === 0;
  };
}

/**
 * `cf-ray=yes` on a miss means the request DID come through Cloudflare and the
 * Transform Rule is not stamping (cc-231's STOP signal); `cf-ray=no` is the
 * direct-to-origin traffic the check exists for.
 */
export function formatOriginLogLine(input: {
  verb: "miss" | "refused";
  host: string | null;
  path: string;
  method: string;
  cfRay: boolean;
  ua: string | null;
}): string {
  return (
    `[origin-auth] ${input.verb} host=${input.host ?? "-"} path=${input.path} ` +
    `method=${input.method} cf-ray=${input.cfRay ? "yes" : "no"} ua=${(input.ua ?? "-").slice(0, 60)}`
  );
}
