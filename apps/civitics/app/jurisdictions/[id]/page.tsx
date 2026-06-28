// FIX-F: /jurisdictions/[id] hub. UUID-canonical, type-conditional sections,
// server-rendered static SVG map (no Mapbox JS). ISR (revalidate 300) — the
// per-user constituent surface is a client island (VerifyConstituentSection)
// so the page itself stays statically renderable. Data is read with the anon
// publishable client (no cookies → no static opt-out).
//
// Live-schema notes (Stage 1 rebuild): there is no civic_initiatives or
// spending_records table. Initiatives are proposals(type='initiative') joined to
// initiative_details; spending is financial_relationships sourced from agencies
// in the jurisdiction.
import { notFound } from "next/navigation";
import { createClient } from "@supabase/supabase-js";
import { JurisdictionHeader } from "./components/JurisdictionHeader";
import { SyntheticBanner } from "../../components/integrity/Synthetic";
import { BoundarySvg, type BoundarySvgData } from "./components/BoundarySvg";
import { VerifyConstituentSection } from "./components/VerifyConstituentSection";
import {
  Section,
  ChildJurisdictionsNav,
  InstitutionsList,
  OfficialsRoster,
  ProposalsSection,
  MeetingsSection,
  InitiativesSection,
  SpendingSection,
  ActivityFeed,
  type ChildJurisdiction,
  type SpendingGroup,
  type ActivityEvent,
} from "./components/Sections";
import type { InstitutionCardData } from "../../components/cards/InstitutionCard";
import type { OfficialRosterData } from "../../components/cards/OfficialRosterCard";
import type { MeetingCardData } from "../../components/cards/MeetingCard";
import type { ProposalCardData } from "../../proposals/components/ProposalCard";
import type { InitiativeCardData } from "../../initiatives/components/InitiativeCard";
import { EntityComments } from "../../components/EntityComments";
import { QASection } from "../../components/QASection";
import { withDbTimeout } from "@/lib/supabase-check";
import { lookupJurisdictionCache } from "@/lib/jurisdiction-cache";

export const revalidate = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OFFICIALS_LIMIT = 50;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function anonClient(): any {
  return createClient(
    process.env["NEXT_PUBLIC_SUPABASE_URL"]!,
    process.env["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]!
  );
}

function getFiscalYear(isoDate: string | null): string {
  if (!isoDate) return "Unknown";
  const d = new Date(isoDate);
  return d.getMonth() >= 9 ? `FY${d.getFullYear() + 1}` : `FY${d.getFullYear()}`;
}

function aggregateSpending(
  rows: Array<{ recipient: string; awardType: string; amountCents: number; date: string | null }>
): SpendingGroup[] {
  const map = new Map<string, SpendingGroup>();
  for (const r of rows) {
    const fy = getFiscalYear(r.date);
    const key = `${r.recipient}|${r.awardType}|${fy}`;
    const existing = map.get(key);
    if (existing) existing.totalCents += r.amountCents;
    else map.set(key, { recipient: r.recipient, awardType: r.awardType, totalCents: r.amountCents, fiscalYear: fy });
  }
  return Array.from(map.values())
    .sort((a, b) => b.totalCents - a.totalCents)
    .slice(0, 10);
}

// ─── generateStaticParams (warm set) ─────────────────────────────────────────
// Per root CLAUDE.md rules: try/catch → [], 5s race timeout, ≤50 rows,
// NEXT_PUBLIC keys only. Warm the federal jurisdiction + the 50 states.
export async function generateStaticParams(): Promise<Array<{ id: string }>> {
  try {
    const supabase = anonClient();
    const result = await Promise.race([
      // build-time generateStaticParams — already has its own 5s Promise.race +
      // degrade-to-[]; the guard mis-scopes its body span because the return-type
      // annotation `Promise<Array<{ id: string }>>` contains the first `{` it
      // brace-matches from, so it never sees this read as build-time.
      supabase
        // db-timeout-exempt: build-time generateStaticParams; not a request-path read.
        .from("jurisdictions")
        .select("id")
        .in("type", ["country", "state"])
        .eq("is_active", true)
        .limit(50),
      new Promise<{ data: null }>((resolve) =>
        setTimeout(() => resolve({ data: null }), 5000)
      ),
    ]);
    const data = (result as { data: Array<{ id: string }> | null }).data;
    return (data ?? []).map((r) => ({ id: r.id }));
  } catch {
    return [];
  }
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return { title: "Jurisdiction · Civitics" };
  const supabase = anonClient();
  const [{ data }, lookup] = await Promise.all([
    withDbTimeout(
      supabase.from("jurisdictions").select("name, type").eq("id", id).maybeSingle() as PromiseLike<{
        data: { name: string; type: string } | null;
      }>,
      3000,
      "jurisdiction:metadata",
    ),
    lookupJurisdictionCache(supabase, id),
  ]);
  if (!data) return { title: "Jurisdiction · Civitics" };
  return {
    title: `${data.name} · Civitics`,
    // FIX-683: an empty county/district leaf (not in jurisdiction_page_cache) is
    // noindex,nofollow — the sitemap already drops it; this deindexes the ~10k
    // shells already crawled. Content jurisdictions (isMember true) and any cache
    // hiccup (isMember null → fail open) stay indexed.
    ...(lookup.isMember === false ? { robots: { index: false, follow: false } } : {}),
  };
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default async function JurisdictionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const supabase = anonClient();

  // FIX-634: ONE consolidating RPC replaces the ~11-query request-path fan-out
  // (parent, boundary, children, institutions, officials, proposals, meetings,
  // initiatives, activity, + two spending queries). The 2026-06-21 incident was
  // a crawl across hundreds of unique ids — every hit a full cache-miss render
  // firing ~37 Supabase calls, which blew past the connection pool (522 → 504s).
  // One call = one connection. Each section below mirrors the exact shape the
  // old per-section queries returned, so the downstream .map() shaping is
  // unchanged.
  //
  // FIX-683 (item 4): the empty district/county leaves (~10k, not in
  // jurisdiction_page_cache) were the ones a crawl hammered, and on a cache miss
  // get_jurisdiction_page falls back to _live — which still fires the expensive
  // boundary PostGIS/geometry read. We now read the cache table BY PK directly:
  //   * member with cached payload → render from it (skips the RPC wrapper).
  //   * empty leaf (definite miss)  → leave payload null → the base-row shell
  //     below renders WITHOUT ever cold-reading the geometry.
  //   * cache lookup degraded       → fall back to the RPC wrapper (handles a
  //     cold cache + _live), preserving correctness on a hiccup.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let payload: any = null;
  {
    const lookup = await lookupJurisdictionCache(supabase, id, true);
    if (lookup.payload) {
      payload = lookup.payload;
    } else if (lookup.isMember === null) {
      const { data } = await withDbTimeout(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        supabase.rpc("get_jurisdiction_page", { p_id: id }) as PromiseLike<{ data: any }>,
        3000,
        "jurisdiction:page-rpc",
      );
      payload = data ?? null;
    }
    // else: empty leaf → payload stays null → base-row shell renders below.
  }

  // Safe fallback: a DB hiccup must not 500 the page. If the RPC errored, still
  // resolve the base jurisdiction row so the shell renders (sections empty);
  // only notFound() when the jurisdiction genuinely doesn't exist.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let jurisdiction: any = payload?.jurisdiction ?? null;
  if (!jurisdiction) {
    const { data: base } = await withDbTimeout(
      supabase
        .from("jurisdictions")
        .select("id, name, short_name, type, parent_id, population, timezone, fips_code, is_synthetic")
        .eq("id", id)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .maybeSingle() as PromiseLike<{ data: any }>,
      3000,
      "jurisdiction:base-fallback",
    );
    jurisdiction = base ?? null;
  }
  if (!jurisdiction) notFound();

  // ── Shape section data ──────────────────────────────────────────────────────
  const parent = (payload?.parent ?? null) as { id: string; name: string } | null;

  const boundary = (payload?.boundary ?? null) as BoundarySvgData | null;

  const children = (payload?.children ?? []) as ChildJurisdiction[];

  const institutions = (payload?.institutions ?? []) as Array<InstitutionCardData & { source_table?: string }>;

  const officialsRows = (payload?.officials ?? []) as OfficialRosterData[];
  const officialsHasMore = officialsRows.length > OFFICIALS_LIMIT;
  const officials = officialsRows.slice(0, OFFICIALS_LIMIT);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proposals: ProposalCardData[] = ((payload?.proposals ?? []) as any[]).map((p) => {
    const meta = (p.metadata ?? {}) as Record<string, string>;
    return {
      id: p.id,
      title: p.title,
      type: p.type,
      status: p.status,
      regulations_gov_id: meta["regulations_gov_id"] ?? null,
      congress_gov_url: p.external_url ?? null,
      comment_period_end: meta["comment_period_end"] ?? null,
      summary_plain: p.summary_plain,
      summary_model: p.summary_model,
      introduced_at: p.introduced_at,
      metadata: meta,
      is_synthetic: p.is_synthetic ?? false,
    };
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meetings: MeetingCardData[] = ((payload?.meetings ?? []) as any[]).map((m) => {
    const gb = Array.isArray(m.governing_bodies) ? m.governing_bodies[0] : m.governing_bodies;
    return {
      id: m.id,
      title: m.title,
      meeting_type: m.meeting_type,
      scheduled_at: m.scheduled_at,
      bodyName: gb?.name ?? null,
      agenda_url: m.agenda_url ?? null,
      is_synthetic: gb?.is_synthetic ?? false,
    };
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const initiatives: InitiativeCardData[] = ((payload?.initiatives ?? []) as any[])
    .map((row) => {
      const p = Array.isArray(row.proposals) ? row.proposals[0] : row.proposals;
      return {
        id: row.proposal_id,
        title: p?.title ?? "Initiative",
        summary: p?.summary_plain ?? null,
        stage: row.stage,
        scope: row.scope,
        authorship_type: row.authorship_type,
        issue_area_tags: row.issue_area_tags ?? [],
        target_district: row.target_district,
        mobilise_started_at: row.mobilise_started_at,
        created_at: p?.created_at ?? "",
        resolved_at: p?.resolved_at ?? null,
      } as InitiativeCardData;
    })
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
    .slice(0, 10);

  const activity = ((payload?.activity ?? []) as ActivityEvent[]);

  // ── Spending: rows pre-resolved (recipient name + award type + amount + date)
  // by get_jurisdiction_page; aggregated here by the same aggregateSpending the
  // page has always used (group by recipient|awardType|fiscalYear, top 10). ─────
  const spendingGroups: SpendingGroup[] = aggregateSpending(
    (payload?.spending ?? []) as Array<{
      recipient: string;
      awardType: string;
      amountCents: number;
      date: string | null;
    }>
  );

  // NOTE: the jurisdictions table carries no primary_source* columns (unlike
  // agencies/officials), so there is no SourceBadge attribution to render here.

  return (
    <div className="min-h-screen bg-gray-50">
      <main id="main-content" className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        {/* SF-P2 (FIX-599): persistent demonstration banner for a synthetic
            jurisdiction (the State of Franklin). Everything scoped under it is
            AI-generated; sub-entity pages inherit a one-line variant. */}
        {jurisdiction.is_synthetic && <SyntheticBanner className="mb-4" />}

        <JurisdictionHeader jurisdiction={jurisdiction} parent={parent} />

        {boundary && (
          <div className="mt-4">
            <BoundarySvg data={boundary} type={jurisdiction.type} />
          </div>
        )}

        <Section title="Your status">
          <VerifyConstituentSection jurisdictionId={id} />
        </Section>

        {children.length > 0 && (
          <Section title="Within this jurisdiction">
            <ChildJurisdictionsNav items={children} />
          </Section>
        )}

        {institutions.length > 0 && (
          <Section title="Institutions" subtitle="Governing bodies and agencies based here">
            <InstitutionsList institutions={institutions} />
          </Section>
        )}

        {officials.length > 0 && (
          <Section title="Officials">
            <OfficialsRoster officials={officials} hasMore={officialsHasMore} />
          </Section>
        )}

        {proposals.length > 0 && (
          <Section title="Recent proposals">
            <ProposalsSection proposals={proposals} />
          </Section>
        )}

        {meetings.length > 0 && (
          <Section title="Meetings" subtitle="Upcoming and recent">
            <MeetingsSection meetings={meetings} />
          </Section>
        )}

        {initiatives.length > 0 && (
          <Section title="Civic initiatives">
            <InitiativesSection initiatives={initiatives} />
          </Section>
        )}

        {spendingGroups.length > 0 && (
          <Section title="Spending" subtitle="Top contracts and grants from agencies based here">
            <SpendingSection groups={spendingGroups} />
          </Section>
        )}

        {activity.length > 0 && (
          <Section title="Recent activity">
            <ActivityFeed events={activity} />
          </Section>
        )}

        {/* FIX-610: citizen↔answerer Q&A lane. Anyone may ask; answers require an
            active jurisdiction_admin grant on this jurisdiction (the clerk role) —
            unclaimed real jurisdictions show the honest "awaiting response" state. */}
        <div className="mt-8">
          <QASection entityId={id} entityType="jurisdiction" entityName={jurisdiction.short_name ?? jurisdiction.name} />
        </div>

        <EntityComments
          entityType="jurisdiction"
          entityId={id}
          lensEnabled
          constituentJurisdictionId={id}
          startCollapsed
          heading="Community comments"
        />
      </main>
    </div>
  );
}
