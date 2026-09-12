// Reads pipeline_runtime_stats_mv (admin-only). Force-dynamic because the page
// is gated on the signed-in user's email and createAdminClient() needs the
// secret key at request time.
export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { createServerClient, createAdminClient } from "@civitics/db";
import { PageHeader, SectionCard, SectionHeader } from "@civitics/ui";
import {
  budgetTone,
  fetchCronJobBudgets,
  fetchPipelineRuntimeStats,
  formatDurationMs,
  PIPELINE_BUDGET_REFS,
  resolveBudget,
  type PipelineRuntimeStatRow,
  type ResolvedBudget,
} from "@/lib/pipeline-runtime-stats";

export const metadata = { title: "Pipeline Health | Admin" };

// FIX-1083 — this page used to tier p95 against a flat 50-min red line,
// described as "the 60-min GitHub Actions job cap". Both halves were wrong:
//
//   * No GHA job in this repo carries timeout-minutes: 60. The nightly phases
//     are 90–150, fec-backfill is 350, irs990 is 90.
//   * The heavy work is not on GHA at all any more. It migrated into pg_cron
//     procedures (FIX-687 onward) bounded by per-job budgets in the
//     `cron_job_budget` table (FIX-1063/1071).
//
// The consequence was that every heavy pipeline sat permanently red and the
// colour carried no information: entity_connections_rebuild's p95 is 6.07 h and
// that is its DESIGNED behaviour under a 5 h budget with resume. Tiering is now
// proportional to each pipeline's own budget, read live from the table.
function p95ClassName(
  ms: number | null,
  budget: ResolvedBudget | null,
): string {
  switch (budgetTone(ms, budget)) {
    case "red":
      return "text-accent font-semibold tabular-nums";
    case "amber":
      return "text-ink font-medium tabular-nums";
    default:
      return "text-ink-soft tabular-nums";
  }
}

function formatBudget(budget: ResolvedBudget | null): string {
  if (!budget) return "—";
  return formatDurationMs(budget.seconds * 1000);
}

function formatRss(mb: number | null): string {
  return mb == null ? "—" : `${mb} MB`;
}

function formatLastRun(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffHours < 1) return "just now";
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * FIX-950 — the shape `public.prod_session_state()` returns, narrowed to what
 * the tile renders. Declared locally rather than imported from @civitics/data:
 * this is an app page, and the only contract between them is the four keys
 * below, which the function's SQL comment names.
 */
type ProdSessionTile = {
  held: boolean;
  label_stale: boolean;
  reason: string | null;
  claimed_by: string | null;
  age_seconds: number | null;
  expected_minutes: number | null;
  live_writers: string[] | null;
};

function formatHoldAge(seconds: number | null): string {
  if (seconds == null) return "unknown";
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/**
 * Rendered only while something is true — a held session or a dead label. On an
 * ordinary day this returns null and the page is exactly as it was, which is
 * the point: a tile that is always there is a tile nobody reads.
 */
function ProdSessionBanner({ session }: { session: ProdSessionTile | null }) {
  if (!session || (!session.held && !session.label_stale)) return null;

  const stale = !session.held && session.label_stale;
  const writers = session.live_writers ?? [];
  const expected = session.expected_minutes;
  const over =
    !stale && expected != null && session.age_seconds != null
      ? session.age_seconds > expected * 120
      : false;

  return (
    <div
      className={`mb-6 rounded-md border px-4 py-3 text-sm ${
        stale ? "border-rule bg-paper text-ink-soft" : "border-accent bg-paper text-ink"
      }`}
    >
      <p className="font-semibold">
        {stale
          ? "Stale prod-session label — nobody is actually holding the box"
          : `Supervised prod session held${over ? " — OVER ESTIMATE" : ""}`}
      </p>
      <p className="mt-1">
        {session.claimed_by ?? "someone"} · {formatHoldAge(session.age_seconds)}
        {expected != null ? ` of an expected ${expected}m` : ""} ·{" "}
        <span className="italic">{session.reason ?? "(no reason given)"}</span>
      </p>
      <p className="mt-1 text-ink-soft">
        {stale
          ? "The advisory lock is gone, so nothing is deferring. The next claim clears this row."
          : "Every guarded pg_cron writer and the nightly's writer phases are deferring with " +
            "this reason. Gaps in the table below are deliberate, not a regression."}
        {writers.length > 0 ? ` Claimed over: ${writers.join(", ")}.` : ""}
      </p>
    </div>
  );
}

export default async function PipelineHealthPage() {
  const adminEmail = process.env["ADMIN_EMAIL"];
  const cookieStore = await cookies();
  const supabase = createServerClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();

  // Treat as 404 for non-admins so the route isn't discoverable. Matches the
  // sign-in redirect surface area we use elsewhere without leaking that the
  // page exists.
  if (!adminEmail || !user || user.email !== adminEmail) {
    notFound();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;
  // FIX-1083: the MV read moved into @/lib/pipeline-runtime-stats so the public
  // Data Health card reads the same definition. Both helpers swallow their
  // error and return empty, which is the same degradation the withDbTimeout
  // wrapper gave this page before.
  const [rows, cronBudgets, prodSession] = await Promise.all([
    fetchPipelineRuntimeStats(admin),
    fetchCronJobBudgets(admin),
    // FIX-950 — is a human holding the box right now? Every duration below is
    // read as evidence about the platform; while a supervised session is held,
    // the scheduled writers are standing down ON PURPOSE and a gap in this
    // table means nothing. Swallows its own error like the two helpers above:
    // a page that 500s because an interlock reader is unavailable is worse
    // than a page without one tile.
    admin
      .rpc("prod_session_state")
      .then((r: { data: ProdSessionTile | null }) => r.data ?? null)
      .catch(() => null),
  ]);

  const budgetFor = (pipeline: string) => resolveBudget(pipeline, cronBudgets);
  const runnerFor = (pipeline: string) =>
    PIPELINE_BUDGET_REFS[pipeline]?.runner ?? null;
  const runnerLabel: Record<string, string> = {
    pg_cron: "pg_cron",
    github_actions: "Actions",
    manual: "manual",
  };
  const typedRows: PipelineRuntimeStatRow[] = rows;

  return (
    <div className="min-h-screen bg-paper-2">
      <main id="main-content">
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          <PageHeader
            title="Pipeline Health"
            description="Per-pipeline duration trends over the last 30 days, tiered against each pipeline's own wall-clock budget — the pg_cron per-job budgets in cron_job_budget, or the workflow's timeout-minutes for the Actions jobs."
            breadcrumb={[
              { label: "Civitics", href: "/" },
              { label: "Admin" },
              { label: "Pipeline Health" },
            ]}
          />

          <ProdSessionBanner session={prodSession} />

          <SectionCard noPadding>
            <div className="p-6 border-b border-rule">
              <SectionHeader
                title="30-day runtime stats"
                description={
                  <span>
                    Amber at 60% of budget, red at 85% — proportional, so a 30-minute job
                    and a 5-hour one are judged by how close they are to being cancelled.
                    A pg_cron job with no row in <code>cron_job_budget</code> inherits the
                    6h cluster <code>statement_timeout</code>; Actions pipelines show a
                    budget only where the workflow&rsquo;s <code>timeout-minutes</code> is
                    unambiguous. {/* FIX-1083: the old note claimed RSS "will populate once
                    Stage 7b instrumentation lands". It landed — every Node pipeline
                    reports RSS (fec_bulk p95 6,078 MB, littlesis 3,198 MB). The blanks
                    are the pg_cron procedures, which have no Node process to measure. */}
                    RSS is reported by the Node pipelines only; in-database pg_cron
                    procedures have no process to measure and show &mdash;.
                  </span>
                }
              />
            </div>

            {rows.length === 0 ? (
              <div className="p-8 text-center text-sm text-ink-soft/70">
                No pipeline runs in the last 30 days. The MV may not have been refreshed yet —
                run <code className="px-1 py-0.5 bg-paper-2 rounded text-xs">SELECT refresh_pipeline_runtime_stats_mv();</code> or wait for the nightly cron.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-paper-2 text-xs uppercase tracking-wider text-ink-soft/70">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium">Pipeline</th>
                      <th className="px-4 py-3 text-left font-medium">Runner</th>
                      <th className="px-4 py-3 text-right font-medium">Last run</th>
                      <th className="px-4 py-3 text-right font-medium">30d runs</th>
                      <th className="px-4 py-3 text-right font-medium">Success %</th>
                      <th className="px-4 py-3 text-right font-medium">p50</th>
                      <th className="px-4 py-3 text-right font-medium">p95</th>
                      <th className="px-4 py-3 text-right font-medium">Budget</th>
                      <th className="px-4 py-3 text-right font-medium">Max</th>
                      <th className="px-4 py-3 text-right font-medium">p95 RSS</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-rule">
                    {typedRows.map((r) => {
                      const budget = budgetFor(r.pipeline);
                      const runner = runnerFor(r.pipeline);
                      return (
                        <tr key={r.pipeline} className="hover:bg-paper-2">
                          <td className="px-4 py-3 font-medium text-ink">{r.pipeline}</td>
                          <td className="px-4 py-3 text-ink-soft/70 text-xs">
                            {runner ? runnerLabel[runner] : "—"}
                          </td>
                          <td className="px-4 py-3 text-right text-ink-soft tabular-nums">{formatLastRun(r.last_run_at)}</td>
                          <td className="px-4 py-3 text-right text-ink-soft tabular-nums">{r.runs_30d ?? "—"}</td>
                          <td className="px-4 py-3 text-right text-ink-soft tabular-nums">
                            {r.success_rate_pct == null ? "—" : `${r.success_rate_pct}%`}
                          </td>
                          <td className="px-4 py-3 text-right text-ink-soft tabular-nums">{formatDurationMs(r.p50_duration_ms)}</td>
                          <td className={`px-4 py-3 text-right ${p95ClassName(r.p95_duration_ms, budget)}`}>
                            {formatDurationMs(r.p95_duration_ms)}
                          </td>
                          <td
                            className="px-4 py-3 text-right text-ink-soft/70 tabular-nums text-xs"
                            title={budget ? `from ${budget.source}` : "no budget known"}
                          >
                            {formatBudget(budget)}
                          </td>
                          <td className="px-4 py-3 text-right text-ink-soft tabular-nums">{formatDurationMs(r.max_duration_ms)}</td>
                          <td className="px-4 py-3 text-right text-ink-soft tabular-nums">{formatRss(r.p95_peak_rss_mb)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </div>
      </main>
    </div>
  );
}
