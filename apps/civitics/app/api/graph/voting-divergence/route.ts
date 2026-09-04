import { NextResponse } from "next/server";
import { withPublicCdnCache } from "@/lib/cdn-cache";
import type { NextRequest } from "next/server";
import { createAdminClient, afterKey } from "@civitics/db";
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
    // FIX-217: query_districts RPC, paginated per-state. Server-side
    // ST_Simplify is required — without it, full-resolution polygons
    // exceed Vercel's response budget on SLD-L. The earlier nationwide
    // single call hit a Supabase statement timeout; per-state slices stay
    // well under both timeout and payload limits.
    const stateAbbrs = ["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC"];
    const allRows: Array<{ id: string; name: string; geom_geojson: string | null }> = [];
    for (const st of stateAbbrs) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).rpc("query_districts", {
        p_chamber: chamberFilter,
        p_state:   st,
        p_simplify_tolerance: 0.01,
        p_limit:   200,
      });
      if (error) {
        console.error(`[voting-divergence] ${st}: ${error.message}`);
        continue;
      }
      for (const r of (data ?? []) as Array<{ id: string; name: string; geom_geojson: string }>) {
        allRows.push({ id: r.id, name: r.name, geom_geojson: r.geom_geojson });
      }
    }
    jRows = allRows;
  }

  const districts = jRows;
  if (districts.length === 0) return withPublicCdnCache(NextResponse.json([]));

  const districtIds = districts.map(d => d.id);
  const districtIdSet = new Set(districtIds);

  // FIX-217: bucket linked officials by district. Run two narrow queries
  // (federal Reps + state legs) in parallel rather than one nationwide
  // pagination — keeps each query small and fast on Vercel where total
  // function-execution budget is tight after the per-state district
  // fetch loop. role_title is an indexed enum so each filtered query
  // returns < 5,000 rows.
  const officialsByDistrict = new Map<string, OfficialRow[]>();

  async function fetchAndBucket(roleFilter: 'Representative' | 'state-leg'): Promise<void> {
    // FIX-984. Two things were wrong here, both fixed by the same rewrite:
    //
    //  1. NO `.order()` at all, so `.range()` paged an unordered result -- free
    //     to hand back the same official twice and drop another, which shifts a
    //     district's party mix and therefore its divergence score.
    //  2. ONE builder object was reused for every page. supabase-js filter
    //     builders MUTATE and return `this`, so each `.range()` overwrote the
    //     previous call's header on the same instance; a fresh builder per page
    //     is the documented contract every other walk in this repo follows.
    //
    // The builder is now a factory, ordered on and keyset-seeked by the `id`
    // pkey.
    const PAGE = 1000;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buildPage = (after: string | null): any => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q = (supabase as any)
        .from("officials")
        .select("id, party, metadata, role_title")
        .not("metadata->>district_jurisdiction_id", "is", null);
      if (roleFilter === 'Representative') {
        q = q.eq("role_title", "Representative");
      } else {
        q = q.in("role_title", ["State Senator", "State Representative", "State Delegate", "State Assemblymember"]);
      }
      return afterKey(q.order("id", { ascending: true }).limit(PAGE), "id", after);
    };
    let afterId: string | null = null;
    let scanned = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { data, error } = await buildPage(afterId);
      if (error) {
        console.error(`[voting-divergence] ${roleFilter} fetch:`, error.message);
        break;
      }
      const rows = data as Array<{ id: string; party: string | null; metadata: { district_jurisdiction_id?: string } | null }> | null;
      if (!rows || rows.length === 0) break;
      for (const o of rows) {
        const jid = o.metadata?.district_jurisdiction_id;
        if (!jid || !districtIdSet.has(jid)) continue;
        if (!officialsByDistrict.has(jid)) officialsByDistrict.set(jid, []);
        officialsByDistrict.get(jid)!.push({ id: o.id, jurisdiction_id: jid, party: o.party });
      }
      scanned += rows.length;
      if (rows.length < PAGE) break;
      afterId = rows[rows.length - 1]!.id;
      if (scanned > 20_000) break;
    }
  }

  await Promise.all([
    fetchAndBucket('Representative'),
    fetchAndBucket('state-leg'),
  ]);

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

  return withPublicCdnCache(NextResponse.json(rows, {
    headers: {
      "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
    },
  }));
}
