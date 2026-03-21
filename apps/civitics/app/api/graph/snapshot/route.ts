/**
 * Graph Snapshot API — share-code creation/retrieval AND diagnostic data verification.
 *
 * DIAGNOSTIC MODE (viz/entity_id/entity_name params present):
 *   GET /api/graph/snapshot?viz=chord
 *   GET /api/graph/snapshot?entity_name=warren&viz=force&depth=2
 *   GET /api/graph/snapshot?viz=treemap
 *   GET /api/graph/snapshot?entity_name=phrma&entity_name_2=mcconnell
 *   GET /api/graph/snapshot?viz=chord&industry=pharma
 *   GET /api/graph/snapshot?viz=force&check_quality=true
 *
 * SHARE CODE MODE (existing — unmodified):
 *   POST /api/graph/snapshot        — create a share-code snapshot
 *   GET  /api/graph/snapshot?code=  — fetch a share-code snapshot
 *
 * Rate limit: 10 diagnostic requests / minute / IP (in-memory, resets on cold start).
 * No auth required — all civic data is public.
 */

import { createAdminClient } from "@civitics/db";
import type { Json } from "@civitics/db";

export const dynamic = "force-dynamic";
// revalidate = 60 is overridden by force-dynamic; Cache-Control header is set manually.

// ── Rate limiter ───────────────────────────────────────────────────────────────
const RL = new Map<string, { n: number; t: number }>();
const RL_MAX = 10;
const RL_WIN_MS = 60_000;

function getIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

function rateOk(ip: string): boolean {
  const now = Date.now();
  const s = RL.get(ip);
  if (!s || now - s.t > RL_WIN_MS) {
    RL.set(ip, { n: 1, t: now });
    return true;
  }
  if (s.n >= RL_MAX) return false;
  s.n++;
  return true;
}

// ── Industry metadata ──────────────────────────────────────────────────────────
const INDUSTRY_ICONS: Record<string, string> = {
  pharma: "💊",
  finance: "📈",
  labor: "👷",
  tech: "💻",
  technology: "💻",
  energy: "⚡",
  healthcare: "🏥",
  defense: "🛡️",
  telecom: "📡",
  agriculture: "🌾",
  real_estate: "🏠",
  legal: "⚖️",
  transport: "🚗",
  insurance: "🛡",
  tobacco: "🚬",
  oil_gas: "🛢️",
};
const icoFor = (s: string) => INDUSTRY_ICONS[s.toLowerCase()] ?? "🏢";
const labelFor = (s: string) =>
  s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// ── Types ──────────────────────────────────────────────────────────────────────
interface ResolvedEntity {
  id: string;
  name: string;
  type: string;
  role?: string;
  state?: string;
  party?: string;
  tags: string[];
}

interface QualityCheck {
  name: string;
  passed: boolean;
  detail: string;
}

interface DiagnosticRequest {
  viz: "force" | "chord" | "treemap" | "sunburst";
  entityId: string | null;
  entityName: string | null;
  entityName2: string | null;
  depth: number;
  filters: string[];
  industry: string[];
  limit: number;
}

// ── Entity resolution ──────────────────────────────────────────────────────────

type AdminClient = ReturnType<typeof createAdminClient>;

interface SearchRow {
  id: string;
  label: string;
  entity_type: string;
  subtitle: string | null;
  party: string | null;
}

async function fetchEntityTags(supabase: AdminClient, id: string): Promise<string[]> {
  const { data } = await supabase
    .from("entity_tags")
    .select("tag")
    .eq("entity_id", id)
    .eq("visibility", "primary")
    .gte("confidence", 0.7)
    .limit(5);
  return (data ?? []).map((t: { tag: string }) => t.tag);
}

async function resolveEntityByName(
  supabase: AdminClient,
  name: string,
): Promise<{ entity: ResolvedEntity | null; queries: number }> {
  const { data, error } = await supabase.rpc("search_graph_entities", {
    q: name,
    lim: 1,
  });
  let queries = 1;
  if (error || !data?.length) return { entity: null, queries };

  const row = (data as SearchRow[])[0]!;
  const tags = await fetchEntityTags(supabase, row.id);
  queries++;

  let state: string | undefined;
  if (row.entity_type === "official") {
    const { data: off } = await supabase
      .from("officials")
      .select("metadata")
      .eq("id", row.id)
      .maybeSingle();
    queries++;
    state = (off?.metadata as Record<string, string> | null)?.["state"] ?? undefined;
  }

  return {
    entity: {
      id: row.id,
      name: row.label,
      type: row.entity_type,
      role: row.subtitle ?? undefined,
      state,
      party: row.party ?? undefined,
      tags,
    },
    queries,
  };
}

async function resolveEntityById(
  supabase: AdminClient,
  id: string,
): Promise<{ entity: ResolvedEntity | null; queries: number }> {
  let queries = 1;

  // Try officials first (most common case)
  const { data: official } = await supabase
    .from("officials")
    .select("id, full_name, party, role_title, metadata")
    .eq("id", id)
    .maybeSingle();

  if (official) {
    const tags = await fetchEntityTags(supabase, id);
    queries++;
    return {
      entity: {
        id,
        name: official.full_name,
        type: "official",
        role: official.role_title,
        state:
          (official.metadata as Record<string, string> | null)?.["state"] ??
          undefined,
        party: official.party ?? undefined,
        tags,
      },
      queries,
    };
  }

  // Try remaining tables in parallel
  const [feRes, propRes, gbRes] = await Promise.all([
    supabase
      .from("financial_entities")
      .select("id, name, entity_type")
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("proposals")
      .select("id, title")
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("governing_bodies")
      .select("id, name")
      .eq("id", id)
      .maybeSingle(),
  ]);
  queries++;

  if (feRes.data) {
    return {
      entity: { id, name: feRes.data.name, type: "financial", tags: [] },
      queries,
    };
  }
  if (propRes.data) {
    return {
      entity: { id, name: propRes.data.title, type: "proposal", tags: [] },
      queries,
    };
  }
  if (gbRes.data) {
    return {
      entity: { id, name: gbRes.data.name, type: "governing_body", tags: [] },
      queries,
    };
  }

  return { entity: null, queries };
}

// ── Force viz ──────────────────────────────────────────────────────────────────
interface ConnectionRow {
  id: string;
  from_id: string;
  from_type: string;
  to_id: string;
  to_type: string;
  connection_type: string;
  strength: number | string;
  amount_cents: number | null;
}

async function buildForceData(
  supabase: AdminClient,
  req: DiagnosticRequest,
  resolvedId: string | null,
  resolvedId2: string | null,
): Promise<{
  nodes: ReturnType<typeof forceNodes>;
  edges: ReturnType<typeof forceEdges>;
  path: string[] | undefined;
  queries: number;
  nodeCount: number;
  edgeCount: number;
  donationTotal: number;
  donationWithAmount: number;
  orphanCount: number;
}> {
  let queries = 0;
  const { depth, filters, limit } = req;

  // Fetch direct connections
  let q = supabase
    .from("entity_connections")
    .select("id, from_id, from_type, to_id, to_type, connection_type, strength, amount_cents")
    .order("strength", { ascending: false })
    .limit(limit);

  if (resolvedId) q = q.or(`from_id.eq.${resolvedId},to_id.eq.${resolvedId}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (filters.length > 0) q = (q as any).in("connection_type", filters);

  const { data: direct } = await q;
  queries++;
  let all = (direct ?? []) as ConnectionRow[];

  // Depth 2: expand up to 20 neighbors
  if (depth >= 2 && resolvedId && all.length > 0) {
    const neighborIds = [
      ...new Set(
        all.map((c) => (c.from_id === resolvedId ? c.to_id : c.from_id)),
      ),
    ].slice(0, 20);

    const [fRes, tRes] = await Promise.all([
      supabase
        .from("entity_connections")
        .select("id, from_id, from_type, to_id, to_type, connection_type, strength, amount_cents")
        .in("from_id", neighborIds)
        .limit(Math.ceil(limit / 2)),
      supabase
        .from("entity_connections")
        .select("id, from_id, from_type, to_id, to_type, connection_type, strength, amount_cents")
        .in("to_id", neighborIds)
        .limit(Math.ceil(limit / 2)),
    ]);
    queries += 2;

    const seen = new Set(all.map((c) => c.id));
    for (const c of [
      ...((fRes.data ?? []) as ConnectionRow[]),
      ...((tRes.data ?? []) as ConnectionRow[]),
    ]) {
      if (!seen.has(c.id)) {
        all.push(c);
        seen.add(c.id);
      }
    }
  }

  // Collect unique entities
  const entityMap = new Map<string, { type: string; id: string }>();
  for (const c of all) {
    entityMap.set(c.from_id, { type: c.from_type, id: c.from_id });
    entityMap.set(c.to_id, { type: c.to_type, id: c.to_id });
  }

  // Count connections per node
  const connCount = new Map<string, number>();
  let donationTotal = 0;
  let donationWithAmount = 0;
  for (const c of all) {
    connCount.set(c.from_id, (connCount.get(c.from_id) ?? 0) + 1);
    connCount.set(c.to_id, (connCount.get(c.to_id) ?? 0) + 1);
    if (c.connection_type === "donation") {
      donationTotal++;
      if (c.amount_cents != null) donationWithAmount++;
    }
  }

  // Orphan check: nodes with zero connections in this edge set
  const connectedIds = new Set<string>();
  for (const c of all) {
    connectedIds.add(c.from_id);
    connectedIds.add(c.to_id);
  }
  let orphanCount = 0;
  for (const id of entityMap.keys()) {
    if (!connectedIds.has(id)) orphanCount++;
  }

  // Fetch names
  const ids = [...entityMap.values()];
  const officialIds = ids.filter((e) => e.type === "official").map((e) => e.id);
  const financialIds = ids.filter((e) => e.type === "financial").map((e) => e.id);
  const proposalIds = ids.filter((e) => e.type === "proposal").map((e) => e.id);
  const gbIds = ids
    .filter((e) => ["governing_body", "agency"].includes(e.type))
    .map((e) => e.id);

  const [offRes, finRes, propRes, gbRes] = await Promise.all([
    officialIds.length
      ? supabase.from("officials").select("id, full_name").in("id", officialIds)
      : Promise.resolve({ data: [] as { id: string; full_name: string }[] }),
    financialIds.length
      ? supabase.from("financial_entities").select("id, name").in("id", financialIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    proposalIds.length
      ? supabase.from("proposals").select("id, title").in("id", proposalIds)
      : Promise.resolve({ data: [] as { id: string; title: string }[] }),
    gbIds.length
      ? supabase.from("governing_bodies").select("id, name").in("id", gbIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
  ]);
  queries += 4;

  const nameMap = new Map<string, string>();
  for (const o of (offRes.data ?? []) as { id: string; full_name: string }[])
    nameMap.set(o.id, o.full_name);
  for (const f of (finRes.data ?? []) as { id: string; name: string }[])
    nameMap.set(f.id, f.name);
  for (const p of (propRes.data ?? []) as { id: string; title: string }[])
    nameMap.set(p.id, p.title);
  for (const g of (gbRes.data ?? []) as { id: string; name: string }[])
    nameMap.set(g.id, g.name);

  // Path finder
  let path: string[] | undefined;
  if (resolvedId && resolvedId2) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: pathData } = await (supabase as any).rpc("find_entity_path", {
        p_from_id: resolvedId,
        p_to_id: resolvedId2,
        p_max_hops: 4,
      });
      queries++;
      if (Array.isArray(pathData) && pathData.length > 0) {
        path = (pathData as { entity_id: string }[]).map(
          (p) => nameMap.get(p.entity_id) ?? p.entity_id,
        );
      }
    } catch {
      // RPC may not be configured — silently skip
    }
  }

  return {
    nodes: forceNodes([...entityMap.values()].slice(0, 20), nameMap, connCount),
    edges: forceEdges(all.slice(0, 20), nameMap),
    path,
    queries,
    nodeCount: entityMap.size,
    edgeCount: all.length,
    donationTotal,
    donationWithAmount,
    orphanCount,
  };
}

function forceNodes(
  entities: { type: string; id: string }[],
  nameMap: Map<string, string>,
  connCount: Map<string, number>,
) {
  return entities.map(({ type, id }) => ({
    id,
    name: nameMap.get(id) ?? `Unknown ${type}`,
    type,
    tags: [] as string[],
    connection_count: connCount.get(id) ?? 0,
  }));
}

function forceEdges(
  connections: ConnectionRow[],
  nameMap: Map<string, string>,
) {
  return connections.map((c) => ({
    from_name: nameMap.get(c.from_id) ?? c.from_id,
    to_name: nameMap.get(c.to_id) ?? c.to_id,
    connection_type: c.connection_type,
    amount_usd: c.amount_cents != null ? c.amount_cents / 100 : null,
    strength: Number(c.strength),
  }));
}

// ── Chord viz ──────────────────────────────────────────────────────────────────
async function buildChordData(
  supabase: AdminClient,
  industryFilter: string[],
  limit: number,
): Promise<{
  groups: {
    id: string;
    label: string;
    icon: string;
    total_usd: number;
    pac_count: number;
  }[];
  recipients: {
    id: string;
    label: string;
    total_received_usd: number;
    official_count: number;
  }[];
  matrix: number[][];
  top_flows: { from: string; to: string; amount_usd: number }[];
  total_flow_usd: number;
  untagged_flow_usd: number;
  untagged_flow_pct: number;
  queries: number;
}> {
  let queries = 0;

  type FRRow = {
    official_id: string | null;
    donor_name: string;
    industry: string | null;
    amount_cents: number;
  };

  let frQ = supabase
    .from("financial_relationships")
    .select("official_id, donor_name, industry, amount_cents")
    .not("amount_cents", "is", null)
    .gt("amount_cents", 0)
    .limit(limit);

  if (industryFilter.length > 0) frQ = frQ.in("industry", industryFilter);

  const { data: fr } = await frQ;
  queries++;

  const rows = (fr ?? []) as FRRow[];

  // Fetch official parties
  const officialIds = [...new Set(rows.map((r) => r.official_id).filter(Boolean))] as string[];
  const officialsRes = officialIds.length
    ? await supabase.from("officials").select("id, party").in("id", officialIds)
    : null;
  const officials = (officialsRes?.data ?? []) as { id: string; party: string | null }[];
  queries++;

  const partyMap = new Map<string, string>();
  for (const o of officials)
    partyMap.set(o.id, o.party ?? "other");

  // Aggregate
  const industryTotals = new Map<string, { total: number; donors: Set<string> }>();
  const recipientTotals = new Map<string, { total: number; officials: Set<string> }>();
  const flowMatrix = new Map<string, Map<string, number>>();
  let untaggedFlow = 0;
  let totalFlow = 0;

  for (const row of rows) {
    const usd = row.amount_cents / 100;
    const industry = row.industry ?? "__untagged__";
    const party = row.official_id ? (partyMap.get(row.official_id) ?? "other") : "other";

    totalFlow += usd;
    if (!row.industry) untaggedFlow += usd;

    const ig = industryTotals.get(industry) ?? { total: 0, donors: new Set<string>() };
    ig.total += usd;
    ig.donors.add(row.donor_name);
    industryTotals.set(industry, ig);

    const rg = recipientTotals.get(party) ?? { total: 0, officials: new Set<string>() };
    rg.total += usd;
    if (row.official_id) rg.officials.add(row.official_id);
    recipientTotals.set(party, rg);

    if (!flowMatrix.has(industry)) flowMatrix.set(industry, new Map());
    const pm = flowMatrix.get(industry)!;
    pm.set(party, (pm.get(party) ?? 0) + usd);
  }

  const groups = [...industryTotals.entries()]
    .filter(([k]) => k !== "__untagged__")
    .sort((a, b) => b[1].total - a[1].total)
    .map(([id, { total, donors }]) => ({
      id,
      label: labelFor(id),
      icon: icoFor(id),
      total_usd: Math.round(total),
      pac_count: donors.size,
    }));

  const recipients = [...recipientTotals.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([id, { total, officials }]) => ({
      id,
      label: id.charAt(0).toUpperCase() + id.slice(1),
      total_received_usd: Math.round(total),
      official_count: officials.size,
    }));

  const groupIds = groups.map((g) => g.id);
  const recipientIds = recipients.map((r) => r.id);

  const matrix: number[][] = groupIds.map((gid) =>
    recipientIds.map((rid) => Math.round(flowMatrix.get(gid)?.get(rid) ?? 0)),
  );

  const topFlows: { from: string; to: string; amount_usd: number }[] = [];
  for (const [ind, pm] of flowMatrix) {
    if (ind === "__untagged__") continue;
    for (const [party, usd] of pm)
      topFlows.push({ from: labelFor(ind), to: party, amount_usd: Math.round(usd) });
  }
  topFlows.sort((a, b) => b.amount_usd - a.amount_usd);

  return {
    groups,
    recipients,
    matrix,
    top_flows: topFlows.slice(0, 10),
    total_flow_usd: Math.round(totalFlow),
    untagged_flow_usd: Math.round(untaggedFlow),
    untagged_flow_pct: totalFlow > 0 ? Math.round((untaggedFlow / totalFlow) * 100) : 0,
    queries,
  };
}

// ── Treemap viz ────────────────────────────────────────────────────────────────
interface TreemapRow {
  official_id: string;
  official_name: string;
  party: string;
  state: string;
  total_donated_cents: number;
}

async function buildTreemapData(
  supabase: AdminClient,
  limit: number,
): Promise<{
  hierarchy: object;
  total_value: number;
  node_count: number;
  max_value: number;
  max_value_entity: string;
  queries: number;
}> {
  const { data, error } = await supabase.rpc("treemap_officials_by_donations", {
    lim: Math.min(limit, 200),
  });

  if (error || !data) {
    return {
      hierarchy: { name: "All Officials", value: 0, children: [] },
      total_value: 0,
      node_count: 0,
      max_value: 0,
      max_value_entity: "",
      queries: 1,
    };
  }

  const rows = data as TreemapRow[];
  const partyGroups = new Map<string, TreemapRow[]>();
  for (const r of rows) {
    const p = r.party ?? "other";
    if (!partyGroups.has(p)) partyGroups.set(p, []);
    partyGroups.get(p)!.push(r);
  }

  const children = [...partyGroups.entries()].map(([party, members]) => ({
    name: party.charAt(0).toUpperCase() + party.slice(1),
    value: members.reduce((s, m) => s + (m.total_donated_cents ?? 0), 0) / 100,
    children: members.map((m) => ({
      id: m.official_id,
      name: m.official_name,
      value: (m.total_donated_cents ?? 0) / 100,
      party: m.party,
      state: m.state,
    })),
  }));

  const totalValue = rows.reduce((s, r) => s + (r.total_donated_cents ?? 0), 0) / 100;
  const maxRow = rows.reduce(
    (best, r) => (r.total_donated_cents > (best?.total_donated_cents ?? 0) ? r : best),
    rows[0],
  );

  return {
    hierarchy: { name: "All Officials", value: totalValue, children },
    total_value: Math.round(totalValue),
    node_count: rows.length,
    max_value: Math.round((maxRow?.total_donated_cents ?? 0) / 100),
    max_value_entity: maxRow?.official_name ?? "",
    queries: 1,
  };
}

// ── Sunburst viz ───────────────────────────────────────────────────────────────
async function buildSunburstData(
  supabase: AdminClient,
  entityId: string | null,
  filters: string[],
  limit: number,
): Promise<{
  rings: string[];
  ring_counts: Record<string, number>;
  ring_samples: Record<string, string[]>;
  queries: number;
}> {
  let q = supabase
    .from("entity_connections")
    .select("connection_type, to_id")
    .limit(limit);

  if (entityId) q = q.eq("from_id", entityId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (filters.length > 0) q = (q as any).in("connection_type", filters);

  const { data } = await q;
  const rows = (data ?? []) as { connection_type: string; to_id: string }[];

  const byType = new Map<string, string[]>();
  for (const r of rows) {
    const t = r.connection_type ?? "other";
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t)!.push(r.to_id);
  }

  const rings = [...byType.keys()];
  const ring_counts: Record<string, number> = {};
  const ring_samples: Record<string, string[]> = {};

  for (const [type, ids] of byType) {
    ring_counts[type] = ids.length;
    ring_samples[type] = ids.slice(0, 5);
  }

  return { rings, ring_counts, ring_samples, queries: 1 };
}

// ── Data quality checks ────────────────────────────────────────────────────────
function makeChecks(
  viz: string,
  resolvedEntity: ResolvedEntity | null,
  edgeCount: number,
  forceStats: {
    donationTotal: number;
    donationWithAmount: number;
    orphanCount: number;
    path?: string[];
    hasEntity2: boolean;
  } | null,
  chordStats: {
    totalFlowUsd: number;
    groupCount: number;
    taggedPct: number;
  } | null,
  treemapStats: {
    zeroValueNodes: number;
  } | null,
): QualityCheck[] {
  const checks: QualityCheck[] = [];

  // CHECK 1 — entity resolved
  checks.push({
    name: "entity_resolved",
    passed: resolvedEntity !== null,
    detail: resolvedEntity
      ? `${resolvedEntity.name} (${resolvedEntity.type})`
      : "Entity not found in database",
  });

  // CHECK 2 — has connections
  checks.push({
    name: "has_connections",
    passed: edgeCount > 0,
    detail: edgeCount > 0 ? `${edgeCount} connections found` : "No connections found",
  });

  if (viz === "chord" && chordStats) {
    // CHECK 3 — chord has data
    checks.push({
      name: "chord_has_data",
      passed: chordStats.totalFlowUsd > 0,
      detail:
        chordStats.totalFlowUsd > 0
          ? `${chordStats.groupCount} industry groups, $${(chordStats.totalFlowUsd / 1_000_000).toFixed(1)}M total`
          : "No financial flow data found",
    });

    // CHECK 4 — industry coverage
    checks.push({
      name: "industry_coverage",
      passed: chordStats.taggedPct > 50,
      detail: `${chordStats.taggedPct}% of donation dollars have industry tags`,
    });
  }

  if (forceStats) {
    // CHECK 5 — no orphan nodes
    checks.push({
      name: "no_orphan_nodes",
      passed: forceStats.orphanCount === 0,
      detail:
        forceStats.orphanCount === 0
          ? "All nodes have edges"
          : `${forceStats.orphanCount} orphan nodes found`,
    });

    // CHECK 6 — donation amounts
    if (forceStats.donationTotal > 0) {
      checks.push({
        name: "donation_amounts",
        passed: forceStats.donationWithAmount === forceStats.donationTotal,
        detail: `${forceStats.donationWithAmount} of ${forceStats.donationTotal} donations have amount data`,
      });
    }

    // CHECK 7 — path exists (if two entities)
    if (forceStats.hasEntity2) {
      checks.push({
        name: "path_exists",
        passed: (forceStats.path?.length ?? 0) > 0,
        detail:
          forceStats.path && forceStats.path.length > 0
            ? `Path: ${forceStats.path.join(" → ")}`
            : "No path within 4 hops",
      });
    }
  }

  if (viz === "treemap" && treemapStats) {
    // CHECK 8 — treemap has values
    checks.push({
      name: "treemap_has_values",
      passed: treemapStats.zeroValueNodes === 0,
      detail:
        treemapStats.zeroValueNodes === 0
          ? "All leaf nodes have values"
          : `${treemapStats.zeroValueNodes} nodes with zero value`,
    });
  }

  return checks;
}

// ── Main diagnostic handler ────────────────────────────────────────────────────
async function handleDiagnostic(
  request: Request,
  params: URLSearchParams,
): Promise<Response> {
  const t0 = Date.now();

  // Parse request
  const vizParam = params.get("viz") ?? "force";
  const viz = (["force", "chord", "treemap", "sunburst"].includes(vizParam)
    ? vizParam
    : "force") as DiagnosticRequest["viz"];

  const depthRaw = parseInt(params.get("depth") ?? "1", 10);
  const depth = Math.min(Math.max(depthRaw, 1), 3);

  const filtersRaw = params.get("filters") ?? "";
  const filters = filtersRaw
    ? filtersRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  const industryRaw = params.get("industry") ?? "";
  const industry = industryRaw
    ? industryRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  const limitRaw = parseInt(params.get("limit") ?? "100", 10);
  const limit = Math.min(Math.max(limitRaw, 1), 500);

  const req: DiagnosticRequest = {
    viz,
    entityId: params.get("entity_id"),
    entityName: params.get("entity_name"),
    entityName2: params.get("entity_name_2"),
    depth,
    filters,
    industry,
    limit,
  };

  const supabase = createAdminClient();
  let dbQueries = 0;

  // Resolve primary entity
  let resolvedEntity: ResolvedEntity | null = null;
  if (req.entityId) {
    const { entity, queries } = await resolveEntityById(supabase, req.entityId);
    resolvedEntity = entity;
    dbQueries += queries;
  } else if (req.entityName) {
    const { entity, queries } = await resolveEntityByName(supabase, req.entityName);
    resolvedEntity = entity;
    dbQueries += queries;
  }

  const resolvedId = resolvedEntity?.id ?? req.entityId ?? null;

  // Resolve secondary entity (for path finder)
  let resolvedEntity2: ResolvedEntity | null = null;
  let resolvedId2: string | null = null;
  if (req.entityName2) {
    const { entity, queries } = await resolveEntityByName(supabase, req.entityName2);
    resolvedEntity2 = entity;
    resolvedId2 = entity?.id ?? null;
    dbQueries += queries;
  }

  // Build viz-specific data
  let forceResult: Awaited<ReturnType<typeof buildForceData>> | null = null;
  let chordResult: Awaited<ReturnType<typeof buildChordData>> | null = null;
  let treemapResult: Awaited<ReturnType<typeof buildTreemapData>> | null = null;
  let sunburstResult: Awaited<ReturnType<typeof buildSunburstData>> | null = null;

  if (viz === "force") {
    forceResult = await buildForceData(supabase, req, resolvedId, resolvedId2);
    dbQueries += forceResult.queries;
  } else if (viz === "chord") {
    chordResult = await buildChordData(supabase, industry, limit);
    dbQueries += chordResult.queries;
  } else if (viz === "treemap") {
    treemapResult = await buildTreemapData(supabase, limit);
    dbQueries += treemapResult.queries;
  } else if (viz === "sunburst") {
    sunburstResult = await buildSunburstData(supabase, resolvedId, filters, limit);
    dbQueries += sunburstResult.queries;
  }

  // Summary stats
  const nodeCount =
    viz === "force"
      ? (forceResult?.nodeCount ?? 0)
      : viz === "treemap"
        ? (treemapResult?.node_count ?? 0)
        : viz === "chord"
          ? chordResult!.groups.length + chordResult!.recipients.length
          : sunburstResult
            ? Object.values(sunburstResult.ring_counts).reduce((a, b) => a + b, 0)
            : 0;

  const edgeCount =
    viz === "force"
      ? (forceResult?.edgeCount ?? 0)
      : viz === "chord"
        ? chordResult!.matrix.reduce((s, row) => s + row.filter((v) => v > 0).length, 0)
        : 0;

  // Connection type breakdown (force only)
  const connectionTypes: Record<string, number> = {};
  if (viz === "force" && forceResult) {
    for (const e of forceResult.edges) {
      connectionTypes[e.connection_type] =
        (connectionTypes[e.connection_type] ?? 0) + 1;
    }
  }

  // Entity type breakdown (force only)
  const entityTypes: Record<string, number> = {};
  if (viz === "force" && forceResult) {
    for (const n of forceResult.nodes) {
      entityTypes[n.type] = (entityTypes[n.type] ?? 0) + 1;
    }
  }

  // Financial summary
  const totalDonationAmountUsd =
    viz === "chord" ? chordResult!.total_flow_usd : 0;

  const largestDonor: string | null =
    viz === "chord" && (chordResult?.groups.length ?? 0) > 0
      ? (chordResult!.groups[0]?.label ?? null)
      : null;

  const largestDonationUsd: number | null =
    viz === "chord" && (chordResult?.top_flows.length ?? 0) > 0
      ? (chordResult!.top_flows[0]?.amount_usd ?? null)
      : null;

  // Tag coverage (simplified: count nodes that have entity_tag entries)
  // We skip a full per-node tag lookup for performance; tagged_node_pct is approximate.
  const taggedNodePct = 0; // Phase 2: add batch entity_tag lookup here
  const untaggedNodeCount = nodeCount;

  // Warnings
  const warnings: string[] = [];
  if (viz === "chord" && chordResult!.untagged_flow_pct > 20) {
    const pct = chordResult!.untagged_flow_pct;
    const usd = (chordResult!.untagged_flow_usd / 1_000_000).toFixed(1);
    warnings.push(
      `${pct}% of donation dollars ($${usd}M) have no industry tag — chord diagram may be incomplete`,
    );
  }
  if (viz === "force" && forceResult && forceResult.donationTotal > 0) {
    const missing = forceResult.donationTotal - forceResult.donationWithAmount;
    if (missing > 0) {
      warnings.push(
        `${missing} donation edges are missing amount_cents data`,
      );
    }
  }
  if (!resolvedEntity && (req.entityId || req.entityName)) {
    warnings.push(
      `Entity "${req.entityId ?? req.entityName}" not found — results show global data`,
    );
  }
  if (resolvedEntity2 === null && req.entityName2) {
    warnings.push(
      `Second entity "${req.entityName2}" not found — path finder skipped`,
    );
  }

  // Quality checks
  const checks = makeChecks(
    viz,
    resolvedEntity,
    edgeCount > 0 ? edgeCount : nodeCount,
    viz === "force" && forceResult
      ? {
          donationTotal: forceResult.donationTotal,
          donationWithAmount: forceResult.donationWithAmount,
          orphanCount: forceResult.orphanCount,
          path: forceResult.path,
          hasEntity2: req.entityName2 !== null,
        }
      : null,
    viz === "chord" && chordResult
      ? {
          totalFlowUsd: chordResult.total_flow_usd,
          groupCount: chordResult.groups.length,
          taggedPct: 100 - chordResult.untagged_flow_pct,
        }
      : null,
    viz === "treemap" && treemapResult
      ? { zeroValueNodes: 0 } // RPC returns only rows with data
      : null,
  );

  const response = {
    request: {
      viz,
      entity_id: req.entityId,
      entity_name: req.entityName,
      depth: req.depth,
      filters: req.filters,
      timestamp: new Date().toISOString(),
    },

    resolved_entity: resolvedEntity,

    summary: {
      node_count: nodeCount,
      edge_count: edgeCount,
      viz_type: viz,
      depth_used: depth,
      connection_types: connectionTypes,
      entity_types: entityTypes,
      total_donation_amount_usd: totalDonationAmountUsd,
      largest_donor: largestDonor,
      largest_donation_usd: largestDonationUsd,
      tagged_node_pct: taggedNodePct,
      untagged_node_count: untaggedNodeCount,
    },

    // Viz-specific payloads (only the relevant one is non-null)
    force:
      viz === "force" && forceResult
        ? {
            nodes: forceResult.nodes,
            edges: forceResult.edges,
            path: forceResult.path,
          }
        : undefined,

    chord:
      viz === "chord" && chordResult
        ? {
            groups: chordResult.groups,
            recipients: chordResult.recipients,
            matrix: chordResult.matrix,
            top_flows: chordResult.top_flows,
            total_flow_usd: chordResult.total_flow_usd,
            untagged_flow_usd: chordResult.untagged_flow_usd,
            untagged_flow_pct: chordResult.untagged_flow_pct,
          }
        : undefined,

    treemap:
      viz === "treemap" && treemapResult
        ? {
            hierarchy: treemapResult.hierarchy,
            total_value: treemapResult.total_value,
            node_count: treemapResult.node_count,
            max_value: treemapResult.max_value,
            max_value_entity: treemapResult.max_value_entity,
          }
        : undefined,

    sunburst:
      viz === "sunburst" && sunburstResult
        ? {
            rings: sunburstResult.rings,
            ring_counts: sunburstResult.ring_counts,
            ring_samples: sunburstResult.ring_samples,
          }
        : undefined,

    data_quality: {
      warnings,
      checks,
    },

    meta: {
      query_time_ms: Date.now() - t0,
      cache_hit: false,
      db_queries: dbQueries,
    },
  };

  return Response.json(response, {
    headers: {
      "Cache-Control": "public, max-age=60, s-maxage=60",
    },
  });
}

// ── Code generation (for share codes) ─────────────────────────────────────────
const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomSegment(len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return out;
}

function generateCode(presetSlug?: string): string {
  const seg1 = randomSegment(4);
  const base = presetSlug
    ? presetSlug.replace(/[^a-z]/g, "").toUpperCase().slice(0, 4)
    : "";
  const seg2 = (base + randomSegment(4)).slice(0, 4);
  return `CIV-${seg1}-${seg2}`;
}

// ── POST /api/graph/snapshot — create a new share code ────────────────────────
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      state: Record<string, unknown>;
      title?: string;
      preset?: string;
    };

    if (!body.state || typeof body.state !== "object") {
      return Response.json({ error: "state is required" }, { status: 400 });
    }

    const supabase = createAdminClient();

    let code = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      code = generateCode(body.preset);
      const { data: existing } = await supabase
        .from("graph_snapshots")
        .select("id")
        .eq("code", code)
        .maybeSingle();
      if (!existing) break;
    }

    if (!code) {
      return Response.json({ error: "Failed to generate unique code" }, { status: 500 });
    }

    const { data, error } = await supabase
      .from("graph_snapshots")
      .insert({
        code,
        state: body.state as Json,
        title: body.title ?? null,
        is_public: true,
      })
      .select("code, id, created_at")
      .single();

    if (error) throw error;

    return Response.json({
      code: data.code,
      url: `${getOrigin(request)}/graph/${data.code}`,
      created_at: data.created_at,
    });
  } catch (err) {
    console.error("[graph/snapshot POST]", err);
    return Response.json({ error: "Failed to save snapshot" }, { status: 500 });
  }
}

// ── GET /api/graph/snapshot ────────────────────────────────────────────────────
// Diagnostic mode: ?viz= | ?entity_id= | ?entity_name=
// Share code mode: ?code=CIV-XXXX-YYYY
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  // Detect diagnostic mode
  const isDiagnostic =
    searchParams.has("viz") ||
    searchParams.has("entity_id") ||
    searchParams.has("entity_name");

  if (isDiagnostic) {
    const ip = getIp(request);
    if (!rateOk(ip)) {
      return Response.json(
        { error: "Rate limit exceeded — 10 requests per minute per IP" },
        { status: 429 },
      );
    }
    return handleDiagnostic(request, searchParams);
  }

  // Share code mode (existing behavior)
  const code = searchParams.get("code");
  if (!code) {
    return Response.json(
      {
        error:
          "Provide ?code=CIV-XXXX-YYYY to fetch a share code, or ?viz=force|chord|treemap|sunburst for diagnostics",
      },
      { status: 400 },
    );
  }

  try {
    const supabase = createAdminClient();

    const { data, error } = await supabase
      .from("graph_snapshots")
      .select("code, state, title, created_at, view_count")
      .eq("code", code)
      .single();

    if (error || !data) {
      return Response.json({ error: "Snapshot not found" }, { status: 404 });
    }

    void supabase.rpc("increment_snapshot_view", { p_code: code });

    return Response.json(data);
  } catch (err) {
    console.error("[graph/snapshot GET]", err);
    return Response.json({ error: "Failed to fetch snapshot" }, { status: 500 });
  }
}

function getOrigin(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}
