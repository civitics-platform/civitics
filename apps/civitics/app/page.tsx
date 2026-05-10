export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createServerClient, agencyFullName } from "@civitics/db";
import { withDbTimeout } from "../src/lib/supabase-check";
import nextDynamic from "next/dynamic";
const DistrictMap = nextDynamic(
  () => import("./components/DistrictMap").then((m) => m.DistrictMap),
  { ssr: false }
);
import { GlobalSearch } from "./components/GlobalSearch";
import { PageViewTracker } from "./components/PageViewTracker";
import { HomeOfficialCard, type HomeOfficialCardData } from "./components/HomeOfficialCard";
import { ProposalCard, type ProposalCardData } from "./proposals/components/ProposalCard";
import { InitiativeCard, type InitiativeCardData } from "./initiatives/components/InitiativeCard";
import { AgencyCard } from "./agencies/components/AgencyCard";
import type { AgencyRow } from "./agencies/page";
import type { EntityTag } from "./components/tags/EntityTags";

// ─── Types ────────────────────────────────────────────────────────────────────

type Stats = {
  officials: number;
  proposals: number;
  donors: number;
  spending: number;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatStat(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return n.toLocaleString();
  return String(n);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

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

function ProposalsSection({ proposals }: { proposals: ProposalCardData[] }) {
  return (
    <section>
      <SectionHeader
        title="Proposals"
        description="Bills, regulations, and rules open for public comment — submit your position for free."
        href="/proposals"
        linkLabel="Browse all proposals"
      />
      {proposals.length === 0 ? (
        <p className="mt-4 text-sm text-gray-500">
          No open comment periods right now. Check back soon.
        </p>
      ) : (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {proposals.map((p) => (
            <ProposalCard key={p.id} proposal={p} />
          ))}
        </div>
      )}
    </section>
  );
}

function InitiativesSection({ initiatives }: { initiatives: InitiativeCardData[] }) {
  return (
    <section>
      <SectionHeader
        title="Civic Initiatives"
        description="Citizen-led proposals — from deliberation to official accountability."
        href="/initiatives"
        linkLabel="Browse all initiatives"
      />
      {initiatives.length === 0 ? (
        <p className="mt-4 text-sm text-gray-500">
          No initiatives yet.{" "}
          <a href="/initiatives/new" className="text-indigo-600 hover:underline">
            Start one →
          </a>
        </p>
      ) : (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {initiatives.map((i) => (
            <InitiativeCard key={i.id} initiative={i} />
          ))}
        </div>
      )}
    </section>
  );
}

function OfficialsSection({ officials }: { officials: HomeOfficialCardData[] }) {
  return (
    <section>
      <SectionHeader
        title="Officials"
        description="Every elected and appointed official — votes, donors, and promises on record."
        href="/officials"
        linkLabel="Browse all officials"
      />
      {officials.length === 0 ? (
        <p className="mt-4 text-sm text-gray-500">Loading officials data…</p>
      ) : (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {officials.map((o) => (
            <HomeOfficialCard key={o.id} official={o} />
          ))}
        </div>
      )}
    </section>
  );
}

function AgenciesSection({ agencies }: { agencies: AgencyRow[] }) {
  return (
    <section>
      <SectionHeader
        title="Agencies"
        description="Federal agencies, their active rulemaking, and open comment periods."
        href="/agencies"
        linkLabel="Browse all agencies"
      />
      {agencies.length === 0 ? (
        <p className="mt-4 text-sm text-gray-500">Loading agency data…</p>
      ) : (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {agencies.map((a) => (
            <AgencyCard key={a.id} agency={a} />
          ))}
        </div>
      )}
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
          <p className="text-sm font-semibold text-white">Connection Graph</p>
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

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  // Supabase redirects auth errors (e.g. expired magic links) back to the
  // site root with ?error=access_denied&error_code=otp_expired. Forward the
  // user to the sign-in page so they see a proper error message.
  const params = await searchParams;
  if (params.error) {
    redirect("/auth/sign-in?error=auth");
  }

  const cookieStore = await cookies();
  const supabase = createServerClient(cookieStore);

  const now = new Date().toISOString();

  // FIX-223 — per-phase timings, surfaced as a hidden <script id="__perf">
  // payload at the end of the page so we can diagnose slow renders from
  // browser DevTools without middleware. Also logged via console.time for
  // pnpm dev / Vercel function logs.
  const perf: { phase: string; ms: number }[] = [];
  async function timed<T>(phase: string, fn: () => Promise<T>): Promise<T> {
    const label = `home/${phase}`;
    const t0 = Date.now();
    console.time(label);
    try {
      return await fn();
    } finally {
      const ms = Date.now() - t0;
      perf.push({ phase, ms });
      console.timeEnd(label);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sbAny = supabase as any;

  // ── Wave 1: precomputed hero stats (FIX-223) + featured rows ────────────────
  // Hero stats are served from homepage_stats_mv (refreshed nightly). One row.
  // Sub-millisecond on the read path; replaces 4 count: "exact" queries that
  // intermittently timed out and fell back to "Coming soon".
  const [
    homepageStatsRes,
    openProposalsRes,
    agencyRowsRes,
    upvotesRes,
  ] = await timed("wave1", () => Promise.all([
    withDbTimeout(
      sbAny
        .from("homepage_stats_mv")
        .select("officials_count,active_proposals_count,donor_records_count,spending_records_count")
        .limit(1)
        .maybeSingle(),
      2000
    ),
    supabase
      .from("proposals")
      .select("id,title,type,status,summary_plain,summary_model,introduced_at,metadata")
      .eq("status", "open_comment")
      .gt("metadata->>comment_period_end", now)
      .order("metadata->>comment_period_end", { ascending: true })
      .limit(3),
    supabase
      .from("agencies")
      .select("id,name,short_name,acronym,agency_type,website_url,description,metadata")
      .eq("is_active", true)
      .order("name")
      .limit(4),
    // Top initiatives by upvote count — fetch all upvote rows, count client-side,
    // then fetch the top-N initiative rows. Small table, fine for now.
    supabase
      .from("civic_initiative_upvotes")
      .select("initiative_id")
      .limit(5000),
  ]));

  // Defensive fallback for donor_records_count only — if the MV row is missing
  // (cron failed for many nights, or migration not yet applied) or returns 0,
  // run the live count query so the hero never regresses to "Coming soon".
  // Cheap insurance; remove once cron is proven stable.
  type HomepageStatsRow = {
    officials_count:        number | null;
    active_proposals_count: number | null;
    donor_records_count:    number | null;
    spending_records_count: number | null;
  };
  const homepageStatsTyped = homepageStatsRes as { data: HomepageStatsRow | null };
  let mvStats: HomepageStatsRow | null = homepageStatsTyped.data ?? null;
  if (!mvStats || (mvStats.donor_records_count ?? 0) === 0) {
    const liveDonorRes = await timed("wave1_donor_fallback", () =>
      withDbTimeout(
        supabase
          .from("financial_relationships")
          .select("id", { count: "exact", head: true })
          .eq("relationship_type", "donation"),
        2000
      )
    );
    mvStats = {
      officials_count:        mvStats?.officials_count        ?? 0,
      active_proposals_count: mvStats?.active_proposals_count ?? 0,
      donor_records_count:    liveDonorRes.count              ?? 0,
      spending_records_count: mvStats?.spending_records_count ?? 0,
    };
  }

  // Flatten proposals rows into legacy ProposalCardData shape — post-promotion
  // regulations_gov_id / congress_gov_url / comment_period_end live in metadata.
  type ProposalRow = {
    id: string;
    title: string;
    type: string;
    status: string;
    summary_plain: string | null;
    summary_model: string | null;
    introduced_at: string | null;
    metadata: Record<string, string> | null;
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
    };
  }

  // ── Proposal fallback: if no open comment periods, show most recent ────────
  let rawProposals: ProposalCardData[] = ((openProposalsRes.data ?? []) as ProposalRow[]).map(toCardShape);
  if (rawProposals.length === 0) {
    const { data: fallback } = await supabase
      .from("proposals")
      .select("id,title,type,status,summary_plain,summary_model,introduced_at,metadata")
      .order("introduced_at", { ascending: false, nullsFirst: false })
      .limit(3);
    rawProposals = ((fallback ?? []) as ProposalRow[]).map(toCardShape);
  }

  // ── Initiatives ranked by upvote count ─────────────────────────────────────
  const upvoteCountByInitiative: Record<string, number> = {};
  for (const row of upvotesRes.data ?? []) {
    const id = (row as { initiative_id: string }).initiative_id;
    upvoteCountByInitiative[id] = (upvoteCountByInitiative[id] ?? 0) + 1;
  }
  const topInitiativeIds = Object.entries(upvoteCountByInitiative)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([id]) => id);

  // Fetch the top-4 rows, plus a fallback newest-4 if there aren't enough upvotes.
  // Post-promotion, initiatives = proposals(type='initiative') + initiative_details
  // satellite row (keyed by proposal_id). We join initiative_details → proposals and
  // flatten back to the legacy InitiativeCardData shape.
  const initiativeJoinSelect =
    "proposal_id,stage,scope,authorship_type,issue_area_tags,target_district,mobilise_started_at,resolved_at,proposals!inner(id,title,summary_plain,type,created_at)";
  const [topInitiativesRes, fallbackInitiativesRes] = await Promise.all([
    topInitiativeIds.length > 0
      ? sbAny
          .from("initiative_details")
          .select(initiativeJoinSelect)
          .in("proposal_id", topInitiativeIds)
          .neq("stage", "draft")
          .eq("proposals.type", "initiative")
      : Promise.resolve({ data: [] }),
    topInitiativeIds.length < 4
      ? sbAny
          .from("initiative_details")
          .select(initiativeJoinSelect)
          .neq("stage", "draft")
          .eq("proposals.type", "initiative")
          .order("created_at", { ascending: false, referencedTable: "proposals" })
          .limit(4)
      : Promise.resolve({ data: [] }),
  ]);

  type InitiativeJoinRow = {
    proposal_id:         string;
    stage:               string;
    scope:               string;
    authorship_type:     string;
    issue_area_tags:     string[] | null;
    target_district:     string | null;
    mobilise_started_at: string | null;
    resolved_at:         string | null;
    proposals: {
      id:            string;
      title:         string;
      summary_plain: string | null;
      type:          string;
      created_at:    string;
    } | Array<{
      id:            string;
      title:         string;
      summary_plain: string | null;
      type:          string;
      created_at:    string;
    }>;
  };

  function flattenInitiativeRow(r: InitiativeJoinRow): InitiativeCardData {
    const p = Array.isArray(r.proposals) ? r.proposals[0]! : r.proposals;
    return {
      id:                  r.proposal_id,
      title:               p.title,
      summary:             p.summary_plain,
      stage:               r.stage,
      scope:               r.scope,
      authorship_type:     r.authorship_type,
      issue_area_tags:     r.issue_area_tags ?? [],
      target_district:     r.target_district,
      mobilise_started_at: r.mobilise_started_at,
      created_at:          p.created_at,
      resolved_at:         r.resolved_at,
    };
  }

  // ── Wave 2: officials + agency stats + proposal enrichment (parallel) ──────
  const proposalIds = rawProposals.map((p) => p.id);
  const agencyRows = agencyRowsRes.data ?? [];

  const [officialsRes, summaryRes, tagsRes, ...agencyStatPairs] = await timed("wave2", () => Promise.all([
    supabase
      .from("officials")
      .select(
        "id,full_name,role_title,party,photo_url,district_name,source_ids,jurisdictions!jurisdiction_id(name),governing_bodies!governing_body_id(short_name)"
      )
      .eq("is_active", true)
      .in("role_title", ["Senator", "Representative"])
      .filter("source_ids->>congress_gov", "not.is", null)
      .limit(20),
    proposalIds.length > 0
      ? sbAny
          .from("ai_summary_cache")
          .select("entity_id,summary_text")
          .eq("entity_type", "proposal")
          .in("entity_id", proposalIds)
      : Promise.resolve({ data: [] as { entity_id: string; summary_text: string }[] }),
    proposalIds.length > 0
      ? sbAny
          .from("entity_tags")
          .select(
            "entity_id,tag,tag_category,display_label,display_icon,visibility,confidence,generated_by,ai_model,metadata"
          )
          .eq("entity_type", "proposal")
          .in("entity_id", proposalIds)
      : Promise.resolve({ data: [] as EntityTag[] }),
    ...agencyRows.map((agency) => {
      const key = agency.acronym ?? agency.name;
      return Promise.all([
        supabase
          .from("proposals")
          .select("id", { count: "exact", head: true })
          .filter("metadata->>agency_id", "eq", key),
        supabase
          .from("proposals")
          .select("id", { count: "exact", head: true })
          .filter("metadata->>agency_id", "eq", key)
          .eq("status", "open_comment")
          .gt("metadata->>comment_period_end", now),
      ]);
    }),
  ]));

  // ── Wave 3: per-official stats — single read from official_homepage_stats_mv
  // (FIX-223). Replaces an N=20 .map() loop that ran 60 sub-queries per render
  // and silently filtered by a non-existent `official_id` column on
  // financial_relationships. The MV uses to_type='official' AND to_id and is
  // refreshed nightly.
  const rawOfficials = officialsRes.data ?? [];
  const officialIds = rawOfficials.map((o) => o.id as string);
  type OfficialStatRow = {
    official_id: string;
    vote_count: number;
    donor_count: number;
    total_donations_cents: number;
  };
  const officialStatsRes = officialIds.length > 0
    ? await timed("wave3", () =>
        withDbTimeout(
          sbAny
            .from("official_homepage_stats_mv")
            .select("official_id,vote_count,donor_count,total_donations_cents")
            .in("official_id", officialIds),
          2000
        )
      )
    : { data: [] as OfficialStatRow[] };
  const officialStatsTyped = officialStatsRes as { data: OfficialStatRow[] | null };
  const statsById = new Map<string, { id: string; voteCount: number; donorCount: number; totalDonationsCents: number }>(
    (officialStatsTyped.data ?? []).map((s) => [
      s.official_id,
      {
        id:                  s.official_id,
        voteCount:           Number(s.vote_count            ?? 0),
        donorCount:          Number(s.donor_count           ?? 0),
        totalDonationsCents: Number(s.total_donations_cents ?? 0),
      },
    ])
  );

  // Sort by vote count desc, take top 4
  rawOfficials.sort(
    (a, b) =>
      (statsById.get(b.id as string)?.voteCount ?? 0) -
      (statsById.get(a.id as string)?.voteCount ?? 0)
  );
  const topOfficials = rawOfficials.slice(0, 4);

  // ─── Shape data ────────────────────────────────────────────────────────────

  const stats: Stats = {
    officials: Number(mvStats.officials_count        ?? 0),
    proposals: Number(mvStats.active_proposals_count ?? 0),
    donors:    Number(mvStats.donor_records_count    ?? 0),
    spending:  Number(mvStats.spending_records_count ?? 0),
  };

  // Officials → HomeOfficialCardData
  const featuredOfficials: HomeOfficialCardData[] = topOfficials.map((o) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jurisdiction = o.jurisdictions as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const govBody = o.governing_bodies as any;
    const sources = (o.source_ids as Record<string, string> | null) ?? {};
    const stats = statsById.get(o.id as string);
    return {
      id: o.id,
      full_name: o.full_name,
      role_title: o.role_title,
      party: o.party ?? null,
      photo_url: o.photo_url ?? null,
      chamber: govBody?.short_name ?? null,
      district_name: o.district_name ?? null,
      state_name: jurisdiction?.name ?? null,
      isFederal: !!sources["congress_gov"],
      voteCount: stats?.voteCount ?? 0,
      donorCount: stats?.donorCount ?? 0,
      totalDonationsCents: stats?.totalDonationsCents ?? 0,
    };
  });

  // Proposals → ProposalCardData (enrich with AI summary, tags, agency name)
  const summaryMap: Record<string, string> = {};
  for (const s of (summaryRes.data ?? []) as { entity_id: string; summary_text: string }[]) {
    if (!summaryMap[s.entity_id]) summaryMap[s.entity_id] = s.summary_text;
  }
  const tagsMap: Record<string, EntityTag[]> = {};
  for (const t of (tagsRes.data ?? []) as (EntityTag & { entity_id: string })[]) {
    const eid = t.entity_id;
    if (!tagsMap[eid]) tagsMap[eid] = [];
    tagsMap[eid]!.push(t);
  }
  const featuredProposals: ProposalCardData[] = rawProposals.map((p) => {
    const acronym = p.metadata?.agency_id ?? null;
    return {
      ...p,
      agency_name: acronym ? agencyFullName(acronym) ?? null : null,
      ai_summary: summaryMap[p.id] ?? null,
      tags: tagsMap[p.id] ?? [],
    };
  });

  // Initiatives → InitiativeCardData (attach upvote count)
  const initiativeRows: InitiativeCardData[] = [
    ...((topInitiativesRes.data as InitiativeJoinRow[] | null) ?? []).map(flattenInitiativeRow),
    ...((fallbackInitiativesRes.data as InitiativeJoinRow[] | null) ?? []).map(flattenInitiativeRow),
  ];
  // Dedupe by id, preserve insertion order (top-by-upvotes first)
  const seenInit = new Set<string>();
  const dedupedInitiatives = initiativeRows.filter((i) => {
    if (seenInit.has(i.id)) return false;
    seenInit.add(i.id);
    return true;
  });
  // Sort by upvote count desc (fallback rows have 0 → appended at end)
  dedupedInitiatives.sort(
    (a, b) =>
      (upvoteCountByInitiative[b.id] ?? 0) - (upvoteCountByInitiative[a.id] ?? 0)
  );
  const featuredInitiatives: InitiativeCardData[] = dedupedInitiatives
    .slice(0, 4)
    .map((i) => ({ ...i, upvoteCount: upvoteCountByInitiative[i.id] ?? 0 }));

  // Agencies → AgencyRow[]
  const featuredAgencies: AgencyRow[] = agencyRows.map((agency, i) => {
    const pair = agencyStatPairs[i] as
      | [{ count: number | null }, { count: number | null }]
      | undefined;
    const meta = agency.metadata as Record<string, unknown> | null;
    return {
      id: agency.id,
      name: agencyFullName(agency.acronym) ?? agency.name,
      short_name: agency.short_name ?? null,
      acronym: agency.acronym ?? null,
      agency_type: agency.agency_type,
      website_url: agency.website_url ?? null,
      description: agency.description ?? null,
      totalProposals: pair?.[0]?.count ?? 0,
      openProposals: pair?.[1]?.count ?? 0,
      isFeatured: meta?.["is_whitehouse"] === true,
    };
  });

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50">
      <PageViewTracker />
      <Hero stats={stats} />
      <main id="main-content" className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-12">
          <CommentBanner />
          <DistrictMap />
          <GraphBanner />
          <ProposalsSection proposals={featuredProposals} />
          <InitiativesSection initiatives={featuredInitiatives} />
          <OfficialsSection officials={featuredOfficials} />
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
      {/* FIX-223: per-phase timings (ms). Inspect with
          JSON.parse(document.getElementById('__perf').textContent) */}
      <script
        id="__perf"
        type="application/json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(perf) }}
      />
    </div>
  );
}
