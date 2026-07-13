"use client";

/**
 * packages/graph/src/saved-views.ts — FIX-817
 *
 * User-saved custom views, persisted in localStorage under `civitics_presets`.
 * Before FIX-817 the right panel's "Save view…" wrote this key but nothing read
 * it back (the header viz dropdown's Custom section was an alert() stub), so
 * saved views were write-only and unreachable. This module is the read/write/
 * delete contract; GraphConfigPanel renders the list, GraphPage saves through it.
 *
 * Longer term this merges with the Browse W2 DB-backed saved-views concept
 * (FIX-763); localStorage is the interim store.
 */

import type { GraphView } from './types';
import { isFocusEntity } from './types';

const STORAGE_KEY = 'civitics_presets';

/** Fires on window after any save/delete so open panels re-read the list. */
export const SAVED_VIEWS_CHANGE_EVENT = 'civitics:saved-views-changed';

export interface SavedView extends GraphView {
  meta: {
    name: string;
    isPreset: true;
    presetId: string;
    isDirty: boolean;
  };
}

function isSavedViewLike(v: unknown): v is SavedView {
  if (!v || typeof v !== 'object') return false;
  const o = v as { focus?: unknown; style?: unknown; meta?: { presetId?: unknown; name?: unknown } };
  return !!o.focus && !!o.style && typeof o.meta?.presetId === 'string' && typeof o.meta?.name === 'string';
}

function notifyChange(): void {
  try { window.dispatchEvent(new Event(SAVED_VIEWS_CHANGE_EVENT)); } catch { /* SSR / no window */ }
}

/** Read all user-saved views. Call only after mount (reads localStorage). */
export function listSavedViews(): SavedView[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSavedViewLike);
  } catch {
    return [];
  }
}

/** Persist `view` as a named saved view. Returns the updated list. */
export function saveView(view: GraphView, name: string): SavedView[] {
  const saved: SavedView = {
    ...view,
    meta: {
      name: name.trim(),
      isPreset: true,
      // Date.now() is fine here — this runs in a click handler, never render.
      presetId: `user-${Date.now()}`,
      isDirty: false,
    },
  };
  const next = [...listSavedViews(), saved];
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  notifyChange();
  return next;
}

/** Delete a saved view by presetId. Returns the updated list. */
export function deleteSavedView(presetId: string): SavedView[] {
  const next = listSavedViews().filter(v => v.meta.presetId !== presetId);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  notifyChange();
  return next;
}

/**
 * FIX-812/817 back-compat clamp, applied when RESTORING a saved view.
 * A view saved before the G4 reorg may carry now-invalid state:
 *   - depth 3 → 2  (max graph depth was reduced to 2 in G4)
 *   - per-entity `highlight` flag → dropped (a placebo ForceGraph never read)
 *   - `scope` is already absent from the type (FIX-816); if present on a legacy
 *     blob it deserializes as an ignored excess property — nothing reads it.
 */
export function clampLegacyView(view: GraphView): GraphView {
  const depth = (view.focus.depth >= 3 ? 2 : view.focus.depth) as GraphView['focus']['depth'];
  return {
    ...view,
    focus: {
      ...view.focus,
      depth,
      entities: view.focus.entities.map(e => {
        if (!isFocusEntity(e) || !('highlight' in e)) return e;
        const clone = { ...e };
        delete (clone as { highlight?: unknown }).highlight;
        return clone;
      }),
    },
  };
}
