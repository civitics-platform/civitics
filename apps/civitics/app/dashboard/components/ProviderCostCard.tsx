"use client";

/**
 * One provider, one card shape (FIX-1091).
 *
 * Every provider gets the SAME full-width card — no compact half-cards, no
 * per-vendor layout. The old section had one card shape for Anthropic and
 * another for everything else, which made two providers impossible to compare
 * and buried the only row that was costing money. Here the differences between
 * providers live in the DATA (plan line, bill decomposition, which rows rank
 * into the headline), never in the frame.
 *
 * Structure: status dot + name + plan/cycle line + right-aligned true $/mo,
 * a bill-decomposition line where non-zero, two-to-three headline meters, then
 * a collapsible details section carrying the rest of the rows plus whatever
 * provider-specific panel the caller passes as `extra`.
 */

import { useState, type ReactNode } from "react";
import { Icon, hasIcon } from "@civitics/graph";
import type { PlatformMetric, SourceDisplay } from "@civitics/db";
import {
  cycleDayLabel,
  cycleKeyForMetric,
  isDisplayedMetric,
  isRollingCycle,
  rankMetrics,
  serviceIsProjected,
  type CostsPayloadView,
  type Formatters,
  type ProviderCycle,
  type ServiceCost,
} from "@/lib/platform-costs-view";
import { CostMeter } from "./CostMeter";

const HEADLINE_METERS = 3;

// ── Small parts ───────────────────────────────────────────────────────────────

export function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    healthy: "bg-green-ink",
    warning: "bg-amber",
    critical: "bg-accent",
  };
  return (
    <span
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${colors[status] ?? "bg-rule/60"}`}
      title={status}
    />
  );
}

export function SourceIndicator({ display }: { display: SourceDisplay }) {
  const colorClass =
    display.color === "green"
      ? "text-green-ink"
      : display.color === "amber"
        ? "text-amber"
        : "text-ink-soft/70";

  // FIX-1076: getSourceDisplay no longer carries the icon inside `label`, but
  // this section renders a PERSISTED payload — an old snapshot still holds the
  // doubled form ("~ ~ Est."). Cheap insurance, kept from the previous card.
  const label = display.label.startsWith(display.icon)
    ? display.label.slice(display.icon.length).trimStart()
    : display.label;

  return (
    <span className={`whitespace-nowrap ${colorClass}`} title={display.tooltip}>
      {display.icon} {label}
    </span>
  );
}

/** How old the newest reading on this card is. */
function DataAge({ metrics }: { metrics: PlatformMetric[] }) {
  const newest = metrics
    .filter((m) => m.recorded_at)
    .sort((a, b) => new Date(b.recorded_at!).getTime() - new Date(a.recorded_at!).getTime())[0];
  if (!newest?.recorded_at) return <span className="text-ink-soft/60">○ no data</span>;

  const ageMin = Math.round((Date.now() - new Date(newest.recorded_at).getTime()) / 60_000);
  const text =
    ageMin < 1
      ? "just now"
      : ageMin < 60
        ? `${ageMin}m ago`
        : ageMin < 1440
          ? `${Math.round(ageMin / 60)}h ago`
          : `${Math.round(ageMin / 1440)}d ago`;

  return (
    <span suppressHydrationWarning className={ageMin > 60 ? "text-amber" : "text-ink-soft/70"}>
      read {text}
    </span>
  );
}

// ── The card ──────────────────────────────────────────────────────────────────

export function ProviderCostCard({
  service,
  label,
  icon,
  metrics,
  payload,
  cost,
  legacyCost,
  planLabel,
  fmt,
  isAdmin,
  onEditThresholds,
  extra,
  footnote,
  metricControls,
}: {
  service: string;
  label: string;
  icon: string;
  metrics: PlatformMetric[];
  payload: CostsPayloadView;
  /** Itemized true cost for this provider; null on a pre-FIX-1089 payload. */
  cost: ServiceCost | null;
  /** Pre-R4a per-card arithmetic, used only while `cost` is null. */
  legacyCost: number;
  planLabel: string | null;
  fmt: Formatters;
  isAdmin: boolean;
  onEditThresholds: () => void;
  /** Provider-specific detail panel (the Anthropic token table, etc.). */
  extra?: ReactNode;
  /** One-line caveat under the meters (self-counted sources, FIX-1092). */
  footnote?: ReactNode;
  /** Per-row admin controls, rendered on the details meters only. */
  metricControls?: (metric: PlatformMetric) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);

  const displayed = metrics.filter(isDisplayedMetric);
  const ranked = rankMetrics(displayed);
  const headline = ranked.slice(0, HEADLINE_METERS);
  const rest = ranked.slice(HEADLINE_METERS);

  // Status rolls up over ALL rows including hidden companions — the dot is the
  // alert state, and a companion row exists precisely to carry one (FIX-1076).
  const status = metrics.some((m) => m.status === "critical")
    ? "critical"
    : metrics.some((m) => m.status === "warning")
      ? "warning"
      : "healthy";

  const cycles = payload.cycles ?? {};
  const cardCycle: ProviderCycle | undefined = cycles[service];
  const cycleFor = (m: PlatformMetric): ProviderCycle | undefined => cycles[cycleKeyForMetric(m)];
  // Provider-wide, derived from the rows themselves — see pacePctFor.
  const projectedProvider = serviceIsProjected(metrics);

  const total = cost ? cost.total : legacyCost;
  const dayLabel = cycleDayLabel(cardCycle);

  return (
    <div className="overflow-hidden rounded-xl border border-rule bg-card">
      <div className="p-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            {hasIcon(icon) ? (
              <Icon name={icon} className="h-4 w-4 shrink-0 text-ink-soft" />
            ) : (
              <span className="shrink-0">{icon}</span>
            )}
            <span className="truncate text-sm font-medium text-ink">{label}</span>
            <StatusDot status={status} />
          </div>
          <span className="shrink-0 text-sm font-medium tabular-nums text-ink">
            {fmt.usd(total)}/mo
          </span>
        </div>

        {/* Plan · cycle · day N of M */}
        <div className="mt-0.5 text-xs text-ink-soft/80">
          {[
            planLabel,
            cardCycle
              ? isRollingCycle(cardCycle)
                ? `${cardCycle.label} — no billing cycle`
                : `cycle ${cardCycle.label}`
              : null,
            dayLabel,
          ]
            .filter(Boolean)
            .join(" · ")}
          {cardCycle && !isRollingCycle(cardCycle) && cardCycle.source !== "api" && (
            <span
              className="ml-1 cursor-help text-ink-soft/60"
              title={cardCycle.detail}
            >
              ({cardCycle.source})
            </span>
          )}
        </div>

        {/* Bill decomposition — only where there is a bill to decompose. */}
        {cost && total > 0 && (
          <div className="mt-1.5 text-xs text-ink-soft">
            bill ={" "}
            {[
              ...cost.subItems
                .filter((s) => s.usd > 0)
                .map((s) => `${fmt.usd(s.usd)} ${s.name} subscription`),
              ...cost.usageItems.map((u) => `${fmt.usd(u.usd)} ${u.label}`),
            ].join(" + ")}
          </div>
        )}

        {/* Headline meters */}
        <div className="mt-3 space-y-3">
          {headline.map((m) => (
            <CostMeter
              key={m.metric}
              metric={m}
              cycle={cycleFor(m)}
              fmt={fmt}
              providerIsProjected={projectedProvider}
              showPaceLabel
            />
          ))}
          {headline.length === 0 && (
            <p className="text-xs text-ink-soft/70">No metric rows for this provider yet.</p>
          )}
        </div>

        {footnote && <div className="mt-2 text-[11px] text-ink-soft/70">{footnote}</div>}

        {/* Footer: details toggle · data age · admin affordance */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px]">
          <div className="flex items-center gap-3">
            {(rest.length > 0 || extra) && (
              <button
                onClick={() => setExpanded((e) => !e)}
                className="text-ink-soft/80 transition-colors hover:text-ink"
              >
                {expanded ? "▾ hide details" : `▸ ${rest.length > 0 ? `${rest.length} more metric${rest.length === 1 ? "" : "s"}` : "details"}`}
              </button>
            )}
            <DataAge metrics={metrics} />
          </div>
          {/* Client-gated only — never rendered into the edge-cached SSR HTML. */}
          {isAdmin && (
            <button
              onClick={onEditThresholds}
              className="text-ink-soft/70 transition-colors hover:text-accent"
              title="Edit this provider's alert thresholds (admin)"
            >
              ✎ thresholds — admin
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="space-y-4 border-t border-rule/60 bg-paper-2/50 p-4">
          {rest.length > 0 && (
            <div className="space-y-3">
              {rest.map((m) => (
                <CostMeter
                  key={m.metric}
                  metric={m}
                  cycle={cycleFor(m)}
                  fmt={fmt}
                  providerIsProjected={projectedProvider}
                >
                  <SourceIndicator display={m.source_display} />
                  {metricControls?.(m)}
                </CostMeter>
              ))}
            </div>
          )}
          {extra}
        </div>
      )}
    </div>
  );
}
