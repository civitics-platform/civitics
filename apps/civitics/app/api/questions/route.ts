import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";

export const dynamic = "force-dynamic";

// ─── GET /api/questions?official_id=&lens=&sort=&cursor=&limit= ───────────────
// Q&A lane read (C1 Wave D, FIX-537). Officials-only this wave (decision 2).
// Anon-allowed. Called via the caller's server client so get_entity_questions
// can surface the caller's `can_answer` grant flag (decision 9). Returns the RPC
// object: { can_answer, total, awaiting, questions[], nextCursor }. FIX-540: the
// RPC keysets in SQL; cursor/limit pass through opaquely (the cursor is minted
// per sort — callers reset it on sort change).
export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const officialId = sp.get("official_id");
    const lens = sp.get("lens") === "constituents" ? "constituents" : "all";
    const sortParam = sp.get("sort");
    const sort =
      sortParam === "newest" ? "newest" : sortParam === "unanswered" ? "unanswered" : "wanted";
    const cursor = sp.get("cursor");
    const limit = Math.min(100, Math.max(1, parseInt(sp.get("limit") ?? "", 10) || 50));

    if (!officialId) {
      return NextResponse.json({ error: "official_id is required" }, { status: 400 });
    }

    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);

    const { data, error } = await supabase.rpc("get_entity_questions", {
      p_official_id: officialId,
      p_lens: lens,
      p_sort: sort,
      p_limit: limit,
      p_cursor: cursor ?? undefined,
    });
    if (error) {
      return NextResponse.json({ error: "Failed to load questions" }, { status: 500 });
    }

    const result = (data as Record<string, unknown> | null) ?? {};
    return NextResponse.json({
      can_answer: result.can_answer === true,
      total: typeof result.total === "number" ? result.total : 0,
      awaiting: typeof result.awaiting === "number" ? result.awaiting : 0,
      questions: Array.isArray(result.questions) ? result.questions : [],
      nextCursor: typeof result.next_cursor === "string" ? result.next_cursor : null,
    });
  } catch {
    return NextResponse.json({ error: "Failed to load questions" }, { status: 500 });
  }
}
