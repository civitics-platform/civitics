"use client";

import { useState, useEffect, useCallback } from "react";
import type { PlatformMetric } from "@civitics/db";

// ── Types matching /api/claude/status response ────────────────────────────────

type PartialError = { error: string; partial: true };

export type DatabaseStats = {
  officials: number;
  proposals: number;
  proposals_bills: number;
  proposals_regulations: number;
  votes: number;
  entity_connections: number;
  financial_relationships: number;
  financial_entities: number;
  entity_tags: number;
  ai_summary_cache: number;
  page_views_24h: number;
};

export type PipelineRun = {
  pipeline: string;
  status: string;
  completed_at: string;
  rows_inserted: number;
};

export type PipelineHistoryRun = {
  pipeline: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  rows_inserted: number;
  rows_updated: number;
  rows_failed: number;
  estimated_mb: number;
  error_message: string | null;
  // FIX-390: non-fatal seed warnings (FIX-386) ride on data_sync_log.metadata
  // (e.g. metadata.seed_warnings). Free-form JSONB, kept loose. Mirrors the
  // server-side PipelineHistoryRun in app/api/claude/status/_lib/sections.ts.
  metadata?: Record<string, unknown> | null;
};

// FIX-924: `in_progress` was a status value public.enrichment_queue never had
// (it belongs to the never-created shadow.enrichment_queue) so the count was
// always 0. Real vocabulary is pending | processing | done | failed + the two
// skipped_* statuses. `stale_processing` is the subset of `processing` whose
// claim is older than ENRICHMENT_STALE_CLAIM_MINUTES — an abandoned claim.
export type EnrichmentBacklog = {
  pending_tag: number;
  pending_summary: number;
  processing: number;
  stale_processing: number;
};

// FIX-1083: 30-day aggregates out of pipeline_runtime_stats_mv, keyed by the
// writer-side pipeline label. Mirrors PublicPipelineRuntimeStat in
// @/lib/pipeline-runtime-stats.
export type PipelineRuntimeStat = {
  runs_30d: number;
  success_rate_pct: number | null;
  p95_duration_ms: number | null;
};

export type PipelinesData = {
  recent_runs: PipelineRun[];
  cron_last_run: Record<string, unknown> | null;
  history: Record<string, PipelineHistoryRun[]>;
  // Optional: the dashboard renders a PERSISTED status_snapshot, so a snapshot
  // written before FIX-1083 deployed has no such key. Every read site must
  // tolerate its absence for the one-cron-tick window after a deploy.
  runtime_stats?: Record<string, PipelineRuntimeStat>;
  enrichment_backlog: EnrichmentBacklog;
};

type TokenPeriod = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
};

export type AiCosts = {
  monthly_spent_usd: number;
  monthly_budget_usd: number;
  budget_used_pct: number;
  month_start: string;
  last_hour_tokens?: number;
  last_24h_tokens?: number;
  last_24h_cost_usd?: number;
  source?: string;
  this_month_total_tokens?: number;
  last_hour?: TokenPeriod;
  last_24h?: TokenPeriod;
  this_month?: TokenPeriod;
};

export type QualityData = {
  fec_coverage: { total: number; has_fec: number; pct: number };
  missing_state: number;
  vote_categories: Array<{ vote_category: string; count: number }>;
  industry_tags: { total: number; tagged: number; pct: number };
  vote_connections: number;
};

export type SelfTest = {
  name: string;
  passed: boolean;
  detail: string;
};

export type ChordSectionData = {
  // from_id — raw industry key, added by FIX-1081. Optional here because a
  // CDN-cached /api/claude/status payload written before that change has rows
  // without it; the row's graph link falls back to the un-emphasized preset.
  top_flows: Array<{ from: string; from_id?: string; to: string; amount_usd: number }>;
  total_flow_usd: number;
};

export type ActivitySectionData = {
  page_views: number;
  lookback_days: number;
  top_pages: Array<{ path: string; views: number }>;
};

export type OfficialsBreakdown = {
  federal: number;
  state: number;
  judges: number;
} | null;

export type StatusData = {
  meta: { query_time_ms: number; timestamp: string };
  version: { commit_sha: string; env: string; latest_sync_at: string | null; latest_pipeline: string | null } | PartialError;
  database: DatabaseStats | PartialError;
  pipelines: PipelinesData | PartialError;
  ai_costs: AiCosts | PartialError;
  quality: QualityData | PartialError;
  self_tests: SelfTest[] | PartialError;
  chord?: ChordSectionData | PartialError;
  activity?: ActivitySectionData | PartialError;
  officials_breakdown?: OfficialsBreakdown | PartialError;
};

export type ChordFlow = {
  from: string;
  from_id?: string;
  to: string;
  amount_usd: number;
};

export type PlatformUsageResponse = {
  plan: string;
  metrics: PlatformMetric[];
  by_service: Record<string, PlatformMetric[]>;
  total_metrics: number;
  summary: {
    total_overage_cost: number;
    top3_by_pct: PlatformMetric[];
    top3_by_cost: PlatformMetric[];
    any_critical: boolean;
    any_warning: boolean;
    needs_verification: boolean;
    critical_count: number;
    warning_count: number;
    unverified_count: number;
  };
  // FIX-1044/1045/1046. All optional: the dashboard reads a PERSISTED snapshot
  // payload, so after a deploy these are absent until the next cron tick writes
  // a row in the new shape — which under GHA drift can be up to a couple of
  // hours. Every consumer below must render without them.
  cloudflare_edge?: {
    zone_id: string;
    latest: {
      hour: string;
      edge_requests: number;
      origin_requests: number;
      absorbed_requests: number;
      mitigated_pct: number;
    } | null;
    trip_threshold: number;
    fetched_at: string;
  };
  cf_mitigation?: {
    action: string;
    reason: string;
    observed_level: string | null;
    acted: boolean;
    write_error: string | null;
    tripped_at: string | null;
    previous_level: string | null;
    breach_hours: number;
    required_breach_hours: number;
    revert_after_hours: number;
    writes_enabled: boolean;
    // FIX-1047 — optional: absent until a snapshot written by that code lands.
    write_scope_confirmed?: boolean | null;
    write_scope_checked_at?: string | null;
    write_scope_detail?: string | null;
    threshold?: number;
    threshold_is_overridden?: boolean;
  };
  vercel_billing?: {
    gross_effective_mtd_usd: number;
    plan_base_mtd_usd: number;
    usage_mtd_usd: number;
    included_credit_usd: number;
    credit_remaining_usd: number;
    credit_used_pct: number;
    billable_overage_mtd_usd: number;
    projected_usage_usd: number;
    projected_billable_overage_usd: number;
    projected_total_bill_usd: number;
    projected_gross_usd: number;
    projectable: boolean;
  };
  burn_rate?: {
    latest_delta_usd: number | null;
    latest_mtd_day: number | null;
    trailing_median_usd: number | null;
    multiple: number | null;
    elevated: boolean;
    reason: string;
    history_days: number;
    projected_monthly_usd: number | null;
  };
  timestamp: string;
};

export type AnthropicTokenPeriod = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  cost_usd: number;
};

export type CacheMeta = {
  hit: boolean;
  age_minutes: number;
  recorded_at: string;
  source: string;
  stale?: boolean;
  error?: string;
};

export type AnthropicDetail = {
  last_hour: AnthropicTokenPeriod | null;
  last_24h: AnthropicTokenPeriod | null;
  this_month: (AnthropicTokenPeriod & {
    by_model: Array<{
      model: string;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
    }>;
  }) | null;
  source: string;
  fetched_at: string;
  cache?: CacheMeta;
};

export type DashboardData = {
  status: StatusData;
  chordFlows: ChordFlow[];
  platformUsage: PlatformUsageResponse | null;
  anthropicDetail: AnthropicDetail | null;
};

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useDashboardData(initialStatus?: StatusData | null) {
  // Seed state from server-prefetched status (FIX-204). Without this the
  // dashboard renders "Loading…" until the first fetch chain resolves; with
  // it, the user sees real database / AI / pipeline numbers on first paint.
  // The hook still polls in the background to keep things fresh.
  const initialData: DashboardData | null = initialStatus
    ? {
        status: initialStatus,
        chordFlows: extractChordFlows(initialStatus),
        platformUsage: null,
        anthropicDetail: null,
      }
    : null;
  const [data, setData] = useState<DashboardData | null>(initialData);
  const [loading, setLoading] = useState(!initialStatus);
  const [error, setError] = useState<string | null>(null);
  const [anthropicCacheAge, setAnthropicCacheAge] = useState<number | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [coreResult, qualityResult, usageResult, anthropicResult] = await Promise.allSettled([
        fetch("/api/claude/status/core"),
        fetch("/api/claude/status/quality"),
        fetch("/api/platform/usage"),
        fetch("/api/platform/anthropic"),
      ]);

      // /core failures bubble up — without it we can't render the dashboard at all.
      // /quality failures degrade gracefully into per-section partial: true placeholders.
      if (coreResult.status === "rejected") throw new Error(coreResult.reason);
      const coreRes = coreResult.value;
      if (!coreRes.ok) throw new Error(`HTTP ${coreRes.status}`);
      const core = (await coreRes.json()) as Partial<StatusData> & { meta: StatusData["meta"] };

      let quality: Partial<StatusData> = {};
      if (qualityResult.status === "fulfilled" && qualityResult.value.ok) {
        try {
          quality = (await qualityResult.value.json()) as Partial<StatusData>;
        } catch {
          // fall through — placeholders below
        }
      }
      const qualityFailed =
        qualityResult.status === "rejected" ||
        (qualityResult.status === "fulfilled" && !qualityResult.value.ok);
      const partialErr: PartialError = {
        error: "quality endpoint unavailable",
        partial: true,
      };

      const status: StatusData = {
        meta: core.meta,
        version: core.version!,
        database: core.database!,
        pipelines: core.pipelines!,
        ai_costs: core.ai_costs!,
        activity: core.activity,
        officials_breakdown: core.officials_breakdown,
        quality: qualityFailed ? partialErr : quality.quality!,
        self_tests: qualityFailed ? partialErr : quality.self_tests!,
        chord: qualityFailed ? partialErr : quality.chord,
      };

      // Read chord flows from status — no separate fetch needed
      const chordData =
        status.chord && typeof status.chord === "object" && !("partial" in status.chord)
          ? (status.chord as ChordSectionData)
          : null;
      const chordFlows: ChordFlow[] = chordData?.top_flows ?? [];

      let platformUsage: PlatformUsageResponse | null = null;
      if (usageResult.status === "fulfilled" && usageResult.value.ok) {
        try {
          platformUsage = (await usageResult.value.json()) as PlatformUsageResponse;
        } catch { /* ignore — platform usage is non-critical */ }
      }

      let anthropicDetail: AnthropicDetail | null = null;
      if (anthropicResult.status === "fulfilled" && anthropicResult.value.ok) {
        try {
          anthropicDetail = (await anthropicResult.value.json()) as AnthropicDetail;
          setAnthropicCacheAge(anthropicDetail.cache?.age_minutes ?? 0);
        } catch { /* ignore — anthropic detail is non-critical */ }
      }

      setData({ status, chordFlows, platformUsage, anthropicDetail });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;

    const start = () => {
      if (interval) return; // guard against double-start
      interval = setInterval(fetchData, 900_000);
    };
    const stop = () => {
      clearInterval(interval);
      interval = undefined;
    };

    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        // Re-fetch once on tab focus, then resume interval
        fetchData();
        start();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    fetchData(); // single initial fetch
    start();

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [fetchData]);

  return { data, loading, error, refresh: fetchData, anthropicCacheAge };
}

// ── Type guards ───────────────────────────────────────────────────────────────

export function isPartial(v: unknown): v is PartialError {
  return typeof v === "object" && v !== null && "partial" in v;
}

// Mirror of the chord-flow extraction the in-hook fetch path does, lifted out
// so the SSR seed (FIX-204) and the client refresh produce identical shapes.
function extractChordFlows(status: StatusData): ChordFlow[] {
  const chord =
    status.chord && typeof status.chord === "object" && !("partial" in status.chord)
      ? (status.chord as ChordSectionData)
      : null;
  return chord?.top_flows ?? [];
}
