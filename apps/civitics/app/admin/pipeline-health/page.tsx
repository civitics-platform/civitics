// Reads pipeline_runtime_stats_mv (admin-only). Force-dynamic because the page
// is gated on the signed-in user's email and createAdminClient() needs the
// secret key at request time.
export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { createServerClient, createAdminClient } from "@civitics/db";
import { PageHeader, SectionCard, SectionHeader } from "@civitics/ui";

export const metadata = { title: "Pipeline Health | Admin" };

type PipelineStatRow = {
  pipeline: string;
  runs_30d: number | null;
  successful_runs_30d: number | null;
  success_rate_pct: number | null;
  p50_duration_ms: number | null;
  p95_duration_ms: number | null;
  max_duration_ms: number | null;
  last_run_at: string | null;
  max_peak_rss_mb: number | null;
  p95_peak_rss_mb: number | null;
};

// Tiering against the 60-min GHA job cap. The amber band gives ~30 min of
// headroom before red, which matches a single doubling of pipeline duration.
const RED_MS   = 50 * 60 * 1000; // 50 min — within 10 min of the cap
const AMBER_MS = 30 * 60 * 1000; // 30 min — halfway to the cap

function p95ClassName(ms: number | null): string {
  if (ms == null) return "text-gray-400";
  if (ms >= RED_MS)   return "text-red-600 font-semibold tabular-nums";
  if (ms >= AMBER_MS) return "text-amber-600 font-medium tabular-nums";
  return "text-gray-700 tabular-nums";
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
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
  // Cast to any: pipeline_runtime_stats_mv is a new MV not yet in generated TS
  // types. The shape is fully covered by PipelineStatRow above. A type
  // regeneration follow-up after the migration lands on prod is on the list.
  const { data, error } = await admin
    .from("pipeline_runtime_stats_mv")
    .select(
      "pipeline,runs_30d,successful_runs_30d,success_rate_pct,p50_duration_ms,p95_duration_ms,max_duration_ms,last_run_at,max_peak_rss_mb,p95_peak_rss_mb"
    )
    .order("p95_duration_ms", { ascending: false, nullsFirst: false });

  const rows: PipelineStatRow[] = error ? [] : (data ?? []);

  return (
    <div className="min-h-screen bg-gray-50">
      <main id="main-content">
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          <PageHeader
            title="Pipeline Health"
            description="Per-pipeline duration trends over the last 30 days. Watching p95 against the 60-min GitHub Actions job cap before it bites."
            breadcrumb={[
              { label: "Civitics", href: "/" },
              { label: "Admin" },
              { label: "Pipeline Health" },
            ]}
          />

          <SectionCard noPadding>
            <div className="p-6 border-b border-gray-100">
              <SectionHeader
                title="30-day runtime stats"
                description={
                  <span>
                    Amber if p95 ≥ 30 min, red if p95 ≥ 50 min. RSS columns will populate
                    once Stage 7b instrumentation lands.
                  </span>
                }
              />
            </div>

            {rows.length === 0 ? (
              <div className="p-8 text-center text-sm text-gray-500">
                No pipeline runs in the last 30 days. The MV may not have been refreshed yet —
                run <code className="px-1 py-0.5 bg-gray-100 rounded text-xs">SELECT refresh_pipeline_runtime_stats_mv();</code> or wait for the nightly cron.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-xs uppercase tracking-wider text-gray-500">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium">Pipeline</th>
                      <th className="px-4 py-3 text-right font-medium">Last run</th>
                      <th className="px-4 py-3 text-right font-medium">30d runs</th>
                      <th className="px-4 py-3 text-right font-medium">Success %</th>
                      <th className="px-4 py-3 text-right font-medium">p50</th>
                      <th className="px-4 py-3 text-right font-medium">p95</th>
                      <th className="px-4 py-3 text-right font-medium">Max</th>
                      <th className="px-4 py-3 text-right font-medium">p95 RSS</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {rows.map((r) => (
                      <tr key={r.pipeline} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium text-gray-900">{r.pipeline}</td>
                        <td className="px-4 py-3 text-right text-gray-600 tabular-nums">{formatLastRun(r.last_run_at)}</td>
                        <td className="px-4 py-3 text-right text-gray-700 tabular-nums">{r.runs_30d ?? "—"}</td>
                        <td className="px-4 py-3 text-right text-gray-700 tabular-nums">
                          {r.success_rate_pct == null ? "—" : `${r.success_rate_pct}%`}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-700 tabular-nums">{formatDuration(r.p50_duration_ms)}</td>
                        <td className={`px-4 py-3 text-right ${p95ClassName(r.p95_duration_ms)}`}>
                          {formatDuration(r.p95_duration_ms)}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-700 tabular-nums">{formatDuration(r.max_duration_ms)}</td>
                        <td className="px-4 py-3 text-right text-gray-600 tabular-nums">{formatRss(r.p95_peak_rss_mb)}</td>
                      </tr>
                    ))}
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
