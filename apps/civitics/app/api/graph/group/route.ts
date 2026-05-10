export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, fetchIndustryTagsByEntityId, fetchEntityIdsByIndustryTag } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse, withDbTimeout } from "@/lib/supabase-check";
import type { GraphEdgeV2 as GraphEdge, GraphNodeV2 as GraphNode, NodeTypeV2 as NodeType } from "@civitics/graph";

// Local extensions — group route adds metadata and id fields not in base types
type ResponseNode = GraphNode & { metadata?: Record<string, unknown> };
type ResponseEdge = GraphEdge & { id?: string; metadata?: Record<string, unknown> };

export async function GET(req: NextRequest) {
  if (supabaseUnavailable()) return unavailableResponse();

  const { searchParams } = req.nextUrl;
  const groupId    = searchParams.get("groupId")    ?? "group-unknown";
  const entityType = searchParams.get("entity_type") ?? "official";
  const chamber    = searchParams.get("chamber");
  const party      = searchParams.get("party");
  const state      = searchParams.get("state");
  const industry   = searchParams.get("industry");
  const tag        = searchParams.get("tag");
  const committeeId = searchParams.get("committeeId");
  const groupName  = searchParams.get("groupName")  ?? "Group";
  const groupIcon  = searchParams.get("groupIcon")  ?? "👥";
  const groupColor = searchParams.get("groupColor") ?? "#6366f1";
  const limit      = Math.min(parseInt(searchParams.get("limit") ?? "50"), 100);

  const supabase = createAdminClient();

  // ── Official group mode ──────────────────────────────────────────────────────
  // Who donated to this group of officials, and how much in aggregate?

  if (entityType === "official") {
    // Committee membership (FIX-139) is a join, not a direct officials column,
    // so resolve the cohort first and skip the officials.* filters when present.
    let memberIds: string[] = [];
    let memberCount: number | null = null;

    if (committeeId) {
      const { data: memberRows, error: memberErr } = await supabase
        .from("official_committee_memberships")
        .select("official_id")
        .eq("committee_id", committeeId)
        .is("ended_at", null);

      if (memberErr) {
        return NextResponse.json({ error: memberErr.message }, { status: 500 });
      }

      memberIds   = [...new Set((memberRows ?? []).map(r => r.official_id))];
      memberCount = memberIds.length;
    } else {
      let memberQuery = supabase
        .from("officials")
        .select("id", { count: "exact" })
        .eq("is_active", true);

      if (chamber === "senate")
        memberQuery = memberQuery.eq("role_title", "Senator");
      else if (chamber === "house")
        memberQuery = memberQuery.eq("role_title", "Representative");

      if (party)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        memberQuery = memberQuery.eq("party", party as any);

      if (state)
        // FIX-175: match metadata.state OR metadata.state_abbr to mirror the
        // treemap route's filter. FIX-124 backfilled state_abbr for federal
        // officials whose state lives in source_ids/jurisdictions; checking
        // only metadata.state silently drops them from state-filtered groups.
        memberQuery = memberQuery.or(
          `metadata->>state.eq.${state},metadata->>state_abbr.eq.${state}`,
        );

      // QWEN-ADDED: Add generic type to withDbTimeout for officials query with count
      const { count, data: memberData } = await withDbTimeout<{
        count: number | null;
        data: Array<{ id: string }> | null;
        error: { message: string } | null;
      }>(memberQuery.limit(1000));

      memberIds   = (memberData ?? []).map((m) => m.id);
      memberCount = count;
    }

    if (memberIds.length === 0) {
      return NextResponse.json({
        group: { id: groupId, name: groupName, count: 0 },
        nodes: [],
        edges: [],
      });
    }

    // Parallel-fetch from entity_connections (pre-aggregated, indexed) rather
    // than financial_relationships (raw source, now bloated by individual donors).
    // entity_connections has one row per (donor, official) pair with amount_cents
    // already summed across all FEC cycles and proper (to_type, to_id) indexes.
    const BATCH_SIZE = 100;
    const chunks: string[][] = [];
    for (let i = 0; i < memberIds.length; i += BATCH_SIZE)
      chunks.push(memberIds.slice(i, i + BATCH_SIZE));

    const batchResults = await Promise.all(
      chunks.map(batch =>
        supabase
          .from("entity_connections")
          .select("from_id, amount_cents")
          .eq("connection_type", "donation")
          .eq("to_type", "official")
          .in("to_id", batch)
          .eq("from_type", "financial_entity")
          .order("amount_cents", { ascending: false })
          .limit(2000)
      )
    );
    const allDonationRows: Array<{ from_id: string; amount_cents: number | null }> =
      batchResults.flatMap(r => r.data ?? []);

    // Resolve donor entity names, industry tags, and entity_type.
    // Industry comes from `entity_tags` (FIX-167): the legacy
    // `financial_entities.industry` column was dropped.
    // entity_type is needed to filter out individual donors —
    // group summary shows institutional money (PACs, orgs, corps) only;
    // individual donor detail lives in the DonorListPanel.
    //
    // CRITICAL: batch the financial_entities lookup. With ~900+ distinct
    // donors per group (Full Senate routinely hits this), an unbatched
    // .in("id", donorIds) blows past PostgREST's URI length cap and
    // returns silently empty — leaving every donor unresolved and the
    // group rendering with zero edges. fetchIndustryTagsByEntityId
    // already batches internally; we just need to match it here.
    const donorIds = [...new Set(allDonationRows.map((r) => r.from_id))];
    const donorInfo = new Map<string, { name: string; sector: string | null; entityType: string }>();
    if (donorIds.length > 0) {
      const FE_BATCH = 100;
      const feChunks: string[][] = [];
      for (let i = 0; i < donorIds.length; i += FE_BATCH) {
        feChunks.push(donorIds.slice(i, i + FE_BATCH));
      }
      const [feResults, industryByEntityId] = await Promise.all([
        Promise.all(
          feChunks.map(batch =>
            supabase
              .from("financial_entities")
              .select("id, display_name, entity_type")
              .in("id", batch),
          ),
        ),
        fetchIndustryTagsByEntityId(supabase, donorIds),
      ]);
      const entities = feResults.flatMap(r => r.data ?? []);
      for (const e of entities) {
        donorInfo.set(e.id, {
          name:       e.display_name,
          sector:     industryByEntityId.get(e.id)?.display_label ?? null,
          entityType: (e as { id: string; display_name: string; entity_type: string }).entity_type,
        });
      }
    }

    // Aggregate by donor UUID (not name — distinct donors can share display names).
    const donorMap = new Map<string, {
      donorId: string;
      donorName: string;
      totalUsd: number;
      memberCount: number;
      sector: string | null;
    }>();

    for (const row of allDonationRows) {
      const info = donorInfo.get(row.from_id);
      if (!info) continue;
      // Group summary = institutional money only — skip individual donors.
      if (info.entityType === 'individual') continue;
      // Skip generic "PAC/Committee" aggregate placeholder rows
      if (/PAC\/Committee/i.test(info.name)) continue;

      const key = row.from_id;  // UUID key — not name
      const usd = (row.amount_cents ?? 0) / 100;

      if (donorMap.has(key)) {
        const existing = donorMap.get(key)!;
        existing.totalUsd    += usd;
        existing.memberCount += 1;
      } else {
        donorMap.set(key, { donorId: row.from_id, donorName: info.name, totalUsd: usd, memberCount: 1, sector: info.sector });
      }
    }

    const topDonors = [...donorMap.values()]
      .sort((a, b) => b.totalUsd - a.totalUsd)
      .slice(0, limit);

    // Group node represents the whole cohort as a single graph node
    const groupNode: ResponseNode = {
      id: groupId,
      name: groupName,
      type: "group" as NodeType,
      collapsed: false,
      metadata: {
        icon: groupIcon,
        color: groupColor,
        memberCount: memberCount ?? 0,
        isGroup: true,
      },
    };

    const connectedNodes: ResponseNode[] = topDonors.map((donor) => ({
      id: `donor-${donor.donorId}`,
      name: donor.donorName,
      type: "financial" as NodeType,
      collapsed: false,
      metadata: { sector: donor.sector },
    }));

    const edges: ResponseEdge[] = topDonors.map((donor) => ({
      id: `edge-${groupId}-${donor.donorId}`,
      fromId: `donor-${donor.donorId}`,
      toId: groupId,
      connectionType: "donation",
      amountUsd: donor.totalUsd,
      strength: Math.min(donor.totalUsd / 1_000_000, 1),
      metadata: {
        memberCount: donor.memberCount,
        pctOfGroup: memberCount
          ? Math.round((donor.memberCount / memberCount) * 100)
          : 0,
      },
    }));

    return NextResponse.json({
      group: {
        id: groupId,
        name: groupName,
        icon: groupIcon,
        color: groupColor,
        count: memberCount ?? 0,
        filter: { entity_type: entityType, chamber, party, state, committeeId },
      },
      nodes: [groupNode, ...connectedNodes],
      edges,
      meta: {
        memberCount:      memberCount ?? 0,
        donorCount:       donorMap.size,
        topDonorsShown:   topDonors.length,
        totalDonatedUsd:  topDonors.reduce((s, d) => s + d.totalUsd, 0),
      },
    });
  }

  // ── PAC group mode ───────────────────────────────────────────────────────────
  // Which officials received the most money from PACs in this industry?

  if (entityType === "pac") {
    // Step 1: find the PAC financial_entities tagged with this industry.
    // Industry filter comes from `entity_tags.tag` now (FIX-167) — the legacy
    // `financial_entities.industry` column was dropped.
    const taggedIds = industry ? await fetchEntityIdsByIndustryTag(supabase, industry) : [];

    const pacEntitiesRows: Array<{ id: string; display_name: string }> = [];
    if (taggedIds.length > 0) {
      const BATCH_FILTER = 200;
      for (let i = 0; i < taggedIds.length; i += BATCH_FILTER) {
        const batch = taggedIds.slice(i, i + BATCH_FILTER);
        const { data } = await withDbTimeout<{
          data: Array<{ id: string; display_name: string }> | null;
          error: { message: string } | null;
        }>(
          supabase
            .from("financial_entities")
            .select("id, display_name")
            .eq("entity_type", "pac")
            .in("id", batch)
            .not("display_name", "ilike", "%PAC/Committee%"),
        );
        if (data) pacEntitiesRows.push(...data);
      }
    }

    const pacIds = pacEntitiesRows.map((p) => p.id);

    // Step 2: pull their donations to officials via entity_connections
    // (pre-aggregated, indexed) rather than financial_relationships.
    const pacData: Array<{ to_id: string; amount_cents: number | null }> = [];
    if (pacIds.length > 0) {
      const BATCH = 200;
      const pacChunks: string[][] = [];
      for (let i = 0; i < pacIds.length; i += BATCH)
        pacChunks.push(pacIds.slice(i, i + BATCH));

      const pacResults = await Promise.all(
        pacChunks.map(batch =>
          supabase
            .from("entity_connections")
            .select("to_id, amount_cents")
            .eq("connection_type", "donation")
            .eq("from_type", "financial_entity")
            .in("from_id", batch)
            .eq("to_type", "official")
            .limit(5000)
        )
      );
      for (const r of pacResults) if (r.data) pacData.push(...r.data);
    }

    const officialMap = new Map<string, {
      officialId: string;
      totalUsd: number;
      pacCount: number;
    }>();

    for (const row of pacData) {
      const id  = row.to_id;
      const usd = (row.amount_cents ?? 0) / 100;

      if (officialMap.has(id)) {
        const ex = officialMap.get(id)!;
        ex.totalUsd  += usd;
        ex.pacCount  += 1;
      } else {
        officialMap.set(id, { officialId: id, totalUsd: usd, pacCount: 1 });
      }
    }

    const topRecipients = [...officialMap.values()]
      .sort((a, b) => b.totalUsd - a.totalUsd)
      .slice(0, limit);

    const officialIds = topRecipients.map((r) => r.officialId);

    type OfficialRow = { id: string; full_name: string; party: string | null; metadata: Record<string, unknown> | null };
    const { data: officialsData } = officialIds.length > 0
      ? await supabase
          .from("officials")
          .select("id, full_name, party, metadata")
          .in("id", officialIds)
      : { data: [] as OfficialRow[] };

    const officialLookup = new Map(
      (officialsData ?? []).map((o) => [o.id, o as OfficialRow])
    );

    const groupNode: ResponseNode = {
      id: groupId,
      name: groupName,
      type: "group" as NodeType,
      collapsed: false,
      metadata: {
        icon: groupIcon,
        color: groupColor,
        memberCount: officialMap.size,
        isGroup: true,
        isPacGroup: true,
      },
    };

    const connectedNodes: ResponseNode[] = topRecipients.map((r) => {
      const official = officialLookup.get(r.officialId);
      return {
        id: r.officialId,
        name: official?.full_name ?? "Unknown",
        type: "official" as NodeType,
        collapsed: false,
        metadata: {
          party: official?.party,
          state: (official?.metadata as Record<string, unknown> | null)?.state,
        },
      };
    });

    // Edges flow from group to officials — PAC industry → recipients
    const edges: ResponseEdge[] = topRecipients.map((r) => ({
      id: `edge-${groupId}-${r.officialId}`,
      fromId: groupId,
      toId: r.officialId,
      connectionType: "donation",
      amountUsd: r.totalUsd,
      strength: Math.min(r.totalUsd / 100_000, 1),
      metadata: { pacCount: r.pacCount },
    }));

    return NextResponse.json({
      group: {
        id: groupId,
        name: groupName,
        icon: groupIcon,
        color: groupColor,
        count: officialMap.size,
        filter: { entity_type: entityType, industry },
      },
      nodes: [groupNode, ...connectedNodes],
      edges,
      meta: {
        totalPacDonors:      officialMap.size,
        topRecipientsShown:  topRecipients.length,
        totalDonatedUsd:     topRecipients.reduce((s, r) => s + r.totalUsd, 0),
      },
    });
  }

  // ── Proposal/topic-tag group mode (FIX-137) ───────────────────────────────
  // Surface a single group node carrying memberCount. Drill-down into the
  // member proposals and their connections (votes, sponsorships) is a future
  // enhancement — for now the tag bubble is the visible artifact and the
  // count is what the user reads.

  if (entityType === "proposal") {
    if (!tag) {
      return NextResponse.json(
        { error: "tag query param required for entity_type=proposal" },
        { status: 400 },
      );
    }

    const { count: rawCount } = await supabase
      .from("entity_tags")
      .select("entity_id", { count: "exact", head: true })
      .eq("entity_type", "proposal")
      .eq("tag_category", "topic")
      .eq("tag", tag)
      .neq("visibility", "internal");

    const memberCount = rawCount ?? 0;

    const groupNode: ResponseNode = {
      id: groupId,
      name: groupName,
      type: "group" as NodeType,
      collapsed: false,
      metadata: {
        icon: groupIcon,
        color: groupColor,
        memberCount,
        isGroup: true,
        isTagGroup: true,
        tag,
      },
    };

    return NextResponse.json({
      group: {
        id: groupId,
        name: groupName,
        icon: groupIcon,
        color: groupColor,
        count: memberCount,
        filter: { entity_type: entityType, tag },
      },
      nodes: [groupNode],
      edges: [],
      meta: { memberCount, tag },
    });
  }

  // ── Agency group mode ────────────────────────────────────────────────────────
  // Show which governing bodies (congressional committees) oversee the agencies
  // in this group. Oversight edges live in entity_connections where
  // from_type='governing_body', to_type='agency', connection_type='oversight'.

  if (entityType === "agency") {
    const { data: agencyData, count: agencyCount } = await withDbTimeout<{
      data: Array<{ id: string }> | null;
      count: number | null;
      error: { message: string } | null;
    }>(
      supabase
        .from("agencies")
        .select("id", { count: "exact" })
        .eq("is_active", true)
        .limit(1000)
    );

    const agencyIds = (agencyData ?? []).map(a => a.id);

    if (agencyIds.length === 0) {
      return NextResponse.json({
        group: { id: groupId, name: groupName, count: 0 },
        nodes: [],
        edges: [],
      });
    }

    // Fetch oversight edges for all agencies in parallel batches
    const AG_BATCH = 500;
    const agChunks: string[][] = [];
    for (let i = 0; i < agencyIds.length; i += AG_BATCH)
      agChunks.push(agencyIds.slice(i, i + AG_BATCH));

    const oversightResults = await Promise.all(
      agChunks.map(batch =>
        supabase
          .from("entity_connections")
          .select("from_id, strength")
          .eq("connection_type", "oversight")
          .eq("to_type", "agency")
          .in("to_id", batch)
      )
    );
    const oversightRows: Array<{ from_id: string; strength: number }> =
      oversightResults.flatMap(r => r.data ?? []);

    // Aggregate by overseer (governing_body): count agencies each oversees
    const overseerMap = new Map<string, { agencyCount: number; totalStrength: number }>();
    for (const row of oversightRows) {
      const ex = overseerMap.get(row.from_id);
      if (ex) {
        ex.agencyCount     += 1;
        ex.totalStrength   += (row.strength ?? 0.7);
      } else {
        overseerMap.set(row.from_id, { agencyCount: 1, totalStrength: (row.strength ?? 0.7) });
      }
    }

    const topOverseers = [...overseerMap.entries()]
      .sort((a, b) => b[1].agencyCount - a[1].agencyCount)
      .slice(0, limit);

    const overseerIds = topOverseers.map(([id]) => id);
    type GovBodyRow = { id: string; name: string; metadata: Record<string, unknown> | null };
    const { data: overseerData } = overseerIds.length > 0
      ? await supabase
          .from("governing_bodies")
          .select("id, name, metadata")
          .in("id", overseerIds)
      : { data: [] as GovBodyRow[] };

    const overseerLookup = new Map(
      (overseerData ?? []).map(g => [g.id, g as GovBodyRow])
    );

    const agencyGroupNode: ResponseNode = {
      id: groupId,
      name: groupName,
      type: "group" as NodeType,
      collapsed: false,
      metadata: {
        icon: groupIcon,
        color: groupColor,
        memberCount: agencyCount ?? 0,
        isGroup: true,
        isAgencyGroup: true,
      },
    };

    // governing_body maps to 'agency' node type in the V2 type system
    const overseerNodes: ResponseNode[] = topOverseers.map(([id, stats]) => {
      const g = overseerLookup.get(id);
      return {
        id,
        name: g?.name ?? "Unknown Committee",
        type: "agency" as NodeType,
        collapsed: false,
        metadata: {
          chamber: (g?.metadata as Record<string, unknown> | null)?.chamber,
          agencyCount: stats.agencyCount,
        },
      };
    });

    const overseerEdges: ResponseEdge[] = topOverseers.map(([id, stats]) => ({
      id: `edge-${groupId}-${id}`,
      fromId: id,
      toId: groupId,
      connectionType: "oversight",
      strength: Math.min(stats.totalStrength, 1),
      metadata: { agencyCount: stats.agencyCount },
    }));

    return NextResponse.json({
      group: {
        id: groupId,
        name: groupName,
        icon: groupIcon,
        color: groupColor,
        count: agencyCount ?? 0,
        filter: { entity_type: entityType },
      },
      nodes: [agencyGroupNode, ...overseerNodes],
      edges: overseerEdges,
      meta: {
        agencyCount:      agencyCount ?? 0,
        overseersShown:   topOverseers.length,
      },
    });
  }

  return NextResponse.json({ error: "Invalid entity_type" }, { status: 400 });
}
