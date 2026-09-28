/**
 * packages/ai/src/cost-tracker.ts
 *
 * Reads and writes cost data to/from Supabase.
 * Used by CostGate — do not call directly from pipelines.
 *
 * Server-only. Never import from client components.
 */

import { createAdminClient } from "@civitics/db";
import { COST_CONFIG, calculateCostUsd } from "./cost-config";

export class CostTracker {
  /**
   * Get total spent this month in USD.
   * Tries Anthropic API first (most accurate); falls back to local api_usage_logs.
   */
  async getMonthlySpend(): Promise<number> {
    try {
      const adminKey = process.env["ANTHROPIC_ADMIN_API_KEY"];
      if (!adminKey) return this.getMonthlySpendFromLogs();

      const startOfMonth = new Date(
        new Date().getFullYear(),
        new Date().getMonth(),
        1
      ).toISOString();

      const response = await fetch(
        `https://api.anthropic.com/v1/organizations/cost_report?` +
          `starting_at=${startOfMonth}&ending_at=${new Date().toISOString()}`,
        {
          headers: {
            "anthropic-version": "2023-06-01",
            "x-api-key": adminKey,
          },
        }
      );

      if (!response.ok) return this.getMonthlySpendFromLogs();

      const data = await response.json() as { data?: Array<{ cost_usd?: number }> };
      return (
        data.data?.reduce(
          (sum: number, entry) => sum + (entry.cost_usd ?? 0),
          0
        ) ?? 0
      );
    } catch {
      return this.getMonthlySpendFromLogs();
    }
  }

  /**
   * Fallback: calculate monthly spend from our own api_usage_logs.
   * Uses token-based cost when available; falls back to stored cost_cents.
   */
  private async getMonthlySpendFromLogs(): Promise<number> {
    try {
      const supabase = createAdminClient();
      const monthStart = new Date(
        new Date().getFullYear(),
        new Date().getMonth(),
        1
      ).toISOString();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabase as any)
        .from("api_usage_logs")
        .select("input_tokens, output_tokens, cost_cents")
        .eq("service", "anthropic")
        .gte("created_at", monthStart);

      type UsageRow = { input_tokens: number | null; output_tokens: number | null; cost_cents: number | null };
      return ((data ?? []) as UsageRow[]).reduce((sum, row) => {
        if (row.input_tokens != null && row.output_tokens != null) {
          return sum + calculateCostUsd(row.input_tokens, row.output_tokens);
        }
        return sum + (row.cost_cents ?? 0) / 100;
      }, 0);
    } catch {
      return 0;
    }
  }

  /**
   * Get historical variance data for a pipeline — used to improve estimates.
   * Returns averages from the last 5 completed runs.
   */
  async getPipelineVariance(pipelineName: string): Promise<{
    avg_variance: number | null;
    avg_input_per_entity: number | null;
    avg_output_per_entity: number | null;
    run_count: number;
  }> {
    try {
      const supabase = createAdminClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabase as any)
        .from("pipeline_cost_history")
        .select(
          "variance_ratio, actual_tokens_input, actual_tokens_output, entity_count"
        )
        .eq("pipeline_name", pipelineName)
        .eq("status", "complete")
        .not("variance_ratio", "is", null)
        .order("run_at", { ascending: false })
        .limit(5);

      type HistoryRow = {
        variance_ratio: number | null;
        actual_tokens_input: number | null;
        actual_tokens_output: number | null;
        entity_count: number;
      };

      const rows = (data ?? []) as HistoryRow[];
      if (rows.length === 0) {
        return { avg_variance: null, avg_input_per_entity: null, avg_output_per_entity: null, run_count: 0 };
      }

      const avg_variance =
        rows.reduce((sum, r) => sum + (r.variance_ratio ?? 1), 0) / rows.length;

      const avg_input_per_entity =
        rows.reduce((sum, r) => sum + (r.actual_tokens_input ?? 0) / r.entity_count, 0) /
        rows.length;

      const avg_output_per_entity =
        rows.reduce((sum, r) => sum + (r.actual_tokens_output ?? 0) / r.entity_count, 0) /
        rows.length;

      return { avg_variance, avg_input_per_entity, avg_output_per_entity, run_count: rows.length };
    } catch {
      return { avg_variance: null, avg_input_per_entity: null, avg_output_per_entity: null, run_count: 0 };
    }
  }

  /** Insert a new run record when the pipeline starts. Returns the run ID. */
  async startRun(
    pipelineName: string,
    entityCount: number,
    estimatedCostUsd: number,
    estimatedInputTokens: number,
    estimatedOutputTokens: number,
    wasAutoApproved: boolean
  ): Promise<string> {
    const supabase = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabase as any)
      .from("pipeline_cost_history")
      .insert({
        pipeline_name:           pipelineName,
        entity_count:            entityCount,
        estimated_cost_usd:      estimatedCostUsd,
        estimated_tokens_input:  estimatedInputTokens,
        estimated_tokens_output: estimatedOutputTokens,
        was_auto_approved:       wasAutoApproved,
        status:                  "running",
      })
      .select("id")
      .single();

    return (data as { id: string } | null)?.id ?? "unknown";
  }

  /** Update a run record with actual costs once the pipeline finishes. */
  async completeRun(
    runId: string,
    actualInputTokens: number,
    actualOutputTokens: number,
    model: string,
    status: string = "complete"
  ): Promise<void> {
    const actualCostUsd = calculateCostUsd(actualInputTokens, actualOutputTokens, model);
    const supabase = createAdminClient();

    // Fetch the estimated cost for variance calculation
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: run } = await (supabase as any)
      .from("pipeline_cost_history")
      .select("estimated_cost_usd")
      .eq("id", runId)
      .single();

    const estimatedCost = (run as { estimated_cost_usd: number } | null)?.estimated_cost_usd;
    const varianceRatio = estimatedCost ? actualCostUsd / estimatedCost : null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any)
      .from("pipeline_cost_history")
      .update({
        actual_cost_usd:      actualCostUsd,
        actual_tokens_input:  actualInputTokens,
        actual_tokens_output: actualOutputTokens,
        variance_ratio:       varianceRatio,
        status,
      })
      .eq("id", runId);

    // Also log to api_usage_logs for dashboard cost tracking
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from("api_usage_logs").insert({
      service:       "anthropic",
      endpoint:      `pipeline:${runId}`,
      model,
      input_tokens:  actualInputTokens,
      output_tokens: actualOutputTokens,
      tokens_used:   actualInputTokens + actualOutputTokens,
      cost_cents:    actualCostUsd * 100,
    });
  }

  /**
   * Send an alert to configured channels.
   * Phase 1: console + supabase pipeline_state table.
   * Phase 2: add email + webhook.
   */
  async sendAlert(
    level: "info" | "warning" | "urgent" | "blocked",
    message: string,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    if (COST_CONFIG.alerts.console) {
      const prefix = { info: "💡", warning: "⚠️ ", urgent: "🚨", blocked: "🚫" }[level];
      console.warn(`\n${prefix} COST ALERT [${level.toUpperCase()}]\n${message}\n`);
    }

    if (COST_CONFIG.alerts.supabase) {
      try {
        const supabase = createAdminClient();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (supabase as any)
          .from("pipeline_state")
          .upsert(
            {
              key:   "cost_alert_latest",
              value: { level, message, metadata, created_at: new Date().toISOString() },
              updated_at: new Date().toISOString(),
            },
            { onConflict: "key" }
          );
      } catch {
        // Non-critical — alert write failure never blocks the pipeline
      }
    }
  }
}

export const costTracker = new CostTracker();
