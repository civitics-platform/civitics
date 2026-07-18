"use client";

/**
 * packages/graph/src/SankeyGraph.tsx
 *
 * Federal contract budget flow — d3-sankey rendering of
 * "Federal Treasury → Agency → Sector → Vendor". Levels (2/3/4), min flow USD,
 * and top-N at each tier are user-configurable.
 * Per FIX-147 / GRAPH_PLAN §5.4.
 */

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import * as d3 from "d3";
import {
  sankey as d3Sankey,
  sankeyLinkHorizontal,
  type SankeyNodeMinimal,
  type SankeyLinkMinimal,
} from "d3-sankey";
import type { RefObject } from "react";
import type { SankeyOptions } from "./types";
import { resolveToken, resolveColor } from "./tokens";

// ── Types ─────────────────────────────────────────────────────────────────────

interface SankeyFlow {
  agencyId: string;
  agencyName: string;
  agencyAcronym: string;
  sector: string;
  vendorId: string;
  vendorName: string;
  amountCents: number;
  awardCount: number;
}

interface SankeyApiResponse {
  flows: SankeyFlow[];
  totalCents: number;
  scannedRows: number;
}

type Tier = "root" | "agency" | "sector" | "vendor";

interface SNode extends SankeyNodeMinimal<SNode, SLink> {
  id: string;
  label: string;
  tier: Tier;
}

interface SLink extends SankeyLinkMinimal<SNode, SLink> {
  source: string | number | SNode;
  target: string | number | SNode;
  value: number;
}

const ROOT_NODE_ID = "root:federal";

// Sector palette — same buckets as chord/spending so colors stay consistent.
// Token strings (FIX-729) built from the 9-hue viz ramp + brand hues; the
// original 18 Tailwind hexes collapse near-neighbour pairs (violet/violet-400,
// amber/amber-400, red/rose, blue/sky, cyan/teal) onto the same token. Wrap
// with resolveColor(…, svgEl) at d3 .attr() sites.
const SECTOR_COLORS: Record<string, string> = {
  "Manufacturing":         "rgb(var(--c-viz-4))",     // was blue → civic blue
  "Information Technology": "rgb(var(--c-viz-7))",    // was violet → wine
  "Professional Services":  "rgb(var(--c-viz-2))",    // was cyan → teal
  "Health Care":           "rgb(var(--c-viz-9))",     // was pink → bronze
  "Construction":          "rgb(var(--c-amber))",     // was amber
  "Transportation":        "rgb(var(--c-viz-2))",     // was teal → teal
  "Finance":               "rgb(var(--c-green-ink))", // was emerald
  "Education":             "rgb(var(--c-blue))",      // was indigo → blue
  "Real Estate":           "rgb(var(--c-viz-8))",     // was lime → olive
  "Mining":                "rgb(var(--c-accent))",    // was red
  "Retail":                "rgb(var(--c-viz-6))",     // was orange → terracotta
  "Agriculture":           "rgb(var(--c-viz-1))",     // was green
  "Wholesale Trade":       "rgb(var(--c-viz-7))",     // was violet-400 → wine
  "Utilities":             "rgb(var(--c-viz-3))",     // was amber-400 → ochre-gold
  "Entertainment":         "rgb(var(--c-accent))",    // was rose → accent
  "Public Administration": "rgb(var(--c-viz-4))",     // was sky → civic blue
  "Other Services":        "rgb(var(--c-ink-soft))",  // neutral
  "Other":                 "rgb(var(--c-viz-5))",     // was slate → steel-slate
};

function sectorColor(sector: string): string {
  return SECTOR_COLORS[sector] ?? "rgb(var(--c-viz-5))";
}

function fmtMoney(cents: number): string {
  const d = cents / 100;
  if (d >= 1_000_000_000) return `$${(d / 1_000_000_000).toFixed(1)}B`;
  if (d >= 1_000_000) return `$${(d / 1_000_000).toFixed(1)}M`;
  if (d >= 1_000) return `$${(d / 1_000).toFixed(0)}K`;
  if (d > 0) return `$${d.toFixed(0)}`;
  return "—";
}

// ── Component ─────────────────────────────────────────────────────────────────

export interface SankeyGraphProps {
  className?: string;
  svgRef?: RefObject<SVGSVGElement>;
  vizOptions?: Partial<SankeyOptions>;
  /**
   * FIX-857 — when an agency is the primary focus entity, scope the contract
   * scan to that agency (the server has supported ?agencyId= since FIX-218).
   * null = platform-wide (all agencies). agencyName labels the scope pill.
   */
  agencyId?: string | null;
  agencyName?: string | null;
}

const DEFAULTS: SankeyOptions = {
  levels: 4,
  minFlowUsd: 0,
  topN: 12,
  showLabels: true,
};

export function SankeyGraph({ className = "", svgRef: externalSvgRef, vizOptions, agencyId = null, agencyName = null }: SankeyGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const internalSvgRef = useRef<SVGSVGElement>(null);
  const svgRef = externalSvgRef ?? internalSvgRef;

  const [data, setData] = useState<SankeyApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const levels = vizOptions?.levels ?? DEFAULTS.levels;
  const minFlowUsd = vizOptions?.minFlowUsd ?? DEFAULTS.minFlowUsd;
  const topN = vizOptions?.topN ?? DEFAULTS.topN;
  const showLabels = vizOptions?.showLabels ?? DEFAULTS.showLabels ?? true;

  // ── Fetch ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    setLoading(true);
    setError(null);

    // FIX-857 — scope to the focused agency when present (?agencyId=), else
    // platform-wide. The server (FIX-218) narrows the contract scan to
    // from_id = agencyId.
    const qs = agencyId ? `?agencyId=${encodeURIComponent(agencyId)}` : "";
    fetch(`/api/graph/sankey${qs}`)
      .then((r) => r.json())
      .then((res: SankeyApiResponse | { error: string }) => {
        if ("error" in res) throw new Error(res.error);
        setData(res);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [agencyId]);

  // ── Build nodes + links from flows ──────────────────────────────────────────
  const graph = useMemo(() => {
    if (!data) return null;

    const minCents = minFlowUsd * 100;
    const filtered = data.flows.filter((f) => f.amountCents >= minCents);

    if (filtered.length === 0) return null;

    // Top-N filtering at each tier — keep only the top-N agencies / sectors /
    // vendors by total amount. 0 = no cap.
    const cap = topN > 0 ? topN : Infinity;

    const agencyTotals = new Map<string, number>();
    for (const f of filtered) {
      agencyTotals.set(f.agencyId, (agencyTotals.get(f.agencyId) ?? 0) + f.amountCents);
    }
    const topAgencies = new Set(
      [...agencyTotals.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, cap)
        .map(([id]) => id),
    );

    const sectorTotals = new Map<string, number>();
    for (const f of filtered) {
      if (!topAgencies.has(f.agencyId)) continue;
      sectorTotals.set(f.sector, (sectorTotals.get(f.sector) ?? 0) + f.amountCents);
    }
    const topSectors = new Set(
      [...sectorTotals.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, cap)
        .map(([s]) => s),
    );

    const vendorTotals = new Map<string, number>();
    for (const f of filtered) {
      if (!topAgencies.has(f.agencyId)) continue;
      if (!topSectors.has(f.sector)) continue;
      vendorTotals.set(f.vendorId, (vendorTotals.get(f.vendorId) ?? 0) + f.amountCents);
    }
    const topVendors = new Set(
      [...vendorTotals.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, cap)
        .map(([id]) => id),
    );

    const useFlows = filtered.filter(
      (f) => topAgencies.has(f.agencyId) && topSectors.has(f.sector) && topVendors.has(f.vendorId),
    );

    if (useFlows.length === 0) return null;

    // Build node + link sets per requested tier depth.
    const nodes = new Map<string, SNode>();
    const linkBuckets = new Map<string, SLink>();

    function ensureNode(id: string, label: string, tier: Tier) {
      if (!nodes.has(id)) nodes.set(id, { id, label, tier });
    }

    function addLink(srcId: string, tgtId: string, valueCents: number) {
      const key = `${srcId}→${tgtId}`;
      const existing = linkBuckets.get(key);
      if (existing) {
        existing.value += valueCents;
      } else {
        linkBuckets.set(key, { source: srcId, target: tgtId, value: valueCents });
      }
    }

    if (levels >= 2) {
      ensureNode(ROOT_NODE_ID, "Federal", "root");
    }

    for (const f of useFlows) {
      const agencyNodeId = `agency:${f.agencyId}`;
      const sectorNodeId = `sector:${f.sector}`;
      const vendorNodeId = `vendor:${f.vendorId}`;

      // Treasury → Agency
      ensureNode(agencyNodeId, f.agencyAcronym, "agency");
      if (levels >= 2) addLink(ROOT_NODE_ID, agencyNodeId, f.amountCents);

      if (levels >= 3) {
        ensureNode(sectorNodeId, f.sector, "sector");
        addLink(agencyNodeId, sectorNodeId, f.amountCents);
      }

      if (levels >= 4) {
        ensureNode(vendorNodeId, f.vendorName, "vendor");
        addLink(sectorNodeId, vendorNodeId, f.amountCents);
      }
    }

    return {
      nodes: [...nodes.values()],
      links: [...linkBuckets.values()],
    };
  }, [data, levels, minFlowUsd, topN]);

  // ── Render ──────────────────────────────────────────────────────────────────
  const render = useCallback(() => {
    const container = containerRef.current;
    const svg = svgRef.current;
    if (!container || !svg || !graph) return;

    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width === 0 || height === 0) return;

    d3.select(svg).selectAll("*").remove();
    d3.select(svg).attr("width", width).attr("height", height);

    // SVG presentation attributes can't carry var() — resolve tokens to
    // concrete colors against the svg's scope at draw time (FIX-729).
    const T = {
      viz4:      resolveToken("--c-viz-4", svg),
      viz5:      resolveToken("--c-viz-5", svg),
      viz7:      resolveToken("--c-viz-7", svg),
      termBg:    resolveToken("--c-term-bg", svg),
      termPanel: resolveToken("--c-term-panel", svg),
      ink:       resolveToken("--c-ink", svg),
    };

    const margin = { top: 24, right: 200, bottom: 24, left: 80 };

    const sankey = d3Sankey<SNode, SLink>()
      .nodeId((d) => d.id)
      .nodeAlign((node) => {
        // Horizontal alignment per tier so nodes line up cleanly even when
        // a tier is missing.
        const tierIdx: Record<Tier, number> = { root: 0, agency: 1, sector: 2, vendor: 3 };
        const idx = tierIdx[(node as SNode).tier];
        return Math.min(idx, levels - 1);
      })
      .nodeWidth(14)
      .nodePadding(10)
      .extent([
        [margin.left, margin.top],
        [width - margin.right, height - margin.bottom],
      ]);

    const layout = sankey({
      nodes: graph.nodes.map((n) => ({ ...n })),
      links: graph.links.map((l) => ({ ...l })),
    });

    const root = d3.select(svg).append("g");

    // ── Links ───────────────────────────────────────────────────────────────────
    const linkGen = sankeyLinkHorizontal<SNode, SLink>();

    root
      .append("g")
      .attr("fill", "none")
      .selectAll<SVGPathElement, SLink>("path")
      .data(layout.links)
      .join("path")
      .attr("d", linkGen)
      .attr("stroke", (d) => {
        // Colour by sector when a sector exists in the path; else neutral.
        const tgt = d.target as SNode;
        const src = d.source as SNode;
        if (tgt.tier === "sector") return resolveColor(sectorColor(tgt.label), svg);
        if (src.tier === "sector") return resolveColor(sectorColor(src.label), svg);
        return T.viz5;
      })
      .attr("stroke-opacity", 0.45)
      .attr("stroke-width", (d) => Math.max(1, d.width ?? 1))
      .append("title")
      .text((d) => {
        const src = d.source as SNode;
        const tgt = d.target as SNode;
        return `${src.label} → ${tgt.label}\n${fmtMoney(d.value)}`;
      });

    // ── Nodes ───────────────────────────────────────────────────────────────────
    const nodeG = root
      .append("g")
      .selectAll<SVGGElement, SNode>("g.node")
      .data(layout.nodes)
      .join("g")
      .attr("class", "node");

    nodeG
      .append("rect")
      .attr("x", (d) => d.x0 ?? 0)
      .attr("y", (d) => d.y0 ?? 0)
      .attr("width", (d) => (d.x1 ?? 0) - (d.x0 ?? 0))
      .attr("height", (d) => Math.max(1, (d.y1 ?? 0) - (d.y0 ?? 0)))
      .attr("fill", (d) => {
        if (d.tier === "root") return T.viz7; // was purple → wine
        if (d.tier === "sector") return resolveColor(sectorColor(d.label), svg);
        if (d.tier === "agency") return T.viz4;
        return T.termPanel; // vendor — neutral well
      })
      .attr("stroke", T.termBg)
      .attr("stroke-width", 1)
      .style("cursor", "pointer")
      .append("title")
      .text((d) => `${d.label}\n${fmtMoney(d.value ?? 0)}`);

    if (showLabels) {
      nodeG
        .append("text")
        .attr("x", (d) => {
          const x0 = d.x0 ?? 0;
          const x1 = d.x1 ?? 0;
          // Right of the rectangle for the last column, left for everything else.
          if (d.tier === "vendor" || (levels === 3 && d.tier === "sector") || (levels === 2 && d.tier === "agency")) {
            return x1 + 6;
          }
          return x0 - 6;
        })
        .attr("y", (d) => ((d.y0 ?? 0) + (d.y1 ?? 0)) / 2)
        .attr("dominant-baseline", "central")
        .attr("text-anchor", (d) => {
          if (d.tier === "vendor" || (levels === 3 && d.tier === "sector") || (levels === 2 && d.tier === "agency")) {
            return "start";
          }
          return "end";
        })
        .attr("font-size", (d) => (d.tier === "root" ? 13 : 11))
        .attr("font-family", "system-ui, sans-serif")
        .attr("fill", T.ink)
        .text((d) => {
          const max = d.tier === "vendor" ? 28 : 22;
          if (d.label.length > max) return d.label.slice(0, max - 1) + "…";
          return d.label;
        });
    }
  }, [graph, levels, showLabels, svgRef]);

  // Re-render on data + on resize
  useEffect(() => {
    render();
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(render);
    ro.observe(container);
    return () => ro.disconnect();
  }, [render]);

  // ── States ──────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className={`flex items-center justify-center ${className}`}>
        <div className="text-center">
          <div className="w-8 h-8 rounded-full border-2 border-accent border-t-transparent animate-spin mx-auto mb-3" />
          <p className="text-ink-soft text-sm">Loading contract flows…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`flex items-center justify-center ${className}`}>
        <p className="text-accent text-sm">Failed to load Sankey: {error}</p>
      </div>
    );
  }

  if (!graph) {
    return (
      <div className={`flex items-center justify-center ${className}`}>
        <p className="text-ink-soft text-sm">No contract flows match the current filters.</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className={`relative overflow-hidden flex flex-col ${className}`}>
      <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
        <span className="text-xs text-ink-soft bg-term-bg/70 px-2 py-0.5 rounded-full">
          {/* FIX-857 — pill reflects the scope: the focused agency's spending, or
              platform-wide (all agencies) when nothing is focused. */}
          <span className="text-ink font-medium">
            {agencyId ? `${agencyName ?? "Agency"} spending` : "All federal spending"}
          </span>
          {data && data.totalCents > 0 && (
            <>
              <span className="ml-1 text-green-ink font-medium">{fmtMoney(data.totalCents)}</span>
              <span className="ml-1">in {data.scannedRows.toLocaleString()} contracts</span>
            </>
          )}
        </span>
      </div>

      <svg id="sankey-svg" ref={svgRef} className="w-full flex-1" />
    </div>
  );
}
