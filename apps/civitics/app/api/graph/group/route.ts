export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";
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
  const groupName  = searchParams.get("groupName")  ?? "Group";
  const groupIcon  = searchParams.get("groupIcon")  ?? "👥";
  const groupColor = searchParams.get("groupColor") ?? "#6366f1";
  const limit      = Math.min(parseInt(searchParams.get("limit") ?? "50"), 100);

  const supabase = createAdminClient();

  // ── Official group mode ──────────────────────────────────────────────────────
  // Who donated to this group of officials, and how much in aggregate?

  if (entityType === "official") {
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
      memberQuery = memberQuery.filter("metadata->>state", "eq", state);

    const { count: memberCount, data: memberData } = await memberQuery.limit(1000);

    const memberIds = (memberData ?? []).map((m) => m.id);

    if (memberIds.length === 0) {
      return NextResponse.json({
        group: { id: groupId, name: groupName, count: 0 },
        nodes: [],
        edges: [],
      });
    }

    // Batch the .in() query — PostgREST URL limits break with hundreds of UUIDs
    const BATCH_SIZE = 100;
    const allDonationRows: Array<{ donor_name: string; amount_cents: number; metadata: unknown }> = [];
    for (let i = 0; i < memberIds.length; i += BATCH_SIZE) {
      const batch = memberIds.slice(i, i + BATCH_SIZE);
      const { data: batchData } = await supabase
        .from("financial_relationships")
        .select("donor_name, amount_cents, metadata")
        .in("official_id", batch)
        .not("donor_name", "ilike", "%PAC/Committee%")
        .order("amount_cents", { ascending: false });
      if (batchData) allDonationRows.push(...batchData);
    }
    const donationData = allDonationRows;

    // Aggregate by donor name across all group members
    const donorMap = new Map<string, {
      donorName: string;
      totalUsd: number;
      memberCount: number;
      sector: string | null;
    }>();

    for (const row of donationData ?? []) {
      const key    = row.donor_name as string;
      const usd    = ((row.amount_cents as number) ?? 0) / 100;
      const sector = ((row.metadata as Record<string, unknown> | null)?.sector as string) ?? null;

      if (donorMap.has(key)) {
        const existing = donorMap.get(key)!;
        existing.totalUsd    += usd;
        existing.memberCount += 1;
      } else {
        donorMap.set(key, { donorName: key, totalUsd: usd, memberCount: 1, sector });
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

    const connectedNodes: ResponseNode[] = topDonors.map((donor, i) => ({
      id: `donor-${groupId}-${i}`,
      name: donor.donorName,
      type: "financial" as NodeType,
      collapsed: false,
      metadata: { sector: donor.sector },
    }));

    const edges: ResponseEdge[] = topDonors.map((donor, i) => ({
      id: `edge-${groupId}-${i}`,
      fromId: `donor-${groupId}-${i}`,
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
        filter: { entity_type: entityType, chamber, party, state },
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
    const { data: pacData } = await supabase
      .from("financial_relationships")
      .select("official_id, amount_cents")
      .eq("donor_type", "pac")
      .filter("metadata->>sector", "eq", industry ?? "")
      .not("donor_name", "ilike", "%PAC/Committee%");

    const officialMap = new Map<string, {
      officialId: string;
      totalUsd: number;
      pacCount: number;
    }>();

    for (const row of pacData ?? []) {
      const id  = row.official_id as string;
      const usd = ((row.amount_cents as number) ?? 0) / 100;

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

  return NextResponse.json({ error: "Invalid entity_type" }, { status: 400 });
}
