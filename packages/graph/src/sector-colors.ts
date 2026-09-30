/**
 * FIX-1247 — the colour of a contract-surface sector label, in ONE place.
 *
 * Since FIX-1247 the contract chord (SpendingGraph's sector bars), the treemap
 * (SpendingGraph's recipient bars) and the Sankey (SankeyGraph's sector tier)
 * all carry one vocabulary: a tagged recipient's industry display label
 * (INDUSTRY_LABELS, e.g. "Defense & Aerospace") or, for an untagged one, the
 * NAICS fallback label from the SQL CASE (e.g. "Construction"). Before it, the
 * chord and treemap carried the lowercase tag KEY for tagged recipients, and the
 * two components each kept a colour map keyed on NAICS labels only — so every
 * tagged sector drew in the default slate, and the two maps disagreed on hues
 * for the same label.
 *
 * Resolution order:
 *   1. an industry label (current or historical, any casing) → its key's colour
 *      (INDUSTRY_KEY_COLORS). Since FIX-1254 the CASE emits the industry label
 *      itself for the seven sectors that map 1:1 (Agriculture & Food, Mining &
 *      Metals, Consumer Goods & Services, Technology & Communications, Finance &
 *      Insurance, Real Estate & Construction, Health Care), and Manufacturing,
 *      Transportation and Utilities already were one. The pre-FIX-1254 strings
 *      (Finance, Healthcare, Retail, Agriculture, Real Estate) still resolve
 *      here through LABEL_TO_KEY's historical entries, for a rollup written
 *      before the rename.
 *   2. a NAICS-only label → NAICS_LABEL_COLORS.
 *   3. anything else → the default steel-slate.
 *
 * NAICS_LABEL_COLORS must name every NAICS label the SQL CASE can emit that
 * step 1 does not resolve; apps/civitics/src/lib/naics-sector-label.test.ts
 * reads this file off disk and checks.
 */

import { industryLabelColor } from "./industries";

/** NAICS fallback labels that are not also an industry label. Token strings (FIX-729). */
export const NAICS_LABEL_COLORS: Readonly<Record<string, string>> = {
  // Historical (pre-FIX-1254): the CASE now emits "Mining & Metals" and
  // "Technology & Communications", which step 1 resolves. Kept, like
  // LABEL_TO_KEY's historical labels, for a rollup written before the rename.
  "Mining":                  "rgb(var(--c-accent))",
  "Information Technology":  "rgb(var(--c-viz-2))",
  "Construction":            "rgb(var(--c-amber))",
  "Wholesale Trade":         "rgb(var(--c-viz-7))",
  "Professional Services":   "rgb(var(--c-viz-7))",
  "Management":              "rgb(var(--c-viz-4))",
  "Administrative Services": "rgb(var(--c-viz-8))",
  "Education":               "rgb(var(--c-viz-9))",
  "Arts & Entertainment":    "rgb(var(--c-accent))",
  "Hospitality":             "rgb(var(--c-viz-3))",
  "Other Services":          "rgb(var(--c-ink-soft))",
  "Government":              "rgb(var(--c-viz-5))",
  "Other":                   "rgb(var(--c-viz-5))",
};

/** Default for a label neither map knows. */
export const SECTOR_COLOR_DEFAULT = "rgb(var(--c-viz-5))";

/** The colour of a contract-surface sector label (industry label or NAICS fallback label). */
export function contractSectorColor(label: string): string {
  return industryLabelColor(label) ?? NAICS_LABEL_COLORS[label] ?? SECTOR_COLOR_DEFAULT;
}
