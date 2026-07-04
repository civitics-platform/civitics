"use client";

import type { SearchFilters } from "./SearchFiltersPanel";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Party hues are categorical — viz-7 (wine) stands in for the independent
// purple, matching the @civitics/ui Badge convention (FIX-719).
const PARTIES = [
  { value: "democrat",    label: "Democrat",    color: "bg-civic-blue/15 border-civic-blue/60 text-civic-blue" },
  { value: "republican",  label: "Republican",  color: "bg-accent/15 border-accent/60 text-accent" },
  { value: "independent", label: "Independent", color: "bg-viz-7/15 border-viz-7/60 text-viz-7" },
];

const CHAMBERS = [
  { value: "senate", label: "Senate" },
  { value: "house",  label: "House" },
];

const PROPOSAL_STATUSES = [
  { value: "open_comment",     label: "Open Comment",     color: "bg-green-ink/15 border-green-ink/60 text-green-ink" },
  { value: "introduced",       label: "Introduced" },
  { value: "in_committee",     label: "In Committee" },
  { value: "passed_committee", label: "Passed Committee" },
  { value: "floor_vote",       label: "Floor Vote" },
  { value: "enacted",          label: "Enacted" },
  { value: "signed",           label: "Signed" },
  { value: "failed",           label: "Failed" },
];

const PROPOSAL_TYPES = [
  { value: "bill",            label: "Bill" },
  { value: "regulation",      label: "Regulation" },
  { value: "executive_order", label: "Exec. Order" },
  { value: "resolution",      label: "Resolution" },
  { value: "treaty",          label: "Treaty" },
];

const AGENCY_TYPES = [
  { value: "federal",     label: "Federal" },
  { value: "independent", label: "Independent" },
  { value: "state",       label: "State" },
  { value: "local",       label: "Local" },
];

const FINANCIAL_ENTITY_TYPES = [
  { value: "pac",              label: "PAC" },
  { value: "super_pac",        label: "Super PAC" },
  { value: "corporation",      label: "Corporation" },
  { value: "union",            label: "Union" },
  { value: "party_committee",  label: "Party Cmte" },
  { value: "individual",       label: "Individual" },
];

const SORT_OPTIONS = [
  { value: "relevance",       label: "Relevance" },
  { value: "connections_desc",label: "Most Connected" },
  { value: "name_asc",        label: "A → Z" },
  { value: "name_desc",       label: "Z → A" },
  { value: "amount_desc",     label: "Largest Amount" },
];

const US_STATES = [
  ["AL","Alabama"], ["AK","Alaska"], ["AZ","Arizona"], ["AR","Arkansas"], ["CA","California"],
  ["CO","Colorado"], ["CT","Connecticut"], ["DE","Delaware"], ["DC","D.C."], ["FL","Florida"],
  ["GA","Georgia"], ["HI","Hawaii"], ["ID","Idaho"], ["IL","Illinois"], ["IN","Indiana"],
  ["IA","Iowa"], ["KS","Kansas"], ["KY","Kentucky"], ["LA","Louisiana"], ["ME","Maine"],
  ["MD","Maryland"], ["MA","Massachusetts"], ["MI","Michigan"], ["MN","Minnesota"],
  ["MS","Mississippi"], ["MO","Missouri"], ["MT","Montana"], ["NE","Nebraska"],
  ["NV","Nevada"], ["NH","New Hampshire"], ["NJ","New Jersey"], ["NM","New Mexico"],
  ["NY","New York"], ["NC","North Carolina"], ["ND","North Dakota"], ["OH","Ohio"],
  ["OK","Oklahoma"], ["OR","Oregon"], ["PA","Pennsylvania"], ["RI","Rhode Island"],
  ["SC","South Carolina"], ["SD","South Dakota"], ["TN","Tennessee"], ["TX","Texas"],
  ["UT","Utah"], ["VT","Vermont"], ["VA","Virginia"], ["WA","Washington"],
  ["WV","West Virginia"], ["WI","Wisconsin"], ["WY","Wyoming"],
] as const;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SearchFilterBarProps {
  filters: SearchFilters;
  onFiltersChange: (partial: Partial<SearchFilters>) => void;
  sort: string;
  onSortChange: (sort: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SearchFilterBar({ filters, onFiltersChange, sort, onSortChange }: SearchFilterBarProps) {
  const t = filters.type;
  const showOfficials  = t === "all" || t === "officials";
  const showProposals  = t === "all" || t === "proposals" || t === "initiatives";
  const showAgencies   = t === "all" || t === "agencies";
  const showFinancial  = t === "all" || t === "financial";
  const showAmountInputs = t === "financial" || t === "all";

  // Accent marks active/selected — amber is reserved for live/warning.
  function pill(
    label: string,
    active: boolean,
    onClick: () => void,
    activeColor = "bg-accent/15 border-accent/60 text-accent",
  ) {
    return (
      <button
        key={label}
        onClick={onClick}
        className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors whitespace-nowrap
          ${active
            ? activeColor
            : "bg-card border-term-line text-ink-soft hover:border-ink-soft/50 hover:bg-ink/5"}`}
      >
        {label}
      </button>
    );
  }

  // Count active filters (excluding type and sort)
  const activeCount = [
    filters.party, filters.chamber, filters.state, filters.jurisdiction_level,
    filters.status, filters.proposal_type, filters.date_from, filters.date_to,
    filters.agency_type,
    filters.entity_type, filters.industry, filters.min_amount, filters.max_amount,
    filters.official_role, filters.financial_type, filters.initiative_stage,
  ].filter(Boolean).length;

  function clearAll() {
    onFiltersChange({
      party: undefined, chamber: undefined, state: undefined, jurisdiction_level: undefined,
      status: undefined, proposal_type: undefined, date_from: undefined, date_to: undefined,
      agency_type: undefined,
      entity_type: undefined, industry: undefined, min_amount: undefined, max_amount: undefined,
      official_role: undefined, financial_type: undefined, initiative_stage: undefined,
    });
    onSortChange("relevance");
  }

  return (
    <div className="shrink-0 bg-card border-b border-rule px-4 py-2 flex flex-wrap items-center gap-2">

      {/* Sort select */}
      <select
        value={sort}
        onChange={(e) => onSortChange(e.target.value)}
        className="shrink-0 rounded border border-term-line bg-paper px-2 py-1 text-[11px] font-medium text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent h-7"
      >
        {SORT_OPTIONS.map(({ value, label }) => (
          <option key={value} value={value}>{label}</option>
        ))}
      </select>

      {/* Divider */}
      <div className="shrink-0 h-4 w-px bg-rule" />

      {/* Open for Comment quick chip — always visible */}
      {(showProposals || t === "all") && pill(
        "⚡ Open Comment",
        filters.status === "open_comment",
        () => {
          const next = filters.status === "open_comment" ? undefined : "open_comment";
          onFiltersChange({ status: next, type: next ? "proposals" : filters.type });
        },
        "bg-green-ink/15 border-green-ink/60 text-green-ink",
      )}

      {/* Officials: Jurisdiction level pills */}
      {showOfficials && (
        <>
          {(["Federal", "State", "Local"] as const).map((level) => {
            const value = level.toLowerCase();
            return pill(level, filters.jurisdiction_level === value,
              () => onFiltersChange({ jurisdiction_level: filters.jurisdiction_level === value ? undefined : value }),
            );
          })}
          <div className="shrink-0 h-4 w-px bg-rule" />
        </>
      )}

      {/* Officials: Party pills */}
      {showOfficials && PARTIES.map(({ value, label, color }) =>
        pill(label, filters.party === value,
          () => onFiltersChange({ party: filters.party === value ? undefined : value }),
          color,
        )
      )}

      {/* Officials: Chamber pills */}
      {showOfficials && CHAMBERS.map(({ value, label }) =>
        pill(label, filters.chamber === value,
          () => onFiltersChange({ chamber: filters.chamber === value ? undefined : value }),
        )
      )}

      {/* Officials: State select */}
      {showOfficials && (
        <select
          value={filters.state ?? ""}
          onChange={(e) => onFiltersChange({ state: e.target.value || undefined })}
          className="shrink-0 rounded border border-term-line bg-paper px-2 py-1 text-[11px] font-medium text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent h-7"
        >
          <option value="">All states</option>
          {US_STATES.map(([abbr, name]) => (
            <option key={abbr} value={abbr}>{name} ({abbr})</option>
          ))}
        </select>
      )}

      {/* Proposals: Status pills (section divider only in "All" tab) */}
      {showProposals && t === "all" && <div className="shrink-0 h-4 w-px bg-rule" />}
      {showProposals && PROPOSAL_STATUSES.slice(1).map(({ value, label }) =>
        pill(label, filters.status === value,
          () => onFiltersChange({ status: filters.status === value ? undefined : value }),
        )
      )}

      {/* Proposals: Type pills */}
      {showProposals && (
        <>
          <div className="shrink-0 h-4 w-px bg-rule" />
          {PROPOSAL_TYPES.map(({ value, label }) =>
            pill(label, filters.proposal_type === value,
              () => onFiltersChange({ proposal_type: filters.proposal_type === value ? undefined : value }),
            )
          )}
        </>
      )}

      {/* Agencies: Type pills (section divider only in "All" tab) */}
      {showAgencies && t === "all" && <div className="shrink-0 h-4 w-px bg-rule" />}
      {showAgencies && AGENCY_TYPES.map(({ value, label }) =>
        pill(label, filters.agency_type === value,
          () => onFiltersChange({ agency_type: filters.agency_type === value ? undefined : value }),
        )
      )}

      {/* Financial: Entity type pills (section divider only in "All" tab) */}
      {showFinancial && t === "all" && <div className="shrink-0 h-4 w-px bg-rule" />}
      {showFinancial && FINANCIAL_ENTITY_TYPES.map(({ value, label }) =>
        pill(label, (filters.financial_type ?? filters.entity_type) === value,
          () => onFiltersChange({
            financial_type: (filters.financial_type ?? filters.entity_type) === value ? undefined : value,
            entity_type: undefined,
          }),
        )
      )}

      {/* Financial: Amount range (only on dedicated financial tab) */}
      {showAmountInputs && (
        <>
          <div className="shrink-0 h-4 w-px bg-rule" />
          <input
            type="number"
            min={0}
            placeholder="Min $"
            value={filters.min_amount ?? ""}
            onChange={(e) => onFiltersChange({ min_amount: e.target.value || undefined })}
            className="shrink-0 w-20 rounded border border-term-line bg-paper px-2 py-1 font-mono text-[11px] tabular-nums text-ink placeholder:text-ink-soft focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent h-7"
          />
          <input
            type="number"
            min={0}
            placeholder="Max $"
            value={filters.max_amount ?? ""}
            onChange={(e) => onFiltersChange({ max_amount: e.target.value || undefined })}
            className="shrink-0 w-20 rounded border border-term-line bg-paper px-2 py-1 font-mono text-[11px] tabular-nums text-ink placeholder:text-ink-soft focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent h-7"
          />
        </>
      )}

      {/* Clear all — shown when any active filter */}
      {activeCount > 0 && (
        <>
          <div className="shrink-0 h-4 w-px bg-rule" />
          <button
            onClick={clearAll}
            className="shrink-0 rounded-full border border-term-line px-2.5 py-1 text-[11px] font-medium text-ink-soft hover:border-accent/60 hover:text-accent transition-colors whitespace-nowrap"
          >
            Clear ({activeCount})
          </button>
        </>
      )}
    </div>
  );
}
