import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient, createAdminClient } from "@civitics/db";
import { recordAbuseEvent } from "@/lib/abuse-events";

export const dynamic = "force-dynamic";

const VALID_CONTENT_TYPES = ["civic_comment", "official_community_comment"] as const;
const VALID_REASONS = [
  "spam",
  "harassment",
  "off_topic",
  "misinformation",
  "other",
] as const;

type ContentType = (typeof VALID_CONTENT_TYPES)[number];
type Reason = (typeof VALID_REASONS)[number];

// POST /api/moderation/flag
// Body: { content_type, content_id, reason, note? }
// Idempotent per (content_type, content_id, user_id).
export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = createServerClient(cookieStore);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to flag" }, { status: 401 });
  }

  let body: {
    content_type?: string;
    content_id?: string;
    reason?: string;
    note?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (
    !body.content_type ||
    !VALID_CONTENT_TYPES.includes(body.content_type as ContentType) ||
    !body.content_id ||
    !body.reason ||
    !VALID_REASONS.includes(body.reason as Reason)
  ) {
    return NextResponse.json(
      {
        error:
          "content_type (civic_comment|official_community_comment), content_id, and reason are required",
      },
      { status: 400 }
    );
  }

  if (body.note && body.note.length > 500) {
    return NextResponse.json({ error: "Note too long (max 500 chars)" }, { status: 400 });
  }

  // Use admin client because a user flagging another user's comment would
  // otherwise be blocked by RLS when reading back the row.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;

  const { data: existing } = await admin
    .from("content_flags")
    .select("id")
    .eq("content_type", body.content_type)
    .eq("content_id", body.content_id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ flagged: true });
  }

  const { error } = await admin.from("content_flags").insert({
    content_type: body.content_type,
    content_id:   body.content_id,
    user_id:      user.id,
    reason:       body.reason,
    note:         body.note ?? null,
  });

  if (error) {
    return NextResponse.json({ error: "Failed to flag" }, { status: 500 });
  }

  await recordAbuseEvent({
    action: "flag_create",
    headers: request.headers,
    userId: user.id,
    targetType: body.content_type,
    targetId: body.content_id,
    meta: { route: "moderation_flag" },
  });

  return NextResponse.json({ flagged: true });
}
