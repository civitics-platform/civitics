/**
 * Cron-triggered platform usage + status snapshot.
 *
 * Fires every 30 minutes from the half-hourly `platform-snapshot` cron entry
 * in apps/civitics/vercel.json, which invokes this endpoint with
 * `Authorization: Bearer <CRON_SECRET>` — the same header the GHA workflow
 * used, so the move needed no protocol change here.
 *
 * FIX-1127 (2026-08-29) moved the schedule off GHA. The original reason for
 * GHA was Vercel Hobby rejecting sub-daily cron expressions; the project has
 * been on Pro since the April cutover, and GHA had stopped honouring its own
 * ten-minute schedule badly enough to matter — eight scheduled firings in 51
 * hours (mean ~6.4 h, shortest gap 3.2 h). The driver stays EXTERNAL to the
 * database on purpose: a pg_cron job that curls this route would couple the
 * tick to the health of the very database whose distress the dashboard exists
 * to show (the FIX-1120 lesson).
 *
 * .github/workflows/platform-snapshot.yml still exists — it carries the
 * request-path probe (FIX-1026), which is unrelated to this route.
 *
 * RECEIPT for the cadence claim above, since the whole point of FIX-1127 is
 * that a cron expression is not evidence: the first unattended firing after
 * the cutover landed a status_snapshot row at 2026-08-29T22:30:58Z, on the
 * :30 boundary, from deployment a82999b0 — nobody dispatched it and the GHA
 * trigger job no longer exists. Re-check the same way (a boundary row nobody
 * asked for) if this ever needs re-proving.
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
  BURN_ABSOLUTE_FLOOR_USD,
  type PlatformUsagePayload,
} from "@civitics/db";
import { writeStatusSnapshot } from "../../claude/status/_lib/status-snapshot";
import {
  sendEmail,
  renderKillSwitchEmail,
  renderMetricAlertEmail,
  renderMitigationEmail,
} from "@/lib/email";

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
 * 30-min cron doesn't re-page while the metric sits in the same band. Metrics
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

/**
 * FIX-1044 — leading-signal alert on Cloudflare origin-reaching volume.
 *
 * The THIRD leading-signal layer, and the one that would actually have caught
 * 2026-08-15. db_connections (FIX-642) watches the database; fluid-compute
 * dollars (FIX-648) watch a Vercel figure that only moves once per day. This
 * watches request volume at the edge, which is where every downstream cost
 * originates and is the only thing in the stack observable at hour resolution.
 *
 * ORIGIN-REACHING, not total edge requests: those are the requests that cost
 * money, and it makes the alert self-limiting — while a mitigation absorbs a
 * crawl, origin volume collapses and this correctly goes quiet instead of
 * paging about traffic nobody is paying for.
 *
 * Ungated (mirrors FIX-642/648 — a live burn pages even with cumulative-cost
 * alerting muted) and rising-edge debounced on its own platform_alert_state key
 * so it pages once per spike rather than every tick. Best-effort: never throws.
 */
async function emailLeadingEdgeVolumeAlerts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  payload: PlatformUsagePayload,
  adminEmail: string,
  siteUrl: string,
): Promise<void> {
  const edge = payload.cloudflare_edge;
  if (!edge?.latest) return;

  const threshold = Number(
    process.env["LEADING_CF_ORIGIN_REQ_THRESHOLD"] ?? edge.trip_threshold,
  );
  const value = edge.latest.origin_requests;
  const alertKey = "leading.cloudflare.origin_requests_hourly";
  const elevated = value >= threshold;

  const { data: priorRow, error: readErr } = await db
    .from("platform_alert_state")
    .select("last_status")
    .eq("metric_key", alertKey)
    .maybeSingle();
  if (readErr) {
    console.warn(`[leading edge] could not read state (${alertKey}): ${readErr.message}`);
  }
  const prevElevated = priorRow?.last_status === "elevated";

  if (elevated && !prevElevated) {
    const pct = (value / threshold) * 100;
    const { subject, html } = renderMetricAlertEmail({
      service: "cloudflare",
      metric: "origin_requests_hourly",
      display_label:
        `Origin requests/hr (leading signal) — hour ${edge.latest.hour}, ` +
        `${edge.latest.edge_requests.toLocaleString()} at the edge, ` +
        `${edge.latest.mitigated_pct.toFixed(0)}% absorbed`,
      value,
      limit: threshold,
      unit: "requests_per_hour",
      pct,
      status: pct >= 200 ? "critical" : "warning",
      siteUrl,
    });
    const sendResult = await sendEmail({ to: adminEmail, subject, html });
    if (!sendResult.sent) {
      console.warn(`[leading edge] not sent (${alertKey}): ${sendResult.reason}`);
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
    console.warn(`[leading edge] state upsert failed (${alertKey}): ${upsertErr.message}`);
  }
}

/**
 * FIX-1044 D2 — burn-rate alert on day-over-day consumption.
 *
 * The monthly-cumulative bands are a lagging control by construction: at
 * 2026-08-15's ~$21/day they would not have tripped for days. This fires on the
 * DERIVATIVE — today's consumption against the trailing-7-day median, gated on
 * BOTH an absolute floor and a multiple (see packages/db/src/burn-rate.ts for
 * why one condition alone produces either noise or silence).
 *
 * Routed through the existing platform_alert_state edge-trigger machinery with
 * a new key — a new SIGNAL, not new substrate. Ungated for the same reason as
 * the other leading alerts.
 */
async function emailBurnRateAlerts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  payload: PlatformUsagePayload,
  adminEmail: string,
  siteUrl: string,
): Promise<void> {
  const burn = payload.burn_rate;
  if (!burn || burn.latest_delta_usd === null) return;

  const alertKey = "burn.vercel.daily_usage_usd";

  const { data: priorRow, error: readErr } = await db
    .from("platform_alert_state")
    .select("last_status")
    .eq("metric_key", alertKey)
    .maybeSingle();
  if (readErr) {
    console.warn(`[burn rate] could not read state (${alertKey}): ${readErr.message}`);
  }
  const prevElevated = priorRow?.last_status === "elevated";

  if (burn.elevated && !prevElevated) {
    const { subject, html } = renderMetricAlertEmail({
      service: "vercel",
      metric: "daily_usage_usd",
      display_label:
        `Daily burn rate — ${burn.reason} (day ${burn.latest_mtd_day}, ` +
        `${burn.history_days}d of history)`,
      value: burn.latest_delta_usd,
      // Framed against the absolute floor, so the pct in the subject reads as
      // "how many times over the bar this day went" rather than a share of a
      // monthly allotment — which is the whole point of a rate alert.
      limit: BURN_ABSOLUTE_FLOOR_USD,
      unit: "usd",
      pct: (burn.latest_delta_usd / BURN_ABSOLUTE_FLOOR_USD) * 100,
      status: (burn.multiple ?? 0) >= 6 ? "critical" : "warning",
      siteUrl,
    });
    const sendResult = await sendEmail({ to: adminEmail, subject, html });
    if (!sendResult.sent) {
      console.warn(`[burn rate] not sent (${alertKey}): ${sendResult.reason}`);
    }
  }

  const nowIso = new Date().toISOString();
  const upsertRow =
    burn.elevated && !prevElevated
      ? { metric_key: alertKey, last_status: "elevated", last_alerted_at: nowIso }
      : { metric_key: alertKey, last_status: burn.elevated ? "elevated" : "normal" };
  const { error: upsertErr } = await db
    .from("platform_alert_state")
    .upsert(upsertRow, { onConflict: "metric_key" });
  if (upsertErr) {
    console.warn(`[burn rate] state upsert failed (${alertKey}): ${upsertErr.message}`);
  }
}

/**
 * FIX-1045 — email every transition of the closed mitigation loop.
 *
 * "Every transition emails" is a hard requirement: the loop mutates production
 * edge configuration, and an unannounced change to the security level is worse
 * than no change at all. Trip, revert, refusal, and the disarmed-but-should-
 * have-acted cases all send.
 *
 * DEBOUNCED ON THE ACTION ITSELF, not on a status band. `skip_no_scope` and
 * `skip_disabled` persist for as long as the underlying condition does, so a
 * naive per-tick send would mail on every cron run for hours. Storing the last
 * emailed action in platform_alert_state means a state that persists is
 * reported once, and any CHANGE of state is reported immediately.
 *
 * Best-effort throughout: email failure never blocks or reverses the action,
 * which has already been recorded durably by the loop itself.
 */
async function emailMitigationTransitions(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  payload: PlatformUsagePayload,
  adminEmail: string,
  siteUrl: string,
): Promise<void> {
  const mit = payload.cf_mitigation;
  const edge = payload.cloudflare_edge;
  if (!mit) return;

  const emailable =
    mit.action === "trip" ||
    mit.action === "revert" ||
    mit.action === "refuse_revert_manual_change" ||
    mit.action === "skip_no_scope" ||
    mit.action === "skip_disabled" ||
    (mit.action === "error" && mit.write_error !== null);

  const alertKey = "mitigation.cloudflare.security_level";

  const { data: priorRow, error: readErr } = await db
    .from("platform_alert_state")
    .select("last_status")
    .eq("metric_key", alertKey)
    .maybeSingle();
  if (readErr) {
    console.warn(`[mitigation] could not read state (${alertKey}): ${readErr.message}`);
  }
  const changed = priorRow?.last_status !== mit.action;

  if (emailable && changed) {
    const { subject, html } = renderMitigationEmail({
      action: mit.action,
      reason: mit.reason,
      observedLevel: mit.observed_level,
      latestHourUtc: edge?.latest?.hour ?? null,
      latestOriginRequests: edge?.latest?.origin_requests ?? null,
      latestEdgeRequests: edge?.latest?.edge_requests ?? null,
      threshold: edge?.trip_threshold ?? 0,
      revertAfterHours: mit.revert_after_hours,
      siteUrl,
    });
    const sendResult = await sendEmail({ to: adminEmail, subject, html });
    if (!sendResult.sent) {
      console.warn(`[mitigation] not sent (${mit.action}): ${sendResult.reason}`);
    }
  }

  // Record the action every tick — including 'none' — so returning to quiet
  // re-arms the next transition email.
  const nowIso = new Date().toISOString();
  const upsertRow =
    emailable && changed
      ? { metric_key: alertKey, last_status: mit.action, last_alerted_at: nowIso }
      : { metric_key: alertKey, last_status: mit.action };
  const { error: upsertErr } = await db
    .from("platform_alert_state")
    .upsert(upsertRow, { onConflict: "metric_key" });
  if (upsertErr) {
    console.warn(`[mitigation] state upsert failed (${alertKey}): ${upsertErr.message}`);
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
      // page once per escalation, not every 30-min tick.
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
      // FIX-1044: the leading signal that would actually have caught
      // 2026-08-15 — origin-reaching edge volume, at hour resolution.
      await emailLeadingEdgeVolumeAlerts(
        db,
        platformOutcome.value.payload,
        adminEmail,
        siteUrl,
      );
      // FIX-1044 D2: day-over-day burn rate against the trailing median.
      await emailBurnRateAlerts(db, platformOutcome.value.payload, adminEmail, siteUrl);
      // FIX-1045: report what the closed loop DID. Runs last so the action is
      // already durably recorded before we try to talk about it — an email
      // failure must never be able to hide a live edge-config change.
      await emailMitigationTransitions(
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
    // PR 3 (FIX-286): one-glance signal so we don't need to query
    // kill_switch_events to spot a flip.
    auto_trips_flipped: platformResult?.auto_trips_flipped ?? 0,
    // FIX-1044/1045: the same one-glance principle for the new signals. These
    // used to land in the GHA run log via `cat /tmp/body.json`; FIX-1127 moved
    // the tick to a Vercel cron, so the body is now read from the function's
    // invocation log (Vercel dashboard → Logs, filter the cron path) or from a
    // manual curl of this route. The fields are unchanged either way.
    cf_origin_requests_hourly:
      platformResult?.payload.cloudflare_edge?.latest?.origin_requests ?? null,
    cf_security_level: platformResult?.payload.cf_mitigation?.observed_level ?? null,
    cf_mitigation_action: platformResult?.payload.cf_mitigation?.action ?? null,
    cf_mitigation_acted: platformResult?.payload.cf_mitigation?.acted ?? false,
    burn_rate_elevated: platformResult?.payload.burn_rate?.elevated ?? null,
    vercel_billable_overage_usd:
      platformResult?.payload.vercel_billing?.projected_billable_overage_usd ?? null,
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
