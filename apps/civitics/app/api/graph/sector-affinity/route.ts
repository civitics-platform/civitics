import { NextResponse } from "next/server";
import { withPublicCdnCache } from "@/lib/cdn-cache";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";
import { fetchChunkedByIds } from "@/lib/paginate";

export const dynamic = "force-dynamic";

/**
 * /api/graph/sector-affinity?entityId=X — FIX-218
 *
 * Returns the focused official's top funding industries — sectors of the
 * PACs / financial entities that donated to them. Used by the
 * "Sector Affinity" preset rendered as a horizontal bar set.
 *
 * FIX-777: served from public.official_sector_affinity_rollup (per-(official,
 * industry) dollars + distinct-donor count, maintained incrementally on the
 * FIX-704 donor dirty set). The route reads all of an official's sector rows,
 * sorts, and takes the top 15; `totalCents` is the sum over ALL sectors. The
 * live per-donor aggregation below stays as the per-entity miss fallback.
 *
 * FIX-872 — SCOPE: donation-only by design. Both the rollup rebuild
 * (sector_affinity_rebuild_officials, per_donor CTE filters
 * relationship_type='donation') and the live fallback below
 * (computeSectorAffinityLive, .eq("relationship_type","donation")) count ONLY
 * donations — ie_support/ie_oppose are intentionally excluded. So an official
 * with only independent-expenditure money and zero donations returns a clean
 * empty payload (sectors: [], totalCents: 0), NOT a 500. This is deliberate:
 * the chart answers "which sectors FUND this official" (donations); IE money
 * (especially ie_oppose, spent AGAINST a candidate) is shown separately as
 * "Independent support" and would be wrong here (locked IE≠donation product
 * rule). IE-only officials being absent from this surface is not a gap. The
 * FIX-872 investigation confirmed the donation-only reading on local + prod and
 * chose scope-as-designed over widening the work-list. See FIX-869/FIX-872.
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
const CACHE_HEADERS = { "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400" };

interface DonationLite { from_id: string; amount_cents: number | null }
interface TagLite      { entity_id: string; tag: string }
interface OfficialRow  { id: string; full_name: string }
interface RollupRow    { industry: string; total_cents: number | string | null; donor_count: number | string | null }

// FIX-777 live-compute fallback: paginate the official's donations, sum per
// donor, map each donor to its single (smallest, deterministic) industry tag or
// 'Untagged', then aggregate dollars + distinct-donor count per industry. This is
// the pre-materialization request-path aggregation; it stays as the per-entity
// fallback for a rollup miss (official absent — not yet backfilled, or no
// donations) so nothing 500s / blanks. Byte-for-byte with
// official_sector_affinity_rollup (same smallest-tag pick, same Untagged bucket).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function computeSectorAffinityLive(supabase: any, entityId: string): Promise<{ totalCents: number; sectors: SectorRow[] }> {
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

  if (donorTotals.size === 0) return { totalCents: 0, sectors: [] };

  // Pull industry tags for these donors, deterministic smallest-tag per donor
  // (FIX-777 — was "first seen" across unordered batches; ordering by (entity_id,
  // tag) + keep-first yields the smallest tag, matching the rollup / the
  // FIX-518 `ind` CTE / fetchIndustryTagsByEntityId).
  // FIX-902: this loop WAS chunked — at 300, which is over the URL bound, not
  // under it. 300 uuids is ~11 KB on the request line and FIX-509 verified the
  // gateway 414 at ~356 / FIX-772 at ~234, so every chunk sat inside the
  // failure window and each one that tripped it silently dropped 300 donors'
  // industry tags into "Other". The pagination loop above admits up to 200,000
  // donors, so this is not a rare shape. Chunked at the shared ID_CHUNK_SIZE.
  const donorIds = [...donorTotals.keys()];
  const tagByEntity = new Map<string, string>();
  const { rows: tags, complete: tagsComplete } = await fetchChunkedByIds<TagLite>(
    donorIds,
    (ids) =>
      supabase
        .from("entity_tags")
        .select("entity_id, tag")
        .eq("tag_category", "industry")
        .eq("entity_type", "financial_entity")
        .in("entity_id", ids)
        .order("entity_id", { ascending: true })
        .order("tag", { ascending: true }),
    { label: "sector-affinity:industry-tags" },
  );
  if (!tagsComplete) {
    console.warn("[sector-affinity] industry tag read incomplete — affected donors fall back to Other");
  }
  for (const t of tags) {
    if (!tagByEntity.has(t.entity_id)) tagByEntity.set(t.entity_id, t.tag);
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
  return { totalCents, sectors };
}

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
  const o = official as OfficialRow;

  // FIX-777 fast path: read the materialized per-(official, industry) rollup.
  // Bounded row count (one per industry + Untagged), so no 1000-row cap risk.
  const { data: rollupRows, error: rErr } = await supabase
    .from("official_sector_affinity_rollup")
    .select("industry, total_cents, donor_count")
    .eq("official_id", entityId);

  let totalCents: number;
  let sectors: SectorRow[];
  if (!rErr && rollupRows && rollupRows.length > 0) {
    // totalCents sums ALL sectors (incl. Untagged / beyond top-15); sectors is the
    // top-15 slice — mirrors the live compute exactly.
    totalCents = 0;
    const all = (rollupRows as RollupRow[]).map((r) => {
      const c = Number(r.total_cents ?? 0);
      totalCents += c;
      return { industry: r.industry, totalCents: c, donorCount: Number(r.donor_count ?? 0) };
    });
    sectors = all.sort((a, b) => b.totalCents - a.totalCents).slice(0, 15);
  } else {
    if (rErr) console.error("[sector-affinity] rollup read (falling back to live):", rErr.message);
    const live = await computeSectorAffinityLive(supabase, entityId);
    totalCents = live.totalCents;
    sectors = live.sectors;
  }

  const body: ResponseShape = {
    officialId:   o.id,
    officialName: o.full_name,
    totalCents,
    sectors,
  };
  return withPublicCdnCache(NextResponse.json(body, { headers: CACHE_HEADERS }));
}
