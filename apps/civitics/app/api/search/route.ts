/**
 * GET /api/search
 *
 * @deprecated FIX-769 — the search/browse redesign (W0–W3) retired this
 * 8-searcher fan-out. No live consumer remains: /search renders the W1 explorer
 * + FIX-767 landing over /api/browse; the ⌘K GlobalSearch and the investigations
 * EntitySearchPicker now read /api/browse/typeahead; the only other callers
 * (AdvancedSearchPage, packages/graph EntityBrowse) are already-unmounted legacy
 * components tracked for retirement in FIX-773 (the W3 consolidated cleanup,
 * with FIX-753 / FIX-765). The route + its exported SearchResults types stay until
 * those components are deleted — do NOT delete here (no-deletion standing rule).
 * NOTE: /api/search/entity is NOT deprecated — the detail rail still uses it
 * (FIX-751 decision 7).
 *
 * Params:
 *   q               — text query (optional; omit for browse mode)
 *   type            — all|officials|proposals|jurisdictions|institutions|agencies|financial|initiatives|meetings
 *   cursor          — opaque pagination cursor (base64 JSON {offset})
 *   limit           — override per-page size (max 50, default PAGE_SIZE)
 *   sort            — relevance|name_asc|name_desc|connections_desc|amount_desc
 *
 * Official filters:    party, state, chamber (senate|house), is_active, official_role
 * Proposal filters:    status, proposal_type, date_from, date_to
 * Agency filters:      agency_type
 * Financial filters:   entity_type, financial_type, industry, min_amount, max_amount (USD)
 * Initiative filters:  initiative_stage
 *
 * Returns SearchResults
 */

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, fetchIndustryTagsByEntityId } from "@civitics/db";

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
  relevance_score: number;
  connection_count: number;
  total_received_cents: number | null;
  is_synthetic: boolean;
};

export type SearchProposal = {
  id: string;
  title: string;
  status: string;
  type: string;
  comment_period_end: string | null;
  agency_acronym: string | null;
  ai_summary: string | null;
  relevance_score: number;
  connection_count: number;
  is_synthetic: boolean;
};

export type SearchAgency = {
  id: string;
  name: string;
  acronym: string | null;
  agency_type: string;
  description: string | null;
  relevance_score: number;
  connection_count: number;
  is_synthetic: boolean;
};

export type SearchFinancialEntity = {
  id: string;
  name: string;
  entity_type: string;
  industry: string | null;
  total_amount_cents: number | null;
  amount_label: "contract" | "grant" | "donation" | "independent_expenditure";
  relevance_score: number;
  connection_count: number;
  is_synthetic: boolean;
};

export type SearchInitiative = {
  id: string;
  title: string;
  stage: string | null;
  status: string;
  relevance_score: number;
  connection_count: number;
};

export type SearchJurisdiction = {
  id: string;
  name: string;
  short_name: string | null;
  jurisdiction_type: string;
  relevance_score: number;
  connection_count: number;
  is_synthetic: boolean;
};

// Institutions search is governing-bodies-only (the agencies section covers the
// agency half of the public.institutions view, so querying the view here would
// double-list agencies in the "all" tab). Deep-links to /institutions/[id],
// which resolves a governing_body id via the institutions view (FIX-442).
export type SearchInstitution = {
  id: string;
  name: string;
  short_name: string | null;
  institution_type: string;
  is_active: boolean;
  relevance_score: number;
  connection_count: number;
  is_synthetic: boolean;
};

export type SearchMeeting = {
  id: string;
  title: string;
  scheduled_at: string | null;
  meeting_type: string;
  status: string;
  governing_body_name: string | null;
  relevance_score: number;
  connection_count: number;
  // NOTE: the `meetings` table has NO is_synthetic column (FIX-572 added it to
  // officials/proposals/agencies/governing_bodies/jurisdictions/financial_entities
  // only), so meetings carry no synthetic mark.
};

export type SearchResults = {
  query: string;
  officials: SearchOfficial[];
  proposals: SearchProposal[];
  jurisdictions: SearchJurisdiction[];
  institutions: SearchInstitution[];
  agencies: SearchAgency[];
  financial_entities: SearchFinancialEntity[];
  initiatives: SearchInitiative[];
  meetings: SearchMeeting[];
  total: number;
  totals: {
    officials: number;
    proposals: number;
    jurisdictions: number;
    institutions: number;
    agencies: number;
    financial_entities: number;
    initiatives: number;
    meetings: number;
  };
  timing_ms: number;
  has_more: boolean;
  next_cursor: string | null;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 20;

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

// jurisdiction_level → jurisdiction.type[] — shared by officials, jurisdictions,
// and institutions searchers (FIX-442).
const LEVEL_TYPE_MAP: Record<string, string[]> = {
  federal: ["country"],
  state:   ["state"],
  local:   ["county", "city", "district", "precinct", "other"],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseRelevance(name: string, q: string): number {
  const nameLower = name.toLowerCase();
  const qLower = q.toLowerCase();
  if (nameLower === qLower) return 100;
  if (nameLower.startsWith(qLower)) return 80;
  const wordBoundary = new RegExp(`\\b${qLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  if (wordBoundary.test(name)) return 60;
  if (nameLower.includes(qLower)) return 40;
  return 0;
}

const DESC_SCORE = 20;

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset })).toString("base64");
}

function decodeCursor(cursor: string): number {
  try {
    return (JSON.parse(Buffer.from(cursor, "base64").toString("utf-8")) as { offset?: number }).offset ?? 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Migration guard — cached for the lifetime of this function instance.
// When the spending columns don't exist yet (pre-migration), the financial
// entity select falls back to total_donated_cents only.
// ---------------------------------------------------------------------------

let _spendingColsAvailable: boolean | null = null;

async function checkSpendingCols(db: ReturnType<typeof createAdminClient>): Promise<boolean> {
  if (_spendingColsAvailable !== null) return _spendingColsAvailable;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (db as any).from("financial_entities").select("total_contract_cents").limit(1);
  _spendingColsAvailable = !error;
  return _spendingColsAvailable;
}

// FIX-666/FIX-667: IE (Schedule E) totals were added in a later migration than
// the spending columns, so probe them independently — there's a brief window
// where total_contract_cents exists but the IE columns don't.
let _ieColsAvailable: boolean | null = null;

async function checkIeCols(db: ReturnType<typeof createAdminClient>): Promise<boolean> {
  if (_ieColsAvailable !== null) return _ieColsAvailable;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (db as any).from("financial_entities").select("total_ie_support_cents").limit(1);
  _ieColsAvailable = !error;
  return _ieColsAvailable;
}

// ---------------------------------------------------------------------------
// Route Handler
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const t0 = Date.now();
  const sp = req.nextUrl.searchParams;

  const q = (sp.get("q") ?? "").trim();
  const typeFilter = sp.get("type") ?? "all";
  const cursor = sp.get("cursor") ?? null;
  const offset = cursor ? decodeCursor(cursor) : 0;
  const limitParam = parseInt(sp.get("limit") ?? String(PAGE_SIZE));
  const pageSize = Math.min(isNaN(limitParam) ? PAGE_SIZE : limitParam, 50);
  const sortParam = sp.get("sort") ?? "relevance";

  // Explicit filter params — officials
  const filterParty            = sp.get("party")              ?? null;
  const filterState            = sp.get("state")              ?? null;
  const filterChamber          = sp.get("chamber")            ?? null;
  const filterIsActive         = sp.get("is_active")          !== "false";
  const filterOfficialRole     = sp.get("official_role")      ?? null; // congress|judiciary|cabinet|state_gov
  const filterJurisdictionLevel = sp.get("jurisdiction_level") ?? null; // federal|state|local

  // Explicit filter params — proposals
  const filterStatus       = sp.get("status")        ?? null;
  const filterProposalType = sp.get("proposal_type") ?? null;
  const filterDateFrom     = sp.get("date_from")     ?? null;
  const filterDateTo       = sp.get("date_to")       ?? null;

  // Explicit filter params — agencies
  const filterAgencyType = sp.get("agency_type") ?? null;

  // Explicit filter params — financial
  const filterEntityType     = sp.get("entity_type")    ?? sp.get("financial_type") ?? null;
  const filterIndustry       = sp.get("industry")       ?? null;
  const filterMinAmountCents = sp.get("min_amount")  ? Number(sp.get("min_amount")) * 100 : null;
  const filterMaxAmountCents = sp.get("max_amount")  ? Number(sp.get("max_amount")) * 100 : null;

  // Explicit filter params — initiatives
  const filterInitiativeStage = sp.get("initiative_stage") ?? null;

  const db = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db2 = db as any;
  const qLower = q.toLowerCase();

  // Text-based heuristics (skipped when explicit filter covers the same dimension)
  const stateAbbr  = !filterState  && q.length === 2 ? q.toUpperCase() : null;
  const stateMatch = stateAbbr && US_STATES[stateAbbr] ? stateAbbr : null;
  const partyMatch = !filterParty   ? (PARTY_KEYWORDS[qLower] ?? null) : null;
  const roleMatch  = !filterChamber ? (ROLE_KEYWORDS[qLower] ?? null)  : null;

  // Filter group booleans — used to type-scope "all" tab results
  const hasOfficialFilters  = !!(filterParty || filterChamber || filterState || filterOfficialRole || filterJurisdictionLevel);
  const hasProposalFilters  = !!(filterStatus || filterProposalType || filterDateFrom || filterDateTo);
  const hasAgencyFilters    = !!filterAgencyType;
  const hasFinancialFilters = !!(filterEntityType || filterIndustry || filterMinAmountCents || filterMaxAmountCents);
  const hasInitiativeFilters = !!filterInitiativeStage;
  // jurisdiction_level scopes officials, jurisdictions, AND institutions in the
  // "all" tab (FIX-442); meetings have no dedicated filter dimension.
  const hasJurisdictionFilters = !!filterJurisdictionLevel;
  const hasInstitutionFilters  = !!filterJurisdictionLevel;
  const hasMeetingFilters      = false;
  const anyTypeFilter = hasOfficialFilters || hasProposalFilters || hasAgencyFilters || hasFinancialFilters || hasInitiativeFilters || hasJurisdictionFilters || hasInstitutionFilters;

  // Always use cursor pagination; "all" tab now supports infinite scroll
  const isPaginated = true;
  const fetchLimit  = pageSize + 1;

  // Batch connection count helper
  async function getConnectionCounts(ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const { data } = await db2.rpc("get_connection_counts", { entity_ids: ids });
    const map = new Map<string, number>();
    for (const r of (data ?? []) as Array<{ entity_id: string; connection_count: number | string }>) {
      map.set(r.entity_id, Number(r.connection_count));
    }
    return map;
  }

  // Apply sort order to a list of results that all have a name field and connection_count
  function applySort<T extends { connection_count: number; relevance_score: number }>(
    rows: T[],
    getName: (r: T) => string,
  ): T[] {
    if (sortParam === "name_asc")         return [...rows].sort((a, b) => getName(a).localeCompare(getName(b)));
    if (sortParam === "name_desc")        return [...rows].sort((a, b) => getName(b).localeCompare(getName(a)));
    if (sortParam === "connections_desc") return [...rows].sort((a, b) => b.connection_count - a.connection_count);
    return rows; // relevance and amount_desc handled elsewhere or are default
  }

  // ── Officials ──────────────────────────────────────────────────────────────
  const searchOfficials = async (): Promise<{ results: SearchOfficial[]; hasMore: boolean; total_count: number }> => {
    if (typeFilter !== "all" && typeFilter !== "officials") return { results: [], hasMore: false, total_count: 0 };
    if (typeFilter === "all" && anyTypeFilter && !hasOfficialFilters) return { results: [], hasMore: false, total_count: 0 };

    let qb = db2
      .from("officials")
      .select("id, full_name, role_title, party, photo_url, is_active, metadata, source_ids, total_received_cents, is_synthetic", { count: "exact" });

    if (filterIsActive && !filterOfficialRole) qb = qb.eq("is_active", true);
    if (filterParty)    qb = qb.eq("party", filterParty);
    if (filterState)    qb = qb.filter("metadata->>state", "eq", filterState);
    if (filterChamber === "senate") qb = qb.eq("role_title", "Senator");
    if (filterChamber === "house")  qb = qb.ilike("role_title", "Representative%");

    // official_role filter — uses a subquery on governing_bodies
    if (filterOfficialRole && filterOfficialRole !== "congress") {
      const gbTypeMap: Record<string, string> = {
        judiciary: "judicial",
        cabinet:   "executive",
        state_gov: "legislature_upper",
      };
      const gbType = gbTypeMap[filterOfficialRole];
      if (gbType) {
        const { data: gbRows } = await db2
          .from("governing_bodies")
          .select("id")
          .eq("type", gbType);
        const ids = (gbRows ?? []).map((g: { id: string }) => g.id);
        if (ids.length === 0) return { results: [], hasMore: false, total_count: 0 };
        qb = qb.in("governing_body_id", ids);
      }
    }

    // jurisdiction_level filter — two-step subquery: jurisdiction.type → governing_body → official
    if (filterJurisdictionLevel) {
      const jTypes = LEVEL_TYPE_MAP[filterJurisdictionLevel];
      if (jTypes) {
        const { data: jRows } = await db2.from("jurisdictions").select("id").in("type", jTypes);
        const jIds = (jRows ?? []).map((j: { id: string }) => j.id);
        if (jIds.length === 0) return { results: [], hasMore: false, total_count: 0 };
        const { data: gbRows } = await db2.from("governing_bodies").select("id").in("jurisdiction_id", jIds);
        const gbIds = (gbRows ?? []).map((g: { id: string }) => g.id);
        if (gbIds.length === 0) return { results: [], hasMore: false, total_count: 0 };
        qb = qb.in("governing_body_id", gbIds);
      }
    }

    if (q.length >= 2) {
      if (!filterParty && partyMatch) {
        qb = qb.eq("party", partyMatch);
      } else if (!filterChamber && roleMatch) {
        qb = qb.eq("role_title", roleMatch);
      } else if (!filterState && stateMatch) {
        qb = qb.filter("metadata->>state", "eq", stateMatch);
      } else if (!filterParty && !filterChamber && !filterState) {
        qb = qb.or(`full_name.ilike.%${q}%,role_title.ilike.%${q}%`);
      }
    }

    qb = qb.order("full_name", { ascending: true }).range(offset, offset + fetchLimit - 1);

    const { data, count: totalCount } = await qb;
    const rows: Array<{
      id: string; full_name: string; role_title: string; party: string | null;
      photo_url: string | null; is_active: boolean; total_received_cents: number | null;
      is_synthetic: boolean;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      metadata: any; source_ids: Record<string, string> | null;
    }> = data ?? [];

    if (rows.length === 0) return { results: [], hasMore: false, total_count: 0 };

    const hasMore = rows.length > pageSize;
    const resultRows = rows.slice(0, pageSize);
    const countMap = await getConnectionCounts(resultRows.map((r) => r.id));

    const results = resultRows.map((o) => {
      const connCount = countMap.get(o.id) ?? 0;
      const isFederal = !!o.source_ids?.["congress_gov"];
      let score = q.length >= 2 ? baseRelevance(o.full_name, q) : 50;
      if (score === 0) score = DESC_SCORE;
      if (isFederal) score += 15;
      if (o.is_active) score += 10;
      if (connCount > 100) score += 5;
      return {
        id: o.id, full_name: o.full_name, role_title: o.role_title,
        party: o.party ?? null, state: o.metadata?.state ?? null,
        photo_url: o.photo_url ?? null, is_active: o.is_active,
        relevance_score: Math.min(score, 100),
        connection_count: connCount,
        total_received_cents: o.total_received_cents ?? null,
        is_synthetic: o.is_synthetic ?? false,
      };
    });
    return { results: applySort(results, (r) => r.full_name), hasMore, total_count: totalCount ?? 0 };
  };

  // ── Proposals ──────────────────────────────────────────────────────────────
  const searchProposals = async (): Promise<{ results: SearchProposal[]; hasMore: boolean; total_count: number }> => {
    if (typeFilter !== "all" && typeFilter !== "proposals") return { results: [], hasMore: false, total_count: 0 };
    if (typeFilter === "all" && anyTypeFilter && !hasProposalFilters) return { results: [], hasMore: false, total_count: 0 };

    let qb = db2
      .from("proposals")
      // FIX-503: total_count is display-only ("about N results"); hasMore is
      // computed from the page rows, not the count. 'planned' uses the planner
      // estimate and avoids a full count over the proposals q-search.
      .select("id, title, status, type, metadata, summary_plain, is_synthetic", { count: "planned" })
      .neq("type", "initiative");

    // comment_period_end is metadata-only post-cutover (no top-level column);
    // metadata->>comment_period_end is backed by an expression index (FIX-359).
    // ISO-8601 dates compare correctly as text, so the text comparison stays
    // index-backed (FIX-425).
    if (filterStatus)       qb = qb.eq("status", filterStatus);
    if (filterProposalType) qb = qb.eq("type", filterProposalType);
    if (filterDateFrom)     qb = qb.gte("metadata->>comment_period_end", filterDateFrom);
    if (filterDateTo)       qb = qb.lte("metadata->>comment_period_end", filterDateTo);

    if (q.length >= 2) {
      // FIX-504: FTS over proposals.search_vector (title A / short_title B /
      // summary_plain C) instead of summary_plain ILIKE '%q%'. ILIKE seq-scanned
      // (no trgm on summary_plain; prod cost 20063); websearch uses the restored
      // proposals_search_vector GIN. Match semantics change from substring to
      // whole-word lexeme ("healthc" no longer matches "healthcare"), with
      // websearch syntax (quoted "phrases", -exclusion) now supported.
      qb = qb.textSearch("search_vector", q, { type: "websearch", config: "english" });
    }

    qb = qb.order("metadata->>comment_period_end", { ascending: false, nullsFirst: false })
           .range(offset, offset + fetchLimit - 1);

    const { data: proposalData, count: totalCount } = await qb;
    const rows = proposalData ?? [];
    if (rows.length === 0) return { results: [], hasMore: false, total_count: 0 };

    const hasMore = rows.length > pageSize;
    const resultRows = rows.slice(0, pageSize);

    const ids = resultRows.map((p: { id: string }) => p.id);
    const [summaryRes, countMap] = await Promise.all([
      ids.length > 0
        ? db2.from("ai_summary_cache").select("entity_id, summary_text")
             .eq("entity_type", "proposal").in("entity_id", ids)
        : Promise.resolve({ data: [] }),
      getConnectionCounts(ids),
    ]);
    const summaryMap: Record<string, string> = {};
    for (const s of summaryRes.data ?? []) summaryMap[s.entity_id] = s.summary_text;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = resultRows.map((p: any) => {
      let score = q.length >= 2 ? baseRelevance(p.title, q) : 50;
      if (score === 0) score = DESC_SCORE;
      if (p.status === "open_comment") score += 10;
      return {
        id: p.id, title: p.title, status: p.status, type: p.type,
        comment_period_end: p.metadata?.comment_period_end ?? null,
        agency_acronym: p.metadata?.agency_id ?? null,
        ai_summary: summaryMap[p.id] ?? null,
        relevance_score: Math.min(score, 100),
        connection_count: countMap.get(p.id) ?? 0,
        is_synthetic: p.is_synthetic ?? false,
      };
    });
    return { results: applySort(results, (r) => r.title), hasMore, total_count: totalCount ?? 0 };
  };

  // ── Agencies ───────────────────────────────────────────────────────────────
  const searchAgencies = async (): Promise<{ results: SearchAgency[]; hasMore: boolean; total_count: number }> => {
    if (typeFilter !== "all" && typeFilter !== "agencies") return { results: [], hasMore: false, total_count: 0 };
    if (typeFilter === "all" && anyTypeFilter && !hasAgencyFilters) return { results: [], hasMore: false, total_count: 0 };

    let qb = db2
      .from("agencies")
      .select("id, name, acronym, agency_type, description, is_synthetic", { count: "exact" })
      .eq("is_active", true);

    if (filterAgencyType) qb = qb.eq("agency_type", filterAgencyType);

    if (q.length >= 2) {
      qb = qb.or(`name.ilike.%${q}%,acronym.ilike.%${q}%,description.ilike.%${q}%`);
    }

    qb = qb.order("name", { ascending: true }).range(offset, offset + fetchLimit - 1);

    const { data: agencyData, count: totalCount } = await qb;
    const rows = agencyData ?? [];
    if (rows.length === 0) return { results: [], hasMore: false, total_count: 0 };

    const hasMore = rows.length > pageSize;
    const resultRows = rows.slice(0, pageSize);
    const countMap = await getConnectionCounts(resultRows.map((a: { id: string }) => a.id));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = resultRows.map((a: any) => {
      const exactAcronym = a.acronym?.toUpperCase() === q.toUpperCase();
      let score = q.length >= 2 ? baseRelevance(a.name, q) : 50;
      if (score === 0) score = DESC_SCORE;
      if (exactAcronym) score += 20;
      return {
        id: a.id, name: a.name, acronym: a.acronym ?? null,
        agency_type: a.agency_type, description: a.description ?? null,
        relevance_score: Math.min(score, 100),
        connection_count: countMap.get(a.id) ?? 0,
        is_synthetic: a.is_synthetic ?? false,
      };
    }).sort((a: SearchAgency, b: SearchAgency) => b.relevance_score - a.relevance_score);
    return { results: applySort(results, (r) => r.name), hasMore, total_count: totalCount ?? 0 };
  };

  // ── Financial entities ─────────────────────────────────────────────────────
  const searchFinancialEntities = async (): Promise<{ results: SearchFinancialEntity[]; hasMore: boolean; total_count: number }> => {
    if (typeFilter !== "all" && typeFilter !== "financial") return { results: [], hasMore: false, total_count: 0 };
    if (typeFilter === "all" && anyTypeFilter && !hasFinancialFilters) return { results: [], hasMore: false, total_count: 0 };

    const [spendingCols, ieCols] = await Promise.all([checkSpendingCols(db), checkIeCols(db)]);
    const ieSelect = ieCols ? ", total_ie_support_cents, total_ie_oppose_cents" : "";
    const selectCols = (spendingCols
      ? "id, display_name, entity_type, total_donated_cents, total_contract_cents, total_grant_cents, is_synthetic"
      : "id, display_name, entity_type, total_donated_cents, is_synthetic") + ieSelect;

    let qb = db2
      .from("financial_entities")
      // FIX-503: total_count is display-only; 'planned' uses the planner estimate
      // instead of an exact count over a multi-million-row table.
      .select(selectCols, { count: "planned" });

    // FIX-236: individuals are surfaced whenever the user is actively
    // searching or filtering. The only time we exclude them is the
    // landing browse view (no query, no industry/amount filter) — where
    // including 540K individual rows would crowd out the PAC/corp/union
    // diversity in the default "amount_desc" sort.
    const isBrowseMode =
      q.length < 2 &&
      !filterIndustry &&
      !filterMinAmountCents &&
      !filterMaxAmountCents;

    if (filterEntityType) {
      qb = qb.eq("entity_type", filterEntityType);
    } else if (isBrowseMode) {
      qb = qb.neq("entity_type", "individual");
    }
    // else: query or other filter active → all entity_types, individuals included

    if (filterMinAmountCents) qb = qb.gte("total_donated_cents", filterMinAmountCents);
    if (filterMaxAmountCents) qb = qb.lte("total_donated_cents", filterMaxAmountCents);

    if (filterIndustry) {
      const { data: tagRows } = await db2
        .from("entity_tags")
        // FIX-503: industry tags are stored as lowercase slugs (real_estate,
        // oil_gas, …). An exact .eq matches the same rows as the prior case-
        // insensitive .ilike but uses idx_entity_tags_tag(tag,tag_category)
        // instead of a seq scan / filter.
        .select("entity_id")
        .eq("tag_category", "industry")
        .eq("tag", filterIndustry.toLowerCase());
      const tagIds = (tagRows ?? []).map((r: { entity_id: string }) => r.entity_id);
      if (tagIds.length === 0) return { results: [], hasMore: false, total_count: 0 };
      qb = qb.in("id", tagIds);
    }

    if (q.length >= 2) {
      // FIX-238: canonical_name is the unified search target. Individual donor
      // canonical_name is now stored in natural "FIRST [MI] LAST" form by the
      // pipeline (canonicalDonorName in indiv.ts), backed by the trgm GIN
      // financial_entities_canonical_trgm. Non-individual canonical_name has
      // corporate suffixes stripped, so it's a good trigram target there too.
      // No more LAST-FIRST reversal fallback (the FIX-236 workaround).
      qb = qb.ilike("canonical_name", `%${q}%`);
    }

    if (sortParam === "amount_desc" || (!q && !filterIndustry)) {
      qb = qb.order("total_donated_cents", { ascending: false, nullsFirst: false });
    }

    qb = qb.range(offset, offset + fetchLimit - 1);

    const { data, count: totalCount } = await qb;
    const rows = data ?? [];
    if (rows.length === 0) return { results: [], hasMore: false, total_count: 0 };

    const hasMore = rows.length > pageSize;
    const resultRows = rows.slice(0, pageSize);
    const [industryByEntityId, countMap] = await Promise.all([
      fetchIndustryTagsByEntityId(db, resultRows.map((f: { id: string }) => f.id)),
      getConnectionCounts(resultRows.map((f: { id: string }) => f.id)),
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = resultRows.map((f: any) => {
      const contractCents = (f.total_contract_cents as number | null | undefined) ?? 0;
      const grantCents    = (f.total_grant_cents    as number | null | undefined) ?? 0;
      const donationCents = (f.total_donated_cents  as number | null) ?? 0;
      const ieCents       = ((f.total_ie_support_cents as number | null | undefined) ?? 0)
                          + ((f.total_ie_oppose_cents  as number | null | undefined) ?? 0);
      const spendingCents = contractCents + grantCents;

      // Precedence (FIX-667): independent expenditures dominate when present —
      // an IE-only super PAC makes no direct donations, so its "spending" IS its
      // Schedule E outlay. Gated on IE>0 (not entity_type) because FEC committee
      // type 'U' falls through to entity_type='other'. Then the existing rule:
      // corps/orgs show federal spending; everyone else shows donations.
      const showIe       = ieCents > 0;
      const showSpending = !showIe && spendingCents > 0 &&
        (f.entity_type === "corporation" || f.entity_type === "organization");
      const dominantAmount = showIe ? ieCents : showSpending ? spendingCents : donationCents;
      const amountLabel: SearchFinancialEntity["amount_label"] = showIe
        ? "independent_expenditure"
        : showSpending
          ? (contractCents >= grantCents ? "contract" : "grant")
          : "donation";

      let score = q.length >= 2 ? baseRelevance(f.display_name, q) : 50;
      if (dominantAmount > 100_000_00) score += 5;
      return {
        id: f.id, name: f.display_name, entity_type: f.entity_type,
        industry: industryByEntityId.get(f.id)?.display_label ?? null,
        total_amount_cents: dominantAmount || null,
        amount_label: amountLabel,
        relevance_score: Math.min(score, 100),
        connection_count: countMap.get(f.id) ?? 0,
        is_synthetic: f.is_synthetic ?? false,
      };
    });
    return { results: applySort(results, (r) => r.name), hasMore, total_count: totalCount ?? 0 };
  };

  // ── Initiatives ────────────────────────────────────────────────────────────
  const searchInitiatives = async (): Promise<{ results: SearchInitiative[]; hasMore: boolean; total_count: number }> => {
    if (typeFilter !== "all" && typeFilter !== "initiatives") return { results: [], hasMore: false, total_count: 0 };
    if (typeFilter === "all" && anyTypeFilter && !hasInitiativeFilters) return { results: [], hasMore: false, total_count: 0 };

    let qb = db2
      .from("proposals")
      .select("id, title, status, initiative_details!initiative_details_proposal_id_fkey!inner(stage)", { count: "exact" })
      .eq("type", "initiative");

    if (filterInitiativeStage) {
      qb = qb.eq("initiative_details.stage", filterInitiativeStage);
    } else if (typeFilter === "initiatives") {
      // Default: active stages only
      qb = qb.in("initiative_details.stage", ["deliberate", "mobilise", "draft"]);
    }

    if (filterStatus) qb = qb.eq("status", filterStatus);

    if (q.length >= 2) {
      qb = qb.ilike("title", `%${q}%`);
    }

    qb = qb.order("title", { ascending: true }).range(offset, offset + fetchLimit - 1);

    const { data, count: totalCount } = await qb;
    const rows = data ?? [];
    if (rows.length === 0) return { results: [], hasMore: false, total_count: 0 };

    const hasMore = rows.length > pageSize;
    const resultRows = rows.slice(0, pageSize);
    const countMap = await getConnectionCounts(resultRows.map((r: { id: string }) => r.id));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = resultRows.map((r: any) => {
      const stage = r.initiative_details?.[0]?.stage ?? r.initiative_details?.stage ?? null;
      let score = q.length >= 2 ? baseRelevance(r.title, q) : 50;
      if (score === 0) score = DESC_SCORE;
      if (stage === "mobilise") score += 10;
      return {
        id: r.id, title: r.title, stage, status: r.status,
        relevance_score: Math.min(score, 100),
        connection_count: countMap.get(r.id) ?? 0,
      };
    });
    return { results: applySort(results, (r) => r.title), hasMore, total_count: totalCount ?? 0 };
  };

  // ── Jurisdictions ────────────────────────────────────────────────────────────
  const searchJurisdictions = async (): Promise<{ results: SearchJurisdiction[]; hasMore: boolean; total_count: number }> => {
    if (typeFilter !== "all" && typeFilter !== "jurisdictions") return { results: [], hasMore: false, total_count: 0 };
    if (typeFilter === "all" && anyTypeFilter && !hasJurisdictionFilters) return { results: [], hasMore: false, total_count: 0 };

    let qb = db2
      .from("jurisdictions")
      .select("id, name, short_name, type, is_active, is_synthetic", { count: "exact" });

    if (filterJurisdictionLevel) {
      const jTypes = LEVEL_TYPE_MAP[filterJurisdictionLevel];
      if (jTypes) qb = qb.in("type", jTypes);
    }

    if (q.length >= 2) {
      qb = qb.or(`name.ilike.%${q}%,short_name.ilike.%${q}%`);
    }

    qb = qb.order("name", { ascending: true }).range(offset, offset + fetchLimit - 1);

    const { data, count: totalCount } = await qb;
    const rows = data ?? [];
    if (rows.length === 0) return { results: [], hasMore: false, total_count: 0 };

    const hasMore = rows.length > pageSize;
    const resultRows = rows.slice(0, pageSize);
    const countMap = await getConnectionCounts(resultRows.map((r: { id: string }) => r.id));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = resultRows.map((j: any) => {
      const exactShort = j.short_name?.toUpperCase() === q.toUpperCase();
      let score = q.length >= 2 ? baseRelevance(j.name, q) : 50;
      if (score === 0) score = DESC_SCORE;
      if (exactShort) score += 20;
      return {
        id: j.id, name: j.name, short_name: j.short_name ?? null,
        jurisdiction_type: j.type,
        relevance_score: Math.min(score, 100),
        connection_count: countMap.get(j.id) ?? 0,
        is_synthetic: j.is_synthetic ?? false,
      };
    });
    return { results: applySort(results, (r) => r.name), hasMore, total_count: totalCount ?? 0 };
  };

  // ── Institutions (governing bodies only — agencies covered by searchAgencies) ─
  const searchInstitutions = async (): Promise<{ results: SearchInstitution[]; hasMore: boolean; total_count: number }> => {
    if (typeFilter !== "all" && typeFilter !== "institutions") return { results: [], hasMore: false, total_count: 0 };
    if (typeFilter === "all" && anyTypeFilter && !hasInstitutionFilters) return { results: [], hasMore: false, total_count: 0 };

    let qb = db2
      .from("governing_bodies")
      .select("id, name, short_name, type, is_active, jurisdiction_id, is_synthetic", { count: "exact" });

    // jurisdiction_level filter — jurisdiction.type → jurisdiction_id → governing_body
    if (filterJurisdictionLevel) {
      const jTypes = LEVEL_TYPE_MAP[filterJurisdictionLevel];
      if (jTypes) {
        const { data: jRows } = await db2.from("jurisdictions").select("id").in("type", jTypes);
        const jIds = (jRows ?? []).map((j: { id: string }) => j.id);
        if (jIds.length === 0) return { results: [], hasMore: false, total_count: 0 };
        qb = qb.in("jurisdiction_id", jIds);
      }
    }

    if (q.length >= 2) {
      qb = qb.or(`name.ilike.%${q}%,short_name.ilike.%${q}%`);
    }

    qb = qb.order("name", { ascending: true }).range(offset, offset + fetchLimit - 1);

    const { data, count: totalCount } = await qb;
    const rows = data ?? [];
    if (rows.length === 0) return { results: [], hasMore: false, total_count: 0 };

    const hasMore = rows.length > pageSize;
    const resultRows = rows.slice(0, pageSize);
    const countMap = await getConnectionCounts(resultRows.map((r: { id: string }) => r.id));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = resultRows.map((g: any) => {
      const exactShort = g.short_name?.toUpperCase() === q.toUpperCase();
      let score = q.length >= 2 ? baseRelevance(g.name, q) : 50;
      if (score === 0) score = DESC_SCORE;
      if (exactShort) score += 20;
      if (g.is_active) score += 5;
      return {
        id: g.id, name: g.name, short_name: g.short_name ?? null,
        institution_type: g.type, is_active: g.is_active,
        relevance_score: Math.min(score, 100),
        connection_count: countMap.get(g.id) ?? 0,
        is_synthetic: g.is_synthetic ?? false,
      };
    });
    return { results: applySort(results, (r) => r.name), hasMore, total_count: totalCount ?? 0 };
  };

  // ── Meetings (search-page only — kept out of the nav dropdown) ────────────────
  const searchMeetings = async (): Promise<{ results: SearchMeeting[]; hasMore: boolean; total_count: number }> => {
    if (typeFilter !== "all" && typeFilter !== "meetings") return { results: [], hasMore: false, total_count: 0 };
    if (typeFilter === "all" && anyTypeFilter && !hasMeetingFilters) return { results: [], hasMore: false, total_count: 0 };

    let qb = db2
      .from("meetings")
      .select("id, title, scheduled_at, meeting_type, status, governing_body_id, governing_bodies(name, short_name)", { count: "exact" })
      .not("title", "is", null); // NULL-titled meetings have no searchable label

    if (q.length >= 2) {
      qb = qb.ilike("title", `%${q}%`);
    }

    // Rank by most-recent meeting; relevance ties fall back to date desc.
    qb = qb.order("scheduled_at", { ascending: false, nullsFirst: false })
           .range(offset, offset + fetchLimit - 1);

    const { data, count: totalCount } = await qb;
    const rows = data ?? [];
    if (rows.length === 0) return { results: [], hasMore: false, total_count: 0 };

    const hasMore = rows.length > pageSize;
    const resultRows = rows.slice(0, pageSize);

    // meetings are not tracked in entity_connections → connection_count is 0.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = resultRows.map((m: any) => {
      const gb = Array.isArray(m.governing_bodies) ? m.governing_bodies[0] : m.governing_bodies;
      let score = q.length >= 2 ? baseRelevance(m.title ?? "", q) : 50;
      if (score === 0) score = DESC_SCORE;
      return {
        id: m.id, title: m.title, scheduled_at: m.scheduled_at ?? null,
        meeting_type: m.meeting_type, status: m.status,
        governing_body_name: gb?.name ?? gb?.short_name ?? null,
        relevance_score: Math.min(score, 100),
        connection_count: 0,
      };
    });
    return { results, hasMore, total_count: totalCount ?? 0 };
  };

  // ── Run in parallel ────────────────────────────────────────────────────────
  const [
    { results: officials,          hasMore: officialsMore,    total_count: officialsTotal },
    { results: proposals,          hasMore: proposalsMore,    total_count: proposalsTotal },
    { results: jurisdictions,      hasMore: jurisdictionsMore, total_count: jurisdictionsTotal },
    { results: institutions,       hasMore: institutionsMore, total_count: institutionsTotal },
    { results: agencies,           hasMore: agenciesMore,     total_count: agenciesTotal },
    { results: financial_entities, hasMore: financialMore,    total_count: financialTotal },
    { results: initiatives,        hasMore: initiativesMore,  total_count: initiativesTotal },
    { results: meetings,           hasMore: meetingsMore,     total_count: meetingsTotal },
  ] = await Promise.all([
    searchOfficials(),
    searchProposals(),
    searchJurisdictions(),
    searchInstitutions(),
    searchAgencies(),
    searchFinancialEntities(),
    searchInitiatives(),
    searchMeetings(),
  ]);

  const has_more = officialsMore || proposalsMore || jurisdictionsMore || institutionsMore || agenciesMore || financialMore || initiativesMore || meetingsMore;
  const next_cursor = has_more ? encodeCursor(offset + pageSize) : null;
  const total = officials.length + proposals.length + jurisdictions.length + institutions.length + agencies.length + financial_entities.length + initiatives.length + meetings.length;

  return NextResponse.json({
    query: q, officials, proposals, jurisdictions, institutions, agencies, financial_entities, initiatives, meetings,
    total,
    totals: {
      officials: officialsTotal,
      proposals: proposalsTotal,
      jurisdictions: jurisdictionsTotal,
      institutions: institutionsTotal,
      agencies: agenciesTotal,
      financial_entities: financialTotal,
      initiatives: initiativesTotal,
      meetings: meetingsTotal,
    },
    timing_ms: Date.now() - t0, has_more, next_cursor,
  } satisfies SearchResults, {
    headers: { "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=300" },
  });
}
