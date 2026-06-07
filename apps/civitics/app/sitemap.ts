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
// goes through PostgREST), so 1000 is the real per-segment ceiling — a higher
// .limit() is silently truncated (same cap behind [[FIX-510]]). Decision: publishable
// client only (no admin), single query per segment, so each segment tops out at 1000.
// Proposals are ordered newest-first so the 1000 are the most recent. Trade-off worth
// noting: with robots.txt now blocking ?page= crawling, this sitemap is the primary
// discovery path, and it covers only the most recent ~1000 of each large set (78k
// proposals, 27k officials, 10k jurisdictions). See [[FIX-517]] to widen coverage via
// paginated/admin-side sitemap generation if SEO indexing of older entities matters.
const LIMITS = { proposals: 1000, officials: 1000, institutions: 1000, jurisdictions: 1000 } as const;
const MAX_URLS = 10000;
const QUERY_TIMEOUT_MS = 5000;

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

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticEntries: MetadataRoute.Sitemap = STATIC_PATHS.map((p) => ({
    url: p === "/" ? BASE : `${BASE}${p}`,
    changeFrequency: "daily" as const,
    priority: p === "/" ? 1 : 0.7,
  }));

  try {
    const supabase = createPublicClient();
    const [proposals, officials, institutions, jurisdictions] = await Promise.all([
      timed(
        supabase
          .from("proposals")
          .select("id")
          .order("introduced_at", { ascending: false, nullsFirst: false })
          .limit(LIMITS.proposals),
      ),
      timed(supabase.from("officials").select("id").eq("is_active", true).order("id").limit(LIMITS.officials)),
      timed(supabase.from("institutions").select("id").eq("is_active", true).order("id").limit(LIMITS.institutions)),
      timed(supabase.from("jurisdictions").select("id").eq("is_active", true).order("id").limit(LIMITS.jurisdictions)),
    ]);

    const mk = (seg: string, rows: IdRow[] | null, priority: number): MetadataRoute.Sitemap =>
      (rows ?? []).map((r) => ({
        url: `${BASE}/${seg}/${r.id}`,
        changeFrequency: "weekly" as const,
        priority,
      }));

    return [
      ...staticEntries,
      ...mk("proposals", proposals, 0.6),
      ...mk("officials", officials, 0.6),
      ...mk("institutions", institutions, 0.5),
      ...mk("jurisdictions", jurisdictions, 0.5),
    ].slice(0, MAX_URLS);
  } catch {
    return staticEntries;
  }
}
