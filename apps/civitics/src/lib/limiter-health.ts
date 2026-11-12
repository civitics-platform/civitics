// /api/cron/limiter-health, answered by middleware.ts itself (FIX-1402, cc-272).
//
// WHY THE MIDDLEWARE: cc-270 shipped this as an edge route, but Next bundles
// middleware and each edge route separately (middleware-manifest.json:
// `middleware ['/']` vs `functions ['/api/cron/limiter-health/route', …]`), so
// the route read its own copy of ratelimit.ts's module state and prod answered
// `mode null` and zeros. FIX-1304's receipt (the budget hold's first
// engagement) needs the LIMITER's state, so the module that runs
// checkRateLimit answers. `health_scope: "middleware"` says so in the payload.
//
// THE STAMP (D1): every answer, the 401 included, carries
//   x-civitics-ip-key: cf=<absent|same|differs>; key=<xff|real|cf|unknown>
// `cf` compares cf-connecting-ip with x-forwarded-for's first hop; `key` names
// the header getClientIp keyed THIS request on, under the same
// `trustCfConnectingIp` the middleware hands the bucket check. A class, never
// an address, so a probe without the bearer (the GHA job holds the Under Attack
// skip header but not CRON_SECRET) still reads whether the limiter's key is the
// client or the Cloudflare edge that connected to Vercel (FIX-1401: deploy A
// read `cf=differs; key=xff` through IAD and ORD).
//
// THE BEARER (D2/D3): CRON_SECRET, compared in constant time; missing env or a
// mismatch is 401. With it, one forced budget-flag read (forceBudgetFlagRead —
// 1 Upstash GET per call, hand-run only), so `budget_hold` / `budget_detail`
// are the flag as of this call on any isolate. `mode` stays this isolate's own
// history: null when `isolate.checks` is 0.
//
// Under /api/cron/ for the origin door's one exemption (origin-auth.ts D4) and
// the bearer that makes it safe. Nothing schedules it: no vercel.json cron, no
// registry row. Pure apart from the ratelimit.ts state it reads; edge-safe.

import { CLIENT_IP_HEADERS, resolveClientIp, type ClientIpOptions } from "./client-ip";
import { constantTimeEqual } from "./origin-auth";
import { forceBudgetFlagRead, getLimiterHealth, getLimiterIsolate } from "./ratelimit";

export const LIMITER_HEALTH_PATH = "/api/cron/limiter-health";
export const IP_KEY_HEADER = "x-civitics-ip-key";

export type CfConnectingIpClass = "absent" | "same" | "differs";

/** `cf=` of the stamp: cf-connecting-ip against x-forwarded-for's first hop. */
export function classifyCfConnectingIp(headers: Pick<Headers, "get">): CfConnectingIpClass {
  const cf = headers.get("cf-connecting-ip")?.trim();
  if (!cf) return "absent";
  const xff = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return cf === xff ? "same" : "differs";
}

export function ipKeyStamp(headers: Pick<Headers, "get">, options: ClientIpOptions = {}): string {
  return `cf=${classifyCfConnectingIp(headers)}; key=${resolveClientIp(headers, options).source}`;
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

function json(body: unknown, status: number, stamp: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...NO_STORE, [IP_KEY_HEADER]: stamp },
  });
}

export async function answerLimiterHealth(
  headers: Pick<Headers, "get">,
  secret: string | undefined,
  options: ClientIpOptions = {},
): Promise<Response> {
  const stamp = ipKeyStamp(headers, options);
  const auth = headers.get("authorization") ?? "";
  if (!secret || !constantTimeEqual(auth, `Bearer ${secret}`)) {
    return json({ error: "Unauthorized" }, 401, stamp);
  }

  const budgetRead = await forceBudgetFlagRead();
  const ip = Object.fromEntries(
    CLIENT_IP_HEADERS.map((name) => [name.replace(/-/g, "_"), headers.get(name)]),
  ) as Record<"x_forwarded_for" | "x_real_ip" | "cf_connecting_ip", string | null>;
  return json(
    {
      health: getLimiterHealth(),
      health_scope: "middleware",
      budget_read: budgetRead,
      isolate: getLimiterIsolate(),
      ip: { ...ip, key_in_use: resolveClientIp(headers, options).ip },
      at: new Date().toISOString(),
    },
    200,
    stamp,
  );
}
