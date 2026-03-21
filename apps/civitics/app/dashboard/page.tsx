export const dynamic = "force-dynamic";

import { createAdminClient } from "@civitics/db";
import { DashboardAutoRefresh } from "./DashboardAutoRefresh";
import { DashboardStatsSection } from "./DashboardStatsSection";
import { PipelineOpsSection } from "./PipelineOpsSection";
import { BudgetControlForm } from "./BudgetControlForm";
import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";

export const metadata = { title: "Platform Dashboard" };

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function getDatabaseSizeBytes(): Promise<number> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (createAdminClient() as any).rpc("get_database_size_bytes");
    return typeof data === "number" ? data : 0;
  } catch {
    return 0;
  }
}

async function getAnthropicUsage() {
  const now = new Date();
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyDb = createAdminClient() as any;
  try {
    const [today, month, daily7, recentRuns, alertState] = await Promise.all([
      anyDb.from("api_usage_logs").select("cost_cents,input_tokens,output_tokens").eq("service", "anthropic").gte("created_at", todayStart.toISOString()),
      anyDb.from("api_usage_logs").select("model,cost_cents,input_tokens,output_tokens").eq("service", "anthropic").gte("created_at", monthStart.toISOString()),
      anyDb.from("api_usage_logs").select("cost_cents,created_at").eq("service", "anthropic").gte("created_at", new Date(now.getTime() - 7 * 86400_000).toISOString()),
      anyDb.from("pipeline_cost_history")
        .select("pipeline_name,run_at,entity_count,estimated_cost_usd,actual_cost_usd,variance_ratio,status")
        .order("run_at", { ascending: false })
        .limit(10),
      anyDb.from("pipeline_state").select("value").eq("key", "cost_alert_latest").maybeSingle(),
    ]);
    type Row = { cost_cents: number; model?: string; created_at?: string; input_tokens?: number; output_tokens?: number };
    type RunRow = { pipeline_name: string; run_at: string; entity_count: number; estimated_cost_usd: number; actual_cost_usd: number | null; variance_ratio: number | null; status: string };
    const todayRows: Row[] = today.data ?? [];
    const monthRows: Row[] = month.data ?? [];
    const daily7Rows: Row[] = daily7.data ?? [];

    // Combined cost: token-based (accurate) + cost_cents fallback for old NULL-token rows
    const combinedCostDollars = (rows: Row[]) =>
      rows.reduce((s, r) => {
        if (r.input_tokens != null && r.output_tokens != null) {
          return s + (r.input_tokens * 0.25 + r.output_tokens * 1.25) / 1_000_000;
        }
        // Fallback: use stored cost_cents for rows that predate token tracking
        return s + (r.cost_cents ?? 0) / 100;
      }, 0);

    const dayBuckets: number[] = Array(7).fill(0);
    for (const r of daily7Rows) {
      const daysAgo = Math.floor((now.getTime() - new Date(r.created_at!).getTime()) / 86400_000);
      if (daysAgo >= 0 && daysAgo < 7) dayBuckets[6 - daysAgo]! += r.cost_cents ?? 0;
    }

    const modelBreakdown: Record<string, number> = {};
    for (const r of monthRows) { const k = r.model ?? "unknown"; modelBreakdown[k] = (modelBreakdown[k] ?? 0) + 1; }

    return {
      monthCostDollars: combinedCostDollars(monthRows),
      monthInputTokens: monthRows.reduce((s, r) => s + (r.input_tokens ?? 0), 0),
      monthOutputTokens: monthRows.reduce((s, r) => s + (r.output_tokens ?? 0), 0),
      todayCalls: todayRows.length,
      monthCalls: monthRows.length,
      dailyCents7: dayBuckets,
      modelBreakdown,
      recentRuns: (recentRuns.data ?? []) as RunRow[],
      latestAlert: alertState.data?.value ?? null,
    };
  } catch {
    return { monthCostDollars: 0, monthInputTokens: 0, monthOutputTokens: 0, todayCalls: 0, monthCalls: 0, dailyCents7: Array(7).fill(0), modelBreakdown: {}, recentRuns: [], latestAlert: null };
  }
}

async function getServiceUsage(period: string) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (createAdminClient() as any).from("service_usage").select("service,metric,count").eq("period", period);
    type Row = { service: string; metric: string; count: number };
    const rows: Row[] = data ?? [];
    const get = (svc: string, metric: string) => rows.find((r) => r.service === svc && r.metric === metric)?.count ?? 0;
    return { mapboxLoads: get("mapbox", "map_load") };
  } catch {
    return { mapboxLoads: 0 };
  }
}

async function getPageViewAnalytics() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  try {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const [summary, topPages, sources, devices, countries, bots, topOfficials, topProposals, todayAll, todayHuman] =
      await Promise.all([
        db.rpc("get_pv_summary"),
        db.rpc("get_pv_top_pages", { lim: 8 }),
        db.rpc("get_pv_sources"),
        db.rpc("get_pv_devices"),
        db.rpc("get_pv_countries", { lim: 8 }),
        db.rpc("get_pv_bots"),
        db.rpc("get_pv_top_officials", { lim: 5 }),
        db.rpc("get_pv_top_proposals", { lim: 5 }),
        db.from("page_views").select("*", { count: "exact", head: true }).gte("viewed_at", todayStart.toISOString()),
        db.from("page_views").select("*", { count: "exact", head: true }).gte("viewed_at", todayStart.toISOString()).eq("is_bot", false),
      ]);

    type SummaryRow = { total_views: number; human_views: number; bot_views: number };
    type PageRow    = { page: string; views: number; unique_sessions: number };
    type SourceRow  = { referrer: string; visits: number };
    type DeviceRow  = { device_type: string; count: number };
    type CountryRow = { country_code: string; count: number };
    type BotRow     = { visitor_type: string; count: number };
    type OfficialRow = { official_id: string; full_name: string; role_title: string; views: number };
    type ProposalRow = { proposal_id: string; title: string; views: number };

    const s: SummaryRow = summary.data?.[0] ?? { total_views: 0, human_views: 0, bot_views: 0 };
    return {
      totalViews:      Number(s.total_views),
      humanViews:      Number(s.human_views),
      botViews:        Number(s.bot_views),
      todayTotalViews: todayAll.count ?? 0,
      todayHumanViews: todayHuman.count ?? 0,
      topPages:        (topPages.data ?? [])     as PageRow[],
      sources:         (sources.data ?? [])      as SourceRow[],
      devices:         (devices.data ?? [])      as DeviceRow[],
      countries:       (countries.data ?? [])    as CountryRow[],
      bots:            (bots.data ?? [])         as BotRow[],
      topOfficials:    (topOfficials.data ?? [])  as OfficialRow[],
      topProposals:    (topProposals.data ?? [])  as ProposalRow[],
    };
  } catch {
    return {
      totalViews: 0, humanViews: 0, botViews: 0,
      todayTotalViews: 0, todayHumanViews: 0,
      topPages: [], sources: [], devices: [], countries: [],
      bots: [], topOfficials: [], topProposals: [],
    };
  }
}

async function getSiteActivity(period: string) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = createAdminClient() as any;
    const monthStart = new Date();
    monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

    const [svcRows, graphShares, aiSummaries, comments] = await Promise.all([
      db.from("service_usage").select("service,metric,count").eq("period", period),
      db.from("graph_snapshots").select("*", { count: "exact", head: true }).gte("created_at", monthStart.toISOString()),
      db.from("ai_summary_cache").select("*", { count: "exact", head: true }),
      db.from("official_comment_submissions").select("*", { count: "exact", head: true }).gte("created_at", monthStart.toISOString()),
    ]);

    type SvcRow = { service: string; metric: string; count: number };
    const rows: SvcRow[] = svcRows.data ?? [];
    const get = (svc: string, metric: string) => rows.find((r) => r.service === svc && r.metric === metric)?.count ?? 0;

    return {
      mapActivations: get("mapbox", "map_activated"),
      graphShares: graphShares.count ?? 0,
      aiSummaries: aiSummaries.count ?? 0,
      commentsDrafted: comments.count ?? 0,
    };
  } catch {
    return { mapActivations: 0, graphShares: 0, aiSummaries: 0, commentsDrafted: 0 };
  }
}

async function getCloudflareR2Stats() {
  const token = process.env["CLOUDFLARE_API_TOKEN"];
  const accountId = process.env["CLOUDFLARE_ACCOUNT_ID"];
  if (!token || !accountId) return null;
  try {
    const bucket = process.env["CLOUDFLARE_R2_BUCKET_DOCUMENTS"] ?? "civitics-documents";
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/usage`,
      { headers: { Authorization: `Bearer ${token}` }, next: { revalidate: 300 } }
    );
    if (!res.ok) return null;
    const json = await res.json();
    return { objectCount: json.result?.objectCount ?? 0, payloadBytes: json.result?.payloadSize ?? 0 };
  } catch {
    return null;
  }
}


// Reads the most recent completed run per pipeline from data_sync_log
async function getSyncLog() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (createAdminClient() as any)
      .from("data_sync_log")
      .select("pipeline,status,completed_at,rows_inserted,rows_updated,estimated_mb,error_message")
      .eq("status", "complete")
      .order("completed_at", { ascending: false });

    type Row = {
      pipeline: string;
      status: string;
      completed_at: string;
      rows_inserted: number;
      rows_updated: number;
      estimated_mb: string | null;
      error_message: string | null;
    };
    const rows: Row[] = data ?? [];

    // Keep only the most recent run per pipeline
    const seen = new Set<string>();
    const latest: Row[] = [];
    for (const row of rows) {
      if (!seen.has(row.pipeline)) {
        seen.add(row.pipeline);
        latest.push(row);
      }
    }
    return latest;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Helper components
// ---------------------------------------------------------------------------

type StatusLevel = "green" | "yellow" | "orange" | "red" | "gray";

function StatusDot({ level }: { level: StatusLevel }) {
  const colors: Record<StatusLevel, string> = {
    green: "bg-emerald-500", yellow: "bg-yellow-400",
    orange: "bg-orange-400", red: "bg-red-500", gray: "bg-gray-300",
  };
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${colors[level]} shrink-0`} />;
}

function statusFromPercent(pct: number): StatusLevel {
  if (pct >= 95) return "red";
  if (pct >= 80) return "orange";
  if (pct >= 60) return "yellow";
  return "green";
}

function ProgressBar({ label, used, total, unit, upgradeNote }: {
  label: string; used: number; total: number; unit: string; upgradeNote?: string;
}) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const level = statusFromPercent(pct);
  const barColors: Record<StatusLevel, string> = {
    green: "bg-emerald-500", yellow: "bg-yellow-400",
    orange: "bg-orange-400", red: "bg-red-500", gray: "bg-gray-300",
  };
  const fmt = (v: number) => {
    if (unit === "MB") return `${(v / 1024 / 1024).toFixed(1)} MB`;
    if (unit === "GB") return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
    if (unit === "bytes") return v < 1024 * 1024 ? `${(v / 1024).toFixed(0)} KB` : `${(v / 1024 / 1024).toFixed(1)} MB`;
    return `${v.toLocaleString()} ${unit}`;
  };
  const fmtTotal = (v: number) => {
    if (unit === "MB") return `${(v / 1024 / 1024).toFixed(0)} MB`;
    if (unit === "GB") return `${(v / 1024 / 1024 / 1024).toFixed(0)} GB`;
    if (unit === "bytes") return `${(v / 1024 / 1024 / 1024).toFixed(0)} GB`;
    return `${v.toLocaleString()} ${unit}`;
  };
  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-gray-700">{label}</span>
        <span className="tabular-nums text-gray-500">{fmt(used)} / {fmtTotal(total)} ({pct}%)</span>
      </div>
      <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-gray-100">
        <div className={`h-full rounded-full transition-all ${barColors[level]}`} style={{ width: `${pct}%` }} />
      </div>
      {upgradeNote && pct >= 80 && (
        <p className="mt-1 text-xs text-orange-600">{upgradeNote}</p>
      )}
    </div>
  );
}

function BudgetBar({ label, spentCents, budgetCents }: {
  label: string; spentCents: number; budgetCents: number;
}) {
  const pct = budgetCents > 0 ? Math.min(100, Math.round((spentCents / budgetCents) * 100)) : 0;
  const level = statusFromPercent(pct);
  const barColors: Record<StatusLevel, string> = {
    green: "bg-emerald-500", yellow: "bg-yellow-400",
    orange: "bg-orange-400", red: "bg-red-500", gray: "bg-gray-300",
  };
  const fmt = (c: number) => `$${(c / 100).toFixed(2)}`;
  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-gray-700">{label}</span>
        <span className="tabular-nums text-gray-500">{fmt(spentCents)} / {fmt(budgetCents)} ({pct}%)</span>
      </div>
      <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-gray-100">
        <div className={`h-full rounded-full transition-all ${barColors[level]}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Sparkline({ values, maxVal }: { values: number[]; maxVal: number }) {
  const h = 24;
  const w = 80;
  const n = values.length;
  if (n === 0) return null;
  const points = values
    .map((v, i) => {
      const x = (i / Math.max(n - 1, 1)) * w;
      const y = maxVal > 0 ? h - (v / maxVal) * h : h;
      return `${x},${y}`;
    })
    .join(" ");
  return (
    <svg width={w} height={h} className="overflow-visible">
      <polyline points={points} fill="none" stroke="#6366f1" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function formatCost(dollars: number): string {
  if (dollars === 0) return "$0.00";
  if (dollars < 0.001) return `$${dollars.toFixed(5)}`;
  if (dollars < 0.01)  return `$${dollars.toFixed(4)}`;
  if (dollars < 0.10)  return `$${dollars.toFixed(3)}`;
  return `$${dollars.toFixed(2)}`;
}

function ServiceCard({
  name, cost, level, note, children,
}: {
  name: string; cost: string; level: StatusLevel; note?: string; children: React.ReactNode;
}) {
  const labelMap: Record<StatusLevel, string> = {
    green: "Healthy", yellow: "Watch", orange: "Plan upgrade", red: "Urgent", gray: "No data",
  };
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <StatusDot level={level} />
          <span className="text-sm font-semibold text-gray-900">{name}</span>
          <span className="text-xs text-gray-400">{labelMap[level]}</span>
        </div>
        <span className="text-sm font-bold tabular-nums text-gray-700">{cost}/mo</span>
      </div>
      {children}
      {note && <p className="text-xs text-gray-400 italic">{note}</p>}
    </div>
  );
}

function PhaseBar({ label, pct, done }: { label: string; pct: number; done?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-20 shrink-0 text-xs font-medium text-gray-600">{label}</span>
      <div className="flex-1 h-2 overflow-hidden rounded-full bg-gray-100">
        <div className={`h-full rounded-full ${done ? "bg-emerald-500" : "bg-indigo-500"}`} style={{ width: `${pct}%` }} />
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

// Canonical pipeline keys and display labels for the Data Freshness section
const PIPELINES: Array<{ key: string; label: string }> = [
  { key: "congress",      label: "Congress.gov — officials + votes" },
  { key: "fec_bulk",      label: "FEC Campaign Finance" },
  { key: "usaspending",   label: "USASpending.gov — contracts + grants" },
  { key: "regulations",   label: "Regulations.gov — proposals + comment periods" },
  { key: "openstates",    label: "OpenStates — state legislators" },
  { key: "courtlistener", label: "CourtListener — judges + rulings" },
];

// Normalize any pipeline name variant → canonical key used in PIPELINES above
function normalizePipeline(name: string): string {
  const n = name.toLowerCase().replace(/-/g, "_");
  if (n === "congress_gov" || n === "congress") return "congress";
  if (n === "fec_bulk" || n === "fec") return "fec_bulk";
  if (n === "usaspending" || n === "usa_spending") return "usaspending";
  if (n === "regulations_gov" || n === "regulations") return "regulations";
  if (n === "openstates" || n === "open_states") return "openstates";
  if (n === "courtlistener" || n === "court_listener") return "courtlistener";
  if (n === "nightly_cron" || n === "nightly") return "nightly_cron";
  if (n === "connections" || n === "entity_connections") return "connections";
  return n;
}

function FreshnessRow({
  label,
  lastSync,
  inserted,
  updated,
  estimatedMb,
}: {
  label: string;
  lastSync: string | null;
  inserted: number;
  updated: number;
  estimatedMb: string | null;
}) {
  const synced = !!lastSync;
  const level: StatusLevel = synced ? "green" : "gray";

  const fmt = (ts: string) =>
    new Date(ts).toLocaleString("en-US", {
      month: "short", day: "numeric", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });

  const recordsNote = synced
    ? `+${inserted.toLocaleString()} inserted · ${updated.toLocaleString()} updated${estimatedMb ? ` · ${estimatedMb} MB` : ""}`
    : undefined;

  return (
    <div className="flex items-start justify-between gap-4 py-3 border-b border-gray-100 last:border-0">
      <div className="flex items-start gap-2.5">
        <StatusDot level={level} />
        <p className="text-sm font-medium text-gray-800">{label}</p>
      </div>
      <div className="text-right shrink-0">
        {synced ? (
          <>
            <p className="text-xs tabular-nums text-gray-600">
              Last sync: {fmt(lastSync!)}
            </p>
            {recordsNote && (
              <p className="text-xs text-gray-400">{recordsNote}</p>
            )}
          </>
        ) : (
          <p className="text-xs text-gray-400">Never synced</p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 1 tasks — mirrors PHASE_GOALS.md (update as tasks complete)
// ---------------------------------------------------------------------------

const PHASE1_TASKS = [
  // Data Pipelines
  { label: "Congress.gov → officials + votes",              done: true  },
  { label: "FEC bulk pipeline → financial_relationships",   done: true  },
  { label: "Financial entities pipeline",                   done: true  },
  { label: "USASpending.gov → spending_records",            done: true  },
  { label: "Regulations.gov → proposals + comment periods", done: true  },
  { label: "OpenStates → state legislators",                done: true  },
  { label: "CourtListener → judges + rulings",              done: true  },
  { label: "Entity connections pipeline",                   done: true  },
  { label: "Delta connections runner",                      done: true  },
  { label: "Nightly sync + master orchestrator",            done: true  },
  { label: "Sync log tracking (data_sync_log)",             done: true  },
  // Core Pages
  { label: "Homepage wired to real data",                   done: true  },
  { label: "Officials list + detail page",                  done: true  },
  { label: "Agency list + detail page",                     done: true  },
  { label: "Proposals list + detail page",                  done: true  },
  { label: "Search — officials, proposals, agencies",       done: true  },
  { label: "Public accountability dashboard",               done: true  },
  // Graph
  { label: "Connection graph with D3 force simulation",     done: true  },
  { label: "Share codes + screenshot export",               done: true  },
  { label: "Preset views + filter + customize panel",       done: true  },
  { label: "Smart expansion + depth control",               done: true  },
  // Maps
  { label: "Mapbox + district finder",                      done: true  },
  // AI
  { label: "Anthropic API + plain language summaries",      done: true  },
  // Infrastructure
  { label: "Cloudflare R2 storage configured",              done: true  },
  { label: "Vercel cron + nightly sync schedule",           done: true  },
  { label: "Entity tagging — rules + AI + UI + filters",    done: true  },
  { label: "Self-hosted page view analytics",               done: true  },
  { label: "Vercel Analytics + Speed Insights",             done: true  },
  // Auth
  { label: "User auth — magic link + OAuth",                done: true  },
  // Remaining
  { label: "AI narrative — Explain this graph",             done: false },
  { label: "Credit system + personalized AI queries",       done: false },
  { label: "Community — commenting, positions, follows",    done: false },
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function DashboardPage() {
  const fetchedAt = new Date();
  const period = `${fetchedAt.getFullYear()}-${String(fetchedAt.getMonth() + 1).padStart(2, "0")}`;

  // Admin check — server-side; never exposed to client
  let isAdmin = false;
  try {
    const adminEmail = process.env["ADMIN_EMAIL"];
    if (adminEmail) {
      const supabase = createServerClient(cookies());
      const { data: { user } } = await supabase.auth.getUser();
      isAdmin = user?.email === adminEmail;
    }
  } catch {
    // Non-critical — default to false
  }

  const [dbBytes, ai, svcUsage, r2Stats, siteActivity, pv, syncLog] = await Promise.all([
    getDatabaseSizeBytes(),
    getAnthropicUsage(),
    getServiceUsage(period),
    getCloudflareR2Stats(),
    getSiteActivity(period),
    getPageViewAnalytics(),
    getSyncLog(),
  ]);

  // Build pipeline map for Data Freshness section — normalize names to canonical keys
  type SyncRow = {
    pipeline: string;
    completed_at: string;
    rows_inserted: number;
    rows_updated: number;
    estimated_mb: string | null;
  };
  const syncMap: Record<string, SyncRow> = {};
  for (const r of syncLog as SyncRow[]) {
    const key = normalizePipeline(r.pipeline);
    // getSyncLog already returns rows ordered desc by completed_at and deduped by
    // original name, so the first hit per canonical key is the most recent run.
    if (!syncMap[key]) syncMap[key] = r;
  }

  // Supabase free tier limits
  const DB_FREE_LIMIT = 500 * 1024 * 1024;        // 500 MB
  const BW_FREE_LIMIT = 5 * 1024 * 1024 * 1024;   // 5 GB

  // Anthropic budget — $3.50 hard cap (matches cost-config.ts)
  const ANTHROPIC_BUDGET_DOLLARS = 3.50;
  const aiRemainingDollars = Math.max(0, ANTHROPIC_BUDGET_DOLLARS - ai.monthCostDollars);
  const aiSpentPct = Math.min(100, Math.round((ai.monthCostDollars / ANTHROPIC_BUDGET_DOLLARS) * 100));

  // Mapbox free tier
  const MAPBOX_FREE_LOADS = 50_000;
  const mapboxPct = Math.round((svcUsage.mapboxLoads / MAPBOX_FREE_LOADS) * 100);

  const R2_FREE_BYTES = 10 * 1024 * 1024 * 1024;

  const dbLevel = statusFromPercent(dbBytes > 0 ? Math.round((dbBytes / DB_FREE_LIMIT) * 100) : 0);
  const aiLevel = statusFromPercent(aiSpentPct);
  const r2Level = r2Stats ? statusFromPercent(Math.round((r2Stats.payloadBytes / R2_FREE_BYTES) * 100)) : "gray" as StatusLevel;
  const mapboxLevel = statusFromPercent(mapboxPct);
  // If this page is loading, Vercel is up
  const vercelLevel: StatusLevel = "green";

  const vercelEnv = process.env["VERCEL_ENV"] ?? process.env["NODE_ENV"] ?? "development";
  const vercelSha = process.env["VERCEL_GIT_COMMIT_SHA"] ?? null;

  const phase1Done = PHASE1_TASKS.filter((t) => t.done).length;
  const phase1Pct  = Math.round((phase1Done / PHASE1_TASKS.length) * 100);

  const sparkMax = Math.max(...ai.dailyCents7, 0.01);

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
                <span className="text-sm font-medium text-gray-500 hover:text-gray-800 transition-colors">Civitics</span>
              </a>
              <span className="text-gray-300">/</span>
              <span className="text-sm font-semibold text-gray-900">Platform Dashboard</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <span>Updated:</span>
              <DashboardAutoRefresh intervalMs={60_000} />
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-8">

          {/* ── 1. SITE OVERVIEW ────────────────────────────────────────────── */}
          <section>
            <SectionHeader
              title="Site Overview"
              description="Live counts — refreshed every 60 seconds from the production database."
            />
            <DashboardStatsSection />

            {/* Site Activity — self-hosted analytics */}
            <div className="mt-4 rounded-lg border border-gray-200 bg-white p-5 space-y-5">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-gray-900">Site Activity — self-hosted, privacy-first, no cookies</p>
                <span className="text-xs text-gray-400">this month</span>
              </div>

              {pv.totalViews === 0 ? (
                <p className="text-xs text-gray-400">No page views recorded yet — tracking activates on first visitor after deploy.</p>
              ) : (
                <>
                  {/* Summary row */}
                  <div className="grid grid-cols-2 gap-4 border-b border-gray-100 pb-4 sm:grid-cols-5">
                    <div>
                      <p className="text-2xl font-bold tabular-nums text-gray-900">{pv.todayHumanViews.toLocaleString()}</p>
                      <p className="text-xs text-gray-500 mt-0.5">Human visits today</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold tabular-nums text-gray-900">{pv.todayTotalViews.toLocaleString()}</p>
                      <p className="text-xs text-gray-500 mt-0.5">Page views today</p>
                    </div>
                    <div className="sm:col-span-1 border-l border-gray-100 sm:pl-4">
                      <p className="text-2xl font-bold tabular-nums text-gray-900">{pv.humanViews.toLocaleString()}</p>
                      <p className="text-xs text-gray-500 mt-0.5">Human visits (month)</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold tabular-nums text-gray-900">{pv.totalViews.toLocaleString()}</p>
                      <p className="text-xs text-gray-500 mt-0.5">Total views (month)</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold tabular-nums text-gray-900">{pv.botViews.toLocaleString()}</p>
                      <p className="text-xs text-gray-500 mt-0.5">Bot visits ({pv.totalViews > 0 ? Math.round((pv.botViews / pv.totalViews) * 100) : 0}%)</p>
                    </div>
                  </div>

                  <div className="grid gap-5 sm:grid-cols-2">
                    {/* Top pages */}
                    {pv.topPages.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">Top pages</p>
                        <div className="space-y-1">
                          {pv.topPages.map((r) => (
                            <div key={r.page} className="flex items-center justify-between text-xs">
                              <span className="font-mono text-gray-600 truncate max-w-[160px]">{r.page}</span>
                              <span className="tabular-nums text-gray-500 shrink-0 ml-2">{Number(r.views).toLocaleString()} views</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Traffic sources + Devices */}
                    <div className="space-y-4">
                      {pv.sources.length > 0 && (
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">Traffic sources</p>
                          <div className="space-y-1">
                            {pv.sources.map((r) => {
                              const total = pv.sources.reduce((s, x) => s + Number(x.visits), 0);
                              const pct = total > 0 ? Math.round((Number(r.visits) / total) * 100) : 0;
                              return (
                                <div key={r.referrer} className="flex items-center justify-between text-xs">
                                  <span className="capitalize text-gray-600">{r.referrer}</span>
                                  <span className="tabular-nums text-gray-500">{pct}%</span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      {pv.devices.length > 0 && (
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">Devices</p>
                          <div className="space-y-1">
                            {pv.devices.map((r) => {
                              const total = pv.devices.reduce((s, x) => s + Number(x.count), 0);
                              const pct = total > 0 ? Math.round((Number(r.count) / total) * 100) : 0;
                              return (
                                <div key={r.device_type} className="flex items-center justify-between text-xs">
                                  <span className="capitalize text-gray-600">{r.device_type}</span>
                                  <span className="tabular-nums text-gray-500">{pct}%</span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Top countries */}
                    {pv.countries.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">Top countries</p>
                        <div className="space-y-1">
                          {pv.countries.map((r) => (
                            <div key={r.country_code} className="flex items-center justify-between text-xs">
                              <span className="text-gray-600">{r.country_code}</span>
                              <span className="tabular-nums text-gray-500">{Number(r.count).toLocaleString()}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Engagement */}
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">Civic engagement</p>
                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-gray-600">Map activations</span>
                          <span className="tabular-nums text-gray-500">{siteActivity.mapActivations.toLocaleString()}</span>
                        </div>
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-gray-600">Graph shares</span>
                          <span className="tabular-nums text-gray-500">{siteActivity.graphShares.toLocaleString()}</span>
                        </div>
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-gray-600">AI summaries cached</span>
                          <span className="tabular-nums text-gray-500">{siteActivity.aiSummaries.toLocaleString()}</span>
                        </div>
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-gray-600">Comments drafted</span>
                          <span className="tabular-nums text-gray-500">{siteActivity.commentsDrafted.toLocaleString()}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Most viewed entities */}
                  {(pv.topOfficials.length > 0 || pv.topProposals.length > 0) && (
                    <div className="grid gap-5 sm:grid-cols-2 border-t border-gray-100 pt-4">
                      {pv.topOfficials.length > 0 && (
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">Most viewed officials (30d)</p>
                          <div className="space-y-1">
                            {pv.topOfficials.map((r) => (
                              <div key={r.official_id} className="flex items-center justify-between text-xs">
                                <span className="text-gray-600 truncate max-w-[160px]">{r.full_name}</span>
                                <span className="tabular-nums text-gray-500 shrink-0 ml-2">{Number(r.views).toLocaleString()}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {pv.topProposals.length > 0 && (
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">Most viewed proposals (30d)</p>
                          <div className="space-y-1">
                            {pv.topProposals.map((r) => (
                              <div key={r.proposal_id} className="flex items-center justify-between text-xs">
                                <span className="text-gray-600 truncate max-w-[180px]">{r.title}</span>
                                <span className="tabular-nums text-gray-500 shrink-0 ml-2">{Number(r.views).toLocaleString()}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              <p className="text-xs text-gray-400 italic border-t border-gray-100 pt-3">
                All analytics are self-hosted. No third-party tracking. No cookies. No fingerprinting.
                Session IDs reset when you close your browser. Raw data deleted after 90 days.
              </p>
            </div>
          </section>

          {/* ── 2. BILLING MONITOR ──────────────────────────────────────────── */}
          <section>
            <SectionHeader
              title="Monthly Spend Tracker"
              description="All costs transparent and publicly visible. Every dollar logged."
            />

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">

              {/* Supabase */}
              <ServiceCard name="Supabase" cost="$0.00" level={dbLevel} note="Upgrade to Pro ($25/mo) when DB hits 400 MB">
                <ProgressBar label="Database" used={dbBytes} total={DB_FREE_LIMIT} unit="MB" />
                <ProgressBar label="Bandwidth (est.)" used={0} total={BW_FREE_LIMIT} unit="GB" />
              </ServiceCard>

              {/* Anthropic */}
              <ServiceCard
                name="Anthropic"
                cost={formatCost(ai.monthCostDollars)}
                level={aiLevel}
                note="Hard cap: $3.50/month. Cost gate enforced before every pipeline run."
              >
                {/* Alert banner */}
                {ai.latestAlert && (ai.latestAlert.level === "warning" || ai.latestAlert.level === "urgent" || ai.latestAlert.level === "blocked") && (
                  <div className={`rounded border px-3 py-2 text-xs ${
                    ai.latestAlert.level === "blocked" ? "border-red-200 bg-red-50 text-red-700"
                    : ai.latestAlert.level === "urgent" ? "border-orange-200 bg-orange-50 text-orange-700"
                    : "border-yellow-200 bg-yellow-50 text-yellow-700"
                  }`}>
                    {ai.latestAlert.level === "blocked" ? "🚫" : ai.latestAlert.level === "urgent" ? "🚨" : "⚠️"}{" "}
                    {ai.latestAlert.message}
                  </div>
                )}

                <div className="flex items-center justify-between text-xs text-gray-500">
                  <span>{ai.monthCalls.toLocaleString()} calls this month</span>
                  <span className="tabular-nums font-medium text-gray-700">
                    ${aiRemainingDollars.toFixed(2)} remaining
                  </span>
                </div>
                <BudgetBar label="Monthly budget ($3.50)" spentCents={Math.round(ai.monthCostDollars * 100)} budgetCents={350} />
                {ai.monthInputTokens > 0 || ai.monthOutputTokens > 0 ? (
                  <div className="space-y-0.5 pt-1">
                    <p className="text-[11px] text-gray-400 tabular-nums">
                      Input: {ai.monthInputTokens.toLocaleString()} tokens
                      {" · "}${((ai.monthInputTokens * 0.25) / 1_000_000).toFixed(4)}
                    </p>
                    <p className="text-[11px] text-gray-400 tabular-nums">
                      Output: {ai.monthOutputTokens.toLocaleString()} tokens
                      {" · "}${((ai.monthOutputTokens * 1.25) / 1_000_000).toFixed(4)}
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-gray-400">No AI calls yet this month</p>
                )}

                {/* Pipeline run history */}
                {ai.recentRuns.length > 0 && (
                  <div className="pt-1">
                    <p className="text-[11px] font-medium text-gray-500 mb-1">Recent pipeline runs</p>
                    <div className="space-y-1">
                      {ai.recentRuns.slice(0, 5).map((run, i) => {
                        const variance = run.variance_ratio;
                        const hasLargeVariance = variance !== null && variance > 1.5;
                        const estStr = run.estimated_cost_usd != null ? `$${Number(run.estimated_cost_usd).toFixed(4)}` : "—";
                        const actStr = run.actual_cost_usd != null ? `$${Number(run.actual_cost_usd).toFixed(4)}` : "—";
                        const varStr = variance != null
                          ? `${variance > 1 ? "+" : ""}${((variance - 1) * 100).toFixed(0)}%`
                          : null;
                        return (
                          <div key={i} className="flex items-center justify-between text-[11px] tabular-nums">
                            <span className="text-gray-600 truncate max-w-[120px]">{run.pipeline_name}</span>
                            <span className="text-gray-400 mx-1">est {estStr}</span>
                            <span className="text-gray-700">{actStr}</span>
                            {varStr && (
                              <span className={`ml-1 font-medium ${hasLargeVariance ? "text-orange-600" : "text-gray-400"}`}>
                                {varStr}{hasLargeVariance ? " ⚠" : ""}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Admin-only: budget controls */}
                {isAdmin && (
                  <div className="pt-2 border-t border-gray-100 space-y-1.5">
                    <p className="text-[11px] font-medium text-gray-500">Budget Settings (admin)</p>
                    <BudgetControlForm />
                  </div>
                )}
              </ServiceCard>

              {/* Cloudflare R2 */}
              <ServiceCard name="Cloudflare R2" cost="$0.00" level={r2Level} note="Egress is always free — no bandwidth charges ever.">
                {r2Stats ? (
                  <>
                    <ProgressBar label="Storage (documents)" used={r2Stats.payloadBytes} total={R2_FREE_BYTES} unit="bytes" />
                    <p className="text-xs text-gray-500 tabular-nums">
                      {r2Stats.objectCount.toLocaleString()} objects stored
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-gray-400">
                    ⚠ Add <code className="rounded bg-gray-100 px-1 font-mono text-[11px]">CLOUDFLARE_API_TOKEN</code> to enable live stats.
                  </p>
                )}
              </ServiceCard>

              {/* Mapbox */}
              <ServiceCard name="Mapbox" cost="$0.00" level={mapboxLevel} note="50k map loads/month free. Alert at 40k.">
                <ProgressBar
                  label="Map loads"
                  used={svcUsage.mapboxLoads}
                  total={MAPBOX_FREE_LOADS}
                  unit="loads"
                  upgradeNote="Approaching free tier — at $0.50/1k after 50k"
                />
                <p className="text-xs text-gray-400">
                  Tracked via <code className="rounded bg-gray-100 px-1 font-mono text-[11px]">service_usage</code> table
                </p>
              </ServiceCard>

              {/* Vercel */}
              <ServiceCard name="Vercel" cost="$0.00" level={vercelLevel} note="Hobby plan: 100 GB bandwidth · 6,000 build minutes/month">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-500">Status</span>
                  <span className="font-medium text-emerald-600">Live</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-500">Environment</span>
                  <span className="tabular-nums text-gray-700">{vercelEnv}</span>
                </div>
                {vercelSha && (
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-500">Commit</span>
                    <span className="font-mono text-gray-700">{vercelSha.slice(0, 7)}</span>
                  </div>
                )}
                <p className="text-xs text-gray-400">Plan: Hobby (Free)</p>
              </ServiceCard>

              {/* Resend */}
              <ServiceCard name="Resend" cost="$0.00" level="gray" note="Email not yet active. 3,000 emails/month free.">
                <p className="text-xs text-gray-400">Email integration pending (Phase 2).</p>
              </ServiceCard>

            </div>

            <div className="mt-3 text-xs text-gray-400">
              Color:{" "}
              <span className="text-emerald-600 font-medium">● 0–60% healthy</span>
              {" · "}
              <span className="text-yellow-600 font-medium">● 60–80% watch</span>
              {" · "}
              <span className="text-orange-600 font-medium">● 80–95% plan upgrade</span>
              {" · "}
              <span className="text-red-600 font-medium">● 95%+ urgent</span>
            </div>
          </section>

          {/* ── 3. DATA FRESHNESS ──────────────────────────────────────────── */}
          <section>
            <SectionHeader
              title="Data Freshness"
              description="Most recent completed sync per pipeline. Target: daily at 2am."
            />
            <div className="rounded-lg border border-gray-200 bg-white px-5 divide-y divide-gray-100">
              {PIPELINES.map(({ key, label }) => {
                const entry = syncMap[key] as SyncRow | undefined;
                return (
                  <FreshnessRow
                    key={key}
                    label={label}
                    lastSync={entry?.completed_at ?? null}
                    inserted={entry?.rows_inserted ?? 0}
                    updated={entry?.rows_updated ?? 0}
                    estimatedMb={entry?.estimated_mb ?? null}
                  />
                );
              })}
            </div>
          </section>

          {/* ── 4. PIPELINE OPERATIONS ─────────────────────────────────────── */}
          <PipelineOpsSection isAdmin={isAdmin} />

          {/* ── 5. DEVELOPMENT PROGRESS ─────────────────────────────────────── */}
          <section>
            <SectionHeader
              title="Development Progress"
              description="Phased build plan. Phase 1 unlocks Phase 2."
            />
            <div className="rounded-lg border border-gray-200 bg-white p-5">
              <div className="space-y-3">
                <PhaseBar label="Phase 0" pct={100} done />
                <PhaseBar label="Phase 1" pct={phase1Pct} />
                <PhaseBar label="Phase 2" pct={0} />
                <PhaseBar label="Phase 3" pct={0} />
                <PhaseBar label="Phase 4" pct={0} />
                <PhaseBar label="Phase 5" pct={0} />
              </div>
              <div className="mt-6 border-t border-gray-100 pt-5">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">
                  Phase 1 tasks ({phase1Done}/{PHASE1_TASKS.length} complete — {phase1Pct}%)
                </p>
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  {PHASE1_TASKS.map((task) => (
                    <div key={task.label} className="flex items-center gap-2">
                      {task.done ? (
                        <span className="text-emerald-500 text-xs">✓</span>
                      ) : (
                        <span className="text-gray-300 text-xs">○</span>
                      )}
                      <span className={`text-xs ${task.done ? "text-gray-700" : "text-gray-400"}`}>
                        {task.label}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>

          {/* ── 6. COMPUTE POOL ────────────────────────────────────────────── */}
          <section>
            <SectionHeader
              title="Community Compute Pool"
              description="Phase 4 — launches with blockchain integration on Optimism."
            />
            <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-6 text-center">
              <p className="text-sm font-medium text-gray-600">
                Community-funded development compute launches in Phase 4 with blockchain integration
              </p>
              <p className="mt-1 text-sm text-gray-400">
                Every dollar donated and every dollar spent will be tracked on-chain and visible here in real time.
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

          {/* ── 7. TRANSPARENCY FOOTER ─────────────────────────────────────── */}
          <section>
            <div className="rounded-lg border border-indigo-100 bg-indigo-50 p-6">
              <h2 className="text-sm font-semibold text-indigo-900">Why this dashboard exists</h2>
              <p className="mt-2 text-sm text-indigo-800 leading-relaxed">
                Every dollar spent building Civitics is tracked here. Every API call logged.
                Every cost visible. We hold ourselves to the same standard of transparency
                we demand from government.
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
            <a href="/" className="text-xs text-indigo-600 hover:text-indigo-700">← Back to Civitics</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
