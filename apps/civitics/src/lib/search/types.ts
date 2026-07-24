/**
 * Search result envelope types.
 *
 * Relocated here from `app/api/search/route.ts` (FIX-773) when that legacy
 * 8-searcher route was retired. The `/api/browse/typeahead` route and the ⌘K
 * `GlobalSearch` component still return / consume this exact envelope shape, so
 * the types live in `src/lib/search/` (mirroring the `src/lib/browse/`
 * convention) independent of any route.
 */

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
