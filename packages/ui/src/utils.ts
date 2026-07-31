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
  // Semantic status map (FIX-719): green-ink / civic-blue / amber / accent.
  // Warning-tier text stays ink (amber text is unreadable on paper — the
  // amber tint on the chrome carries the semantics in both modes).
  switch (status) {
    case "complete":
      return {
        label: "Complete",
        color: "text-green-ink",
        bgColor: "bg-green-ink/10",
        icon: "✓",
      };
    case "running":
      return {
        label: "Running",
        color: "text-civic-blue",
        bgColor: "bg-civic-blue/10",
        icon: "⟳",
      };
    case "interrupted":
      return {
        label: "Interrupted",
        color: "text-ink",
        bgColor: "bg-amber/20",
        icon: "⚠",
      };
    case "failed":
      return {
        label: "Failed",
        color: "text-accent",
        bgColor: "bg-accent/10",
        icon: "✗",
      };
    // FIX-944 — a run that did real work and stopped cleanly at its wall-clock
    // budget, resumable from a committed cursor. Warning tier, not error: it is
    // the designed path for a dirty set too large for one window.
    case "partial":
      return {
        label: "Partial",
        color: "text-ink",
        bgColor: "bg-amber/20",
        icon: "◐",
      };
    // FIX-944 — the row was stranded in 'running' and swept by
    // reap_stale_sync_log(). Distinct from 'failed' because the pipeline never
    // reported anything; started_at..metadata.reaped_at is an upper bound on
    // runtime, not a measurement.
    case "reaped":
      return {
        label: "Reaped",
        color: "text-accent",
        bgColor: "bg-accent/10",
        icon: "⌫",
      };
    default:
      return {
        label: status,
        color: "text-ink-soft",
        bgColor: "bg-rule/40",
        icon: "○",
      };
  }
}

export function formatMetricValue(value: number, unit: string): string {
  switch (unit) {
    case "bytes":
      if (value >= 1099511627776)
        return `${(value / 1099511627776).toFixed(1)} TB`;
      if (value >= 1073741824)
        return `${(value / 1073741824).toFixed(1)} GB`;
      if (value >= 1048576)
        return `${(value / 1048576).toFixed(1)} MB`;
      return `${(value / 1024).toFixed(0)} KB`;

    case "seconds":
      if (value >= 3600)
        return `${Math.floor(value / 3600)}h ${Math.floor((value % 3600) / 60)}m`;
      if (value >= 60)
        return `${Math.floor(value / 60)}m ${value % 60}s`;
      return `${value}s`;

    case "ms":
      if (value >= 3600000) return `${(value / 3600000).toFixed(1)}h`;
      if (value >= 60000) return `${(value / 60000).toFixed(1)}m`;
      return `${(value / 1000).toFixed(1)}s`;

    case "minutes":
      if (value >= 60)
        return `${Math.floor(value / 60)}h ${value % 60}m`;
      return `${value}m`;

    case "requests":
      if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
      if (value >= 1000) return `${(value / 1000).toFixed(0)}K`;
      return value.toString();

    case "usd":
      return `$${value.toFixed(2)}`;

    case "gb_hours":
      return `${value.toFixed(1)} GB-Hrs`;

    case "events":
    case "reads":
      if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
      return value.toString();

    case "percent":
      return `${Math.round(value)}%`;

    default:
      return value.toString();
  }
}

export function formatCountdown(isoDeadline: string): string {
  const deadline = new Date(isoDeadline);
  const now = new Date();
  const diffMs = deadline.getTime() - now.getTime();
  if (diffMs < 0) return "Closed";
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffHours < 1) return `Closes in ${Math.ceil(diffMs / 60_000)}m`;
  if (diffHours < 24) return `Closes in ${diffHours}h`;
  if (diffDays === 1) return "Closes tomorrow";
  return `Closes in ${diffDays} days`;
}
