import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@civitics/db";
import { isEntityCommentType } from "@civitics/db";
import { fetchAuthorMeta } from "../_lib";

// C1 Wave B (FIX-528): dedicated lightweight endpoint backing the debate-map
// scatter (decision 7). The scatter needs the whole scored set at once, so it
// gets its own endpoint rather than overloading the keyset-paginated list.
// Pure read; anon may view the map (no auth).
export const dynamic = "force-dynamic";

const MAP_CAP = 500;

// Columns the scatter needs — lighter than the full comment payload.
const MAP_COLUMNS =
  "id,stance,kind,body,bridge_score,map_x,map_y,rating_summary,status,constituent_jurisdiction_id,author_id";

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Rating-signal volume — used ONLY for dot size on the scatter. total_raters is
// not denormalized, so this sums the rating_summary counters as a monotonic
// engagement proxy (over-counts raters who set both axes; harmless for sizing).
function ratingVolume(raw: unknown): number {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return num(o.agree_up) + num(o.agree_down) + num(o.valuable_up) + num(o.valuable_down);
}

// ─── GET /api/comments/map?entity_type=&entity_id=&lens= ──────────────────────
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

    let query = admin
      .from("entity_comments")
      .select(MAP_COLUMNS)
      .eq("entity_type", entityType)
      .eq("entity_id", entityId)
      .in("status", ["visible", "needs_review"])
      .not("map_x", "is", null)
      .not("map_y", "is", null);

    if (lens === "constituents") {
      query = query.not("constituent_jurisdiction_id", "is", null);
    }

    const { data, error } = await query
      .order("bridge_score", { ascending: false, nullsFirst: false })
      .limit(MAP_CAP);

    if (error) {
      return NextResponse.json({ error: "Failed to load map" }, { status: 500 });
    }

    // SF-P2 (FIX-599): resolve author is_synthetic for the per-utterance mark.
    // Throw on error rather than silently dropping labels (the dangerous way).
    const rows = (data ?? []) as Array<{ author_id: string | null }>;
    const meta = await fetchAuthorMeta(
      admin as never,
      rows.map((c) => c.author_id).filter((x): x is string => !!x),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const points = (data ?? []).map((c: any) => ({
      id: c.id,
      map_x: num(c.map_x),
      map_y: num(c.map_y),
      bridge_score: num(c.bridge_score),
      stance: c.stance ?? null,
      kind: c.kind,
      n: ratingVolume(c.rating_summary),
      author_is_synthetic: c.author_id ? (meta.get(c.author_id)?.isSynthetic ?? false) : false,
      snippet:
        typeof c.body === "string" && c.body.length > 120
          ? `${c.body.slice(0, 120)}…`
          : c.body,
    }));

    return NextResponse.json({ points });
  } catch {
    return NextResponse.json({ error: "Failed to load map" }, { status: 500 });
  }
}
