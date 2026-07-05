import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createPublicClient } from "@civitics/db";
import type { MultiPolygon, Polygon } from "geojson";
import { DeferredDistrictMap } from "../components/DeferredDistrictMap";
import { withDbTimeout } from "@/lib/supabase-check";
import { lookupJurisdictionCache } from "@/lib/jurisdiction-cache";

// FIX-645: this page reads only public (RLS USING(true)) data and emits no
// per-user content, so force-dynamic was pure overhead — every hit fully
// re-rendered. Switch to ISR via the publishable client (no cookies() → no
// static opt-out), matching the jurisdictions/[id] pattern (FIX-634).
export const revalidate = 300;

// Empty list → on-demand ISR (no build-time prerender), but marks the route as
// statically-optimized so revalidate actually caches between hits. Without this
// a dynamic [id] segment renders fresh every request even with revalidate set.
export async function generateStaticParams() {
  return [];
}

const PARTY_BADGE: Record<string, string> = {
  democrat:    "bg-civic-blue/10 text-civic-blue",
  republican:  "bg-accent/10 text-accent",
  independent: "bg-viz-7/10 text-viz-7",
};

interface DistrictRow {
  id:         string;
  name:       string | null;
  short_name: string | null;
  parent_id:  string | null;
  metadata:   Record<string, unknown> | null;
}

interface ParentRow { name: string | null }

interface OfficialRow {
  id:           string;
  full_name:    string;
  role_title:   string | null;
  party:        string | null;
  district_name: string | null;
}

async function loadDistrict(id: string): Promise<{
  district: DistrictRow;
  parent: ParentRow | null;
  officials: OfficialRow[];
  geometry: Polygon | MultiPolygon | null;
} | null> {
  const supabase = createPublicClient();

  const { data: district } = await withDbTimeout(
    supabase
      .from("jurisdictions")
      .select("id, name, short_name, parent_id, metadata")
      .eq("id", id)
      .eq("type", "district")
      .single<DistrictRow>(),
    3000,
    "district:detail",
  );
  if (!district) return null;

  const [parentRes, officialsRes, geomRes] = await Promise.all([
    district.parent_id
      ? withDbTimeout(
          supabase.from("jurisdictions").select("name").eq("id", district.parent_id).single<ParentRow>(),
          3000,
          "district:parent",
        )
      : Promise.resolve({ data: null }),
    withDbTimeout(
      supabase
        .from("officials")
        .select("id, full_name, role_title, party, district_name")
        .filter("metadata->>district_jurisdiction_id", "eq", id)
        .eq("is_active", true)
        .order("full_name"),
      3000,
      "district:officials",
    ),
    withDbTimeout(
      supabase.rpc("query_districts" as never, {
        p_id: id,
        p_simplify_tolerance: 0.0005,
        p_limit: 1,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      3000,
      "district:geometry",
    ),
  ]);

  type Row = { id: string; geom_geojson: string | null };
  const matched = (geomRes.data as Row[] | null)?.[0] ?? null;
  let geometry: Polygon | MultiPolygon | null = null;
  if (matched?.geom_geojson) {
    try { geometry = JSON.parse(matched.geom_geojson) as Polygon | MultiPolygon; } catch { /* skip */ }
  }

  return {
    district,
    parent: (parentRes.data as ParentRow | null) ?? null,
    officials: ((officialsRes.data as OfficialRow[] | null) ?? []),
    geometry,
  };
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  // FIX-683: a district is a jurisdictions row, so the same jurisdiction_page_cache
  // membership test gates its noindex. Run it alongside loadDistrict (no extra
  // latency on the critical path).
  const [data, lookup] = await Promise.all([
    loadDistrict(id),
    lookupJurisdictionCache(createPublicClient(), id),
  ]);
  if (!data) return { title: "District not found" };
  const stateName = data.parent?.name ?? "";
  const chamber = (data.district.metadata?.["chamber"] as string | undefined) ?? "";
  const title = `${data.district.name ?? "District"}${stateName ? ` — ${stateName}` : ""}`;
  return {
    title,
    description: `Boundary, representatives, and election info for ${title} (${chamber} chamber).`,
    // Empty-leaf districts (no officials/proposals/etc. → not in the cache) are
    // noindex,nofollow; content-bearing ones (and any cache hiccup → fail open)
    // stay indexed.
    ...(lookup.isMember === false ? { robots: { index: false, follow: false } } : {}),
  };
}

export default async function DistrictPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await loadDistrict(id);
  if (!data) notFound();

  const { district, parent, officials, geometry } = data;
  const meta = district.metadata ?? {};
  const chamber = (meta["chamber"] as string | undefined) ?? null;
  const stateAbbr = (meta["state_abbr"] as string | undefined) ?? null;
  const districtNum = (meta["district_id"] as string | undefined) ?? null;

  const chamberLabel = chamber === "upper" ? "State Senate" : chamber === "lower" ? "State House" : "Legislative";

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <nav className="text-xs text-ink-soft/70 mb-3">
        <Link href="/" className="hover:text-accent">Home</Link>
        <span className="mx-2">/</span>
        <span>Districts</span>
        {parent?.name && (
          <>
            <span className="mx-2">/</span>
            <span>{parent.name}</span>
          </>
        )}
      </nav>

      <header className="mb-6">
        <h1 className="text-2xl font-bold text-ink">{district.name}</h1>
        <p className="mt-1 text-sm text-ink-soft">
          {chamberLabel}{districtNum ? ` · District ${districtNum}` : ""}
          {stateAbbr ? ` · ${stateAbbr}` : ""}
        </p>
      </header>

      <section className="mb-8">
        <DeferredDistrictMap geometry={geometry} />
      </section>

      <section>
        <h2 className="text-lg font-semibold text-ink mb-3">
          Representatives ({officials.length})
        </h2>
        {officials.length === 0 ? (
          <p className="text-sm text-ink-soft">
            No active officials are currently linked to this district. The cross-link is built
            from OpenStates district names and may miss states with non-numeric district
            conventions (e.g. Massachusetts, Vermont, New Hampshire multi-member districts).
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {officials.map((o) => {
              const badge = PARTY_BADGE[(o.party ?? "").toLowerCase()] ?? "bg-rule/40 text-ink-soft";
              return (
                <li key={o.id}>
                  <Link
                    href={`/officials/${o.id}`}
                    className="block border border-rule bg-card p-3 hover:border-accent hover:shadow-sm transition-all"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-semibold text-ink leading-tight">{o.full_name}</p>
                      {o.party && (
                        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${badge}`}>
                          {o.party[0]}
                        </span>
                      )}
                    </div>
                    {o.role_title && <p className="mt-0.5 text-xs text-ink-soft">{o.role_title}</p>}
                    {o.district_name && <p className="mt-0.5 text-xs text-ink-soft/70">District {o.district_name}</p>}
                    <p className="mt-2 text-xs font-medium text-accent">View profile →</p>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
