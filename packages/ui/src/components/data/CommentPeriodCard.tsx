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

const urgencyStyles: Record<
  NonNullable<CommentPeriodCardProps["urgency"]>,
  string
> = {
  critical: "text-red-700 bg-red-50",
  soon: "text-amber-700 bg-amber-50",
  normal: "text-gray-600 bg-gray-100",
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
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 flex flex-col gap-3">
      <div>
        <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-700 mb-2">
          {agency}
        </span>
        <p className="text-sm font-medium text-gray-900 line-clamp-2">{title}</p>
      </div>
      <div className="flex items-center justify-between gap-2 mt-auto">
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${urgencyStyles[resolvedUrgency]}`}
        >
          {countdown}
        </span>
        <a
          href={href}
          className="inline-flex items-center rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 transition-colors duration-150 shrink-0"
        >
          Comment →
        </a>
      </div>
    </div>
  );
}
