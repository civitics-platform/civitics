"use client";

import * as d3 from "d3";
import React, { useEffect, useRef, useState, useCallback } from "react";
import type { RefObject } from "react";
import type { GraphNode as NewGraphNode, NodeActions, SunburstOptions, FocusGroup } from "./types";
import { Tooltip, useTooltip } from "./components/Tooltip";
import { NodePopup } from "./components/NodePopup";

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

const TYPE_PALETTE: Record<string, { bright: string; dark: string; glow: string }> = {
  vote_yes:            { bright: "#4ade80", dark: "#14532d", glow: "#22c55e" },
  vote_no:             { bright: "#f87171", dark: "#7f1d1d", glow: "#ef4444" },
  donation:            { bright: "#fbbf24", dark: "#78350f", glow: "#f59e0b" },
  oversight:           { bright: "#c084fc", dark: "#4a1d96", glow: "#a855f7" },
  nomination_vote_yes: { bright: "#34d399", dark: "#064e3b", glow: "#10b981" },
  nomination_vote_no:  { bright: "#fca5a5", dark: "#7f1d1d", glow: "#f87171" },
  appointment:         { bright: "#a78bfa", dark: "#2e1065", glow: "#8b5cf6" },
  revolving_door:      { bright: "#fb923c", dark: "#7c2d12", glow: "#f97316" },
  lobbying:            { bright: "#fde047", dark: "#713f12", glow: "#eab308" },
  co_sponsorship:      { bright: "#22d3ee", dark: "#164e63", glow: "#06b6d4" },
  other:               { bright: "#94a3b8", dark: "#1e293b", glow: "#64748b" },
};

function getPalette(typeName: string) {
  const key = typeName.toLowerCase().replace(/ /g, "_");
  return TYPE_PALETTE[key] ?? TYPE_PALETTE.other!;
}

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

  const renderRef = useRef<((root: D3HierarchyNode, width: number, height: number) => void) | null>(null);
  const arcRef = useRef<d3.Arc<unknown, D3HierarchyNode> | null>(null);

  const centerMetaRef = useRef<{ isGroup: boolean; party?: string; icon?: string }>({ isGroup: false });
  const vizOptionsRef = useRef<Partial<SunburstOptions>>({});
  vizOptionsRef.current = { ...vizOptions, ...(badgeSizeProp !== undefined ? { badgeSize: badgeSizeProp } : {}) };

  const render = useCallback((root: D3HierarchyNode, width: number, height: number) => {
    const svg = svgRef.current;
    if (!svg) return;

    d3.select(svg).selectAll("*").remove();

    // Badge mode options (via ref — always current without adding deps)
    const vizOpts    = vizOptionsRef.current;
    const shape      = vizOpts?.shape ?? 'circle';
    const badgeSize  = vizOpts?.badgeSize;
    const isTiny     = badgeSize === 'tiny';
    const isMini     = badgeSize === 'small' || badgeSize === 'tiny';
    const showLabels = vizOpts?.showLabels ?? 'auto';
    const skipLabels = isMini || showLabels === 'never';

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

    // ── Dark background ──────────────────────────────────────────────────────
    const svgSel = d3.select(svg)
      .attr("width", width)
      .attr("height", height)
      .style("background", "#030712");

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

    // Center glow gradient — color reflects party or group
    const meta = centerMetaRef.current;
    const centerColor = meta.isGroup
      ? "#6366f1"
      : meta.party === "democrat"
      ? "#3b82f6"
      : meta.party === "republican"
      ? "#ef4444"
      : "#6366f1";
    const centerColorDark = meta.isGroup
      ? "#1e1b4b"
      : meta.party === "democrat"
      ? "#1e3a8a"
      : meta.party === "republican"
      ? "#7f1d1d"
      : "#1e1b4b";

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

    bgGrad.append("stop").attr("offset", "0%").attr("stop-color", "#0f172a");
    bgGrad.append("stop").attr("offset", "100%").attr("stop-color", "#030712");

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
        .attr("fill", "white")
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
        return getPalette(typeName).dark + "cc";
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
        .attr("fill", "#f1f5f9")
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
        .attr("fill", "#6b7280")
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
        .attr("fill", "#a5b4fc")
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
          .attr("fill", "#e0e7ff")
          .attr("font-size", Math.max(centerRadius * 0.5, 14) + "px")
          .attr("font-weight", "700")
          .attr("letter-spacing", "0.05em")
          .style("pointer-events", "none")
          .style("user-select", "none")
          .text(initials);

        g.append("text")
          .attr("text-anchor", "middle")
          .attr("dy", "1.2em")
          .attr("fill", "#a5b4fc")
          .attr("font-size", Math.max(centerRadius * 0.2, 9) + "px")
          .style("pointer-events", "none")
          .style("user-select", "none")
          .text(displayName.length > 20 ? displayName.slice(0, 18) + "…" : displayName);
      } else {
        g.append("text")
          .attr("text-anchor", "middle")
          .attr("dy", "0.35em")
          .attr("fill", "#e0e7ff")
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
        .attr("fill", "#4b5563")
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
        .attr('stroke', '#4338ca')
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

    // If SVG not ready, fall back to instant render
    const svg = svgRef.current;
    if (!svg || !arcRef.current) {
      render(node, width, height);
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
        render(node, width, height);
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
        render(node, width, height);
      });
  }

  const defaultRing1 = primaryGroup?.filter.entity_type === "pac"
    ? "donation_industries"
    : "connection_types";
  const ring1    = vizOptions?.ring1    ?? defaultRing1;
  const maxRing1 = vizOptions?.maxRing1 ?? 8;
  const maxRing2 = vizOptions?.maxRing2 ?? 10;

  useEffect(() => {
    if (!entityId && !primaryGroup) {
      if (!rootRef.current) { setStatus("idle"); }
      return;
    }

    const controller = new AbortController();

    async function load() {
      const cacheKey = primaryGroup
        ? `group:${primaryGroup.id}:${ring1}:${maxRing1}:${maxRing2}`
        : `${entityId!}:${ring1}:${maxRing1}:${maxRing2}`;

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
        renderRef.current?.(partitioned, w, h);
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
            `&ring1=${ring1}&maxRing1=${maxRing1}&maxRing2=${maxRing2}`;
        } else {
          url = `/api/graph/sunburst` +
            `?entityId=${encodeURIComponent(entityId!)}` +
            (entityLabel ? `&entityLabel=${encodeURIComponent(entityLabel)}` : "") +
            `&ring1=${ring1}&maxRing1=${maxRing1}&maxRing2=${maxRing2}`;
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
        renderRef.current?.(partitioned, w, h);
      } catch (err) {
        if ((err as Error).name !== "AbortError") setStatus("error");
      }
    }

    void load();
    return () => { controller.abort(); };
  // render is intentionally excluded — renderRef.current always holds the latest version
  // primaryGroup?.id used (not full object) to avoid re-firing when reference changes but ID doesn't
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId, primaryGroup?.id, ring1, maxRing1, maxRing2]);

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
      renderRef.current?.(currentRootRef.current, w, h);
    });

    obs.observe(container);
    return () => obs.disconnect();
  }, [status]);

  return (
    <div ref={containerRef} className={`relative w-full h-full flex flex-col ${className}`}>
      {/* Breadcrumb trail — only shown when drilled in */}
      {status === "ok" && breadcrumbs.length > 1 && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 bg-gray-900/90 backdrop-blur-sm border border-gray-700/50 rounded-full px-3 py-1.5 shadow-lg">
          {/* Back button */}
          <button
            onClick={() => {
              if (!rootRef.current || !containerRef.current) return;
              const { width, height } = containerRef.current.getBoundingClientRect();
              zoom(rootRef.current, width || 600, height || 500);
            }}
            className="text-indigo-400 hover:text-indigo-300 text-xs font-medium flex items-center gap-1 transition-colors mr-1"
          >
            ← Back
          </button>
          <span className="text-gray-600 text-xs">|</span>
          {breadcrumbs.map((crumb, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span className="text-gray-600 text-xs">›</span>}
              <span className={`text-xs transition-colors ${i === breadcrumbs.length - 1 ? "text-white font-medium" : "text-gray-400"}`}>
                {crumb.length > 16 ? crumb.slice(0, 14) + "…" : crumb}
              </span>
            </React.Fragment>
          ))}
        </div>
      )}

      {status === "idle" && (
        <div className="flex flex-col items-center justify-center flex-1">
          <div className="text-center max-w-sm px-8 py-10 rounded-2xl bg-gray-900/80 border border-gray-800">
            <div className="w-10 h-10 mx-auto mb-4 rounded-full border border-gray-700 flex items-center justify-center">
              <svg className="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707m12.728 0l-.707-.707M6.343 6.343l-.707-.707" />
              </svg>
            </div>
            <p className="text-gray-300 text-sm font-medium">Select an official</p>
            <p className="text-gray-500 text-xs mt-2 leading-relaxed">
              Click any official node in the graph to see their full connection sunburst.
            </p>
          </div>
        </div>
      )}

      {status === "loading" && (
        <div className="flex flex-col items-center justify-center flex-1 gap-3">
          <div className="w-10 h-10 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" />
          <p className="text-gray-500 text-sm">Building network map…</p>
        </div>
      )}

      {status === "error" && (
        <div className="flex flex-col items-center justify-center flex-1 text-center">
          <p className="text-red-400 text-sm">Failed to load sunburst data.</p>
          <button onClick={() => setStatus("idle")} className="mt-3 text-xs text-indigo-400 hover:underline">
            Reset
          </button>
        </div>
      )}

      {status === "empty" && (
        <div className="flex flex-col items-center justify-center flex-1">
          <div className="text-center max-w-sm px-8 py-10 rounded-2xl bg-gray-900/80 border border-gray-800">
            <p className="text-gray-300 text-sm font-medium">
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
