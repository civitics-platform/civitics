// /api/cron/limiter-health (cc-270) — what the edge limiter keys a request on,
// beside the limiter's health block. A read-only instrument, run by hand.
//
// ip: the three headers an identifier can come from, as this request carried
// them, and `key_in_use` = getClientIp() for this request, the same function
// middleware.ts keys every per-IP bucket on (src/lib/client-ip.ts). Called
// through www.civitics.com, it answers the census's open question
// (docs/audits/2026-11-09-upstash-spend-census.md §10 item 13): is the
// "per-IP" key the client, or the Cloudflare edge that connected to Vercel?
//
// health: getLimiterHealth() as THIS route's isolate sees it. Middleware is its
// own bundle and its own Edge Function on Vercel, so its module state (mode,
// deny-cache, the FIX-1304 budget flag) is a different copy from the one this
// file imports, even though both run on the edge. This isolate never calls
// checkRateLimit, so expect `mode: null`, `budget_hold: null` and zeros here,
// whatever the middleware is doing. `health_scope` says so in the payload.
//
// Under /api/cron/ for the origin door's one exemption and the CRON_SECRET
// bearer that makes it safe (origin-auth.ts D4, FIX-1230). Middleware buckets
// nothing under /api/cron/, so a call costs 0 Upstash commands. Nothing
// schedules it: no vercel.json cron, no registry row.

import { NextResponse, type NextRequest } from "next/server";
import { getClientIp } from "@/lib/client-ip";
import { getLimiterHealth } from "@/lib/ratelimit";

export const runtime = "edge";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get("authorization");
  const expected = `Bearer ${process.env["CRON_SECRET"] ?? ""}`;
  if (!process.env["CRON_SECRET"] || authHeader !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const headers = request.headers;
  return NextResponse.json(
    {
      health: getLimiterHealth(),
      health_scope: "route-isolate",
      ip: {
        x_forwarded_for: headers.get("x-forwarded-for"),
        x_real_ip: headers.get("x-real-ip"),
        cf_connecting_ip: headers.get("cf-connecting-ip"),
        key_in_use: getClientIp(headers),
      },
      at: new Date().toISOString(),
    },
    { headers: NO_STORE },
  );
}
