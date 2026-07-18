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
import {
  VOTE_CONNECTION_TYPES,
  DEFAULT_DONATION_LIMIT,
  DEFAULT_VOTES_LIMIT,
} from '../connections';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const edgeKey = (e: GraphEdge) => `${e.fromId}:${e.toId}:${e.connectionType}`;

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

  // Track which entity IDs we've already fetched to avoid re-fetching
  const fetchedIds = useRef(new Set<string>());

  // Track which nodes belong to each group (groupId → Set of connected node IDs)
  const groupNodeIds = useRef(new Map<string, Set<string>>());

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
      setNodes([]);
      setEdges([]);
    }

    // Find newly added entities (groups are resolved separately; only fetch FocusEntity items here)
    const toFetch = focus.entities.filter(
      (e): e is FocusEntity => isFocusEntity(e) && !fetchedIds.current.has(e.id)
    );

    // Find newly added groups. FIX-826 — selection groups (memberIds set) are
    // client-only handles over already-loaded nodes: no server fetch, no bubble.
    const toFetchGroups = focus.entities.filter(
      (e): e is FocusGroup => isFocusGroup(e) && !e.memberIds && !fetchedIds.current.has(e.id)
    );

    // Find removed entities
    const removedIds = [...fetchedIds.current].filter(id => !currentIds.has(id));

    // Remove nodes/edges for removed entities
    if (removedIds.length > 0) {
      removedIds.forEach(id => fetchedIds.current.delete(id));

      // Collect nodes that belonged to removed groups
      const groupConnectedToRemove = new Set<string>();
      for (const removedId of removedIds) {
        const connected = groupNodeIds.current.get(removedId);
        if (connected) {
          connected.forEach(id => groupConnectedToRemove.add(id));
          groupNodeIds.current.delete(removedId);
        }
      }

      // QWEN-ADDED: Compute surviving edges first, then prune orphaned nodes
      // Step 1: compute the surviving edges as a plain array
      const survivingEdges = edges.filter(e => {
        const fromRemoved = removedIds.includes(e.fromId) || groupConnectedToRemove.has(e.fromId);
        const toRemoved   = removedIds.includes(e.toId)   || groupConnectedToRemove.has(e.toId);
        return !fromRemoved && !toRemoved;
      });

      // Step 2: build a set of node IDs still referenced by a surviving edge
      const referencedNodeIds = new Set<string>([
        ...survivingEdges.map(e => e.fromId),
        ...survivingEdges.map(e => e.toId),
      ]);

      // Step 3: keep a node if it's a current focus entity OR still has at least one edge
      setNodes(prev =>
        prev.filter(n =>
          !removedIds.includes(n.id) &&
          !groupConnectedToRemove.has(n.id) &&
          (currentIds.has(n.id) || referencedNodeIds.has(n.id))
        )
      );

      // Step 4: apply the pre-computed edge filter
      setEdges(() => survivingEdges);
    }

    // Fetch data for new entities and groups
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
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus.entities, focus.includeProcedural, forceOptions?.individualDisplayMode, forceOptions?.connectorMinRecipients, donationLimit, votesLimit, retryNonce]);

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

        // Mark as fetched
        fetchedIds.current.add(entity.id);

        // Merge nodes (dedupe by id)
        setNodes(prev => {
          const existing = new Map(prev.map(n => [n.id, n]));
          (data.nodes ?? []).forEach((n: GraphNode) => existing.set(n.id, n));
          return [...existing.values()];
        });

        // Merge edges (dedupe by fromId:toId:connectionType)
        setEdges(prev => {
          const key = (e: GraphEdge) => `${e.fromId}:${e.toId}:${e.connectionType}`;
          const existing = new Map(prev.map(e => [key(e), e]));
          (data.edges ?? []).forEach((e: GraphEdge) => existing.set(key(e), e));
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
        const params = new URLSearchParams({
          groupId: group.id,
          entity_type: group.filter.entity_type,
          groupName: group.name,
          groupIcon: group.icon,
          groupColor: group.color,
          // FIX-842 — forward the Top-donors cap so the dropdown actually
          // changes the group's donor count (route clamps to ≤100).
          limit: String(donationLimit),
        });

        if (group.filter.chamber)  params.set('chamber',  group.filter.chamber);
        if (group.filter.party)    params.set('party',    group.filter.party);
        if (group.filter.state)    params.set('state',    group.filter.state);
        if (group.filter.industry) params.set('industry', group.filter.industry);
        if (group.filter.tag)      params.set('tag',      group.filter.tag);
        if (group.filter.committeeId) params.set('committeeId', group.filter.committeeId);
        if (group.filter.governingBody) params.set('governingBody', group.filter.governingBody);
        // FIX-772 — financial cohorts were unreachable end-to-end: this param
        // was never forwarded, so even a route that understood
        // entity_type=financial would have seen no subtype.
        if (group.filter.financial_type) params.set('financial_type', group.filter.financial_type);

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

        // Merge nodes (dedupe by id)
        setNodes(prev => {
          const existing = new Map(prev.map(n => [n.id, n]));
          (data.nodes ?? []).forEach((n: GraphNode) => existing.set(n.id, n));
          return [...existing.values()];
        });

        // Merge edges (dedupe by fromId:toId:connectionType)
        setEdges(prev => {
          const key = (e: GraphEdge) => `${e.fromId}:${e.toId}:${e.connectionType}`;
          const existing = new Map(prev.map(e => [key(e), e]));
          (data.edges ?? []).forEach((e: GraphEdge) => existing.set(key(e), e));
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
        (data.nodes ?? []).forEach((n: GraphNode) => existing.set(n.id, n));
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

  return {
    nodes, edges: visibleEdges, allEdges: edges, loading,
    loadingEntityId, graphMeta,
    // FIX-827 — incremental expand surface
    expandNode, collapseExpansion, promoteExpansion,
    expandedOriginIds, expansionAddedIds,
    // FIX-827 — surfaced so the NodePopup can show "Expand here (top N)"
    donationLimit,
    refetch: () => {
      fetchedIds.current.clear();
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