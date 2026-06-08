import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@civitics/db";
import { isEntityCommentType } from "@civitics/db";

// C1 Wave B (FIX-528): proportional-representation highlights surface backing
// CommentHighlightsStrip (decision 5). Thin wrapper over the
// get_entity_comment_highlights RPC (anon-granted, SECURITY DEFINER with the
// visible-status filter baked in) — mirrors the /api/positions/rollup
// convention of fronting an aggregate RPC with a route. Pure read; no auth.
export const dynamic = "force-dynamic";

// ─── GET /api/comments/highlights?entity_type=&entity_id=&lens= ───────────────
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

    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin as any).rpc("get_entity_comment_highlights", {
      p_entity_type: entityType,
      p_entity_id: entityId,
      p_lens: lens,
    });

    if (error) {
      return NextResponse.json({ error: "Failed to load highlights" }, { status: 500 });
    }

    // data is the jsonb object { common_ground: [...], steelman: {...} }.
    return NextResponse.json({
      highlights: data ?? { common_ground: [], steelman: { support: null, oppose: null, conditional: null } },
    });
  } catch {
    return NextResponse.json({ error: "Failed to load highlights" }, { status: 500 });
  }
}
