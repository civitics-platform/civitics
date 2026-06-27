"use client";

import type {
  SearchOfficial,
  SearchProposal,
  SearchAgency,
  SearchFinancialEntity,
  SearchInitiative,
  SearchJurisdiction,
  SearchInstitution,
  SearchMeeting,
} from "../../api/search/route";
import { FormerBadge } from "../../components/FormerBadge";
import { SyntheticMark } from "../../components/integrity/Synthetic";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PARTY_BADGE: Record<string, string> = {
  democrat:    "bg-blue-100 text-blue-800",
  republican:  "bg-red-100 text-red-800",
  independent: "bg-purple-100 text-purple-800",
};

const STATUS_LABEL: Record<string, string> = {
  open_comment:         "Open Comment",
  introduced:           "Introduced",
  in_committee:         "In Committee",
  passed_committee:     "Passed Committee",
  floor_vote:           "Floor Vote",
  passed_chamber:       "Passed Chamber",
  passed_both_chambers: "Passed Both Chambers",
  signed:               "Signed",
  enacted:              "Enacted",
  failed:               "Failed",
  withdrawn:            "Withdrawn",
  comment_closed:       "Comment Closed",
};

const STATUS_COLOR: Record<string, string> = {
  open_comment:  "bg-emerald-100 text-emerald-800",
  introduced:    "bg-amber-100 text-amber-800",
  in_committee:  "bg-amber-100 text-amber-800",
  enacted:       "bg-green-100 text-green-800",
  signed:        "bg-green-100 text-green-800",
  failed:        "bg-red-100 text-red-800",
};

const STAGE_COLOR: Record<string, string> = {
  draft:      "bg-gray-100 text-gray-600",
  deliberate: "bg-blue-100 text-blue-700",
  mobilise:   "bg-emerald-100 text-emerald-700",
  resolved:   "bg-gray-100 text-gray-500",
};

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

function formatDollars(cents: number): string {
  const d = cents / 100;
  if (d >= 1_000_000) return `$${(d / 1_000_000).toFixed(1)}M`;
  if (d >= 1_000) return `$${(d / 1_000).toFixed(0)}K`;
  return `$${d.toFixed(0)}`;
}

function ConnectionBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500 tabular-nums">
      🔗 {count.toLocaleString()}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Discriminated union type for all result kinds
// ---------------------------------------------------------------------------

export type AnySearchResult =
  | { kind: "official";     data: SearchOfficial }
  | { kind: "proposal";     data: SearchProposal }
  | { kind: "agency";       data: SearchAgency }
  | { kind: "financial";    data: SearchFinancialEntity }
  | { kind: "initiative";   data: SearchInitiative }
  | { kind: "jurisdiction"; data: SearchJurisdiction }
  | { kind: "institution";  data: SearchInstitution }
  | { kind: "meeting";      data: SearchMeeting };

export function resultId(r: AnySearchResult): string {
  return `${r.kind}:${r.data.id}`;
}

export function resultEntityId(r: AnySearchResult): string {
  return r.data.id;
}

export function resultEntityType(r: AnySearchResult): string {
  return r.kind;
}

// ---------------------------------------------------------------------------
// SearchResultCard
// ---------------------------------------------------------------------------

interface SearchResultCardProps {
  result: AnySearchResult;
  isSelected: boolean;
  onToggleSelect: (id: string) => void;
  onClickDetail: (result: AnySearchResult) => void;
  showCheckbox: boolean;
  /** "badge" shows a type label — used in the "All" tab */
  badge?: boolean;
  /** True when this entity is already loaded in the connection graph */
  isInGraph?: boolean;
}

export function SearchResultCard({
  result,
  isSelected,
  onToggleSelect,
  onClickDetail,
  showCheckbox,
  badge,
  isInGraph = false,
}: SearchResultCardProps) {
  const key = resultId(result);

  function handleCardClick(e: React.MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.closest("[data-checkbox]")) return;
    onClickDetail(result);
  }

  function handleCheckboxChange(e: React.ChangeEvent<HTMLInputElement>) {
    e.stopPropagation();
    onToggleSelect(key);
  }

  return (
    <div
      className={`relative flex items-stretch rounded-lg border bg-white transition-all cursor-pointer
        ${isSelected
          ? "border-indigo-400 shadow-sm ring-1 ring-indigo-300"
          : "border-gray-200 hover:border-indigo-300 hover:shadow-sm"}`}
      onClick={handleCardClick}
    >
      {/* Checkbox */}
      {showCheckbox && (
        <div
          data-checkbox
          className="flex items-center px-3 border-r border-gray-100 shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={isSelected}
            onChange={handleCheckboxChange}
            className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
            aria-label="Select this item"
          />
        </div>
      )}

      {/* Card content */}
      <div className="flex-1 min-w-0 px-4 py-3">
        {result.kind === "official"     && <OfficialCardContent     o={result.data} badge={badge} isInGraph={isInGraph} />}
        {result.kind === "proposal"     && <ProposalCardContent     p={result.data} badge={badge} />}
        {result.kind === "agency"       && <AgencyCardContent       a={result.data} badge={badge} isInGraph={isInGraph} />}
        {result.kind === "financial"    && <FinancialCardContent    f={result.data} badge={badge} isInGraph={isInGraph} />}
        {result.kind === "initiative"   && <InitiativeCardContent   i={result.data} badge={badge} />}
        {result.kind === "jurisdiction" && <JurisdictionCardContent j={result.data} badge={badge} isInGraph={isInGraph} />}
        {result.kind === "institution"  && <InstitutionCardContent  g={result.data} badge={badge} isInGraph={isInGraph} />}
        {result.kind === "meeting"      && <MeetingCardContent      m={result.data} badge={badge} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card content variants
// ---------------------------------------------------------------------------

function InGraphBadge() {
  return (
    <span className="shrink-0 rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-500">
      ⊙ in graph
    </span>
  );
}

function OfficialCardContent({ o, badge, isInGraph }: { o: SearchOfficial; badge?: boolean; isInGraph?: boolean }) {
  const partyBadge = PARTY_BADGE[o.party ?? ""] ?? "bg-gray-100 text-gray-700";
  return (
    <div className="flex items-center gap-3">
      {badge && <TypeBadge label="Official" color="indigo" />}
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs font-semibold text-gray-600 overflow-hidden">
        {o.photo_url
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={o.photo_url} alt={o.full_name} width={36} height={36} loading="lazy" decoding="async" className="h-9 w-9 rounded-full object-cover" />
          : initials(o.full_name)}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-gray-900">
          {o.full_name}
          {o.is_synthetic && <SyntheticMark size="xs" className="ml-1.5" />}
        </p>
        <p className="truncate text-xs text-gray-500">
          {o.role_title}{o.state ? ` · ${o.state}` : ""}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {isInGraph && <InGraphBadge />}
        {o.total_received_cents != null && o.total_received_cents > 0 && (
          <span className="shrink-0 rounded bg-green-50 px-1.5 py-0.5 text-[10px] font-medium text-green-700 tabular-nums">
            {formatDollars(o.total_received_cents)} raised
          </span>
        )}
        <ConnectionBadge count={o.connection_count} />
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${partyBadge}`}>
          {o.party?.[0]?.toUpperCase() ?? "?"}
        </span>
      </div>
    </div>
  );
}

function ProposalCardContent({ p, badge }: { p: SearchProposal; badge?: boolean }) {
  const color = STATUS_COLOR[p.status] ?? "bg-gray-100 text-gray-700";
  const label = STATUS_LABEL[p.status] ?? p.status.replace(/_/g, " ");
  const isOpen = p.status === "open_comment" && p.comment_period_end &&
    new Date(p.comment_period_end) > new Date();
  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap">
        {badge && <TypeBadge label="Proposal" color="amber" />}
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${color}`}>{label}</span>
        {isOpen && (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
            Comment open
          </span>
        )}
        {p.agency_acronym && (
          <span className="font-mono text-[11px] text-gray-400">{p.agency_acronym}</span>
        )}
        <div className="ml-auto shrink-0">
          <ConnectionBadge count={p.connection_count} />
        </div>
      </div>
      <p className="mt-1.5 text-sm font-semibold text-gray-900 line-clamp-2 leading-snug">
        {p.title}
        {p.is_synthetic && <SyntheticMark size="xs" className="ml-1.5" />}
      </p>
      {p.ai_summary && (
        <p className="mt-1 text-xs text-gray-500 line-clamp-1">{p.ai_summary}</p>
      )}
    </div>
  );
}

function AgencyCardContent({ a, badge, isInGraph }: { a: SearchAgency; badge?: boolean; isInGraph?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      {badge && <TypeBadge label="Agency" color="gray" />}
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded border border-gray-200 bg-gray-50 font-mono text-[10px] font-bold text-gray-600">
        {(a.acronym ?? a.name).slice(0, 4)}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-gray-900">
          {a.name}
          {a.is_synthetic && <SyntheticMark size="xs" className="ml-1.5" />}
        </p>
        {a.acronym && <p className="text-xs text-gray-400">{a.acronym}</p>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {isInGraph && <InGraphBadge />}
        <ConnectionBadge count={a.connection_count} />
        <span className="rounded bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500 capitalize">
          {a.agency_type.replace(/_/g, " ")}
        </span>
      </div>
    </div>
  );
}

const FINANCIAL_BADGE_LABEL: Record<string, string> = {
  pac:             "PAC",
  super_pac:       "Super PAC",
  corporation:     "Corp",
  union:           "Union",
  party_committee: "Party Cmte",
  individual:      "Donor",
};

function FinancialCardContent({ f, badge, isInGraph }: { f: SearchFinancialEntity; badge?: boolean; isInGraph?: boolean }) {
  const badgeLabel = FINANCIAL_BADGE_LABEL[f.entity_type] ?? "Donor";
  const showAmt = f.total_amount_cents != null && f.total_amount_cents > 0;
  return (
    <div className="flex items-center gap-3">
      {badge && <TypeBadge label={badgeLabel} color="green" />}
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded border border-gray-200 bg-gray-50 text-gray-400">
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-gray-900">
          {f.name}
          {f.is_synthetic && <SyntheticMark size="xs" className="ml-1.5" />}
        </p>
        <p className="truncate text-xs text-gray-500">
          {f.entity_type.replace(/_/g, " ")}
          {f.industry ? ` · ${f.industry}` : ""}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {isInGraph && <InGraphBadge />}
        <ConnectionBadge count={f.connection_count} />
        {showAmt && (
          <span className="rounded bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">
            {formatDollars(f.total_amount_cents!)} · {
              f.amount_label === "contract" ? "Contracts"
              : f.amount_label === "grant"  ? "Grants"
              : f.amount_label === "independent_expenditure" ? "Ind. expenditures"
              : "Donations"
            }
          </span>
        )}
      </div>
    </div>
  );
}

function InitiativeCardContent({ i, badge }: { i: SearchInitiative; badge?: boolean }) {
  const stageColor = STAGE_COLOR[i.stage ?? ""] ?? "bg-gray-100 text-gray-600";
  const stageLabel = i.stage ? (i.stage.charAt(0).toUpperCase() + i.stage.slice(1)) : "Draft";
  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap">
        {badge && <TypeBadge label="Initiative" color="green" />}
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${stageColor}`}>
          {stageLabel}
        </span>
        <div className="ml-auto shrink-0">
          <ConnectionBadge count={i.connection_count} />
        </div>
      </div>
      <p className="mt-1.5 text-sm font-semibold text-gray-900 line-clamp-2 leading-snug">
        {i.title}
      </p>
    </div>
  );
}

function JurisdictionCardContent({ j, badge, isInGraph }: { j: SearchJurisdiction; badge?: boolean; isInGraph?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      {badge && <TypeBadge label="Jurisdiction" color="indigo" />}
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded border border-gray-200 bg-gray-50 text-gray-400">
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-gray-900">
          {j.name}
          {j.is_synthetic && <SyntheticMark size="xs" className="ml-1.5" />}
        </p>
        <p className="truncate text-xs text-gray-500 capitalize">
          {j.jurisdiction_type}{j.short_name ? ` · ${j.short_name}` : ""}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {isInGraph && <InGraphBadge />}
        <ConnectionBadge count={j.connection_count} />
      </div>
    </div>
  );
}

function InstitutionCardContent({ g, badge, isInGraph }: { g: SearchInstitution; badge?: boolean; isInGraph?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      {badge && <TypeBadge label="Institution" color="indigo" />}
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded border border-gray-200 bg-gray-50 text-gray-400">
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-gray-900">
          {g.name}
          {g.is_synthetic && <SyntheticMark size="xs" className="ml-1.5" />}
        </p>
        <p className="truncate text-xs text-gray-500 capitalize">
          {g.institution_type.replace(/_/g, " ")}{g.short_name ? ` · ${g.short_name}` : ""}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <FormerBadge isActive={g.is_active} />
        {isInGraph && <InGraphBadge />}
        <ConnectionBadge count={g.connection_count} />
      </div>
    </div>
  );
}

function MeetingCardContent({ m, badge }: { m: SearchMeeting; badge?: boolean }) {
  const dateLabel = m.scheduled_at ? new Date(m.scheduled_at).toLocaleDateString() : null;
  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap">
        {badge && <TypeBadge label="Meeting" color="gray" />}
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600 capitalize">
          {m.meeting_type.replace(/_/g, " ")}
        </span>
        {dateLabel && <span className="text-[11px] text-gray-400">{dateLabel}</span>}
      </div>
      <p className="mt-1.5 text-sm font-semibold text-gray-900 line-clamp-2 leading-snug">
        {m.title}
      </p>
      {m.governing_body_name && (
        <p className="mt-0.5 text-xs text-gray-500 truncate">{m.governing_body_name}</p>
      )}
    </div>
  );
}

function TypeBadge({ label, color }: { label: string; color: string }) {
  const cls: Record<string, string> = {
    indigo: "bg-indigo-50 text-indigo-500",
    amber:  "bg-amber-50 text-amber-600",
    gray:   "bg-gray-100 text-gray-500",
    green:  "bg-green-50 text-green-600",
  };
  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${cls[color] ?? cls.gray}`}>
      {label}
    </span>
  );
}
