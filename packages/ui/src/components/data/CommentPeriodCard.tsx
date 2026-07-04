import * as React from "react";
import { formatCountdown } from "../../utils";

interface CommentPeriodCardProps {
  id: string;
  title: string;
  agency: string;
  deadline: string;
  href: string;
  urgency?: "critical" | "soon" | "normal";
}

function deriveUrgency(deadline: string): CommentPeriodCardProps["urgency"] {
  const diffMs = new Date(deadline).getTime() - Date.now();
  const diffHours = diffMs / 3_600_000;
  if (diffHours < 48) return "critical";
  if (diffHours < 7 * 24) return "soon";
  return "normal";
}

// "soon" text stays ink — amber text is unreadable on paper; the amber tint
// carries the urgency (FIX-719).
const urgencyStyles: Record<
  NonNullable<CommentPeriodCardProps["urgency"]>,
  string
> = {
  critical: "text-accent bg-accent/10",
  soon: "text-ink bg-amber/20",
  normal: "text-ink-soft bg-rule/40",
};

export function CommentPeriodCard({
  title,
  agency,
  deadline,
  href,
  urgency,
}: CommentPeriodCardProps) {
  const resolvedUrgency: NonNullable<CommentPeriodCardProps["urgency"]> =
    urgency ?? deriveUrgency(deadline) ?? "normal";
  const countdown = formatCountdown(deadline);

  return (
    <div className="bg-card rounded-xl border border-rule shadow-sm p-4 flex flex-col gap-3">
      <div>
        <span className="inline-flex items-center rounded-full bg-paper-2 px-2.5 py-0.5 text-xs font-medium text-ink-soft mb-2">
          {agency}
        </span>
        <p className="text-sm font-medium text-ink line-clamp-2">{title}</p>
      </div>
      <div className="flex items-center justify-between gap-2 mt-auto">
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${urgencyStyles[resolvedUrgency]}`}
        >
          {countdown}
        </span>
        <a
          href={href}
          className="inline-flex items-center rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-paper hover:bg-accent transition-colors duration-150 shrink-0"
        >
          Comment →
        </a>
      </div>
    </div>
  );
}
