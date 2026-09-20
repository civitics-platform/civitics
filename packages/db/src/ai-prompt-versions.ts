/**
 * packages/db/src/ai-prompt-versions.ts
 *
 * THE single source of truth for ai_summary_cache prompt versions (FIX-938).
 *
 * WHY THIS LIVES IN packages/db:
 * exactly the reason ai-pricing.ts does. The producers that write
 * ai_summary_cache live in three different workspaces — packages/ai,
 * packages/data and apps/civitics — and packages/db is the lowest package in
 * the graph, reachable from all three with no new edges. A constant that has to
 * agree across every producer cannot live in any one of them.
 *
 * This module must stay dependency-free — no supabase, no node builtins.
 *
 * WHAT A VERSION IS ATTACHED TO
 * -----------------------------
 * The CACHE KEY, not the prompt. `(entity_type, summary_type)` is one content
 * contract — "what a plain-language summary of a proposal says" — and THREE
 * different prompt texts write into it:
 *
 *   (proposal, plain_language)  ← packages/data/src/pipelines/ai-summaries
 *                               ← apps/civitics/app/api/proposals/[id]/summary
 *                               ← packages/data/src/drain/prompts/summary.md
 *   (official,  profile)        ← packages/data/src/pipelines/ai-summaries
 *                               ← apps/civitics/app/api/officials/[id]/summary
 *                               ← packages/data/src/drain/prompts/summary.md
 *
 * A reader of a cached row cannot tell which of the three produced it (that is
 * the FIX-931 observation, and the reason the first two are kept byte-identical
 * to each other). So versioning any ONE of them would make the other two's
 * output look stale, and the cache would thrash between producers. The version
 * belongs to the pair, and EVERY producer of that pair stamps the same value.
 *
 * THE RULE
 * --------
 * Change the wording of ANY prompt that writes a pair  →  bump that pair here,
 * in the same commit. The generate paths read
 * `prompt_version = summaryPromptVersion(...)`, so a row stamped with an older
 * version is a cache MISS and is regenerated, replacing the row in place. That
 * is the whole mechanism: before FIX-938 a prompt fix shipped and every already
 * cached entity kept the old framing forever, because the cache was keyed on
 * the entity alone and "never regenerate if a row exists" (0005's header).
 *
 * The drain prompt files carry the pair's version in a
 * `<!-- prompt-version: … -->` header on their first line, and
 * drain-prompt-version.test.ts asserts the header matches this map. The header
 * is documentation with an alarm on it — nothing parses it at runtime — so that
 * editing the .md without bumping the constant fails CI instead of silently
 * serving an old framing under a current version.
 *
 * FORMAT: a date, `YYYY-MM-DD`, suffixed `.N` if a pair is bumped twice in one
 * day. Orderable and self-documenting. `legacy` is reserved (see below).
 */

/**
 * Rows written before FIX-938 existed. It is the column DEFAULT, so a producer
 * that forgets to stamp a version writes a visibly-unversioned row rather than
 * a falsely-current one. No pair may ever use this as its current version.
 */
export const LEGACY_PROMPT_VERSION = "legacy";

/**
 * Current version per `entity_type:summary_type`.
 *
 * 2026-09-20 — FIX-938's initial stamp. The prompt TEXT is unchanged by
 * FIX-938, so the 6,888 rows already in the table were backfilled to this same
 * value rather than to `legacy`: they were produced by the prompts that are in
 * the tree today, and stamping them stale would have forced ~6,888
 * regenerations (~$11 at Haiku 4.5 rates) against a $4/month platform spend cap
 * for no change in framing. The mechanism this FIX buys applies to the NEXT
 * prompt edit, which is what the bullet asked for.
 */
export const SUMMARY_PROMPT_VERSIONS: Readonly<Record<string, string>> = {
  // The four pairs the live producers write. Only the first has rows today.
  "proposal:plain_language": "2026-09-20",
  "official:profile": "2026-09-20",
  "agency:profile": "2026-09-20",
  "financial:profile": "2026-09-20",

  // packages/ai#generateSummary's own vocabulary. It passes its `type` argument
  // ('bill' | 'regulation' | 'official') straight through as summary_type, which
  // matches nothing in the table — and on 2026-09-20 it has no callers at all,
  // only comment references from the two on-demand routes that reimplement it.
  // Registered anyway so that wiring it up later cannot silently start writing
  // rows stamped 'unregistered', which no version bump would ever invalidate.
  "proposal:bill": "2026-09-20",
  "proposal:regulation": "2026-09-20",
  "official:official": "2026-09-20",
};

/**
 * The version a producer must stamp, and a reader must filter on, for this
 * cache key.
 *
 * An unregistered pair falls back to `UNREGISTERED_PROMPT_VERSION` rather than
 * throwing: a summary written for a pair nobody registered is still a summary,
 * and taking down a producer over a bookkeeping gap would be worse than serving
 * it. The value is distinct from every real version, so such rows are greppable
 * and never collide with a registered pair's cache.
 */
export const UNREGISTERED_PROMPT_VERSION = "unregistered";

export function summaryPromptVersion(
  entityType: string,
  summaryType: string,
): string {
  return (
    SUMMARY_PROMPT_VERSIONS[`${entityType}:${summaryType}`] ??
    UNREGISTERED_PROMPT_VERSION
  );
}
