// Investigations MVP PR2 (FIX-579) — server-only SSR loaders for the index +
// case-file pages. RLS does the visibility work: reads go through the CALLER's
// cookie client (createServerClient), so an un-cleared private-person card is
// invisible to everyone but its author (PR1 RLS). Contributor / author display
// names are resolved with the SHARED comments admin resolver (fetchNameMap) — the
// same server-side pattern the comment list uses to bypass the own-row users RLS
// without leaking email — never a new SECURITY DEFINER resolver, never citizen-<id>.

// Server-only by construction: imports next/headers cookies(), which throws if
// ever evaluated in a client bundle.
import { cookies } from "next/headers";
import { createServerClient, createAdminClient } from "@civitics/db";
import { withDbTimeout } from "@/lib/supabase-check";
import { fetchAuthorMeta } from "../../api/comments/_lib";
import { fetchChunkedByIds } from "@/lib/paginate";
import type {
  Investigation,
  EvidenceCard,
  Citation,
  Contributor,
  EvidenceRatingSummary,
  EvidenceViewerRating,
} from "./presentation";

const INVESTIGATION_COLS =
  "id, title, question, scope_type, scope_id, scope_note, status, findings_md, created_by, is_seeded, is_featured, is_synthetic, created_at, updated_at";

const CARD_COLS =
  "id, investigation_id, author_id, claim_text, claim_type, from_type, from_id, to_type, to_id, relationship_kind, status, subject_is_private_person, rating_summary, created_at, updated_at";

const CITATION_COLS =
  "id, evidence_card_id, citation_type, target_type, target_id, external_url, excerpt, created_at";

function normSummary(raw: unknown): EvidenceRatingSummary {
  const s = (raw ?? {}) as Record<string, unknown>;
  return {
    agree_up: Number(s.agree_up ?? 0),
    agree_down: Number(s.agree_down ?? 0),
    valuable_up: Number(s.valuable_up ?? 0),
    valuable_down: Number(s.valuable_down ?? 0),
  };
}

export type InvestigationListItem = {
  investigation: Investigation;
  evidence_count: number;
  contributor_count: number;
};

// Index list: featured/seeded first (is_featured DESC), then newest. Counts are
// visibility-correct — RLS already hid un-cleared private-person cards from
// non-authors, so they don't inflate the per-row evidence/contributor counts.
export async function listInvestigations(): Promise<InvestigationListItem[]> {
  const cookieStore = await cookies();
  const supabase = createServerClient(cookieStore);

  const { data: rows } = await withDbTimeout(
    supabase
      .from("investigations")
      .select(INVESTIGATION_COLS)
      .order("is_featured", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(100),
    3000,
    "investigations:list",
  );

  const investigations = (rows ?? []) as unknown as Investigation[];
  if (investigations.length === 0) return [];

  // .in() bounded: the investigations read above carries an explicit limit
  // (100 for the list, `limit` for the home strip), max 100 — FIX-902
  const ids = investigations.map((i) => i.id);
  const { data: cards } = await withDbTimeout(
    supabase
      .from("evidence_cards")
      .select("investigation_id, author_id")
      .in("investigation_id", ids),
    3000,
    "investigations:list-cards",
  );

  const evidenceCount = new Map<string, number>();
  const authorSet = new Map<string, Set<string>>();
  for (const c of (cards ?? []) as Array<{ investigation_id: string; author_id: string }>) {
    evidenceCount.set(c.investigation_id, (evidenceCount.get(c.investigation_id) ?? 0) + 1);
    const set = authorSet.get(c.investigation_id) ?? new Set<string>();
    set.add(c.author_id);
    authorSet.set(c.investigation_id, set);
  }

  return investigations.map((inv) => {
    const authors = authorSet.get(inv.id) ?? new Set<string>();
    authors.add(inv.created_by); // the creator is always a contributor ("crew")
    return {
      investigation: inv,
      evidence_count: evidenceCount.get(inv.id) ?? 0,
      contributor_count: authors.size,
    };
  });
}

// ── Homepage band (FIX-711) ────────────────────────────────────────────────
// Reuses the index query shape (same investigations + evidence_cards tables,
// same anon-readable cookie-client reads, same is_featured DESC / created_at
// DESC ordering) but capped to a handful of rows for the homepage budget, plus
// a third capped read for the per-file citation count the mockup asks for. No
// new MV/RPC. Synthetic case files are INCLUDED and labeled by the caller — the
// homepage surfaces Franklin's seeded files with the SYNTHETIC mark (SF-P2),
// never excluded.
export type HomeInvestigation = {
  id: string;
  title: string;
  /** the investigative question — the one-line summary shown on the card */
  summary: string | null;
  status: Investigation["status"];
  isSynthetic: boolean;
  evidenceCount: number;
  citationCount: number;
};

export async function listInvestigationsForHome(limit = 4): Promise<HomeInvestigation[]> {
  const cookieStore = await cookies();
  const supabase = createServerClient(cookieStore);

  const { data: rows } = await withDbTimeout(
    supabase
      .from("investigations")
      .select("id, title, question, status, is_synthetic")
      .order("is_featured", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(limit),
    3000,
    "investigations:home",
  );
  const investigations = (rows ?? []) as unknown as Array<{
    id: string;
    title: string;
    question: string | null;
    status: Investigation["status"];
    is_synthetic: boolean | null;
  }>;
  if (investigations.length === 0) return [];

  // .in() bounded: the investigations read above carries an explicit limit
  // (100 for the list, `limit` for the home strip), max 100 — FIX-902
  const ids = investigations.map((i) => i.id);
  const { data: cards } = await withDbTimeout(
    supabase.from("evidence_cards").select("id, investigation_id").in("investigation_id", ids),
    3000,
    "investigations:home-cards",
  );
  const cardRows = (cards ?? []) as Array<{ id: string; investigation_id: string }>;

  const evidenceCount = new Map<string, number>();
  const investigationByCard = new Map<string, string>();
  for (const c of cardRows) {
    evidenceCount.set(c.investigation_id, (evidenceCount.get(c.investigation_id) ?? 0) + 1);
    investigationByCard.set(c.id, c.investigation_id);
  }

  // Citation count rolls up citations → their card → the card's investigation.
  const citationCount = new Map<string, number>();
  // FIX-902: chunked. `cardIds` is every evidence card across the investigations
  // on this page — no per-investigation cap, so a handful of well-evidenced case
  // files clears 200 on its own. A 414 zeroes the citation count on every card.
  const cardIds = cardRows.map((c) => c.id);
  if (cardIds.length > 0) {
    const { rows: cites, complete } = await fetchChunkedByIds<{ evidence_card_id: string }>(
      cardIds,
      (ids, { label }) =>
        withDbTimeout(
          supabase.from("citations").select("evidence_card_id").in("evidence_card_id", ids),
          3000,
          label,
        ),
      { label: "investigations:home-citations" },
    );
    if (!complete) console.warn("investigations:home-citations — partial read; citation counts understated");
    for (const ct of cites) {
      const invId = investigationByCard.get(ct.evidence_card_id);
      if (!invId) continue;
      citationCount.set(invId, (citationCount.get(invId) ?? 0) + 1);
    }
  }

  return investigations.map((inv) => ({
    id: inv.id,
    title: inv.title,
    summary: inv.question,
    status: inv.status,
    isSynthetic: inv.is_synthetic ?? false,
    evidenceCount: evidenceCount.get(inv.id) ?? 0,
    citationCount: citationCount.get(inv.id) ?? 0,
  }));
}

export type CaseFile = {
  investigation: Investigation;
  evidence: EvidenceCard[];
  contributors: Contributor[];
};

export async function loadCaseFile(id: string): Promise<CaseFile | null> {
  const cookieStore = await cookies();
  const supabase = createServerClient(cookieStore);

  const { data: invRow } = await withDbTimeout(
    supabase
      .from("investigations")
      .select(INVESTIGATION_COLS)
      .eq("id", id)
      .maybeSingle(),
    3000,
    "investigations:case-file",
  );
  if (!invRow) return null;
  const investigation = invRow as unknown as Investigation;

  const { data: cardRows } = await withDbTimeout(
    supabase
      .from("evidence_cards")
      .select(CARD_COLS)
      .eq("investigation_id", id)
      .order("created_at", { ascending: true }),
    3000,
    "investigations:case-file-cards",
  );
  const cards = (cardRows ?? []) as unknown as Array<Omit<EvidenceCard, "author_name" | "citations" | "rating_summary" | "my_rating"> & {
    rating_summary: unknown;
  }>;

  // FIX-902: chunked (this list and the viewer-ratings read below). The card
  // read above is scoped to one investigation but has no `.limit()`, so a large
  // case file blows the URL bound and every card renders with zero citations
  // and an unset rating control — on an HTTP 200.
  const cardIds = cards.map((c) => c.id);
  const citationsByCard = new Map<string, Citation[]>();
  if (cardIds.length > 0) {
    const { rows: citations, complete } = await fetchChunkedByIds<Citation>(
      cardIds,
      (ids, { label }) =>
        withDbTimeout(
          supabase.from("citations").select(CITATION_COLS).in("evidence_card_id", ids),
          3000,
          label,
        ),
      { label: "investigations:case-file-citations" },
    );
    if (!complete) console.warn("investigations:case-file-citations — partial read; some cards show no sources");
    for (const c of citations) {
      const list = citationsByCard.get(c.evidence_card_id) ?? [];
      list.push(c);
      citationsByCard.set(c.evidence_card_id, list);
    }
  }

  // FIX-801: seed each card's rating control with the viewer's OWN ballot so a
  // rated card stays selected across reloads (same own-state class as FIX-798,
  // but this substrate is per-viewer SSR, not an edge-cached list, so we read it
  // here instead of via the /api/viewer/engagement overlay). RLS
  // (evidence_ratings_select_own) scopes the read to the caller's rows; anon
  // callers get an empty map and every card falls back to zeros.
  const myRatingByCard = new Map<string, EvidenceViewerRating>();
  if (cardIds.length > 0) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const { rows: mine, complete } = await fetchChunkedByIds<{
        evidence_id: string;
        agree: number | null;
        valuable: number | null;
      }>(
        cardIds,
        (ids, { label }) =>
          withDbTimeout(
            supabase.from("evidence_ratings").select("evidence_id, agree, valuable").in("evidence_id", ids),
            3000,
            label,
          ),
        { label: "investigations:case-file-my-ratings" },
      );
      if (!complete) {
        console.warn("investigations:case-file-my-ratings — partial read; some cards lose the viewer's own ballot");
      }
      for (const r of mine) {
        myRatingByCard.set(r.evidence_id, {
          agree: r.agree ?? 0,
          valuable: r.valuable ?? 0,
        });
      }
    }
  }

  // Resolve crew + author display names via the shared admin resolver.
  const contributorIds = Array.from(
    new Set<string>([investigation.created_by, ...cards.map((c) => c.author_id)]),
  );
  const admin = createAdminClient();
  const metaMap = await fetchAuthorMeta(admin as never, contributorIds);

  const evidence: EvidenceCard[] = cards.map((c) => ({
    ...c,
    author_name: metaMap.get(c.author_id)?.name ?? "",
    author_is_synthetic: metaMap.get(c.author_id)?.isSynthetic ?? false,
    rating_summary: normSummary(c.rating_summary),
    my_rating: myRatingByCard.get(c.id) ?? { agree: 0, valuable: 0 },
    citations: (citationsByCard.get(c.id) ?? []).sort(
      (a, b) => a.created_at.localeCompare(b.created_at),
    ),
  }));

  const cardCountByAuthor = new Map<string, number>();
  for (const c of cards) cardCountByAuthor.set(c.author_id, (cardCountByAuthor.get(c.author_id) ?? 0) + 1);

  const contributors: Contributor[] = contributorIds.map((uid) => ({
    user_id: uid,
    name: metaMap.get(uid)?.name ?? "",
    card_count: cardCountByAuthor.get(uid) ?? 0,
    is_creator: uid === investigation.created_by,
    is_synthetic: metaMap.get(uid)?.isSynthetic ?? false,
  }));

  return { investigation, evidence, contributors };
}

export type ViewerCapState = {
  signedIn: boolean;
  openCount: number;
  /** MAX_OPEN_INVESTIGATIONS_PER_USER (mirrors PR1; new-account halving + the
   *  daily cap are still enforced server-side and surfaced via the 429). */
  cap: number;
};

export async function viewerCapState(): Promise<ViewerCapState> {
  const cookieStore = await cookies();
  const supabase = createServerClient(cookieStore);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { signedIn: false, openCount: 0, cap: 3 };

  const { count } = await withDbTimeout(
    supabase
      .from("investigations")
      .select("id", { count: "exact", head: true })
      .eq("created_by", user.id)
      .eq("status", "open"),
    3000,
    "investigations:viewer-cap",
  );

  return { signedIn: true, openCount: count ?? 0, cap: 3 };
}
