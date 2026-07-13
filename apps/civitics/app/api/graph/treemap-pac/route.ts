import { createAdminClient } from "@civitics/db";
import { withPublicCdnCache } from "@/lib/cdn-cache";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";

export const dynamic = "force-dynamic";

// ── Hierarchy types ──────────────────────────────────────────────────────────

interface PacLeaf {
  name: string;
  value: number;
  count: number;
}

interface PacGroup {
  name: string;
  totalUsd: number;
  children: PacLeaf[];
}

interface PacHierarchy {
  name: string;
  children: PacGroup[];
}

const CACHE_HEADERS = {
  "Cache-Control": "public, max-age=0, s-maxage=86400, stale-while-revalidate=172800",
};

// PAC display names that are FEC junk rollup buckets, not real committees.
function isJunkPacName(name: string | null): boolean {
  if (!name) return true;
  const u = name.toUpperCase();
  return u.includes("PAC/COMMITTEE") || u.includes("COMMITTEE CONTRIBUTIONS");
}

// ── Route handler ────────────────────────────────────────────────────────────
//
// FIX-518 — all three aggregation shapes now read the donor-rollup MVs instead
// of paging financial_relationships per 300-PAC batch (silently capped over
// 1.9M rows → global totals were WRONG, the last open FIX-510-class surface):
//   * entityId mode (sector + party) → official_donor_rollup_mv (rollup #1),
//     the PAC donors to one official, filtered to entity_type IN (pac,
//     party_committee) and read by rank (≤1000 rows, no request-time sort).
//   * global sector/party modes → get_pac_treemap_by_{sector,party} RPCs over
//     donor_party_rollup_mv (rollup #2). The RPCs do the GROUP BY + top-N cap
//     in-DB and return one jsonb `children` array — cap-proof (a set-returning
//     read of the ~7.4k-PAC subset would still hit the 1000-row PostgREST cap).
export async function GET(request: Request) {
  if (supabaseUnavailable()) return unavailableResponse();
  const supabase = createAdminClient();

  const { searchParams } = new URL(request.url);
  const groupBy = (searchParams.get("groupBy") ?? "sector") as "sector" | "party";
  // Industry filter: the canonical tag the UI sends (e.g. 'finance'), matched
  // against the MV's industry_tag column. Restricts the PAC set to one sector.
  const industryFilter = searchParams.get("industry");

  // FIX-220 — user-controlled donation floor (dollars), applied as a cents
  // threshold on per-donor totals.
  const minAmountUsd = Math.max(0, parseFloat(searchParams.get("minAmountUsd") ?? "0") || 0);
  const minCents = Math.round(minAmountUsd * 100);

  // FIX-216: when an officialId is provided, restrict the PAC set to those that
  // donated to that official (rollup #1 already holds exactly that, per official).
  const entityIdParam = searchParams.get("entityId");
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const entityId = entityIdParam && UUID_RE.test(entityIdParam) ? entityIdParam : null;

  // ── EntityId mode: PAC donors to one official, from rollup #1 ───────────────
  if (entityId) {
    // Official name (for the title) + party (party-mode grouping is degenerate:
    // one official has one party).
    const { data: o } = await supabase
      .from("officials")
      .select("full_name, party")
      .eq("id", entityId)
      .maybeSingle();
    const officialName = o?.full_name ?? null;
    const officialParty = o?.party ?? "Unknown";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: rollup, error } = await (supabase as any)
      .from("official_donor_rollup_mv")
      .select("donor_name, entity_type, industry_tag, industry_label, total_cents, tx_count")
      .eq("official_id", entityId)
      .eq("relationship_type", "donation")
      .in("entity_type", ["pac", "party_committee"])
      .order("rank", { ascending: true });
    if (error) {
      console.error("[treemap-pac/entity] rollup error:", error.message);
      return Response.json({ error: error.message }, { status: 500 });
    }

    let rows = ((rollup ?? []) as Array<{
      donor_name: string | null;
      entity_type: string | null;
      industry_tag: string | null;
      industry_label: string | null;
      total_cents: number;
      tx_count: number;
    }>).filter((r) => !isJunkPacName(r.donor_name) && Number(r.total_cents) >= minCents);

    if (industryFilter) rows = rows.filter((r) => r.industry_tag === industryFilter);

    if (groupBy === "party") {
      const leaves: PacLeaf[] = rows
        .map((r) => ({ name: r.donor_name as string, value: Number(r.total_cents) / 100, count: Number(r.tx_count) }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 50);
      const children: PacGroup[] = leaves.length
        ? [{ name: officialParty, totalUsd: leaves.reduce((s, l) => s + l.value, 0), children: leaves }]
        : [];
      const name = officialName ? `${officialName} — PAC Money by Party` : "PAC Money by Party";
      return withPublicCdnCache(Response.json({ name, children } satisfies PacHierarchy, { headers: CACHE_HEADERS }));
    }

    // Sector mode: group the official's PAC donors by industry_label.
    const bySector = new Map<string, PacLeaf[]>();
    for (const r of rows) {
      if (!r.industry_label) continue; // untagged PACs absent (FIX-179)
      const leaf: PacLeaf = { name: r.donor_name as string, value: Number(r.total_cents) / 100, count: Number(r.tx_count) };
      if (!bySector.has(r.industry_label)) bySector.set(r.industry_label, []);
      bySector.get(r.industry_label)!.push(leaf);
    }
    const PER_SECTOR_CAP = industryFilter ? Number.POSITIVE_INFINITY : 100;
    const SECTOR_CAP = industryFilter ? Number.POSITIVE_INFINITY : 15;
    const children: PacGroup[] = Array.from(bySector.entries())
      .map(([sector, leaves]) => {
        const top = leaves.sort((a, b) => b.value - a.value).slice(0, PER_SECTOR_CAP);
        return { name: sector, totalUsd: top.reduce((s, l) => s + l.value, 0), children: top };
      })
      .filter((g) => g.children.length > 0)
      .sort((a, b) => b.totalUsd - a.totalUsd)
      .slice(0, SECTOR_CAP);
    const baseName = industryFilter ? `${industryFilter} PACs` : "PAC Money by Sector";
    const name = officialName ? `${officialName} — ${baseName}` : baseName;
    return withPublicCdnCache(Response.json({ name, children } satisfies PacHierarchy, { headers: CACHE_HEADERS }));
  }

  // ── Global party mode: rollup #2 via RPC ───────────────────────────────────
  if (groupBy === "party") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc("get_pac_treemap_by_party", {
      p_min_cents: minCents,
    });
    if (error) {
      console.error("[treemap-pac/party] rpc error:", error.message);
      return Response.json({ error: error.message }, { status: 500 });
    }
    const children = ((data?.children ?? []) as PacGroup[]);
    return withPublicCdnCache(Response.json({ name: "PAC Money by Party", children } satisfies PacHierarchy, { headers: CACHE_HEADERS }));
  }

  // ── Global sector mode: rollup #2 via RPC ──────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc("get_pac_treemap_by_sector", {
    p_industry: industryFilter,
    p_min_cents: minCents,
  });
  if (error) {
    console.error("[treemap-pac/sector] rpc error:", error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
  const children = ((data?.children ?? []) as PacGroup[]);
  const name = industryFilter ? `${industryFilter} PACs` : "PAC Money by Sector";
  return withPublicCdnCache(Response.json({ name, children } satisfies PacHierarchy, { headers: CACHE_HEADERS }));
}
