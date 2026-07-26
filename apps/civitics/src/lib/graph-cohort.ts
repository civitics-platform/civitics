/**
 * apps/civitics/src/lib/graph-cohort.ts
 *
 * Pure cohort admission rules for /api/graph/group's official branch, split out
 * of the route so they are unit-testable (the route itself has no test harness —
 * it needs a Next request + an admin Supabase client).
 *
 * Two concerns live here:
 *
 *   FIX-886 — parsing the hand-picked `officialIds` cohort (validate, dedup, cap).
 *   FIX-887 — refusing degenerate/oversized cohorts on the LIVE aggregation path
 *             before get_cohort_top_donors() runs.
 *
 * ── What the FIX-887 measurements actually showed (prod, 2026-07-25) ─────────
 *
 * Cohort SIZE is a weak predictor of cost; donor-edge DENSITY is the real
 * driver. Measured warm against prod via get_cohort_top_donors(ids, 25):
 *
 *   50 senators            →   0.5s        437 House members  →  5.0s
 *   100 senators           →   1.1s        537 federal        → 17-27s
 *   1,000 mixed officials  →   0.6s        5,000 mixed        →  1.5s
 *
 * i.e. 437 dense federal members cost 8× what 5,000 sparse ones do, and a
 * genuinely cold House cohort exceeded 30s. So this cap is NOT a latency
 * control — the latency controls are the FIX-500 rollup (which serves every
 * full-chamber cohort off a materialized top-N and never reaches this path) and
 * the FIX-497 fail-closed contract (which turns a 57014 into a flagged, retryable
 * bubble instead of a convincing empty). What the cap IS: a backstop against a
 * cohort that is degenerate as an ANSWER — "top donors to 27,753 officials" is
 * not a fact about any group the user chose, however fast it returns.
 *
 * Prod cohort census behind MAX_LIVE_COHORT (2026-07-25):
 *   all active officials     27,753   ← degenerate; what FIX-886's bug produced
 *   party=republican          9,345   ← largest cohort a real affordance emits
 *   party=democrat            8,248
 *   state=CA / state=TX       ~1,180
 *   House roster                437   ← largest dense live cohort (rollup miss)
 * 15,000 sits 1.6× above the largest legitimate cohort and 1.85× below the
 * degenerate one.
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

/** FIX-887 — see the header note. Compared against the RESOLVED cohort size. */
export const MAX_LIVE_COHORT = 15_000;

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

export type CohortGuardInput = {
  /** True when the cohort came from a governing body (gb / committee / chamber alias). */
  hasGoverningBody: boolean;
  hasParty: boolean;
  hasState: boolean;
  hasOfficialIds: boolean;
  /** Exact cohort size as resolved (officials count, not the 1000-id slice). */
  memberCount: number;
};

export type CohortGuardVerdict =
  | { ok: true }
  | { ok: false; error: "filter_too_broad" | "cohort_too_large"; reason: string; memberCount: number };

/**
 * FIX-887 — admission check for the LIVE get_cohort_top_donors() path. Callers
 * must NOT apply this to the FIX-500 rollup path: a materialized cohort is a
 * single indexed top-N read regardless of member count, so refusing Full Senate
 * there would break a working, cheap surface.
 */
export function checkLiveCohort(input: CohortGuardInput): CohortGuardVerdict {
  const { hasGoverningBody, hasParty, hasState, hasOfficialIds, memberCount } = input;

  // (1) Legacy no-gb path with no narrowing whatsoever = "every active official".
  // Never a legitimate group; today it is reachable only through the FIX-886
  // handoff bug and hand-built URLs.
  if (!hasGoverningBody && !hasParty && !hasState && !hasOfficialIds) {
    return {
      ok: false,
      error: "filter_too_broad",
      reason:
        "an official group needs at least one narrowing filter (governingBody, party, state, or officialIds) — " +
        "aggregating every active official is not a group",
      memberCount,
    };
  }

  // (2) Narrowed, but still larger than any cohort a real affordance produces.
  if (memberCount > MAX_LIVE_COHORT) {
    return {
      ok: false,
      error: "cohort_too_large",
      reason:
        `this cohort resolves to ${memberCount.toLocaleString("en-US")} officials, above the ` +
        `${MAX_LIVE_COHORT.toLocaleString("en-US")} limit for a live donor aggregation — narrow it further`,
      memberCount,
    };
  }

  return { ok: true };
}
