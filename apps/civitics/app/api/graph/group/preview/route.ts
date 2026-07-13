/**
 * GET /api/graph/group/preview — FIX-127
 *
 * Lightweight HEAD-only count for a GroupFilter. Powers the live "47
 * matching" badge in the custom group builder. Mirrors the filter logic of
 * /api/graph/group's full mode but skips every join, aggregation, and node
 * build — the only thing the caller needs is the row count.
 *
 * Query params (all from GroupFilter shape):
 *   entity_type=official|pac|agency|financial  (required)
 *   chamber=senate|house              (official only)
 *   party=democrat|republican|independent (official only)
 *   state=XX                          (official only)
 *   industry=Finance|...              (pac only)
 *   financial_type=super_pac|...      (financial only, required — FIX-772)
 */

import { NextRequest, NextResponse } from "next/server";
import { withPublicCdnCache } from "@/lib/cdn-cache";
import { createAdminClient, fetchEntityIdsByIndustryTag } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";

export const dynamic = "force-dynamic";

const VALID_TYPES   = new Set(["official", "pac", "agency", "financial"]);
const VALID_CHAMBER = new Set(["senate", "house"]);
// FIX-772 — the financial cohorts the full route resolves. 'individual' is
// deliberately absent (not enumerable — see the full route's 422).
const VALID_FINANCIAL_TYPES = new Set([
  "pac", "super_pac", "corporation", "union", "party_committee",
]);

export async function GET(req: NextRequest) {
  if (supabaseUnavailable()) return unavailableResponse();

  const { searchParams } = req.nextUrl;
  const entityType = searchParams.get("entity_type") ?? "";
  if (!VALID_TYPES.has(entityType)) {
    return NextResponse.json({ error: "entity_type must be official|pac|agency|financial" }, { status: 400 });
  }

  const supabase = createAdminClient();

  if (entityType === "official") {
    const chamber = searchParams.get("chamber");
    const party   = searchParams.get("party");
    const state   = searchParams.get("state");
    if (chamber && !VALID_CHAMBER.has(chamber)) {
      return NextResponse.json({ error: "chamber must be senate|house" }, { status: 400 });
    }

    let q = supabase
      .from("officials")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true);

    if (chamber === "senate") q = q.eq("role_title", "Senator");
    else if (chamber === "house") q = q.eq("role_title", "Representative");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (party) q = q.eq("party", party as any);
    if (state) q = q.or(`metadata->>state.eq.${state},metadata->>state_abbr.eq.${state}`);

    const { count, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return withPublicCdnCache(NextResponse.json({ count: count ?? 0 }));
  }

  if (entityType === "pac") {
    const industry = searchParams.get("industry");

    // Industry filter resolves through `entity_tags` (FIX-167). Resolve the
    // tagged entity IDs first, then count PACs in that set.
    const taggedIds = industry ? await fetchEntityIdsByIndustryTag(supabase, industry) : null;
    if (taggedIds && taggedIds.length === 0) {
      return withPublicCdnCache(NextResponse.json({ count: 0 }));
    }

    let q = supabase
      .from("financial_entities")
      .select("id", { count: "exact", head: true })
      .eq("entity_type", "pac")
      .not("display_name", "ilike", "%PAC/Committee%");

    if (taggedIds) q = q.in("id", taggedIds);

    const { count, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return withPublicCdnCache(NextResponse.json({ count: count ?? 0 }));
  }

  // FIX-772 — financial cohort count, mirroring the full route's member query
  // (entity_search_index, synthetic + placeholder rows excluded).
  if (entityType === "financial") {
    const financialType = searchParams.get("financial_type") ?? "";
    if (!VALID_FINANCIAL_TYPES.has(financialType)) {
      return NextResponse.json(
        { error: "financial_type must be pac|super_pac|corporation|union|party_committee" },
        { status: 400 },
      );
    }

    const { count, error } = await supabase
      .from("entity_search_index")
      .select("entity_id", { count: "exact", head: true })
      .eq("kind", "financial")
      .eq("financial_type", financialType)
      .eq("is_synthetic", false)
      .not("display_name", "ilike", "%PAC/Committee%");

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return withPublicCdnCache(NextResponse.json({ count: count ?? 0 }));
  }

  // entity_type === "agency"
  // GroupFilter doesn't expose agency-specific facets yet (agency_type would be
  // a future addition), so this is a flat count of active agencies.
  const { count, error } = await supabase
    .from("agencies")
    .select("id", { count: "exact", head: true })
    .eq("is_active", true);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return withPublicCdnCache(NextResponse.json({ count: count ?? 0 }));
}
