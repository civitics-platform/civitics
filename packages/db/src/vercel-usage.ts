/**
 * Vercel current-cycle usage metrics — for the Platform Costs card.
 *
 * Two endpoints attempted in order:
 *
 *   1. GET /v1/usage?from=<iso-ms>&to=<iso-ms>[&teamId=...]
 *        Returns quantities only — function invocations, edge requests, fluid
 *        CPU seconds, etc. The "Usage" view in the Vercel dashboard.
 *        Pro / Enterprise only — Hobby tier responds with
 *        { error: { code: "plan_upgrade_required" } }.
 *
 *   2. GET /v1/billing/charges?from=<iso-ms>&to=<iso-ms>[&teamId=...]
 *        Returns FOCUS-format charges (JSONL, one charge per line). Each line
 *        carries UsageQuantity + BilledCost per ChargeDescription. Used here
 *        as a fallback so teams with at least one paid charge in-cycle still
 *        get quantity numbers even without the Pro Usage endpoint.
 *        Hobby tier with no plan responds with
 *        { error: { code: "not_found", message: "Plan not found." } }.
 *
 * On Hobby tier today both calls fail — the snapshot cron will log
 * "vercel: plan_upgrade_required" and leave platform_usage's vercel.* rows on
 * their last-known value (manual). Upgrading to Pro flips both calls on
 * without code changes.
 *
 * 5-minute in-memory cache (matches Supabase + Cloudflare helpers).
 *
 * Date format: Vercel's billing endpoints require ISO 8601 with millisecond
 * precision and a "Z" suffix — exactly what `Date.prototype.toISOString()`
 * produces. YYYY-MM-DD and Unix timestamps are rejected with
 * "invalid_from_date".
 */

const BASE = "https://api.vercel.com";
const CACHE_TTL_MS = 5 * 60 * 1000;

// ── Public types ──────────────────────────────────────────────────────────────
//
// Keys are the platform_limits.metric values for service='vercel'. Every key
// is present in every successful response — a metric not returned by the API
// is set to 0 so the downstream updateUsage() calls always have a number to
// write.

export type VercelUsage = {
  fluid_cpu_seconds: number;
  function_invocations: number;
  origin_transfer_bytes: number;
  edge_requests: number;
  edge_cpu_ms: number;
  build_minutes: number;
  web_analytics_events: number;
  isr_reads: number;
  fluid_memory_gb_hrs: number;
  /** Sub-cents-precise dollar total of in-cycle charges (from billing/charges).
   *  0 on Hobby + on Pro accounts with no billable usage in the period. */
  charges_total_usd: number;
  /** "usage" if the Pro /v1/usage endpoint provided the quantities,
   *  "charges" if they came from /v1/billing/charges. */
  source: "usage" | "charges";
  fetched_at: string;
};

export type VercelUsageError = { error: string };

// ── In-memory cache ───────────────────────────────────────────────────────────

let cached: VercelUsage | null = null;
let cacheExpiresAt = 0;

export function clearVercelUsageCache(): void {
  cached = null;
  cacheExpiresAt = 0;
}

// ── Empty metric template ─────────────────────────────────────────────────────

function emptyMetrics(): Omit<VercelUsage, "source" | "fetched_at"> {
  return {
    fluid_cpu_seconds: 0,
    function_invocations: 0,
    origin_transfer_bytes: 0,
    edge_requests: 0,
    edge_cpu_ms: 0,
    build_minutes: 0,
    web_analytics_events: 0,
    isr_reads: 0,
    fluid_memory_gb_hrs: 0,
    charges_total_usd: 0,
  };
}

// ── Description → metric-key mapping ──────────────────────────────────────────
//
// Vercel's billing charges identify each metric via the ChargeDescription
// (and sometimes ResourceName) string. These are stable user-facing labels
// from the FOCUS export — they don't change with API version bumps.

function chargeDescriptionToMetricKey(
  desc: string,
): keyof ReturnType<typeof emptyMetrics> | null {
  const d = desc.toLowerCase();
  if (d.includes("fluid") && d.includes("cpu")) return "fluid_cpu_seconds";
  if (d.includes("fluid") && d.includes("memory")) return "fluid_memory_gb_hrs";
  if (d.includes("function invocation")) return "function_invocations";
  if (d.includes("edge request")) return "edge_requests";
  if (d.includes("edge cpu") || d.includes("edge function cpu")) return "edge_cpu_ms";
  if (d.includes("origin transfer") || d.includes("fast origin")) return "origin_transfer_bytes";
  if (d.includes("build minute") || d.includes("build time")) return "build_minutes";
  if (d.includes("isr read") || d.includes("isr requests")) return "isr_reads";
  if (d.includes("web analytics") || d.includes("analytics event")) return "web_analytics_events";
  return null;
}

// ── /v1/usage attempt (Pro+ only) ─────────────────────────────────────────────
//
// The response shape from /v1/usage isn't documented in the public Vercel REST
// reference, so we treat the body as opaque JSON and look for keys that match
// our platform_limits.metric names (with snake-case fallback to camelCase
// alternatives). On 4xx return null so the caller tries billing/charges.

type UsageResponse = Record<string, unknown>;

const USAGE_KEY_ALIASES: Record<keyof ReturnType<typeof emptyMetrics>, string[]> = {
  fluid_cpu_seconds: ["fluidCpuSeconds", "fluidComputeCpuSeconds", "fluid_cpu_seconds"],
  function_invocations: ["functionInvocations", "function_invocations", "invocations"],
  origin_transfer_bytes: ["originTransferBytes", "fastOriginTransferBytes", "bandwidth"],
  edge_requests: ["edgeRequests", "edge_requests"],
  edge_cpu_ms: ["edgeCpuMs", "edgeFunctionCpuMs", "edge_cpu_ms"],
  build_minutes: ["buildMinutes", "buildTime", "build_minutes"],
  web_analytics_events: ["webAnalyticsEvents", "analyticsEvents", "web_analytics_events"],
  isr_reads: ["isrReads", "isr_reads"],
  fluid_memory_gb_hrs: ["fluidMemoryGbHours", "fluidMemoryGbHrs", "fluid_memory_gb_hrs"],
  charges_total_usd: [],
};

function extractFromUsageBody(
  body: UsageResponse,
): Omit<VercelUsage, "source" | "fetched_at"> {
  const out = emptyMetrics();
  // Vercel may wrap quantities under different top-level keys depending on the
  // schema version — scan the body recursively for matching aliases.
  const candidates = flattenNumeric(body);
  for (const key of Object.keys(out) as Array<keyof typeof out>) {
    if (key === "charges_total_usd") continue;
    for (const alias of USAGE_KEY_ALIASES[key]) {
      const v = candidates.get(alias.toLowerCase());
      if (typeof v === "number" && v > 0) {
        out[key] = v;
        break;
      }
    }
  }
  return out;
}

function flattenNumeric(
  obj: unknown,
  out: Map<string, number> = new Map(),
): Map<string, number> {
  if (obj === null || typeof obj !== "object") return out;
  if (Array.isArray(obj)) {
    for (const item of obj) flattenNumeric(item, out);
    return out;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === "number") {
      // Last one wins; usage responses don't repeat keys at conflicting depths.
      out.set(k.toLowerCase(), v);
    } else {
      flattenNumeric(v, out);
    }
  }
  return out;
}

// ── /v1/billing/charges fallback ──────────────────────────────────────────────

type ChargeLine = Record<string, string | undefined>;

function parseChargesBody(text: string): ChargeLine[] {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as ChargeLine;
      } catch {
        return null;
      }
    })
    .filter(Boolean) as ChargeLine[];
}

function extractFromCharges(
  charges: ChargeLine[],
): Omit<VercelUsage, "source" | "fetched_at"> {
  const out = emptyMetrics();
  for (const c of charges) {
    const desc = c["ChargeDescription"] ?? c["ResourceName"] ?? "";
    const key = chargeDescriptionToMetricKey(desc);
    if (key) {
      out[key] += Number(c["UsageQuantity"]) || 0;
    }
    out.charges_total_usd += parseFloat(c["BilledCost"] ?? "0") || 0;
  }
  return out;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function getVercelUsage(): Promise<VercelUsage | VercelUsageError> {
  if (cached && Date.now() < cacheExpiresAt) {
    return cached;
  }

  const token = process.env["VERCEL_API_TOKEN"];
  if (!token) return { error: "VERCEL_API_TOKEN not set" };

  const teamId = process.env["VERCEL_TEAM_ID"];
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const to = now.toISOString();

  const headers = {
    Authorization: `Bearer ${token}`,
    "Accept-Encoding": "gzip",
  };

  // ── Attempt 1: /v1/usage ────────────────────────────────────────────────────
  try {
    const u = new URL(`${BASE}/v1/usage`);
    u.searchParams.set("from", from);
    u.searchParams.set("to", to);
    if (teamId) u.searchParams.set("teamId", teamId);

    const res = await fetch(u.toString(), {
      headers,
      cache: "no-store",
    } as RequestInit & { cache?: RequestCache });

    if (res.ok) {
      const body = (await res.json()) as UsageResponse;
      const metrics = extractFromUsageBody(body);
      const result: VercelUsage = {
        ...metrics,
        source: "usage",
        fetched_at: new Date().toISOString(),
      };
      cached = result;
      cacheExpiresAt = Date.now() + CACHE_TTL_MS;
      return result;
    }
    // Non-2xx → try the charges fallback. Capture the error body for later if
    // both attempts fail, so the dashboard sees the more informative message.
  } catch {
    // fall through to charges
  }

  // ── Attempt 2: /v1/billing/charges ─────────────────────────────────────────
  try {
    const u = new URL(`${BASE}/v1/billing/charges`);
    u.searchParams.set("from", from);
    u.searchParams.set("to", to);
    if (teamId) u.searchParams.set("teamId", teamId);

    const res = await fetch(u.toString(), {
      headers,
      cache: "no-store",
    } as RequestInit & { cache?: RequestCache });

    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      let msg = body.slice(0, 200);
      try {
        const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } };
        if (parsed.error?.code) {
          msg = `${parsed.error.code}${parsed.error.message ? ": " + parsed.error.message : ""}`;
        }
      } catch {
        // body wasn't JSON, keep the raw slice
      }
      return { error: `HTTP ${res.status}: ${msg}` };
    }

    const text = await res.text();
    const charges = parseChargesBody(text);
    const metrics = extractFromCharges(charges);

    const result: VercelUsage = {
      ...metrics,
      source: "charges",
      fetched_at: new Date().toISOString(),
    };
    cached = result;
    cacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return result;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
