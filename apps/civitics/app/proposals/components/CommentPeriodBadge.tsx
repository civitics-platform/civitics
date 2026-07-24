import { Icon } from "@civitics/graph";

type Props = {
  commentPeriodEnd: string; // ISO timestamp
  compact?: boolean;
};

function daysUntil(isoDate: string): number {
  return Math.ceil(
    (new Date(isoDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  );
}

function formatDate(isoDate: string): string {
  return new Date(isoDate).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function CommentPeriodBadge({ commentPeriodEnd, compact = false }: Props) {
  const days = daysUntil(commentPeriodEnd);

  if (days <= 0) return null; // already closed

  const urgency =
    days <= 7
      ? { bg: "bg-accent/5", border: "border-accent/30", text: "text-accent", dot: "bg-accent" }
      : days <= 14
      ? { bg: "bg-amber/20", border: "border-amber/60", text: "text-ink", dot: "bg-amber" }
      : { bg: "bg-green-ink/5", border: "border-green-ink/30", text: "text-green-ink", dot: "bg-green-ink" };

  const label =
    days === 1
      ? "Closes tomorrow"
      : days <= 7
      ? `Closes in ${days} days`
      : `Closes in ${days} days`;

  if (compact) {
    return (
      <span
        className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium border ${urgency.bg} ${urgency.border} ${urgency.text}`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${urgency.dot}`} />
        {label}
      </span>
    );
  }

  return (
    <div
      className={`flex items-center justify-between gap-3 border px-3 py-2 text-sm ${urgency.bg} ${urgency.border} ${urgency.text}`}
    >
      <span className="inline-flex items-center gap-1 font-medium"><Icon name="comment" className="w-3.5 h-3.5" />{label}</span>
      <span className="font-mono tabular-nums opacity-75">Deadline: {formatDate(commentPeriodEnd)}</span>
    </div>
  );
}
