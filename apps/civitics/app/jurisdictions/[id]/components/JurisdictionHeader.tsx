import Link from "next/link";
import { PageViewTracker } from "../../../components/PageViewTracker";
import { FollowButton } from "../../../components/FollowButton";

export const JURISDICTION_TYPE_LABELS: Record<string, string> = {
  global: "Global",
  supranational: "Supranational",
  country: "Country",
  state: "State",
  county: "County",
  city: "City",
  district: "District",
  precinct: "Precinct",
  school_district: "School District",
  special_district: "Special District",
  federal_district: "Federal District",
  unincorporated_territory: "Territory",
  other: "Jurisdiction",
};

const JURISDICTION_TYPE_COLORS: Record<string, string> = {
  country: "bg-slate-50 text-slate-700 border-slate-200",
  state: "bg-blue-50 text-blue-700 border-blue-200",
  county: "bg-green-50 text-green-700 border-green-200",
  city: "bg-amber-50 text-amber-700 border-amber-200",
  district: "bg-purple-50 text-purple-700 border-purple-200",
  school_district: "bg-purple-50 text-purple-700 border-purple-200",
  special_district: "bg-teal-50 text-teal-700 border-teal-200",
  federal_district: "bg-red-50 text-red-700 border-red-200",
  unincorporated_territory: "bg-indigo-50 text-indigo-700 border-indigo-200",
  other: "bg-gray-50 text-gray-600 border-gray-200",
};

export type JurisdictionHeaderData = {
  id: string;
  name: string;
  short_name: string | null;
  type: string;
  population: number | null;
  timezone: string | null;
  fips_code: string | null;
};

export function JurisdictionHeader({
  jurisdiction,
  parent,
}: {
  jurisdiction: JurisdictionHeaderData;
  parent: { id: string; name: string } | null;
}) {
  const typeColor =
    JURISDICTION_TYPE_COLORS[jurisdiction.type] ?? JURISDICTION_TYPE_COLORS["other"]!;
  const typeLabel = JURISDICTION_TYPE_LABELS[jurisdiction.type] ?? "Jurisdiction";

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6">
      <PageViewTracker entityType="jurisdiction" entityId={jurisdiction.id} />

      {parent && (
        <nav className="mb-2 text-xs text-gray-500" aria-label="Breadcrumb">
          <Link href={`/jurisdictions/${parent.id}`} className="hover:text-indigo-700 hover:underline">
            {parent.name}
          </Link>
          <span className="mx-1.5 text-gray-300">/</span>
          <span className="text-gray-700">{jurisdiction.name}</span>
        </nav>
      )}

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold text-gray-900">{jurisdiction.name}</h1>
            <span className={`rounded border px-2 py-0.5 text-xs font-semibold ${typeColor}`}>
              {typeLabel}
            </span>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-500">
            {jurisdiction.population != null && (
              <span>
                Population{" "}
                <span className="font-medium text-gray-700">
                  {jurisdiction.population.toLocaleString()}
                </span>
              </span>
            )}
            {jurisdiction.timezone && <span>{jurisdiction.timezone}</span>}
            {jurisdiction.fips_code && (
              <span className="text-xs text-gray-400">FIPS {jurisdiction.fips_code}</span>
            )}
          </div>
        </div>

        <div className="flex flex-col items-end gap-2">
          <FollowButton
            entityType="jurisdiction"
            entityId={jurisdiction.id}
            entityLabel={jurisdiction.name}
          />
        </div>
      </div>
    </div>
  );
}
