/**
 * FIX-398 — server-side helper for SSR detail-page attribution.
 *
 * Reads the materialized primary_source* columns on the entity table (cheap)
 * and the source_count from external_source_refs (one extra round-trip).
 *
 * NULL-tolerant: when primary_source IS NULL on the entity row, returns
 * { primary: null, source_count, detail_endpoint }. Most financial_entities
 * fall into this bucket because FEC dedup happens outside the xsr surface.
 *
 * The full xsr expansion (sources[]) is intentionally NOT fetched here — the
 * detail page only needs the cheap primary + count. The lazy-loaded popover
 * (FIX-400) hits /api/attribution/[type]/[id] for the full list.
 *
 * FIX-408: xsr now carries a public-read RLS policy (xsr_public_read), so
 * both the entity-table read and the xsr count subquery route through the
 * single caller-passed client. createAdminClient is no longer required here.
 */

import type { createAdminClient, createPublicClient, createServerClient } from "./client";
import {
  attributionDetailEndpoint,
  type AttributionEntityType,
  type AttributionShape,
} from "./types/attribution";

// Accept any of the three server-side client shapes. The narrow callable
// surface used here (.from, .select, .eq, .maybeSingle) is identical across
// all three.
type AnyDb =
  | ReturnType<typeof createPublicClient>
  | ReturnType<typeof createServerClient>
  | ReturnType<typeof createAdminClient>;

const ENTITY_TYPE_TO_TABLE: Record<AttributionEntityType, string> = {
  official:         "officials",
  proposal:         "proposals",
  agency:           "agencies",
  governing_body:   "governing_bodies",
  financial_entity: "financial_entities",
};

export async function fetchAttributionForEntity(
  db: AnyDb,
  entityType: AttributionEntityType,
  entityId: string,
): Promise<AttributionShape> {
  const table = ENTITY_TYPE_TO_TABLE[entityType];

  const [entityRes, countRes] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any)
      .from(table)
      .select("primary_source, primary_source_url, primary_source_last_seen_at")
      .eq("id", entityId)
      .maybeSingle(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any)
      .from("external_source_refs")
      .select("id", { count: "exact", head: true })
      .eq("entity_type", entityType)
      .eq("entity_id", entityId),
  ]);

  const row = entityRes?.data as
    | { primary_source: string | null; primary_source_url: string | null; primary_source_last_seen_at: string | null }
    | null
    | undefined;
  const count = (countRes?.count ?? 0) as number;

  const primary = row?.primary_source && row.primary_source_last_seen_at
    ? {
        source:       row.primary_source,
        source_url:   row.primary_source_url,
        last_seen_at: row.primary_source_last_seen_at,
      }
    : null;

  return {
    primary,
    source_count:    count,
    detail_endpoint: attributionDetailEndpoint(entityType, entityId),
  };
}
