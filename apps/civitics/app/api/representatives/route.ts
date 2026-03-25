import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";

export const dynamic = "force-dynamic";

// Privacy rule: coarsen coordinates to ~1 km accuracy before any DB lookup.
// Never log or store the precise coordinates received from the client.
function coarsen(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function GET(request: NextRequest) {
  if (supabaseUnavailable()) return unavailableResponse();
  const { searchParams } = new URL(request.url);
  const latStr = searchParams.get("lat");
  const lngStr = searchParams.get("lng");

  if (!latStr || !lngStr) {
    return NextResponse.json(
      { error: "lat and lng query params are required" },
      { status: 400 }
    );
  }

  const lat = parseFloat(latStr);
  const lng = parseFloat(lngStr);

  if (isNaN(lat) || isNaN(lng)) {
    return NextResponse.json({ error: "Invalid coordinates" }, { status: 400 });
  }

  const coarsenedLat = coarsen(lat);
  const coarsenedLng = coarsen(lng);

  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);

    // PostGIS stored function — returns officials whose jurisdiction boundary
    // contains the given point. Requires district geometry to be loaded.
    const { data, error } = await supabase.rpc(
      "find_representatives_by_location",
      { user_lat: coarsenedLat, user_lng: coarsenedLng }
    );

    if (error) throw error;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const representatives = (data ?? []).map((r: any) => ({
      id: r.id as string,
      full_name: r.full_name as string,
      role_title: r.role_title as string,
      party: (r.party as string | null) ?? null,
      jurisdiction: (r.jurisdiction as string | null) ?? null,
    }));

    return NextResponse.json({ representatives });
  } catch {
    // District geometry may not be loaded yet — return empty list gracefully
    return NextResponse.json({ representatives: [] });
  }
}
