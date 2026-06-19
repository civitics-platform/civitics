import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";

export const dynamic = "force-dynamic";

// ─── GET /api/initiatives/[id]/signature-count ────────────────────────────────
// Lightweight count endpoint for client-side polling without fetching full detail.

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);

    // SF-P1 (FIX-572): counts go through count_initiative_signatures, which applies
    // the shared quarantine predicate (author_excluded_from_standing) so synthetic
    // and confirmed-abuse signers never count toward real signature standing.
    const { data, error } = await supabase
      .rpc("count_initiative_signatures", { p_initiative_id: params.id })
      .single();

    if (error) throw error; // never log-and-continue — a swallowed error here mis-reports standing

    return NextResponse.json({
      total: data?.total ?? 0,
      constituent_verified: data?.constituent_verified ?? 0,
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch signature counts" },
      { status: 500 }
    );
  }
}
