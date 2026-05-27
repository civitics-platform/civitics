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
 */

import { createAdminClient } from "./client";
import type { createPublicClient, createServerClient } from "./client";
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

  // governing_bodies doesn't carry primary_source* columns (FIX-397 only
  // materialized them on 5 tables). Fall back to a pure xsr lookup for that
  // type — the SSR loaders don't call us with governing_body today, but the
  // surface is shaped so future callers don't trip a SELECT on a missing
  // column.
  if (entityType === "governing_body") {
    return fetchAttributionFromXsrOnly(db, entityType, entityId);
  }

  // xsr has RLS enabled with no policies, so the passed (publishable-key)
  // client can't see it. Spin up an admin client just for the count step.
  // The entity-table read uses the caller's client (RLS-respecting). Admin
  // is instantiated lazily at request time — safe under ISR because
  // generateStaticParams returns []; never invoked at Vercel build.
  const admin = createAdminClient();
  const [entityRes, countRes] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any)
      .from(table)
      .select("primary_source, primary_source_url, primary_source_last_seen_at")
      .eq("id", entityId)
      .maybeSingle(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (admin as any)
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

async function fetchAttributionFromXsrOnly(
  _db: AnyDb,
  entityType: AttributionEntityType,
  entityId: string,
): Promise<AttributionShape> {
  // xsr has no public RLS policy — must use admin to read.
  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, count } = await (admin as any)
    .from("external_source_refs")
    .select("source, source_url, last_seen_at", { count: "exact" })
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .order("last_seen_at", { ascending: false });

  const rows = (data ?? []) as Array<{ source: string; source_url: string | null; last_seen_at: string }>;
  // Without source_priority() composability through PostgREST, pick the
  // freshest row as primary. governing_body is a low-volume corner today
  // (~255 rows in prod), so this is fine — re-evaluate when usage grows.
  const top = rows[0] ?? null;

  return {
    primary: top
      ? { source: top.source, source_url: top.source_url, last_seen_at: top.last_seen_at }
      : null,
    source_count:    (count ?? rows.length) as number,
    detail_endpoint: attributionDetailEndpoint(entityType, entityId),
  };
}
