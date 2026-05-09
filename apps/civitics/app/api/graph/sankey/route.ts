import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";

export const dynamic = "force-dynamic";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ContractRow {
  from_id: string;
  to_id: string;
  amount_cents: number;
  metadata: Record<string, unknown> | null;
}

interface AgencyRow {
  id: string;
  name: string;
  acronym: string | null;
  short_name: string | null;
}

interface FinancialEntityRow {
  id: string;
  display_name: string;
}

interface TagRow {
  entity_id: string;
  tag: string;
}

export interface SankeyFlow {
  agencyId: string;
  agencyName: string;
  agencyAcronym: string;
  sector: string;
  vendorId: string;
  vendorName: string;
  amountCents: number;
  awardCount: number;
}

export interface SankeyResponse {
  flows: SankeyFlow[];
  /** Total cents represented across the returned flow set. */
  totalCents: number;
  /** Number of contract rows scanned (may be capped). */
  scannedRows: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// NAICS 2-digit prefix → human-readable sector.
// Matches the buckets used by chord_contract_flows so the two viz types stay
// visually consistent.
function naicsToSector(naics: string | null | undefined): string {
  if (!naics) return "Other";
  const prefix = naics.slice(0, 2);
  switch (prefix) {
    case "11": return "Agriculture";
    case "21": return "Mining";
    case "22": return "Utilities";
    case "23": return "Construction";
    case "31":
    case "32":
    case "33": return "Manufacturing";
    case "42": return "Wholesale Trade";
    case "44":
    case "45": return "Retail";
    case "48":
    case "49": return "Transportation";
    case "51": return "Information Technology";
    case "52": return "Finance";
    case "53": return "Real Estate";
    case "54": return "Professional Services";
    case "55": return "Management";
    case "56": return "Administrative";
    case "61": return "Education";
    case "62": return "Health Care";
    case "71": return "Entertainment";
    case "72": return "Accommodation";
    case "81": return "Other Services";
    case "92": return "Public Administration";
    default:   return "Other";
  }
}

// Scan ceiling. Contracts are heavily power-law distributed by amount, so the
// top-N rows already cover ~99% of total spend. 5000 is a comfortable upper
// bound that fits in a single Supabase response.
const SCAN_LIMIT = 5000;

// ── Route ─────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (supabaseUnavailable()) return unavailableResponse();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createAdminClient() as any;

  // FIX-218: when an agencyId is provided, narrow the contract scan to flows
  // originating from that agency. Powers the "Federal Spending Flows on
  // {agency}" preset where the user has, e.g., DOD focused and wants only
  // DOD's contract → sector → vendor breakdown.
  const { searchParams } = new URL(req.url);
  const agencyIdParam = searchParams.get("agencyId");
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const agencyId = agencyIdParam && UUID_RE.test(agencyIdParam) ? agencyIdParam : null;

  // Pull the largest contracts first. The Sankey is dominated by the top of
  // the distribution; capping here keeps response size bounded.
  let contractsQuery = supabase
    .from("financial_relationships")
    .select("from_id, to_id, amount_cents, metadata")
    .eq("relationship_type", "contract")
    .eq("from_type", "agency")
    .eq("to_type", "financial_entity")
    .gt("amount_cents", 0)
    .order("amount_cents", { ascending: false })
    .limit(SCAN_LIMIT);
  if (agencyId) contractsQuery = contractsQuery.eq("from_id", agencyId);
  const { data: contractRows, error: contractsErr } = await contractsQuery;

  if (contractsErr) {
    console.error("[graph/sankey] contracts fetch:", contractsErr.message);
    return NextResponse.json({ error: contractsErr.message }, { status: 500 });
  }

  const contracts = (contractRows ?? []) as ContractRow[];
  if (contracts.length === 0) {
    return NextResponse.json<SankeyResponse>({ flows: [], totalCents: 0, scannedRows: 0 });
  }

  // Resolve agency + vendor names in two batched lookups.
  const agencyIds = [...new Set(contracts.map((c) => c.from_id))];
  const vendorIds = [...new Set(contracts.map((c) => c.to_id))];

  const [agenciesRes, vendorsRes, tagsRes] = await Promise.all([
    supabase
      .from("agencies")
      .select("id, name, acronym, short_name")
      .in("id", agencyIds),
    supabase
      .from("financial_entities")
      .select("id, display_name")
      .in("id", vendorIds),
    supabase
      .from("entity_tags")
      .select("entity_id, tag")
      .eq("entity_type", "financial_entity")
      .eq("tag_category", "industry")
      .in("entity_id", vendorIds),
  ]);

  if (agenciesRes.error) {
    console.error("[graph/sankey] agencies fetch:", agenciesRes.error.message);
    return NextResponse.json({ error: agenciesRes.error.message }, { status: 500 });
  }
  if (vendorsRes.error) {
    console.error("[graph/sankey] vendors fetch:", vendorsRes.error.message);
    return NextResponse.json({ error: vendorsRes.error.message }, { status: 500 });
  }

  const agencies = new Map<string, AgencyRow>(
    ((agenciesRes.data ?? []) as AgencyRow[]).map((a) => [a.id, a]),
  );
  const vendors = new Map<string, FinancialEntityRow>(
    ((vendorsRes.data ?? []) as FinancialEntityRow[]).map((v) => [v.id, v]),
  );
  const vendorTags = new Map<string, string>(
    ((tagsRes.data ?? []) as TagRow[]).map((t) => [t.entity_id, t.tag]),
  );

  // Aggregate to (agency, sector, vendor) buckets.
  const flowMap = new Map<string, SankeyFlow>();
  let total = 0;

  for (const row of contracts) {
    const agency = agencies.get(row.from_id);
    const vendor = vendors.get(row.to_id);
    if (!agency || !vendor) continue;

    const naics = (row.metadata?.naics_code as string | null | undefined) ?? null;
    // Industry tag (FIX-109) takes priority over NAICS prefix mapping.
    // The legacy financial_entities.industry fallback was removed in FIX-167
    // (column was polluted with FEC CONNECTED_ORG_NM and has been dropped).
    const sector =
      vendorTags.get(vendor.id) ?? (naics ? naicsToSector(naics) : null) ?? "Other";

    const key = `${agency.id}|${sector}|${vendor.id}`;
    const existing = flowMap.get(key);
    const amount = Number(row.amount_cents) || 0;
    total += amount;

    if (existing) {
      existing.amountCents += amount;
      existing.awardCount += 1;
    } else {
      flowMap.set(key, {
        agencyId: agency.id,
        agencyName: agency.short_name ?? agency.name,
        agencyAcronym: agency.acronym ?? agency.short_name ?? agency.name,
        sector,
        vendorId: vendor.id,
        vendorName: vendor.display_name,
        amountCents: amount,
        awardCount: 1,
      });
    }
  }

  const flows = [...flowMap.values()].sort((a, b) => b.amountCents - a.amountCents);

  const response: SankeyResponse = {
    flows,
    totalCents: total,
    scannedRows: contracts.length,
  };

  return NextResponse.json(response, {
    headers: {
      "Cache-Control":
        "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
