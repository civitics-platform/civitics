// Position rollup API (C1 / FIX-524) — aggregate-only public read over the
// entity_positions spine (FIX-523).
//
// Calls get_entity_position_rollup() (GRANT EXECUTE to anon) which returns the
// 7-bucket distribution, median, pct_with_conditions and n — all NULL except n
// below MIN_POSITIONS_FOR_ROLLUP (10). No user data, so anon is fine; kept
// dynamic (premature caching of near-empty aggregates isn't worth header tuning).

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";
import { isEntityCommentType } from "@civitics/db";

export const dynamic = "force-dynamic";

type Rollup = {
  n: number;
  median: number | null;
  pct_with_conditions: number | null;
  buckets: Record<string, number> | null;
};

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const entityType = sp.get("entity_type");
    const entityId = sp.get("entity_id");
    const lens = sp.get("lens") === "constituents" ? "constituents" : "all";

    if (!entityType || !isEntityCommentType(entityType)) {
      return NextResponse.json({ error: "Invalid entity_type" }, { status: 400 });
    }
    if (!entityId) {
      return NextResponse.json({ error: "entity_id is required" }, { status: 400 });
    }

    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);

    const { data, error } = await supabase.rpc("get_entity_position_rollup", {
      p_entity_type: entityType,
      p_entity_id: entityId,
      p_lens: lens,
    });

    if (error) {
      return NextResponse.json({ error: "Failed to load rollup" }, { status: 500 });
    }

    // The function returns a single-row TABLE → array with one element.
    const row = (Array.isArray(data) ? data[0] : data) as Rollup | undefined;
    const rollup: Rollup = row ?? { n: 0, median: null, pct_with_conditions: null, buckets: null };
    return NextResponse.json({ rollup, lens }, { status: 200 });
  } catch {
    return NextResponse.json({ error: "Failed to load rollup" }, { status: 500 });
  }
}
