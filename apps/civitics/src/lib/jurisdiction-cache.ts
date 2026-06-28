import { withDbTimeout } from "@/lib/supabase-check";

// FIX-683 — a jurisdiction/district's membership in jurisdiction_page_cache
// (FIX-663) IS the content-bearing signal: the cache holds exactly the
// jurisdictions the refresh predicate covers (type IN country/state OR has active
// officials/institutions / any proposals / active child / meetings). A PK EXISTS
// on that table is the cheap test the empty-leaf noindex (generateMetadata) and
// the heavy-RPC skip (the page) both use — one source of truth, no re-derived
// content logic to drift from refresh_jurisdiction_page_cache().

export type JurisdictionCacheLookup = {
  // true  = a content-bearing member (keep indexed; render from cache).
  // false = a definitely-empty leaf (noindex; render the light shell).
  // null  = the lookup DEGRADED (timeout/error). Callers FAIL OPEN — treat as a
  //         member: stay indexed and run the live path, never deindex / blank a
  //         real page on a DB hiccup.
  isMember: boolean | null;
  // The cached get_jurisdiction_page payload when present (selectPayload=true),
  // else null — lets the page render a member straight from the cache table
  // without re-calling the RPC wrapper.
  payload: unknown | null;
};

export async function lookupJurisdictionCache(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  id: string,
  selectPayload = false,
): Promise<JurisdictionCacheLookup> {
  const { data, error } = await withDbTimeout(
    supabase
      .from("jurisdiction_page_cache")
      .select(selectPayload ? "jurisdiction_id, payload" : "jurisdiction_id")
      .eq("jurisdiction_id", id)
      .maybeSingle() as PromiseLike<{
      data: { jurisdiction_id: string; payload?: unknown } | null;
      error: unknown;
    }>,
    3000,
    "jurisdiction:cache-membership",
  );
  // withDbTimeout returns { data: null, error } on timeout; maybeSingle returns
  // { data: null, error: null } for a genuine miss. Distinguish the two so a
  // hiccup fails open (isMember null) and a real miss is an empty leaf (false).
  if (error) return { isMember: null, payload: null };
  return {
    isMember: Boolean(data),
    payload: (data as { payload?: unknown } | null)?.payload ?? null,
  };
}
