import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";
import { challengeRequiredForWrite, verifyTurnstile } from "@/lib/turnstile";
import { mapRpcError } from "../../_lib";
import { recordAbuseEvent } from "@/lib/abuse-events";

export const dynamic = "force-dynamic";

// ─── POST /api/investigations/[id]/evidence ───────────────────────────────────
// Body: { claim_text, claim_type: 'edge'|'context',
//         from_type?, from_id?, to_type?, to_id?, relationship_kind?,   (edge only)
//         subject_is_private_person?,
//         citation_type: 'internal_record'|'imported_entity',
//         citation_target_type, citation_target_id, citation_excerpt?,
//         captchaToken? }
// Adds a card AND its first citation atomically (the no-claim-without-a-citation
// rule) via add_evidence_card. Tier-3 citation types are rejected by the RPC.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Sign in to add evidence", code: "not_authenticated" }, { status: 401 });
    }

    const json = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!json) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });

    const {
      claim_text,
      claim_type,
      from_type,
      from_id,
      to_type,
      to_id,
      relationship_kind,
      subject_is_private_person,
      citation_type,
      citation_target_type,
      citation_target_id,
      citation_excerpt,
      captchaToken,
    } = json;

    if (typeof claim_text !== "string" || claim_text.trim().length < 10) {
      return NextResponse.json({ error: "Claim must be at least 10 characters" }, { status: 400 });
    }
    if (claim_text.trim().length > 2000) {
      return NextResponse.json({ error: "Claim must be 2000 characters or fewer" }, { status: 400 });
    }
    if (claim_type !== "edge" && claim_type !== "context") {
      return NextResponse.json({ error: "claim_type must be edge or context" }, { status: 400 });
    }
    if (citation_type !== "internal_record" && citation_type !== "imported_entity") {
      return NextResponse.json(
        { error: "A tier-1/2 citation (internal_record or imported_entity) is required" },
        { status: 400 },
      );
    }
    if (typeof citation_target_id !== "string" || !citation_target_id) {
      return NextResponse.json({ error: "citation_target_id is required" }, { status: 400 });
    }

    // FIX-569 new-account first-writes challenge (net-new content; established
    // accounts skip it). The add_evidence_card daily cap is the primary control.
    if (await challengeRequiredForWrite(supabase, user)) {
      const ip =
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
        request.headers.get("x-real-ip") ??
        undefined;
      const ok = await verifyTurnstile(typeof captchaToken === "string" ? captchaToken : null, ip);
      await recordAbuseEvent({
        action: "turnstile_challenge",
        headers: request.headers,
        userId: user.id,
        targetType: "investigation",
        targetId: params.id,
        meta: { route: "evidence", outcome: ok ? "pass" : "fail" },
      });
      if (!ok) {
        return NextResponse.json(
          { error: "Please complete the verification to continue.", code: "challenge_required" },
          { status: 403 },
        );
      }
    }

    const { data, error } = await supabase.rpc("add_evidence_card", {
      p_investigation_id: params.id,
      p_claim_text: claim_text.trim(),
      p_claim_type: claim_type,
      p_from_type: typeof from_type === "string" && from_type ? from_type : undefined,
      p_from_id: typeof from_id === "string" && from_id ? from_id : undefined,
      p_to_type: typeof to_type === "string" && to_type ? to_type : undefined,
      p_to_id: typeof to_id === "string" && to_id ? to_id : undefined,
      p_relationship_kind:
        typeof relationship_kind === "string" && relationship_kind ? relationship_kind : undefined,
      p_subject_is_private_person: subject_is_private_person === true,
      p_citation_type: citation_type,
      p_citation_target_type:
        typeof citation_target_type === "string" && citation_target_type ? citation_target_type : undefined,
      p_citation_target_id: citation_target_id,
      p_citation_excerpt:
        typeof citation_excerpt === "string" && citation_excerpt.trim() ? citation_excerpt.trim() : undefined,
    });
    if (error) {
      if (error.code === "53400") {
        await recordAbuseEvent({
          action: "cap_hit",
          headers: request.headers,
          userId: user.id,
          targetType: "investigation",
          targetId: params.id,
          meta: { route: "evidence", cap: "evidence_cap" },
        });
      }
      return mapRpcError(error);
    }

    await recordAbuseEvent({
      action: "evidence_write",
      headers: request.headers,
      userId: user.id,
      targetType: "investigation",
      targetId: params.id,
      meta: { route: "evidence", kind: "card" },
    });

    return NextResponse.json(
      { ok: true, id: (data as { id?: string } | null)?.id ?? null },
      { status: 201 },
    );
  } catch {
    return NextResponse.json({ error: "Failed to add evidence" }, { status: 500 });
  }
}
