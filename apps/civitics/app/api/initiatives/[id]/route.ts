import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient, createAdminClient } from "@civitics/db";
import type { Database } from "@civitics/db";

export const dynamic = "force-dynamic";

type ResponseRow = Database["public"]["Tables"]["civic_initiative_responses"]["Row"];

const VALID_SCOPES = ["federal", "state", "local"] as const;

// ─── GET /api/initiatives/[id] ────────────────────────────────────────────────
// Full initiative detail with signature counts and official responses.
// Reads from proposals (core) + initiative_details (initiative-specific fields).

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);

    // Fetch proposal + initiative_details
    const { data: proposal, error: fetchErr } = await supabase
      .from("proposals")
      .select("*, initiative_details!initiative_details_proposal_id_fkey(*)")
      .eq("id", params.id)
      .eq("type", "initiative")
      .maybeSingle();

    if (fetchErr || !proposal || !proposal.initiative_details) {
      return NextResponse.json(
        { error: "Initiative not found" },
        { status: 404 }
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const details: any = Array.isArray(proposal.initiative_details)
      ? proposal.initiative_details[0]
      : proposal.initiative_details;

    // Flatten to the shape the frontend expects (legacy civic_initiatives shape)
    const initiative = {
      id:                   proposal.id,
      title:                proposal.title,
      summary:              proposal.summary_plain,
      status:               proposal.status,
      jurisdiction_id:      proposal.jurisdiction_id,
      created_at:           proposal.created_at,
      updated_at:           proposal.updated_at,
      resolved_at:          proposal.resolved_at,
      body_md:              details.body_md,
      scope:                details.scope,
      stage:                details.stage,
      primary_author_id:    details.primary_author_id,
      authorship_type:      details.authorship_type,
      issue_area_tags:      details.issue_area_tags,
      mobilise_started_at:  details.mobilise_started_at,
      quality_gate_score:   details.quality_gate_score,
      resolution_type:      details.resolution_type,
      signature_threshold:  details.signature_threshold,
      target_district:      details.target_district,
      promoted_to_proposal_id: details.promoted_to_proposal_id,
    };

    // Fetch counts and responses in parallel
    const [totalRes, verifiedRes, upvoteRes, responsesRes] = await Promise.all([
      supabase
        .from("civic_initiative_signatures")
        .select("*", { count: "exact", head: true })
        .eq("initiative_id", params.id),
      supabase
        .from("civic_initiative_signatures")
        .select("*", { count: "exact", head: true })
        .eq("initiative_id", params.id)
        .eq("verification_tier", "district"),
      supabase
        .from("civic_initiative_upvotes")
        .select("*", { count: "exact", head: true })
        .eq("initiative_id", params.id),
      supabase
        .from("civic_initiative_responses")
        .select(
          "id,official_id,response_type,body_text,committee_referred,window_opened_at,window_closes_at,responded_at,is_verified_staff"
        )
        .eq("initiative_id", params.id),
    ]);

    return NextResponse.json({
      initiative,
      signature_counts: {
        total: totalRes.count ?? 0,
        constituent_verified: verifiedRes.count ?? 0,
      },
      upvote_count: upvoteRes.count ?? 0,
      responses: (responsesRes.data ?? []) as ResponseRow[],
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch initiative" },
      { status: 500 }
    );
  }
}

// ─── PATCH /api/initiatives/[id] ─────────────────────────────────────────────
// Update an initiative (draft/deliberate stage only). Snapshots current body_md
// as a version before applying the update.

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json(
        { error: "Sign in to edit an initiative" },
        { status: 401 }
      );
    }

    // Fetch current initiative — must be author, and stage must be draft or deliberate
    const { data: current, error: fetchErr } = await supabase
      .from("proposals")
      .select("id, title, summary_plain, initiative_details!initiative_details_proposal_id_fkey(body_md, stage, primary_author_id)")
      .eq("id", params.id)
      .eq("type", "initiative")
      .maybeSingle();

    if (fetchErr || !current || !current.initiative_details) {
      return NextResponse.json({ error: "Initiative not found" }, { status: 404 });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const details: any = Array.isArray(current.initiative_details)
      ? current.initiative_details[0]
      : current.initiative_details;

    if (details.primary_author_id !== user.id) {
      return NextResponse.json({ error: "Only the author can edit this initiative" }, { status: 403 });
    }
    if (details.stage !== "draft" && details.stage !== "deliberate") {
      return NextResponse.json(
        { error: "Proposal text is frozen once mobilising begins" },
        { status: 400 }
      );
    }

    const body = await request.json();
    const { title, summary, body_md, scope, issue_area_tags } = body;

    // Validate
    if (title !== undefined) {
      if (typeof title !== "string" || title.length < 10 || title.length > 120) {
        return NextResponse.json({ error: "Title must be 10–120 characters" }, { status: 400 });
      }
    }
    if (summary !== undefined && typeof summary === "string" && summary.length > 500) {
      return NextResponse.json({ error: "Summary must be 500 characters or less" }, { status: 400 });
    }
    if (scope !== undefined && !VALID_SCOPES.includes(scope as (typeof VALID_SCOPES)[number])) {
      return NextResponse.json({ error: "Scope must be federal, state, or local" }, { status: 400 });
    }

    const admin = createAdminClient();

    // Snapshot the current version before overwriting
    const bodyChanged = body_md !== undefined && body_md.trim() !== details.body_md;
    const titleChanged = title !== undefined && title.trim() !== current.title;

    if (bodyChanged || titleChanged) {
      // Get highest version number for this initiative
      const { data: latestVersion } = await admin
        .from("civic_initiative_versions")
        .select("version_number")
        .eq("initiative_id", params.id)
        .order("version_number", { ascending: false })
        .limit(1)
        .maybeSingle();

      const nextVersion = (latestVersion?.version_number ?? 0) + 1;

      await admin.from("civic_initiative_versions").insert({
        initiative_id: params.id,
        version_number: nextVersion,
        body_md: details.body_md,
        title: current.title,
        edited_by: user.id,
      });
    }

    // Apply update — split between proposals (title, summary_plain) and initiative_details (body_md, scope, issue_area_tags)
    const proposalUpdates: Record<string, unknown> = {};
    if (title !== undefined) proposalUpdates.title = title.trim();
    if (summary !== undefined) proposalUpdates.summary_plain = summary?.trim() ?? null;

    const detailUpdates: Record<string, unknown> = {};
    if (body_md !== undefined) detailUpdates.body_md = body_md.trim();
    if (scope !== undefined) detailUpdates.scope = scope;
    if (Array.isArray(issue_area_tags)) detailUpdates.issue_area_tags = issue_area_tags;

    if (Object.keys(proposalUpdates).length > 0) {
      const { error: pErr } = await admin
        .from("proposals")
        .update(proposalUpdates)
        .eq("id", params.id);
      if (pErr) {
        return NextResponse.json({ error: "Failed to update initiative" }, { status: 500 });
      }
    }

    if (Object.keys(detailUpdates).length > 0) {
      const { error: dErr } = await admin
        .from("initiative_details")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .update(detailUpdates as any)
        .eq("proposal_id", params.id);
      if (dErr) {
        return NextResponse.json({ error: "Failed to update initiative" }, { status: 500 });
      }
    }

    const { data: updated } = await admin
      .from("proposals")
      .select("id, title, updated_at, initiative_details!initiative_details_proposal_id_fkey(stage)")
      .eq("id", params.id)
      .single();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updatedDetails: any = updated?.initiative_details
      ? (Array.isArray(updated.initiative_details) ? updated.initiative_details[0] : updated.initiative_details)
      : null;

    return NextResponse.json({
      initiative: {
        id: updated?.id,
        title: updated?.title,
        stage: updatedDetails?.stage,
        updated_at: updated?.updated_at,
      },
    });
  } catch {
    return NextResponse.json({ error: "Failed to update initiative" }, { status: 500 });
  }
}
