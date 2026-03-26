/**
 * GET /api/platform/anthropic
 *
 * Live Anthropic usage data from the Anthropic Admin API.
 * Returns three time windows (last hour, last 24h, this month) with
 * token counts, costs, per-model breakdown, and budget status.
 *
 * Cached at edge for 5 minutes — Anthropic API has rate limits.
 * Never returns 500 — always returns 200 with error field if unavailable.
 */

export const revalidate = 300; // 5-minute edge cache

import { getAnthropicUsage } from "@civitics/db";
import { NextResponse } from "next/server";

export async function GET() {
  const data = await getAnthropicUsage();
  return NextResponse.json(data);
}
