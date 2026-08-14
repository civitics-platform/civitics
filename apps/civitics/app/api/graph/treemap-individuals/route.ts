import { NextResponse } from "next/server";
import { withPublicCdnCache } from "@/lib/cdn-cache";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";
import { fetchAllRows, fetchChunkedByIds } from "@/lib/paginate";

export const dynamic = "force-dynamic";

/**
 * /api/graph/treemap-individuals — FIX-218
 *
 * Returns individual donors aggregated for the treemap. Two modes:
 *
 *  1. With entityId  — donors who gave to that official, grouped by state.
 *  2. Without entityId — global aggregate of top individual donors by state.
 *
 * FIX-779: served from public.treemap_individuals_rollup via the cap-proof
 * get_treemap_individuals(scope) RPC (top-50 states × top-50 donors, per-state
 * total = sum of the shown 50). This ALSO fixes the global coverage gap — the
 * live path below capped its scan at 20k rows (<1% of ~2.38M), so the old global
 * treemap showed an arbitrary sliver; the rollup is the TRUE uncapped aggregate.
 * The live JS aggregation stays as the per-scope miss fallback.
 */

interface IndividualLeaf {
  name: string;
  value: number;
  count: number;
  state: string;
}

interface StateGroup {
  name: string;        // state code
  totalUsd: number;
  children: IndividualLeaf[];
}

interface ResponseShape {
  name: string;
  children: StateGroup[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// scope_id used for the global (no-entityId) treemap rollup partition.
const GLOBAL_SCOPE = "00000000-0000-0000-0000-000000000000";

interface DonationLite { from_id: string; amount_cents: number | null }
interface DonorLite    { id: string; display_name: string; metadata: { state?: string } | null }

// FIX-779 live-compute fallback: the pre-materialization aggregation. Pages the
// donations (focused-to-official or global), filters to individual donors, and
// aggregates by (state, donor display_name), top-50 states × top-50 donors.
// Retains the safety scan ceilings (focused 100k / global 20k) — this path is
// only the per-scope miss fallback now (the RPC serves the uncapped rollup);
// keeping the ceilings bounds a degraded-DB fallback response.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function computeTreemapIndividualsLive(supabase: any, entityId: string | null): Promise<StateGroup[]> {
  const { rows: donationRows, error: dErr } = await fetchAllRows<DonationLite>((f, t) => {
    let q = supabase
      .from("financial_relationships")
      .select("from_id, amount_cents")
      .eq("relationship_type", "donation")
      .eq("from_type", "financial_entity")
      .eq("to_type", "official")
      .gt("amount_cents", 0);
    if (entityId) q = q.eq("to_id", entityId);
    return q.order("id", { ascending: true }).range(f, t);
  }, { maxRows: entityId ? 100000 : 20000 });
  if (dErr) {
    console.error("[treemap-individuals] donations fetch:", dErr.message);
    return [];
  }
  if (donationRows.length === 0) return [];

  // FIX-902: this loop WAS chunked — at 300, above the URL bound rather than
  // below it (~11 KB per request; 414 verified at ~356 in FIX-509 and ~234 in
  // FIX-772). The donations read above admits up to 100,000 rows, so donorIds
  // is routinely in the thousands and every chunk sat in the failure window;
  // a tripped chunk silently drops 300 donors out of the state rollup, which
  // reads as "these states gave less" rather than as an error.
  const donorIds = [...new Set(donationRows.map(r => r.from_id))];
  const donorMap = new Map<string, { name: string; state: string }>();
  const { rows: donors, complete: donorsComplete } = await fetchChunkedByIds<DonorLite>(
    donorIds,
    (ids) =>
      supabase
        .from("financial_entities")
        .select("id, display_name, metadata")
        .in("id", ids)
        .eq("entity_type", "individual"),
    { label: "treemap-individuals:donors" },
  );
  if (!donorsComplete) {
    console.error("[treemap-individuals] donor read incomplete — state totals understated");
  }
  for (const d of donors) {
    donorMap.set(d.id, { name: d.display_name, state: d.metadata?.state ?? "??" });
  }
  if (donorMap.size === 0) return [];

  const byState = new Map<string, Map<string, { totalUsd: number; count: number }>>();
  for (const d of donationRows) {
    const info = donorMap.get(d.from_id);
    if (!info) continue;
    const usd = (d.amount_cents ?? 0) / 100;
    if (!byState.has(info.state)) byState.set(info.state, new Map());
    const donors = byState.get(info.state)!;
    const prev = donors.get(info.name) ?? { totalUsd: 0, count: 0 };
    donors.set(info.name, { totalUsd: prev.totalUsd + usd, count: prev.count + 1 });
  }

  const PER_STATE_CAP = 50;
  const STATE_CAP     = 50;
  return Array.from(byState.entries())
    .map(([state, donors]) => {
      const leaves: IndividualLeaf[] = Array.from(donors.entries())
        .map(([name, stats]) => ({ name, value: stats.totalUsd, count: stats.count, state }))
        .sort((a, b) => b.value - a.value)
        .slice(0, PER_STATE_CAP);
      return { name: state, totalUsd: leaves.reduce((s, l) => s + l.value, 0), children: leaves };
    })
    .sort((a, b) => b.totalUsd - a.totalUsd)
    .slice(0, STATE_CAP);
}

export async function GET(req: NextRequest) {
  if (supabaseUnavailable()) return unavailableResponse();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createAdminClient() as any;

  const { searchParams } = new URL(req.url);
  const entityIdRaw = searchParams.get("entityId");
  const entityId = entityIdRaw && UUID_RE.test(entityIdRaw) ? entityIdRaw : null;
  const title = entityId ? "Individual donors (focused)" : "Top Individual Donors by State";
  const cache = {
    "Cache-Control": "public, max-age=0, s-maxage=86400, stale-while-revalidate=172800",
  };

  // FIX-779 fast path: cap-proof assembly RPC over treemap_individuals_rollup.
  const { data: children, error: rpcErr } = await supabase.rpc("get_treemap_individuals", {
    p_scope: entityId ?? GLOBAL_SCOPE,
  });
  if (!rpcErr && Array.isArray(children) && children.length > 0) {
    return withPublicCdnCache(NextResponse.json({ name: title, children } as ResponseShape, { headers: cache }));
  }
  if (rpcErr) console.error("[treemap-individuals] rollup RPC (falling back to live):", rpcErr.message);

  // Per-scope miss fallback (scope absent from the rollup — not yet backfilled, or
  // no individual donors — or an RPC error).
  const liveChildren = await computeTreemapIndividualsLive(supabase, entityId);
  return withPublicCdnCache(NextResponse.json({ name: title, children: liveChildren } as ResponseShape, { headers: cache }));
}
