/**
 * FIX-1247 — the contract surfaces' NAICS fallback label, as ONE table.
 *
 * THE SOURCE OF TRUTH IS THE SQL. `chord_contract_flows_full()`,
 * `treemap_recipients_by_contracts_full()` and both CTEs of
 * `refresh_contract_flow_rollups()` label an untagged contract recipient by
 * `CASE SUBSTRING(<naics_code> FROM 1 FOR 2) WHEN '11' THEN 'Agriculture' …
 * ELSE 'Other' END` (latest definition:
 * supabase/migrations/20260930000000_fix1247_contract_display_labels.sql).
 * This is that CASE, arm for arm, for the one surface that computes it in TS —
 * the Sankey route, which scans financial_relationships directly. Before
 * FIX-1247 the route carried its own copy that disagreed with the SQL on seven
 * prefixes (53, 55, 56, 62, 71, 72, 92), so one recipient could be two sectors
 * depending on the chart.
 *
 * Kept honest by a test, not by discipline: naics-sector-label.test.ts parses
 * the LAST migration that carries the CASE off disk and fails if a WHEN arm or
 * the ELSE differs from this table.
 *
 * A tagged recipient never reaches this: every surface takes the tag's
 * display_label (an INDUSTRY_LABELS value) first.
 */

/** NAICS 2-digit prefix → the contract-surface label. Mirrors the SQL CASE. */
export const NAICS_SECTOR_LABELS: Readonly<Record<string, string>> = {
  "11": "Agriculture",
  "21": "Mining",
  "22": "Utilities",
  "23": "Construction",
  "31": "Manufacturing",
  "32": "Manufacturing",
  "33": "Manufacturing",
  "42": "Wholesale Trade",
  "44": "Retail",
  "45": "Retail",
  "48": "Transportation",
  "49": "Transportation",
  "51": "Information Technology",
  "52": "Finance",
  "53": "Real Estate",
  "54": "Professional Services",
  "55": "Management",
  "56": "Administrative Services",
  "61": "Education",
  "62": "Healthcare",
  "71": "Arts & Entertainment",
  "72": "Hospitality",
  "81": "Other Services",
  "92": "Government",
};

/** The CASE's ELSE — also what a missing code resolves to (SUBSTRING(NULL) matches no arm). */
export const NAICS_SECTOR_OTHER = "Other";

/** The contract-surface label for a NAICS code, exactly as the SQL CASE computes it. */
export function naicsSectorLabel(naics: string | null | undefined): string {
  if (!naics) return NAICS_SECTOR_OTHER;
  return NAICS_SECTOR_LABELS[naics.slice(0, 2)] ?? NAICS_SECTOR_OTHER;
}
