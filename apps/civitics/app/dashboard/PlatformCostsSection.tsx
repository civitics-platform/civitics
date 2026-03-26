"use client";

import { useState, useEffect, useCallback } from "react";
import {
  SectionCard,
  SectionHeader,
  AlertBanner,
  LoadingSkeleton,
  formatMetricValue,
} from "@civitics/ui";
import type { PlatformMetric, SourceDisplay } from "@civitics/db";

// ── Types ─────────────────────────────────────────────────────────────────────

interface UsageResponse {
  plan: string;
  metrics: PlatformMetric[];
  by_service: Record<string, PlatformMetric[]>;
  total_metrics: number;
  summary: {
    total_overage_cost: number;
    top3_by_pct: PlatformMetric[];
    top3_by_cost: PlatformMetric[];
    any_critical: boolean;
    any_warning: boolean;
    needs_verification: boolean;
    critical_count: number;
    warning_count: number;
    unverified_count: number;
  };
  timestamp: string;
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
}: {
  service: string;
  metrics: PlatformMetric[];
  isAdmin: boolean;
  adminKey: string;
  onVerify: (metric: PlatformMetric) => void;
  onUpdate: (metric: PlatformMetric) => void;
}) {
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

export function PlatformCostsSection() {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [sortBy, setSortBy] = useState<"usage_pct" | "cost">("usage_pct");
  const [updatingMetric, setUpdatingMetric] = useState<PlatformMetric | null>(null);
  const [adminKey, setAdminKey] = useState("");
  const isAdmin = useIsAdmin();

  // Read admin key from localStorage after mount only — never during SSR
  useEffect(() => {
    try {
      setAdminKey(localStorage.getItem("civitics_admin_key") ?? "");
    } catch {
      // Blocked storage (private mode, etc.) — stay empty
    }
  }, []);

  const fetchUsage = useCallback(async () => {
    try {
      const res = await fetch("/api/platform/usage");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load usage data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchUsage();
  }, [fetchUsage]);

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
    await fetchUsage();
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

  if (loading) {
    return (
      <SectionCard>
        <SectionHeader icon="💰" title="Platform Costs" />
        <div className="mt-4">
          <LoadingSkeleton variant="card" />
        </div>
      </SectionCard>
    );
  }

  if (error || !data) {
    return (
      <SectionCard>
        <SectionHeader icon="💰" title="Platform Costs" />
        <p className="mt-3 text-sm text-red-600">{error ?? "No data available"}</p>
      </SectionCard>
    );
  }

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
