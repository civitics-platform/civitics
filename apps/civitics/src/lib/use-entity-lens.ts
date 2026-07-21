"use client";

// React binding for the shared entity lens (FIX-658) + the constituent-status
// fetch dedupe (decision 4). See entity-lens.ts for the pure store/reducer.

import { useCallback, useSyncExternalStore } from "react";
import {
  DEFAULT_LENS_STATE,
  dispatchLens,
  getLensState,
  lensKey,
  subscribeLens,
  writeStoredLensPref,
  type Lens,
} from "./entity-lens";

export interface EntityLensControls {
  lens: Lens;
  /** True once a manual toggle or a stored preference has locked the lens — the
   *  surface passes this through to short-circuit its viewer-match resolution. */
  overridden: boolean;
  /** Manual toggle from any surface: persists the choice (FIX-657) and
   *  entity-wide-overrides the async default (decision 3). */
  setLens: (lens: Lens) => void;
  /** A surface's viewer-match probe resolved to "constituents": adopt unless a
   *  manual/stored override already locked the lens (decision 4). Never persists —
   *  an auto-default is the platform's suggestion, not the user's choice. */
  adoptConstituents: () => void;
}

const noopSubscribe = () => () => {};

/**
 * Subscribe a surface to the entity's shared lens.
 * @param enabled  When false the surface is inert (decision 5): it stays "all",
 *   never subscribes to or mutates the store, and its setters are no-ops.
 */
export function useEntityLens(
  entityType: string,
  entityId: string,
  enabled: boolean,
): EntityLensControls {
  const key = lensKey(entityType, entityId);

  const subscribe = useCallback(
    (cb: () => void) => (enabled ? subscribeLens(key, cb) : noopSubscribe()),
    [key, enabled],
  );
  const getSnapshot = useCallback(
    () => (enabled ? getLensState(key) : DEFAULT_LENS_STATE),
    [key, enabled],
  );
  // Server + hydration render use the default ("all") snapshot; a stored pref of
  // "constituents" surfaces post-hydration via useSyncExternalStore's own
  // client-swap (no hydration-mismatch error — that's its contract).
  const state = useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_LENS_STATE);

  const setLens = useCallback(
    (lens: Lens) => {
      if (!enabled) return;
      writeStoredLensPref(lens);
      dispatchLens(key, { type: "manual", lens });
    },
    [key, enabled],
  );
  const adoptConstituents = useCallback(() => {
    if (!enabled) return;
    dispatchLens(key, { type: "auto-default", lens: "constituents" });
  }, [key, enabled]);

  return { lens: state.lens, overridden: state.overridden, setLens, adoptConstituents };
}

// ─── Constituent-status promise cache (decision 4) ─────────────────────────────
// Every lens surface runs its own viewer-match resolution; without dedupe a
// signed-in constituent's page fires /api/constituent-status once per surface
// (3-4x). Cache the in-flight promise per jurisdiction id so the surfaces share a
// single round-trip. Anon viewers never reach here — useConstituentDefaultLens'
// local getSession() gate short-circuits before any status fetch — so this keeps
// the zero-network anon guarantee intact.
const statusCache = new Map<string, Promise<boolean>>();

export function getConstituentStatus(jurisdictionId: string): Promise<boolean> {
  let p = statusCache.get(jurisdictionId);
  if (!p) {
    p = (async () => {
      try {
        const sp = new URLSearchParams({ jurisdiction_id: jurisdictionId });
        const res = await fetch(`/api/constituent-status?${sp.toString()}`, {
          credentials: "same-origin",
        });
        const data = await res.json().catch(() => ({}));
        return res.ok && !!data.verified;
      } catch {
        return false;
      }
    })();
    statusCache.set(jurisdictionId, p);
  }
  return p;
}
