"use client";

/**
 * packages/graph/src/hooks/useGraphView.ts
 *
 * Single state manager for the entire graph.
 * All components read from and write to this hook.
 *
 * Critical rules:
 *   - setVizType does NOT call markDirty — switching viz is navigation, not modification
 *   - All other setters call markDirty so the panel footer knows a preset was modified
 */

import { useState } from 'react';
import type { FocusEntity, FocusGroup, FocusItem, GraphView, GraphViewPreset, VizType } from '../types';
import { isFocusEntity, MAX_FOCUS_ENTITIES } from '../types';
import { DEFAULT_GRAPH_VIEW, applyPreset as applyPresetUtil, markDirty } from '../presets';

export function useGraphView(initialView?: Partial<GraphView>) {
  const [view, setView] = useState<GraphView>({
    ...DEFAULT_GRAPH_VIEW,
    ...initialView,
  });

  return {
    view,

    // ── Layer 1: Focus ──────────────────────────────────────────────────────

    addEntity: (entity: FocusEntity) =>
      setView(v => {
        if (v.focus.entities.length >= MAX_FOCUS_ENTITIES) return v; // caller shows warning
        return markDirty({
          ...v,
          focus: {
            ...v.focus,
            entities: [
              ...v.focus.entities.filter(e => e.id !== entity.id), // prevent duplicates
              entity,
            ],
          },
        });
      }),

    removeEntity: (id: string) =>
      setView(v => markDirty({
        ...v,
        focus: {
          ...v.focus,
          entities: v.focus.entities.filter(e => e.id !== id),
        },
      })),

    updateEntity: (id: string, options: Partial<FocusEntity>) =>
      setView(v => markDirty({
        ...v,
        focus: {
          ...v.focus,
          entities: v.focus.entities.map(e =>
            (e.id === id && isFocusEntity(e)) ? { ...e, ...options } : e
          ),
        },
      })),

    clearFocus: () =>
      setView(v => ({
        ...v,
        focus: {
          ...v.focus,
          entities: [],
        },
      })),

    addGroup: (_group: FocusGroup) => {
      // Stub — implemented in Prompt 3
      console.warn('addGroup not yet implemented', _group);
    },

    removeGroup: (groupTag: string) =>
      setView(v => markDirty({
        ...v,
        focus: {
          ...v.focus,
          entities: v.focus.entities.filter(e => !isFocusEntity(e) || e.groupTag !== groupTag),
        },
      })),

    setDepth: (depth: 1 | 2 | 3) =>
      setView(v => markDirty({
        ...v,
        focus: { ...v.focus, depth },
      })),

    setScope: (scope: GraphView['focus']['scope']) =>
      setView(v => markDirty({
        ...v,
        focus: { ...v.focus, scope },
      })),

    toggleIncludeProcedural: () =>
      setView(v => markDirty({
        ...v,
        focus: { ...v.focus, includeProcedural: !v.focus.includeProcedural },
      })),

    // ── Layer 2: Connections ────────────────────────────────────────────────

    toggleConnection: (type: string) =>
      setView(v => markDirty({
        ...v,
        connections: {
          ...v.connections,
          [type]: {
            ...v.connections[type],
            enabled: !v.connections[type]?.enabled,
          },
        } as GraphView['connections'],
      })),

    setConnectionColor: (type: string, color: string) =>
      setView(v => markDirty({
        ...v,
        connections: {
          ...v.connections,
          [type]: { ...v.connections[type], color },
        } as GraphView['connections'],
      })),

    setConnectionOpacity: (type: string, opacity: number) =>
      setView(v => markDirty({
        ...v,
        connections: {
          ...v.connections,
          [type]: { ...v.connections[type], opacity },
        } as GraphView['connections'],
      })),

    setConnectionThickness: (type: string, thickness: number) =>
      setView(v => markDirty({
        ...v,
        connections: {
          ...v.connections,
          [type]: { ...v.connections[type], thickness },
        } as GraphView['connections'],
      })),

    setConnectionMinAmount: (type: string, minAmount: number) =>
      setView(v => markDirty({
        ...v,
        connections: {
          ...v.connections,
          [type]: { ...v.connections[type], minAmount },
        } as GraphView['connections'],
      })),

    /** Replace the full settings object for a connection type. Used by ConnectionStyleRow. */
    setConnection: (type: string, settings: GraphView['connections'][string]) =>
      setView(v => markDirty({
        ...v,
        connections: {
          ...v.connections,
          [type]: settings,
        } as GraphView['connections'],
      })),

    // ── Layer 3: Style ──────────────────────────────────────────────────────

    // NOTE: do NOT call markDirty here.
    // Switching viz type is navigation — not a modification of a preset.
    setVizType: (vizType: VizType) =>
      setView(v => ({
        ...v,
        style: { ...v.style, vizType },
      })),

    setVizOption: (vizType: VizType, key: string, value: unknown) =>
      setView(v => markDirty({
        ...v,
        style: {
          ...v.style,
          vizOptions: {
            ...v.style.vizOptions,
            [vizType]: {
              ...v.style.vizOptions[vizType],
              [key]: value,
            },
          },
        },
      })),

    // ── Presets ─────────────────────────────────────────────────────────────

    applyPreset: (preset: GraphViewPreset) =>
      setView(applyPresetUtil(preset, view)),

    // ── Computed helpers (backward compat with single-entity APIs) ───────────

    /** First focused entity. For backward compat during G2/G3 migration. */
    primaryEntity: view.focus.entities[0] ?? null,

    /** True when at least one entity is focused. */
    hasFocus: view.focus.entities.length > 0,

    /** True when MAX_FOCUS_ENTITIES has been reached. */
    atMaxFocus: view.focus.entities.length >= MAX_FOCUS_ENTITIES,

    // ── Serialization ────────────────────────────────────────────────────────

    serialize: () => JSON.stringify({ version: '2.0', view }),
  };
}

export type UseGraphViewReturn = ReturnType<typeof useGraphView>;
