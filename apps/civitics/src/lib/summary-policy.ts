// FIX-1029 — the /summary answer vocabulary, in one place.
//
// `/api/officials/[id]/summary` used to answer every outcome — a DB outage, an
// unreadable spend ledger, a model exception, and a genuine "this official has
// no record" — with the identical `200 {summary: null}` body. A caller could
// not tell "we have nothing to say" from "the database is down", which is why
// the FIX-1021 liveness probe had to route around the surface entirely and go
// to /responsiveness instead. Same signal-laundering class as FIX-1027.
//
// THE RULE: AN ERROR IS NEVER A 200.
//
// The builders below are the only places the status and the cache headers are
// decided, so FIX-796's contract — CDN headers on the summary-bearing 200s and
// nowhere else — holds by construction rather than by discipline. The route is
// a driver; every classification it makes is a pure function here, and every
// one of them is pinned by summary-policy.test.ts.

import { NextResponse } from "next/server";
import { withPublicCdnCache } from "./cdn-cache";

/** Why a 200 carried no summary. Absent for the plain no-record case. */
export type NoSummaryReason = "disabled" | "monthly_cap_reached";

/**
 * The infrastructure-failure answer: 503, never CDN-stamped, and explicitly
 * `no-store` so the shared edge in front of us (Cloudflare fronts the site)
 * cannot pin a transient outage as though it were an answer.
 *
 * Callers are ONLY thrown errors and inspected `error` fields — never a
 * zero-rows result.
 */
export function summaryUnavailable(): NextResponse {
  const res = NextResponse.json({ summary: null, error: "unavailable" }, { status: 503 });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

/**
 * A real answer that happens to carry no text: the kill switch is off, the
 * spend cap is reached, the official genuinely has no votes and no donors, or
 * the model returned empty text. 200, and deliberately NOT CDN-stamped — a
 * null is cheap to recompute and must never be pinned at the edge (FIX-796).
 */
export function summaryNone(reason?: NoSummaryReason): NextResponse {
  return NextResponse.json(reason ? { summary: null, error: reason } : { summary: null });
}

/** The one response that carries text, and therefore the one that is cached. */
export function summaryText(text: string): NextResponse {
  return withPublicCdnCache(NextResponse.json({ summary: text }));
}

/**
 * Classify a supabase-js single-row read.
 *
 * supabase-js RESOLVES rather than throws on a failed query, handing back
 * `{data: null, error}`. Checking `!data` alone therefore reports a DB outage
 * as "this official does not exist" — the original bug. The error field is
 * inspected FIRST; only a null row with no error is a genuine no-record.
 */
export function officialsReadOutcome(
  res: { data: unknown; error: unknown },
): "unavailable" | "no_record" | "ok" {
  if (res.error) return "unavailable";
  if (!res.data) return "no_record";
  return "ok";
}

/**
 * Month-to-date spend in cents — THIS FAILS CLOSED.
 *
 * The original swallowed its error and returned 0, so an unreadable ledger read
 * as "$0 spent this month" and the $4.00 cap was not enforced for that request:
 * the one direction a cost guard must never fail in. It throws instead, and the
 * route turns that into a 503 BEFORE the model client is constructed. An
 * unreadable ledger means no model call, not an unmetered one.
 */
export function spendCentsOrThrow(res: {
  data: Array<{ cost_cents: number | null }> | null;
  error: { message?: string } | null;
}): number {
  if (res.error) {
    throw new Error(`spend-cap read failed: ${res.error.message ?? String(res.error)}`);
  }
  return (res.data ?? []).reduce((sum, r) => sum + (r.cost_cents ?? 0), 0);
}

/** Reaching the cap is an ANSWER (200). Failing to read it is not (see above). */
export function capDecision(spentCents: number, limitCents: number): "generate" | "cap_reached" {
  return spentCents >= limitCents ? "cap_reached" : "generate";
}
