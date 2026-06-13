/**
 * FIX-399 — server-rendered data-provenance pill.
 *
 * Reads the AttributionShape that FIX-398 placed in scope on the 4 detail
 * pages (officials/proposals/donors/agencies) and renders a small pill
 * naming the primary source. Renders nothing when attribution is null or
 * primary is null — the common case for FEC-sourced donors, since FEC
 * dedup is structurally outside external_source_refs.
 *
 * No `'use client'` directive — this is a pure server component. The
 * `<script data-civitics-attribution>` payloads on the detail pages remain
 * in place for FIX-400's lazy popover; do not consume them here.
 *
 * Categories → Tailwind classes live in this file (presentation). Source
 * key → label + category lives in `@civitics/db` (data).
 */

import { resolveSource, type SourceCategory, type AttributionShape } from "@civitics/db";

const SOURCE_CATEGORY_COLORS: Record<SourceCategory, string> = {
  federal:   "bg-civic-blue/10 text-civic-blue",
  state:     "bg-ink/10 text-ink",
  local:     "bg-green-ink/10 text-green-ink",
  community: "bg-amber/25 text-ink",
  other:     "bg-ink/5 text-ink-soft",
};

type Variant = "pill" | "inline" | "icon-only";

type Props = {
  attribution: AttributionShape | null | undefined;
  variant?: Variant;
  className?: string;
};

const PILL_BASE  = "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium";
const INLINE_BASE = "inline-flex items-center gap-1 text-xs font-medium";

export function SourceBadge({ attribution, variant = "pill", className }: Props) {
  if (!attribution || !attribution.primary) return null;

  const { source, source_url } = attribution.primary;
  const resolved = resolveSource(source);
  const colorClass = SOURCE_CATEGORY_COLORS[resolved.category];

  const labelNode =
    variant === "icon-only" ? (
      <>
        <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" aria-hidden />
        <span className="sr-only">{resolved.label}</span>
      </>
    ) : (
      <>
        <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" aria-hidden />
        <span>{resolved.label}</span>
      </>
    );

  const wrapperClass = (() => {
    switch (variant) {
      case "inline":    return [INLINE_BASE, "text-ink-soft", className].filter(Boolean).join(" ");
      case "icon-only": return [PILL_BASE, colorClass, className].filter(Boolean).join(" ");
      case "pill":
      default:          return [PILL_BASE, colorClass, className].filter(Boolean).join(" ");
    }
  })();

  const title = variant === "icon-only" ? `Source: ${resolved.label}` : undefined;

  if (source_url) {
    return (
      <a
        href={source_url}
        target="_blank"
        rel="noopener noreferrer"
        className={`${wrapperClass} hover:opacity-80 transition-opacity`}
        title={title}
        data-source-key={resolved.key}
      >
        {labelNode}
      </a>
    );
  }

  return (
    <span className={wrapperClass} title={title} data-source-key={resolved.key}>
      {labelNode}
    </span>
  );
}
