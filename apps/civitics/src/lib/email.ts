/**
 * Resend email helper — REST API (no SDK dep required).
 *
 * Usage:
 *   await sendEmail({ to: "user@x.com", subject: "…", html: "<p>…</p>" });
 *
 * Required env: RESEND_API_KEY, RESEND_FROM (e.g. "Civitics <notify@civitics.com>")
 * If RESEND_API_KEY is unset, the call is a no-op returning { sent: false, reason }.
 *
 * ── THE CHOKE POINT (FIX-1090) ───────────────────────────────────────────────
 *
 * Every send on the platform funnels through this one function — the kill-switch
 * flip mail, the six alert mails in the platform-snapshot cron, the follow
 * notifications, the admin test mail. That is what makes counting here complete
 * rather than approximate, and it is why Resend is self-counted at all:
 * `GET /emails` returns only the retained tail (84 rows, `has_more:false` at
 * limit=100, oldest 2026-07-27), so the vendor cannot tell us a monthly total.
 *
 * The counter is BEST-EFFORT AND MUST STAY THAT WAY. This function is on the
 * alerting path; a monitoring system that fails to page because its own usage
 * counter could not be written is worse than one with an undercounted graph.
 * So: the increment runs only AFTER the send has already succeeded, its result
 * is not consulted, and `recordServiceUsage` swallows its own errors.
 */

import { createAdminClient, recordServiceUsage } from "@civitics/db";

export type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
};

export type SendEmailResult =
  | { sent: true; id: string }
  | { sent: false; reason: string };

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const key = process.env["RESEND_API_KEY"];
  const from = process.env["RESEND_FROM"];

  if (!key || !from) {
    return { sent: false, reason: "RESEND_API_KEY or RESEND_FROM not configured" };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: input.to,
        subject: input.subject,
        html: input.html,
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { sent: false, reason: `Resend HTTP ${res.status}: ${text.slice(0, 200)}` };
    }

    const data = (await res.json()) as { id?: string };
    // FIX-1090: the send is already done and its result is already decided.
    // Nothing below can change what this function returns.
    await countSend();
    return { sent: true, id: data.id ?? "" };
  } catch (err) {
    return {
      sent: false,
      reason: err instanceof Error ? err.message : "unknown email error",
    };
  }
}

/**
 * Increment this month's Resend send counter. Never throws, never rejects.
 *
 * The admin-client construction is inside the try because it reads
 * SUPABASE_SECRET_KEY and throws when it is absent — which is exactly the
 * situation (a misconfigured environment) where we least want the alert path to
 * acquire a new way to fail.
 */
async function countSend(): Promise<void> {
  try {
    await recordServiceUsage(createAdminClient(), "resend", "email_sent");
  } catch {
    // Best-effort by design. See the module header.
  }
}

/**
 * Wrap a notification payload in a minimal branded HTML shell.
 * Kept inline so we don't pull in a template engine.
 */
export function renderNotificationEmail(args: {
  title: string;
  body?: string | null;
  link?: string | null;
  siteUrl: string;
}): string {
  const { title, body, link, siteUrl } = args;
  const cta = link
    ? `<p><a href="${siteUrl}${link}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:500">View on Civitics</a></p>`
    : "";
  return `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;color:#111;max-width:560px;margin:0 auto;padding:24px">
  <div style="border-bottom:1px solid #e5e7eb;padding-bottom:12px;margin-bottom:16px">
    <strong style="color:#4f46e5">Civitics</strong>
  </div>
  <h2 style="font-size:18px;margin:0 0 8px">${escapeHtml(title)}</h2>
  ${body ? `<p style="color:#374151;line-height:1.5">${escapeHtml(body)}</p>` : ""}
  ${cta}
  <p style="color:#9ca3af;font-size:12px;margin-top:32px;border-top:1px solid #f3f4f6;padding-top:16px">
    You're receiving this because you follow this entity on Civitics.
    Manage your follows in your <a href="${siteUrl}/dashboard/notifications" style="color:#6366f1">notifications settings</a>.
  </p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render a kill-switch flip notification email (FIX-288).
 *
 * Subject + body shape mirrors the three flip surfaces:
 *   - auto + OFF      → "⚠️ AUTO-TRIP: <name> DISABLED" + metric / value / threshold
 *   - manual + OFF    → "Kill switch disabled: <name>"
 *   - manual + ON     → "Kill switch re-enabled: <name>"  (positive tone)
 *   - auto + ON       → shouldn't fire (auto-trip is one-way per FIX-286
 *                       decision #11) but handled as a manual re-enable shape
 *                       in case of future bidirectional auto-recovery.
 *
 * The auto-trip body includes the trigger metric / current value / threshold
 * so the admin can decide whether to re-enable directly from the email body.
 */
export function renderKillSwitchEmail(event: {
  switch_name: string;
  trigger_metric: string | null;
  trigger_value: number | null;
  threshold_pct: number | null;
  flipped_to: boolean;
  source: "auto" | "manual";
  flipped_at: string;
  siteUrl: string;
}): { subject: string; html: string } {
  const { switch_name, trigger_metric, trigger_value, threshold_pct, flipped_to, source, flipped_at, siteUrl } =
    event;

  let subject: string;
  let title: string;
  let body: string;

  if (source === "auto" && !flipped_to) {
    subject = `⚠️ AUTO-TRIP: ${switch_name} DISABLED`;
    title = `Kill switch auto-tripped: ${switch_name}`;
    const metricLine =
      trigger_metric && trigger_value !== null && threshold_pct !== null
        ? `Trigger: ${trigger_metric} hit ${trigger_value} (threshold ${threshold_pct}% of free-tier limit).`
        : "Trigger metric details not available.";
    body =
      `${metricLine} Flipped at ${flipped_at}. ` +
      `Open the Operations tab to review the metric and re-enable when ready ` +
      `(auto-trip is one-way — the switch stays off until you manually flip it back on).`;
  } else if (!flipped_to) {
    subject = `Kill switch disabled: ${switch_name}`;
    title = `Kill switch disabled: ${switch_name}`;
    body = `Manually disabled at ${flipped_at}. Open the Operations tab to review or re-enable.`;
  } else {
    subject = `Kill switch re-enabled: ${switch_name}`;
    title = `Kill switch re-enabled: ${switch_name}`;
    body = `Manually re-enabled at ${flipped_at}. The pipeline is back online.`;
  }

  const html = renderNotificationEmail({
    title,
    body,
    link: "/dashboard?tab=operations",
    siteUrl,
  });

  return { subject, html };
}

/**
 * Render a per-metric threshold-crossing alert email (FIX-γ).
 *
 * Distinct from the kill-switch flip email: this fires when a Platform Costs
 * metric ESCALATES past its warning/critical threshold (healthy→warning,
 * healthy→critical, warning→critical), debounced by platform_alert_state so the
 * 30-min cron doesn't re-send while the metric sits in the same band. The
 * snapshot caller is responsible for skipping source='estimated' rows (e.g. the
 * NIC egress proxy) before calling this.
 */
export function renderMetricAlertEmail(args: {
  service: string;
  metric: string;
  display_label: string;
  value: number;
  limit: number;
  unit: string;
  pct: number;
  status: "warning" | "critical";
  siteUrl: string;
}): { subject: string; html: string } {
  const { service, display_label, value, limit, unit, pct, status, siteUrl } = args;

  const serviceLabel = service.charAt(0).toUpperCase() + service.slice(1);
  const pctRounded = Math.round(pct);
  const emoji = status === "critical" ? "🔴" : "⚠️";

  const subject = `${emoji} ${serviceLabel} ${display_label} at ${pctRounded}% (${status})`;
  const title = `${serviceLabel} · ${display_label} crossed ${status} threshold`;
  const limitLabel = limit > 0 ? `${formatUsage(limit, unit)} limit` : "no fixed limit";
  const body =
    `${display_label} is at ${pctRounded}% — ${formatUsage(value, unit)} of ${limitLabel}. ` +
    `Open the Operations tab to review usage and projected overage.`;

  const html = renderNotificationEmail({
    title,
    body,
    link: "/dashboard?tab=operations",
    siteUrl,
  });

  return { subject, html };
}

/**
 * Render a Cloudflare auto-mitigation transition email (FIX-1045).
 *
 * Distinct from every other alert in this file in one important way: the other
 * templates ask a human to go and look at something. This one reports that the
 * system ALREADY ACTED on production edge configuration. So the body leads with
 * what changed, backs it with the measured evidence that justified it, and ends
 * with the exact one-line undo — because the first question on reading "we
 * turned on Under Attack mode" is always "how do I turn it off".
 *
 * Four shapes, one per transition the loop can make:
 *   trip                        → it escalated. Evidence + undo.
 *   revert                      → the timer expired and it put the level back.
 *   refuse_revert_manual_change → somebody changed the level by hand; the loop
 *                                 released its claim and wrote NOTHING.
 *   skip_*                      → it WOULD have acted but is disarmed (kill
 *                                 switch off, or the token has no write scope).
 */
export function renderMitigationEmail(args: {
  action: string;
  reason: string;
  observedLevel: string | null;
  targetLevel?: string | null;
  latestHourUtc?: string | null;
  latestOriginRequests?: number | null;
  latestEdgeRequests?: number | null;
  threshold: number;
  revertAfterHours: number;
  siteUrl: string;
}): { subject: string; html: string } {
  const {
    action,
    reason,
    observedLevel,
    latestHourUtc,
    latestOriginRequests,
    latestEdgeRequests,
    threshold,
    revertAfterHours,
    siteUrl,
  } = args;

  let subject: string;
  let title: string;
  let lead: string;

  switch (action) {
    case "trip":
      subject = "🛡️ ACTED: Cloudflare raised to Under Attack (auto-mitigation)";
      title = "Auto-mitigation escalated the Cloudflare security level";
      lead =
        `The platform detected a sustained origin-volume spike and RAISED the ` +
        `Cloudflare zone security level to "under_attack" by itself. This is not a ` +
        `request for you to act — it has already happened. It will auto-revert in ` +
        `${revertAfterHours}h unless the burn is still running, in which case the ` +
        `next runs will re-trip on fresh evidence.`;
      break;
    case "revert":
      subject = "🛡️ Cloudflare security level restored (auto-revert)";
      title = "Auto-mitigation reverted its own escalation";
      lead =
        `The ${revertAfterHours}h window expired and the loop restored the security ` +
        `level it found before escalating. If the burn resumes, the next runs will ` +
        `escalate again on fresh evidence. Nothing further is required.`;
      break;
    case "refuse_revert_manual_change":
      subject = "⚠️ Auto-mitigation stood down — Cloudflare level changed by hand";
      title = "Auto-revert refused: the zone no longer matches what the loop set";
      lead =
        `The loop was due to revert its own escalation, re-read the zone first, and ` +
        `found a DIFFERENT security level than the one it set. That means somebody ` +
        `changed it manually. It wrote nothing, released its claim on the setting, ` +
        `and will not touch it again — the current level is yours and stays yours. ` +
        `A future spike can still trigger a fresh escalation.`;
      break;
    default:
      subject = "⚠️ Cost spike detected — auto-mitigation is DISARMED";
      title = "Sustained origin-volume spike, and the loop could not act";
      lead =
        `The trip condition was met but the closed loop is not armed, so NOTHING was ` +
        `changed at the edge and the burn is continuing. This is the alert-only ` +
        `degradation path — you need to raise the Cloudflare security level by hand, ` +
        `or fix the reason it is disarmed.`;
      break;
  }

  const evidence: string[] = [];
  if (latestHourUtc) {
    evidence.push(
      `Latest complete hour ${latestHourUtc}: ` +
        `${(latestOriginRequests ?? 0).toLocaleString()} requests reached the origin` +
        (latestEdgeRequests != null
          ? ` of ${latestEdgeRequests.toLocaleString()} seen at the edge`
          : "") +
        ` (threshold ${threshold.toLocaleString()}/hr).`,
    );
  }
  if (observedLevel) evidence.push(`Zone security_level read as "${observedLevel}".`);
  evidence.push(reason);
  evidence.push(
    `To change it by hand: Cloudflare dashboard → civitics.com → Security → ` +
      `Settings → Security Level. Auto-set changes are recorded in ` +
      `pipeline_state.cf_mitigation_loop, so you can always tell an automatic ` +
      `change from a manual one. To disarm the loop entirely, turn off the ` +
      `cf_auto_mitigation kill switch on the Operations tab.`,
  );

  // renderNotificationEmail escapes the body into a single <p>, so newlines
  // would vanish — join as prose with a separator that survives escaping.
  const html = renderNotificationEmail({
    title,
    body: [lead, ...evidence].join(" — "),
    link: "/dashboard?tab=operations",
    siteUrl,
  });

  return { subject, html };
}

/** Compact human-readable usage formatting for alert bodies. */
function formatUsage(value: number, unit: string): string {
  if (unit === "bytes") {
    const gb = value / 1024 ** 3;
    if (gb >= 1024) return `${(gb / 1024).toFixed(2)} TB`;
    if (gb >= 1) return `${gb.toFixed(2)} GB`;
    return `${(value / 1024 ** 2).toFixed(1)} MB`;
  }
  if (unit === "usd") return `$${value.toFixed(2)}`;
  return `${Math.round(value).toLocaleString()} ${unit}`;
}
