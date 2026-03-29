import { createAdminClient } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";

export const dynamic = "force-dynamic";

interface TreemapRow {
  official_id: string;
  official_name: string;
  party: string;
  state: string;
  chamber: string;
  total_donated_cents: number;
}

export async function GET(request: Request) {
  if (supabaseUnavailable()) return unavailableResponse();
  const supabase = createAdminClient();

  // groupBy and sizeBy are accepted for API compatibility and passed to the client.
  // Actual grouping is done client-side in TreemapGraph; chamber data is always returned.
  const { searchParams } = new URL(request.url);
  void searchParams.get("groupBy");  // accepted, used client-side
  void searchParams.get("sizeBy");   // accepted, used client-side

  const { data, error } = await supabase.rpc("treemap_officials_by_donations", {
    lim: 200,
  });

  if (error) {
    console.error("[graph/treemap] RPC error:", error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json((data ?? []) as TreemapRow[]);
}
