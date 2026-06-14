import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";
import { mapRpcError } from "../../../investigations/_lib";

export const dynamic = "force-dynamic";

const RATING_VALUES = new Set([-1, 0, 1]);

// ─── PUT /api/evidence/[id]/rate ──────────────────────────────────────────────
// Body: { agree: -1|0|1, valuable: -1|0|1 }. Two-axis upsert via rate_evidence;
// returns the fresh rating_summary (aggregate only — never other users' ballots).
export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Sign in to rate", code: "not_authenticated" }, { status: 401 });
    }

    const json = (await request.json().catch(() => null)) as { agree?: unknown; valuable?: unknown } | null;
    const agree = json?.agree;
    const valuable = json?.valuable;
    if (
      typeof agree !== "number" || !RATING_VALUES.has(agree) ||
      typeof valuable !== "number" || !RATING_VALUES.has(valuable)
    ) {
      return NextResponse.json({ error: "agree and valuable must each be -1, 0, or 1" }, { status: 400 });
    }

    const { data, error } = await supabase.rpc("rate_evidence", {
      p_evidence_id: params.id,
      p_agree: agree,
      p_valuable: valuable,
    });
    if (error) return mapRpcError(error);

    return NextResponse.json({ ok: true, rating_summary: data ?? {} });
  } catch {
    return NextResponse.json({ error: "Failed to record rating" }, { status: 500 });
  }
}
