/**
 * FIX-398 — GET /api/attribution/[type]/[id]
 *
 * Returns the full external_source_refs expansion for a single entity.
 * Lazy-fetched by the FIX-400 source-detail popover; not preloaded from any
 * detail-page SSR loader (cost-deferred by design).
 *
 *   400 — unknown entity type, or non-UUID id
 *   404 — entity does not exist in its target table
 *   200 — { primary, sources: [], source_count } even when xsr is empty
 *
 * FIX-408: xsr now carries a public-read RLS policy (xsr_public_read), so
 * the route reads through the publishable-key client. force-dynamic stays
 * because the params shape ([type]/[id]) precludes any static-rendering
 * value, not because admin access is required.
 */

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import {
  createPublicClient,
  ATTRIBUTION_ENTITY_TYPES,
  deriveSourceUrl,
  type AttributionDetailResponse,
  type AttributionDetailSource,
  type AttributionEntityType,
  type AttributionPrimary,
} from "@civitics/db";
import { withDbTimeout } from "@/lib/supabase-check";
import { withPublicCdnCache } from "@/lib/cdn-cache";

const ENTITY_TYPE_TO_TABLE: Record<AttributionEntityType, string> = {
  official:         "officials",
  proposal:         "proposals",
  agency:           "agencies",
  governing_body:   "governing_bodies",
  financial_entity: "financial_entities",
};

// Inline because public.source_priority() lives DB-side and we want one
// round-trip for the xsr fetch (PostgREST can't apply a SQL function in a
// .select()). Kept in sync with the SQL function by hand — see
// supabase/migrations/<FIX-397 migration>.
function sourcePriority(src: string): number {
  if (src === "congress_gov")          return 1;
  if (src === "fec")                   return 2;
  if (src === "openstates")            return 3;
  if (src.startsWith("legistar:"))     return 4;
  if (src === "regulations_gov")       return 5;
  if (src === "courtlistener")         return 6;
  if (src === "littlesis")             return 7;
  if (src === "usaspending_recipient") return 8;
  if (src === "irs_990")               return 9;
  if (src === "sec_edgar")             return 10;
  if (src === "edgar")                 return 11;
  return 9999;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isAttributionEntityType(s: string): s is AttributionEntityType {
  return (ATTRIBUTION_ENTITY_TYPES as readonly string[]).includes(s);
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { type: string; id: string } },
): Promise<NextResponse> {
  const { type, id } = params;

  if (!isAttributionEntityType(type)) {
    return NextResponse.json(
      { error: "invalid_type", allowed: ATTRIBUTION_ENTITY_TYPES },
      { status: 400 },
    );
  }
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const db = createPublicClient();
  const table = ENTITY_TYPE_TO_TABLE[type];

  // 1) Confirm the entity exists. For FIX-406 synthetic-source prepend on
  // financial_entity / official, also pull the FEC key + updated_at so we
  // don't need a second round-trip.
  const entitySelect =
    type === "financial_entity" ? "id, fec_committee_id, updated_at"
    : type === "official"        ? "id, source_ids, updated_at"
    :                              "id";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entityRes = await withDbTimeout<any>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).from(table).select(entitySelect).eq("id", id).maybeSingle(),
    5000,
    `attribution:entity-check:${type}`,
  );

  if (entityRes?.error) {
    console.error(`[/api/attribution] entity check failed`, entityRes.error);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }
  if (!entityRes?.data) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const entityRow = entityRes.data as {
    id: string;
    fec_committee_id?: string | null;
    source_ids?: Record<string, unknown> | null;
    updated_at?: string | null;
  };

  // 2) Fetch xsr rows. Sort client-side by priority then last_seen_at so the
  // first row is "primary". This matches public.source_priority()'s ordering.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const xsrRes = await withDbTimeout<any>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any)
      .from("external_source_refs")
      .select("source, external_id, source_url, last_seen_at, metadata")
      .eq("entity_type", type)
      .eq("entity_id", id),
    5000,
    `attribution:xsr:${type}`,
  );

  if (xsrRes?.error) {
    console.error(`[/api/attribution] xsr fetch failed`, xsrRes.error);
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }

  const rawRows = (xsrRes?.data ?? []) as Array<{
    source:       string;
    external_id:  string;
    source_url:   string | null;
    last_seen_at: string;
    metadata:     Record<string, unknown> | null;
  }>;

  const sources: AttributionDetailSource[] = rawRows.map((r) => ({
    source:       r.source,
    external_id:  r.external_id,
    source_url:   deriveSourceUrl(r.source, type, r.external_id, r.source_url),
    last_seen_at: r.last_seen_at,
    priority:     sourcePriority(r.source),
    is_primary:   false,
    metadata:     r.metadata ?? {},
  }));

  // FIX-406: synthesize a primary_source='fec' entry from the entity's
  // first-class FEC key (fec_committee_id on financial_entities, source_ids
  // .fec_candidate_id on officials) when no real fec xsr row is already in
  // the set. Mirrors the DB-side synthesis in
  // rebuild_all_primary_sources(); the API needs its own copy because the
  // detail expansion lists ALL sources, not just primary, and the xsr
  // surface intentionally has no fec rows.
  const hasFecXsr = sources.some((s) => s.source === "fec");
  let fecExternalId: string | null = null;
  if (!hasFecXsr) {
    if (type === "financial_entity" && entityRow.fec_committee_id) {
      fecExternalId = entityRow.fec_committee_id;
    } else if (
      type === "official" &&
      entityRow.source_ids &&
      typeof entityRow.source_ids["fec_candidate_id"] === "string"
    ) {
      fecExternalId = entityRow.source_ids["fec_candidate_id"] as string;
    }
  }
  if (fecExternalId) {
    sources.push({
      source:       "fec",
      external_id:  fecExternalId,
      source_url:   deriveSourceUrl("fec", type, fecExternalId, null),
      last_seen_at: entityRow.updated_at ?? new Date().toISOString(),
      priority:     sourcePriority("fec"),
      is_primary:   false,
      metadata:     { synthetic: true },
    });
  }

  sources.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    // Newer first when priority ties.
    return b.last_seen_at.localeCompare(a.last_seen_at);
  });

  if (sources.length > 0) {
    sources[0]!.is_primary = true;
  }

  const primary: AttributionPrimary | null = sources[0]
    ? {
        source:       sources[0].source,
        source_url:   sources[0].source_url,
        last_seen_at: sources[0].last_seen_at,
      }
    : null;

  const body: AttributionDetailResponse = {
    primary,
    sources,
    source_count: sources.length,
  };

  // FIX-796 — header handler-owned: public per-entity source attribution
  // (createPublicClient payload, zero viewer-dependence); GET 200 only.
  return withPublicCdnCache(NextResponse.json(body));
}
