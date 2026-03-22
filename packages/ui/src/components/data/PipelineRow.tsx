import * as React from "react";
import { formatRelativeTime, formatNumber } from "../../utils";
import { StatusBadge } from "../feedback/StatusBadge";

interface PipelineRowProps {
  name: string;
  displayName?: string;
  status: string;
  completedAt?: string | null;
  rowsInserted?: number;
  isDelta?: boolean;
  duration?: number;
  cost?: number;
}

function formatDuration(seconds: number): string {
  if (seconds < 1) return "< 1s";
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  return `${mins}m`;
}

export function PipelineRow({
  name,
  displayName,
  status,
  completedAt,
  rowsInserted,
  isDelta,
  duration,
  cost,
}: PipelineRowProps) {
  const label = displayName ?? name;
  const validStatus =
    status === "complete" ||
    status === "running" ||
    status === "interrupted" ||
    status === "failed" ||
    status === "pending"
      ? (status as "complete" | "running" | "interrupted" | "failed" | "pending")
      : "pending";

  return (
    <div className="flex items-center gap-3 py-3 px-4 hover:bg-gray-50 transition-colors duration-150">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-900 truncate">
            {label}
          </span>
          {isDelta && (
            <span
              className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-purple-50 text-purple-700"
              title="Delta mode — only new data processed"
            >
              δ
            </span>
          )}
        </div>
      </div>

      <StatusBadge status={validStatus} size="sm" />

      {completedAt && (
        <span className="text-xs text-gray-400 w-20 text-right shrink-0">
          {formatRelativeTime(completedAt)}
        </span>
      )}

      {typeof rowsInserted === "number" && (
        <span className="text-xs text-gray-500 w-16 text-right shrink-0">
          {formatNumber(rowsInserted, { compact: true })} rows
        </span>
      )}

      {typeof duration === "number" && duration > 0 && (
        <span className="text-xs text-gray-400 w-14 text-right shrink-0">
          {formatDuration(duration)}
        </span>
      )}

      {typeof cost === "number" && cost > 0 && (
        <span className="text-xs text-gray-400 w-10 text-right shrink-0">
          ${cost.toFixed(2)}
        </span>
      )}
    </div>
  );
}
