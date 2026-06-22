/**
 * Cron-triggered platform usage + status snapshot.
 *
 * Fires every 10 minutes from .github/workflows/platform-snapshot.yml, which
 * curls this endpoint with `Authorization: Bearer <CRON_SECRET>`. Vercel
 * Hobby blocks sub-daily cron expressions, so the schedule lives in GHA
 * rather than vercel.json. The auth shape is identical to the
 * Vercel-internal cron header (Bearer + CRON_SECRET), so swapping back to
 * a vercel.json entry on Pro would be a one-line change.
 *
 * Two independent writes:
 *  1. platform_usage_snapshot (FIX-281) — vendor-API + DB-sum aggregation
 *     that used to run inside /api/platform/usage on every request.
 *  2. status_snapshot (FIX-297) — 11-section /api/claude/status/* payload
 *     that used to run on every dashboard load and every status request.
 *
 * Each write is wrapped in its own try/catch so one failing doesn't block
 * the other. Returns a lightweight ack — full payloads live in the snapshot
 * rows themselves.
 */

export const dynamic = "force-dynamic";

import { NextResponse, type NextRequest } from "next/server";
import {
  createAdminClient,
  writePlatformUsageSnapshot,
  type PlatformUsagePayload,
} from "@civitics/db";
import { writeStatusSnapshot } from "../../claude/status/_lib/status-snapshot";
import { sendEmail, renderKillSwitchEmail, renderMetricAlertEmail } from "@/lib/email";

const SITE_URL_FALLBACK = "https://civitics-civitics.vercel.app";

// Status ordering for escalation detection. We email only when a metric moves
// UP this scale (healthy→warning, healthy→critical, warning→critical); a missing
// prior row is treated as "healthy".
const STATUS_RANK: Record<string, number> = { healthy: 0, warning: 1, critical: 2 };

/**
 * FIX-γ — edge-triggered per-metric threshold alerts.
 *
 * Compares each metric's current status against platform_alert_state.last_status
 * and emails the admin only on ESCALATION, then records the new status so the
 * 10-min cron doesn't re-page while the metric sits in the same band. Metrics
 * with source='estimated' (e.g. the NIC egress upper-bound proxy) are skipped so
 * they never alert. Best-effort: all failures are logged, never thrown.
 */
async function emailMetricThresholdAlerts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  payload: PlatformUsagePayload,
  adminEmail: string,
  siteUrl: string,
): Promise<void> {
  // Load prior states once; we compare every metric's current status against it.
  const { data: priorRows, error: readErr } = await db
    .from("platform_alert_state")
    .select("metric_key, last_status");
  if (readErr) {
    console.warn(`[metric alert] could not read platform_alert_state: ${readErr.message}`);
  }
  const prior = new Map<string, string>(
    (priorRows ?? []).map((r: { metric_key: string; last_status: string }) => [
      r.metric_key,
      r.last_status,
    ]),
  );

  const nowIso = new Date().toISOString();

  // Update state for EVERY non-estimated metric (so de-escalations are recorded),
  // but only email on escalation.
  const alertable = payload.metrics.filter(
    (m) => m.value !== null && m.source !== "estimated",
  );

  await Promise.allSettled(
    alertable.map(async (m) => {
      const key = `${m.service}.${m.metric}`;
      const prevRank = STATUS_RANK[prior.get(key) ?? "healthy"] ?? 0;
      const currRank = STATUS_RANK[m.status] ?? 0;
      const escalated = currRank > prevRank;

      if (escalated && (m.status === "warning" || m.status === "critical")) {
        const { subject, html } = renderMetricAlertEmail({
          service: m.service,
          metric: m.metric,
          display_label: m.display_label ?? m.metric,
          value: m.value as number,
          limit: m.included_limit,
          unit: m.unit,
          pct: m.pct,
          status: m.status,
          siteUrl,
        });
        const sendResult = await sendEmail({ to: adminEmail, subject, html });
        if (!sendResult.sent) {
          console.warn(`[metric alert] not sent (${key}): ${sendResult.reason}`);
        }
      }

      // Record current status regardless of direction so the next escalation is
      // measured from the right baseline. Only bump last_alerted_at on a send.
      const upsertRow = escalated
        ? { metric_key: key, last_status: m.status, last_alerted_at: nowIso }
        : { metric_key: key, last_status: m.status };
      const { error: upsertErr } = await db
        .from("platform_alert_state")
        .upsert(upsertRow, { onConflict: "metric_key" });
      if (upsertErr) {
        console.warn(`[metric alert] state upsert failed (${key}): ${upsertErr.message}`);
      }
    }),
  );
}

/**
 * FIX-642 — leading-signal early-warning alert.
 *
 * The emailMetricThresholdAlerts path above tracks monthly CUMULATIVE usage —
 * a LAGGING indicator — and is gated behind EMAIL_ALERTS_ENABLED. This is the
 * leading layer: a low-threshold page on a FAST-moving signal (Supabase
 * db_connections nearing the 60 ceiling → connection exhaustion → live-site
 * 503s) that fires regardless of the EMAIL_ALERTS_ENABLED master toggle, so a
 * real spike pages even when cumulative-cost alerting is intentionally muted.
 *
 * Debounced on a dedicated platform_alert_state key (rising-edge only) so it
 * pages once per spike, not every cron tick. Threshold is env-overridable
 * (LEADING_DB_CONN_THRESHOLD, default 45 = 75% of the 60-connection ceiling —
 * below the platform_limits 80% warning band so it genuinely leads the standard
 * alert). Set it low in a verify run to confirm firing. Best-effort: never
 * throws. db_connections is source='api' (not 'estimated'), so the FIX-α
 * estimated-skip does not apply here.
 */
async function emailLeadingSignalAlerts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  payload: PlatformUsagePayload,
  adminEmail: string,
  siteUrl: string,
): Promise<void> {
  const threshold = Number(process.env["LEADING_DB_CONN_THRESHOLD"] ?? 45);
  const metric = payload.metrics.find(
    (m) => m.service === "supabase" && m.metric === "db_connections",
  );
  // Only act on a live (source='api') numeric reading — a stale manual/estimated
  // value isn't a real-time spike signal.
  if (!metric || metric.value === null || metric.source !== "api") return;

  const alertKey = "leading.supabase.db_connections";
  const elevated = metric.value >= threshold;

  const { data: priorRow, error: readErr } = await db
    .from("platform_alert_state")
    .select("last_status")
    .eq("metric_key", alertKey)
    .maybeSingle();
  if (readErr) {
    console.warn(`[leading alert] could not read state (${alertKey}): ${readErr.message}`);
  }
  const prevElevated = priorRow?.last_status === "elevated";

  // Rising edge into the danger zone → page once.
  if (elevated && !prevElevated) {
    const { subject, html } = renderMetricAlertEmail({
      service: "supabase",
      metric: "db_connections",
      display_label: "DB Connections (leading signal)",
      value: metric.value,
      limit: metric.included_limit,
      unit: metric.unit,
      pct: metric.pct,
      status: metric.status === "critical" ? "critical" : "warning",
      siteUrl,
    });
    const sendResult = await sendEmail({ to: adminEmail, subject, html });
    if (!sendResult.sent) {
      console.warn(`[leading alert] not sent (${alertKey}): ${sendResult.reason}`);
    }
  }

  // Record the current band so the next page only fires on a fresh
  // normal→elevated transition. Bump last_alerted_at only on the rising edge.
  const nowIso = new Date().toISOString();
  const upsertRow =
    elevated && !prevElevated
      ? { metric_key: alertKey, last_status: "elevated", last_alerted_at: nowIso }
      : { metric_key: alertKey, last_status: elevated ? "elevated" : "normal" };
  const { error: upsertErr } = await db
    .from("platform_alert_state")
    .upsert(upsertRow, { onConflict: "metric_key" });
  if (upsertErr) {
    console.warn(`[leading alert] state upsert failed (${alertKey}): ${upsertErr.message}`);
  }
}

/**
 * FIX-648 — leading-signal alert on the Vercel fluid-compute cost driver.
 *
 * Provisioned fluid memory bills during I/O wait, so a fan-out / low-and-slow
 * crawl spikes its DOLLAR cost before any quantity hits a plan limit (Vercel Pro
 * is credit-based — there is no GB-hr allotment to breach). This pages on the
 * projected monthly run-rate of fluid memory + fluid CPU dollars (from
 * payload.vercel_breakdown) crossing LEADING_FLUID_USD_THRESHOLD (default 8 =
 * 40% of the $20 Pro credit) — BEFORE the dollar cap trips. Ungated (mirrors the
 * db_connections leading alert, FIX-643) and rising-edge debounced via a
 * dedicated platform_alert_state key so it pages once per spike. Set the env low
 * in a verify run to confirm firing.
 */
async function emailLeadingFluidCostAlerts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  payload: PlatformUsagePayload,
  adminEmail: string,
  siteUrl: string,
): Promise<void> {
  const breakdown = payload.vercel_breakdown;
  if (!breakdown || breakdown.services.length === 0) return;

  const find = (needle: string): number =>
    breakdown.services.find((s) => s.service.toLowerCase().includes(needle))?.usd ?? 0;
  const memUsd = find("provisioned memory"); // "Fluid Provisioned Memory"
  const cpuUsd = find("active cpu"); // "Fluid Active CPU"
  const fluidUsd = memUsd + cpuUsd;

  const threshold = Number(process.env["LEADING_FLUID_USD_THRESHOLD"] ?? 8);
  const CREDIT = 20; // $20 Pro monthly credit — the real fluid ceiling.
  const alertKey = "leading.vercel.fluid_compute_usd";
  const elevated = fluidUsd >= threshold;

  const { data: priorRow, error: readErr } = await db
    .from("platform_alert_state")
    .select("last_status")
    .eq("metric_key", alertKey)
    .maybeSingle();
  if (readErr) {
    console.warn(`[leading fluid] could not read state (${alertKey}): ${readErr.message}`);
  }
  const prevElevated = priorRow?.last_status === "elevated";

  if (elevated && !prevElevated) {
    const pct = (fluidUsd / CREDIT) * 100;
    const { subject, html } = renderMetricAlertEmail({
      service: "vercel",
      metric: "fluid_compute_usd",
      display_label: `Fluid compute run-rate (mem $${memUsd.toFixed(2)} + cpu $${cpuUsd.toFixed(2)}/mo)`,
      value: fluidUsd,
      limit: CREDIT,
      unit: "usd",
      pct,
      status: pct >= 90 ? "critical" : "warning",
      siteUrl,
    });
    const sendResult = await sendEmail({ to: adminEmail, subject, html });
    if (!sendResult.sent) {
      console.warn(`[leading fluid] not sent (${alertKey}): ${sendResult.reason}`);
    }
  }

  const nowIso = new Date().toISOString();
  const upsertRow =
    elevated && !prevElevated
      ? { metric_key: alertKey, last_status: "elevated", last_alerted_at: nowIso }
      : { metric_key: alertKey, last_status: elevated ? "elevated" : "normal" };
  const { error: upsertErr } = await db
    .from("platform_alert_state")
    .upsert(upsertRow, { onConflict: "metric_key" });
  if (upsertErr) {
    console.warn(`[leading fluid] state upsert failed (${alertKey}): ${upsertErr.message}`);
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get("authorization");
  const expected = `Bearer ${process.env["CRON_SECRET"] ?? ""}`;

  if (!process.env["CRON_SECRET"] || authHeader !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createAdminClient();

  // Two independent writes — wrap each so one failing doesn't block the
  // other. FIX-297: status_snapshot is meaningful on its own even when the
  // vendor-API platform pass fails, and vice versa.
  const platformSettled = await Promise.allSettled([writePlatformUsageSnapshot(db)]);
  const statusSettled = await Promise.allSettled([writeStatusSnapshot(db)]);

  const platformOutcome = platformSettled[0]!;
  const statusOutcome = statusSettled[0]!;

  const platform_snapshot_ok = platformOutcome.status === "fulfilled";
  const status_snapshot_ok = statusOutcome.status === "fulfilled";

  // FIX-288: email the admin on any auto-trip flip. Best-effort —
  // sendEmail no-ops when RESEND_API_KEY/RESEND_FROM are missing and
  // the gate is a separate per-environment toggle so a verified Resend
  // setup doesn't start paging the moment the API key is added.
  if (platformOutcome.status === "fulfilled" && process.env["EMAIL_ALERTS_ENABLED"] === "true") {
    const result = platformOutcome.value;
    const adminEmail = process.env["ADMIN_EMAIL"];
    if (adminEmail) {
      const siteUrl = process.env["NEXT_PUBLIC_SITE_URL"] ?? SITE_URL_FALLBACK;
      const flips = result.payload.auto_trip_decisions.filter(
        (d) => d.action === "flip",
      );
      await Promise.allSettled(
        flips.map(async (d) => {
          const { subject, html } = renderKillSwitchEmail({
            switch_name: d.switch_name,
            trigger_metric: d.trigger_metric,
            trigger_value: d.trigger_value,
            threshold_pct: d.threshold_pct,
            flipped_to: false,
            source: "auto",
            flipped_at: result.payload.timestamp,
            siteUrl,
          });
          const sendResult = await sendEmail({ to: adminEmail, subject, html });
          if (!sendResult.sent) {
            console.warn(
              `[kill-switch email] not sent (${d.switch_name}): ${sendResult.reason}`,
            );
          }
        }),
      );

      // FIX-γ: edge-triggered per-metric threshold alerts (separate from the
      // kill-switch flips above). Debounced via platform_alert_state so we only
      // page once per escalation, not every 10-min tick.
      await emailMetricThresholdAlerts(db, result.payload, adminEmail, siteUrl);
    }
  }

  // FIX-642: leading-signal alert runs OUTSIDE the EMAIL_ALERTS_ENABLED gate —
  // connection exhaustion takes the live site down, so it pages whenever a
  // recipient is configured even with cumulative-cost alerting muted. sendEmail
  // still no-ops without RESEND keys, so this is safe to leave always-on.
  if (platformOutcome.status === "fulfilled") {
    const adminEmail = process.env["ADMIN_EMAIL"];
    if (adminEmail) {
      const siteUrl = process.env["NEXT_PUBLIC_SITE_URL"] ?? SITE_URL_FALLBACK;
      await emailLeadingSignalAlerts(
        db,
        platformOutcome.value.payload,
        adminEmail,
        siteUrl,
      );
      // FIX-648: leading alert on the Vercel fluid-compute cost driver (dollars).
      await emailLeadingFluidCostAlerts(
        db,
        platformOutcome.value.payload,
        adminEmail,
        siteUrl,
      );
    }
  }

  const platformResult = platformOutcome.status === "fulfilled" ? platformOutcome.value : null;
  const statusResult = statusOutcome.status === "fulfilled" ? statusOutcome.value : null;
  const platformErr =
    platformOutcome.status === "rejected"
      ? platformOutcome.reason instanceof Error
        ? platformOutcome.reason.message
        : String(platformOutcome.reason)
      : null;
  const statusErr =
    statusOutcome.status === "rejected"
      ? statusOutcome.reason instanceof Error
        ? statusOutcome.reason.message
        : String(statusOutcome.reason)
      : null;

  return NextResponse.json({
    ok: platform_snapshot_ok || status_snapshot_ok,
    platform_snapshot_ok,
    status_snapshot_ok,
    fetched_at: platformResult?.payload.timestamp ?? new Date().toISOString(),
    any_critical: platformResult?.any_critical ?? null,
    any_warning: platformResult?.any_warning ?? null,
    total_overage_cost: platformResult?.total_overage_cost ?? null,
    // PR 3 (FIX-286): one-glance log signal so we don't need to query
    // kill_switch_events from the GHA workflow log to spot a flip.
    auto_trips_flipped: platformResult?.auto_trips_flipped ?? 0,
    status_query_time_ms: statusResult?.query_time_ms ?? null,
    partial:
      (platformResult?.error ?? null) !== null ||
      (statusResult?.error ?? null) !== null ||
      !platform_snapshot_ok ||
      !status_snapshot_ok,
    error:
      [
        platformErr && `platform: ${platformErr}`,
        statusErr && `status: ${statusErr}`,
        platformResult?.error && `platform_partial: ${platformResult.error}`,
        statusResult?.error && `status_partial: ${statusResult.error}`,
      ]
        .filter(Boolean)
        .join("; ") || null,
  });
}
