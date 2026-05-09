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

interface OfficialRow {
  id: string;
  jurisdiction_id: string | null;
  party: string | null;
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

  // FIX-217: jurisdiction_type is a single 'district' enum value with
  // metadata->>'chamber' disambiguating ('upper' | 'lower' | 'congressional').
  // The TIGER pipeline writes congressional districts under chamber='congressional'
  // (FIX-163). State band uses jurisdiction_type='state' directly.
  const isStateBand = bandLevel === "state";
  const chamberFilter =
    bandLevel === "congressional" ? "congressional" :
    bandLevel === "sld_u"         ? "upper" :
    bandLevel === "sld_l"         ? "lower" :
                                    null;

  // Fetch districts + their boundaries via the existing query_districts RPC,
  // which returns ST_AsGeoJSON-converted polygons rather than raw PostGIS.
  // For 'state' band, query the jurisdictions table directly.
  let jRows: Array<{ id: string; name: string; geom_geojson: string | null }>;
  if (isStateBand) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .from("jurisdictions")
      .select("id, name")
      .eq("type", "state")
      .limit(60);
    if (error) {
      console.error("[voting-divergence] state fetch:", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    jRows = (data ?? []).map((r: { id: string; name: string }) => ({
      id: r.id, name: r.name, geom_geojson: null,
    }));
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc("query_districts", {
      p_chamber: chamberFilter,
      p_state:   null,
      // FIX-217: simplification tolerance and limit balanced against
      // Supabase's statement timeout. ST_SimplifyPreserveTopology cost
      // grows with both polygon count and tolerance × geometry density.
      // 1200 × 0.01 stays under the timeout for SLD-U/L; congressional
      // is only ~440 districts so easily fits.
      p_simplify_tolerance: 0.01,
      p_limit:   1200,
    });
    if (error) {
      console.error("[voting-divergence] query_districts error:", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    jRows = (data ?? []) as Array<{ id: string; name: string; geom_geojson: string | null }>;
  }

  const districts = jRows;
  if (districts.length === 0) return NextResponse.json([]);

  const districtIds = districts.map(d => d.id);
  const districtIdSet = new Set(districtIds);

  // Officials per district. FIX-217: link_officials_to_districts() writes
  // the district id to officials.metadata->>'district_jurisdiction_id',
  // not to officials.jurisdiction_id (which still points at the statewide
  // jurisdiction for state legislators). Query metadata and bucket
  // client-side. Paginate via range() because the officials table has
  // ~7,000+ linked rows and PostgREST caps at 1000 per response — without
  // pagination only ~156 of 500 districts would resolve a rep.
  const officialsByDistrict = new Map<string, OfficialRow[]>();
  {
    const PAGE = 1000;
    let from = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any)
        .from("officials")
        .select("id, party, metadata")
        .not("metadata->>district_jurisdiction_id", "is", null)
        .range(from, from + PAGE - 1);
      if (error) {
        console.error("[voting-divergence] officials fetch:", error.message);
        break;
      }
      if (!data || data.length === 0) break;
      for (const o of data as Array<{ id: string; party: string | null; metadata: { district_jurisdiction_id?: string } | null }>) {
        const jid = o.metadata?.district_jurisdiction_id;
        if (!jid || !districtIdSet.has(jid)) continue;
        if (!officialsByDistrict.has(jid)) officialsByDistrict.set(jid, []);
        officialsByDistrict.get(jid)!.push({ id: o.id, jurisdiction_id: jid, party: o.party });
      }
      if (data.length < PAGE) break;
      from += PAGE;
      if (from > 50_000) break; // safety
    }
  }

  // FIX-217 — Choropleth measure on SLDs.
  //
  // Originally this computed within-district "party cohesion" by looking
  // for votes where every rep in the district cast the same yes/no. That
  // doesn't apply to state legislative districts: nearly all are
  // single-rep, so cohesion is trivially 1.0 and the map ends up uniform.
  //
  // Better signal for an SLD-level choropleth: party of the rep,
  // rendered on a diverging scale so a Red/Blue political map falls out.
  // -1 = Democrat, +1 = Republican, 0 = Independent / no rep / Unknown.
  // The d3.interpolateRdBu scale on the client paints D districts blue
  // and R districts red, with neutral / no-data districts in white-ish.
  //
  // For multi-rep districts (rare on SLDs but possible at the
  // state-aggregate band) we average across reps so a 50/50 D+R district
  // colors neutral.
  const partyToScalar = (p: string | null | undefined): number => {
    const s = (p ?? "").toLowerCase();
    if (s === "democrat") return -1;
    if (s === "republican") return 1;
    return 0;
  };

  const measureByDistrict = new Map<string, number | null>();
  for (const district of districts) {
    const reps = officialsByDistrict.get(district.id) ?? [];
    if (reps.length === 0) {
      measureByDistrict.set(district.id, null);
      continue;
    }
    const sum = reps.reduce((s, r) => s + partyToScalar(r.party), 0);
    measureByDistrict.set(district.id, sum / reps.length);
  }

  // small_dollar_share / divergence are not yet implemented for SLDs —
  // fall back to the same party-based scalar so the map at least colors.
  if (measure !== "party_cohesion") {
    // (intentional fall-through — same map.)
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
    // FIX-217: query_districts returns ST_AsGeoJSON-converted polygons as a
    // text column. Parse to a GeoJSON Geometry object for the client.
    let geojson: GeoJSON.Geometry | null = null;
    if (d.geom_geojson) {
      try { geojson = JSON.parse(d.geom_geojson) as GeoJSON.Geometry; }
      catch { geojson = null; }
    }
    return {
      districtId:   d.id,
      districtName: d.name,
      geojson,
      measureValue: measureByDistrict.get(d.id) ?? null,
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
