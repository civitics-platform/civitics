/**
 * GET /api/platform/vercel
 *
 * Current-month Vercel billing charges from the Vercel Billing API.
 * Parses JSONL response, groups by charge description, and returns
 * aggregated metrics and total cost.
 *
 * Cached at edge for 1 hour — billing data doesn't change that fast.
 * Never returns 500 — always 200 with error field if unavailable.
 */

export const revalidate = 3600; // Cache 1 hour

import { NextResponse } from "next/server";

interface VercelMetric {
  label: string;
  quantity: number;
  cost_usd: number;
  unit: string;
}

export async function GET() {
  const token = process.env.VERCEL_API_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;

  if (!token) {
    return NextResponse.json({
      error: "No VERCEL_API_TOKEN",
      source: "unconfigured",
    });
  }

  const from = new Date(
    new Date().getFullYear(),
    new Date().getMonth(),
    1,
  ).toISOString();

  const to = new Date().toISOString();

  const url = new URL("https://api.vercel.com/v1/billing/charges");
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  if (teamId) url.searchParams.set("teamId", teamId);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        "Accept-Encoding": "gzip",
      },
      next: { revalidate: 3600 },
    });
  } catch (err) {
    return NextResponse.json({
      error: err instanceof Error ? err.message : String(err),
      source: "api_error",
    });
  }

  if (!res.ok) {
    return NextResponse.json({
      error: res.statusText,
      status: res.status,
      source: "api_error",
    });
  }

  const text = await res.text();
  const lines = text.trim().split("\n").filter(Boolean);

  const charges = lines
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, string | undefined>;
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Record<string, string | undefined>[];

  const metrics = new Map<string, VercelMetric>();

  for (const charge of charges) {
    const key =
      charge["ChargeDescription"] ?? charge["ResourceName"] ?? "Unknown";

    if (!metrics.has(key)) {
      metrics.set(key, {
        label: key,
        quantity: 0,
        cost_usd: 0,
        unit: charge["UsageUnit"] ?? "",
      });
    }

    const m = metrics.get(key)!;
    m.quantity += Number(charge["UsageQuantity"]) || 0;
    m.cost_usd += parseFloat(charge["BilledCost"] ?? "0");
  }

  const total_cost_usd = [...metrics.values()].reduce(
    (sum, m) => sum + m.cost_usd,
    0,
  );

  return NextResponse.json({
    metrics: Object.fromEntries(metrics),
    charges_count: charges.length,
    total_cost_usd,
    period: { from, to },
    source: "api",
    fetched_at: new Date().toISOString(),
  });
}
