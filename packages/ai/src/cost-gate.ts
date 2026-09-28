/**
 * packages/ai/src/cost-gate.ts
 *
 * Main entry point for AI pipeline cost control.
 * EVERY AI pipeline must call costGate.gate() before processing any entities.
 *
 * Flow (interactive mode):
 *   1. Check hard monthly limit — block immediately if exceeded
 *   2. Sample 3 real API calls to measure actual token usage
 *   3. Build estimate with historical variance adjustment
 *   4. Auto-approve if under $0.05; otherwise prompt for approval
 *   5. Record the run start in pipeline_cost_history
 *   6. After pipeline: call costGate.complete() to record actuals
 *
 * Flow (autonomous mode — cron/CI):
 *   Steps 1-3 same, then:
 *   4. Apply autonomous rules (budget floor, entity cap, cost cap, last-run checks)
 *   5. Auto-approve if all rules pass; otherwise skip and log
 *
 * Server-only. Never import from client components.
 */

import * as readline from "readline";
import { createAdminClient } from "@civitics/db";
import { COST_CONFIG, calculateCostUsd, type PipelineName } from "./cost-config";
import { costTracker } from "./cost-tracker";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SampleResult {
  input_tokens:  number;
  output_tokens: number;
  cost_usd:      number;
}

export interface CostEstimate {
  pipeline:      string;
  entity_count:  number;
  sample_size:   number;

  // Per entity (measured from samples):
  avg_input_tokens:  number;
  avg_output_tokens: number;
  cost_per_entity_usd: number;

  // Adjusted for historical variance:
  adjusted_cost_per_entity_usd: number;
  historical_variance:   number | null;
  historical_run_count:  number;

  // Totals:
  estimated_total_usd:      number;
  estimated_duration_mins:  number;

  // Budget context:
  monthly_spent_usd:    number;
  monthly_budget_usd:   number;
  budget_remaining_usd: number;
  would_exceed_budget:  boolean;
  would_exceed_run_limit: boolean;
  run_limit_usd:        number;

  // After this run:
  projected_remaining_usd: number;

  // Confidence in estimate:
  confidence: "high" | "medium" | "low";
}

export interface GateResult {
  approved:       boolean;
  auto_approved:  boolean;
  entity_limit?:  number;
  run_id?:        string;
  estimate:       CostEstimate;
  skip_reason?:   string;
}

// ---------------------------------------------------------------------------
// Autonomous mode detection
// ---------------------------------------------------------------------------

/**
 * Returns true when running in a cron or CI environment where terminal prompts
 * are not possible. Cost gate uses pre-configured rules instead of prompts.
 *
 * Detection order:
 *   1. VERCEL_CRON_SIGNATURE — set by Vercel on all cron invocations
 *   2. AUTONOMOUS=true       — explicit override for testing
 *   3. CI=true               — standard CI environment variable
 */
export function isAutonomousMode(): boolean {
  return !!(
    process.env["VERCEL_CRON_SIGNATURE"] ||
    process.env["AUTONOMOUS"] === "true" ||
    process.env["CI"] === "true"
  );
}

// ---------------------------------------------------------------------------
// CostGate
// ---------------------------------------------------------------------------

export class CostGate {
  /**
   * STEP 1: Run sampleSize real API calls to measure actual token usage.
   * Uses the caller's sampleFn so results reflect the real prompt.
   */
  async sampleCost(
    sampleFn: () => Promise<{ usage: { input_tokens: number; output_tokens: number }; model: string }>,
    sampleSize: number = COST_CONFIG.estimate_sample_size
  ): Promise<SampleResult[]> {
    console.info(`\n📊 Sampling ${sampleSize} real API calls to estimate cost...\n`);

    const results: SampleResult[] = [];

    for (let i = 0; i < sampleSize; i++) {
      const response = await sampleFn();
      const cost = calculateCostUsd(
        response.usage.input_tokens,
        response.usage.output_tokens,
        response.model
      );
      results.push({
        input_tokens:  response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cost_usd:      cost,
      });
      console.info(
        `  Sample ${i + 1}/${sampleSize}: ` +
        `${response.usage.input_tokens} in / ${response.usage.output_tokens} out ` +
        `($${cost.toFixed(6)})`
      );
    }

    return results;
  }

  /**
   * STEP 2: Build a full cost estimate from sample results + historical data.
   */
  async buildEstimate(
    pipelineName: PipelineName | string,
    entityCount:  number,
    samples:      SampleResult[],
    model:        string = "claude-haiku-4-5-20251001"
  ): Promise<CostEstimate> {
    // Average the samples
    const avgInput  = samples.reduce((s, r) => s + r.input_tokens,  0) / samples.length;
    const avgOutput = samples.reduce((s, r) => s + r.output_tokens, 0) / samples.length;
    const costPerEntity = calculateCostUsd(avgInput, avgOutput, model);

    // Historical variance — improves estimate if we have prior runs
    const history = await costTracker.getPipelineVariance(pipelineName);

    // If history exists, apply its variance multiplier; otherwise add 20% safety buffer
    const varianceMultiplier =
      history.avg_variance !== null ? history.avg_variance : 1.20;

    const adjustedCostPerEntity = costPerEntity * varianceMultiplier;
    const estimatedTotal = adjustedCostPerEntity * entityCount;

    // Estimate duration — ~1.3s per entity (rate-limit delay)
    const estimatedMins = Math.ceil((entityCount * 1.3) / 60);

    // Budget context
    const monthlySpent    = await costTracker.getMonthlySpend();
    const monthlyBudget   = COST_CONFIG.monthly_hard_limit_usd;
    const budgetRemaining = monthlyBudget - monthlySpent;

    const runLimit =
      (COST_CONFIG.per_run_limits as Record<string, number>)[pipelineName] ??
      COST_CONFIG.per_run_limits.default;

    // Confidence based on sample consistency + run history
    const maxSample = Math.max(...samples.map((s) => s.cost_usd));
    const minSample = Math.min(...samples.map((s) => s.cost_usd));
    const sampleVariance = minSample > 0 ? maxSample / minSample : 1;

    const confidence: "high" | "medium" | "low" =
      sampleVariance < 1.1 && history.run_count > 0
        ? "high"
        : sampleVariance < 1.3
        ? "medium"
        : "low";

    return {
      pipeline:      pipelineName,
      entity_count:  entityCount,
      sample_size:   samples.length,
      avg_input_tokens:  Math.round(avgInput),
      avg_output_tokens: Math.round(avgOutput),
      cost_per_entity_usd:          costPerEntity,
      adjusted_cost_per_entity_usd: adjustedCostPerEntity,
      historical_variance:   history.avg_variance,
      historical_run_count:  history.run_count,
      estimated_total_usd:     estimatedTotal,
      estimated_duration_mins: estimatedMins,
      monthly_spent_usd:    monthlySpent,
      monthly_budget_usd:   monthlyBudget,
      budget_remaining_usd: budgetRemaining,
      would_exceed_budget:    estimatedTotal > budgetRemaining,
      would_exceed_run_limit: estimatedTotal > runLimit,
      run_limit_usd:        runLimit,
      projected_remaining_usd: budgetRemaining - estimatedTotal,
      confidence,
    };
  }

  /** STEP 3: Print the estimate box to the terminal. */
  displayEstimate(estimate: CostEstimate): void {
    const bar = (pct: number, width = 20): string => {
      const filled = Math.min(width, Math.round(pct * width));
      return "█".repeat(filled) + "░".repeat(width - filled);
    };

    const budgetPct = estimate.monthly_spent_usd / estimate.monthly_budget_usd;

    const line = (label: string, value: string, width = 39): string => {
      const inner = `  ${label}${value}`;
      return `║${inner.padEnd(width)}║`;
    };

    const historyLine =
      estimate.historical_run_count > 0
        ? line(
            "    History variance:  ",
            `${((estimate.historical_variance! - 1) * 100).toFixed(0)}% (${estimate.historical_run_count} runs)`
          )
        : line("    No run history — ", "+20% buffer applied");

    const budgetBar = `[${bar(budgetPct)}] ${(budgetPct * 100).toFixed(0)}%`;

    const budgetExceedBlock = estimate.would_exceed_budget
      ? "╠═══════════════════════════════════════╣\n" +
        "║  ⚠  WOULD EXCEED MONTHLY BUDGET       ║\n"
      : "";

    const runLimitBlock = estimate.would_exceed_run_limit
      ? "╠═══════════════════════════════════════╣\n" +
        `║  ⚠  EXCEEDS PER-RUN LIMIT ($${estimate.run_limit_usd.toFixed(2).padEnd(8)})║\n`
      : "";

    console.info(`
╔═══════════════════════════════════════╗
║  💰 Cost Estimate — ${estimate.pipeline.slice(0, 17).padEnd(17)}║
╠═══════════════════════════════════════╣
║  Entities to process: ${String(estimate.entity_count).padEnd(16)}║
║  Sample calls made:   ${String(estimate.sample_size).padEnd(16)}║
╠═══════════════════════════════════════╣
║  MEASURED PER ENTITY:                 ║
║    Avg input tokens:  ${String(estimate.avg_input_tokens).padEnd(16)}║
║    Avg output tokens: ${String(estimate.avg_output_tokens).padEnd(16)}║
║    Raw cost/entity:   $${estimate.cost_per_entity_usd.toFixed(6).padEnd(15)}║
${historyLine}
║    Adjusted cost/entity: $${estimate.adjusted_cost_per_entity_usd.toFixed(6).padEnd(12)}║
╠═══════════════════════════════════════╣
║  PROJECTED TOTAL:                     ║
║    Estimated cost:  $${estimate.estimated_total_usd.toFixed(4).padEnd(18)}║
║    Estimated time:  ${(estimate.estimated_duration_mins + " minutes").padEnd(19)}║
║    Confidence:      ${estimate.confidence.toUpperCase().padEnd(19)}║
╠═══════════════════════════════════════╣
║  MONTHLY BUDGET:                      ║
║    ${budgetBar.padEnd(35)}║
║    Spent:     $${estimate.monthly_spent_usd.toFixed(4).padEnd(23)}║
║    Budget:    $${estimate.monthly_budget_usd.toFixed(2).padEnd(23)}║
║    Remaining: $${estimate.budget_remaining_usd.toFixed(4).padEnd(23)}║
║    After run: $${Math.max(0, estimate.projected_remaining_usd).toFixed(4).padEnd(23)}║
${budgetExceedBlock}${runLimitBlock}╚═══════════════════════════════════════╝`);
  }

  /**
   * STEP 4a (interactive): Request approval — auto-approve if tiny, block if over budget,
   * otherwise prompt the user.
   */
  async requestApproval(estimate: CostEstimate): Promise<{
    approved:      boolean;
    auto_approved: boolean;
    entity_limit?: number;
  }> {
    // BLOCKED: would exceed monthly budget
    if (estimate.would_exceed_budget) {
      const maxEntities = Math.floor(
        estimate.budget_remaining_usd / estimate.adjusted_cost_per_entity_usd
      );

      this.displayEstimate(estimate);
      console.info(`
🚫 BUDGET WOULD BE EXCEEDED

Options:
  1. Process only ${maxEntities} entities (fits within remaining budget)
  2. Cancel

Choice [1/2]: `);

      const choice = await this.prompt();
      if (choice.trim() === "1") {
        return { approved: true, auto_approved: false, entity_limit: maxEntities };
      }
      return { approved: false, auto_approved: false };
    }

    // AUTO-APPROVE: tiny cost, no prompt needed
    if (estimate.estimated_total_usd < COST_CONFIG.auto_approve_under_usd) {
      console.info(
        `\n✅ Auto-approved — under $${COST_CONFIG.auto_approve_under_usd} threshold\n`
      );
      return { approved: true, auto_approved: true };
    }

    // MANUAL APPROVAL REQUIRED
    this.displayEstimate(estimate);
    console.info("\nProceed? [Y/n]: ");
    const answer = await this.prompt();
    const approved = answer.trim().toLowerCase() !== "n";
    return { approved, auto_approved: false };
  }

  /**
   * STEP 4b (autonomous): Apply pre-configured rules instead of terminal prompts.
   * Used in cron/CI environments where stdin is not available.
   */
  async autonomousApproval(
    estimate: CostEstimate,
    pipelineName: string
  ): Promise<{
    approved:      boolean;
    auto_approved: boolean;
    skip_reason?:  string;
  }> {
    const rules = COST_CONFIG.autonomous;

    // CHECK 1: Budget remaining
    if (estimate.budget_remaining_usd < rules.min_budget_remaining_usd) {
      return {
        approved: false,
        auto_approved: false,
        skip_reason:
          `Budget too low for autonomous run. ` +
          `Remaining: $${estimate.budget_remaining_usd.toFixed(2)} ` +
          `(minimum: $${rules.min_budget_remaining_usd})`,
      };
    }

    // CHECK 2: Entity count
    if (estimate.entity_count > rules.max_entity_count) {
      return {
        approved: false,
        auto_approved: false,
        skip_reason:
          `Entity count too high for autonomous run: ` +
          `${estimate.entity_count} entities (max: ${rules.max_entity_count}). ` +
          `Manual review needed.`,
      };
    }

    // CHECK 3: Estimated cost
    if (estimate.estimated_total_usd > rules.max_auto_approve_usd) {
      return {
        approved: false,
        auto_approved: false,
        skip_reason:
          `Estimated cost too high for autonomous run: ` +
          `$${estimate.estimated_total_usd.toFixed(4)} ` +
          `(max: $${rules.max_auto_approve_usd})`,
      };
    }

    // CHECK 4: Last run status + variance
    if (rules.skip_if_last_run_failed) {
      const supabase = createAdminClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: lastRun } = await (supabase as any)
        .from("pipeline_cost_history")
        .select("status, variance_ratio")
        .eq("pipeline_name", pipelineName)
        .order("run_at", { ascending: false })
        .limit(1)
        .single();

      type LastRunRow = { status: string; variance_ratio: number | null } | null;
      const run = lastRun as LastRunRow;

      if (run?.status === "failed" || run?.status === "paused") {
        return {
          approved: false,
          auto_approved: false,
          skip_reason:
            `Last run of ${pipelineName} had status: ${run.status}. ` +
            `Manual review needed before autonomous runs resume.`,
        };
      }

      // CHECK 5: Last run variance
      if (run?.variance_ratio != null && run.variance_ratio > rules.skip_if_variance_over) {
        return {
          approved: false,
          auto_approved: false,
          skip_reason:
            `Last run variance was ${((run.variance_ratio - 1) * 100).toFixed(0)}% over estimate. ` +
            `Skipping autonomous run.`,
        };
      }
    }

    // All checks passed — auto-approve
    console.info(
      `\n✅ Autonomous approval: ${pipelineName}\n` +
      `   Estimated: $${estimate.estimated_total_usd.toFixed(4)}\n` +
      `   Entities: ${estimate.entity_count}\n` +
      `   All autonomous rules passed\n`
    );

    return { approved: true, auto_approved: true };
  }

  /** Log a skipped pipeline run to DB for dashboard visibility. */
  private async logSkip(
    pipelineName: string,
    entityCount: number,
    reason: string
  ): Promise<void> {
    try {
      const supabase = createAdminClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any)
        .from("pipeline_cost_history")
        .insert({
          pipeline_name:      pipelineName,
          entity_count:       entityCount,
          estimated_cost_usd: 0,
          status:             "skipped",
          notes:              reason,
        });

      await costTracker.sendAlert(
        "info",
        `Pipeline skipped in autonomous mode: ${pipelineName}\nReason: ${reason}`
      );
    } catch {
      // Non-critical — skip log failure never blocks the pipeline
    }
  }

  /** Read one line from stdin. */
  private prompt(): Promise<string> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input:  process.stdin,
        output: process.stdout,
      });
      rl.question("", (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Main entry point. Call at the start of every AI pipeline.
   *
   * @param options.pipelineName  - Name matching per_run_limits key
   * @param options.entityCount   - Total entities to process
   * @param options.model         - Anthropic model ID (default: haiku)
   * @param options.sampleFn      - Runs ONE real entity through the actual pipeline prompt
   *                                Must return the raw Anthropic API response object
   *
   * Returns gate result with approved flag, run_id for tracking, and estimate.
   * If approved is false, return immediately — do not process any entities.
   */
  async gate(options: {
    pipelineName: PipelineName | string;
    entityCount:  number;
    model?:       string;
    sampleFn: () => Promise<{
      usage: { input_tokens: number; output_tokens: number };
      model: string;
    }>;
  }): Promise<GateResult> {
    const model = options.model ?? "claude-haiku-4-5-20251001";
    const autonomous = isAutonomousMode();

    // Check hard monthly limit before sampling
    const monthlySpent = await costTracker.getMonthlySpend();

    if (monthlySpent >= COST_CONFIG.monthly_hard_limit_usd) {
      await costTracker.sendAlert(
        "blocked",
        `Monthly budget of $${COST_CONFIG.monthly_hard_limit_usd} reached. ` +
          `All AI pipelines suspended until next month.`
      );
      return { approved: false, auto_approved: false, estimate: null as unknown as CostEstimate };
    }

    // Budget warning alerts
    const budgetPct = monthlySpent / COST_CONFIG.monthly_hard_limit_usd;
    if (budgetPct >= 0.90) {
      await costTracker.sendAlert(
        "urgent",
        `AI budget 90% used. Only $${(COST_CONFIG.monthly_hard_limit_usd - monthlySpent).toFixed(2)} remaining.`
      );
    } else if (budgetPct >= 0.75) {
      await costTracker.sendAlert(
        "warning",
        `AI budget 75% used. $${(COST_CONFIG.monthly_hard_limit_usd - monthlySpent).toFixed(2)} remaining.`
      );
    }

    // Use 1 sample in autonomous mode (faster, cheaper), 3 in interactive mode
    const sampleSize = autonomous
      ? COST_CONFIG.autonomous.sample_size_override
      : COST_CONFIG.estimate_sample_size;

    // Sample real API calls
    const samples = await this.sampleCost(options.sampleFn, sampleSize);

    // Build estimate
    const estimate = await this.buildEstimate(
      options.pipelineName,
      options.entityCount,
      samples,
      model
    );

    // Route to correct approval method
    const approval: {
      approved:      boolean;
      auto_approved: boolean;
      entity_limit?: number;
      skip_reason?:  string;
    } = autonomous
      ? await this.autonomousApproval(estimate, options.pipelineName)
      : await this.requestApproval(estimate);

    // Autonomous skip: log and return early
    if (!approval.approved && autonomous) {
      console.info(
        `\n⏭ Pipeline skipped (autonomous):\n   ${approval.skip_reason}\n`
      );
      await this.logSkip(
        options.pipelineName,
        options.entityCount,
        approval.skip_reason!
      );
      return {
        approved:     false,
        auto_approved: false,
        skip_reason:  approval.skip_reason,
        estimate,
      };
    }

    if (!approval.approved) {
      console.info("\n❌ Pipeline cancelled\n");
      return { ...approval, estimate };
    }

    // Start run record in DB
    const finalEntityCount = approval.entity_limit ?? options.entityCount;
    const runId = await costTracker.startRun(
      options.pipelineName,
      finalEntityCount,
      estimate.estimated_total_usd,
      estimate.avg_input_tokens * finalEntityCount,
      estimate.avg_output_tokens * finalEntityCount,
      approval.auto_approved
    );

    console.info(`\n▶ Pipeline approved — run ID: ${runId}\n`);

    return { ...approval, run_id: runId, estimate };
  }

  /**
   * Call after pipeline completes to record actual costs and print final report.
   * Always call this — even if the pipeline was cancelled or paused mid-run.
   */
  async complete(
    runId:              string,
    totalInputTokens:   number,
    totalOutputTokens:  number,
    model:              string = "claude-haiku-4-5-20251001",
    status:             string = "complete"
  ): Promise<void> {
    await costTracker.completeRun(runId, totalInputTokens, totalOutputTokens, model, status);

    const actualCost = calculateCostUsd(totalInputTokens, totalOutputTokens, model);

    // Fetch run details for comparison report
    const supabase = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: run } = await (supabase as any)
      .from("pipeline_cost_history")
      .select("estimated_cost_usd, pipeline_name, entity_count")
      .eq("id", runId)
      .single();

    type RunRow = { estimated_cost_usd: number; pipeline_name: string; entity_count: number } | null;
    const runRow = run as RunRow;

    const variance =
      runRow?.estimated_cost_usd ? actualCost / runRow.estimated_cost_usd : null;

    const varianceLine =
      variance !== null
        ? `║  Variance:  ${((variance > 1 ? "+" : "") + ((variance - 1) * 100).toFixed(1) + "%").padEnd(26)}║`
        : "";

    console.info(`
╔═══════════════════════════════════════╗
║  ✅ Pipeline Complete — Cost Report   ║
╠═══════════════════════════════════════╣
║  Pipeline:  ${(runRow?.pipeline_name ?? "unknown").slice(0, 26).padEnd(26)}║
║  Entities:  ${String(runRow?.entity_count ?? 0).padEnd(26)}║
╠═══════════════════════════════════════╣
║  COST COMPARISON:                     ║
║  Estimated: $${(runRow?.estimated_cost_usd ?? 0).toFixed(6).padEnd(24)}║
║  Actual:    $${actualCost.toFixed(6).padEnd(24)}║
${varianceLine ? varianceLine + "\n" : ""}╠═══════════════════════════════════════╣
║  Tokens:                              ║
║  Input:  ${String(totalInputTokens).padEnd(29)}║
║  Output: ${String(totalOutputTokens).padEnd(29)}║
╚═══════════════════════════════════════╝`);

    // Alert on large variance
    if (variance !== null && variance > COST_CONFIG.variance_pause_threshold) {
      await costTracker.sendAlert(
        "warning",
        `Pipeline ${runRow?.pipeline_name} cost ${((variance - 1) * 100).toFixed(0)}% more than estimated. ` +
          `Estimate: $${(runRow?.estimated_cost_usd ?? 0).toFixed(4)} ` +
          `Actual: $${actualCost.toFixed(4)}. Future estimates updated.`
      );
    }
  }
}

export const costGate = new CostGate();
