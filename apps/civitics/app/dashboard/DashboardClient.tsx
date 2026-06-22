"use client";

import { useState, useEffect } from "react";
import {
  Users, ScrollText, Vote, DollarSign,
  RefreshCw, Lightbulb, Eye, Rocket, CircleCheck, CircleX,
  Megaphone,
} from "lucide-react";
import {
  StatCard,
  StatsRow,
  SectionCard,
  SectionHeader,
  EmptyState,
  CommentPeriodCard,
  DataQualityBar,
  ConnectionHighlight,
  ActivityItem,
  AlertBanner,
  StatusBadge,
  formatRelativeTime,
  formatNumber,
} from "@civitics/ui";
import {
  useDashboardData,
  isPartial,
  type AiCosts,
  type PipelineHistoryRun,
  type ActivitySectionData,
  type OfficialsBreakdown,
  type DatabaseStats,
  type StatusData,
} from "./useDashboardData";
import dynamic from "next/dynamic";

const AnthropicCard = dynamic(
  () => import("./components/AnthropicCard").then((m) => ({ default: m.AnthropicCard })),
  { ssr: false },
);

const PlatformCostsSection = dynamic(
  () => import("./PlatformCostsSection").then((m) => ({ default: m.PlatformCostsSection })),
  { ssr: false },
);

// ── Types ─────────────────────────────────────────────────────────────────────

type OpenProposal = {
  id: string;
  title: string;
  agency: string;
  comment_period_end: string;
};

type ActivityRow = { path: string; views: number };

interface DashboardClientProps {
  openProposals: OpenProposal[];
  openProposalCount: number;
  tab: "transparency" | "operations";
  initialStatus: StatusData | null;
}

// ── Pipeline display name mapping ────────────────────────────────────────────

// `cadence` drives per-pipeline freshness thresholds (see freshnessFor()
// below). Without it, every pipeline was scored against a single 48h ok /
// 168h warning threshold, which flagged TIGER (annual) as red after 7 days,
// hid actually-stale daily pipelines, and disagreed with /admin/pipeline-
// health. Values picked from .github/workflows/*.yml + a prod audit query
// against data_sync_log (see scripts/pipeline-cadence-audit.ts).
type Cadence =
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly"
  | "quarterly"
  | "annual"
  | "on_demand"   // no expected schedule; healthy as long as any run exists
  | "continuous"; // background queue; freshness reads activity, not last_run

const SLOW_CADENCES: ReadonlySet<Cadence> = new Set([
  "weekly",
  "monthly",
  "quarterly",
  "annual",
  "on_demand",
]);

// One row on the Data Health card. `aliases` holds every writer-side name that
// should be merged into this row's history — used when one display row covers
// multiple sub-pipelines (e.g. Congress = officials + votes + committees).
// The list of writers is the audit ground truth from `grep startSync`.
type PipelineDef = {
  key: string; // canonical key (used as React key + display name fallback)
  display: string; // user-facing label
  aliases: string[]; // writer-side `pipeline` strings that map to this row
  cadence: Cadence; // expected schedule, drives freshness thresholds
  dbTotals?: (db: DatabaseStats) => Array<{ value: number; label: string }>;
  source?: { label: string; href: string };
  retryCmd?: string;
  note?: string; // optional caveat shown in the expansion (e.g. "no log writer yet")
};

const PIPELINES: PipelineDef[] = [
  {
    key: "congress",
    display: "Congress.gov",
    aliases: ["congress", "congress_officials", "congress_votes"],
    cadence: "daily",
    dbTotals: (db) => [
      { value: db.officials, label: "officials" },
      { value: db.proposals_bills, label: "bills + resolutions" },
    ],
    source: { label: "Congress.gov", href: "https://congress.gov" },
    retryCmd: "pnpm data:officials  /  data:votes",
  },
  {
    // Split out of the Congress.gov row (was an alias under cadence: "daily")
    // because committees run weekly via the Sunday-only orchestrator block
    // — bundling them under daily made the row read false-red every weekday.
    key: "congress_committees",
    display: "Congress Committees",
    aliases: ["congress_committees"],
    cadence: "weekly",
    source: { label: "Congress.gov", href: "https://congress.gov" },
    retryCmd: "pnpm data:committees",
  },
  {
    key: "regulations",
    display: "Regulations.gov",
    aliases: ["regulations", "federal_register"],
    cadence: "daily",
    dbTotals: (db) => [
      { value: db.proposals_regulations, label: "regulations" },
    ],
    source: { label: "Regulations.gov", href: "https://regulations.gov" },
    retryCmd: "pnpm data:regulations",
  },
  {
    key: "fec_bulk",
    display: "FEC / Donors",
    aliases: ["fec_bulk", "fec"],
    cadence: "weekly",
    dbTotals: (db) => [
      { value: db.financial_entities, label: "donors / PACs" },
      { value: db.financial_relationships, label: "donations" },
    ],
    source: { label: "FEC.gov", href: "https://www.fec.gov" },
    retryCmd: "pnpm data:fec-bulk",
  },
  {
    key: "usaspending",
    // FIX-249 deprecated the legacy `usaspending` (API path) alias — bulk is
    // the live writer. Audit shows bulk + assistance run on the Sunday block.
    display: "USAspending",
    aliases: ["usaspending_bulk", "usaspending_bulk_assistance"],
    cadence: "weekly",
    dbTotals: (db) => [
      { value: db.financial_relationships, label: "spending records (shared)" },
    ],
    source: { label: "USAspending.gov", href: "https://usaspending.gov" },
    retryCmd: "pnpm data:usaspending-bulk",
  },
  {
    key: "openstates",
    display: "OpenStates",
    // `openstates_bulk_people` runs daily; `openstates` (v3 API for term
    // dates + bills) runs weekly in the Sunday block. Weekly is the row's
    // cadence — daily satisfies, weekly stale on the API side is what
    // worst-status propagation surfaces.
    aliases: ["openstates", "openstates_bulk_people"],
    cadence: "weekly",
    source: { label: "OpenStates.org", href: "https://openstates.org" },
    retryCmd: "pnpm data:states  /  data:states-api",
  },
  {
    key: "courtlistener",
    display: "CourtListener",
    aliases: ["courtlistener"],
    // packages/data/CLAUDE.md: "weekly via nightly orchestrator (Sunday-only
    // block)". Audit confirms ~5d gap between runs.
    cadence: "weekly",
    source: { label: "CourtListener", href: "https://www.courtlistener.com" },
    retryCmd: "pnpm data:courts",
  },
  {
    key: "elections",
    display: "Elections",
    aliases: ["elections"],
    cadence: "annual",
    retryCmd: "pnpm data:elections",
  },
  {
    key: "opensecrets",
    display: "OpenSecrets",
    aliases: ["opensecrets_bulk"],
    cadence: "monthly",
    retryCmd: "pnpm data:opensecrets-bulk",
  },
  {
    key: "govtrack",
    display: "GovTrack Cosponsors",
    aliases: ["govtrack_cosponsors"],
    cadence: "weekly",
    retryCmd: "pnpm data:govtrack-cosponsors",
  },
  {
    key: "legistar",
    display: "Legistar (local)",
    aliases: ["legistar"],
    // packages/data/CLAUDE.md: "Manual only" — not on the orchestrator.
    cadence: "on_demand",
    retryCmd: "pnpm data:legistar",
  },
  {
    key: "agencies",
    display: "Agencies (hierarchy)",
    aliases: ["agencies_hierarchy"],
    cadence: "quarterly",
    retryCmd: "pnpm data:agencies",
  },
  {
    key: "agency_leadership",
    display: "Agency Leadership",
    aliases: ["agency_leadership"],
    // packages/data/CLAUDE.md: Sunday block of nightly. Audit shows ~weekly
    // cadence in prod; the "federal directory rarely changes" assumption is
    // about content churn, not run frequency.
    cadence: "weekly",
    retryCmd: "pnpm data:agency-leadership",
  },
  {
    key: "agency_enrichment",
    display: "Agency Enrichment",
    aliases: ["agency_enrichment"],
    // First Sunday of month per packages/data/CLAUDE.md ("Monthly").
    cadence: "monthly",
    retryCmd: "pnpm data:agency-enrichment",
  },
  {
    key: "opm_fte",
    display: "OPM FTE",
    aliases: ["opm_fte"],
    cadence: "weekly",
    retryCmd: "pnpm data:opm-fte",
  },
  {
    key: "plum_book",
    display: "PLUM Book",
    aliases: ["plum_book"],
    cadence: "weekly",
    retryCmd: "pnpm data:plum-book",
  },
  {
    key: "irs990",
    display: "IRS 990 (nonprofits)",
    aliases: ["irs990"],
    // packages/data/CLAUDE.md: weekly Sunday after FEC bulk. HEAD-watermark
    // short-circuits cheaply when IRS bulk hasn't changed, but the pipeline
    // still records a run each Sunday.
    cadence: "weekly",
    source: { label: "IRS 990 Bulk", href: "https://apps.irs.gov/pub/epostcard/990/xml/" },
    retryCmd: "pnpm data:irs990",
  },
  {
    key: "littlesis",
    display: "LittleSis",
    aliases: ["littlesis"],
    cadence: "weekly",
    source: { label: "LittleSis", href: "https://littlesis.org" },
    retryCmd: "pnpm data:littlesis",
  },
  {
    key: "edgar",
    display: "SEC EDGAR (weekly)",
    aliases: ["edgar"],
    // Weekly full reconciliation of the S&P 500 universe (FIX-253).
    cadence: "weekly",
    source: { label: "SEC EDGAR", href: "https://www.sec.gov/edgar" },
    retryCmd: "pnpm data:edgar",
  },
  {
    key: "edgar_daily",
    display: "SEC EDGAR (daily)",
    aliases: ["edgar_daily"],
    // Daily SC 13D/13G scan over tracked CIKs. `status: skipped` on quiet
    // days is normal — no new filings doesn't constitute failure.
    cadence: "daily",
    source: { label: "SEC EDGAR", href: "https://www.sec.gov/edgar" },
    retryCmd: "pnpm data:edgar:daily",
  },
  {
    key: "districts",
    display: "TIGER Districts",
    aliases: ["tiger_districts"],
    // Census TIGER/Line ships annually. Manual reruns happen but don't
    // change the underlying cadence designation.
    cadence: "annual",
    retryCmd: "pnpm data:districts",
  },
  {
    key: "ai_summaries",
    display: "AI Summaries",
    aliases: ["ai_summaries"],
    // Background work lives in enrichment_queue, drained by subagent
    // sessions (see docs/done.log). The pipeline name rarely writes
    // to data_sync_log itself, so `continuous` would always show red.
    // `on_demand` treats "any run logged" as healthy.
    cadence: "on_demand",
    dbTotals: (db) => [
      { value: db.ai_summary_cache, label: "summaries cached" },
    ],
    retryCmd: "pnpm data:ai-summaries",
  },
  {
    key: "tag_ai",
    display: "AI Tagger",
    aliases: ["tag_ai"],
    // Same shape as ai_summaries — drained via subagent queue. See
    // `ai_summaries` for rationale.
    cadence: "on_demand",
    dbTotals: (db) => [
      { value: db.entity_tags, label: "entity_tags rows (all categories)" },
    ],
    retryCmd: "pnpm data:tag-ai",
  },
  {
    key: "tag_rules",
    display: "Rule Tagger",
    aliases: ["tag_rules"],
    cadence: "continuous",
    retryCmd: "pnpm data:tag-rules",
  },
  {
    key: "entity_connections_rebuild",
    display: "Connections (derived)",
    aliases: ["entity_connections_rebuild"],
    // rebuild-entity-connections.yml runs Sun + Wed 08:00 UTC ≈ 3-4 day
    // cadence. `weekly` thresholds (8d ok / 15d warn) absorb both legs.
    cadence: "weekly",
    dbTotals: (db) => [
      { value: db.entity_connections, label: "edges" },
    ],
    retryCmd:
      "pnpm --filter @civitics/data data:nightly  (runs rebuild_entity_connections())",
  },
];

const PIPELINE_STATUS_COLOR: Record<string, string> = {
  complete: "bg-green-500",
  running: "bg-blue-500",
  interrupted: "bg-amber-500",
  failed: "bg-red-500",
  pending: "bg-gray-300",
};

// Lookup: writer-side alias → canonical PipelineDef (used to bucket history
// rows whose `pipeline` string matches any alias).
const ALIAS_TO_DEF: Record<string, PipelineDef> = (() => {
  const map: Record<string, PipelineDef> = {};
  for (const def of PIPELINES) for (const a of def.aliases) map[a] = def;
  return map;
})();

// ── Self-test display labels ──────────────────────────────────────────────────

const SELF_TEST_LABELS: Record<string, string> = {
  entity_search_finds_warren: "Entity search working",
  chord_has_industry_data: "Chord diagram has data",
  warren_has_vote_connections: "Vote connections healthy",
  ai_budget_ok: "AI budget OK",
  nightly_ran_today: "Nightly sync ran today",
  connections_pipeline_healthy: "Connections pipeline healthy",
};

// ── Phase / task data (FIX 4) ────────────────────────────────────────────────

const PHASES_FALLBACK = [
  { name: "Phase 0", label: "Foundation", pct: 100, done: true },
  { name: "Phase 1", label: "Civic Core", pct: 88, done: false },
  { name: "Phase 2", label: "Community", pct: 0, done: false },
  { name: "Phase 3", label: "Economy", pct: 0, done: false },
  { name: "Phase 4", label: "Blockchain", pct: 0, done: false },
  { name: "Phase 5", label: "Candidates", pct: 0, done: false },
];

const PHASE1_TASKS: Array<{ label: string; done: boolean }> = [
  { label: "Entity connections pipeline", done: true },
  { label: "AI cost management system", done: true },
  { label: "Entity tagging system", done: true },
  { label: "Plain language summaries", done: true },
  { label: "Graph visualization studio (Force, Chord, Treemap, Sunburst, Comparison)", done: true },
  { label: "Nightly auto-sync pipeline", done: true },
  { label: "Vote categorization", done: true },
  { label: "Nomination vote tracking", done: true },
  { label: "Claude diagnostic API", done: true },
  { label: "packages/ui component library", done: true },
  { label: "Dashboard redesign", done: true },
  { label: "Search across all entities", done: false },
  { label: "Basic credit system", done: false },
  { label: "'What does this mean for me'", done: false },
  { label: "User auth via Supabase", done: false },
  { label: "Community commenting", done: false },
  { label: "Position tracking", done: false },
  { label: "Follow officials/agencies", done: false },
];

// ── Pipeline freshness helper ────────────────────────────────────────────────

// Thresholds are expressed in hours. Each tier roughly maps to "one expected
// cycle" (ok), "missed one cycle" (warning), "missed multiple" (error).
function freshnessFor(
  cadence: Cadence,
  completedAt: string | null | undefined,
): "ok" | "warning" | "error" {
  if (!completedAt) {
    // On-demand pipelines that never logged are a soft warning — no expected
    // schedule means we can't call it broken. Everything else is error.
    return cadence === "on_demand" ? "warning" : "error";
  }
  const ageH = (Date.now() - new Date(completedAt).getTime()) / 3_600_000;
  switch (cadence) {
    case "hourly":     return ageH < 2     ? "ok" : ageH < 6     ? "warning" : "error";
    case "daily":      return ageH < 48    ? "ok" : ageH < 96    ? "warning" : "error";
    case "weekly":     return ageH < 192   ? "ok" : ageH < 360   ? "warning" : "error"; // 8d / 15d
    case "monthly":    return ageH < 840   ? "ok" : ageH < 1560  ? "warning" : "error"; // 35d / 65d
    case "quarterly":  return ageH < 2400  ? "ok" : ageH < 3120  ? "warning" : "error"; // 100d / 130d
    case "annual":     return ageH < 9600  ? "ok" : ageH < 12000 ? "warning" : "error"; // 400d / 500d
    case "on_demand":  return "ok"; // any run is fine, indefinite
    case "continuous": return ageH < 24    ? "ok" : ageH < 72    ? "warning" : "error";
  }
}

// ── Activity path → display name ─────────────────────────────────────────────

function pathIcon(path: string): string {
  if (path.startsWith("/officials")) return "👤";
  if (path.startsWith("/proposals")) return "📋";
  if (path.startsWith("/agencies")) return "🏛";
  if (path.startsWith("/graph")) return "🔗";
  return "📄";
}

function pathLabel(path: string): string {
  if (path === "/graph") return "Connection Graph";
  if (path.startsWith("/officials/")) return "Official profile";
  if (path.startsWith("/proposals/")) return "Proposal";
  if (path.startsWith("/agencies/")) return "Agency";
  return path;
}

// (Platform cost helpers moved to PlatformCostsSection.tsx)

// ── Sections ─────────────────────────────────────────────────────────────────

function StatsSection({
  database,
  officialsBreakdown,
  openProposalCount,
  chordTotalFlowUsd,
}: {
  database: NonNullable<ReturnType<typeof useDashboardData>["data"]>["status"]["database"];
  officialsBreakdown: OfficialsBreakdown;
  openProposalCount: number;
  chordTotalFlowUsd: number;
}) {
  const db = isPartial(database) ? null : database;

  const officialsBreakdownLabel = officialsBreakdown
    ? `${formatNumber(officialsBreakdown.federal)} federal · ${formatNumber(officialsBreakdown.state)} state · ${formatNumber(officialsBreakdown.judges)} judges`
    : "Federal, state & judicial officials";

  return (
    <StatsRow>
      <StatCard
        icon={<Users size={16} />}
        label="Officials"
        value={db?.officials ?? 0}
        formatAs="number"
        href="/officials"
        sublabel={officialsBreakdownLabel}
        loading={!db}
      />
      <StatCard
        icon={<ScrollText size={16} />}
        label="Open Proposals"
        value={openProposalCount}
        formatAs="number"
        href="/proposals?status=open"
        sublabel={
          db
            ? `of ${formatNumber(db.proposals)} total federal regulations`
            : "Federal regulations open for comment"
        }
        loading={!db}
      />
      <StatCard
        icon={<Vote size={16} />}
        label="Votes"
        value={db?.votes ?? 0}
        formatAs="number"
        href="/graph"
        sublabel="Congressional votes tracked"
        loading={!db}
      />
      <StatCard
        icon={<DollarSign size={16} />}
        label="Donation Flow"
        value={chordTotalFlowUsd * 100}
        formatAs="usd"
        href="/graph?preset=follow-the-money"
        sublabel="FEC-tracked PAC and individual contributions"
        loading={!db}
      />
    </StatsRow>
  );
}

function CommentPeriodsSection({ openProposals }: { openProposals: OpenProposal[] }) {
  return (
    <SectionCard>
      <SectionHeader
        icon={<Megaphone size={16} />}
        title="Open Comment Periods"
        description="Your voice is public record"
        action={
          openProposals.length > 0
            ? { label: "View all", href: "/proposals?status=open" }
            : undefined
        }
      />
      <div className="mt-4">
        {openProposals.length === 0 ? (
          <EmptyState
            title="No comment periods currently open"
            description="Check back soon — federal agencies regularly open rules for public input."
            action={{ label: "View all proposals", href: "/proposals" }}
          />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {openProposals.map((p) => (
                <CommentPeriodCard
                  key={p.id}
                  id={p.id}
                  title={p.title}
                  agency={p.agency}
                  deadline={p.comment_period_end}
                  href={`/proposals/${p.id}`}
                />
              ))}
            </div>
            <p className="mt-4 text-xs text-gray-500">
              Submitting a comment is free and always will be.{" "}
              <a href="/proposals?status=open" className="text-blue-600 hover:underline">
                View all open proposals →
              </a>
            </p>
          </>
        )}
      </div>
    </SectionCard>
  );
}

// 7-day status indicator: oldest run on the left, newest on the right.
// Empty squares for pipelines with fewer than 7 logged runs so the visual
// width stays constant — operators can see "no rhythm" pipelines instantly.
function StatusSparkline({ runs }: { runs: PipelineHistoryRun[] }) {
  const ordered = [...runs].reverse();
  const padded: Array<PipelineHistoryRun | null> = [
    ...Array<null>(Math.max(0, 7 - ordered.length)).fill(null),
    ...ordered,
  ].slice(-7);
  return (
    <div className="flex items-center gap-1">
      {padded.map((run, i) => (
        <span
          key={i}
          suppressHydrationWarning
          title={
            run
              ? `${run.status} · ${run.completed_at ? formatRelativeTime(run.completed_at) : "—"} · +${formatNumber(run.rows_inserted ?? 0)}`
              : "no run"
          }
          className={`block h-3 w-3 rounded-sm ${
            run ? PIPELINE_STATUS_COLOR[run.status] ?? "bg-gray-300" : "bg-gray-100"
          }`}
        />
      ))}
    </div>
  );
}

function HealthMetricTile({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "ok" | "warning" | "error" | "neutral";
}) {
  const toneCls =
    tone === "ok"
      ? "text-green-700"
      : tone === "warning"
      ? "text-amber-700"
      : tone === "error"
      ? "text-red-700"
      : "text-gray-900";
  return (
    <div className="flex-1 min-w-[140px] rounded-lg border border-gray-100 bg-gray-50/60 px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`mt-1 text-lg font-semibold tabular-nums ${toneCls}`}>{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-0.5">{sub}</div>}
    </div>
  );
}

type RowStatus = "complete" | "running" | "interrupted" | "failed" | "pending";

type AliasState = {
  alias: string;
  latest: PipelineHistoryRun | null;
  freshness: "ok" | "warning" | "error";
};

type RowVerdict = {
  rowStatus: RowStatus;
  worstFreshness: "ok" | "warning" | "error";
  aliasStates: AliasState[];
  worstAlias: string | null;
};

// One verdict per registered PIPELINES row. Worst-status across the def's
// aliases drives the badge — the Congress.gov row reads red when *any* of
// congress_officials / congress_votes / congress_committees / congress is
// stale or failing, instead of going green because one alias completed.
function computeRowVerdict(
  cadence: Cadence,
  perAlias: Record<string, PipelineHistoryRun[]>,
  aliases: string[],
): RowVerdict {
  const aliasStates: AliasState[] = aliases.map((a) => {
    const latest = perAlias[a]?.[0] ?? null;
    return {
      alias: a,
      latest,
      freshness: freshnessFor(cadence, latest?.completed_at),
    };
  });

  // failed > stale-error > stale-warning > complete > pending
  const rank = (s: AliasState): number => {
    if (s.latest?.status === "failed") return 5;
    if (s.freshness === "error") return 4;
    if (s.freshness === "warning") return 3;
    if (s.latest && s.latest.status === "complete") return 2;
    return 1;
  };

  const worst =
    aliasStates.length > 0
      ? aliasStates.reduce((a, b) => (rank(b) > rank(a) ? b : a))
      : null;

  let rowStatus: RowStatus;
  if (!worst || !worst.latest) {
    rowStatus = "pending";
  } else if (worst.latest.status === "failed") {
    rowStatus = "failed";
  } else if (worst.freshness === "error") {
    rowStatus = "failed";
  } else if (worst.freshness === "warning") {
    rowStatus = "interrupted";
  } else {
    rowStatus = (worst.latest.status as RowStatus) ?? "pending";
  }

  return {
    rowStatus,
    worstFreshness: worst?.freshness ?? "error",
    aliasStates,
    worstAlias: worst?.alias ?? null,
  };
}

function DataHealthRow({
  def,
  history,
  perAlias,
  verdict,
  database,
  quality,
}: {
  def: PipelineDef;
  history: PipelineHistoryRun[];
  perAlias: Record<string, PipelineHistoryRun[]>;
  verdict: RowVerdict;
  database:
    | NonNullable<ReturnType<typeof useDashboardData>["data"]>["status"]["database"]
    | null;
  quality:
    | NonNullable<ReturnType<typeof useDashboardData>["data"]>["status"]["quality"]
    | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const latest = history[0] ?? null;
  const prior = history[1] ?? null;

  const { rowStatus, worstFreshness, aliasStates, worstAlias } = verdict;

  const dbResolved = database && !isPartial(database) ? database : null;
  const totals = dbResolved && def.dbTotals ? def.dbTotals(dbResolved) : [];
  const primaryTotal = totals[0] ?? null;
  const lastInserted = latest?.rows_inserted ?? 0;
  const delta = lastInserted - (prior?.rows_inserted ?? 0);

  const lastFailed = history.find((r) => r.status === "failed" && r.error_message);
  const q = quality && !isPartial(quality) ? quality : null;

  // FIX-390: non-fatal seed warnings (FIX-386 plumbing) ride on a run's
  // metadata.seed_warnings (e.g. the jurisdictions_seed row). Surface them as a
  // yellow sub-status — green-with-warnings, never escalated to red, so they
  // don't touch rowStatus. Read from the most recent run that carries any.
  const seedWarnings: string[] = (() => {
    const runWith = history.find((r) => {
      const w = (r.metadata as { seed_warnings?: unknown } | null | undefined)
        ?.seed_warnings;
      return Array.isArray(w) && w.length > 0;
    });
    const raw = (runWith?.metadata as { seed_warnings?: unknown[] } | undefined)
      ?.seed_warnings;
    return Array.isArray(raw)
      ? raw.filter((w): w is string => typeof w === "string")
      : [];
  })();

  // Right-column timestamp label. For slow cadences we prefix "Current · " on
  // healthy rows so a 16-day-old TIGER doesn't look stale next to a fresh
  // daily pipeline. on_demand with no run reads "Loaded never" to distinguish
  // an unloaded one-shot pipeline from a broken scheduled one.
  let timestampLabel: string;
  if (!latest?.completed_at) {
    timestampLabel = def.cadence === "on_demand" ? "Loaded never" : "never";
  } else if (worstFreshness === "ok" && SLOW_CADENCES.has(def.cadence)) {
    timestampLabel = `Current · ${formatRelativeTime(latest.completed_at)}`;
  } else {
    timestampLabel = formatRelativeTime(latest.completed_at);
  }

  return (
    <div className="border-t border-gray-100 first:border-t-0">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="w-full flex items-center gap-3 px-6 py-3 hover:bg-gray-50 transition-colors text-left"
      >
        <span className="text-gray-400 text-xs w-3 shrink-0">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="flex-1 min-w-0 flex items-center gap-3">
          <span className="text-sm font-medium text-gray-900 truncate w-40 shrink-0">
            {def.display}
          </span>
          {/* Total entities — the primary fact for this row. Show the first
              total from the def's dbTotals(); secondary totals (e.g. donors
              count under FEC) appear in the expanded panel. */}
          {primaryTotal ? (
            <span className="tabular-nums w-52 shrink-0">
              <span className="text-sm font-semibold text-gray-900">
                {formatNumber(primaryTotal.value)}
              </span>{" "}
              <span className="text-xs text-gray-500">{primaryTotal.label}</span>
            </span>
          ) : (
            <span className="text-xs text-gray-400 w-52 shrink-0">no DB mapping</span>
          )}
          <span
            className={`text-xs tabular-nums w-20 shrink-0 ${
              delta > 0 ? "text-green-700" : delta < 0 ? "text-rose-700" : "text-gray-400"
            }`}
            title="Δ rows_inserted vs prior run"
          >
            {latest
              ? `${delta >= 0 ? "+" : ""}${formatNumber(delta)} Δ`
              : ""}
          </span>
          <StatusSparkline runs={history} />
        </span>
        {seedWarnings.length > 0 && (
          <span
            className="text-[11px] font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 shrink-0"
            title={seedWarnings.join("\n")}
          >
            ⚠ {seedWarnings.length} warning{seedWarnings.length === 1 ? "" : "s"}
          </span>
        )}
        <StatusBadge status={rowStatus} size="sm" />
        <span className="text-xs text-gray-400 w-28 text-right shrink-0" suppressHydrationWarning>
          {timestampLabel}
        </span>
      </button>

      {expanded && (
        <div className="bg-gray-50/60 border-t border-gray-100 px-6 py-4 space-y-4">
          {/* Author note (e.g. "no startSync writer yet") if present */}
          {def.note && (
            <div className="rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs text-amber-900">
              {def.note}
            </div>
          )}

          {/* FIX-390: non-fatal seed warnings (metadata.seed_warnings, FIX-386).
              Green-with-warnings — listed here, not folded into the row status. */}
          {seedWarnings.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs text-amber-900">
              <div className="font-medium mb-1">
                Seed warnings ({seedWarnings.length}) — non-fatal
              </div>
              <ul className="list-disc list-inside space-y-0.5">
                {seedWarnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Secondary DB totals (3+ wide grid; primary already shown above) */}
          {totals.length > 1 && (
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {totals.slice(1).map((t) => (
                <div key={t.label} className="text-xs text-gray-600">
                  <span className="font-semibold text-gray-900 tabular-nums">
                    {formatNumber(t.value)}
                  </span>{" "}
                  <span className="text-gray-500">{t.label}</span>
                </div>
              ))}
            </div>
          )}

          {/* Coverage bars relevant to this pipeline */}
          {def.key === "congress" && q && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <DataQualityBar
                label="FEC ID coverage"
                pct={q.fec_coverage.pct}
                value={q.fec_coverage.has_fec}
                total={q.fec_coverage.total}
                color="green"
              />
              <div className="text-xs text-gray-600 self-end">
                Missing state metadata:{" "}
                <span className="font-medium tabular-nums">
                  {formatNumber(q.missing_state)}
                </span>{" "}
                congress members
              </div>
            </div>
          )}
          {def.key === "fec_bulk" && q && (
            <DataQualityBar
              label="Industry tags on PACs"
              pct={q.industry_tags.pct}
              value={q.industry_tags.tagged}
              total={q.industry_tags.total}
              color="blue"
            />
          )}
          {def.key === "ai_summaries" && dbResolved && (
            <DataQualityBar
              label="AI summaries cached"
              pct={
                dbResolved.proposals > 0
                  ? Math.round((dbResolved.ai_summary_cache / dbResolved.proposals) * 1000) / 10
                  : 0
              }
              value={dbResolved.ai_summary_cache}
              total={dbResolved.proposals}
              color="amber"
            />
          )}

          {/* Per-alias sub-pipeline breakdown (multi-alias defs only). The
              alias that drove the row's worst-status verdict is marked
              ← propagating so the operator can see which writer is dragging
              the rollup down. */}
          {def.aliases.length > 1 && (
            <div>
              <div className="text-xs font-medium text-gray-700 mb-1.5">
                Sub-pipelines ({def.aliases.length}):
              </div>
              <div className="overflow-hidden rounded-md border border-gray-100 bg-white">
                <table className="w-full text-xs">
                  <tbody className="divide-y divide-gray-100">
                    {aliasStates.map((s) => {
                      const propagating =
                        s.alias === worstAlias && aliasStates.length > 1;
                      const subStatus: RowStatus = !s.latest
                        ? "pending"
                        : s.latest.status === "failed"
                        ? "failed"
                        : s.freshness === "error"
                        ? "failed"
                        : s.freshness === "warning"
                        ? "interrupted"
                        : ((s.latest.status as RowStatus) ?? "pending");
                      return (
                        <tr key={s.alias}>
                          <td className="px-3 py-1.5 font-mono text-[11px] text-gray-700">
                            {s.alias}
                          </td>
                          <td className="px-3 py-1.5">
                            <StatusBadge status={subStatus} size="sm" />
                          </td>
                          <td className="px-3 py-1.5 text-gray-500 tabular-nums" suppressHydrationWarning>
                            {s.latest?.completed_at
                              ? formatRelativeTime(s.latest.completed_at)
                              : "(no runs in window)"}
                          </td>
                          <td className="px-3 py-1.5 text-amber-700 text-[11px]">
                            {propagating ? "← propagating" : ""}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Last 5 runs */}
          {history.length > 0 ? (
            <div>
              <div className="text-xs font-medium text-gray-700 mb-1.5">Recent runs</div>
              <div className="overflow-hidden rounded-md border border-gray-100">
                <table className="w-full text-xs">
                  <thead className="bg-gray-100 text-gray-600">
                    <tr>
                      <th className="text-left font-medium px-3 py-1.5">Started</th>
                      <th className="text-right font-medium px-3 py-1.5">Inserted</th>
                      <th className="text-right font-medium px-3 py-1.5">Updated</th>
                      <th className="text-right font-medium px-3 py-1.5">Failed</th>
                      <th className="text-right font-medium px-3 py-1.5">MB</th>
                      <th className="text-left font-medium px-3 py-1.5">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 bg-white">
                    {history.slice(0, 5).map((r, i) => (
                      <tr key={`${r.completed_at ?? r.started_at}-${i}`}>
                        <td className="px-3 py-1.5 text-gray-700" suppressHydrationWarning>
                          {r.started_at
                            ? new Date(r.started_at).toLocaleString("en-US", {
                                month: "short",
                                day: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                              })
                            : "—"}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">
                          {formatNumber(r.rows_inserted ?? 0)}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-gray-600">
                          {formatNumber(r.rows_updated ?? 0)}
                        </td>
                        <td
                          className={`px-3 py-1.5 text-right tabular-nums ${
                            (r.rows_failed ?? 0) > 0 ? "text-rose-700" : "text-gray-400"
                          }`}
                        >
                          {formatNumber(r.rows_failed ?? 0)}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">
                          {r.estimated_mb != null
                            ? Math.round(Number(r.estimated_mb) * 10) / 10
                            : "—"}
                        </td>
                        <td className="px-3 py-1.5">
                          <StatusBadge
                            status={
                              (r.status as
                                | "complete"
                                | "running"
                                | "interrupted"
                                | "failed"
                                | "pending") ?? "pending"
                            }
                            size="sm"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <p className="text-xs text-gray-500">
              No runs logged in <code>data_sync_log</code> for this pipeline.
            </p>
          )}

          {/* Most recent error */}
          {lastFailed?.error_message && (
            <div className="rounded-md border border-rose-200 bg-rose-50/60 px-3 py-2">
              <div className="text-xs font-medium text-rose-800 mb-0.5">
                Latest failure ·{" "}
                <span suppressHydrationWarning>
                  {lastFailed.completed_at
                    ? formatRelativeTime(lastFailed.completed_at)
                    : "unknown time"}
                </span>
              </div>
              <pre className="text-[11px] text-rose-900 whitespace-pre-wrap break-words font-mono">
                {lastFailed.error_message}
              </pre>
            </div>
          )}

          {/* Footer: source link + retry hint */}
          <div className="flex flex-wrap items-center gap-3 pt-1 text-xs text-gray-600">
            {def.source && (
              <a
                href={def.source.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center rounded-full border border-gray-200 bg-white px-2.5 py-0.5 font-medium hover:border-blue-300 hover:text-blue-700 transition-colors"
              >
                {def.source.label} ↗
              </a>
            )}
            {def.retryCmd && (
              <span className="font-mono text-[11px] text-gray-500">
                ↻ <code>{def.retryCmd}</code>
              </span>
            )}
            {def.aliases.length > 1 && (
              <span
                className="text-[11px] text-gray-400"
                title="data_sync_log writer-side names that get merged into this row"
              >
                aliases: {def.aliases.join(", ")}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DataHealthSection({
  pipelines,
  quality,
  database,
}: {
  pipelines: NonNullable<ReturnType<typeof useDashboardData>["data"]>["status"]["pipelines"];
  quality: NonNullable<ReturnType<typeof useDashboardData>["data"]>["status"]["quality"];
  database: NonNullable<ReturnType<typeof useDashboardData>["data"]>["status"]["database"];
}) {
  const [hoursUntilNext, setHoursUntilNext] = useState(0);

  useEffect(() => {
    function computeHours() {
      const now = new Date();
      const next2am = new Date(now);
      next2am.setUTCHours(2, 0, 0, 0);
      if (next2am <= now) next2am.setUTCDate(next2am.getUTCDate() + 1);
      setHoursUntilNext(Math.round((next2am.getTime() - now.getTime()) / 3_600_000));
    }
    computeHours();
    const interval = setInterval(computeHours, 60_000);
    return () => clearInterval(interval);
  }, []);

  if (isPartial(pipelines)) {
    return (
      <SectionCard>
        <SectionHeader icon={<RefreshCw size={16} />} title="Data Health" status="error" />
        <p className="mt-3 text-sm text-rose-600">{pipelines.error}</p>
      </SectionCard>
    );
  }

  // Build per-pipeline rows from the canonical PIPELINES registry. For each
  // def, gather every history row whose writer-side `pipeline` string matches
  // any of the def's aliases, then sort newest-first and trim to 7. This is
  // where pipeline-name normalization happens — writer-side inconsistencies
  // (hyphens vs underscores, sub-pipeline subkeys) collapse into one row.
  // `perAlias` preserves per-writer identity so the expanded panel and the
  // worst-status verdict can see each sub-pipeline separately.
  const historyMap = pipelines.history ?? {};
  type Row = {
    def: PipelineDef;
    history: PipelineHistoryRun[];
    perAlias: Record<string, PipelineHistoryRun[]>;
    verdict: RowVerdict;
  };
  const rows: Row[] = PIPELINES.map((def) => {
    const perAlias: Record<string, PipelineHistoryRun[]> = {};
    for (const a of def.aliases) perAlias[a] = historyMap[a] ?? [];

    const merged = def.aliases.flatMap((a) => historyMap[a] ?? []);
    merged.sort((a, b) => {
      const at = a.completed_at ? new Date(a.completed_at).getTime() : 0;
      const bt = b.completed_at ? new Date(b.completed_at).getTime() : 0;
      return bt - at;
    });

    return {
      def,
      history: merged.slice(0, 7),
      perAlias,
      verdict: computeRowVerdict(def.cadence, perAlias, def.aliases),
    };
  });

  // Append any unknown writer-side pipeline strings as orphan rows so they're
  // never silently dropped from the dashboard. If we see one of these in
  // production, it usually means a new pipeline shipped without a PIPELINES
  // entry (or a writer was renamed).
  const knownAliases = new Set(Object.keys(ALIAS_TO_DEF));
  for (const name of Object.keys(historyMap)) {
    if (!knownAliases.has(name)) {
      const orphanDef: PipelineDef = {
        key: name,
        display: `${name} (orphan)`,
        aliases: [name],
        // on_demand keeps unknown writers from being flagged red just because
        // their cadence is unknown — the orphan label itself is the signal.
        cadence: "on_demand",
        note:
          "This pipeline is logging to data_sync_log but isn't registered in PIPELINES. Add an entry to apps/civitics/app/dashboard/DashboardClient.tsx to give it a proper display name and DB total.",
      };
      const orphanHistory: PipelineHistoryRun[] = historyMap[name] ?? [];
      const orphanPerAlias: Record<string, PipelineHistoryRun[]> = {
        [name]: orphanHistory,
      };
      rows.push({
        def: orphanDef,
        history: orphanHistory,
        perAlias: orphanPerAlias,
        verdict: computeRowVerdict(orphanDef.cadence, orphanPerAlias, [name]),
      });
    }
  }

  // Health score: fraction of registered rows whose worst-status verdict is
  // both complete AND within the cadence's "ok" threshold. Uses the same
  // worst-status semantics as the row badge, so the header metric and the
  // per-row badges can't disagree.
  const registeredRows = rows.filter((r) => !r.def.display.endsWith("(orphan)"));
  const healthyCount = registeredRows.filter(
    (r) => r.verdict.rowStatus === "complete" && r.verdict.worstFreshness === "ok",
  ).length;
  const healthPct = registeredRows.length
    ? Math.round((healthyCount / registeredRows.length) * 100)
    : 0;
  const healthTone =
    healthPct >= 80 ? "ok" : healthPct >= 50 ? "warning" : "error";

  // Latest run anywhere (for header status)
  const latestAcrossAll = rows
    .map((r) => r.history[0])
    .filter((r): r is PipelineHistoryRun => !!r && !!r.completed_at)
    .sort(
      (a, b) =>
        new Date(b.completed_at!).getTime() - new Date(a.completed_at!).getTime(),
    )[0];

  // Cron summary
  const cron = pipelines.cron_last_run as Record<string, unknown> | null;
  const cronAt =
    (cron?.["completed_at"] as string | undefined) ??
    (cron?.["started_at"] as string | undefined) ??
    null;
  const cronDurationSec = cron?.["duration_seconds"] as number | undefined;
  const cronCost = cron?.["cost_usd"] as number | undefined;

  const backlog = pipelines.enrichment_backlog ?? {
    pending_tag: 0,
    pending_summary: 0,
    in_progress: 0,
  };
  const backlogTotal = backlog.pending_tag + backlog.pending_summary;
  const backlogTone =
    backlogTotal > 50_000 ? "warning" : backlogTotal > 0 ? "neutral" : "ok";

  return (
    <SectionCard noPadding>
      <div className="p-6 pb-4">
        <SectionHeader
          icon={<RefreshCw size={16} />}
          title="Data Health"
          status={healthTone === "ok" ? "ok" : healthTone === "warning" ? "warning" : "error"}
          description={
            latestAcrossAll ? (
              <>
                Last sync: <span suppressHydrationWarning>{formatRelativeTime(latestAcrossAll.completed_at!)}</span> · Next
                nightly in <span suppressHydrationWarning>{hoursUntilNext}</span>h
              </>
            ) : (
              "No recent runs found"
            )
          }
          action={{ label: "Runtime stats", href: "/admin/pipeline-health" }}
        />

        {/* Top strip */}
        <div className="mt-4 flex flex-wrap gap-2">
          <HealthMetricTile
            label="Pipeline health"
            value={`${healthyCount}/${registeredRows.length} fresh`}
            sub={`${healthPct}% complete and within cadence`}
            tone={healthTone}
          />
          <HealthMetricTile
            label="Enrichment backlog"
            value={
              <>
                {formatNumber(backlog.pending_tag)} <span className="text-gray-400 text-sm">tag</span> ·{" "}
                {formatNumber(backlog.pending_summary)} <span className="text-gray-400 text-sm">sum</span>
              </>
            }
            sub={
              backlog.in_progress > 0
                ? `${formatNumber(backlog.in_progress)} in progress`
                : "queue idle"
            }
            tone={backlogTone}
          />
          <HealthMetricTile
            label="Last nightly"
            value={
              <span suppressHydrationWarning>
                {cronAt
                  ? new Date(cronAt).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    }) +
                    " " +
                    new Date(cronAt).toLocaleTimeString("en-US", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : "—"}
              </span>
            }
            sub={
              cronAt ? (
                <>
                  {cronDurationSec != null
                    ? cronDurationSec < 60
                      ? `${cronDurationSec}s`
                      : `${Math.round(cronDurationSec / 60)}m`
                    : "—"}
                  {cronCost != null && ` · $${cronCost.toFixed(2)}`}
                </>
              ) : (
                "no cron_last_run recorded"
              )
            }
          />
        </div>
      </div>

      {/* Pipeline rows */}
      <div>
        {rows.map((r) => (
          <DataHealthRow
            key={r.def.key}
            def={r.def}
            history={r.history}
            perAlias={r.perAlias}
            verdict={r.verdict}
            database={database}
            quality={quality}
          />
        ))}
      </div>
    </SectionCard>
  );
}

function ConnectionHighlightsSection({
  chordFlows,
}: {
  chordFlows: NonNullable<ReturnType<typeof useDashboardData>["data"]>["chordFlows"];
}) {
  if (!chordFlows || chordFlows.length === 0) {
    return (
      <SectionCard>
        <SectionHeader
          icon={<Lightbulb size={16} />}
          title="Notable Connections"
          description="Top donation flows this cycle"
        />
        <div className="mt-4">
          <EmptyState
            title="Connection data loading"
            description="Chord diagram data will appear here once available."
          />
        </div>
      </SectionCard>
    );
  }

  const topFlows = chordFlows.slice(0, 5);

  return (
    <SectionCard>
      <SectionHeader
        icon={<Lightbulb size={16} />}
        title="Notable Connections"
        description="Top donation flows this cycle"
        action={{ label: "Explore graph", href: "/graph?preset=follow-the-money" }}
      />
      <div className="mt-3 divide-y divide-gray-100">
        {topFlows.map((flow, i) => (
          <ConnectionHighlight
            key={i}
            from={flow.from}
            to={flow.to}
            amountUsd={flow.amount_usd}
            graphHref={
              flow.from_id
                ? `/graph?preset=follow-the-money&industry=${flow.from_id}`
                : "/graph?preset=follow-the-money"
            }
          />
        ))}
      </div>
    </SectionCard>
  );
}

function ActivitySection({
  activity,
  totalViews,
  lookbackDays,
}: {
  activity: ActivityRow[];
  totalViews: number;
  lookbackDays: number;
}) {
  return (
    <SectionCard>
      <SectionHeader
        icon={<Eye size={16} />}
        title="Site Activity"
        description={`${formatNumber(totalViews)} human page views in the last ${lookbackDays} days`}
      />
      <div className="mt-3 divide-y divide-gray-100">
        {activity.length === 0 ? (
          <EmptyState title="No activity data" description="Page view data will appear here." />
        ) : (
          activity.map((row, i) => (
            <ActivityItem
              key={i}
              icon={pathIcon(row.path)}
              title={pathLabel(row.path)}
              subtitle={row.path}
              meta={`${formatNumber(row.views)} views`}
              href={row.path}
            />
          ))
        )}
      </div>
    </SectionCard>
  );
}

// PlatformCostsSection is now DB-driven — imported from ./PlatformCostsSection

type PhaseData = { name: string; label: string; pct: number; done: boolean };

function DevelopmentProgressSection() {
  const [phases, setPhases] = useState<PhaseData[]>(PHASES_FALLBACK);

  useEffect(() => {
    fetch("/api/phases")
      .then((r) => r.json())
      .then((d) => { if (d.phases?.length) setPhases(d.phases as PhaseData[]); })
      .catch(() => {/* keep fallback */});
  }, []);

  return (
    <SectionCard>
      <SectionHeader icon={<Rocket size={16} />} title="Development Progress" description="Phase 1 of 5" />
      <div className="mt-4 space-y-3">
        {phases.map((phase) => (
          <div key={phase.name}>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-sm font-medium text-gray-900">
                {phase.name} — {phase.label}
                {phase.done && <span className="ml-2 text-emerald-600">✓</span>}
              </span>
              <span className="tabular-nums text-sm text-gray-600">{phase.pct}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
              <div
                className={`h-full rounded-full transition-all duration-200 ${
                  phase.done ? "bg-emerald-500" : phase.pct > 0 ? "bg-blue-500" : "bg-gray-200"
                }`}
                style={{ width: `${phase.pct}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-6 border-t border-gray-100 pt-4">
        <p className="mb-2 text-xs font-semibold text-gray-700">Phase 1 Tasks</p>
        <ul className="space-y-1">
          {PHASE1_TASKS.map((task) => (
            <li key={task.label} className="flex items-start gap-2">
              <span
                className={`mt-0.5 shrink-0 text-xs ${
                  task.done ? "text-emerald-600" : "text-gray-400"
                }`}
              >
                {task.done ? "✓" : "○"}
              </span>
              <span
                className={`text-xs ${task.done ? "text-gray-700" : "text-gray-500"}`}
              >
                {task.label}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </SectionCard>
  );
}

// ── Platform Story (FIX 1: use chord total_flow_usd) ─────────────────────────

function PlatformStorySection({
  database,
  chordTotalFlowUsd,
}: {
  database: NonNullable<ReturnType<typeof useDashboardData>["data"]>["status"]["database"];
  chordTotalFlowUsd: number;
}) {
  const db = isPartial(database) ? null : database;

  function formatFlowUsd(n: number): string {
    if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(0)}M`;
    if (n > 0) return `$${formatNumber(n)}`;
    return null!;
  }

  const flowLabel = formatFlowUsd(chordTotalFlowUsd) ?? (db ? `${formatNumber(db.financial_relationships)} donor records` : null);

  return (
    <SectionCard>
      <SectionHeader title="What Civitics Tracks" />
      <div className="mt-4 space-y-2">
        {[
          flowLabel ? `${flowLabel} in donation flows` : "Donation flows tracked",
          db ? `${formatNumber(db.votes)} congressional votes` : "Congressional votes tracked",
          db ? `${formatNumber(db.proposals)} federal regulations` : "Federal regulations tracked",
          db ? `${formatNumber(db.officials)} officials across federal, state, and judiciary` : "Officials across all levels",
          db ? `${formatNumber(db.entity_connections)} mapped connections` : "Connections mapped",
        ].map((line, i) => (
          <p key={i} className="text-sm text-gray-700">
            {line}
          </p>
        ))}
      </div>
      <div className="mt-6 border-t border-gray-100 pt-4 space-y-1.5">
        <p className="text-xs text-gray-500">All data is public record.</p>
        <p className="text-xs text-gray-500">All source code is open.</p>
        <p className="text-xs text-gray-500">All civic actions are free.</p>
      </div>
      <div className="mt-4 flex flex-wrap gap-3">
        <a href="/proposals" className="text-sm font-medium text-blue-600 hover:underline">
          View data sources →
        </a>
        <a
          href="https://github.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-blue-600 hover:underline"
        >
          GitHub →
        </a>
      </div>
    </SectionCard>
  );
}

function SelfTestsSection({
  selfTests,
  aiCosts,
}: {
  selfTests: NonNullable<ReturnType<typeof useDashboardData>["data"]>["status"]["self_tests"];
  aiCosts: NonNullable<ReturnType<typeof useDashboardData>["data"]>["status"]["ai_costs"];
}) {
  if (isPartial(selfTests)) {
    return (
      <SectionCard>
        <SectionHeader icon={<CircleCheck size={16} />} title="System Self-Tests" />
        <p className="mt-3 text-sm text-rose-600">{selfTests.error}</p>
      </SectionCard>
    );
  }

  const costs = isPartial(aiCosts) ? null : aiCosts;
  const allPassed = selfTests.every((t) => t.passed);

  return (
    <SectionCard>
      <SectionHeader
        icon={<CircleCheck size={16} />}
        title="System Self-Tests"
        description="Run on every status check"
        status={allPassed ? "ok" : "error"}
      />
      <ul className="mt-4 space-y-2">
        {selfTests.map((test) => {
          const label = SELF_TEST_LABELS[test.name] ?? test.name.replace(/_/g, " ");
          const displayLabel =
            test.name === "ai_budget_ok" && costs
              ? `AI budget OK (${costs.budget_used_pct.toFixed(0)}% used)`
              : label;
          return (
            <li key={test.name} className="flex items-start gap-2">
              <span
                className={`shrink-0 mt-0.5 ${test.passed ? "text-emerald-600" : "text-rose-600"}`}
                title={test.detail}
              >
                {test.passed
                  ? <CircleCheck size={14} />
                  : <CircleX size={14} />}
              </span>
              <span
                className={`text-sm ${test.passed ? "text-gray-700" : "text-rose-700 font-medium"}`}
              >
                {displayLabel}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-4 text-xs text-gray-500">
        {allPassed ? "All systems operational" : "Issues detected — investigating"}
      </p>
    </SectionCard>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function DashboardClient({
  openProposals,
  openProposalCount,
  tab,
  initialStatus,
}: DashboardClientProps) {
  const { data, error, refresh } = useDashboardData(initialStatus);
  const [_secondsAgo] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  async function handleAdminRefresh() {
    setRefreshing(true);
    try {
      await fetch("/api/platform/anthropic", {
        method: "POST",
        headers: {
          // Must use dot notation — Next.js only inlines NEXT_PUBLIC_ with dot access
          "X-Admin-Key": process.env.NEXT_PUBLIC_ADMIN_KEY ?? "admin",
        },
      });
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    setMounted(true);
  }, []);

  const db = data && !isPartial(data.status.database) ? data.status.database : null;

  const officialsBreakdown: OfficialsBreakdown =
    data?.status.officials_breakdown && !isPartial(data.status.officials_breakdown)
      ? (data.status.officials_breakdown as OfficialsBreakdown)
      : null;

  const failedTests =
    data && !isPartial(data.status.self_tests)
      ? data.status.self_tests.filter((t) => !t.passed)
      : [];

  // FIX 1: chord total flow USD
  const chordSection =
    data?.status.chord && !isPartial(data.status.chord) ? data.status.chord : null;
  const chordTotalFlowUsd = chordSection?.total_flow_usd ?? 0;

  const activitySectionData: ActivitySectionData | null =
    data?.status.activity && !isPartial(data.status.activity)
      ? (data.status.activity as ActivitySectionData)
      : null;
  const topPages = activitySectionData?.top_pages ?? [];
  const totalViews = activitySectionData?.page_views ?? 0;
  const lookbackDays = activitySectionData?.lookback_days ?? 7;

  // Shared banners (shown on both tabs when there's a problem)
  const banners = (
    <>
      {failedTests.length > 0 && (
        <AlertBanner
          level="warning"
          message={`System issue detected: ${failedTests.map((t) => SELF_TEST_LABELS[t.name] ?? t.name).join(", ")}`}
          detail="The team has been notified and is investigating."
        />
      )}
      {error && (
        <AlertBanner
          level="error"
          message="Could not load platform status"
          detail={error}
        />
      )}
    </>
  );

  // Refresh timestamp + admin button (shown on operations tab)
  const opsHeader = mounted && data ? (
    <div className="flex items-center justify-between">
      <p className="text-xs text-gray-400" suppressHydrationWarning>
        Updated {new Date(data.status.meta.timestamp).toLocaleTimeString()} ·
        {data.status.meta.query_time_ms}ms
      </p>
      <button
        onClick={handleAdminRefresh}
        disabled={refreshing}
        title="Force refresh all platform data"
        className="text-xs bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white px-2 py-1 rounded transition-colors disabled:opacity-50"
      >
        {refreshing ? "⟳" : "↺ Refresh"}
      </button>
    </div>
  ) : null;

  if (tab === "transparency") {
    return (
      <div className="space-y-6">
        {banners}

        {/* ── Hero: Stat Cards ── */}
        <StatsSection
          database={data?.status.database ?? { error: "Loading", partial: true }}
          officialsBreakdown={officialsBreakdown}
          openProposalCount={openProposalCount}
          chordTotalFlowUsd={chordTotalFlowUsd}
        />

        {/* ── Comment Periods ── */}
        <CommentPeriodsSection openProposals={openProposals} />

        {/* ── Donation Flows ── */}
        <ConnectionHighlightsSection chordFlows={data?.chordFlows ?? []} />

        {/* ── What Civitics Tracks ── */}
        <PlatformStorySection
          database={data?.status.database ?? { error: "Loading", partial: true }}
          chordTotalFlowUsd={chordTotalFlowUsd}
        />
      </div>
    );
  }

  // ── Operations tab ────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {banners}
      {opsHeader}

      {/* ── Self-Tests (promoted to top) ── */}
      <SelfTestsSection
        selfTests={data?.status.self_tests ?? { error: "Loading", partial: true }}
        aiCosts={data?.status.ai_costs ?? { error: "Loading", partial: true }}
      />

      {/* ── Unified Data Health (replaces Pipelines + Quality cards) ── */}
      <DataHealthSection
        pipelines={data?.status.pipelines ?? { error: "Loading", partial: true }}
        quality={data?.status.quality ?? { error: "Loading", partial: true }}
        database={data?.status.database ?? { error: "Loading", partial: true }}
      />

      {/* ── Platform Costs ── */}
      <PlatformCostsSection
        platformUsage={data?.platformUsage ?? null}
        onRefresh={refresh}
        anthropicDetail={data?.anthropicDetail ?? null}
        aiCosts={
          data?.status.ai_costs && !isPartial(data.status.ai_costs)
            ? (data.status.ai_costs as AiCosts)
            : null
        }
        chordTotalFlowUsd={chordTotalFlowUsd}
      />

      {/* ── Site Activity ── */}
      <ActivitySection activity={topPages} totalViews={totalViews} lookbackDays={lookbackDays} />

      {/* ── Development Progress ── */}
      <DevelopmentProgressSection />
    </div>
  );
}
