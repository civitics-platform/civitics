/**
 * FIX-398 — shared types for the data-attribution surface.
 *
 * AttributionShape is what every detail-page SSR response carries (officials,
 * proposals, donors, agencies). NULL-tolerant by design: `primary` is null
 * when the entity has no xsr binding. Most financial_entities fall into the
 * null bucket because FEC dedup is structurally outside external_source_refs.
 *
 * AttributionDetailResponse is the full xsr expansion returned by the
 * lazy-fetched /api/attribution/[type]/[id] route (consumed by the
 * FIX-400 popover).
 *
 * SOURCE_URL_TEMPLATES is the fallback for xsr rows whose source_url column
 * is null — derive a backlink from the external_id when the template exists,
 * else return null (don't synthesize broken URLs).
 */

export type AttributionPrimary = {
  source: string;
  source_url: string | null;
  last_seen_at: string;
};

export type AttributionShape = {
  primary: AttributionPrimary | null;
  source_count: number;
  detail_endpoint: string;
};

export type AttributionDetailSource = {
  source: string;
  external_id: string;
  source_url: string | null;
  last_seen_at: string;
  priority: number;
  is_primary: boolean;
  metadata: Record<string, unknown>;
};

export type AttributionDetailResponse = {
  primary: AttributionPrimary | null;
  sources: AttributionDetailSource[];
  source_count: number;
};

export type AttributionEntityType =
  | "official"
  | "proposal"
  | "agency"
  | "governing_body"
  | "financial_entity";

export const ATTRIBUTION_ENTITY_TYPES: readonly AttributionEntityType[] = [
  "official",
  "proposal",
  "agency",
  "governing_body",
  "financial_entity",
] as const;

/**
 * Backlink templates keyed by (source, entity_type). When external_source_refs.source_url
 * is null, the API route derives a URL from `{external_id}`. Unknown
 * (source, entity_type) combos return null — never synthesize a broken URL.
 */
export const SOURCE_URL_TEMPLATES: Record<string, Partial<Record<AttributionEntityType, string>>> = {
  congress_gov: {
    official: "https://www.congress.gov/member/{external_id}",
    proposal: "https://www.congress.gov/bill/{external_id}",
  },
  fec: {
    financial_entity: "https://www.fec.gov/data/committee/{external_id}/",
  },
  littlesis: {
    financial_entity: "https://littlesis.org/entity/{external_id}",
    official: "https://littlesis.org/entity/{external_id}",
  },
  openstates: {
    official: "https://openstates.org/person/{external_id}/",
    proposal: "https://openstates.org/bill/{external_id}/",
  },
  regulations_gov: {
    proposal: "https://www.regulations.gov/document/{external_id}",
  },
  courtlistener: {
    proposal: "https://www.courtlistener.com/opinion/{external_id}/",
  },
  usaspending_recipient: {
    financial_entity: "https://www.usaspending.gov/recipient/{external_id}/latest",
  },
  irs_990: {
    financial_entity: "https://projects.propublica.org/nonprofits/organizations/{external_id}",
  },
  sec_edgar: {
    financial_entity: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={external_id}",
  },
  edgar: {
    financial_entity: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={external_id}",
  },
};

export function deriveSourceUrl(
  source: string,
  entityType: AttributionEntityType,
  externalId: string,
  existingUrl: string | null,
): string | null {
  if (existingUrl) return existingUrl;
  const template = SOURCE_URL_TEMPLATES[source]?.[entityType];
  if (!template) return null;
  return template.replace("{external_id}", encodeURIComponent(externalId));
}

export function attributionDetailEndpoint(
  entityType: AttributionEntityType,
  entityId: string,
): string {
  return `/api/attribution/${entityType}/${entityId}`;
}
