/**
 * FIX-399 — shared registry of data-source labels + categories.
 *
 * Shape is intentionally extensible: FIX-400 will add `license` / `citation` /
 * `backlink_template` fields onto the same entries for the SourceDetailPopover
 * and the /about/sources disclosure page. Keep entries object-shaped so
 * downstream additions are non-breaking — never collapse to a flat label
 * lookup.
 *
 * Tailwind color classes are presentation, not data — those live in the UI
 * layer (apps/civitics/...). This module exports category strings only.
 */
export type SourceCategory = "federal" | "state" | "local" | "community" | "other";

export type SourceRegistryEntry = {
  label: string;
  category: SourceCategory;
};

export type ResolvedSource = SourceRegistryEntry & {
  /** The source key as resolved (after legistar:* prefix parsing, etc.). */
  key: string;
  /** True when the source key was unknown to the registry. */
  unknown: boolean;
};

/**
 * Concrete sources written into `external_source_refs.source` and the
 * materialized `<entity>.primary_source` columns. Keep entries 1:1 with the
 * SOURCE_URL_TEMPLATES keys in `types/attribution.ts` where they overlap;
 * registry can hold more (federal-register, govtrack, etc. that don't yet
 * have URL templates) but a key present here AND in SOURCE_URL_TEMPLATES
 * must have the same canonical label.
 */
const SOURCE_REGISTRY: Record<string, SourceRegistryEntry> = {
  // ── Federal ─────────────────────────────────────────────────────────
  congress_gov:           { label: "Congress.gov",   category: "federal" },
  fec:                    { label: "FEC",            category: "federal" },
  fec_bulk:               { label: "FEC",            category: "federal" },
  fec_bulk_indiv:         { label: "FEC",            category: "federal" },
  fec_bulk_ie:            { label: "FEC",            category: "federal" },
  fec_bulk_indiv_to_committee: { label: "FEC",       category: "federal" },
  regulations_gov:        { label: "Regulations.gov", category: "federal" },
  courtlistener:          { label: "CourtListener", category: "federal" },
  usaspending:            { label: "USAspending",   category: "federal" },
  usaspending_recipient:  { label: "USAspending",   category: "federal" },
  irs_990:                { label: "IRS 990",       category: "federal" },
  sec_edgar:              { label: "SEC EDGAR",     category: "federal" },
  edgar:                  { label: "SEC EDGAR",     category: "federal" },
  federal_register:       { label: "Federal Register", category: "federal" },
  govtrack:               { label: "GovTrack",      category: "federal" },
  opm:                    { label: "OPM",           category: "federal" },
  plum_book:              { label: "Plum Book",     category: "federal" },

  // ── State ───────────────────────────────────────────────────────────
  openstates:             { label: "OpenStates",    category: "state" },

  // ── Community ───────────────────────────────────────────────────────
  littlesis:              { label: "LittleSis",     category: "community" },
  opensecrets:            { label: "OpenSecrets",   category: "community" },
};

function titleCaseSegment(segment: string): string {
  if (!segment) return segment;
  return segment
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Resolve a `source` value as written in `external_source_refs.source` /
 * `<entity>.primary_source` to a display label + category. Unknown sources
 * return `{ label: <raw key>, category: 'other', unknown: true }` rather
 * than throwing — the badge still renders, and the unknown source is
 * greppable in the diagnostic output for registry follow-ups.
 *
 * Special-case: `legistar:<city>:<type>` (e.g. `legistar:seattle:person`)
 * parses to `Legistar <City>` + `local`.
 */
export function resolveSource(sourceKey: string): ResolvedSource {
  if (!sourceKey) {
    return { key: sourceKey, label: sourceKey, category: "other", unknown: true };
  }

  if (sourceKey.startsWith("legistar:")) {
    const parts = sourceKey.split(":");
    const city = parts[1] ?? "";
    const cityLabel = titleCaseSegment(city);
    return {
      key: sourceKey,
      label: cityLabel ? `Legistar ${cityLabel}` : "Legistar",
      category: "local",
      unknown: false,
    };
  }

  const entry = SOURCE_REGISTRY[sourceKey];
  if (entry) {
    return { key: sourceKey, label: entry.label, category: entry.category, unknown: false };
  }

  return { key: sourceKey, label: sourceKey, category: "other", unknown: true };
}
