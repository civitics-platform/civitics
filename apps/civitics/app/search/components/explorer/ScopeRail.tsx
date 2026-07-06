"use client";

/**
 * FIX-751 — left rail: By-Branch scope tree (top) + saved-views stub + the
 * contextual facet blocks for the compiled kind (below). Tree data comes from
 * the W0 BROWSE_TREE; node counts are shown only where derivable from the
 * current /api/browse envelope (selected node = totals; a node exactly one
 * facet-key away from the current scope = that facet block's counts) — no
 * per-node count fan-out.
 *
 * Facet blocks render the kind's registry facets minus scope-locked keys.
 * get_browse_facets narrows by the SELECTED value too (naive GROUP BY), so
 * value rows come from a per-kind universe cache (first exact counts seen)
 * and merely lose their count badge when absent from the current counts.
 */

import { useEffect, useMemo, useState } from "react";
import type { BrowseKind, FacetMap, FacetValue } from "@/lib/browse/types";
import { BROWSE_REGISTRY, type FacetDef } from "@/lib/browse/registry";
import { BROWSE_TREE, compileScope, type ScopeNode } from "@/lib/browse/scope-tree";
import { titleizeValue, formatCountCompact } from "./format";

const ENUM_VISIBLE = 8;

function asArray(v: FacetValue | undefined): string[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

export interface ScopeRailProps {
  scope: string;
  kind: BrowseKind | null;
  /** Facet keys the scope itself pins (hidden from the refine blocks). */
  scopeFacets: FacetMap;
  facets: FacetMap;
  facetCounts: Record<string, Record<string, number>>;
  /** Per-facet-key value universe for the current kind (cached exact counts). */
  universe: Record<string, string[]>;
  totalsCount: number | null;
  scopeLabel: string;
  onScope: (path: string) => void;
  onToggleFacet: (key: string, value: string) => void;
}

export function ScopeRail(props: ScopeRailProps) {
  return (
    <div className="flex h-full flex-col overflow-y-auto border-r border-rule bg-card px-2 pb-6 pt-3">
      <h5 className="px-2 pb-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-soft/70">
        Scope — by branch
      </h5>
      <ScopeTree {...props} />

      <h5 className="mt-4 px-2 pb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-soft/70">
        Saved
      </h5>
      {/* W2 ships saved-view persistence; this row is a deliberate disabled affordance. */}
      <div
        className="cursor-not-allowed px-2 py-1 font-mono text-[11px] text-ink-soft/50"
        title="Coming with saved views"
        aria-disabled="true"
      >
        + save current view
      </div>

      <FacetBlocks {...props} />
    </div>
  );
}

// ── Scope tree ─────────────────────────────────────────────────────────────────

function ScopeTree({ scope, kind, facetCounts, totalsCount, onScope }: ScopeRailProps) {
  // Expanded paths — auto-expand ancestors of the active scope, keep the
  // user's manual toggles otherwise.
  const [expanded, setExpanded] = useState<Set<string>>(() => ancestorsOf(scope));

  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const p of ancestorsOf(scope)) next.add(p);
      return next;
    });
  }, [scope]);

  function toggle(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  // Count derivation: selected node → envelope total; a node whose compiled
  // predicate differs from the current scope by exactly ONE facet key → summed
  // from that key's current facet counts. Anything else renders without a count.
  const scopeCompiledFacets = useMemo(() => {
    try { return compileScope(scope).facets; } catch { return {}; }
  }, [scope]);

  function nodeCount(path: string): number | null {
    if (path === scope) return totalsCount;
    if (!kind) return null;
    let compiled;
    try { compiled = compileScope(path); } catch { return null; }
    if (compiled.kind !== kind) return null;

    const keys = new Set([...Object.keys(compiled.facets), ...Object.keys(scopeCompiledFacets)]);
    const delta: string[] = [];
    for (const k of keys) {
      if (JSON.stringify(compiled.facets[k] ?? null) !== JSON.stringify(scopeCompiledFacets[k] ?? null)) delta.push(k);
    }
    if (delta.length !== 1) return null;
    const key = delta[0] as string;
    const values = asArray(compiled.facets[key]);
    if (values.length === 0) return null;
    const counts = facetCounts[key];
    if (!counts) return null;
    return values.reduce((sum, v) => sum + (counts[v] ?? 0), 0);
  }

  function renderNodes(nodes: ScopeNode[], prefix: string, depth: number) {
    return nodes.map((node) => {
      const path = prefix ? `${prefix}/${node.segment}` : node.segment;
      const hasChildren = (node.children?.length ?? 0) > 0;
      const isOpen = expanded.has(path);
      const isSelected = path === scope;
      const count = nodeCount(path);
      return (
        <div key={path}>
          <div
            className={`group flex items-center gap-1.5 rounded-[2px] py-1 pr-2 font-mono text-[12px] transition-colors
              ${isSelected ? "bg-amber/10 text-amber" : "text-ink-soft hover:bg-ink/5 hover:text-ink"}`}
            style={{ paddingLeft: `${8 + depth * 14}px` }}
          >
            <button
              onClick={() => (hasChildren ? toggle(path) : onScope(path))}
              className="w-[12px] shrink-0 text-left text-[9px] text-ink-soft/60 focus-visible:outline-none focus-visible:text-accent"
              aria-label={hasChildren ? (isOpen ? `Collapse ${node.label}` : `Expand ${node.label}`) : node.label}
              tabIndex={hasChildren ? 0 : -1}
            >
              {hasChildren ? (isOpen ? "▾" : "▸") : ""}
            </button>
            <button
              onClick={() => onScope(path)}
              className="min-w-0 flex-1 truncate text-left focus-visible:outline-none focus-visible:text-accent"
            >
              {node.label}
            </button>
            {count != null && (
              <span className={`shrink-0 font-mono text-[10.5px] tabular-nums ${isSelected ? "text-amber" : "text-ink-soft/60"}`}>
                {formatCountCompact(count)}
              </span>
            )}
          </div>
          {hasChildren && isOpen && renderNodes(node.children as ScopeNode[], path, depth + 1)}
        </div>
      );
    });
  }

  return <nav aria-label="Browse scope">{renderNodes(BROWSE_TREE, "", 0)}</nav>;
}

function ancestorsOf(scope: string): Set<string> {
  const out = new Set<string>();
  const segs = scope.split("/").filter(Boolean);
  let prefix = "";
  for (const seg of segs) {
    prefix = prefix ? `${prefix}/${seg}` : seg;
    out.add(prefix);
  }
  return out;
}

// ── Facet blocks ───────────────────────────────────────────────────────────────

function FacetBlocks({ kind, scopeFacets, facets, facetCounts, universe, totalsCount, scopeLabel, onToggleFacet }: ScopeRailProps) {
  if (!kind) return null;
  const defs = BROWSE_REGISTRY[kind].facets.filter((f) => !(f.key in scopeFacets));
  if (defs.length === 0) return null;

  return (
    <div className="mt-4 border-t border-rule pt-2">
      <h5 className="px-2 pb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-soft/70">
        Refine — {scopeLabel}{totalsCount != null ? ` (${formatCountCompact(totalsCount)})` : ""}
      </h5>
      {defs.map((def) => (
        <FacetBlock
          key={`${kind}:${def.key}`}
          def={def}
          selected={asArray(facets[def.key])}
          counts={facetCounts[def.key]}
          universeValues={universe[def.key] ?? []}
          totalsCount={totalsCount}
          onToggle={(value) => onToggleFacet(def.key, value)}
        />
      ))}
    </div>
  );
}

function FacetBlock({
  def, selected, counts, universeValues, totalsCount, onToggle,
}: {
  def: FacetDef;
  selected: string[];
  counts: Record<string, number> | undefined;
  universeValues: string[];
  totalsCount: number | null;
  onToggle: (value: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [filter, setFilter] = useState("");

  // Value rows: current counts ∪ cached universe ∪ selected values, count-desc.
  const values = useMemo(() => {
    const set = new Set<string>([...Object.keys(counts ?? {}), ...universeValues, ...selected]);
    return [...set].sort((a, b) => {
      const ca = counts?.[a] ?? -1;
      const cb = counts?.[b] ?? -1;
      if (cb !== ca) return cb - ca;
      return a.localeCompare(b);
    });
  }, [counts, universeValues, selected]);

  const isTypeahead = def.flavour === "typeahead";
  const filtered = isTypeahead && filter
    ? values.filter((v) => v.toLowerCase().includes(filter.toLowerCase()))
    : values;
  const visible = showAll || isTypeahead ? filtered.slice(0, isTypeahead ? ENUM_VISIBLE : filtered.length) : filtered.slice(0, ENUM_VISIBLE);
  const hiddenCount = filtered.length - visible.length;

  const blockMax = Math.max(1, ...values.map((v) => counts?.[v] ?? 0));
  const denominator = totalsCount && totalsCount > 0 ? totalsCount : blockMax;

  if (values.length === 0 && !isTypeahead) return null;

  return (
    <div className="pt-2">
      <h6 className="px-2 pb-1 pt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-soft/60">
        {def.label}
      </h6>
      {isTypeahead && (
        <div className="px-2 pb-1">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              // Free-entry commit for when counts are omitted and the universe
              // is empty (e.g. cold typeahead facet) — Enter applies the text.
              if (e.key === "Enter" && filter.trim() && filtered.length === 0) {
                onToggle(filter.trim());
                setFilter("");
              }
            }}
            placeholder={`filter ${def.label.toLowerCase()}…`}
            className="w-full rounded-[2px] border border-term-line bg-paper px-2 py-1 font-mono text-[11px] text-ink placeholder:text-ink-soft/60 focus:border-accent focus:outline-none"
          />
        </div>
      )}
      {visible.map((value) => {
        const isOn = selected.includes(value);
        const count = counts?.[value];
        return (
          <button
            key={value}
            onClick={() => onToggle(value)}
            aria-pressed={isOn}
            className={`flex w-full items-center gap-2 px-2 py-[3px] text-left font-mono text-[11.5px] transition-colors focus-visible:outline-none focus-visible:bg-ink/10
              ${isOn ? "text-amber" : "text-ink-soft hover:text-ink"}`}
          >
            <span
              className={`relative h-[11px] w-[11px] shrink-0 rounded-[2px] border ${isOn ? "border-amber bg-amber/15" : "border-ink-soft/50"}`}
              aria-hidden
            >
              {isOn && <span className="absolute -top-[4px] left-[1px] text-[10px] leading-none text-amber">✓</span>}
            </span>
            <span className="min-w-0 flex-1 truncate">{titleizeValue(value)}</span>
            {count != null && (
              <>
                <span className="h-[3px] w-[42px] shrink-0 overflow-hidden rounded-[1px] bg-rule/60">
                  <span
                    className={`block h-full ${isOn ? "bg-amber" : "bg-ink-soft/50"}`}
                    style={{ width: `${Math.min(100, Math.round((count / denominator) * 100))}%` }}
                  />
                </span>
                <span className="w-[38px] shrink-0 text-right font-mono text-[10.5px] tabular-nums text-ink-soft/60">
                  {formatCountCompact(count)}
                </span>
              </>
            )}
          </button>
        );
      })}
      {hiddenCount > 0 && !isTypeahead && (
        <button
          onClick={() => setShowAll(true)}
          className="px-2 py-[3px] pl-[27px] font-mono text-[10.5px] text-ink-soft/60 hover:text-amber focus-visible:outline-none focus-visible:text-amber"
        >
          + {hiddenCount} more…
        </button>
      )}
      {isTypeahead && hiddenCount > 0 && (
        <p className="px-2 py-[3px] pl-[27px] font-mono text-[10.5px] text-ink-soft/50">
          {hiddenCount} more — type to narrow
        </p>
      )}
    </div>
  );
}
