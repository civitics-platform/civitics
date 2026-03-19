/**
 * /search?q=[query]&type=all|officials|proposals|agencies
 *
 * Full search results page — grouped sections, tab filters, direct DB queries.
 */

export const dynamic = "force-dynamic";

import { createAdminClient } from "@civitics/db";
import type { SearchOfficial, SearchProposal, SearchAgency } from "../api/search/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PARTY_BADGE: Record<string, string> = {
  democrat:    "bg-blue-100 text-blue-800",
  republican:  "bg-red-100 text-red-800",
  independent: "bg-purple-100 text-purple-800",
};

const STATUS_LABEL: Record<string, string> = {
  open_comment:         "Open Comment",
  introduced:           "Introduced",
  in_committee:         "In Committee",
  passed_committee:     "Passed Committee",
  floor_vote:           "Floor Vote",
  passed_chamber:       "Passed Chamber",
  passed_both_chambers: "Passed Both Chambers",
  signed:               "Signed",
  enacted:              "Enacted",
  failed:               "Failed",
  withdrawn:            "Withdrawn",
  comment_closed:       "Comment Closed",
};

const STATUS_COLOR: Record<string, string> = {
  open_comment:  "bg-emerald-100 text-emerald-800",
  introduced:    "bg-amber-100 text-amber-800",
  in_committee:  "bg-amber-100 text-amber-800",
  enacted:       "bg-green-100 text-green-800",
  signed:        "bg-green-100 text-green-800",
  failed:        "bg-red-100 text-red-800",
};

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

// ---------------------------------------------------------------------------
// Sub-components (server-renderable)
// ---------------------------------------------------------------------------

function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <h2 className="text-base font-semibold text-gray-900">{title}</h2>
      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
        {count}
      </span>
    </div>
  );
}

function OfficialCard({ o }: { o: SearchOfficial }) {
  const badge = PARTY_BADGE[o.party ?? ""] ?? "bg-gray-100 text-gray-700";
  return (
    <a
      href={`/officials/${o.id}`}
      className="flex items-center gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 hover:border-indigo-300 hover:shadow-sm transition-all"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs font-semibold text-gray-600">
        {o.photo_url
          ? <img src={o.photo_url} alt={o.full_name} className="h-9 w-9 rounded-full object-cover" />
          : initials(o.full_name)}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-gray-900">{o.full_name}</p>
        <p className="truncate text-xs text-gray-500">
          {o.role_title}{o.state ? ` · ${o.state}` : ""}
        </p>
      </div>
      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${badge}`}>
        {o.party?.[0]?.toUpperCase() ?? "?"}
      </span>
    </a>
  );
}

function ProposalCard({ p }: { p: SearchProposal }) {
  const color = STATUS_COLOR[p.status] ?? "bg-gray-100 text-gray-700";
  const label = STATUS_LABEL[p.status] ?? p.status.replace(/_/g, " ");
  const isOpen = p.status === "open_comment" && p.comment_period_end && new Date(p.comment_period_end) > new Date();
  return (
    <a
      href={`/proposals/${p.id}`}
      className="block rounded-lg border border-gray-200 bg-white px-4 py-3 hover:border-indigo-300 hover:shadow-sm transition-all"
    >
      <div className="flex items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${color}`}>{label}</span>
        {isOpen && (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
            Comment open
          </span>
        )}
        {p.agency_acronym && (
          <span className="font-mono text-[11px] text-gray-400">{p.agency_acronym}</span>
        )}
      </div>
      <p className="mt-1.5 text-sm font-semibold text-gray-900 line-clamp-2 leading-snug">
        {p.title}
      </p>
      {p.ai_summary && (
        <p className="mt-1 text-xs text-gray-500 line-clamp-2 leading-relaxed">{p.ai_summary}</p>
      )}
    </a>
  );
}

function AgencyCard({ a }: { a: SearchAgency }) {
  return (
    <a
      href={`/agencies/${a.id}`}
      className="flex items-center gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 hover:border-indigo-300 hover:shadow-sm transition-all"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded border border-gray-200 bg-gray-50 font-mono text-[10px] font-bold text-gray-600">
        {(a.acronym ?? a.name).slice(0, 4)}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-gray-900">{a.name}</p>
        {a.acronym && <p className="text-xs text-gray-400">{a.acronym}</p>}
      </div>
      <span className="shrink-0 rounded bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500 capitalize">
        {a.agency_type.replace(/_/g, " ")}
      </span>
    </a>
  );
}

function EmptyState({ query }: { query: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white py-16 text-center">
      <p className="text-base font-medium text-gray-500">No results for &ldquo;{query}&rdquo;</p>
      <p className="mt-1 text-sm text-gray-400">
        Try an official&apos;s name, agency acronym (e.g. &ldquo;EPA&rdquo;), or policy topic
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; type?: string }>;
}) {
  const { q: rawQ, type: rawType } = await searchParams;
  const q = (rawQ ?? "").trim();
  const typeFilter = rawType ?? "all";

  // Run all three searches in parallel (same logic as /api/search)
  let officials: SearchOfficial[] = [];
  let proposals: SearchProposal[] = [];
  let agencies: SearchAgency[] = [];

  if (q.length >= 2) {
    const db = createAdminClient();
    const qLower = q.toLowerCase();

    const US_STATES: Record<string, string> = {
      AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
      CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
      HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
      KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
      MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
      MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
      NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina",
      ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
      RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
      TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
      WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
    };

    const PARTY_KEYWORDS: Record<string, string> = {
      democrat: "democrat", democratic: "democrat", dem: "democrat",
      republican: "republican", rep: "republican", gop: "republican",
      independent: "independent", ind: "independent",
    };
    const ROLE_KEYWORDS: Record<string, string> = {
      senator: "Senator", senators: "Senator",
      representative: "Representative", representatives: "Representative",
      congressman: "Representative", congresswoman: "Representative",
    };

    const stateAbbr = q.length === 2 ? q.toUpperCase() : null;
    const stateName = stateAbbr ? US_STATES[stateAbbr] : null;
    const partyFilter = PARTY_KEYWORDS[qLower];
    const roleFilter = ROLE_KEYWORDS[qLower];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db2 = db as any;

    const [officialsRes, proposalsRes, agenciesRes] = await Promise.all([
      // Officials
      (async (): Promise<SearchOfficial[]> => {
        if (typeFilter !== "all" && typeFilter !== "officials") return [];
        let query = db2
          .from("officials")
          .select("id, full_name, role_title, party, photo_url, is_active, metadata")
          .eq("is_active", true)
          .limit(20);

        if (partyFilter) {
          query = query.eq("party", partyFilter);
        } else if (roleFilter) {
          query = query.eq("role_title", roleFilter);
        } else if (stateName) {
          query = query.filter("metadata->>state", "eq", stateAbbr);
        } else {
          query = query.or(`full_name.ilike.%${q}%,role_title.ilike.%${q}%`);
        }

        const { data } = await query.order("full_name");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (data ?? []).map((o: any) => ({
          id: o.id,
          full_name: o.full_name,
          role_title: o.role_title,
          party: o.party ?? null,
          state: o.metadata?.state ?? null,
          photo_url: o.photo_url ?? null,
          is_active: o.is_active,
        }));
      })(),

      // Proposals
      (async (): Promise<SearchProposal[]> => {
        if (typeFilter !== "all" && typeFilter !== "proposals") return [];
        const { data: proposalData } = await db2
          .from("proposals")
          .select("id, title, status, type, comment_period_end, metadata, summary_plain")
          .or(`title.ilike.%${q}%,summary_plain.ilike.%${q}%`)
          .order("comment_period_end", { ascending: true, nullsFirst: false })
          .limit(20);

        const ids = (proposalData ?? []).map((p: { id: string }) => p.id);
        const summaryRes = ids.length > 0
          ? await db2.from("ai_summary_cache").select("entity_id, summary_text")
              .eq("entity_type", "proposal").in("entity_id", ids)
          : { data: [] };

        const summaryMap: Record<string, string> = {};
        for (const s of summaryRes.data ?? []) summaryMap[s.entity_id] = s.summary_text;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (proposalData ?? []).map((p: any) => ({
          id: p.id,
          title: p.title,
          status: p.status,
          type: p.type,
          comment_period_end: p.comment_period_end ?? null,
          agency_acronym: p.metadata?.agency_id ?? null,
          ai_summary: summaryMap[p.id] ?? null,
        }));
      })(),

      // Agencies
      (async (): Promise<SearchAgency[]> => {
        if (typeFilter !== "all" && typeFilter !== "agencies") return [];
        const { data: agencyData } = await db2
          .from("agencies")
          .select("id, name, acronym, agency_type, description")
          .eq("is_active", true)
          .or(`name.ilike.%${q}%,acronym.ilike.%${q}%,description.ilike.%${q}%`)
          .order("name")
          .limit(10);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sorted = (agencyData ?? []).sort((a: any, b: any) => {
          const aExact = a.acronym?.toUpperCase() === q.toUpperCase() ? 0 : 1;
          const bExact = b.acronym?.toUpperCase() === q.toUpperCase() ? 0 : 1;
          return aExact - bExact;
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return sorted.map((a: any) => ({
          id: a.id,
          name: a.name,
          acronym: a.acronym ?? null,
          agency_type: a.agency_type,
          description: a.description ?? null,
        }));
      })(),
    ]);

    officials = officialsRes;
    proposals = proposalsRes;
    agencies = agenciesRes;
  }

  const total = officials.length + proposals.length + agencies.length;
  const showAll = typeFilter === "all";

  // Tab helper
  function tabHref(type: string) {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (type !== "all") params.set("type", type);
    return `/search?${params.toString()}`;
  }

  const tabs = [
    { key: "all",       label: "All",       count: total },
    { key: "officials", label: "Officials",  count: officials.length },
    { key: "proposals", label: "Proposals",  count: proposals.length },
    { key: "agencies",  label: "Agencies",   count: agencies.length },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center gap-4">
            <a href="/" className="flex items-center gap-2 shrink-0">
              <div className="flex h-8 w-8 items-center justify-center rounded bg-indigo-600">
                <span className="text-xs font-bold text-white">CV</span>
              </div>
              <span className="text-lg font-semibold tracking-tight text-gray-900">Civitics</span>
            </a>
            {/* Search form */}
            <form method="get" action="/search" className="flex-1 max-w-2xl">
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2">
                  <svg className="h-4 w-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                </span>
                <input
                  name="q"
                  type="text"
                  defaultValue={q}
                  placeholder="Search officials, proposals, agencies…"
                  autoFocus={!q}
                  className="w-full rounded-md border border-gray-200 bg-gray-50 pl-9 pr-4 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-indigo-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
                />
              </div>
            </form>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {!q ? (
          <div className="py-24 text-center">
            <p className="text-base text-gray-500">Enter a query to search officials, proposals, and agencies.</p>
          </div>
        ) : (
          <>
            {/* Query summary */}
            <p className="mb-6 text-sm text-gray-500">
              {total > 0
                ? <><span className="font-semibold text-gray-900">{total} result{total !== 1 ? "s" : ""}</span> for &ldquo;{q}&rdquo;</>
                : <>No results for &ldquo;{q}&rdquo;</>}
            </p>

            {/* Tabs */}
            <div className="mb-8 flex gap-1 border-b border-gray-200">
              {tabs.map((tab) => {
                const active = typeFilter === tab.key;
                return (
                  <a
                    key={tab.key}
                    href={tabHref(tab.key)}
                    className={`flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px
                      ${active
                        ? "border-indigo-600 text-indigo-600"
                        : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"}`}
                  >
                    {tab.label}
                    {tab.count > 0 && (
                      <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold
                        ${active ? "bg-indigo-100 text-indigo-700" : "bg-gray-100 text-gray-500"}`}>
                        {tab.count}
                      </span>
                    )}
                  </a>
                );
              })}
            </div>

            {/* Results */}
            {total === 0 ? (
              <EmptyState query={q} />
            ) : (
              <div className="flex flex-col gap-10">

                {/* Officials */}
                {officials.length > 0 && (showAll || typeFilter === "officials") && (
                  <section>
                    <SectionHeader title="Officials" count={officials.length} />
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {officials.map((o) => <OfficialCard key={o.id} o={o} />)}
                    </div>
                  </section>
                )}

                {/* Proposals */}
                {proposals.length > 0 && (showAll || typeFilter === "proposals") && (
                  <section>
                    <SectionHeader title="Proposals" count={proposals.length} />
                    <div className="flex flex-col gap-2">
                      {proposals.map((p) => <ProposalCard key={p.id} p={p} />)}
                    </div>
                    {typeFilter === "all" && proposals.length >= 20 && (
                      <a href={tabHref("proposals")} className="mt-3 block text-sm font-medium text-indigo-600 hover:text-indigo-800">
                        Show all proposals →
                      </a>
                    )}
                  </section>
                )}

                {/* Agencies */}
                {agencies.length > 0 && (showAll || typeFilter === "agencies") && (
                  <section>
                    <SectionHeader title="Agencies" count={agencies.length} />
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {agencies.map((a) => <AgencyCard key={a.id} a={a} />)}
                    </div>
                  </section>
                )}

              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
