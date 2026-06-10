import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient, createAdminClient } from "@civitics/db";
import {
  DEFAULT_KIND,
  isEntityCommentType,
  type EntityCommentType,
} from "@civitics/db";
import {
  COMMENT_COLUMNS,
  fetchNameMap,
  serialize,
  nestReplies,
  topScore,
  type CommentPayload,
} from "./_lib";
import { getSlowMode } from "@/lib/slow-mode";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const TOP_CAP = 200; // C0: "top" sort ranks the most-recent TOP_CAP roots (cheap at current scale).

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`).toString("base64url");
}
function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const [createdAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    if (!createdAt || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

// ─── GET /api/comments?entity_type=&entity_id=&lens=&sort=&cursor=&limit= ──────
export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const entityType = sp.get("entity_type");
    const entityId = sp.get("entity_id");
    const lens = sp.get("lens") === "constituents" ? "constituents" : "all";
    // C1 Wave B (FIX-528): default sort is now `bridge` (bridge_score DESC NULLS
    // LAST). `newest` (keyset-paginated) and `top` remain as explicit options.
    const sortParam = sp.get("sort");
    const sort = sortParam === "newest" ? "newest" : sortParam === "top" ? "top" : "bridge";
    const cursor = sp.get("cursor");
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(sp.get("limit") ?? "", 10) || DEFAULT_LIMIT));

    if (!entityType || !isEntityCommentType(entityType)) {
      return NextResponse.json({ error: "Invalid entity_type" }, { status: 400 });
    }
    if (!entityId) {
      return NextResponse.json({ error: "entity_id is required" }, { status: 400 });
    }

    const admin = createAdminClient();

    // ── Root comments (parent_id IS NULL) ──
    // C1 Wave D (FIX-537, decision 8): the discussion list EXCLUDES the Q&A
    // kinds — questions/answers live only in the Q&A lane read
    // (get_entity_questions). Excluding question roots here also means their
    // answer replies are never fetched as descendants below.
    let rootsQuery = admin
      .from("entity_comments")
      .select(COMMENT_COLUMNS)
      .eq("entity_type", entityType)
      .eq("entity_id", entityId)
      .is("parent_id", null)
      .not("kind", "in", "(question,answer)")
      .in("status", ["visible", "needs_review"]);

    if (lens === "constituents") {
      rootsQuery = rootsQuery.not("constituent_jurisdiction_id", "is", null);
    }

    let roots: any[];
    let nextCursor: string | null = null;

    if (sort === "bridge") {
      // Real ordered query: bridge_score DESC NULLS LAST, then recency. Single
      // page (no keyset) — the representation floor lives in the highlights
      // strip, so the list stays a simple ordered page (decision 6).
      const { data, error } = await rootsQuery
        .order("bridge_score", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(limit);
      if (error) return NextResponse.json({ error: "Failed to load comments" }, { status: 500 });
      roots = data ?? [];
    } else if (sort === "top") {
      const { data, error } = await rootsQuery
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(TOP_CAP);
      if (error) return NextResponse.json({ error: "Failed to load comments" }, { status: 500 });
      roots = (data ?? [])
        .sort(
          (a, b) =>
            topScore(b.rating_summary) - topScore(a.rating_summary) ||
            b.created_at.localeCompare(a.created_at),
        )
        .slice(0, limit);
    } else {
      // newest — keyset on (created_at DESC, id DESC)
      if (cursor) {
        const c = decodeCursor(cursor);
        if (c) {
          rootsQuery = rootsQuery.or(
            `created_at.lt.${c.createdAt},and(created_at.eq.${c.createdAt},id.lt.${c.id})`,
          );
        }
      }
      const { data, error } = await rootsQuery
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(limit);
      if (error) return NextResponse.json({ error: "Failed to load comments" }, { status: 500 });
      roots = data ?? [];
      if (roots.length === limit) {
        const last = roots[roots.length - 1];
        nextCursor = encodeCursor(last.created_at, last.id);
      }
    }

    // ── Descendants of the returned roots (depth-bounded threads) ──
    const rootIds = roots.map((r) => r.id);
    let descendants: any[] = [];
    if (rootIds.length > 0) {
      const { data: desc } = await admin
        .from("entity_comments")
        .select(COMMENT_COLUMNS)
        .in("thread_root_id", rootIds)
        .not("parent_id", "is", null)
        .not("kind", "in", "(question,answer)")
        .in("status", ["visible", "needs_review"]);
      descendants = desc ?? [];
    }

    const names = await fetchNameMap(admin, [
      ...roots.map((r) => r.author_id),
      ...descendants.map((d) => d.author_id),
    ]);

    const rootPayloads: CommentPayload[] = roots.map((r) => serialize(r, names));
    const tree = nestReplies(rootPayloads, descendants, names);

    return NextResponse.json({ comments: tree, nextCursor });
  } catch {
    return NextResponse.json({ error: "Failed to load comments" }, { status: 500 });
  }
}

// Map a submit_comment RPC exception (raised with a stable SQLSTATE) to the HTTP
// status + the existing { error } shape. The RPC is the single enforcement point
// for auth / answer-gate / kind / stance / body / depth / rate-limit (FIX-539):
//   28000 → 401 (auth)   42501 → 403 (answer-gate / permission)
//   53400 → 429 (rate)   22023 / 42704 → 400 (validation / parent-not-found)
function rpcErrorResponse(error: { code?: string; message?: string }): NextResponse {
  const msg = error.message || "Failed to post comment";
  switch (error.code) {
    case "28000":
      return NextResponse.json({ error: "Sign in to comment" }, { status: 401 });
    case "42501":
      return NextResponse.json({ error: msg }, { status: 403 });
    case "53400":
      return NextResponse.json({ error: msg }, { status: 429 });
    case "22023":
    case "42704":
      return NextResponse.json({ error: msg }, { status: 400 });
    default:
      return NextResponse.json({ error: "Failed to post comment" }, { status: 500 });
  }
}

// ─── POST /api/comments ───────────────────────────────────────────────────────
// Body: { entity_type, entity_id, body, kind?, stance?, parent_id? }
//
// FIX-539: all comment writes go through the SECURITY DEFINER submit_comment RPC
// (mirrors submit_statement / set_entity_position). The RPC — called with the
// CALLER's JWT via createServerClient — is the sole insert path and the real
// enforcement of every rule (auth, answer-gate, kind/stance vocab, body length,
// thread depth, rate limit, and the SERVER-SIDE constituent-badge stamp, which is
// impossible to forge because it is not a parameter). The direct .insert() path,
// its inline badge stamp and answer-gate pre-check are gone. Only light
// request-shape validation stays here for friendly early 400s.
export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Sign in to comment" }, { status: 401 });
    }

    const json = await request.json().catch(() => null);
    if (!json) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });

    const { entity_type, entity_id, body, kind, stance, parent_id } = json as Record<string, unknown>;

    if (typeof entity_type !== "string" || !isEntityCommentType(entity_type)) {
      return NextResponse.json({ error: "Invalid entity_type" }, { status: 400 });
    }
    const entityType = entity_type as EntityCommentType;
    if (typeof entity_id !== "string" || !entity_id) {
      return NextResponse.json({ error: "entity_id is required" }, { status: 400 });
    }
    if (typeof body !== "string") {
      return NextResponse.json({ error: "Comment body is required" }, { status: 400 });
    }

    const admin = createAdminClient();

    // C1 Wave C (FIX-534): rescore-on-trip. Read slow mode BEFORE the insert; the
    // RPC's insert fires the activity trigger that may flip it on. We do the
    // rescore from here (not the trigger) because recompute_comment_bridge_scores
    // UPDATEs entity_comments and firing it inside an AFTER INSERT trigger on the
    // same table risks recursion / write amplification during the spike (FIX-534
    // decision 7). getSlowMode is a single-PK read, cheap.
    const wasSlowMode = await getSlowMode(entityType, entity_id, admin);

    // The single write path. submit_comment validates everything and stamps the
    // constituent badge server-side; auth.uid() inside resolves from this JWT.
    const { data: inserted, error: rpcErr } = await supabase.rpc("submit_comment", {
      p_entity_type: entityType,
      p_entity_id: entity_id,
      p_body: body,
      p_kind: typeof kind === "string" && kind ? kind : DEFAULT_KIND,
      p_stance: typeof stance === "string" && stance ? stance : undefined,
      p_parent_id: typeof parent_id === "string" && parent_id ? parent_id : undefined,
    });

    if (rpcErr) return rpcErrorResponse(rpcErr);
    if (!inserted) {
      return NextResponse.json({ error: "Failed to post comment" }, { status: 500 });
    }

    // If this comment just tripped slow mode (off→on), refresh the bridge map /
    // highlights once so they're fresh during the spike. Best-effort: a failure
    // here must never fail the comment post. Per-entity rescore is cheap.
    if (!wasSlowMode && (await getSlowMode(entityType, entity_id, admin))) {
      try {
        await admin.rpc("recompute_comment_bridge_scores", {
          p_entity_type: entityType,
          p_entity_id: entity_id,
        });
      } catch {
        /* non-fatal — nightly scorer will catch up */
      }
    }

    const names = await fetchNameMap(admin, [inserted.author_id]);
    return NextResponse.json({ comment: serialize(inserted, names) }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Failed to post comment" }, { status: 500 });
  }
}
