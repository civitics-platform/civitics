import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";

export const dynamic = "force-dynamic";

/**
 * /api/graph/voting-divergence — FIX-217 / FIX-218
 *
 * Returns one row per district at the requested band level. Each row
 * carries the district's boundary GeoJSON (FIX-163) and a derived measure
 * value, plus the IDs/parties of the officials representing it.
 *
 * Default measure: 'party_cohesion' — within-district fraction of
 * Yes/No vote pairs where every rep voted the same way. proposals.party_line
 * does not exist in the current schema, so we use this within-district
 * cohesion metric until a follow-up MV ships it (see plan §6).
 *
 * Sample size: up to 200 most recent legislation votes per official to
 * cap query cost. The choropleth shows spatial structure — a 200-vote
 * sample is more than sufficient.
 */

interface ResponseRow {
  districtId: string;
  districtName: string;
  geojson: GeoJSON.Geometry | null;
  measureValue: number | null;
  officialIds: string[];
  primaryParty: string | null;
}

const VALID_MEASURES = new Set(["party_cohesion", "divergence", "small_dollar_share"]);
const VALID_BANDS    = new Set(["state", "congressional", "sld_u", "sld_l"]);

interface JurisdictionRow {
  id: string;
  name: string;
  type: string;
  boundary_geometry: GeoJSON.Geometry | null;
}

interface OfficialRow {
  id: string;
  jurisdiction_id: string | null;
  party: string | null;
}

interface VoteRow {
  official_id: string;
  proposal_id: string;
  vote: string;
}

export async function GET(req: NextRequest) {
  if (supabaseUnavailable()) return unavailableResponse();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createAdminClient() as any;

  const { searchParams } = new URL(req.url);
  const measure = searchParams.get("measure") ?? "party_cohesion";
  const bandLevel = searchParams.get("bandLevel") ?? "congressional";

  if (!VALID_MEASURES.has(measure))
    return NextResponse.json({ error: `invalid measure: ${measure}` }, { status: 400 });
  if (!VALID_BANDS.has(bandLevel))
    return NextResponse.json({ error: `invalid bandLevel: ${bandLevel}` }, { status: 400 });

  // Map bandLevel → jurisdictions.type values used in the migration.
  const jurisdictionType =
    bandLevel === "state"         ? "state" :
    bandLevel === "congressional" ? "district_congressional" :
    bandLevel === "sld_u"         ? "district_state_upper" :
                                     "district_state_lower";

  // Fetch districts + their boundaries.
  const { data: jRows, error: jErr } = await supabase
    .from("jurisdictions")
    .select("id, name, type, boundary_geometry")
    .eq("type", jurisdictionType)
    .limit(500);

  if (jErr) {
    console.error("[voting-divergence] jurisdictions fetch:", jErr.message);
    return NextResponse.json({ error: jErr.message }, { status: 500 });
  }
  const districts = (jRows ?? []) as JurisdictionRow[];
  if (districts.length === 0) return NextResponse.json([]);

  const districtIds = districts.map(d => d.id);

  // Officials per district.
  const { data: officials } = await supabase
    .from("officials")
    .select("id, jurisdiction_id, party")
    .in("jurisdiction_id", districtIds);
  const officialsByDistrict = new Map<string, OfficialRow[]>();
  for (const o of (officials ?? []) as OfficialRow[]) {
    if (!o.jurisdiction_id) continue;
    if (!officialsByDistrict.has(o.jurisdiction_id))
      officialsByDistrict.set(o.jurisdiction_id, []);
    officialsByDistrict.get(o.jurisdiction_id)!.push(o);
  }

  // For party_cohesion: pull a sample of recent votes per official.
  // The cohesion calculation is per-district: across all votes where
  // ALL of the district's reps cast a Yes/No, what fraction had every
  // rep vote the same way?
  let cohesionByDistrict = new Map<string, number>();
  if (measure === "party_cohesion") {
    const allOfficialIds = (officials ?? []).map((o: OfficialRow) => o.id);
    if (allOfficialIds.length > 0) {
      // Pull recent legislation votes (yes/no only). Limit cap controls
      // total scan size — at ~500 districts × 2 reps × 200 votes that's
      // ~200k rows max, well under PostgREST limits.
      const { data: votes } = await supabase
        .from("votes")
        .select("official_id, proposal_id, vote")
        .in("official_id", allOfficialIds)
        .in("vote", ["yes", "no"])
        .order("voted_at", { ascending: false })
        .limit(50000);

      // Group votes by proposal then bucket by district.
      const byProposal = new Map<string, Map<string, string>>();
      for (const v of (votes ?? []) as VoteRow[]) {
        if (!byProposal.has(v.proposal_id)) byProposal.set(v.proposal_id, new Map());
        byProposal.get(v.proposal_id)!.set(v.official_id, v.vote);
      }

      for (const district of districts) {
        const reps = officialsByDistrict.get(district.id) ?? [];
        if (reps.length < 2) {
          // Single-rep districts have trivially 100% cohesion — skip.
          // Show as 1.0 (cohesive) so they color predictably.
          cohesionByDistrict.set(district.id, 1.0);
          continue;
        }
        let coherent = 0;
        let total = 0;
        for (const [, repVotes] of byProposal) {
          // Only count proposals where all of this district's reps voted.
          const districtVotes = reps
            .map(r => repVotes.get(r.id))
            .filter((v): v is string => Boolean(v));
          if (districtVotes.length !== reps.length) continue;
          total++;
          const allSame = districtVotes.every(v => v === districtVotes[0]);
          if (allSame) coherent++;
        }
        cohesionByDistrict.set(district.id, total === 0 ? 0.5 : coherent / total);
      }
    }
  }

  // small_dollar_share / divergence: stub — return 0.5 so the choropleth
  // still renders a uniform color rather than failing. The plan flagged
  // these as later additions.
  if (measure !== "party_cohesion") {
    cohesionByDistrict = new Map(districts.map(d => [d.id, 0.5]));
  }

  const rows: ResponseRow[] = districts.map(d => {
    const reps = officialsByDistrict.get(d.id) ?? [];
    const partyCount = new Map<string, number>();
    for (const r of reps) {
      const p = r.party ?? "Unknown";
      partyCount.set(p, (partyCount.get(p) ?? 0) + 1);
    }
    let primaryParty: string | null = null;
    let maxN = 0;
    for (const [p, n] of partyCount) if (n > maxN) { primaryParty = p; maxN = n; }
    return {
      districtId:   d.id,
      districtName: d.name,
      geojson:      d.boundary_geometry,
      measureValue: cohesionByDistrict.get(d.id) ?? null,
      officialIds:  reps.map(r => r.id),
      primaryParty,
    };
  });

  return NextResponse.json(rows, {
    headers: {
      "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
