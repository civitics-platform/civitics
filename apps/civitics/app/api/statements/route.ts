import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";
import {
  STATEMENT_MIN_LEN,
  STATEMENT_MAX_LEN,
  isEntityCommentType,
} from "@civitics/db";
import { getSlowMode } from "@/lib/slow-mode";
import { mapRpcError } from "./_lib";

export const dynamic = "force-dynamic";

// ─── GET /api/statements?entity_type=&entity_id=&lens= ────────────────────────
// Public ordered list (anon-allowed). Called via the caller's server client so
// get_entity_statements can surface my_vote for an authenticated reader. Also
// returns the slow-mode flag so a client refresh can re-read it without SSR.
export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const entityType = sp.get("entity_type");
    const entityId = sp.get("entity_id");
    const lens = sp.get("lens") === "constituents" ? "constituents" : "all";

    if (!entityType || !isEntityCommentType(entityType)) {
      return NextResponse.json({ error: "Invalid entity_type" }, { status: 400 });
    }
    if (!entityId) {
      return NextResponse.json({ error: "entity_id is required" }, { status: 400 });
    }

    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);

    const { data, error } = await supabase.rpc("get_entity_statements", {
      p_entity_type: entityType,
      p_entity_id: entityId,
      p_lens: lens,
    });
    if (error) return NextResponse.json({ error: "Failed to load statements" }, { status: 500 });

    const slowMode = await getSlowMode(entityType, entityId, supabase);
    return NextResponse.json({ statements: data ?? [], slowMode });
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

    const { entity_type, entity_id, body, source_comment_id } = json;

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
