/**
 * GET /api/officials/[id]/summary
 *
 * On-demand civic profile summary for an official.
 *
 * Flow:
 *  1. Check ai_summary_cache — return immediately if found
 *  2. Fetch official data (votes + donors)
 *  3. Only generate if official has at least some record
 *  4. Check monthly spend cap ($4.00)
 *  5. Generate with Haiku, cache, log usage
 */

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@civitics/db";
import { createAiClient, MODELS } from "@civitics/ai";

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
      .eq("entity_type", "official")
      .eq("entity_id", id)
      .eq("summary_type", "profile")
      .maybeSingle();

    if (cacheRes.data?.summary_text) {
      return NextResponse.json({ summary: cacheRes.data.summary_text });
    }
  } catch {
    // cache miss — proceed
  }

  // 2. Fetch official
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const officialRes = await (db as any)
    .from("officials")
    .select("id, full_name, role_title, party, metadata, is_active")
    .eq("id", id)
    .maybeSingle();

  const official = officialRes.data;
  if (!official) return NextResponse.json({ summary: null });

  // Get vote count
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const voteCountRes = await (db as any)
    .from("votes")
    .select("id", { count: "exact", head: true })
    .eq("official_id", id);

  // Get donor count + total
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const donorRes = await (db as any)
    .from("financial_relationships")
    .select("amount_cents")
    .eq("official_id", id);

  const voteCount = voteCountRes.count ?? 0;
  const donorCount = (donorRes.data ?? []).length;
  const totalRaisedCents = (donorRes.data ?? []).reduce(
    (sum: number, r: { amount_cents: number }) => sum + (r.amount_cents ?? 0),
    0
  );

  // Only generate if there's meaningful data
  if (voteCount === 0 && donorCount === 0) {
    return NextResponse.json({ summary: null });
  }

  // 3. Cost cap check
  const spent = await getMonthlySpendCents(db);
  if (spent >= MONTHLY_SPEND_LIMIT_CENTS) {
    return NextResponse.json({ summary: null, error: "monthly_cap_reached" });
  }

  // 4. Generate
  try {
    const ai = createAiClient();

    const totalRaisedDollars = (totalRaisedCents / 100).toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    });

    const userPrompt =
      `Write a 2-sentence factual profile of this official based on their record.\n` +
      `Focus on their role and legislative activity. Be completely neutral.\n\n` +
      `Name: ${official.full_name}\n` +
      `Title: ${official.role_title}\n` +
      `State: ${official.metadata?.state ?? "Unknown"}\n` +
      `Party: ${official.party ?? "Unknown"}\n` +
      `Votes on record: ${voteCount.toLocaleString()}\n` +
      `Donor relationships: ${donorCount.toLocaleString()}\n` +
      `Total raised: ${totalRaisedDollars}`;

    const response = await ai.messages.create({
      model: MODELS.haiku,
      max_tokens: 200,
      system:
        "You are a civic analyst writing neutral factual profiles of elected officials for citizens. " +
        "Be factual, balanced, and brief. " +
        "Write in plain prose only — no markdown, no headers, no bullet points, no bold text.",
      messages: [{ role: "user", content: userPrompt }],
    });

    const summaryText =
      response.content[0]?.type === "text" ? response.content[0].text.trim() : "";

    if (!summaryText) return NextResponse.json({ summary: null });

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const tokensUsed = inputTokens + outputTokens;
    const costCents = Math.ceil((inputTokens * 0.00025 + outputTokens * 0.00125) / 10);

    await Promise.all([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db as any).from("ai_summary_cache").upsert(
        {
          entity_type: "official",
          entity_id: id,
          summary_type: "profile",
          summary_text: summaryText,
          model: MODELS.haiku,
          tokens_used: tokensUsed,
        },
        { onConflict: "entity_type,entity_id,summary_type" }
      ),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db as any).from("api_usage_logs").insert({
        service: "anthropic",
        endpoint: "official_profile_ondemand",
        model: MODELS.haiku,
        tokens_used: tokensUsed,
        cost_cents: costCents,
      }),
    ]);

    return NextResponse.json({ summary: summaryText });
  } catch (err) {
    console.error("[/api/officials/[id]/summary]", err);
    return NextResponse.json({ summary: null });
  }
}
