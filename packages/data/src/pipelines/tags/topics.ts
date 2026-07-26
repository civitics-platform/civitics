/**
 * Topic / issue-area vocabulary shared by the AI tagger and the enrichment
 * queue. Lives in its own file to avoid a cycle between ai-tagger.ts and
 * enrichment/queue.ts (both need these constants; ai-tagger pulls queue.ts
 * for its queue-mode branch).
 *
 * FIX-890: this module is now also the single source of truth for the drain
 * write-boundary vocabulary guard (drain/vocabulary.ts). Anything added here
 * becomes writable by the drain path; anything removed becomes rejected. Keep
 * it dependency-free so the guard can import it without dragging in `pg`.
 */

export const TOPIC_ICONS: Record<string, string> = {
  climate:             "🌊",
  healthcare:          "🏥",
  finance:             "📈",
  education:           "📚",
  housing:             "🏠",
  transportation:      "🚗",
  // FIX-889: `aviation` was emitted 329x by the drain path while outside the
  // vocabulary. Adopted as a real topic rather than folded into
  // `transportation` because (a) 183 of those rows ALREADY carry a
  // `transportation` tag too — the model uses it as a refinement, not a
  // substitute, so folding it in would collide on the (entity_type, entity_id,
  // tag, tag_category) unique constraint and destroy 183 rows for zero net
  // topic gain; (b) the corpus is a large coherent regulatory stream (FAA
  // Airworthiness Directives, Airspace Designations) that outranks 6 existing
  // topics by volume; (c) packages/graph/src/icons.tsx already registers
  // `aviation: Plane` in its Issue-keys block, so the render layer treats it
  // as first-class already.
  aviation:            "✈️",
  agriculture:         "🌾",
  energy:              "⚡",
  defense:             "🛡",
  technology:          "💻",
  labor:               "👷",
  immigration:         "🌍",
  civil_rights:        "⚖️",
  veterans:            "🎖",
  food_safety:         "🍽",
  consumer_protection: "🛡",
  environment:         "🌊",
  public_health:       "🏥",
  trade:               "🤝",
  other:               "📋",
};

export const VALID_TOPICS = Object.keys(TOPIC_ICONS);

/**
 * @deprecated ORPHANED by FIX-896 — zero references as of this commit.
 *
 * This was the allowed vocabulary for the official issue-area classifier, which
 * is retired (an official is not a document; see tags/ai-tagger.ts header).
 * Its three consumers all went with it: classifyOfficial(),
 * buildOfficialTagContext(), and `official.topic` in drain/vocabulary.ts —
 * where the entry is now `official: {}` so the guard REJECTS rather than
 * fail-opens.
 *
 * Deliberately left exported pending Craig's call on deleting it: removing a
 * public export is a wider blast radius than this PR's scope, and keeping it
 * costs nothing but a symbol. Do NOT re-wire it into a write path — anything
 * that feeds this list back to a model is re-introducing the retired feature.
 */
export const ISSUE_AREAS = [
  "healthcare", "climate", "finance", "education", "defense",
  "technology", "labor", "agriculture", "housing", "immigration",
  "civil_rights", "veterans", "energy", "trade",
];

/**
 * Proposal complexity classification — `tag_category='quality'`, NOT `topic`
 * (FIX-889/890). ai-tagger.ts has always written these under `quality`; the
 * drain path wrote them under `topic`, which is the bug FIX-889 re-categorized.
 * Named here so the drain vocabulary guard can enforce the split at the write
 * boundary rather than trusting the worker prompt.
 */
export const COMPLEXITY_TAGS = ["technical", "accessible"] as const;

/**
 * Valid industry tags for financial entities. Moved here from
 * enrichment/queue.ts by FIX-890 so the drain vocabulary guard can import a
 * dependency-free vocabulary module — queue.ts pulls in `pg` via
 * lib/heavy-rebuild, which the guard must not drag into every drain submit.
 * queue.ts re-exports it, so existing importers are unaffected.
 */
export const VALID_INDUSTRIES = [
  "pharma", "oil_gas", "finance", "tech", "defense",
  "real_estate", "labor", "agriculture", "legal",
  "retail", "transportation", "lobby",
] as const;
