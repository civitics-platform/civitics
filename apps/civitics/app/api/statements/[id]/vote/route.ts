import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";
import { isStatementVote } from "@civitics/db";
import { mapRpcError } from "../../_lib";
import { recordAbuseEvent } from "@/lib/abuse-events";

export const dynamic = "force-dynamic";

// ─── PUT /api/statements/[id]/vote ────────────────────────────────────────────
// Upsert the caller's ballot. Body: { vote: -1 | 0 | 1 } (disagree / pass / agree).
// Voting is open to any authenticated user; the RPC returns the fresh vote_summary.
export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Sign in to vote", code: "not_authenticated" }, { status: 401 });
    }

    const json = (await request.json().catch(() => null)) as { vote?: unknown } | null;
    if (!json || !isStatementVote(json.vote)) {
      return NextResponse.json({ error: "vote must be -1, 0, or 1" }, { status: 400 });
    }

    const { data, error } = await supabase.rpc("set_statement_vote", {
      p_statement_id: params.id,
      p_vote: json.vote,
    });
    if (error) {
      if (error.code === "53400") {
        await recordAbuseEvent({
          action: "cap_hit",
          headers: request.headers,
          userId: user.id,
          targetType: "statement",
          targetId: params.id,
          meta: { route: "statements_vote", cap: "vote_daily" },
        });
      }
      return mapRpcError(error);
    }

    await recordAbuseEvent({
      action: "statement_vote",
      headers: request.headers,
      userId: user.id,
      targetType: "statement",
      targetId: params.id,
      meta: { route: "statements_vote" },
    });

    return NextResponse.json({ ok: true, vote: json.vote, vote_summary: data ?? {} });
  } catch {
    return NextResponse.json({ error: "Failed to record vote" }, { status: 500 });
  }
}
