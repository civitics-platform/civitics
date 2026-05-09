/**
 * GET /api/search
 *
 * Params:
 *   q               — text query (optional; omit for browse mode)
 *   type            — all|officials|proposals|agencies|financial|initiatives
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
};

export type SearchAgency = {
  id: string;
  name: string;
  slug: string | null;
  acronym: string | null;
  agency_type: string;
  description: string | null;
  relevance_score: number;
  connection_count: number;
};

export type SearchFinancialEntity = {
  id: string;
  name: string;
  entity_type: string;
  industry: string | null;
  total_amount_cents: number | null;
  amount_label: "contract" | "grant" | "donation";
  relevance_score: number;
  connection_count: number;
};

export type SearchInitiative = {
  id: string;
  title: string;
  stage: string | null;
  status: string;
  relevance_score: number;
  connection_count: number;
};

export type SearchResults = {
  query: string;
  officials: SearchOfficial[];
  proposals: SearchProposal[];
  agencies: SearchAgency[];
  financial_entities: SearchFinancialEntity[];
  initiatives: SearchInitiative[];
  total: number;
  totals: {
    officials: number;
    proposals: number;
    agencies: number;
    financial_entities: number;
    initiatives: number;
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
  const anyTypeFilter = hasOfficialFilters || hasProposalFilters || hasAgencyFilters || hasFinancialFilters || hasInitiativeFilters;

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
      .select("id, full_name, role_title, party, photo_url, is_active, metadata, source_ids, total_received_cents", { count: "exact" });

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
      const levelTypeMap: Record<string, string[]> = {
        federal: ["country"],
        state:   ["state"],
        local:   ["county", "city", "district", "precinct", "other"],
      };
      const jTypes = levelTypeMap[filterJurisdictionLevel];
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
      .select("id, title, status, type, comment_period_end, metadata, summary_plain", { count: "exact" })
      .neq("type", "initiative");

    if (filterStatus)       qb = qb.eq("status", filterStatus);
    if (filterProposalType) qb = qb.eq("type", filterProposalType);
    if (filterDateFrom)     qb = qb.gte("comment_period_end", filterDateFrom);
    if (filterDateTo)       qb = qb.lte("comment_period_end", filterDateTo);

    if (q.length >= 2) {
      qb = qb.or(`title.ilike.%${q}%,summary_plain.ilike.%${q}%`);
    }

    qb = qb.order("comment_period_end", { ascending: false, nullsFirst: false })
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
        comment_period_end: p.comment_period_end ?? null,
        agency_acronym: p.metadata?.agency_id ?? null,
        ai_summary: summaryMap[p.id] ?? null,
        relevance_score: Math.min(score, 100),
        connection_count: countMap.get(p.id) ?? 0,
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
      .select("id, name, slug, acronym, agency_type, description", { count: "exact" })
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
        id: a.id, name: a.name, slug: a.slug ?? null, acronym: a.acronym ?? null,
        agency_type: a.agency_type, description: a.description ?? null,
        relevance_score: Math.min(score, 100),
        connection_count: countMap.get(a.id) ?? 0,
      };
    }).sort((a: SearchAgency, b: SearchAgency) => b.relevance_score - a.relevance_score);
    return { results: applySort(results, (r) => r.name), hasMore, total_count: totalCount ?? 0 };
  };

  // ── Financial entities ─────────────────────────────────────────────────────
  const searchFinancialEntities = async (): Promise<{ results: SearchFinancialEntity[]; hasMore: boolean; total_count: number }> => {
    if (typeFilter !== "all" && typeFilter !== "financial") return { results: [], hasMore: false, total_count: 0 };
    if (typeFilter === "all" && anyTypeFilter && !hasFinancialFilters) return { results: [], hasMore: false, total_count: 0 };

    const spendingCols = await checkSpendingCols(db);
    const selectCols = spendingCols
      ? "id, display_name, entity_type, total_donated_cents, total_contract_cents, total_grant_cents"
      : "id, display_name, entity_type, total_donated_cents";

    let qb = db2
      .from("financial_entities")
      .select(selectCols, { count: "exact" });

    // financial_type / entity_type filter (when set, allow individuals too)
    if (filterEntityType) {
      qb = qb.eq("entity_type", filterEntityType);
    } else {
      // browse mode: exclude individual donors from "all" / default financial view
      qb = qb.neq("entity_type", "individual");
    }

    if (filterMinAmountCents) qb = qb.gte("total_donated_cents", filterMinAmountCents);
    if (filterMaxAmountCents) qb = qb.lte("total_donated_cents", filterMaxAmountCents);

    if (filterIndustry) {
      const { data: tagRows } = await db2
        .from("entity_tags")
        .select("entity_id")
        .eq("tag_type", "industry")
        .ilike("tag_value", filterIndustry);
      const tagIds = (tagRows ?? []).map((r: { entity_id: string }) => r.entity_id);
      if (tagIds.length === 0) return { results: [], hasMore: false, total_count: 0 };
      qb = qb.in("id", tagIds);
    }

    if (q.length >= 2) {
      qb = qb.ilike("display_name", `%${q}%`);
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
      const spendingCents = contractCents + grantCents;

      // Corps/orgs: show federal spending if present; PACs/individuals: show donations.
      const showSpending = spendingCents > 0 &&
        (f.entity_type === "corporation" || f.entity_type === "organization");
      const dominantAmount = showSpending ? spendingCents : donationCents;
      const amountLabel: SearchFinancialEntity["amount_label"] = showSpending
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
      .select("id, title, status, initiative_details!inner(stage)", { count: "exact" })
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

  // ── Run in parallel ────────────────────────────────────────────────────────
  const [
    { results: officials,          hasMore: officialsMore,  total_count: officialsTotal },
    { results: proposals,          hasMore: proposalsMore,  total_count: proposalsTotal },
    { results: agencies,           hasMore: agenciesMore,   total_count: agenciesTotal },
    { results: financial_entities, hasMore: financialMore,  total_count: financialTotal },
    { results: initiatives,        hasMore: initiativesMore, total_count: initiativesTotal },
  ] = await Promise.all([
    searchOfficials(),
    searchProposals(),
    searchAgencies(),
    searchFinancialEntities(),
    searchInitiatives(),
  ]);

  const has_more = officialsMore || proposalsMore || agenciesMore || financialMore || initiativesMore;
  const next_cursor = has_more ? encodeCursor(offset + pageSize) : null;
  const total = officials.length + proposals.length + agencies.length + financial_entities.length + initiatives.length;

  return NextResponse.json({
    query: q, officials, proposals, agencies, financial_entities, initiatives,
    total,
    totals: {
      officials: officialsTotal,
      proposals: proposalsTotal,
      agencies: agenciesTotal,
      financial_entities: financialTotal,
      initiatives: initiativesTotal,
    },
    timing_ms: Date.now() - t0, has_more, next_cursor,
  } satisfies SearchResults);
}
