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

import { useEffect, useState } from 'react';
import type { FocusEntity, FocusGroup, FocusItem, GraphView, GraphViewPreset, VizType } from '../types';
import { isFocusEntity, isFocusGroup, MAX_FOCUS_ENTITIES } from '../types';
import {
  DEFAULT_GRAPH_VIEW,
  applyPreset as applyPresetUtil,
  markDirty,
  BUILT_IN_PRESETS,
  resolvePresetForFocus,
} from '../presets';
import { recordRecent } from '../recently-viewed';

export function useGraphView(initialView?: Partial<GraphView>) {
  const [view, setView] = useState<GraphView>({
    ...DEFAULT_GRAPH_VIEW,
    ...initialView,
  });

  // FIX-216 — Auto-adapt the active preset when focus changes.
  // When a clean (non-dirty) preset is loaded, switching focus from e.g.
  // an unfocused state to "Ted Cruz" should re-merge per-focus dataMode
  // overrides into vizOptions. We do this by:
  //   1. Looking up the original preset by meta.presetId
  //   2. Re-resolving it for the current focus
  //   3. Updating only style.vizOptions when the resolved view differs
  // Skips when isDirty=true (user has manually edited the preset).
  useEffect(() => {
    const presetId = view.meta?.presetId;
    if (!presetId) return;
    if (view.meta?.isDirty) return;
    const original = BUILT_IN_PRESETS.find(p => p.meta.presetId === presetId);
    if (!original) return;
    const resolved = resolvePresetForFocus(original, view.focus);
    // Cheap structural equality on the just-resolved viz-options
    const currentJson  = JSON.stringify(view.style.vizOptions);
    const resolvedJson = JSON.stringify(resolved.style.vizOptions);
    if (currentJson === resolvedJson) return;
    setView(v => ({
      ...v,
      style: {
        ...v.style,
        vizOptions: resolved.style.vizOptions,
      },
    }));
    // Intentionally narrow deps: only react to focus changes + the loaded
    // preset id. Ignoring view.style.vizOptions is what makes "no-op when
    // unchanged" stable; the equality check above guards re-entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.focus.entities, view.meta?.presetId, view.meta?.isDirty]);

  return {
    view,

    // ── Layer 1: Focus ──────────────────────────────────────────────────────

    addEntity: (entity: FocusEntity) => {
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
      });
      // Recently-viewed history (FIX-140) — record outside the setState updater so
      // StrictMode's double-invocation doesn't double-record.
      recordRecent(entity);
    },

    removeEntity: (id: string) =>
      setView(v => markDirty({
        ...v,
        focus: {
          ...v.focus,
          entities: v.focus.entities.filter(e => e.id !== id),
          // FIX-184: clear pinned primary if it was the removed item
          primaryEntityId: v.focus.primaryEntityId === id ? undefined : v.focus.primaryEntityId,
          primaryGroupId:  v.focus.primaryGroupId  === id ? undefined : v.focus.primaryGroupId,
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

    addGroup: (group: FocusGroup) =>
      setView(v => {
        if (v.focus.entities.some(e => e.id === group.id)) return v;
        if (v.focus.entities.length >= MAX_FOCUS_ENTITIES) return v;
        return markDirty({
          ...v,
          focus: {
            ...v.focus,
            entities: [
              ...v.focus.entities,
              group,
            ],
          },
        });
      }),

    // FIX-498 — patch a focused group in place (e.g. the server-resolved gb
    // name replacing the synthetic "Institution" placeholder once the group
    // fetch returns). Deliberately NOT markDirty: a server-side resolution is
    // not a user modification of the preset — same reasoning as setVizType.
    updateGroup: (id: string, options: Partial<FocusGroup>) =>
      setView(v => ({
        ...v,
        focus: {
          ...v.focus,
          entities: v.focus.entities.map(e =>
            (e.id === id && isFocusGroup(e)) ? { ...e, ...options } : e
          ),
        },
      })),

    removeGroup: (groupId: string) =>
      setView(v => markDirty({
        ...v,
        focus: {
          ...v.focus,
          entities: v.focus.entities.filter(e => e.id !== groupId),
          primaryEntityId: v.focus.primaryEntityId === groupId ? undefined : v.focus.primaryEntityId,
          primaryGroupId:  v.focus.primaryGroupId  === groupId ? undefined : v.focus.primaryGroupId,
        },
      })),

    /**
     * FIX-184 — toggle the pinned primary for a focus item. Pinning is
     * mutually exclusive within type (one entity + one group max). Clicking
     * an already-pinned item unpins it. Single-entity vizes (treemap,
     * sunburst, chord) read these refs first; if unset they fall back to
     * the last-added item.
     */
    togglePrimary: (id: string) =>
      setView(v => {
        const item = v.focus.entities.find(e => e.id === id);
        if (!item) return v;
        const isGroup = isFocusGroup(item);
        const currentKey = isGroup ? 'primaryGroupId' : 'primaryEntityId';
        const currentVal = isGroup ? v.focus.primaryGroupId : v.focus.primaryEntityId;
        const nextVal = currentVal === id ? undefined : id;
        return markDirty({
          ...v,
          focus: { ...v.focus, [currentKey]: nextVal },
        });
      }),

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

    /** Set a scalar option on the connections map (e.g. filterProcedural). */
    setConnectionOption: (key: string, value: unknown) =>
      setView(v => markDirty({
        ...v,
        connections: {
          ...v.connections,
          [key]: value,
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

    /** First focused FocusEntity (skips groups). For backward compat during G2/G3 migration. */
    primaryEntity: view.focus.entities.find(isFocusEntity) ?? null,

    /** True when at least one entity is focused. */
    hasFocus: view.focus.entities.length > 0,

    /** True when MAX_FOCUS_ENTITIES has been reached. */
    atMaxFocus: view.focus.entities.length >= MAX_FOCUS_ENTITIES,

    // ── Serialization ────────────────────────────────────────────────────────

    serialize: () => JSON.stringify({ version: '2.0', view }),
  };
}

export type UseGraphViewReturn = ReturnType<typeof useGraphView>;
