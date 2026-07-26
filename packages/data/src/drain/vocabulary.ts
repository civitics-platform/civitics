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
 *
 * That fail-open is exactly why FIX-896 set `official: {}` instead of DELETING
 * the `official` key. Retiring the official AI tagger means no official tag may
 * be written by the drain path at all — and deleting the key would have made
 * `official` an *unregistered* type, i.e. silently re-permitted every write the
 * retirement exists to stop. An empty category map keeps the type ENFORCED with
 * an empty valid set, so every official tag is rejected with a reason naming it.
 */

import {
  VALID_TOPICS,
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
  // FIX-896 — officials are ENFORCED with an EMPTY valid set: no tag_category,
  // and therefore no tag, is writable to an official from the drain path. This
  // key must NOT be deleted (see the fail-open note in the module header).
  // Officials get derived industry labels from tagOfficials() in
  // pipelines/tags/rules.ts, which writes over direct pg and never passes here.
  official: {},
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
    // FIX-896: `official: {}` lands here for EVERY category, so the reason has
    // to read sensibly when the valid set is empty — "(valid: )" would look like
    // a formatting bug rather than a deliberate retirement.
    const validCategories = Object.keys(byCategory);
    return {
      allowed: false,
      reason:
        validCategories.length === 0
          ? `entity_type '${entityType}' has an empty tag vocabulary — no tag ` +
            `category is writable for it (category '${tagCategory}' rejected)`
          : `category '${tagCategory}' is not valid for entity_type '${entityType}' ` +
            `(valid: ${validCategories.join(", ")})`,
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
