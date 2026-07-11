import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createPublicClient, createServerClient } from "@civitics/db";
import {
  STATEMENT_MIN_LEN,
  STATEMENT_MAX_LEN,
  isEntityCommentType,
} from "@civitics/db";
import { getSlowMode } from "@/lib/slow-mode";
import { stripViewerKeys } from "@/lib/public-payload";
import { withPublicCdnCache } from "@/lib/cdn-cache";
import { challengeRequiredForWrite, verifyTurnstile } from "@/lib/turnstile";
import { mapRpcError } from "./_lib";

export const dynamic = "force-dynamic";

// ─── GET /api/statements?entity_type=&entity_id=&lens=&cursor=&limit= ─────────
// PUBLIC, CDN-CACHED (FIX-788; header handler-owned since FIX-796 — the config
// catch-all is gone, withPublicCdnCache stamps the GET 200 below and nothing
// else). The response is held in the shared edge cache and served cross-user,
// so it must contain ZERO viewer-dependent fields — a personalized field here
// is the FIX-786/787 cross-user cache leak. Two layers enforce that:
//   1. the RPC runs on createPublicClient (no cookies → auth.uid() NULL →
//      my_vote is null for every row, for every caller), and
//   2. the body passes through stripViewerKeys() so the my_vote key never
//      appears in the cached payload at all (public-payload.test.ts pins this).
// The caller's own ballots hydrate client-side from the no-store
// /api/viewer/engagement overlay. Never re-add a personalized field here — put
// it in the overlay instead.
// FIX-540: the RPC keysets in SQL and returns { statements, next_cursor };
// cursor/limit pass through opaquely. Also returns the (per-entity, public)
// slow-mode flag so a client refresh can re-read it without SSR.
export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const entityType = sp.get("entity_type");
    const entityId = sp.get("entity_id");
    const lens = sp.get("lens") === "constituents" ? "constituents" : "all";
    const cursor = sp.get("cursor");
    const limit = Math.min(100, Math.max(1, parseInt(sp.get("limit") ?? "", 10) || 50));

    if (!entityType || !isEntityCommentType(entityType)) {
      return NextResponse.json({ error: "Invalid entity_type" }, { status: 400 });
    }
    if (!entityId) {
      return NextResponse.json({ error: "entity_id is required" }, { status: 400 });
    }

    const supabase = createPublicClient();

    const { data, error } = await supabase.rpc("get_entity_statements", {
      p_entity_type: entityType,
      p_entity_id: entityId,
      p_lens: lens,
      p_limit: limit,
      p_cursor: cursor ?? undefined,
    });
    if (error) return NextResponse.json({ error: "Failed to load statements" }, { status: 500 });

    const result = (data as { statements?: unknown; next_cursor?: unknown } | null) ?? {};
    const slowMode = await getSlowMode(entityType, entityId, supabase);
    return withPublicCdnCache(
      NextResponse.json(
        stripViewerKeys({
          statements: Array.isArray(result.statements) ? result.statements : [],
          nextCursor: typeof result.next_cursor === "string" ? result.next_cursor : null,
          slowMode,
        }),
      ),
    );
  } catch {
    return NextResponse.json({ error: "Failed to load statements" }, { status: 500 });
  }
}

// ─── POST /api/statements ─────────────────────────────────────────────────────
// Body: { entity_type, entity_id, body, source_comment_id? }
// Creation is gated (rate-limited, own-comment promotion only) — enforced in the
// submit_statement RPC, which runs as the caller (auth.uid()).
export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Sign in to propose a statement", code: "not_authenticated" }, { status: 401 });
    }

    const json = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!json) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });

    const { entity_type, entity_id, body, source_comment_id, captchaToken } = json;

    if (typeof entity_type !== "string" || !isEntityCommentType(entity_type)) {
      return NextResponse.json({ error: "Invalid entity_type" }, { status: 400 });
    }
    if (typeof entity_id !== "string" || !entity_id) {
      return NextResponse.json({ error: "entity_id is required" }, { status: 400 });
    }
    if (typeof body !== "string" || body.trim().length < STATEMENT_MIN_LEN) {
      return NextResponse.json({ error: `Statement must be at least ${STATEMENT_MIN_LEN} characters` }, { status: 400 });
    }
    if (body.trim().length > STATEMENT_MAX_LEN) {
      return NextResponse.json({ error: `Statement must be ${STATEMENT_MAX_LEN} characters or fewer` }, { status: 400 });
    }
    let sourceCommentId: string | null = null;
    if (source_comment_id != null && source_comment_id !== "") {
      if (typeof source_comment_id !== "string") {
        return NextResponse.json({ error: "Invalid source_comment_id" }, { status: 400 });
      }
      sourceCommentId = source_comment_id;
    }

    // FIX-569: new-account first-writes challenge — 403 at the access layer; the
    // submit_statement daily cap is the primary control. Established accounts skip it.
    if (await challengeRequiredForWrite(supabase, user)) {
      const ip =
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
        request.headers.get("x-real-ip") ??
        undefined;
      const ok = await verifyTurnstile(typeof captchaToken === "string" ? captchaToken : null, ip);
      if (!ok) {
        return NextResponse.json(
          { error: "Please complete the verification to continue.", code: "challenge_required" },
          { status: 403 },
        );
      }
    }

    const { data, error } = await supabase.rpc("submit_statement", {
      p_entity_type: entity_type,
      p_entity_id: entity_id,
      p_body: body.trim(),
      p_source_comment_id: sourceCommentId ?? undefined,
    });
    if (error) return mapRpcError(error);

    return NextResponse.json({ ok: true, id: (data as { id?: string } | null)?.id ?? null }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Failed to submit statement" }, { status: 500 });
  }
}
