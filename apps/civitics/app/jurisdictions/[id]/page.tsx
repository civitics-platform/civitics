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
      supabase
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
  const { data } = await supabase
    .from("jurisdictions")
    .select("name, type")
    .eq("id", id)
    .maybeSingle();
  if (!data) return { title: "Jurisdiction · Civitics" };
  return { title: `${data.name} · Civitics` };
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default async function JurisdictionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const supabase = anonClient();

  const { data: jurisdiction } = await supabase
    .from("jurisdictions")
    .select("id, name, short_name, type, parent_id, population, timezone, fips_code, is_synthetic")
    .eq("id", id)
    .maybeSingle();

  if (!jurisdiction) notFound();

  const now = Date.now();
  const meetWindowStart = new Date(now - 30 * 86_400_000).toISOString();
  const meetWindowEnd = new Date(now + 60 * 86_400_000).toISOString();

  const [
    parentRes,
    boundaryRes,
    childrenRes,
    instRes,
    offRes,
    propRes,
    meetRes,
    initRes,
    activityRes,
  ] = await Promise.all([
    jurisdiction.parent_id
      ? supabase.from("jurisdictions").select("id, name").eq("id", jurisdiction.parent_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.rpc("jurisdiction_boundary_svg", { p_id: id }),
    supabase
      .from("jurisdictions")
      .select("id, name, short_name, type")
      .eq("parent_id", id)
      .eq("is_active", true)
      .order("type", { ascending: true })
      .order("name", { ascending: true })
      .limit(1000),
    supabase
      .from("institutions")
      .select("id, name, short_name, type, acronym, source_table, is_synthetic")
      .eq("jurisdiction_id", id)
      .eq("is_active", true)
      .order("type", { ascending: true })
      .order("name", { ascending: true })
      .limit(200),
    supabase
      .from("officials")
      .select("id, full_name, role_title, party, photo_url, district_name, is_synthetic")
      .eq("jurisdiction_id", id)
      .eq("is_active", true)
      .order("role_title", { ascending: true })
      .order("last_name", { ascending: true })
      .limit(OFFICIALS_LIMIT + 1),
    supabase
      .from("proposals")
      .select("id, title, type, status, summary_plain, summary_model, introduced_at, external_url, metadata, is_synthetic")
      .eq("jurisdiction_id", id)
      .neq("type", "initiative")
      .order("introduced_at", { ascending: false, nullsFirst: false })
      .limit(10),
    supabase
      .from("meetings")
      .select("id, title, meeting_type, scheduled_at, agenda_url, governing_bodies!inner(name, jurisdiction_id, is_synthetic)")
      .eq("governing_bodies.jurisdiction_id", id)
      .gte("scheduled_at", meetWindowStart)
      .lte("scheduled_at", meetWindowEnd)
      .order("scheduled_at", { ascending: false })
      .limit(10),
    supabase
      .from("initiative_details")
      .select(
        "proposal_id, stage, scope, authorship_type, issue_area_tags, target_district, mobilise_started_at, proposals!inner(id, title, summary_plain, created_at, resolved_at, type, jurisdiction_id)"
      )
      .eq("proposals.type", "initiative")
      .eq("proposals.jurisdiction_id", id)
      .neq("stage", "draft")
      .limit(20),
    supabase.rpc("get_jurisdiction_activity", { p_id: id, p_limit: 20 }),
  ]);

  // ── Shape section data ──────────────────────────────────────────────────────
  const parent = (parentRes.data ?? null) as { id: string; name: string } | null;

  const boundary = ((boundaryRes.data ?? [])[0] ?? null) as BoundarySvgData | null;

  const children = (childrenRes.data ?? []) as ChildJurisdiction[];

  const institutions = (instRes.data ?? []) as Array<InstitutionCardData & { source_table?: string }>;

  const officialsRows = (offRes.data ?? []) as OfficialRosterData[];
  const officialsHasMore = officialsRows.length > OFFICIALS_LIMIT;
  const officials = officialsRows.slice(0, OFFICIALS_LIMIT);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proposals: ProposalCardData[] = ((propRes.data ?? []) as any[]).map((p) => {
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
  const meetings: MeetingCardData[] = ((meetRes.data ?? []) as any[]).map((m) => {
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
  const initiatives: InitiativeCardData[] = ((initRes.data ?? []) as any[])
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

  const activity = ((activityRes.data ?? []) as ActivityEvent[]);

  // ── Spending: financial_relationships from agencies in this jurisdiction ──────
  const agencyIds = institutions
    .filter((i) => i.source_table === "agency")
    .map((i) => i.id)
    .slice(0, 300);

  let spendingGroups: SpendingGroup[] = [];
  if (agencyIds.length > 0) {
    const { data: relRows } = await supabase
      .from("financial_relationships")
      .select("to_id, to_type, relationship_type, amount_cents, occurred_at")
      .in("relationship_type", ["contract", "grant"])
      .eq("from_type", "agency")
      .in("from_id", agencyIds)
      .order("amount_cents", { ascending: false })
      .limit(100);

    const rels = (relRows ?? []) as Array<{
      to_id: string;
      to_type: string;
      relationship_type: string;
      amount_cents: number | null;
      occurred_at: string | null;
    }>;

    const entityIds = Array.from(
      new Set(rels.filter((r) => r.to_type === "financial_entity").map((r) => r.to_id))
    );
    const names = new Map<string, string>();
    if (entityIds.length > 0) {
      const { data: ents } = await supabase
        .from("financial_entities")
        .select("id, display_name, canonical_name")
        .in("id", entityIds);
      for (const e of (ents ?? []) as Array<{
        id: string;
        display_name: string | null;
        canonical_name: string | null;
      }>) {
        names.set(e.id, e.display_name || e.canonical_name || "Unknown recipient");
      }
    }

    spendingGroups = aggregateSpending(
      rels.map((r) => ({
        recipient: names.get(r.to_id) ?? "Unknown recipient",
        awardType: r.relationship_type,
        amountCents: r.amount_cents ?? 0,
        date: r.occurred_at,
      }))
    );
  }

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

        <EntityComments
          entityType="jurisdiction"
          entityId={id}
          lensEnabled
          startCollapsed
          heading="Community comments"
        />
      </main>
    </div>
  );
}
