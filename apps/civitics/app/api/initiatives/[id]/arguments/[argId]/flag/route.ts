import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient, createAdminClient } from "@civitics/db";
import { type FlagReason } from "@civitics/db";

export const dynamic = "force-dynamic";

// @deprecated — thin adapter over the unified substrate (C0 / FIX-520). Argument
// flags map to content_flags(content_type='entity_comment'). New surface:
// POST /api/comments/[id]/flag. Body: { flag_type }.

const VALID_FLAG_TYPES = ["off_topic", "misleading", "duplicate", "other"] as const;

// argument_flag -> flag_reason (matches the migration backfill mapping).
function reasonFor(flagType: string): { reason: FlagReason; note: string | null } {
  switch (flagType) {
    case "off_topic":
      return { reason: "off_topic", note: null };
    case "misleading":
      return { reason: "misinformation", note: null };
    case "duplicate":
      return { reason: "other", note: "duplicate" };
    default:
      return { reason: "other", note: null };
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string; argId: string } },
) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Sign in to flag an argument" }, { status: 401 });

    const admin = createAdminClient();
    const { data: comment } = await admin
      .from("entity_comments")
      .select("id,entity_id,author_id")
      .eq("id", params.argId)
      .maybeSingle();
    if (!comment || comment.entity_id !== params.id) {
      return NextResponse.json({ error: "Argument not found" }, { status: 404 });
    }
    if (comment.author_id === user.id) {
      return NextResponse.json({ error: "Cannot flag your own argument" }, { status: 400 });
    }

    const { flag_type } = await request.json();
    if (!flag_type || !VALID_FLAG_TYPES.includes(flag_type as (typeof VALID_FLAG_TYPES)[number])) {
      return NextResponse.json(
        { error: "flag_type must be one of: off_topic, misleading, duplicate, other" },
        { status: 400 },
      );
    }

    const { reason, note } = reasonFor(flag_type);
    const { error } = await admin.from("content_flags").insert({
      content_type: "entity_comment",
      content_id: params.argId,
      user_id: user.id,
      reason,
      note,
    });
    // 23505 = already flagged by this user; idempotent success.
    if (error && error.code !== "23505") {
      return NextResponse.json({ error: "Failed to submit flag" }, { status: 500 });
    }
    return NextResponse.json({ flagged: true });
  } catch {
    return NextResponse.json({ error: "Failed to submit flag" }, { status: 500 });
  }
}
