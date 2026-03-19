/**
 * GET /api/search?q=query&type=all|officials|proposals|agencies
 *
 * Universal search across officials, proposals, and agencies.
 * Uses ILIKE with GIN trigram indexes (migration 0008).
 * Runs all three searches in parallel via Promise.all.
 *
 * Returns:
 *   { query, officials[], proposals[], agencies[], total, timing_ms }
 */

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@civitics/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SearchOfficial = {
  id: string;
  full_name: string;
  role_title: string;
  party: string | null;
  state: string | null;
  photo_url: string | null;
  is_active: boolean;
};

export type SearchProposal = {
  id: string;
  title: string;
  status: string;
  type: string;
  comment_period_end: string | null;
  agency_acronym: string | null;
  ai_summary: string | null;
};

export type SearchAgency = {
  id: string;
  name: string;
  acronym: string | null;
  agency_type: string;
  description: string | null;
};

export type SearchResults = {
  query: string;
  officials: SearchOfficial[];
  proposals: SearchProposal[];
  agencies: SearchAgency[];
  total: number;
  timing_ms: number;
};

// ---------------------------------------------------------------------------
// Special query handlers
// ---------------------------------------------------------------------------

const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina",
  ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
  TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
};

const PARTY_KEYWORDS: Record<string, string> = {
  democrat: "democrat", democratic: "democrat", dem: "democrat",
  republican: "republican", rep: "republican", gop: "republican",
  independent: "independent", ind: "independent",
};

const ROLE_KEYWORDS: Record<string, string> = {
  senator: "Senator", senators: "Senator",
  representative: "Representative", representatives: "Representative",
  congressman: "Representative", congresswoman: "Representative",
};

// ---------------------------------------------------------------------------
// Route Handler
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const t0 = Date.now();
  const { searchParams } = req.nextUrl;
  const q = (searchParams.get("q") ?? "").trim();
  const typeFilter = searchParams.get("type") ?? "all";

  // Minimum 2 characters — return empty for very short queries
  if (q.length < 2) {
    return NextResponse.json({
      query: q,
      officials: [],
      proposals: [],
      agencies: [],
      total: 0,
      timing_ms: Date.now() - t0,
    } satisfies SearchResults);
  }

  const db = createAdminClient();
  const qLower = q.toLowerCase();

  // Detect special query patterns
  const stateAbbr = q.length === 2 ? q.toUpperCase() : null;
  const stateName = stateAbbr ? US_STATES[stateAbbr] : null;
  const partyFilter = PARTY_KEYWORDS[qLower];
  const roleFilter = ROLE_KEYWORDS[qLower];

  // ── Officials search ───────────────────────────────────────────────────────
  const searchOfficials = async (): Promise<SearchOfficial[]> => {
    if (typeFilter !== "all" && typeFilter !== "officials") return [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (db as any)
      .from("officials")
      .select("id, full_name, role_title, party, photo_url, is_active, metadata")
      .eq("is_active", true)
      .limit(10);

    if (partyFilter) {
      query = query.eq("party", partyFilter);
    } else if (roleFilter) {
      query = query.eq("role_title", roleFilter);
    } else if (stateName) {
      // State abbreviation search — match officials from that state
      query = query.filter("metadata->>state", "eq", stateAbbr);
    } else {
      // Full-text name search
      query = query.or(`full_name.ilike.%${q}%,role_title.ilike.%${q}%`);
    }

    const { data } = await query.order("full_name");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data ?? []).map((o: any) => ({
      id: o.id,
      full_name: o.full_name,
      role_title: o.role_title,
      party: o.party ?? null,
      state: o.metadata?.state ?? null,
      photo_url: o.photo_url ?? null,
      is_active: o.is_active,
    }));
  };

  // ── Proposals search ───────────────────────────────────────────────────────
  const searchProposals = async (): Promise<SearchProposal[]> => {
    if (typeFilter !== "all" && typeFilter !== "proposals") return [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: proposalData } = await (db as any)
      .from("proposals")
      .select("id, title, status, type, comment_period_end, metadata, summary_plain")
      .or(`title.ilike.%${q}%,summary_plain.ilike.%${q}%`)
      .order("comment_period_end", { ascending: true, nullsFirst: false })
      .limit(10);

    // Fetch AI summaries for matched proposals
    const ids = (proposalData ?? []).map((p: { id: string }) => p.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const summaryRes = ids.length > 0
      ? await (db as any)
          .from("ai_summary_cache")
          .select("entity_id, summary_text")
          .eq("entity_type", "proposal")
          .in("entity_id", ids)
      : { data: [] };

    const summaryMap: Record<string, string> = {};
    for (const s of summaryRes.data ?? []) {
      summaryMap[s.entity_id] = s.summary_text;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (proposalData ?? []).map((p: any) => ({
      id: p.id,
      title: p.title,
      status: p.status,
      type: p.type,
      comment_period_end: p.comment_period_end ?? null,
      agency_acronym: p.metadata?.agency_id ?? null,
      ai_summary: summaryMap[p.id] ?? null,
    }));
  };

  // ── Agencies search ────────────────────────────────────────────────────────
  const searchAgencies = async (): Promise<SearchAgency[]> => {
    if (typeFilter !== "all" && typeFilter !== "agencies") return [];

    // Acronym exact match gets priority — check separately
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: agencyData } = await (db as any)
      .from("agencies")
      .select("id, name, acronym, agency_type, description")
      .eq("is_active", true)
      .or(`name.ilike.%${q}%,acronym.ilike.%${q}%,description.ilike.%${q}%`)
      .order("name")
      .limit(5);

    // Sort: exact acronym match first
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sorted = (agencyData ?? []).sort((a: any, b: any) => {
      const aExact = a.acronym?.toUpperCase() === q.toUpperCase() ? 0 : 1;
      const bExact = b.acronym?.toUpperCase() === q.toUpperCase() ? 0 : 1;
      return aExact - bExact;
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return sorted.map((a: any) => ({
      id: a.id,
      name: a.name,
      acronym: a.acronym ?? null,
      agency_type: a.agency_type,
      description: a.description ?? null,
    }));
  };

  // ── Run in parallel ────────────────────────────────────────────────────────
  const [officials, proposals, agencies] = await Promise.all([
    searchOfficials(),
    searchProposals(),
    searchAgencies(),
  ]);

  const total = officials.length + proposals.length + agencies.length;

  return NextResponse.json({
    query: q,
    officials,
    proposals,
    agencies,
    total,
    timing_ms: Date.now() - t0,
  } satisfies SearchResults);
}
