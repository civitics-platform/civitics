/**
 * Cloudflare zone analytics + zone-settings client (FIX-1044 / FIX-1045).
 *
 * WHY THIS EXISTS. Every dollar in this stack is downstream of edge request
 * volume, and Cloudflare is the ONLY near-real-time, script-readable counter in
 * the chain. Vercel's own billing data is one-day granularity and cumulative
 * (see docs/audits/2026-08-15-traffic-cost-spike.md — "The effective resolution
 * of this dataset is ONE DAY"), Supabase's Prometheus feed watches the database
 * rather than the request path, and Upstash exposes no usage API at all. On
 * 2026-08-15 a crawler burned ~$21/day for 16 hours and what stopped it was a
 * vendor email read by a human. This module is the counter that was missing.
 *
 * `scripts/cf-analytics.mjs` proved the API is scriptable with the token this
 * repo already holds; it stays as the CLI face, and the query shapes below are
 * the same ones it issues.
 *
 * ── ORIGIN-REACHING IS THE METRIC, NOT TOTAL EDGE REQUESTS ───────────────────
 *
 * `originResponseStatus` is available on this Free zone (probed 2026-08-16) and
 * reads 0 exactly when the request never reached Vercel — blocked at the edge,
 * challenged, or served from the CF cache. So:
 *
 *     origin_reaching = requests whose originResponseStatus != 0
 *
 * That is the number that costs money (~$1.23e-4 each, measured), and keying on
 * it makes the whole detection loop SELF-LIMITING: while Under Attack mode or a
 * WAF rule is absorbing a crawl, origin counts collapse and the system correctly
 * goes quiet instead of screaming about traffic nobody is paying for. Measured
 * across the 2026-08-15 incident: 7,302 origin-reaching at 21:00 UTC, 36 at
 * 23:00 UTC — same ~7,300 total edge requests both hours.
 *
 * ── WHAT THIS FREE ZONE REFUSES ──────────────────────────────────────────────
 *
 * `clientAsn` and the whole `firewallEventsAdaptiveGroups` dataset are refused
 * (probed 2026-08-16). Everything here therefore stays on
 * `httpRequestsAdaptiveGroups`. Analytics retention is 8 days ("cannot request
 * data older than 1w1d") and a single query may not span more than 1 day.
 *
 * ── SCOPES ───────────────────────────────────────────────────────────────────
 *
 * The token in use as of 2026-08-16 carries Zone:Read, Zone Analytics:Read and
 * Zone Settings:READ — it can GET security_level but a PATCH returns
 * 403/9109. `setZoneSecurityLevel` therefore degrades to a typed error and the
 * mitigation loop stays alert-only until a token with Zone Settings:EDIT is
 * minted. That is deliberate: the loop is built behind the scope check so it
 * ships today and starts acting the moment the token exists.
 *
 * Never throws — every failure is a typed `{ error }` return, matching the
 * convention every other vendor helper in this package uses.
 */

const API = "https://api.cloudflare.com/client/v4";
const DEFAULT_ZONE_NAME = "civitics.com";
const FETCH_TIMEOUT_MS = 10_000;

// ── Public types ──────────────────────────────────────────────────────────────

export type CloudflareError = { error: string };

/** One COMPLETE clock hour of edge traffic. Partial hours are never returned. */
export type CloudflareHourBucket = {
  /** Bucket start, ISO, always on the hour (e.g. "2026-08-16T02:00:00Z"). */
  hour: string;
  /** Every request Cloudflare saw. */
  edge_requests: number;
  /** Requests the origin actually answered — the ones that cost money. */
  origin_requests: number;
  /** edge - origin: blocked, challenged, or served from the CF cache. */
  absorbed_requests: number;
  /** absorbed / edge, 0-100. High = a mitigation is doing work. */
  mitigated_pct: number;
};

export type CloudflareEdgeVolume = {
  zone_id: string;
  /** Newest first. Length <= lookbackHours; hours with zero traffic are absent. */
  hours: CloudflareHourBucket[];
  /** The most recent complete hour, or null if the zone was silent. */
  latest: CloudflareHourBucket | null;
  fetched_at: string;
};

export type SecurityLevel =
  | "off"
  | "essentially_off"
  | "low"
  | "medium"
  | "high"
  | "under_attack";

/**
 * Escalation ordering. `setZoneSecurityLevel` is only ever called by the
 * mitigation loop to move UP this scale, and the loop refuses to write a level
 * whose rank is not strictly greater than the level it just read.
 */
export const SECURITY_LEVEL_RANK: Record<SecurityLevel, number> = {
  off: 0,
  essentially_off: 1,
  low: 2,
  medium: 3,
  high: 4,
  under_attack: 5,
};

export function isSecurityLevel(v: unknown): v is SecurityLevel {
  return typeof v === "string" && v in SECURITY_LEVEL_RANK;
}

// ── Zone id resolution (module-cached) ────────────────────────────────────────

let cachedZoneId: string | null = null;

function creds(): { token: string } | CloudflareError {
  const token = process.env["CLOUDFLARE_API_TOKEN"];
  if (!token) return { error: "CLOUDFLARE_API_TOKEN not set" };
  return { token };
}

function headers(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

/**
 * `CLOUDFLARE_ZONE_ID` when set, else resolve by name with Zone:Read (which the
 * current token has). Resolving by name means D1 works on prod today with no
 * new env var; the explicit id is preferred because it costs one fewer call and
 * survives a zone rename.
 */
export async function resolveZoneId(): Promise<string | CloudflareError> {
  const explicit = process.env["CLOUDFLARE_ZONE_ID"];
  if (explicit) return explicit;
  if (cachedZoneId) return cachedZoneId;

  const c = creds();
  if ("error" in c) return c;

  const name = process.env["CLOUDFLARE_ZONE_NAME"] ?? DEFAULT_ZONE_NAME;
  try {
    const res = await fetch(`${API}/zones?name=${encodeURIComponent(name)}`, {
      headers: headers(c.token),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const json = (await res.json()) as {
      success?: boolean;
      result?: { id: string }[];
      errors?: { message?: string }[];
    };
    const id = json.result?.[0]?.id;
    if (!id) {
      return {
        error: `zone lookup for ${name} failed: ${
          json.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`
        }`,
      };
    }
    cachedZoneId = id;
    return id;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Test hook — drops the resolved-zone cache. */
export function __resetCloudflareZoneCache(): void {
  cachedZoneId = null;
}

// ── Analytics ─────────────────────────────────────────────────────────────────

const HOURLY_QUERY = `
query ($zoneTag: String!, $since: Time!, $until: Time!) {
  viewer { zones(filter: {zoneTag: $zoneTag}) {
    httpRequestsAdaptiveGroups(limit: 5000,
      filter: {datetime_geq: $since, datetime_leq: $until},
      orderBy: [datetimeHour_ASC]) {
      count
      dimensions { datetimeHour originResponseStatus }
    }
  } }
}`;

/** Truncate to the start of the clock hour. */
function hourFloor(ms: number): number {
  return Math.floor(ms / 3_600_000) * 3_600_000;
}

/**
 * The last `lookbackHours` COMPLETE clock hours of edge traffic, newest first.
 *
 * WHY IT LOOKS BACK MORE THAN ONE HOUR. The snapshot cron is GHA-driven and its
 * every-10-minutes schedule is aspirational: measured over 200 runs / 6.8 days
 * the inter-run gap is p50 46 min, p75 60 min, p90 87 min, max 155 min. A
 * reader that only ever asked
 * for "the previous hour" would SKIP hours outright whenever a gap exceeded 60
 * minutes — which is 26% of runs. Fetching three hours and letting the caller
 * dedupe by bucket timestamp makes the sustained-breach count robust to that
 * drift at no extra API cost (one query either way).
 *
 * The CURRENT hour is deliberately excluded: it is partial, so its count is an
 * undercount that would read as a fall in traffic.
 */
export async function getCloudflareEdgeVolume(
  opts: { lookbackHours?: number; now?: number } = {},
): Promise<CloudflareEdgeVolume | CloudflareError> {
  const c = creds();
  if ("error" in c) return c;

  const zone = await resolveZoneId();
  if (typeof zone !== "string") return zone;

  // Free-plan queries may not span more than 1 day; 23 keeps a safety margin.
  const lookbackHours = Math.min(23, Math.max(1, opts.lookbackHours ?? 3));
  const nowMs = opts.now ?? Date.now();
  const currentHourStart = hourFloor(nowMs);
  const untilMs = currentHourStart - 1_000; // last ms of the last COMPLETE hour
  const sinceMs = currentHourStart - lookbackHours * 3_600_000;

  const variables = {
    zoneTag: zone,
    since: new Date(sinceMs).toISOString(),
    until: new Date(untilMs).toISOString(),
  };

  try {
    const res = await fetch(`${API}/graphql`, {
      method: "POST",
      headers: headers(c.token),
      body: JSON.stringify({ query: HOURLY_QUERY, variables }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const json = (await res.json()) as {
      errors?: { message?: string }[];
      data?: {
        viewer?: {
          zones?: {
            httpRequestsAdaptiveGroups?: {
              count: number;
              dimensions: { datetimeHour: string; originResponseStatus: number };
            }[];
          }[];
        };
      };
    };
    if (json.errors?.length) {
      return { error: `graphql: ${json.errors.map((e) => e.message).join("; ")}` };
    }
    const rows = json.data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups ?? [];

    const byHour = new Map<string, { edge: number; origin: number }>();
    for (const r of rows) {
      const key = r.dimensions.datetimeHour;
      // Guard against an inclusive-bound row from the partial current hour.
      if (Date.parse(key) >= currentHourStart) continue;
      const b = byHour.get(key) ?? { edge: 0, origin: 0 };
      b.edge += r.count;
      // originResponseStatus === 0 ⇒ the origin never saw it.
      if (r.dimensions.originResponseStatus !== 0) b.origin += r.count;
      byHour.set(key, b);
    }

    const hours: CloudflareHourBucket[] = [...byHour.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1)) // newest first
      .map(([hour, b]) => ({
        hour,
        edge_requests: b.edge,
        origin_requests: b.origin,
        absorbed_requests: b.edge - b.origin,
        mitigated_pct: b.edge > 0 ? ((b.edge - b.origin) / b.edge) * 100 : 0,
      }));

    return {
      zone_id: zone,
      hours,
      latest: hours[0] ?? null,
      fetched_at: new Date().toISOString(),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Zone settings (security_level) ────────────────────────────────────────────

export type ZoneSecurityLevel = {
  level: SecurityLevel;
  modified_on: string | null;
  /** Cloudflare's own flag — false on plans where the setting is fixed. */
  editable: boolean;
};

export async function getZoneSecurityLevel(): Promise<
  ZoneSecurityLevel | CloudflareError
> {
  const c = creds();
  if ("error" in c) return c;
  const zone = await resolveZoneId();
  if (typeof zone !== "string") return zone;

  try {
    const res = await fetch(`${API}/zones/${zone}/settings/security_level`, {
      headers: headers(c.token),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const json = (await res.json()) as {
      result?: { value?: unknown; modified_on?: string | null; editable?: boolean };
      errors?: { code?: number; message?: string }[];
    };
    if (!res.ok || !json.result) {
      return {
        error: `HTTP ${res.status}: ${
          json.errors?.map((e) => `${e.code} ${e.message}`).join("; ") ?? "no result"
        }`,
      };
    }
    if (!isSecurityLevel(json.result.value)) {
      return { error: `unrecognised security_level: ${String(json.result.value)}` };
    }
    return {
      level: json.result.value,
      modified_on: json.result.modified_on ?? null,
      editable: json.result.editable !== false,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Write the zone's security level.
 *
 * Callers must have already established that this is an ESCALATION (or the
 * reversal of an escalation this system itself made) — the ordering policy
 * lives in cf-mitigation-loop.ts, not here, so it can be unit-tested without a
 * network. This function is the transport only.
 *
 * Returns `{ error }` with Cloudflare's own code on a scope failure; 9109
 * ("Unauthorized to access requested resource") is what a token holding only
 * Zone Settings:Read gets back, and is how the loop detects it must stay
 * alert-only.
 */
export async function setZoneSecurityLevel(
  level: SecurityLevel,
): Promise<{ level: SecurityLevel; modified_on: string | null } | CloudflareError> {
  const c = creds();
  if ("error" in c) return c;
  const zone = await resolveZoneId();
  if (typeof zone !== "string") return zone;

  try {
    const res = await fetch(`${API}/zones/${zone}/settings/security_level`, {
      method: "PATCH",
      headers: headers(c.token),
      body: JSON.stringify({ value: level }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const json = (await res.json()) as {
      success?: boolean;
      result?: { value?: unknown; modified_on?: string | null };
      errors?: { code?: number; message?: string }[];
    };
    if (!res.ok || json.success === false || !json.result) {
      const detail =
        json.errors?.map((e) => `${e.code} ${e.message}`).join("; ") ?? `HTTP ${res.status}`;
      return { error: `HTTP ${res.status}: ${detail}` };
    }
    if (!isSecurityLevel(json.result.value)) {
      return { error: `write returned unrecognised level: ${String(json.result.value)}` };
    }
    return { level: json.result.value, modified_on: json.result.modified_on ?? null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Can this token WRITE zone settings?
 *
 * There is no cheap read-only way to ask — `GET /user/tokens/{id}` needs "User
 * API Tokens:Read", which this token also lacks (403/9109, probed 2026-08-16).
 * So the scope is inferred from the shape of the failure at the moment of a
 * real write attempt: the loop calls `setZoneSecurityLevel`, and a 9109 back is
 * recorded as `scope_missing` rather than as a transient error, which is what
 * demotes the loop to alert-only and puts the USER item on the card.
 */
export function isScopeError(message: string): boolean {
  return /\b9109\b|Unauthorized to access requested resource|Authentication error/i.test(
    message,
  );
}
