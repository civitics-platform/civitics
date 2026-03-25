import { createAdminClient } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";

export const dynamic = "force-dynamic";

interface TreemapRow {
  official_id: string;
  official_name: string;
  party: string;
  state: string;
  total_donated_cents: number;
}

export async function GET() {
  if (supabaseUnavailable()) return unavailableResponse();
  const supabase = createAdminClient();

  const { data, error } = await supabase.rpc("treemap_officials_by_donations", {
    lim: 200,
  });

  if (error) {
    console.error("[graph/treemap] RPC error:", error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json((data ?? []) as TreemapRow[]);
}
