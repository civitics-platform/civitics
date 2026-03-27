"use client";

import { useState, useEffect } from "react";
import {
  StatCard,
  SectionCard,
  SectionHeader,
  LoadingSkeleton,
  EmptyState,
  CommentPeriodCard,
  PipelineRow,
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
  type PipelineRun,
  type ActivitySectionData,
} from "./useDashboardData";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";

const AnthropicCard = dynamic(
  () => import("./components/AnthropicCard").then((m) => ({ default: m.AnthropicCard })),
  { ssr: false },
);

const PlatformCostsSection = dynamic(
  () => import("./PlatformCostsSection").then((m) => ({ default: m.PlatformCostsSection })),
  { ssr: false },
);

// ── Types from server ─────────────────────────────────────────────────────────

type OpenProposal = {
  id: string;
  title: string;
  agency: string;
  comment_period_end: string;
};

type ActivityRow = {
  path: string;
  views: number;
};

type OfficialsBreakdown = {
  federal: number;
  state: number;
  judges: number;
} | null;

interface DashboardClientProps {
  openProposals: OpenProposal[];
  activity: ActivityRow[];
  officialsBreakdown: OfficialsBreakdown;
}

// ── Pipeline display name mapping ────────────────────────────────────────────

const PIPELINE_NAMES: Record<string, string> = {
  congress: "Congress.gov",
  regulations: "Regulations.gov",
  connections: "Connections",
  fec: "FEC / Donors",
  fec_bulk: "FEC / Donors",
  ai_summaries: "AI Summaries",
  nightly_cron: "Nightly Sync",
  tag_rules: "Rule Tagger",
  tag_ai: "AI Tagger",
};

const KNOWN_PIPELINES = ["congress", "regulations", "connections", "fec", "ai_summaries"];

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

const PHASES = [
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
  { label: "500 beta users", done: false },
  { label: "Grant applications submitted", done: false },
];

// ── Pipeline freshness helper ────────────────────────────────────────────────

function pipelineFreshness(completedAt: string | null | undefined): "ok" | "warning" | "error" {
  if (!completedAt) return "error";
  const age = Date.now() - new Date(completedAt).getTime();
  const hours = age / 3_600_000;
  if (hours < 48) return "ok";
  if (hours < 168) return "warning";
  return "error";
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
  aiCosts,
  officialsBreakdown,
  openProposalCount,
}: {
  database: NonNullable<ReturnType<typeof useDashboardData>["data"]>["status"]["database"];
  aiCosts: NonNullable<ReturnType<typeof useDashboardData>["data"]>["status"]["ai_costs"];
  officialsBreakdown: OfficialsBreakdown;
  openProposalCount: number;
}) {
  const router = useRouter();
  const db = isPartial(database) ? null : database;
  const costs = isPartial(aiCosts) ? null : aiCosts;

  const officialsBreakdownLabel = officialsBreakdown
    ? `${formatNumber(officialsBreakdown.federal)} federal · ${formatNumber(officialsBreakdown.state)} state · ${formatNumber(officialsBreakdown.judges)} judges`
    : "Federal, state & judicial officials";

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <StatCard
        icon="👤"
        label="Officials"
        value={db?.officials ?? 0}
        formatAs="number"
        href="/officials"
        sublabel={officialsBreakdownLabel}
        loading={!db}
      />
      <StatCard
        icon="📋"
        label="Proposals"
        value={db?.proposals ?? 0}
        formatAs="number"
        onClick={() => router.push("/proposals")}
        badge={
          openProposalCount > 0
            ? {
                label: `${openProposalCount} open now`,
                href: "/proposals?status=open",
                variant: "warning",
              }
            : { label: "Federal regulations", variant: "info" }
        }
        sublabel="Federal regulations open for comment"
        loading={!db}
      />
      <StatCard
        icon="🗳"
        label="Votes on Record"
        value={db?.votes ?? 0}
        formatAs="number"
        href="/graph"
        sublabel="Congressional votes tracked"
        loading={!db}
      />
      <StatCard
        icon="🔗"
        label="Connections"
        value={db?.entity_connections ?? 0}
        formatAs="number"
        href="/graph"
        trend="Explore the graph →"
        trendDirection="neutral"
        sublabel="Donations, votes, oversight mapped"
        loading={!db}
      />
      <StatCard
        icon="💰"
        label="Donor Records"
        value={db?.financial_relationships ?? 0}
        formatAs="number"
        href="/graph?preset=follow-the-money"
        sublabel="FEC-tracked PAC and individual contributions"
        loading={!db}
      />
      <StatCard
        icon="🤖"
        label="AI Summaries"
        value={db?.ai_summary_cache ?? 0}
        formatAs="number"
        sublabel="Plain-language summaries generated"
        trend={
          costs
            ? `$${costs.monthly_spent_usd.toFixed(2)} this month`
            : undefined
        }
        trendDirection="neutral"
        loading={!db}
      />
    </div>
  );
}

function CommentPeriodsSection({ openProposals }: { openProposals: OpenProposal[] }) {
  return (
    <SectionCard>
      <SectionHeader
        icon="📢"
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

function PipelinesSection({
  pipelines,
  aiCosts,
}: {
  pipelines: NonNullable<ReturnType<typeof useDashboardData>["data"]>["status"]["pipelines"];
  aiCosts: NonNullable<ReturnType<typeof useDashboardData>["data"]>["status"]["ai_costs"];
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
        <SectionHeader icon="🔄" title="Data Pipelines" status="error" />
        <p className="mt-3 text-sm text-red-600">{pipelines.error}</p>
      </SectionCard>
    );
  }

  const costs = isPartial(aiCosts) ? null : aiCosts;

  // Deduplicate recent_runs — keep latest per pipeline
  const latestByPipeline = new Map<string, PipelineRun>();
  for (const run of pipelines.recent_runs) {
    if (!latestByPipeline.has(run.pipeline)) {
      latestByPipeline.set(run.pipeline, run);
    }
  }

  // Build display rows: known pipelines first, then anything else
  const pipelineRows: PipelineRun[] = [];
  for (const name of KNOWN_PIPELINES) {
    const run = latestByPipeline.get(name);
    if (run) pipelineRows.push(run);
    else {
      pipelineRows.push({
        pipeline: name,
        status: "pending",
        completed_at: "",
        rows_inserted: 0,
      });
    }
  }

  // Cron summary
  const cron = pipelines.cron_last_run as Record<string, unknown> | null;
  const cronAt = (cron?.["completed_at"] as string | undefined) ?? (cron?.["started_at"] as string | undefined) ?? null;
  const cronStatus = (cron?.["status"] as string | undefined) ?? "unknown";
  const cronDurationSec = cron?.["duration_seconds"] as number | undefined;
  const cronCost = cron?.["cost_usd"] as number | undefined;

  // Overall freshness for header status
  const latestRun = pipelines.recent_runs[0];
  const overallFreshness = latestRun ? pipelineFreshness(latestRun.completed_at) : "error";

  return (
    <SectionCard noPadding>
      <div className="p-6 pb-0">
        <SectionHeader
          icon="🔄"
          title="Data Pipelines"
          status={overallFreshness === "ok" ? "ok" : overallFreshness === "warning" ? "warning" : "error"}
          description={
            latestRun
              ? `Last sync: ${formatRelativeTime(latestRun.completed_at)} · Next sync: in ${hoursUntilNext}h`
              : "No recent runs found"
          }
        />
      </div>

      {/* Cron summary */}
      {cron && (
        <div className="mx-6 mt-4 rounded-lg border border-gray-100 bg-gray-50 px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-600">
            <span>
              <span className="font-medium text-gray-900">Last nightly:</span>{" "}
              {cronAt ? new Date(cronAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) + ", " + new Date(cronAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : "—"}
            </span>
            {cronDurationSec != null && (
              <span>
                <span className="font-medium text-gray-900">Duration:</span>{" "}
                {cronDurationSec < 60
                  ? `${cronDurationSec}s`
                  : `${Math.round(cronDurationSec / 60)} minutes`}
              </span>
            )}
            {cronCost != null && (
              <span>
                <span className="font-medium text-gray-900">Cost:</span>{" "}
                ${cronCost.toFixed(2)}
              </span>
            )}
            <span>
              <StatusBadge status={cronStatus === "complete" ? "complete" : cronStatus === "failed" ? "failed" : "pending"} size="sm" />
            </span>
          </div>
        </div>
      )}

      {/* Pipeline rows */}
      <div className="mt-3 divide-y divide-gray-100">
        {pipelineRows.map((run) => {
          const freshness = run.completed_at ? pipelineFreshness(run.completed_at) : "error";
          const status =
            !run.completed_at
              ? "pending"
              : freshness === "error"
              ? "failed"
              : freshness === "warning"
              ? "interrupted"
              : (run.status as "complete" | "running" | "interrupted" | "failed" | "pending");

          return (
            <PipelineRow
              key={run.pipeline}
              name={run.pipeline}
              displayName={PIPELINE_NAMES[run.pipeline] ?? run.pipeline}
              status={status}
              completedAt={run.completed_at || null}
              rowsInserted={run.rows_inserted}
            />
          );
        })}
      </div>

      {/* AI cost footer */}
      {costs && (
        <div className="border-t border-gray-100 p-6 pt-4">
          <div className="flex items-center justify-between text-xs text-gray-600">
            <span className="font-medium text-gray-900">Monthly AI cost</span>
            <span className="tabular-nums">
              ${costs.monthly_spent_usd.toFixed(2)} / ${costs.monthly_budget_usd.toFixed(2)} budget ({costs.budget_used_pct.toFixed(0)}%)
            </span>
          </div>
          <div className="mt-2 h-2 w-full rounded-full bg-gray-100 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-200 ${
                costs.budget_used_pct > 75 ? "bg-amber-500" : "bg-blue-500"
              }`}
              style={{ width: `${Math.min(100, costs.budget_used_pct)}%` }}
            />
          </div>
        </div>
      )}
    </SectionCard>
  );
}

function DataQualitySection({
  quality,
  database,
}: {
  quality: NonNullable<ReturnType<typeof useDashboardData>["data"]>["status"]["quality"];
  database: NonNullable<ReturnType<typeof useDashboardData>["data"]>["status"]["database"];
}) {
  if (isPartial(quality)) {
    return (
      <SectionCard>
        <SectionHeader icon="📊" title="Data Quality & Coverage" />
        <p className="mt-3 text-sm text-red-600">{quality.error}</p>
      </SectionCard>
    );
  }

  const db = isPartial(database) ? null : database;

  const aiPct =
    db && db.proposals > 0
      ? Math.round((db.ai_summary_cache / db.proposals) * 1000) / 10
      : 0;

  return (
    <SectionCard>
      <SectionHeader icon="📊" title="Data Quality & Coverage" />
      <div className="mt-4 space-y-5">
        <DataQualityBar
          label="FEC ID coverage"
          pct={quality.fec_coverage.pct}
          value={quality.fec_coverage.has_fec}
          total={quality.fec_coverage.total}
          color="green"
        />
        <DataQualityBar
          label="Vote records"
          pct={quality.vote_connections > 0 ? 100 : 0}
          value={quality.vote_connections}
          color="green"
        />
        <DataQualityBar
          label="Industry tags"
          pct={quality.industry_tags.pct}
          value={quality.industry_tags.tagged}
          total={quality.industry_tags.total}
          color="blue"
        />
        <DataQualityBar
          label="AI summaries"
          pct={aiPct}
          value={db?.ai_summary_cache ?? 0}
          total={db?.proposals ?? 0}
          color="amber"
        />
      </div>
      <div className="mt-6 flex flex-wrap gap-2 border-t border-gray-100 pt-4">
        <span className="text-xs text-gray-500 mr-1">Data sources:</span>
        {[
          { label: "FEC.gov", href: "https://www.fec.gov" },
          { label: "Congress.gov", href: "https://congress.gov" },
          { label: "Regulations.gov", href: "https://regulations.gov" },
          { label: "OpenStates.org", href: "https://openstates.org" },
        ].map((src) => (
          <a
            key={src.label}
            href={src.href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center rounded-full border border-gray-200 px-2.5 py-0.5 text-xs font-medium text-gray-600 hover:border-blue-300 hover:text-blue-700 transition-colors duration-150"
          >
            {src.label} ↗
          </a>
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
          icon="💡"
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
        icon="💡"
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
}: {
  activity: ActivityRow[];
  totalViews: number;
}) {
  return (
    <SectionCard>
      <SectionHeader
        icon="👀"
        title="Site Activity"
        description={`${formatNumber(totalViews)} human page views in the last 24h`}
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

// ── FIX 4: Development Progress ───────────────────────────────────────────────

function DevelopmentProgressSection() {
  return (
    <SectionCard>
      <SectionHeader icon="🚀" title="Development Progress" description="Phase 1 of 5" />
      <div className="mt-4 space-y-3">
        {PHASES.map((phase) => (
          <div key={phase.name}>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-sm font-medium text-gray-900">
                {phase.name} — {phase.label}
                {phase.done && <span className="ml-2 text-green-600">✓</span>}
              </span>
              <span className="tabular-nums text-sm text-gray-600">{phase.pct}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
              <div
                className={`h-full rounded-full transition-all duration-200 ${
                  phase.done ? "bg-green-500" : phase.pct > 0 ? "bg-blue-500" : "bg-gray-200"
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
                  task.done ? "text-green-600" : "text-gray-400"
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

// ── FIX 5: Community Compute Pool ─────────────────────────────────────────────

function CommunityComputeSection() {
  return (
    <SectionCard>
      <SectionHeader
        icon="⛏"
        title="Community Compute Pool"
        description="Phase 4 — launches with blockchain integration on Optimism"
      />
      <div className="mt-4 grid grid-cols-2 gap-4">
        <div className="rounded-lg bg-gray-50 p-4 text-center">
          <p className="text-2xl font-bold text-gray-900">$0</p>
          <p className="mt-1 text-xs text-gray-500">Community donations</p>
        </div>
        <div className="rounded-lg bg-gray-50 p-4 text-center">
          <p className="text-2xl font-bold text-gray-900">$0</p>
          <p className="mt-1 text-xs text-gray-500">API costs covered</p>
        </div>
      </div>
      <p className="mt-4 text-sm leading-relaxed text-gray-600">
        Every dollar donated and every dollar spent will be tracked on-chain and visible here in
        real time.
      </p>
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
        <SectionHeader icon="🔍" title="System Self-Tests" />
        <p className="mt-3 text-sm text-red-600">{selfTests.error}</p>
      </SectionCard>
    );
  }

  const costs = isPartial(aiCosts) ? null : aiCosts;
  const allPassed = selfTests.every((t) => t.passed);

  return (
    <SectionCard>
      <SectionHeader
        icon="🔍"
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
                className={`shrink-0 mt-0.5 text-sm font-bold ${
                  test.passed ? "text-green-600" : "text-red-600"
                }`}
                title={test.detail}
              >
                {test.passed ? "✓" : "✗"}
              </span>
              <span
                className={`text-sm ${test.passed ? "text-gray-700" : "text-red-700 font-medium"}`}
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
  activity,
  officialsBreakdown,
}: DashboardClientProps) {
  const { data, loading, error, refresh } = useDashboardData();
  const [_secondsAgo] = useState(0);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const db = data && !isPartial(data.status.database) ? data.status.database : null;
  const failedTests =
    data && !isPartial(data.status.self_tests)
      ? data.status.self_tests.filter((t) => !t.passed)
      : [];

  // FIX 1: chord total flow USD
  const chordSection =
    data?.status.chord && !isPartial(data.status.chord) ? data.status.chord : null;
  const chordTotalFlowUsd = chordSection?.total_flow_usd ?? 0;

  // FIX 7: activity from status API
  const activitySectionData: ActivitySectionData | null =
    data?.status.activity && !isPartial(data.status.activity)
      ? (data.status.activity as ActivitySectionData)
      : null;
  const topPages = activitySectionData?.top_pages ?? activity;
  const totalViews = activitySectionData?.page_views_24h ?? db?.page_views_24h ?? 0;

  if (!mounted) {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
          {[...Array(6)].map((_, i) => (
            <div
              key={i}
              className="h-40 bg-white rounded-xl border border-gray-200 shadow-sm animate-pulse"
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Alert banner if self-tests fail */}
      {failedTests.length > 0 && (
        <AlertBanner
          level="warning"
          message={`System issue detected: ${failedTests.map((t) => SELF_TEST_LABELS[t.name] ?? t.name).join(", ")}`}
          detail="The team has been notified and is investigating."
        />
      )}

      {/* Error banner if status fetch failed */}
      {error && (
        <AlertBanner
          level="error"
          message="Could not load platform status"
          detail={error}
        />
      )}

      {/* Refresh timestamp + manual refresh button */}
      {mounted && data && (
        <p className="flex items-center gap-1 text-xs text-gray-400" suppressHydrationWarning>
          Updated {new Date(data.status.meta.timestamp).toLocaleTimeString()} ·
          query took {data.status.meta.query_time_ms}ms
          <button
            onClick={refresh}
            disabled={loading}
            className="ml-1 transition-colors hover:text-gray-600 disabled:opacity-40"
            title="Refresh data"
          >
            {loading ? "⟳" : "↺"}
          </button>
        </p>
      )}

      {/* ── Stat Cards ── */}
      {loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <LoadingSkeleton variant="stat-card" count={6} />
        </div>
      ) : (
        <StatsSection
          database={data?.status.database ?? { error: "Loading", partial: true }}
          aiCosts={data?.status.ai_costs ?? { error: "Loading", partial: true }}
          officialsBreakdown={officialsBreakdown}
          openProposalCount={openProposals.length}
        />
      )}

      {/* ── Comment Periods ── */}
      <CommentPeriodsSection openProposals={openProposals} />

      {/* ── Two-column: Pipelines + Quality ── */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {loading ? (
          <>
            <LoadingSkeleton variant="card" />
            <LoadingSkeleton variant="card" />
          </>
        ) : (
          <>
            <PipelinesSection
              pipelines={data?.status.pipelines ?? { error: "Loading", partial: true }}
              aiCosts={data?.status.ai_costs ?? { error: "Loading", partial: true }}
            />
            <DataQualitySection
              quality={data?.status.quality ?? { error: "Loading", partial: true }}
              database={data?.status.database ?? { error: "Loading", partial: true }}
            />
          </>
        )}
      </div>

      {/* ── Two-column: Connections + Activity ── */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {loading ? (
          <>
            <LoadingSkeleton variant="card" />
            <LoadingSkeleton variant="card" />
          </>
        ) : (
          <>
            <ConnectionHighlightsSection chordFlows={data?.chordFlows ?? []} />
            <ActivitySection activity={topPages} totalViews={totalViews} />
          </>
        )}
      </div>

      {/* ── Platform Costs — data from useDashboardData, no independent fetch ── */}
      <PlatformCostsSection
        platformUsage={data?.platformUsage ?? null}
        onRefresh={refresh}
      />

      {/* ── Anthropic AI — data from status ai_costs, no independent fetch ── */}
      <AnthropicCard
        aiCosts={
          data?.status.ai_costs && !isPartial(data.status.ai_costs)
            ? (data.status.ai_costs as AiCosts)
            : null
        }
      />

      {/* ── FIX 4: Development Progress + FIX 5: Community Compute ── */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {loading ? (
          <>
            <LoadingSkeleton variant="card" />
            <LoadingSkeleton variant="card" />
          </>
        ) : (
          <>
            <DevelopmentProgressSection />
            <CommunityComputeSection />
          </>
        )}
      </div>

      {/* ── Two-column: Platform Story + Self Tests ── */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {loading ? (
          <>
            <LoadingSkeleton variant="card" />
            <LoadingSkeleton variant="card" />
          </>
        ) : (
          <>
            <PlatformStorySection
              database={data?.status.database ?? { error: "Loading", partial: true }}
              chordTotalFlowUsd={chordTotalFlowUsd}
            />
            <SelfTestsSection
              selfTests={data?.status.self_tests ?? { error: "Loading", partial: true }}
              aiCosts={data?.status.ai_costs ?? { error: "Loading", partial: true }}
            />
          </>
        )}
      </div>
    </div>
  );
}
