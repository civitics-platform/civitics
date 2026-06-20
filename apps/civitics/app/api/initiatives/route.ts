import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient, createAdminClient } from "@civitics/db";

export const dynamic = "force-dynamic";

const VALID_STAGES = ["draft", "deliberate", "mobilise", "resolved", "problem"] as const;
const VALID_SCOPES = ["federal", "state", "local"] as const;

// ─── GET /api/initiatives ─────────────────────────────────────────────────────
// Paginated list of initiatives, filterable by stage/scope/tag.
// Reads from initiative_details joined to proposals.

export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);

    const { searchParams } = request.nextUrl;
    const stage = searchParams.get("stage");
    const scope = searchParams.get("scope");
    const tag = searchParams.get("tag");
    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1") || 1);
    const limit = Math.min(
      Math.max(1, parseInt(searchParams.get("limit") ?? "20") || 20),
      50
    );
    const offset = (page - 1) * limit;

    // Query initiative_details and join the parent proposal for title/summary/created_at
    let query = supabase
      .from("initiative_details")
      .select(
        // initiative_details has TWO FKs to proposals; name the FK or PostgREST
        // PGRST201s and supabase-js swallows it to null (FIX-616 twin).
        "proposal_id,stage,scope,authorship_type,issue_area_tags,target_district,mobilise_started_at,proposals!initiative_details_proposal_id_fkey!inner(id,title,summary_plain,created_at,resolved_at,type)",
        { count: "exact" }
      )
      .eq("proposals.type", "initiative");

    if (stage && VALID_STAGES.includes(stage as (typeof VALID_STAGES)[number])) {
      query = query.eq("stage", stage as (typeof VALID_STAGES)[number]);
    }
    if (scope && VALID_SCOPES.includes(scope as (typeof VALID_SCOPES)[number])) {
      query = query.eq("scope", scope as (typeof VALID_SCOPES)[number]);
    }
    if (tag) {
      query = query.contains("issue_area_tags", [tag]);
    }

    const { data, error, count } = await query
      .order("mobilise_started_at", { ascending: false, nullsFirst: false })
      .range(offset, offset + limit - 1);

    if (error) {
      return NextResponse.json(
        { error: "Failed to fetch initiatives" },
        { status: 500 }
      );
    }

    // Flatten to the shape the frontend expects (legacy civic_initiatives shape)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const initiatives = (data ?? []).map((row: any) => {
      const p = Array.isArray(row.proposals) ? row.proposals[0] : row.proposals;
      return {
        id:                  row.proposal_id,
        title:               p?.title,
        summary:             p?.summary_plain,
        stage:               row.stage,
        scope:               row.scope,
        authorship_type:     row.authorship_type,
        issue_area_tags:     row.issue_area_tags,
        target_district:     row.target_district,
        mobilise_started_at: row.mobilise_started_at,
        created_at:          p?.created_at,
        resolved_at:         p?.resolved_at,
      };
    });

    return NextResponse.json({
      initiatives,
      total: count ?? 0,
      page,
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch initiatives" },
      { status: 500 }
    );
  }
}

// ─── POST /api/initiatives ────────────────────────────────────────────────────
// Create a new initiative. Auth required.
// Writes to proposals (core) + initiative_details (initiative-specific fields).

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json(
        { error: "Sign in to create an initiative" },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { title, summary, body_md, scope, issue_area_tags, jurisdiction_id, is_problem } = body;

    // Validation
    if (!title || typeof title !== "string") {
      return NextResponse.json(
        { error: "Title is required" },
        { status: 400 }
      );
    }
    if (title.length < 10 || title.length > 120) {
      return NextResponse.json(
        { error: "Title must be between 10 and 120 characters" },
        { status: 400 }
      );
    }
    // body_md is required for full initiatives, optional for problem statements
    if (!is_problem && (!body_md || typeof body_md !== "string" || body_md.trim().length === 0)) {
      return NextResponse.json(
        { error: "Body text is required" },
        { status: 400 }
      );
    }
    if (summary && typeof summary === "string" && summary.length > 500) {
      return NextResponse.json(
        { error: "Summary must be 500 characters or less" },
        { status: 400 }
      );
    }
    if (!scope || !VALID_SCOPES.includes(scope as (typeof VALID_SCOPES)[number])) {
      return NextResponse.json(
        { error: "Scope must be one of: federal, state, local" },
        { status: 400 }
      );
    }

    const initiativeStage = is_problem ? "problem" : "draft";

    const admin = createAdminClient();

    // Resolve jurisdiction_id — use client-supplied value or fall back to country root.
    let resolvedJurisdictionId: string | null = jurisdiction_id ?? null;
    if (!resolvedJurisdictionId) {
      const { data: root } = await admin
        .from("jurisdictions")
        .select("id")
        .eq("type", "country")
        .limit(1)
        .maybeSingle();
      resolvedJurisdictionId = root?.id ?? null;
    }
    if (!resolvedJurisdictionId) {
      return NextResponse.json(
        { error: "No jurisdiction available" },
        { status: 500 }
      );
    }

    // 1. Insert the proposal (core row)
    const { data: proposal, error: propErr } = await admin
      .from("proposals")
      .insert({
        title:           title.trim(),
        summary_plain:   summary?.trim() ?? null,
        type:            "initiative",
        status:          "introduced",
        jurisdiction_id: resolvedJurisdictionId,
      })
      .select("id")
      .single();

    if (propErr || !proposal) {
      return NextResponse.json(
        { error: "Failed to create initiative" },
        { status: 500 }
      );
    }

    // 2. Insert initiative_details (initiative-specific row)
    const { error: detailErr } = await admin
      .from("initiative_details")
      .insert({
        proposal_id:       proposal.id,
        body_md:           body_md?.trim() ?? "",
        scope,
        issue_area_tags:   Array.isArray(issue_area_tags) ? issue_area_tags : [],
        primary_author_id: user.id,
        stage:             initiativeStage as (typeof VALID_STAGES)[number],
        authorship_type:   "individual",
      });

    if (detailErr) {
      // Roll back the proposal insert on detail failure
      await admin.from("proposals").delete().eq("id", proposal.id);
      return NextResponse.json(
        { error: "Failed to create initiative" },
        { status: 500 }
      );
    }

    return NextResponse.json(
      { initiative: { id: proposal.id, title: title.trim(), stage: initiativeStage } },
      { status: 201 }
    );
  } catch {
    return NextResponse.json(
      { error: "Failed to create initiative" },
      { status: 500 }
    );
  }
}
