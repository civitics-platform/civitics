import { NextRequest, NextResponse } from "next/server";
import { createPublicClient } from "@civitics/db";
import { stripViewerKeys } from "@/lib/public-payload";
import { withPublicCdnCache } from "@/lib/cdn-cache";

export const dynamic = "force-dynamic";

// The entity_types the Q&A lane supports (mirrors the QASection QAEntityType).
// All accept kind='question'. official/institution/jurisdiction can hold an
// answerer grant (an official answer); 'proposal' (Q&A v2 PR-2a, FIX-628) is
// community-only — no official answerer exists for a bill, so can_answer is
// always false there and notes ARE the answer path.
const QA_ENTITY_TYPES = new Set(["official", "institution", "jurisdiction", "proposal"]);

// ─── GET /api/questions?entity_type=&entity_id=&lens=&sort=&cursor=&limit= ────
// Q&A lane read (C1 Wave D, FIX-537; generalized FIX-610 to official | institution
// | jurisdiction). Anon-allowed.
// PUBLIC, CDN-CACHED (FIX-788; header handler-owned since FIX-796 — the config
// catch-all is gone, withPublicCdnCache stamps the GET 200 below and nothing
// else). The response is held in the shared edge cache and served cross-user,
// so it must contain ZERO viewer-dependent fields — a personalized field here
// is the FIX-786/787 cross-user cache leak. Two layers enforce that:
//   1. the RPC runs on createPublicClient (no cookies → auth.uid() NULL →
//      can_answer is false for every caller), and
//   2. the response omits can_answer and passes through stripViewerKeys()
//      (public-payload.test.ts pins this).
// The caller's grant flag hydrates client-side from the no-store
// /api/viewer/engagement overlay. Never re-add a personalized field here — put
// it in the overlay instead.
// Returns { total, awaiting, questions[], nextCursor }. FIX-540: the RPC keysets
// in SQL; cursor/limit pass through opaquely (the cursor is minted per sort —
// callers reset it on sort change).
export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    // FIX-610: entity_type + entity_id. (Back-compat: a bare official_id is read
    // as an official entity_id so any cached officials caller keeps working.)
    const entityType = sp.get("entity_type") ?? (sp.get("official_id") ? "official" : null);
    const entityId = sp.get("entity_id") ?? sp.get("official_id");
    const lens = sp.get("lens") === "constituents" ? "constituents" : "all";
    const sortParam = sp.get("sort");
    const sort =
      sortParam === "newest" ? "newest" : sortParam === "unanswered" ? "unanswered" : "wanted";
    const cursor = sp.get("cursor");
    const limit = Math.min(100, Math.max(1, parseInt(sp.get("limit") ?? "", 10) || 50));

    if (!entityId) {
      return NextResponse.json({ error: "entity_id is required" }, { status: 400 });
    }
    if (!entityType || !QA_ENTITY_TYPES.has(entityType)) {
      return NextResponse.json({ error: "Invalid entity_type" }, { status: 400 });
    }

    const supabase = createPublicClient();

    const { data, error } = await supabase.rpc("get_entity_questions", {
      p_entity_type: entityType,
      p_entity_id: entityId,
      p_lens: lens,
      p_sort: sort,
      p_limit: limit,
      p_cursor: cursor ?? undefined,
    });
    if (error) {
      return NextResponse.json({ error: "Failed to load questions" }, { status: 500 });
    }

    const result = (data as Record<string, unknown> | null) ?? {};
    return withPublicCdnCache(
      NextResponse.json(
        stripViewerKeys({
          total: typeof result.total === "number" ? result.total : 0,
          awaiting: typeof result.awaiting === "number" ? result.awaiting : 0,
          questions: Array.isArray(result.questions) ? result.questions : [],
          nextCursor: typeof result.next_cursor === "string" ? result.next_cursor : null,
        }),
      ),
    );
  } catch {
    return NextResponse.json({ error: "Failed to load questions" }, { status: 500 });
  }
}
