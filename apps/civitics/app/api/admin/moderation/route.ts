import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient, createAdminClient } from "@civitics/db";
import { fetchChunkedByIds } from "@/lib/paginate";

export const dynamic = "force-dynamic";

type ContentType = "civic_comment" | "official_community_comment";

// Admin guard. Matches the convention used in /api/admin/* routes.
async function requireAdmin(): Promise<string | null> {
  const adminEmail = process.env["ADMIN_EMAIL"];
  if (!adminEmail) return null;

  const cookieStore = await cookies();
  const supabase = createServerClient(cookieStore);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || user.email !== adminEmail) return null;
  return user.id;
}

// ── Investigations PR3 (FIX-585): endpoint-name resolver for evidence-card from/to ──
// Resolves the (type,id) endpoints of a batch of edge cards to display names so the
// admin review queue reads as "X --kind--> Y" rather than raw UUIDs. Bounded by the
// queue size (≤100 cards → ≤200 endpoints), one query per endpoint type.
async function resolveEndpointNames(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  pairs: { type: string | null; id: string | null }[],
): Promise<Map<string, string>> {
  const byType = new Map<string, Set<string>>();
  for (const p of pairs) {
    if (!p.type || !p.id) continue;
    const set = byType.get(p.type) ?? new Set<string>();
    set.add(p.id);
    byType.set(p.type, set);
  }
  const out = new Map<string, string>(); // key `${type}:${id}` → name
  const specs: Record<string, { table: string; col: string }> = {
    official: { table: "officials", col: "full_name" },
    financial_entity: { table: "financial_entities", col: "display_name" },
    agency: { table: "agencies", col: "name" },
    governing_body: { table: "governing_bodies", col: "name" },
  };
  await Promise.all(
    [...byType.entries()].map(async ([type, ids]) => {
      const spec = specs[type];
      if (!spec) return;
      // FIX-902: chunked. Callers pass BOTH endpoints of every card in the
      // queue — the card reads are capped at 100 each but there are two of
      // them, so a single type bucket can hold ~400 ids, past the URL bound.
      // Unresolved endpoints render as blank names in the moderation queue.
      const { rows: data, complete } = await fetchChunkedByIds<Record<string, string>>(
        [...ids],
        (chunk) => db.from(spec.table).select(`id, ${spec.col}`).in("id", chunk),
        { label: `moderation:endpoint-names:${type}` },
      );
      if (!complete) console.warn(`[admin/moderation] endpoint name read incomplete for ${type}`);
      for (const r of data) out.set(`${type}:${r.id}`, r[spec.col] ?? "");
    }),
  );
  return out;
}

// GET /api/admin/moderation?queue=comments|promotion|disputes&resolved=0|1
export async function GET(request: NextRequest) {
  const adminId = await requireAdmin();
  if (!adminId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const queue = request.nextUrl.searchParams.get("queue") ?? "comments";
  const resolved = request.nextUrl.searchParams.get("resolved") === "1";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;

  // ── Promotion-review queue (FIX-585) ────────────────────────────────────────
  // Corroborated edge cards awaiting an admin promote/reject, PLUS promoted cards
  // that have since accrued unresolved disputes (decision 7 — they surface here for
  // manual review rather than auto-unpromoting).
  if (queue === "promotion") {
    const { data: corroborated } = await db
      .from("evidence_cards")
      .select(
        "id, investigation_id, claim_text, claim_type, from_type, from_id, to_type, to_id, relationship_kind, status, subject_is_private_person, created_at",
      )
      .eq("claim_type", "edge")
      .eq("status", "corroborated")
      .order("created_at", { ascending: false })
      .limit(100);

    // Promoted cards carrying ≥1 unresolved investigation_evidence flag.
    const { data: openFlags } = await db
      .from("content_flags")
      .select("content_id")
      .eq("content_type", "investigation_evidence")
      .eq("resolved", false);
    const flaggedIds = Array.from(new Set((openFlags ?? []).map((f: { content_id: string }) => f.content_id)));
    let flaggedPromoted: unknown[] = [];
    if (flaggedIds.length > 0) {
      const { data } = await db
        .from("evidence_cards")
        .select(
          "id, investigation_id, claim_text, claim_type, from_type, from_id, to_type, to_id, relationship_kind, status, subject_is_private_person, created_at",
        )
        .eq("status", "promoted")
        .in("id", flaggedIds);
      flaggedPromoted = data ?? [];
    }

    const cards = [...(corroborated ?? []), ...flaggedPromoted] as Array<{
      id: string;
      investigation_id: string;
      from_type: string | null;
      from_id: string | null;
      to_type: string | null;
      to_id: string | null;
    }>;

    // Hydrate: investigation title, citation count, corroboration count, endpoint names.
    // .in() bounded (this and the flagged/citation reads around it): both card
    // sources are `.limit(100)`, so cards is ≤200 and every list derived from it
    // is ≤200. resolveEndpointNames is the exception — it takes TWO endpoints
    // per card, so it chunks — FIX-902
    const invIds = Array.from(new Set(cards.map((c) => c.investigation_id)));
    const cardIds = cards.map((c) => c.id);
    const titleById = new Map<string, string>();
    if (invIds.length > 0) {
      const { data: invs } = await db.from("investigations").select("id, title").in("id", invIds);
      for (const i of invs ?? []) titleById.set(i.id, i.title);
    }
    const citeCount = new Map<string, number>();
    if (cardIds.length > 0) {
      const { data: cites } = await db.from("citations").select("evidence_card_id").in("evidence_card_id", cardIds);
      for (const c of cites ?? []) citeCount.set(c.evidence_card_id, (citeCount.get(c.evidence_card_id) ?? 0) + 1);
    }
    const names = await resolveEndpointNames(
      db,
      cards.flatMap((c) => [
        { type: c.from_type, id: c.from_id },
        { type: c.to_type, id: c.to_id },
      ]),
    );
    const corrByCard = new Map<string, number>();
    await Promise.all(
      cardIds.map(async (id) => {
        const { data } = await db.rpc("count_independent_corroborations", { p_card_id: id });
        corrByCard.set(id, Number(data ?? 0));
      }),
    );

    const hydrated = cards.map((c) => ({
      ...c,
      investigation_title: titleById.get(c.investigation_id) ?? "",
      from_name: c.from_id ? names.get(`${c.from_type}:${c.from_id}`) ?? "" : "",
      to_name: c.to_id ? names.get(`${c.to_type}:${c.to_id}`) ?? "" : "",
      citation_count: citeCount.get(c.id) ?? 0,
      corroboration_count: corrByCard.get(c.id) ?? 0,
    }));

    return NextResponse.json({ cards: hydrated });
  }

  // ── Disputes queue (FIX-585) ─────────────────────────────────────────────────
  // investigation_evidence flags; hydrate the flagged card body + investigation title.
  if (queue === "disputes") {
    const { data: flags } = await db
      .from("content_flags")
      .select("id, content_type, content_id, user_id, reason, note, resolved, created_at")
      .eq("content_type", "investigation_evidence")
      .eq("resolved", resolved)
      .order("created_at", { ascending: false })
      .limit(100);
    const flagRows = (flags ?? []) as Array<{ id: string; content_id: string }>;

    // .in() bounded: the flags read above is `.limit(100)`, so this and the
    // invIds derived from it are ≤100 — FIX-902
    const cardIds = Array.from(new Set(flagRows.map((f) => f.content_id)));
    const cardById = new Map<string, Record<string, unknown>>();
    if (cardIds.length > 0) {
      const { data: cards } = await db
        .from("evidence_cards")
        .select("id, investigation_id, claim_text, status, from_type, to_type, relationship_kind")
        .in("id", cardIds);
      const invIds = Array.from(new Set((cards ?? []).map((c: { investigation_id: string }) => c.investigation_id)));
      const titleById = new Map<string, string>();
      if (invIds.length > 0) {
        const { data: invs } = await db.from("investigations").select("id, title").in("id", invIds);
        for (const i of invs ?? []) titleById.set(i.id, i.title);
      }
      for (const c of cards ?? []) {
        cardById.set(c.id, { ...c, investigation_title: titleById.get(c.investigation_id) ?? "" });
      }
    }

    const hydrated = flagRows.map((f) => ({ ...f, card: cardById.get(f.content_id) ?? null }));
    return NextResponse.json({ flags: hydrated });
  }

  // ── Comments queue (default — unchanged from the original moderation surface) ──
  const { data: flags } = await db
    .from("content_flags")
    .select(
      "id, content_type, content_id, user_id, reason, note, resolved, resolved_at, resolved_by, action_taken, created_at",
    )
    .in("content_type", ["civic_comment", "official_community_comment"])
    .eq("resolved", resolved)
    .order("created_at", { ascending: false })
    .limit(100);

  const flagRows: Array<{
    id: string;
    content_type: ContentType;
    content_id: string;
    user_id: string;
    reason: string;
    note: string | null;
    resolved: boolean;
    resolved_at: string | null;
    resolved_by: string | null;
    action_taken: string | null;
    created_at: string;
  }> = flags ?? [];

  const civicIds = flagRows
    .filter((f) => f.content_type === "civic_comment")
    .map((f) => f.content_id);
  // .in() bounded (this, civicIds above, and authorIds below): the comment-flag
  // queue read is `.limit(100)`, so the two content-type splits sum to ≤100 and
  // the author set derived from them is ≤100 — FIX-902
  const officialIds = flagRows
    .filter((f) => f.content_type === "official_community_comment")
    .map((f) => f.content_id);

  const civicLookup = new Map<
    string,
    { body: string; proposal_id: string | null; user_id: string; is_deleted: boolean }
  >();
  const officialLookup = new Map<
    string,
    { body: string; official_id: string; user_id: string; is_deleted: boolean }
  >();

  if (civicIds.length > 0) {
    const { data } = await db
      .from("civic_comments")
      .select("id, body, proposal_id, user_id, is_deleted")
      .in("id", civicIds);
    for (const r of data ?? []) {
      civicLookup.set(r.id, {
        body:        r.body,
        proposal_id: r.proposal_id,
        user_id:     r.user_id,
        is_deleted:  r.is_deleted,
      });
    }
  }

  if (officialIds.length > 0) {
    const { data } = await db
      .from("official_community_comments")
      .select("id, body, official_id, user_id, is_deleted")
      .in("id", officialIds);
    for (const r of data ?? []) {
      officialLookup.set(r.id, {
        body:        r.body,
        official_id: r.official_id,
        user_id:     r.user_id,
        is_deleted:  r.is_deleted,
      });
    }
  }

  // SF-P1 (FIX-572): moderation half of the quarantine — exclude SYNTHETIC authors
  // only. Confirmed-abuse and real authors are RETAINED (a real person's post still
  // needs human review, even on a synthetic entity — the moderation floor applies in
  // the sandbox). Behavior-neutral today (no synthetic authors exist yet).
  const authorIds = Array.from(
    new Set([
      ...[...civicLookup.values()].map((v) => v.user_id),
      ...[...officialLookup.values()].map((v) => v.user_id),
    ]),
  );
  const syntheticAuthors = new Set<string>();
  if (authorIds.length > 0) {
    const { data: synthRows, error: synthErr } = await db
      .from("users")
      .select("id")
      .in("id", authorIds)
      .eq("is_synthetic", true);
    if (synthErr) throw synthErr; // never swallow — a failure here must not silently surface synthetic content
    for (const u of synthRows ?? []) syntheticAuthors.add(u.id);
  }

  const hydrated = flagRows
    .map((f) => {
      const content =
        f.content_type === "civic_comment"
          ? civicLookup.get(f.content_id) ?? null
          : officialLookup.get(f.content_id) ?? null;
      return { ...f, content };
    })
    .filter((row) => !row.content || !syntheticAuthors.has(row.content.user_id));

  return NextResponse.json({ flags: hydrated });
}

// POST /api/admin/moderation
// Comments:        { flag_id, action: 'dismiss' | 'delete' }              (unchanged)
// Investigation:   { card_id, action: 'promote'|'reject'|'unpromote'|'clear'|'dismiss_flags' }
//   promote → promote_evidence_edge; reject → reject_evidence_edge (+ resolve flags);
//   unpromote → unpromote_evidence_edge; clear → clear_private_person_card;
//   dismiss_flags → resolve the card's unresolved investigation_evidence flags only.
export async function POST(request: NextRequest) {
  const adminId = await requireAdmin();
  if (!adminId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  let body: { flag_id?: string; card_id?: string; action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;

  // ── Investigation actions (card_id-keyed) ────────────────────────────────────
  if (body.card_id) {
    const action = body.action;
    const RPC: Record<string, string> = {
      promote: "promote_evidence_edge",
      reject: "reject_evidence_edge",
      unpromote: "unpromote_evidence_edge",
      clear: "clear_private_person_card",
    };
    if (action === "dismiss_flags") {
      await db
        .from("content_flags")
        .update({ resolved: true, resolved_at: new Date().toISOString(), resolved_by: adminId, action_taken: "dismiss" })
        .eq("content_type", "investigation_evidence")
        .eq("content_id", body.card_id)
        .eq("resolved", false);
      return NextResponse.json({ ok: true });
    }
    const fn = action ? RPC[action] : undefined;
    if (!fn) {
      return NextResponse.json(
        { error: "action must be promote|reject|unpromote|clear|dismiss_flags" },
        { status: 400 },
      );
    }
    const { error } = await db.rpc(fn, { p_card_id: body.card_id, p_actor_id: adminId });
    if (error) {
      // The RPCs RAISE a clean SQLSTATE for not-found (42704) / wrong-state (42501).
      const status = error.code === "42704" ? 404 : error.code === "42501" ? 409 : 400;
      return NextResponse.json({ error: error.message ?? "Action failed" }, { status });
    }
    // On reject, also resolve any open flags so the card leaves the dispute queue.
    if (action === "reject") {
      await db
        .from("content_flags")
        .update({ resolved: true, resolved_at: new Date().toISOString(), resolved_by: adminId, action_taken: "reject" })
        .eq("content_type", "investigation_evidence")
        .eq("content_id", body.card_id)
        .eq("resolved", false);
    }
    return NextResponse.json({ ok: true });
  }

  // ── Comment actions (flag_id-keyed — unchanged) ──────────────────────────────
  if (!body.flag_id || (body.action !== "dismiss" && body.action !== "delete")) {
    return NextResponse.json(
      { error: "flag_id and action (dismiss|delete) are required" },
      { status: 400 }
    );
  }

  const { data: flag } = await db
    .from("content_flags")
    .select("id, content_type, content_id, resolved")
    .eq("id", body.flag_id)
    .single();

  if (!flag) {
    return NextResponse.json({ error: "Flag not found" }, { status: 404 });
  }
  if (flag.resolved) {
    return NextResponse.json({ error: "Already resolved" }, { status: 400 });
  }

  if (body.action === "delete") {
    const table =
      flag.content_type === "civic_comment"
        ? "civic_comments"
        : "official_community_comments";
    await db.from(table).update({ is_deleted: true }).eq("id", flag.content_id);
  }

  await db
    .from("content_flags")
    .update({
      resolved:     true,
      resolved_at:  new Date().toISOString(),
      resolved_by:  adminId,
      action_taken: body.action,
    })
    .eq("content_type", flag.content_type)
    .eq("content_id", flag.content_id)
    .eq("resolved", false);

  return NextResponse.json({ ok: true });
}
