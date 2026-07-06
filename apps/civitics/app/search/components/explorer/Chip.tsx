/**
 * FIX-751 — square chip grammar for the explorer (decision 2; keeps FIX-730's
 * rounded-full inventory from growing). Terminal-scope-only code, so bare
 * amber text is allowed. Party hues follow the FIX-719 Badge convention
 * (viz-7 wine stands in for independent purple).
 */

const VARIANT: Record<string, string> = {
  neutral:     "border-term-line text-ink-soft bg-ink/5",
  active:      "border-amber/60 text-amber bg-amber/10",
  positive:    "border-green-ink/50 text-green-ink bg-green-ink/10",
  negative:    "border-accent/50 text-accent bg-accent/10",
  democrat:    "border-civic-blue/50 text-civic-blue bg-civic-blue/10",
  republican:  "border-accent/50 text-accent bg-accent/10",
  independent: "border-viz-7/50 text-viz-7 bg-viz-7/10",
};

/** Semantic chip variant for a facet value (party hues, status hues, neutral). */
export function chipVariantFor(facetKey: string, value: string): string {
  if (facetKey === "party") {
    if (value in VARIANT) return value;
    return "neutral";
  }
  if (facetKey === "status") {
    if (value === "open_comment" || value === "enacted" || value === "signed") return "positive";
    if (value === "failed" || value === "withdrawn") return "negative";
  }
  return "neutral";
}

export function Chip({
  variant = "neutral",
  className = "",
  onDismiss,
  children,
}: {
  variant?: string;
  className?: string;
  onDismiss?: () => void;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-[2px] border px-1.5 py-0.5 font-mono text-[10.5px] font-medium whitespace-nowrap ${VARIANT[variant] ?? VARIANT.neutral} ${className}`}
    >
      {children}
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="text-ink-soft/70 hover:text-accent transition-colors focus-visible:outline-none focus-visible:text-accent"
          aria-label="Remove filter"
        >
          ✕
        </button>
      )}
    </span>
  );
}
