import { NextResponse } from "next/server";
import { withPublicCdnCache } from "@/lib/cdn-cache";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";

export const dynamic = "force-dynamic";

/**
 * /api/graph/sector-affinity?entityId=X — FIX-218
 *
 * Returns the focused official's top funding industries — sectors of the
 * PACs / financial entities that donated to them. Used by the
 * "Sector Affinity" preset rendered as a horizontal bar set.
 *
 * Implementation: aggregate financial_relationships where to_id=X over
 * entity_tags(tag_category='industry') of the donor. (We don't read
 * chord_industry_flows_mv directly — it's keyed by party_chamber × industry,
 * not per-official, so it's the wrong grain.)
 */

interface SectorRow {
  industry: string;
  totalCents: number;
  donorCount: number;
}

interface ResponseShape {
  officialId: string;
  officialName: string;
  totalCents: number;
  sectors: SectorRow[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface DonationLite { from_id: string; amount_cents: number | null }
interface TagLite      { entity_id: string; tag: string }
interface OfficialRow  { id: string; full_name: string }

export async function GET(req: NextRequest) {
  if (supabaseUnavailable()) return unavailableResponse();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createAdminClient() as any;

  const { searchParams } = new URL(req.url);
  const raw = searchParams.get("entityId");
  if (!raw || !UUID_RE.test(raw)) {
    return NextResponse.json({ error: "entityId required (uuid)" }, { status: 400 });
  }
  const entityId = raw;

  const { data: official } = await supabase
    .from("officials")
    .select("id, full_name")
    .eq("id", entityId)
    .maybeSingle();
  if (!official) return NextResponse.json({ error: "official not found" }, { status: 404 });

  // Aggregate per donor. (Many donations from the same donor on different
  // dates get combined first, so the donorCount is the count of distinct
  // donors per industry, not raw donation rows.)
  const donorTotals = new Map<string, number>();
  let from = 0;
  const PAGE = 1000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data } = await supabase
      .from("financial_relationships")
      .select("from_id, amount_cents")
      .eq("relationship_type", "donation")
      .eq("from_type", "financial_entity")
      .eq("to_type", "official")
      .eq("to_id", entityId)
      .gt("amount_cents", 0)
      // FIX-503: stable pkey order so paged per-donor sums don't double-count.
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (!data || data.length === 0) break;
    for (const d of data as DonationLite[]) {
      donorTotals.set(d.from_id, (donorTotals.get(d.from_id) ?? 0) + (d.amount_cents ?? 0));
    }
    if (data.length < PAGE) break;
    from += PAGE;
    if (donorTotals.size > 200_000) break;
  }

  if (donorTotals.size === 0) {
    const o = official as OfficialRow;
    return withPublicCdnCache(NextResponse.json({ officialId: o.id, officialName: o.full_name, totalCents: 0, sectors: [] } as ResponseShape));
  }

  // Pull industry tags for these donors. Use the primary visibility tag
  // when available (matches FIX-179 ranking).
  const donorIds = [...donorTotals.keys()];
  const tagByEntity = new Map<string, string>();
  const BATCH = 300;
  for (let i = 0; i < donorIds.length; i += BATCH) {
    const batch = donorIds.slice(i, i + BATCH);
    const { data: tags } = await supabase
      .from("entity_tags")
      .select("entity_id, tag")
      .eq("tag_category", "industry")
      .eq("entity_type", "financial_entity")
      .in("entity_id", batch);
    for (const t of (tags ?? []) as TagLite[]) {
      // Keep the first tag we see per entity (entity_tags has a primary
      // index but this endpoint doesn't need to query it specifically).
      if (!tagByEntity.has(t.entity_id)) tagByEntity.set(t.entity_id, t.tag);
    }
  }

  const bySector = new Map<string, { totalCents: number; donors: Set<string> }>();
  let totalCents = 0;
  for (const [donorId, cents] of donorTotals) {
    const tag = tagByEntity.get(donorId) ?? "Untagged";
    if (!bySector.has(tag)) bySector.set(tag, { totalCents: 0, donors: new Set() });
    const bucket = bySector.get(tag)!;
    bucket.totalCents += cents;
    bucket.donors.add(donorId);
    totalCents += cents;
  }

  const sectors: SectorRow[] = Array.from(bySector.entries())
    .map(([industry, b]) => ({ industry, totalCents: b.totalCents, donorCount: b.donors.size }))
    .sort((a, b) => b.totalCents - a.totalCents)
    .slice(0, 15); // top 15 industries

  const o = official as OfficialRow;
  const body: ResponseShape = {
    officialId:   o.id,
    officialName: o.full_name,
    totalCents,
    sectors,
  };
  return withPublicCdnCache(NextResponse.json(body, {
    headers: { "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400" },
  }));
}
