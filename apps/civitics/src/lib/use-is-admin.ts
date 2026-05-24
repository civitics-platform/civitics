"use client";

/**
 * Shared admin-gate hook (FIX-347). Replaces the three inline `useIsAdmin`
 * function bodies that all read `window.CIVITICS_ADMIN` — a surface that
 * was never wired up, so `isAdmin` always returned false and the admin
 * surfaces in PlatformCostsSection (per-metric Verify/Update buttons) and
 * ModerationSection have been silently dead.
 *
 * On mount, calls GET /api/admin/me — which gates on the same cookie-based
 * ADMIN_EMAIL match used by the other /api/admin/* routes. 200 → isAdmin=true,
 * 404/error → isAdmin=false.
 *
 * Module-level in-flight cache: multiple components mounting in the same
 * tree share one fetch instead of fanning out.
 */

import { useEffect, useState } from "react";

type AdminState = { isAdmin: boolean; loading: boolean };

let cached: { isAdmin: boolean } | null = null;
let inflight: Promise<{ isAdmin: boolean }> | null = null;

async function fetchAdminState(): Promise<{ isAdmin: boolean }> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch("/api/admin/me", { credentials: "same-origin" });
      const result = { isAdmin: res.ok };
      cached = result;
      return result;
    } catch {
      const result = { isAdmin: false };
      cached = result;
      return result;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function useIsAdmin(): AdminState {
  const [state, setState] = useState<AdminState>(() =>
    cached ? { isAdmin: cached.isAdmin, loading: false } : { isAdmin: false, loading: true },
  );

  useEffect(() => {
    if (cached) {
      setState({ isAdmin: cached.isAdmin, loading: false });
      return;
    }
    let active = true;
    void fetchAdminState().then((res) => {
      if (active) setState({ isAdmin: res.isAdmin, loading: false });
    });
    return () => {
      active = false;
    };
  }, []);

  return state;
}
