import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";
import { mapRpcError, fallbackName } from "../_lib";

export const dynamic = "force-dynamic";

// ─── GET /api/investigations/[id] ─────────────────────────────────────────────
// Detail: the investigation + its evidence cards (each with citations + the
// denormalized rating_summary) + a contributor list. All reads go through the
// caller's client so RLS does the private-person filtering: an un-cleared
// private-person card (and its citations) is invisible to everyone but the author.
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);

    const { data: investigation, error: invErr } = await supabase
      .from("investigations")
      .select(
        "id, title, question, scope_type, scope_id, scope_note, status, findings_md, created_by, is_seeded, is_featured, created_at, updated_at",
      )
      .eq("id", params.id)
      .maybeSingle();
    if (invErr) return NextResponse.json({ error: "Failed to load investigation" }, { status: 500 });
    if (!investigation) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const { data: cards } = await supabase
      .from("evidence_cards")
      .select(
        "id, investigation_id, author_id, claim_text, claim_type, from_type, from_id, to_type, to_id, relationship_kind, status, subject_is_private_person, rating_summary, created_at, updated_at",
      )
      .eq("investigation_id", params.id)
      .order("created_at", { ascending: true });

    const cardRows = cards ?? [];
    const cardIds = cardRows.map((c) => c.id as string);

    // Citations for the visible cards (RLS hides citations of hidden cards too).
    const citationsByCard = new Map<string, unknown[]>();
    if (cardIds.length > 0) {
      const { data: citations } = await supabase
        .from("citations")
        .select("id, evidence_card_id, citation_type, target_type, target_id, external_url, excerpt, created_at")
        .in("evidence_card_id", cardIds);
      for (const c of citations ?? []) {
        const key = c.evidence_card_id as string;
        const list = citationsByCard.get(key) ?? [];
        list.push(c);
        citationsByCard.set(key, list);
      }
    }

    // Contributor list: distinct authors of visible cards + the creator. Resolve
    // display names best-effort; fall back to a presentation-neutral citizen label
    // if the users row is not readable to the caller.
    const contributorIds = Array.from(
      new Set<string>([investigation.created_by as string, ...cardRows.map((c) => c.author_id as string)]),
    );
    const nameById = new Map<string, string>();
    if (contributorIds.length > 0) {
      const { data: users } = await supabase
        .from("users")
        .select("id, display_name")
        .in("id", contributorIds);
      for (const u of users ?? []) {
        const dn = typeof u.display_name === "string" ? u.display_name.trim() : "";
        if (dn) nameById.set(u.id as string, dn);
      }
    }
    const cardCountByAuthor = new Map<string, number>();
    for (const c of cardRows) {
      const a = c.author_id as string;
      cardCountByAuthor.set(a, (cardCountByAuthor.get(a) ?? 0) + 1);
    }
    const contributors = contributorIds.map((id) => ({
      user_id: id,
      name: nameById.get(id) ?? fallbackName(id),
      card_count: cardCountByAuthor.get(id) ?? 0,
      is_creator: id === investigation.created_by,
    }));

    const evidence = cardRows.map((c) => ({
      ...c,
      citations: citationsByCard.get(c.id as string) ?? [],
    }));

    return NextResponse.json({ investigation, evidence, contributors });
  } catch {
    return NextResponse.json({ error: "Failed to load investigation" }, { status: 500 });
  }
}

// ─── PATCH /api/investigations/[id] ───────────────────────────────────────────
// Body: { findings_md?, status? }. Creator-or-admin edits findings / open↔closed;
// archive is admin-only — all enforced in set_investigation_findings.
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Sign in to continue", code: "not_authenticated" }, { status: 401 });
    }

    const json = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!json) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });

    const { findings_md, status } = json;
    if (findings_md !== undefined && findings_md !== null && typeof findings_md !== "string") {
      return NextResponse.json({ error: "Invalid findings_md" }, { status: 400 });
    }
    if (status !== undefined && status !== null && typeof status !== "string") {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }

    const { data, error } = await supabase.rpc("set_investigation_findings", {
      p_investigation_id: params.id,
      p_findings_md: typeof findings_md === "string" ? findings_md : undefined,
      p_new_status: typeof status === "string" ? status : undefined,
    });
    if (error) return mapRpcError(error);

    return NextResponse.json({ ok: true, investigation: data ?? null });
  } catch {
    return NextResponse.json({ error: "Failed to update investigation" }, { status: 500 });
  }
}
