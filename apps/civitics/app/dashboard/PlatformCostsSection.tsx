"use client";

import { useState, useEffect } from "react";
import {
  SectionCard,
  SectionHeader,
  AlertBanner,
  LoadingSkeleton,
  formatMetricValue,
} from "@civitics/ui";
import type { PlatformMetric, SourceDisplay } from "@civitics/db";
import type { PlatformUsageResponse, AnthropicDetail, AiCosts } from "./useDashboardData";

// ── Token / cost formatters ───────────────────────────────────────────────────

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K";
  return n === 0 ? "—" : String(n);
}

function fmtUsd(n: number): string {
  if (n === 0) return "—";
  if (n < 0.01) return "<$0.01";
  return "$" + n.toFixed(2);
}

// ── Anthropic source badge (live / logs / estimated) ─────────────────────────

function AnthropicSourceBadge({ source }: { source?: string }) {
  if (source === "api")
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-green-600">
        <span className="w-1.5 h-1.5 bg-green-500 rounded-full inline-block animate-pulse" />
        Live · Anthropic Admin API
      </span>
    );
  if (source === "api_usage_logs")
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-blue-600">
        <span className="w-1.5 h-1.5 bg-blue-500 rounded-full inline-block" />
        From local usage logs
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-amber-600">
      <span className="w-1.5 h-1.5 bg-amber-500 rounded-full inline-block" />
      Estimated
    </span>
  );
}

// ── Admin key (dev only — no secret in client bundle) ─────────────────────────
// In production this is only set in the server env. The UI shows admin controls
// whenever window.CIVITICS_ADMIN is set (dev convenience) or via a future
// session-based role check.
function useIsAdmin(): boolean {
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setIsAdmin(!!(window as any).CIVITICS_ADMIN);
  }, []);
  return isAdmin;
}

// ── Source indicator ──────────────────────────────────────────────────────────

function SourceIndicator({ display }: { display: SourceDisplay }) {
  const colorClass =
    display.color === "green"
      ? "text-green-600"
      : display.color === "amber"
        ? "text-amber-600"
        : "text-gray-400";

  return (
    <span className={`text-xs ${colorClass} whitespace-nowrap`} title={display.tooltip}>
      {display.icon} {display.label}
    </span>
  );
}

// ── Single metric row ─────────────────────────────────────────────────────────

function MetricRow({
  metric,
  isAdmin,
  adminKey,
  onVerify,
  onUpdate,
}: {
  metric: PlatformMetric;
  isAdmin: boolean;
  adminKey: string;
  onVerify: (metric: PlatformMetric) => void;
  onUpdate: (metric: PlatformMetric) => void;
}) {
  const pct = metric.included_limit === -1 ? 0 : metric.pct;
  const barColor =
    metric.status === "critical"
      ? "bg-red-500"
      : metric.status === "warning"
        ? "bg-amber-500"
        : "bg-green-500";
  const pctColor =
    metric.status === "critical"
      ? "text-red-600"
      : metric.status === "warning"
        ? "text-amber-600"
        : "text-gray-600";

  return (
    <div className="group flex items-center gap-3 py-2.5 border-b border-gray-50 last:border-0">
      {/* Service + metric name */}
      <div className="w-44 flex-shrink-0">
        <div className="text-sm font-medium text-gray-900 leading-tight">
          {metric.display_label ?? metric.metric}
        </div>
        <div className="text-xs text-gray-400 capitalize">{metric.service}</div>
      </div>

      {/* Progress bar */}
      <div className="flex-1 min-w-0">
        <div className="flex justify-between text-xs text-gray-400 mb-1">
          <span>
            {metric.value !== null
              ? formatMetricValue(metric.value, metric.unit)
              : "—"}
          </span>
          <span>
            {metric.included_limit === -1
              ? "Unlimited"
              : formatMetricValue(metric.included_limit, metric.unit)}
          </span>
        </div>
        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
          {metric.included_limit !== -1 && metric.value !== null && (
            <div
              className={`h-full rounded-full transition-all duration-200 ${barColor}`}
              style={{ width: `${Math.min(pct, 100)}%` }}
            />
          )}
        </div>
      </div>

      {/* Percentage */}
      <div className={`w-14 text-right text-sm font-medium tabular-nums ${pctColor}`}>
        {metric.included_limit === -1
          ? "∞"
          : metric.value !== null
            ? pct > 100
              ? `${Math.round(pct)}% ⛔`
              : `${Math.round(pct)}%`
            : "—"}
      </div>

      {/* Source indicator */}
      <div className="w-28 text-right">
        {metric.source !== null ? (
          <SourceIndicator display={metric.source_display} />
        ) : (
          <span className="text-xs text-gray-300">No data</span>
        )}
      </div>

      {/* Overage cost */}
      <div className="w-20 text-right">
        {metric.overage_cost > 0 ? (
          <span className="text-xs text-red-600 font-medium">
            +${metric.overage_cost.toFixed(2)}
          </span>
        ) : (
          <span className="text-xs text-gray-300">—</span>
        )}
      </div>

      {/* Admin actions — visible on group hover */}
      {isAdmin && (
        <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {metric.source_display.needsVerification && (
            <button
              onClick={() => onVerify(metric)}
              className="text-xs text-amber-600 hover:text-amber-800 font-medium"
            >
              Verify
            </button>
          )}
          <button
            onClick={() => onUpdate(metric)}
            className="text-xs text-gray-400 hover:text-gray-700"
          >
            Update
          </button>
        </div>
      )}
    </div>
  );
}

// ── Service group (expanded view) ─────────────────────────────────────────────

const SERVICE_LINKS: Record<string, string> = {
  vercel: "https://vercel.com/dashboard",
  supabase: "https://supabase.com/dashboard",
  anthropic: "https://console.anthropic.com",
  cloudflare: "https://dash.cloudflare.com",
  mapbox: "https://account.mapbox.com",
  resend: "https://resend.com/dashboard",
};

function ServiceGroup({
  service,
  metrics,
  isAdmin,
  adminKey,
  onVerify,
  onUpdate,
  anthropicDetail,
  aiCosts,
}: {
  service: string;
  metrics: PlatformMetric[];
  isAdmin: boolean;
  adminKey: string;
  onVerify: (metric: PlatformMetric) => void;
  onUpdate: (metric: PlatformMetric) => void;
  anthropicDetail?: AnthropicDetail | null;
  aiCosts?: AiCosts | null;
}) {
  const [showTokens, setShowTokens] = useState(false);
  const hasCritical = metrics.some((m) => m.status === "critical");
  const hasWarning = metrics.some((m) => m.status === "warning");
  const link = SERVICE_LINKS[service];

  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
          {service}
        </h3>
        {hasCritical && <span className="text-xs text-red-500">⛔ Critical</span>}
        {!hasCritical && hasWarning && (
          <span className="text-xs text-amber-500">⚠ Warning</span>
        )}
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-xs text-gray-400 hover:text-blue-600"
          >
            Dashboard ↗
          </a>
        )}
      </div>
      {metrics.map((m) => (
        <MetricRow
          key={`${m.service}:${m.metric}`}
          metric={m}
          isAdmin={isAdmin}
          adminKey={adminKey}
          onVerify={onVerify}
          onUpdate={onUpdate}
        />
      ))}

      {/* Token detail toggle — anthropic only */}
      {service === "anthropic" && (
        <>
          <button
            onClick={() => setShowTokens((s) => !s)}
            className="text-xs text-gray-400 hover:text-gray-600 mt-2 flex items-center gap-1 transition-colors"
          >
            <span>{showTokens ? "▲" : "▾"}</span>
            {showTokens ? "Hide details" : "Show token details"}
          </button>

          {showTokens && (
            <div className="mt-3 border-t border-gray-100 pt-3 space-y-3">
              {/* Source indicator */}
              <AnthropicSourceBadge source={aiCosts?.source} />

              {/* Token breakdown table */}
              <table className="w-full text-xs text-gray-600">
                <thead>
                  <tr className="text-gray-400 border-b border-gray-100 text-right">
                    <th className="text-left pb-1.5 font-medium">Tokens</th>
                    <th className="pb-1.5 font-medium">1h</th>
                    <th className="pb-1.5 font-medium">24h</th>
                    <th className="pb-1.5 font-medium">Month</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  <tr className="text-right">
                    <td className="text-left py-1.5">Input</td>
                    <td className="tabular-nums text-gray-400">—</td>
                    <td className="tabular-nums text-gray-400">—</td>
                    <td className="tabular-nums">
                      {fmtTokens(anthropicDetail?.this_month?.input_tokens ?? 0)}
                    </td>
                  </tr>
                  <tr className="text-right">
                    <td className="text-left py-1.5">Output</td>
                    <td className="tabular-nums text-gray-400">—</td>
                    <td className="tabular-nums text-gray-400">—</td>
                    <td className="tabular-nums">
                      {fmtTokens(anthropicDetail?.this_month?.output_tokens ?? 0)}
                    </td>
                  </tr>
                  <tr className="text-right">
                    <td className="text-left py-1.5">Cache hits</td>
                    <td className="tabular-nums text-gray-400">—</td>
                    <td className="tabular-nums text-gray-400">—</td>
                    <td className="tabular-nums">
                      {fmtTokens(anthropicDetail?.this_month?.cache_read_tokens ?? 0)}
                    </td>
                  </tr>
                  <tr className="text-right font-medium border-t border-gray-100">
                    <td className="text-left py-1.5">Total</td>
                    <td className="tabular-nums">
                      {fmtTokens(aiCosts?.last_hour_tokens ?? 0)}
                    </td>
                    <td className="tabular-nums">
                      {fmtTokens(aiCosts?.last_24h_tokens ?? 0)}
                    </td>
                    <td className="tabular-nums">
                      {fmtTokens(anthropicDetail?.this_month?.total_tokens ?? 0)}
                    </td>
                  </tr>
                  <tr className="text-right">
                    <td className="text-left py-1.5 text-gray-500">Cost</td>
                    <td className="tabular-nums text-gray-400">—</td>
                    <td className="tabular-nums">
                      {fmtUsd(aiCosts?.last_24h_cost_usd ?? 0)}
                    </td>
                    <td className="tabular-nums font-medium">
                      {fmtUsd(aiCosts?.monthly_spent_usd ?? 0)}
                    </td>
                  </tr>
                </tbody>
              </table>

              {/* By model breakdown */}
              {anthropicDetail?.this_month?.by_model &&
                anthropicDetail.this_month.by_model.length > 0 && (
                  <div className="text-xs text-gray-500">
                    <div className="font-medium text-gray-400 mb-1">By model</div>
                    {anthropicDetail.this_month.by_model.map((m) => (
                      <div key={m.model} className="flex justify-between py-0.5">
                        <span className="font-mono text-gray-400 truncate max-w-[180px]">
                          {m.model.replace("claude-", "")}
                        </span>
                        <span className="tabular-nums">
                          {fmtTokens(m.input_tokens + m.output_tokens)}
                          {" · "}
                          {fmtUsd(m.cost_usd)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Update modal ──────────────────────────────────────────────────────────────

function UpdateModal({
  metric,
  onClose,
  onSave,
}: {
  metric: PlatformMetric;
  onClose: () => void;
  onSave: (value: number) => Promise<void>;
}) {
  const [inputValue, setInputValue] = useState(
    metric.value !== null ? String(metric.value) : "",
  );
  const [saving, setSaving] = useState(false);
  const link = SERVICE_LINKS[metric.service];

  async function handleSave() {
    const num = parseFloat(inputValue);
    if (isNaN(num)) return;
    setSaving(true);
    try {
      await onSave(num);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm">
        <h2 className="text-base font-semibold text-gray-900 mb-1">
          Update {metric.display_label ?? metric.metric}
        </h2>
        <p className="text-xs text-gray-500 mb-4">
          Source will be set to <span className="font-medium">manual</span>.
          {link && (
            <>
              {" "}
              Check the{" "}
              <a
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline"
              >
                {metric.service} dashboard
              </a>{" "}
              for the current value.
            </>
          )}
        </p>
        <div className="mb-4">
          <label className="text-xs font-medium text-gray-700 block mb-1">
            Value ({metric.unit})
          </label>
          <input
            type="number"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            autoFocus
          />
          {metric.value !== null && (
            <p className="text-xs text-gray-400 mt-1">
              Current: {formatMetricValue(metric.value, metric.unit)}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="text-sm text-gray-500 hover:text-gray-700 px-3 py-1.5"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="text-sm bg-blue-600 text-white px-4 py-1.5 rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface PlatformCostsSectionProps {
  platformUsage: PlatformUsageResponse | null;
  onRefresh: () => void;
  anthropicDetail?: AnthropicDetail | null;
  aiCosts?: AiCosts | null;
}

export function PlatformCostsSection({
  platformUsage,
  onRefresh,
  anthropicDetail,
  aiCosts,
}: PlatformCostsSectionProps) {
  const [mounted, setMounted] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [sortBy, setSortBy] = useState<"usage_pct" | "cost">("usage_pct");
  const [updatingMetric, setUpdatingMetric] = useState<PlatformMetric | null>(null);
  const [adminKey, setAdminKey] = useState("");
  const isAdmin = useIsAdmin();

  useEffect(() => setMounted(true), []);

  // Read admin key from localStorage after mount only — never during SSR
  useEffect(() => {
    try {
      setAdminKey(localStorage.getItem("civitics_admin_key") ?? "");
    } catch {
      // Blocked storage (private mode, etc.) — stay empty
    }
  }, []);

  async function adminPost(body: Record<string, unknown>) {
    const res = await fetch("/api/platform/usage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-key": adminKey,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Admin action failed: HTTP ${res.status}`);
    onRefresh();
  }

  async function handleVerify(metric: PlatformMetric) {
    await adminPost({ action: "verify_usage", service: metric.service, metric: metric.metric });
  }

  async function handleUpdate(value: number) {
    if (!updatingMetric) return;
    await adminPost({
      action: "update_usage",
      service: updatingMetric.service,
      metric: updatingMetric.metric,
      value,
    });
  }

  if (!platformUsage) {
    return (
      <SectionCard>
        <SectionHeader icon="💰" title="Platform Costs" />
        <div className="mt-4">
          {!mounted ? (
            <div className="animate-pulse bg-white rounded-xl border border-gray-200 shadow-sm h-48" />
          ) : (
            <LoadingSkeleton variant="card" />
          )}
        </div>
      </SectionCard>
    );
  }

  const data = platformUsage;
  const { summary, by_service, total_metrics } = data;

  // Top 3 based on sort mode
  const top3 = sortBy === "usage_pct" ? summary.top3_by_pct : summary.top3_by_cost;

  // Alert banners
  const banners: Array<{ level: "error" | "warning" | "info"; message: string; detail?: string }> = [];
  if (summary.any_critical) {
    banners.push({
      level: "error",
      message: `⛔ ${summary.critical_count} metric${summary.critical_count !== 1 ? "s" : ""} over limit — action required`,
      detail: "Check platform costs section below",
    });
  }
  if (summary.any_warning) {
    banners.push({
      level: "warning",
      message: `⚠ ${summary.warning_count} metric${summary.warning_count !== 1 ? "s" : ""} approaching limit`,
    });
  }
  if (summary.needs_verification) {
    banners.push({
      level: "info",
      message: `💡 ${summary.unverified_count} usage metric${summary.unverified_count !== 1 ? "s" : ""} need manual verification`,
      detail: "Check service dashboards to confirm",
    });
  }

  return (
    <>
      {/* Alert banners — rendered above the card */}
      {banners.map((b, i) => (
        <AlertBanner key={i} level={b.level} message={b.message} detail={b.detail} />
      ))}

      <SectionCard>
        <SectionHeader
          icon="💰"
          title="Platform Costs"
          description={`On ${data.plan} plan`}
        />

        {/* Summary row */}
        <div className="flex items-center justify-between mt-4 mb-4 flex-wrap gap-2">
          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl font-bold text-gray-900 tabular-nums">
              ${summary.total_overage_cost > 0
                ? summary.total_overage_cost.toFixed(2)
                : "0.00"}
            </span>
            <span className="text-sm text-gray-400">/month overages</span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setSortBy("usage_pct")}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                sortBy === "usage_pct"
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              Closest to limit
            </button>
            <button
              onClick={() => setSortBy("cost")}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                sortBy === "cost"
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              Highest cost
            </button>
          </div>
        </div>

        {/* Column headers */}
        <div className="flex items-center gap-3 pb-1 mb-1 border-b border-gray-100">
          <div className="w-44 text-xs text-gray-400">Metric</div>
          <div className="flex-1 text-xs text-gray-400">Usage</div>
          <div className="w-14 text-right text-xs text-gray-400">Used</div>
          <div className="w-28 text-right text-xs text-gray-400">Source</div>
          <div className="w-20 text-right text-xs text-gray-400">Overage</div>
          {isAdmin && <div className="w-16" />}
        </div>

        {/* Top 3 metrics */}
        {top3.map((m) => (
          <MetricRow
            key={`${m.service}:${m.metric}`}
            metric={m}
            isAdmin={isAdmin}
            adminKey={adminKey}
            onVerify={handleVerify}
            onUpdate={(metric) => setUpdatingMetric(metric)}
          />
        ))}

        {/* Expand/collapse */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-3 text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1"
        >
          <span>{expanded ? "▲" : "▾"}</span>
          <span>{expanded ? "Show less" : `Show all ${total_metrics} metrics`}</span>
        </button>

        {/* Expanded: all metrics grouped by service */}
        {expanded && (
          <div className="mt-4 border-t border-gray-100 pt-4">
            {Object.entries(by_service).sort(([a], [b]) => a.localeCompare(b)).map(
              ([service, metrics]) => (
                <ServiceGroup
                  key={service}
                  service={service}
                  metrics={metrics}
                  isAdmin={isAdmin}
                  adminKey={adminKey}
                  onVerify={handleVerify}
                  onUpdate={(metric) => setUpdatingMetric(metric)}
                  anthropicDetail={service === "anthropic" ? anthropicDetail : undefined}
                  aiCosts={service === "anthropic" ? aiCosts : undefined}
                />
              ),
            )}
          </div>
        )}

        {/* Legend */}
        <div className="mt-4 flex flex-wrap gap-3 text-xs text-gray-400 border-t border-gray-100 pt-3">
          <span>
            <span className="text-green-500">●</span> Healthy (&lt;{80}%)
          </span>
          <span>
            <span className="text-amber-500">●</span> Warning ({80}–{95}%)
          </span>
          <span>
            <span className="text-red-500">●</span> Critical ({95}%+)
          </span>
          <span className="ml-auto">
            <span className="text-green-600">●</span> Live{" "}
            <span className="text-green-600 ml-1">✓</span> Verified{" "}
            <span className="text-gray-400 ml-1">~</span> Estimated{" "}
            <span className="text-amber-500 ml-1">⚠</span> Unverified
          </span>
        </div>
      </SectionCard>

      {/* Update modal */}
      {updatingMetric && (
        <UpdateModal
          metric={updatingMetric}
          onClose={() => setUpdatingMetric(null)}
          onSave={handleUpdate}
        />
      )}
    </>
  );
}
