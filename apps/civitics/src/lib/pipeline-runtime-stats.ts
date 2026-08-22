// Shared reader + formatters for `pipeline_runtime_stats_mv` (FIX-233).
//
// FIX-1083 — this used to live entirely inside app/admin/pipeline-health/page.tsx.
// The public Data Health card now wants the same 30-day numbers (success rate,
// p95) next to each row, so the query, the row shape and the duration/budget
// formatting moved here and both surfaces read one definition.
//
// Deliberately dependency-free at module scope: DashboardClient.tsx is a client
// component and imports the formatters + the budget registry from here, so
// nothing in this file may import a server-only module. The DB read takes its
// client as a parameter for the same reason.
//
// The MV is refreshed by `refresh_derived_mvs('daily')` on pg_cron at 06:00 UTC
// (migration 20260703000000_fix715), so these numbers lag by up to a day. That
// is fine for a 30-day aggregate and is why nothing here is used for freshness
// verdicts — freshness comes from data_sync_log directly.

export type PipelineRuntimeStatRow = {
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

export const PIPELINE_RUNTIME_STAT_COLUMNS =
  "pipeline,runs_30d,successful_runs_30d,success_rate_pct,p50_duration_ms,p95_duration_ms,max_duration_ms,last_run_at,max_peak_rss_mb,p95_peak_rss_mb";

// The slim projection that rides on the public /api/claude/status payload.
// Kept to four fields on purpose: the dashboard shows "30d: N runs · X% ok"
// and nothing else, and the persisted status_snapshot blob should not carry
// columns no renderer reads.
export type PublicPipelineRuntimeStat = {
  runs_30d: number;
  success_rate_pct: number | null;
  p95_duration_ms: number | null;
};

export function toPublicRuntimeStats(
  rows: PipelineRuntimeStatRow[],
): Record<string, PublicPipelineRuntimeStat> {
  const out: Record<string, PublicPipelineRuntimeStat> = {};
  for (const r of rows) {
    out[r.pipeline] = {
      runs_30d: r.runs_30d ?? 0,
      success_rate_pct: r.success_rate_pct,
      p95_duration_ms: r.p95_duration_ms,
    };
  }
  return out;
}

// ── Duration formatting ──────────────────────────────────────────────────────

/**
 * Human duration for a millisecond span. Used for run durations on the public
 * dashboard and for p50/p95/max on the admin page.
 *
 * Deliberately not the old `M:SS` form: pg_cron procedures routinely run for
 * hours, and `363:15` is not readable as "6h 3m" by anyone.
 */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

/**
 * Duration of one data_sync_log row. Returns null when the run has no terminal
 * timestamp — a `running` row, or a `reaped` one (the reaper deliberately does
 * NOT stamp completed_at, FIX-944/979, because elapsed-since-started is an
 * upper bound on runtime and not a measurement). Rendering "—" for those is the
 * honest answer; rendering now() − started_at would be inventing a number.
 */
export function runDurationMs(run: {
  started_at?: string | null;
  completed_at?: string | null;
}): number | null {
  if (!run.started_at || !run.completed_at) return null;
  const start = new Date(run.started_at).getTime();
  const end = new Date(run.completed_at).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

// ── Runtime budgets ──────────────────────────────────────────────────────────
//
// FIX-1083 — the admin page used to tier p95 against a flat "60-min GitHub
// Actions job cap". That framing is dead twice over:
//
//   * the heavy work migrated to in-database pg_cron procedures (FIX-687
//     onward), which are bounded by per-job wall-clock budgets in the
//     `cron_job_budget` table (FIX-1063/1071) — 0.5 h to 5 h — and, absent a
//     row there, by the 6 h cluster statement_timeout;
//   * no GitHub Actions job in this repo has ever carried timeout-minutes: 60.
//     The nightly phases are 90–150, fec-backfill is 350, irs990 is 90.
//
// So a single global 50-min red line marked every heavy pipeline permanently
// red and told the operator nothing. Budgets are per-pipeline now, and the
// pg_cron ones are READ FROM THE TABLE rather than copied here — FIX-1063 made
// them a table precisely so re-tuning is an UPDATE, not a migration, and a
// hardcoded copy would drift the moment anyone re-tunes one.
//
// What IS static here is the display-layer mapping from a data_sync_log
// `pipeline` label to the runner that produces it. That mapping is not a
// budget; it is the same class of registration as the Data Health rows.

export type PipelineRunner = "pg_cron" | "github_actions" | "manual";

export type PipelineBudgetRef = {
  runner: PipelineRunner;
  /** cron.job.jobname(s) that write this pipeline label. Matched by NAME. */
  cronJobNames?: string[];
  /** Verified `timeout-minutes` for the GHA job that runs this pipeline. */
  ghaTimeoutMinutes?: number;
  /** Workflow file, for the operator who wants to go read it. */
  ghaWorkflow?: string;
};

/** The 6 h cluster statement_timeout every unbudgeted pg_cron job inherits. */
export const PGCRON_CEILING_SECONDS = 6 * 60 * 60;

/**
 * data_sync_log `pipeline` label → runner + budget source.
 *
 * pg_cron entries come from the 2026-08-22 prod census (`SELECT jobname,
 * schedule, command FROM cron.job` joined against distinct data_sync_log
 * pipeline labels). GHA timeouts are only listed where the number was read
 * directly out of the workflow file — the nightly-phase pipelines are marked
 * `github_actions` with no number because they inherit whichever phase job
 * happens to run them, and guessing the wrong phase is worse than showing "—".
 */
export const PIPELINE_BUDGET_REFS: Record<string, PipelineBudgetRef> = {
  entity_connections_rebuild: {
    runner: "pg_cron",
    cronJobNames: ["rebuild-ec-incremental-mon", "rebuild-ec-incremental"],
  },
  entity_connection_stats_rebuild: {
    runner: "pg_cron",
    cronJobNames: ["entity-connection-stats-rebuild"],
  },
  donor_rollup_refresh: { runner: "pg_cron", cronJobNames: ["donor-rollup-refresh"] },
  donor_party_rollup_refresh: {
    runner: "pg_cron",
    cronJobNames: ["donor-party-rollup-refresh"],
  },
  refresh_derived_mvs: {
    runner: "pg_cron",
    cronJobNames: ["refresh-derived-mvs-daily", "refresh-derived-mvs-weekly"],
  },
  run_rule_taggers: {
    runner: "pg_cron",
    cronJobNames: ["rule-taggers-daily", "rule-taggers-weekly"],
  },
  official_vote_stats_rebuild: { runner: "pg_cron", cronJobNames: ["vote-stats-refresh"] },
  contract_flow_rollups_rebuild: {
    runner: "pg_cron",
    cronJobNames: ["contract-flow-rollups-refresh"],
  },
  financial_entity_totals_refresh: {
    runner: "pg_cron",
    cronJobNames: ["financial-entity-totals-incremental"],
  },
  financial_entity_totals_reconcile: {
    runner: "pg_cron",
    cronJobNames: ["financial-entity-totals-reconcile"],
  },
  treemap_individuals_global_refresh: {
    runner: "pg_cron",
    cronJobNames: ["treemap-individuals-global-refresh"],
  },
  agency_staffing_rollup_refresh: {
    runner: "pg_cron",
    cronJobNames: ["agency-staffing-rollup-refresh"],
  },
  donation_edge_orphan_sweep: {
    runner: "pg_cron",
    cronJobNames: ["donation-edge-orphan-sweep"],
  },
  donor_rollup_orphan_sweep: {
    runner: "pg_cron",
    cronJobNames: ["donor-rollup-orphan-sweep"],
  },
  donor_party_rollup_orphan_sweep: {
    runner: "pg_cron",
    cronJobNames: ["donor-party-rollup-orphan-sweep"],
  },
  entity_connection_stats_orphan_sweep: {
    runner: "pg_cron",
    cronJobNames: ["entity-connection-stats-orphan-sweep"],
  },

  fec_bulk: {
    runner: "github_actions",
    ghaWorkflow: "fec-backfill.yml",
    ghaTimeoutMinutes: 350,
  },
  irs990: {
    runner: "github_actions",
    ghaWorkflow: "irs990.yml",
    ghaTimeoutMinutes: 90,
  },

  // Nightly-orchestrator pipelines: GHA, but the binding cap is whichever
  // phase job (fec 150 / enrichment-heavy 90 / enrichment-light 120 /
  // enrichment-tail 90) picked them up on that run.
  congress_officials: { runner: "github_actions", ghaWorkflow: "nightly.yml" },
  congress_votes: { runner: "github_actions", ghaWorkflow: "nightly.yml" },
  congress_committees: { runner: "github_actions", ghaWorkflow: "nightly.yml" },
  regulations: { runner: "github_actions", ghaWorkflow: "nightly.yml" },
  openstates: { runner: "github_actions", ghaWorkflow: "nightly.yml" },
  openstates_bulk_people: { runner: "github_actions", ghaWorkflow: "nightly.yml" },
  courtlistener: { runner: "github_actions", ghaWorkflow: "nightly.yml" },
  edgar: { runner: "github_actions", ghaWorkflow: "nightly.yml" },
  edgar_daily: { runner: "github_actions", ghaWorkflow: "nightly.yml" },
  littlesis: { runner: "github_actions", ghaWorkflow: "nightly.yml" },
  usaspending_bulk: { runner: "github_actions", ghaWorkflow: "nightly.yml" },
  usaspending_bulk_assistance: { runner: "github_actions", ghaWorkflow: "nightly.yml" },
  elections: { runner: "github_actions", ghaWorkflow: "nightly.yml" },
  plum_book: { runner: "github_actions", ghaWorkflow: "nightly.yml" },
  opm_fte: { runner: "github_actions", ghaWorkflow: "nightly.yml" },
  agencies_hierarchy: { runner: "github_actions", ghaWorkflow: "nightly.yml" },
  agency_leadership: { runner: "github_actions", ghaWorkflow: "nightly.yml" },
  agency_enrichment: { runner: "github_actions", ghaWorkflow: "nightly.yml" },
  tag_rules: { runner: "github_actions", ghaWorkflow: "nightly.yml" },
  tag_ai: { runner: "github_actions", ghaWorkflow: "nightly.yml" },
  ai_summaries: { runner: "github_actions", ghaWorkflow: "nightly.yml" },
};

export type ResolvedBudget = {
  seconds: number;
  /** Short provenance string for the UI, e.g. "cron_job_budget" or "6h ceiling". */
  source: string;
};

/**
 * Resolve the wall-clock budget a pipeline is actually held to.
 *
 * `cronBudgets` is the live `cron_job_budget` table keyed by jobname; pass an
 * empty map to fall back to the ceiling. When a label maps to two jobnames
 * (Mon/Wed EC, daily/weekly derived MVs) the LARGER budget wins — the row's p95
 * mixes both jobs' runs, so tiering against the tighter one would flag the
 * looser job's healthy runs.
 *
 * Returns null when nothing is known, which the UI renders as "—" rather than
 * inventing a bound.
 */
export function resolveBudget(
  pipeline: string,
  cronBudgets: Record<string, number>,
): ResolvedBudget | null {
  const ref = PIPELINE_BUDGET_REFS[pipeline];
  if (!ref) return null;

  if (ref.runner === "pg_cron") {
    let best: number | null = null;
    for (const name of ref.cronJobNames ?? []) {
      const secs = cronBudgets[name];
      if (secs != null && (best == null || secs > best)) best = secs;
    }
    if (best != null) return { seconds: best, source: "cron_job_budget" };
    return { seconds: PGCRON_CEILING_SECONDS, source: "6h pg_cron ceiling" };
  }

  if (ref.runner === "github_actions" && ref.ghaTimeoutMinutes != null) {
    return {
      seconds: ref.ghaTimeoutMinutes * 60,
      source: ref.ghaWorkflow ?? "github actions",
    };
  }

  return null;
}

/**
 * Tier a duration against its budget. Amber at 60% of budget, red at 85% —
 * proportional, so a 30-minute job and a 5-hour one are both judged by how
 * close they are to being cancelled rather than by an absolute clock.
 */
export function budgetTone(
  ms: number | null,
  budget: ResolvedBudget | null,
): "ok" | "amber" | "red" | "unknown" {
  if (ms == null || budget == null || budget.seconds <= 0) return "unknown";
  const used = ms / 1000 / budget.seconds;
  if (used >= 0.85) return "red";
  if (used >= 0.6) return "amber";
  return "ok";
}

// ── DB reads ─────────────────────────────────────────────────────────────────

// Both readers take the client as `any`: pipeline_runtime_stats_mv and
// cron_job_budget are not both present in the generated Database type, and the
// row shapes are fully covered by the types above.
/* eslint-disable @typescript-eslint/no-explicit-any */

export async function fetchPipelineRuntimeStats(
  db: any,
): Promise<PipelineRuntimeStatRow[]> {
  const { data, error } = await db
    .from("pipeline_runtime_stats_mv")
    .select(PIPELINE_RUNTIME_STAT_COLUMNS)
    .order("p95_duration_ms", { ascending: false, nullsFirst: false });
  if (error) return [];
  return (data ?? []) as PipelineRuntimeStatRow[];
}

/** Live pg_cron budgets keyed by jobname. Empty on any error — the caller
 *  falls back to the 6 h ceiling, which is what an unbudgeted job really has. */
export async function fetchCronJobBudgets(
  db: any,
): Promise<Record<string, number>> {
  const { data, error } = await db
    .from("cron_job_budget")
    .select("jobname,budget_seconds");
  if (error) return {};
  const out: Record<string, number> = {};
  for (const r of (data ?? []) as Array<{ jobname: string; budget_seconds: number }>) {
    out[r.jobname] = r.budget_seconds;
  }
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
