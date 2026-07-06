"use client";

/**
 * FIX-751 — breadcrumb + facet chips (decision 1). Crumbs POP SCOPE (clicking
 * one truncates the scope path there); chips clear INDIVIDUAL explicit facets.
 * The two are deliberately distinct controls over the two halves of BrowseState.
 */

import type { FacetMap } from "@/lib/browse/types";
import { scopeCrumbs } from "@/lib/browse/scope-tree";
import { BROWSE_REGISTRY } from "@/lib/browse/registry";
import type { BrowseKind } from "@/lib/browse/types";
import { Chip, chipVariantFor } from "./Chip";
import { titleizeValue } from "./format";

export function CrumbBar({
  scope, kind, facets, onScope, onRemoveFacet, onClearFacets,
}: {
  scope: string;
  kind: BrowseKind | null;
  facets: FacetMap;
  onScope: (path: string) => void;
  onRemoveFacet: (key: string, value: string) => void;
  onClearFacets: () => void;
}) {
  let crumbs: { path: string; label: string }[] = [];
  try {
    crumbs = scopeCrumbs(scope);
  } catch {
    crumbs = [];
  }

  const chips: Array<{ key: string; value: string; label: string }> = [];
  for (const [key, v] of Object.entries(facets)) {
    const def = kind ? BROWSE_REGISTRY[kind].facets.find((f) => f.key === key) : null;
    const keyLabel = (def?.label ?? key.replace(/_/g, " ")).toLowerCase();
    for (const value of Array.isArray(v) ? v : [v]) {
      chips.push({ key, value, label: `${keyLabel}: ${titleizeValue(value)}` });
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-rule px-4 py-2.5">
      <nav aria-label="Scope breadcrumb" className="flex min-w-0 flex-wrap items-center font-mono text-[12px]">
        <button
          onClick={() => onScope("")}
          className={`transition-colors focus-visible:outline-none focus-visible:text-accent ${crumbs.length === 0 ? "font-semibold text-ink" : "text-ink-soft hover:text-amber"}`}
        >
          Search
        </button>
        {crumbs.map((crumb, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <span key={crumb.path} className="flex items-center">
              <span className="mx-1.5 text-ink-soft/50">›</span>
              {isLast ? (
                <span className="font-semibold text-ink">{crumb.label}</span>
              ) : (
                <button
                  onClick={() => onScope(crumb.path)}
                  className="text-ink-soft transition-colors hover:text-amber focus-visible:outline-none focus-visible:text-accent"
                >
                  {crumb.label}
                </button>
              )}
            </span>
          );
        })}
      </nav>

      <span className="flex-1" />

      {chips.map((chip) => (
        <Chip
          key={`${chip.key}:${chip.value}`}
          variant={chipVariantFor(chip.key, chip.value) === "neutral" ? "active" : chipVariantFor(chip.key, chip.value)}
          onDismiss={() => onRemoveFacet(chip.key, chip.value)}
        >
          {chip.label}
        </Chip>
      ))}
      {chips.length > 1 && (
        <button
          onClick={onClearFacets}
          className="rounded-[2px] border border-term-line px-1.5 py-0.5 font-mono text-[10.5px] text-ink-soft transition-colors hover:border-accent/60 hover:text-accent focus-visible:outline-none focus-visible:border-accent focus-visible:text-accent"
        >
          clear all
        </button>
      )}
    </div>
  );
}
