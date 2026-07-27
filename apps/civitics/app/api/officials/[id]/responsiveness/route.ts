import { NextRequest, NextResponse } from "next/server";
import { createPublicClient } from "@civitics/db";
import { type ResponsivenessData } from "./_lib";
import { withPublicCdnCache } from "@/lib/cdn-cache";

export const dynamic = "force-dynamic";

// PUBLIC, CDN-CACHED (header handler-owned since FIX-796 — withPublicCdnCache
// on the GET 200 only). Per-official public aggregate, zero viewer-dependence;
// built on createPublicClient so that is structural (FIX-788 pattern).
export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const supabase = createPublicClient();

    // The `civic_initiatives` table was dropped at the Supabase cutover
    // (migration 20260422000000): initiatives are now `proposals` (type=
    // 'initiative') with initiative-specific fields in `initiative_details`, and
    // `civic_initiative_responses.initiative_id` was re-pointed to proposals(id).
    // The old `civic_initiatives!initiative_id(...)` embed 500s with PGRST200.
    // Resolve title (proposals) and scope (initiative_details) via a two-step
    // manual fetch — proposals→initiative_details has two FKs so a PostgREST
    // embed is ambiguous (see the votes→proposals two-step precedent in CLAUDE.md).
    const { data: rows, error } = await supabase
      .from("civic_initiative_responses")
      .select(
        "id, initiative_id, response_type, responded_at, window_closes_at, window_opened_at, is_verified_staff"
      )
      .eq("official_id", params.id)
      .order("window_opened_at", { ascending: false })
      .limit(50);

    if (error) {
      return NextResponse.json(
        { error: "Failed to fetch responsiveness data" },
        { status: 500 }
      );
    }

    // Resolve linked-initiative title + scope for the recent list (≤10 rows).
    const initiativeIds = [
      ...new Set(
        ((rows ?? []) as Array<{ initiative_id: string | null }>)
          .map((r) => r.initiative_id)
          .filter((id): id is string => Boolean(id))
      ),
    ];

    const titleById = new Map<string, string>();
    const scopeById = new Map<string, string>();
    if (initiativeIds.length > 0) {
      const [{ data: props }, { data: details }] = await Promise.all([
        supabase.from("proposals").select("id, title").in("id", initiativeIds),
        supabase
          .from("initiative_details")
          .select("proposal_id, scope")
          .in("proposal_id", initiativeIds),
      ]);
      for (const p of (props ?? []) as Array<{ id: string; title: string | null }>) {
        if (p.title) titleById.set(p.id, p.title);
      }
      for (const d of (details ?? []) as Array<{ proposal_id: string; scope: string | null }>) {
        if (d.scope) scopeById.set(d.proposal_id, d.scope);
      }
    }

    const now = new Date();

    let responded    = 0;
    let no_response  = 0;
    let open         = 0;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const r of (rows ?? []) as any[]) {
      if (r.responded_at) {
        responded++;
      } else if (new Date(r.window_closes_at) < now) {
        no_response++;
      } else {
        open++;
      }
    }

    // FIX-905: counts only. The response-rate percentage and the A-F grade
    // derived from it were public scores with no minimum-sample floor — see _lib.ts.
    const total_closed = responded + no_response;

    // Build recent list (most recent first, capped at 10)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recent = ((rows ?? []) as any[]).slice(0, 10).map((r) => ({
      initiative_id:    r.initiative_id as string,
      initiative_title: (titleById.get(r.initiative_id) ?? "Unknown initiative") as string,
      scope:            (scopeById.get(r.initiative_id) ?? "federal") as string,
      response_type:    r.response_type as string,
      responded_at:     r.responded_at as string | null,
      window_closes_at: r.window_closes_at as string,
      window_opened_at: r.window_opened_at as string,
    }));

    const data: ResponsivenessData = {
      responded,
      no_response,
      open,
      total_closed,
      recent,
    };

    return withPublicCdnCache(NextResponse.json(data));
  } catch {
    return NextResponse.json(
      { error: "Failed to compute responsiveness data" },
      { status: 500 }
    );
  }
}
