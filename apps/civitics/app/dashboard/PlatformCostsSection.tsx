"use client";

import { useState, useEffect } from "react";
import {
  SectionCard,
  SectionHeader,
  AlertBanner,
  LoadingSkeleton,
  formatMetricValue,
} from "@civitics/ui";
import { Icon, hasIcon } from "@civitics/graph";
import type { PlatformMetric, SourceDisplay } from "@civitics/db";
import type { PlatformUsageResponse, AnthropicDetail, AiCosts } from "./useDashboardData";
import { useIsAdmin } from "@/lib/use-is-admin";

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
      <span className="inline-flex items-center gap-1.5 text-xs text-green-ink">
        <span className="w-1.5 h-1.5 bg-green-ink rounded-full inline-block animate-pulse" />
        Live · Anthropic Admin API
      </span>
    );
  if (source === "api_usage_logs")
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-civic-blue">
        <span className="w-1.5 h-1.5 bg-civic-blue rounded-full inline-block" />
        From local usage logs
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-amber">
      <span className="w-1.5 h-1.5 bg-amber rounded-full inline-block" />
      Estimated
    </span>
  );
}

// ── Source indicator ──────────────────────────────────────────────────────────

function SourceIndicator({ display }: { display: SourceDisplay }) {
  const colorClass =
    display.color === "green"
      ? "text-green-ink"
      : display.color === "amber"
        ? "text-amber"
        : "text-ink-soft/80";

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
    return <span className="text-xs text-ink-soft/60">&#9675; No data</span>;
  }

  if (!recordedAt) {
    return (
      <span className="text-xs text-ink-soft/80">
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
      ? "text-green-ink"
      : source === "api" && isStale
        ? "text-amber"
        : source === "manual"
          ? "text-civic-blue"
          : "text-ink-soft/80";

  return (
    <span suppressHydrationWarning className={`text-xs ${colorClass}`}>
      {sourceIcon} {ageStr}
    </span>
  );
}

// ── Service metadata ──────────────────────────────────────────────────────────

const SERVICE_META: Record<string, { label: string; icon: string; costLabel: string }> = {
  anthropic: { label: "Anthropic", icon: "anthropic", costLabel: "monthly spend" },
  vercel: { label: "Vercel", icon: "▲", costLabel: "monthly usage" },
  supabase: { label: "Supabase", icon: "supabase", costLabel: "monthly usage" },
  cloudflare: { label: "Cloudflare R2", icon: "cloudflare", costLabel: "monthly usage" },
  mapbox: { label: "Mapbox", icon: "mapbox", costLabel: "map loads" },
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
    healthy: "bg-green-ink",
    warning: "bg-amber",
    critical: "bg-accent",
  };
  return (
    <span
      className={`w-1.5 h-1.5 rounded-full inline-block ${
        colors[status as keyof typeof colors] ?? "bg-rule/60"
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
      ? "bg-accent"
      : metric.status === "warning"
        ? "bg-amber"
        : "bg-green-ink";

  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-ink-soft font-medium">
          {metric.display_label ?? metric.metric}
        </span>
        <span className="text-ink-soft tabular-nums">
          {metric.value != null
            ? `${formatMetricValue(metric.value, metric.unit)} / ${
                metric.included_limit === -1
                  ? "∞"
                  : formatMetricValue(metric.included_limit, metric.unit)
              }`
            : "No data"}
        </span>
      </div>
      <div className="h-1.5 bg-rule/30 rounded-full">
        {metric.included_limit !== -1 && metric.value !== null && (
          <div
            className={`h-full rounded-full ${barColor}`}
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        )}
      </div>
      {pct > 0 && (
        <div className="text-xs text-ink-soft/80 mt-0.5 text-right">{Math.round(pct)}%</div>
      )}
      {metric.metric === "cpu_pct" && metric.metadata && (
        <div className="text-xs text-ink-soft mt-0.5">
          max 1h: {metric.metadata.cpu_max_1h != null
            ? `${Math.round(metric.metadata.cpu_max_1h)}%`
            : "—"}
          {" · "}24h: {metric.metadata.cpu_max_24h != null
            ? `${Math.round(metric.metadata.cpu_max_24h)}%`
            : "—"}
        </div>
      )}
      {/* FIX-648: Vercel run-rate projection context. The headline value is a
          30-day run-rate projected from a trailing ~Nd billing window; show the
          un-projected truth so it's verifiable against the Vercel dashboard. */}
      {metric.metadata?.is_projected && metric.metadata.raw_window_value != null && (
        <div className="text-xs text-ink-soft/80 mt-0.5">
          ~est. monthly run-rate
          {/* FIX-1076: was `window_days ?? "?"`, which rendered "last ?d" when
              the writer had no daily granularity. Drop the clause instead of
              printing a placeholder. */}
          {metric.metadata.window_days != null && <> · last {metric.metadata.window_days}d</>}:{" "}
          {formatMetricValue(metric.metadata.raw_window_value, metric.unit)}
          {metric.metric === "monthly_spend_usd" &&
            metric.metadata.billed_window_usd != null && (
              <> · billed overage (cap): {fmtUsd(metric.metadata.billed_window_usd)}</>
            )}
        </div>
      )}
      {metric.metric === "monthly_spend_usd" &&
        metric.metadata?.cost_breakdown &&
        metric.metadata.cost_breakdown.length > 0 && (
          <div className="text-xs text-ink-soft mt-1">
            <div className="font-medium text-ink-soft/80 mb-0.5">By service (run-rate $/mo)</div>
            {metric.metadata.cost_breakdown.slice(0, 6).map((b) => (
              <div key={b.service} className="flex justify-between py-0.5">
                <span className="truncate max-w-[180px]">{b.service}</span>
                <span className="tabular-nums">{fmtUsd(b.usd)}</span>
              </div>
            ))}
          </div>
        )}
      <div className="flex items-center justify-between mt-1">
        {metric.source !== null ? (
          <SourceIndicator display={metric.source_display} />
        ) : (
          <span className="text-xs text-ink-soft/60">No data</span>
        )}
        {isAdmin && (
          <div className="flex gap-2">
            {metric.source_display.needsVerification && onVerify && (
              <button
                onClick={() => onVerify(metric)}
                className="text-xs text-amber hover:text-amber/80 font-medium"
              >
                Verify
              </button>
            )}
            {onUpdate && (
              <button
                onClick={() => onUpdate(metric)}
                className="text-xs text-ink-soft/80 hover:text-ink"
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
            <span className="text-ink-soft font-medium">
              {displayMetric.display_label ?? displayMetric.metric}
            </span>
            <span className="text-ink-soft tabular-nums">
              {displayMetric.value != null
                ? `${fmtUsd(displayMetric.value)} / ${fmtUsd(displayMetric.included_limit)}`
                : "No data"}
            </span>
          </div>
          <div className="h-1.5 bg-rule/30 rounded-full">
            {displayMetric.included_limit !== -1 && displayMetric.value !== null && (
              <div
                className={`h-full rounded-full ${
                  displayMetric.status === "critical"
                    ? "bg-accent"
                    : displayMetric.status === "warning"
                      ? "bg-amber"
                      : "bg-green-ink"
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
                    className="text-xs text-amber hover:text-amber/80 font-medium"
                  >
                    Verify
                  </button>
                )}
                {onUpdate && (
                  <button
                    onClick={() => onUpdate(displayMetric)}
                    className="text-xs text-ink-soft/80 hover:text-ink"
                  >
                    Update
                  </button>
                )}
              </div>
            )}
          </div>
          {showSubLabel && (
            <div className="flex justify-between text-xs text-ink-soft/80 mt-1">
              <span>${appOnlyCost.toFixed(2)} from Civitics app</span>
              <span>${((totalCost ?? 0) - appOnlyCost).toFixed(2)} other tools</span>
            </div>
          )}
        </div>
      )}

      {/* Token breakdown table */}
      <table className="w-full text-xs text-ink-soft">
        <thead>
          <tr className="text-ink-soft/80 border-b border-rule/60 text-right">
            <th className="text-left pb-1.5 font-medium">Tokens</th>
            <th className="pb-1.5 font-medium">1h</th>
            <th className="pb-1.5 font-medium">24h</th>
            <th className="pb-1.5 font-medium">Month</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule/40">
          <tr className="text-right">
            <td className="text-left py-1.5">Input</td>
            <td className="tabular-nums text-ink-soft/70">—</td>
            <td className="tabular-nums text-ink-soft/70">—</td>
            <td className="tabular-nums">
              {fmtTokens(anthropicDetail?.this_month?.input_tokens ?? 0)}
            </td>
          </tr>
          <tr className="text-right">
            <td className="text-left py-1.5">Output</td>
            <td className="tabular-nums text-ink-soft/70">—</td>
            <td className="tabular-nums text-ink-soft/70">—</td>
            <td className="tabular-nums">
              {fmtTokens(anthropicDetail?.this_month?.output_tokens ?? 0)}
            </td>
          </tr>
          <tr className="text-right">
            <td className="text-left py-1.5">Cache hits</td>
            <td className="tabular-nums text-ink-soft/70">—</td>
            <td className="tabular-nums text-ink-soft/70">—</td>
            <td className="tabular-nums">
              {fmtTokens(anthropicDetail?.this_month?.cache_read_tokens ?? 0)}
            </td>
          </tr>
          <tr className="text-right font-medium border-t border-rule/60">
            <td className="text-left py-1.5">Total</td>
            <td className="tabular-nums">{fmtTokens(aiCosts?.last_hour_tokens ?? 0)}</td>
            <td className="tabular-nums">{fmtTokens(aiCosts?.last_24h_tokens ?? 0)}</td>
            <td className="tabular-nums">
              {fmtTokens(anthropicDetail?.this_month?.total_tokens ?? 0)}
            </td>
          </tr>
          <tr className="text-right">
            <td className="text-left py-1.5 text-ink-soft">Cost</td>
            <td className="tabular-nums text-ink-soft/70">—</td>
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
          <div className="text-xs text-ink-soft">
            <div className="font-medium text-ink-soft/80 mb-1">By model</div>
            {anthropicDetail.this_month.by_model.map((m) => (
              <div key={m.model} className="flex justify-between py-0.5">
                <span className="font-mono text-ink-soft/80 truncate max-w-[180px]">
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
  vercelBilling,
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
  vercelBilling?: PlatformUsageResponse["vercel_billing"];
  isAdmin: boolean;
  adminKey: string;
  onVerify: (metric: PlatformMetric) => void;
  onUpdate: (metric: PlatformMetric) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  // FIX-1076: `vercel.overage_present` is the FIX-1050 wire-format companion
  // to the dollar row — a 0/1 state with bands 1/101, which exists purely so
  // "any overage at all" can be expressed as an integer percentage band and
  // fire the first-cent email. It is not a quantity, so rendering it as a
  // "0 / 1" progress row says nothing; worse, at 1 its pct is 100 and it
  // sorts to the front of `topMetric`, taking over the collapsed card's
  // headline label and bar. Dropped from DISPLAY only — it stays in the API
  // payload and in `serviceStatus` below, so the alert evaluation and the
  // status dot are untouched.
  const displayMetrics = metrics.filter(
    (m) => !(m.service === "vercel" && m.metric === "overage_present"),
  );

  const topMetric =
    displayMetrics
      .filter((m) => m.value !== null && m.value !== undefined)
      .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))[0] ?? displayMetrics[0];

  const serviceStatus: string = metrics.some((m) => m.status === "critical")
    ? "critical"
    : metrics.some((m) => m.status === "warning")
      ? "warning"
      : "healthy";

  const totalCost =
    service === "anthropic"
      ? (anthropicDetail?.this_month?.cost_usd ?? aiCosts?.monthly_spent_usd ?? 0)
      : service === "vercel"
        ? // FIX-1046: the card headline is the projected BILL — subscription plus
          // whatever exceeds the $20 of usage the subscription includes — not the
          // gross list value of all consumption, which is what monthly_spend_usd
          // holds and what this used to show ($31.38 against a real $20.00).
          // FIX-648's monthly_spend_usd remains the fallback for the window
          // between deploy and the first cron tick in the new payload shape.
          (vercelBilling?.projected_total_bill_usd ??
            metrics.find((m) => m.metric === "monthly_spend_usd")?.value ??
            0)
        : metrics.reduce((sum, m) => sum + (m.overage_cost ?? 0), 0);

  // For Anthropic: override the collapsed bar to reflect total account spend, not just app spend
  const anthropicBarPct =
    service === "anthropic" && anthropicDetail?.this_month?.cost_usd != null
      ? (() => {
          const spendMetric = metrics.find((m) => m.metric === "monthly_spend_usd");
          const budget = spendMetric?.included_limit ?? 3.5;
          return (anthropicDetail.this_month!.cost_usd / budget) * 100;
        })()
      : null;
  const displayBarPct = anthropicBarPct ?? (topMetric?.pct ?? 0);
  const displayBarStatus =
    anthropicBarPct != null
      ? (() => {
          const spendMetric = metrics.find((m) => m.metric === "monthly_spend_usd");
          return anthropicBarPct >= (spendMetric?.critical_pct ?? 95)
            ? "critical"
            : anthropicBarPct >= (spendMetric?.warning_pct ?? 80)
              ? "warning"
              : "healthy";
        })()
      : (topMetric?.status ?? "healthy");

  const appOnlyCost = aiCosts?.monthly_spent_usd ?? 0;
  const showAnthropicSubLabel =
    service === "anthropic" &&
    anthropicDetail?.this_month?.cost_usd != null &&
    Math.abs(anthropicDetail.this_month.cost_usd - appOnlyCost) > 0.01;

  return (
    <div className="border border-rule rounded-xl overflow-hidden bg-card">
      {/* Collapsed header — always visible */}
      <div className="p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            {hasIcon(meta.icon) ? (
              <Icon name={meta.icon} className="w-4 h-4 shrink-0 text-ink-soft" />
            ) : (
              <span>{meta.icon}</span>
            )}
            <span className="font-medium text-sm text-ink">{meta.label}</span>
            <StatusDot status={serviceStatus} />
          </div>
          <span className="text-sm font-medium text-ink tabular-nums">
            ${totalCost.toFixed(2)}/mo
          </span>
        </div>

        {/* Top metric label */}
        {topMetric && (
          <div className="text-xs text-ink-soft mb-1.5">
            {topMetric.display_label ?? topMetric.metric}
          </div>
        )}

        {/* Single progress bar */}
        {topMetric && (
          <>
            <div className="h-1.5 bg-rule/30 rounded-full mb-2">
              <div
                className={`h-full rounded-full ${
                  displayBarStatus === "critical"
                    ? "bg-accent"
                    : displayBarStatus === "warning"
                      ? "bg-amber"
                      : "bg-green-ink"
                }`}
                style={{ width: `${Math.min(displayBarPct, 100)}%` }}
              />
            </div>
            {showAnthropicSubLabel && (
              <div className="flex justify-between text-xs text-ink-soft/80 mt-1 mb-1">
                <span>${appOnlyCost.toFixed(2)} from Civitics app</span>
                <span>
                  ${((anthropicDetail!.this_month!.cost_usd) - appOnlyCost).toFixed(2)} other tools
                </span>
              </div>
            )}
          </>
        )}

        {/* Show/hide button */}
        <button
          onClick={() => setExpanded((e) => !e)}
          className="text-xs text-ink-soft/80 hover:text-ink transition-colors flex items-center gap-1"
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
        <div className="border-t border-rule/60 p-4 space-y-4 bg-paper-2/50">
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
            displayMetrics.map((metric) => (
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
      <div className="bg-card rounded-xl shadow-xl p-6 w-full max-w-sm">
        <h2 className="text-base font-semibold text-ink mb-1">
          Update {metric.display_label ?? metric.metric}
        </h2>
        <p className="text-xs text-ink-soft mb-4">
          Source will be set to <span className="font-medium">manual</span>.
          {link && (
            <>
              {" "}
              Check the{" "}
              <a
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                {metric.service} dashboard
              </a>{" "}
              for the current value.
            </>
          )}
        </p>
        <div className="mb-4">
          <label className="text-xs font-medium text-ink-soft block mb-1">
            Value ({metric.unit})
          </label>
          <input
            type="number"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            className="w-full border border-rule bg-card text-ink rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            autoFocus
          />
          {metric.value !== null && (
            <p className="text-xs text-ink-soft/80 mt-1">
              Current: {formatMetricValue(metric.value, metric.unit)}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="text-sm text-ink-soft hover:text-ink px-3 py-1.5"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="text-sm bg-ink text-paper px-4 py-1.5 rounded-lg hover:bg-accent disabled:opacity-50"
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
  chordTotalFlowUsd?: number;
}

export function PlatformCostsSection({
  platformUsage,
  onRefresh,
  anthropicDetail,
  aiCosts,
  chordTotalFlowUsd = 0,
}: PlatformCostsSectionProps) {
  const [mounted, setMounted] = useState(false);
  const [updatingMetric, setUpdatingMetric] = useState<PlatformMetric | null>(null);
  const [adminKey, setAdminKey] = useState("");
  const { isAdmin } = useIsAdmin();

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
        <SectionHeader icon={<Icon name="money" className="w-4 h-4" />} title="Platform Costs" />
        <div className="mt-4">
          {!mounted ? (
            <div className="animate-pulse bg-card rounded-xl border border-rule shadow-sm h-48" />
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

  // FIX-1046 — the headline is BILLABLE money, not gross list value.
  //
  // It used to fold in vercel.monthly_spend_usd, which is the projected sum of
  // EffectiveCost across every charge line INCLUDING the $20 Pro subscription
  // and every dollar of within-allotment usage. On prod 2026-08-16 that made
  // this number read $31.38 on a month whose actual billable overage was $0.00.
  // Vercel Pro is $20/mo AND that $20 buys $20 of included usage, so:
  //     bill = $20 subscription + max(0, usage - $20)
  // The subscription is a real, known, fixed cost and stays in the total; what
  // comes out is the pretend "cost" of usage the subscription already paid for.
  //
  // Falls back to the old gross figure only while `vercel_billing` is absent —
  // i.e. between this deploy and the first cron tick that writes the new payload
  // shape. That window can be a couple of hours under GHA drift.
  const billing = platformUsage.vercel_billing;
  const vercelCost = billing
    ? billing.projected_total_bill_usd
    : ((by_service["vercel"] ?? []).find((m) => m.metric === "monthly_spend_usd")?.value ?? 0);
  const totalMonthlyCost = anthropicCost + otherOverages + vercelCost;

  const edge = platformUsage.cloudflare_edge;
  const mitigation = platformUsage.cf_mitigation;
  const burn = platformUsage.burn_rate;

  // Alert banners
  const banners: Array<{ level: "error" | "warning" | "info"; message: string; detail?: string }> =
    [];
  if (summary.any_critical) {
    banners.push({
      level: "error",
      message: `${summary.critical_count} metric${summary.critical_count !== 1 ? "s" : ""} over limit — action required`,
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
      message: `${summary.unverified_count} usage metric${summary.unverified_count !== 1 ? "s" : ""} need manual verification`,
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
          icon={<Icon name="money" className="w-4 h-4" />}
          title="Platform Costs"
          description="Every cost is public record"
        />

        {/* Summary row. FIX-1076 removed the trailing
            "On {plan} plan · Upgrade" span: the plan field rendered "free"
            while Supabase and Vercel are both on Pro, and the Upgrade button
            had no onClick — a wrong fact next to a dead control. */}
        <div className="flex justify-between items-center mb-1 px-1 mt-4">
          <span className="text-2xl font-bold tabular-nums">
            ${totalMonthlyCost.toFixed(2)}
            <span className="text-sm font-normal text-ink-soft ml-1">/month</span>
          </span>
        </div>

        {/* FIX-1046: show the decomposition, because "$20.00/month" on its own
            is indistinguishable from "we have no idea". The credit line is the
            number that actually tells you how much headroom is left. */}
        {billing && (
          <div className="px-1 mb-3 text-xs text-ink-soft">
            Vercel: ${billing.projected_total_bill_usd.toFixed(2)} = $
            {(billing.projected_total_bill_usd - billing.projected_billable_overage_usd).toFixed(2)}{" "}
            subscription + ${billing.projected_billable_overage_usd.toFixed(2)} billable overage
            {" · "}
            <span
              className={
                billing.credit_remaining_usd <= 0
                  ? "text-accent font-medium"
                  : billing.credit_used_pct >= 80
                    ? "text-ink font-medium"
                    : ""
              }
            >
              ${billing.credit_remaining_usd.toFixed(2)} of the $
              {billing.included_credit_usd.toFixed(0)} usage credit unspent
            </span>
            {" · "}gross list value ${billing.projected_gross_usd.toFixed(2)}
            {!billing.projectable && " (no daily granularity — not projected)"}
          </div>
        )}

        {/* FIX-1044/1045: the leading signal + what the loop is doing. Deliberately
            a compact strip rather than a redesign — the full card revamp is its
            own piece of work. */}
        {(edge || burn || mitigation) && (
          <div className="px-1 mb-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-soft border-t border-rule/60 pt-2">
            {edge?.latest && (
              <span title={`Cloudflare hour ${edge.latest.hour} (UTC)`}>
                Edge{" "}
                <span
                  className={
                    edge.latest.origin_requests >= edge.trip_threshold
                      ? "text-accent font-medium tabular-nums"
                      : "text-ink tabular-nums"
                  }
                >
                  {formatMetricValue(edge.latest.origin_requests, "requests_per_hour")}
                </span>{" "}
                to origin of{" "}
                <span className="tabular-nums">
                  {formatMetricValue(edge.latest.edge_requests, "requests_per_hour")}
                </span>{" "}
                seen
                {edge.latest.mitigated_pct >= 1 &&
                  ` · ${Math.round(edge.latest.mitigated_pct)}% absorbed`}
                {" · trip at "}
                <span className="tabular-nums">
                  {formatMetricValue(edge.trip_threshold, "requests_per_hour")}
                </span>
              </span>
            )}
            {burn?.latest_delta_usd != null && (
              <span title={burn.reason}>
                Burn{" "}
                <span
                  className={
                    burn.elevated ? "text-accent font-medium tabular-nums" : "text-ink tabular-nums"
                  }
                >
                  ${burn.latest_delta_usd.toFixed(2)}/day
                </span>
                {burn.multiple != null && ` (${burn.multiple.toFixed(1)}× median)`}
              </span>
            )}
            {mitigation && (
              <span title={mitigation.reason}>
                Loop{" "}
                {/* FIX-1047: "armed" now means the write scope was PROVED by an
                    idempotent probe, not merely that the kill switch is on.
                    `undefined` = a pre-FIX-1047 snapshot, so we fall back to the
                    old kill-switch-only wording rather than claiming either. */}
                <span
                  className={
                    mitigation.tripped_at
                      ? "text-accent font-medium"
                      : !mitigation.writes_enabled
                        ? "text-ink"
                        : mitigation.write_scope_confirmed === true
                          ? "text-green-ink"
                          : mitigation.write_scope_confirmed === false
                            ? "text-amber"
                            : "text-ink"
                  }
                >
                  {mitigation.tripped_at
                    ? `TRIPPED (auto, since ${mitigation.tripped_at.slice(11, 16)} UTC)`
                    : !mitigation.writes_enabled
                      ? "disarmed"
                      : mitigation.write_scope_confirmed === true
                        ? "armed ✓ verified"
                        : mitigation.write_scope_confirmed === false
                          ? "ALERT-ONLY"
                          : "armed (unverified)"}
                </span>
                {mitigation.observed_level && ` · CF ${mitigation.observed_level}`}
                {mitigation.breach_hours > 0 &&
                  ` · ${mitigation.breach_hours}/${mitigation.required_breach_hours} breach hrs`}
                {(mitigation.write_scope_confirmed === false ||
                  mitigation.action === "skip_no_scope") && (
                  <span className="text-amber"> · needs Zone Settings:Edit</span>
                )}
                {mitigation.threshold_is_overridden && mitigation.threshold != null && (
                  <span className="text-amber">
                    {" "}
                    · threshold OVERRIDDEN to {mitigation.threshold.toLocaleString()}/hr
                  </span>
                )}
              </span>
            )}
          </div>
        )}

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
                vercelBilling={service === "vercel" ? billing : undefined}
                isAdmin={isAdmin}
                adminKey={adminKey}
                onVerify={handleVerify}
                onUpdate={(metric) => setUpdatingMetric(metric)}
              />
            );
          })}
        </div>

        {/* Footer */}
        <p className="text-xs text-center text-ink-soft/80 mt-4">
          Running a civic accountability platform tracking{" "}
          {chordTotalFlowUsd >= 1_000_000_000
            ? `$${(chordTotalFlowUsd / 1_000_000_000).toFixed(2)}B`
            : chordTotalFlowUsd >= 1_000_000
            ? `$${(chordTotalFlowUsd / 1_000_000).toFixed(0)}M`
            : "billions"}{" "}
          in donations costs less than a streaming subscription
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
