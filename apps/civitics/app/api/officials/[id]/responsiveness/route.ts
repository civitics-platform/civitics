import { NextRequest, NextResponse } from "next/server";
import { createPublicClient } from "@civitics/db";
import { gradeFromRate, type ResponsivenessData } from "./_lib";
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

    const { data: rows, error } = await supabase
      .from("civic_initiative_responses")
      .select(
        "id, initiative_id, response_type, responded_at, window_closes_at, window_opened_at, is_verified_staff, civic_initiatives!initiative_id(id, title, scope)"
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

    const total_closed = responded + no_response;
    const response_rate = total_closed > 0
      ? Math.round((responded / total_closed) * 100)
      : null;
    const grade = response_rate !== null ? gradeFromRate(response_rate) : null;

    // Build recent list (most recent first, capped at 10)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recent = ((rows ?? []) as any[]).slice(0, 10).map((r) => ({
      initiative_id:    r.initiative_id as string,
      initiative_title: (r.civic_initiatives?.title ?? "Unknown initiative") as string,
      scope:            (r.civic_initiatives?.scope ?? "federal") as string,
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
      response_rate,
      grade,
      recent,
    };

    return withPublicCdnCache(NextResponse.json(data));
  } catch {
    return NextResponse.json(
      { error: "Failed to compute responsiveness score" },
      { status: 500 }
    );
  }
}
