import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient, createAdminClient } from "@civitics/db";

export const dynamic = "force-dynamic";

// @deprecated — thin adapter over the unified substrate (C0 / FIX-520). The old
// single-axis "vote" maps to comment_ratings.valuable (1 = "good argument").
// New surface: PUT /api/comments/[id]/rate. Toggle returns { voted, vote_count }.

async function valuableUp(admin: ReturnType<typeof createAdminClient>, id: string): Promise<number> {
  const { data } = await admin.from("entity_comments").select("rating_summary").eq("id", id).maybeSingle();
  const rs = data?.rating_summary;
  const obj = rs && typeof rs === "object" && !Array.isArray(rs) ? (rs as Record<string, unknown>) : {};
  return Number(obj["valuable_up"] ?? 0) || 0;
}

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string; argId: string } },
) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Sign in to vote" }, { status: 401 });

    const admin = createAdminClient();
    const { data: comment } = await admin
      .from("entity_comments")
      .select("id,entity_id,status")
      .eq("id", params.argId)
      .maybeSingle();
    if (!comment || comment.entity_id !== params.id) {
      return NextResponse.json({ error: "Argument not found" }, { status: 404 });
    }
    if (comment.status === "withdrawn") {
      return NextResponse.json({ error: "Cannot vote on a deleted argument" }, { status: 400 });
    }

    const { data: existing } = await admin
      .from("comment_ratings")
      .select("agree,valuable")
      .eq("comment_id", params.argId)
      .eq("rater_id", user.id)
      .maybeSingle();

    let voted: boolean;
    if (existing && existing.valuable === 1) {
      // Un-vote: clear the valuable axis, preserve agree.
      await admin
        .from("comment_ratings")
        .update({ valuable: 0, updated_at: new Date().toISOString() })
        .eq("comment_id", params.argId)
        .eq("rater_id", user.id);
      voted = false;
    } else {
      await admin.from("comment_ratings").upsert(
        {
          comment_id: params.argId,
          rater_id: user.id,
          agree: existing?.agree ?? 0,
          valuable: 1,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "comment_id,rater_id" },
      );
      voted = true;
    }

    return NextResponse.json({ voted, vote_count: await valuableUp(admin, params.argId) });
  } catch {
    return NextResponse.json({ error: "Failed to toggle vote" }, { status: 500 });
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string; argId: string } },
) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ voted: false });

    const admin = createAdminClient();
    const { data } = await admin
      .from("comment_ratings")
      .select("valuable")
      .eq("comment_id", params.argId)
      .eq("rater_id", user.id)
      .maybeSingle();
    return NextResponse.json({ voted: data?.valuable === 1 });
  } catch {
    return NextResponse.json({ voted: false });
  }
}
