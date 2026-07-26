/**
 * GET /api/proposals/[id]/summary
 *
 * On-demand plain-language summary for a proposal.
 *
 * Flow:
 *  1. Check ai_summary_cache — return immediately if found
 *  2. Verify proposal exists and is open for comment
 *  3. Check monthly spend cap ($4.00)
 *  4. Generate with Haiku, cache, log usage
 *  5. Return { summary: string } | { summary: null }
 */

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { calculateCostUsd, createAdminClient } from "@civitics/db";
import { createAiClient, MODELS } from "@civitics/ai";
// FIX-796 — header handler-owned: only the two summary-bearing 200s are
// CDN-cached. The `summary: null` variants (kill switch, spend cap, closed
// proposal, DB error) are NOT stamped, so a transient null is never pinned.
import { withPublicCdnCache } from "@/lib/cdn-cache";

const MONTHLY_SPEND_LIMIT_CENTS = 400;

async function getMonthlySpendCents(db: ReturnType<typeof createAdminClient>): Promise<number> {
  try {
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (db as any)
      .from("api_usage_logs")
      .select("cost_cents")
      .eq("service", "anthropic")
      .gte("created_at", start.toISOString());
    return data?.reduce((sum: number, r: { cost_cents: number }) => sum + (r.cost_cents ?? 0), 0) ?? 0;
  } catch {
    return 0;
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { id } = params;
  if (!id) return NextResponse.json({ summary: null });

  const db = createAdminClient();

  // 1. Cache check
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cacheRes = await (db as any)
      .from("ai_summary_cache")
      .select("summary_text")
      .eq("entity_type", "proposal")
      .eq("entity_id", id)
      .maybeSingle();

    if (cacheRes.data?.summary_text) {
      return withPublicCdnCache(NextResponse.json({ summary: cacheRes.data.summary_text }));
    }
  } catch {
    // cache miss — proceed
  }

  // Kill switch: when AI_SUMMARIES_ENABLED=false, refuse on cache miss
  // instead of calling Anthropic. Mirrors the guard in
  // packages/ai/src/client.ts#generateSummary.
  if (process.env["AI_SUMMARIES_ENABLED"] === "false") {
    return NextResponse.json({ summary: null, error: "disabled" });
  }

  // 2. Fetch proposal
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proposalRes = await (db as any)
    .from("proposals")
    .select("id, title, summary_plain, status, metadata")
    .eq("id", id)
    .maybeSingle();

  const proposal = proposalRes.data;
  if (!proposal) return NextResponse.json({ summary: null });

  // comment_period_end and agency_id are metadata-only post-cutover (FIX-425).
  const commentPeriodEnd: string | null = proposal.metadata?.comment_period_end ?? null;
  const agencyId: string | null = proposal.metadata?.agency_id ?? null;

  // Only generate for open proposals
  const isOpen =
    proposal.status === "open_comment" &&
    commentPeriodEnd &&
    new Date(commentPeriodEnd) > new Date();

  if (!isOpen) return NextResponse.json({ summary: null });

  // 3. Cost cap check
  const spent = await getMonthlySpendCents(db);
  if (spent >= MONTHLY_SPEND_LIMIT_CENTS) {
    return NextResponse.json({ summary: null, error: "monthly_cap_reached" });
  }

  // 4. Fetch agency name
  let agencyLine = "Federal Agency";
  if (agencyId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agencyRes = await (db as any)
      .from("agencies")
      .select("name, acronym")
      .eq("id", agencyId)
      .maybeSingle();
    if (agencyRes.data) {
      agencyLine = agencyRes.data.name ?? agencyRes.data.acronym ?? "Federal Agency";
    }
  }

  // 5. Generate
  try {
    const ai = createAiClient();

    const userPrompt =
      `Summarize this federal proposal in 2-3 sentences in plain language.\n` +
      `Focus on: what is changing, who is affected, and why it matters.\n\n` +
      `Agency: ${agencyLine}\n` +
      `Title: ${proposal.title}\n` +
      `Summary: ${proposal.summary_plain ?? "No summary provided"}\n\n` +
      `Write as if explaining to someone with no policy background.`;

    const response = await ai.messages.create({
      model: MODELS.haiku,
      max_tokens: 300,
      system:
        "You are a plain language expert helping ordinary citizens understand federal regulations. " +
        "Write clear, jargon-free summaries that explain what a proposal means for real people. " +
        "Be factual and neutral. Never editorialize. " +
        "Write in plain prose only — no markdown, no headers, no bullet points, no bold text.",
      messages: [{ role: "user", content: userPrompt }],
    });

    const summaryText =
      response.content[0]?.type === "text" ? response.content[0].text.trim() : "";

    if (!summaryText) return NextResponse.json({ summary: null });

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const tokensUsed = inputTokens + outputTokens;
    // FIX-893: was Math.ceil((in*0.00025 + out*0.00125)/10) — a fourth private
    // copy of Haiku-3-era pricing, ~4x low. cost_cents is DECIMAL(10,4), so keep
    // exact fractional cents rather than ceiling to whole cents.
    const costCents = calculateCostUsd(inputTokens, outputTokens, MODELS.haiku) * 100;

    // Cache + log (parallel, non-blocking errors)
    await Promise.all([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db as any).from("ai_summary_cache").upsert(
        {
          entity_type: "proposal",
          entity_id: id,
          summary_type: "plain_language",
          summary_text: summaryText,
          model: MODELS.haiku,
          tokens_used: tokensUsed,
        },
        { onConflict: "entity_type,entity_id,summary_type" }
      ),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db as any).from("api_usage_logs").insert({
        service: "anthropic",
        endpoint: "proposal_summary_ondemand",
        model: MODELS.haiku,
        tokens_used: tokensUsed,
        cost_cents: costCents,
      }),
    ]);

    return withPublicCdnCache(NextResponse.json({ summary: summaryText }));
  } catch (err) {
    console.error("[/api/proposals/[id]/summary]", err);
    return NextResponse.json({ summary: null });
  }
}
