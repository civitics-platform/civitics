import { createAdminClient } from "@civitics/db";
import type { GraphEdge, GraphNode, EdgeType, NodeType } from "@civitics/graph";

export const dynamic = "force-dynamic";

/** Map DB entity type string → GraphNode type */
function mapNodeType(dbType: string, subType?: string): NodeType {
  switch (dbType) {
    case "official": return "official";
    case "agency": return "governing_body";
    case "governing_body": return "governing_body";
    case "proposal": return "proposal";
    case "financial": {
      // Map financial entity subtype to graph NodeType
      switch (subType) {
        case "pac":
        case "super_pac":
        case "party_committee": return "pac";
        case "individual": return "individual";
        default: return "corporation";
      }
    }
    case "organization": return "corporation";
    default: return "corporation";
  }
}

/** Map DB connection_type string → GraphEdge type */
function mapEdgeType(dbType: string): EdgeType {
  const valid: EdgeType[] = [
    "donation", "vote_yes", "vote_no", "vote_abstain",
    "appointment", "revolving_door", "oversight", "lobbying", "co_sponsorship",
  ];
  if (valid.includes(dbType as EdgeType)) return dbType as EdgeType;
  // Fallbacks for enum values not in graph's EdgeType
  switch (dbType) {
    case "contract_award": return "donation";
    case "business_partner": return "oversight";
    case "endorsement": return "oversight";
    case "family": return "appointment";
    case "legal_representation": return "oversight";
    default: return "oversight";
  }
}

export async function GET() {
  try {
    const supabase = createAdminClient();

    // Fetch connections ordered by strength, cap at 150 for performance
    const { data: connections, error } = await supabase
      .from("entity_connections")
      .select("*")
      .order("strength", { ascending: false })
      .limit(150);

    if (error) throw error;
    if (!connections || connections.length === 0) {
      return Response.json({ nodes: [], edges: [], count: 0 });
    }

    // Collect unique entity (type, id) pairs
    const entityMap = new Map<string, { type: string; id: string }>();
    for (const conn of connections) {
      entityMap.set(`${conn.from_type}:${conn.from_id}`, {
        type: conn.from_type,
        id: conn.from_id,
      });
      entityMap.set(`${conn.to_type}:${conn.to_id}`, {
        type: conn.to_type,
        id: conn.to_id,
      });
    }

    const entities = [...entityMap.values()];
    const officialIds   = entities.filter((e) => e.type === "official").map((e) => e.id);
    const agencyIds     = entities.filter((e) => e.type === "agency").map((e) => e.id);
    const proposalIds   = entities.filter((e) => e.type === "proposal").map((e) => e.id);
    const gbIds         = entities.filter((e) => e.type === "governing_body").map((e) => e.id);
    const financialIds  = entities.filter((e) => e.type === "financial").map((e) => e.id);

    // Batch-fetch names in parallel
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

    // Build name lookup
    const nameMap = new Map<string, { label: string; party?: string; subType?: string }>();
    for (const o of officialsRes.data ?? []) {
      nameMap.set(o.id, { label: o.full_name, party: o.party ?? undefined });
    }
    for (const a of agenciesRes.data ?? []) {
      nameMap.set(a.id, { label: a.acronym ?? a.name });
    }
    for (const p of proposalsRes.data ?? []) {
      nameMap.set(p.id, { label: p.title });
    }
    for (const g of gbRes.data ?? []) {
      nameMap.set(g.id, { label: g.name });
    }
    for (const f of financialRes.data ?? []) {
      nameMap.set(f.id, { label: f.name, subType: f.entity_type });
    }

    // Build nodes — one per unique entity (keyed as "type:id")
    // Use fallback label if name lookup failed — never silently drop a node
    const nodes: GraphNode[] = [];
    for (const [key, { type, id }] of entityMap) {
      const info = nameMap.get(id) ?? { label: `Unknown ${type}` };
      nodes.push({
        id: key,
        type: mapNodeType(type, info.subType),
        label: info.label,
        party: info.party as GraphNode["party"],
        metadata: { entityType: type, entityId: id },
      });
    }

    const nodeIds = new Set(nodes.map((n) => n.id));

    // Build edges
    const edges: GraphEdge[] = [];
    for (const c of connections) {
      const sourceKey = `${c.from_type}:${c.from_id}`;
      const targetKey = `${c.to_type}:${c.to_id}`;
      if (!nodeIds.has(sourceKey) || !nodeIds.has(targetKey)) continue;
      edges.push({
        id: c.id,
        source: sourceKey,
        target: targetKey,
        type: mapEdgeType(c.connection_type),
        amountCents: c.amount_cents ?? undefined,
        occurredAt: c.occurred_at ?? undefined,
        strength: Number(c.strength),
      });
    }

    return Response.json({ nodes, edges, count: connections.length });
  } catch (err) {
    console.error("[graph/connections]", err);
    return Response.json({ error: "Failed to load graph data" }, { status: 500 });
  }
}
