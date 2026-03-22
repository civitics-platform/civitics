export function formatUSD(
  cents: number,
  options?: {
    compact?: boolean;
    showCents?: boolean;
  }
): string {
  const dollars = cents / 100;
  if (options?.compact) {
    if (dollars >= 1_000_000_000)
      return "$" + (dollars / 1_000_000_000).toFixed(1) + "B";
    if (dollars >= 1_000_000)
      return "$" + (dollars / 1_000_000).toFixed(1) + "M";
    if (dollars >= 1_000)
      return "$" + (dollars / 1_000).toFixed(0) + "K";
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: options?.showCents ? 2 : 0,
  }).format(dollars);
}

export function formatNumber(
  n: number,
  options?: { compact?: boolean }
): string {
  if (options?.compact) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(0) + "K";
  }
  return new Intl.NumberFormat("en-US").format(n);
}

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function formatPipelineStatus(status: string): {
  label: string;
  color: string;
  bgColor: string;
  icon: string;
} {
  switch (status) {
    case "complete":
      return {
        label: "Complete",
        color: "text-green-700",
        bgColor: "bg-green-50",
        icon: "✓",
      };
    case "running":
      return {
        label: "Running",
        color: "text-blue-700",
        bgColor: "bg-blue-50",
        icon: "⟳",
      };
    case "interrupted":
      return {
        label: "Interrupted",
        color: "text-amber-700",
        bgColor: "bg-amber-50",
        icon: "⚠",
      };
    case "failed":
      return {
        label: "Failed",
        color: "text-red-700",
        bgColor: "bg-red-50",
        icon: "✗",
      };
    default:
      return {
        label: status,
        color: "text-gray-600",
        bgColor: "bg-gray-50",
        icon: "○",
      };
  }
}

export function formatCountdown(isoDeadline: string): string {
  const deadline = new Date(isoDeadline);
  const now = new Date();
  const diffMs = deadline.getTime() - now.getTime();
  if (diffMs < 0) return "Closed";
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffHours < 24) return `Closes in ${diffHours}h`;
  if (diffDays === 1) return "Closes tomorrow";
  return `Closes in ${diffDays} days`;
}
