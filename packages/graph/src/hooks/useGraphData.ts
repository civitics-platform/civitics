"use client";

/**
 * packages/graph/src/hooks/useGraphData.ts
 *
 * Manages node/edge data for the graph, merging data for multiple focused
 * entities. Fetches data for newly added entities and removes data for
 * removed entities without reloading the whole graph.
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import type { GraphView } from '../types';
import type { FocusEntity } from '../types';
import { isFocusEntity } from '../types';
import type { GraphNode, GraphEdge } from '../types';

export function useGraphData(
  focus: GraphView['focus'],
  connections: GraphView['connections']
) {
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingEntityId, setLoadingEntityId] = useState<string | null>(null);

  // Track which entity IDs we've already fetched to avoid re-fetching
  const fetchedIds = useRef(new Set<string>());

  // When focus.entities changes: fetch data for new entities, remove data for removed entities
  useEffect(() => {
    const currentIds = new Set(focus.entities.map(e => e.id));

    // Find newly added entities (groups are resolved separately; only fetch FocusEntity items here)
    const toFetch = focus.entities.filter(
      (e): e is FocusEntity => isFocusEntity(e) && !fetchedIds.current.has(e.id)
    );

    // Find removed entities
    const removedIds = [...fetchedIds.current].filter(id => !currentIds.has(id));

    // Remove nodes/edges for removed entities
    if (removedIds.length > 0) {
      removedIds.forEach(id => fetchedIds.current.delete(id));

      setNodes(prev =>
        prev.filter(n =>
          // Keep if it's not a removed entity OR it connects to a remaining entity
          !removedIds.includes(n.id) || focus.entities.some(e => e.id === n.id)
        )
      );

      setEdges(prev =>
        prev.filter(e => {
          // Keep edge only if BOTH endpoints still exist
          const fromRemoved = removedIds.includes(e.fromId);
          const toRemoved = removedIds.includes(e.toId);
          return !fromRemoved && !toRemoved;
        })
      );
    }

    // Fetch data for new entities
    if (toFetch.length > 0) {
      fetchEntities(toFetch);
    }

    // If all entities removed: clear graph state
    if (focus.entities.length === 0) {
      setNodes([]);
      setEdges([]);
      fetchedIds.current.clear();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus.entities]);

  async function fetchEntities(entities: FocusEntity[]) {
    setLoading(true);
    for (const entity of entities) {
      setLoadingEntityId(entity.id);
      try {
        const params = new URLSearchParams({
          entityId: entity.id,
          depth: String(entity.depth ?? focus.depth),
          viz: 'force',
        });

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

  // Filter visible edges based on connection settings
  const visibleEdges = useMemo(
    () => edges.filter(e => connections[e.connectionType]?.enabled ?? true),
    [edges, connections]
  );

  return {
    nodes,
    edges: visibleEdges,
    allEdges: edges,
    loading,
    loadingEntityId,
    refetch: () => {
      fetchedIds.current.clear();
      setNodes([]);
      setEdges([]);
      // Re-fetch will trigger via useEffect when entities are still set
    },
  };
}
