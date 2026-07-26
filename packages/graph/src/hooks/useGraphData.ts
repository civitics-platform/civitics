"use client";

/**
 * packages/graph/src/hooks/useGraphData.ts
 *
 * Manages node/edge data for the graph, merging data for multiple focused
 * entities. Fetches data for newly added entities and removes data for
 * removed entities without reloading the whole graph.
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type { GraphView, ForceOptions } from '../types';
import type { FocusEntity, FocusGroup } from '../types';
import { isFocusEntity, isFocusGroup } from '../types';
import type { GraphNode, GraphEdge } from '../types';
import { isFocusNode } from '../nodeId';
import { graphGroupParams } from '../groupQuery';
import {
  VOTE_CONNECTION_TYPES,
  DEFAULT_DONATION_LIMIT,
  DEFAULT_VOTES_LIMIT,
} from '../connections';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const edgeKey = (e: GraphEdge) => `${e.fromId}:${e.toId}:${e.connectionType}`;

/**
 * FIX-851 — field-wise node merge. Per-response node payloads are computed
 * relative to the REQUESTED focus, so a last-write-wins `Map.set` let a later
 * focus clobber an earlier one's fields — adding Trump (whose response carries
 * FFPAC opposition-scoped with NO donationTotal) erased Kamala's $498M FFPAC
 * total. Merge so the derived fields are invariant to fetch order:
 *   - donationTotal: max of the two — a scope that omits it (opposition-only)
 *     never zeroes a real total from another scope.
 *   - collapsed: only if BOTH scopes saw it collapsed (an expanded scope wins).
 *   - connectionCount: the larger known degree.
 * Every other field takes the incoming value when present (the server omits
 * undefined keys via conditional spread, so `{...prev, ...incoming}` keeps
 * prev's value where incoming is silent).
 */
function mergeNode(prev: GraphNode, incoming: GraphNode): GraphNode {
  const merged: GraphNode = { ...prev, ...incoming };
  const dt = Math.max(prev.donationTotal ?? 0, incoming.donationTotal ?? 0);
  if (dt > 0) merged.donationTotal = dt;
  else delete (merged as { donationTotal?: number }).donationTotal;
  if (prev.collapsed && incoming.collapsed) merged.collapsed = true;
  else delete (merged as { collapsed?: boolean }).collapsed;
  const cc = Math.max(prev.connectionCount ?? 0, incoming.connectionCount ?? 0);
  if (cc > 0) merged.connectionCount = cc;
  else delete (merged as { connectionCount?: number }).connectionCount;
  return merged;
}

export interface GraphMeta {
  /** Connection types present with counts and total amounts */
  connectionTypes: Record<string, { count: number; totalAmount: number }>;
  /** Entity types present in the graph */
  entityTypes: Set<string>;
  hasVotes: boolean;
  hasDonations: boolean;
  hasOversight: boolean;
  hasNominations: boolean;
  hasGroups: boolean;
  /** Is any focused entity a PAC group? */
  isPacFocus: boolean;
}

export function useGraphData(
  focus: GraphView['focus'],
  connections: GraphView['connections'],
  forceOptions?: Pick<ForceOptions, 'individualDisplayMode' | 'connectorMinRecipients'>,
  // FIX-498 — fired when a group fetch returns a server-resolved name that
  // differs from the client-side one (gb groups resolve their real name on the
  // route). The caller decides whether/which groups to patch — e.g. GraphPage
  // applies it only to synthetic `group-gb-*` handoff placeholders.
  onGroupResolved?: (groupId: string, resolvedName: string) => void
) {
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingEntityId, setLoadingEntityId] = useState<string | null>(null);
  // FIX-852 — the connections route emits meta.depth2Truncated (a depth-2
  // budget/read trip) and `partial` (an edge-hydration ceiling) that NOTHING
  // consumed. Accumulate them across the loaded focus set (reset on full
  // refetch / empty) so GraphPage can show an honest "graph may be incomplete"
  // badge instead of silently presenting truncated data as complete.
  const [dataTruncation, setDataTruncation] = useState<{ depth2Truncated: boolean; partial: boolean }>({
    depth2Truncated: false,
    partial: false,
  });

  // FIX-827 — incremental expansion state. Fresh refs mirror nodes/edges so the
  // async expand/collapse handlers diff against the latest committed set without
  // closing over a stale render snapshot.
  const nodesRef = useRef<GraphNode[]>(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef<GraphEdge[]>(edges);
  edgesRef.current = edges;
  // originId → the node/edge ids this expansion ADDED (i.e. that were newly
  // present when it ran). Drives exact collapse + the lightweight render sets.
  const expansions = useRef(new Map<string, { addedNodeIds: Set<string>; addedEdgeKeys: Set<string> }>());
  // Exposed as state so ForceGraph re-derives the expanded-origin badge flip
  // and the dashed lightweight stroke on expansion-added nodes.
  const [expandedOriginIds, setExpandedOriginIds] = useState<Set<string>>(new Set());
  const [expansionAddedIds, setExpansionAddedIds] = useState<Set<string>>(new Set());

  const syncExpansionSets = () => {
    setExpandedOriginIds(new Set(expansions.current.keys()));
    const added = new Set<string>();
    for (const { addedNodeIds } of expansions.current.values()) {
      addedNodeIds.forEach((id) => added.add(id));
    }
    setExpansionAddedIds(added);
  };

  // FIX-497 — bumping this re-runs the fetch effect on demand. A group whose
  // donor aggregation failed is deliberately left out of `fetchedIds`, so a
  // nonce bump re-requests exactly the un-fetched groups (retryGroup below).
  const [retryNonce, setRetryNonce] = useState(0);

  // FIX-887 — groups the route REFUSED (422 filter_too_broad / cohort_too_large,
  // 404 gb_not_found, 422 gb_not_expandable, …). The FIX-490 error path already
  // stopped these from merging an empty payload, but it only console.warn'd —
  // silent in prod, so a refused group read as a graph that just did nothing.
  // Carrying the server's `reason` up lets GraphPage render the FIX-764 notice.
  const [groupNotices, setGroupNotices] = useState<Array<{ groupId: string; name: string; reason: string }>>([]);

  // Track which entity IDs we've already fetched to avoid re-fetching
  const fetchedIds = useRef(new Set<string>());

  // Track which nodes belong to each group (groupId → Set of connected node IDs)
  const groupNodeIds = useRef(new Map<string, Set<string>>());

  // FIX-850 — per-focus ownership. Records the FULL set of node ids + edge keys
  // each focus/group fetch CONTRIBUTED, so removal drops only what no surviving
  // focus still owns. A node/edge contributed by two focuses is owned by BOTH,
  // so removing one keeps it for the other. This replaces the raw-vs-prefixed
  // `removedIds.includes(edgeEndpointId)` checks that never matched (entity
  // removal was a no-op) and the group over-prune (every edge incident to a
  // member was dropped, killing surviving focuses' edges to shared nodes).
  const focusOwnership = useRef(new Map<string, { nodeIds: Set<string>; edgeKeys: Set<string> }>());
  // FIX-851 — last-fetched effective depth per focus entity, so the depth chip
  // [1|2] (and a global default-depth change) trigger a surgical single-entity
  // refetch instead of being inert.
  const fetchedDepths = useRef(new Map<string, number>());

  // FIX-802 — server-side fetch caps, read from the per-type connection
  // settings (donation row dropdown + shared vote control in ConnectionsTree)
  // so they round-trip through snapshots/presets.
  const donationLimit = connections['donation']?.fetchLimit ?? DEFAULT_DONATION_LIMIT;
  const votesLimit =
    VOTE_CONNECTION_TYPES.map(t => connections[t]?.fetchLimit).find(v => v != null) ??
    DEFAULT_VOTES_LIMIT;

  // Track values that require a full re-fetch when they change
  const prevIncludeProceduralRef   = useRef(focus.includeProcedural);
  const prevIndividualModeRef      = useRef(forceOptions?.individualDisplayMode);
  const prevConnectorMinRef        = useRef(forceOptions?.connectorMinRecipients);
  const prevDonationLimitRef       = useRef(donationLimit);
  const prevVotesLimitRef          = useRef(votesLimit);

  // When focus.entities or any re-fetch trigger changes: fetch data for new entities,
  // remove data for removed entities, and re-fetch all when server-side params toggle.
  useEffect(() => {
    const currentIds = new Set(focus.entities.map(e => e.id));

    // Re-fetch everything when any server-side filter param changes
    const shouldRefetchAll =
      prevIncludeProceduralRef.current !== focus.includeProcedural ||
      prevIndividualModeRef.current    !== forceOptions?.individualDisplayMode ||
      prevConnectorMinRef.current      !== forceOptions?.connectorMinRecipients ||
      prevDonationLimitRef.current     !== donationLimit ||
      prevVotesLimitRef.current        !== votesLimit;

    prevIncludeProceduralRef.current = focus.includeProcedural;
    prevIndividualModeRef.current    = forceOptions?.individualDisplayMode;
    prevConnectorMinRef.current      = forceOptions?.connectorMinRecipients;
    prevDonationLimitRef.current     = donationLimit;
    prevVotesLimitRef.current        = votesLimit;

    if (shouldRefetchAll) {
      fetchedIds.current.clear();
      groupNodeIds.current.clear();
      focusOwnership.current.clear();
      fetchedDepths.current.clear();
      setNodes([]);
      setEdges([]);
      setDataTruncation({ depth2Truncated: false, partial: false });
    }

    // FIX-851 — per-entity depth changes must refetch that entity. The depth
    // chip [1|2] calls updateEntity(id,{depth}); the id stays in fetchedIds, so
    // without this the chip is inert. A global default-depth change moves every
    // entity without a per-entity override. Depth-changed ids are evicted (their
    // owned data pruned below) then re-enter `toFetch`.
    const depthChangedIds: string[] = [];
    for (const e of focus.entities) {
      if (!isFocusEntity(e)) continue;
      if (!fetchedIds.current.has(e.id)) continue;
      const eff = e.depth ?? focus.depth;
      const prevDepth = fetchedDepths.current.get(e.id);
      if (prevDepth != null && prevDepth !== eff) depthChangedIds.push(e.id);
    }

    // Find newly added / depth-changed entities to (re)fetch. Groups are resolved
    // separately; selection groups (memberIds set — FIX-826) are client-only
    // handles over already-loaded nodes: no server fetch, no bubble.
    const toFetch = focus.entities.filter(
      (e): e is FocusEntity =>
        isFocusEntity(e) && (!fetchedIds.current.has(e.id) || depthChangedIds.includes(e.id))
    );
    const toFetchGroups = focus.entities.filter(
      (e): e is FocusGroup => isFocusGroup(e) && !e.memberIds && !fetchedIds.current.has(e.id)
    );

    // FIX-887 — a refusal notice belongs to a group in focus; drop it once the
    // group is removed (or retried), so dismissing by removing works and a stale
    // reason never outlives its group.
    setGroupNotices(prev => {
      const kept = prev.filter(n => currentIds.has(n.groupId));
      return kept.length === prev.length ? prev : kept;
    });

    // Evict = removed-from-focus ∪ depth-changed. Both prune the data they own;
    // depth-changed ids stay in focus so they re-fetch at the new depth.
    const removedIds = [...fetchedIds.current].filter(id => !currentIds.has(id));
    const evictIds = [...new Set([...removedIds, ...depthChangedIds])];

    if (evictIds.length > 0) {
      const evictSet = new Set(evictIds);
      evictIds.forEach(id => {
        fetchedIds.current.delete(id);
        fetchedDepths.current.delete(id);
      });

      // FIX-850 — union of everything still owned by a NON-evicted focus/group.
      const survivingNodeIds = new Set<string>();
      const survivingEdgeKeys = new Set<string>();
      for (const [focusId, own] of focusOwnership.current) {
        if (evictSet.has(focusId)) continue;
        own.nodeIds.forEach(id => survivingNodeIds.add(id));
        own.edgeKeys.forEach(k => survivingEdgeKeys.add(k));
      }
      evictIds.forEach(id => { focusOwnership.current.delete(id); groupNodeIds.current.delete(id); });

      // Expansion-introduced nodes/edges (FIX-827) are owned by the expansions
      // map, not by any focus — keep them regardless of the removed focus.
      const expNodeIds = new Set<string>();
      const expEdgeKeys = new Set<string>();
      for (const exp of expansions.current.values()) {
        exp.addedNodeIds.forEach(id => expNodeIds.add(id));
        exp.addedEdgeKeys.forEach(k => expEdgeKeys.add(k));
      }

      // Current focus uuids (raw) — a focus node with no data yet (still loading
      // or refetching at a new depth) must never be pruned mid-flight.
      const focusUuids = new Set(focus.entities.filter(isFocusEntity).map(e => e.id));

      const survivingEdges = edgesRef.current.filter(e => {
        const k = edgeKey(e);
        return survivingEdgeKeys.has(k) || expEdgeKeys.has(k);
      });
      const referenced = new Set<string>();
      survivingEdges.forEach(e => { referenced.add(e.fromId); referenced.add(e.toId); });

      const survivingNodes = nodesRef.current.filter(n => {
        if (survivingNodeIds.has(n.id)) return true;    // a surviving focus owns it
        if (expNodeIds.has(n.id)) return true;          // an expansion introduced it
        if (referenced.has(n.id)) return true;          // still wired by a surviving edge
        if (n.type === 'user') return true;             // app-injected (GraphPage)
        if (isFocusNode(n.id, focusUuids)) return true; // focus node still loading / refetching
        return false;
      });

      setEdges(survivingEdges);
      setNodes(survivingNodes);
    }

    // Fetch data for new / depth-changed entities and new groups
    if (toFetch.length > 0) {
      fetchEntities(toFetch);
    }
    if (toFetchGroups.length > 0) {
      fetchGroups(toFetchGroups);
    }

    // If all entities removed: clear graph state
    if (focus.entities.length === 0) {
      setNodes([]);
      setEdges([]);
      fetchedIds.current.clear();
      focusOwnership.current.clear();
      fetchedDepths.current.clear();
      groupNodeIds.current.clear();
      setDataTruncation({ depth2Truncated: false, partial: false });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus.entities, focus.depth, focus.includeProcedural, forceOptions?.individualDisplayMode, forceOptions?.connectorMinRecipients, donationLimit, votesLimit, retryNonce]);

  async function fetchEntities(entities: FocusEntity[]) {
    setLoading(true);
    for (const entity of entities) {
      setLoadingEntityId(entity.id);
      try {
        const params = new URLSearchParams({
          entityId: entity.id,
          depth: String(entity.depth ?? focus.depth),
          viz: 'force',
          include_procedural: String(focus.includeProcedural),
          // FIX-802 — server-side fetch caps (whitelisted by the route)
          limit: String(donationLimit),
          votes_limit: String(votesLimit),
        });
        if (forceOptions?.individualDisplayMode) {
          params.set('individualMode', forceOptions.individualDisplayMode);
        }
        if (forceOptions?.connectorMinRecipients != null) {
          params.set('connectorMin', String(forceOptions.connectorMinRecipients));
        }

        const res = await fetch(`/api/graph/connections?` + params);
        const data = await res.json();

        // FIX-852 — surface honest truncation. depth2Truncated (budget/read trip)
        // and partial (edge-hydration ceiling) both mean "some edges are missing".
        if (data?.meta?.depth2Truncated || data?.partial) {
          setDataTruncation(prev => ({
            depth2Truncated: prev.depth2Truncated || Boolean(data?.meta?.depth2Truncated),
            partial: prev.partial || Boolean(data?.partial),
          }));
        }

        // Mark as fetched + record this fetch's effective depth (FIX-851) and
        // its full node/edge contribution for ownership pruning (FIX-850).
        fetchedIds.current.add(entity.id);
        fetchedDepths.current.set(entity.id, entity.depth ?? focus.depth);
        focusOwnership.current.set(entity.id, {
          nodeIds: new Set<string>((data.nodes ?? []).map((n: GraphNode) => n.id)),
          edgeKeys: new Set<string>((data.edges ?? []).map((e: GraphEdge) => edgeKey(e))),
        });

        // Merge nodes field-wise (FIX-851 — dedupe by id, focus-set-invariant)
        setNodes(prev => {
          const existing = new Map(prev.map(n => [n.id, n]));
          (data.nodes ?? []).forEach((n: GraphNode) => {
            const prevN = existing.get(n.id);
            existing.set(n.id, prevN ? mergeNode(prevN, n) : n);
          });
          return [...existing.values()];
        });

        // Merge edges (dedupe by fromId:toId:connectionType)
        setEdges(prev => {
          const existing = new Map(prev.map(e => [edgeKey(e), e]));
          (data.edges ?? []).forEach((e: GraphEdge) => existing.set(edgeKey(e), e));
          return [...existing.values()];
        });
      } catch (err) {
        console.error('[useGraphData] fetch failed:', entity.id, err);
      }
    }
    setLoadingEntityId(null);
    setLoading(false);
  }

  async function fetchGroups(groups: FocusGroup[]) {
    setLoading(true);
    for (const group of groups) {
      setLoadingEntityId(group.id);
      try {
        // FIX-842/849 — params built by the shared pure helper (unit-tested).
        const params = graphGroupParams(group, donationLimit);

        const res  = await fetch(`/api/graph/group?` + params);
        const data = await res.json();

        // FIX-490 — gb groups can be gated (422 gb_not_expandable) or missing
        // (404). The route error is authoritative: mark fetched (a gate is not
        // retryable) and surface it instead of merging an empty payload and
        // rendering a mysteriously blank group bubble.
        if (!res.ok || data?.error) {
          fetchedIds.current.add(group.id);
          console.warn(
            `[useGraphData] group ${group.id} not expandable:`,
            data?.error ?? `HTTP ${res.status}`,
            data?.reason ?? '',
          );
          // FIX-887 — make the refusal visible. `reason` is the route's
          // human-readable sentence; fall back to the error code so even an
          // unstructured failure says something rather than nothing.
          const reason: string =
            (typeof data?.reason === 'string' && data.reason) ||
            (typeof data?.error === 'string' && data.error) ||
            `HTTP ${res.status}`;
          setGroupNotices(prev =>
            prev.some(n => n.groupId === group.id)
              ? prev
              : [...prev, { groupId: group.id, name: group.name, reason }],
          );
          continue;
        }

        // FIX-497 — the donor/connection aggregation timed out or errored. The
        // route still returns the group bubble (+ memberCount) but with
        // meta.donorFetchError and no donor edges. Merge the bubble so the
        // member node still renders, but do NOT mark the group fetched — leaving
        // it un-fetched lets retryGroup() (and the next focus change) re-request
        // instead of caching a convincing empty.
        const donorFetchError = Boolean(data?.meta?.donorFetchError);
        if (!donorFetchError) {
          fetchedIds.current.add(group.id);
        } else {
          console.warn(`[useGraphData] group ${group.id} donor fetch failed — left un-cached for retry`);
        }

        // FIX-498 — surface the server-resolved group name so the FOCUS panel
        // can replace a client-side placeholder once the real name is known.
        const resolvedName: unknown = data?.group?.name;
        if (typeof resolvedName === 'string' && resolvedName && resolvedName !== group.name) {
          onGroupResolved?.(group.id, resolvedName);
        }

        // Track which nodes belong to this group (all nodes except the group node itself)
        const connectedIds = new Set<string>(
          (data.nodes ?? [])
            .map((n: GraphNode) => n.id)
            .filter((id: string) => id !== group.id)
        );
        groupNodeIds.current.set(group.id, connectedIds);

        // FIX-850 — record this group's full node/edge contribution for
        // ownership pruning (recorded even on donorFetchError: the bubble node
        // was still merged, so removal must be able to prune it).
        focusOwnership.current.set(group.id, {
          nodeIds: new Set<string>((data.nodes ?? []).map((n: GraphNode) => n.id)),
          edgeKeys: new Set<string>((data.edges ?? []).map((e: GraphEdge) => edgeKey(e))),
        });

        // Merge nodes field-wise (FIX-851)
        setNodes(prev => {
          const existing = new Map(prev.map(n => [n.id, n]));
          (data.nodes ?? []).forEach((n: GraphNode) => {
            const prevN = existing.get(n.id);
            existing.set(n.id, prevN ? mergeNode(prevN, n) : n);
          });
          return [...existing.values()];
        });

        // Merge edges (dedupe by fromId:toId:connectionType)
        setEdges(prev => {
          const existing = new Map(prev.map(e => [edgeKey(e), e]));
          (data.edges ?? []).forEach((e: GraphEdge) => existing.set(edgeKey(e), e));
          return [...existing.values()];
        });
      } catch (err) {
        console.error('[useGraphData] group fetch failed:', group.id, err);
      }
    }
    setLoadingEntityId(null);
    setLoading(false);
  }

  // ── FIX-827 — incremental neighborhood expand ──────────────────────────────
  // Replaces the FIX-805 interim (which added the clicked node as a whole focus
  // entity). Fetches ONE hop for the node honoring the current fetch caps and
  // MERGES the result into graph state; the origin does NOT become a focus
  // entity. The set-difference vs the current graph is recorded so a later
  // collapse removes exactly what this expansion introduced.
  const expandNode = useCallback(async (originId: string) => {
    // FIX-843 — group donor nodes arrive as `donor-{uuid}` (no `type:` colon),
    // which the old prefix-strip left intact → UUID_RE failed → the node was
    // silently non-expandable. Extract the first uuid anywhere in the id, but
    // never expand the synthetic tail/bracket aggregates (their uuid is the
    // official's, not a real neighbor to fetch).
    if (/^(tail|bracket):/.test(originId)) return;
    const uuidMatch = originId.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    const cleanId = uuidMatch ? uuidMatch[0] : originId.replace(/^[a-z_]+:/, '');
    if (!UUID_RE.test(cleanId)) return;               // groups / user / brackets aren't expandable
    if (expansions.current.has(originId)) return;     // already expanded

    setLoading(true);
    setLoadingEntityId(originId);
    try {
      const params = new URLSearchParams({
        entityId: cleanId,
        depth: '1',
        viz: 'force',
        include_procedural: String(focus.includeProcedural),
        limit: String(donationLimit),
        votes_limit: String(votesLimit),
      });
      if (forceOptions?.individualDisplayMode) params.set('individualMode', forceOptions.individualDisplayMode);
      if (forceOptions?.connectorMinRecipients != null) params.set('connectorMin', String(forceOptions.connectorMinRecipients));

      const res = await fetch(`/api/graph/connections?` + params);
      const data = await res.json();

      const existingNodeIds = new Set(nodesRef.current.map((n) => n.id));
      const existingEdgeKeys = new Set(edgesRef.current.map(edgeKey));
      const addedNodeIds = new Set<string>();
      const addedEdgeKeys = new Set<string>();
      (data.nodes ?? []).forEach((n: GraphNode) => { if (!existingNodeIds.has(n.id)) addedNodeIds.add(n.id); });
      (data.edges ?? []).forEach((e: GraphEdge) => { const k = edgeKey(e); if (!existingEdgeKeys.has(k)) addedEdgeKeys.add(k); });

      setNodes((prev) => {
        const existing = new Map(prev.map((n) => [n.id, n]));
        (data.nodes ?? []).forEach((n: GraphNode) => {
          const prevN = existing.get(n.id);
          existing.set(n.id, prevN ? mergeNode(prevN, n) : n);
        });
        return [...existing.values()];
      });
      setEdges((prev) => {
        const existing = new Map(prev.map((e) => [edgeKey(e), e]));
        (data.edges ?? []).forEach((e: GraphEdge) => existing.set(edgeKey(e), e));
        return [...existing.values()];
      });

      expansions.current.set(originId, { addedNodeIds, addedEdgeKeys });
      syncExpansionSets();
    } catch (err) {
      console.error('[useGraphData] expand failed:', originId, err);
    } finally {
      setLoadingEntityId(null);
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [donationLimit, votesLimit, focus.includeProcedural, forceOptions?.individualDisplayMode, forceOptions?.connectorMinRecipients]);

  // Collapse an expansion: remove the edges it added, then drop the nodes it
  // added UNLESS a surviving edge still references them, they're a focus entity,
  // or the USER node — i.e. "minus anything another expansion / focus fetch also
  // references" (a shared node kept alive by another surviving edge stays).
  const collapseExpansion = useCallback((originId: string) => {
    const exp = expansions.current.get(originId);
    if (!exp) return;
    expansions.current.delete(originId);

    const survivingEdges = edgesRef.current.filter((e) => !exp.addedEdgeKeys.has(edgeKey(e)));
    const referenced = new Set<string>();
    survivingEdges.forEach((e) => { referenced.add(e.fromId); referenced.add(e.toId); });

    const survivingNodes = nodesRef.current.filter((n) => {
      if (!exp.addedNodeIds.has(n.id)) return true;   // not ours → keep
      if (referenced.has(n.id)) return true;          // still wired by a surviving edge
      if (n.type === 'user') return true;
      return false;
    });

    setEdges(survivingEdges);
    setNodes(survivingNodes);
    syncExpansionSets();
  }, []);

  // Promote an expanded origin to a real focus entity: drop its expansion record
  // WITHOUT pruning (the caller's addEntity re-fetches the full neighborhood and
  // takes ownership of these nodes) and clear its lightweight/expanded state.
  const promoteExpansion = useCallback((originId: string) => {
    if (!expansions.current.delete(originId)) return;
    syncExpansionSets();
  }, []);

  // Filter visible edges based on connection settings
  const visibleEdges = useMemo(
    () => edges.filter(e => connections[e.connectionType]?.enabled ?? true),
    [edges, connections]
  );

  // Derive metadata from loaded edges and nodes
  const graphMeta = useMemo((): GraphMeta => {
    const connectionTypes: Record<string, { count: number; totalAmount: number }> = {};

    for (const edge of edges) {
      const t = edge.connectionType;
      if (!connectionTypes[t]) {
        connectionTypes[t] = { count: 0, totalAmount: 0 };
      }
      connectionTypes[t].count++;
      connectionTypes[t].totalAmount += edge.amountUsd ?? 0;
    }

    const entityTypes = new Set(nodes.map(n => n.type));

    const voteTypes = new Set([
      'vote_yes', 'vote_no', 'vote_abstain',
      'nomination_vote_yes', 'nomination_vote_no',
    ]);

    const hasVotes      = Object.keys(connectionTypes).some(t => voteTypes.has(t));
    const hasDonations  = 'donation' in connectionTypes;
    const hasOversight  = 'oversight' in connectionTypes;
    const hasNominations =
      'nomination_vote_yes' in connectionTypes ||
      'nomination_vote_no'  in connectionTypes;
    const hasGroups = nodes.some(n => n.type === 'group');
    const isPacFocus = focus.entities.some(
      e => isFocusGroup(e) && e.filter.entity_type === 'pac'
    );
    return {
      connectionTypes, entityTypes, hasVotes, hasDonations,
      hasOversight, hasNominations, hasGroups, isPacFocus,
    };
  }, [edges, nodes, focus.entities]);

  // FIX-C — stamp client-computed contract totals (USD) onto nodes so
  // ForceGraph's 'contract_total' node-size encoding stays a plain field read in
  // getNodeRadius. Sums amountUsd over contract_award edges incident to each
  // node (agency award-side AND vendor receive-side). LOWER BOUND: reflects only
  // the loaded top-500-by-amount contract edges the connections route returns.
  const nodesWithContractTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const e of edges) {
      if (e.connectionType !== 'contract_award') continue;
      const amt = e.amountUsd ?? 0;
      if (amt <= 0) continue;
      totals.set(e.fromId, (totals.get(e.fromId) ?? 0) + amt);
      totals.set(e.toId, (totals.get(e.toId) ?? 0) + amt);
    }
    if (totals.size === 0) return nodes;
    return nodes.map((n) => (totals.has(n.id) ? { ...n, contractTotal: totals.get(n.id)! } : n));
  }, [nodes, edges]);

  return {
    nodes: nodesWithContractTotals, edges: visibleEdges, allEdges: edges, loading,
    loadingEntityId, graphMeta,
    // FIX-852 — honest truncation flags for the canvas badge
    dataTruncation,
    // FIX-887 — groups the route refused, with the server's reason (visible notice)
    groupNotices,
    dismissGroupNotice: (groupId: string) =>
      setGroupNotices(prev => prev.filter(n => n.groupId !== groupId)),
    // FIX-827 — incremental expand surface
    expandNode, collapseExpansion, promoteExpansion,
    expandedOriginIds, expansionAddedIds,
    // FIX-827 — surfaced so the NodePopup can show "Expand here (top N)"
    donationLimit,
    refetch: () => {
      fetchedIds.current.clear();
      focusOwnership.current.clear();
      fetchedDepths.current.clear();
      groupNodeIds.current.clear();
      setNodes([]); setEdges([]);
    },
    // FIX-497 — re-request a group whose donor aggregation failed. The group was
    // left out of fetchedIds, so bumping the nonce re-runs the effect and
    // re-fetches exactly that group (and any other un-fetched group).
    retryGroup: (groupId: string) => {
      fetchedIds.current.delete(groupId);
      setRetryNonce(n => n + 1);
    },
  };
}