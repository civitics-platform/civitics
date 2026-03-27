import * as React from "react";
import { formatUSD, formatNumber } from "../../utils";
import { LoadingSkeleton } from "../feedback/LoadingSkeleton";

interface StatCardProps {
  icon?: string;
  label: string;
  value: number | string;
  formatAs?: "number" | "usd" | "string";
  trend?: string;
  trendDirection?: "up" | "down" | "neutral";
  href?: string;
  badge?: {
    label: string;
    href?: string;
    variant?: "info" | "warning" | "success";
  };
  loading?: boolean;
  sublabel?: string;
}

const badgeVariantStyles: Record<
  NonNullable<StatCardProps["badge"]>["variant"] & string,
  string
> = {
  info: "bg-blue-100 text-blue-700",
  warning: "bg-amber-100 text-amber-700",
  success: "bg-green-100 text-green-700",
};

const trendStyles: Record<
  NonNullable<StatCardProps["trendDirection"]>,
  string
> = {
  up: "text-green-600",
  down: "text-red-600",
  neutral: "text-gray-500",
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
}: StatCardProps) {
  const formatted = formatValue(value, formatAs ?? "number");
  const badgeVariant = badge?.variant ?? "info";

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5">
          {icon && <span className="text-base" aria-hidden="true">{icon}</span>}
          <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
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
        <div className="text-3xl font-bold tabular-nums text-gray-900">
          {formatted}
        </div>
        {sublabel && (
          <div className="mt-0.5 text-xs text-gray-500">{sublabel}</div>
        )}
      </div>

      {(trend || href) && (
        <div className="mt-3 flex items-center justify-between">
          {trend && trendDirection ? (
            <span className={`text-xs font-medium ${trendStyles[trendDirection]}`}>
              {trendIcons[trendDirection]} {trend}
            </span>
          ) : trend ? (
            <span className="text-xs text-gray-500">{trend}</span>
          ) : (
            <span />
          )}
          {href && (
            <span className="text-sm text-gray-400 group-hover:text-blue-600 transition-colors duration-150">
              →
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function StatCard(props: StatCardProps) {
  if (props.loading) {
    return <LoadingSkeleton variant="stat-card" />;
  }

  const inner = <CardInner {...props} />;

  if (props.href) {
    return (
      <a
        href={props.href}
        className="group block bg-white rounded-xl border border-gray-200 shadow-sm p-6 hover:border-blue-200 hover:shadow-md transition-all duration-150"
      >
        {inner}
      </a>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
      {inner}
    </div>
  );
}
