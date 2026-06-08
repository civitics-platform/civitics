import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient, createAdminClient } from "@civitics/db";
import { RATE_LIMITS } from "@civitics/db";
import { isRateLimited } from "../../_lib";

export const dynamic = "force-dynamic";

function validAxis(v: unknown): v is -1 | 0 | 1 {
  return v === -1 || v === 0 || v === 1;
}

// ─── PUT /api/comments/[id]/rate ──────────────────────────────────────────────
// Upsert the caller's two-axis rating. Body: { agree?: -1|0|1, valuable?: -1|0|1 }
export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Sign in to rate" }, { status: 401 });

    const json = (await request.json().catch(() => null)) as
      | { agree?: unknown; valuable?: unknown }
      | null;
    if (!json) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });

    const hasAgree = json.agree !== undefined;
    const hasValuable = json.valuable !== undefined;
    if (!hasAgree && !hasValuable) {
      return NextResponse.json({ error: "Provide agree and/or valuable" }, { status: 400 });
    }
    if (hasAgree && !validAxis(json.agree)) {
      return NextResponse.json({ error: "agree must be -1, 0, or 1" }, { status: 400 });
    }
    if (hasValuable && !validAxis(json.valuable)) {
      return NextResponse.json({ error: "valuable must be -1, 0, or 1" }, { status: 400 });
    }

    const admin = createAdminClient();

    // Target must exist and be publicly visible.
    const { data: comment } = await admin
      .from("entity_comments")
      .select("id,status")
      .eq("id", params.id)
      .maybeSingle();
    if (!comment || !["visible", "needs_review"].includes(comment.status)) {
      return NextResponse.json({ error: "Comment not found" }, { status: 404 });
    }

    if (await isRateLimited(admin, "comment_ratings", "rater_id", user.id, RATE_LIMITS.ratings)) {
      return NextResponse.json(
        { error: `Daily rating limit reached (${RATE_LIMITS.ratings}).` },
        { status: 429 },
      );
    }

    // Merge with any existing rating so a single-axis update doesn't clobber the other.
    const { data: prior } = await admin
      .from("comment_ratings")
      .select("agree,valuable")
      .eq("comment_id", params.id)
      .eq("rater_id", user.id)
      .maybeSingle();

    const agree = hasAgree ? (json.agree as number) : prior?.agree ?? 0;
    const valuable = hasValuable ? (json.valuable as number) : prior?.valuable ?? 0;

    const { error } = await admin
      .from("comment_ratings")
      .upsert(
        { comment_id: params.id, rater_id: user.id, agree, valuable, updated_at: new Date().toISOString() },
        { onConflict: "comment_id,rater_id" },
      );
    if (error) return NextResponse.json({ error: "Failed to rate" }, { status: 500 });

    // Trigger has recomputed rating_summary; return it.
    const { data: fresh } = await admin
      .from("entity_comments")
      .select("rating_summary")
      .eq("id", params.id)
      .maybeSingle();

    return NextResponse.json({ ok: true, agree, valuable, rating_summary: fresh?.rating_summary ?? {} });
  } catch {
    return NextResponse.json({ error: "Failed to rate comment" }, { status: 500 });
  }
}
