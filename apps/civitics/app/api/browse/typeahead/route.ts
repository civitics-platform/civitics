/**
 * FIX-769 — the ⌘K / picker typeahead. Replaces the /api/search 8-searcher
 * fan-out as the data source for the GlobalSearch dropdown and the
 * investigations EntitySearchPicker. It is deliberately CHEAP:
 *
 *   - a per-kind trigram match over the materialized entity_search_index
 *     (display_name GIN), ordered by connection_count so prominent entities
 *     surface first, capped at PER_KIND each;
 *   - the same capped financial-individual passthrough executeBrowse uses
 *     (individuals live outside the index);
 *   - NO facet counts, NO get_connection_counts RPC, NO exact totals, NO
 *     per-result enrichment.
 *
 * It returns the SAME SearchResults envelope /api/search did, so the consumers
 * only change their fetch URL — the dropdown UI, keyboard nav, and result
 * mapping (FIX-555) are untouched. `total` reflects the returned rows only.
 */

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@civitics/db";
import type {
  SearchResults, SearchOfficial, SearchProposal, SearchAgency,
  SearchFinancialEntity, SearchJurisdiction, SearchInstitution,
  SearchInitiative, SearchMeeting,
} from "@/lib/search/types";

const PER_KIND = 6;
const INDIV_LIMIT = 4;
const INDIV_SCAN = 200;

// Single literal (not concatenated) so postgrest-js keeps the literal type
// and parses it into a typed row pick.
const SELECT =
  "entity_id, display_name, secondary_label, photo_url, party, state, status, proposal_type, agency_type, financial_type, industry, initiative_stage, institution_type, amount_cents, amount_label, connection_count, activity_at, is_synthetic";

const AMOUNT_LABELS = new Set(["contract", "grant", "donation", "independent_expenditure"]);
function amountLabel(v: unknown): SearchFinancialEntity["amount_label"] {
  return AMOUNT_LABELS.has(v as string) ? (v as SearchFinancialEntity["amount_label"]) : "donation";
}

function emptyResults(query: string): SearchResults {
  return {
    query,
    officials: [], proposals: [], jurisdictions: [], institutions: [],
    agencies: [], financial_entities: [], initiatives: [], meetings: [],
    total: 0,
    totals: {
      officials: 0, proposals: 0, jurisdictions: 0, institutions: 0,
      agencies: 0, financial_entities: 0, initiatives: 0, meetings: 0,
    },
    timing_ms: 0, has_more: false, next_cursor: null,
  };
}

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < 2) return NextResponse.json(emptyResults(q));

  const db = createAdminClient();
  const like = `%${q}%`;

  const forKind = (kind: string) =>
    db.from("entity_search_index")
      .select(SELECT)
      .eq("kind", kind)
      .ilike("display_name", like)
      .order("connection_count", { ascending: false })
      .limit(PER_KIND);

  const [
    officialsRes, proposalsRes, agenciesRes, financialRes,
    jurisdictionsRes, institutionsRes, initiativesRes, meetingsRes, indivRes,
  ] = await Promise.all([
    forKind("official"),
    forKind("proposal"),
    forKind("agency"),
    forKind("financial"),
    forKind("jurisdiction"),
    forKind("institution"),
    forKind("initiative"),
    forKind("meeting"),
    // Individuals live outside the index (FIX-748) — reach them via the
    // FIX-238 canonical_name trigram, ranked in JS to keep a bitmap plan.
    db.from("financial_entities")
      .select("id, display_name, total_donated_cents, is_synthetic")
      .eq("entity_type", "individual")
      .ilike("canonical_name", like)
      .limit(INDIV_SCAN),
  ]);

  const rowsOf = <T>(res: { data: T[] | null }): T[] => res.data ?? [];

  const officials: SearchOfficial[] = rowsOf(officialsRes).map((r) => ({
    id: r.entity_id, full_name: r.display_name, role_title: r.secondary_label ?? "",
    party: r.party ?? null, state: r.state ?? null, photo_url: r.photo_url ?? null,
    is_active: true, relevance_score: 0, connection_count: r.connection_count ?? 0,
    total_received_cents: r.amount_cents ?? null, is_synthetic: r.is_synthetic ?? false,
  }));

  const proposals: SearchProposal[] = rowsOf(proposalsRes).map((r) => ({
    id: r.entity_id, title: r.display_name, status: r.status ?? "", type: r.proposal_type ?? "",
    comment_period_end: null, agency_acronym: r.secondary_label ?? null, ai_summary: null,
    relevance_score: 0, connection_count: r.connection_count ?? 0, is_synthetic: r.is_synthetic ?? false,
  }));

  const agencies: SearchAgency[] = rowsOf(agenciesRes).map((r) => ({
    id: r.entity_id, name: r.display_name, acronym: r.secondary_label ?? null,
    agency_type: r.agency_type ?? "", description: null, relevance_score: 0,
    connection_count: r.connection_count ?? 0, is_synthetic: r.is_synthetic ?? false,
  }));

  const indexFinancial: SearchFinancialEntity[] = rowsOf(financialRes).map((r) => ({
    id: r.entity_id, name: r.display_name, entity_type: r.financial_type ?? "",
    industry: r.industry ?? null, total_amount_cents: r.amount_cents ?? null,
    amount_label: amountLabel(r.amount_label), relevance_score: 0,
    connection_count: r.connection_count ?? 0, is_synthetic: r.is_synthetic ?? false,
  }));
  const individuals: SearchFinancialEntity[] = rowsOf(indivRes)
    .sort((a, b) => (b.total_donated_cents ?? 0) - (a.total_donated_cents ?? 0))
    .slice(0, INDIV_LIMIT)
    .map((r) => ({
      id: r.id, name: r.display_name, entity_type: "individual", industry: null,
      total_amount_cents: r.total_donated_cents ?? null, amount_label: "donation",
      relevance_score: 0, connection_count: 0, is_synthetic: r.is_synthetic ?? false,
    }));
  const financial_entities = [...indexFinancial, ...individuals].slice(0, PER_KIND);

  const jurisdictions: SearchJurisdiction[] = rowsOf(jurisdictionsRes).map((r) => ({
    id: r.entity_id, name: r.display_name, short_name: null,
    jurisdiction_type: r.secondary_label ?? "", relevance_score: 0,
    connection_count: r.connection_count ?? 0, is_synthetic: r.is_synthetic ?? false,
  }));

  const institutions: SearchInstitution[] = rowsOf(institutionsRes).map((r) => ({
    id: r.entity_id, name: r.display_name, short_name: null,
    institution_type: r.institution_type ?? r.secondary_label ?? "", is_active: true,
    relevance_score: 0, connection_count: r.connection_count ?? 0, is_synthetic: r.is_synthetic ?? false,
  }));

  const initiatives: SearchInitiative[] = rowsOf(initiativesRes).map((r) => ({
    id: r.entity_id, title: r.display_name, stage: r.initiative_stage ?? null,
    status: r.status ?? "", relevance_score: 0, connection_count: r.connection_count ?? 0,
  }));

  const meetings: SearchMeeting[] = rowsOf(meetingsRes).map((r) => ({
    id: r.entity_id, title: r.display_name, scheduled_at: r.activity_at ?? null,
    meeting_type: r.secondary_label ?? "", status: r.status ?? "", governing_body_name: null,
    relevance_score: 0, connection_count: r.connection_count ?? 0,
  }));

  const totals = {
    officials: officials.length, proposals: proposals.length, jurisdictions: jurisdictions.length,
    institutions: institutions.length, agencies: agencies.length,
    financial_entities: financial_entities.length, initiatives: initiatives.length, meetings: meetings.length,
  };
  const total = Object.values(totals).reduce((a, b) => a + b, 0);

  const body: SearchResults = {
    query: q, officials, proposals, jurisdictions, institutions, agencies,
    financial_entities, initiatives, meetings, total, totals, timing_ms: 0,
    has_more: false, next_cursor: null,
  };

  return NextResponse.json(body, {
    headers: { "Cache-Control": "public, max-age=0, s-maxage=30, stale-while-revalidate=60" },
  });
}
