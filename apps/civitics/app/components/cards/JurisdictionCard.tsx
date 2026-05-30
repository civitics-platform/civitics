import Link from "next/link";

// Presentational card for a jurisdiction row. Used by the /jurisdictions index
// and reusable on any jurisdiction list surface. Data fetching stays in the
// page — this only renders.
export type JurisdictionCardData = {
  id: string;
  name: string;
  short_name: string | null;
  type: string;
  population: number | null;
  parentName: string | null;
};

const TYPE_LABELS: Record<string, string> = {
  country: "Country",
  state: "State",
  county: "County",
  city: "City",
  district: "District",
  federal_district: "Federal District",
  unincorporated_territory: "Territory",
  school_district: "School District",
  special_district: "Special District",
  precinct: "Precinct",
  supranational: "Supranational",
  global: "Global",
  other: "Other",
};

function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type.replace(/_/g, " ");
}

function formatPopulation(pop: number): string {
  return pop.toLocaleString("en-US");
}

export function JurisdictionCard({ jurisdiction }: { jurisdiction: JurisdictionCardData }) {
  return (
    <Link
      href={`/jurisdictions/${jurisdiction.id}`}
      className="group block rounded-lg border border-gray-200 bg-white p-4 transition-all hover:border-gray-300 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-gray-900 group-hover:text-indigo-700">
            {jurisdiction.name}
          </h3>
          {jurisdiction.parentName && (
            <p className="mt-0.5 truncate text-xs text-gray-400">{jurisdiction.parentName}</p>
          )}
        </div>
        <span className="shrink-0 rounded border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs font-medium capitalize text-gray-600">
          {typeLabel(jurisdiction.type)}
        </span>
      </div>
      {jurisdiction.population != null && jurisdiction.population > 0 && (
        <p className="mt-2 text-xs text-gray-500">
          Pop. {formatPopulation(jurisdiction.population)}
        </p>
      )}
    </Link>
  );
}
