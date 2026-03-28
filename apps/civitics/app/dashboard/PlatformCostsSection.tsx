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

// ── Anthropic source badge ────────────────────────────────────────────────────

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

// ── Data age indicator ────────────────────────────────────────────────────────

function DataAge({
  recordedAt,
  source,
}: {
  recordedAt?: string | null;
  source?: string | null;
}) {
  if (!recordedAt && !source) {
    return <span className="text-xs text-gray-300">&#9675; No data</span>;
  }

  if (!recordedAt) {
    return (
      <span className="text-xs text-gray-400">
        {source === "manual"
          ? "✓ Manual entry"
          : source === "estimated"
            ? "~ Estimated"
            : "○ No data"}
      </span>
    );
  }

  const ageMs = Date.now() - new Date(recordedAt).getTime();
  const ageMin = Math.round(ageMs / 60_000);
  const ageHrs = Math.round(ageMs / 3_600_000);
  const ageDays = Math.round(ageMs / 86_400_000);

  const ageStr =
    ageMin < 1
      ? "just now"
      : ageMin < 60
        ? `${ageMin}m ago`
        : ageHrs < 24
          ? `${ageHrs}h ago`
          : `${ageDays}d ago`;

  const isStale = ageMin > 15;

  const sourceIcon =
    source === "api" ? "●" : source === "estimated" ? "~" : source === "manual" ? "✓" : "○";

  const colorClass =
    source === "api" && !isStale
      ? "text-green-600"
      : source === "api" && isStale
        ? "text-amber-500"
        : source === "manual"
          ? "text-blue-500"
          : "text-gray-400";

  return (
    <span suppressHydrationWarning className={`text-xs ${colorClass}`}>
      {sourceIcon} {ageStr}
    </span>
  );
}

// ── Service metadata ──────────────────────────────────────────────────────────

const SERVICE_META: Record<string, { label: string; icon: string; costLabel: string }> = {
  anthropic: { label: "Anthropic", icon: "🤖", costLabel: "monthly spend" },
  vercel: { label: "Vercel", icon: "▲", costLabel: "monthly usage" },
  supabase: { label: "Supabase", icon: "🗄", costLabel: "monthly usage" },
  cloudflare: { label: "Cloudflare R2", icon: "☁", costLabel: "monthly usage" },
  mapbox: { label: "Mapbox", icon: "🗺", costLabel: "map loads" },
};

const SERVICE_ORDER = ["anthropic", "supabase", "vercel", "cloudflare", "mapbox"];

const SERVICE_LINKS: Record<string, string> = {
  vercel: "https://vercel.com/dashboard",
  supabase: "https://supabase.com/dashboard",
  anthropic: "https://console.anthropic.com",
  cloudflare: "https://dash.cloudflare.com",
  mapbox: "https://account.mapbox.com",
  resend: "https://resend.com/dashboard",
};

// ── Status dot ────────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: string }) {
  const colors = {
    healthy: "bg-green-500",
    warning: "bg-amber-500",
    critical: "bg-red-500",
  };
  return (
    <span
      className={`w-1.5 h-1.5 rounded-full inline-block ${
        colors[status as keyof typeof colors] ?? "bg-gray-300"
      }`}
    />
  );
}

// ── Metric row (non-Anthropic expanded view) ──────────────────────────────────

function MetricRow({
  metric,
  isAdmin,
  onVerify,
  onUpdate,
}: {
  metric: PlatformMetric;
  isAdmin?: boolean;
  onVerify?: (metric: PlatformMetric) => void;
  onUpdate?: (metric: PlatformMetric) => void;
}) {
  const pct = metric.included_limit === -1 ? 0 : (metric.pct ?? 0);
  const barColor =
    metric.status === "critical"
      ? "bg-red-500"
      : metric.status === "warning"
        ? "bg-amber-500"
        : "bg-green-500";

  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-gray-600 font-medium">
          {metric.display_label ?? metric.metric}
        </span>
        <span className="text-gray-500 tabular-nums">
          {metric.value != null
            ? `${formatMetricValue(metric.value, metric.unit)} / ${
                metric.included_limit === -1
                  ? "∞"
                  : formatMetricValue(metric.included_limit, metric.unit)
              }`
            : "No data"}
        </span>
      </div>
      <div className="h-1.5 bg-gray-100 rounded-full">
        {metric.included_limit !== -1 && metric.value !== null && (
          <div
            className={`h-full rounded-full ${barColor}`}
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        )}
      </div>
      {pct > 0 && (
        <div className="text-xs text-gray-400 mt-0.5 text-right">{Math.round(pct)}%</div>
      )}
      <div className="flex items-center justify-between mt-1">
        {metric.source !== null ? (
          <SourceIndicator display={metric.source_display} />
        ) : (
          <span className="text-xs text-gray-300">No data</span>
        )}
        {isAdmin && (
          <div className="flex gap-2">
            {metric.source_display.needsVerification && onVerify && (
              <button
                onClick={() => onVerify(metric)}
                className="text-xs text-amber-600 hover:text-amber-800 font-medium"
              >
                Verify
              </button>
            )}
            {onUpdate && (
              <button
                onClick={() => onUpdate(metric)}
                className="text-xs text-gray-400 hover:text-gray-700"
              >
                Update
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Anthropic detail panel (expanded view) ────────────────────────────────────

function AnthropicDetailPanel({
  aiCosts,
  anthropicDetail,
  metrics,
  isAdmin,
  onVerify,
  onUpdate,
}: {
  aiCosts?: AiCosts | null;
  anthropicDetail?: AnthropicDetail | null;
  metrics: PlatformMetric[];
  isAdmin?: boolean;
  onVerify?: (metric: PlatformMetric) => void;
  onUpdate?: (metric: PlatformMetric) => void;
}) {
  const spendMetric = metrics.find((m) => m.metric === "monthly_spend_usd");
  const totalCost = anthropicDetail?.this_month?.cost_usd;
  const appOnlyCost = aiCosts?.monthly_spent_usd ?? 0;

  const displayMetric: PlatformMetric | undefined =
    spendMetric && totalCost != null && spendMetric.included_limit > 0
      ? {
          ...spendMetric,
          value: totalCost,
          pct: (totalCost / spendMetric.included_limit) * 100,
          status:
            (totalCost / spendMetric.included_limit) * 100 >= spendMetric.critical_pct
              ? "critical"
              : (totalCost / spendMetric.included_limit) * 100 >= spendMetric.warning_pct
                ? "warning"
                : "healthy",
        }
      : spendMetric;

  const showSubLabel = totalCost != null && Math.abs(totalCost - appOnlyCost) > 0.01;

  return (
    <div className="space-y-3">
      {/* Spend metric row */}
      {displayMetric && (
        <div>
          <div className="flex justify-between text-xs mb-1">
            <span className="text-gray-600 font-medium">
              {displayMetric.display_label ?? displayMetric.metric}
            </span>
            <span className="text-gray-500 tabular-nums">
              {displayMetric.value != null
                ? `${fmtUsd(displayMetric.value)} / ${fmtUsd(displayMetric.included_limit)}`
                : "No data"}
            </span>
          </div>
          <div className="h-1.5 bg-gray-100 rounded-full">
            {displayMetric.included_limit !== -1 && displayMetric.value !== null && (
              <div
                className={`h-full rounded-full ${
                  displayMetric.status === "critical"
                    ? "bg-red-500"
                    : displayMetric.status === "warning"
                      ? "bg-amber-500"
                      : "bg-green-500"
                }`}
                style={{ width: `${Math.min(displayMetric.pct ?? 0, 100)}%` }}
              />
            )}
          </div>
          <div className="flex items-center justify-between mt-1">
            <AnthropicSourceBadge source={aiCosts?.source} />
            {isAdmin && (
              <div className="flex gap-2">
                {displayMetric.source_display.needsVerification && onVerify && (
                  <button
                    onClick={() => onVerify(displayMetric)}
                    className="text-xs text-amber-600 hover:text-amber-800 font-medium"
                  >
                    Verify
                  </button>
                )}
                {onUpdate && (
                  <button
                    onClick={() => onUpdate(displayMetric)}
                    className="text-xs text-gray-400 hover:text-gray-700"
                  >
                    Update
                  </button>
                )}
              </div>
            )}
          </div>
          {showSubLabel && (
            <div className="flex justify-between text-xs text-gray-400 mt-1">
              <span>${appOnlyCost.toFixed(2)} from Civitics app</span>
              <span>${((totalCost ?? 0) - appOnlyCost).toFixed(2)} other tools</span>
            </div>
          )}
        </div>
      )}

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
            <td className="tabular-nums">{fmtTokens(aiCosts?.last_hour_tokens ?? 0)}</td>
            <td className="tabular-nums">{fmtTokens(aiCosts?.last_24h_tokens ?? 0)}</td>
            <td className="tabular-nums">
              {fmtTokens(anthropicDetail?.this_month?.total_tokens ?? 0)}
            </td>
          </tr>
          <tr className="text-right">
            <td className="text-left py-1.5 text-gray-500">Cost</td>
            <td className="tabular-nums text-gray-400">—</td>
            <td className="tabular-nums">{fmtUsd(aiCosts?.last_24h_cost_usd ?? 0)}</td>
            <td className="tabular-nums font-medium">
              {fmtUsd(
                anthropicDetail?.this_month?.cost_usd ?? aiCosts?.monthly_spent_usd ?? 0,
              )}
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
  );
}

// ── Service card (collapsible) ────────────────────────────────────────────────

function ServiceCard({
  service,
  metrics,
  meta,
  anthropicDetail,
  aiCosts,
  isAdmin,
  adminKey,
  onVerify,
  onUpdate,
}: {
  service: string;
  metrics: PlatformMetric[];
  meta: (typeof SERVICE_META)[string];
  anthropicDetail?: AnthropicDetail | null;
  aiCosts?: AiCosts | null;
  isAdmin: boolean;
  adminKey: string;
  onVerify: (metric: PlatformMetric) => void;
  onUpdate: (metric: PlatformMetric) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const topMetric =
    metrics
      .filter((m) => m.value !== null && m.value !== undefined)
      .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))[0] ?? metrics[0];

  const serviceStatus: string = metrics.some((m) => m.status === "critical")
    ? "critical"
    : metrics.some((m) => m.status === "warning")
      ? "warning"
      : "healthy";

  const totalCost =
    service === "anthropic"
      ? (anthropicDetail?.this_month?.cost_usd ?? aiCosts?.monthly_spent_usd ?? 0)
      : metrics.reduce((sum, m) => sum + (m.overage_cost ?? 0), 0);

  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden bg-white">
      {/* Collapsed header — always visible */}
      <div className="p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span>{meta.icon}</span>
            <span className="font-medium text-sm text-gray-900">{meta.label}</span>
            <StatusDot status={serviceStatus} />
          </div>
          <span className="text-sm font-medium text-gray-700">
            ${totalCost.toFixed(2)}/mo
          </span>
        </div>

        {/* Top metric label */}
        {topMetric && (
          <div className="text-xs text-gray-500 mb-1.5">
            {topMetric.display_label ?? topMetric.metric}
          </div>
        )}

        {/* Single progress bar */}
        {topMetric && (
          <div className="h-1.5 bg-gray-100 rounded-full mb-2">
            <div
              className={`h-full rounded-full ${
                topMetric.status === "critical"
                  ? "bg-red-500"
                  : topMetric.status === "warning"
                    ? "bg-amber-500"
                    : "bg-green-500"
              }`}
              style={{ width: `${Math.min(topMetric.pct ?? 0, 100)}%` }}
            />
          </div>
        )}

        {/* Show/hide button */}
        <button
          onClick={() => setExpanded((e) => !e)}
          className="text-xs text-gray-400 hover:text-gray-600 transition-colors flex items-center gap-1"
        >
          <span>{expanded ? "▲" : "▾"}</span>
          {expanded ? "Hide details" : "Show details"}
        </button>

        {/* Data age */}
        {(() => {
          const latestRecordedAt =
            metrics
              .filter((m) => m.recorded_at)
              .sort(
                (a, b) =>
                  new Date(b.recorded_at!).getTime() - new Date(a.recorded_at!).getTime(),
              )[0]?.recorded_at ?? null;
          const latestSource = metrics.filter((m) => m.source)[0]?.source ?? null;
          return (
            <div className="mt-1">
              <DataAge recordedAt={latestRecordedAt} source={latestSource} />
            </div>
          );
        })()}
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="border-t border-gray-100 p-4 space-y-4 bg-gray-50/50">
          {service === "anthropic" ? (
            <AnthropicDetailPanel
              aiCosts={aiCosts}
              anthropicDetail={anthropicDetail}
              metrics={metrics}
              isAdmin={isAdmin}
              onVerify={onVerify}
              onUpdate={onUpdate}
            />
          ) : (
            metrics.map((metric) => (
              <MetricRow
                key={metric.metric}
                metric={metric}
                isAdmin={isAdmin}
                onVerify={onVerify}
                onUpdate={onUpdate}
              />
            ))
          )}
        </div>
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

  const { summary, by_service } = platformUsage;

  // Total monthly cost: Anthropic actual spend + other service overages
  const anthropicCost =
    anthropicDetail?.this_month?.cost_usd ?? aiCosts?.monthly_spent_usd ?? 0;
  const otherOverages = Object.entries(by_service)
    .filter(([svc]) => svc !== "anthropic")
    .flatMap(([, metrics]) => metrics)
    .reduce((sum, m) => sum + (m.overage_cost ?? 0), 0);
  const totalMonthlyCost = anthropicCost + otherOverages;

  // Alert banners
  const banners: Array<{ level: "error" | "warning" | "info"; message: string; detail?: string }> =
    [];
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
          description="Every cost is public record"
        />

        {/* Summary row */}
        <div className="flex justify-between items-center mb-4 px-1 mt-4">
          <span className="text-2xl font-bold tabular-nums">
            ${totalMonthlyCost.toFixed(2)}
            <span className="text-sm font-normal text-gray-500 ml-1">/month</span>
          </span>
          <span className="text-xs text-gray-400">
            On {platformUsage.plan} plan ·{" "}
            <button className="underline hover:text-gray-600">Upgrade</button>
          </span>
        </div>

        {/* Service cards */}
        <div className="space-y-3">
          {SERVICE_ORDER.map((service) => {
            const metrics = by_service[service] ?? [];
            if (metrics.length === 0) return null;
            const meta = SERVICE_META[service];
            if (!meta) return null;
            return (
              <ServiceCard
                key={service}
                service={service}
                metrics={metrics}
                meta={meta}
                anthropicDetail={service === "anthropic" ? anthropicDetail : undefined}
                aiCosts={service === "anthropic" ? aiCosts : undefined}
                isAdmin={isAdmin}
                adminKey={adminKey}
                onVerify={handleVerify}
                onUpdate={(metric) => setUpdatingMetric(metric)}
              />
            );
          })}
        </div>

        {/* Footer */}
        <p className="text-xs text-center text-gray-400 mt-4">
          Running a civic accountability platform tracking $1.75B in donations costs less
          than a streaming subscription
        </p>
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
