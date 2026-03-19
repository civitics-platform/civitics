export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";
import { ProposalCard, type ProposalCardData } from "./components/ProposalCard";

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

type SearchParams = {
  status?: string;
  type?: string;
  agency?: string;
  q?: string;
  page?: string;
};

function buildUrl(base: SearchParams, updates: Partial<SearchParams>): string {
  // Merge — only reset page to "1" when the update is a filter change (no explicit page)
  const merged = { ...base, ...updates };
  if (!("page" in updates)) merged.page = "1";
  const params = new URLSearchParams();
  if (merged.status && merged.status !== "all") params.set("status", merged.status);
  if (merged.type)   params.set("type",   merged.type);
  if (merged.agency) params.set("agency", merged.agency);
  if (merged.q)      params.set("q",      merged.q);
  if (merged.page && merged.page !== "1") params.set("page", merged.page);
  const qs = params.toString();
  return `/proposals${qs ? `?${qs}` : ""}`;
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

export default async function ProposalsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const cookieStore = await cookies();
  const supabase = createServerClient(cookieStore);

  const statusFilter = searchParams.status ?? "open";
  const typeFilter   = searchParams.type   ?? "";
  const agencyFilter = searchParams.agency ?? "";
  const searchQ      = searchParams.q      ?? "";
  const page         = Math.max(1, parseInt(searchParams.page ?? "1", 10));
  const offset       = (page - 1) * PAGE_SIZE;

  const now = new Date().toISOString();

  // ─── Open-now featured section ────────────────────────────────────────────
  const openFeaturedQuery = supabase
    .from("proposals")
    .select("id,title,type,status,regulations_gov_id,congress_gov_url,comment_period_end,summary_plain,summary_model,introduced_at,metadata")
    .eq("status", "open_comment")
    .gt("comment_period_end", now)
    .order("comment_period_end", { ascending: true })
    .limit(6);

  // ─── Filtered main list ───────────────────────────────────────────────────
  let mainQuery = supabase
    .from("proposals")
    .select("id,title,type,status,regulations_gov_id,congress_gov_url,comment_period_end,summary_plain,summary_model,introduced_at,metadata", {
      count: "exact",
    });

  // Status filter
  if (statusFilter === "open") {
    mainQuery = mainQuery.eq("status", "open_comment").gt("comment_period_end", now);
  } else if (statusFilter === "closed") {
    mainQuery = mainQuery.or(`status.eq.comment_closed,and(status.eq.open_comment,comment_period_end.lt.${now})`);
  }
  // "all" — no status filter

  // Type filter
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeFilter) mainQuery = mainQuery.eq("type", typeFilter as any);

  // Agency filter (via metadata JSONB)
  if (agencyFilter) mainQuery = mainQuery.filter("metadata->>agency_id", "eq", agencyFilter);

  // Text search
  if (searchQ) mainQuery = mainQuery.ilike("title", `%${searchQ}%`);

  // Sort and paginate
  mainQuery = mainQuery
    .order("comment_period_end", { ascending: true, nullsFirst: false })
    .range(offset, offset + PAGE_SIZE - 1);

  // ─── Agency name lookup ───────────────────────────────────────────────────
  const agencyLookupQuery = supabase
    .from("agencies")
    .select("acronym,name")
    .not("acronym", "is", null);

  const [openFeaturedRes, mainRes, agencyLookupRes] = await Promise.all([
    openFeaturedQuery,
    mainQuery,
    agencyLookupQuery,
  ]);

  // Build acronym → full name map
  const agencyNameMap: Record<string, string> = {};
  for (const a of agencyLookupRes.data ?? []) {
    if (a.acronym) agencyNameMap[a.acronym] = a.name;
  }

  const rawOpenFeatured = (openFeaturedRes.data ?? []) as ProposalCardData[];
  const rawMainProposals = (mainRes.data ?? []) as ProposalCardData[];
  const totalCount = mainRes.count ?? 0;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  // ─── AI summary cache lookup ──────────────────────────────────────────────
  // Fetch cached summaries for all proposals on this page in one query
  const allProposalIds = [
    ...rawOpenFeatured.map((p) => p.id),
    ...rawMainProposals.map((p) => p.id),
  ];

  // ai_summary_cache may not be in generated types — cast to bypass
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;
  const summaryRes =
    allProposalIds.length > 0
      ? await sb
          .from("ai_summary_cache")
          .select("entity_id,summary_text")
          .eq("entity_type", "proposal")
          .in("entity_id", allProposalIds)
      : { data: [] };

  const summaryMap: Record<string, string> = {};
  for (const s of summaryRes.data ?? []) {
    if (!summaryMap[s.entity_id]) summaryMap[s.entity_id] = s.summary_text;
  }

  // Enrich proposals with agency names and AI summaries
  function enrich(p: ProposalCardData): ProposalCardData {
    const acronym = p.metadata?.agency_id ?? null;
    return {
      ...p,
      agency_name: acronym ? (agencyNameMap[acronym] ?? null) : null,
      ai_summary: summaryMap[p.id] ?? null,
    };
  }

  const openFeatured = rawOpenFeatured.map(enrich);
  const mainProposals = rawMainProposals.map(enrich);

  const showFeaturedSection =
    statusFilter !== "closed" && !typeFilter && !agencyFilter && !searchQ && page === 1;

  const currentParams: SearchParams = {
    status: statusFilter,
    type: typeFilter || undefined,
    agency: agencyFilter || undefined,
    q: searchQ || undefined,
  };

  const countLabel = buildCountLabel(totalCount, statusFilter, searchQ);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* ─── Header ────────────────────────────────────────────────────────── */}
      <div className="border-b border-gray-200 bg-white">
        <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
          <div className="max-w-2xl">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700">
              <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" />
              {totalCount.toLocaleString()} proposals · All public record
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-gray-900">
              Proposals &amp; Open Comment Periods
            </h1>
            <p className="mt-3 text-base text-gray-600 leading-relaxed">
              Bills, regulations, and rules from Congress and federal agencies.
              Submit official comments for free — no account required.
            </p>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">

        {/* ─── Open Now Featured ─────────────────────────────────────────── */}
        {showFeaturedSection && openFeatured.length > 0 && (
          <section className="mb-12">
            <div className="mb-4 flex items-center gap-3">
              <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
              <h2 className="text-lg font-semibold text-gray-900">
                ⏰ Comment Period Open Now
              </h2>
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                {openFeatured.length} closing soonest
              </span>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {openFeatured.map((p) => (
                <ProposalCard key={p.id} proposal={p} />
              ))}
            </div>
          </section>
        )}

        {/* ─── Filters ───────────────────────────────────────────────────── */}
        <div className="mb-6 rounded-lg border border-gray-200 bg-white p-4">
          <form method="GET" action="/proposals" className="flex flex-wrap items-end gap-3">
            {/* Status */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-gray-500">Status</label>
              <select
                name="status"
                defaultValue={statusFilter}
                className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              >
                <option value="open">Open for Comment</option>
                <option value="all">All Proposals</option>
                <option value="closed">Comment Closed</option>
              </select>
            </div>

            {/* Type */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-gray-500">Type</label>
              <select
                name="type"
                defaultValue={typeFilter}
                className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
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
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-gray-500">Agency</label>
              <select
                name="agency"
                defaultValue={agencyFilter}
                className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              >
                <option value="">All Agencies</option>
                {AGENCIES.map((a) => (
                  <option key={a} value={a}>
                    {a}{agencyNameMap[a] ? ` · ${agencyNameMap[a].slice(0, 35)}${agencyNameMap[a].length > 35 ? "…" : ""}` : ""}
                  </option>
                ))}
              </select>
            </div>

            {/* Search */}
            <div className="flex flex-col gap-1 flex-1 min-w-[180px]">
              <label className="text-xs font-medium text-gray-500">Search</label>
              <input
                type="text"
                name="q"
                defaultValue={searchQ}
                placeholder="Search proposals…"
                className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>

            <button
              type="submit"
              className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 transition-colors"
            >
              Filter
            </button>

            {(statusFilter !== "open" || typeFilter || agencyFilter || searchQ) && (
              <a
                href="/proposals"
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Clear
              </a>
            )}
          </form>
        </div>

        {/* ─── Results header ─────────────────────────────────────────────── */}
        <div className="mb-4 flex items-center justify-between">
          <p className="text-sm text-gray-500">
            {totalCount === 0 ? "No proposals found" : countLabel}
          </p>
          {totalPages > 1 && (
            <p className="text-sm text-gray-400">
              Page {page} of {totalPages}
            </p>
          )}
        </div>

        {/* ─── Proposals grid ─────────────────────────────────────────────── */}
        {mainProposals.length === 0 ? (
          <div className="rounded-lg border border-gray-200 bg-white p-12 text-center">
            <p className="text-sm font-medium text-gray-500">No proposals match your filters.</p>
            <a href="/proposals" className="mt-3 inline-block text-sm text-indigo-600 hover:underline">
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
          <div className="mt-8 flex items-center justify-center gap-2">
            {page > 1 && (
              <a
                href={buildUrl(currentParams, { page: String(page - 1) })}
                className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
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
                  <span key={`ellipsis-${i}`} className="px-1 text-gray-400">…</span>
                ) : (
                  <a
                    key={p}
                    href={buildUrl(currentParams, { page: String(p) })}
                    className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                      p === page
                        ? "border-indigo-600 bg-indigo-600 text-white"
                        : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
                    }`}
                  >
                    {p}
                  </a>
                )
              )}

            {page < totalPages && (
              <a
                href={buildUrl(currentParams, { page: String(page + 1) })}
                className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Next →
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
