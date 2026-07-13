import { NextResponse } from "next/server";
import { withPublicCdnCache } from "@/lib/cdn-cache";
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
// bound. PostgREST caps a single .select() at max_rows (1000), so we page the
// scan to actually reach this window (FIX-803).
const SCAN_LIMIT = 5000;
// PostgREST max_rows cap — the real per-request row ceiling / keyset page size.
const PAGE_SIZE = 1000;

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
  //
  // FIX-803: a single .limit(SCAN_LIMIT) is silently truncated to PostgREST's
  // max_rows (1000), so scannedRows/totalCents only ever reflected the top
  // 1000 contracts — 1/5 of the intended window. We page to reach the full
  // 5000, but via KEYSET (not .range()/OFFSET): OFFSET re-runs the whole
  // amount_cents sort per page (5x the work → statement timeout on the ~1.19M
  // contract rows), whereas a keyset cursor SEEKS via the
  // financial_relationships_amount (amount_cents DESC) index from the previous
  // page's last row — the whole window costs ~one index range scan. The id
  // tiebreak makes the (amount_cents DESC, id ASC) order total so equal-amount
  // rows never repeat or skip at page seams (the FIX-503 lesson).
  interface ScanRow extends ContractRow { id: string }
  const contracts: ContractRow[] = [];
  let cursor: { amount: number; id: string } | null = null;
  for (let fetched = 0; fetched < SCAN_LIMIT; fetched += PAGE_SIZE) {
    let contractsQuery = supabase
      .from("financial_relationships")
      .select("id, from_id, to_id, amount_cents, metadata")
      .eq("relationship_type", "contract")
      .eq("from_type", "agency")
      .eq("to_type", "financial_entity")
      .gt("amount_cents", 0)
      .order("amount_cents", { ascending: false })
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);
    if (agencyId) contractsQuery = contractsQuery.eq("from_id", agencyId);
    if (cursor) {
      // Rows strictly after the cursor in (amount_cents DESC, id ASC) order.
      contractsQuery = contractsQuery.or(
        `amount_cents.lt.${cursor.amount},and(amount_cents.eq.${cursor.amount},id.gt.${cursor.id})`,
      );
    }
    const { data: pageRows, error: contractsErr } = await contractsQuery;

    if (contractsErr) {
      console.error("[graph/sankey] contracts fetch:", contractsErr.message);
      return NextResponse.json({ error: contractsErr.message }, { status: 500 });
    }

    const page = (pageRows ?? []) as ScanRow[];
    if (page.length === 0) break;
    for (const r of page) {
      contracts.push({ from_id: r.from_id, to_id: r.to_id, amount_cents: r.amount_cents, metadata: r.metadata });
    }
    const last = page[page.length - 1]!;
    cursor = { amount: last.amount_cents, id: last.id };
    if (page.length < PAGE_SIZE) break; // exhausted before the ceiling
  }
  if (contracts.length === 0) {
    return withPublicCdnCache(NextResponse.json<SankeyResponse>({ flows: [], totalCents: 0, scannedRows: 0 }));
  }

  // Resolve agency + vendor names in chunked batched lookups. The id lists
  // derive from up to SCAN_LIMIT contract rows (vendorIds can be thousands);
  // a single .in() read 414'd behind Kong at ~234 uuids (FIX-772), so chunk at
  // 200 with per-chunk error checks — the FIX-732 shape.
  const agencyIds = [...new Set(contracts.map((c) => c.from_id))];
  const vendorIds = [...new Set(contracts.map((c) => c.to_id))];

  const ID_CHUNK = 200;
  function chunkIds(ids: string[]): string[][] {
    const out: string[][] = [];
    for (let i = 0; i < ids.length; i += ID_CHUNK) out.push(ids.slice(i, i + ID_CHUNK));
    return out;
  }
  async function fetchChunked<T>(
    ids: string[],
    label: string,
    build: (chunk: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  ): Promise<{ rows: T[]; error: string | null }> {
    const results = await Promise.all(chunkIds(ids).map((c) => build(c)));
    const rows: T[] = [];
    for (const r of results) {
      if (r.error) {
        console.error(`[graph/sankey] ${label} fetch:`, r.error.message);
        return { rows, error: r.error.message };
      }
      rows.push(...((r.data ?? []) as T[]));
    }
    return { rows, error: null };
  }

  const [agenciesRes, vendorsRes, tagsRes] = await Promise.all([
    fetchChunked<AgencyRow>(agencyIds, "agencies", (ids) =>
      supabase.from("agencies").select("id, name, acronym, short_name").in("id", ids)),
    fetchChunked<FinancialEntityRow>(vendorIds, "vendors", (ids) =>
      supabase.from("financial_entities").select("id, display_name").in("id", ids)),
    fetchChunked<TagRow>(vendorIds, "tags", (ids) =>
      supabase
        .from("entity_tags")
        .select("entity_id, tag")
        .eq("entity_type", "financial_entity")
        .eq("tag_category", "industry")
        .in("entity_id", ids)),
  ]);

  if (agenciesRes.error) {
    return NextResponse.json({ error: agenciesRes.error }, { status: 500 });
  }
  if (vendorsRes.error) {
    return NextResponse.json({ error: vendorsRes.error }, { status: 500 });
  }
  // Tags stay best-effort (sector falls back to NAICS prefix / "Other"), but a
  // failed chunk is now logged instead of silently narrowing every sector.

  const agencies = new Map<string, AgencyRow>(agenciesRes.rows.map((a) => [a.id, a]));
  const vendors = new Map<string, FinancialEntityRow>(vendorsRes.rows.map((v) => [v.id, v]));
  const vendorTags = new Map<string, string>(tagsRes.rows.map((t) => [t.entity_id, t.tag]));

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

  return withPublicCdnCache(NextResponse.json(response, {
    headers: {
      "Cache-Control":
        "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
    },
  }));
}
