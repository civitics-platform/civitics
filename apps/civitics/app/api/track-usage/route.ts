import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@civitics/db";

export const dynamic = "force-dynamic";

// Allowed service/metric combinations — reject anything unexpected
const ALLOWED: Record<string, string[]> = {
  mapbox: ["map_load"],
  r2:     ["file_read", "file_write"],
  vercel: ["deployment"],
};

function currentPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { service, metric } = body as { service?: string; metric?: string };

    if (!service || !metric || !ALLOWED[service]?.includes(metric)) {
      return NextResponse.json({ error: "Invalid service/metric" }, { status: 400 });
    }

    const period = currentPeriod();
    const db = createAdminClient();

    // Upsert: insert row or increment count if already exists this period
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any).rpc("increment_service_usage", {
      p_service: service,
      p_metric:  metric,
      p_period:  period,
    });

    return NextResponse.json({ ok: true });
  } catch {
    // Non-critical tracking — always return 200 so UI is never blocked
    return NextResponse.json({ ok: true });
  }
}
