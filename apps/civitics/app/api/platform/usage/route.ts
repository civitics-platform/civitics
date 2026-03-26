/**
 * GET  /api/platform/usage  — Platform resource usage with limits
 * POST /api/platform/usage  — Admin: update/verify/upgrade (requires X-Admin-Key)
 *
 * GET is cached at edge for 1 hour. Anthropic cost is always fetched live
 * from api_usage_logs and upserted before responding.
 */

export const dynamic = "force-dynamic";

import { createAdminClient } from "@civitics/db";
import {
  getPlatformUsage,
  updateUsage,
  verifyUsage,
  upgradeServicePlan,
  calculateOverageCost,
  getSourceDisplay,
  type PlanTier,
  type UsageSource,
} from "@civitics/db";
import { NextResponse } from "next/server";

// ── Types ─────────────────────────────────────────────────────────────────────

type UsageRow = {
  input_tokens: number | null;
  output_tokens: number | null;
  cost_cents: number | null;
};

// ── Anthropic live spend ──────────────────────────────────────────────────────

async function getMonthlyAnthropicSpend(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
): Promise<number | null> {
  try {
    const monthStart = new Date(
      new Date().getFullYear(),
      new Date().getMonth(),
      1,
    ).toISOString();

    const { data: rows } = await db
      .from("api_usage_logs")
      .select("input_tokens, output_tokens, cost_cents")
      .eq("service", "anthropic")
      .gte("created_at", monthStart);

    if (!rows) return null;

    const total = ((rows as UsageRow[]) ?? []).reduce((sum, r) => {
      if (r.input_tokens != null && r.output_tokens != null) {
        return sum + (r.input_tokens * 0.25 + r.output_tokens * 1.25) / 1_000_000;
      }
      return sum + (r.cost_cents ?? 0) / 100;
    }, 0);

    return Math.round(total * 10000) / 10000;
  } catch {
    return null;
  }
}

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = createAdminClient() as any;

    // Read per-service plan overrides from pipeline_state
    const { data: planState } = await db
      .from("pipeline_state")
      .select("value")
      .eq("key", "platform_plan")
      .maybeSingle();

    const planOverrides = (planState?.value as Record<string, string> | null) ?? {};
    // Default plan for services not explicitly overridden
    const defaultPlan: PlanTier = "free";

    // Auto-update Anthropic from live api_usage_logs (source = 'api')
    const anthropicSpend = await getMonthlyAnthropicSpend(db);
    if (anthropicSpend !== null) {
      await updateUsage(db, "anthropic", "monthly_spend_usd", anthropicSpend, "api");
    }

    // Determine which plans to query for each service
    // Since getPlatformUsage takes a single plan, we handle the common case:
    // most services are on 'free', upgrades stored in planOverrides per-service.
    // For simplicity we fetch free plan limits for all, then re-fetch pro overrides.
    const freePlan = defaultPlan;
    const allMetrics = await getPlatformUsage(db, freePlan);

    // Apply per-service plan overrides: if a service has a non-free plan,
    // re-fetch its limits at the correct tier and merge
    const upgradedServices = Object.entries(planOverrides).filter(
      ([, plan]) => plan !== freePlan,
    );

    let finalMetrics = allMetrics;

    if (upgradedServices.length > 0) {
      // For each upgraded service, get pro metrics and splice them in
      const overrideResults = await Promise.all(
        upgradedServices.map(async ([service, plan]) => ({
          service,
          metrics: await getPlatformUsage(db, plan as PlanTier),
        })),
      );

      finalMetrics = allMetrics.filter(
        (m) => !upgradedServices.some(([svc]) => svc === m.service),
      );

      for (const { service, metrics } of overrideResults) {
        finalMetrics.push(...metrics.filter((m) => m.service === service));
      }

      // Re-sort: by service name, then sort_order
      finalMetrics.sort((a, b) =>
        a.service === b.service
          ? a.sort_order - b.sort_order
          : a.service.localeCompare(b.service),
      );
    }

    // Group by service
    const byService: Record<string, typeof finalMetrics> = {};
    for (const m of finalMetrics) {
      if (!byService[m.service]) byService[m.service] = [];
      byService[m.service]!.push(m);
    }

    // Summary calculations
    let totalOverageCost = 0;
    const metricsWithValues = finalMetrics.filter((m) => m.value !== null);

    for (const m of metricsWithValues) {
      totalOverageCost += m.overage_cost;
    }

    // Top 3 by pct
    const top3ByPct = [...metricsWithValues]
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 3);

    // Top 3 by cost
    const top3ByCost = [...metricsWithValues]
      .sort((a, b) => b.overage_cost - a.overage_cost || b.pct - a.pct)
      .slice(0, 3);

    const anyCritical = metricsWithValues.some((m) => m.status === "critical");
    const anyWarning = metricsWithValues.some((m) => m.status === "warning");
    const needsVerification = metricsWithValues.some(
      (m) => m.source_display.needsVerification,
    );

    const criticalCount = metricsWithValues.filter((m) => m.status === "critical").length;
    const warningCount = metricsWithValues.filter((m) => m.status === "warning").length;
    const unverifiedCount = metricsWithValues.filter(
      (m) => m.source_display.needsVerification,
    ).length;

    return NextResponse.json({
      plan: defaultPlan,
      plan_overrides: planOverrides,
      metrics: finalMetrics,
      by_service: byService,
      total_metrics: finalMetrics.length,
      summary: {
        total_overage_cost: totalOverageCost,
        top3_by_pct: top3ByPct,
        top3_by_cost: top3ByCost,
        any_critical: anyCritical,
        any_warning: anyWarning,
        needs_verification: needsVerification,
        critical_count: criticalCount,
        warning_count: warningCount,
        unverified_count: unverifiedCount,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

// ── POST (admin only) ─────────────────────────────────────────────────────────

export async function POST(request: Request) {
  // Simple admin auth: X-Admin-Key header must match ADMIN_SECRET env var
  const adminKey = request.headers.get("x-admin-key");
  const adminSecret = process.env["ADMIN_SECRET"];

  if (!adminSecret || adminKey !== adminSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  const { action, service, metric, value, plan } = body as {
    action: string;
    service?: string;
    metric?: string;
    value?: number;
    plan?: string;
  };

  try {
    switch (action) {
      case "update_usage": {
        if (!service || !metric || value === undefined) {
          return NextResponse.json(
            { error: "service, metric, value required" },
            { status: 400 },
          );
        }
        await updateUsage(db, service, metric, value, "manual");
        return NextResponse.json({ ok: true, action: "update_usage", service, metric, value });
      }

      case "verify_usage": {
        if (!service || !metric) {
          return NextResponse.json(
            { error: "service, metric required" },
            { status: 400 },
          );
        }
        await verifyUsage(db, service, metric, "admin");
        return NextResponse.json({ ok: true, action: "verify_usage", service, metric });
      }

      case "upgrade_plan": {
        if (!service || !plan) {
          return NextResponse.json(
            { error: "service, plan required" },
            { status: 400 },
          );
        }
        await upgradeServicePlan(db, service, plan as PlanTier);
        return NextResponse.json({ ok: true, action: "upgrade_plan", service, plan });
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 },
        );
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

