// Shared entity-wide constituent lens (FIX-658/657) — the pure substrate.
//
// FIX-574 gave each lens-bearing surface (PositionSection rollup, EntityComments
// cluster, CommentHighlightsStrip, and now QASection — FIX-656) its OWN
// useState("all") lens, so toggling one surface didn't move the others and a
// manual choice didn't survive navigation. This module lifts the lens to ONE
// synchronized value per entity, keyed `${entityType}:${entityId}`, held in a
// module-level store so sibling client islands on an ISR page sync without a
// React context provider (there's no shared parent to hang one on).
//
// This file is deliberately React-free, fetch-free, and next-free: the
// adoption/override/persist ORDERING is a pure reducer (reduceLens) plus a tiny
// module store, unit-tested in entity-lens.test.ts. The React binding
// (useSyncExternalStore) and the constituent-status fetch cache live in the
// companion use-entity-lens.ts.

export type Lens = "all" | "constituents";

export interface LensState {
  readonly lens: Lens;
  /** True once a manual toggle OR a persisted preference has locked the lens
   *  against the async viewer-match default (decisions 3, 8). Monotonic: once
   *  true it never returns to false, so a late-arriving auto-default can never
   *  yank a surface after the user (or their stored choice) has spoken. */
  readonly overridden: boolean;
}

export const DEFAULT_LENS_STATE: LensState = Object.freeze({ lens: "all", overridden: false });

export type LensEvent =
  // localStorage seed applied at store-entry creation (decision 8).
  | { readonly type: "stored-pref"; readonly lens: Lens }
  // A deliberate toggle on ANY surface (decision 3).
  | { readonly type: "manual"; readonly lens: Lens }
  // A surface's viewer-match probe resolved to "constituents" (decision 4).
  | { readonly type: "auto-default"; readonly lens: Lens };

/**
 * The single source of truth for lens ordering (decisions 3, 4, 8, 9):
 *   - stored-pref  → seeds the lens AND locks it (skips viewer-match entirely).
 *   - manual       → entity-wide override; beats any auto-default, any time.
 *   - auto-default → first passing probe adopts, UNLESS already overridden.
 * Pure: same (prev, ev) always yields the same next state.
 */
export function reduceLens(prev: LensState, ev: LensEvent): LensState {
  switch (ev.type) {
    case "stored-pref":
    case "manual": {
      if (prev.lens === ev.lens && prev.overridden) return prev;
      return { lens: ev.lens, overridden: true };
    }
    case "auto-default": {
      if (prev.overridden) return prev;
      if (prev.lens === ev.lens) return prev;
      return { lens: ev.lens, overridden: false };
    }
    default:
      return prev;
  }
}

// ─── localStorage preference (FIX-657) ─────────────────────────────────────────
// A single GLOBAL key (not per-entity, not a DB/profile pref): the user's last
// deliberate lens choice, reapplied on every entity. Written ONLY on a manual
// toggle — choosing "Everyone" is as deliberate as choosing "Constituents".
// Cross-device staleness is acceptable for a pre-revenue nicety (decision 7).

export const LENS_PREF_KEY = "civitics:lens-pref";

export function readStoredLensPref(): Lens | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(LENS_PREF_KEY);
    return v === "all" || v === "constituents" ? v : null;
  } catch {
    return null;
  }
}

export function writeStoredLensPref(lens: Lens): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LENS_PREF_KEY, lens);
  } catch {
    /* private mode / quota / storage disabled — a nicety, never fatal */
  }
}

// ─── Module store, keyed per entity ────────────────────────────────────────────

type Entry = { state: LensState; listeners: Set<() => void> };
const entries = new Map<string, Entry>();

export function lensKey(entityType: string, entityId: string): string {
  return `${entityType}:${entityId}`;
}

// Lazily create an entry, seeding it from the stored preference at creation time
// (decision 8): a present pref makes the entry born overridden, which the async
// resolution then skips. Absent → default "all", not overridden.
function ensureEntry(key: string): Entry {
  let e = entries.get(key);
  if (!e) {
    const pref = readStoredLensPref();
    e = {
      state: pref
        ? reduceLens(DEFAULT_LENS_STATE, { type: "stored-pref", lens: pref })
        : DEFAULT_LENS_STATE,
      listeners: new Set(),
    };
    entries.set(key, e);
  }
  return e;
}

export function getLensState(key: string): LensState {
  return ensureEntry(key).state;
}

export function subscribeLens(key: string, cb: () => void): () => void {
  const e = ensureEntry(key);
  e.listeners.add(cb);
  return () => {
    e.listeners.delete(cb);
  };
}

export function dispatchLens(key: string, ev: LensEvent): void {
  const e = ensureEntry(key);
  const next = reduceLens(e.state, ev);
  // Reference-stable when nothing changed — required so useSyncExternalStore's
  // getSnapshot doesn't loop, and so no-op events don't wake subscribers.
  if (next.lens === e.state.lens && next.overridden === e.state.overridden) return;
  e.state = next;
  for (const l of e.listeners) l();
}

/** Test-only: clear the module store between cases. */
export function __resetLensStore(): void {
  entries.clear();
}
