import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";

export const dynamic = "force-dynamic";

// ─── GET /api/questions?official_id=&lens=&sort= ──────────────────────────────
// Q&A lane read (C1 Wave D, FIX-537). Officials-only this wave (decision 2).
// Anon-allowed. Called via the caller's server client so get_entity_questions
// can surface the caller's `can_answer` grant flag (decision 9). Returns the RPC
// object verbatim: { can_answer, total, awaiting, questions[] }.
export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const officialId = sp.get("official_id");
    const lens = sp.get("lens") === "constituents" ? "constituents" : "all";
    const sortParam = sp.get("sort");
    const sort =
      sortParam === "newest" ? "newest" : sortParam === "unanswered" ? "unanswered" : "wanted";

    if (!officialId) {
      return NextResponse.json({ error: "official_id is required" }, { status: 400 });
    }

    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);

    const { data, error } = await supabase.rpc("get_entity_questions", {
      p_official_id: officialId,
      p_lens: lens,
      p_sort: sort,
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
    });
  } catch {
    return NextResponse.json({ error: "Failed to load questions" }, { status: 500 });
  }
}
