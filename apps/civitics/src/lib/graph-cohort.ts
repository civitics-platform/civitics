/**
 * apps/civitics/src/lib/graph-cohort.ts
 *
 * Pure cohort admission rules for /api/graph/group's official branch, split out
 * of the route so they are unit-testable (the route itself has no test harness —
 * it needs a Next request + an admin Supabase client).
 *
 * FIX-886 — parsing the hand-picked `officialIds` cohort (validate, dedup, cap).
 */

/** Canonical UUID form. Mirrors the route's own UUID_RE. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * FIX-886 — hand-picked cohort cap. 50 UUIDs ≈ 1.9KB of query string, safely
 * under every edge/proxy URL limit (the FIX-772 FIN_CHUNK 414 lesson), and 50
 * SENATORS — the densest 50 members that exist — measured 0.5s warm / 2.1s cold
 * on prod, comfortably inside the service_role 8s statement timeout.
 */
export const MAX_GROUP_OFFICIAL_IDS = 50;

export type OfficialIdsParse =
  | { ok: true; ids: string[] }
  | { ok: false; error: "officialIds_invalid" | "officialIds_too_many"; reason: string; count?: number };

/**
 * Parse the `officialIds` query param into a validated, deduped, capped id list.
 *
 * Returns `ok:true, ids:[]` for an absent/blank param — "no ids mode requested"
 * is not an error, it just means the caller wants filter-based resolution. An
 * ids param that is PRESENT but yields nothing usable IS an error: silently
 * falling back to filter resolution is exactly the FIX-886 bug (a request that
 * names members answering about the whole platform instead).
 */
export function parseOfficialIds(raw: string | null): OfficialIdsParse {
  if (raw == null) return { ok: true, ids: [] };
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return { ok: true, ids: [] };

  const bad = parts.filter((p) => !UUID_RE.test(p));
  if (bad.length > 0) {
    return {
      ok: false,
      error: "officialIds_invalid",
      reason: `officialIds must be a comma-separated list of UUIDs — ${bad.length} value(s) are not`,
    };
  }

  const ids = [...new Set(parts.map((p) => p.toLowerCase()))];
  if (ids.length > MAX_GROUP_OFFICIAL_IDS) {
    return {
      ok: false,
      error: "officialIds_too_many",
      reason: `a hand-picked group is limited to ${MAX_GROUP_OFFICIAL_IDS} officials (received ${ids.length})`,
      count: ids.length,
    };
  }
  return { ok: true, ids };
}
