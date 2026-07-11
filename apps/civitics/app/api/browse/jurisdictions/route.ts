/**
 * FIX-768 — By Place lazy child-fetch. The discovery-path "By Place" tree
 * drills country → state → county / city one level at a time; there are ~10.5k
 * jurisdictions so the tree NEVER loads them eagerly — each expand calls this
 * for exactly one parent's children.
 *
 *   GET /api/browse/jurisdictions            → top-level roots (parent_id IS NULL)
 *   GET /api/browse/jurisdictions?parent=UUID → active children of that parent
 *
 * Indexed on jurisdictions.parent_id, capped, and CDN-cacheable (the geography
 * changes rarely). `expandable` is inferred from type so the client can render
 * a disclosure arrow without a per-node existence probe.
 */

import { NextResponse } from "next/server";
import { createAdminClient } from "@civitics/db";

export const dynamic = "force-dynamic";

const LEVEL_LIMIT = 600;

// Types that can hold sub-jurisdictions worth drilling. Everything else is a
// leaf (link only) — a heuristic that avoids an EXISTS probe per node.
const EXPANDABLE_TYPES = new Set(["country", "state", "county", "federal_district"]);

export async function GET(req: Request) {
  const parent = new URL(req.url).searchParams.get("parent");
  const db = createAdminClient();

  let query = db
    .from("jurisdictions")
    .select("id, name, short_name, type")
    .eq("is_active", true)
    .order("name", { ascending: true })
    .limit(LEVEL_LIMIT);
  query = parent ? query.eq("parent_id", parent) : query.is("parent_id", null);

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const nodes = (data ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    short_name: r.short_name,
    type: r.type,
    expandable: EXPANDABLE_TYPES.has(r.type),
  }));

  return NextResponse.json(
    { nodes },
    { headers: { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" } },
  );
}
