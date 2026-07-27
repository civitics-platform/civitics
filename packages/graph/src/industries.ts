/**
 * FIX-908 — the UI-layer mirror of the donor-industry vocabulary.
 *
 * THE SOURCE OF TRUTH IS `packages/data/src/pipelines/tags/topics.ts`
 * (VALID_INDUSTRIES + INDUSTRY_LABELS). This file exists only because there is
 * no dependency edge that reaches every consumer: `apps/civitics` depends on
 * `@civitics/graph` and `@civitics/db` but NOT on `@civitics/data`, and
 * `@civitics/graph` is a React/d3 package that the pipeline package must not
 * import. Rather than let the app hand-maintain a third copy — which is exactly
 * what `CANONICAL_INDUSTRY_TOKENS` in apps/civitics/src/lib/browse/graph-compiler.ts
 * was — the key list is declared once HERE and imported by every UI consumer.
 *
 * The two files are kept honest by a test, not by discipline:
 * `packages/data/src/pipelines/tags/industry-vocabulary.test.ts` reads THIS FILE
 * off disk and fails if its key set differs from VALID_INDUSTRIES. If you add a
 * key upstream and forget this file, that test goes red.
 *
 * Deliberately dependency-free — no React, no lucide — so anything can import it.
 */

/**
 * The canonical `entity_tags.tag` values for
 * `(entity_type='financial_entity', tag_category='industry')`.
 *
 * Must equal VALID_INDUSTRIES in topics.ts, in any order. Values are
 * lowercase/snake_case and are matched case-sensitively against the column.
 */
export const INDUSTRY_KEYS = [
  "health", "oil_gas", "finance", "tech", "defense",
  "real_estate", "labor", "agriculture", "legal",
  "retail", "transportation", "lobby",
  "utilities", "manufacturing", "mining", "media",
] as const;

export type IndustryKey = (typeof INDUSTRY_KEYS)[number];

const INDUSTRY_KEY_SET: ReadonlySet<string> = new Set(INDUSTRY_KEYS);

export function isIndustryKey(value: string): value is IndustryKey {
  return INDUSTRY_KEY_SET.has(value);
}

/**
 * Display label → canonical key.
 *
 * Some surfaces only ever see the LABEL, never the key: `get_crossgroup_sector_totals`
 * returns `official_sector_dollars_mv.sector_label` (a MIN() over
 * `entity_tags.display_label`) with no tag column alongside it, so
 * /api/graph/chord's cross-group mode has to map back from the label to pick an
 * icon. That map used to be a hand-written table of labels that had already gone
 * stale ('Healthcare', 'Energy', 'Retail & Food' were never our labels), so
 * every lookup silently fell through to the generic icon.
 *
 * Includes the CURRENT labels plus the historical ones, because a rollup
 * refreshed before a label change still carries the old string. Keys are
 * lowercased at lookup time — see labelToIndustryKey.
 */
const LABEL_TO_KEY: Record<string, IndustryKey> = {
  // Current labels (must match INDUSTRY_LABELS in topics.ts).
  "health care": "health",
  "oil & gas": "oil_gas",
  "finance & insurance": "finance",
  "technology & communications": "tech",
  "defense & aerospace": "defense",
  "real estate & construction": "real_estate",
  "labor": "labor",
  "agriculture & food": "agriculture",
  "legal & professional services": "legal",
  "consumer goods & services": "retail",
  "transportation": "transportation",
  "advocacy & lobbying": "lobby",
  "utilities": "utilities",
  "manufacturing": "manufacturing",
  "mining & metals": "mining",
  "media & entertainment": "media",

  // Historical labels still present in rollups refreshed before FIX-908.
  "pharma": "health",
  "healthcare": "health",
  "health": "health",
  "finance": "finance",
  "tech": "tech",
  "defense": "defense",
  "real estate": "real_estate",
  "agriculture": "agriculture",
  "legal": "legal",
  "retail": "retail",
  "retail & food": "retail",
  "lobby": "lobby",
  "lobby / advocacy": "lobby",
  "energy": "oil_gas",
};

/** Resolve a display label (any casing) to a canonical industry key, or null. */
export function labelToIndustryKey(label: string): IndustryKey | null {
  return LABEL_TO_KEY[label.trim().toLowerCase()] ?? null;
}
