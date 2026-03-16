"use client";

import * as d3 from "d3";
import React, { useEffect, useRef, useCallback } from "react";
import {
  type GraphNode,
  type GraphEdge,
  type VisualConfig,
  NODE_COLORS,
  PARTY_COLORS,
  EDGE_COLORS,
  edgeWidth,
} from "./index";

export interface ForceGraphProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeClick?: (node: GraphNode | null) => void;
  className?: string;
  visualConfig?: VisualConfig;
}

// D3 mutates link source/target from string IDs to node objects at runtime
type SimLink = Omit<GraphEdge, "source" | "target"> & {
  source: GraphNode;
  target: GraphNode;
};

function getNodeRadius(type: GraphNode["type"], encoding: VisualConfig["nodeSizeEncoding"] | undefined): number {
  if (encoding === "uniform") return 18;
  return NODE_RADIUS[type];
}

function getEdgeWidth(edge: Pick<GraphEdge, "type" | "amountCents" | "strength">, encoding: VisualConfig["edgeThicknessEncoding"] | undefined): number {
  if (encoding === "uniform") return 1.5;
  if (encoding === "strength_proportional") return Math.max(0.5, edge.strength * 3);
  return edgeWidth(edge);
}

const NODE_RADIUS: Record<GraphNode["type"], number> = {
  official: 26,
  governing_body: 20,
  proposal: 20,
  corporation: 22,
  pac: 20,
  individual: 16,
};

function initials(label: string) {
  return label
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase();
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export const ForceGraph = React.forwardRef<SVGSVGElement, ForceGraphProps>(
function ForceGraph({ nodes, edges, onNodeClick, className, visualConfig }: ForceGraphProps, forwardedRef) {
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<d3.Simulation<GraphNode, SimLink> | null>(null);

  // Expose internal svgRef to parent via forwardRef
  React.useImperativeHandle(forwardedRef, () => svgRef.current!, []);

  const handleClick = useCallback(
    (node: GraphNode) => onNodeClick?.(node),
    [onNodeClick]
  );

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl || nodes.length === 0) return;

    const width = svgEl.clientWidth || 900;
    const height = svgEl.clientHeight || 600;

    // ── clear ──────────────────────────────────────────────────────────────
    const svg = d3.select(svgEl);
    svg.selectAll("*").remove();

    // ── defs: arrowhead markers per edge type ──────────────────────────────
    const defs = svg.append("defs");
    (Object.keys(EDGE_COLORS) as GraphEdge["type"][]).forEach((type) => {
      defs
        .append("marker")
        .attr("id", `arrow-${type}`)
        .attr("viewBox", "0 -5 10 10")
        .attr("refX", 34)
        .attr("refY", 0)
        .attr("markerWidth", 5)
        .attr("markerHeight", 5)
        .attr("orient", "auto")
        .append("path")
        .attr("d", "M0,-5L10,0L0,5")
        .attr("fill", EDGE_COLORS[type])
        .attr("opacity", 0.75);
    });

    // Drop shadow filter for hovered nodes
    const shadow = defs.append("filter").attr("id", "shadow");
    shadow.append("feDropShadow")
      .attr("dx", 0).attr("dy", 2)
      .attr("stdDeviation", 4)
      .attr("flood-color", "#6366f1")
      .attr("flood-opacity", 0.35);

    // ── zoom layer ─────────────────────────────────────────────────────────
    const g = svg.append("g");
    svg.call(
      d3
        .zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.15, 4])
        .on("zoom", (e) => g.attr("transform", e.transform))
    );

    // Click on empty SVG → deselect
    svg.on("click", (e) => {
      if (e.target === svgEl) onNodeClick?.(null);
    });

    // ── deep-copy data so D3 mutations don't affect React props ────────────
    const simNodes: GraphNode[] = nodes.map((n) => ({ ...n }));
    const nodeById = new Map(simNodes.map((n) => [n.id, n]));
    const simEdges: SimLink[] = edges.map((e) => ({
      ...e,
      source: nodeById.get(e.source) ?? simNodes[0]!,
      target: nodeById.get(e.target) ?? simNodes[0]!,
    }));

    // ── edge lines ─────────────────────────────────────────────────────────
    const linkGroup = g.append("g").attr("class", "links");
    const link = linkGroup
      .selectAll<SVGLineElement, SimLink>("line")
      .data(simEdges)
      .join("line")
      .attr("stroke", (d) => EDGE_COLORS[d.type])
      .attr("stroke-width", (d) => getEdgeWidth(d, visualConfig?.edgeThicknessEncoding))
      .attr("stroke-opacity", visualConfig?.edgeOpacity ?? 0.55)
      .attr("stroke-dasharray", (d) => (d.type === "appointment" ? "6,3" : null))
      .attr("marker-end", (d) => `url(#arrow-${d.type})`);

    // ── edge labels (shown on hover) ───────────────────────────────────────
    const edgeLabelGroup = g.append("g").attr("class", "edge-labels").attr("opacity", 0);
    const edgeLabel = edgeLabelGroup
      .selectAll<SVGTextElement, SimLink>("text")
      .data(simEdges)
      .join("text")
      .attr("text-anchor", "middle")
      .attr("font-size", "9px")
      .attr("fill", (d) => EDGE_COLORS[d.type])
      .attr("font-weight", "600")
      .text((d) => d.type.replace(/_/g, " "));

    // ── node groups ────────────────────────────────────────────────────────
    const nodeGroup = g.append("g").attr("class", "nodes");
    const node = nodeGroup
      .selectAll<SVGGElement, GraphNode>("g")
      .data(simNodes, (d) => d.id)
      .join("g")
      .attr("cursor", "pointer")
      .call(
        d3
          .drag<SVGGElement, GraphNode>()
          .on("start", (event, d) => {
            if (!event.active) sim.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on("drag", (event, d) => {
            d.fx = event.x;
            d.fy = event.y;
          })
          .on("end", (event, d) => {
            if (!event.active) sim.alphaTarget(0);
            d.fx = null;
            d.fy = null;
          })
      );

    // Draw shape per node type
    node.each(function (d) {
      const el = d3.select(this);
      const colors = NODE_COLORS[d.type];
      const stroke =
        d.type === "official" && d.party
          ? (PARTY_COLORS[d.party] ?? colors.stroke)
          : colors.stroke;

      if (d.type === "official") {
        el.append("circle")
          .attr("r", getNodeRadius("official", visualConfig?.nodeSizeEncoding))
          .attr("fill", colors.fill)
          .attr("stroke", stroke)
          .attr("stroke-width", 3);
        el.append("text")
          .attr("text-anchor", "middle")
          .attr("dominant-baseline", "central")
          .attr("font-size", "11px")
          .attr("font-weight", "700")
          .attr("fill", "#374151")
          .attr("pointer-events", "none")
          .text(initials(d.label));
      } else if (d.type === "governing_body") {
        el.append("rect")
          .attr("x", -30).attr("y", -18)
          .attr("width", 60).attr("height", 36)
          .attr("rx", 5)
          .attr("fill", colors.fill)
          .attr("stroke", stroke)
          .attr("stroke-width", 2);
        el.append("text")
          .attr("text-anchor", "middle")
          .attr("dominant-baseline", "central")
          .attr("font-size", "9px")
          .attr("font-weight", "600")
          .attr("fill", "#374151")
          .attr("pointer-events", "none")
          .text(truncate(d.label, 11));
      } else if (d.type === "proposal") {
        el.append("rect")
          .attr("x", -28).attr("y", -20)
          .attr("width", 56).attr("height", 40)
          .attr("rx", 2)
          .attr("fill", colors.fill)
          .attr("stroke", stroke)
          .attr("stroke-width", 2);
        // Folded corner
        el.append("path")
          .attr("d", "M10,-20 L28,-2 L28,-20 Z")
          .attr("fill", stroke)
          .attr("opacity", 0.3)
          .attr("pointer-events", "none");
        el.append("text")
          .attr("text-anchor", "middle")
          .attr("dominant-baseline", "central")
          .attr("font-size", "8px")
          .attr("font-weight", "600")
          .attr("fill", "#92400e")
          .attr("pointer-events", "none")
          .text(truncate(d.label, 10));
      } else if (d.type === "corporation") {
        // Diamond — green, financial entity
        el.append("path")
          .attr("d", "M0,-24 L24,0 L0,24 L-24,0 Z")
          .attr("fill", colors.fill)
          .attr("stroke", stroke)
          .attr("stroke-width", 2);
        el.append("text")
          .attr("text-anchor", "middle")
          .attr("dominant-baseline", "central")
          .attr("font-size", "8px")
          .attr("font-weight", "600")
          .attr("fill", "#14532d")
          .attr("pointer-events", "none")
          .text(truncate(d.label, 9));
      } else if (d.type === "pac") {
        // Upward triangle — orange, political money
        el.append("path")
          .attr("d", "M0,-22 L22,18 L-22,18 Z")
          .attr("fill", colors.fill)
          .attr("stroke", stroke)
          .attr("stroke-width", 2);
        el.append("text")
          .attr("text-anchor", "middle")
          .attr("y", "5")
          .attr("font-size", "7px")
          .attr("font-weight", "700")
          .attr("fill", "#7c2d12")
          .attr("pointer-events", "none")
          .text(truncate(d.label, 8));
      } else {
        // individual — small filled circle, steel blue
        el.append("circle")
          .attr("r", getNodeRadius("individual", visualConfig?.nodeSizeEncoding))
          .attr("fill", colors.fill)
          .attr("stroke", stroke)
          .attr("stroke-width", 1.5)
          .attr("stroke-dasharray", "3,2");  // dashed = private citizen, not public official
        el.append("text")
          .attr("text-anchor", "middle")
          .attr("dominant-baseline", "central")
          .attr("font-size", "9px")
          .attr("font-weight", "600")
          .attr("fill", "#1e40af")
          .attr("pointer-events", "none")
          .text(initials(d.label));
      }

      // Node label below shape
      const labelY =
        d.type === "official" ? 40 :
        d.type === "pac" ? 34 :
        d.type === "individual" ? 26 : 34;
      el.append("text")
        .attr("class", "node-label")
        .attr("y", labelY)
        .attr("text-anchor", "middle")
        .attr("font-size", "10px")
        .attr("fill", "#6b7280")
        .attr("pointer-events", "none")
        .text(truncate(d.label, 22));
    });

    // ── interactions ───────────────────────────────────────────────────────
    const connectedIds = (d: GraphNode): Set<string> => {
      const ids = new Set([d.id]);
      simEdges.forEach((e) => {
        if (e.source.id === d.id) ids.add(e.target.id);
        if (e.target.id === d.id) ids.add(e.source.id);
      });
      return ids;
    };

    node
      .on("mouseenter", function (_, d) {
        const ids = connectedIds(d);
        node.attr("opacity", (n) => (ids.has(n.id) ? 1 : 0.12));
        link.attr("opacity", (e) =>
          e.source.id === d.id || e.target.id === d.id ? 0.9 : 0.04
        );
        edgeLabelGroup.attr("opacity", 1);
        edgeLabel.attr("opacity", (e) =>
          e.source.id === d.id || e.target.id === d.id ? 1 : 0
        );
        d3.select(this).select("circle,rect,path").attr("filter", "url(#shadow)");
      })
      .on("mouseleave", function () {
        node.attr("opacity", 1);
        link.attr("opacity", 0.55);
        edgeLabelGroup.attr("opacity", 0);
        d3.select(this).select("circle,rect,path").attr("filter", null);
      })
      .on("click", (event, d) => {
        event.stopPropagation();
        handleClick(d);
      });

    // ── simulation ─────────────────────────────────────────────────────────
    const sim = d3
      .forceSimulation<GraphNode>(simNodes)
      .force(
        "link",
        d3
          .forceLink<GraphNode, SimLink>(simEdges)
          .id((d) => d.id)
          .distance(160)
          .strength(0.4)
      )
      .force("charge", d3.forceManyBody<GraphNode>().strength(-600))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collide", d3.forceCollide<GraphNode>()
        .radius((d) => (d.type === "individual" ? 35 : 55))
        .strength(0.7)
      );

    sim.on("tick", () => {
      link
        .attr("x1", (d) => d.source.x ?? 0)
        .attr("y1", (d) => d.source.y ?? 0)
        .attr("x2", (d) => d.target.x ?? 0)
        .attr("y2", (d) => d.target.y ?? 0);

      edgeLabel
        .attr("x", (d) => ((d.source.x ?? 0) + (d.target.x ?? 0)) / 2)
        .attr("y", (d) => ((d.source.y ?? 0) + (d.target.y ?? 0)) / 2 - 4);

      node.attr("transform", (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
    });

    simRef.current = sim;
    return () => { sim.stop(); };
  }, [nodes, edges, handleClick, onNodeClick, visualConfig]);

  return (
    <svg
      ref={svgRef}
      className={className}
      style={{ width: "100%", height: "100%", background: "transparent" }}
    />
  );
});
ForceGraph.displayName = "ForceGraph";
