import { NextRequest, NextResponse } from "next/server";
import { userAgent } from "next/server";
import { createAdminClient } from "@civitics/db";
import { CHROME_FLEET_BOT_NAME, isChromeFleetUa, visitorCountry } from "@/lib/view-telemetry";

export const dynamic = "force-dynamic";

function parseReferrer(refHeader: string, host: string): string {
  if (!refHeader) return "direct";
  if (refHeader.includes(host)) return "internal";
  if (refHeader.includes("google")) return "google";
  if (refHeader.includes("bing")) return "bing";
  if (refHeader.includes("twitter") || refHeader.includes("x.com")) return "twitter";
  if (refHeader.includes("reddit")) return "reddit";
  if (refHeader.includes("linkedin")) return "linkedin";
  if (refHeader.includes("facebook") || refHeader.includes("fb.com")) return "facebook";
  return "other";
}

export async function POST(request: NextRequest) {
  // Never track in development — keeps local data clean
  if (process.env.NODE_ENV === "development") {
    return NextResponse.json({ ok: true });
  }

  try {
    const body = await request.json() as {
      page: string;
      entity_type?: string;
      entity_id?: string;
      session_id: string;
    };

    const ua = userAgent(request);
    const refHeader = request.headers.get("referer") ?? "";
    const host = request.headers.get("host") ?? "civitics.com";
    // FIX-1405: cf-ipcountry (the visitor) before x-vercel-ip-country (the
    // Cloudflare edge) — src/lib/view-telemetry.ts.
    const country = visitorCountry(request.headers);

    // FIX-1404: the Chrome 133–142 fleet is a bot under its own name. The row
    // is still written, so get_pv_bots counts it and every is_bot = false
    // reader drops it.
    const fleet = isChromeFleetUa(ua.ua);
    const isBot = ua.isBot || fleet;
    // Extract bot name from UA string (first token before /)
    const botName = fleet
      ? CHROME_FLEET_BOT_NAME
      : isBot
        ? (ua.ua?.split("/")?.[0]?.trim() ?? "Unknown bot")
        : null;
    const deviceType = isBot ? null : (ua.device?.type ?? "desktop");
    const browser = isBot ? null : (ua.browser?.name ?? null);

    const db = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any).from("page_views").insert({
      page: body.page,
      entity_type: body.entity_type ?? null,
      entity_id: body.entity_id ?? null,
      referrer: parseReferrer(refHeader, host),
      is_bot: isBot,
      bot_name: botName,
      device_type: deviceType,
      browser,
      country_code: country,
      session_id: body.session_id,
    });
  } catch {
    // Tracking must never affect user experience — silently ignore all errors
  }

  return NextResponse.json({ ok: true });
}
