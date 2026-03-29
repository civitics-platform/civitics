export const revalidate = 60; // Graph connections cached 1 minute at edge

import { createAdminClient } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";
import type { Database } from "@civitics/db";
import type { GraphEdgeV2 as GraphEdge, GraphNodeV2 as GraphNode, EdgeType, NodeTypeV2 as NodeType } from "@civitics/graph";

type ConnectionRow = Database["public"]["Tables"]["entity_connections"]["Row"];

export const dynamic = "force-dynamic";

/**
 * At depth 2, neighbors with fewer than MAX_AUTO_EXPAND connections are expanded
 * automatically. Neighbors at or above this threshold are returned as "collapsed"
 * nodes with a + badge — the user must click to expand them manually.
 *
 * This prevents financial entities like "Individual Contributors" (which connect to
 * hundreds of officials) from freezing the graph when using Follow the Money + depth 2.
 */
const MAX_AUTO_EXPAND = 50;

/** Map DB entity type string → GraphNode type */
function mapNodeType(dbType: string, subType?: string): NodeType {
  switch (dbType) {
    case "official": return "official";
    case "agency": return "agency";
    case "governing_body": return "agency";
    case "proposal": return "proposal";
    case "financial": {
      switch (subType) {
        case "pac":
        case "super_pac":
        case "party_committee": return "pac";
        case "individual": return "individual";
        default: return "corporation";
      }
    }
    case "organization": return "organization";
    default: return "corporation";
  }
}

/** Map DB connection_type string → GraphEdge type */
function mapEdgeType(dbType: string): EdgeType {
  const valid: EdgeType[] = [
    "donation", "vote_yes", "vote_no", "vote_abstain",
    "nomination_vote_yes", "nomination_vote_no",
    "appointment", "revolving_door", "oversight", "lobbying", "co_sponsorship",
  ];
  if (valid.includes(dbType as EdgeType)) return dbType as EdgeType;
  switch (dbType) {
    case "contract_award": return "donation";
    case "business_partner": return "oversight";
    case "endorsement": return "oversight";
    case "family": return "appointment";
    case "legal_representation": return "oversight";
    default: return "oversight";
  }
}

/**
 * Remove connections to proposals whose vote_category = 'procedural'.
 * Procedural votes (cloture, passage motions, etc.) clutter the graph
 * without providing accountability insight. Hidden by default; researchers
 * can opt in with ?include_procedural=true.
 *
 * Non-proposal connections (donations, oversight, etc.) are always kept.
 */
async function filterProceduralConnections(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  connections: ConnectionRow[],
): Promise<ConnectionRow[]> {
  const proposalIds = [
    ...new Set(
      connections
        .filter((c) => c.to_type === "proposal")
        .map((c) => c.to_id),
    ),
  ];

  if (proposalIds.length === 0) return connections;

  const { data } = await supabase
    .from("proposals")
    .select("id, vote_category")
    .in("id", proposalIds);

  const proceduralIds = new Set(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((data ?? []) as unknown as { id: string; vote_category: string | null }[])
      .filter((p) => p.vote_category === "procedural")
      .map((p) => p.id),
  );

  if (proceduralIds.size === 0) return connections;

  return connections.filter(
    (c) => c.to_type !== "proposal" || !proceduralIds.has(c.to_id),
  );
}

export async function GET(request: Request) {
  if (supabaseUnavailable()) return unavailableResponse();
  const { searchParams } = new URL(request.url);
  const entityId = searchParams.get("entityId");
  // Server handles up to depth 2 (direct + one smart expansion).
  // Client-side BFS handles further depth filtering on the loaded data.
  const depth = Math.min(parseInt(searchParams.get("depth") ?? "1", 10), 2);
  // Default: hide procedural votes (cloture, passage motions, etc.).
  // Pass ?include_procedural=true to show all — for researchers/journalists.
  const includeProcedural = searchParams.get("include_procedural") === "true";

  try {
    const supabase = createAdminClient();

    let connections: ConnectionRow[] = [];
    let totalCount = 0;

    // Tracks which neighbor nodes were too large to auto-expand: entityId → connectionCount
    const collapsedNodes = new Map<string, number>();

    if (entityId) {
      // ── Entity-focused mode — parallel type-bucketed fetches ───────────
      // Donations and oversight are fetched in full (never more than ~20–30).
      // Votes are capped at 50 most recent — prevents a single default row limit
      // from crowding out donations when an official has thousands of vote records.
      const VOTE_TYPES = [
        "vote_yes", "vote_no", "vote_abstain",
        "nomination_vote_yes", "nomination_vote_no",
      ] as const;
      const OVERSIGHT_TYPES = ["oversight", "appointment", "co_sponsorship"] as const;

      const [donationsRes, votesRes, oversightRes] = await Promise.all([
        supabase
          .from("entity_connections")
          .select("*")
          .eq("connection_type", "donation")
          .or(`from_id.eq.${entityId},to_id.eq.${entityId}`),
        supabase
          .from("entity_connections")
          .select("*")
          .in("connection_type", VOTE_TYPES)
          .or(`from_id.eq.${entityId},to_id.eq.${entityId}`)
          .order("occurred_at", { ascending: false, nullsFirst: false })
          .limit(50),
        supabase
          .from("entity_connections")
          .select("*")
          .in("connection_type", OVERSIGHT_TYPES)
          .or(`from_id.eq.${entityId},to_id.eq.${entityId}`),
      ]);

      if (donationsRes.error) throw donationsRes.error;
      const direct: ConnectionRow[] = [
        ...(donationsRes.data ?? []),
        ...(oversightRes.data ?? []),
        ...(votesRes.data ?? []),
      ];

      if (depth >= 2 && direct.length > 0) {
        // Get all neighbor IDs from direct connections
        const neighborIds = Array.from(
          new Set(direct.map((c) => (c.from_id === entityId ? c.to_id : c.from_id)))
        );

        // Count how many connections each neighbor has (to decide auto-expand vs. collapsed)
        const [neighborFromCounts, neighborToCounts] = await Promise.all([
          supabase.from("entity_connections").select("from_id").in("from_id", neighborIds),
          supabase.from("entity_connections").select("to_id").in("to_id", neighborIds),
        ]);

        const neighborConnCounts = new Map<string, number>();
        for (const r of neighborFromCounts.data ?? []) {
          neighborConnCounts.set(r.from_id, (neighborConnCounts.get(r.from_id) ?? 0) + 1);
        }
        for (const r of neighborToCounts.data ?? []) {
          neighborConnCounts.set(r.to_id, (neighborConnCounts.get(r.to_id) ?? 0) + 1);
        }

        const autoExpandIds: string[] = [];
        for (const id of neighborIds) {
          const count = neighborConnCounts.get(id) ?? 0;
          if (count >= MAX_AUTO_EXPAND) {
            // Too many connections — show as collapsed, let user expand manually
            collapsedNodes.set(id, count);
          } else {
            autoExpandIds.push(id);
          }
        }

        if (autoExpandIds.length > 0) {
          const [expandFromRes, expandToRes] = await Promise.all([
            supabase.from("entity_connections").select("*").in("from_id", autoExpandIds),
            supabase.from("entity_connections").select("*").in("to_id", autoExpandIds),
          ]);
          const connMap = new Map<string, ConnectionRow>();
          for (const c of [...direct, ...(expandFromRes.data ?? []), ...(expandToRes.data ?? [])]) {
            connMap.set(c.id, c);
          }
          connections = [...connMap.values()];
        } else {
          connections = direct;
        }
      } else {
        connections = direct;
      }

      if (!includeProcedural) {
        connections = await filterProceduralConnections(supabase, connections);
      }

      totalCount = connections.length;

    } else {
      // ── Default view: top 10 most connected officials ──────────────────
      const { data: allForCount, error: countErr } = await supabase
        .from("entity_connections")
        .select("from_id, from_type, to_id, to_type");

      if (countErr) throw countErr;
      totalCount = allForCount?.length ?? 0;

      if (!allForCount || allForCount.length === 0) {
        return Response.json({ nodes: [], edges: [], count: 0 });
      }

      const officialCounts = new Map<string, number>();
      for (const c of allForCount) {
        if (c.from_type === "official") officialCounts.set(c.from_id, (officialCounts.get(c.from_id) ?? 0) + 1);
        if (c.to_type === "official") officialCounts.set(c.to_id, (officialCounts.get(c.to_id) ?? 0) + 1);
      }

      const top10Ids = [...officialCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([id]) => id);

      if (top10Ids.length === 0) {
        return Response.json({ nodes: [], edges: [], count: totalCount });
      }

      const [fromRes, toRes] = await Promise.all([
        supabase.from("entity_connections").select("*").in("from_id", top10Ids),
        supabase.from("entity_connections").select("*").in("to_id", top10Ids),
      ]);

      const connMap = new Map<string, ConnectionRow>();
      for (const c of [...(fromRes.data ?? []), ...(toRes.data ?? [])]) {
        connMap.set(c.id, c);
      }
      connections = [...connMap.values()];

      if (!includeProcedural) {
        connections = await filterProceduralConnections(supabase, connections);
      }
    }

    // ── Collect unique entity (type, id) pairs ─────────────────────────────
    const entityMap = new Map<string, { type: string; id: string }>();
    for (const conn of connections) {
      entityMap.set(`${conn.from_type}:${conn.from_id}`, { type: conn.from_type, id: conn.from_id });
      entityMap.set(`${conn.to_type}:${conn.to_id}`, { type: conn.to_type, id: conn.to_id });
    }

    // Also ensure collapsed nodes appear as graph nodes (they're in direct connections
    // but may not have any connections in the expanded set).
    // They're already included via the `direct` connections above — the entity map
    // captures them from the direct connection endpoints.

    const entities = [...entityMap.values()];
    const officialIds  = entities.filter((e) => e.type === "official").map((e) => e.id);
    const agencyIds    = entities.filter((e) => e.type === "agency").map((e) => e.id);
    const proposalIds  = entities.filter((e) => e.type === "proposal").map((e) => e.id);
    const gbIds        = entities.filter((e) => e.type === "governing_body").map((e) => e.id);
    const financialIds = entities.filter((e) => e.type === "financial").map((e) => e.id);

    // ── Batch-fetch names in parallel ──────────────────────────────────────
    const [officialsRes, agenciesRes, proposalsRes, gbRes, financialRes] = await Promise.all([
      officialIds.length
        ? supabase.from("officials").select("id, full_name, party").in("id", officialIds)
        : Promise.resolve({ data: [] as { id: string; full_name: string; party: string | null }[] }),
      agencyIds.length
        ? supabase.from("agencies").select("id, name, acronym").in("id", agencyIds)
        : Promise.resolve({ data: [] as { id: string; name: string; acronym: string | null }[] }),
      proposalIds.length
        ? supabase.from("proposals").select("id, title").in("id", proposalIds)
        : Promise.resolve({ data: [] as { id: string; title: string }[] }),
      gbIds.length
        ? supabase.from("governing_bodies").select("id, name").in("id", gbIds)
        : Promise.resolve({ data: [] as { id: string; name: string }[] }),
      financialIds.length
        ? supabase.from("financial_entities").select("id, name, entity_type").in("id", financialIds)
        : Promise.resolve({ data: [] as { id: string; name: string; entity_type: string }[] }),
    ]);

    // ── Build name lookup ───────────────────────────────────────────────────
    const nameMap = new Map<string, { label: string; party?: string; subType?: string }>();
    for (const o of officialsRes.data ?? []) nameMap.set(o.id, { label: o.full_name, party: o.party ?? undefined });
    for (const a of agenciesRes.data ?? []) nameMap.set(a.id, { label: a.acronym ?? a.name });
    for (const p of proposalsRes.data ?? []) nameMap.set(p.id, { label: p.title });
    for (const g of gbRes.data ?? []) nameMap.set(g.id, { label: g.name });
    for (const f of financialRes.data ?? []) nameMap.set(f.id, { label: f.name, subType: f.entity_type });

    // ── Build nodes ────────────────────────────────────────────────────────
    const nodes: GraphNode[] = [];
    for (const [key, { type, id }] of entityMap) {
      const info = nameMap.get(id) ?? { label: `Unknown ${type}` };
      const isCollapsed = collapsedNodes.has(id);
      nodes.push({
        id: key,
        type: mapNodeType(type, info.subType),
        name: info.label,
        party: info.party as GraphNode["party"],
        ...(isCollapsed
          ? { collapsed: true, connectionCount: collapsedNodes.get(id) }
          : {}),
      });
    }

    const nodeIds = new Set(nodes.map((n) => n.id));

    // ── Build edges ────────────────────────────────────────────────────────
    const edges: GraphEdge[] = [];
    for (const c of connections) {
      const sourceKey = `${c.from_type}:${c.from_id}`;
      const targetKey = `${c.to_type}:${c.to_id}`;
      if (!nodeIds.has(sourceKey) || !nodeIds.has(targetKey)) continue;
      edges.push({
        fromId: sourceKey,
        toId: targetKey,
        connectionType: mapEdgeType(c.connection_type),
        amountUsd: c.amount_cents != null ? c.amount_cents / 100 : undefined,
        occurredAt: c.occurred_at ?? undefined,
        strength: Number(c.strength),
      });
    }

    return Response.json({ nodes, edges, count: totalCount });
  } catch (err) {
    console.error("[graph/connections]", err);
    return Response.json({ error: "Failed to load graph data" }, { status: 500 });
  }
}
