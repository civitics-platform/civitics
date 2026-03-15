export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";
import { AgenciesList } from "./components/AgenciesList";

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
};

export default async function AgenciesPage() {
  const cookieStore = await cookies();
  const supabase = createServerClient(cookieStore);

  const { data: agencyRows, error } = await supabase
    .from("agencies")
    .select("id, name, short_name, acronym, agency_type, website_url, description")
    .eq("is_active", true)
    .order("name")
    .limit(200);

  if (error) console.error("agencies fetch error:", error.message);

  const rows = agencyRows ?? [];
  const now = new Date().toISOString();

  // Fetch proposal counts for each agency in parallel
  const statPairs = await Promise.all(
    rows.map((agency) => {
      const key = agency.acronym ?? agency.name;
      return Promise.all([
        supabase
          .from("proposals")
          .select("id", { count: "exact", head: true })
          .filter("metadata->>agency_id", "eq", key),
        supabase
          .from("proposals")
          .select("id", { count: "exact", head: true })
          .filter("metadata->>agency_id", "eq", key)
          .eq("status", "open_comment")
          .gt("comment_period_end", now),
      ]);
    })
  );

  const agencies: AgencyRow[] = rows.map((agency, i) => {
    const pair = statPairs[i];
    return {
      id: agency.id,
      name: agency.name,
      short_name: agency.short_name ?? null,
      acronym: agency.acronym ?? null,
      agency_type: agency.agency_type,
      website_url: agency.website_url ?? null,
      description: agency.description ?? null,
      totalProposals: pair?.[0]?.count ?? 0,
      openProposals: pair?.[1]?.count ?? 0,
    };
  });

  return <AgenciesList agencies={agencies} />;
}
