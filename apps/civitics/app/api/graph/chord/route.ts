import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse, withDbTimeout } from "@/lib/supabase-check";
import type { GroupFilter } from "@civitics/graph";
import { withPublicCdnCache } from "@/lib/cdn-cache";

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

function labelFor(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// FIX-L (decision 3) — pull a message out of a PostgREST/RPC error so the route
// can return an honest error envelope instead of swallowing it into an empty 200.
function rpcErrMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

// Display label maps for the new modes.
const VOTE_OUTCOME_LABELS: Record<string, string> = {
  yes:   'Yes Votes',
  no:    'No Votes',
  other: 'Other',
};

const DONOR_TYPE_LABELS: Record<string, string> = {
  individual:           'Individual',
  pac:                  'PAC',
  super_pac:            'Super PAC',
  corporation:          'Corporation',
  union:                'Union',
  party_committee:      'Party Committee',
  small_donor_aggregate:'Small Donors',
  tribal:               'Tribal',
  '527':                '527 Group',
  other:                'Other',
};

export async function GET(req: NextRequest) {
  if (supabaseUnavailable()) return unavailableResponse();
  const { searchParams } = new URL(req.url);
  const entityId = searchParams.get("entityId");
  const dataMode = searchParams.get('dataMode');

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
    const { data, error } = await withDbTimeout<{ data: Array<{ id: string }> | null; error: unknown }>(
      (supabase as any).rpc('get_officials_by_filter', {
        p_chamber: filter.chamber ?? null,
        p_party:   filter.party   ?? null,
        p_state:   filter.state   ?? null,
      })
    );
    console.log('[getMemberIds] count:', data?.length ?? 0);
    console.log('[getMemberIds] error:', error);
    return (data ?? []).map((m: { id: string }) => m.id);
  }

  // ── Helper: resolve focused-cohort IDs from entityId or groupFilter ───────
  async function resolveCohortIds(): Promise<string[]> {
    if (entityId) return [entityId];
    if (groupFilter) return await getMemberIds(groupFilter);
    return [];
  }

  // ── Explicit dataMode branches (preferred over inferred-from-props) ────────

  // Mode: sector-vote — donor sectors × vote outcomes (yes/no/other) for the
  // focused official(s). Cell value = sum across officials of
  //   sector_donations × (vote_outcome_count / total_votes).
  if (dataMode === 'sector-vote') {
    try {
      const cohortIds = await resolveCohortIds();
      if (cohortIds.length === 0) {
        return withPublicCdnCache(NextResponse.json({ groups: [], recipients: [], matrix: [], mode: 'sector-vote' }));
      }
      const minFlowParam = parseFloat(searchParams.get('minFlowUsd') ?? '0');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await withDbTimeout<{ data: Array<{ sector: string; display_label: string; display_icon: string; vote_outcome: string; total_usd: number; vote_count: number }> | null; error: unknown }>(
        (supabase as any).rpc('chord_sector_vote_for_officials', { p_official_ids: cohortIds, p_min_usd: minFlowParam })
      );
      if (error) {
        console.error('[chord/sector-vote] rpc error:', error);
        return withPublicCdnCache(NextResponse.json({ groups: [], recipients: [], matrix: [], mode: 'sector-vote' }));
      }
      const rows = data ?? [];

      const sectorMap = new Map<string, { label: string; icon: string; total: number }>();
      const outcomeMap = new Map<string, { usd: number; votes: number }>();
      const cellMap = new Map<string, Map<string, number>>();
      for (const row of rows) {
        const sec = row.sector;
        const out = row.vote_outcome;
        const usd = Number(row.total_usd) || 0;
        const sg = sectorMap.get(sec) ?? { label: row.display_label || labelFor(sec), icon: row.display_icon || '💼', total: 0 };
        sg.total += usd;
        sectorMap.set(sec, sg);
        const op = outcomeMap.get(out) ?? { usd: 0, votes: 0 };
        op.usd += usd;
        op.votes += Number(row.vote_count) || 0;
        outcomeMap.set(out, op);
        if (!cellMap.has(sec)) cellMap.set(sec, new Map());
        cellMap.get(sec)!.set(out, usd);
      }

      const groups = [...sectorMap.entries()]
        .sort((a, b) => b[1].total - a[1].total)
        .map(([sec, v]) => ({
          id: sec,
          label: v.label,
          icon: v.icon || SECTOR_ICONS[v.label] || '💼',
          total_usd: Math.round(v.total),
          pac_count: 0,
        }));
      const outcomeOrder = ['yes', 'no', 'other'];
      const recipients = outcomeOrder
        .filter(o => outcomeMap.has(o))
        .map(o => ({
          id: o,
          label: VOTE_OUTCOME_LABELS[o] ?? o,
          total_received_usd: Math.round(outcomeMap.get(o)!.usd),
          official_count: outcomeMap.get(o)!.votes,
        }));
      const matrix = groups.map(g =>
        recipients.map(r => Math.round(cellMap.get(g.id)?.get(r.id) ?? 0))
      );
      return withPublicCdnCache(NextResponse.json({ groups, recipients, matrix, mode: 'sector-vote' }));
    } catch (e) {
      console.error('[chord/sector-vote]', e);
      return NextResponse.json({ error: 'Internal error' }, { status: 500 });
    }
  }

  // Mode: subject-party — bill subjects × party_chamber, weighted by yes votes.
  if (dataMode === 'subject-party') {
    try {
      const cohortIds = await resolveCohortIds();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await withDbTimeout<{ data: Array<{ subject: string; display_label: string; display_icon: string; party_chamber: string; vote_count: number }> | null; error: unknown }>(
        (supabase as any).rpc('chord_subject_party_flows', { p_official_ids: cohortIds.length ? cohortIds : null })
      );
      if (error) {
        console.error('[chord/subject-party] rpc error:', error);
        return withPublicCdnCache(NextResponse.json({ groups: [], recipients: [], matrix: [], mode: 'subject-party' }));
      }
      const rows = data ?? [];

      const subjectMap = new Map<string, { label: string; icon: string; total: number }>();
      const partyMap = new Map<string, number>();
      const cellMap = new Map<string, Map<string, number>>();
      for (const row of rows) {
        const sub = row.subject;
        const pc = row.party_chamber;
        const cnt = Number(row.vote_count) || 0;
        const sg = subjectMap.get(sub) ?? { label: row.display_label || labelFor(sub), icon: row.display_icon || '🏷️', total: 0 };
        sg.total += cnt;
        subjectMap.set(sub, sg);
        partyMap.set(pc, (partyMap.get(pc) ?? 0) + cnt);
        if (!cellMap.has(sub)) cellMap.set(sub, new Map());
        cellMap.get(sub)!.set(pc, (cellMap.get(sub)!.get(pc) ?? 0) + cnt);
      }

      const groups = [...subjectMap.entries()]
        .sort((a, b) => b[1].total - a[1].total)
        .slice(0, 12)
        .map(([id, v]) => ({
          id,
          label: v.label,
          icon: v.icon,
          total_usd: v.total, // overloaded: vote count
          pac_count: 0,
        }));
      const recipients = [...partyMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([id, total]) => ({
          id,
          label: id,
          total_received_usd: total,
          official_count: 0,
        }));
      const matrix = groups.map(g =>
        recipients.map(r => cellMap.get(g.id)?.get(r.id) ?? 0)
      );
      return withPublicCdnCache(NextResponse.json({ groups, recipients, matrix, mode: 'subject-party' }));
    } catch (e) {
      console.error('[chord/subject-party]', e);
      return NextResponse.json({ error: 'Internal error' }, { status: 500 });
    }
  }

  // Mode: donor-type-party — donor entity_type × party_chamber.
  if (dataMode === 'donor-type-party') {
    try {
      const cohortIds = await resolveCohortIds();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await withDbTimeout<{ data: Array<{ donor_type: string; party_chamber: string; total_usd: number }> | null; error: unknown }>(
        (supabase as any).rpc('chord_donor_type_party_flows', { p_official_ids: cohortIds.length ? cohortIds : null })
      );
      if (error) {
        console.error('[chord/donor-type-party] rpc error:', error);
        return withPublicCdnCache(NextResponse.json({ groups: [], recipients: [], matrix: [], mode: 'donor-type-party' }));
      }
      const rows = data ?? [];

      const typeMap = new Map<string, number>();
      const partyMap = new Map<string, number>();
      const cellMap = new Map<string, Map<string, number>>();
      for (const row of rows) {
        const dt = row.donor_type;
        const pc = row.party_chamber;
        const usd = Number(row.total_usd) || 0;
        typeMap.set(dt, (typeMap.get(dt) ?? 0) + usd);
        partyMap.set(pc, (partyMap.get(pc) ?? 0) + usd);
        if (!cellMap.has(dt)) cellMap.set(dt, new Map());
        cellMap.get(dt)!.set(pc, usd);
      }

      const groups = [...typeMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([id, total]) => ({
          id,
          label: DONOR_TYPE_LABELS[id] ?? labelFor(id),
          icon: '🏛️',
          total_usd: Math.round(total),
          pac_count: 0,
        }));
      const recipients = [...partyMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([id, total]) => ({
          id,
          label: id,
          total_received_usd: Math.round(total),
          official_count: 0,
        }));
      const matrix = groups.map(g =>
        recipients.map(r => Math.round(cellMap.get(g.id)?.get(r.id) ?? 0))
      );
      return withPublicCdnCache(NextResponse.json({ groups, recipients, matrix, mode: 'donor-type-party' }));
    } catch (e) {
      console.error('[chord/donor-type-party]', e);
      return NextResponse.json({ error: 'Internal error' }, { status: 500 });
    }
  }

  // Mode: state-party — donor home state × recipient party_chamber.
  if (dataMode === 'state-party') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await withDbTimeout<{ data: Array<{ donor_state: string; party_chamber: string; total_usd: number }> | null; error: unknown }>(
        (supabase as any).rpc('chord_donor_state_party_flows', { p_official_id: entityId ?? null })
      );
      if (error) {
        console.error('[chord/state-party] rpc error:', error);
        return withPublicCdnCache(NextResponse.json({ groups: [], recipients: [], matrix: [], mode: 'state-party' }));
      }
      const rows = data ?? [];

      const stateMap = new Map<string, number>();
      const partyMap = new Map<string, number>();
      const cellMap = new Map<string, Map<string, number>>();
      for (const row of rows) {
        const st = row.donor_state;
        const pc = row.party_chamber;
        const usd = Number(row.total_usd) || 0;
        stateMap.set(st, (stateMap.get(st) ?? 0) + usd);
        partyMap.set(pc, (partyMap.get(pc) ?? 0) + usd);
        if (!cellMap.has(st)) cellMap.set(st, new Map());
        cellMap.get(st)!.set(pc, usd);
      }

      const groups = [...stateMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([id, total]) => ({
          id,
          label: id,
          icon: '📍',
          total_usd: Math.round(total),
          pac_count: 0,
        }));
      const recipients = [...partyMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([id, total]) => ({
          id,
          label: id,
          total_received_usd: Math.round(total),
          official_count: 0,
        }));
      const matrix = groups.map(g =>
        recipients.map(r => Math.round(cellMap.get(g.id)?.get(r.id) ?? 0))
      );
      return withPublicCdnCache(NextResponse.json({ groups, recipients, matrix, mode: 'state-party' }));
    } catch (e) {
      console.error('[chord/state-party]', e);
      return NextResponse.json({ error: 'Internal error' }, { status: 500 });
    }
  }

  // ── Mode 3: Cross-group chord ──────────────────────────────────────────────
  if (groupId && groupFilter && secondaryGroupId && secondaryFilter) {
    try {
      const [group1Ids, group2Ids] = await Promise.all([
        getMemberIds(groupFilter),
        getMemberIds(secondaryFilter),
      ]);

      if (group1Ids.length === 0 && group2Ids.length === 0) {
        return withPublicCdnCache(NextResponse.json({ groups: [], recipients: [], matrix: [], mode: 'cross-group' }));
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: sectorData, error: sectorError } = await withDbTimeout<{ data: Array<{ sector: string; group1_usd: number; group2_usd: number }> | null; error: unknown }>(
        (supabase as any).rpc(
          'get_crossgroup_sector_totals',
          { p_group1_ids: group1Ids, p_group2_ids: group2Ids }
        )
      );

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

      return withPublicCdnCache(NextResponse.json({ groups, recipients, matrix, top_flows: [], total_flow_usd: 0, untagged_flow_usd: 0, mode: 'cross-group' }));
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
        return withPublicCdnCache(NextResponse.json({ groups: [], recipients: [], matrix: [], mode: 'group' }));
      }

      const minFlowParam = parseFloat(searchParams.get('minFlowUsd') ?? '0');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: sectorData, error: sectorError } = await withDbTimeout<{ data: Array<{ sector: string; total_usd: number }> | null; error: unknown }>(
        (supabase as any).rpc(
          'get_group_sector_totals',
          { p_member_ids: memberIds, p_min_usd: minFlowParam }
        )
      );

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
        return withPublicCdnCache(NextResponse.json({ groups: [], recipients: [], matrix: [], mode: 'group' }));
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

      return withPublicCdnCache(NextResponse.json({ groups, recipients, matrix, top_flows: [], total_flow_usd: totalReceived, untagged_flow_usd: 0, mode: 'group' }));
    } catch (e) {
      console.error('[chord/group]', e);
      return NextResponse.json({ error: 'Internal error' }, { status: 500 });
    }
  }

  // ── Multi-entity compare mode: 2+ focused officials ──────────────────────
  // Each official becomes a recipient arc; donor arcs are the union of
  // industries / PACs / brackets across all officials. Cell value is each
  // official's slice of donations from that donor — visually surfaces shared
  // donor bases (thick ribbons to multiple officials) at a glance.
  const entityIdsRaw = searchParams.get('entityIds');
  if (entityIdsRaw) {
    try {
      // FIX-503: entityIds is a user-supplied CSV and each id drives a separate
      // per-official donor-breakdown query (fetchDonorsFor). Validate UUID shape
      // and cap at 12 so a long/garbage list can't fan out into an unbounded
      // query storm against the cache-starved DB.
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const entityIds = entityIdsRaw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => UUID_RE.test(s))
        .slice(0, 12);
      if (entityIds.length === 0) {
        return withPublicCdnCache(NextResponse.json({ groups: [], recipients: [], matrix: [], mode: 'compare' }));
      }
      const granularity = searchParams.get('granularity') ?? 'aggregate';
      const topPacsLimit = parseInt(searchParams.get('topPacsLimit') ?? '12');
      const minFlowParam = parseFloat(searchParams.get('minFlowUsd') ?? '0');

      // Fetch official names + per-official donor breakdowns in parallel.
      const officialsPromise = withDbTimeout<{ data: Array<{ id: string; full_name: string }> | null; error: unknown }>(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any).from('officials').select('id, full_name').in('id', entityIds)
      );

      type DonorRow = { id: string; label: string; icon: string; total_cents: number; pac_count: number; industry?: string };

      async function fetchDonorsFor(officialId: string): Promise<DonorRow[]> {
        if (granularity === 'top-pacs') {
          // Fetch a wider per-official batch (2× the requested limit, capped
          // at 100) so the union has enough candidates to surface PACs that
          // gave to multiple focused officials — the "shared donor base"
          // signal that's the whole point of compare mode.
          const perOfficialLimit = Math.min(100, Math.max(topPacsLimit * 2, topPacsLimit));
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data } = await withDbTimeout<{ data: Array<{ pac_id: string; pac_name: string; industry: string; display_label: string; display_icon: string; total_cents: number }> | null; error: unknown }>(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (supabase as any).rpc('chord_top_pacs_for_official', { p_official_id: officialId, p_limit: perOfficialLimit })
          );
          return (data ?? []).map(r => ({
            id: r.pac_id, label: r.pac_name, icon: r.display_icon || '🏛️',
            total_cents: Number(r.total_cents), pac_count: 1, industry: r.industry,
          }));
        }
        if (granularity === 'by-bracket') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data } = await withDbTimeout<{ data: Array<{ bracket: string; total_cents: number; donor_count: number }> | null; error: unknown }>(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (supabase as any).rpc('chord_donor_brackets_for_official', { p_official_id: officialId })
          );
          const labels: Record<string, string> = {
            mega: 'Mega ($10k+)', major: 'Major ($2.5k–10k)',
            mid: 'Mid ($500–2.5k)', small: 'Small (<$500)',
          };
          return (data ?? []).map(r => ({
            id: r.bracket, label: labels[r.bracket] ?? r.bracket, icon: '💵',
            total_cents: Number(r.total_cents), pac_count: r.donor_count,
          }));
        }
        // aggregate
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data } = await withDbTimeout<{ data: Array<{ industry: string; display_label: string; display_icon: string; total_cents: number; donor_count: number }> | null; error: unknown }>(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (supabase as any).rpc('chord_industry_flows_for_official', { p_official_id: officialId })
        );
        // FIX-L (decision 2) — keep the untagged bucket as a neutral arc rather
        // than silently dropping it; it is frequently the largest donor slice.
        return (data ?? [])
          .map(r => r.industry === 'untagged'
            ? {
                id: 'untagged', label: 'Untagged donors', icon: '•',
                total_cents: Number(r.total_cents), pac_count: r.donor_count,
              }
            : {
                id: r.industry, label: r.display_label || labelFor(r.industry),
                icon: r.display_icon || '🏢', total_cents: Number(r.total_cents),
                pac_count: r.donor_count,
              });
      }

      const [{ data: officialsData }, ...perOfficialDonors] = await Promise.all([
        officialsPromise,
        ...entityIds.map(fetchDonorsFor),
      ]);

      const nameById = new Map<string, string>(
        (officialsData ?? []).map(o => [o.id, o.full_name])
      );

      // Union of donor IDs across officials, ranked by total contribution.
      const donorTotals = new Map<string, { label: string; icon: string; total: number; donors: number; industry?: string }>();
      const cell = new Map<string, Map<string, number>>(); // donorId → officialId → cents

      perOfficialDonors.forEach((rows, idx) => {
        const officialId = entityIds[idx];
        if (!officialId) return;
        for (const r of rows) {
          const t = donorTotals.get(r.id) ?? { label: r.label, icon: r.icon, total: 0, donors: 0, industry: r.industry };
          t.total += r.total_cents;
          t.donors += r.pac_count;
          if (r.industry && !t.industry) t.industry = r.industry;
          donorTotals.set(r.id, t);
          if (!cell.has(r.id)) cell.set(r.id, new Map());
          cell.get(r.id)!.set(officialId, r.total_cents);
        }
      });

      // Cap donor arcs by granularity: by-bracket has fixed 4 buckets;
      // top-pacs uses the user-set topPacsLimit; aggregate keeps 12
      // industries (more would crowd the layout).
      const donorCap = granularity === 'by-bracket' ? 4
                     : granularity === 'top-pacs'   ? topPacsLimit
                     :                                12;
      const topDonors = [...donorTotals.entries()]
        .filter(([, v]) => v.total >= minFlowParam * 100)
        .sort((a, b) => b[1].total - a[1].total)
        .slice(0, donorCap);

      const groups = topDonors.map(([id, v]) => ({
        id,
        label: v.label,
        icon: v.icon,
        total_usd: Math.round(v.total / 100),
        pac_count: v.donors,
        industry: v.industry,
      }));

      const recipients = entityIds.map(id => {
        const total = topDonors.reduce((s, [donorId]) =>
          s + (cell.get(donorId)?.get(id) ?? 0), 0);
        return {
          id,
          label: nameById.get(id) ?? id,
          total_received_usd: Math.round(total / 100),
          official_count: 1,
        };
      });

      const matrix = groups.map(g =>
        recipients.map(r => Math.round((cell.get(g.id)?.get(r.id) ?? 0) / 100))
      );

      return withPublicCdnCache(NextResponse.json({ groups, recipients, matrix, mode: 'compare' }));
    } catch (e) {
      console.error('[chord/compare]', e);
      return NextResponse.json({ error: 'Internal error' }, { status: 500 });
    }
  }

  // ── Entity mode: industries / PACs / brackets donating to one official ────
  // Delegates to one of three RPCs based on the granularity option:
  //   aggregate   → chord_industry_flows_for_official       (sectors as arcs)
  //   top-pacs    → chord_top_pacs_for_official              (top-N PAC arcs)
  //   by-bracket  → chord_donor_brackets_for_official        (size brackets)
  if (entityId) {
    try {
      const granularity = searchParams.get('granularity') ?? 'aggregate';
      const topPacsLimit = parseInt(searchParams.get('topPacsLimit') ?? '12');

      // Fetch official name (post-cutover column is full_name).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: officialData } = await withDbTimeout<{ data: { id: string; full_name: string } | null; error: unknown }>(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any).from('officials').select('id, full_name').eq('id', entityId).maybeSingle()
      );
      const officialName = officialData?.full_name ?? entityId;

      let groups: { id: string; label: string; icon: string; total_usd: number; pac_count: number; industry?: string }[] = [];
      // FIX-L (decision 2) — untagged money (donors with no industry tag), carried
      // out of the aggregate branch so the response can render it as a neutral arc
      // or an honest "$X from N donors not yet industry-tagged" empty state.
      let untaggedUsd = 0;
      let untaggedDonors = 0;

      if (granularity === 'top-pacs') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await withDbTimeout<{ data: Array<{ pac_id: string; pac_name: string; industry: string; display_label: string; display_icon: string; total_cents: number }> | null; error: unknown }>(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (supabase as any).rpc('chord_top_pacs_for_official', { p_official_id: entityId, p_limit: topPacsLimit })
        );
        // FIX-L (decision 3) — surface RPC failure as an error, never a blank chord.
        if (error) {
          console.error('[chord/entity/top-pacs] rpc error:', error);
          return NextResponse.json({ error: 'chord_rpc_failed', detail: rpcErrMessage(error) }, { status: 502 });
        }
        groups = (data ?? []).map(row => ({
          id: row.pac_id,
          label: row.pac_name,
          icon: row.display_icon || '🏛️',
          total_usd: Math.round(Number(row.total_cents) / 100),
          pac_count: 1,
          industry: row.industry,
        }));
      } else if (granularity === 'by-bracket') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await withDbTimeout<{ data: Array<{ bracket: string; total_cents: number; donor_count: number }> | null; error: unknown }>(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (supabase as any).rpc('chord_donor_brackets_for_official', { p_official_id: entityId })
        );
        // FIX-L (decision 3) — surface RPC failure as an error, never a blank chord.
        if (error) {
          console.error('[chord/entity/by-bracket] rpc error:', error);
          return NextResponse.json({ error: 'chord_rpc_failed', detail: rpcErrMessage(error) }, { status: 502 });
        }
        const order: Record<string, number> = { mega: 0, major: 1, mid: 2, small: 3 };
        const labels: Record<string, string> = {
          mega:  'Mega ($10k+)',
          major: 'Major ($2.5k–10k)',
          mid:   'Mid ($500–2.5k)',
          small: 'Small (<$500)',
        };
        groups = (data ?? [])
          .sort((a, b) => (order[a.bracket] ?? 9) - (order[b.bracket] ?? 9))
          .map(row => ({
            id: row.bracket,
            label: labels[row.bracket] ?? row.bracket,
            icon: '💵',
            total_usd: Math.round(Number(row.total_cents) / 100),
            pac_count: row.donor_count,
          }));
      } else {
        // aggregate: industries as arcs (+ the untagged bucket, surfaced honestly)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await withDbTimeout<{ data: Array<{ industry: string; display_label: string; display_icon: string; total_cents: number; donor_count: number }> | null; error: unknown }>(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (supabase as any).rpc('chord_industry_flows_for_official', { p_official_id: entityId })
        );
        // FIX-L (decision 3) — surface RPC failure / timeout as an error the
        // client renders as "couldn't load", never a swallowed empty 200 (which
        // was indistinguishable from an all-untagged or no-donor official, and
        // hid the FIX-839 cold-cache timeouts on the best-funded officials —
        // measured 6.8s aggregate / 8.8s top-pacs for the whale on warm local).
        if (error) {
          console.error('[chord/entity/aggregate] rpc error:', error);
          return NextResponse.json({ error: 'chord_rpc_failed', detail: rpcErrMessage(error) }, { status: 502 });
        }
        const rows = data ?? [];
        // FIX-L (decision 2) — the untagged bucket is money from donors with no
        // industry tag; for most officials it is the single largest slice (the
        // whale: $268M / 309k donors untagged vs ~$10M tagged). Carry it so the
        // client renders it instead of silently dropping the biggest arc.
        const untaggedRow = rows.find(r => r.industry === 'untagged');
        untaggedUsd    = untaggedRow ? Math.round(Number(untaggedRow.total_cents) / 100) : 0;
        untaggedDonors = untaggedRow ? Number(untaggedRow.donor_count) : 0;
        groups = rows
          .filter(r => r.industry !== 'untagged')
          .map(row => ({
            id: row.industry,
            label: row.display_label || labelFor(row.industry),
            icon: row.display_icon || '🏢',
            total_usd: Math.round(Number(row.total_cents) / 100),
            pac_count: row.donor_count,
          }));
        // Append the untagged arc AFTER the tagged industries. A lone untagged
        // arc is degenerate, so when there is NO tagged industry the all-untagged
        // case falls through to the honest empty state below instead.
        if (untaggedUsd > 0 && groups.length > 0) {
          groups.push({
            id: 'untagged', label: 'Untagged donors', icon: '•',
            total_usd: untaggedUsd, pac_count: untaggedDonors,
          });
        }
      }

      if (groups.length === 0) {
        // FIX-L (decision 2) — no tagged industries. If there is untagged money,
        // tell the client exactly how much / how many donors so it renders an
        // honest empty state ("$83M from 755 donors not yet industry-tagged")
        // rather than a "pipeline is processing" platitude.
        return withPublicCdnCache(NextResponse.json({
          groups: [], recipients: [], matrix: [],
          untagged_usd: untaggedUsd, untagged_donors: untaggedDonors,
        }));
      }

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

      return withPublicCdnCache(NextResponse.json({
        groups, recipients, matrix,
        untagged_usd: untaggedUsd, untagged_donors: untaggedDonors,
      }));
    } catch (e) {
      console.error("[chord/entity]", e);
      return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }
  }

  // ── Aggregate mode: industry → party flows ────────────────────────────────
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await withDbTimeout<{ data: FlowRow[] | null; error: { message: string } | null }>((createAdminClient() as any).rpc("chord_industry_flows"));

    if (error) {
      console.error("[chord] RPC error:", error.message);
      return withPublicCdnCache(NextResponse.json({ groups: [], recipients: [], matrix: [], top_flows: [], total_flow_usd: 0 }));
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

    return withPublicCdnCache(NextResponse.json({
      groups,
      recipients,
      matrix,
      top_flows: topFlows.slice(0, 10),
      total_flow_usd: Math.round(totalFlow),
      untagged_flow_usd: Math.round(untaggedFlow),
    }, {
      headers: { "Cache-Control": "public, max-age=0, s-maxage=86400, stale-while-revalidate=172800" },
    }));
  } catch (e) {
    console.error("[chord]", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
