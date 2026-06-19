/**
 * Resend email helper — REST API (no SDK dep required).
 *
 * Usage:
 *   await sendEmail({ to: "user@x.com", subject: "…", html: "<p>…</p>" });
 *
 * Required env: RESEND_API_KEY, RESEND_FROM (e.g. "Civitics <notify@civitics.com>")
 * If RESEND_API_KEY is unset, the call is a no-op returning { sent: false, reason }.
 */

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
    return { sent: true, id: data.id ?? "" };
  } catch (err) {
    return {
      sent: false,
      reason: err instanceof Error ? err.message : "unknown email error",
    };
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
 * 10-min cron doesn't re-send while the metric sits in the same band. The
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
