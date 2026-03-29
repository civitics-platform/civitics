import { createAdminClient } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";

export const dynamic = "force-dynamic";

// ── Shared hierarchy types ───────────────────────────────────────────────────

interface PacLeaf {
  name: string;
  value: number;
  pacId: string;
  officialCount: number;
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

  // Step 1: Fetch PAC entities with their fec_committee_id and industry
  const { data: entities, error: entErr } = await supabase
    .from("financial_entities")
    .select("id, name, metadata, source_ids")
    .in("entity_type", ["pac", "party_committee"])
    .not("metadata->>industry_category", "is", null)
    .limit(1000);

  if (entErr) {
    console.error("[treemap-pac] entities error:", entErr.message);
    return Response.json({ error: entErr.message }, { status: 500 });
  }

  if (!entities || entities.length === 0) {
    const label = groupBy === "sector" ? "PAC Donations by Sector" : "PAC Donations by Party";
    return Response.json({ name: label, children: [] } satisfies PacHierarchy);
  }

  // Build lookup: fec_committee_id → { entityId, name, sector }
  const byCommitteeId: Record<string, { entityId: string; name: string; sector: string }> = {};
  const byEntityId: Record<string, { name: string; sector: string }> = {};

  for (const e of entities) {
    const sid = e.source_ids as Record<string, string> | null;
    const meta = e.metadata as Record<string, string> | null;
    const sector = meta?.industry_category ?? "Other";
    const committeeId = sid?.fec_committee_id;
    byEntityId[e.id as string] = { name: e.name as string, sector };
    if (committeeId) {
      byCommitteeId[committeeId] = { entityId: e.id as string, name: e.name as string, sector };
    }
  }

  const committeeIds = Object.keys(byCommitteeId);
  if (committeeIds.length === 0) {
    const label = groupBy === "sector" ? "PAC Donations by Sector" : "PAC Donations by Party";
    return Response.json({ name: label, children: [] } satisfies PacHierarchy);
  }

  // Step 2: Fetch financial_relationships for these committee IDs
  const { data: rels, error: relErr } = await supabase
    .from("financial_relationships")
    .select("fec_committee_id, official_id, amount_cents")
    .in("fec_committee_id", committeeIds.slice(0, 500));

  if (relErr) {
    console.error("[treemap-pac] rels error:", relErr.message);
    return Response.json({ error: relErr.message }, { status: 500 });
  }

  // ── Sector mode ─────────────────────────────────────────────────────────────

  if (groupBy === "sector") {
    // sector → committeeId → { name, totalCents, officials }
    const grouped: Record<string, Record<string, { name: string; totalCents: number; officials: Set<string> }>> = {};

    for (const rel of rels ?? []) {
      const committeeId = rel.fec_committee_id as string | null;
      if (!committeeId) continue;
      const pac = byCommitteeId[committeeId];
      if (!pac) continue;

      const { entityId, name, sector } = pac;
      if (!grouped[sector]) grouped[sector] = {};
      if (!grouped[sector]![entityId]) {
        grouped[sector]![entityId] = { name, totalCents: 0, officials: new Set() };
      }
      grouped[sector]![entityId]!.totalCents += rel.amount_cents as number;
      if (rel.official_id) grouped[sector]![entityId]!.officials.add(rel.official_id as string);
    }

    const hierarchy: PacHierarchy = {
      name: "PAC Donations by Sector",
      children: Object.entries(grouped)
        .map(([sector, pacs]) => {
          const children: PacLeaf[] = Object.entries(pacs)
            .map(([pacId, stats]) => ({
              name:          stats.name,
              value:         stats.totalCents / 100,
              pacId,
              officialCount: stats.officials.size,
            }))
            .sort((a, b) => b.value - a.value);

          return {
            name:     sector,
            totalUsd: children.reduce((s, c) => s + c.value, 0),
            children,
          };
        })
        .sort((a, b) => b.totalUsd - a.totalUsd),
    };

    return Response.json(hierarchy);
  }

  // ── Party mode ──────────────────────────────────────────────────────────────

  // Collect unique official ids to look up parties
  const officialIds = [
    ...new Set(
      (rels ?? [])
        .map((r) => r.official_id as string | null)
        .filter((id): id is string => id !== null)
    ),
  ];

  let partyByOfficial: Record<string, string> = {};

  if (officialIds.length > 0) {
    const { data: officials, error: offErr } = await supabase
      .from("officials")
      .select("id, party")
      .in("id", officialIds.slice(0, 500));

    if (offErr) {
      console.error("[treemap-pac/party] officials error:", offErr.message);
      return Response.json({ error: offErr.message }, { status: 500 });
    }

    for (const off of officials ?? []) {
      partyByOfficial[off.id as string] = (off.party as string) ?? "Unknown";
    }
  }

  // party → committeeId → totalCents
  const partyGroup: Record<string, Record<string, number>> = {};

  for (const rel of rels ?? []) {
    const committeeId = rel.fec_committee_id as string | null;
    if (!committeeId) continue;
    const pac = byCommitteeId[committeeId];
    if (!pac) continue;

    const party = rel.official_id
      ? (partyByOfficial[rel.official_id as string] ?? "Unknown")
      : "Unknown";

    const { entityId } = pac;
    if (!partyGroup[party]) partyGroup[party] = {};
    partyGroup[party]![entityId] =
      (partyGroup[party]![entityId] ?? 0) + (rel.amount_cents as number);
  }

  const partyHierarchy: PacHierarchy = {
    name: "PAC Donations by Party",
    children: Object.entries(partyGroup)
      .map(([party, pacs]) => {
        const children: PacLeaf[] = Object.entries(pacs)
          .map(([pacId, cents]) => ({
            name:          byEntityId[pacId]?.name ?? pacId,
            value:         cents / 100,
            pacId,
            officialCount: 0,
          }))
          .sort((a, b) => b.value - a.value);

        return {
          name:     party,
          totalUsd: children.reduce((s, c) => s + c.value, 0),
          children,
        };
      })
      .sort((a, b) => b.totalUsd - a.totalUsd),
  };

  return Response.json(partyHierarchy);
}
