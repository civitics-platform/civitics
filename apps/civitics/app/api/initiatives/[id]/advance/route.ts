import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient, createAdminClient } from "@civitics/db";
import { computeGate } from "../../_lib/gate";

export const dynamic = "force-dynamic";

// ─── POST /api/initiatives/[id]/advance ──────────────────────────────────────
// Advance an initiative to the next stage. Two valid transitions:
//
//   draft → deliberate   (no gate — author decision to open for input)
//   deliberate → mobilise (quality gate enforced)
//
// Auth required. Only the primary_author_id may advance their initiative.
//
// On success, persists the gate score to quality_gate_score JSONB.

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Sign in to advance this initiative" }, { status: 401 });
    }

    // Fetch initiative — core (proposals) + initiative-specific (initiative_details).
    const { data: proposal } = await supabase
      .from("proposals")
      .select("id, jurisdiction_id, initiative_details!initiative_details_proposal_id_fkey(stage, primary_author_id, mobilise_started_at, scope)")
      .eq("id", params.id)
      .eq("type", "initiative")
      .single();

    if (!proposal || !proposal.initiative_details) {
      return NextResponse.json({ error: "Initiative not found" }, { status: 404 });
    }

    // Supabase returns a single related row as an object because proposal_id is unique on initiative_details.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const details = Array.isArray(proposal.initiative_details)
      ? (proposal.initiative_details[0] as any)
      : (proposal.initiative_details as any);

    if (details.primary_author_id !== user.id) {
      return NextResponse.json({ error: "Only the author can advance this initiative" }, { status: 403 });
    }

    const currentStage = details.stage;

    // ── draft → deliberate ────────────────────────────────────────────────────
    if (currentStage === "draft") {
      const admin = createAdminClient();
      const { data: updated, error } = await admin
        .from("initiative_details")
        .update({ stage: "deliberate" })
        .eq("proposal_id", params.id)
        .select("stage")
        .single();

      if (error) {
        return NextResponse.json({ error: "Failed to advance initiative" }, { status: 500 });
      }

      return NextResponse.json({
        stage: updated.stage,
        message: "Initiative is now open for community deliberation.",
      });
    }

    // ── deliberate → mobilise ─────────────────────────────────────────────────
    if (currentStage === "deliberate") {
      // Run quality gate (v2 — population-normalised)
      const gate = await computeGate(supabase, params.id, details.mobilise_started_at, {
        jurisdictionId: proposal.jurisdiction_id,
        scope:          details.scope,
      });

      const admin = createAdminClient();

      // Always persist the latest gate score
      await admin
        .from("initiative_details")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .update({ quality_gate_score: gate as any })
        .eq("proposal_id", params.id);

      if (!gate.can_advance) {
        return NextResponse.json(
          {
            error: "Quality gate not passed",
            gate,
          },
          { status: 422 }
        );
      }

      // Advance to mobilise — update initiative_details + proposal status in parallel.
      const now = new Date().toISOString();
      const [{ data: updated, error }] = await Promise.all([
        admin
          .from("initiative_details")
          .update({
            stage: "mobilise",
            mobilise_started_at: now,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            quality_gate_score: gate as any,
          })
          .eq("proposal_id", params.id)
          .select("stage, mobilise_started_at")
          .single(),
        admin
          .from("proposals")
          .update({ status: "in_committee" })
          .eq("id", params.id),
      ]);

      if (error) {
        return NextResponse.json({ error: "Failed to advance initiative" }, { status: 500 });
      }

      return NextResponse.json({
        stage: updated.stage,
        mobilise_started_at: updated.mobilise_started_at,
        message: "Initiative is now mobilising — signature gathering has begun.",
        gate,
      });
    }

    // ── already at or past mobilise ───────────────────────────────────────────
    return NextResponse.json(
      { error: `Cannot advance from '${currentStage}' stage` },
      { status: 400 }
    );
  } catch {
    return NextResponse.json({ error: "Failed to advance initiative" }, { status: 500 });
  }
}
