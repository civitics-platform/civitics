// FIX-418: Stage 1 institution unification.
//
// Reads from public.institutions (UNION view over governing_bodies + agencies).
// Branches the render by source_table — agency rows get the full agency
// profile cribbed from /agencies/[slug]; governing_body rows get a leaner
// header + officials roster + recent proposals/votes.
//
// Param shape: [id]. Accepts a UUID directly or a governing_bodies.slug
// (governing_bodies side only; agencies side has no slug). Non-UUID values
// resolve via governing_bodies.slug → permanent-redirect to /institutions/<uuid>.
import { notFound, permanentRedirect } from "next/navigation";
import nextDynamic from "next/dynamic";
import {
  createPublicClient,
  fetchAttributionForEntity,
} from "@civitics/db";
import { createClient } from "@supabase/supabase-js";
import { AgencyHierarchyTree } from "../../agencies/[slug]/components/AgencyHierarchyTree";
import { PageViewTracker } from "../../components/PageViewTracker";
import { FormerBadge } from "../../components/FormerBadge";
import { FollowButton } from "../../components/FollowButton";
import { SourceBadge } from "../../components/SourceBadge";
import { SourceDetailPopover } from "../../components/SourceDetailPopover";
import { OfficialRosterCard, type OfficialRosterData } from "../../components/cards/OfficialRosterCard";
import { MeetingCard, type MeetingCardData } from "../../components/cards/MeetingCard";
import { EntityComments } from "../../components/EntityComments";
import { QASection } from "../../components/QASection";
import { SyntheticMark, SyntheticBanner } from "../../components/integrity/Synthetic";
import { withDbTimeout } from "@/lib/supabase-check";

const AgencyGraph = nextDynamic(
  () => import("../../agencies/[slug]/components/AgencyGraph").then((m) => ({ default: m.AgencyGraph })),
  { ssr: false, loading: () => <div className="h-[400px] bg-gray-50 rounded-lg" /> }
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Types ────────────────────────────────────────────────────────────────────

type InstitutionRow = {
  id: string;
  jurisdiction_id: string;
  type: string;
  name: string;
  short_name: string | null;
  website_url: string | null;
  contact_email: string | null;
  is_active: boolean;
  slug: string | null;
  source_table: "agency" | "governing_body";
  acronym: string | null;
  usaspending_agency_id: string | null;
  usaspending_subtier_id: string | null;
  parent_id: string | null;
  primary_source: string | null;
  primary_source_url: string | null;
  primary_source_last_seen_at: string | null;
  metadata: Record<string, unknown> | null;
  // SF-P2 (FIX-599): exposed from the underlying gb/agency via the recreated
  // institutions view (entity marker).
  is_synthetic: boolean;
};

type Proposal = {
  id: string;
  title: string;
  status: string;
  type: string;
  bill_number: string | null;
  regulations_gov_id: string | null;
  introduced_at: string | null;
  comment_period_end: string | null;
  summary_plain: string | null;
};

type OfficialLink = {
  id: string;
  name: string;
  title: string;
  connectionType: string;
  strength: number;
  startDate: string | null;
  endDate: string | null;
  isCurrent: boolean;
  evidenceSource: string | null;
  sourceDate: string | null;
};

type SpendingRow = {
  recipient_name: string;
  award_type: string;
  amount_cents: number;
  award_date: string | null;
};

type SpendingGroup = {
  recipient: string;
  awardType: string;
  totalCents: number;
  fiscalYear: string;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const AGENCY_TYPE_LABELS: Record<string, string> = {
  federal:       "Federal Agency",
  state:         "State Agency",
  local:         "Local Agency",
  independent:   "Independent Agency",
  international: "International Body",
  other:         "Agency",
};

const AGENCY_TYPE_COLORS: Record<string, string> = {
  federal:       "bg-blue-50 text-blue-700 border-blue-200",
  state:         "bg-purple-50 text-purple-700 border-purple-200",
  local:         "bg-green-50 text-green-700 border-green-200",
  independent:   "bg-amber-50 text-amber-700 border-amber-200",
  international: "bg-indigo-50 text-indigo-700 border-indigo-200",
  other:         "bg-gray-50 text-gray-600 border-gray-200",
};

const GB_TYPE_LABELS: Record<string, string> = {
  legislature_upper:       "Upper Chamber",
  legislature_lower:       "Lower Chamber",
  legislature_unicameral:  "Legislature",
  executive:               "Executive",
  judicial:                "Court",
  regulatory_agency:       "Regulatory Agency",
  municipal_council:       "Municipal Council",
  school_board:            "School Board",
  special_district:        "Special District",
  international_body:      "International Body",
  committee:               "Committee",
  other:                   "Governing Body",
};

const GB_TYPE_COLORS: Record<string, string> = {
  legislature_upper:       "bg-indigo-50 text-indigo-700 border-indigo-200",
  legislature_lower:       "bg-indigo-50 text-indigo-700 border-indigo-200",
  legislature_unicameral:  "bg-indigo-50 text-indigo-700 border-indigo-200",
  executive:               "bg-rose-50 text-rose-700 border-rose-200",
  judicial:                "bg-amber-50 text-amber-700 border-amber-200",
  regulatory_agency:       "bg-blue-50 text-blue-700 border-blue-200",
  municipal_council:       "bg-green-50 text-green-700 border-green-200",
  school_board:            "bg-green-50 text-green-700 border-green-200",
  special_district:        "bg-emerald-50 text-emerald-700 border-emerald-200",
  international_body:      "bg-purple-50 text-purple-700 border-purple-200",
  committee:               "bg-sky-50 text-sky-700 border-sky-200",
  other:                   "bg-gray-50 text-gray-600 border-gray-200",
};

const PROPOSAL_STATUS: Record<string, { color: string; label: string }> = {
  open_comment:         { color: "bg-emerald-100 text-emerald-800", label: "Open Comment" },
  introduced:           { color: "bg-amber-100 text-amber-800",     label: "Proposed" },
  in_committee:         { color: "bg-amber-100 text-amber-800",     label: "In Review" },
  floor_vote:           { color: "bg-blue-100 text-blue-800",       label: "Floor Vote" },
  passed_committee:     { color: "bg-blue-100 text-blue-800",       label: "Passed Committee" },
  comment_closed:       { color: "bg-gray-100 text-gray-700",       label: "Comment Closed" },
  final_rule:           { color: "bg-green-100 text-green-800",     label: "Final Rule" },
  enacted:              { color: "bg-green-100 text-green-800",     label: "Enacted" },
  signed:               { color: "bg-green-100 text-green-800",     label: "Signed" },
  failed:               { color: "bg-red-100 text-red-800",         label: "Failed" },
  withdrawn:            { color: "bg-gray-100 text-gray-700",       label: "Withdrawn" },
};

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDollars(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 1_000_000_000) return `$${(dollars / 1_000_000_000).toFixed(1)}B`;
  if (dollars >= 1_000_000)     return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000)         return `$${(dollars / 1_000).toFixed(0)}K`;
  return `$${dollars.toFixed(0)}`;
}

function getFiscalYear(isoDate: string | null): string {
  if (!isoDate) return "Unknown";
  const d = new Date(isoDate);
  const month = d.getMonth();
  const year  = d.getFullYear();
  return month >= 9 ? `FY${year + 1}` : `FY${year}`;
}

function aggregateSpending(rows: SpendingRow[]): SpendingGroup[] {
  const map = new Map<string, SpendingGroup>();
  for (const row of rows) {
    const fy  = getFiscalYear(row.award_date);
    const key = `${row.recipient_name}|${row.award_type ?? "other"}|${fy}`;
    if (map.has(key)) {
      map.get(key)!.totalCents += row.amount_cents;
    } else {
      map.set(key, {
        recipient:  row.recipient_name,
        awardType:  row.award_type ?? "other",
        totalCents: row.amount_cents,
        fiscalYear: fy,
      });
    }
  }
  return Array.from(map.values())
    .sort((a, b) => b.totalCents - a.totalCents)
    .slice(0, 10);
}

export async function generateStaticParams() {
  return [];
}

// FIX-645: this page emits no per-user server content (follow/comment UI are
// client islands). Its only dynamic dependency was a createAdminClient() read of
// the service-role-only plum_book_state row — now exposed via the
// get_plum_book_last_change() RPC (FIX-645). With that gone it renders on the
// publishable client, so switch force-dynamic → ISR off the per-hit render path.
export const revalidate = 300;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return { title: "Institution" };

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = (await withDbTimeout(
    (supabase as any)
      .from("institutions")
      .select("name, acronym")
      .eq("id", id)
      .maybeSingle(),
    3000,
    "institutions:metadata"
  )) as any;

  if (!data) return { title: "Institution" };
  const label = data.acronym ? `${data.acronym} — ${data.name}` : data.name;
  return { title: label };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function InstitutionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = createPublicClient();

  // Slug → UUID resolution. governing_bodies.slug only — agencies have no slug.
  if (!UUID_RE.test(id)) {
    const { data: slugRow } = await withDbTimeout(
      supabase
        .from("governing_bodies")
        .select("id")
        .eq("slug", id)
        .maybeSingle(),
      3000,
      "institutions:slug-resolve"
    );
    if (!slugRow?.id) notFound();
    permanentRedirect(`/institutions/${slugRow.id}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const instRes = (await withDbTimeout(
    (supabase as any)
      .from("institutions")
      .select(
        "id, jurisdiction_id, type, name, short_name, website_url, contact_email, is_active, slug, source_table, acronym, usaspending_agency_id, usaspending_subtier_id, parent_id, primary_source, primary_source_url, primary_source_last_seen_at, metadata, is_synthetic"
      )
      .eq("id", id)
      .maybeSingle(),
    3000,
    "institutions:detail"
  )) as any;

  const institution = instRes.data as InstitutionRow | null;
  if (!institution) notFound();

  const attributionEntityType: "agency" | "governing_body" = institution.source_table;
  const attribution = await fetchAttributionForEntity(supabase, attributionEntityType, institution.id);

  return (
    <>
      {institution.source_table === "agency"
        ? <AgencyView institution={institution} attribution={attribution} supabase={supabase} />
        : <GoverningBodyView institution={institution} attribution={attribution} supabase={supabase} />}
      {/* FIX-610: citizen↔answerer Q&A lane. Anyone may ask; answers require an
          active institution_admin grant on this institution (= agency/gb id) —
          unclaimed real institutions show the honest "awaiting response" state. */}
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <QASection entityId={institution.id} entityType="institution" entityName={institution.short_name ?? institution.name} />
      </div>
      <div className="mx-auto max-w-5xl px-4 pb-12 sm:px-6">
        <EntityComments
          entityType="institution"
          entityId={institution.id}
          lensEnabled
          startCollapsed
          heading="Community comments"
        />
      </div>
    </>
  );
}

// ─── Agency view ──────────────────────────────────────────────────────────────
// Mirrors /agencies/[slug]/page.tsx — full hierarchy, spending, officials, graph.

async function AgencyView({
  institution,
  attribution,
  supabase,
}: {
  institution: InstitutionRow;
  attribution: Awaited<ReturnType<typeof fetchAttributionForEntity>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any;
}) {
  // FIX-647: ONE consolidating RPC replaces the agency branch's ~14-query
  // request-path fan-out (agency extras, active/recent rules, spending +
  // recipient-name resolution, total/open counts, appointment connections +
  // officials, plum freshness, parent/children). The page is already ISR
  // (FIX-645) + withDbTimeout-wrapped (FIX-638); this collapses the cache-miss
  // render cost. Each payload section mirrors the exact shape the old
  // per-section query returned, so the JS shaping below (aggregateSpending, the
  // SOURCE_PRIORITY dedup, mapProposal) is unchanged — it just reads the payload.
  // withDbTimeout<T> infers T=unknown on an any builder, so cast locally rather
  // than pass a type arg (the FIX-639 render-timeout guard still sees the wrap).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rpcData } = (await withDbTimeout(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).rpc("get_agency_page", { p_id: institution.id }),
    3000,
    "institutions:agency-page"
  )) as { data: unknown };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload = (rpcData ?? null) as any;

  const agencyExtra = (payload?.agency_extra ?? null) as {
    description: string | null;
    founded_year: number | null;
    personnel_fte: number | null;
    governing_body_id: string | null;
    agency_type: string | null;
  } | null;

  const agency = {
    id:                institution.id,
    name:              institution.name,
    short_name:        institution.short_name,
    acronym:           institution.acronym,
    agency_type:       agencyExtra?.agency_type ?? institution.type,
    website_url:       institution.website_url,
    contact_email:     institution.contact_email,
    description:       (agencyExtra?.description ?? null) as string | null,
    governing_body_id: (agencyExtra?.governing_body_id ?? null) as string | null,
    parent_agency_id:  institution.parent_id,
    founded_year:      (agencyExtra?.founded_year ?? null) as number | null,
    personnel_fte:     (agencyExtra?.personnel_fte ?? null) as number | null,
    metadata:          (institution.metadata ?? {}) as Record<string, string | null>,
  };

  const mapProposal = (row: { id: string; title: string; status: string; type: string; introduced_at: string | null; summary_plain: string | null; metadata: Record<string, unknown> | null; bill_details?: { bill_number?: string | null } | null }): Proposal => ({
    id: row.id,
    title: row.title,
    status: row.status,
    type: row.type,
    bill_number: row.bill_details?.bill_number ?? null,
    regulations_gov_id: ((row.metadata ?? {}) as Record<string, string | null>)["regulations_gov_id"] ?? null,
    introduced_at: row.introduced_at,
    comment_period_end: ((row.metadata ?? {}) as Record<string, string | null>)["comment_period_end"] ?? null,
    summary_plain: row.summary_plain,
  });

  const activeRules: Proposal[] = (payload?.active_rules ?? []).map(mapProposal);
  const recentRules: Proposal[] = (payload?.recent_rules ?? []).map(mapProposal);
  const totalRules = payload?.total_rules ?? 0;
  const openRules  = payload?.open_rules ?? 0;

  // Spending rows arrive recipient-resolved in SpendingRow shape from the RPC
  // (financial_entity recipients named, everything else "Unknown recipient" —
  // identical to the old two-step name resolution). aggregateSpending is unchanged.
  const spendingGroups = aggregateSpending((payload?.spending ?? []) as SpendingRow[]);

  const totalSpentCents = spendingGroups.reduce((sum, g) => sum + g.totalCents, 0);

  // Raw appointment connections (same select shape as before) for the dedup below.
  const connectionRows = (payload?.connections ?? []) as Array<{
    from_id: string; from_type: string; to_id: string; to_type: string;
    connection_type: string; strength: number | null;
    metadata: Record<string, unknown> | null; evidence_source: string | null;
  }>;

  const officialIds = Array.from(
    new Set(
      (connectionRows ?? []).map((r: { from_type: string; from_id: string; to_id: string }) =>
        r.from_type === "official" ? r.from_id : r.to_id
      )
    )
  );

  const SOURCE_PRIORITY: Record<string, number> = { plum_book: 3, congress_nominations: 2, wikidata: 1 };
  const connectionByOfficialId = new Map<string, {
    connectionType: string;
    positionTitle:  string | null;
    strength:       number;
    startDate:      string | null;
    endDate:        string | null;
    isCurrent:      boolean;
    evidenceSource: string | null;
    sourceDate:     string | null;
  }>();
  for (const r of (connectionRows ?? []) as Array<{
    from_type: string; from_id: string; to_id: string;
    connection_type: string; strength: number | null;
    metadata: Record<string, unknown> | null; evidence_source: string | null;
  }>) {
    const officialId = r.from_type === "official" ? r.from_id : r.to_id;
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const incoming = {
      connectionType: r.connection_type,
      positionTitle:  typeof meta["position_title"] === "string" ? meta["position_title"] as string : null,
      strength:       typeof r.strength === "number" ? r.strength : 0,
      startDate:      typeof meta["start_date"] === "string" ? meta["start_date"] as string : null,
      endDate:        typeof meta["end_date"]   === "string" ? meta["end_date"]   as string : null,
      isCurrent:      meta["is_current"] === true,
      evidenceSource: typeof r.evidence_source === "string" ? r.evidence_source : null,
      sourceDate:     typeof meta["source_date"] === "string" ? meta["source_date"] as string : null,
    };
    const existing = connectionByOfficialId.get(officialId);
    const inPriority = SOURCE_PRIORITY[incoming.evidenceSource ?? ""] ?? 0;
    const exPriority = SOURCE_PRIORITY[existing?.evidenceSource ?? ""] ?? 0;
    if (!existing || inPriority > exPriority) {
      connectionByOfficialId.set(officialId, incoming);
    }
  }

  let officials: OfficialLink[] = [];
  if (officialIds.length > 0) {
    const officialRows = (payload?.officials ?? []) as Array<{ id: string; full_name: string; role_title: string | null }>;
    officials = officialRows.map((o) => {
      const conn = connectionByOfficialId.get(o.id) ?? { connectionType: "oversight", positionTitle: null, strength: 0, startDate: null, endDate: null, isCurrent: false, evidenceSource: null, sourceDate: null };
      return {
        id:             o.id,
        name:           o.full_name,
        title:          conn.positionTitle ?? (o.role_title ?? ""),
        connectionType: conn.connectionType,
        strength:       conn.strength,
        startDate:      conn.startDate,
        endDate:        conn.endDate,
        isCurrent:      conn.isCurrent,
        evidenceSource: conn.evidenceSource,
        sourceDate:     conn.sourceDate,
      };
    });
    officials.sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      if (a.strength !== b.strength) return b.strength - a.strength;
      if (a.endDate && b.endDate) return b.endDate.localeCompare(a.endDate);
      return 0;
    });
  }

  // plum_book_state freshness date, delegated through get_agency_page →
  // get_plum_book_last_change() (the SECURITY DEFINER RPC FIX-645 added so the
  // publishable client can read this without force-dynamic). Same slice(0,10).
  const plumLastChange: string | null =
    typeof payload?.plum_last_change === "string" ? payload.plum_last_change.slice(0, 10) : null;

  const parentAgency = (payload?.parent_agency ?? null) as { id: string; name: string; acronym: string | null } | null;
  const childAgencies = (payload?.child_agencies ?? []) as { id: string; name: string; acronym: string | null }[];

  const typeColor = AGENCY_TYPE_COLORS[agency.agency_type] ?? AGENCY_TYPE_COLORS["other"]!;
  const typeLabel = AGENCY_TYPE_LABELS[agency.agency_type] ?? "Agency";
  const displayAcronym = agency.acronym ?? agency.short_name ?? agency.name.slice(0, 5).toUpperCase();
  const agencyMeta = agency.metadata;
  const twitterHandle = agencyMeta["twitter_handle"] ?? null;
  const youtubeHandle = agencyMeta["youtube_handle"] ?? null;
  const facebookUrl   = agencyMeta["facebook_url"]   ?? null;

  return (
    <div className="min-h-screen bg-gray-50">
      <script
        type="application/json"
        data-civitics-attribution="agency"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(attribution) }}
      />
      <PageViewTracker entityType="agency" entityId={agency.id} />
      <header className="border-b border-gray-200 bg-white px-5 py-3">
        <div className="flex items-center gap-3">
          <a href="/" className="text-sm font-medium text-gray-400 hover:text-gray-700 transition-colors">
            ← Civitics
          </a>
          <span className="text-gray-200">/</span>
          <a href="/agencies" className="text-sm font-medium text-gray-400 hover:text-gray-700 transition-colors">
            Agencies
          </a>
          <span className="text-gray-200">/</span>
          <span className="text-sm font-semibold text-gray-900">{displayAcronym}</span>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <div className="flex items-start gap-5">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-gray-50 font-mono text-lg font-bold text-gray-700">
              {displayAcronym.slice(0, 4)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded border px-2 py-0.5 text-xs font-semibold ${typeColor}`}>
                  {typeLabel}
                </span>
                {agency.founded_year && (
                  <span className="rounded border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs text-gray-500">
                    Est. {agency.founded_year}
                  </span>
                )}
                <SourceDetailPopover
                  entityType="agency"
                  entityId={agency.id}
                  attribution={attribution}
                >
                  <SourceBadge attribution={attribution} />
                </SourceDetailPopover>
              </div>
              <h1 className="mt-1 text-2xl font-bold text-gray-900 leading-tight">
                {agency.name}
                {institution.is_synthetic && <SyntheticMark withIcon className="ml-2 align-middle" />}
              </h1>
              <FormerBadge isActive={institution.is_active} className="mt-1" />
              {agency.acronym && agency.acronym !== agency.name && (
                <p className="text-sm font-medium text-gray-500">{agency.acronym}</p>
              )}
              {agency.description && (
                <p className="mt-2 text-sm text-gray-600 leading-relaxed max-w-3xl">
                  {agency.description}
                </p>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-4">
                {agency.website_url && (
                  <a
                    href={agency.website_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-indigo-600 hover:text-indigo-800 transition-colors"
                  >
                    {agency.website_url.replace(/^https?:\/\//, "")} ↗
                  </a>
                )}
                {twitterHandle && (
                  <a
                    href={`https://twitter.com/${twitterHandle}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-gray-400 hover:text-gray-700 transition-colors"
                    title={`@${twitterHandle} on X/Twitter`}
                  >
                    𝕏 @{twitterHandle}
                  </a>
                )}
                {youtubeHandle && (
                  <a
                    href={`https://youtube.com/${youtubeHandle}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-gray-400 hover:text-gray-700 transition-colors"
                    title="YouTube channel"
                  >
                    ▶ YouTube
                  </a>
                )}
                {facebookUrl && (
                  <a
                    href={facebookUrl.startsWith("http") ? facebookUrl : `https://facebook.com/${facebookUrl}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-gray-400 hover:text-gray-700 transition-colors"
                    title="Facebook"
                  >
                    f Facebook
                  </a>
                )}
                {agency.contact_email && (
                  <a
                    href={`mailto:${agency.contact_email}`}
                    className="text-sm text-gray-500 hover:text-gray-700"
                  >
                    {agency.contact_email}
                  </a>
                )}
                <FollowButton
                  entityType="agency"
                  entityId={agency.id}
                  entityLabel={agency.name}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-gray-200 bg-gray-200 sm:grid-cols-5">
          <StatBox value={totalRules > 0 ? totalRules.toLocaleString() : "—"} label="Total rules" />
          <StatBox
            value={openRules > 0 ? openRules.toLocaleString() : "—"}
            label="Open comment periods"
            highlight={openRules > 0}
          />
          <StatBox
            value={totalSpentCents > 0 ? formatDollars(totalSpentCents) : "—"}
            label="Spending on record"
          />
          <StatBox
            value={agency.personnel_fte ? `~${agency.personnel_fte.toLocaleString()}` : "—"}
            label="Personnel (FTE)"
          />
          <StatBox value="—" label="Promises tracked" note="Phase 2" />
        </div>

        {(parentAgency || childAgencies.length > 0) && (
          <div className="mt-6">
            <AgencyHierarchyTree
              parent={parentAgency}
              current={{ id: agency.id, name: agency.name, acronym: agency.acronym ?? null }}
              children={childAgencies}
            />
          </div>
        )}

        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 flex flex-col gap-6">
            <section>
              <SectionHeader title="Active Rulemaking" />
              {activeRules.length === 0 ? (
                <EmptyState message="No active rulemaking found for this agency." />
              ) : (
                <div className="flex flex-col gap-3">
                  {activeRules.map((rule) => {
                    const statusStyle = PROPOSAL_STATUS[rule.status] ?? {
                      color: "bg-gray-100 text-gray-700",
                      label: rule.status,
                    };
                    const isOpen = rule.status === "open_comment";
                    const isPastDeadline =
                      rule.comment_period_end &&
                      new Date(rule.comment_period_end) < new Date();
                    return (
                      <div
                        key={rule.id}
                        className="rounded-lg border border-gray-200 bg-white p-4"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusStyle.color}`}>
                              {statusStyle.label}
                            </span>
                            {rule.bill_number && (
                              <span className="rounded bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-600">
                                {rule.bill_number}
                              </span>
                            )}
                            {rule.regulations_gov_id && (
                              <span className="rounded bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-600">
                                {rule.regulations_gov_id}
                              </span>
                            )}
                          </div>
                          {rule.comment_period_end && (
                            <span className={`shrink-0 text-xs ${isPastDeadline ? "text-red-500" : "text-gray-400"}`}>
                              {isOpen ? "Deadline: " : "Closed: "}
                              {formatDate(rule.comment_period_end)}
                            </span>
                          )}
                        </div>
                        <h3 className="mt-2 text-sm font-semibold text-gray-900 leading-snug">
                          {rule.title}
                        </h3>
                        {rule.summary_plain && (
                          <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-gray-500">
                            {rule.summary_plain}
                          </p>
                        )}
                        {isOpen && !isPastDeadline && (
                          <div className="mt-3 flex items-center justify-between rounded border border-emerald-200 bg-emerald-50 px-3 py-2">
                            <p className="text-xs text-emerald-800">
                              Comment period open. Submitting is free — no account required.
                            </p>
                            <a
                              href="#"
                              className="ml-3 shrink-0 rounded bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700 transition-colors"
                            >
                              Submit comment →
                            </a>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {recentRules.length > 0 && (
              <section>
                <SectionHeader title="Recent Rules" subtitle="Closed or finalized" />
                <div className="flex flex-col gap-2">
                  {recentRules.map((rule) => {
                    const statusStyle = PROPOSAL_STATUS[rule.status] ?? {
                      color: "bg-gray-100 text-gray-700",
                      label: rule.status,
                    };
                    return (
                      <div
                        key={rule.id}
                        className="flex items-start justify-between gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-gray-800">{rule.title}</p>
                          <p className="mt-0.5 text-xs text-gray-400">
                            {rule.bill_number ?? rule.regulations_gov_id ?? rule.type}
                            {rule.comment_period_end ? ` · ${formatDate(rule.comment_period_end)}` : ""}
                          </p>
                        </div>
                        <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${statusStyle.color}`}>
                          {statusStyle.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            <section>
              <SectionHeader
                title="Spending"
                subtitle="Top contractors and grant recipients"
              />
              {spendingGroups.length === 0 ? (
                <EmptyState message="Spending data syncs weekly from USASpending.gov." />
              ) : (
                <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100 bg-gray-50">
                        <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                          Recipient
                        </th>
                        <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                          Type
                        </th>
                        <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wider text-gray-500">
                          Amount
                        </th>
                        <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wider text-gray-500">
                          Year
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {spendingGroups.map((g, i) => (
                        <tr key={i} className="hover:bg-gray-50">
                          <td className="max-w-xs truncate px-4 py-2.5 text-sm font-medium text-gray-800">
                            {g.recipient}
                          </td>
                          <td className="px-4 py-2.5 text-xs capitalize text-gray-500">
                            {g.awardType}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-sm font-semibold text-gray-900">
                            {formatDollars(g.totalCents)}
                          </td>
                          <td className="px-4 py-2.5 text-right text-xs text-gray-400">
                            {g.fiscalYear}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>

          <div className="flex flex-col gap-6">
            <section>
              <SectionHeader title="Leadership" />
              {officials.length === 0 ? (
                <div className="rounded-lg border border-gray-200 bg-white px-4 py-5">
                  <p className="text-sm text-gray-400">No leadership data on record yet.</p>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {officials.filter(o => o.isCurrent && o.strength >= 0.9).length > 0 && (
                    <div>
                      <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-gray-400">Agency Head</p>
                      <div className="rounded-lg border border-gray-200 bg-white divide-y divide-gray-100">
                        {officials.filter(o => o.isCurrent && o.strength >= 0.9).map((o) => (
                          <OfficialCard key={o.id} official={o} plumLastChange={plumLastChange} />
                        ))}
                      </div>
                    </div>
                  )}
                  {officials.filter(o => o.isCurrent && o.strength < 0.9).length > 0 && (
                    <div>
                      <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-gray-400">
                        {officials.filter(o => o.isCurrent && o.strength >= 0.9).length > 0 ? "Senior Leadership" : "Current"}
                      </p>
                      <div className="rounded-lg border border-gray-200 bg-white divide-y divide-gray-100">
                        {officials.filter(o => o.isCurrent && o.strength < 0.9).map((o) => (
                          <OfficialCard key={o.id} official={o} plumLastChange={plumLastChange} />
                        ))}
                      </div>
                    </div>
                  )}
                  {officials.filter(o => !o.isCurrent).length > 0 && (
                    <div>
                      <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-gray-400">Past</p>
                      <div className="rounded-lg border border-gray-200 bg-white divide-y divide-gray-100">
                        {officials.filter(o => !o.isCurrent).slice(0, 5).map((o) => (
                          <OfficialCard key={o.id} official={o} plumLastChange={plumLastChange} />
                        ))}
                      </div>
                    </div>
                  )}
                  <DataFreshnessNote plumLastChange={plumLastChange} />
                </div>
              )}
            </section>

            <div className="rounded-lg border border-indigo-100 bg-indigo-50 p-4">
              <p className="text-sm font-semibold text-indigo-900">
                Your tax dollars fund this agency.
              </p>
              <p className="mt-1 text-xs text-indigo-700 leading-relaxed">
                Comment on proposed rules — free, always. No account, no fees, no exceptions.
              </p>
              {openRules > 0 && (
                <a
                  href="#active-rulemaking"
                  className="mt-3 block rounded border border-indigo-300 bg-white px-3 py-2 text-center text-xs font-medium text-indigo-700 hover:bg-indigo-50 transition-colors"
                >
                  {openRules} open period{openRules !== 1 ? "s" : ""} — comment now →
                </a>
              )}
            </div>
          </div>
        </div>

        <div className="mt-6">
          <SectionHeader title="Connection Graph" subtitle="Officials, contractors, and oversight relationships" />
          <div className="mt-3 rounded-lg border border-gray-200 overflow-hidden">
            <AgencyGraph agencyId={agency.id} agencyName={agency.name} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Governing-body view ──────────────────────────────────────────────────────
// FIX-H: full legislature treatment — header + breadcrumbs, party-balance bar,
// members roster (shared OfficialRosterCard), sub-bodies/committees tree,
// recent votes (party-line + unanimous indicators via get_institution_recent_votes
// RPC), recent proposals, recent meetings. Non-legislative governing bodies
// degrade gracefully — sections with no data self-omit.

// Types that get the legislature treatment (party balance bar + votes are most
// meaningful here). Others (judicial/executive/school_board/etc.) still render
// the roster, just without the party bar.
const LEGISLATURE_TYPES = new Set([
  "legislature_upper",
  "legislature_lower",
  "legislature_unicameral",
  "municipal_council",
]);

const PARTY_BAR: Array<{ key: string; label: string; color: string }> = [
  { key: "democrat",    label: "Democrat",    color: "bg-blue-500" },
  { key: "republican",  label: "Republican",  color: "bg-red-500" },
  { key: "independent", label: "Independent", color: "bg-purple-500" },
  { key: "other",       label: "Other",       color: "bg-gray-400" },
];

type RecentVote = {
  proposal_id: string | null;
  proposal_title: string | null;
  bill_number: string | null;
  vote_question: string | null;
  voted_at: string | null;
  yes_count: number;
  no_count: number;
  abstain_count: number;
  not_voting_count: number;
  party_line: boolean;
  unanimous: boolean;
};

async function GoverningBodyView({
  institution,
  attribution,
  supabase,
}: {
  institution: InstitutionRow;
  attribution: Awaited<ReturnType<typeof fetchAttributionForEntity>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any;
}) {
  const isLegislature = LEGISLATURE_TYPES.has(institution.type);

  // FIX-647: ONE consolidating RPC replaces the governing-body branch's ~11-query
  // request-path fan-out (gb extras, jurisdiction, parent, roster, party balance,
  // active/recent/total proposals, sub-bodies, meetings, recent votes — the last
  // delegated to get_institution_recent_votes, FIX-439). The page is already ISR
  // (FIX-645) + withDbTimeout-wrapped (FIX-638); this collapses the cache-miss
  // render cost. The roster/party current-member scope (is_active AND
  // tier='elected', FIX-470/FIX-476) and the meeting window (now ±30/60d) live in
  // the RPC now; each section mirrors the old query's exact shape so the JS
  // shaping below (roster/party/meeting reshape, mapProposal) is unchanged.
  // withDbTimeout<T> infers T=unknown on an any builder, so cast locally rather
  // than pass a type arg (the FIX-639 render-timeout guard still sees the wrap).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rpcData } = (await withDbTimeout(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).rpc("get_gb_page", { p_id: institution.id }),
    3000,
    "institutions:gb-page"
  )) as { data: unknown };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload = (rpcData ?? null) as any;

  const gbExtra = (payload?.gb_extra ?? null) as { seat_count: number | null; term_length_years: number | null } | null;
  const jurisdiction = (payload?.jurisdiction ?? null) as { id: string; name: string; is_synthetic?: boolean } | null;
  const parent = (payload?.parent ?? null) as { id: string; name: string } | null;

  const roster = ((payload?.roster ?? []) as Array<{
    id: string;
    full_name: string;
    role_title: string | null;
    party: string | null;
    photo_url: string | null;
    district_name: string | null;
    is_synthetic?: boolean | null;
  }>).map<OfficialRosterData>((o) => ({
    id: o.id,
    full_name: o.full_name,
    role_title: o.role_title ?? "Member",
    party: o.party,
    photo_url: o.photo_url,
    district_name: o.district_name,
    is_synthetic: o.is_synthetic ?? false,
  }));

  // Party balance over ALL active members (not just the rendered roster slice).
  const partyCounts = new Map<string, number>();
  for (const r of (payload?.party_balance ?? []) as Array<{ party: string | null }>) {
    const bucket =
      r.party === "democrat" || r.party === "republican" || r.party === "independent"
        ? r.party
        : "other";
    partyCounts.set(bucket, (partyCounts.get(bucket) ?? 0) + 1);
  }
  const partyTotal = Array.from(partyCounts.values()).reduce((a, b) => a + b, 0);

  // Sub-bodies / committees: the RPC folds the old two-step (institution_extensions
  // → governing_bodies) into one join, returning resolved {id,name,type} rows
  // (is_active, ordered by name, limit 100). Empty today — institution_extensions
  // is unpopulated — so the section self-omits.
  const subBodies = (payload?.sub_bodies ?? []) as Array<{ id: string; name: string; type: string }>;

  const meetings = ((payload?.meetings ?? []) as Array<{
    id: string;
    title: string | null;
    meeting_type: string;
    scheduled_at: string;
    agenda_url: string | null;
    governing_bodies?: { is_synthetic?: boolean | null } | { is_synthetic?: boolean | null }[] | null;
  }>).map<MeetingCardData>((m) => {
    const gb = Array.isArray(m.governing_bodies) ? m.governing_bodies[0] : m.governing_bodies;
    return {
      id: m.id,
      title: m.title,
      meeting_type: m.meeting_type,
      scheduled_at: m.scheduled_at,
      bodyName: institution.short_name ?? institution.name,
      agenda_url: m.agenda_url,
      is_synthetic: gb?.is_synthetic ?? false,
    };
  });

  const recentVotes = (payload?.recent_votes ?? []) as RecentVote[];

  const mapProposal = (row: { id: string; title: string; status: string; type: string; introduced_at: string | null; summary_plain: string | null; metadata: Record<string, unknown> | null; bill_details?: { bill_number?: string | null } | null }): Proposal => ({
    id: row.id,
    title: row.title,
    status: row.status,
    type: row.type,
    bill_number: row.bill_details?.bill_number ?? null,
    regulations_gov_id: ((row.metadata ?? {}) as Record<string, string | null>)["regulations_gov_id"] ?? null,
    introduced_at: row.introduced_at,
    comment_period_end: ((row.metadata ?? {}) as Record<string, string | null>)["comment_period_end"] ?? null,
    summary_plain: row.summary_plain,
  });

  const activeProposals: Proposal[] = (payload?.active_proposals ?? []).map(mapProposal);
  const recentProposals: Proposal[] = (payload?.recent_proposals ?? []).map(mapProposal);
  const totalProposals = payload?.total_proposals ?? 0;

  const typeColor = GB_TYPE_COLORS[institution.type] ?? GB_TYPE_COLORS["other"]!;
  const typeLabel = GB_TYPE_LABELS[institution.type] ?? "Governing Body";
  const displayAcronym = institution.short_name ?? institution.name.split(" ").map((w) => w[0]).join("").slice(0, 5).toUpperCase();
  const gbMeta = (institution.metadata ?? {}) as Record<string, string | null>;
  const twitterHandle = gbMeta["twitter_handle"] ?? null;

  const ROSTER_VISIBLE = 50;
  const visibleRoster = roster.slice(0, ROSTER_VISIBLE);
  const hiddenRoster = roster.slice(ROSTER_VISIBLE);

  return (
    <div className="min-h-screen bg-gray-50">
      <script
        type="application/json"
        data-civitics-attribution="governing_body"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(attribution) }}
      />
      <PageViewTracker entityType="governing_body" entityId={institution.id} />
      <header className="border-b border-gray-200 bg-white px-5 py-3">
        <div className="flex items-center gap-3">
          <a href="/" className="text-sm font-medium text-gray-400 hover:text-gray-700 transition-colors">
            ← Civitics
          </a>
          <span className="text-gray-200">/</span>
          <a href="/officials" className="text-sm font-medium text-gray-400 hover:text-gray-700 transition-colors">
            Officials
          </a>
          <span className="text-gray-200">/</span>
          <span className="text-sm font-semibold text-gray-900">{institution.short_name ?? institution.name}</span>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <div className="flex items-start gap-5">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-gray-50 font-mono text-lg font-bold text-gray-700">
              {displayAcronym.slice(0, 4)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                {jurisdiction?.is_synthetic && !institution.is_synthetic && (
                  <SyntheticBanner scope="entity" className="w-full" />
                )}
                <span className={`rounded border px-2 py-0.5 text-xs font-semibold ${typeColor}`}>
                  {typeLabel}
                </span>
                <SourceDetailPopover
                  entityType="governing_body"
                  entityId={institution.id}
                  attribution={attribution}
                >
                  <SourceBadge attribution={attribution} />
                </SourceDetailPopover>
              </div>
              {(jurisdiction || parent) && (
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-gray-500">
                  {jurisdiction && (
                    <a href={`/jurisdictions/${jurisdiction.id}`} className="hover:text-indigo-600 transition-colors">
                      {jurisdiction.name}
                    </a>
                  )}
                  {parent && (
                    <>
                      {jurisdiction && <span className="text-gray-300">·</span>}
                      <span>
                        Part of{" "}
                        <a href={`/institutions/${parent.id}`} className="font-medium hover:text-indigo-600 transition-colors">
                          {parent.name}
                        </a>
                      </span>
                    </>
                  )}
                </div>
              )}
              <h1 className="mt-1 text-2xl font-bold text-gray-900 leading-tight">
                {institution.name}
                {institution.is_synthetic && <SyntheticMark withIcon className="ml-2 align-middle" />}
              </h1>
              <FormerBadge isActive={institution.is_active} className="mt-1" />
              {institution.short_name && institution.short_name !== institution.name && (
                <p className="text-sm font-medium text-gray-500">{institution.short_name}</p>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-4">
                {institution.website_url && (
                  <a
                    href={institution.website_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-indigo-600 hover:text-indigo-800 transition-colors"
                  >
                    {institution.website_url.replace(/^https?:\/\//, "")} ↗
                  </a>
                )}
                {twitterHandle && (
                  <a
                    href={`https://twitter.com/${twitterHandle}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-gray-400 hover:text-gray-700 transition-colors"
                  >
                    𝕏 @{twitterHandle}
                  </a>
                )}
                {institution.contact_email && (
                  <a
                    href={`mailto:${institution.contact_email}`}
                    className="text-sm text-gray-500 hover:text-gray-700"
                  >
                    {institution.contact_email}
                  </a>
                )}
                <FollowButton
                  entityType="agency"
                  entityId={institution.id}
                  entityLabel={institution.name}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-gray-200 bg-gray-200 sm:grid-cols-4">
          <StatBox value={partyTotal > 0 ? partyTotal.toLocaleString() : "—"} label="Active members" />
          <StatBox
            value={gbExtra?.seat_count ? gbExtra.seat_count.toLocaleString() : "—"}
            label="Total seats"
          />
          <StatBox
            value={totalProposals > 0 ? totalProposals.toLocaleString() : "—"}
            label="Proposals on record"
          />
          <StatBox
            value={gbExtra?.term_length_years ? `${gbExtra.term_length_years} yr` : "—"}
            label="Term length"
          />
        </div>

        {isLegislature && partyTotal > 0 && (
          <div className="mt-6">
            <PartyBalanceBar counts={partyCounts} total={partyTotal} />
          </div>
        )}

        {roster.length > 0 && (
          <section className="mt-6">
            <SectionHeader title="Members" subtitle={`${partyTotal.toLocaleString()} active`} />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {visibleRoster.map((o) => (
                <OfficialRosterCard key={o.id} official={o} />
              ))}
            </div>
            {hiddenRoster.length > 0 && (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-medium text-indigo-600 hover:text-indigo-800">
                  Show all {roster.length.toLocaleString()} members
                </summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {hiddenRoster.map((o) => (
                    <OfficialRosterCard key={o.id} official={o} />
                  ))}
                </div>
              </details>
            )}
          </section>
        )}

        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 flex flex-col gap-6">
            {recentVotes.length > 0 && (
              <section>
                <SectionHeader title="Recent Votes" subtitle="Latest roll-call votes" />
                <div className="flex flex-col gap-2">
                  {recentVotes.map((v, i) => (
                    <RecentVoteRow key={`${v.proposal_id ?? "x"}-${i}`} vote={v} />
                  ))}
                </div>
              </section>
            )}

            <section>
              <SectionHeader title="Active Proposals" />
              {activeProposals.length === 0 ? (
                <EmptyState message="No active proposals on record for this body." />
              ) : (
                <div className="flex flex-col gap-3">
                  {activeProposals.map((p) => {
                    const statusStyle = PROPOSAL_STATUS[p.status] ?? {
                      color: "bg-gray-100 text-gray-700",
                      label: p.status,
                    };
                    return (
                      <a
                        key={p.id}
                        href={`/proposals/${p.id}`}
                        className="block rounded-lg border border-gray-200 bg-white p-4 hover:bg-gray-50 transition-colors"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusStyle.color}`}>
                              {statusStyle.label}
                            </span>
                            {p.bill_number && (
                              <span className="rounded bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-600">
                                {p.bill_number}
                              </span>
                            )}
                          </div>
                          {p.introduced_at && (
                            <span className="shrink-0 text-xs text-gray-400">
                              Introduced {formatDate(p.introduced_at)}
                            </span>
                          )}
                        </div>
                        <h3 className="mt-2 text-sm font-semibold text-gray-900 leading-snug">
                          {p.title}
                        </h3>
                        {p.summary_plain && (
                          <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-gray-500">
                            {p.summary_plain}
                          </p>
                        )}
                      </a>
                    );
                  })}
                </div>
              )}
            </section>

            {recentProposals.length > 0 && (
              <section>
                <SectionHeader title="Recent Proposals" subtitle="Closed or enacted" />
                <div className="flex flex-col gap-2">
                  {recentProposals.map((p) => {
                    const statusStyle = PROPOSAL_STATUS[p.status] ?? {
                      color: "bg-gray-100 text-gray-700",
                      label: p.status,
                    };
                    return (
                      <a
                        key={p.id}
                        href={`/proposals/${p.id}`}
                        className="flex items-start justify-between gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 hover:bg-gray-50 transition-colors"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-gray-800">{p.title}</p>
                          <p className="mt-0.5 text-xs text-gray-400">
                            {p.bill_number ?? p.type}
                            {p.introduced_at ? ` · ${formatDate(p.introduced_at)}` : ""}
                          </p>
                        </div>
                        <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${statusStyle.color}`}>
                          {statusStyle.label}
                        </span>
                      </a>
                    );
                  })}
                </div>
              </section>
            )}
          </div>

          <div className="flex flex-col gap-6">
            {subBodies.length > 0 && (
              <section>
                <SectionHeader title="Committees & Sub-bodies" subtitle={`${subBodies.length} on record`} />
                <div className="rounded-lg border border-gray-200 bg-white divide-y divide-gray-100">
                  {subBodies.map((sb) => (
                    <a
                      key={sb.id}
                      href={`/institutions/${sb.id}`}
                      className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-gray-50 transition-colors"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-800">{sb.name}</span>
                      <span className="shrink-0 text-xs capitalize text-gray-400">
                        {GB_TYPE_LABELS[sb.type] ?? sb.type.replace(/_/g, " ")}
                      </span>
                    </a>
                  ))}
                </div>
              </section>
            )}

            {meetings.length > 0 && (
              <section>
                <SectionHeader title="Meetings" subtitle="Recent & upcoming" />
                <div className="flex flex-col gap-3">
                  {meetings.map((m) => (
                    <MeetingCard key={m.id} meeting={m} />
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Governing-body sub-components ──────────────────────────────────────────────

function PartyBalanceBar({
  counts,
  total,
}: {
  counts: Map<string, number>;
  total: number;
}) {
  const segments = PARTY_BAR
    .map((p) => ({ ...p, count: counts.get(p.key) ?? 0 }))
    .filter((p) => p.count > 0);
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-gray-100">
        {segments.map((s) => (
          <div
            key={s.key}
            className={s.color}
            style={{ width: `${(s.count / total) * 100}%` }}
            title={`${s.label}: ${s.count}`}
          />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
        {segments.map((s) => (
          <div key={s.key} className="flex items-center gap-1.5 text-xs">
            <span className={`h-2.5 w-2.5 rounded-full ${s.color}`} />
            <span className="font-medium text-gray-700">{s.label}</span>
            <span className="text-gray-400">
              {s.count} · {Math.round((s.count / total) * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function voteIndicator(v: RecentVote): { label: string; cls: string } | null {
  if (v.unanimous) return { label: "Unanimous", cls: "bg-gray-100 text-gray-600" };
  if (v.party_line) return { label: "Party-line", cls: "bg-rose-100 text-rose-700" };
  return { label: "Bipartisan", cls: "bg-emerald-100 text-emerald-700" };
}

function RecentVoteRow({ vote }: { vote: RecentVote }) {
  const indicator = voteIndicator(vote);
  const passed = vote.yes_count > vote.no_count;
  const inner = (
    <>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {vote.bill_number && (
            <span className="rounded bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-600">
              {vote.bill_number}
            </span>
          )}
          {indicator && (
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${indicator.cls}`}>
              {indicator.label}
            </span>
          )}
          <span className={`text-xs font-semibold ${passed ? "text-emerald-700" : "text-gray-500"}`}>
            {passed ? "Passed" : "Failed"} {vote.yes_count}–{vote.no_count}
            {vote.not_voting_count > 0 ? ` (${vote.not_voting_count} NV)` : ""}
          </span>
        </div>
        <p className="mt-1 truncate text-sm font-medium text-gray-800">
          {vote.vote_question ?? "Roll-call vote"}
          {vote.proposal_title ? ` · ${vote.proposal_title}` : ""}
        </p>
      </div>
      <span className="shrink-0 text-xs text-gray-400">{formatDate(vote.voted_at)}</span>
    </>
  );
  const className =
    "flex items-start justify-between gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 transition-colors hover:bg-gray-50";
  return vote.proposal_id ? (
    <a href={`/proposals/${vote.proposal_id}`} className={className}>
      {inner}
    </a>
  ) : (
    <div className={className}>{inner}</div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatBox({
  value,
  label,
  highlight,
  note,
}: {
  value: string;
  label: string;
  highlight?: boolean;
  note?: string;
}) {
  return (
    <div className="bg-white px-4 py-4 text-center">
      <p className={`text-xl font-bold ${highlight ? "text-emerald-600" : "text-gray-900"}`}>
        {value}
      </p>
      <p className="mt-0.5 text-xs text-gray-500">{label}</p>
      {note && <p className="text-[10px] text-gray-300">{note}</p>}
    </div>
  );
}

function SectionHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="mb-3">
      <h2 className="text-base font-semibold text-gray-900">{title}</h2>
      {subtitle && <p className="text-xs text-gray-400">{subtitle}</p>}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-5 py-8 text-center">
      <p className="text-sm text-gray-400">{message}</p>
    </div>
  );
}

function formatTenure(startDate: string | null, endDate: string | null): string {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString("en-US", { month: "short", year: "numeric" });
  if (startDate && !endDate) return `${fmt(startDate)} – present`;
  if (startDate && endDate)  return `${fmt(startDate)} – ${fmt(endDate)}`;
  if (!startDate && endDate) return `until ${fmt(endDate)}`;
  return "";
}

function OfficialCard({
  official,
  plumLastChange,
}: {
  official: OfficialLink;
  plumLastChange?: string | null;
}) {
  const tenure = formatTenure(official.startDate, official.endDate);
  const isStale =
    official.isCurrent &&
    official.evidenceSource === "plum_book" &&
    plumLastChange != null &&
    (Date.now() - new Date(plumLastChange).getTime()) > 60 * 24 * 60 * 60 * 1000;
  return (
    <a
      href={`/officials/${official.id}`}
      className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors"
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs font-bold text-gray-600">
        {official.name.split(" ").map((w: string) => w[0]).join("").slice(0, 2)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-semibold text-gray-900">{official.name}</p>
          {official.isCurrent && !isStale && (
            <span className="shrink-0 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
              Current
            </span>
          )}
          {official.isCurrent && isStale && (
            <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700" title="Data may be outdated — OPM PLUM Book hasn't been updated recently">
              Current*
            </span>
          )}
        </div>
        <p className="text-xs text-gray-500">{official.title}</p>
        {tenure && <p className="text-xs text-gray-400">{tenure}</p>}
      </div>
      <svg className="h-4 w-4 shrink-0 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
    </a>
  );
}

function DataFreshnessNote({ plumLastChange }: { plumLastChange: string | null }) {
  if (!plumLastChange) return null;
  const date = new Date(plumLastChange);
  const isStale = (Date.now() - date.getTime()) > 60 * 24 * 60 * 60 * 1000;
  const formatted = date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  return (
    <p className={`mt-2 text-[11px] ${isStale ? "text-amber-600" : "text-gray-400"}`}>
      {isStale ? "* " : ""}OPM PLUM Book data as of {formatted}
      {isStale && " — may not reflect recent changes"}
    </p>
  );
}
