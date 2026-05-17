/**
 * packages/ai/src/client.ts
 *
 * Server-only. Used by ingestion pipelines and server-side route handlers.
 * Never import this from client components.
 *
 * Cost rules (non-negotiable):
 *  - Monthly spend cap: $4.00 (leaves $1 buffer on $5 card)
 *  - Model: Haiku for all summaries — cheapest at ~$0.25/M input tokens
 *  - Cache first: summaries generated once and served to all users forever
 *  - Log every API call to api_usage_logs for dashboard transparency
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  createAdminClient,
  getMonthlyAnthropicSpend,
  getMonthlyAnthropicLimitUsd,
  isKillSwitchEnabled,
} from "@civitics/db";

export const anthropic = new Anthropic({
  apiKey: process.env["CIVITICS_ANTHROPIC_API_KEY"],
});

// Fallback hard cap used when platform_limits is unreachable.
// platform_limits.anthropic.monthly_spend_usd is the source of truth — this
// value only kicks in if that query fails (returns null).
const FALLBACK_MONTHLY_SPEND_LIMIT_USD = 4.0;

async function getCachedSummary(
  entityType: string,
  entityId: string,
  summaryType: string
): Promise<string | null> {
  try {
    const db = createAdminClient();
    const { data } = await db
      .from("ai_summary_cache")
      .select("summary_text")
      .eq("entity_type", entityType)
      .eq("entity_id", entityId)
      .eq("summary_type", summaryType)
      .single();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data as any)?.summary_text ?? null;
  } catch {
    return null; // cache miss — proceed to generate
  }
}

async function cacheSummary(
  entityType: string,
  entityId: string,
  summaryType: string,
  summaryText: string,
  model: string,
  tokensUsed: number
): Promise<void> {
  try {
    const db = createAdminClient();
    await db.from("ai_summary_cache").upsert(
      { entity_type: entityType, entity_id: entityId, summary_type: summaryType, summary_text: summaryText, model, tokens_used: tokensUsed },
      { onConflict: "entity_type,entity_id,summary_type" }
    );
  } catch {
    // Non-critical — cache write failure never blocks the response
  }
}

async function logUsage(
  model: string,
  inputTokens: number,
  outputTokens: number,
  costCents: number
): Promise<void> {
  try {
    const db = createAdminClient();
    await db.from("api_usage_logs").insert({
      service: "anthropic",
      endpoint: "generate_summary",
      model,
      tokens_used: inputTokens + outputTokens,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_cents: costCents,
    });
  } catch {
    // Non-critical
  }
}

const PLAIN_TEXT_INSTRUCTION =
  " Write in plain prose only — no markdown, no headers, no bullet points, " +
  "no bold text, no asterisks, no pound signs. Just clear sentences.";

function buildSummaryPrompt(
  text: string,
  type: "bill" | "regulation" | "official"
): string {
  const truncated = text.slice(0, 6000);

  if (type === "bill") {
    return (
      "Summarize this bill in 2-3 sentences in plain language a citizen can understand. " +
      "Focus on what it does and who it affects." +
      PLAIN_TEXT_INSTRUCTION + "\n\n" +
      `Bill text: ${truncated}`
    );
  }

  if (type === "regulation") {
    return (
      "Summarize this proposed regulation in 2-3 sentences. " +
      "What is being changed and what does it mean for ordinary people?" +
      PLAIN_TEXT_INSTRUCTION + "\n\n" +
      `Regulation: ${truncated}`
    );
  }

  return (
    "Based on this voting record and donor information, write a 2-3 sentence " +
    "neutral factual summary of this official's legislative profile." +
    PLAIN_TEXT_INSTRUCTION + "\n\n" +
    `Data: ${truncated}`
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a plain-language summary for a specific entity.
 *
 * @param text        - Raw text to summarize (bill text, regulation, official data)
 * @param type        - Summary type: 'bill' | 'regulation' | 'official'
 * @param entityType  - DB entity type: 'proposal' | 'official' | 'agency'
 * @param entityId    - UUID of the entity in the database
 *
 * Flow:
 *  1. Check ai_summary_cache — return immediately if found
 *  2. Check monthly spend cap ($4.00) — throw if exceeded
 *  3. Call Haiku — cheapest model, 300 token max
 *  4. Write to cache + log usage (parallel, non-blocking)
 *  5. Return summary
 */
export async function generateSummary(
  text: string,
  type: "bill" | "regulation" | "official",
  entityType: string,
  entityId: string
): Promise<string> {
  // Check cache first
  const cached = await getCachedSummary(entityType, entityId, type);
  if (cached) return cached;

  // Kill switch: refuse on cache miss when the switch is off. Layered
  // env > DB > on, with a 30s module cache inside isKillSwitchEnabled
  // (see packages/db/src/kill-switches.ts). Replaces the bare
  // AI_SUMMARIES_ENABLED env check.
  const db = createAdminClient();
  const aiOn = await isKillSwitchEnabled(db, "ai_summaries");
  if (!aiOn) {
    throw new Error(
      "AI summaries are temporarily disabled. Cached summaries are still available; " +
        "uncached entities will resume once summaries are re-enabled."
    );
  }

  // Cost guard: refuse when the current-month spend is at or above the
  // platform_limits cap for anthropic.monthly_spend_usd. Both spend and
  // limit are module-cached for 60s, so a burst of AI calls hits cached
  // values rather than hammering api_usage_logs.
  const [spentUsd, limitUsdRaw] = await Promise.all([
    getMonthlyAnthropicSpend(db),
    getMonthlyAnthropicLimitUsd(db, "free"),
  ]);
  const limitUsd = limitUsdRaw ?? FALLBACK_MONTHLY_SPEND_LIMIT_USD;
  if (spentUsd !== null && spentUsd >= limitUsd) {
    throw new Error(
      `Monthly AI spend limit reached ($${limitUsd.toFixed(2)}). Plain-language summaries ` +
        "are temporarily unavailable — they will resume next month."
    );
  }

  // Haiku: cheapest model — $0.25/M input, $1.25/M output
  const model = "claude-haiku-4-5-20251001";
  const message = await anthropic.messages.create({
    model,
    max_tokens: 300,
    system:
      "You write plain language civic summaries for ordinary citizens. " +
      "Always respond in plain prose — never use markdown formatting, " +
      "headers, bullet points, bold text, asterisks, or pound signs.",
    messages: [{ role: "user", content: buildSummaryPrompt(text, type) }],
  });

  const summary =
    message.content[0]?.type === "text" ? message.content[0].text : "";

  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  const tokensUsed = inputTokens + outputTokens;
  // Haiku: $0.25/M input + $1.25/M output → exact fractional cents
  // Stored as DECIMAL(10,4) — no rounding, no Math.ceil, no Math.round
  const costCents = (inputTokens * 0.25 + outputTokens * 1.25) / 10_000;

  // Cache and log in parallel — neither blocks the response
  await Promise.all([
    cacheSummary(entityType, entityId, type, summary, model, tokensUsed),
    logUsage(model, inputTokens, outputTokens, costCents),
  ]);

  return summary;
}
