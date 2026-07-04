import * as React from "react";
import { formatNumber } from "../../utils";

interface DataQualityBarProps {
  label: string;
  value: number;
  total?: number;
  pct: number;
  color?: "green" | "blue" | "amber";
}

// Amber pct text stays ink — amber text is unreadable on paper; the amber
// bar fill carries the semantics (FIX-719).
const colorStyles: Record<
  NonNullable<DataQualityBarProps["color"]>,
  { bar: string; text: string }
> = {
  green: { bar: "bg-green-ink", text: "text-green-ink" },
  blue: { bar: "bg-civic-blue", text: "text-civic-blue" },
  amber: { bar: "bg-amber", text: "text-ink" },
};

export function DataQualityBar({
  label,
  value,
  total,
  pct,
  color = "blue",
}: DataQualityBarProps) {
  const styles = colorStyles[color];
  const clampedPct = Math.min(100, Math.max(0, pct));

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm text-ink-soft">{label}</span>
        <span className={`text-sm font-medium tabular-nums ${styles.text}`}>
          {clampedPct.toFixed(1)}%
        </span>
      </div>
      <div className="h-2 w-full rounded-full bg-rule/40 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-200 ${styles.bar}`}
          style={{ width: `${clampedPct}%` }}
        />
      </div>
      {total !== undefined && (
        <div className="mt-0.5 text-xs text-ink-soft/80">
          {formatNumber(value)} of {formatNumber(total)}
        </div>
      )}
    </div>
  );
}
