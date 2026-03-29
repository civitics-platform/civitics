import { createAdminClient } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";

export const dynamic = "force-dynamic";

// ── Hierarchy types ──────────────────────────────────────────────────────────

interface PacLeaf {
  name: string;
  value: number;
  count: number;
}

interface PacGroup {
  name: string;
  totalUsd: number;
  children: PacLeaf[];
}

interface PacHierarchy {
  name: string;
  children: PacGroup[];
}

// ── Route handler ────────────────────────────────────────────────────────────

export async function GET(request: Request) {
  if (supabaseUnavailable()) return unavailableResponse();
  const supabase = createAdminClient();

  const { searchParams } = new URL(request.url);
  const groupBy = (searchParams.get("groupBy") ?? "sector") as "sector" | "party";

  // ── Sector mode ──────────────────────────────────────────────────────────────

  if (groupBy === "sector") {
    const { data, error } = await supabase
      .from("financial_relationships")
      .select("donor_name, amount_cents, metadata")
      .eq("donor_type", "pac")
      .not("metadata->>sector", "is", null);

    if (error) {
      console.error("[treemap-pac/sector] query error:", error.message);
      return Response.json({ error: error.message }, { status: 500 });
    }

    // sector → donor → { totalUsd, count }
    const bySector = new Map<string, Map<string, { totalUsd: number; count: number }>>();

    for (const row of data ?? []) {
      const meta   = row.metadata as Record<string, string> | null;
      const sector = meta?.sector ?? "Other";
      const donor  = (row.donor_name as string) ?? "Unknown";
      const usd    = (row.amount_cents as number) / 100;

      if (!bySector.has(sector)) bySector.set(sector, new Map());
      const donors = bySector.get(sector)!;
      const prev   = donors.get(donor) ?? { totalUsd: 0, count: 0 };
      donors.set(donor, { totalUsd: prev.totalUsd + usd, count: prev.count + 1 });
    }

    // Build hierarchy — top 15 sectors, top 20 donors each
    const children: PacGroup[] = Array.from(bySector.entries())
      .map(([sector, donors]) => {
        const leaves: PacLeaf[] = Array.from(donors.entries())
          .map(([name, stats]) => ({ name, value: stats.totalUsd, count: stats.count }))
          .sort((a, b) => b.value - a.value)
          .slice(0, 20);

        return {
          name:     sector,
          totalUsd: leaves.reduce((s, l) => s + l.value, 0),
          children: leaves,
        };
      })
      .sort((a, b) => b.totalUsd - a.totalUsd)
      .slice(0, 15);

    const hierarchy: PacHierarchy = { name: "PAC Money by Sector", children };
    return Response.json(hierarchy);
  }

  // ── Party mode ───────────────────────────────────────────────────────────────

  const { data, error } = await supabase.rpc("get_pac_donations_by_party");

  if (error) {
    console.error("[treemap-pac/party] rpc error:", error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }

  // party → donor → { totalUsd, count }
  const byParty = new Map<string, Map<string, { totalUsd: number; count: number }>>();

  for (const row of data ?? []) {
    const party  = (row.party as string) ?? "Unknown";
    const donor  = (row.donor_name as string) ?? "Unknown";
    const usd    = Number(row.total_usd) ?? 0;
    const count  = Number(row.donation_count) ?? 0;

    if (!byParty.has(party)) byParty.set(party, new Map());
    const donors = byParty.get(party)!;
    const prev   = donors.get(donor) ?? { totalUsd: 0, count: 0 };
    donors.set(donor, { totalUsd: prev.totalUsd + usd, count: prev.count + count });
  }

  // Build hierarchy — all parties, top 20 donors each
  const children: PacGroup[] = Array.from(byParty.entries())
    .map(([party, donors]) => {
      const leaves: PacLeaf[] = Array.from(donors.entries())
        .map(([name, stats]) => ({ name, value: stats.totalUsd, count: stats.count }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 20);

      return {
        name:     party,
        totalUsd: leaves.reduce((s, l) => s + l.value, 0),
        children: leaves,
      };
    })
    .sort((a, b) => b.totalUsd - a.totalUsd);

  const hierarchy: PacHierarchy = { name: "PAC Money by Party", children };
  return Response.json(hierarchy);
}
