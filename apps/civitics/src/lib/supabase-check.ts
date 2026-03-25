import { NextResponse } from "next/server";

export function supabaseUnavailable(): boolean {
  return process.env.SUPABASE_AVAILABLE === "false";
}

export function unavailableResponse(): NextResponse {
  return NextResponse.json(
    { error: "Service temporarily unavailable", retry_after: 3600 },
    {
      status: 503,
      headers: {
        "Retry-After": "3600",
        "Cache-Control": "no-store",
      },
    }
  );
}
