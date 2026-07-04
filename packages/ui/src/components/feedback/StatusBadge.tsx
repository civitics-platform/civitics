import * as React from "react";
import { formatPipelineStatus } from "../../utils";

interface StatusBadgeProps {
  status:
    | "complete"
    | "running"
    | "interrupted"
    | "failed"
    | "pending"
    | "ok"
    | "warning"
    | "error";
  label?: string;
  size?: "sm" | "md";
}

const extraStatusMap: Partial<
  Record<
    StatusBadgeProps["status"],
    { label: string; color: string; bgColor: string; icon: string }
  >
> = {
  pending: {
    label: "Pending",
    color: "text-ink-soft",
    bgColor: "bg-rule/40",
    icon: "○",
  },
  ok: {
    label: "OK",
    color: "text-green-ink",
    bgColor: "bg-green-ink/10",
    icon: "✓",
  },
  warning: {
    label: "Warning",
    color: "text-ink",
    bgColor: "bg-amber/20",
    icon: "⚠",
  },
  error: {
    label: "Error",
    color: "text-accent",
    bgColor: "bg-accent/10",
    icon: "✗",
  },
};

export function StatusBadge({ status, label, size = "md" }: StatusBadgeProps) {
  const extra = extraStatusMap[status];
  const { label: defaultLabel, color, bgColor, icon } = extra
    ? extra
    : formatPipelineStatus(status);

  const displayLabel = label ?? defaultLabel;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-medium border border-transparent ${bgColor} ${color} ${
        size === "sm" ? "text-xs px-2 py-0.5" : "text-sm px-3 py-1"
      }`}
    >
      <span aria-hidden="true">{icon}</span>
      {displayLabel}
    </span>
  );
}
