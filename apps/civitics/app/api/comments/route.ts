import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
import { createServerClient, createAdminClient } from "@civitics/db";
import {
  ALLOWED_KINDS,
  COMMENT_STANCES,
  DEFAULT_KIND,
  RATE_LIMITS,
  BODY_MIN,
  BODY_MAX,
  isEntityCommentType,
  type EntityCommentType,
} from "@civitics/db";
import {
  COMMENT_COLUMNS,
  fetchNameMap,
  serialize,
  nestReplies,
  resolveConstituentBadge,
  isRateLimited,
  replyDepthExceeded,
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

// ─── POST /api/comments ───────────────────────────────────────────────────────
// Body: { entity_type, entity_id, body, kind?, stance?, parent_id? }
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
    if (typeof body !== "string" || body.trim().length < BODY_MIN) {
      return NextResponse.json({ error: `Comment must be at least ${BODY_MIN} characters` }, { status: 400 });
    }
    if (body.trim().length > BODY_MAX) {
      return NextResponse.json({ error: `Comment must be ${BODY_MAX} characters or fewer` }, { status: 400 });
    }

    const resolvedKind = typeof kind === "string" && kind ? kind : DEFAULT_KIND;
    if (!ALLOWED_KINDS[entityType].includes(resolvedKind)) {
      return NextResponse.json({ error: `Invalid kind '${resolvedKind}' for ${entityType}` }, { status: 400 });
    }
    let resolvedStance: string | null = null;
    if (stance != null && stance !== "") {
      if (typeof stance !== "string" || !(COMMENT_STANCES as readonly string[]).includes(stance)) {
        return NextResponse.json({ error: `Invalid stance '${String(stance)}'` }, { status: 400 });
      }
      resolvedStance = stance;
    }

    const admin = createAdminClient();

    // C1 Wave D (FIX-537, decision 4 + 11): answer path. kind='answer' is the
    // official Q&A response — only a holder of an active 'official' grant for
    // this official may post it, and it must reply to a question. The DB RLS
    // WITH CHECK is the true gate (this route writes via the service-role admin
    // client, which BYPASSES RLS), so we pre-check the grant here to return a
    // clean 403 instead of letting the insert fail; we also require the parent
    // question (enforced + verified as kind='question' in the threading block).
    if (resolvedKind === "answer") {
      if (entityType !== "official") {
        return NextResponse.json({ error: "Answers are only valid on officials" }, { status: 400 });
      }
      if (typeof parent_id !== "string" || !parent_id) {
        return NextResponse.json({ error: "An answer must reply to a question" }, { status: 400 });
      }
      const { data: canAnswer } = await admin.rpc("has_active_official_grant", {
        p_user_id: user.id,
        p_official_id: entity_id,
      });
      if (canAnswer !== true) {
        return NextResponse.json({ error: "Only the verified official can answer" }, { status: 403 });
      }
    }

    // Rate limit: comments per user per rolling 24h.
    if (await isRateLimited(admin, "entity_comments", "author_id", user.id, RATE_LIMITS.comments)) {
      return NextResponse.json(
        { error: `Daily comment limit reached (${RATE_LIMITS.comments}). Try again tomorrow.` },
        { status: 429 },
      );
    }

    // Threading: resolve thread_root_id + enforce max depth.
    const newId: string = randomUUID();
    let threadRootId: string = newId;
    if (parent_id != null) {
      if (typeof parent_id !== "string") {
        return NextResponse.json({ error: "Invalid parent_id" }, { status: 400 });
      }
      const { data: parent } = await admin
        .from("entity_comments")
        .select("id,entity_type,entity_id,parent_id,thread_root_id,status,kind")
        .eq("id", parent_id)
        .maybeSingle();
      if (!parent || parent.entity_type !== entityType || parent.entity_id !== entity_id) {
        return NextResponse.json({ error: "Parent comment not found" }, { status: 400 });
      }
      // An answer may only reply to a question (decision 1).
      if (resolvedKind === "answer" && parent.kind !== "question") {
        return NextResponse.json({ error: "An answer must reply to a question" }, { status: 400 });
      }
      threadRootId = parent.thread_root_id ?? parent.id;
      const { data: threadRows } = await admin
        .from("entity_comments")
        .select("id,parent_id")
        .eq("thread_root_id", threadRootId);
      if (replyDepthExceeded(parent.id, (threadRows ?? []) as Array<{ id: string; parent_id: string | null }>)) {
        return NextResponse.json({ error: "Maximum reply depth reached" }, { status: 400 });
      }
    }

    // Constituent badge snapshot (decision 11).
    const constituentJurisdiction = await resolveConstituentBadge(admin, user.id, entityType, entity_id);

    // C1 Wave C (FIX-534): rescore-on-trip. Read slow mode BEFORE the insert; the
    // insert fires the activity trigger that may flip it on. We do the rescore
    // from here (not the trigger) because recompute_comment_bridge_scores UPDATEs
    // entity_comments and firing it inside an AFTER INSERT trigger on the same
    // table risks recursion / write amplification during the spike (decision 7).
    const wasSlowMode = await getSlowMode(entityType, entity_id, admin);

    const { data: inserted, error: insertErr } = await admin
      .from("entity_comments")
      .insert({
        id: newId,
        entity_type: entityType,
        entity_id,
        parent_id: (parent_id as string) ?? null,
        thread_root_id: threadRootId,
        author_id: user.id,
        kind: resolvedKind,
        stance: resolvedStance,
        body: body.trim(),
        constituent_jurisdiction_id: constituentJurisdiction,
      })
      .select(COMMENT_COLUMNS)
      .single();

    if (insertErr || !inserted) {
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
