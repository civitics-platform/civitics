export const dynamic = "force-dynamic";

import { createAdminClient } from "@civitics/db";
import { DashboardAutoRefresh } from "./DashboardAutoRefresh";

export const metadata = { title: "Platform Dashboard" };

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function getPlatformCounts() {
  const supabase = createAdminClient();

  const [officials, proposals, votes, financial, connections, comments] =
    await Promise.all([
      supabase.from("officials").select("*", { count: "exact", head: true }),
      supabase.from("proposals").select("*", { count: "exact", head: true }),
      supabase.from("votes").select("*", { count: "exact", head: true }),
      supabase.from("financial_relationships").select("*", { count: "exact", head: true }),
      supabase.from("entity_connections").select("*", { count: "exact", head: true }),
      supabase.from("civic_comments").select("*", { count: "exact", head: true }),
    ]);

  return {
    officials:   officials.count   ?? 0,
    proposals:   proposals.count   ?? 0,
    votes:       votes.count       ?? 0,
    financial:   financial.count   ?? 0,
    connections: connections.count ?? 0,
    comments:    comments.count    ?? 0,
  };
}

async function getDatabaseSizeBytes(): Promise<number> {
  const supabase = createAdminClient();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabase as any).rpc("get_database_size_bytes");
    return typeof data === "number" ? data : 0;
  } catch {
    return 0;
  }
}

async function getApiUsageStats() {
  const supabase = createAdminClient();
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any;
  try {
    const [todayRows, monthRows] = await Promise.all([
      db
        .from("api_usage_logs")
        .select("service, model, cost_cents")
        .gte("created_at", todayStart.toISOString()),
      db
        .from("api_usage_logs")
        .select("service, model, cost_cents")
        .gte("created_at", monthStart.toISOString()),
    ]);

    type UsageRow = { service: string; model: string | null; cost_cents: number };

    const sumCents = (rows: UsageRow[] | null) =>
      (rows ?? []).reduce((acc, r) => acc + (r.cost_cents ?? 0), 0);

    const todayData: UsageRow[]  = todayRows.data  ?? [];
    const monthData: UsageRow[]  = monthRows.data  ?? [];

    const countByModel = (rows: UsageRow[]) => {
      const m: Record<string, number> = {};
      for (const r of rows) {
        const key = r.model ?? "unknown";
        m[key] = (m[key] ?? 0) + 1;
      }
      return m;
    };

    return {
      todayCents:        sumCents(todayData),
      monthCents:        sumCents(monthData),
      todayCalls:        todayData.filter((r) => r.service === "anthropic").length,
      monthCalls:        monthData.filter((r) => r.service === "anthropic").length,
      modelBreakdown:    countByModel(monthData.filter((r) => r.service === "anthropic")),
      resendMonthCount:  monthData.filter((r) => r.service === "resend").length,
    };
  } catch {
    return {
      todayCents: 0, monthCents: 0, todayCalls: 0, monthCalls: 0,
      modelBreakdown: {}, resendMonthCount: 0,
    };
  }
}

async function getDataFreshness() {
  const supabase = createAdminClient();

  const [officialsRow, votesRow] = await Promise.all([
    supabase
      .from("officials")
      .select("updated_at")
      .order("updated_at", { ascending: false })
      .limit(1)
      .single(),
    supabase
      .from("votes")
      .select("updated_at")
      .order("updated_at", { ascending: false })
      .limit(1)
      .single(),
  ]);

  return {
    officialsLastSync: officialsRow.data?.updated_at ?? null,
    votesLastSync:     votesRow.data?.updated_at     ?? null,
  };
}

// ---------------------------------------------------------------------------
// Helper components
// ---------------------------------------------------------------------------

function MetricCard({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5">
      <p className="text-2xl font-bold tabular-nums text-gray-900">
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
      <p className="mt-0.5 text-sm font-medium text-gray-700">{label}</p>
      {note && <p className="mt-1 text-xs text-gray-400">{note}</p>}
    </div>
  );
}

type StatusLevel = "green" | "yellow" | "orange" | "red" | "gray";

function StatusDot({ level }: { level: StatusLevel }) {
  const colors: Record<StatusLevel, string> = {
    green:  "bg-emerald-500",
    yellow: "bg-yellow-400",
    orange: "bg-orange-400",
    red:    "bg-red-500",
    gray:   "bg-gray-300",
  };
  return (
    <span className={`inline-block h-2.5 w-2.5 rounded-full ${colors[level]} shrink-0`} />
  );
}

function statusFromPercent(pct: number): StatusLevel {
  if (pct >= 95) return "red";
  if (pct >= 80) return "orange";
  if (pct >= 60) return "yellow";
  return "green";
}

function ProgressBar({
  label,
  used,
  total,
  unit,
  upgradeNote,
}: {
  label: string;
  used: number;
  total: number;
  unit: string;
  upgradeNote?: string;
}) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const level = statusFromPercent(pct);

  const barColors: Record<StatusLevel, string> = {
    green:  "bg-emerald-500",
    yellow: "bg-yellow-400",
    orange: "bg-orange-400",
    red:    "bg-red-500",
    gray:   "bg-gray-300",
  };

  const formatVal = (v: number) => {
    if (unit === "MB") return `${(v / 1024 / 1024).toFixed(1)} MB`;
    if (unit === "GB") return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
    return `${v.toLocaleString()} ${unit}`;
  };

  const formatTotal = (v: number) => {
    if (unit === "MB") return `${(v / 1024 / 1024).toFixed(0)} MB`;
    if (unit === "GB") return `${(v / 1024 / 1024 / 1024).toFixed(0)} GB`;
    return `${v.toLocaleString()} ${unit}`;
  };

  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-gray-700">{label}</span>
        <span className="tabular-nums text-gray-500">
          {formatVal(used)} / {formatTotal(total)} ({pct}%)
        </span>
      </div>
      <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-gray-100">
        <div
          className={`h-full rounded-full transition-all ${barColors[level]}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {upgradeNote && pct >= 80 && (
        <p className="mt-1 text-xs text-orange-600">{upgradeNote}</p>
      )}
    </div>
  );
}

function BudgetBar({
  label,
  spentCents,
  budgetCents,
}: {
  label: string;
  spentCents: number;
  budgetCents: number;
}) {
  const pct = budgetCents > 0 ? Math.min(100, Math.round((spentCents / budgetCents) * 100)) : 0;
  const level = statusFromPercent(pct);

  const barColors: Record<StatusLevel, string> = {
    green:  "bg-emerald-500",
    yellow: "bg-yellow-400",
    orange: "bg-orange-400",
    red:    "bg-red-500",
    gray:   "bg-gray-300",
  };

  const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-gray-700">{label}</span>
        <span className="tabular-nums text-gray-500">
          {fmt(spentCents)} / {fmt(budgetCents)} ({pct}%)
        </span>
      </div>
      <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-gray-100">
        <div
          className={`h-full rounded-full transition-all ${barColors[level]}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function PhaseBar({ label, pct, done }: { label: string; pct: number; done?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-20 shrink-0 text-xs font-medium text-gray-600">{label}</span>
      <div className="flex-1 h-2 overflow-hidden rounded-full bg-gray-100">
        <div
          className={`h-full rounded-full ${done ? "bg-emerald-500" : "bg-indigo-500"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-gray-500">
        {pct}%{done ? " ✓" : ""}
      </span>
    </div>
  );
}

function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-base font-semibold text-gray-900">{title}</h2>
      {description && <p className="mt-0.5 text-sm text-gray-500">{description}</p>}
    </div>
  );
}

function ServiceRow({
  name,
  level,
  detail,
  subDetail,
}: {
  name: string;
  level: StatusLevel;
  detail: string;
  subDetail?: string;
}) {
  const labels: Record<StatusLevel, string> = {
    green:  "Operational",
    yellow: "Degraded",
    orange: "Warning",
    red:    "Down",
    gray:   "Unknown",
  };
  return (
    <div className="flex items-start justify-between gap-4 py-3 border-b border-gray-100 last:border-0">
      <div className="flex items-center gap-2.5">
        <StatusDot level={level} />
        <span className="text-sm font-medium text-gray-800">{name}</span>
        <span className="text-xs text-gray-400">{labels[level]}</span>
      </div>
      <div className="text-right">
        <p className="text-xs tabular-nums text-gray-600">{detail}</p>
        {subDetail && <p className="text-xs text-gray-400">{subDetail}</p>}
      </div>
    </div>
  );
}

function FreshnessRow({
  source,
  lastSync,
  nextNote,
  records,
  status,
}: {
  source: string;
  lastSync: string | null;
  nextNote?: string;
  records?: string;
  status: "synced" | "pending" | "not_started";
}) {
  const levelMap: Record<string, StatusLevel> = {
    synced:      "green",
    pending:     "yellow",
    not_started: "gray",
  };
  const level = levelMap[status] ?? "gray";

  const formatTs = (ts: string | null) => {
    if (!ts) return "Never";
    const d = new Date(ts);
    return d.toLocaleString("en-US", {
      month: "short", day: "numeric", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  };

  return (
    <div className="flex items-start justify-between gap-4 py-3 border-b border-gray-100 last:border-0">
      <div className="flex items-start gap-2.5">
        <StatusDot level={level} />
        <div>
          <p className="text-sm font-medium text-gray-800">{source}</p>
          {nextNote && <p className="text-xs text-gray-400">{nextNote}</p>}
        </div>
      </div>
      <div className="text-right shrink-0">
        <p className="text-xs tabular-nums text-gray-600">Last sync: {formatTs(lastSync)}</p>
        {records && <p className="text-xs text-gray-400">{records}</p>}
        {status === "not_started" && (
          <p className="text-xs text-gray-400">Pipeline pending</p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 1 checklist items (mirrors PHASE_GOALS.md)
// ---------------------------------------------------------------------------

const PHASE1_TASKS = [
  // Data Ingestion
  { label: "Congress.gov → officials + votes",       done: true  },
  { label: "FEC → financial_relationships",           done: false },
  { label: "USASpending.gov → spending_records",      done: false },
  { label: "Regulations.gov → proposals",             done: false },
  { label: "OpenStates → state legislators",          done: false },
  { label: "CourtListener → judges + rulings",        done: false },
  // Core Pages
  { label: "Official profile page",                   done: true  },
  { label: "Agency profile page",                     done: false },
  { label: "Proposal detail page",                    done: false },
  { label: "Search across all entities",              done: false },
  { label: "Homepage wired to real data",             done: false },
  // AI Features
  { label: "Plain language bill summaries (cached)",  done: false },
  { label: "Credit system in Supabase",               done: false },
  { label: "'What does this mean for me' query",      done: false },
  // Community
  { label: "User auth via Supabase",                  done: false },
  { label: "Community commenting",                    done: false },
  { label: "Position tracking on proposals",         done: false },
  { label: "Follow officials and agencies",           done: false },
  // Maps
  { label: "Mapbox account + API key",                done: false },
  { label: "District finder from address",            done: false },
  { label: "Find your representatives map",           done: false },
  // Dashboard
  { label: "Public accountability dashboard",         done: true  },
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function DashboardPage() {
  const fetchedAt = new Date();

  const [counts, dbSizeBytes, usage, freshness] = await Promise.all([
    getPlatformCounts(),
    getDatabaseSizeBytes(),
    getApiUsageStats(),
    getDataFreshness(),
  ]);

  // Supabase free tier limits (bytes)
  const DB_FREE_LIMIT = 500 * 1024 * 1024; // 500 MB

  // Budget constants (cents)
  const DAILY_BUDGET_CENTS   = 200;   // $2.00
  const MONTHLY_BUDGET_CENTS = 5000;  // $50.00
  const CREDITS_TOTAL_CENTS  = 500_000; // $5,000 startup credits
  const CREDITS_USED_CENTS   = usage.monthCents; // rough proxy

  const dbOk = dbSizeBytes < DB_FREE_LIMIT * 0.8;
  const dbLevel: StatusLevel = statusFromPercent(
    dbSizeBytes > 0 ? Math.round((dbSizeBytes / DB_FREE_LIMIT) * 100) : 0
  );

  const vercelEnv = process.env["VERCEL_ENV"] ?? process.env["NODE_ENV"] ?? "development";
  const vercelSha = process.env["VERCEL_GIT_COMMIT_SHA"] ?? null;

  const phase1DoneCount = PHASE1_TASKS.filter((t) => t.done).length;
  const phase1Pct = Math.round((phase1DoneCount / PHASE1_TASKS.length) * 100);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-14 items-center justify-between">
            <div className="flex items-center gap-3">
              <a href="/" className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded bg-indigo-600">
                  <span className="text-[10px] font-bold text-white">CV</span>
                </div>
                <span className="text-sm font-medium text-gray-500 hover:text-gray-800 transition-colors">
                  Civitics
                </span>
              </a>
              <span className="text-gray-300">/</span>
              <span className="text-sm font-semibold text-gray-900">Platform Dashboard</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <span>Updated:</span>
              <DashboardAutoRefresh />
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-8">

          {/* ── 1. PLATFORM STATUS ─────────────────────────────────────────── */}
          <section>
            <SectionHeader
              title="Platform Status"
              description="Live counts from the database — refreshed every 60 seconds."
            />
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
              <MetricCard label="Officials"           value={counts.officials}   />
              <MetricCard label="Proposals tracked"   value={counts.proposals}   />
              <MetricCard label="Votes recorded"      value={counts.votes}       />
              <MetricCard label="Financial records"   value={counts.financial}   />
              <MetricCard label="Connections mapped"  value={counts.connections} />
              <MetricCard label="Comments submitted"  value={counts.comments}    />
            </div>
            <p className="mt-2 text-xs text-gray-400">
              Last queried:{" "}
              {fetchedAt.toLocaleString("en-US", {
                month: "short", day: "numeric", year: "numeric",
                hour: "2-digit", minute: "2-digit", second: "2-digit",
              })}
            </p>
          </section>

          {/* ── 2. SERVICE HEALTH ──────────────────────────────────────────── */}
          <section>
            <SectionHeader
              title="Service Health"
              description="Status of connected infrastructure services."
            />
            <div className="rounded-lg border border-gray-200 bg-white px-5 divide-y divide-gray-100">
              <ServiceRow
                name="Supabase Database"
                level={dbOk ? "green" : dbLevel}
                detail={
                  dbSizeBytes > 0
                    ? `${(dbSizeBytes / 1024 / 1024).toFixed(1)} MB used of 500 MB free tier`
                    : "Size query unavailable — run migration 0003"
                }
                subDetail="PostgreSQL + PostGIS"
              />
              <ServiceRow
                name="Vercel Deployment"
                level="green"
                detail={`Environment: ${vercelEnv}`}
                subDetail={vercelSha ? `SHA: ${vercelSha.slice(0, 7)}` : "Local build"}
              />
              <ServiceRow
                name="Anthropic API"
                level={usage.todayCalls > 0 ? "green" : "gray"}
                detail={
                  usage.todayCalls > 0
                    ? `${usage.todayCalls} calls today · $${(usage.todayCents / 100).toFixed(2)} spent`
                    : "No calls logged today"
                }
                subDetail="Logging via api_usage_logs"
              />
              <ServiceRow
                name="Resend Email"
                level={usage.resendMonthCount > 0 ? "green" : "gray"}
                detail={`${usage.resendMonthCount} / 3,000 emails this month (free tier)`}
                subDetail={
                  usage.resendMonthCount > 2400
                    ? "Approaching free tier limit"
                    : "Within free tier"
                }
              />
              <ServiceRow
                name="Sentry"
                level="gray"
                detail="Error tracking configured"
                subDetail="SDK integration pending"
              />
            </div>
          </section>

          {/* ── 3. SUPABASE TIER TRACKER ───────────────────────────────────── */}
          <section>
            <SectionHeader
              title="Supabase Free Tier"
              description="Free tier: 500 MB database · 5 GB bandwidth/month. Upgrade to Pro at $25/mo."
            />
            <div className="rounded-lg border border-gray-200 bg-white p-5 space-y-4">
              <ProgressBar
                label="Database size"
                used={dbSizeBytes > 0 ? dbSizeBytes : 0}
                total={DB_FREE_LIMIT}
                unit="MB"
                upgradeNote="Upgrade to Pro at $25/mo when database hits 400 MB"
              />
              <ProgressBar
                label="Bandwidth (est.)"
                used={0}
                total={5 * 1024 * 1024 * 1024}
                unit="GB"
              />
              <div className="pt-1 text-xs text-gray-400">
                Color coding: <span className="text-emerald-600 font-medium">0–60% healthy</span>
                {" · "}
                <span className="text-yellow-600 font-medium">60–80% watch</span>
                {" · "}
                <span className="text-orange-600 font-medium">80–95% plan upgrade</span>
                {" · "}
                <span className="text-red-600 font-medium">95%+ urgent</span>
              </div>
            </div>
          </section>

          {/* ── 4. ANTHROPIC USAGE ─────────────────────────────────────────── */}
          <section>
            <SectionHeader
              title="Anthropic API Usage"
              description="All AI costs tracked and published here. Budget limits enforced server-side."
            />
            <div className="rounded-lg border border-gray-200 bg-white p-5 space-y-4">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 pb-4 border-b border-gray-100">
                <div>
                  <p className="text-xs text-gray-500">Calls today</p>
                  <p className="text-lg font-bold tabular-nums text-gray-900">
                    {usage.todayCalls.toLocaleString()}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Spent today</p>
                  <p className="text-lg font-bold tabular-nums text-gray-900">
                    ${(usage.todayCents / 100).toFixed(2)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Calls this month</p>
                  <p className="text-lg font-bold tabular-nums text-gray-900">
                    {usage.monthCalls.toLocaleString()}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Spent this month</p>
                  <p className="text-lg font-bold tabular-nums text-gray-900">
                    ${(usage.monthCents / 100).toFixed(2)}
                  </p>
                </div>
              </div>
              <BudgetBar
                label="Daily budget"
                spentCents={usage.todayCents}
                budgetCents={DAILY_BUDGET_CENTS}
              />
              <BudgetBar
                label="Monthly budget"
                spentCents={usage.monthCents}
                budgetCents={MONTHLY_BUDGET_CENTS}
              />
              <BudgetBar
                label="Startup credits ($5,000)"
                spentCents={CREDITS_USED_CENTS}
                budgetCents={CREDITS_TOTAL_CENTS}
              />
              {Object.keys(usage.modelBreakdown).length > 0 && (
                <div className="pt-2 border-t border-gray-100">
                  <p className="text-xs font-medium text-gray-500 mb-2">Model usage this month</p>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(usage.modelBreakdown).map(([model, count]) => (
                      <span
                        key={model}
                        className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-700"
                      >
                        {model}: {(count as number).toLocaleString()}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {Object.keys(usage.modelBreakdown).length === 0 && (
                <p className="text-xs text-gray-400">
                  No API calls logged yet. Calls are recorded to{" "}
                  <code className="rounded bg-gray-100 px-1 font-mono">api_usage_logs</code>{" "}
                  when AI features are used.
                </p>
              )}
            </div>
          </section>

          {/* ── 5. COMPUTE POOL ────────────────────────────────────────────── */}
          <section>
            <SectionHeader
              title="Community Compute Pool"
              description="Phase 4 — launches with blockchain integration."
            />
            <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-6 text-center">
              <p className="text-sm font-medium text-gray-600">Compute pool not yet live</p>
              <p className="mt-1 text-sm text-gray-400">
                Community donations will fund platform API costs starting in Phase 4.
                Every dollar donated and every dollar spent will be tracked on-chain
                and visible here in real time.
              </p>
              <div className="mt-4 grid grid-cols-2 gap-4 max-w-xs mx-auto">
                <div className="rounded bg-white border border-gray-200 p-3">
                  <p className="text-xl font-bold text-gray-300">$0</p>
                  <p className="text-xs text-gray-400">Community donations</p>
                </div>
                <div className="rounded bg-white border border-gray-200 p-3">
                  <p className="text-xl font-bold text-gray-300">$0</p>
                  <p className="text-xs text-gray-400">API costs covered</p>
                </div>
              </div>
            </div>
          </section>

          {/* ── 6. DEVELOPMENT PROGRESS ────────────────────────────────────── */}
          <section>
            <SectionHeader
              title="Development Progress"
              description="Phased build plan from CLAUDE.md. Updated as features ship."
            />
            <div className="rounded-lg border border-gray-200 bg-white p-5">
              <div className="space-y-3">
                <PhaseBar label="Phase 0"  pct={100} done />
                <PhaseBar label="Phase 1"  pct={phase1Pct} />
                <PhaseBar label="Phase 2"  pct={0} />
                <PhaseBar label="Phase 3"  pct={0} />
                <PhaseBar label="Phase 4"  pct={0} />
                <PhaseBar label="Phase 5"  pct={0} />
              </div>

              <div className="mt-6 border-t border-gray-100 pt-5">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">
                  Phase 1 tasks ({phase1DoneCount}/{PHASE1_TASKS.length} complete)
                </p>
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  {PHASE1_TASKS.map((task) => (
                    <div key={task.label} className="flex items-center gap-2">
                      {task.done ? (
                        <span className="text-emerald-500 text-xs">✓</span>
                      ) : (
                        <span className="text-gray-300 text-xs">○</span>
                      )}
                      <span
                        className={`text-xs ${task.done ? "text-gray-700" : "text-gray-400"}`}
                      >
                        {task.label}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>

          {/* ── 7. DATA FRESHNESS ──────────────────────────────────────────── */}
          <section>
            <SectionHeader
              title="Data Freshness"
              description="When each source was last synced. Target: daily at 2am."
            />
            <div className="rounded-lg border border-gray-200 bg-white px-5 divide-y divide-gray-100">
              <FreshnessRow
                source="Congress.gov — officials + votes"
                lastSync={freshness.officialsLastSync}
                nextNote="Scheduled: daily 2am"
                records={`${counts.officials.toLocaleString()} officials · ${counts.votes.toLocaleString()} votes`}
                status={freshness.officialsLastSync ? "synced" : "pending"}
              />
              <FreshnessRow
                source="FEC — campaign finance"
                lastSync={null}
                nextNote="Pipeline not yet built"
                status="not_started"
              />
              <FreshnessRow
                source="USASpending.gov — contracts + grants"
                lastSync={null}
                nextNote="Pipeline not yet built"
                status="not_started"
              />
              <FreshnessRow
                source="Regulations.gov — proposals + comment periods"
                lastSync={null}
                nextNote="Pipeline not yet built"
                status="not_started"
              />
              <FreshnessRow
                source="OpenStates — state legislators"
                lastSync={null}
                nextNote="Pipeline not yet built"
                status="not_started"
              />
              <FreshnessRow
                source="CourtListener — judges + rulings"
                lastSync={null}
                nextNote="Pipeline not yet built"
                status="not_started"
              />
            </div>
          </section>

          {/* ── 8. TRANSPARENCY FOOTER ─────────────────────────────────────── */}
          <section>
            <div className="rounded-lg border border-indigo-100 bg-indigo-50 p-6">
              <h2 className="text-sm font-semibold text-indigo-900">
                Why this dashboard exists
              </h2>
              <p className="mt-2 text-sm text-indigo-800 leading-relaxed">
                This dashboard is publicly accessible because Civitics holds itself to the same
                standard of transparency it demands from government. Every dollar spent building
                this platform will be trackable here when the community compute pool launches
                in Phase 4.
              </p>
              <p className="mt-3 text-sm text-indigo-700">
                The platform earns no revenue from surveillance advertising. Official comment
                submission is always free. Blockchain is invisible. This page is our receipt.
              </p>
            </div>
          </section>

        </div>
      </main>

      <footer className="mt-8 border-t border-gray-200 bg-white">
        <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-gray-500">
              Civitics · Platform Dashboard · All data is live from the production database.
            </p>
            <a href="/" className="text-xs text-indigo-600 hover:text-indigo-700">
              ← Back to Civitics
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
