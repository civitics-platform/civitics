import { NextResponse } from "next/server";
import { withPublicCdnCache } from "@/lib/cdn-cache";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";

export const dynamic = "force-dynamic";

type ChordRow = {
  agency_id: string;
  agency_name: string;
  agency_acronym: string;
  sector: string;
  total_cents: number;
  award_count: number;
};

type TreemapRow = {
  entity_id: string;
  entity_name: string;
  industry: string;
  naics_code: string | null;
  total_cents: number;
  award_count: number;
};

export async function GET(req: NextRequest) {
  if (supabaseUnavailable()) return unavailableResponse();

  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type") ?? "chord";

  const supabase = createAdminClient();

  // ── Chord: agency × sector flows ─────────────────────────────────────────
  if (type === "chord") {
    const { data, error } = await supabase.rpc("chord_contract_flows");
    if (error) {
      console.error("[spending/chord] RPC error:", error.message);
      // FIX-838: 502 (NOT a CDN-cached empty 200). A cache-miss RPC failure/
      // timeout must never pin an empty chord in the CDN for 1h — the pre-FIX-838
      // latent-correctness bug. Mirrors the FIX-854 chord-route precedent; the
      // SpendingGraph client checks res.ok and renders "couldn't load".
      return NextResponse.json(
        { error: "spending_rpc_failed", detail: error.message },
        { status: 502 },
      );
    }

    // FIX-878: chord_contract_flows() now RETURNS jsonb (one row: the full flows
    // array) instead of SETOF, so the >1,000-row flow set is not truncated by
    // PostgREST's max_rows cap. `data` is the jsonb array; the element shape is
    // unchanged (ChordRow), so the aggregation below is untouched.
    const rows = (Array.isArray(data) ? data : []) as unknown as ChordRow[];

    // Aggregate agency totals
    const agencyMap = new Map<string, { name: string; acronym: string; total: number; count: number }>();
    // Aggregate sector totals
    const sectorMap = new Map<string, { total: number; count: number }>();

    let totalCents = 0;

    for (const row of rows) {
      totalCents += Number(row.total_cents);

      const ag = agencyMap.get(row.agency_id) ?? { name: row.agency_name, acronym: row.agency_acronym, total: 0, count: 0 };
      ag.total += Number(row.total_cents);
      ag.count += Number(row.award_count);
      agencyMap.set(row.agency_id, ag);

      const sc = sectorMap.get(row.sector) ?? { total: 0, count: 0 };
      sc.total += Number(row.total_cents);
      sc.count += Number(row.award_count);
      sectorMap.set(row.sector, sc);
    }

    const agencies = [...agencyMap.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .map(([id, v]) => ({
        id,
        name: v.name,
        acronym: v.acronym,
        total_cents: v.total,
        award_count: v.count,
      }));

    const sectors = [...sectorMap.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .map(([sector, v]) => ({
        sector,
        total_cents: v.total,
        award_count: v.count,
      }));

    return withPublicCdnCache(NextResponse.json(
      { agencies, sectors, flows: rows, total_cents: totalCents },
      { headers: { "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400" } }
    ));
  }

  // ── Treemap: top recipients by contract value ─────────────────────────────
  if (type === "treemap") {
    const lim = Math.min(parseInt(searchParams.get("lim") ?? "100", 10), 200);
    const { data, error } = await supabase.rpc("treemap_recipients_by_contracts", { lim });
    if (error) {
      console.error("[spending/treemap] RPC error:", error.message);
      // FIX-838: 502, not a CDN-cached empty []. See the chord branch above.
      return NextResponse.json(
        { error: "spending_rpc_failed", detail: error.message },
        { status: 502 },
      );
    }

    const rows = (data ?? []) as TreemapRow[];
    return withPublicCdnCache(NextResponse.json(rows, {
      headers: { "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400" },
    }));
  }

  return NextResponse.json({ error: "Unknown type. Use ?type=chord or ?type=treemap" }, { status: 400 });
}
