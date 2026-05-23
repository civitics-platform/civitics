// Dashboard uses createAdminClient() which needs the secret key — secret key
// is unavailable at Vercel build time, so the page must be force-dynamic to
// avoid build-time evaluation. CDN caching is done via the Cache-Control
// rule for /dashboard in next.config.mjs (30 min s-maxage + SWR), which gives
// us most of the ISR benefit without depending on build-time data fetching.
export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { createAdminClient, createServerClient } from "@civitics/db";
import { PageHeader, TabBar } from "@civitics/ui";
import { DashboardClient } from "./DashboardClient";
import { KillSwitchBanner, type KillSwitchEvent } from "./KillSwitchBanner";
import { SitemapSection } from "./SitemapSection";
import { BrowsingFlowsSection, type PathTransition, type EntryPage } from "./BrowsingFlowsSection";
import { ModerationSection } from "./ModerationSection";
import { ManualMetricsPanel, type ManualMetric } from "./ManualMetricsPanel";
import { PageViewTracker } from "../components/PageViewTracker";
import {
  computeStatusPayload,
  readStatusSnapshot,
  SNAPSHOT_STALE_MS,
  SNAPSHOT_FALLBACK_TIMEOUT_MS,
} from "../api/claude/status/_lib/status-snapshot";
import { withDbTimeout } from "@/lib/supabase-check";
import type { StatusData } from "./useDashboardData";

export const metadata = { title: "Platform Transparency | Civitics" };

// ── Server-side data fetching ─────────────────────────────────────────────────

type OpenProposal = {
  id: string;
  title: string;
  agency: string;
  comment_period_end: string;
};

// `comment_period_end` lives in `metadata`, NOT as a top-level column on
// `proposals` (verified against a live `open_comment` row, FIX-206).
// PostgREST: `metadata->>comment_period_end` for filter / order, and
// `metadata->comment_period_end` to read it back through .select().
async function getOpenProposals(): Promise<OpenProposal[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = createAdminClient() as any;
    const now = new Date().toISOString();
    const in30 = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const { data } = await db
      .from("proposals")
      .select("id,title,metadata")
      .eq("status", "open_comment")
      .gt("metadata->>comment_period_end", now)
      .lt("metadata->>comment_period_end", in30)
      .order("metadata->>comment_period_end", { ascending: true })
      .limit(3);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data ?? []).map((p: any) => ({
      id: p.id as string,
      title: p.title as string,
      agency: (p.metadata?.agency_id as string | undefined) ?? "Federal Agency",
      comment_period_end: (p.metadata?.comment_period_end as string) ?? "",
    }));
  } catch {
    return [];
  }
}

// Total count of regulations currently in their comment-period window.
// Separate from getOpenProposals above (which limits to 3 for display).
async function getOpenProposalCount(): Promise<number> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = createAdminClient() as any;
    const now = new Date().toISOString();
    const { count } = await db
      .from("proposals")
      .select("*", { count: "planned", head: true })
      .eq("status", "open_comment")
      .gt("metadata->>comment_period_end", now);
    return count ?? 0;
  } catch {
    return 0;
  }
}

// Pre-fetch the same status payload that useDashboardData would otherwise
// pull client-side via /api/claude/status/{core,quality}. Reads from the
// 10-min status_snapshot (FIX-297), falling back to a live recompute when
// the snapshot is missing or older than 30 min. Same source of truth the
// two status routes use, so SSR and the in-hook background refresh produce
// identical shapes.
//
// The platform/usage and platform/anthropic endpoints are NOT prefetched
// here: anthropic hits an external Admin API on every miss (slow + flaky),
// and usage is non-critical for LCP. The hook still pulls them client-side.
async function getInitialStatus(): Promise<StatusData | null> {
  try {
    const db = createAdminClient();
    const now = new Date();

    const snapshot = await withDbTimeout<Awaited<ReturnType<typeof readStatusSnapshot>>>(
      readStatusSnapshot(db),
      2000,
    );
    const fresh =
      snapshot &&
      Date.now() - new Date(snapshot.fetched_at).getTime() < SNAPSHOT_STALE_MS;

    let payload;
    let computeMs: number;
    let timestamp: string;
    if (fresh && snapshot) {
      payload = snapshot.payload;
      computeMs = snapshot.query_time_ms;
      timestamp = snapshot.fetched_at;
    } else {
      // FIX-327: cap live-compute fallback at 5 s. Prod observed
      // computeStatusPayload taking 30+ s — unbounded fallback turned every
      // stale-snapshot SSR into a 30-s hang. On timeout, serve the
      // last-known-good snapshot if we have one; only return null when
      // there is no snapshot row at all.
      const TIMEOUT = Symbol("status-fallback-timeout");
      const result = await Promise.race<
        Awaited<ReturnType<typeof computeStatusPayload>> | typeof TIMEOUT
      >([
        computeStatusPayload(db),
        new Promise<typeof TIMEOUT>((resolve) =>
          setTimeout(() => resolve(TIMEOUT), SNAPSHOT_FALLBACK_TIMEOUT_MS),
        ),
      ]);
      if (result === TIMEOUT) {
        console.warn(
          "[dashboard.getInitialStatus] live-compute fallback timed out after",
          SNAPSHOT_FALLBACK_TIMEOUT_MS,
          "ms — serving stale snapshot",
          snapshot ? { fetched_at: snapshot.fetched_at } : { snapshot: null },
        );
        if (!snapshot) return null;
        payload = snapshot.payload;
        computeMs = snapshot.query_time_ms;
        timestamp = snapshot.fetched_at;
      } else {
        console.warn(
          "[dashboard.getInitialStatus] snapshot missing or stale, served live recompute",
          snapshot ? { fetched_at: snapshot.fetched_at } : { snapshot: null },
        );
        payload = result.payload;
        computeMs = result.query_time_ms;
        timestamp = now.toISOString();
      }
    }

    return {
      meta: {
        query_time_ms: computeMs,
        timestamp,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      version: payload.version as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      database: payload.database as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pipelines: payload.pipelines as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ai_costs: payload.ai_costs as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      quality: payload.quality as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      self_tests: payload.self_tests as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      activity: payload.activity as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      officials_breakdown: payload.officials_breakdown as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chord: payload.chord as any,
    };
  } catch {
    return null;
  }
}

// FIX-287: recent kill-switch flips for the admin-only banner. One-hour
// window matches the dashboard's normal refresh cadence (operators dismiss
// what they've acted on; old flips just age out instead of growing a list).
// Only OFF flips surface — re-enables are non-events for an "operator
// awareness" surface (a re-enable means someone already knew and acted).
async function getRecentKillSwitchEvents(): Promise<KillSwitchEvent[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = createAdminClient() as any;
    const { data } = await db
      .from("kill_switch_events")
      .select(
        "id, switch_name, trigger_metric, trigger_value, threshold_pct, flipped_to, source, flipped_at",
      )
      .gte("flipped_at", new Date(Date.now() - 3_600_000).toISOString())
      .eq("flipped_to", false)
      .order("flipped_at", { ascending: false })
      .limit(10);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data ?? []).map((r: any) => ({
      id: r.id as number,
      switch_name: r.switch_name as string,
      trigger_metric: (r.trigger_metric as string | null) ?? null,
      trigger_value: r.trigger_value === null ? null : Number(r.trigger_value),
      threshold_pct: (r.threshold_pct as number | null) ?? null,
      flipped_to: r.flipped_to as boolean,
      source: r.source as "auto" | "manual",
      flipped_at: r.flipped_at as string,
    }));
  } catch {
    return [];
  }
}

// FIX-296: pulls the platform_usage rows that have no public API path so
// the operator-facing ManualMetricsPanel can render them with a freshness
// badge. Joins to platform_limits to honor has_public_api=false as the
// canonical filter — manual rows with has_public_api=true are scraper-
// backlog items, not "must be hand-entered" items.
async function getManualMetrics(): Promise<ManualMetric[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = createAdminClient() as any;
    const monthStart = new Date(
      new Date().getFullYear(),
      new Date().getMonth(),
      1,
    ).toISOString();

    const [usageRes, limitsRes] = await Promise.all([
      db
        .from("platform_usage")
        .select(
          "service, metric, value, verified_at, stale_after_days, source",
        )
        .eq("source", "manual")
        .eq("period_start", monthStart),
      db
        .from("platform_limits")
        .select("service, metric, display_label, unit, has_public_api")
        .eq("has_public_api", false)
        .eq("is_active", true),
    ]);

    const limits = (limitsRes.data ?? []) as Array<{
      service: string;
      metric: string;
      display_label: string | null;
      unit: string;
      has_public_api: boolean;
    }>;
    const usageRows = (usageRes.data ?? []) as Array<{
      service: string;
      metric: string;
      value: number | null;
      verified_at: string | null;
      stale_after_days: number | null;
    }>;
    const usageByKey = new Map(
      usageRows.map((u) => [`${u.service}:${u.metric}`, u]),
    );

    return limits.map((lim) => {
      const usage = usageByKey.get(`${lim.service}:${lim.metric}`);
      const days =
        usage?.verified_at
          ? Math.floor(
              (Date.now() - new Date(usage.verified_at).getTime()) / 86_400_000,
            )
          : null;
      return {
        service: lim.service,
        metric: lim.metric,
        display_label: lim.display_label ?? lim.metric,
        unit: lim.unit,
        value: usage?.value ?? null,
        verified_at: usage?.verified_at ?? null,
        stale_after_days: usage?.stale_after_days ?? null,
        days_since_verified: days,
      };
    });
  } catch {
    return [];
  }
}

async function getBrowsingFlows(): Promise<{
  transitions: PathTransition[];
  entryPages: EntryPage[];
}> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = createAdminClient() as any;
    const [{ data: tRows }, { data: eRows }] = await Promise.all([
      db.rpc("get_pv_top_transitions", { lim: 12, min_count: 3, days: 30 }),
      db.rpc("get_pv_entry_pages", { lim: 6, days: 30 }),
    ]);
    type TRow = { from_page: string; to_page: string; sessions: number | string };
    type ERow = { page: string; sessions: number | string };
    const transitions: PathTransition[] = (tRows ?? []).map((r: TRow) => ({
      from_page: r.from_page,
      to_page: r.to_page,
      sessions: Number(r.sessions),
    }));
    const entryPages: EntryPage[] = (eRows ?? []).map((r: ERow) => ({
      page: r.page,
      sessions: Number(r.sessions),
    }));
    return { transitions, entryPages };
  } catch {
    return { transitions: [], entryPages: [] };
  }
}

// ── Tab config ────────────────────────────────────────────────────────────────

const DASHBOARD_TABS = [
  { id: "transparency", label: "Transparency", href: "?tab=transparency" },
  { id: "operations",   label: "Operations",   href: "?tab=operations" },
];

// ── Page ─────────────────────────────────────────────────────────────────────

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: { tab?: string };
}) {
  const tab = searchParams?.tab === "operations" ? "operations" : "transparency";
  const isOps = tab === "operations";

  // FIX-287: kill-switch banner is admin-only + operations-tab-only. Cheap
  // server-context user lookup gates the kill_switch_events read so anon
  // pageviews don't pay for it.
  const adminEmail = process.env["ADMIN_EMAIL"];
  let isAdmin = false;
  if (adminEmail) {
    try {
      const cookieStore = await cookies();
      const supabase = createServerClient(cookieStore);
      const { data: { user } } = await supabase.auth.getUser();
      isAdmin = !!user && user.email === adminEmail;
    } catch {
      isAdmin = false;
    }
  }
  const showKillSwitchBanner = isAdmin && isOps;

  // FIX-296: manual metrics are admin + operations-tab only — same gate as
  // the kill-switch banner. Skips the query entirely on Transparency
  // pageviews and anon sessions.
  const showManualMetrics = isAdmin && isOps;

  const [openProposals, openProposalCount, browsingFlows, initialStatus, killSwitchEvents, manualMetrics] = await Promise.all([
    getOpenProposals(),
    getOpenProposalCount(),
    isOps ? getBrowsingFlows() : Promise.resolve({ transitions: [] as PathTransition[], entryPages: [] as EntryPage[] }),
    getInitialStatus(),
    showKillSwitchBanner ? getRecentKillSwitchEvents() : Promise.resolve([] as KillSwitchEvent[]),
    showManualMetrics ? getManualMetrics() : Promise.resolve([] as ManualMetric[]),
  ]);

  return (
    <div className="min-h-screen bg-gray-50">
      <PageViewTracker entityType="dashboard" />
      <main id="main-content">
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          <PageHeader
            title="Platform Transparency"
            description="Live data on what Civitics tracks, how pipelines are performing, and what the platform costs to run. This page is our receipt."
            breadcrumb={[
              { label: "Civitics", href: "/" },
              { label: "Transparency" },
            ]}
          />

          <div className="mb-6">
            <TabBar tabs={DASHBOARD_TABS} activeTab={tab} />
          </div>

          {showKillSwitchBanner && (
            <KillSwitchBanner events={killSwitchEvents} />
          )}

          <DashboardClient
            openProposals={openProposals}
            openProposalCount={openProposalCount}
            tab={tab}
            initialStatus={initialStatus}
          />

          {/* Transparency-only: Sitemap */}
          {!isOps && (
            <div className="mt-6">
              <SitemapSection />
            </div>
          )}

          {/* Operations-only: Browsing Flows + Moderation */}
          {isOps && (
            <div className="mt-6 space-y-6">
              {showManualMetrics && manualMetrics.length > 0 && (
                <ManualMetricsPanel metrics={manualMetrics} />
              )}
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <BrowsingFlowsSection
                  transitions={browsingFlows.transitions}
                  entryPages={browsingFlows.entryPages}
                />
              </div>
              <ModerationSection />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
