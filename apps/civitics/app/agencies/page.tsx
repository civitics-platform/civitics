export const dynamic = "force-dynamic";

// TODO: deprecate post Stage 3 — see FIX-418. Stage 3 collapses agencies
// into governing_bodies; the institutions index page replaces this one.

import { cookies } from "next/headers";
import { createServerClient, agencyFullName } from "@civitics/db";
import { withDbTimeout } from "../../src/lib/supabase-check";
import { AgenciesList } from "./components/AgenciesList";
import { AgencyActivityChart } from "./components/AgencyActivityChart";
import { GroupBuilderWidget } from "./components/GroupBuilderWidget";
import { HierarchyEmbed } from "./components/HierarchyEmbed";
import { PageViewTracker } from "../components/PageViewTracker";
import { PageHeader } from "@civitics/ui";

export const metadata = { title: "Agencies" };

export type AgencyRow = {
  id: string;
  name: string;
  short_name: string | null;
  acronym: string | null;
  agency_type: string;
  website_url: string | null;
  description: string | null;
  totalProposals: number;
  openProposals: number;
  is_synthetic?: boolean;
};

export default async function AgenciesPage() {
  const cookieStore = await cookies();
  const supabase = createServerClient(cookieStore);

  const [{ data: agencyRows, error }, { data: featuredRow }] = await Promise.all([
    supabase
      .from("agencies")
      .select("id, name, short_name, acronym, agency_type, website_url, description, is_synthetic")
      .eq("is_active", true)
      .order("name")
      .limit(200),
    supabase
      .from("agencies")
      .select("id, name, short_name, acronym, agency_type, website_url, description, is_synthetic")
      .filter("metadata->>featured", "eq", "true")
      .limit(1)
      .maybeSingle(),
  ]);

  if (error) console.error("agencies fetch error:", error.message);

  const rows = agencyRows ?? [];

  // FIX-330 — read from homepage_agency_counts_mv (refreshed nightly).
  // Same (agency_id, total, open) shape the FIX-303 RPC returns, served
  // from a unique-indexed MV. 1000ms request-path budget; falls back to
  // the FIX-303 RPC below when the MV is missing/empty (fresh DB,
  // post-truncate). Homepage Wave 2 consumes the same MV.
  type AgencyCountRow = { agency_id: string; total: number | string; open: number | string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sbAny = supabase as any;
  const countsMvRes = await withDbTimeout<{ data: AgencyCountRow[] | null; error: { message: string } | null }>(
    sbAny.from("homepage_agency_counts_mv").select("agency_id,total,open"),
    1000
  );
  if (countsMvRes.error) console.error("agency counts MV read error:", countsMvRes.error.message);
  let countsRows = countsMvRes.data ?? [];
  if (countsRows.length === 0) {
    // FIX-330 fallback — MV missing or empty. Falls back to the FIX-303 RPC
    // at its prior 5000ms request-path budget.
    const countsRes = await withDbTimeout<{ data: AgencyCountRow[] | null; error: { message: string } | null }>(
      sbAny.rpc("get_proposal_counts_by_agency"),
      5000
    );
    if (countsRes.error) console.error("agency counts RPC error:", countsRes.error.message);
    countsRows = countsRes.data ?? [];
  }
  const countsByAgency = new Map<string, { total: number; open: number }>(
    countsRows.map((r) => [
      r.agency_id,
      { total: Number(r.total), open: Number(r.open) },
    ])
  );

  const agencies: AgencyRow[] = rows.map((agency) => {
    const key = agency.acronym ?? agency.name;
    const counts = countsByAgency.get(key) ?? { total: 0, open: 0 };
    return {
      id: agency.id,
      name: agencyFullName(agency.acronym) ?? agency.name,
      short_name: agency.short_name ?? null,
      acronym: agency.acronym ?? null,
      agency_type: agency.agency_type,
      website_url: agency.website_url ?? null,
      description: agency.description ?? null,
      totalProposals: counts.total,
      openProposals: counts.open,
      is_synthetic: agency.is_synthetic ?? false,
    };
  });

  const featuredAgency: AgencyRow | null = featuredRow
    ? {
        id:             featuredRow.id,
        name:           agencyFullName(featuredRow.acronym) ?? featuredRow.name,
        short_name:     featuredRow.short_name ?? null,
        acronym:        featuredRow.acronym ?? null,
        agency_type:    featuredRow.agency_type,
        website_url:    featuredRow.website_url ?? null,
        description:    featuredRow.description ?? null,
        totalProposals: agencies.find((a) => a.id === featuredRow.id)?.totalProposals ?? 0,
        openProposals:  agencies.find((a) => a.id === featuredRow.id)?.openProposals ?? 0,
        is_synthetic:   featuredRow.is_synthetic ?? false,
      }
    : null;

  const chartRows = [...agencies]
    .sort((a, b) => b.totalProposals - a.totalProposals)
    .slice(0, 12)
    .map((a) => ({ name: a.name, acronym: a.acronym, count: a.totalProposals }));

  return (
    <div className="min-h-screen bg-gray-50">
      <PageViewTracker entityType="agency_list" />
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <PageHeader
          title="Agencies"
          description="Federal agencies, their active rulemaking, and open comment periods."
          breadcrumb={[
            { label: "Civitics", href: "/" },
            { label: "Agencies" },
          ]}
        />
        <HierarchyEmbed />
        <div className="grid gap-6 lg:grid-cols-[1fr,260px]">
          <AgencyActivityChart rows={chartRows} />
          <GroupBuilderWidget />
        </div>
      </div>
      <AgenciesList agencies={agencies} featuredAgency={featuredAgency} />
    </div>
  );
}
