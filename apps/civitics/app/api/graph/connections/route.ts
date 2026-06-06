export const revalidate = 60; // Graph connections cached 1 minute at edge

import { createAdminClient } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse, withDbTimeout } from "@/lib/supabase-check";
import type { Database } from "@civitics/db";
import type { GraphEdgeV2 as GraphEdge, GraphNodeV2 as GraphNode, EdgeType, NodeTypeV2 as NodeType, IndividualDisplayMode } from "@civitics/graph";
import { BRACKET_TIERS } from "@civitics/graph";

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

// PostgREST hard row cap (supabase/config.toml db-max-rows). A single .select()
// — even with .limit(N) for N>1000 — never returns more than this, so any load
// that consumes its result as the complete set silently truncates past it (FIX-428).
const MAX_ROWS = 1000;

/**
 * Page through a row-capped PostgREST query so the full set is assembled rather
 * than silently truncated at MAX_ROWS (FIX-428). `build(from, to)` must return a
 * fresh query with `.range(from, to)` applied.
 *
 * Returns the accumulated rows plus an `error` (propagated from the first failing
 * page — never swallowed, FIX-431) and a `truncated` flag set when an optional
 * `maxRows` safety ceiling was reached before exhaustion.
 */
async function fetchAllPaged<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  opts: { maxRows?: number } = {},
): Promise<{ rows: T[]; error: { message: string } | null; truncated: boolean }> {
  const ceiling = opts.maxRows ?? Number.POSITIVE_INFINITY;
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await build(from, from + MAX_ROWS - 1);
    if (error) return { rows, error, truncated: false };
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < MAX_ROWS) break;        // last (short) page → exhausted
    from += MAX_ROWS;
    if (rows.length >= ceiling) return { rows, error: null, truncated: true };
  }
  return { rows, error: null, truncated: false };
}

// ── Individual-donor aggregation helpers (FIX-194) ────────────────────────────

/** Normalize FEC employer strings for grouping. "GOLDMAN SACHS & CO" → "GOLDMAN SACHS". */
const LEGAL_SUFFIX_RE = /\b(incorporated|inc|llc|corp|corporation|l\.l\.c|co|company|the|plc|ltd|limited|lp|l\.p)\b\.?/gi;

function normalizeEmployer(raw: string): string {
  return raw
    .toUpperCase()
    .replace(LEGAL_SUFFIX_RE, '')
    .replace(/[^\w\s]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Log-scale donation strength identical to the rebuild function's formula. */
function logScaleDonation(cents: number): number {
  return Math.min(0.999, Math.max(0.001, Math.log10(Math.max(cents / 100, 1)) / 8));
}

/** Map DB entity type string → GraphNode type */
function mapNodeType(dbType: string, subType?: string): NodeType {
  switch (dbType) {
    case "official": return "official";
    case "agency": return "agency";
    case "governing_body": return "agency";
    case "proposal": return "proposal";
    case "initiative": return "initiative";
    case "financial":
    case "financial_entity": {
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
    "contract_award",
  ];
  if (valid.includes(dbType as EdgeType)) return dbType as EdgeType;
  switch (dbType) {
    case "business_partner": return "oversight";
    case "endorsement": return "oversight";
    case "family": return "appointment";
    case "legal_representation": return "oversight";
    default: return "oversight";
  }
}

/**
 * FIX-125: drop vote-type connections whose underlying votes are all procedural.
 *
 * The connections pipeline already skips procedural votes at derivation
 * (voteToConnectionType returns null), so most entity_connections rows are clean.
 * This runtime filter handles legacy rows derived before the procedural skip
 * was tightened, and lets the pipeline's procedural list grow without a re-run.
 *
 * For each vote-type connection (official ↔ proposal), look up the underlying
 * votes by (official_id, proposal_id) and drop the connection only if every
 * matching vote has a procedural vote_question. Connections with no matching
 * vote rows are kept (trust the existing edge).
 */
const PROCEDURAL_PREFIXES = [
  "on the cloture motion",
  "on the motion to proceed",
  "on the motion to table",
  "on the motion to recommit",
  "on ordering the previous question",
  "on agreeing to the amendment",
  "on the conference report",
  "on the joint resolution",
  "on the resolution",
  "on the motion",
];

const VOTE_CONN_TYPES = new Set([
  "vote_yes", "vote_no", "vote_abstain",
  "nomination_vote_yes", "nomination_vote_no",
]);

async function filterProceduralConnections(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  connections: ConnectionRow[],
): Promise<ConnectionRow[]> {
  const voteConns = connections.filter(c => VOTE_CONN_TYPES.has(c.connection_type));
  if (voteConns.length === 0) return connections;

  const officialIds = new Set<string>();
  const proposalIds = new Set<string>();
  for (const c of voteConns) {
    const officialId = c.from_type === "official" ? c.from_id : c.to_id;
    const proposalId = c.from_type === "proposal" ? c.from_id : c.to_id;
    officialIds.add(officialId);
    proposalIds.add(proposalId);
  }

  const { data: votes, error } = await supabase
    .from("votes")
    .select("official_id, bill_proposal_id, vote_question")
    .in("official_id", [...officialIds])
    .in("bill_proposal_id", [...proposalIds]);

  if (error || !votes) return connections; // fail open — never hide data on lookup error

  // For each (official, proposal) pair: true if at least one non-procedural vote exists,
  // false if we saw votes but they were all procedural, missing if no votes were found.
  const hasSubstantive = new Map<string, boolean>();
  // vote_question is a first-class votes column (NOT metadata->>'vote_question').
  // Reading it off metadata returned undefined for every row, so the procedural
  // filter failed open and treated every vote as substantive.
  for (const v of votes as { official_id: string; bill_proposal_id: string; vote_question: string | null }[]) {
    const key = `${v.official_id}|${v.bill_proposal_id}`;
    const q = String(v.vote_question ?? "").toLowerCase();
    const isProcedural = PROCEDURAL_PREFIXES.some(p => q.startsWith(p));
    if (!isProcedural) hasSubstantive.set(key, true);
    else if (!hasSubstantive.has(key)) hasSubstantive.set(key, false);
  }

  return connections.filter(c => {
    if (!VOTE_CONN_TYPES.has(c.connection_type)) return true;
    const officialId = c.from_type === "official" ? c.from_id : c.to_id;
    const proposalId = c.from_type === "proposal" ? c.from_id : c.to_id;
    const flag = hasSubstantive.get(`${officialId}|${proposalId}`);
    // missing → no vote rows found, keep edge; false → all procedural, drop; true → keep
    return flag !== false;
  });
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
  // Individual donor display mode (FIX-194).
  // 'bracket'   = aggregate into 4 tier nodes per official (default)
  // 'connector' = real nodes for donors giving to 2+ officials; rest → brackets
  // 'employer'  = synthetic employer-group nodes per official
  // 'off'       = pass all individuals through as real nodes (researcher mode)
  const individualMode = (searchParams.get("individualMode") ?? "bracket") as IndividualDisplayMode;
  const connectorMin = Math.max(2, parseInt(searchParams.get("connectorMin") ?? "2", 10));

  try {
    const supabase = createAdminClient();

    let connections: ConnectionRow[] = [];
    let totalCount = 0;
    // Set when an edge-hydration load was capped at a safety ceiling — surfaced to
    // the client so a truncated graph is honest rather than silently incomplete (FIX-428).
    let partial = false;

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
      const OVERSIGHT_TYPES = ["oversight", "appointment", "co_sponsorship", "revolving_door", "contract_award"] as const;

      const [donationsRes, votesRes, oversightRes] = await Promise.all([
        withDbTimeout(
          supabase
            .from("entity_connections")
            .select("*")
            .eq("connection_type", "donation")
            .or(`from_id.eq.${entityId},to_id.eq.${entityId}`)
        ),
        withDbTimeout(
          supabase
            .from("entity_connections")
            .select("*")
            .in("connection_type", VOTE_TYPES)
            .or(`from_id.eq.${entityId},to_id.eq.${entityId}`)
            .order("occurred_at", { ascending: false, nullsFirst: false })
            .limit(50)
        ),
        withDbTimeout(
          supabase
            .from("entity_connections")
            .select("*")
            .in("connection_type", OVERSIGHT_TYPES)
            .or(`from_id.eq.${entityId},to_id.eq.${entityId}`)
        ),
      ]);

      // Check every edge-type result, not just donations — a votes/oversight
      // timeout was previously merged blind, silently dropping those edge types
      // and presenting a partial graph as complete (FIX-431). Fail loud instead.
      if (donationsRes.error) throw donationsRes.error;
      if (votesRes.error) throw votesRes.error;
      if (oversightRes.error) throw oversightRes.error;
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

        // Count how many connections each neighbor has (to decide auto-expand vs. collapsed).
        // Paginate the full set: an unbounded .select() caps at MAX_ROWS, so a neighbor
        // whose rows fell past the cap was undercounted to 0 → wrongly auto-expanded (FIX-428).
        // Single-column projections keep the egress small even for high-degree neighbors.
        // FIX-503: count neighbor degrees with the get_connection_counts RPC
        // (from+to UNION ALL GROUP BY, server-side) instead of two fully-
        // paginated entity_connections scans pulled to the client. The old
        // approach moved every edge row of every neighbor over the wire and
        // churned the buffer pool; the RPC returns one count per id. Chunk the
        // uuid[] arg so a wide neighbor set stays bounded.
        const neighborConnCounts = new Map<string, number>();
        const RPC_CHUNK = 500;
        for (let i = 0; i < neighborIds.length; i += RPC_CHUNK) {
          const chunk = neighborIds.slice(i, i + RPC_CHUNK);
          const { data, error } = await supabase.rpc("get_connection_counts", { entity_ids: chunk });
          if (error) throw error;
          for (const r of (data ?? []) as Array<{ entity_id: string; connection_count: number | string }>) {
            neighborConnCounts.set(r.entity_id, Number(r.connection_count));
          }
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
          // Paginate the expansion edges — the neighbors here each have < MAX_AUTO_EXPAND
          // connections, but their sum can exceed MAX_ROWS, so an unbounded load dropped
          // edges past the cap from the rendered graph with HTTP 200 (FIX-428).
          const [expandFromRes, expandToRes] = await Promise.all([
            fetchAllPaged<ConnectionRow>((f, t) =>
              supabase.from("entity_connections").select("*").in("from_id", autoExpandIds).range(f, t)),
            fetchAllPaged<ConnectionRow>((f, t) =>
              supabase.from("entity_connections").select("*").in("to_id", autoExpandIds).range(f, t)),
          ]);
          if (expandFromRes.error) throw expandFromRes.error;
          if (expandToRes.error) throw expandToRes.error;
          const connMap = new Map<string, ConnectionRow>();
          for (const c of [...direct, ...expandFromRes.rows, ...expandToRes.rows]) {
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
      // Use a HEAD request for the total count (no rows transferred), then
      // two small targeted queries (officials only, capped at 3 000 each)
      // to find the top 10 by connection frequency.
      // Previously fetched all 143 k rows client-side — ~100× egress reduction.
      // QWEN-ADDED: Add generic type to withDbTimeout for count-only HEAD query
      const { count, error: countErr } = await withDbTimeout<{
        count: number | null;
        error: { message: string } | null;
      }>(
        supabase
          .from("entity_connections")
          .select("*", { count: "exact", head: true })
      );

      if (countErr) throw countErr;
      totalCount = count ?? 0;

      if (totalCount === 0) {
        return Response.json({ nodes: [], edges: [], count: 0 });
      }

      // FIX-476 — true top-10 by degree via a GROUP BY RPC. The prior approach
      // (two `.limit(3000)` selects, no ORDER BY) was silently capped to 1000 by
      // PostgREST max_rows, so the "top 10" came from an arbitrary slice of the
      // ~143k-row table. RPCs aren't row-capped. Fall back to the old capped
      // sample if the RPC is unavailable (e.g. prod schema-cache cold-start).
      let top10Ids: string[] = [];
      const topRes = await supabase.rpc("get_top_connected_officials", { p_limit: 10 });
      if (!topRes.error && Array.isArray(topRes.data) && topRes.data.length > 0) {
        top10Ids = topRes.data.map((r) => r.entity_id);
      } else {
        if (topRes.error) {
          console.warn("[graph/connections] get_top_connected_officials unavailable, falling back to capped sample:", topRes.error.message);
        }
        const [fromRes, toRes] = await Promise.all([
          supabase.from("entity_connections").select("from_id").eq("from_type", "official").limit(1000),
          supabase.from("entity_connections").select("to_id").eq("to_type", "official").limit(1000),
        ]);
        const officialCounts = new Map<string, number>();
        for (const r of fromRes.data ?? []) {
          officialCounts.set(r.from_id, (officialCounts.get(r.from_id) ?? 0) + 1);
        }
        for (const r of toRes.data ?? []) {
          officialCounts.set(r.to_id, (officialCounts.get(r.to_id) ?? 0) + 1);
        }
        top10Ids = [...officialCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([id]) => id);
      }

      if (top10Ids.length === 0) {
        return Response.json({ nodes: [], edges: [], count: totalCount });
      }

      // Top-10 officials are the highest-degree nodes, so this is the egress-sensitive
      // path the default view is designed to keep small. Cap each direction at a safety
      // ceiling and signal `partial` when truncated, rather than silently dropping edges
      // past MAX_ROWS (the prior unbounded load) or fetching the whole table (FIX-428).
      const TOP10_EDGE_CEILING = MAX_ROWS * 5;
      const [expandFromRes, expandToRes] = await Promise.all([
        fetchAllPaged<ConnectionRow>((f, t) =>
          supabase.from("entity_connections").select("*").in("from_id", top10Ids).range(f, t),
          { maxRows: TOP10_EDGE_CEILING }),
        fetchAllPaged<ConnectionRow>((f, t) =>
          supabase.from("entity_connections").select("*").in("to_id", top10Ids).range(f, t),
          { maxRows: TOP10_EDGE_CEILING }),
      ]);
      if (expandFromRes.error) throw expandFromRes.error;
      if (expandToRes.error) throw expandToRes.error;
      if (expandFromRes.truncated || expandToRes.truncated) partial = true;

      const connMap = new Map<string, ConnectionRow>();
      for (const c of [...expandFromRes.rows, ...expandToRes.rows]) {
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
    const financialIds = entities.filter((e) => e.type === "financial_entity").map((e) => e.id);

    // ── Batch-fetch names in parallel ──────────────────────────────────────
    // FIX-123: bill_number lives in `bill_details` (one-to-one with proposals)
    // post-cutover, so it's a separate fetch keyed on proposal_id.
    // Financial entities can number in the thousands (e.g. Sanders ~5k individual donors).
    // PostgREST sends IN filters as query-string params; at >~500 UUIDs the URL exceeds
    // nginx's header buffer limit and the query silently returns empty. Chunk to 500.
    type FinRow = { id: string; display_name: string; entity_type: string; recipient_count?: number; metadata?: Record<string, unknown> | null };
    const FIN_CHUNK = 500;
    const financialData: FinRow[] = [];
    if (financialIds.length > 0) {
      const finSelect = individualMode === 'employer'
        ? "id, display_name, entity_type, recipient_count, metadata"
        : "id, display_name, entity_type, recipient_count";
      const finChunks: string[][] = [];
      for (let i = 0; i < financialIds.length; i += FIN_CHUNK) {
        finChunks.push(financialIds.slice(i, i + FIN_CHUNK));
      }
      const finResults = await Promise.all(
        finChunks.map(ids => withDbTimeout(supabase.from("financial_entities").select(finSelect).in("id", ids)))
      );
      for (const r of finResults) {
        // A timed-out/errored chunk previously fell through `data ?? []`, silently
        // dropping those entities' names so their nodes rendered as "Unknown" with
        // HTTP 200. Fail loud instead (FIX-431).
        if (r.error) throw r.error;
        financialData.push(...((r.data ?? []) as unknown as FinRow[]));
      }
    }

    const [officialsRes, agenciesRes, proposalsRes, billDetailsRes, gbRes] = await Promise.all([
      officialIds.length
        ? supabase.from("officials").select("id, full_name, party").in("id", officialIds)
        : Promise.resolve({ data: [] as { id: string; full_name: string; party: string | null }[] }),
      agencyIds.length
        ? supabase.from("agencies").select("id, name, acronym").in("id", agencyIds)
        : Promise.resolve({ data: [] as { id: string; name: string; acronym: string | null }[] }),
      proposalIds.length
        ? supabase.from("proposals").select("id, title").in("id", proposalIds)
        : Promise.resolve({ data: [] as { id: string; title: string }[] }),
      proposalIds.length
        ? supabase.from("bill_details").select("proposal_id, bill_number").in("proposal_id", proposalIds)
        : Promise.resolve({ data: [] as { proposal_id: string; bill_number: string }[] }),
      gbIds.length
        ? supabase.from("governing_bodies").select("id, name").in("id", gbIds)
        : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    ]);

    const billNumberByProposal = new Map<string, string>();
    for (const b of billDetailsRes.data ?? []) {
      if (b.bill_number) billNumberByProposal.set(b.proposal_id, b.bill_number);
    }

    // ── Build name lookup ───────────────────────────────────────────────────
    const nameMap = new Map<string, { label: string; party?: string; subType?: string; role?: string }>();
    for (const o of officialsRes.data ?? []) nameMap.set(o.id, { label: o.full_name, party: o.party ?? undefined });
    for (const a of agenciesRes.data ?? []) nameMap.set(a.id, { label: a.acronym ?? a.name });
    for (const p of proposalsRes.data ?? []) {
      // FIX-123: bill_number ("HR 1234") goes into role so the tooltip subtitle
      // shows it. Title stays as the primary name. If title is missing, fall
      // back to bill_number rather than rendering blank.
      const billNumber = billNumberByProposal.get(p.id);
      nameMap.set(p.id, {
        label: p.title || billNumber || "Untitled bill",
        role: billNumber,
      });
    }
    for (const g of gbRes.data ?? []) nameMap.set(g.id, { label: g.name });

    // Track individual-donor extra data for bracket/employer aggregation (FIX-194)
    const individualMeta = new Map<string, { recipientCount: number; employer?: string }>();
    for (const f of financialData) {
      nameMap.set(f.id, { label: f.display_name, subType: f.entity_type });
      if (f.entity_type === 'individual') {
        const meta = f.metadata as Record<string, string> | null;
        individualMeta.set(f.id, {
          recipientCount: f.recipient_count ?? 0,
          employer: meta?.employer ?? undefined,
        });
      }
    }

    // ── Individual-donor bracket/employer aggregation (FIX-194) ──────────────
    // Replaces per-individual nodes+edges with synthetic aggregate nodes when
    // individualMode !== 'off'. Keeps the graph renderable for high-donor officials
    // (e.g. Sanders ~975 individual donors at depth 1).
    type BucketKey = string; // "bracket:{officialId}:{tierId}" or "employer:{officialId}:{normalized}"
    const skipEntityKeys = new Set<string>();
    const skipConnectionIds = new Set<string>();
    const bracketNodes: GraphNode[] = [];
    const bracketEdges: GraphEdge[] = [];

    if (individualMode !== 'off' && individualMeta.size > 0) {
      const buckets = new Map<BucketKey, {
        totalCents: number;
        donorCount: number;
        officialId: string;
        tier?: string;
        employer?: string;
      }>();

      for (const c of connections) {
        if (c.connection_type !== 'donation') continue;
        if (c.from_type !== 'financial_entity') continue;
        const meta = individualMeta.get(c.from_id);
        if (!meta) continue; // not an individual donor

        // Connector mode: pass through donors who donated to enough officials
        if (individualMode === 'connector' && meta.recipientCount >= connectorMin) continue;

        // Mark for exclusion from normal node/edge paths
        skipEntityKeys.add(`financial_entity:${c.from_id}`);
        skipConnectionIds.add(c.id);

        const officialId = c.to_id;
        const amountCents = c.amount_cents ?? 0;

        if (individualMode === 'employer') {
          const rawEmployer = meta.employer ?? '';
          const normalized = rawEmployer ? normalizeEmployer(rawEmployer) : '';
          const employerKey = normalized || 'UNAFFILIATED';
          const bucketKey: BucketKey = `employer:${officialId}:${employerKey}`;
          const existing = buckets.get(bucketKey);
          if (existing) {
            existing.totalCents += amountCents;
            existing.donorCount += 1;
          } else {
            buckets.set(bucketKey, { totalCents: amountCents, donorCount: 1, officialId, employer: employerKey });
          }
        } else {
          // bracket + connector modes: aggregate non-connector donors into tiers
          const tier = BRACKET_TIERS.find(t =>
            amountCents >= t.minCents && (t.maxCents === null || amountCents <= t.maxCents)
          );
          if (!tier) continue; // below FEC itemization threshold — skip
          const bucketKey: BucketKey = `bracket:${officialId}:${tier.id}`;
          const existing = buckets.get(bucketKey);
          if (existing) {
            existing.totalCents += amountCents;
            existing.donorCount += 1;
          } else {
            buckets.set(bucketKey, { totalCents: amountCents, donorCount: 1, officialId, tier: tier.id });
          }
        }
      }

      for (const [bucketKey, bucket] of buckets) {
        const officialNodeId = `official:${bucket.officialId}`;

        if (individualMode === 'employer') {
          const displayName = bucket.employer === 'UNAFFILIATED'
            ? 'Unaffiliated'
            : bucket.employer!;
          bracketNodes.push({
            id: bucketKey,
            type: 'individual_bracket',
            name: displayName,
            connectionCount: bucket.donorCount,
            donationTotal: bucket.totalCents,
            metadata: {
              isEmployerNode: true,
              employer: bucket.employer,
              donorCount: bucket.donorCount,
              officialId: bucket.officialId,
            },
          });
        } else {
          const tier = BRACKET_TIERS.find(t => t.id === bucket.tier)!;
          bracketNodes.push({
            id: bucketKey,
            type: 'individual_bracket',
            name: `${tier.shortLabel} Donors`,
            connectionCount: bucket.donorCount,
            donationTotal: bucket.totalCents,
            metadata: {
              isBracketNode: true,
              tier: tier.id,
              donorCount: bucket.donorCount,
              officialId: bucket.officialId,
            },
          });
        }

        bracketEdges.push({
          fromId: bucketKey,
          toId: officialNodeId,
          connectionType: 'donation',
          amountUsd: bucket.totalCents / 100,
          strength: logScaleDonation(bucket.totalCents),
          metadata: {
            isBracketEdge: true,
            tier: bucket.tier,
            employer: bucket.employer,
            donorCount: bucket.donorCount,
          },
        });
      }
    }

    // ── Pre-compute per-financial-entity donation totals (cents) ──────────
    // Used to populate donationTotal on PAC/corporation/individual nodes so
    // the tooltip can show total donations given to officials in this graph.
    const financialDonationTotals = new Map<string, number>();
    for (const c of connections) {
      if (c.connection_type !== 'donation') continue;
      if (c.from_type !== 'financial_entity') continue;
      if (skipConnectionIds.has(c.id)) continue; // aggregated into bracket
      financialDonationTotals.set(
        c.from_id,
        (financialDonationTotals.get(c.from_id) ?? 0) + (c.amount_cents ?? 0),
      );
    }

    // ── Build nodes ────────────────────────────────────────────────────────
    const nodes: GraphNode[] = [];
    for (const [key, { type, id }] of entityMap) {
      // Individual-donor entities that were aggregated into bracket/employer nodes
      // are excluded here — they'll appear via bracketNodes instead.
      if (skipEntityKeys.has(key)) continue;
      const info = nameMap.get(id) ?? { label: `Unknown ${type}` };
      const isCollapsed = collapsedNodes.has(id);
      const donationTotalCents = type === 'financial_entity' ? financialDonationTotals.get(id) : undefined;
      nodes.push({
        id: key,
        type: mapNodeType(type, info.subType),
        name: info.label,
        party: info.party as GraphNode["party"],
        ...(info.role ? { role: info.role } : {}),
        ...(donationTotalCents != null ? { donationTotal: donationTotalCents } : {}),
        ...(isCollapsed
          ? { collapsed: true, connectionCount: collapsedNodes.get(id) }
          : {}),
      });
    }
    // Append synthetic bracket/employer aggregate nodes
    nodes.push(...bracketNodes);

    const nodeIds = new Set(nodes.map((n) => n.id));

    // ── Build edges ────────────────────────────────────────────────────────
    const edges: GraphEdge[] = [];
    for (const c of connections) {
      // Skip individual-donor donation connections that were aggregated into bracket edges
      if (skipConnectionIds.has(c.id)) continue;
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
    // Append synthetic bracket/employer aggregate edges (official endpoints guaranteed in nodeIds)
    edges.push(...bracketEdges);

    return Response.json({ nodes, edges, count: totalCount, ...(partial ? { partial: true } : {}) });
  } catch (err) {
    console.error("[graph/connections]", err);
    return Response.json({ error: "Failed to load graph data" }, { status: 500 });
  }
}
