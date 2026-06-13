"use client";

import { useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EntityTag = {
  tag: string;
  tag_category: string;
  display_label: string;
  display_icon: string | null;
  visibility: "primary" | "secondary" | "internal";
  confidence: number;
  generated_by?: string;
  ai_model?: string | null;
  metadata?: Record<string, unknown>;
};

interface EntityTagsProps {
  entityType: string;
  entityId: string;
  tags?: EntityTag[];
  variant?: "compact" | "full";
}

// ---------------------------------------------------------------------------
// Category → color pill styles
// ---------------------------------------------------------------------------

// Token palette (FIX-563): four categories keep a color identity
// (urgency=amber, topic=blue, pattern=accent, industry=green); the rest
// read as neutral paper pills — no purple/teal tokens exist by design.
const CATEGORY_STYLES: Record<string, string> = {
  urgency:  "bg-amber/25 text-ink border border-amber/60",
  topic:    "bg-civic-blue/10 text-civic-blue border border-civic-blue/25",
  pattern:  "bg-accent/10 text-accent border border-accent/25",
  industry: "bg-green-ink/10 text-green-ink border border-green-ink/25",
  audience: "bg-ink/5 text-ink-soft border border-rule",
  scope:    "bg-ink/5 text-ink-soft border border-rule",
  quality:  "bg-paper-2 text-ink-soft border border-rule",
  size:     "bg-paper-2 text-ink-soft border border-rule",
};

const DEFAULT_PILL_STYLE = "bg-ink/5 text-ink-soft border border-rule";

function pillStyle(category: string): string {
  return CATEGORY_STYLES[category] ?? DEFAULT_PILL_STYLE;
}

// ---------------------------------------------------------------------------
// Sort order: urgency first, then topic, then everything else
// ---------------------------------------------------------------------------

const CATEGORY_ORDER: Record<string, number> = {
  urgency: 0,
  topic:   1,
  pattern: 2,
  industry: 3,
  audience: 4,
  scope:   5,
  quality: 6,
  size:    7,
  internal: 8,
};

function sortTags(tags: EntityTag[]): EntityTag[] {
  return [...tags].sort((a, b) => {
    const aOrder = CATEGORY_ORDER[a.tag_category] ?? 9;
    const bOrder = CATEGORY_ORDER[b.tag_category] ?? 9;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return b.confidence - a.confidence;
  });
}

// ---------------------------------------------------------------------------
// Research warning — shown the first time tier 3 is expanded
// ---------------------------------------------------------------------------

const DISMISSED_KEY = "civitics_research_tags_dismissed";

function hasResearchWarningBeenDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function dismissResearchWarning(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // localStorage not available (SSR guard)
  }
}

// ---------------------------------------------------------------------------
// Pill component
// ---------------------------------------------------------------------------

function TagPill({ tag, muted = false }: { tag: EntityTag; muted?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${
        muted ? "bg-paper-2 text-ink-soft/70 border border-rule text-[10px]" : pillStyle(tag.tag_category)
      }`}
      title={`${tag.display_label}${tag.confidence < 1 ? ` (${Math.round(tag.confidence * 100)}% confidence)` : ""}`}
    >
      {tag.display_icon && <span className="text-[11px]">{tag.display_icon}</span>}
      {tag.display_label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function EntityTags({ tags = [], variant = "compact" }: EntityTagsProps) {
  const [tier2Open, setTier2Open]         = useState(false);
  const [tier3Open, setTier3Open]         = useState(false);
  const [researchDismissed, setDismissed] = useState(false);

  if (tags.length === 0) return null;

  // ── Bucket tags into tiers ──────────────────────────────────────────────
  // Tier 1: primary, confidence >= 0.8
  const tier1 = sortTags(
    tags.filter((t) => t.visibility === "primary" && t.confidence >= 0.8)
  ).slice(0, 3);

  // Tier 2: secondary, confidence >= 0.7
  const tier2 = sortTags(
    tags.filter((t) => t.visibility === "secondary" && t.confidence >= 0.7)
  );

  // Tier 3: everything else (internal or low confidence)
  const tier3 = sortTags(
    tags.filter(
      (t) => t.visibility === "internal" || t.confidence < 0.7
    )
  );

  const hasResearchTags = tier3.length > 0;

  // ── Render ──────────────────────────────────────────────────────────────

  function handleResearchClick() {
    if (hasResearchWarningBeenDismissed() || researchDismissed) {
      setTier3Open((prev) => !prev);
    } else {
      setTier3Open(true); // open — will show warning
    }
  }

  function handleDismissWarning() {
    dismissResearchWarning();
    setDismissed(true);
  }

  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {/* ── Tier 1: always visible ────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-1">
        {tier1.map((tag) => (
          <TagPill key={`${tag.tag}-${tag.tag_category}`} tag={tag} />
        ))}

        {/* "+N more" collapse button (tier 2) */}
        {tier2.length > 0 && !tier2Open && (
          <button
            onClick={() => setTier2Open(true)}
            className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium text-accent hover:bg-accent/5 transition-colors"
          >
            +{tier2.length} more
          </button>
        )}
      </div>

      {/* ── Tier 2: expandable ────────────────────────────────────────────── */}
      {tier2Open && tier2.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tier2.map((tag) => (
            <TagPill key={`${tag.tag}-${tag.tag_category}`} tag={tag} />
          ))}
        </div>
      )}

      {/* ── Collapse / research toggle row ───────────────────────────────── */}
      {(tier2Open || hasResearchTags) && (
        <div className="flex flex-wrap items-center gap-2 mt-0.5">
          {tier2Open && tier2.length > 0 && (
            <button
              onClick={() => { setTier2Open(false); setTier3Open(false); }}
              className="text-[11px] text-ink-soft/70 hover:text-ink-soft transition-colors"
            >
              ▲ Show less
            </button>
          )}
          {hasResearchTags && (
            <button
              onClick={handleResearchClick}
              className="text-[11px] text-ink-soft/70 hover:text-ink-soft transition-colors"
            >
              {tier3Open ? "⚙ Hide research tags ↑" : "⚙ Research tags"}
            </button>
          )}
        </div>
      )}

      {/* ── Tier 3: research / internal tags ─────────────────────────────── */}
      {tier3Open && (
        <div className="mt-1 border border-rule bg-paper-2 p-3">
          {/* Warning blurb — shown until dismissed */}
          {!hasResearchWarningBeenDismissed() && !researchDismissed && (
            <div className="mb-3 border border-amber/60 bg-amber/15 p-2.5 text-xs text-ink">
              <p className="font-semibold mb-1">⚙ Research &amp; Internal Tags</p>
              <p className="text-[11px] leading-relaxed mb-2">
                These tags include:{" "}
                <span className="opacity-80">
                  low-confidence AI labels (&lt;0.7 certainty), internal pipeline metadata,
                  unverified classifications, and timing analysis flags.
                </span>{" "}
                Shown for full transparency. May contain errors.
              </p>
              <button
                onClick={handleDismissWarning}
                className="bg-amber/40 px-2 py-0.5 text-[11px] font-medium text-ink hover:bg-amber/60 transition-colors"
              >
                Got it
              </button>
            </div>
          )}

          {/* Internal tags */}
          <p className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-soft/70">
            Research tags
          </p>
          <div className="flex flex-wrap gap-1">
            {tier3.map((tag) => (
              <span
                key={`${tag.tag}-${tag.tag_category}`}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-ink-soft bg-card border border-rule font-mono"
                title={`${tag.tag_category}: ${tag.tag} (confidence: ${tag.confidence})`}
              >
                {tag.display_icon && <span>{tag.display_icon}</span>}
                {tag.tag}
                {tag.confidence < 1 && (
                  <span className="opacity-60 ml-0.5">{Math.round(tag.confidence * 100)}%</span>
                )}
              </span>
            ))}
          </div>

          {/* Detail page shows model + pipeline info */}
          {variant === "full" && tier3.some((t) => t.ai_model) && (
            <p className="mt-2 text-[10px] text-ink-soft/60">
              AI model: {tier3.find((t) => t.ai_model)?.ai_model ?? "unknown"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
