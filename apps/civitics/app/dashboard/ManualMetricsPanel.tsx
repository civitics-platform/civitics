"use client";

/**
 * FIX-296 — Manual metrics that need periodic operator attention.
 *
 * Surfaces the platform_usage rows that have no public API path (Supabase
 * egress as of May 2026 is the only one). The existing PlatformCostsSection
 * already exposes Update/Verify buttons inside each service card, but those
 * are buried behind "Show details" and don't surface staleness at a glance.
 * This panel is a top-of-tab "what needs my attention" surface that:
 *
 *  - Renders only manual + has_public_api=false rows
 *  - Computes days-since-verified vs stale_after_days for an overdue badge
 *  - Posts to /api/admin/usage-update (cookie-based admin email auth)
 *
 * Gated at the parent (DashboardPage) by `user.email === ADMIN_EMAIL`. This
 * component itself trusts the prop set — never read the cookie or
 * window.CIVITICS_ADMIN here.
 */

import { useState } from "react";
import { SectionCard, SectionHeader, formatMetricValue } from "@civitics/ui";
import { Settings } from "lucide-react";

export type ManualMetric = {
  service: string;
  metric: string;
  display_label: string;
  unit: string;
  value: number | null;
  verified_at: string | null;
  stale_after_days: number | null;
  days_since_verified: number | null;
};

function daysSince(verifiedAt: string | null): number | null {
  if (!verifiedAt) return null;
  const ms = Date.now() - new Date(verifiedAt).getTime();
  return Math.floor(ms / 86_400_000);
}

function StalenessBadge({ metric }: { metric: ManualMetric }) {
  const days = metric.days_since_verified;
  const limit = metric.stale_after_days;
  if (days === null || limit === null) {
    return (
      <span className="text-xs text-gray-400">No verification recorded</span>
    );
  }
  if (days <= limit) {
    return (
      <span className="text-xs text-green-700">
        ✓ Last updated {days}d ago
      </span>
    );
  }
  return (
    <span className="text-xs text-amber-700 font-medium">
      ⚠ Overdue — last updated {days}d ago (cadence {limit}d)
    </span>
  );
}

function MetricRow({
  metric,
  onSaved,
}: {
  metric: ManualMetric;
  onSaved: () => void;
}) {
  const isBytes = metric.unit === "bytes";
  const currentGb =
    isBytes && metric.value !== null
      ? (metric.value / 1_073_741_824).toFixed(2)
      : null;

  const [input, setInput] = useState<string>(currentGb ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const num = Number.parseFloat(input);
    if (!Number.isFinite(num) || num < 0) {
      setError("Enter a non-negative number");
      return;
    }
    const valueInBaseUnit = isBytes ? Math.round(num * 1_073_741_824) : num;

    setSaving(true);
    try {
      const res = await fetch("/api/admin/usage-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service: metric.service,
          metric: metric.metric,
          value: valueInBaseUnit,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border-t border-gray-100 first:border-t-0 px-6 py-4">
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium text-gray-900">
          {metric.display_label}
        </span>
        <span className="text-sm text-gray-700 tabular-nums">
          {metric.value !== null
            ? formatMetricValue(metric.value, metric.unit)
            : "No data"}
        </span>
      </div>
      <div className="mb-3">
        <StalenessBadge metric={metric} />
      </div>
      <form onSubmit={handleSubmit} className="flex items-center gap-2">
        <label className="text-xs text-gray-600">
          New value{isBytes ? " (GB)" : ` (${metric.unit})`}
        </label>
        <input
          type="number"
          step="0.01"
          min="0"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={saving}
          className="w-32 border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          type="submit"
          disabled={saving}
          className="text-sm bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Update"}
        </button>
        <a
          href={`https://supabase.com/dashboard/project/xsazcoxinpgttgquwvuf/settings/billing`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 hover:underline ml-auto"
        >
          Supabase dashboard ↗
        </a>
      </form>
      {error && (
        <p className="text-xs text-rose-600 mt-2">Update failed: {error}</p>
      )}
    </div>
  );
}

export function ManualMetricsPanel({
  metrics,
}: {
  metrics: ManualMetric[];
}) {
  // After a successful update, soft-refresh the page so the new
  // verified_at / value flows through the snapshot read on next render.
  // router.refresh() would also work but only re-runs Server Components;
  // a full reload guarantees the platform/usage snapshot picks up too.
  function handleSaved() {
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  }

  if (metrics.length === 0) return null;

  return (
    <SectionCard noPadding>
      <div className="p-6 pb-4">
        <SectionHeader
          icon={<Settings size={16} />}
          title="Manual metrics needing periodic refresh"
          description="These services don't expose a public usage API. Pull the current value from each vendor's dashboard."
        />
      </div>
      <div>
        {metrics.map((m) => (
          <MetricRow
            key={`${m.service}:${m.metric}`}
            metric={m}
            onSaved={handleSaved}
          />
        ))}
      </div>
    </SectionCard>
  );
}
