import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (supabaseUnavailable()) return unavailableResponse();
  try {
    const { from_id, to_id, max_hops = 4 } = await req.json() as {
      from_id: string;
      to_id: string;
      max_hops?: number;
    };

    if (!from_id || !to_id) {
      return NextResponse.json({ error: "from_id and to_id are required" }, { status: 400 });
    }

    const supabase = createAdminClient();

    // BFS via recursive CTE
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc("find_entity_path", {
      p_from_id: from_id,
      p_to_id: to_id,
      p_max_hops: Math.min(max_hops, 4),
    });

    if (error) {
      // If RPC doesn't exist yet, return graceful empty response
      console.error("[pathfinder]", error.message);
      return NextResponse.json({ path: null, message: "Path finding not yet configured" });
    }

    return NextResponse.json({ path: data });
  } catch (e) {
    console.error("[pathfinder]", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
