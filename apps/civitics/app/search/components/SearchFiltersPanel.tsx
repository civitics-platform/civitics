"use client";

import { GroupBrowser } from "@civitics/graph";
import type { FocusGroup } from "@civitics/graph";

// ---------------------------------------------------------------------------
// Filter state type (mirrors the API query params)
// ---------------------------------------------------------------------------

export interface SearchFilters {
  type: string;           // all|officials|proposals|agencies|financial|initiatives
  party?: string;
  state?: string;
  chamber?: string;       // senate|house
  status?: string;
  proposal_type?: string;
  date_from?: string;
  date_to?: string;
  agency_type?: string;
  entity_type?: string;
  industry?: string;
  min_amount?: string;
  max_amount?: string;
  // Phase 2+ fields
  official_role?: string;        // congress|judiciary|cabinet|state_gov
  financial_type?: string;       // individual|pac|super_pac|corporation|union|party_committee
  initiative_stage?: string;     // draft|deliberate|mobilise|resolved
  jurisdiction_level?: string;   // federal|state|local
}

interface SearchFiltersPanelProps {
  filters: SearchFilters;
  onFiltersChange: (filters: Partial<SearchFilters>) => void;
}

// ---------------------------------------------------------------------------
// Compute activeGroupIds from current filters (for the GroupBrowser checkmarks)
// ---------------------------------------------------------------------------
function filtersToGroupId(f: SearchFilters): string | null {
  // Officials
  if (f.type === "officials" || f.type === "all") {
    if (f.state)   return `group-state-${f.state}`;
    if (f.party === "democrat"   && f.chamber === "senate") return "group-senate-dems";
    if (f.party === "republican" && f.chamber === "senate") return "group-senate-reps";
    if (f.party === "democrat"   && f.chamber === "house")  return "group-house-dems";
    if (f.party === "republican" && f.chamber === "house")  return "group-house-reps";
    if (f.chamber === "senate"   && !f.party) return "group-full-senate";
    if (f.chamber === "house"    && !f.party) return "group-full-house";
    if (f.official_role === "judiciary") return "group-judiciary";
    if (f.official_role === "cabinet")   return "group-cabinet";
  }
  // Agencies
  if (f.type === "agencies") {
    if (f.agency_type === "independent") return "group-independent-agencies";
    if (!f.agency_type)                  return "group-federal-agencies";
  }
  // Financial / money
  if (f.type === "financial" || f.type === "all") {
    if (f.industry) return `group-pac-${f.industry.toLowerCase()}`;
    const ft = f.financial_type ?? f.entity_type;
    if (ft === "super_pac")       return "group-super-pacs";
    if (ft === "party_committee") return "group-party-committees";
    if (ft === "corporation")     return "group-corporations";
    if (ft === "union")           return "group-unions";
    if (ft === "individual")      return "group-individual-donors";
  }
  // Proposals
  if (f.type === "proposals") {
    if (f.proposal_type === "bill"       && !f.status) return "group-proposals-bills";
    if (f.status === "open_comment"      && !f.proposal_type) return "group-proposals-open-comment";
    if (f.proposal_type === "regulation" && !f.status) return "group-proposals-regulations";
  }
  // Initiatives
  if (f.type === "initiatives") {
    if (!f.initiative_stage) return "group-initiatives-active"; // default to active
    if (f.initiative_stage === "resolved") return "group-initiatives-resolved";
  }
  return null;
}

// Map a FocusGroup's filter to SearchFilters
function groupToFilters(group: FocusGroup): Partial<SearchFilters> {
  const f = group.filter;
  const result: Partial<SearchFilters> = {};

  if (f.entity_type === "official") {
    result.type = "officials";
    if (f.party)           result.party        = f.party;
    if (f.state)           result.state        = f.state;
    if (f.chamber)         result.chamber      = f.chamber;
    if (f.official_role)   result.official_role = f.official_role;
  } else if (f.entity_type === "pac") {
    result.type = "financial";
    if (f.industry) result.industry = f.industry;
  } else if (f.entity_type === "financial") {
    result.type = "financial";
    if (f.financial_type) result.financial_type = f.financial_type;
  } else if (f.entity_type === "agency") {
    result.type = "agencies";
    if (f.agency_type) result.agency_type = f.agency_type;
  } else if (f.entity_type === "proposal") {
    result.type = "proposals";
    if (f.tag)           result.status        = f.tag;
    if (f.proposal_type) result.proposal_type = f.proposal_type;
  } else if (f.entity_type === "initiative") {
    result.type = "initiatives";
    if (f.initiative_stage) result.initiative_stage = f.initiative_stage;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Component — hierarchy browser only (filter pills moved to SearchFilterBar)
// ---------------------------------------------------------------------------

export function SearchFiltersPanel({ filters, onFiltersChange }: SearchFiltersPanelProps) {
  const activeGroupId = filtersToGroupId(filters);

  function handleGroupSelect(group: FocusGroup) {
    const mapped = groupToFilters(group);
    // If already active, clear to "all"
    const wouldBeActive = activeGroupId &&
      filtersToGroupId({ ...filters, ...mapped }) === activeGroupId;
    if (wouldBeActive) {
      onFiltersChange({
        type: "all",
        party: undefined, state: undefined, chamber: undefined,
        industry: undefined, official_role: undefined, financial_type: undefined,
        agency_type: undefined, proposal_type: undefined, status: undefined,
        initiative_stage: undefined,
      });
    } else {
      onFiltersChange(mapped);
    }
  }

  return (
    <div className="h-full flex flex-col overflow-hidden border-r border-gray-200 bg-white">
      <div className="flex-1 overflow-y-auto">
        <div className="pt-2 pb-2">
          <GroupBrowser
            onAddGroup={handleGroupSelect}
            activeGroupIds={activeGroupId ? [activeGroupId] : []}
          />
        </div>
      </div>
    </div>
  );
}
