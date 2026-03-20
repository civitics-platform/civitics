/**
 * @civitics/ai
 *
 * Shared Claude API service layer for all AI features.
 *
 * Cost control rules (non-negotiable):
 *  1. Never turn on an AI feature until the credit/revenue mechanism that pays for it is LIVE
 *  2. Cache hit rate target: 80%+ (summaries generated once, served to all)
 *  3. Model routing by task complexity:
 *     - Haiku:  simple/cached tasks (12x cheaper than Sonnet)
 *     - Sonnet: standard features
 *     - Opus:   premium complex tasks (multi-hop analysis, legislation drafting)
 *  4. Hard rate limits per user per day
 *  5. Never open-ended free API access
 *
 * Free (cached, shared):
 *  - Plain language summaries — generated once on ingestion
 *  - "What does this mean?" basic Q&A on cached data
 *
 * Credit-gated (per-user):
 *  - Personalized impact analysis
 *  - Comment drafting (3 questions → structured comment)
 *  - Direct submission to regulations.gov
 *  - Connection mapping queries
 *  - Legislation drafting studio
 *
 * Premium (Opus, higher credit cost):
 *  - Full legislation drafting with legal citations
 *  - Complex multi-hop connection analysis
 */

import Anthropic from "@anthropic-ai/sdk";

// Model IDs — route by task complexity
export const MODELS = {
  haiku: "claude-haiku-4-5-20251001",   // simple/cached tasks
  sonnet: "claude-sonnet-4-6",          // standard features
  opus: "claude-opus-4-6",              // premium complex tasks
} as const;

export type ModelTier = keyof typeof MODELS;

// Credit costs per operation
export const CREDIT_COSTS = {
  personalizedImpact: 5,
  commentDraft: 10,
  connectionMapping: 15,
  legislationDraft: 50,
  foiaBuilder: 10,
  multiHopAnalysis: 30,
} as const;

export type AiOperation = keyof typeof CREDIT_COSTS;

export function createAiClient() {
  const apiKey = process.env["CIVITICS_ANTHROPIC_API_KEY"];
  if (!apiKey) throw new Error("Missing CIVITICS_ANTHROPIC_API_KEY");
  return new Anthropic({ apiKey });
}

/**
 * Generate a plain language summary of a proposal.
 * Called ONCE on ingestion; result stored in Supabase and served free to all users.
 * Never call this per-user — check cache first.
 */
export async function generateProposalSummary(
  client: Anthropic,
  proposalTitle: string,
  proposalText: string
): Promise<string> {
  const response = await client.messages.create({
    model: MODELS.haiku,
    max_tokens: 500,
    messages: [
      {
        role: "user",
        content: `Summarize this government proposal in plain language for a general audience.
Be factual, neutral, and specific. Avoid political framing. 3-5 sentences.

Title: ${proposalTitle}

Text: ${proposalText.slice(0, 8000)}`,
      },
    ],
  });

  const content = response.content[0];
  if (content?.type !== "text") throw new Error("Unexpected response type");
  return content.text;
}
