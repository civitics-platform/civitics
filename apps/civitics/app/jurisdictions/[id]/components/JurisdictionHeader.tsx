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
  country: "bg-paper-2 text-ink-soft border-rule",
  state: "bg-civic-blue/10 text-civic-blue border-civic-blue/25",
  county: "bg-green-ink/10 text-green-ink border-green-ink/25",
  city: "bg-amber/20 text-ink border-amber/60",
  district: "bg-viz-7/10 text-viz-7 border-viz-7/25",
  school_district: "bg-viz-7/10 text-viz-7 border-viz-7/25",
  special_district: "bg-viz-3/10 text-viz-3 border-viz-3/25",
  federal_district: "bg-accent/10 text-accent border-accent/25",
  unincorporated_territory: "bg-accent/10 text-accent border-accent/25",
  other: "bg-paper-2 text-ink-soft border-rule",
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
    <div className="border border-rule bg-card p-6">
      <PageViewTracker entityType="jurisdiction" entityId={jurisdiction.id} />

      {parent && (
        <nav className="mb-2 text-xs text-ink-soft/70" aria-label="Breadcrumb">
          <Link href={`/jurisdictions/${parent.id}`} className="hover:text-accent hover:underline">
            {parent.name}
          </Link>
          <span className="mx-1.5 text-ink-soft/70">/</span>
          <span className="text-ink-soft">{jurisdiction.name}</span>
        </nav>
      )}

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold text-ink">{jurisdiction.name}</h1>
            <span className={`rounded border px-2 py-0.5 text-xs font-semibold ${typeColor}`}>
              {typeLabel}
            </span>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-soft/70">
            {jurisdiction.population != null && (
              <span>
                Population{" "}
                <span className="font-medium text-ink-soft">
                  {jurisdiction.population.toLocaleString()}
                </span>
              </span>
            )}
            {jurisdiction.timezone && <span>{jurisdiction.timezone}</span>}
            {jurisdiction.fips_code && (
              <span className="text-xs text-ink-soft/70">FIPS {jurisdiction.fips_code}</span>
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
