import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";
import { computeGate } from "../../_lib/gate";

export const dynamic = "force-dynamic";

// ─── GET /api/initiatives/[id]/gate ──────────────────────────────────────────
// Returns the current quality gate status for the deliberate→mobilise transition.
// Available to anyone (public read) — but practically only shown to the author.
//
// Response: { can_advance, signals: GateSignal[], checked_at }

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);

    // Verify initiative exists — join initiative_details for stage/scope, proposals for jurisdiction_id
    const { data: proposal } = await supabase
      .from("proposals")
      .select("id, jurisdiction_id, initiative_details!initiative_details_proposal_id_fkey(stage, mobilise_started_at, scope)")
      .eq("id", params.id)
      .eq("type", "initiative")
      .maybeSingle();

    if (!proposal || !proposal.initiative_details) {
      return NextResponse.json({ error: "Initiative not found" }, { status: 404 });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const details = Array.isArray(proposal.initiative_details)
      ? (proposal.initiative_details[0] as any)
      : (proposal.initiative_details as any);

    // Gate only applies to deliberate stage — but return status for any stage
    const gate = await computeGate(supabase, params.id, details.mobilise_started_at, {
      jurisdictionId: proposal.jurisdiction_id,
      scope:          details.scope,
    });

    return NextResponse.json(gate);
  } catch {
    return NextResponse.json({ error: "Failed to compute gate status" }, { status: 500 });
  }
}
