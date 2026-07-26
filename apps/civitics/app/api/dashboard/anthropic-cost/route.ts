export const dynamic = "force-dynamic";

/**
 * GET /api/dashboard/anthropic-cost
 *
 * Returns Anthropic spend data for the dashboard cost card.
 * Includes pipeline run history and latest alert from cost gate.
 *
 * Data sources:
 *  - api_usage_logs       — token-level spend (accurate)
 *  - pipeline_cost_history — per-run estimates vs. actuals
 *  - pipeline_state        — latest cost alert from the gate
 */

import { calculateLoggedCostUsd, createAdminClient } from "@civitics/db";
import { NextResponse } from "next/server";

export async function GET() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  try {
    const [usageLogs, recentRuns, alertState] = await Promise.all([
      // Monthly spend from api_usage_logs
      db
        .from("api_usage_logs")
        .select("input_tokens, output_tokens, cost_cents, model")
        .eq("service", "anthropic")
        .gte("created_at", monthStart),

      // Last 10 pipeline runs
      db
        .from("pipeline_cost_history")
        .select(
          "pipeline_name, run_at, entity_count, " +
          "estimated_cost_usd, actual_cost_usd, variance_ratio, status"
        )
        .order("run_at", { ascending: false })
        .limit(10),

      // Latest cost alert
      db
        .from("pipeline_state")
        .select("value")
        .eq("key", "cost_alert_latest")
        .single(),
    ]);

    // Calculate monthly spend — prefer token-based, fall back to cost_cents
    // FIX-893: was an inline (in*0.25 + out*1.25) that used Haiku-3-era prices
    // and ignored the model column entirely. Priced by model now, erring high on
    // an unknown one so the dashboard never under-reports spend.
    type UsageRow = { input_tokens: number | null; output_tokens: number | null; cost_cents: number | null; model: string | null };
    const monthRows: UsageRow[] = usageLogs.data ?? [];
    const cost_usd = monthRows.reduce((sum, r) => {
      if (r.input_tokens != null && r.output_tokens != null) {
        return sum + calculateLoggedCostUsd(r.input_tokens, r.output_tokens, r.model);
      }
      return sum + (r.cost_cents ?? 0) / 100;
    }, 0);

    type RunRow = {
      pipeline_name:      string;
      run_at:             string;
      entity_count:       number;
      estimated_cost_usd: number;
      actual_cost_usd:    number | null;
      variance_ratio:     number | null;
      status:             string;
    };

    return NextResponse.json(
      {
        cost_usd,
        recent_runs: (recentRuns.data ?? []) as RunRow[],
        latest_alert: alertState.data?.value ?? null,
        fetched_at:   now.toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
