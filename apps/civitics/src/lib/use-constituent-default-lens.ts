"use client";

// Viewer-matched constituent lens default (FIX-574). The lens-bearing surfaces
// (PositionSection rollup, EntityComments cluster, CommentHighlightsStrip) each
// own an independent "all" | "constituents" lens with a manual toggle. By
// default they open on "all"; this hook lets a verified constituent of the
// entity's jurisdiction OPEN on the constituent lens instead — rewarding
// verification without hiding anything (the toggle still exposes both).
//
// Resolution is CLIENT-side (the host pages stay ISR/static — a per-user SSR
// read would defeat that caching). Order of escalation, cheapest first:
//   1. No jurisdiction id  → "all" (entity has no resolvable jurisdiction).
//   2. No local session    → "all" (anon majority pays NO status fetch — the
//                            getSession() read is local, no network).
//   3. Not a verified constituent (authoritative /api/constituent-status, which
//                            is RLS-scoped to the signed-in user) → "all".
//   4. Verified constituent → run the optional `probe` (empty-view fallback,
//                            decision 6): adopt "constituents" only if that
//                            lens actually has something to show, else "all".
//
// The surface seeds its OWN useState("all") and, when this hook resolves to
// "constituents", switches once — gated on a manual-override flag so a user who
// toggles before the async default lands is never yanked back (decision 4).
// Because `defaultLens` only becomes "constituents" AFTER the probe passes, the
// switch is a single clean transition with no empty-view flash (decision 5).

import { useEffect, useState } from "react";
import { createBrowserClient } from "@civitics/db";

export type Lens = "all" | "constituents";

export interface ConstituentDefaultLens {
  /** The viewer-matched seed: "constituents" only for a verified constituent
   *  whose constituent view cleared the (surface-specific) probe; else "all". */
  defaultLens: Lens;
  /** True once resolution has completed (or was short-circuited). The surface's
   *  apply-default effect waits on this so it never fires mid-resolution. */
  resolved: boolean;
}

/**
 * @param jurisdictionId  The entity's jurisdiction (jurisdiction page → itself;
 *   proposal/official/institution → its `jurisdiction_id`). `null` short-circuits
 *   to "all".
 * @param probe  Optional empty-view threshold check. Receives an AbortSignal and
 *   returns whether the constituent lens has enough to show on THIS surface
 *   (rollup n ≥ 10, comments ≥ 1, highlights ≥ 1). Threshold lives per-surface
 *   because each differs. Memoize it (useCallback) — it's an effect dependency.
 */
export function useConstituentDefaultLens(
  jurisdictionId: string | null,
  probe?: (signal: AbortSignal) => Promise<boolean>,
): ConstituentDefaultLens {
  const [state, setState] = useState<ConstituentDefaultLens>({
    defaultLens: "all",
    resolved: false,
  });

  useEffect(() => {
    if (!jurisdictionId) {
      setState({ defaultLens: "all", resolved: true });
      return;
    }

    let cancelled = false;
    const ctrl = new AbortController();
    const settle = (defaultLens: Lens) => {
      if (!cancelled) setState({ defaultLens, resolved: true });
    };

    void (async () => {
      // 1. Local session gate — no network. Anon viewers stop here.
      let signedIn = false;
      try {
        const supabase = createBrowserClient();
        const { data } = await supabase.auth.getSession();
        signedIn = !!data.session;
      } catch {
        // getSession unavailable → let the authoritative route decide.
        signedIn = true;
      }
      if (cancelled) return;
      if (!signedIn) {
        settle("all");
        return;
      }

      // 2. Authoritative constituent status (RLS-scoped to the signed-in user).
      let verified = false;
      try {
        const sp = new URLSearchParams({ jurisdiction_id: jurisdictionId });
        const res = await fetch(`/api/constituent-status?${sp.toString()}`, {
          signal: ctrl.signal,
          credentials: "same-origin",
        });
        const data = await res.json().catch(() => ({}));
        verified = res.ok && !!data.verified;
      } catch {
        verified = false;
      }
      if (cancelled) return;
      if (!verified) {
        settle("all");
        return;
      }

      // 3. Empty-view fallback — only a non-empty constituent view auto-adopts.
      if (!probe) {
        settle("constituents");
        return;
      }
      let pass = false;
      try {
        pass = await probe(ctrl.signal);
      } catch {
        pass = false;
      }
      settle(pass ? "constituents" : "all");
    })();

    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [jurisdictionId, probe]);

  return state;
}
