import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
import { createServerClient, createAdminClient } from "@civitics/db";

export const dynamic = "force-dynamic";

// @deprecated — thin read/write adapter over the unified entity_comments
// substrate (C0 / FIX-520). New surface: POST/GET /api/comments. Kept for
// back-compat with the old { comments: [{ id, body, upvotes, user_id, ... }] }
// shape; the legacy civic_comments table is frozen (read-only).

type OldComment = {
  id: string;
  body: string;
  created_at: string;
  upvotes: number;
  user_id: string;
  is_deleted: boolean;
};

function toOld(row: {
  id: string;
  body: string;
  created_at: string;
  author_id: string;
  status: string;
  rating_summary: unknown;
}): OldComment {
  const s = row.rating_summary ?? {};
  const num = (k: string) => Number((s as Record<string, unknown>)[k] ?? 0) || 0;
  return {
    id: row.id,
    body: row.body,
    created_at: row.created_at,
    upvotes: num("legacy_upvotes") + num("valuable_up") - num("valuable_down"),
    user_id: row.author_id,
    is_deleted: row.status === "withdrawn",
  };
}

export async function GET(_request: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("entity_comments")
      .select("id,body,created_at,author_id,status,rating_summary")
      .eq("entity_type", "proposal")
      .eq("entity_id", params.id)
      .is("parent_id", null)
      .in("status", ["visible", "needs_review"])
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) return NextResponse.json({ error: "Failed to fetch comments" }, { status: 500 });
    return NextResponse.json({ comments: (data ?? []).map(toOld) });
  } catch {
    return NextResponse.json({ error: "Failed to fetch comments" }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Sign in to comment" }, { status: 401 });

    const { text } = await request.json();
    if (!text || typeof text !== "string") {
      return NextResponse.json({ error: "Text is required" }, { status: 400 });
    }
    if (text.trim().length < 10) {
      return NextResponse.json({ error: "Comment must be at least 10 characters" }, { status: 400 });
    }
    if (text.length > 2000) {
      return NextResponse.json({ error: "Comment must be less than 2000 characters" }, { status: 400 });
    }

    const admin = createAdminClient();
    const id = randomUUID();
    const { data, error } = await admin
      .from("entity_comments")
      .insert({
        id,
        entity_type: "proposal",
        entity_id: params.id,
        thread_root_id: id,
        author_id: user.id,
        kind: "discussion",
        body: text.trim(),
      })
      .select("id,body,created_at,author_id,status,rating_summary")
      .single();
    if (error || !data) return NextResponse.json({ error: "Failed to create comment" }, { status: 500 });
    return NextResponse.json({ comment: toOld(data) }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Failed to create comment" }, { status: 500 });
  }
}
