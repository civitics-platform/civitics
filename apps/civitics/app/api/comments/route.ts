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
  fetchAuthorMeta,
  serialize,
  nestReplies,
  topScore,
  hasRecordLink,
  type CommentPayload,
} from "./_lib";
import { getSlowMode } from "@/lib/slow-mode";
import { challengeRequiredForWrite, verifyTurnstile } from "@/lib/turnstile";
import { recordAbuseEvent } from "@/lib/abuse-events";

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

// FIX-540: two-region bridge cursor. Region 1 = scored rows, ordered
// (bridge_score DESC, created_at DESC, id DESC); region 2 = unscored rows
// (bridge_score IS NULL), ordered (created_at DESC, id DESC). The cursor
// carries the region tag + the last row's sort values so a single GET can fill
// a page across the region boundary. Same base64url codec as `newest`, with a
// region prefix; score kept as its raw PostgREST string so the numeric value
// round-trips into the seek filter exactly.
type BridgeCursor =
  | { region: 1; score: string; createdAt: string; id: string }
  | { region: 2; createdAt: string; id: string };

function encodeBridgeCursor(c: BridgeCursor): string {
  const parts =
    c.region === 1 ? ["b1", c.score, c.createdAt, c.id] : ["b2", "", c.createdAt, c.id];
  return Buffer.from(parts.join("|")).toString("base64url");
}
function decodeBridgeCursor(cursor: string): BridgeCursor | null {
  try {
    const [tag, score, createdAt, id] = Buffer.from(cursor, "base64url")
      .toString("utf8")
      .split("|");
    if (!createdAt || !id) return null;
    if (tag === "b1" && score) return { region: 1, score, createdAt, id };
    if (tag === "b2") return { region: 2, createdAt, id };
    return null;
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
    const focusId = sp.get("focus_id");
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
    // Builder (not a shared instance): the bridge sort issues two region
    // queries and PostgrestFilterBuilder accumulates filters, so each query
    // needs a fresh chain.
    const buildRoots = () => {
      let q = admin
        .from("entity_comments")
        .select(COMMENT_COLUMNS)
        .eq("entity_type", entityType)
        .eq("entity_id", entityId)
        .is("parent_id", null)
        .not("kind", "in", "(question,answer,community_note)")
        .in("status", ["visible", "needs_review"]);
      if (lens === "constituents") {
        q = q.not("constituent_jurisdiction_id", "is", null);
      }
      return q;
    };

    // ── focus_id (FIX-532): resolve the target's thread root and return just
    // that root's tree — bounded work no matter how deep the comment sits in
    // any sort order. The root keeps the discussion-lane filters so a Q&A row
    // can never be injected into the discussion list. lens is deliberately not
    // applied: a focused thread is fetched regardless of the active lens.
    if (focusId) {
      const { data: target, error: targetErr } = await admin
        .from("entity_comments")
        .select("id,thread_root_id")
        .eq("entity_type", entityType)
        .eq("entity_id", entityId)
        .eq("id", focusId)
        .in("status", ["visible", "needs_review"])
        .maybeSingle();
      if (targetErr) return NextResponse.json({ error: "Failed to load comments" }, { status: 500 });
      if (!target) return NextResponse.json({ comments: [], nextCursor: null });

      const rootId = target.thread_root_id ?? target.id;
      const { data: rootRow, error: rootErr } = await admin
        .from("entity_comments")
        .select(COMMENT_COLUMNS)
        .eq("id", rootId)
        .is("parent_id", null)
        .not("kind", "in", "(question,answer,community_note)")
        .in("status", ["visible", "needs_review"])
        .maybeSingle();
      if (rootErr) return NextResponse.json({ error: "Failed to load comments" }, { status: 500 });
      if (!rootRow) return NextResponse.json({ comments: [], nextCursor: null });

      const { data: desc } = await admin
        .from("entity_comments")
        .select(COMMENT_COLUMNS)
        .eq("thread_root_id", rootId)
        .not("parent_id", "is", null)
        .not("kind", "in", "(question,answer,community_note)")
        .in("status", ["visible", "needs_review"]);
      const descendants = desc ?? [];
      const names = await fetchAuthorMeta(admin, [
        rootRow.author_id,
        ...descendants.map((d) => d.author_id),
      ]);
      const tree = nestReplies([serialize(rootRow, names)], descendants, names);
      return NextResponse.json({ comments: tree, nextCursor: null });
    }

    let roots: any[];
    let nextCursor: string | null = null;

    if (sort === "bridge") {
      // Two-region keyset (FIX-540): scored rows first (region 1), then the
      // bridge_score IS NULL tail (region 2) — together equivalent to the old
      // single-page NULLS LAST order, but pageable. One GET fills the page
      // across the boundary: if region 1 comes up short, top up from region 2
      // in the same request.
      const c = cursor ? decodeBridgeCursor(cursor) : null;
      roots = [];

      if (!c || c.region === 1) {
        let q = buildRoots().not("bridge_score", "is", null);
        if (c && c.region === 1) {
          q = q.or(
            `bridge_score.lt.${c.score},and(bridge_score.eq.${c.score},created_at.lt.${c.createdAt}),and(bridge_score.eq.${c.score},created_at.eq.${c.createdAt},id.lt.${c.id})`,
          );
        }
        const { data, error } = await q
          .order("bridge_score", { ascending: false })
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(limit);
        if (error) return NextResponse.json({ error: "Failed to load comments" }, { status: 500 });
        roots = data ?? [];
      }

      if (roots.length < limit) {
        // Region 1 exhausted (or we're already in region 2) — fill from the
        // unscored tail. A region-1 cursor needs no seek here: region 2 hasn't
        // been consumed yet.
        let q = buildRoots().is("bridge_score", null);
        if (c && c.region === 2) {
          q = q.or(
            `created_at.lt.${c.createdAt},and(created_at.eq.${c.createdAt},id.lt.${c.id})`,
          );
        }
        const { data, error } = await q
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(limit - roots.length);
        if (error) return NextResponse.json({ error: "Failed to load comments" }, { status: 500 });
        roots = [...roots, ...(data ?? [])];
      }

      if (roots.length === limit) {
        const last = roots[roots.length - 1];
        nextCursor = encodeBridgeCursor(
          last.bridge_score != null
            ? { region: 1, score: String(last.bridge_score), createdAt: last.created_at, id: last.id }
            : { region: 2, createdAt: last.created_at, id: last.id },
        );
      }
    } else if (sort === "top") {
      const { data, error } = await buildRoots()
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
      let rootsQuery = buildRoots();
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
    // .in() bounded: roots is `.limit(limit)` and limit is Math.min(MAX_LIMIT=50, …),
    // max 50. Note the DESCENDANT read this feeds is NOT bounded — its author
    // list is chunked in fetchAuthorMeta — FIX-902
    const rootIds = roots.map((r) => r.id);
    let descendants: any[] = [];
    if (rootIds.length > 0) {
      const { data: desc } = await admin
        .from("entity_comments")
        .select(COMMENT_COLUMNS)
        .in("thread_root_id", rootIds)
        .not("parent_id", "is", null)
        .not("kind", "in", "(question,answer,community_note)")
        .in("status", ["visible", "needs_review"]);
      descendants = desc ?? [];
    }

    const names = await fetchAuthorMeta(admin, [
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

    const { entity_type, entity_id, body, kind, stance, parent_id, captchaToken } =
      json as Record<string, unknown>;

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

    // Q&A v2 PR-1 (FIX-626): friendly citation pre-check for community context. The
    // RPC is the hard enforcement (same two-pattern test); this just yields a
    // nicer message than the raw RPC exception text.
    if (kind === "community_note" && !hasRecordLink(body)) {
      return NextResponse.json(
        { error: "Add a link to the record — a vote, statement, or page — so others can verify." },
        { status: 400 },
      );
    }

    // FIX-569: new-account first-writes challenge. Established accounts skip the
    // Turnstile check; new accounts must pass it before the write — a 403 at the
    // ACCESS layer (never auto-hide/delete posted content). The gate short-circuits
    // on account age, so it's cheap on the common (established) path.
    if (await challengeRequiredForWrite(supabase, user)) {
      const ip =
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
        request.headers.get("x-real-ip") ??
        undefined;
      const ok = await verifyTurnstile(
        typeof captchaToken === "string" ? captchaToken : null,
        ip,
      );
      await recordAbuseEvent({
        action: "turnstile_challenge",
        headers: request.headers,
        userId: user.id,
        targetType: entityType,
        targetId: entity_id,
        meta: { route: "comments", outcome: ok ? "pass" : "fail" },
      });
      if (!ok) {
        return NextResponse.json(
          { error: "Please complete the verification to continue.", code: "challenge_required" },
          { status: 403 },
        );
      }
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

    if (rpcErr) {
      if (rpcErr.code === "53400") {
        await recordAbuseEvent({
          action: "cap_hit",
          headers: request.headers,
          userId: user.id,
          targetType: entityType,
          targetId: entity_id,
          meta: { route: "comments", cap: "comment_daily" },
        });
      }
      return rpcErrorResponse(rpcErr);
    }
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

    await recordAbuseEvent({
      action: "comment_create",
      headers: request.headers,
      userId: user.id,
      targetType: entityType,
      targetId: entity_id,
      // meta.kind distinguishes discussion comments from Q&A questions/answers
      // and community_notes — those are all comments, so this stays one action.
      meta: { route: "comments", kind: typeof kind === "string" && kind ? kind : DEFAULT_KIND },
    });

    const names = await fetchAuthorMeta(admin, [inserted.author_id]);
    return NextResponse.json({ comment: serialize(inserted, names) }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Failed to post comment" }, { status: 500 });
  }
}
