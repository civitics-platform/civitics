import Link from "next/link";
import { FormerBadge } from "../FormerBadge";
import { SyntheticMark } from "../integrity/Synthetic";

// Presentational card for an institutions-view row (governing body or agency).
// Used by /jurisdictions/[id]; intended for reuse on future institution lists.
// Data fetching stays in the page — this only renders.
//
// NOTE (SF-P2 → FIX-600): the `institutions` DB VIEW now exposes is_synthetic on
// both UNION branches (migration 20260618010000), and both feeders select it —
// /institutions (institutions/page.tsx) and the jurisdictions/[id] institutions
// section — so the mark lights up for synthetic governing_bodies/agencies.
export type InstitutionCardData = {
  id: string;
  name: string;
  short_name: string | null;
  type: string;
  acronym: string | null;
  source_table?: "agency" | "governing_body";
  is_active?: boolean | null;
  is_synthetic?: boolean;
};

const TYPE_LABELS: Record<string, string> = {
  legislature_upper: "Upper Chamber",
  legislature_lower: "Lower Chamber",
  legislature_unicameral: "Legislature",
  executive: "Executive",
  judicial: "Court",
  regulatory_agency: "Regulatory Agency",
  municipal_council: "Municipal Council",
  school_board: "School Board",
  special_district: "Special District",
  international_body: "International Body",
  committee: "Committee",
  federal: "Federal Agency",
  state: "State Agency",
  local: "Local Agency",
  independent: "Independent Agency",
  international: "International Body",
};

function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type.replace(/_/g, " ");
}

export function InstitutionCard({ institution }: { institution: InstitutionCardData }) {
  return (
    <Link
      href={`/institutions/${institution.id}`}
      className="group block rounded-lg border border-gray-200 bg-white p-4 transition-all hover:border-gray-300 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-gray-900 group-hover:text-indigo-700">
            {institution.name}
            {institution.is_synthetic && <SyntheticMark size="xs" className="ml-1.5" />}
          </h3>
          <p className="mt-0.5 text-xs capitalize text-gray-500">{typeLabel(institution.type)}</p>
          <FormerBadge isActive={institution.is_active} className="mt-1" />
        </div>
        {institution.acronym && (
          <span className="shrink-0 rounded border border-gray-200 bg-gray-50 px-2 py-0.5 font-mono text-xs font-semibold text-gray-700">
            {institution.acronym}
          </span>
        )}
      </div>
    </Link>
  );
}
