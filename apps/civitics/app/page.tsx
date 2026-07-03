export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createServerClient, agencyFullName } from "@civitics/db";
import { withDbTimeout } from "../src/lib/supabase-check";
import { resolveEntityLabels, isCommonsEntityType } from "../src/lib/entity-labels";
import { GlobalSearch } from "./components/GlobalSearch";
import { PageViewTracker } from "./components/PageViewTracker";
import { Ticker } from "./components/home/Ticker";
import { HeroReceipt } from "./components/home/HeroReceipt";
import { ClosingSoonPanel } from "./components/home/ClosingSoonPanel";
import { OfficialsLedger } from "./components/home/OfficialsLedger";
import { Commons } from "./components/home/Commons";
import { InvestigationsBand } from "./components/home/InvestigationsBand";
import { GraphBand } from "./components/home/GraphBand";
import { FranklinBand } from "./components/home/FranklinBand";
import { AgenciesRow } from "./components/home/AgenciesRow";
import { listInvestigationsForHome } from "./investigations/_lib/load";
import type { HomeStats, HomeOfficialCardData, CommonsThread } from "./components/home/types";
import type { ProposalCardData } from "./proposals/components/ProposalCard";
import type { AgencyRow } from "./agencies/page";
import type { EntityTag } from "./components/tags/EntityTags";

// ─── Sub-components ───────────────────────────────────────────────────────────

function Hero({ stats, receiptDate }: { stats: HomeStats; receiptDate: string }) {
  return (
    <section className="border-b border-rule py-11 sm:py-12">
      <div className="mx-auto grid max-w-7xl items-center gap-10 px-4 sm:px-6 lg:grid-cols-[7fr_3.4fr] lg:gap-14 lg:px-8">
        <div>
          <p className="mb-3.5 font-mono text-[11.5px] font-semibold uppercase tracking-[0.24em] text-accent">
            Every vote · Every donor · Every dollar
          </p>
          <h1 className="font-serif text-[40px] font-semibold leading-[1.05] text-ink sm:text-[50px]">
            Democracy, <em className="font-medium italic">with receipts.</em>
          </h1>
          <p className="mt-4 max-w-[58ch] text-base leading-[1.65] text-ink-soft">
            The public record of who governs you, who funds them, and what they do with
            that power — connected, searchable, and permanent.{" "}
            <b className="font-semibold text-ink">Reading is free. Commenting is free. Always.</b>
          </p>
          <div className="mt-6 max-w-xl">
            <GlobalSearch variant="hero" placeholder="Search officials, proposals, agencies, donors…" />
          </div>
          <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-[13.5px] font-semibold">
            {[
              { label: "Find your representatives", href: "/officials" },
              { label: "Open comment periods", href: "/proposals?status=open" },
              { label: "Explore the connection graph", href: "/graph" },
            ].map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="border-b border-ink pb-px text-ink transition-colors hover:border-accent hover:text-accent"
              >
                {link.label} <span className="text-accent">→</span>
              </a>
            ))}
          </div>
        </div>
        <HeroReceipt stats={stats} dateLabel={receiptDate} />
      </div>
    </section>
  );
}

function PledgeBand() {
  return (
    <section className="border-b border-rule bg-paper-2">
      <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
        <div>
          <p className="font-serif text-lg font-semibold text-ink">
            Official comment submission is always free.
          </p>
          <p className="mt-0.5 text-sm text-ink-soft">
            Submitting a public comment to a federal agency is a constitutional right. No
            account, no credits, no fees — ever.
          </p>
        </div>
        <a
          href="/proposals?status=open"
          className="w-fit shrink-0 border-[1.5px] border-ink px-5 py-2.5 text-xs font-semibold uppercase tracking-[0.06em] text-ink transition-colors hover:bg-ink hover:text-paper"
        >
          View open periods →
        </a>
      </div>
    </section>
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
  const receiptDate = new Date().toLocaleDateString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  });

  // FIX-223 — per-phase timings, surfaced as a hidden <script id="__perf">
  // payload at the end of the page so we can diagnose slow renders from
  // browser DevTools without middleware. Also logged via console.time for
  // pnpm dev / Vercel function logs.
  const perf: { phase: string; ms: number }[] = [];
  async function timed<T>(phase: string, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      const ms = Date.now() - t0;
      perf.push({ phase, ms });
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
  ] = await timed("wave1", () => Promise.all([
    withDbTimeout(
      sbAny
        .from("homepage_stats_mv")
        .select("officials_count,active_proposals_count,donor_records_count,spending_records_count")
        .limit(1)
        .maybeSingle(),
      2000
    ),
    withDbTimeout(
      supabase
        .from("proposals")
        .select("id,title,type,status,summary_plain,summary_model,introduced_at,metadata,is_synthetic")
        .eq("status", "open_comment")
        .gt("metadata->>comment_period_end", now)
        .order("metadata->>comment_period_end", { ascending: true })
        .limit(3),
      3000,
      "home:open-proposals",
    ),
    withDbTimeout(
      supabase
        .from("agencies")
        .select("id,name,short_name,acronym,agency_type,website_url,description,metadata,is_synthetic")
        .eq("is_active", true)
        .order("name")
        .limit(4),
      3000,
      "home:agencies",
    ),
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
          // FIX-503: hero stat — an exact count over millions of donation rows
          // is the expensive part. 'estimated' (planner reltuples) is accurate
          // enough for a "N donor records" headline and won't churn the buffer
          // pool / hit the 2s timeout.
          .select("id", { count: "estimated", head: true })
          .eq("relationship_type", "donation"),
        2000
      )
    );
    // On timeout/error withDbTimeout returns { data: null, error } with no `count`,
    // so `liveDonorRes.count ?? 0` collapsed a timeout into a false 0 → "Coming soon"
    // even with millions of donor records. Only adopt the live count when the query
    // actually succeeded; otherwise keep the (missing) MV value rather than asserting
    // a zero we never measured (FIX-431).
    const liveDonorGross = liveDonorRes.error ? null : (liveDonorRes.count ?? null);
    // FIX-600 (SF-P1): the estimate above is unfilterable (planner reltuples), so
    // subtract the EXACT count of synthetic donor records — the gated MV value
    // already excludes them, and this keeps the fallback path from re-advertising
    // fakes. Cheap RPC (driven from the tiny synthetic set); behavior-neutral
    // today (returns 0). On RPC error we subtract nothing rather than drop the stat.
    let liveDonorCount = liveDonorGross;
    if (liveDonorGross !== null) {
      const synthDonorRes = await timed("wave1_donor_synthetic", () =>
        // Already wrapped — the guard's wrapSpan regex doesn't match the
        // generic-typed withDbTimeout<...>( form, so it mis-reports this read.
        withDbTimeout<{ data: number | string | null; error: { message: string } | null }>(
          // db-timeout-exempt: enclosed in the generic-typed withDbTimeout<...>( above.
          sbAny.rpc("count_synthetic_donor_records"),
          2000
        )
      );
      const synthDonorCount = synthDonorRes.error ? 0 : Number(synthDonorRes.data ?? 0);
      liveDonorCount = Math.max(0, liveDonorGross - synthDonorCount);
    }
    mvStats = {
      officials_count:        mvStats?.officials_count        ?? 0,
      active_proposals_count: mvStats?.active_proposals_count ?? 0,
      donor_records_count:    liveDonorCount ?? mvStats?.donor_records_count ?? null,
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

  // ── Proposal fallback: if no open comment periods, show most recent ────────
  let rawProposals: ProposalCardData[] = ((openProposalsRes.data ?? []) as ProposalRow[]).map(toCardShape);
  if (rawProposals.length === 0) {
    const { data: fallback } = await withDbTimeout(
      supabase
        .from("proposals")
        .select("id,title,type,status,summary_plain,summary_model,introduced_at,metadata,is_synthetic")
        .order("introduced_at", { ascending: false, nullsFirst: false })
        .limit(3),
      3000,
      "home:proposals-fallback",
    );
    rawProposals = ((fallback ?? []) as ProposalRow[]).map(toCardShape);
  }

  // ── Wave 2: officials + agency stats + proposal enrichment (parallel) ──────
  const proposalIds = rawProposals.map((p) => p.id);
  const agencyRows = agencyRowsRes.data ?? [];

  const [officialsRes, summaryRes, tagsRes, agencyCountsMvRes] = await timed("wave2", () => Promise.all([
    withDbTimeout(
      supabase
        .from("officials")
        .select(
          "id,full_name,role_title,party,photo_url,district_name,source_ids,jurisdictions!jurisdiction_id(name),governing_bodies!governing_body_id(short_name)"
        )
        .eq("is_active", true)
        .in("role_title", ["Senator", "Representative"])
        .filter("source_ids->>congress_gov", "not.is", null)
        .limit(20),
      3000,
      "home:officials",
    ),
    proposalIds.length > 0
      ? withDbTimeout(
          sbAny
            .from("ai_summary_cache")
            .select("entity_id,summary_text")
            .eq("entity_type", "proposal")
            .in("entity_id", proposalIds) as PromiseLike<{
            data: { entity_id: string; summary_text: string }[] | null;
          }>,
          3000,
          "home:proposal-summaries",
        )
      : Promise.resolve({ data: [] as { entity_id: string; summary_text: string }[] }),
    proposalIds.length > 0
      ? withDbTimeout(
          sbAny
            .from("entity_tags")
            .select(
              "entity_id,tag,tag_category,display_label,display_icon,visibility,confidence,generated_by,ai_model,metadata"
            )
            .eq("entity_type", "proposal")
            .in("entity_id", proposalIds) as PromiseLike<{
            data: (EntityTag & { entity_id: string })[] | null;
          }>,
          3000,
          "home:proposal-tags",
        )
      : Promise.resolve({ data: [] as EntityTag[] }),
    // FIX-330 — read from homepage_agency_counts_mv (refreshed nightly).
    // Replaces the FIX-303 RPC on the request path. Sub-millisecond on warm
    // cache via unique index on agency_id; 1000ms budget gives cold-start
    // headroom while still surfacing real regressions. Falls back to the
    // FIX-303 RPC below if the MV returns 0 rows.
    withDbTimeout<{ data: { agency_id: string; total: number | string; open: number | string }[] | null; error: { message: string } | null }>(
      sbAny
        // db-timeout-exempt: enclosed in the generic-typed withDbTimeout<...>( above (regex can't see it).
        .from("homepage_agency_counts_mv")
        .select("agency_id,total,open"),
      1000
    ),
  ]));

  if (agencyCountsMvRes.error) {
    console.error("agency counts MV read error:", agencyCountsMvRes.error.message);
  }
  let agencyCountsRows = agencyCountsMvRes.data ?? [];
  if (agencyCountsRows.length === 0) {
    // FIX-330 fallback — MV missing or empty (fresh DB, post-truncate, etc.).
    // Falls back to the FIX-303 RPC at its prior 2000ms request-path budget.
    const agencyCountsRes = await withDbTimeout<{ data: { agency_id: string; total: number | string; open: number | string }[] | null; error: { message: string } | null }>(
      // db-timeout-exempt: enclosed in the generic-typed withDbTimeout<...>( above (regex can't see it).
      sbAny.rpc("get_proposal_counts_by_agency"),
      2000
    );
    if (agencyCountsRes.error) {
      console.error("agency counts RPC error:", agencyCountsRes.error.message);
    }
    agencyCountsRows = agencyCountsRes.data ?? [];
  }
  const agencyCountsMap = new Map<string, { total: number; open: number }>(
    agencyCountsRows.map((r) => [
      r.agency_id,
      { total: Number(r.total), open: Number(r.open) },
    ])
  );

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

  // ── Commons: cross-entity discussion ledger (FIX-595) ──────────────────────
  // MV-only + fail-soft read of the most bridging root threads platform-wide
  // (commons_active_threads, FIX-594 — already bridge-ranked + capped at 50).
  // Re-apply the ranking ORDER on the read; resolve each row's entity to a
  // label + href via the shared resolver (FIX-597, src/lib/entity-labels — one
  // batched query per present entity_type). Never blocks the page — on
  // timeout/empty the module renders its sparse state.
  type CommonsRow = {
    comment_id: string;
    entity_type: string;
    entity_id: string;
    excerpt: string;
    kind: string;
    has_answer: boolean;
    reply_count: number;
    rater_count: number;
    last_activity_at: string;
    author_is_synthetic: boolean;
  };
  const commonsRes = await timed("wave_commons", () =>
    withDbTimeout(
      sbAny
        .from("commons_active_threads")
        .select(
          "comment_id,entity_type,entity_id,excerpt,kind,has_answer,reply_count,rater_count,last_activity_at,author_is_synthetic"
        )
        .order("bridge_score", { ascending: false, nullsFirst: false })
        .order("last_activity_at", { ascending: false })
        .limit(8),
      2000
    )
  );
  const commonsRows = ((commonsRes as { data: CommonsRow[] | null }).data ?? []).filter(
    (r): r is CommonsRow => isCommonsEntityType(r.entity_type)
  );
  // Shared resolver (FIX-597): one batched label query per present entity_type.
  const commonsLabels = await resolveEntityLabels(sbAny, commonsRows);
  const commonsThreads: CommonsThread[] = [];
  for (const r of commonsRows) {
    if (commonsThreads.length >= 6) break;
    const resolved = commonsLabels.get(`${r.entity_type}:${r.entity_id}`);
    if (!resolved) continue; // unresolved entity → skip rather than link to a 404
    commonsThreads.push({
      commentId: r.comment_id,
      excerpt: r.excerpt,
      chip: resolved.chip,
      // Commons links to the specific comment — append the anchor the shared
      // resolver deliberately omits (entity href only).
      href: `${resolved.href}#comment-${r.comment_id}`,
      label: resolved.label.length > 60 ? `${resolved.label.slice(0, 57)}…` : resolved.label,
      isQuestion: r.kind === "question",
      isAnswered: r.has_answer === true,
      replyCount: Number(r.reply_count ?? 0),
      raterCount: Number(r.rater_count ?? 0),
      lastActivityAt: r.last_activity_at,
      authorIsSynthetic: r.author_is_synthetic === true,
    });
  }

  // ── Investigations: cited case-file band (FIX-711) ─────────────────────────
  // Capped reuse of the /investigations index query shape (no new MV/RPC).
  // Fail-soft like every other module: on timeout the loader returns [] and the
  // band renders its empty state. Franklin's synthetic case files are labeled,
  // not excluded (SF-P2).
  const investigations = await timed("wave_investigations", () => listInvestigationsForHome(4));

  // ─── Shape data ────────────────────────────────────────────────────────────

  const stats: HomeStats = {
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

  // Agencies → AgencyRow[]
  const featuredAgencies: AgencyRow[] = agencyRows.map((agency) => {
    const key = agency.acronym ?? agency.name;
    const counts = agencyCountsMap.get(key) ?? { total: 0, open: 0 };
    const meta = agency.metadata as Record<string, unknown> | null;
    return {
      id: agency.id,
      name: agencyFullName(agency.acronym) ?? agency.name,
      short_name: agency.short_name ?? null,
      acronym: agency.acronym ?? null,
      agency_type: agency.agency_type,
      website_url: agency.website_url ?? null,
      description: agency.description ?? null,
      totalProposals: counts.total,
      openProposals: counts.open,
      isFeatured: meta?.["is_whitehouse"] === true,
      is_synthetic: (agency as { is_synthetic?: boolean }).is_synthetic ?? false,
    };
  });

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-paper">
      <PageViewTracker />
      <Ticker stats={stats} />
      <main id="main-content">
        <Hero stats={stats} receiptDate={receiptDate} />
        <PledgeBand />
        <ClosingSoonPanel proposals={featuredProposals} nowIso={now} activeCount={stats.proposals} />
        <OfficialsLedger officials={featuredOfficials} totalOfficials={stats.officials} />
        <InvestigationsBand items={investigations} />
        <Commons threads={commonsThreads} nowIso={now} />
        <GraphBand />
        <FranklinBand />
        <AgenciesRow agencies={featuredAgencies} />
      </main>
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
