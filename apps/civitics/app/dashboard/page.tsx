// Dashboard uses createAdminClient() which needs the secret key — secret key
// is unavailable at Vercel build time, so the page must be force-dynamic to
// avoid build-time evaluation. CDN caching is done via the Cache-Control
// rule for /dashboard in next.config.mjs (30 min s-maxage + SWR), which gives
// us most of the ISR benefit without depending on build-time data fetching.
export const dynamic = "force-dynamic";

import { createAdminClient } from "@civitics/db";
import { PageHeader, TabBar } from "@civitics/ui";
import { DashboardClient } from "./DashboardClient";
import { KillSwitchBanner } from "./KillSwitchBanner";
import { SitemapSection } from "./SitemapSection";
import { BrowsingFlowsSection, type PathTransition, type EntryPage } from "./BrowsingFlowsSection";
import { ModerationSection } from "./ModerationSection";
import { PageViewTracker } from "../components/PageViewTracker";
import {
  computeStatusPayload,
  readStatusSnapshot,
  SNAPSHOT_STALE_MS,
  SNAPSHOT_FALLBACK_TIMEOUT_MS,
} from "../api/claude/status/_lib/status-snapshot";
import { withDbTimeout } from "@/lib/supabase-check";
import type { StatusData } from "./useDashboardData";

// No "| Civitics" suffix here — the root layout's title template is
// "%s | Civitics", so writing it in the page title too rendered
// "Platform Transparency | Civitics | Civitics" on prod (FIX-1076).
export const metadata = { title: "Platform Transparency" };

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
    const { data } = await withDbTimeout(
      db
        .from("proposals")
        .select("id,title,metadata")
        .eq("status", "open_comment")
        .gt("metadata->>comment_period_end", now)
        .lt("metadata->>comment_period_end", in30)
        .order("metadata->>comment_period_end", { ascending: true })
        .limit(3) as PromiseLike<{ data: { id: string; title: string; metadata: Record<string, unknown> | null }[] | null }>,
      3000,
      "dashboard:open-proposals",
    );
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
//
// FIX-1077: this was `count: "planned"`, which returns the planner's row
// estimate rather than a count. The planner has no cross-column statistics
// for `status = 'open_comment'` AND a JSONB-path comparison on
// `metadata->>comment_period_end`, so it multiplies two independent
// selectivity guesses and bottoms out at `Plan Rows: 1` — on BOTH local and
// prod. The card rendered a literal "1" against a true 220 (local) / 314
// (prod). `count: "exact"` measured 96 ms local / 32 ms prod under the same
// filters, comfortably inside the 3 s budget below, so it needs no
// materialization. Note the FIX-206 precedent (cheap `estimated` counts)
// applies to UNFILTERED big-table counts, where the estimate is
// `pg_class.reltuples`; on a filtered count there is no such shortcut.
async function getOpenProposalCount(): Promise<number> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = createAdminClient() as any;
    const now = new Date().toISOString();
    const { count } = await withDbTimeout(
      db
        .from("proposals")
        .select("*", { count: "exact", head: true })
        .eq("status", "open_comment")
        .gt("metadata->>comment_period_end", now) as PromiseLike<{ count: number | null }>,
      3000,
      "dashboard:open-proposal-count",
    );
    return count ?? 0;
  } catch {
    return 0;
  }
}

// Pre-fetch the same status payload that useDashboardData would otherwise
// pull client-side via /api/claude/status/{core,quality}. Reads from the
// 10-min status_snapshot (FIX-297), falling back to a live recompute when
// the snapshot is missing or older than SNAPSHOT_STALE_MS (4 h since FIX-327;
// this comment said 30 min until FIX-1094). Same source of truth the
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
    // FIX-1094: carry the snapshot's own write time separately from `timestamp`
    // so DashboardClient's staleness cue has something real to measure. Null on
    // the live-recompute branch — there is no snapshot behind that payload, and
    // a recompute is by definition zero seconds old.
    let fetchedAt: string | null = null;
    if (fresh && snapshot) {
      payload = snapshot.payload;
      computeMs = snapshot.query_time_ms;
      timestamp = snapshot.fetched_at;
      fetchedAt = snapshot.fetched_at;
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
        fetchedAt = snapshot.fetched_at;
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
        fetched_at: fetchedAt,
        from_snapshot: fetchedAt != null,
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
      // FIX-090 — stat-card sparkline series. `as any` matches the rest of this
      // block; undefined on a pre-FIX-090 snapshot, which the cards handle.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      daily_counts: payload.daily_counts as any,
    };
  } catch {
    return null;
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
      withDbTimeout(
        db.rpc("get_pv_top_transitions", { lim: 12, min_count: 3, days: 30 }) as PromiseLike<{
          data: { from_page: string; to_page: string; sessions: number | string }[] | null;
        }>,
        3000,
        "dashboard:pv-top-transitions",
      ),
      withDbTimeout(
        db.rpc("get_pv_entry_pages", { lim: 6, days: 30 }) as PromiseLike<{
          data: { page: string; sessions: number | string }[] | null;
        }>,
        3000,
        "dashboard:pv-entry-pages",
      ),
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

  // FIX-347: dashboard is edge-cached for 30 min, so any admin-only content
  // baked into the SSR HTML leaks to anon visitors for the cache lifetime.
  // KillSwitchBanner / ModerationSection / PlatformCostsSection admin
  // surfaces all fetch client-side on mount, gated by /api/admin/me.
  const [openProposals, openProposalCount, browsingFlows, initialStatus] = await Promise.all([
    getOpenProposals(),
    getOpenProposalCount(),
    isOps ? getBrowsingFlows() : Promise.resolve({ transitions: [] as PathTransition[], entryPages: [] as EntryPage[] }),
    getInitialStatus(),
  ]);

  return (
    // Terminal Wave 1 (FIX-720): everything below the site masthead is a dark
    // live instrument. The data-theme scope re-binds every semantic token, so
    // bg-paper renders as term-bg and the tokenized @civitics/ui components
    // (FIX-719) go dark without forking. text-ink must be restated here so the
    // inherited body color re-resolves inside the scope.
    <div data-theme="terminal" className="min-h-screen bg-paper text-ink">
      <PageViewTracker entityType="dashboard" />
      <main id="main-content">
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          <p className="mb-3 flex items-center gap-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.22em] text-amber">
            <span className="h-[7px] w-[7px] animate-pulse rounded-full bg-amber motion-reduce:animate-none" />
            Platform transparency — Live
          </p>
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

          <KillSwitchBanner />

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
