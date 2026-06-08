import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
import { createServerClient, createAdminClient } from "@civitics/db";
import { ALLOWED_KINDS, DEFAULT_KIND } from "@civitics/db";

export const dynamic = "force-dynamic";

// @deprecated — thin adapter over the unified entity_comments substrate
// (C0 / FIX-520). New surface: /api/comments. Initiatives are proposals, so
// arguments are entity_comments rows with entity_type='proposal'. comment_type
// <-> kind, side <-> stance, the old single-axis vote <-> comment_ratings.valuable.
// The legacy civic_initiative_arguments table is frozen (read-only).

function kindToCommentType(kind: string): string | null {
  return kind === DEFAULT_KIND ? null : kind;
}
function stanceToSide(stance: string | null): "for" | "against" | null {
  return stance === "support" ? "for" : stance === "oppose" ? "against" : null;
}
function sideToStance(side: unknown, commentType: unknown): string | null {
  if (side === "for") return "support";
  if (side === "against") return "oppose";
  if (commentType === "support") return "support";
  if (commentType === "oppose") return "oppose";
  return null;
}
function ratingValuableUp(rs: unknown): number {
  const obj = rs && typeof rs === "object" && !Array.isArray(rs) ? (rs as Record<string, unknown>) : {};
  return Number(obj["valuable_up"] ?? 0) || 0;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  try {
    const admin = createAdminClient();
    const { data: rows, error } = await admin
      .from("entity_comments")
      .select("id,entity_id,parent_id,kind,stance,body,author_id,status,rating_summary,created_at,updated_at")
      .eq("entity_type", "proposal")
      .eq("entity_id", params.id)
      .in("status", ["visible", "needs_review", "withdrawn"])
      .order("created_at", { ascending: true });
    if (error) return NextResponse.json({ error: "Failed to fetch arguments" }, { status: 500 });

    type Tree = {
      id: string;
      initiative_id: string;
      parent_id: string | null;
      side: "for" | "against" | null;
      comment_type: string | null;
      body: string;
      author_id: string | null;
      is_deleted: boolean;
      flag_count: number;
      created_at: string;
      updated_at: string;
      vote_count: number;
      replies: Tree[];
    };

    const nodes: Record<string, Tree> = {};
    for (const r of rows ?? []) {
      const deleted = r.status === "withdrawn";
      nodes[r.id] = {
        id: r.id,
        initiative_id: r.entity_id,
        parent_id: r.parent_id,
        side: stanceToSide(r.stance),
        comment_type: kindToCommentType(r.kind),
        body: deleted ? "[deleted]" : r.body,
        author_id: r.author_id,
        is_deleted: deleted,
        flag_count: 0,
        created_at: r.created_at,
        updated_at: r.updated_at,
        vote_count: ratingValuableUp(r.rating_summary),
        replies: [],
      };
    }
    const roots: Tree[] = [];
    for (const node of Object.values(nodes)) {
      if (node.parent_id && nodes[node.parent_id]) nodes[node.parent_id]!.replies.push(node);
      else roots.push(node);
    }
    roots.sort(
      (a, b) =>
        b.vote_count - a.vote_count ||
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    return NextResponse.json({ comments: roots, total: roots.length });
  } catch {
    return NextResponse.json({ error: "Failed to fetch arguments" }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Sign in to submit an argument" }, { status: 401 });

    const { data: initiative } = await supabase
      .from("initiative_details")
      .select("proposal_id,stage")
      .eq("proposal_id", params.id)
      .maybeSingle();
    if (!initiative) return NextResponse.json({ error: "Initiative not found" }, { status: 404 });
    if (!["problem", "deliberate", "mobilise"].includes(initiative.stage)) {
      return NextResponse.json(
        { error: "Arguments can only be submitted during problem identification, deliberation, or mobilisation." },
        { status: 400 },
      );
    }

    const { side, body: argBody, parent_id, comment_type } = await request.json();
    if (!argBody || typeof argBody !== "string") {
      return NextResponse.json({ error: "Argument body is required" }, { status: 400 });
    }
    if (argBody.trim().length < 10) {
      return NextResponse.json({ error: "Argument must be at least 10 characters" }, { status: 400 });
    }
    if (argBody.trim().length > 2000) {
      return NextResponse.json({ error: "Argument must be 2000 characters or fewer" }, { status: 400 });
    }

    const kind = typeof comment_type === "string" && comment_type ? comment_type : DEFAULT_KIND;
    if (!ALLOWED_KINDS.proposal.includes(kind)) {
      return NextResponse.json({ error: `Invalid comment_type '${kind}'` }, { status: 400 });
    }
    const stance = sideToStance(side, comment_type);

    const admin = createAdminClient();

    let threadRootId = "";
    if (parent_id) {
      const { data: parent } = await admin
        .from("entity_comments")
        .select("id,entity_id,thread_root_id")
        .eq("id", parent_id)
        .maybeSingle();
      if (!parent || parent.entity_id !== params.id) {
        return NextResponse.json({ error: "Parent argument not found" }, { status: 400 });
      }
      threadRootId = parent.thread_root_id ?? parent.id;
    }

    const id = randomUUID();
    if (!threadRootId) threadRootId = id;

    const { data: inserted, error: insertErr } = await admin
      .from("entity_comments")
      .insert({
        id,
        entity_type: "proposal",
        entity_id: params.id,
        parent_id: parent_id ?? null,
        thread_root_id: threadRootId,
        author_id: user.id,
        kind,
        stance,
        body: argBody.trim(),
      })
      .select("id,parent_id,kind,stance,body,created_at")
      .single();
    if (insertErr || !inserted) {
      return NextResponse.json({ error: "Failed to submit argument" }, { status: 500 });
    }

    return NextResponse.json(
      {
        comment: {
          id: inserted.id,
          side: stanceToSide(inserted.stance),
          comment_type: kindToCommentType(inserted.kind),
          body: inserted.body,
          parent_id: inserted.parent_id,
          created_at: inserted.created_at,
        },
      },
      { status: 201 },
    );
  } catch {
    return NextResponse.json({ error: "Failed to submit argument" }, { status: 500 });
  }
}
