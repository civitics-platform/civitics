import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import nextDynamic from "next/dynamic";
import { createServerClient, createAdminClient, fetchAttributionForEntity } from "@civitics/db";
import { createClient } from "@supabase/supabase-js";
import { AgencyHierarchyTree } from "./components/AgencyHierarchyTree";
import { PageViewTracker } from "../../components/PageViewTracker";
import { FollowButton } from "../../components/FollowButton";
import { SourceBadge } from "../../components/SourceBadge";
import { SourceDetailPopover } from "../../components/SourceDetailPopover";

// FIX-205: defer the D3 graph chunk off the initial /agencies/[slug] bundle.
// The graph isn't always the first thing visitors look at — and even when
// it is, the chunk loads on demand without blocking the surrounding page.
const AgencyGraph = nextDynamic(
  () => import("./components/AgencyGraph").then((m) => ({ default: m.AgencyGraph })),
  { ssr: false, loading: () => <div className="h-[400px] bg-gray-50 rounded-lg" /> }
);

// ─── Types ────────────────────────────────────────────────────────────────────

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
  sourceDate: string | null;  // date OPM/Wikidata last changed this record
};

type SpendingRow = {
  recipient_name: string;
  award_type: "contract" | "grant" | string;
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
  // US fiscal year: Oct 1 – Sep 30
  const month = d.getMonth(); // 0-based
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

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // Use public client — secret key is not available at Vercel build time
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
  );
  const { data } = await supabase.from("agencies").select("name, acronym").eq("id", slug).single();

  if (!data) return { title: "Agency" };
  const label = data.acronym ? `${data.acronym} — ${data.name}` : data.name;
  return { title: label };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function AgencyProfilePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const cookieStore = await cookies();
  const supabase = createServerClient(cookieStore);
  const now = new Date().toISOString();

  // Step 1: fetch agency
  const agencyRes = await supabase
    .from("agencies")
    .select("id, name, short_name, acronym, agency_type, website_url, contact_email, description, governing_body_id, parent_agency_id, founded_year, personnel_fte, metadata")
    .eq("id", slug)
    .single();

  const agency = agencyRes.data;
  if (!agency) notFound();

  // FIX-398: attribution shape for the future SourceBadge (FIX-399). Most
  // agencies have primary_source IS NULL today; the badge will simply skip
  // rendering when primary is null.
  const agencyAttribution = await fetchAttributionForEntity(supabase, "agency", agency.id);

  // Step 2: use agency key for proposal queries (metadata->>agency_id stores acronym or name)
  const agencyKey = agency.acronym ?? agency.name;

  const proposalSelect =
    "id, title, status, type, introduced_at, summary_plain, metadata, bill_details(bill_number)";

  const [
    activeRulesRes,
    recentRulesRes,
    spendingRes,
    totalCountRes,
    openCountRes,
  ] = await Promise.all([
    supabase
      .from("proposals")
      .select(proposalSelect)
      .in("status", ["introduced", "in_committee"])
      .filter("metadata->>agency_id", "eq", agencyKey)
      .order("metadata->>comment_period_end", { ascending: true })
      .limit(20),

    supabase
      .from("proposals")
      .select(proposalSelect)
      .in("status", ["enacted", "failed", "withdrawn", "tabled"])
      .filter("metadata->>agency_id", "eq", agencyKey)
      .order("updated_at", { ascending: false })
      .limit(5),

    supabase
      .from("financial_relationships")
      .select("to_id, to_type, relationship_type, amount_cents, occurred_at")
      .in("relationship_type", ["contract", "grant"])
      .eq("from_type", "agency")
      .eq("from_id", agency.id)
      .order("amount_cents", { ascending: false })
      .limit(100),

    supabase
      .from("proposals")
      .select("id", { count: "exact", head: true })
      .filter("metadata->>agency_id", "eq", agencyKey),

    supabase
      .from("proposals")
      .select("id", { count: "exact", head: true })
      .filter("metadata->>agency_id", "eq", agencyKey)
      .eq("status", "introduced")
      .gt("metadata->>comment_period_end", now),
  ]);

  const mapProposal = (row: any): Proposal => ({
    id: row.id,
    title: row.title,
    status: row.status,
    type: row.type,
    bill_number: row.bill_details?.bill_number ?? null,
    regulations_gov_id: (row.metadata ?? {}).regulations_gov_id ?? null,
    introduced_at: row.introduced_at,
    comment_period_end: (row.metadata ?? {}).comment_period_end ?? null,
    summary_plain: row.summary_plain,
  });

  const activeRules: Proposal[] = (activeRulesRes.data ?? []).map(mapProposal);
  const recentRules: Proposal[] = (recentRulesRes.data ?? []).map(mapProposal);
  const totalRules = totalCountRes.count ?? 0;
  const openRules = openCountRes.count ?? 0;

  // Look up recipient display names for contract/grant counterparties.
  const spendingRows = (spendingRes.data ?? []) as Array<{
    to_id: string;
    to_type: string;
    relationship_type: string;
    amount_cents: number | null;
    occurred_at: string | null;
  }>;

  const entityIds = Array.from(
    new Set(spendingRows.filter((r) => r.to_type === "financial_entity").map((r) => r.to_id))
  );

  const entityNames = new Map<string, string>();
  if (entityIds.length > 0) {
    const { data: entityRows } = await supabase
      .from("financial_entities")
      .select("id, display_name, canonical_name")
      .in("id", entityIds);
    for (const e of entityRows ?? []) {
      entityNames.set(e.id, e.display_name || e.canonical_name || "Unknown recipient");
    }
  }

  const spendingGroups = aggregateSpending(
    spendingRows.map<SpendingRow>((r) => ({
      recipient_name: entityNames.get(r.to_id) ?? "Unknown recipient",
      award_type: r.relationship_type,
      amount_cents: r.amount_cents ?? 0,
      award_date: r.occurred_at,
    }))
  );

  const totalSpentCents = spendingGroups.reduce((sum, g) => sum + g.totalCents, 0);

  // Officials connected to this agency via entity_connections
  const { data: connectionRows } = await supabase
    .from("entity_connections")
    .select("from_id, from_type, to_id, to_type, connection_type, strength, metadata, evidence_source")
    .eq("connection_type", "appointment")
    .or(
      `and(from_type.eq.official,to_id.eq.${agency.id}),and(to_type.eq.official,from_id.eq.${agency.id})`
    )
    .limit(100);

  const officialIds = Array.from(
    new Set(
      (connectionRows ?? []).map((r) =>
        r.from_type === "official" ? r.from_id : r.to_id
      )
    )
  );

  // Prefer plum_book rows over wikidata/congress rows for the same official —
  // PLUM is more complete and has source_date for freshness display.
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

  for (const r of connectionRows ?? []) {
    const officialId = r.from_type === "official" ? r.from_id : r.to_id;
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const incoming = {
      connectionType: r.connection_type,
      positionTitle:  typeof meta["position_title"] === "string" ? meta["position_title"] : null,
      strength:       typeof r.strength === "number" ? r.strength : 0,
      startDate:      typeof meta["start_date"] === "string" ? meta["start_date"] : null,
      endDate:        typeof meta["end_date"]   === "string" ? meta["end_date"]   : null,
      isCurrent:      meta["is_current"] === true,
      evidenceSource: typeof r.evidence_source === "string" ? r.evidence_source : null,
      sourceDate:     typeof meta["source_date"] === "string" ? meta["source_date"] : null,
    };
    const existing = connectionByOfficialId.get(officialId);
    const inPriority  = SOURCE_PRIORITY[incoming.evidenceSource ?? ""] ?? 0;
    const exPriority  = SOURCE_PRIORITY[existing?.evidenceSource ?? ""] ?? 0;
    if (!existing || inPriority > exPriority) {
      connectionByOfficialId.set(officialId, incoming);
    }
  }

  let officials: OfficialLink[] = [];
  if (officialIds.length > 0) {
    const { data: officialRows } = await supabase
      .from("officials")
      .select("id, full_name, role_title")
      .in("id", officialIds);
    officials = (officialRows ?? []).map((o) => {
      const conn = connectionByOfficialId.get(o.id) ?? { connectionType: "oversight", positionTitle: null, strength: 0, startDate: null, endDate: null, isCurrent: false, evidenceSource: null, sourceDate: null };
      return {
        id:             o.id,
        name:           o.full_name,
        title:          conn.positionTitle ?? o.role_title,
        connectionType: conn.connectionType,
        strength:       conn.strength,
        startDate:      conn.startDate,
        endDate:        conn.endDate,
        isCurrent:      conn.isCurrent,
        evidenceSource: conn.evidenceSource,
        sourceDate:     conn.sourceDate,
      };
    });
    // Sort: current first, then by strength desc, then endDate desc
    officials.sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      if (a.strength !== b.strength) return b.strength - a.strength;
      if (a.endDate && b.endDate) return b.endDate.localeCompare(a.endDate);
      return 0;
    });
  }

  // PLUM Book data freshness — last time OPM actually changed the underlying data
  const plumStateRes = await supabase
    .from("pipeline_state")
    .select("value")
    .eq("key", "plum_book_state")
    .maybeSingle();
  const plumState = plumStateRes.data?.value as Record<string, string> | null;
  const plumLastChange: string | null = plumState?.last_change?.slice(0, 10) ?? null;

  // Agency hierarchy: parent + children
  const [parentRes, childrenRes] = await Promise.all([
    agency.parent_agency_id
      ? supabase
          .from("agencies")
          .select("id, name, acronym")
          .eq("id", agency.parent_agency_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("agencies")
      .select("id, name, acronym")
      .eq("parent_agency_id", agency.id)
      .eq("is_active", true)
      .order("name")
      .limit(30),
  ]);

  const parentAgency = parentRes.data as { id: string; name: string; acronym: string | null } | null;
  const childAgencies = (childrenRes.data ?? []) as { id: string; name: string; acronym: string | null }[];

  const typeColor = AGENCY_TYPE_COLORS[agency.agency_type] ?? AGENCY_TYPE_COLORS["other"]!;
  const typeLabel = AGENCY_TYPE_LABELS[agency.agency_type] ?? "Agency";
  const displayAcronym = agency.acronym ?? agency.short_name ?? agency.name.slice(0, 5).toUpperCase();
  const agencyMeta = (agency.metadata ?? {}) as Record<string, string | null>;
  const twitterHandle = agencyMeta["twitter_handle"] ?? null;
  const youtubeHandle = agencyMeta["youtube_handle"] ?? null;
  const facebookUrl   = agencyMeta["facebook_url"]   ?? null;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* FIX-398: attribution payload embedded for the FIX-399 SourceBadge
          hydration hook. Not visually rendered. */}
      <script
        type="application/json"
        data-civitics-attribution="agency"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(agencyAttribution) }}
      />
      <PageViewTracker entityType="agency" entityId={slug} />
      {/* Top bar */}
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

        {/* ── 1. HEADER ────────────────────────────────────────────────────── */}
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <div className="flex items-start gap-5">
            {/* Seal placeholder */}
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
                  attribution={agencyAttribution}
                >
                  <SourceBadge attribution={agencyAttribution} />
                </SourceDetailPopover>
              </div>
              <h1 className="mt-1 text-2xl font-bold text-gray-900 leading-tight">
                {agency.name}
              </h1>
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

        {/* ── 2. QUICK STATS BAR ────────────────────────────────────────────── */}
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
            value={agency.personnel_fte ? `~${(agency.personnel_fte as number).toLocaleString()}` : "—"}
            label="Personnel (FTE)"
          />
          <StatBox value="—" label="Promises tracked" note="Phase 2" />
        </div>

        {/* ── HIERARCHY TREE ───────────────────────────────────────────────── */}
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

            {/* ── 4. ACTIVE RULEMAKING ─────────────────────────────────────── */}
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

            {/* ── 5. RECENT RULES (CLOSED) ─────────────────────────────────── */}
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

            {/* ── 6. SPENDING ──────────────────────────────────────────────── */}
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

          {/* ── RIGHT COLUMN ─────────────────────────────────────────────────── */}
          <div className="flex flex-col gap-6">

            {/* ── 3. LEADERSHIP ─────────────────────────────────────────────── */}
            <section>
              <SectionHeader title="Leadership" />
              {officials.length === 0 ? (
                <div className="rounded-lg border border-gray-200 bg-white px-4 py-5">
                  <p className="text-sm text-gray-400">No leadership data on record yet.</p>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {/* Agency Head: current + strength >= 0.9 */}
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
                  {/* Senior Leadership: current + strength < 0.9 */}
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
                  {/* Past: all non-current, capped at 5 */}
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

            {/* Comment banner */}
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

        {/* ── 8. CONNECTION GRAPH ──────────────────────────────────────────── */}
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
  // Stale if current, sourced from PLUM, and last OPM update was >60 days ago
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
