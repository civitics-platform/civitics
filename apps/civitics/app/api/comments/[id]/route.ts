import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient, createAdminClient } from "@civitics/db";
import { BODY_MIN, BODY_MAX, EDIT_WINDOW_MINUTES } from "@civitics/db";
import { COMMENT_COLUMNS, fetchAuthorMeta, serialize } from "../_lib";

export const dynamic = "force-dynamic";

// ─── PATCH /api/comments/[id] ─────────────────────────────────────────────────
// Author-only: edit body (within EDIT_WINDOW_MINUTES of creation) or withdraw.
// Body: { action: "withdraw" } | { body: string }
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Sign in to edit" }, { status: 401 });

    const json = await request.json().catch(() => null);
    if (!json) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });

    const admin = createAdminClient();
    const { data: existing } = await admin
      .from("entity_comments")
      .select("id,author_id,created_at,status")
      .eq("id", params.id)
      .maybeSingle();

    if (!existing) return NextResponse.json({ error: "Comment not found" }, { status: 404 });
    if (existing.author_id !== user.id) {
      return NextResponse.json({ error: "Not your comment" }, { status: 403 });
    }

    // Withdraw (status flip) — always allowed for the author.
    if ((json as { action?: string }).action === "withdraw") {
      const { error } = await admin
        .from("entity_comments")
        .update({ status: "withdrawn" })
        .eq("id", params.id);
      if (error) return NextResponse.json({ error: "Failed to withdraw" }, { status: 500 });
      return NextResponse.json({ ok: true, status: "withdrawn" });
    }

    // Edit body — only within the edit window.
    const newBody = (json as { body?: unknown }).body;
    if (typeof newBody !== "string") {
      return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
    }
    if (newBody.trim().length < BODY_MIN || newBody.trim().length > BODY_MAX) {
      return NextResponse.json(
        { error: `Comment must be between ${BODY_MIN} and ${BODY_MAX} characters` },
        { status: 400 },
      );
    }
    const ageMin = (Date.now() - new Date(existing.created_at).getTime()) / 60000;
    if (ageMin > EDIT_WINDOW_MINUTES) {
      return NextResponse.json(
        { error: `Edits are only allowed within ${EDIT_WINDOW_MINUTES} minutes of posting` },
        { status: 403 },
      );
    }

    const { data: updated, error } = await admin
      .from("entity_comments")
      .update({ body: newBody.trim() })
      .eq("id", params.id)
      .select(COMMENT_COLUMNS)
      .single();
    if (error || !updated) return NextResponse.json({ error: "Failed to update" }, { status: 500 });

    const names = await fetchAuthorMeta(admin, [updated.author_id]);
    return NextResponse.json({ comment: serialize(updated, names) });
  } catch {
    return NextResponse.json({ error: "Failed to update comment" }, { status: 500 });
  }
}
