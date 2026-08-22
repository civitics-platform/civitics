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

  // FIX-1076: the whole card is the link, not just the "Comment →" button —
  // the agency badge and title used to be dead pixels. Stretched-link rather
  // than wrapping everything in one <a>, because the CTA is itself an <a> and
  // nesting anchors is invalid HTML (hydration mismatch — see
  // apps/civitics/CLAUDE.md). The overlay sits ABOVE the static content so it
  // actually receives those clicks; the CTA is raised above the overlay in
  // turn, so it keeps its own hit target and stays in the tab order.
  return (
    <div className="group relative bg-card rounded-xl border border-rule shadow-sm p-4 flex flex-col gap-3 transition-colors duration-150 hover:border-accent/50">
      <a
        href={href}
        aria-label={`Comment on ${title}`}
        className="absolute inset-0 z-10 rounded-xl"
      />

      <div>
        <span className="inline-flex items-center rounded-full bg-paper-2 px-2.5 py-0.5 text-xs font-medium text-ink-soft mb-2">
          {agency}
        </span>
        <p className="text-sm font-medium text-ink line-clamp-2 group-hover:text-accent transition-colors duration-150">
          {title}
        </p>
      </div>
      <div className="flex items-center justify-between gap-2 mt-auto">
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${urgencyStyles[resolvedUrgency]}`}
        >
          {countdown}
        </span>
        <a
          href={href}
          tabIndex={-1}
          aria-hidden="true"
          className="relative z-20 inline-flex items-center rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-paper hover:bg-accent transition-colors duration-150 shrink-0"
        >
          Comment →
        </a>
      </div>
    </div>
  );
}
