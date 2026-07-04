import * as React from "react";
import { cn } from "../lib/cn";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: "democrat" | "republican" | "independent" | "neutral" | "agency" | "proposal";
}

// Party hues are categorical, not status — viz-7 (wine) stands in for the
// independent purple since the semantic set has no purple (FIX-719).
const variantClasses: Record<NonNullable<BadgeProps["variant"]>, string> = {
  democrat: "border-civic-blue/60 text-civic-blue bg-civic-blue/10",
  republican: "border-accent/60 text-accent bg-accent/10",
  independent: "border-viz-7/60 text-viz-7 bg-viz-7/10",
  neutral: "border-rule text-ink-soft bg-paper-2",
  agency: "border-rule text-ink bg-paper-2",
  proposal: "border-amber/60 text-ink bg-amber/20",
};

export function Badge({ className, variant = "neutral", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
        variantClasses[variant],
        className
      )}
      {...props}
    />
  );
}
