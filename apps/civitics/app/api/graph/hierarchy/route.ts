import { NextResponse } from "next/server";
import { withPublicCdnCache } from "@/lib/cdn-cache";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";
import { fetchChunkedByIds } from "@/lib/paginate";

export const dynamic = "force-dynamic";

// ── Types ─────────────────────────────────────────────────────────────────────

interface HierarchyNode {
  id: string;
  name: string;
  acronym: string | null;
  agency_type: string;
  // Aggregate contract spend on this node (for budget-weighted sizing).
  // Cents. Includes self only — UI may roll children up.
  budget_cents: number;
  award_count: number;
  // Direct child agencies (parent_agency_id = this.id).
  children: HierarchyNode[];
}

interface AgencyRow {
  id: string;
  parent_agency_id: string | null;
  name: string;
  short_name: string | null;
  acronym: string | null;
  agency_type: string;
}

interface SpendRow {
  from_id: string;
  amount_cents: number;
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (supabaseUnavailable()) return unavailableResponse();

  const { searchParams } = new URL(req.url);
  const rootParam = searchParams.get("root");
  const agencyType = searchParams.get("agencyType") ?? "federal";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createAdminClient() as any;

  // Pull all agencies of the requested type. Federal departments fit in well
  // under the 1k Supabase row limit, so a single query suffices.
  const { data: agencyRows, error: agencyErr } = await supabase
    .from("agencies")
    .select("id, parent_agency_id, name, short_name, acronym, agency_type")
    .eq("agency_type", agencyType)
    .eq("is_active", true)
    .order("name")
    .limit(1000);

  if (agencyErr) {
    console.error("[graph/hierarchy] agency fetch:", agencyErr.message);
    return NextResponse.json({ error: agencyErr.message }, { status: 500 });
  }

  const agencies = (agencyRows ?? []) as AgencyRow[];
  if (agencies.length === 0) {
    return withPublicCdnCache(NextResponse.json({ tree: null, total_budget_cents: 0 }));
  }

  // Pull contract totals per agency (financial_relationships from agency).
  // amount_cents is the FY-totalled spend; aggregating per from_id gives us
  // the budget figure to size each node by.
  // FIX-902: chunked. `ids` is the full active agency set for this agencyType,
  // capped only by the `.limit(1000)` above — 127 rows locally for the largest
  // type today and growing with every agency ingest, so a single `.in()` is
  // already within a factor of two of the 414 bound.
  const ids = agencies.map((a) => a.id);
  const { rows: spendRows, complete: spendComplete } = await fetchChunkedByIds<{
    from_id: string;
    amount_cents: number | null;
  }>(
    ids,
    (chunk) =>
      supabase
        .from("financial_relationships")
        .select("from_id, amount_cents")
        .eq("from_type", "agency")
        .eq("relationship_type", "contract")
        .in("from_id", chunk),
    { label: "graph/hierarchy:agency-spend" },
  );

  if (!spendComplete) {
    console.error("[graph/hierarchy] spend fetch incomplete — some agencies sized without contract totals");
  }

  const spendMap = new Map<string, { total: number; count: number }>();
  for (const row of spendRows as SpendRow[]) {
    const cur = spendMap.get(row.from_id) ?? { total: 0, count: 0 };
    cur.total += Number(row.amount_cents) || 0;
    cur.count += 1;
    spendMap.set(row.from_id, cur);
  }

  // Build node lookup with empty children arrays.
  const nodeMap = new Map<string, HierarchyNode>();
  for (const a of agencies) {
    const spend = spendMap.get(a.id) ?? { total: 0, count: 0 };
    nodeMap.set(a.id, {
      id: a.id,
      name: a.short_name ?? a.name,
      acronym: a.acronym,
      agency_type: a.agency_type,
      budget_cents: spend.total,
      award_count: spend.count,
      children: [],
    });
  }

  // Wire children to parents.
  const roots: HierarchyNode[] = [];
  for (const a of agencies) {
    const node = nodeMap.get(a.id)!;
    const parent = a.parent_agency_id ? nodeMap.get(a.parent_agency_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  // Sort children by budget descending so the tree reads as "largest first".
  function sortRecursive(node: HierarchyNode) {
    node.children.sort((x, y) => y.budget_cents - x.budget_cents || x.name.localeCompare(y.name));
    for (const child of node.children) sortRecursive(child);
  }

  let tree: HierarchyNode;
  if (rootParam) {
    const found = nodeMap.get(rootParam);
    if (!found) return withPublicCdnCache(NextResponse.json({ tree: null, total_budget_cents: 0 }));
    sortRecursive(found);
    tree = found;
  } else {
    // Synthetic root grouping all top-level agencies together.
    roots.sort((x, y) => y.budget_cents - x.budget_cents || x.name.localeCompare(y.name));
    for (const r of roots) sortRecursive(r);
    tree = {
      id: "root",
      name: agencyType === "federal" ? "Federal Government" : agencyType,
      acronym: null,
      agency_type: agencyType,
      budget_cents: 0,
      award_count: 0,
      children: roots,
    };
  }

  // Total spend for the headline figure.
  let total = 0;
  for (const v of spendMap.values()) total += v.total;

  return withPublicCdnCache(NextResponse.json(
    { tree, total_budget_cents: total },
    {
      headers: {
        "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
      },
    }
  ));
}
