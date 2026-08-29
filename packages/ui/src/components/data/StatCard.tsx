"use client";

import * as React from "react";
import { useState, useEffect } from "react";
import { formatUSD, formatNumber } from "../../utils";
import { Sparkline } from "./Sparkline";

/**
 * FIX-090 — below this many points a sparkline is not drawn at all (no empty
 * box, no axis, no placeholder). Two points is a straight line between two
 * readings, which reads as a trend while asserting nothing; three is the least
 * that can show a shape. Metrics that only start accruing when the recorder
 * ships therefore stay invisible for their first couple of days and then appear.
 */
export const MIN_SPARKLINE_POINTS = 3;

interface StatCardProps {
  /** String emoji (legacy) or React node (e.g. Lucide icon) */
  icon?: string | React.ReactNode;
  label: string;
  value: number | string;
  formatAs?: "number" | "usd" | "string";
  trend?: string;
  trendDirection?: "up" | "down" | "neutral";
  href?: string;
  onClick?: () => void;
  badge?: {
    label: string;
    href?: string;
    variant?: "info" | "warning" | "success";
  };
  loading?: boolean;
  sublabel?: string;
  /**
   * FIX-090 — optional 30-day trend garnish. The card's number stays the hero;
   * this is a thin unlabelled line beneath it plus a compact delta in dim text.
   * Props-driven per the packages/ui rule — the caller computes the series and
   * the label, this component only draws them.
   */
  sparkline?: {
    /** Oldest-first values. Fewer than MIN_SPARKLINE_POINTS renders nothing. */
    data: number[];
    /** Compact change over the window, e.g. "+1.2% 30d". */
    deltaLabel?: string;
    /** Accessible description, e.g. "Officials, 30-day trend: up 1.2%". */
    ariaLabel?: string;
  };
}

const badgeVariantStyles: Record<
  NonNullable<StatCardProps["badge"]>["variant"] & string,
  string
> = {
  info: "bg-civic-blue/10 text-civic-blue",
  warning: "bg-amber/20 text-ink",
  success: "bg-green-ink/10 text-green-ink",
};

const trendStyles: Record<
  NonNullable<StatCardProps["trendDirection"]>,
  string
> = {
  up: "text-green-ink",
  down: "text-accent",
  neutral: "text-ink-soft",
};

const trendIcons: Record<NonNullable<StatCardProps["trendDirection"]>, string> = {
  up: "↑",
  down: "↓",
  neutral: "→",
};

function formatValue(
  value: number | string,
  formatAs: StatCardProps["formatAs"]
): string {
  if (typeof value === "string") return value;
  if (formatAs === "usd") return formatUSD(value, { compact: true });
  if (formatAs === "number") return formatNumber(value, { compact: true });
  return String(value);
}

function CardInner({
  icon,
  label,
  value,
  formatAs,
  trend,
  trendDirection,
  badge,
  sublabel,
  href,
  sparkline,
}: StatCardProps) {
  const formatted = formatValue(value, formatAs ?? "number");
  const badgeVariant = badge?.variant ?? "info";

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5">
          {icon && (
            typeof icon === "string"
              ? <span className="text-base" aria-hidden="true">{icon}</span>
              : <span className="text-ink-soft flex-shrink-0" aria-hidden="true">{icon}</span>
          )}
          <span className="text-xs font-medium text-ink-soft uppercase tracking-wide">
            {label}
          </span>
        </div>
        {badge && (
          <span>
            {badge.href ? (
              <span
                role="link"
                tabIndex={0}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (badge.href) window.location.href = badge.href;
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && badge.href) {
                    e.preventDefault();
                    e.stopPropagation();
                    window.location.href = badge.href;
                  }
                }}
                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium cursor-pointer ${badgeVariantStyles[badgeVariant]}`}
              >
                {badge.label}
              </span>
            ) : (
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${badgeVariantStyles[badgeVariant]}`}
              >
                {badge.label}
              </span>
            )}
          </span>
        )}
      </div>

      <div className="flex-1">
        <div className="text-3xl font-bold tabular-nums text-ink">
          {formatted}
        </div>
        {sublabel && (
          <div className="mt-0.5 text-xs text-ink-soft">{sublabel}</div>
        )}
        {sparkline && sparkline.data.length >= MIN_SPARKLINE_POINTS && (
          <div className="mt-2 flex items-end gap-2" role="img" aria-label={sparkline.ariaLabel}>
            <Sparkline
              data={sparkline.data}
              height={20}
              width={72}
              strokeWidth={2}
              endDot
            />
            {sparkline.deltaLabel && (
              <span className="pb-0.5 text-[11px] tabular-nums text-ink-soft/70">
                {sparkline.deltaLabel}
              </span>
            )}
          </div>
        )}
      </div>

      {(trend || href) && (
        <div className="mt-3 flex items-center justify-between">
          {trend && trendDirection ? (
            <span className={`text-xs font-medium ${trendStyles[trendDirection]}`}>
              {trendIcons[trendDirection]} {trend}
            </span>
          ) : trend ? (
            <span className="text-xs text-ink-soft">{trend}</span>
          ) : (
            <span />
          )}
          {href && (
            <span className="text-sm text-ink-soft/70 group-hover:text-accent transition-colors duration-150">
              →
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function StatCard(props: StatCardProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || props.loading) {
    return (
      <div className="bg-card rounded-xl border border-rule shadow-sm p-6 animate-pulse">
        <div className="h-4 bg-rule/60 rounded w-24 mb-4" />
        <div className="h-8 bg-rule/60 rounded w-16" />
      </div>
    );
  }

  const inner = <CardInner {...props} />;

  if (props.onClick) {
    return (
      <div
        onClick={props.onClick}
        className="group block bg-card rounded-xl border border-rule shadow-sm p-6 cursor-pointer hover:border-accent/40 hover:shadow-md transition-all duration-150"
      >
        {inner}
      </div>
    );
  }

  if (props.href) {
    return (
      <a
        href={props.href}
        className="group block bg-card rounded-xl border border-rule shadow-sm p-6 hover:border-accent/40 hover:shadow-md transition-all duration-150"
      >
        {inner}
      </a>
    );
  }

  return (
    <div className="bg-card rounded-xl border border-rule shadow-sm p-6">
      {inner}
    </div>
  );
}
