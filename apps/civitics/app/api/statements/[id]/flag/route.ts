import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient, createAdminClient } from "@civitics/db";
import { FLAG_REASONS, RATE_LIMITS, type FlagReason } from "@civitics/db";
import { isRateLimited } from "../../../comments/_lib";

export const dynamic = "force-dynamic";

// ─── POST /api/statements/[id]/flag ───────────────────────────────────────────
// Body: { reason, note? } → content_flags(content_type='entity_statement').
// Idempotent (unique content_type+content_id+user_id). The statement flag-autotrip
// trigger collapses the statement to needs_review at >= 3 unresolved flags
// (decision 9, reuses the C0 machinery). Mirrors the comment flag route.
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Sign in to flag" }, { status: 401 });

    const json = (await request.json().catch(() => null)) as
      | { reason?: unknown; note?: unknown }
      | null;
    if (!json) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });

    const reason = json.reason;
    if (typeof reason !== "string" || !(FLAG_REASONS as readonly string[]).includes(reason)) {
      return NextResponse.json({ error: "Invalid reason" }, { status: 400 });
    }
    const note = typeof json.note === "string" ? json.note.trim().slice(0, 500) : null;

    const admin = createAdminClient();

    const { data: statement } = await admin
      .from("entity_statements")
      .select("id,author_id")
      .eq("id", params.id)
      .maybeSingle();
    if (!statement) return NextResponse.json({ error: "Statement not found" }, { status: 404 });
    if (statement.author_id === user.id) {
      return NextResponse.json({ error: "You can't flag your own statement" }, { status: 400 });
    }

    if (await isRateLimited(admin, "content_flags", "user_id", user.id, RATE_LIMITS.flags, {
      content_type: "entity_statement",
    })) {
      return NextResponse.json({ error: `Daily flag limit reached (${RATE_LIMITS.flags}).` }, { status: 429 });
    }

    const { error } = await admin.from("content_flags").insert({
      content_type: "entity_statement",
      content_id: params.id,
      user_id: user.id,
      reason: reason as FlagReason,
      note: note || null,
    });
    // 23505 = duplicate flag from this user; treat as success (already flagged).
    if (error && error.code !== "23505") {
      return NextResponse.json({ error: "Failed to flag" }, { status: 500 });
    }

    return NextResponse.json({ flagged: true });
  } catch {
    return NextResponse.json({ error: "Failed to flag statement" }, { status: 500 });
  }
}
