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
import { fetchNameMap } from "../../api/comments/_lib";
import type {
  Investigation,
  EvidenceCard,
  Citation,
  Contributor,
  EvidenceRatingSummary,
} from "./presentation";

const INVESTIGATION_COLS =
  "id, title, question, scope_type, scope_id, scope_note, status, findings_md, created_by, is_seeded, is_featured, created_at, updated_at";

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

  const { data: rows } = await supabase
    .from("investigations")
    .select(INVESTIGATION_COLS)
    .order("is_featured", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(100);

  const investigations = (rows ?? []) as unknown as Investigation[];
  if (investigations.length === 0) return [];

  const ids = investigations.map((i) => i.id);
  const { data: cards } = await supabase
    .from("evidence_cards")
    .select("investigation_id, author_id")
    .in("investigation_id", ids);

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

export type CaseFile = {
  investigation: Investigation;
  evidence: EvidenceCard[];
  contributors: Contributor[];
};

export async function loadCaseFile(id: string): Promise<CaseFile | null> {
  const cookieStore = await cookies();
  const supabase = createServerClient(cookieStore);

  const { data: invRow } = await supabase
    .from("investigations")
    .select(INVESTIGATION_COLS)
    .eq("id", id)
    .maybeSingle();
  if (!invRow) return null;
  const investigation = invRow as unknown as Investigation;

  const { data: cardRows } = await supabase
    .from("evidence_cards")
    .select(CARD_COLS)
    .eq("investigation_id", id)
    .order("created_at", { ascending: true });
  const cards = (cardRows ?? []) as unknown as Array<Omit<EvidenceCard, "author_name" | "citations" | "rating_summary"> & {
    rating_summary: unknown;
  }>;

  const cardIds = cards.map((c) => c.id);
  const citationsByCard = new Map<string, Citation[]>();
  if (cardIds.length > 0) {
    const { data: citations } = await supabase
      .from("citations")
      .select(CITATION_COLS)
      .in("evidence_card_id", cardIds);
    for (const c of (citations ?? []) as unknown as Citation[]) {
      const list = citationsByCard.get(c.evidence_card_id) ?? [];
      list.push(c);
      citationsByCard.set(c.evidence_card_id, list);
    }
  }

  // Resolve crew + author display names via the shared admin resolver.
  const contributorIds = Array.from(
    new Set<string>([investigation.created_by, ...cards.map((c) => c.author_id)]),
  );
  const admin = createAdminClient();
  const nameMap = await fetchNameMap(admin as never, contributorIds);

  const evidence: EvidenceCard[] = cards.map((c) => ({
    ...c,
    author_name: nameMap.get(c.author_id) ?? "",
    rating_summary: normSummary(c.rating_summary),
    citations: (citationsByCard.get(c.id) ?? []).sort(
      (a, b) => a.created_at.localeCompare(b.created_at),
    ),
  }));

  const cardCountByAuthor = new Map<string, number>();
  for (const c of cards) cardCountByAuthor.set(c.author_id, (cardCountByAuthor.get(c.author_id) ?? 0) + 1);

  const contributors: Contributor[] = contributorIds.map((uid) => ({
    user_id: uid,
    name: nameMap.get(uid) ?? "",
    card_count: cardCountByAuthor.get(uid) ?? 0,
    is_creator: uid === investigation.created_by,
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

  const { count } = await supabase
    .from("investigations")
    .select("id", { count: "exact", head: true })
    .eq("created_by", user.id)
    .eq("status", "open");

  return { signedIn: true, openCount: count ?? 0, cap: 3 };
}
