/**
 * GET /api/platform/anthropic
 *
 * Live Anthropic usage data from the Anthropic Admin API.
 * Returns three time windows (last hour, last 24h, this month) with
 * token counts, costs, per-model breakdown, and budget status.
 *
 * DB-cached for 15 minutes — writes to platform_usage on each API fetch.
 * Stale DB data returned if the API is unavailable.
 * Never returns 500 — always returns 200 with error field if unavailable.
 */

export const dynamic = "force-dynamic";

import { createAdminClient, getAnthropicUsage, updateUsage } from "@civitics/db";
import { NextResponse } from "next/server";

const CACHE_TTL_MINUTES = 15;

function buildBudget(spentUsd: number) {
  const limitUsd = parseFloat(process.env["ANTHROPIC_MONTHLY_BUDGET"] ?? "") || 3.5;
  const pctUsed = limitUsd > 0 ? (spentUsd / limitUsd) * 100 : 0;
  return {
    limit_usd: limitUsd,
    spent_usd: spentUsd,
    remaining_usd: Math.max(0, limitUsd - spentUsd),
    pct_used: Math.round(pctUsed * 10) / 10,
    warning: pctUsed > 80,
    critical: pctUsed > 95,
  };
}

function buildCachedThisMonth(spendUsd: number, totalTokens: number) {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: totalTokens,
    cost_usd: spendUsd,
    by_model: [],
  };
}

export async function GET() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createAdminClient() as any;

  const monthStart = new Date(
    new Date().getFullYear(),
    new Date().getMonth(),
    1,
  ).toISOString();

  // 1. Check DB for a recent spend entry this month
  const { data: cached } = await supabase
    .from("platform_usage")
    .select("value, source, recorded_at")
    .eq("service", "anthropic")
    .eq("metric", "monthly_spend_usd")
    .eq("period_start", monthStart)
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const ageMinutes = cached?.recorded_at
    ? (Date.now() - new Date(cached.recorded_at as string).getTime()) / 60_000
    : Infinity;

  const isFresh = ageMinutes < CACHE_TTL_MINUTES;

  if (isFresh && cached) {
    const { data: tokenRow } = await supabase
      .from("platform_usage")
      .select("value")
      .eq("service", "anthropic")
      .eq("metric", "monthly_tokens")
      .eq("period_start", monthStart)
      .maybeSingle();

    return NextResponse.json({
      last_hour: null,
      last_24h: null,
      this_month: buildCachedThisMonth(
        cached.value as number,
        (tokenRow?.value as number) ?? 0,
      ),
      budget: buildBudget(cached.value as number),
      source: cached.source as string,
      fetched_at: cached.recorded_at as string,
      cache: {
        hit: true,
        age_minutes: Math.round(ageMinutes),
        recorded_at: cached.recorded_at as string,
        source: cached.source as string,
      },
    });
  }

  // 2. Fetch from Anthropic Admin API (has its own 5-min in-memory cache)
  const data = await getAnthropicUsage();

  if ("error" in data) {
    // API failed — serve stale DB data if available
    if (cached) {
      const { data: tokenRow } = await supabase
        .from("platform_usage")
        .select("value")
        .eq("service", "anthropic")
        .eq("metric", "monthly_tokens")
        .eq("period_start", monthStart)
        .maybeSingle();

      return NextResponse.json({
        last_hour: null,
        last_24h: null,
        this_month: buildCachedThisMonth(
          cached.value as number,
          (tokenRow?.value as number) ?? 0,
        ),
        budget: buildBudget(cached.value as number),
        source: cached.source as string,
        fetched_at: cached.recorded_at as string,
        cache: {
          hit: true,
          stale: true,
          age_minutes: Math.round(ageMinutes),
          recorded_at: cached.recorded_at as string,
          error: "API unavailable, serving stale data",
        },
      });
    }
    return NextResponse.json({
      ...data,
      cache: {
        hit: false,
        age_minutes: 0,
        recorded_at: new Date().toISOString(),
        source: "api",
      },
    });
  }

  // 3. Write fresh data to DB
  const now = new Date().toISOString();
  await Promise.all([
    updateUsage(supabase, "anthropic", "monthly_spend_usd", data.this_month.cost_usd, "api"),
    updateUsage(supabase, "anthropic", "monthly_tokens", data.this_month.total_tokens, "api"),
  ]);

  return NextResponse.json({
    ...data,
    cache: {
      hit: false,
      age_minutes: 0,
      recorded_at: now,
      source: data.source,
    },
  });
}
