import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";

export const dynamic = "force-dynamic";

// GET /api/notifications            → recent notifications for the current user (default 30)
// GET /api/notifications?unread=1   → only unread
// Response: { notifications: [...], unread_count }
export async function GET(request: NextRequest) {
  const cookieStore = await cookies();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createServerClient(cookieStore) as any;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in" }, { status: 401 });
  }

  const unreadOnly = request.nextUrl.searchParams.get("unread") === "1";
  const limit = Math.min(
    parseInt(request.nextUrl.searchParams.get("limit") ?? "30", 10) || 30,
    100
  );

  let query = supabase
    .from("notifications")
    .select("id, event_type, entity_type, entity_id, title, body, link, is_read, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (unreadOnly) query = query.eq("is_read", false);

  const { data } = await query;

  const { count: unreadCount } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("is_read", false);

  return NextResponse.json({
    notifications: data ?? [],
    unread_count: unreadCount ?? 0,
  });
}

// POST /api/notifications
// Body: { mark_all_read?: boolean, ids?: string[] }
// Marks the given notifications (or all) as read for the current user.
export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createServerClient(cookieStore) as any;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in" }, { status: 401 });
  }

  let body: { mark_all_read?: boolean; ids?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.mark_all_read) {
    const { error } = await supabase
      .from("notifications")
      .update({ is_read: true })
      .eq("user_id", user.id)
      .eq("is_read", false);
    if (error) {
      return NextResponse.json({ error: "Failed to mark read" }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  // .in() bounded by the client's batch size, not by data growth — and unlike
  // the read sites, a 414 here is NOT silent: the error is checked and returned
  // as a 500, so an oversized batch fails loudly instead of no-op'ing — FIX-902
  if (Array.isArray(body.ids) && body.ids.length > 0) {
    const { error } = await supabase
      .from("notifications")
      .update({ is_read: true })
      .eq("user_id", user.id)
      .in("id", body.ids);
    if (error) {
      return NextResponse.json({ error: "Failed to mark read" }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json(
    { error: "Provide mark_all_read:true or ids:[...]" },
    { status: 400 }
  );
}
