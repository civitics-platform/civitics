import type { MetadataRoute } from "next";
import { createPublicClient } from "@civitics/db";

// FIX-513: give crawlers a canonical, bounded walk of the site instead of letting
// them spelunk the faceted /proposals?... URL space (ClaudeBot probed /sitemap.xml,
// got a 404 on 2026-06-07, and fell back to facet-crawling — ~430K Vercel
// invocations that day). Hard rules mirror the generateStaticParams guardrails in
// CLAUDE.md: a build must NEVER fail because the DB was unavailable, so every query
// is time-boxed (5s) and the whole thing degrades to a static-pages-only sitemap on
// any error. Publishable-key client only; explicit per-entity caps keep the total
// under the 10,000-URL ceiling.
export const revalidate = 86400; // 24h

const BASE = (process.env["NEXT_PUBLIC_SITE_URL"] ?? "https://civitics.com").replace(/\/+$/, "");

// PostgREST caps any single SELECT at max_rows = 1000 (the publishable/anon client
// goes through PostgREST), so 1000 is the per-REQUEST ceiling — a higher .limit()
// is silently truncated (same cap behind [[FIX-510]]). FIX-517: each segment now
// pages past the cap with .range() loops carrying a stable total order on a
// unique key (unordered range pagination double-counts — the exact bug that
// inflated audit counts 2.3× pre-FIX-476). The publishable-only decision from
// the [[FIX-513]] initial ship stands: no admin client, no direct pg here.
// Per-segment caps are sized so caps + static paths stay under the 10,000-URL
// ceiling: 5000 newest proposals (of ~78k), 2500 officials, 1000 institutions
// (all 716 fit).
//
// FIX-683 — stop advertising the ~10k EMPTY leaf shells (district/county
// jurisdictions, recordless officials) that drive crawlers into the heavy
// get_jurisdiction_page/get_official_page cold reads. Only CONTENT-BEARING leaves
// belong here:
//   * jurisdictions + districts → membership in jurisdiction_page_cache (FIX-663),
//     the exact refresh predicate (type IN country/state OR has officials/
//     institutions/proposals/active child/meetings). PK set, always in sync; ~62
//     today, all comfortably under the cap (no paging needed).
//   * officials → get_sitemap_official_ids (has >=1 vote / financial_relationship
//     / entity_connection); 64% of active officials are empty shells and are
//     dropped. Still capped at 2500.
const LIMITS = { proposals: 5000, officials: 2500, institutions: 1000 } as const;
const MAX_URLS = 10000;
const QUERY_TIMEOUT_MS = 5000;
const PAGE_SIZE = 1000; // PostgREST max_rows — the real per-request ceiling

// Param-free public listing pages. The faceted variants are noindex (robots.txt
// Disallow: /*? + generateMetadata), so only these clean URLs belong in the sitemap.
const STATIC_PATHS = [
  "/", "/about", "/proposals", "/officials", "/agencies",
  "/institutions", "/jurisdictions", "/graph", "/search",
  "/donors", "/districts", "/meetings", "/initiatives",
];

type IdRow = { id: string };

// Resolve to a {data} shape on success or null on timeout/error — never throws.
async function timed(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: PromiseLike<any>,
): Promise<IdRow[] | null> {
  return Promise.race<IdRow[] | null>([
    Promise.resolve(query)
      .then((r) => ((r?.data ?? null) as IdRow[] | null))
      .catch(() => null),
    new Promise<IdRow[] | null>((resolve) => setTimeout(() => resolve(null), QUERY_TIMEOUT_MS)),
  ]);
}

// FIX-517 — page one segment up to `cap` rows. Each page keeps the per-query
// 5s degrade contract: a timeout/error on page N keeps pages 1..N-1 and stops,
// never throws. `page` must apply .range(from, to) on a FRESH query carrying a
// stable total order on a unique key, or pages overlap/skip.
async function fetchPaged(
  cap: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: (from: number, to: number) => PromiseLike<any>,
): Promise<IdRow[]> {
  const rows: IdRow[] = [];
  for (let from = 0; from < cap; from += PAGE_SIZE) {
    const to = Math.min(from + PAGE_SIZE, cap) - 1;
    const batch = await timed(page(from, to));
    if (batch === null) break; // degrade: keep what already loaded
    rows.push(...batch);
    if (batch.length < to - from + 1) break; // short page → segment exhausted
  }
  return rows.slice(0, cap);
}

// FIX-683 — resolve a jsonb-array-returning RPC (get_sitemap_official_ids) to
// IdRow[]. Same 5s degrade contract as timed(): timeout/error → null → mk()
// renders the segment empty, never throws.
async function timedIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: PromiseLike<any>,
): Promise<IdRow[] | null> {
  return Promise.race<IdRow[] | null>([
    Promise.resolve(query)
      .then((r) => {
        const ids = (r?.data ?? null) as string[] | null;
        return ids ? ids.map((id) => ({ id })) : null;
      })
      .catch(() => null),
    new Promise<IdRow[] | null>((resolve) => setTimeout(() => resolve(null), QUERY_TIMEOUT_MS)),
  ]);
}

type CacheMember = { id: string; type: string };

// FIX-683 — content-bearing jurisdictions/districts via jurisdiction_page_cache
// membership, with the jurisdiction type embedded so the caller can route
// districts to /districts/[id]. Time-boxed + degrades to [] like every segment.
async function fetchCacheMembers(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
): Promise<CacheMember[]> {
  const result = await Promise.race<CacheMember[] | null>([
    Promise.resolve(
      supabase
        .from("jurisdiction_page_cache")
        .select("jurisdiction_id, jurisdictions(type)"),
    )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((r: any) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows = (r?.data ?? null) as Array<{ jurisdiction_id: string; jurisdictions: any }> | null;
        if (!rows) return null;
        return rows
          .map((row) => {
            const j = Array.isArray(row.jurisdictions) ? row.jurisdictions[0] : row.jurisdictions;
            return { id: row.jurisdiction_id, type: (j?.type ?? "") as string };
          })
          .filter((m) => Boolean(m.id));
      })
      .catch(() => null),
    new Promise<CacheMember[] | null>((resolve) => setTimeout(() => resolve(null), QUERY_TIMEOUT_MS)),
  ]);
  return result ?? [];
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticEntries: MetadataRoute.Sitemap = STATIC_PATHS.map((p) => ({
    url: p === "/" ? BASE : `${BASE}${p}`,
    changeFrequency: "daily" as const,
    priority: p === "/" ? 1 : 0.7,
  }));

  try {
    const supabase = createPublicClient();
    const [proposals, institutions, officials, cacheMembers] = await Promise.all([
      // introduced_at alone is not unique — the id tiebreak makes the order
      // total so range pages never overlap.
      fetchPaged(LIMITS.proposals, (f, t) =>
        supabase
          .from("proposals")
          .select("id")
          .order("introduced_at", { ascending: false, nullsFirst: false })
          .order("id", { ascending: true })
          .range(f, t),
      ),
      fetchPaged(LIMITS.institutions, (f, t) =>
        supabase.from("institutions").select("id").eq("is_active", true).order("id").range(f, t),
      ),
      // FIX-683 — content-bearing officials only (get_sitemap_official_ids returns
      // a bounded jsonb array of ids, so it dodges the 1000-row SETOF cap). Degrade
      // to [] on timeout/error like every other segment.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      timedIds(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any).rpc("get_sitemap_official_ids", { p_limit: LIMITS.officials }),
      ),
      // FIX-683 — content-bearing jurisdictions + districts = jurisdiction_page_cache
      // membership. Embed the type so districts route to /districts/[id] and the
      // rest to /jurisdictions/[id]. ~62 rows today; the default 1000-row page is
      // plenty (no .range() loop needed).
      fetchCacheMembers(supabase),
    ]);

    const mk = (seg: string, rows: IdRow[] | null, priority: number): MetadataRoute.Sitemap =>
      (rows ?? []).map((r) => ({
        url: `${BASE}/${seg}/${r.id}`,
        changeFrequency: "weekly" as const,
        priority,
      }));

    // Partition cache members by jurisdiction type: districts render at
    // /districts/[id], everything else (country/state/county/city/…) at
    // /jurisdictions/[id].
    const districtMembers = cacheMembers.filter((m) => m.type === "district");
    const jurisdictionMembers = cacheMembers.filter((m) => m.type !== "district");

    return [
      ...staticEntries,
      ...mk("proposals", proposals, 0.6),
      ...mk("officials", officials, 0.6),
      ...mk("institutions", institutions, 0.5),
      ...mk("jurisdictions", jurisdictionMembers, 0.5),
      ...mk("districts", districtMembers, 0.4),
    ].slice(0, MAX_URLS);
  } catch {
    return staticEntries;
  }
}
