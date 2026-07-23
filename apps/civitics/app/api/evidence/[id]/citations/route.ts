import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";
import { mapRpcError } from "../../../investigations/_lib";
import { recordAbuseEvent } from "@/lib/abuse-events";

export const dynamic = "force-dynamic";

// ─── POST /api/evidence/[id]/citations ────────────────────────────────────────
// Body: { citation_type: 'internal_record'|'imported_entity', target_type,
//         target_id, excerpt? }
// Add a further citation to an existing card. Author-only + tier-1/2 only +
// target-existence validated — all in add_citation.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Sign in to add a citation", code: "not_authenticated" }, { status: 401 });
    }

    const json = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!json) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });

    const { citation_type, target_type, target_id, excerpt } = json;
    if (citation_type !== "internal_record" && citation_type !== "imported_entity") {
      return NextResponse.json(
        { error: "A tier-1/2 citation (internal_record or imported_entity) is required" },
        { status: 400 },
      );
    }
    if (typeof target_id !== "string" || !target_id) {
      return NextResponse.json({ error: "target_id is required" }, { status: 400 });
    }

    const { data, error } = await supabase.rpc("add_citation", {
      p_evidence_card_id: params.id,
      p_citation_type: citation_type,
      p_target_type: typeof target_type === "string" && target_type ? target_type : undefined,
      p_target_id: target_id,
      p_excerpt: typeof excerpt === "string" && excerpt.trim() ? excerpt.trim() : undefined,
    });
    if (error) {
      if (error.code === "53400") {
        await recordAbuseEvent({
          action: "cap_hit",
          headers: request.headers,
          userId: user.id,
          targetType: "evidence_card",
          targetId: params.id,
          meta: { route: "evidence_citation", cap: "evidence_cap" },
        });
      }
      return mapRpcError(error);
    }

    await recordAbuseEvent({
      action: "evidence_write",
      headers: request.headers,
      userId: user.id,
      targetType: "evidence_card",
      targetId: params.id,
      meta: { route: "evidence_citation", kind: "citation" },
    });

    return NextResponse.json(
      { ok: true, id: (data as { id?: string } | null)?.id ?? null },
      { status: 201 },
    );
  } catch {
    return NextResponse.json({ error: "Failed to add citation" }, { status: 500 });
  }
}
