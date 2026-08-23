"use client";

/**
 * The one meter anatomy the Platform Costs section uses everywhere (FIX-1091).
 *
 * ── THE ANATOMY ──────────────────────────────────────────────────────────────
 *
 *   ├──────────── included allowance (75%) ────────────┆── overage zone (25%) ──┤
 *   ███████████████████████▮ (pace tick)               ┆ ▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨▨
 *                          △ (projected cycle end)
 *
 * Every track is laid out identically, so a reader learns it once and can then
 * compare two rows by eye. The right quarter is a hatched OVERAGE ZONE and the
 * scale inside it is COMPRESSED (see `trackPct`) — which is exactly why the
 * true magnitude and the implied dollars are always printed as text next to the
 * bar. Colour and geometry never carry the number alone; past the boundary the
 * geometry is deliberately not to scale.
 *
 * The pace tick and the projection marker are drawn only where the payload can
 * honestly support them — the suppression rules live in `pacePctFor` and
 * `projectionOf`, not here, so they can be tested.
 */

import type { CSSProperties, ReactNode } from "react";
import type { PlatformMetric } from "@civitics/db";
import {
  costPhrase,
  cycleDayLabel,
  isStateMetric,
  isUnlimited,
  meterGeometry,
  metricLabel,
  projectionOf,
  type Formatters,
  type MeterTone,
  type ProviderCycle,
} from "@/lib/platform-costs-view";

const TONE_FILL: Record<MeterTone, string> = {
  ok: "bg-green-ink",
  watch: "bg-amber",
  over: "bg-accent",
};

const OVERAGE_ZONE_STYLE: CSSProperties = {
  left: "75%",
  backgroundColor: "rgb(var(--c-accent) / 0.07)",
  backgroundImage:
    "repeating-linear-gradient(45deg, rgb(var(--c-accent) / 0.22) 0 1.5px, transparent 1.5px 5px)",
};

// ── The key ───────────────────────────────────────────────────────────────────

/** The one-line legend under the headline. Without it the anatomy is a guess. */
export function MeterKey() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-soft/80">
      <span className="inline-flex items-center gap-1">
        <span className="inline-block h-2 w-4 rounded-sm bg-green-ink" />
        within included, at or behind pace
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-block h-2 w-4 rounded-sm bg-amber" />
        ahead of pace or ≥90%
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-block h-2 w-4 rounded-sm bg-accent" />
        over — billed
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-block h-3 w-0 border-l border-dashed border-ink-soft" />
        included limit
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-block h-3 w-[2px] bg-ink" />
        today in the cycle
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="text-[9px] leading-none">△</span>
        projected cycle end
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-block h-2 w-4 rounded-sm" style={OVERAGE_ZONE_STYLE} />
        overage zone (compressed scale)
      </span>
    </div>
  );
}

// ── The meter ─────────────────────────────────────────────────────────────────

export function CostMeter({
  metric,
  cycle,
  fmt,
  providerIsProjected = false,
  showPaceLabel = false,
  children,
}: {
  metric: PlatformMetric;
  cycle: ProviderCycle | undefined;
  fmt: Formatters;
  /** True when this provider's quantities are projected — suppresses the tick. */
  providerIsProjected?: boolean;
  /** Headline meters label the pace tick; details meters keep it to a tooltip. */
  showPaceLabel?: boolean;
  /** Trailing controls (admin actions) rendered on the money row. */
  children?: ReactNode;
}) {
  const geometry = meterGeometry(metric, cycle, providerIsProjected);
  const phrase = costPhrase(metric, fmt);
  const projection = projectionOf(metric);
  const label = metricLabel(metric);
  const dayLabel = cycleDayLabel(cycle);

  const valueText =
    metric.value === null
      ? "no reading"
      : isStateMetric(metric)
        ? metric.value >= metric.included_limit
          ? "signal ON"
          : "signal off"
        : isUnlimited(metric)
          ? `${fmt.value(metric.value, metric.unit)} · no included limit`
          : `${fmt.value(geometry?.fillValue ?? metric.value, metric.unit)} / ${fmt.value(
              metric.included_limit,
              metric.unit,
            )}`;

  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate font-medium text-ink-soft" title={metric.notes ?? undefined}>
          {label}
        </span>
        <span className="shrink-0 tabular-nums text-ink">{valueText}</span>
      </div>

      {geometry && (
        <div className="mt-1">
          <div className="relative h-3">
            {/* Track + zone + fill. Only this layer clips, so the ticks below
                can stand proud of the bar without being cut off. */}
            <div className="absolute inset-x-0 top-0.5 h-2 overflow-hidden rounded-sm bg-rule/25">
              <div className="absolute inset-y-0 right-0" style={OVERAGE_ZONE_STYLE} />
              <div
                className={`absolute inset-y-0 left-0 rounded-l-sm ${TONE_FILL[geometry.tone]}`}
                style={{ width: `${geometry.fillPct}%` }}
              />
            </div>

            {/* Included-limit boundary. */}
            <div
              className="absolute inset-y-0 border-l border-dashed border-ink-soft/70"
              style={{ left: `${geometry.includedPct}%` }}
              title={`Included: ${fmt.value(metric.included_limit, metric.unit)}`}
            />

            {/* Pace tick — where the cycle is today. */}
            {geometry.pacePct !== null && (
              <div
                className="absolute -top-0.5 -bottom-0.5 w-[2px] -translate-x-1/2 bg-ink"
                style={{ left: `${geometry.pacePct}%` }}
                title={dayLabel ? `${dayLabel} of this billing cycle` : "cycle pace"}
              />
            )}
          </div>

          {/* Sub-rail: the projection marker, or the pace label. A row never has
              both — a projected row's pace tick is suppressed because its
              quantities are not on this cycle's basis. */}
          {(geometry.projectionPct !== null || (showPaceLabel && geometry.pacePct !== null)) && (
            <div className="relative h-3 text-[9px] leading-none text-ink-soft/80">
              {geometry.projectionPct !== null && projection && (
                <span
                  className="absolute -translate-x-1/2"
                  style={{ left: `${geometry.projectionPct}%` }}
                  title={`Projected ${fmt.value(projection.projected, metric.unit)} by cycle end`}
                >
                  △
                </span>
              )}
              {showPaceLabel && geometry.pacePct !== null && dayLabel && (
                <span
                  className="absolute -translate-x-1/2 whitespace-nowrap"
                  style={{ left: `${geometry.pacePct}%` }}
                >
                  {dayLabel.split(" of ")[0]}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-soft/80">
        {/* The magnitude, in words, because the bar's overage scale is compressed. */}
        {geometry?.overLimit && metric.value !== null && (
          <span className="font-medium text-accent">
            {(geometry.pctOfIncluded / 100).toFixed(1)}× the included{" "}
            {fmt.value(metric.included_limit, metric.unit)}
          </span>
        )}
        {projection && (
          <span title="The payload's own projection — not re-derived here.">
            → {fmt.value(projection.projected, metric.unit)} projected
          </span>
        )}
        {phrase.rate && <span>{phrase.rate}</span>}
        {phrase.cost && (
          <span
            className={
              phrase.tone === "billed"
                ? "font-medium text-accent"
                : phrase.tone === "neutral"
                  ? "text-ink-soft"
                  : "text-ink-soft/70"
            }
          >
            {phrase.rate ? "→ " : ""}
            {phrase.cost}
          </span>
        )}
        {children}
      </div>
    </div>
  );
}
