/**
 * FIX-890 — write-boundary vocabulary guard for drain tag results.
 *
 * WHY THIS EXISTS: `prompts/tag.md` already tells the worker "any tag outside
 * the list is a bug — drop it silently". That instruction was never enforced,
 * so out-of-vocab tags landed in `entity_tags` anyway: `aviation` (329 rows on
 * prod, since adopted as a real topic by FIX-889) plus four singleton tags
 * (`justice`, `small_business`, `homeland_security`, `infrastructure`). A
 * prompt is a request, not a constraint — the constraint belongs at the write
 * boundary, where a subagent's output cannot route around it.
 *
 * The guard checks the full `(entity_type, tag_category, tag)` triple, not just
 * the tag. That matters because the same string is legal in one category and
 * illegal in another: `technical` is a valid `quality` tag and an invalid
 * `topic` tag — which is exactly the FIX-889 bug, expressed as a rule.
 *
 * FAIL-OPEN on unknown entity types, deliberately. `enrichment_queue` already
 * carries `agency` rows (summary-only today, but tag tasks are a plausible
 * addition) and a future entity type with no vocabulary registered here should
 * degrade to "write it and warn", not "silently discard every tag". Rejecting
 * everything for an unregistered type would look identical to a working
 * pipeline right up until someone audited the row counts.
 */

import {
  VALID_TOPICS,
  ISSUE_AREAS,
  VALID_INDUSTRIES,
  COMPLEXITY_TAGS,
} from "../pipelines/tags/topics";

/**
 * entity_type -> tag_category -> allowed tags.
 *
 * An entity_type present here is ENFORCED: a category outside its map, or a
 * tag outside that category's list, is rejected. An entity_type absent here is
 * unenforced (see the fail-open note above).
 */
export const TAG_VOCABULARY: Record<string, Record<string, readonly string[]>> = {
  proposal: {
    topic: VALID_TOPICS,
    quality: COMPLEXITY_TAGS,
  },
  official: {
    // apply.ts writes official issue-areas under `topic` (the fallback
    // derivation); the drain prompt calls the same list `issue_areas`.
    topic: ISSUE_AREAS,
  },
  financial_entity: {
    industry: VALID_INDUSTRIES,
  },
};

export type VocabularyVerdict =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Is `(entityType, tagCategory, tag)` writable to entity_tags?
 *
 * Returns a reason string on rejection so the caller can log something
 * actionable rather than a bare count.
 */
export function checkTagVocabulary(
  entityType: string,
  tagCategory: string,
  tag: string,
): VocabularyVerdict {
  const byCategory = TAG_VOCABULARY[entityType];
  if (!byCategory) {
    // Unregistered entity type — fail open (documented above).
    return { allowed: true };
  }

  const allowedTags = byCategory[tagCategory];
  if (!allowedTags) {
    return {
      allowed: false,
      reason:
        `category '${tagCategory}' is not valid for entity_type '${entityType}' ` +
        `(valid: ${Object.keys(byCategory).join(", ")})`,
    };
  }

  if (!allowedTags.includes(tag)) {
    return {
      allowed: false,
      reason: `tag '${tag}' is not in the '${entityType}/${tagCategory}' vocabulary`,
    };
  }

  return { allowed: true };
}
