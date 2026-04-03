import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";
import type { GroupFilter } from "@civitics/graph";

export const dynamic = "force-dynamic";

const SECTOR_ICONS: Record<string, string> = {
  'Finance': '💰',
  'Labor': '👷',
  'Energy': '⚡',
  'Healthcare': '🏥',
  'Real Estate': '🏘',
  'Tech': '💻',
  'Agriculture': '🌾',
  'Defense': '🛡',
  'Transportation': '🚗',
  'Construction': '🔨',
  'Retail & Food': '🛍',
  'Education': '📚',
  'Legal': '⚖️',
};

type FlowRow = {
  industry: string;
  display_label: string;
  display_icon: string;
  party_chamber: string;
  total_cents: number;
  official_count: number;
  donor_count: number;
};

type EntityDonorRow = {
  industry_category: string | null;
  total_usd: number;
  donor_count: number;
};

type OfficialRow = {
  id: string;
  name: string;
};

function labelFor(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function GET(req: NextRequest) {
  if (supabaseUnavailable()) return unavailableResponse();
  const { searchParams } = new URL(req.url);
  const entityId = searchParams.get("entityId");

  const groupId = searchParams.get('groupId');
  const groupFilterRaw = searchParams.get('groupFilter');
  const groupNameParam = searchParams.get('groupName');
  const secondaryGroupId = searchParams.get('secondaryGroupId');
  const secondaryFilterRaw = searchParams.get('secondaryFilter');
  const secondaryGroupNameParam = searchParams.get('secondaryGroupName');

  let groupFilter: GroupFilter | null = null;
  let secondaryFilter: GroupFilter | null = null;

  try {
    if (groupFilterRaw) {
      console.log('[chord] groupFilterRaw:', groupFilterRaw);
      try {
        const decoded = decodeURIComponent(groupFilterRaw);
        console.log('[chord] decoded:', decoded);
        groupFilter = JSON.parse(decoded) as GroupFilter;
      } catch {
        groupFilter = JSON.parse(groupFilterRaw) as GroupFilter;
      }
      console.log('[chord] groupFilter:', groupFilter);
    }
    if (secondaryFilterRaw) {
      try {
        secondaryFilter = JSON.parse(decodeURIComponent(secondaryFilterRaw)) as GroupFilter;
      } catch {
        secondaryFilter = JSON.parse(secondaryFilterRaw) as GroupFilter;
      }
    }
  } catch (e) {
    console.error('[chord] groupFilter parse error:', e);
    groupFilter = null;
  }

  // Fallback: reconstruct groupFilter from individual params if parse failed
  if (groupId && !groupFilter) {
    const entityType = searchParams.get('entity_type');
    const chamber = searchParams.get('chamber');
    const party = searchParams.get('party');
    const state = searchParams.get('state');
    const industry = searchParams.get('industry');
    if (entityType) {
      groupFilter = {
        entity_type: entityType as 'official' | 'pac',
        ...(chamber && { chamber: chamber as 'senate' | 'house' }),
        ...(party && { party }),
        ...(state && { state }),
        ...(industry && { industry }),
      };
      console.log('[chord] reconstructed groupFilter:', groupFilter);
    }
  }

  const supabase = createAdminClient();

  // ── Helper: resolve official member IDs for a GroupFilter ─────────────────
  async function getMemberIds(filter: GroupFilter): Promise<string[]> {
    console.log('[getMemberIds] filter:', JSON.stringify(filter));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc('get_officials_by_filter', {
      p_chamber: filter.chamber ?? null,
      p_party:   filter.party   ?? null,
      p_state:   filter.state   ?? null,
    }) as { data: Array<{ id: string }> | null; error: unknown };
    console.log('[getMemberIds] count:', data?.length ?? 0);
    console.log('[getMemberIds] error:', error);
    return (data ?? []).map((m: { id: string }) => m.id);
  }

  // ── Mode 3: Cross-group chord ──────────────────────────────────────────────
  if (groupId && groupFilter && secondaryGroupId && secondaryFilter) {
    try {
      const [group1Ids, group2Ids] = await Promise.all([
        getMemberIds(groupFilter),
        getMemberIds(secondaryFilter),
      ]);

      if (group1Ids.length === 0 && group2Ids.length === 0) {
        return NextResponse.json({ groups: [], recipients: [], matrix: [], mode: 'cross-group' });
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: sectorData, error: sectorError } = await (supabase as any).rpc(
        'get_crossgroup_sector_totals',
        { p_group1_ids: group1Ids, p_group2_ids: group2Ids }
      ) as { data: Array<{ sector: string; group1_usd: number; group2_usd: number }> | null; error: unknown };

      if (sectorError) {
        console.error('[chord/cross-group] sector error:', sectorError);
      }

      console.log('[chord/cross-group] sectors:', sectorData?.length ?? 0);

      const sortedSectors = sectorData ?? [];

      const groups = sortedSectors.map((row, i) => ({
        id: `sector-${i}`,
        label: row.sector,
        icon: SECTOR_ICONS[row.sector] ?? '💼',
        total_usd: Math.round(row.group1_usd + row.group2_usd),
        pac_count: 0,
      }));

      const group1Name = groupNameParam ?? 'Group 1';
      const group2Name = secondaryGroupNameParam ?? 'Group 2';

      const recipients = [
        { id: groupId, label: group1Name, total_received_usd: Math.round(sortedSectors.reduce((s, r) => s + r.group1_usd, 0)), official_count: group1Ids.length },
        { id: secondaryGroupId, label: group2Name, total_received_usd: Math.round(sortedSectors.reduce((s, r) => s + r.group2_usd, 0)), official_count: group2Ids.length },
      ];

      const matrix = sortedSectors.map((r) => [Math.round(r.group1_usd), Math.round(r.group2_usd)]);

      return NextResponse.json({ groups, recipients, matrix, top_flows: [], total_flow_usd: 0, untagged_flow_usd: 0, mode: 'cross-group' });
    } catch (e) {
      console.error('[chord/cross-group]', e);
      return NextResponse.json({ error: 'Internal error' }, { status: 500 });
    }
  }

  // ── Mode 2: Single group chord ─────────────────────────────────────────────
  if (groupId && groupFilter && !secondaryGroupId) {
    try {
      const memberIds = await getMemberIds(groupFilter);
      if (memberIds.length === 0) {
        return NextResponse.json({ groups: [], recipients: [], matrix: [], mode: 'group' });
      }

      const minFlowParam = parseFloat(searchParams.get('minFlowUsd') ?? '0');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: sectorData, error: sectorError } = await (supabase as any).rpc(
        'get_group_sector_totals',
        { p_member_ids: memberIds, p_min_usd: minFlowParam }
      ) as { data: Array<{ sector: string; total_usd: number }> | null; error: unknown };

      if (sectorError) {
        console.error('[chord/group] sector error:', sectorError);
      }

      console.log('[chord/group] sectors:', sectorData?.length ?? 0);

      const groups = (sectorData ?? []).map((row, i) => ({
        id: `sector-${i}`,
        label: row.sector,
        icon: SECTOR_ICONS[row.sector] ?? '💼',
        total_usd: Math.round(row.total_usd),
        pac_count: 0,
      }));

      if (groups.length === 0) {
        return NextResponse.json({ groups: [], recipients: [], matrix: [], mode: 'group' });
      }

      const groupName = groupNameParam ?? 'Group';
      const totalReceived = groups.reduce((s, g) => s + g.total_usd, 0);

      const recipients = [{
        id: groupId,
        label: groupName,
        total_received_usd: totalReceived,
        official_count: memberIds.length,
      }];

      const matrix = groups.map((g) => [g.total_usd]);

      return NextResponse.json({ groups, recipients, matrix, top_flows: [], total_flow_usd: totalReceived, untagged_flow_usd: 0, mode: 'group' });
    } catch (e) {
      console.error('[chord/group]', e);
      return NextResponse.json({ error: 'Internal error' }, { status: 500 });
    }
  }

  // ── Entity mode: show industries donating to one official ─────────────────
  if (entityId) {
    try {
      // Fetch official name
      const { data: officialData } = await (supabase as ReturnType<typeof createAdminClient>)
        .from("officials")
        .select("id, name")
        .eq("id", entityId)
        .maybeSingle();

      const official = officialData as OfficialRow | null;

      // Aggregate donations to this official by industry
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: donorData, error } = await (supabase as any)
        .from("financial_relationships")
        .select("financial_entities!inner(industry_category), amount_cents")
        .eq("official_id", entityId) as {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data: Array<{ financial_entities: { industry_category: string | null } | null; amount_cents: number }> | null;
          error: { message: string } | null;
        };

      if (error) {
        console.error("[chord/entity] query error:", error.message);
        return NextResponse.json({ groups: [], recipients: [], matrix: [] });
      }

      // Aggregate by industry client-side
      const industryMap = new Map<string, { total: number; count: number }>();
      for (const row of donorData ?? []) {
        const fe = row.financial_entities;
        const industry = fe?.industry_category ?? "untagged";
        if (industry === "untagged") continue;
        const usd = Number(row.amount_cents) / 100;
        const prev = industryMap.get(industry) ?? { total: 0, count: 0 };
        industryMap.set(industry, { total: prev.total + usd, count: prev.count + 1 });
      }

      const groups = [...industryMap.entries()]
        .sort((a, b) => b[1].total - a[1].total)
        .map(([industry, v]) => ({
          id: industry,
          label: labelFor(industry),
          icon: "🏢",
          total_usd: Math.round(v.total),
          pac_count: v.count,
        }));

      if (groups.length === 0) {
        return NextResponse.json({ groups: [], recipients: [], matrix: [] });
      }

      const officialName = official?.name ?? entityId;
      const recipients = [
        {
          id: entityId,
          label: officialName,
          total_received_usd: groups.reduce((s, g) => s + g.total_usd, 0),
          official_count: 1,
        },
      ];

      // Matrix: M industries × 1 official
      const matrix: number[][] = groups.map((g) => [g.total_usd]);

      return NextResponse.json({ groups, recipients, matrix });
    } catch (e) {
      console.error("[chord/entity]", e);
      return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }
  }

  // ── Aggregate mode: industry → party flows ────────────────────────────────
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (createAdminClient() as any).rpc("chord_industry_flows");

    if (error) {
      console.error("[chord] RPC error:", error.message);
      return NextResponse.json({ groups: [], recipients: [], matrix: [], top_flows: [], total_flow_usd: 0 });
    }

    const rows = (data ?? []) as FlowRow[];

    const industryMap = new Map<string, { label: string; icon: string; total: number; donors: number }>();
    const partyMap = new Map<string, { total: number; officials: number }>();
    const flowMatrix = new Map<string, Map<string, number>>();
    let totalFlow = 0;
    let untaggedFlow = 0;

    for (const row of rows) {
      const usd = Number(row.total_cents) / 100;
      totalFlow += usd;

      if (row.industry === "untagged") {
        untaggedFlow += usd;
        continue;
      }

      const ig = industryMap.get(row.industry) ?? {
        label: row.display_label || labelFor(row.industry),
        icon: row.display_icon || "🏢",
        total: 0,
        donors: 0,
      };
      ig.total += usd;
      ig.donors += Number(row.donor_count);
      industryMap.set(row.industry, ig);

      const pg = partyMap.get(row.party_chamber) ?? { total: 0, officials: 0 };
      pg.total += usd;
      pg.officials += Number(row.official_count);
      partyMap.set(row.party_chamber, pg);

      if (!flowMatrix.has(row.industry)) flowMatrix.set(row.industry, new Map());
      const pm = flowMatrix.get(row.industry)!;
      pm.set(row.party_chamber, (pm.get(row.party_chamber) ?? 0) + usd);
    }

    const groups = [...industryMap.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .map(([id, v]) => ({
        id,
        label: v.label,
        icon: v.icon,
        total_usd: Math.round(v.total),
        pac_count: v.donors,
      }));

    const recipients = [...partyMap.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .map(([id, v]) => ({
        id,
        label: id,
        total_received_usd: Math.round(v.total),
        official_count: v.officials,
      }));

    const groupIds = groups.map((g) => g.id);
    const recipientIds = recipients.map((r) => r.id);

    const matrix: number[][] = groupIds.map((gid) =>
      recipientIds.map((rid) => Math.round(flowMatrix.get(gid)?.get(rid) ?? 0)),
    );

    const topFlows: { from: string; to: string; amount_usd: number }[] = [];
    for (const [ind, pm] of flowMatrix)
      for (const [party, usd] of pm)
        topFlows.push({ from: labelFor(ind), to: party, amount_usd: Math.round(usd) });
    topFlows.sort((a, b) => b.amount_usd - a.amount_usd);

    return NextResponse.json({
      groups,
      recipients,
      matrix,
      top_flows: topFlows.slice(0, 10),
      total_flow_usd: Math.round(totalFlow),
      untagged_flow_usd: Math.round(untaggedFlow),
    });
  } catch (e) {
    console.error("[chord]", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
