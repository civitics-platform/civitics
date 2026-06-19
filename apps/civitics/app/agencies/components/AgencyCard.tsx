"use client";

import Link from "next/link";
import type { AgencyRow } from "../page";
import { SyntheticMark } from "../../components/integrity/Synthetic";

// ─── Style tables (shared with AgenciesList slide-over) ──────────────────────

export const AGENCY_TYPE_LABELS: Record<string, string> = {
  federal:       "Federal",
  state:         "State",
  local:         "Local",
  independent:   "Independent",
  international: "International",
  other:         "Other",
};

export const AGENCY_TYPE_COLORS: Record<string, string> = {
  federal:       "bg-blue-50 text-blue-700 border-blue-200",
  state:         "bg-purple-50 text-purple-700 border-purple-200",
  local:         "bg-green-50 text-green-700 border-green-200",
  independent:   "bg-amber-50 text-amber-700 border-amber-200",
  international: "bg-indigo-50 text-indigo-700 border-indigo-200",
  other:         "bg-gray-50 text-gray-600 border-gray-200",
};

// ─── Sector tag inference ────────────────────────────────────────────────────

const SECTOR_RULES: [RegExp, string, string][] = [
  [/environment|forest|land|wildlife|ocean|fish|park|nature|conservation|reclamation|mines|geology|weather|atmospheric|noaa/i, "Environment", "bg-emerald-50 text-emerald-700"],
  [/defense|army|navy|air force|marine|coast guard|military|pentagon|veteran|national guard/i, "Defense", "bg-slate-100 text-slate-700"],
  [/health|disease|cancer|drug|food|fda|cdc|nih|medicare|medicaid|substance|mental|elder|disability/i, "Health", "bg-rose-50 text-rose-700"],
  [/financial|banking|securities|exchange|treasury|budget|fiscal|currency|fed|reserve|cftc|fdic|consumer financial/i, "Finance", "bg-amber-50 text-amber-700"],
  [/transport|highway|aviation|rail|transit|maritime|pipeline|fhwa|faa|fra|fta|fmcsa/i, "Transportation", "bg-sky-50 text-sky-700"],
  [/energy|nuclear|power|petroleum|oil|gas|electric|ferc|doe|nrc/i, "Energy", "bg-orange-50 text-orange-700"],
  [/education|school|student|college|university|learning|title/i, "Education", "bg-violet-50 text-violet-700"],
  [/labor|worker|wage|safety|osha|mine safety|employment|pension|benefit/i, "Labor", "bg-cyan-50 text-cyan-700"],
  [/agriculture|farm|crop|food safety|rural|animal|plant health|commodity/i, "Agriculture", "bg-lime-50 text-lime-700"],
  [/justice|law|court|civil rights|atf|dea|fbi|prison|correctional|alcohol|tobacco|firearms/i, "Justice", "bg-purple-50 text-purple-700"],
  [/housing|urban|community|hud|mortgage|rural development/i, "Housing", "bg-teal-50 text-teal-700"],
  [/immigration|customs|border|citizenship|visa|ice\b/i, "Immigration", "bg-indigo-50 text-indigo-700"],
  [/space|nasa|aeronaut/i, "Space", "bg-blue-50 text-blue-700"],
  [/trade|commerce|export|import|international trade|census|patent|copyright/i, "Commerce", "bg-yellow-50 text-yellow-700"],
  [/communication|broadcast|fcc|telecom|internet|spectrum/i, "Communications", "bg-pink-50 text-pink-700"],
];

export const ALL_SECTORS = SECTOR_RULES.map(([, label]) => label);

export function inferSectorTags(
  name: string,
  acronym: string | null
): { label: string; color: string }[] {
  const text = `${name} ${acronym ?? ""}`;
  const tags: { label: string; color: string }[] = [];
  for (const [pattern, label, color] of SECTOR_RULES) {
    if (pattern.test(text)) {
      tags.push({ label, color });
      if (tags.length >= 2) break;
    }
  }
  return tags;
}

export function inferSectorLabels(name: string, acronym: string | null): string[] {
  return inferSectorTags(name, acronym).map((t) => t.label);
}

// ─── Card ────────────────────────────────────────────────────────────────────

export function AgencyCard({
  agency,
  onClick,
}: {
  agency: AgencyRow;
  /**
   * If provided, the card renders as a button and calls onClick (used by
   * AgenciesList to open the slide-over). If omitted, the whole card links
   * straight to /agencies/[id] — used on the homepage.
   */
  onClick?: () => void;
}) {
  const typeColor     = AGENCY_TYPE_COLORS[agency.agency_type] ?? AGENCY_TYPE_COLORS["other"]!;
  const typeLabel     = AGENCY_TYPE_LABELS[agency.agency_type] ?? agency.agency_type;
  const displayAcronym =
    agency.acronym ?? agency.short_name ?? agency.name.slice(0, 5).toUpperCase();
  const sectorTags    = inferSectorTags(agency.name, agency.acronym);

  // ── Card body (same markup regardless of wrapper) ──────────────────────────
  const body = (
    <div className="flex flex-col flex-1 p-4">
      {/* Header row */}
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded border border-gray-200 bg-gray-50 font-mono text-xs font-bold text-gray-700">
          {displayAcronym.slice(0, 5)}
        </div>
        <div className="min-w-0 flex-1">
          {/* Type + sector tags */}
          <div className="flex flex-wrap items-center gap-1 mb-0.5">
            <span
              className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-semibold ${typeColor}`}
            >
              {typeLabel}
            </span>
            {sectorTags.map((tag) => (
              <span
                key={tag.label}
                className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${tag.color}`}
              >
                {tag.label}
              </span>
            ))}
          </div>
          <p className="text-sm font-semibold leading-tight text-gray-900 group-hover:text-indigo-700 line-clamp-2">
            {agency.name}
            {agency.is_synthetic && <SyntheticMark size="xs" className="ml-1.5" />}
          </p>
        </div>
      </div>

      {/* Description */}
      {agency.description && (
        <p className="mt-2.5 line-clamp-2 text-xs leading-relaxed text-gray-500">
          {agency.description}
        </p>
      )}

      <div className="flex-1" />

      {/* Stats */}
      <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded border border-gray-100 bg-gray-100">
        <div className="bg-white px-3 py-2 text-center">
          <p className="text-sm font-bold text-gray-900">
            {agency.totalProposals > 0 ? agency.totalProposals.toLocaleString() : "—"}
          </p>
          <p className="text-[10px] text-gray-400">Total rules</p>
        </div>
        <div className="bg-white px-3 py-2 text-center">
          <p
            className={`text-sm font-bold ${
              agency.openProposals > 0 ? "text-emerald-600" : "text-gray-400"
            }`}
          >
            {agency.openProposals > 0 ? agency.openProposals.toLocaleString() : "—"}
          </p>
          <p className="text-[10px] text-gray-400">Open now</p>
        </div>
      </div>
    </div>
  );

  // ── Footer strip (stopPropagation on inner links) ──────────────────────────
  const footer = (
    <div className="flex items-center gap-1 border-t border-gray-100 bg-gray-50 px-3 py-2">
      <Link
        href={`/graph?entity=${agency.id}`}
        onClick={(e) => e.stopPropagation()}
        className="flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-gray-500 hover:bg-white hover:text-indigo-600 transition-colors"
        title="Explore in connection graph"
      >
        <svg
          aria-hidden="true"
          className="h-3 w-3"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <circle cx="5"  cy="12" r="2" />
          <circle cx="19" cy="5"  r="2" />
          <circle cx="19" cy="19" r="2" />
          <line x1="7"  y1="11" x2="17" y2="6"  strokeLinecap="round" />
          <line x1="7"  y1="13" x2="17" y2="18" strokeLinecap="round" />
        </svg>
        Graph
      </Link>

      {agency.website_url && (
        <a
          href={agency.website_url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-gray-500 hover:bg-white hover:text-indigo-600 transition-colors"
          title="Official website"
        >
          <svg
            aria-hidden="true"
            className="h-3 w-3"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
            />
          </svg>
          Website
        </a>
      )}

      <span className="ml-auto text-[11px] font-medium text-gray-400 group-hover:text-indigo-500 transition-colors">
        Details →
      </span>
    </div>
  );

  // ── Shared shell ──
  const sharedClass =
    "group flex flex-col rounded-lg border border-gray-200 bg-white hover:border-indigo-300 hover:shadow-sm transition-all overflow-hidden cursor-pointer text-left w-full h-full";

  // ── Button variant (opens slide-over) ──
  if (onClick) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick();
          }
        }}
        aria-label={`View ${agency.name} details`}
        className={sharedClass}
      >
        {body}
        {footer}
      </div>
    );
  }

  // ── Link variant (goes straight to detail page — homepage default) ──
  // Footer contains its own <Link>/<a> elements, so the outer wrapper must be
  // a <div> — nested <a> tags are invalid HTML and cause hydration mismatches.
  return (
    <div className={`${sharedClass} focus-within:ring-2 focus-within:ring-indigo-500 focus-within:ring-offset-2`}>
      <Link
        href={`/agencies/${agency.id}`}
        aria-label={agency.name}
        className="flex flex-col focus-visible:outline-none"
        tabIndex={0}
      >
        {body}
      </Link>
      {footer}
    </div>
  );
}
