/**
 * POST /api/platform/web-vitals — Capture a Core Web Vitals sample.
 *
 * Accepts sendBeacon or JSON POST. No auth (public telemetry).
 * No reader yet; no retention — FIX-1406. (FIX-049's nightly aggregation into
 * platform_usage and its 30-day trim were never built.)
 *
 * FIX-1404: a sample from the Chrome 133–142 fleet (src/lib/view-telemetry.ts)
 * gets the same { ok: true } without the INSERT. The table has no is_bot
 * column, and a headless farm's timings are not field data.
 */

export const dynamic = "force-dynamic";

import { createAdminClient } from "@civitics/db";
import { NextResponse } from "next/server";
import { isChromeFleetUa } from "@/lib/view-telemetry";

const ALLOWED = new Set(["LCP", "CLS", "INP", "FCP", "TTFB"]);

export async function POST(req: Request) {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const { metric, value, rating, path, exceeded } = payload as {
    metric?: string;
    value?: number;
    rating?: string;
    path?: string;
    exceeded?: boolean;
  };

  if (!metric || !ALLOWED.has(metric) || typeof value !== "number" || !Number.isFinite(value)) {
    return NextResponse.json({ error: "invalid_metric" }, { status: 400 });
  }

  const rawUserAgent = req.headers.get("user-agent");
  if (isChromeFleetUa(rawUserAgent)) {
    return NextResponse.json({ ok: true });
  }

  const userAgent = rawUserAgent?.slice(0, 255) ?? null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createAdminClient() as any;

  const { error } = await supabase.from("web_vitals_samples").insert({
    metric,
    value,
    rating: rating ?? null,
    path: path?.slice(0, 255) ?? null,
    exceeded: Boolean(exceeded),
    user_agent: userAgent,
  });

  if (error) {
    return NextResponse.json({ error: "insert_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
