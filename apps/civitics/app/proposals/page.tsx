// Public read-only page; no auth dependency. ISR-eligible: Next.js will
// render per-searchParams-combination on demand and serve the cached result
// for the next 5 min. Combined with FIX-201's CDN cache, repeat visitors
// hit the edge in ~30ms instead of paying the full SSR cost each time.
export const revalidate = 300;

import type { Metadata } from "next";
import { createPublicClient } from "@civitics/db";
import { withDbTimeout } from "@/lib/supabase-check";
import { ProposalCard, type ProposalCardData } from "./components/ProposalCard";
import { FeaturedSection } from "./components/FeaturedSection";
import { AGENCY_FULL_NAMES } from "./components/agencyNames";
import type { EntityTag } from "../components/tags/EntityTags";
import { PageViewTracker } from "../components/PageViewTracker";
import { PageHeader } from "@civitics/ui";
import { Icon } from "@civitics/graph";

const PAGE_SIZE = 20;

const PROPOSAL_TYPE_LABELS: Record<string, string> = {
  regulation:      "Federal Regulation",
  bill:            "Congressional Bill",
  executive_order: "Executive Order",
  treaty:          "Treaty",
  referendum:      "Referendum",
  resolution:      "Resolution",
};

// Top agencies by proposal volume — used for the filter dropdown.
const AGENCIES = [
  "EPA","FAA","USCG","FCC","FWS","NOAA","IRS","NCUA","OSHA","AMS",
  "CMS","OCC","NRC","ED","FERC","OPM","FDA","VA","CPSC","NHTSA",
];

// Topic filter pills — top 8 by proposal volume
const TOPIC_PILLS = [
  { tag: "climate",             label: "Climate",      icon: "climate" },
  { tag: "healthcare",          label: "Healthcare",   icon: "healthcare" },
  { tag: "finance",             label: "Finance",      icon: "finance" },
  { tag: "aviation",            label: "Aviation",     icon: "aviation" },
  { tag: "agriculture",         label: "Agriculture",  icon: "agriculture" },
  { tag: "energy",              label: "Energy",       icon: "energy" },
  { tag: "education",           label: "Education",    icon: "education" },
  { tag: "consumer_protection", label: "Consumer",     icon: "consumer_protection" },
];

type SearchParams = {
  status?: string;
  type?: string;
  agency?: string;
  topics?: string;
  sort?: string;
  q?: string;
  page?: string;
};

const SORT_OPTIONS = [
  { value: "closing_soon", label: "Closing soon" },
  { value: "newest",       label: "Newest" },
  { value: "title",        label: "A–Z" },
];

function buildUrl(base: SearchParams, updates: Partial<SearchParams>): string {
  // Merge — only reset page to "1" when the update is a filter change (no explicit page)
  const merged = { ...base, ...updates };
  if (!("page" in updates)) merged.page = "1";
  const params = new URLSearchParams();
  if (merged.status && merged.status !== "all") params.set("status", merged.status);
  if (merged.type)   params.set("type",   merged.type);
  if (merged.agency) params.set("agency", merged.agency);
  if (merged.topics) params.set("topics", merged.topics);
  if (merged.sort)   params.set("sort",   merged.sort);
  if (merged.q)      params.set("q",      merged.q);
  if (merged.page && merged.page !== "1") params.set("page", merged.page);
  const qs = params.toString();
  return `/proposals${qs ? `?${qs}` : ""}`;
}

function toggleTopicInUrl(base: SearchParams, topic: string): string {
  const current = (base.topics ?? "").split(",").filter(Boolean);
  const next = current.includes(topic)
    ? current.filter((t) => t !== topic)
    : [...current, topic];
  return buildUrl(base, { topics: next.join(",") || undefined });
}

function buildCountLabel(
  totalCount: number,
  statusFilter: string,
  searchQ: string
): string {
  if (searchQ) return `${totalCount.toLocaleString()} proposals matching "${searchQ}"`;
  if (statusFilter === "open") return `${totalCount.toLocaleString()} open for comment`;
  if (statusFilter === "closed") return `${totalCount.toLocaleString()} closed proposals`;
  return `${totalCount.toLocaleString()} total proposals`;
}

// FIX-513 (crawler hardening): the bare /proposals stays indexable, but any filtered
// or paginated view gets noindex,follow. ClaudeBot walked the full faceted URL space
// (every ?status&type&agency&topics&sort&q&page combo is a unique SSR/cache-miss),
// driving ~430K Vercel invocations on 2026-06-07 (656K of the 1M cap). noindex,follow
// keeps the facets crawlable-for-links but out of the index so they aren't re-walked.
export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<Metadata> {
  const pageNum = parseInt(searchParams.page ?? "1", 10);
  const isDefaultView =
    !searchParams.status &&
    !searchParams.type &&
    !searchParams.agency &&
    !searchParams.topics &&
    !searchParams.sort &&
    !searchParams.q &&
    (!searchParams.page || !(pageNum > 1));

  return {
    title: "Proposals · Civitics",
    description: "Bills, regulations, and rules open for public comment.",
    ...(isDefaultView ? {} : { robots: { index: false, follow: true } }),
  };
}

export default async function ProposalsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const supabase = createPublicClient();

  const statusFilter = searchParams.status ?? "all";
  const typeFilter   = searchParams.type   ?? "";
  const agencyFilter = searchParams.agency ?? "";
  const topicsFilter = searchParams.topics ?? "";
  const sortFilter   = searchParams.sort   ?? "closing_soon";
  const searchQ      = searchParams.q      ?? "";
  // FIX-513: clamp page to [1, 500] (no 404, just clamp) so crawlers can't walk an
  // unbounded paginated URL space. parseInt NaN falls back to 1.
  const page         = Math.min(500, Math.max(1, parseInt(searchParams.page ?? "1", 10) || 1));
  const offset       = (page - 1) * PAGE_SIZE;
  const activeTopics = topicsFilter ? topicsFilter.split(",").filter(Boolean) : [];

  const now = new Date().toISOString();

  // ─── Featured section queries (all three tabs) ────────────────────────────
  const openFeaturedQuery = withDbTimeout(
    supabase
      .from("proposals")
      .select("id,title,type,status,summary_plain,summary_model,introduced_at,metadata,is_synthetic")
      .eq("status", "open_comment")
      .gt("metadata->>comment_period_end", now)
      .order("metadata->>comment_period_end", { ascending: true })
      .limit(6),
    3000,
    "proposals:featured-open",
  );

  const billsQuery = withDbTimeout(
    supabase
      .from("proposals")
      .select("id,title,type,status,summary_plain,summary_model,introduced_at,metadata,is_synthetic")
      .eq("type", "bill")
      .order("introduced_at", { ascending: false, nullsFirst: false })
      .limit(6),
    3000,
    "proposals:featured-bills",
  );

  // FIX-200: replaced the per-request page_views scan + JS aggregation with
  // the proposal_popularity_24h materialized view. Refreshed nightly via
  // refresh_proposal_popularity().
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sbAny2 = supabase as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const topViewedIdsRes: any = await withDbTimeout(
    sbAny2
      .from("proposal_popularity_24h")
      .select("proposal_id")
      .order("view_count", { ascending: false })
      .limit(6),
    3000,
    "proposals:top-viewed-ids",
  );
  const topProposalIds: string[] = (topViewedIdsRes.data ?? []).map(
    (r: { proposal_id: string }) => r.proposal_id
  );

  const mostViewedQuery =
    topProposalIds.length > 0
      ? withDbTimeout(
          supabase
            .from("proposals")
            .select("id,title,type,status,summary_plain,summary_model,introduced_at,metadata,is_synthetic")
            // .in() bounded: proposal_popularity_24h `.limit(6)` above, max 6 — FIX-902
            .in("id", topProposalIds),
          3000,
          "proposals:featured-most-viewed",
        )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      : Promise.resolve({ data: [] as any[], error: null });

  // ─── Trending / Most Commented / New queries (FIX-029) ────────────────────
  // Trending uses the proposal_trending_24h materialized view (nightly refresh).
  // Most commented uses the proposal_comment_stats live view.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const trendingIdsRes: any = await withDbTimeout(
    sbAny2
      .from("proposal_trending_24h")
      .select("proposal_id, trending_score")
      .order("trending_score", { ascending: false, nullsFirst: false })
      .limit(6),
    3000,
    "proposals:trending-ids",
  );
  const trendingIds = (trendingIdsRes.data ?? []).map((r: { proposal_id: string }) => r.proposal_id);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mostCommentedIdsRes: any = await withDbTimeout(
    sbAny2
      .from("proposal_comment_stats")
      .select("proposal_id, comment_count")
      .order("comment_count", { ascending: false, nullsFirst: false })
      .limit(6),
    3000,
    "proposals:most-commented-ids",
  );
  const mostCommentedIds = (mostCommentedIdsRes.data ?? []).map((r: { proposal_id: string }) => r.proposal_id);

  const trendingQuery = trendingIds.length > 0
    ? withDbTimeout(
        supabase
          .from("proposals")
          .select("id,title,type,status,summary_plain,summary_model,introduced_at,metadata,is_synthetic")
          // .in() bounded: proposal_trending_24h `.limit(6)` above, max 6 — FIX-902
          .in("id", trendingIds),
        3000,
        "proposals:featured-trending",
      )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    : Promise.resolve({ data: [] as any[], error: null });

  const mostCommentedQuery = mostCommentedIds.length > 0
    ? withDbTimeout(
        supabase
          .from("proposals")
          .select("id,title,type,status,summary_plain,summary_model,introduced_at,metadata,is_synthetic")
          // .in() bounded: proposal_comment_stats `.limit(6)` above, max 6 — FIX-902
          .in("id", mostCommentedIds),
        3000,
        "proposals:featured-most-commented",
      )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    : Promise.resolve({ data: [] as any[], error: null });

  const newestQuery = withDbTimeout(
    supabase
      .from("proposals")
      .select("id,title,type,status,summary_plain,summary_model,introduced_at,metadata,is_synthetic")
      .order("introduced_at", { ascending: false, nullsFirst: false })
      .limit(6),
    3000,
    "proposals:featured-newest",
  );

  // ─── Filtered main list ───────────────────────────────────────────────────
  // PostgREST builder mutated across the filter/sort block below; wrapped in
  // withDbTimeout at the mainListPromise ternary (the guard's lexical enclosure
  // check can't span the let-reassignment).
  let mainQuery = supabase // db-timeout-exempt: wrapped at mainListPromise ternary below
    .from("proposals")
    .select(
      "id,title,type,status,summary_plain,summary_model,introduced_at,metadata,is_synthetic",
      { count: "exact" },
    );

  // Status filter — comment_period_end now lives in metadata JSONB.
  if (statusFilter === "open") {
    mainQuery = mainQuery.eq("status", "open_comment").gt("metadata->>comment_period_end", now);
  } else if (statusFilter === "closed") {
    mainQuery = mainQuery.or(
      `status.eq.comment_closed,and(status.eq.open_comment,metadata->>comment_period_end.lt.${now})`
    );
  }
  // "all" — no status filter

  // Type filter
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeFilter) mainQuery = mainQuery.eq("type", typeFilter as any);

  // Agency filter (via metadata JSONB)
  if (agencyFilter) mainQuery = mainQuery.filter("metadata->>agency_id", "eq", agencyFilter);

  // Text search
  if (searchQ) mainQuery = mainQuery.ilike("title", `%${searchQ}%`);

  // Topic filter — FIX-514: when topics are active, the whole main list is served by
  // the get_topic_proposal_page RPC (entity_tags × proposals joined server-side), so
  // the request URL stays constant-length. The old two-step fetched up to 1,000 tag
  // matches and stuffed the UUIDs into `.in("id", …)` — a ~37 KB URL that Kong
  // rejected with a 400 (swallowed → silent empty page). See the RPC migration.
  // The non-topics path below keeps the existing PostgREST builder unchanged.

  // Sort and paginate (non-topics path only)
  if (sortFilter === "newest") {
    mainQuery = mainQuery.order("introduced_at", { ascending: false, nullsFirst: false });
  } else if (sortFilter === "title") {
    mainQuery = mainQuery.order("title", { ascending: true });
  } else {
    // Default: closing soonest first (but open periods still come before nulls)
    mainQuery = mainQuery.order("metadata->>comment_period_end", { ascending: true, nullsFirst: false });
  }
  mainQuery = mainQuery.range(offset, offset + PAGE_SIZE - 1);

  // FIX-514: topics active → server-side RPC; otherwise the existing builder.
  const useTopicsRpc = activeTopics.length > 0;
  // get_topic_proposal_page is not in the generated types — cast to call it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sbRpc = supabase as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mainListPromise: Promise<any> = useTopicsRpc
    ? withDbTimeout(
        sbRpc.rpc("get_topic_proposal_page", {
          p_tags:   activeTopics,
          p_status: statusFilter,
          p_type:   typeFilter,
          p_agency: agencyFilter,
          p_q:      searchQ,
          p_sort:   sortFilter,
          p_offset: offset,
          p_limit:  PAGE_SIZE,
        }),
        3000,
        "proposals:list-topics-rpc",
      )
    : withDbTimeout(mainQuery, 3000, "proposals:list");

  // Each query const is already raced through withDbTimeout at its declaration
  // (and mainListPromise at its ternary), so they're passed through here as-is.
  const [openFeaturedRes, billsRes, mostViewedRes, trendingRes, mostCommentedRes, newestRes, mainRes] = await Promise.all([
    openFeaturedQuery,
    billsQuery,
    mostViewedQuery,
    trendingQuery,
    mostCommentedQuery,
    newestQuery,
    mainListPromise,
  ]);

  // RPC errors must NOT be swallowed into a fake zero-result. Flag a degraded
  // state and render the empty block with a "try again" message instead.
  const topicQueryFailed = useTopicsRpc && Boolean(mainRes?.error);

  // Post-promotion, regulations_gov_id / congress_gov_url / comment_period_end
  // live in proposals.metadata — flatten back into the legacy ProposalCardData shape.
  type ProposalRow = {
    id: string;
    title: string;
    type: string;
    status: string;
    summary_plain: string | null;
    summary_model: string | null;
    introduced_at: string | null;
    metadata: Record<string, string> | null;
    is_synthetic?: boolean | null;
  };
  function toCardShape(r: ProposalRow): ProposalCardData {
    const meta = (r.metadata ?? {}) as Record<string, string>;
    return {
      id:                 r.id,
      title:              r.title,
      type:               r.type,
      status:             r.status,
      regulations_gov_id: meta.regulations_gov_id ?? null,
      congress_gov_url:   meta.congress_gov_url   ?? null,
      comment_period_end: meta.comment_period_end ?? null,
      summary_plain:      r.summary_plain,
      summary_model:      r.summary_model,
      introduced_at:      r.introduced_at,
      metadata:           meta,
      is_synthetic:       r.is_synthetic ?? false,
    };
  }

  const rawOpenFeatured   = ((openFeaturedRes.data  ?? []) as ProposalRow[]).map(toCardShape);
  const rawBills          = ((billsRes.data          ?? []) as ProposalRow[]).map(toCardShape);
  const rawMostViewed     = ((mostViewedRes.data     ?? []) as ProposalRow[]).map(toCardShape);
  const rawTrending       = ((trendingRes.data       ?? []) as ProposalRow[]).map(toCardShape);
  const rawMostCommented  = ((mostCommentedRes.data  ?? []) as ProposalRow[]).map(toCardShape);
  const rawNewest         = ((newestRes.data         ?? []) as ProposalRow[]).map(toCardShape);
  const rawMainProposals  = ((mainRes.data           ?? []) as ProposalRow[]).map(toCardShape);
  // RPC path: total comes from the count(*) OVER() window column on each row (0 rows
  // → 0 total, the correct zero-match result). Builder path: PostgREST exact count.
  const totalCount = useTopicsRpc
    ? Number(
        (mainRes.data?.[0] as { total_count?: number | string } | undefined)?.total_count ?? 0,
      )
    : (mainRes.count ?? 0);
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  // ─── AI summary cache lookup ──────────────────────────────────────────────
  // Fetch cached summaries for all proposals on this page in one query
  const allProposalIds = [
    ...rawOpenFeatured.map((p) => p.id),
    ...rawBills.map((p) => p.id),
    ...rawMostViewed.map((p) => p.id),
    ...rawTrending.map((p) => p.id),
    ...rawMostCommented.map((p) => p.id),
    ...rawNewest.map((p) => p.id),
    ...rawMainProposals.map((p) => p.id),
  ].filter((id, i, arr) => arr.indexOf(id) === i);

  // .in() bounded: six featured strips at `.limit(6)` plus one main page at
  // PAGE_SIZE (20) — max 56, and every contributing query carries its own
  // explicit limit. Both reads below share this list — FIX-902
  // ai_summary_cache may not be in generated types — cast to bypass
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [summaryRes, tagsRes] = (await Promise.all([
    allProposalIds.length > 0
      ? withDbTimeout(
          sb
            .from("ai_summary_cache")
            .select("entity_id,summary_text")
            .eq("entity_type", "proposal")
            .in("entity_id", allProposalIds),
          3000,
          "proposals:summaries",
        )
      : Promise.resolve({ data: [] }),
    allProposalIds.length > 0
      ? withDbTimeout(
          sb
            .from("entity_tags")
            .select("entity_id,tag,tag_category,display_label,display_icon,visibility,confidence,generated_by,ai_model,metadata")
            .eq("entity_type", "proposal")
            .in("entity_id", allProposalIds),
          3000,
          "proposals:tags",
        )
      : Promise.resolve({ data: [] }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ])) as [any, any];

  const summaryMap: Record<string, string> = {};
  for (const s of summaryRes.data ?? []) {
    if (!summaryMap[s.entity_id]) summaryMap[s.entity_id] = s.summary_text;
  }

  const tagsMap: Record<string, EntityTag[]> = {};
  for (const t of tagsRes.data ?? []) {
    const eid = t.entity_id as string;
    if (!tagsMap[eid]) tagsMap[eid] = [];
    tagsMap[eid]!.push(t as EntityTag);
  }

  // Enrich proposals with agency names, AI summaries, and tags
  function enrich(p: ProposalCardData): ProposalCardData {
    const acronym = p.metadata?.agency_id ?? null;
    return {
      ...p,
      agency_name: acronym ? (AGENCY_FULL_NAMES[acronym] ?? null) : null,
      ai_summary: summaryMap[p.id] ?? null,
      tags: tagsMap[p.id] ?? [],
    };
  }

  const openFeatured  = rawOpenFeatured.map(enrich);
  const featuredBills = rawBills.map(enrich);
  // Preserve the score-based ordering returned by the views by reindexing lookup.
  // Most-viewed comes from proposal_popularity_24h (already ordered DESC).
  const popularityOrder = new Map<string, number>(topProposalIds.map((id: string, i: number) => [id, i]));
  const featuredMostViewed = rawMostViewed
    .map(enrich)
    .sort((a, b) => (popularityOrder.get(a.id) ?? 999) - (popularityOrder.get(b.id) ?? 999));
  const trendingOrder = new Map<string, number>(trendingIds.map((id: string, i: number) => [id, i]));
  const commentedOrder = new Map<string, number>(mostCommentedIds.map((id: string, i: number) => [id, i]));
  const featuredTrending = rawTrending
    .map(enrich)
    .sort((a, b) => (trendingOrder.get(a.id) ?? 999) - (trendingOrder.get(b.id) ?? 999));
  const featuredMostCommented = rawMostCommented
    .map(enrich)
    .sort((a, b) => (commentedOrder.get(a.id) ?? 999) - (commentedOrder.get(b.id) ?? 999));
  const featuredNewest = rawNewest.map(enrich);
  const mainProposals = rawMainProposals.map(enrich);

  const showFeaturedSection =
    statusFilter !== "closed" && !typeFilter && !agencyFilter && !topicsFilter && !searchQ && page === 1;

  const currentParams: SearchParams = {
    status: statusFilter,
    type: typeFilter || undefined,
    agency: agencyFilter || undefined,
    topics: topicsFilter || undefined,
    sort: sortFilter !== "closing_soon" ? sortFilter : undefined,
    q: searchQ || undefined,
  };

  const countLabel = buildCountLabel(totalCount, statusFilter, searchQ);

  return (
    <main id="main-content" className="min-h-screen bg-paper">
      <PageViewTracker entityType="proposal_list" />
      {/* ─── Header ────────────────────────────────────────────────────────── */}
      <div className="border-b border-rule bg-card">
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          <PageHeader
            title="Proposals"
            description="Bills, regulations, and rules open for public comment."
            breadcrumb={[
              { label: "Civitics", href: "/" },
              { label: "Proposals" },
            ]}
            badge={`${totalCount.toLocaleString()} total`}
          />
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">

        {/* ─── Featured — tabbed: Closing Soon / Bills / Most Viewed ──────── */}
        {showFeaturedSection && (
          openFeatured.length > 0 ||
          featuredBills.length > 0 ||
          featuredMostViewed.length > 0 ||
          featuredTrending.length > 0 ||
          featuredMostCommented.length > 0 ||
          featuredNewest.length > 0
        ) && (
          <FeaturedSection
            closingSoon={openFeatured}
            bills={featuredBills}
            mostViewed={featuredMostViewed}
            trending={featuredTrending}
            mostCommented={featuredMostCommented}
            newest={featuredNewest}
          />
        )}

        {/* ─── Topic filter pills ──────────────────────────────────────── */}
        <nav aria-label="Filter by topic" className="mb-4 flex flex-wrap items-center gap-2">
          <a
            href={buildUrl(currentParams, { topics: undefined })}
            aria-current={activeTopics.length === 0 ? "true" : undefined}
            className={`inline-flex items-center rounded px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 ${
              activeTopics.length === 0
                ? "bg-ink text-paper"
                : "bg-card border border-rule text-ink-soft hover:border-accent hover:text-accent"
            }`}
          >
            All
          </a>
          {TOPIC_PILLS.map((pill) => {
            const isActive = activeTopics.includes(pill.tag);
            return (
              <a
                key={pill.tag}
                href={toggleTopicInUrl(currentParams, pill.tag)}
                aria-current={isActive ? "true" : undefined}
                className={`inline-flex items-center gap-1 rounded px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 ${
                  isActive
                    ? "bg-ink text-paper"
                    : "bg-card border border-rule text-ink-soft hover:border-accent hover:text-accent"
                }`}
              >
                <Icon name={pill.icon} className="w-3.5 h-3.5" />
                {pill.label}
              </a>
            );
          })}
        </nav>

        {/* ─── Filters ───────────────────────────────────────────────────── */}
        <div className="mb-6 border border-rule bg-card p-4">
          <form method="GET" action="/proposals" className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
            {/* Status */}
            <div className="flex flex-col gap-1 w-full sm:w-auto">
              <label htmlFor="filter-status" className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-soft/70">Status</label>
              <select
                id="filter-status"
                name="status"
                defaultValue={statusFilter}
                className="w-full border border-rule bg-paper px-3 py-2 text-sm text-ink focus:border-accent focus:bg-card focus:outline-none focus:ring-1 focus:ring-accent"
              >
                <option value="open">Open for Comment</option>
                <option value="all">All Proposals</option>
                <option value="closed">Comment Closed</option>
              </select>
            </div>

            {/* Type */}
            <div className="flex flex-col gap-1 w-full sm:w-auto">
              <label htmlFor="filter-type" className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-soft/70">Type</label>
              <select
                id="filter-type"
                name="type"
                defaultValue={typeFilter}
                className="w-full border border-rule bg-paper px-3 py-2 text-sm text-ink focus:border-accent focus:bg-card focus:outline-none focus:ring-1 focus:ring-accent"
              >
                <option value="">All Types</option>
                {Object.entries(PROPOSAL_TYPE_LABELS).map(([val, label]) => (
                  <option key={val} value={val}>
                    {label}
                  </option>
                ))}
              </select>
            </div>

            {/* Agency */}
            <div className="flex flex-col gap-1 w-full sm:w-auto">
              <label htmlFor="filter-agency" className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-soft/70">Agency</label>
              <select
                id="filter-agency"
                name="agency"
                defaultValue={agencyFilter}
                className="w-full border border-rule bg-paper px-3 py-2 text-sm text-ink focus:border-accent focus:bg-card focus:outline-none focus:ring-1 focus:ring-accent"
              >
                <option value="">All Agencies</option>
                {AGENCIES.map((a) => {
                  const fullName = AGENCY_FULL_NAMES[a];
                  return (
                    <option key={a} value={a}>
                      {a}{fullName ? ` · ${fullName.length > 35 ? fullName.slice(0, 35) + "…" : fullName}` : ""}
                    </option>
                  );
                })}
              </select>
            </div>

            {/* Sort */}
            <div className="flex flex-col gap-1 w-full sm:w-auto">
              <label htmlFor="filter-sort" className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-soft/70">Sort by</label>
              <select
                id="filter-sort"
                name="sort"
                defaultValue={sortFilter}
                className="w-full border border-rule bg-paper px-3 py-2 text-sm text-ink focus:border-accent focus:bg-card focus:outline-none focus:ring-1 focus:ring-accent"
              >
                {SORT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Search */}
            <div className="flex flex-col gap-1 w-full sm:flex-1 sm:min-w-[180px]">
              <label htmlFor="filter-search" className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-soft/70">Search</label>
              <input
                id="filter-search"
                type="text"
                name="q"
                defaultValue={searchQ}
                placeholder="Search proposals…"
                className="w-full border border-rule bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-soft/60 focus:border-accent focus:bg-card focus:outline-none focus:ring-1 focus:ring-accent"
              />
            </div>

            <button
              type="submit"
              className="w-full sm:w-auto bg-ink px-4 py-2 text-sm font-medium text-paper hover:bg-accent transition-colors"
            >
              Filter
            </button>

            {(statusFilter !== "open" || typeFilter || agencyFilter || topicsFilter || sortFilter !== "closing_soon" || searchQ) && (
              <a
                href="/proposals"
                className="border border-rule px-4 py-2 text-sm font-medium text-ink hover:border-accent hover:text-accent transition-colors"
              >
                Clear
              </a>
            )}
          </form>
        </div>

        {/* ─── Results header ─────────────────────────────────────────────── */}
        <div className="mb-4 flex items-center justify-between">
          <p className="text-sm text-ink-soft">
            {totalCount === 0 ? "No proposals found" : countLabel}
          </p>
          {totalPages > 1 && (
            <p className="font-mono text-sm tabular-nums text-ink-soft/70">
              Page {page} of {totalPages}
            </p>
          )}
        </div>

        {/* ─── Proposals grid ─────────────────────────────────────────────── */}
        {mainProposals.length === 0 ? (
          <div className="border border-dashed border-rule bg-card px-8 py-16 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-paper-2">
              <svg aria-hidden="true" className="h-6 w-6 text-ink-soft/60" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <p className="text-sm font-semibold text-ink">
              {topicQueryFailed ? "We couldn’t load results for this topic." : "No proposals match your filters."}
            </p>
            <p className="mt-1 text-sm text-ink-soft">
              {topicQueryFailed
                ? "Something went wrong fetching this topic. Please try again in a moment."
                : "Try adjusting the status, type, or topic filters, or clear your search."}
            </p>
            <a href="/proposals" className="mt-4 inline-block text-sm font-medium text-accent hover:underline">
              Clear filters →
            </a>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {mainProposals.map((p) => (
              <ProposalCard key={p.id} proposal={p} />
            ))}
          </div>
        )}

        {/* ─── Pagination ──────────────────────────────────────────────────── */}
        {totalPages > 1 && (
          <nav aria-label="Pagination" className="mt-8 flex items-center justify-center gap-2">
            {page > 1 && (
              <a
                href={buildUrl(currentParams, { page: String(page - 1) })}
                className="border border-rule bg-card px-4 py-2 text-sm font-medium text-ink hover:border-accent hover:text-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                ← Previous
              </a>
            )}

            {/* Page numbers — show current ±2 */}
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter((p) => p === 1 || p === totalPages || Math.abs(p - page) <= 2)
              .reduce<(number | "…")[]>((acc, p, i, arr) => {
                if (i > 0 && (arr[i - 1] as number) < p - 1) acc.push("…");
                acc.push(p);
                return acc;
              }, [])
              .map((p, i) =>
                p === "…" ? (
                  <span key={`ellipsis-${i}`} aria-hidden="true" className="px-1 text-ink-soft/70">…</span>
                ) : (
                  <a
                    key={p}
                    href={buildUrl(currentParams, { page: String(p) })}
                    aria-current={p === page ? "page" : undefined}
                    aria-label={p === page ? `Page ${p}, current page` : `Page ${p}`}
                    className={`border px-3 py-2 font-mono text-sm font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                      p === page
                        ? "border-ink bg-ink text-paper"
                        : "border-rule bg-card text-ink hover:border-accent hover:text-accent"
                    }`}
                  >
                    {p}
                  </a>
                )
              )}

            {page < totalPages && (
              <a
                href={buildUrl(currentParams, { page: String(page + 1) })}
                className="border border-rule bg-card px-4 py-2 text-sm font-medium text-ink hover:border-accent hover:text-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                Next →
              </a>
            )}
          </nav>
        )}
      </div>
    </main>
  );
}
