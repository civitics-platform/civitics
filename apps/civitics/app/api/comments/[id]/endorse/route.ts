import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";

export const dynamic = "force-dynamic";

// ─── POST /api/comments/[id]/endorse ──────────────────────────────────────────
// Q&A v2 PR-2b (FIX-B): a verified answerer endorses (or withdraws endorsement of)
// a community note. Body: { endorsed: boolean }.
//
// The SECURITY DEFINER set_community_note_endorsement RPC is the single
// enforcement point (auth, the community_note + visibility checks, and the
// active-answerer grant). It is called with the CALLER's JWT via
// createServerClient so auth.uid() resolves inside the function. RPC error codes
// map to HTTP status the same way the comment write path does:
//   28000 → 401 (auth)      42501 → 403 (not the answerer)
//   42704 → 404 (not a note) 22023 → 400 (hidden / validation)
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Sign in to endorse" }, { status: 401 });

    const json = (await request.json().catch(() => null)) as { endorsed?: unknown } | null;
    if (!json || typeof json.endorsed !== "boolean") {
      return NextResponse.json({ error: "endorsed must be a boolean" }, { status: 400 });
    }

    const { data, error } = await supabase.rpc("set_community_note_endorsement", {
      p_note_id: params.id,
      p_endorsed: json.endorsed,
    });

    if (error) {
      const msg = error.message || "Failed to endorse";
      switch (error.code) {
        case "28000":
          return NextResponse.json({ error: "Sign in to endorse" }, { status: 401 });
        case "42501":
          return NextResponse.json({ error: msg }, { status: 403 });
        case "42704":
          return NextResponse.json({ error: msg }, { status: 404 });
        case "22023":
          return NextResponse.json({ error: msg }, { status: 400 });
        default:
          return NextResponse.json({ error: "Failed to endorse" }, { status: 500 });
      }
    }

    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Failed to endorse" }, { status: 500 });
  }
}
