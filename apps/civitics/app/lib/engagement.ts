/**
 * FIX-618 — read layer + tiering for the DISPLAY-ONLY entity engagement rollup
 * (entity_engagement_rollup_mv). Powers the Claimed / Engaged / Active-community
 * badges and the "Most engaged" officials sort.
 *
 * FIX-633: the rollup now also carries endorsed_count — questions resolved by an
 * endorsed community note rather than a written answer. answers_count stays
 * written-answers-only, so the base "Responsive" tier fires on a written answer
 * OR an endorsement, while the high "Highly responsive" tier stays
 * written-answers-only to keep it distinct.
 *
 * DISPLAY-ONLY: nothing here feeds standing or integrity. It is a read over a
 * nightly MV plus pure label/sort helpers. Generic over the three accountable
 * entity types so PR B2 (institutions/jurisdictions) reuses it unchanged.
 *
 * Thresholds were chosen after a shape query on the real local distribution
 * (FIX-618). Today only ~3 officials have any Q&A interaction, so the tiers are
 * deliberately forward-looking but never fire on noise:
 *
 *   answers_count distribution (officials w/ activity): {1, 1, 1}  (max 1)
 *   answered_rate:                                       {0.14, 1.0, 1.0}
 *   community_count_30d:                                 {34, 1, 1}
 *
 * "Engaged" leads on ABSOLUTE answers_count, not answered_rate — a single
 * answer at rate 1.0 (n=1) must not outrank a real office answering 1-of-7, so
 * answered_rate only gates the top tier.
 */

import { withDbTimeout } from "@/lib/supabase-check";

export type EngagementEntityType = "official" | "institution" | "jurisdiction";

/** One row of entity_engagement_rollup_mv (display-only). */
export type EngagementRollup = {
  isClaimed: boolean;
  answersCount: number;
  questionsCount: number;
  answeredRate: number; // 0..1
  endorsedCount: number; // FIX-633: questions resolved by an endorsed community note
  lastAnswerAt: string | null;
  communityCount30d: number;
  lastActivityAt: string | null;
};

export const EMPTY_ENGAGEMENT: EngagementRollup = {
  isClaimed: false,
  answersCount: 0,
  questionsCount: 0,
  answeredRate: 0,
  endorsedCount: 0,
  lastAnswerAt: null,
  communityCount30d: 0,
  lastActivityAt: null,
};

// ── Tier thresholds (see header for the shape query that justifies them) ──────
const ENGAGED_RESPONSIVE_MIN = 1; // ≥1 answer → the office responds
const ENGAGED_HIGH_MIN = 5; // ≥5 answers AND…
const ENGAGED_HIGH_RATE = 0.5; // …≥50% of questions answered → top tier
const COMMUNITY_ACTIVE_MIN = 5; // ≥5 non-answer comments in 30d
const COMMUNITY_THRIVING_MIN = 20; // ≥20 → top tier

export type EngagedTier = { level: "high" | "base"; label: string } | null;
export type CommunityTier = { level: "high" | "base"; label: string } | null;

/** Engaged (responsiveness) tier, or null when the office has not answered. */
export function engagedTier(e: EngagementRollup): EngagedTier {
  if (e.answersCount >= ENGAGED_HIGH_MIN && e.answeredRate >= ENGAGED_HIGH_RATE) {
    return { level: "high", label: "Highly responsive" };
  }
  // FIX-633: endorsing a community note is an official act of responsiveness
  // ("✓ Endorsed by the office"), so it lifts the base Responsive badge — but NOT
  // the high tier, which stays written-answers-only to keep that tier distinct.
  if (e.answersCount >= ENGAGED_RESPONSIVE_MIN || e.endorsedCount >= 1) {
    return { level: "base", label: "Responsive" };
  }
  return null;
}

/** Active-community tier, or null when there is no recent citizen activity. */
export function communityTier(e: EngagementRollup): CommunityTier {
  if (e.communityCount30d >= COMMUNITY_THRIVING_MIN) {
    return { level: "high", label: "Thriving community" };
  }
  if (e.communityCount30d >= COMMUNITY_ACTIVE_MIN) {
    return { level: "base", label: "Active community" };
  }
  return null;
}

/**
 * "Most engaged" ordering. Returns <0 when `a` should sort before `b`.
 * Display-only; not a standing score.
 *
 * Order: total responses (answers_count + endorsed_count, FIX-633) → written
 * answers as the tie-break → surrounding activity (community_count_30d) →
 * answered_rate → recency of last answer. answered_rate
 * sits BELOW community on purpose: with a tied small answers_count, a 1-of-1
 * office (rate 1.0) must not outrank a busier 1-of-7 office with a large active
 * community — the same small-sample guard the Engaged tier applies.
 */
export function compareEngagement(a: EngagementRollup, b: EngagementRollup): number {
  // FIX-633: total responses (written answers + endorsements) leads; among equal
  // totals, more written answers wins.
  const ra = a.answersCount + a.endorsedCount;
  const rb = b.answersCount + b.endorsedCount;
  if (ra !== rb) return rb - ra;
  if (a.answersCount !== b.answersCount) return b.answersCount - a.answersCount;
  if (a.communityCount30d !== b.communityCount30d) return b.communityCount30d - a.communityCount30d;
  if (a.answeredRate !== b.answeredRate) return b.answeredRate - a.answeredRate;
  const ta = a.lastAnswerAt ? Date.parse(a.lastAnswerAt) : 0;
  const tb = b.lastAnswerAt ? Date.parse(b.lastAnswerAt) : 0;
  return tb - ta;
}

/** True when an entity has at least one badge to show (claimed/engaged/community). */
export function hasAnyBadge(e: EngagementRollup): boolean {
  return e.isClaimed || engagedTier(e) !== null || communityTier(e) !== null;
}

const ROLLUP_COLUMNS =
  "entity_id, is_claimed, answers_count, questions_count, answered_rate, endorsed_count, last_answer_at, community_count_30d, last_activity_at";

/* eslint-disable @typescript-eslint/no-explicit-any */
function toRollup(r: any): EngagementRollup {
  return {
    isClaimed: r.is_claimed ?? false,
    answersCount: r.answers_count ?? 0,
    questionsCount: r.questions_count ?? 0,
    answeredRate: typeof r.answered_rate === "number" ? r.answered_rate : Number(r.answered_rate ?? 0),
    endorsedCount: r.endorsed_count ?? 0,
    lastAnswerAt: r.last_answer_at ?? null,
    communityCount30d: r.community_count_30d ?? 0,
    lastActivityAt: r.last_activity_at ?? null,
  };
}

/**
 * Fetch ALL rollup rows for one entity type (no id filter). Returns a Map keyed
 * by entity_id. The rollup only ever holds rows for entities with an engagement
 * signal (a claim or any Q&A/comment activity), so this set is small and bounded
 * — NOT one row per official. Use this for the officials INDEX, where filtering
 * by the ~1000 loaded ids would build a ~40KB `in(...)` URL that the gateway
 * rejects (silently zeroing every badge). `supabase` is any-typed because the MV
 * isn't in the generated DB types yet (same cast the entity_tags fetch uses).
 */
export async function fetchAllEngagementRollup(
  supabase: any,
  entityType: EngagementEntityType,
): Promise<Map<string, EngagementRollup>> {
  const out = new Map<string, EngagementRollup>();
  const { data, error } = await withDbTimeout<{ data: any; error: any }>(
    supabase
      // db-timeout-exempt: wrapped — generic-typed withDbTimeout<…>( the lexical guard's regex misses
      .from("entity_engagement_rollup_mv")
      .select(ROLLUP_COLUMNS)
      .eq("entity_type", entityType),
    3000,
    "engagement:all-rollup",
  );
  if (error) {
    // Display-only signal — never break the page over a missing/stale MV.
    console.error("engagement rollup fetch error:", error.message);
    return out;
  }
  for (const r of (data ?? []) as any[]) out.set(r.entity_id as string, toRollup(r));
  return out;
}

/**
 * Fetch rollup rows for a SMALL set of entity ids (e.g. a single detail page, or
 * PR B2's institution/jurisdiction cards). Do NOT call with the full officials
 * index id list — see fetchAllEngagementRollup for why. Returns a Map keyed by
 * entity_id; missing ids simply aren't in the map (→ EMPTY).
 */
export async function fetchEngagementRollup(
  supabase: any,
  entityType: EngagementEntityType,
  entityIds: string[],
): Promise<Map<string, EngagementRollup>> {
  const out = new Map<string, EngagementRollup>();
  if (entityIds.length === 0) return out;

  const { data, error } = await withDbTimeout<{ data: any; error: any }>(
    supabase
      // db-timeout-exempt: wrapped — generic-typed withDbTimeout<…>( the lexical guard's regex misses
      .from("entity_engagement_rollup_mv")
      .select(ROLLUP_COLUMNS)
      .eq("entity_type", entityType)
      .in("entity_id", entityIds),
    3000,
    "engagement:rollup-by-ids",
  );

  if (error) {
    console.error("engagement rollup fetch error:", error.message);
    return out;
  }

  for (const r of (data ?? []) as any[]) out.set(r.entity_id as string, toRollup(r));
  return out;
}
