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

// FIX-896/900 — ISSUE_AREAS lived here: the 14-value allowed vocabulary for the
// official issue-area classifier. That feature is retired (an official is not a
// document — see tags/ai-tagger.ts header), and all three consumers went with
// it: classifyOfficial(), buildOfficialTagContext(), and `official.topic` in
// drain/vocabulary.ts, where the entry is now `official: {}` so the guard
// REJECTS rather than fail-opens. FIX-900 deleted the orphaned export.
//
// Do NOT reintroduce this list. Anything that feeds a fixed set of policy areas
// to a model to pick from, for an entity whose text we do not hold, is the
// retired feature wearing a new name. Officials get DERIVED industry labels from
// donation sector affinity instead — see tagOfficials() in ./rules.ts (FIX-897).

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
 *
 * THIS ARRAY IS THE WRITE BOUNDARY. drain/vocabulary.ts sets
 * `TAG_VOCABULARY.financial_entity.industry = VALID_INDUSTRIES` (FIX-890), so a
 * key added here becomes writable by the drain path and a key removed here
 * becomes rejected. rules.ts assertIndustryVocabulary() throws on any rollup
 * value outside it. Do not add a key without a matching INDUSTRY_LABELS entry —
 * the paired test asserts key-completeness in both directions.
 *
 * FIX-908: expanded 12 → 16. The dollar-weighted audit (2026-07-27) found no tag
 * above 79% accuracy and a 41% median, and the dominant error was not dirty
 * keywords — it was that the classifier forced a 12-way choice with NO bucket
 * for electric utilities, industrial manufacturing, chemicals, autos, steel,
 * mining or media. Asked to place Duke Energy PAC into the old twelve, a model
 * answers `oil_gas` and is not wrong to; that single gap is the largest error
 * mass in eight of the twelve tags. `utilities` / `manufacturing` / `mining` /
 * `media` are the four buckets that absorb it.
 *
 * Adding a key here does NOT re-assign any existing donor. The curated override
 * list that actually moves donors into these buckets is a separate change.
 */
export const VALID_INDUSTRIES = [
  "health", "oil_gas", "finance", "tech", "defense",
  "real_estate", "labor", "agriculture", "legal",
  "retail", "transportation", "lobby",
  "utilities", "manufacturing", "mining", "media",
] as const;

export type Industry = (typeof VALID_INDUSTRIES)[number];

/**
 * THE single source of truth for industry key → display label + icon.
 *
 * FIX-908 consolidated four independent copies of this map that had already
 * drifted apart: pipelines/tags/rules.ts (INDUSTRY_LABELS),
 * pipelines/tags/ai-classifier.ts (INDUSTRY_LABELS, which additionally carried
 * an `other` key that is NOT in VALID_INDUSTRIES), and
 * pipelines/enrichment/queue.ts (INDUSTRY_DISPLAY). All three now import from
 * here. Four copies of a vocabulary is exactly how the next drift happens.
 *
 * The UI layer keeps its own key→lucide-component registry in
 * packages/graph/src/icons.tsx — a genuinely different type (React components,
 * and apps/civitics has no dependency edge to @civitics/data). It mirrors the
 * KEY LIST in packages/graph/src/industries.ts, and industry-vocabulary.test.ts
 * reads that file off disk and fails if the two key sets ever diverge.
 *
 * `icon` is the emoji written to entity_tags.display_icon by the taggers.
 */
export const INDUSTRY_LABELS: Record<Industry, { label: string; icon: string }> = {
  // FIX-908: `pharma` → `health`, a blanket key rename, not a re-scoping. The
  // entire keyword list feeding the tag is health-sector (pharma, drug, medical,
  // health, biotech, physician, hospital, healthcare, medicine, surgical,
  // dental, optometry, nursing) and the audit measured the tag at 20.4%
  // pharmaceutical but 91.2% health-sector — its largest components are
  // hospital/physician associations (32.0%), health trade associations (20.7%)
  // and health insurers (11.6%). `pharma` was the wrong name for its own
  // contents, so the rename is correct for the unaudited tail as well.
  health:         { label: "Health Care",                   icon: "🏥" },

  // FIX-908: PINNED NARROW — do NOT widen this to "Energy & Utilities". Renaming
  // it would take the tag from 40.7% to 91.8% honest and would be the cheap
  // win, but it destroys the money_vote_influence HR 26 measure in the same
  // move, because that claim needs FOSSIL-FUEL money specifically. The audit
  // shows a coherent fossil core (upstream 18.0% + refining 9.1% + pipeline
  // 6.0% + trade assoc 3.7% + fuel marketing 2.8% + oilfield services 1.0% of
  // tag dollars); the honest fix is to move the UTILITIES out, not to relabel
  // the tag around them. industry-vocabulary.test.ts pins this string so a
  // future widening has to delete an explicit assertion rather than drift into
  // it.
  oil_gas:        { label: "Oil & Gas",                     icon: "🛢" },

  // Labels widened where the measured contents justify it; keys unchanged.
  finance:        { label: "Finance & Insurance",           icon: "📈" },
  tech:           { label: "Technology & Communications",   icon: "💻" },
  defense:        { label: "Defense & Aerospace",           icon: "🛡" },
  real_estate:    { label: "Real Estate & Construction",    icon: "🏠" },
  labor:          { label: "Labor",                         icon: "👷" },
  agriculture:    { label: "Agriculture & Food",            icon: "🌾" },
  legal:          { label: "Legal & Professional Services", icon: "⚖️" },
  retail:         { label: "Consumer Goods & Services",     icon: "🛒" },
  transportation: { label: "Transportation",                icon: "🚛" },
  lobby:          { label: "Advocacy & Lobbying",           icon: "🏛" },

  // ── FIX-908: the four new buckets ──────────────────────────────────────────
  // Deliberately seeded with NO keyword rules and NO NAICS mapping beyond the
  // sector-correct NAICS fixes in rules.ts. They are vocabulary-only here: the
  // classifier may now REACH them, and the curated override list may now write
  // them. Nothing in this change re-assigns an existing donor into one.
  utilities:      { label: "Utilities",                     icon: "⚡" },
  manufacturing:  { label: "Manufacturing",                 icon: "🏭" },
  mining:         { label: "Mining & Metals",               icon: "⛏" },
  media:          { label: "Media & Entertainment",         icon: "📰" },
};

/**
 * Label/icon lookup for callers holding an UNVALIDATED key — a DB row, a NAICS
 * mapping, or model output. Returns undefined rather than widening
 * INDUSTRY_LABELS to `Record<string, …>`, so the typed map keeps catching a
 * missing key at compile time while runtime strings get an honest miss.
 */
export function industryDisplay(key: string): { label: string; icon: string } | undefined {
  return (INDUSTRY_LABELS as Record<string, { label: string; icon: string }>)[key];
}
