/**
 * FIX-399 / FIX-400 — shared registry of data-source labels, categories, and
 * license metadata.
 *
 * FIX-400 extension: `license` / `license_url` / `homepage_url` / `citation`
 * on `SourceRegistryEntry` for the SourceDetailPopover and the /about/sources
 * disclosure page. License values are asserted ONLY where confirmed (federal
 * works under 17 U.S.C. § 105 = public domain; LittleSis CC-BY-SA 4.0).
 * Sources whose license we have not confirmed leave `license` undefined and
 * supply a `license_url` linking to the source's own terms — the UI should
 * render "See <label> terms" in that case rather than asserting a string.
 *
 * Tailwind color classes are presentation, not data — those live in the UI
 * layer (apps/civitics/...). This module exports category strings only.
 */
export type SourceCategory = "federal" | "state" | "local" | "community" | "other";

export type SourceRegistryEntry = {
  label: string;
  category: SourceCategory;
  /**
   * Display string for the license (e.g. "CC-BY-SA 4.0", "Public domain
   * (U.S. Government work)"). Leave undefined when the source's license is
   * unconfirmed — the UI will fall back to a link to `license_url`.
   */
  license?: string;
  license_url?: string;
  homepage_url?: string;
  /** Optional citation phrase the source requests (e.g. attribution clause). */
  citation?: string;
};

export type ResolvedSource = SourceRegistryEntry & {
  /** The source key as resolved (after legistar:* prefix parsing, etc.). */
  key: string;
  /** True when the source key was unknown to the registry. */
  unknown: boolean;
};

const FEDERAL_PUBLIC_DOMAIN = "Public domain (U.S. Government work)";
// 17 U.S.C. § 105 — works prepared by an officer or employee of the U.S.
// Government as part of their official duties are not subject to copyright.
const FEDERAL_PUBLIC_DOMAIN_URL = "https://www.law.cornell.edu/uscode/text/17/105";

const CC_BY_SA_4_URL = "https://creativecommons.org/licenses/by-sa/4.0/";

/**
 * Verbatim CC-BY-SA 4.0 attribution required by FIX-252 for LittleSis-derived
 * data. Kept as a single exported constant so legal can revise it in one
 * place. Rendered verbatim on /about/sources and reachable from any
 * LittleSis-sourced entity's popover via the "About our sources →" link.
 */
export const LITTLESIS_ATTRIBUTION_TEXT =
  "Some relationship and network data on Civitics is derived from LittleSis " +
  "(https://littlesis.org), © LittleSis contributors, licensed under Creative " +
  "Commons Attribution-ShareAlike 4.0 International (CC-BY-SA 4.0). Civitics' " +
  "modifications and presentation of this data are likewise available under CC-BY-SA 4.0.";

/**
 * Concrete sources written into `external_source_refs.source` and the
 * materialized `<entity>.primary_source` columns. Keep entries 1:1 with the
 * SOURCE_URL_TEMPLATES keys in `types/attribution.ts` where they overlap;
 * registry can hold more (federal-register, govtrack, etc. that don't yet
 * have URL templates) but a key present here AND in SOURCE_URL_TEMPLATES
 * must have the same canonical label.
 *
 * Note: every entry for a federal source asserts public-domain status — this
 * is the position under 17 U.S.C. § 105 for U.S. Government works.
 */
export const SOURCE_REGISTRY: Record<string, SourceRegistryEntry> = {
  // ── Federal (public domain under 17 U.S.C. § 105) ───────────────────
  congress_gov: {
    label: "Congress.gov", category: "federal",
    license: FEDERAL_PUBLIC_DOMAIN, license_url: FEDERAL_PUBLIC_DOMAIN_URL,
    homepage_url: "https://www.congress.gov",
  },
  fec: {
    label: "FEC", category: "federal",
    license: FEDERAL_PUBLIC_DOMAIN, license_url: FEDERAL_PUBLIC_DOMAIN_URL,
    homepage_url: "https://www.fec.gov",
  },
  fec_bulk: {
    label: "FEC", category: "federal",
    license: FEDERAL_PUBLIC_DOMAIN, license_url: FEDERAL_PUBLIC_DOMAIN_URL,
    homepage_url: "https://www.fec.gov/data/browse-data/?tab=bulk-data",
  },
  fec_bulk_indiv: {
    label: "FEC", category: "federal",
    license: FEDERAL_PUBLIC_DOMAIN, license_url: FEDERAL_PUBLIC_DOMAIN_URL,
    homepage_url: "https://www.fec.gov/data/browse-data/?tab=bulk-data",
  },
  fec_bulk_ie: {
    label: "FEC", category: "federal",
    license: FEDERAL_PUBLIC_DOMAIN, license_url: FEDERAL_PUBLIC_DOMAIN_URL,
    homepage_url: "https://www.fec.gov/data/browse-data/?tab=bulk-data",
  },
  fec_bulk_indiv_to_committee: {
    label: "FEC", category: "federal",
    license: FEDERAL_PUBLIC_DOMAIN, license_url: FEDERAL_PUBLIC_DOMAIN_URL,
    homepage_url: "https://www.fec.gov/data/browse-data/?tab=bulk-data",
  },
  regulations_gov: {
    label: "Regulations.gov", category: "federal",
    license: FEDERAL_PUBLIC_DOMAIN, license_url: FEDERAL_PUBLIC_DOMAIN_URL,
    homepage_url: "https://www.regulations.gov",
  },
  courtlistener: {
    // Free Law Project / CourtListener — federal court opinions and dockets;
    // primary content is government work in the public domain. The
    // metadata-overlay (judge bios, normalized citations) is from FLP under
    // their own terms; this surface ingests opinion+docket metadata only.
    label: "CourtListener", category: "federal",
    license: FEDERAL_PUBLIC_DOMAIN, license_url: FEDERAL_PUBLIC_DOMAIN_URL,
    homepage_url: "https://www.courtlistener.com",
  },
  usaspending: {
    label: "USAspending", category: "federal",
    license: FEDERAL_PUBLIC_DOMAIN, license_url: FEDERAL_PUBLIC_DOMAIN_URL,
    homepage_url: "https://www.usaspending.gov",
  },
  usaspending_recipient: {
    label: "USAspending", category: "federal",
    license: FEDERAL_PUBLIC_DOMAIN, license_url: FEDERAL_PUBLIC_DOMAIN_URL,
    homepage_url: "https://www.usaspending.gov",
  },
  irs_990: {
    label: "IRS 990", category: "federal",
    license: FEDERAL_PUBLIC_DOMAIN, license_url: FEDERAL_PUBLIC_DOMAIN_URL,
    homepage_url: "https://www.irs.gov/charities-non-profits/form-990-series-downloads",
  },
  sec_edgar: {
    label: "SEC EDGAR", category: "federal",
    license: FEDERAL_PUBLIC_DOMAIN, license_url: FEDERAL_PUBLIC_DOMAIN_URL,
    homepage_url: "https://www.sec.gov/edgar",
  },
  edgar: {
    label: "SEC EDGAR", category: "federal",
    license: FEDERAL_PUBLIC_DOMAIN, license_url: FEDERAL_PUBLIC_DOMAIN_URL,
    homepage_url: "https://www.sec.gov/edgar",
  },
  federal_register: {
    label: "Federal Register", category: "federal",
    license: FEDERAL_PUBLIC_DOMAIN, license_url: FEDERAL_PUBLIC_DOMAIN_URL,
    homepage_url: "https://www.federalregister.gov",
  },
  opm: {
    label: "OPM", category: "federal",
    license: FEDERAL_PUBLIC_DOMAIN, license_url: FEDERAL_PUBLIC_DOMAIN_URL,
    homepage_url: "https://www.opm.gov",
  },
  plum_book: {
    label: "Plum Book", category: "federal",
    license: FEDERAL_PUBLIC_DOMAIN, license_url: FEDERAL_PUBLIC_DOMAIN_URL,
    homepage_url: "https://www.govinfo.gov/help/plum-book",
  },
  // GovTrack ingests government data but presents it under their own terms.
  // Don't assert public domain — link to their terms instead.
  govtrack: {
    label: "GovTrack", category: "federal",
    license_url: "https://www.govtrack.us/about",
    homepage_url: "https://www.govtrack.us",
  },

  // ── State ───────────────────────────────────────────────────────────
  // OpenStates ingest licensing has varied historically. We have not
  // re-verified the current terms — link to their about page so users can
  // confirm directly.
  openstates: {
    label: "OpenStates", category: "state",
    license_url: "https://openstates.org/about/",
    homepage_url: "https://openstates.org",
  },

  // ── Community ───────────────────────────────────────────────────────
  // LittleSis — CC-BY-SA 4.0. This entry is the legal basis for the
  // verbatim attribution shipped on /about/sources (FIX-252).
  littlesis: {
    label: "LittleSis", category: "community",
    license: "CC-BY-SA 4.0",
    license_url: CC_BY_SA_4_URL,
    homepage_url: "https://littlesis.org",
    citation: LITTLESIS_ATTRIBUTION_TEXT,
  },
  // OpenSecrets bulk data has restrictive terms — link to their legal page.
  opensecrets: {
    label: "OpenSecrets", category: "community",
    license_url: "https://www.opensecrets.org/about/legal-info",
    homepage_url: "https://www.opensecrets.org",
  },
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
 * `<entity>.primary_source` to a display label + category + license metadata.
 * Unknown sources return `{ label: <raw key>, category: 'other', unknown: true }`
 * rather than throwing — the badge still renders, and the unknown source is
 * greppable in the diagnostic output for registry follow-ups.
 *
 * Special-case: `legistar:<city>:<type>` (e.g. `legistar:seattle:person`)
 * parses to `Legistar <City>` + `local`. Legistar feeds are city-published
 * legislative records — we don't assert a license here (cities vary); the
 * popover will fall back to the "no license info" presentation.
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
      homepage_url: "https://www.legistar.com",
    };
  }

  const entry = SOURCE_REGISTRY[sourceKey];
  if (entry) {
    return { ...entry, key: sourceKey, unknown: false };
  }

  return { key: sourceKey, label: sourceKey, category: "other", unknown: true };
}
