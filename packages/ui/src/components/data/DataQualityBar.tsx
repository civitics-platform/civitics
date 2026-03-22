import * as React from "react";
import { formatNumber } from "../../utils";

interface DataQualityBarProps {
  label: string;
  value: number;
  total?: number;
  pct: number;
  color?: "green" | "blue" | "amber";
}

const colorStyles: Record<
  NonNullable<DataQualityBarProps["color"]>,
  { bar: string; text: string }
> = {
  green: { bar: "bg-green-500", text: "text-green-700" },
  blue: { bar: "bg-blue-500", text: "text-blue-700" },
  amber: { bar: "bg-amber-500", text: "text-amber-700" },
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
        <span className="text-sm text-gray-700">{label}</span>
        <span className={`text-sm font-medium tabular-nums ${styles.text}`}>
          {clampedPct.toFixed(1)}%
        </span>
      </div>
      <div className="h-2 w-full rounded-full bg-gray-100 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-200 ${styles.bar}`}
          style={{ width: `${clampedPct}%` }}
        />
      </div>
      {total !== undefined && (
        <div className="mt-0.5 text-xs text-gray-400">
          {formatNumber(value)} of {formatNumber(total)}
        </div>
      )}
    </div>
  );
}
