import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";

export const dynamic = "force-dynamic";

type EntityType = "official" | "agency" | "jurisdiction";

function isValidType(t: string | null): t is EntityType {
  return t === "official" || t === "agency" || t === "jurisdiction";
}

// GET /api/follows                         → list current user's follows
// GET /api/follows?entity_type=X&entity_id=Y → { following: boolean, email_enabled: boolean }
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

  const entityType = request.nextUrl.searchParams.get("entity_type");
  const entityId = request.nextUrl.searchParams.get("entity_id");

  if (entityType && entityId) {
    if (!isValidType(entityType)) {
      return NextResponse.json({ error: "Invalid entity_type" }, { status: 400 });
    }
    const { data } = await supabase
      .from("user_follows")
      .select("id, email_enabled")
      .eq("user_id", user.id)
      .eq("entity_type", entityType)
      .eq("entity_id", entityId)
      .maybeSingle();

    return NextResponse.json({
      following: !!data,
      email_enabled: data?.email_enabled ?? false,
    });
  }

  const { data } = await supabase
    .from("user_follows")
    .select("id, entity_type, entity_id, email_enabled, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  return NextResponse.json({ follows: data ?? [] });
}

// POST /api/follows
// Body: { entity_type, entity_id, email_enabled? }
export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createServerClient(cookieStore) as any;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to follow" }, { status: 401 });
  }

  let body: { entity_type?: string; entity_id?: string; email_enabled?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.entity_type || !isValidType(body.entity_type) || !body.entity_id) {
    return NextResponse.json(
      { error: "entity_type (official|agency|jurisdiction) and entity_id are required" },
      { status: 400 }
    );
  }

  // Idempotent upsert — user-scoped RLS means no need for admin client
  const { data, error } = await supabase
    .from("user_follows")
    .upsert(
      {
        user_id:       user.id,
        entity_type:   body.entity_type,
        entity_id:     body.entity_id,
        email_enabled: body.email_enabled ?? true,
      },
      { onConflict: "user_id,entity_type,entity_id" }
    )
    .select("id, email_enabled")
    .single();

  if (error) {
    return NextResponse.json({ error: "Failed to follow" }, { status: 500 });
  }

  return NextResponse.json({ following: true, ...data });
}

// DELETE /api/follows?entity_type=X&entity_id=Y
export async function DELETE(request: NextRequest) {
  const cookieStore = await cookies();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createServerClient(cookieStore) as any;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in" }, { status: 401 });
  }

  const entityType = request.nextUrl.searchParams.get("entity_type");
  const entityId = request.nextUrl.searchParams.get("entity_id");
  if (!isValidType(entityType) || !entityId) {
    return NextResponse.json(
      { error: "entity_type and entity_id required" },
      { status: 400 }
    );
  }

  const { error } = await supabase
    .from("user_follows")
    .delete()
    .eq("user_id", user.id)
    .eq("entity_type", entityType)
    .eq("entity_id", entityId);

  if (error) {
    return NextResponse.json({ error: "Failed to unfollow" }, { status: 500 });
  }

  return NextResponse.json({ following: false });
}
