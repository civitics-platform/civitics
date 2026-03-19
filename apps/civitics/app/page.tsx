export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";
import { DistrictMap } from "./components/DistrictMap";
import { GlobalSearch } from "./components/GlobalSearch";

// ─── Types ────────────────────────────────────────────────────────────────────

type Stats = {
  officials: number;
  proposals: number;
  donors: number;
  spending: number;
};

type FeaturedOfficial = {
  id: string;
  name: string;
  role: string;
  party: string | null;
  state: string | null;
  district: string | null;
  voteCount: number;
};

type FeaturedProposal = {
  id: string;
  identifier: string;
  title: string;
  status: string;
  type: string;
  introducedAt: string | null;
  commentDeadline: string | null;
  summary: string | null;
  openForComment: boolean;
  agencyId: string | null;
};

type FeaturedAgency = {
  id: string;
  acronym: string;
  name: string;
  totalProposals: number;
  openProposals: number;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PARTY_STYLES: Record<string, { border: string; badge: string; label: string }> = {
  democrat:    { border: "border-blue-400",   badge: "bg-blue-100 text-blue-800",     label: "D" },
  republican:  { border: "border-red-400",    badge: "bg-red-100 text-red-800",       label: "R" },
  independent: { border: "border-purple-400", badge: "bg-purple-100 text-purple-800", label: "I" },
};
const DEFAULT_PARTY = { border: "border-gray-300", badge: "bg-gray-100 text-gray-700", label: "?" };

const PROPOSAL_STATUS: Record<string, { color: string; label: string }> = {
  open_comment:           { color: "bg-emerald-100 text-emerald-800", label: "Open Comment" },
  introduced:             { color: "bg-amber-100 text-amber-800",     label: "Introduced" },
  in_committee:           { color: "bg-amber-100 text-amber-800",     label: "In Committee" },
  passed_committee:       { color: "bg-blue-100 text-blue-800",       label: "Passed Committee" },
  floor_vote:             { color: "bg-blue-100 text-blue-800",       label: "Floor Vote" },
  passed_chamber:         { color: "bg-blue-100 text-blue-800",       label: "Passed Chamber" },
  passed_both_chambers:   { color: "bg-indigo-100 text-indigo-800",   label: "Passed Both Chambers" },
  signed:                 { color: "bg-green-100 text-green-800",     label: "Signed" },
  enacted:                { color: "bg-green-100 text-green-800",     label: "Enacted" },
  failed:                 { color: "bg-red-100 text-red-800",         label: "Failed" },
  withdrawn:              { color: "bg-gray-100 text-gray-700",       label: "Withdrawn" },
  comment_closed:         { color: "bg-gray-100 text-gray-700",       label: "Comment Closed" },
};

const PROPOSAL_TYPE_LABELS: Record<string, string> = {
  regulation:     "Federal Regulation",
  bill:           "Congress",
  executive_order: "Executive Order",
  treaty:         "Treaty",
  referendum:     "Referendum",
  resolution:     "Resolution",
};

function formatStat(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return n.toLocaleString();
  return String(n);
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function NavBar() {
  return (
    <header className="border-b border-gray-200 bg-white">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded bg-indigo-600">
              <span className="text-xs font-bold text-white">CV</span>
            </div>
            <span className="text-lg font-semibold tracking-tight text-gray-900">Civitics</span>
          </div>

          <nav className="hidden md:flex items-center gap-4">
            {[
              { label: "Officials",  href: "/officials" },
              { label: "Proposals",  href: "/proposals" },
              { label: "Agencies",   href: "/agencies" },
              { label: "Graph",      href: "/graph" },
              { label: "Dashboard",  href: "/dashboard" },
            ].map((item) => (
              <a
                key={item.label}
                href={item.href}
                className="text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors"
              >
                {item.label}
              </a>
            ))}
          </nav>

          <div className="hidden lg:block">
            <GlobalSearch variant="nav" />
          </div>

          <div className="flex items-center gap-3">
            <a href="#" className="text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors">
              Sign in
            </a>
            <a
              href="#"
              className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 transition-colors"
            >
              Get started
            </a>
          </div>
        </div>
      </div>
    </header>
  );
}

function Hero({ stats }: { stats: Stats }) {
  const statItems = [
    { label: "Officials tracked",  value: formatStat(stats.officials) },
    { label: "Active proposals",   value: formatStat(stats.proposals) },
    { label: "Donor records",      value: stats.donors > 0 ? formatStat(stats.donors) : "Coming soon" },
    { label: "Spending records",   value: formatStat(stats.spending) },
  ];

  return (
    <section className="border-b border-gray-200 bg-white py-16">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="max-w-3xl">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Beta · All data is public record
          </div>
          <h1 className="text-4xl font-bold tracking-tight text-gray-900 sm:text-5xl">
            Democracy with receipts.
          </h1>
          <p className="mt-4 text-lg text-gray-600 leading-relaxed">
            Every vote, donor, promise, and dollar — connected, searchable, and permanent. Official
            comment submission is always free. No account required to read anything.
          </p>
          <div className="mt-8">
            <GlobalSearch variant="hero" placeholder="Search any official, agency, or proposal…" />
          </div>

          <div className="mt-4 flex flex-wrap gap-3">
            <a
              href="/officials"
              className="rounded-md bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 transition-colors"
            >
              Find your representatives
            </a>
            <a
              href="/proposals?status=open"
              className="rounded-md border border-gray-300 bg-white px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Browse open comment periods
            </a>
          </div>

          <div className="mt-12 grid grid-cols-2 gap-6 sm:grid-cols-4">
            {statItems.map((stat) => (
              <div key={stat.label}>
                <p className="text-2xl font-bold text-gray-900">{stat.value}</p>
                <p className="mt-0.5 text-sm text-gray-500">{stat.label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function SectionHeader({
  title,
  description,
  href,
  linkLabel = "View all",
}: {
  title: string;
  description: string;
  href: string;
  linkLabel?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h2 className="text-xl font-semibold text-gray-900">{title}</h2>
        <p className="mt-1 text-sm text-gray-500">{description}</p>
      </div>
      <a
        href={href}
        className="shrink-0 text-sm font-medium text-indigo-600 hover:text-indigo-700 transition-colors"
      >
        {linkLabel} →
      </a>
    </div>
  );
}

function OfficialsSection({ officials }: { officials: FeaturedOfficial[] }) {
  if (officials.length === 0) {
    return (
      <section>
        <SectionHeader
          title="Officials"
          description="Every elected and appointed official — votes, donors, and promises on record."
          href="/officials"
          linkLabel="Browse all officials"
        />
        <p className="mt-4 text-sm text-gray-500">Loading officials data…</p>
      </section>
    );
  }

  return (
    <section>
      <SectionHeader
        title="Officials"
        description="Every elected and appointed official — votes, donors, and promises on record."
        href="/officials"
        linkLabel="Browse all officials"
      />
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {officials.map((official) => {
          const party = PARTY_STYLES[official.party ?? ""] ?? DEFAULT_PARTY;
          const location = [official.state, official.district].filter(Boolean).join(" · ");
          return (
            <a
              key={official.id}
              href={`/officials?selected=${official.id}`}
              className="group block rounded-lg border border-gray-200 bg-white p-4 hover:border-indigo-300 hover:shadow-sm transition-all"
            >
              <div className="flex items-center gap-3">
                <div
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 bg-gray-100 text-xs font-semibold text-gray-600 ${party.border}`}
                >
                  {initials(official.name)}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-gray-900 group-hover:text-indigo-700">
                    {official.name}
                  </p>
                  <p className="truncate text-xs text-gray-500">{official.role}</p>
                </div>
              </div>
              {location && <p className="mt-2 text-xs text-gray-400">{location}</p>}
              <div className="mt-3 grid grid-cols-3 gap-2 border-t border-gray-100 pt-3">
                <div className="text-center">
                  <p className={`text-xs font-bold rounded px-1 ${party.badge}`}>{party.label}</p>
                  <p className="text-[10px] text-gray-400 mt-0.5">Party</p>
                </div>
                <div className="text-center">
                  <p className="text-sm font-semibold text-gray-900">
                    {official.voteCount.toLocaleString()}
                  </p>
                  <p className="text-[10px] text-gray-400">Votes</p>
                </div>
                <div className="text-center">
                  <p className="text-sm font-semibold text-gray-900">0</p>
                  <p className="text-[10px] text-gray-400">Donors</p>
                </div>
              </div>
            </a>
          );
        })}
      </div>
    </section>
  );
}

function ProposalsSection({ proposals }: { proposals: FeaturedProposal[] }) {
  if (proposals.length === 0) {
    return (
      <section>
        <SectionHeader
          title="Proposals"
          description="Bills, regulations, and rules open for public comment — submit your position for free."
          href="/proposals"
          linkLabel="Browse all proposals"
        />
        <p className="mt-4 text-sm text-gray-500">No open comment periods right now. Check back soon.</p>
      </section>
    );
  }

  return (
    <section>
      <SectionHeader
        title="Proposals"
        description="Bills, regulations, and rules open for public comment — submit your position for free."
        href="/proposals"
        linkLabel="Browse all proposals"
      />
      <div className="mt-4 flex flex-col gap-3">
        {proposals.map((proposal) => {
          const statusStyle = PROPOSAL_STATUS[proposal.status] ?? {
            color: "bg-gray-100 text-gray-700",
            label: proposal.status,
          };
          const typeLabel = PROPOSAL_TYPE_LABELS[proposal.type] ?? proposal.type;

          return (
            <a
              key={proposal.id}
              href={`/proposals/${proposal.id}`}
              className="group block rounded-lg border border-gray-200 bg-white p-5 hover:border-indigo-300 hover:shadow-sm transition-all"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  {proposal.identifier !== proposal.type && (
                    <span className="rounded bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-600">
                      {proposal.identifier.length > 30
                        ? proposal.identifier.slice(0, 30) + "…"
                        : proposal.identifier}
                    </span>
                  )}
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusStyle.color}`}>
                    {statusStyle.label}
                  </span>
                  {proposal.openForComment && (
                    <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
                      Comment open
                    </span>
                  )}
                </div>
                {proposal.commentDeadline && (
                  <span className="text-xs text-gray-400">
                    Deadline: {formatDate(proposal.commentDeadline)}
                  </span>
                )}
              </div>
              <h3 className="mt-2 text-sm font-semibold text-gray-900 group-hover:text-indigo-700 line-clamp-2">
                {proposal.title}
              </h3>
              {proposal.summary ? (
                <p className="mt-1.5 text-sm text-gray-500 leading-relaxed line-clamp-2">
                  {proposal.summary}
                </p>
              ) : null}
              <div className="mt-3 flex items-center gap-4 text-xs text-gray-400">
                <span>{typeLabel}</span>
                {proposal.agencyId && (
                  <>
                    <span>·</span>
                    <span>{proposal.agencyId}</span>
                  </>
                )}
                {proposal.introducedAt && (
                  <>
                    <span>·</span>
                    <span>Introduced {formatDate(proposal.introducedAt)}</span>
                  </>
                )}
              </div>
            </a>
          );
        })}
      </div>
    </section>
  );
}

function AgenciesSection({ agencies }: { agencies: FeaturedAgency[] }) {
  if (agencies.length === 0) {
    return (
      <section>
        <SectionHeader
          title="Agencies"
          description="Federal agencies, their active rulemaking, and open comment periods."
          href="/agencies"
          linkLabel="Browse all agencies"
        />
        <p className="mt-4 text-sm text-gray-500">Loading agency data…</p>
      </section>
    );
  }

  return (
    <section>
      <SectionHeader
        title="Agencies"
        description="Federal agencies, their active rulemaking, and open comment periods."
        href="/agencies"
        linkLabel="Browse all agencies"
      />
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {agencies.map((agency) => (
          <a
            key={agency.id}
            href={`/agencies/${agency.id}`}
            className="group block rounded-lg border border-gray-200 bg-white p-4 hover:border-indigo-300 hover:shadow-sm transition-all"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded border border-gray-200 bg-gray-50 font-mono text-xs font-bold text-gray-600">
                {agency.acronym.slice(0, 5)}
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-gray-900 group-hover:text-indigo-700">
                  {agency.acronym}
                </p>
                <p className="truncate text-xs text-gray-500">Federal Agency</p>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 border-t border-gray-100 pt-3">
              <div className="text-center">
                <p className="text-sm font-semibold text-gray-900">{agency.totalProposals}</p>
                <p className="text-[10px] text-gray-400">Total rules</p>
              </div>
              <div className="text-center">
                <p className={`text-sm font-semibold ${agency.openProposals > 0 ? "text-emerald-600" : "text-gray-400"}`}>
                  {agency.openProposals}
                </p>
                <p className="text-[10px] text-gray-400">Open now</p>
              </div>
            </div>
          </a>
        ))}
      </div>
    </section>
  );
}

function GraphBanner() {
  return (
    <a
      href="/graph"
      className="group block rounded-lg border border-gray-800 bg-gray-950 p-5 hover:border-indigo-700 transition-colors"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-white">
            Connection Graph
          </p>
          <p className="mt-0.5 text-sm text-gray-400">
            Explore how officials, agencies, donors, and legislation are connected — visualized as a live force graph.
          </p>
        </div>
        <span className="shrink-0 rounded-md border border-gray-700 bg-gray-900 px-4 py-2 text-sm font-medium text-indigo-400 group-hover:border-indigo-700 group-hover:text-indigo-300 transition-colors">
          Open graph →
        </span>
      </div>
    </a>
  );
}

function CommentBanner() {
  return (
    <div className="rounded-lg border border-indigo-100 bg-indigo-50 p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-indigo-900">
            Official comment submission is always free.
          </p>
          <p className="mt-0.5 text-sm text-indigo-700">
            Submitting a public comment to a federal agency is a constitutional right. No account, no
            credits, no fees — ever.
          </p>
        </div>
        <a
          href="/proposals?status=open"
          className="shrink-0 rounded-md border border-indigo-300 bg-white px-4 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-50 transition-colors"
        >
          View open periods →
        </a>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function HomePage() {
  const cookieStore = await cookies();
  const supabase = createServerClient(cookieStore);

  // Wave 1: stats + open proposals + agency list (all parallel)
  const [
    officialsCountRes,
    activeProposalsRes,
    donorCountRes,
    spendingCountRes,
    openProposalsRes,
    agencyRowsRes,
  ] = await Promise.all([
    supabase
      .from("officials")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true),
    supabase
      .from("proposals")
      .select("id", { count: "exact", head: true })
      .in("status", ["open_comment", "introduced", "in_committee", "floor_vote"]),
    supabase
      .from("financial_relationships")
      .select("id", { count: "exact", head: true }),
    supabase
      .from("spending_records")
      .select("id", { count: "exact", head: true }),
    supabase
      .from("proposals")
      .select(
        "id,title,status,type,bill_number,regulations_gov_id,introduced_at,comment_period_end,summary_plain,metadata"
      )
      .eq("status", "open_comment")
      .gt("comment_period_end", new Date().toISOString())
      .order("comment_period_end", { ascending: true })
      .limit(3),
    supabase
      .from("agencies")
      .select("id,name,acronym")
      .eq("is_active", true)
      .order("name")
      .limit(4),
  ]);

  const officialsTotal = officialsCountRes.count ?? 0;
  const agencyRows = agencyRowsRes.data ?? [];

  // Proposal fallback: if no open comment periods, show most recent
  let proposalData = openProposalsRes.data ?? [];
  if (proposalData.length === 0) {
    const { data: fallback } = await supabase
      .from("proposals")
      .select(
        "id,title,status,type,bill_number,regulations_gov_id,introduced_at,comment_period_end,summary_plain,metadata"
      )
      .order("introduced_at", { ascending: false })
      .limit(3);
    proposalData = fallback ?? [];
  }

  // Wave 2: federal officials (top 20 by vote count later) + agency proposal counts (all parallel)
  const [officialsRes, ...agencyStatPairs] = await Promise.all([
    supabase
      .from("officials")
      .select(
        "id,full_name,role_title,party,district_name,jurisdictions!jurisdiction_id(name)"
      )
      .eq("is_active", true)
      .in("role_title", ["Senator", "Representative"])
      .filter("source_ids->>congress_gov", "not.is", null)
      .limit(20),
    ...agencyRows.map((agency) =>
      Promise.all([
        supabase
          .from("proposals")
          .select("id", { count: "exact", head: true })
          .filter("metadata->>agency_id", "eq", agency.acronym ?? agency.name),
        supabase
          .from("proposals")
          .select("id", { count: "exact", head: true })
          .filter("metadata->>agency_id", "eq", agency.acronym ?? agency.name)
          .eq("status", "open_comment"),
      ])
    ),
  ]);

  // Wave 3: vote counts for all fetched officials — sort by count, take top 4
  const rawOfficials = officialsRes.data ?? [];
  const voteCounts = await Promise.all(
    rawOfficials.map((o) =>
      supabase
        .from("votes")
        .select("id", { count: "exact", head: true })
        .eq("official_id", o.id)
        .then((r) => ({ id: o.id as string, count: r.count ?? 0 }))
    )
  );
  const voteCountMap = new Map(voteCounts.map((v) => [v.id, v.count]));

  // Sort by vote count desc, take top 4
  rawOfficials.sort((a, b) => (voteCountMap.get(b.id) ?? 0) - (voteCountMap.get(a.id) ?? 0));
  const topOfficials = rawOfficials.slice(0, 4);

  // ─── Shape data ────────────────────────────────────────────────────────────

  const stats: Stats = {
    officials: officialsTotal,
    proposals: activeProposalsRes.count ?? 0,
    donors: donorCountRes.count ?? 0,
    spending: spendingCountRes.count ?? 0,
  };

  const featuredOfficials: FeaturedOfficial[] = topOfficials.map((o) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jurisdiction = o.jurisdictions as any;
    return {
      id: o.id,
      name: o.full_name,
      role: o.role_title,
      party: o.party ?? null,
      state: jurisdiction?.name ?? null,
      district: o.district_name ?? null,
      voteCount: voteCountMap.get(o.id) ?? 0,
    };
  });

  const featuredProposals: FeaturedProposal[] = proposalData.map((p) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = p.metadata as any;
    return {
      id: p.id,
      identifier: p.bill_number ?? p.regulations_gov_id ?? p.type ?? "—",
      title: p.title,
      status: p.status,
      type: p.type,
      introducedAt: p.introduced_at ?? null,
      commentDeadline: p.comment_period_end ?? null,
      summary: p.summary_plain ?? null,
      openForComment: p.status === "open_comment",
      agencyId: meta?.agency_id ?? null,
    };
  });

  const featuredAgencies: FeaturedAgency[] = agencyRows.map((agency, i) => {
    const [totalRes, openRes] = (agencyStatPairs[i] as [{ count: number | null }, { count: number | null }]) ?? [
      { count: 0 },
      { count: 0 },
    ];
    return {
      id: agency.id,
      acronym: agency.acronym ?? agency.name,
      name: agency.name,
      totalProposals: totalRes.count ?? 0,
      openProposals: openRes.count ?? 0,
    };
  });

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50">
      <NavBar />
      <Hero stats={stats} />
      <main className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-12">
          <CommentBanner />
          <DistrictMap />
          <GraphBanner />
          <OfficialsSection officials={featuredOfficials} />
          <ProposalsSection proposals={featuredProposals} />
          <AgenciesSection agencies={featuredAgencies} />
        </div>
      </main>
      <footer className="mt-16 border-t border-gray-200 bg-white">
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-gray-500">
              Civitics — open civic infrastructure. Beta · All data is public record.
            </p>
            <a
              href="/dashboard"
              className="text-xs text-gray-400 hover:text-indigo-600 transition-colors"
            >
              Platform transparency →
            </a>
          </div>
          <span className="text-xs text-gray-300 font-mono">
            v:{process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev"}
          </span>
        </div>
      </footer>
    </div>
  );
}
