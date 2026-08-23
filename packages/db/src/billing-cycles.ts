/**
 * Per-provider billing cycles for the Platform Costs card (FIX-1089).
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 *
 * Everything on this card is quietly anchored to the calendar month:
 * `platform_usage.period_start` is `date_trunc('month')`, the Vercel projection
 * scales by days-in-calendar-month, the Anthropic spend sums from the 1st. Two
 * of our providers are not on the calendar month, and both were found by
 * asking the vendor rather than by assuming:
 *
 *   Vercel   GET /v2/teams/{id} → billing.period
 *            = 2026-08-14T07:00Z … 2026-09-14T07:00Z
 *   Upstash  GET /v2/redis/database/{id} → creation_time 1781337093
 *            = 2026-06-13T07:51:33Z, so the allotment rolls on the 13th
 *
 * The Upstash one is the case that makes this load-bearing. Its 500,000-command
 * allotment is per BILLING PERIOD, and on 2026-08-15 a crawler spent all of it
 * in 15.5 hours. "99.8% used" without a cycle end cannot answer the only
 * question that matters during that incident — when does the rate limiter come
 * back — and the calendar-month answer (Sep 1) is wrong by twelve days.
 *
 * ── HONESTY ABOUT PROVENANCE ─────────────────────────────────────────────────
 *
 * `source` is not decoration. A cycle read off the vendor and a cycle we
 * assumed look identical once rendered as two dates, so the UI must be able to
 * caveat the assumed ones:
 *
 *   'api'       the vendor told us these dates this tick
 *   'configured' derived from a durable vendor fact (an anniversary day) rather
 *               than a live window read
 *   'calendar'  assumed: the calendar month, because nothing better exists
 *
 * Supabase is 'calendar' and that is a finding, not a shrug: the Management API
 * exposes the org plan but every billing endpoint 404s (org-scope
 * /billing/subscription, /billing/usage, /billing/addons; project-scope
 * /billing/subscription — all probed 2026-08-22).
 *
 * Pure functions. The clock is always an argument so the tests are meaningful.
 */

export type CycleSource = "api" | "configured" | "calendar";

export type BillingCycle = {
  /** ISO start of the cycle currently in progress, inclusive. */
  start: string;
  /** ISO end of that cycle, exclusive. */
  end: string;
  source: CycleSource;
  /** Compact human form, e.g. "Aug 14 – Sep 14". */
  label: string;
  /** Where the dates came from. Rendered as the caveat on non-'api' cycles. */
  detail: string;
  /** Fraction of the cycle elapsed, 0–100. The pace denominator. */
  elapsed_pct: number;
  /** Whole days remaining, floored at 0. */
  days_remaining: number;
};

/**
 * A provider whose numbers have no cycle at all — an instantaneous gauge or a
 * trailing window. Distinct from "we don't know the cycle": there is nothing to
 * know, and pacing or projecting the value would be meaningless.
 */
export type RollingWindow = {
  rolling: true;
  label: string;
  detail: string;
};

export type ProviderCycle = BillingCycle | RollingWindow;

export function isRolling(c: ProviderCycle): c is RollingWindow {
  return "rolling" in c;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;

function fmt(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${d.getUTCDate()}`;
}

function finish(
  startMs: number,
  endMs: number,
  nowMs: number,
  source: CycleSource,
  detail: string,
): BillingCycle {
  const start = new Date(startMs).toISOString();
  const end = new Date(endMs).toISOString();
  const span = Math.max(1, endMs - startMs);
  const elapsed = Math.min(100, Math.max(0, ((nowMs - startMs) / span) * 100));
  return {
    start,
    end,
    source,
    label: `${fmt(start)} – ${fmt(end)}`,
    detail,
    elapsed_pct: Math.round(elapsed * 100) / 100,
    days_remaining: Math.max(0, Math.floor((endMs - nowMs) / MS_PER_DAY)),
  };
}

// ── Calendar month ────────────────────────────────────────────────────────────

/**
 * The calendar month containing `now`, in UTC.
 *
 * UTC and not local time on purpose: `platform_usage.period_start` is
 * `date_trunc('month', NOW())` on a UTC database, and a local-time month
 * boundary would disagree with it by the server's offset — which on this
 * machine (America/Los_Angeles) is 7–8 hours of every month-end reading the
 * wrong period.
 */
export function calendarMonthCycle(
  now: Date,
  detail = "Assumed: calendar month. No billing-period API available for this provider.",
): BillingCycle {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return finish(
    Date.UTC(y, m, 1),
    Date.UTC(y, m + 1, 1),
    now.getTime(),
    "calendar",
    detail,
  );
}

// ── Explicit vendor window ────────────────────────────────────────────────────

/**
 * A window the vendor stated outright (Vercel's `billing.period`).
 *
 * Returns null on a missing, non-finite or inverted pair rather than
 * substituting the calendar month — a caller that silently degrades to
 * 'calendar' would report an assumption with the vendor's authority behind it.
 */
export function vendorWindowCycle(
  startMs: number | null | undefined,
  endMs: number | null | undefined,
  now: Date,
  detail: string,
): BillingCycle | null {
  if (typeof startMs !== "number" || typeof endMs !== "number") return null;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  if (endMs <= startMs) return null;
  return finish(startMs, endMs, now.getTime(), "api", detail);
}

// ── Anniversary-day cycle ─────────────────────────────────────────────────────

/**
 * The cycle implied by a monthly anniversary — a subscription that renews on
 * the Nth of each month (Upstash, from its `creation_time`).
 *
 * Short months clamp: an anchor on the 31st rolls on the 28th/30th, matching
 * how every subscription biller behaves. Without the clamp, February would
 * produce a start date in March and `elapsed_pct` would go negative.
 */
export function anniversaryCycle(
  anchor: Date,
  now: Date,
  detail: string,
  source: CycleSource = "configured",
): BillingCycle {
  const anchorDay = anchor.getUTCDate();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();

  const dayIn = (year: number, month: number): number =>
    Math.min(anchorDay, new Date(Date.UTC(year, month + 1, 0)).getUTCDate());

  // This month's anniversary; if it hasn't happened yet, the cycle started last
  // month. Compared on the same clock as `now` (UTC ms), never on date parts.
  const thisMonth = Date.UTC(y, m, dayIn(y, m));
  const startMs =
    now.getTime() >= thisMonth ? thisMonth : Date.UTC(y, m - 1, dayIn(y, m - 1));
  const startDate = new Date(startMs);
  const sy = startDate.getUTCFullYear();
  const sm = startDate.getUTCMonth();
  const endMs = Date.UTC(sy, sm + 1, dayIn(sy, sm + 1));

  return finish(startMs, endMs, now.getTime(), source, detail);
}
