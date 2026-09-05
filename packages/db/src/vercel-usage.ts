/**
 * Vercel current-cycle usage metrics — for the Platform Costs card.
 *
 * PRIMARY source: GET /v1/billing/charges?from=<iso-ms>&to=<iso-ms>[&teamId=...]
 *   FOCUS-format charges, one JSON object per line (JSONL). Each line carries
 *   ServiceName + ConsumedQuantity + ConsumedUnit (the metered amount) and
 *   BilledCost + EffectiveCost (the dollars). This endpoint returns BOTH the
 *   quantities AND the costs, so it is the authoritative source.
 *
 * FALLBACK: GET /v1/usage?from=<iso-ms>&to=<iso-ms>[&teamId=...]
 *   Quantities only, no costs. Pro/Enterprise only — and as of 2026-06 it
 *   responds 400 invalid_time_range for every range we send, so it is dead in
 *   practice. Kept as a best-effort quantity-only fallback in case charges ever
 *   regresses; it never short-circuits the charges path (which has the costs).
 *
 * FIX-644 — the previous implementation keyed extractFromCharges() on
 * c["ChargeDescription"] + c["UsageQuantity"], neither of which exists in the
 * response (the fields are ServiceName + ConsumedQuantity). Every metric
 * therefore wrote 0 with source='api' — the snapshot WAS running, the token IS
 * valid; the parser just never matched a line. This was misfiled as FIX-606
 * ("regenerate the token"). Real FOCUS field names confirmed against prod
 * 2026-06-21.
 *
 * 5-minute in-memory cache (matches Supabase + Cloudflare helpers).
 *
 * Date format: Vercel's billing endpoints require ISO 8601 with millisecond
 * precision and a "Z" suffix — exactly what `Date.prototype.toISOString()`
 * produces.
 */

import { isPlanBaseService } from "./vercel-billing";

const BASE = "https://api.vercel.com";
const CACHE_TTL_MS = 5 * 60 * 1000;

// ── Public types ──────────────────────────────────────────────────────────────
//
// Quantity keys are the platform_limits.metric values for service='vercel'.
// Every key is present in every successful response — a metric not returned by
// the API is set to 0 so the downstream updateUsage() calls always have a
// number to write.

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
  /** Sum of BilledCost across all charge lines — the dollars Vercel actually
   *  bills (overage above plan allotments). 0 while everything is within the
   *  Pro plan. Vercel's native Spend-Management cap watches THIS; we surface it
   *  for completeness but alert on effective_cost_usd (the leading signal). */
  charges_total_usd: number;
  /** Sum of EffectiveCost — the list-price value of ALL consumption (incl.
   *  within-allotment usage + the prorated "Pro" base line). This is the real
   *  monthly run-rate spend and is what we persist as vercel.monthly_spend_usd. */
  effective_cost_usd: number;
  /** FIX-1046: Σ EffectiveCost of the plan-SUBSCRIPTION line(s) only — the `Pro`
   *  charge, which prorates at $20/31 per day. Split out as a first-class field
   *  because every piece of correct billing math starts by removing it:
   *  `usage = effective_cost_usd - plan_base_usd`, and only `usage` draws down
   *  the $20 of included credit that the subscription BUYS. Deriving it
   *  downstream from `cost_breakdown` would be fragile — that array used to be
   *  sliced to the top 8 before it was persisted, so the subscription line could
   *  in principle have fallen out of it. FIX-1041 removed the slice; the field
   *  stays first-class because deriving billing math from a display array is
   *  the wrong dependency direction regardless. */
  plan_base_usd: number;
  /** Number of distinct billing days (ChargePeriodStart) in the response.
   *  Every quantity/cost above is a sum over THIS many days, and the snapshot
   *  writer projects them to a full-month run-rate using it as the divisor.
   *  0 from the quantity-only fallback.
   *
   *  FIX-1041 — THIS IS MONTH-TO-DATE, and the request honours `from`. FIX-648
   *  documented the opposite ("only ever a trailing ~7-day window; it ignores
   *  `from`"), which was true when written and is not true now. Measured on
   *  prod across 927 snapshots, 2026-08-07..09-05: window_days climbs by
   *  exactly one per calendar day — 6,7,8 … 30,31 through August — and RESETS
   *  TO 1 on 09-01, which is the signature of a month-to-date window and could
   *  not happen under a rolling one. `getVercelUsage` sends
   *  `from = first-of-current-month`.
   *
   *  The projection arithmetic was never affected either way: the divisor is
   *  derived from the response, not from the assumption. But the comment
   *  misled anyone reasoning about resolution, which is the whole reason this
   *  field exists.
   *
   *  RESOLUTION, stated where the readers are: values are cumulative MTD and
   *  step ONCE PER DAY at ~06:00-07:00 UTC (Vercel's ChargePeriodStart days are
   *  Pacific days), so consecutive snapshots inside a day are byte-identical.
   *  The platform-snapshot cron runs every 30 minutes — a Vercel cron in
   *  apps/civitics/vercel.json on a 30-minute slash-schedule, moved there
   *  from a GitHub Actions 10-minute one by FIX-1127 (the literal
   *  expressions are not repeated here: a cron slash-star sequence closes
   *  a block comment). That cadence buys ZERO extra resolution on any
   *  Vercel metric. An incident
   *  can be localised to a calendar day and never to an hour. The series IS
   *  differentiable into per-day usage — that is how the 2026-08-15 cost audit
   *  was built — but no faster snapshot will change the granularity. */
  window_days: number;
  /** Earliest / latest ChargePeriodStart in the window (ISO), or null. */
  window_start: string | null;
  window_end: string | null;
  /** FIX-648: per-ServiceName EffectiveCost over the window (non-zero only,
   *  descending). The "what spiked" breakdown — the snapshot writer projects
   *  each to a monthly run-rate and surfaces it on the card and to the leading
   *  fluid-cost alert. Empty from the quantity-only fallback.
   *
   *  FIX-1041 — each line now also carries the RAW metered amount from the same
   *  charge lines that produced its dollars:
   *
   *    quantity  Σ ConsumedQuantity for this ServiceName, or null if Vercel
   *              sent no quantity for it
   *    unit      the ConsumedUnit string Vercel used, verbatim
   *    metric    our metric name when `mapChargeQuantity` recognises the
   *              service, else null
   *
   *  `metric: null` with a non-null quantity is the interesting case: the line
   *  costs money and IS metered by Vercel, but we do not track it as one of our
   *  own metrics. That is the state Observability Events was in when the
   *  2026-08-15 cost-spike audit could report "observability cost rose 3.7x"
   *  and could not state an event count or a unit — and Observability Events is
   *  the largest non-subscription line on this account (projected $11.02/mo at
   *  its August peak). Recording the raw quantity per line makes that gap
   *  visible on the card instead of leaving it to be inferred, WITHOUT
   *  inventing a `platform_usage` metric and a limit row for every service
   *  Vercel happens to bill. */
  cost_breakdown: {
    service: string;
    effective_usd: number;
    quantity: number | null;
    unit: string | null;
    metric: keyof QuantityMetrics | null;
  }[];
  /** FIX-1089: EffectiveCost over the window, keyed by OUR metric name rather
   *  than by ServiceName — the same `mapChargeQuantity` mapping that produces
   *  the quantities, applied to the dollars. Two things fall out of it:
   *
   *    implied cost   the dollars this metric contributed, directly measured
   *    unit rate      those dollars ÷ the quantity above them
   *
   *  Measured beats published here. Vercel prices by region (fastDataTransfer
   *  is $0.15/GB in iad1 and $0.35/GB in icn1), so a list price is not the
   *  price this account pays, and the ratio of two numbers from the same
   *  response cannot drift when Vercel reprices. Empty from the quantity-only
   *  fallback, and a key is absent (not zero) when no charge line mapped. */
  cost_by_metric: Partial<Record<keyof QuantityMetrics, number>>;
  /** "charges" if the billing/charges endpoint provided the data (the normal
   *  path), "usage" if only the quantity-only /v1/usage fallback succeeded. */
  source: "usage" | "charges";
  fetched_at: string;
};

export type VercelUsageError = { error: string };

type CostFields = "charges_total_usd" | "effective_cost_usd" | "plan_base_usd";
// FIX-648: window + breakdown are response-level metadata, not metric quantities.
type WindowFields =
  | "window_days"
  | "window_start"
  | "window_end"
  | "cost_breakdown"
  | "cost_by_metric";
type QuantityMetrics = Omit<VercelUsage, "source" | "fetched_at" | CostFields | WindowFields>;
type AllMetrics = Omit<VercelUsage, "source" | "fetched_at" | WindowFields>;

// ── In-memory cache ───────────────────────────────────────────────────────────

let cached: VercelUsage | null = null;
let cacheExpiresAt = 0;

export function clearVercelUsageCache(): void {
  cached = null;
  cacheExpiresAt = 0;
}

// ── Empty metric template ─────────────────────────────────────────────────────

function emptyMetrics(): AllMetrics {
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
    effective_cost_usd: 0,
    plan_base_usd: 0,
  };
}

const BYTES_PER_GB = 1024 ** 3;

// ── ServiceName → metric mapping (FIX-644) ────────────────────────────────────
//
// Maps a FOCUS charge line's ServiceName to one of our quantity metrics and
// converts ConsumedQuantity (in its native ConsumedUnit) to the metric's unit.
// ServiceName strings are stable user-facing labels from the FOCUS export.
// Order matters: more-specific matches (e.g. edge CPU duration) are checked
// before the generic "edge request" match. Returns null for service lines we
// don't track as one of OUR metrics (Blob, Queues, Speed Insights,
// Observability Events, ISR Writes, the "Pro" base line) — those still
// contribute to the cost sums.
//
// FIX-1041 — "not one of our metrics" no longer means "unmeasured". Since this
// change `cost_breakdown` records the raw ConsumedQuantity and ConsumedUnit for
// EVERY billed service, mapped or not, so an unmapped line shows its quantity
// on the card rather than showing dollars with no denominator. Services seen on
// this account over 2026-08-07..09-05 that return null here and still cost
// money: Observability Events (the largest non-subscription line, $11.02/mo at
// its August peak), ISR Writes ($3.29), Speed Insights Data Points ($1.34),
// Speed Insights Plus Events ($0.78).
//
// NOTE for whoever adds a mapping next: the check below is `isr read`, and the
// service Vercel actually bills on this account is "ISR Writes" — so
// `isr_reads` has been receiving 0 from a live, paid line. Correcting that is
// NOT a comment change: `isr_reads` is a platform_usage metric with a limit
// row, and pointing it at writes changes what an existing series means. Left
// deliberately, now visible via the per-line quantity.

function mapChargeQuantity(
  serviceName: string,
  qty: number,
): { key: keyof QuantityMetrics; value: number } | null {
  const d = serviceName.toLowerCase();

  // Fast Origin Transfer — billed in gigabytes; our metric is bytes.
  if (d.includes("fast origin transfer")) {
    return { key: "origin_transfer_bytes", value: qty * BYTES_PER_GB };
  }
  // Fluid Active CPU — billed in hours; our metric is seconds.
  if (d.includes("fluid") && d.includes("cpu")) {
    return { key: "fluid_cpu_seconds", value: qty * 3600 };
  }
  // Fluid Provisioned Memory — billed in gigabyte-hours; metric matches.
  if (d.includes("fluid") && d.includes("memory")) {
    return { key: "fluid_memory_gb_hrs", value: qty };
  }
  if (d.includes("function invocation")) {
    return { key: "function_invocations", value: qty };
  }
  // Edge CPU duration ("Edge Requests - Additional CPU Duration", billed in
  // hours) → ms. Checked before the generic edge-request match below.
  if (d.includes("edge") && d.includes("cpu duration")) {
    return { key: "edge_cpu_ms", value: qty * 3_600_000 };
  }
  if (d.includes("edge request")) {
    return { key: "edge_requests", value: qty };
  }
  // "Build Minutes" and/or "Build CPU Minutes" — both fold into build_minutes.
  if (d.includes("build") && d.includes("minute")) {
    return { key: "build_minutes", value: qty };
  }
  if (d.includes("isr read")) {
    return { key: "isr_reads", value: qty };
  }
  if (d.includes("web analytics")) {
    return { key: "web_analytics_events", value: qty };
  }
  return null;
}

// ── /v1/billing/charges parsing (primary) ─────────────────────────────────────

type ChargeLine = Record<string, unknown>;

/** Exported for tests (FIX-1041). */
export function parseChargesBody(text: string): ChargeLine[] {
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

function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

type ChargesExtract = {
  metrics: AllMetrics;
  window_days: number;
  window_start: string | null;
  window_end: string | null;
  cost_breakdown: VercelUsage["cost_breakdown"];
  cost_by_metric: Partial<Record<keyof QuantityMetrics, number>>;
};

/** Exported for tests (FIX-1041): the breakdown builder is the thing under test. */
export function extractFromCharges(charges: ChargeLine[]): ChargesExtract {
  const out = emptyMetrics();
  const days = new Set<string>();
  // FIX-1041: dollars AND the raw metered amount, per ServiceName. Lines are
  // per (day, region) leaves, so both are summed across regions the same way.
  const byService = new Map<
    string,
    { usd: number; quantity: number; sawQuantity: boolean; unit: string | null; metric: keyof QuantityMetrics | null }
  >();
  const byMetric: Partial<Record<keyof QuantityMetrics, number>> = {};
  for (const c of charges) {
    const serviceName = typeof c["ServiceName"] === "string" ? (c["ServiceName"] as string) : "";
    const qty = num(c["ConsumedQuantity"]);
    const mapped = mapChargeQuantity(serviceName, qty);
    if (mapped) out[mapped.key] += mapped.value;
    const billed = num(c["BilledCost"]);
    const effective = num(c["EffectiveCost"]);
    out.charges_total_usd += billed;
    out.effective_cost_usd += effective;
    // FIX-1089: dollars keyed by OUR metric, through the SAME mapping as the
    // quantity above — so cost and quantity can never end up describing
    // different sets of charge lines. Accumulated even when effective is 0 so a
    // genuinely-free metric reports $0 rather than looking unmeasured.
    if (mapped) byMetric[mapped.key] = (byMetric[mapped.key] ?? 0) + effective;
    // FIX-1046: keep the subscription line separable from consumption.
    if (isPlanBaseService(serviceName)) out.plan_base_usd += effective;
    // FIX-648: window + per-service breakdown. Lines are per (day, region)
    // leaves (e.g. Fluid Provisioned Memory = 7 days x 21 regions = 147 lines),
    // so distinct ChargePeriodStart is the true day count and summing per
    // ServiceName aggregates regions correctly.
    const day = c["ChargePeriodStart"];
    if (typeof day === "string") days.add(day);
    if (serviceName && effective !== 0) {
      const hit = byService.get(serviceName) ?? {
        usd: 0,
        quantity: 0,
        sawQuantity: false,
        unit: null as string | null,
        metric: (mapped?.key ?? null) as keyof QuantityMetrics | null,
      };
      hit.usd += effective;
      // A quantity is only "absent" if Vercel sent no ConsumedQuantity field at
      // all. A present-but-zero quantity is a real measurement of zero and must
      // not be laundered into "unmeasured".
      if (c["ConsumedQuantity"] !== undefined && c["ConsumedQuantity"] !== null) {
        hit.sawQuantity = true;
        hit.quantity += qty;
      }
      if (hit.unit === null && typeof c["ConsumedUnit"] === "string" && c["ConsumedUnit"]) {
        hit.unit = c["ConsumedUnit"] as string;
      }
      if (hit.metric === null && mapped) hit.metric = mapped.key;
      byService.set(serviceName, hit);
    }
  }
  const sortedDays = [...days].sort();
  const cost_breakdown = [...byService.entries()]
    .map(([service, v]) => ({
      service,
      effective_usd: v.usd,
      quantity: v.sawQuantity ? v.quantity : null,
      unit: v.unit,
      metric: v.metric,
    }))
    .sort((a, b) => b.effective_usd - a.effective_usd);
  return {
    metrics: out,
    window_days: days.size,
    window_start: sortedDays[0] ?? null,
    window_end: sortedDays[sortedDays.length - 1] ?? null,
    cost_breakdown,
    cost_by_metric: byMetric,
  };
}

// ── /v1/usage parsing (quantity-only fallback) ────────────────────────────────
//
// The /v1/usage response shape isn't in the public REST reference, so we treat
// the body as opaque JSON and look for keys matching our metric names. Costs
// are not available here, so charges_total_usd / effective_cost_usd stay 0.

type UsageResponse = Record<string, unknown>;

const USAGE_KEY_ALIASES: Record<keyof QuantityMetrics, string[]> = {
  fluid_cpu_seconds: ["fluidCpuSeconds", "fluidComputeCpuSeconds", "fluid_cpu_seconds"],
  function_invocations: ["functionInvocations", "function_invocations", "invocations"],
  origin_transfer_bytes: ["originTransferBytes", "fastOriginTransferBytes", "bandwidth"],
  edge_requests: ["edgeRequests", "edge_requests"],
  edge_cpu_ms: ["edgeCpuMs", "edgeFunctionCpuMs", "edge_cpu_ms"],
  build_minutes: ["buildMinutes", "buildTime", "build_minutes"],
  web_analytics_events: ["webAnalyticsEvents", "analyticsEvents", "web_analytics_events"],
  isr_reads: ["isrReads", "isr_reads"],
  fluid_memory_gb_hrs: ["fluidMemoryGbHours", "fluidMemoryGbHrs", "fluid_memory_gb_hrs"],
};

function extractFromUsageBody(body: UsageResponse): AllMetrics {
  const out = emptyMetrics();
  const candidates = flattenNumeric(body);
  for (const key of Object.keys(USAGE_KEY_ALIASES) as Array<keyof QuantityMetrics>) {
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
      out.set(k.toLowerCase(), v);
    } else {
      flattenNumeric(v, out);
    }
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

  const fetchOpts = {
    headers,
    cache: "no-store",
  } as RequestInit & {
    cache?: "default" | "force-cache" | "no-cache" | "no-store" | "only-if-cached" | "reload";
  };

  // ── Primary: /v1/billing/charges (quantities + costs) ───────────────────────
  let chargesErr: string | null = null;
  try {
    const u = new URL(`${BASE}/v1/billing/charges`);
    u.searchParams.set("from", from);
    u.searchParams.set("to", to);
    if (teamId) u.searchParams.set("teamId", teamId);

    const res = await fetch(u.toString(), fetchOpts);
    if (res.ok) {
      const text = await res.text();
      const ex = extractFromCharges(parseChargesBody(text));
      const result: VercelUsage = {
        ...ex.metrics,
        window_days: ex.window_days,
        window_start: ex.window_start,
        window_end: ex.window_end,
        cost_breakdown: ex.cost_breakdown,
        cost_by_metric: ex.cost_by_metric,
        source: "charges",
        fetched_at: new Date().toISOString(),
      };
      cached = result;
      cacheExpiresAt = Date.now() + CACHE_TTL_MS;
      return result;
    }
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
    chargesErr = `HTTP ${res.status}: ${msg}`;
  } catch (err) {
    chargesErr = err instanceof Error ? err.message : String(err);
  }

  // ── Fallback: /v1/usage (quantity-only; costs stay 0) ───────────────────────
  try {
    const u = new URL(`${BASE}/v1/usage`);
    u.searchParams.set("from", from);
    u.searchParams.set("to", to);
    if (teamId) u.searchParams.set("teamId", teamId);

    const res = await fetch(u.toString(), fetchOpts);
    if (res.ok) {
      const body = (await res.json()) as UsageResponse;
      const metrics = extractFromUsageBody(body);
      const result: VercelUsage = {
        ...metrics,
        // Quantity-only fallback has no daily granularity or cost lines, so the
        // window/breakdown are unknown — projection is skipped downstream when
        // window_days is 0.
        window_days: 0,
        window_start: null,
        window_end: null,
        cost_breakdown: [],
        cost_by_metric: {},
        source: "usage",
        fetched_at: new Date().toISOString(),
      };
      cached = result;
      cacheExpiresAt = Date.now() + CACHE_TTL_MS;
      return result;
    }
  } catch {
    // fall through to the charges error below
  }

  return { error: chargesErr ?? "vercel: billing/charges and usage both failed" };
}
