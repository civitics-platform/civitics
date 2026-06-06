"use client";

/**
 * packages/graph/src/hooks/useGraphData.ts
 *
 * Manages node/edge data for the graph, merging data for multiple focused
 * entities. Fetches data for newly added entities and removes data for
 * removed entities without reloading the whole graph.
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import type { GraphView, ForceOptions } from '../types';
import type { FocusEntity, FocusGroup } from '../types';
import { isFocusEntity, isFocusGroup } from '../types';
import type { GraphNode, GraphEdge } from '../types';

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
  forceOptions?: Pick<ForceOptions, 'individualDisplayMode' | 'connectorMinRecipients'>
) {
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingEntityId, setLoadingEntityId] = useState<string | null>(null);

  // FIX-497 — bumping this re-runs the fetch effect on demand. A group whose
  // donor aggregation failed is deliberately left out of `fetchedIds`, so a
  // nonce bump re-requests exactly the un-fetched groups (retryGroup below).
  const [retryNonce, setRetryNonce] = useState(0);

  // Track which entity IDs we've already fetched to avoid re-fetching
  const fetchedIds = useRef(new Set<string>());

  // Track which nodes belong to each group (groupId → Set of connected node IDs)
  const groupNodeIds = useRef(new Map<string, Set<string>>());

  // Track values that require a full re-fetch when they change
  const prevIncludeProceduralRef   = useRef(focus.includeProcedural);
  const prevIndividualModeRef      = useRef(forceOptions?.individualDisplayMode);
  const prevConnectorMinRef        = useRef(forceOptions?.connectorMinRecipients);

  // When focus.entities or any re-fetch trigger changes: fetch data for new entities,
  // remove data for removed entities, and re-fetch all when server-side params toggle.
  useEffect(() => {
    const currentIds = new Set(focus.entities.map(e => e.id));

    // Re-fetch everything when any server-side filter param changes
    const shouldRefetchAll =
      prevIncludeProceduralRef.current !== focus.includeProcedural ||
      prevIndividualModeRef.current    !== forceOptions?.individualDisplayMode ||
      prevConnectorMinRef.current      !== forceOptions?.connectorMinRecipients;

    prevIncludeProceduralRef.current = focus.includeProcedural;
    prevIndividualModeRef.current    = forceOptions?.individualDisplayMode;
    prevConnectorMinRef.current      = forceOptions?.connectorMinRecipients;

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

    // Find newly added groups
    const toFetchGroups = focus.entities.filter(
      (e): e is FocusGroup => isFocusGroup(e) && !fetchedIds.current.has(e.id)
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
  }, [focus.entities, focus.includeProcedural, forceOptions?.individualDisplayMode, forceOptions?.connectorMinRecipients, retryNonce]);

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
        });

        if (group.filter.chamber)  params.set('chamber',  group.filter.chamber);
        if (group.filter.party)    params.set('party',    group.filter.party);
        if (group.filter.state)    params.set('state',    group.filter.state);
        if (group.filter.industry) params.set('industry', group.filter.industry);
        if (group.filter.tag)      params.set('tag',      group.filter.tag);
        if (group.filter.committeeId) params.set('committeeId', group.filter.committeeId);
        if (group.filter.governingBody) params.set('governingBody', group.filter.governingBody);

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