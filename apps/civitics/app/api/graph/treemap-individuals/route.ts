import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";

export const dynamic = "force-dynamic";

/**
 * /api/graph/treemap-individuals — FIX-218
 *
 * Returns individual donors aggregated for the treemap. Two modes:
 *
 *  1. With entityId  — donors who gave to that official, grouped by state
 *                      (or industry if available, but most individuals lack tags).
 *  2. Without entityId — global aggregate of top individual donors by state.
 *
 * Uses financial_relationships joined to financial_entities WHERE
 * entity_type='individual' (FIX-181 populated this dataset; ~540k+ donors).
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

interface DonationLite { from_id: string; amount_cents: number | null }
interface DonorLite    { id: string; display_name: string; metadata: { state?: string } | null }

export async function GET(req: NextRequest) {
  if (supabaseUnavailable()) return unavailableResponse();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createAdminClient() as any;

  const { searchParams } = new URL(req.url);
  const entityIdRaw = searchParams.get("entityId");
  const entityId = entityIdRaw && UUID_RE.test(entityIdRaw) ? entityIdRaw : null;

  // Step 1: pull donations to either the focused official or globally
  // (capped to top 5000 by amount when global to keep the response bounded).
  let donationsQuery = supabase
    .from("financial_relationships")
    .select("from_id, amount_cents")
    .eq("relationship_type", "donation")
    .eq("from_type", "financial_entity")
    .eq("to_type", "official")
    .gt("amount_cents", 0)
    .order("amount_cents", { ascending: false });
  if (entityId) {
    donationsQuery = donationsQuery.eq("to_id", entityId);
  } else {
    donationsQuery = donationsQuery.limit(5000);
  }
  const { data: donations, error: dErr } = await donationsQuery;
  if (dErr) {
    console.error("[treemap-individuals] donations fetch:", dErr.message);
    return NextResponse.json({ error: dErr.message }, { status: 500 });
  }
  const donationRows = (donations ?? []) as DonationLite[];
  if (donationRows.length === 0) return NextResponse.json({ name: "Individual donors", children: [] } as ResponseShape);

  // Step 2: filter to individual donors only.
  const donorIds = [...new Set(donationRows.map(r => r.from_id))];
  const donorMap = new Map<string, { name: string; state: string }>();
  const BATCH = 300;
  for (let i = 0; i < donorIds.length; i += BATCH) {
    const batch = donorIds.slice(i, i + BATCH);
    const { data: donors } = await supabase
      .from("financial_entities")
      .select("id, display_name, metadata")
      .in("id", batch)
      .eq("entity_type", "individual");
    for (const d of (donors ?? []) as DonorLite[]) {
      donorMap.set(d.id, {
        name:  d.display_name,
        state: d.metadata?.state ?? "??",
      });
    }
  }

  if (donorMap.size === 0) {
    return NextResponse.json({ name: "Individual donors", children: [] } as ResponseShape);
  }

  // Step 3: aggregate by state then donor.
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

  // Step 4: build hierarchy. Cap top 50 states × top 50 donors each to
  // keep the treemap legible.
  const PER_STATE_CAP = 50;
  const STATE_CAP     = 50;
  const children: StateGroup[] = Array.from(byState.entries())
    .map(([state, donors]) => {
      const leaves: IndividualLeaf[] = Array.from(donors.entries())
        .map(([name, stats]) => ({ name, value: stats.totalUsd, count: stats.count, state }))
        .sort((a, b) => b.value - a.value)
        .slice(0, PER_STATE_CAP);
      return {
        name: state,
        totalUsd: leaves.reduce((s, l) => s + l.value, 0),
        children: leaves,
      };
    })
    .sort((a, b) => b.totalUsd - a.totalUsd)
    .slice(0, STATE_CAP);

  return NextResponse.json({
    name: entityId ? "Individual donors (focused)" : "Top Individual Donors by State",
    children,
  } as ResponseShape, {
    headers: { "Cache-Control": "public, max-age=0, s-maxage=86400, stale-while-revalidate=172800" },
  });
}
