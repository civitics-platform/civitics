import { createAdminClient, fetchIndustryTagsByEntityId, fetchEntityIdsByIndustryTag } from "@civitics/db";
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
  // FIX-179: surface tag-coverage so the UI can warn when a sector view is
  // partial. Untagged PACs are silently absent from `children`.
  meta?: {
    pacsTotal: number;
    pacsTagged: number;
    pacsUntagged: number;
  };
}

// ── Route handler ────────────────────────────────────────────────────────────

export async function GET(request: Request) {
  if (supabaseUnavailable()) return unavailableResponse();
  const supabase = createAdminClient();

  const { searchParams } = new URL(request.url);
  const groupBy = (searchParams.get("groupBy") ?? "sector") as "sector" | "party";
  // FIX-173: when an industry filter is provided ("Finance", "Energy", etc.),
  // restrict the PAC set to that single sector and return one group containing
  // every matching PAC (no per-sector cap). Without this every industry group
  // rendered the same global all-sectors view.
  const industryFilter = searchParams.get("industry");

  // FIX-220 — user-controlled donation floor. Replaces the hardcoded
  // `> $10k` filter in party mode. Default 0 (show all). Applied
  // post-aggregation in dollars (per-donor totals).
  const minAmountUsd = Math.max(0, parseFloat(searchParams.get("minAmountUsd") ?? "0") || 0);

  // FIX-216: when an officialId is provided, restrict the PAC set to those
  // that donated to that official, and constrain donations to flows touching
  // that official. Without this, "Ted Cruz > PAC Money by Sector" returned
  // every PAC in the database — disjoint from sibling presets like "By State"
  // that DO respect the focused entity.
  const entityIdParam = searchParams.get("entityId");
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const entityId = entityIdParam && UUID_RE.test(entityIdParam) ? entityIdParam : null;

  // Look up the official's display name for the hierarchy title; non-blocking
  // failure leaves it as the generic title.
  let officialName: string | null = null;
  if (entityId) {
    const { data: o } = await supabase
      .from("officials")
      .select("full_name")
      .eq("id", entityId)
      .maybeSingle();
    officialName = o?.full_name ?? null;
  }

  // ── Sector mode ──────────────────────────────────────────────────────────────

  if (groupBy === "sector") {
    // Step 1: PAC/party committee entities, joined with their industry tag
    // from `entity_tags`. The `financial_entities.industry` column was dropped
    // in FIX-167 — it had been polluted with FEC `CONNECTED_ORG_NM` values
    // (parent org / candidate / committee names). `entity_tags` is the only
    // source of truth for industry now.
    let pacQuery = supabase
      .from("financial_entities")
      .select("id, display_name")
      .in("entity_type", ["pac", "party_committee"]);

    // If an industry filter is set, pre-narrow to PACs tagged with that industry.
    if (industryFilter) {
      const taggedIds = await fetchEntityIdsByIndustryTag(supabase, industryFilter);
      if (taggedIds.length === 0) {
        return Response.json(
          { name: industryFilter, children: [] },
          { headers: { "Cache-Control": "public, max-age=0, s-maxage=86400, stale-while-revalidate=172800" } },
        );
      }
      pacQuery = pacQuery.in("id", taggedIds);
    }

    const { data: pacEntities, error: pacErr } = await pacQuery;

    if (pacErr) {
      console.error("[treemap-pac/sector] query error:", pacErr.message);
      return Response.json({ error: pacErr.message }, { status: 500 });
    }

    const allIds = (pacEntities ?? []).map((p) => p.id);
    const industryByEntityId = await fetchIndustryTagsByEntityId(supabase, allIds);

    const pacInfo = new Map<string, { name: string; sector: string }>();
    let untaggedCount = 0;
    for (const p of pacEntities ?? []) {
      const ind = industryByEntityId.get(p.id);
      if (!ind) {
        untaggedCount++;
        continue; // Untagged PACs are silently absent from the treemap (FIX-179).
      }
      pacInfo.set(p.id, { name: p.display_name, sector: ind.display_label });
    }
    const pacsTotal = (pacEntities ?? []).length;
    const pacsTagged = pacInfo.size;

    // FIX-216: when an officialId is set, narrow pacInfo to PACs that have
    // at least one donation to that official. This must run BEFORE the
    // per-batch donations aggregation so we don't count flows to other officials.
    if (entityId) {
      const linkedIds: string[] = [];
      const allPacIds = [...pacInfo.keys()];
      const BATCH = 300;
      for (let i = 0; i < allPacIds.length; i += BATCH) {
        const batch = allPacIds.slice(i, i + BATCH);
        const { data: linked } = await supabase
          .from("financial_relationships")
          .select("from_id")
          .eq("relationship_type", "donation")
          .eq("from_type", "financial_entity")
          .eq("to_type", "official")
          .eq("to_id", entityId)
          .in("from_id", batch);
        for (const r of linked ?? []) linkedIds.push(r.from_id);
      }
      const linkedSet = new Set(linkedIds);
      for (const id of [...pacInfo.keys()]) {
        if (!linkedSet.has(id)) pacInfo.delete(id);
      }
    }

    // Step 2: their donations.
    const pacIds = [...pacInfo.keys()];
    const bySector = new Map<string, Map<string, { totalUsd: number; count: number }>>();
    if (pacIds.length > 0) {
      const BATCH = 300;
      for (let i = 0; i < pacIds.length; i += BATCH) {
        const batch = pacIds.slice(i, i + BATCH);
        // FIX-216: when entityId is set, the donations aggregation must only
        // count flows TO that official — otherwise sector totals would still
        // include those PACs' donations to other recipients.
        let donationsQuery = supabase
          .from("financial_relationships")
          .select("from_id, amount_cents")
          .eq("relationship_type", "donation")
          .eq("from_type", "financial_entity")
          .in("from_id", batch);
        if (entityId) donationsQuery = donationsQuery.eq("to_id", entityId);
        const { data: donations } = await donationsQuery;

        for (const row of donations ?? []) {
          const info = pacInfo.get(row.from_id);
          if (!info) continue;
          const donorUpper = info.name.toUpperCase();
          if (
            donorUpper.includes("PAC/COMMITTEE") ||
            donorUpper.includes("COMMITTEE CONTRIBUTIONS")
          ) continue;
          const usd = (row.amount_cents ?? 0) / 100;

          if (!bySector.has(info.sector)) bySector.set(info.sector, new Map());
          const donors = bySector.get(info.sector)!;
          const prev = donors.get(info.name) ?? { totalUsd: 0, count: 0 };
          donors.set(info.name, { totalUsd: prev.totalUsd + usd, count: prev.count + 1 });
        }
      }
    }

    // FIX-174: Build hierarchy. With an industry filter (FIX-173) we want to see
    // every PAC in that sector, so no per-sector cap. For the global "all
    // sectors" view we keep top 15 sectors (any more is too noisy) but raise
    // per-sector PAC cap from 20 → 100; ~5,000 tagged PACs makes a 20-cap
    // hide most data when the user drills into a sector cell.
    const PER_SECTOR_CAP = industryFilter ? Number.POSITIVE_INFINITY : 100;
    const SECTOR_CAP     = industryFilter ? Number.POSITIVE_INFINITY : 15;

    // FIX-220 — apply user donation floor before per-sector cap so the floor
    // is honored even when sector contents are heavy.
    const children: PacGroup[] = Array.from(bySector.entries())
      .map(([sector, donors]) => {
        const leaves: PacLeaf[] = Array.from(donors.entries())
          .map(([name, stats]) => ({ name, value: stats.totalUsd, count: stats.count }))
          .filter(l => l.value >= minAmountUsd)
          .sort((a, b) => b.value - a.value)
          .slice(0, PER_SECTOR_CAP);

        return {
          name:     sector,
          totalUsd: leaves.reduce((s, l) => s + l.value, 0),
          children: leaves,
        };
      })
      .filter(g => g.children.length > 0)
      .sort((a, b) => b.totalUsd - a.totalUsd)
      .slice(0, SECTOR_CAP);

    const baseName = industryFilter ? `${industryFilter} PACs` : "PAC Money by Sector";
    const hierarchy: PacHierarchy = {
      // FIX-216: prefix with the focused official's name so the user can see
      // the rewrite ("PACs that donated to Ted Cruz, by sector").
      name: officialName ? `${officialName} — ${baseName}` : baseName,
      children,
      meta: { pacsTotal, pacsTagged, pacsUntagged: untaggedCount },
    };
    return Response.json(hierarchy, {
      headers: { "Cache-Control": "public, max-age=0, s-maxage=86400, stale-while-revalidate=172800" },
    });
  }

  // ── Party mode ───────────────────────────────────────────────────────────────
  // get_pac_donations_by_party RPC was retired in the shadow→public promotion.
  // We reconstruct the aggregation app-side by joining PACs → donations → officials.

  const { data: pacEntities2 } = await supabase
    .from("financial_entities")
    .select("id, display_name")
    .in("entity_type", ["pac", "party_committee"]);

  const pacInfo2 = new Map<string, string>();
  for (const p of pacEntities2 ?? []) pacInfo2.set(p.id, p.display_name);

  type DonationRow = { from_id: string; to_id: string; amount_cents: number | null };
  const donations: DonationRow[] = [];
  const pacIds2 = [...pacInfo2.keys()];
  if (pacIds2.length > 0) {
    const BATCH = 300;
    for (let i = 0; i < pacIds2.length; i += BATCH) {
      const batch = pacIds2.slice(i, i + BATCH);
      // FIX-216: party-mode with entityId is degenerate (one official has one
      // party) but we still constrain so the single-group hierarchy correctly
      // reports flows TO that official rather than global PAC donations.
      let q = supabase
        .from("financial_relationships")
        .select("from_id, to_id, amount_cents")
        .eq("relationship_type", "donation")
        .eq("from_type", "financial_entity")
        .eq("to_type", "official")
        .in("from_id", batch);
      if (entityId) q = q.eq("to_id", entityId);
      const { data } = await q;
      if (data) donations.push(...data);
    }
  }

  const officialIds = [...new Set(donations.map((d) => d.to_id))];
  const officialParty = new Map<string, string>();
  if (officialIds.length > 0) {
    const BATCH = 300;
    for (let i = 0; i < officialIds.length; i += BATCH) {
      const batch = officialIds.slice(i, i + BATCH);
      const { data: offs } = await supabase
        .from("officials")
        .select("id, party")
        .in("id", batch);
      for (const o of offs ?? []) officialParty.set(o.id, o.party ?? "Unknown");
    }
  }

  // party → donor → { totalUsd, count }
  const byParty = new Map<string, Map<string, { totalUsd: number; count: number }>>();
  const donorCombined = new Map<string, { party: string; totalUsd: number; count: number }>();

  for (const row of donations) {
    const donor = pacInfo2.get(row.from_id);
    if (!donor) continue;
    const party = officialParty.get(row.to_id) ?? "Unknown";
    const usd = (row.amount_cents ?? 0) / 100;
    const key = `${party}|${donor}`;
    const prev = donorCombined.get(key) ?? { party, totalUsd: 0, count: 0 };
    donorCombined.set(key, { party, totalUsd: prev.totalUsd + usd, count: prev.count + 1 });
  }

  for (const [key, val] of donorCombined) {
    // FIX-220 — was hardcoded `<= 10000`; now respects user-set floor.
    if (val.totalUsd < minAmountUsd) continue;
    const donor = key.slice(val.party.length + 1);
    const donorUpper = donor.toUpperCase();
    if (
      donorUpper.includes("PAC/COMMITTEE") ||
      donorUpper.includes("COMMITTEE CONTRIBUTIONS")
    ) continue;
    if (!byParty.has(val.party)) byParty.set(val.party, new Map());
    byParty.get(val.party)!.set(donor, { totalUsd: val.totalUsd, count: val.count });
  }

  // Build hierarchy — top 3 parties, top 50 donors each
  const children: PacGroup[] = Array.from(byParty.entries())
    .map(([party, donors]) => {
      const leaves: PacLeaf[] = Array.from(donors.entries())
        .map(([name, stats]) => ({ name, value: stats.totalUsd, count: stats.count }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 50);

      return {
        name:     party,
        totalUsd: leaves.reduce((s, l) => s + l.value, 0),
        children: leaves,
      };
    })
    .sort((a, b) => b.totalUsd - a.totalUsd)
    .slice(0, 3);

  const partyTitle = officialName ? `${officialName} — PAC Money by Party` : "PAC Money by Party";
  const hierarchy: PacHierarchy = { name: partyTitle, children };
  return Response.json(hierarchy, {
    headers: { "Cache-Control": "public, max-age=0, s-maxage=86400, stale-while-revalidate=172800" },
  });
}
