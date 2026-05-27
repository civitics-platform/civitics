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
 * Uses createAdminClient because the xsr table is server-only data (RLS
 * exists but the surface is admin-curated). force-dynamic per the
 * "createAdminClient ⇒ force-dynamic" rule.
 */

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import {
  createAdminClient,
  ATTRIBUTION_ENTITY_TYPES,
  deriveSourceUrl,
  type AttributionDetailResponse,
  type AttributionDetailSource,
  type AttributionEntityType,
  type AttributionPrimary,
} from "@civitics/db";
import { withDbTimeout } from "@/lib/supabase-check";

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

  const db = createAdminClient();
  const table = ENTITY_TYPE_TO_TABLE[type];

  // 1) Confirm the entity exists. Distinguish "not found" from "DB error" by
  // checking error and data separately — withDbTimeout swallows timeouts to
  // { data: null, error } and logs PostgREST structural codes via prefix.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entityRes = await withDbTimeout<any>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).from(table).select("id").eq("id", id).maybeSingle(),
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

  const sources: AttributionDetailSource[] = rawRows
    .map((r) => ({
      source:       r.source,
      external_id:  r.external_id,
      source_url:   deriveSourceUrl(r.source, type, r.external_id, r.source_url),
      last_seen_at: r.last_seen_at,
      priority:     sourcePriority(r.source),
      is_primary:   false,
      metadata:     r.metadata ?? {},
    }))
    .sort((a, b) => {
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

  return NextResponse.json(body);
}
