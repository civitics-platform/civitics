"use client";

import { useState, useEffect, useCallback } from "react";
import type { PlatformMetric } from "@civitics/db";

// ── Types matching /api/claude/status response ────────────────────────────────

type PartialError = { error: string; partial: true };

export type DatabaseStats = {
  officials: number;
  proposals: number;
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

export type PipelinesData = {
  recent_runs: PipelineRun[];
  cron_last_run: Record<string, unknown> | null;
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
  industry_tags: { total: number; tagged: number; pct: number; note?: string };
  vote_connections: number;
};

export type SelfTest = {
  name: string;
  passed: boolean;
  detail: string;
};

export type ChordSectionData = {
  top_flows: Array<{ from: string; to: string; amount_usd: number }>;
  total_flow_usd: number;
};

export type ActivitySectionData = {
  page_views_24h: number;
  top_pages: Array<{ path: string; views: number }>;
};

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
  timestamp: string;
};

export type DashboardData = {
  status: StatusData;
  chordFlows: ChordFlow[];
  platformUsage: PlatformUsageResponse | null;
};

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useDashboardData() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [statusRes, usageRes] = await Promise.all([
        fetch("/api/claude/status"),
        fetch("/api/platform/usage"),
      ]);
      if (!statusRes.ok) throw new Error(`HTTP ${statusRes.status}`);
      const status = (await statusRes.json()) as StatusData;

      // Read chord flows from status — no separate fetch needed
      const chordData =
        status.chord && typeof status.chord === "object" && !("partial" in status.chord)
          ? (status.chord as ChordSectionData)
          : null;
      const chordFlows: ChordFlow[] = chordData?.top_flows ?? [];

      let platformUsage: PlatformUsageResponse | null = null;
      if (usageRes.ok) {
        try {
          platformUsage = (await usageRes.json()) as PlatformUsageResponse;
        } catch { /* ignore — platform usage is non-critical */ }
      }

      setData({ status, chordFlows, platformUsage });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;

    const start = () => { interval = setInterval(fetchData, 900_000); };
    const stop = () => { clearInterval(interval); };

    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        fetchData();
        start();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    fetchData();
    start();

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [fetchData]);

  return { data, loading, error, refresh: fetchData };
}

// ── Type guards ───────────────────────────────────────────────────────────────

export function isPartial(v: unknown): v is PartialError {
  return typeof v === "object" && v !== null && "partial" in v;
}
