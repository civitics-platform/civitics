import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";

export const dynamic = "force-dynamic";

/**
 * /api/graph/agency-staffing — FIX-217 / FIX-218
 *
 * Returns one row per agency with the dimensions needed for the "Agencies
 * by Staffing" scatter preset:
 *   - personnel_fte (OPM, FIX-214)
 *   - appointment count (entity_connections WHERE connection_type='appointment')
 *   - total_contract_cents / total_grant_cents (USASpending, FIX-194/114)
 *   - founded_year (Wikidata, FIX-208)
 *
 * Federal scope only by default; query param `agencyType` can switch.
 */

interface ResponseRow {
  agencyId: string;
  agencyName: string;
  agencyAcronym: string | null;
  agencyType: string;
  fte: number;
  appointmentCount: number;
  contractTotal: number;   // cents
  grantTotal: number;      // cents
  foundedYear: number | null;
}

export async function GET(req: NextRequest) {
  if (supabaseUnavailable()) return unavailableResponse();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createAdminClient() as any;

  const { searchParams } = new URL(req.url);
  const agencyType = searchParams.get("agencyType") ?? "federal";

  const { data: agencies, error: aErr } = await supabase
    .from("agencies")
    .select("id, name, acronym, short_name, agency_type, personnel_fte, founded_year")
    .eq("agency_type", agencyType)
    .eq("is_active", true)
    .limit(1000);

  if (aErr) {
    console.error("[agency-staffing] agencies fetch:", aErr.message);
    return NextResponse.json({ error: aErr.message }, { status: 500 });
  }
  if (!agencies || agencies.length === 0) {
    return NextResponse.json([]);
  }

  const agencyIds = agencies.map((a: { id: string }) => a.id);

  // Appointment counts via entity_connections.
  const { data: appts } = await supabase
    .from("entity_connections")
    .select("to_id")
    .eq("connection_type", "appointment")
    .eq("to_type", "agency")
    .in("to_id", agencyIds);

  const apptCountByAgency = new Map<string, number>();
  for (const r of (appts ?? []) as { to_id: string }[]) {
    apptCountByAgency.set(r.to_id, (apptCountByAgency.get(r.to_id) ?? 0) + 1);
  }

  // Contract + grant totals via per-agency aggregate. Computed inline since
  // financial_relationships doesn't have a per-agency rollup column on the
  // FROM side — only financial_entities has totals on the TO side.
  const { data: spendRows } = await supabase
    .from("financial_relationships")
    .select("from_id, amount_cents, relationship_type")
    .eq("from_type", "agency")
    .in("from_id", agencyIds)
    .in("relationship_type", ["contract", "grant"]);

  const contractByAgency = new Map<string, number>();
  const grantByAgency    = new Map<string, number>();
  for (const r of (spendRows ?? []) as { from_id: string; amount_cents: number | null; relationship_type: string }[]) {
    const map = r.relationship_type === "contract" ? contractByAgency : grantByAgency;
    map.set(r.from_id, (map.get(r.from_id) ?? 0) + (r.amount_cents ?? 0));
  }

  const rows: ResponseRow[] = agencies.map((a: {
    id: string;
    name: string;
    acronym: string | null;
    short_name: string | null;
    agency_type: string;
    personnel_fte: number | null;
    founded_year: number | null;
  }) => ({
    agencyId:        a.id,
    agencyName:      a.name,
    agencyAcronym:   a.acronym ?? a.short_name ?? null,
    agencyType:      a.agency_type,
    fte:             a.personnel_fte ?? 0,
    appointmentCount: apptCountByAgency.get(a.id) ?? 0,
    contractTotal:   contractByAgency.get(a.id) ?? 0,
    grantTotal:      grantByAgency.get(a.id) ?? 0,
    foundedYear:     a.founded_year,
  }));

  return NextResponse.json(rows, {
    headers: {
      "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
