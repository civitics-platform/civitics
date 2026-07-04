"use client";

import * as d3 from "d3";
import React, { useEffect, useRef, useState, useCallback } from "react";
import type { RefObject } from "react";
import type { GraphNode as NewGraphNode, NodeActions, SunburstOptions, FocusGroup } from "./types";
import { Tooltip, useTooltip } from "./components/Tooltip";
import { NodePopup } from "./components/NodePopup";
import { resolveColor, resolveToken, withAlpha } from "./tokens";

interface SunburstNode {
  name: string;
  value?: number;
  children?: SunburstNode[];
  type?: string;
  entityId?: string;
  entityType?: string;
  color?: string;
  // group / individual meta (top-level only)
  isGroup?: boolean;
  party?: string;
}

export interface SunburstGraphProps {
  entityId?: string | null;
  entityLabel?: string;
  className?: string;
  svgRef?: RefObject<SVGSVGElement>;
  vizOptions?: Partial<SunburstOptions>;
  primaryGroup?: FocusGroup | null;
  /** Convenience alias for vizOptions.badgeSize */
  badgeSize?: 'full' | 'large' | 'medium' | 'small' | 'tiny';
}

// FIX-729 — one token hue per connection type; the bright/dark/glow triple is
// derived from the resolved hue at render time (brighter/darker), replacing
// the legacy per-type hex triples. All 11 types keep distinct hues.
const TYPE_HUE: Record<string, string> = {
  vote_yes:            "rgb(var(--c-green-ink))",
  vote_no:             "rgb(var(--c-accent))",
  donation:            "rgb(var(--c-amber))",
  oversight:           "rgb(var(--c-viz-7))", // was purple — wine; no purple in the token system
  nomination_vote_yes: "rgb(var(--c-viz-8))", // olive — distinct from vote_yes green
  nomination_vote_no:  "rgb(var(--c-viz-9))", // bronze — distinct from vote_no red
  appointment:         "rgb(var(--c-viz-4))", // was violet — civic blue
  revolving_door:      "rgb(var(--c-viz-6))", // terracotta
  lobbying:            "rgb(var(--c-viz-3))", // ochre-gold — distinct from donation amber
  co_sponsorship:      "rgb(var(--c-viz-2))", // teal
  other:               "rgb(var(--c-viz-5))", // steel-slate
};

type D3HierarchyNode = d3.HierarchyRectangularNode<SunburstNode>;

/** Map a sunburst node to NewGraphNode for popup (if it has an entityId) */
function arcToNode(d: D3HierarchyNode): NewGraphNode | null {
  const data = d.data;
  if (!data.entityId) return null;

  const type: NewGraphNode["type"] =
    data.entityType === "official" ? "official" :
    data.entityType === "proposal" ? "proposal" :
    data.entityType === "agency"   ? "agency"   : "organization";

  return {
    id:            data.entityId,
    name:          data.name,
    type,
    donationTotal: data.value && data.type === "donation" ? data.value : undefined,
  };
}

/** Always produce a tooltip node for any arc */
function arcToTooltipNode(d: D3HierarchyNode): NewGraphNode {
  return {
    id:            d.data.entityId ?? d.data.name,
    name:          d.data.name,
    type:          d.data.entityType === "official" ? "official"
                 : d.data.entityType === "proposal" ? "proposal"
                 : "organization",
    donationTotal: d.data.value && d.data.type === "donation" ? d.data.value : undefined,
  };
}

export function SunburstGraph({ entityId, entityLabel, className = "", svgRef: externalSvgRef, vizOptions, primaryGroup, badgeSize: badgeSizeProp }: SunburstGraphProps) {
  const containerRef   = useRef<HTMLDivElement>(null);
  const internalSvgRef = useRef<SVGSVGElement>(null);
  const svgRef         = externalSvgRef ?? internalSvgRef;

  const [status, setStatus] = useState<"idle" | "loading" | "empty" | "error" | "ok">("idle");
  const [breadcrumbs, setBreadcrumbs] = useState<string[]>([]);
  const [centerMeta, setCenterMeta] = useState<{ isGroup: boolean; party?: string; icon?: string }>({ isGroup: false });
  const rootRef        = useRef<D3HierarchyNode | null>(null);
  const currentRootRef = useRef<D3HierarchyNode | null>(null);

  const { tooltip, show: showTip, hide: hideTip } = useTooltip();
  const [popup, setPopup] = useState<NewGraphNode | null>(null);
  const cacheRef      = useRef<Map<string, SunburstNode>>(new Map());
  const lastSizeRef   = useRef({ w: 0, h: 0 });

  const nodeActions: NodeActions = {
    recenter:        () => {},
    openProfile:     (nodeId) => window.open(`/officials/${nodeId}`, "_blank"),
    addToComparison: () => {},
    expandNode:      () => {},
  };

  const renderRef = useRef<((root: D3HierarchyNode, width: number, height: number, opts?: { shape?: string; skipLabels?: boolean }) => void) | null>(null);
  const arcRef = useRef<d3.Arc<unknown, D3HierarchyNode> | null>(null);

  const centerMetaRef = useRef<{ isGroup: boolean; party?: string; icon?: string }>({ isGroup: false });
  const vizOptionsRef = useRef<Partial<SunburstOptions>>({});
  vizOptionsRef.current = { ...vizOptions, ...(badgeSizeProp !== undefined ? { badgeSize: badgeSizeProp } : {}) };

  const render = useCallback((root: D3HierarchyNode, width: number, height: number, opts?: { shape?: string; skipLabels?: boolean }) => {
    const svg = svgRef.current;
    if (!svg) return;

    d3.select(svg).selectAll("*").remove();

    // Badge mode options (opts take precedence; fall back to vizOptionsRef for badge-only options)
    const vizOpts    = vizOptionsRef.current;
    const shape      = opts?.shape ?? vizOpts?.shape ?? 'circle';
    const badgeSize  = vizOpts?.badgeSize;
    const isTiny     = badgeSize === 'tiny';
    const isMini     = badgeSize === 'small' || badgeSize === 'tiny';
    const showLabels = vizOpts?.showLabels ?? 'auto';
    const skipLabels = opts?.skipLabels ?? (isMini || showLabels === 'never');

    const radius   = Math.min(width, height) / 2;
    const innerPad = radius * 0.22;   // center gap
    const outerR   = radius * 0.78;   // partition space — arcs end at radius after offset

    // Pre-compute display values needed before early returns
    const displayName = root.data.name ?? "";
    const initials    = displayName
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((w: string) => w[0] ?? "")
      .join("")
      .toUpperCase() || "?";

    // FIX-729 — resolve design tokens against the svg's scope at render time;
    // d3 .attr()/gradient stops need concrete colors, not var().
    const T = {
      bg:      resolveToken("--c-term-bg", svg),
      panel:   resolveToken("--c-term-panel", svg),
      ink:     resolveToken("--c-ink", svg),
      inkSoft: resolveToken("--c-ink-soft", svg),
      faint:   resolveToken("--c-term-faint", svg),
      amber:   resolveToken("--c-amber", svg),
      blue:    resolveToken("--c-blue", svg),
      accent:  resolveToken("--c-accent", svg),
    };
    // Per-type bright/dark/glow shades derived from the single token hue.
    const TYPE_PALETTE: Record<string, { bright: string; dark: string; glow: string }> =
      Object.fromEntries(
        Object.entries(TYPE_HUE).map(([type, hue]): [string, { bright: string; dark: string; glow: string }] => {
          const c = d3.color(resolveColor(hue, svg)) ?? d3.rgb(0, 0, 0);
          return [type, {
            bright: c.brighter(0.7).formatRgb(),
            dark:   c.darker(2).formatRgb(),
            glow:   c.formatRgb(),
          }];
        }),
      );
    const getPalette = (typeName: string) => {
      const key = typeName.toLowerCase().replace(/ /g, "_");
      return TYPE_PALETTE[key] ?? TYPE_PALETTE.other!;
    };

    // ── Dark background ──────────────────────────────────────────────────────
    const svgSel = d3.select(svg)
      .attr("width", width)
      .attr("height", height)
      .style("background", T.bg);

    // ── Defs ─────────────────────────────────────────────────────────────────
    const defs = svgSel.append("defs");

    // Radial gradient per type (coordinates in g-space where center = 0,0)
    Object.entries(TYPE_PALETTE).forEach(([type, palette]) => {
      const grad = defs.append("radialGradient")
        .attr("id", `grad-${type}`)
        .attr("cx", "0")
        .attr("cy", "0")
        .attr("r", radius)
        .attr("gradientUnits", "userSpaceOnUse");

      grad.append("stop")
        .attr("offset", "0%")
        .attr("stop-color", palette.bright)
        .attr("stop-opacity", 0.95);

      grad.append("stop")
        .attr("offset", "100%")
        .attr("stop-color", palette.dark)
        .attr("stop-opacity", 0.85);
    });

    // Center glow gradient — color reflects party or group. The neutral/group
    // center (formerly indigo) uses the terminal's amber brand highlight.
    const meta = centerMetaRef.current;
    const centerColor = meta.isGroup
      ? T.amber
      : meta.party === "democrat"
      ? T.blue
      : meta.party === "republican"
      ? T.accent
      : T.amber;
    const centerColorDark =
      (d3.color(centerColor) ?? d3.rgb(0, 0, 0)).darker(2).formatRgb();

    const centerGrad = defs.append("radialGradient")
      .attr("id", "center-glow")
      .attr("cx", "0")
      .attr("cy", "0")
      .attr("r", innerPad)
      .attr("gradientUnits", "userSpaceOnUse");

    centerGrad.append("stop")
      .attr("offset", "0%")
      .attr("stop-color", centerColor)
      .attr("stop-opacity", 0.9);

    centerGrad.append("stop")
      .attr("offset", "100%")
      .attr("stop-color", centerColorDark)
      .attr("stop-opacity", 1);

    // Background radial gradient
    const bgGrad = defs.append("radialGradient")
      .attr("id", "bg-grad")
      .attr("cx", "0")
      .attr("cy", "0")
      .attr("r", radius * 1.2)
      .attr("gradientUnits", "userSpaceOnUse");

    bgGrad.append("stop").attr("offset", "0%").attr("stop-color", T.panel);
    bgGrad.append("stop").attr("offset", "100%").attr("stop-color", T.bg);

    // Glow blur filter
    const filter = defs.append("filter")
      .attr("id", "glow")
      .attr("x", "-50%")
      .attr("y", "-50%")
      .attr("width", "200%")
      .attr("height", "200%");

    filter.append("feGaussianBlur")
      .attr("stdDeviation", "3")
      .attr("result", "coloredBlur");

    const feMerge = filter.append("feMerge");
    feMerge.append("feMergeNode").attr("in", "coloredBlur");
    feMerge.append("feMergeNode").attr("in", "SourceGraphic");

    // ── Octagon clip-path ────────────────────────────────────────────────────
    if (shape === 'octagon') {
      const clipId = 'octagon-clip';
      const cx = width / 2;
      const cy = height / 2;
      const r  = Math.min(width, height) / 2 * 0.92;
      const points = Array.from({ length: 8 }, (_, i) => {
        const angle = (i * Math.PI / 4) - Math.PI / 8;
        return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)].join(',');
      }).join(' ');
      defs.append('clipPath')
        .attr('id', clipId)
        .append('polygon')
        .attr('points', points);
      svgSel.attr('clip-path', `url(#${clipId})`);
    } else {
      svgSel.attr('clip-path', null);
    }

    // ── Main group (centered) ────────────────────────────────────────────────
    const g = svgSel
      .append("g")
      .attr("transform", `translate(${width / 2},${height / 2})`);

    // Background circle (subtle inner glow)
    g.append("circle")
      .attr("r", radius * 1.05)
      .attr("fill", "url(#bg-grad)");

    // ── Tiny badge: just party-colored circle with initials ──────────────────
    if (isTiny) {
      g.append("circle")
        .attr("r", radius * 0.8)
        .attr("fill", centerColor)
        .attr("fill-opacity", 0.9);
      g.append("text")
        .attr("text-anchor", "middle")
        .attr("dominant-baseline", "central")
        .attr("fill", T.ink)
        .attr("font-size", radius * 0.5 + "px")
        .attr("font-weight", "700")
        .style("pointer-events", "none")
        .text(initials);
      return;
    }

    // ── Partition ────────────────────────────────────────────────────────────
    const partition = d3.partition<SunburstNode>().size([2 * Math.PI, outerR]);
    partition(root);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const arc = d3.arc<D3HierarchyNode>()
      .startAngle((d) => d.x0)
      .endAngle((d) => d.x1)
      .padAngle((d) => Math.min((d.x1 - d.x0) / 2, 0.008))
      .padRadius(radius / 3)
      .innerRadius((d) => d.depth === 0 ? 0 : d.y0 + innerPad)
      .outerRadius((d) => d.depth === 0 ? 0 : d.y1 + innerPad - 2) as any; // eslint-disable-line @typescript-eslint/no-explicit-any

    arcRef.current = arc;

    // ── Arc paths ────────────────────────────────────────────────────────────
    g.selectAll<SVGPathElement, D3HierarchyNode>(".sunburst-arc")
      .data(root.descendants().slice(1))
      .join("path")
      .attr("class", "sunburst-arc")
      .attr("fill", (d) => {
        let ancestor = d;
        while (ancestor.depth > 1) ancestor = ancestor.parent!;
        const typeName = (ancestor.data.type ?? ancestor.data.name ?? "other")
          .toLowerCase().replace(/ /g, "_");
        if (d.depth === 1) return `url(#grad-${typeName})`;
        return withAlpha(getPalette(typeName).dark, 0.8, svg); // was hex + "cc"
      })
      .attr("fill-opacity", (d) =>
        d.x1 - d.x0 > 0.001 ? (d.depth === 1 ? 1.0 : 0.75) : 0)
      .attr("stroke", (d) => {
        let ancestor = d;
        while (ancestor.depth > 1) ancestor = ancestor.parent!;
        const typeName = ancestor.data.type ?? "other";
        return getPalette(typeName).glow;
      })
      .attr("stroke-width", (d) => d.depth === 1 ? 0.5 : 0.3)
      .attr("stroke-opacity", 0.4)
      .attr("d", arc)
      .style("cursor", (d) => (d.children || d.data.entityId ? "pointer" : "default"))
      .on("mouseover", (event: MouseEvent, d) => {
        if (containerRef.current) {
          const angle = (d.x0 + d.x1) / 2 - Math.PI / 2;
          const r     = (d.y0 + d.y1) / 2 + innerPad;
          const x     = width  / 2 + r * Math.cos(angle);
          const y     = height / 2 + r * Math.sin(angle);
          showTip(arcToTooltipNode(d), x, y);
        }
        // Highlight hovered arc
        d3.select(event.currentTarget as Element)
          .attr("fill-opacity", 1.0)
          .attr("stroke-opacity", 0.9)
          .attr("filter", "url(#glow)");
        // Dim others
        g.selectAll<SVGPathElement, D3HierarchyNode>(".sunburst-arc")
          .filter(function(this: SVGPathElement) { return this !== event.currentTarget; })
          .attr("fill-opacity", 0.3);
        // Show drill hint for hovered arc with children
        if (d.children) {
          g.selectAll<SVGTextElement, D3HierarchyNode>(".drill-hint")
            .filter((h) => h === d)
            .attr("opacity", 1);
        }
      })
      .on("mouseout", () => {
        hideTip();
        g.selectAll<SVGPathElement, D3HierarchyNode>(".sunburst-arc")
          .attr("fill-opacity", (d) =>
            d.x1 - d.x0 > 0.001 ? (d.depth === 1 ? 1.0 : 0.75) : 0)
          .attr("stroke-opacity", 0.4)
          .attr("filter", null);
        // Hide all drill hints
        g.selectAll(".drill-hint").attr("opacity", 0);
      })
      .on("click", (_event: MouseEvent, d) => {
        const newNode = arcToNode(d);
        if (newNode) {
          setPopup(newNode);
          return;
        }
        if (d.children) zoom(d, width, height);
      });

    // ── Curved arc labels (ring 1 only, wide arcs) ───────────────────────────
    if (!skipLabels) {
      const labelData = root.descendants().filter((d) => d.depth === 1 && (d.x1 - d.x0) > 0.3);

      g.selectAll<SVGPathElement, D3HierarchyNode>(".arc-label-path")
        .data(labelData)
        .join("path")
        .attr("class", "arc-label-path")
        .attr("id", (_, i) => `arc-path-${i}`)
        .attr("fill", "none")
        .attr("d", (d) => {
          const midR       = (d.y0 + d.y1) / 2 + innerPad;
          const startAngle = d.x0 - Math.PI / 2;
          const endAngle   = d.x1 - Math.PI / 2;
          const midAngle   = (d.x0 + d.x1) / 2 - Math.PI / 2;
          const isBottom   = midAngle > 0;

          const x1 = midR * Math.cos(startAngle);
          const y1 = midR * Math.sin(startAngle);
          const x2 = midR * Math.cos(endAngle);
          const y2 = midR * Math.sin(endAngle);
          const lg = d.x1 - d.x0 > Math.PI ? 1 : 0;

          return isBottom
            ? `M ${x2} ${y2} A ${midR} ${midR} 0 ${lg} 0 ${x1} ${y1}`
            : `M ${x1} ${y1} A ${midR} ${midR} 0 ${lg} 1 ${x2} ${y2}`;
        });

      g.selectAll<SVGTextElement, D3HierarchyNode>(".arc-label")
        .data(labelData)
        .join("text")
        .attr("class", "arc-label")
        .attr("dy", "-3px")
        .style("pointer-events", "none")
        .style("user-select", "none")
        .append("textPath")
        .attr("href", (_, i) => `#arc-path-${i}`)
        .attr("startOffset", "50%")
        .attr("text-anchor", "middle")
        .attr("fill", T.ink)
        .attr("font-size", (d) => {
          const arcWidth = d.y1 - d.y0;
          return Math.min(arcWidth * 0.35, 11) + "px";
        })
        .attr("font-weight", "500")
        .style("text-shadow", "0 1px 2px rgba(0,0,0,0.8)")
        .text((d) => {
          const name    = d.data.name;
          const arcSpan = (d.x1 - d.x0) * ((d.y0 + d.y1) / 2 + innerPad);
          const max     = Math.floor(arcSpan / 7);
          return name.length > max ? name.slice(0, max - 1) + "…" : name;
        });
    }

    // ── Drill-down hint chevrons (visible on hover for arcs with children) ──
    if (!isMini) {
      g.selectAll<SVGTextElement, D3HierarchyNode>(".drill-hint")
        .data(root.descendants().filter((d) => d.depth >= 1 && !!d.children && (d.x1 - d.x0) > 0.4))
        .join("text")
        .attr("class", "drill-hint")
        .attr("text-anchor", "middle")
        .attr("dominant-baseline", "central")
        .attr("x", (d) => {
          const angle = (d.x0 + d.x1) / 2 - Math.PI / 2;
          const r     = d.y1 + innerPad - 8;
          return r * Math.cos(angle);
        })
        .attr("y", (d) => {
          const angle = (d.x0 + d.x1) / 2 - Math.PI / 2;
          const r     = d.y1 + innerPad - 8;
          return r * Math.sin(angle);
        })
        .attr("font-size", "8px")
        .attr("fill", T.inkSoft)
        .attr("opacity", 0)
        .style("pointer-events", "none")
        .style("user-select", "none")
        .text("›");
    }

    // ── Glowing center circle ────────────────────────────────────────────────
    const centerRadius = innerPad;

    // Outer glow ring
    g.append("circle")
      .attr("r", centerRadius + 3)
      .attr("fill", "none")
      .attr("stroke", centerColor)
      .attr("stroke-width", 1.5)
      .attr("stroke-opacity", 0.6)
      .attr("filter", "url(#glow)");

    // Center fill
    g.append("circle")
      .attr("r", centerRadius)
      .attr("fill", "url(#center-glow)")
      .attr("stroke", centerColor)
      .attr("stroke-width", 1)
      .attr("stroke-opacity", 0.8);

    // Center label
    if (meta.isGroup && meta.icon) {
      // Group: show icon emoji + truncated name below
      g.append("text")
        .attr("text-anchor", "middle")
        .attr("dominant-baseline", "central")
        .attr("dy", `-${centerRadius * 0.15}px`)
        .attr("font-size", Math.max(centerRadius * 0.6, 18) + "px")
        .style("pointer-events", "none")
        .style("user-select", "none")
        .text(meta.icon);

      g.append("text")
        .attr("text-anchor", "middle")
        .attr("dy", `${centerRadius * 0.55}px`)
        .attr("fill", T.inkSoft)
        .attr("font-size", Math.max(centerRadius * 0.2, 9) + "px")
        .style("pointer-events", "none")
        .style("user-select", "none")
        .text(displayName.length > 14 ? displayName.slice(0, 12) + "…" : displayName);
    } else {
      const showInitials = displayName.length > 16;

      if (showInitials) {
        g.append("text")
          .attr("text-anchor", "middle")
          .attr("dy", "-0.1em")
          .attr("fill", T.ink)
          .attr("font-size", Math.max(centerRadius * 0.5, 14) + "px")
          .attr("font-weight", "700")
          .attr("letter-spacing", "0.05em")
          .style("pointer-events", "none")
          .style("user-select", "none")
          .text(initials);

        g.append("text")
          .attr("text-anchor", "middle")
          .attr("dy", "1.2em")
          .attr("fill", T.inkSoft)
          .attr("font-size", Math.max(centerRadius * 0.2, 9) + "px")
          .style("pointer-events", "none")
          .style("user-select", "none")
          .text(displayName.length > 20 ? displayName.slice(0, 18) + "…" : displayName);
      } else {
        g.append("text")
          .attr("text-anchor", "middle")
          .attr("dy", "0.35em")
          .attr("fill", T.ink)
          .attr("font-size", Math.max(centerRadius * 0.3, 11) + "px")
          .attr("font-weight", "600")
          .style("pointer-events", "none")
          .style("user-select", "none")
          .text(displayName);
      }
    }

    // Transparent click overlay for zoom-out
    g.append("circle")
      .attr("r", centerRadius)
      .attr("fill", "transparent")
      .style("cursor", currentRootRef.current !== rootRef.current ? "zoom-out" : "default")
      .on("click", () => {
        if (rootRef.current && currentRootRef.current !== rootRef.current) {
          zoom(rootRef.current, width, height);
        }
      });

    // "↑ back" hint in center when drilled in
    if (currentRootRef.current !== rootRef.current) {
      g.append("text")
        .attr("text-anchor", "middle")
        .attr("dy", centerRadius * 0.35 + "px")
        .attr("fill", T.faint)
        .attr("font-size", "8px")
        .style("pointer-events", "none")
        .style("user-select", "none")
        .text("↑ back");
    }

    // ── Octagon border ring ──────────────────────────────────────────────────
    if (shape === 'octagon') {
      const borderR = Math.min(width, height) / 2 * 0.92 - 1;
      g.append('polygon')
        .attr('points', Array.from({ length: 8 }, (_, i) => {
          const angle = (i * Math.PI / 4) - Math.PI / 8;
          return [borderR * Math.cos(angle), borderR * Math.sin(angle)].join(',');
        }).join(' '))
        .attr('fill', 'none')
        .attr('stroke', T.amber) // was indigo — amber is the terminal brand highlight
        .attr('stroke-width', 2)
        .attr('stroke-opacity', 0.6)
        .attr('filter', 'url(#glow)');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svgRef, showTip, hideTip]);

  // Keep renderRef current so effects can call the latest render without adding it to deps
  useEffect(() => { renderRef.current = render; });

  function zoom(node: D3HierarchyNode, width: number, height: number) {
    currentRootRef.current = node;

    // Update breadcrumbs
    const crumbs: string[] = [];
    let cur: D3HierarchyNode | null = node;
    while (cur) { crumbs.unshift(cur.data.name); cur = cur.parent ?? null; }
    setBreadcrumbs(crumbs);

    // Build opts from current vizOptionsRef so zoom always uses the latest visual settings
    const zoomVizOpts = vizOptionsRef.current;
    const zoomShape   = zoomVizOpts?.shape ?? 'circle';
    const zoomShowLabels = zoomVizOpts?.showLabels ?? 'auto';
    const zoomSkipLabels = zoomShowLabels === 'never';
    const zoomOpts = { shape: zoomShape, skipLabels: zoomSkipLabels };

    // If SVG not ready, fall back to instant render
    const svg = svgRef.current;
    if (!svg || !arcRef.current) {
      render(node, width, height, zoomOpts);
      return;
    }

    // Animate existing arcs out, then render new view and animate in
    d3.select(svg)
      .selectAll("path")
      .transition()
      .duration(250)
      .ease(d3.easeCubicOut)
      .attr("fill-opacity", 0)
      .attr("stroke-opacity", 0)
      .end()
      .then(() => {
        render(node, width, height, zoomOpts);
        d3.select(svg)
          .selectAll<SVGPathElement, D3HierarchyNode>("path")
          .attr("fill-opacity", 0)
          .attr("stroke-opacity", 0)
          .transition()
          .duration(300)
          .ease(d3.easeCubicIn)
          .attr("fill-opacity", (d) =>
            d.x1 - d.x0 > 0.001 ? (d.depth === 1 ? 1.0 : 0.75) : 0)
          .attr("stroke-opacity", 0.4);
      })
      .catch(() => {
        // Fallback if transition is interrupted
        render(node, width, height, zoomOpts);
      });
  }

  const defaultRing1 = primaryGroup?.filter.entity_type === "pac"
    ? "donation_industries"
    : "connection_types";
  const ring1    = vizOptions?.ring1    ?? defaultRing1;
  const ring2    = vizOptions?.ring2    ?? 'top_entities';
  const maxRing1 = vizOptions?.maxRing1 ?? 8;
  const maxRing2 = vizOptions?.maxRing2 ?? 10;

  // Derived visual opts — used by render and by the shape/label change effects
  const shape         = vizOptions?.shape      ?? 'circle';
  const showLabelsOpt = vizOptions?.showLabels ?? 'auto';
  const skipLabels    = showLabelsOpt === 'never';

  useEffect(() => {
    if (!entityId && !primaryGroup) {
      if (!rootRef.current) { setStatus("idle"); }
      return;
    }

    const controller = new AbortController();

    async function load() {
      const cacheKey = primaryGroup
        ? `group:${primaryGroup.id}:${ring1}:${ring2}:${maxRing1}:${maxRing2}`
        : `${entityId!}:${ring1}:${ring2}:${maxRing1}:${maxRing2}`;

      // Show loading briefly when ring1 changes to avoid stale flash
      if (status === "ok") { setStatus("loading"); }

      // Serve from cache if available
      const cached = cacheRef.current.get(cacheKey);
      if (cached) {
        const container = containerRef.current;
        if (!container) return;
        const { width, height } = container.getBoundingClientRect();
        const w = width  || 600;
        const h = height || 500;
        const root = d3.hierarchy<SunburstNode>(cached).sum((d) => d.value ?? 0);
        const partitioned = d3.partition<SunburstNode>().size([2 * Math.PI, Math.min(w, h) / 2])(root) as D3HierarchyNode;
        rootRef.current        = partitioned;
        currentRootRef.current = partitioned;
        setBreadcrumbs([cached.name]);
        centerMetaRef.current = {
          isGroup: cached.isGroup ?? false,
          party: cached.party,
          icon: primaryGroup?.icon,
        };
        setCenterMeta(centerMetaRef.current);
        setStatus("ok");
        renderRef.current?.(partitioned, w, h, { shape, skipLabels });
        return;
      }

      setStatus("loading");
      try {
        let url: string;
        if (primaryGroup) {
          url = `/api/graph/sunburst` +
            `?groupId=${encodeURIComponent(primaryGroup.id)}` +
            `&groupFilter=${encodeURIComponent(JSON.stringify(primaryGroup.filter))}` +
            `&groupName=${encodeURIComponent(primaryGroup.name)}` +
            `&ring1=${ring1}&ring2=${ring2}&maxRing1=${maxRing1}&maxRing2=${maxRing2}`;
        } else {
          url = `/api/graph/sunburst` +
            `?entityId=${encodeURIComponent(entityId!)}` +
            (entityLabel ? `&entityLabel=${encodeURIComponent(entityLabel)}` : "") +
            `&ring1=${ring1}&ring2=${ring2}&maxRing1=${maxRing1}&maxRing2=${maxRing2}`;
        }

        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json() as SunburstNode & { error?: string };

        if (json.error) throw new Error(json.error);
        if (!json.children || json.children.length === 0) { setStatus("empty"); return; }

        cacheRef.current.set(cacheKey, json);

        const container = containerRef.current;
        if (!container) return;
        const { width, height } = container.getBoundingClientRect();
        const w = width  || 600;
        const h = height || 500;

        const root = d3.hierarchy<SunburstNode>(json).sum((d) => d.value ?? 0);
        const partitioned = d3.partition<SunburstNode>().size([2 * Math.PI, Math.min(w, h) / 2])(root) as D3HierarchyNode;

        rootRef.current        = partitioned;
        currentRootRef.current = partitioned;
        setBreadcrumbs([json.name]);
        centerMetaRef.current = {
          isGroup: json.isGroup ?? false,
          party: json.party,
          icon: primaryGroup?.icon,
        };
        setCenterMeta(centerMetaRef.current);
        setStatus("ok");
        renderRef.current?.(partitioned, w, h, { shape, skipLabels });
      } catch (err) {
        if ((err as Error).name !== "AbortError") setStatus("error");
      }
    }

    void load();
    return () => { controller.abort(); };
  // render is intentionally excluded — renderRef.current always holds the latest version
  // primaryGroup?.id used (not full object) to avoid re-firing when reference changes but ID doesn't
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId, primaryGroup?.id, primaryGroup?.filter.entity_type, ring1, ring2, maxRing1, maxRing2]);

  useEffect(() => {
    if (status !== "ok") return;
    const container = containerRef.current;
    if (!container) return;

    const obs = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || !currentRootRef.current) return;
      const w = Math.floor(entry.contentRect.width);
      const h = Math.floor(entry.contentRect.height);
      if (w === lastSizeRef.current.w && h === lastSizeRef.current.h) return;
      lastSizeRef.current = { w, h };
      renderRef.current?.(currentRootRef.current, w, h, { shape, skipLabels });
    });

    obs.observe(container);
    return () => obs.disconnect();
  // shape and showLabelsOpt in deps so the ResizeObserver closure always captures current visual opts
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, shape, showLabelsOpt]);

  // Re-render immediately when shape or label visibility changes (no refetch needed).
  // Uses showLabelsOpt (full string) not skipLabels (boolean) so all three transitions fire:
  // 'auto'→'always', 'always'→'never', 'never'→'auto', etc.
  // render reads vizOptionsRef.current which is updated synchronously at render time.
  useEffect(() => {
    if (status !== "ok") return;
    if (!currentRootRef.current) return;
    const container = containerRef.current;
    if (!container) return;
    const { width, height } = container.getBoundingClientRect();
    renderRef.current?.(currentRootRef.current, width || 600, height || 500, { shape, skipLabels });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, showLabelsOpt, status]);

  return (
    <div ref={containerRef} className={`relative w-full h-full flex flex-col ${className}`}>
      {/* Breadcrumb trail — only shown when drilled in */}
      {status === "ok" && breadcrumbs.length > 1 && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 bg-card/90 backdrop-blur-sm border border-rule/50 rounded-full px-3 py-1.5 shadow-lg">
          {/* Back button */}
          <button
            onClick={() => {
              if (!rootRef.current || !containerRef.current) return;
              const { width, height } = containerRef.current.getBoundingClientRect();
              zoom(rootRef.current, width || 600, height || 500);
            }}
            className="text-accent hover:text-accent/80 text-xs font-medium flex items-center gap-1 transition-colors mr-1"
          >
            ← Back
          </button>
          <span className="text-ink-soft text-xs">|</span>
          {breadcrumbs.map((crumb, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span className="text-ink-soft text-xs">›</span>}
              <span className={`text-xs transition-colors ${i === breadcrumbs.length - 1 ? "text-ink font-medium" : "text-ink-soft"}`}>
                {crumb.length > 16 ? crumb.slice(0, 14) + "…" : crumb}
              </span>
            </React.Fragment>
          ))}
        </div>
      )}

      {status === "idle" && (
        <div className="flex flex-col items-center justify-center flex-1">
          <div className="text-center max-w-sm px-8 py-10 rounded-2xl bg-card/80 border border-rule">
            <div className="w-10 h-10 mx-auto mb-4 rounded-full border border-rule flex items-center justify-center">
              <svg className="w-5 h-5 text-ink-soft" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707m12.728 0l-.707-.707M6.343 6.343l-.707-.707" />
              </svg>
            </div>
            <p className="text-ink text-sm font-medium">Select an official</p>
            <p className="text-ink-soft text-xs mt-2 leading-relaxed">
              Click any official node in the graph to see their full connection sunburst.
            </p>
          </div>
        </div>
      )}

      {status === "loading" && (
        <div className="flex flex-col items-center justify-center flex-1 gap-3">
          <div className="w-10 h-10 rounded-full border-2 border-accent border-t-transparent animate-spin" />
          <p className="text-ink-soft text-sm">Building network map…</p>
        </div>
      )}

      {status === "error" && (
        <div className="flex flex-col items-center justify-center flex-1 text-center">
          <p className="text-accent text-sm">Failed to load sunburst data.</p>
          <button onClick={() => setStatus("idle")} className="mt-3 text-xs text-accent hover:underline">
            Reset
          </button>
        </div>
      )}

      {status === "empty" && (
        <div className="flex flex-col items-center justify-center flex-1">
          <div className="text-center max-w-sm px-8 py-10 rounded-2xl bg-card/80 border border-rule">
            <p className="text-ink text-sm font-medium">
              No network data for {entityLabel ?? "this entity"}.
            </p>
          </div>
        </div>
      )}

      {status === "ok" && (
        <svg id="sunburst-svg" ref={svgRef} className="w-full flex-1" />
      )}

      {/* Shared tooltip */}
      <Tooltip
        node={tooltip.node}
        x={tooltip.x}
        y={tooltip.y}
        visible={tooltip.visible}
      />

      {/* Shared popup */}
      <NodePopup
        node={popup}
        onClose={() => setPopup(null)}
        actions={nodeActions}
        vizType="sunburst"
      />
    </div>
  );
}

// ── CivicBadge ───────────────────────────────────────────────────────────────

const BADGE_PX: Record<string, number> = {
  large:  200,
  medium: 128,
  small:  64,
  tiny:   32,
};

export function CivicBadge({
  entityId,
  entityLabel,
  size = 'medium',
  shape = 'circle',
}: {
  entityId?: string;
  entityLabel?: string;
  size?: 'large' | 'medium' | 'small' | 'tiny';
  party?: string;
  shape?: 'circle' | 'octagon';
}) {
  const px = BADGE_PX[size] ?? 128;
  return (
    <div
      style={{ width: px, height: px, flexShrink: 0 }}
      className={`overflow-hidden ${shape !== 'octagon' ? 'rounded-full' : ''}`}
    >
      <SunburstGraph
        entityId={entityId}
        entityLabel={entityLabel}
        vizOptions={{
          shape,
          badgeSize: size,
          showLabels: size === 'large' ? 'auto' : 'never',
        }}
      />
    </div>
  );
}
