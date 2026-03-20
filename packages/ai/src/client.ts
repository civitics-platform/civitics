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
import { createAdminClient } from "@civitics/db";

export const anthropic = new Anthropic({
  apiKey: process.env["CIVITICS_ANTHROPIC_API_KEY"],
});

// $4.00 hard cap — stored as integer cents
const MONTHLY_SPEND_LIMIT_CENTS = 400;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function getMonthlySpendCents(): Promise<number> {
  try {
    const db = createAdminClient();
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);

    const { data } = await db
      .from("api_usage_logs")
      .select("cost_cents, input_tokens, output_tokens")
      .eq("service", "anthropic")
      .gte("created_at", start.toISOString());

    // Prefer token-based cost when available (accurate); fall back to stored cost_cents
    return data?.reduce((sum, r) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = r as any;
      if (row.input_tokens != null && row.output_tokens != null) {
        return sum + (row.input_tokens * 0.25 + row.output_tokens * 1.25) / 10_000;
      }
      return sum + (row.cost_cents ?? 0);
    }, 0) ?? 0;
  } catch {
    return 0; // fail open — a failed check should not block generation
  }
}

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

  // Cost guard: never exceed $4.00/month on Anthropic
  const spentCents = await getMonthlySpendCents();
  if (spentCents >= MONTHLY_SPEND_LIMIT_CENTS) {
    throw new Error(
      "Monthly AI spend limit reached ($4.00). Plain-language summaries " +
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
