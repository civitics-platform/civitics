"use client";

import * as d3 from "d3";
import React, { useEffect, useRef, useCallback, useState } from "react";
import {
  type GraphNode as OldGraphNode,
  type GraphEdge as OldGraphEdge,
  type VisualConfig,
  NODE_COLORS,
  PARTY_COLORS,
  EDGE_COLORS,
  edgeWidth,
} from "./index";
import type { GraphNode as NewGraphNode, GraphView, NodeActions } from "./types";
import { Tooltip, useTooltip } from "./components/Tooltip";
import { NodePopup } from "./components/NodePopup";

export interface ForceGraphProps {
  nodes: OldGraphNode[];
  edges: OldGraphEdge[];
  onNodeClick?: (node: OldGraphNode | null) => void;
  /** Called when user requests expanding a collapsed node */
  onExpandNode?: (node: OldGraphNode) => void;
  className?: string;
  visualConfig?: VisualConfig;
  /** Connection settings from GraphView.connections — used for edge color/opacity/thickness */
  connectionSettings?: GraphView['connections'];
}

// D3 mutates link source/target from string IDs to node objects at runtime
type SimLink = Omit<OldGraphEdge, "source" | "target"> & {
  source: OldGraphNode;
  target: OldGraphNode;
};

function getNodeRadius(type: OldGraphNode["type"], encoding: VisualConfig["nodeSizeEncoding"] | undefined): number {
  if (encoding === "uniform") return 18;
  return NODE_RADIUS[type] ?? 20;
}

const NODE_RADIUS: Record<string, number> = {
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

/** Map old NodeType to new NodeType (for Tooltip/NodePopup) */
function mapType(t: OldGraphNode["type"]): NewGraphNode["type"] {
  if (t === "governing_body") return "agency";
  return t as NewGraphNode["type"];
}

/** Adapt old GraphNode → new GraphNode for Tooltip/NodePopup */
function adaptNode(d: OldGraphNode): NewGraphNode {
  return {
    id: d.id,
    name: (d as unknown as { label: string }).label ?? d.id,
    type: mapType(d.type),
    party: d.party,
    connectionCount:
      typeof d.metadata?.connectionCount === "number"
        ? d.metadata.connectionCount
        : undefined,
    collapsed: d.metadata?.collapsed === true,
  };
}

export const ForceGraph = React.forwardRef<SVGSVGElement, ForceGraphProps>(
function ForceGraph(
  { nodes, edges, onNodeClick, onExpandNode, className, visualConfig, connectionSettings },
  forwardedRef
) {
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<d3.Simulation<OldGraphNode, SimLink> | null>(null);

  React.useImperativeHandle(forwardedRef, () => svgRef.current!, []);

  const { tooltip, show: showTip, hide: hideTip } = useTooltip();
  const [popup, setPopup] = useState<NewGraphNode | null>(null);

  const handleClick = useCallback(
    (node: OldGraphNode) => onNodeClick?.(node),
    [onNodeClick]
  );

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl || nodes.length === 0) return;

    const width  = svgEl.clientWidth  || 900;
    const height = svgEl.clientHeight || 600;

    // ── clear ──────────────────────────────────────────────────────────────
    const svg = d3.select(svgEl);
    svg.selectAll("*").remove();

    // ── defs: arrowhead markers per edge type ──────────────────────────────
    const defs = svg.append("defs");
    (Object.keys(EDGE_COLORS) as OldGraphEdge["type"][]).forEach((type) => {
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

    // Click on empty SVG → dismiss popup
    svg.on("click", () => {
      setPopup(null);
      onNodeClick?.(null);
    });

    // ── deep-copy data ─────────────────────────────────────────────────────
    const simNodes: OldGraphNode[] = nodes.map((n) => ({ ...n }));
    const nodeById = new Map(simNodes.map((n) => [n.id, n]));
    const simEdges: SimLink[] = edges.map((e) => ({
      ...e,
      source: nodeById.get(e.source) ?? simNodes[0]!,
      target: nodeById.get(e.target) ?? simNodes[0]!,
    }));

    // ── edge color/opacity/width from connectionSettings ───────────────────
    const edgeColor = (d: SimLink): string =>
      connectionSettings?.[d.type]?.color ?? EDGE_COLORS[d.type] ?? "#94a3b8";

    const edgeOpacity = (d: SimLink): number =>
      connectionSettings?.[d.type]?.opacity ?? (visualConfig?.edgeOpacity ?? 0.55);

    const edgeStrokeWidth = (d: SimLink): number => {
      const thickness = connectionSettings?.[d.type]?.thickness ?? 0.5;
      if (visualConfig?.edgeThicknessEncoding === "uniform") return thickness * 3;
      if (visualConfig?.edgeThicknessEncoding === "strength_proportional") {
        return Math.max(0.5, d.strength * 3 * thickness * 2);
      }
      // amount_proportional (default)
      if (d.type === "donation" && d.amountCents) {
        return Math.max(1, Math.log10(d.amountCents / 100_000) + 3) * (thickness * 2);
      }
      return thickness * 4;
    };

    // ── edge lines ─────────────────────────────────────────────────────────
    const linkGroup = g.append("g").attr("class", "links");
    const link = linkGroup
      .selectAll<SVGLineElement, SimLink>("line")
      .data(simEdges)
      .join("line")
      .attr("stroke", edgeColor)
      .attr("stroke-width", edgeStrokeWidth)
      .attr("stroke-opacity", edgeOpacity)
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
      .attr("fill", edgeColor)
      .attr("font-weight", "600")
      .text((d) => d.type.replace(/_/g, " "));

    // ── node groups ────────────────────────────────────────────────────────
    const nodeGroup = g.append("g").attr("class", "nodes");
    const node = nodeGroup
      .selectAll<SVGGElement, OldGraphNode>("g")
      .data(simNodes, (d) => d.id)
      .join("g")
      .attr("cursor", "pointer")
      .call(
        d3
          .drag<SVGGElement, OldGraphNode>()
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
      const colors = NODE_COLORS[d.type] ?? NODE_COLORS.official!;
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
          .text(initials((d as unknown as { label: string }).label ?? d.id));
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
          .text(truncate((d as unknown as { label: string }).label ?? "", 11));
      } else if (d.type === "proposal") {
        el.append("rect")
          .attr("x", -28).attr("y", -20)
          .attr("width", 56).attr("height", 40)
          .attr("rx", 2)
          .attr("fill", colors.fill)
          .attr("stroke", stroke)
          .attr("stroke-width", 2);
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
          .text(truncate((d as unknown as { label: string }).label ?? "", 10));
      } else if (d.type === "corporation") {
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
          .text(truncate((d as unknown as { label: string }).label ?? "", 9));
      } else if (d.type === "pac") {
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
          .text(truncate((d as unknown as { label: string }).label ?? "", 8));
      } else {
        // individual — small filled circle, steel blue
        el.append("circle")
          .attr("r", getNodeRadius("individual", visualConfig?.nodeSizeEncoding))
          .attr("fill", colors.fill)
          .attr("stroke", stroke)
          .attr("stroke-width", 1.5)
          .attr("stroke-dasharray", "3,2");
        el.append("text")
          .attr("text-anchor", "middle")
          .attr("dominant-baseline", "central")
          .attr("font-size", "9px")
          .attr("font-weight", "600")
          .attr("fill", "#1e40af")
          .attr("pointer-events", "none")
          .text(initials((d as unknown as { label: string }).label ?? ""));
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
        .text(truncate((d as unknown as { label: string }).label ?? "", 22));

      // Collapsed badge (orange "+")
      if (d.metadata?.collapsed) {
        const r = getNodeRadius(d.type, visualConfig?.nodeSizeEncoding);
        const bx = d.type === "governing_body" ? 28 :
                   d.type === "proposal"        ? 24 :
                   d.type === "pac"             ? 18 : r - 2;
        const by = d.type === "governing_body" ? -16 :
                   d.type === "proposal"        ? -18 :
                   d.type === "pac"             ? -20 : -(r - 2);
        el.append("circle")
          .attr("cx", bx).attr("cy", by)
          .attr("r", 9)
          .attr("fill", "#f97316")
          .attr("stroke", "#111827")
          .attr("stroke-width", 1.5)
          .attr("pointer-events", "none");
        el.append("text")
          .attr("x", bx).attr("y", by)
          .attr("text-anchor", "middle")
          .attr("dominant-baseline", "central")
          .attr("font-size", "13px")
          .attr("font-weight", "800")
          .attr("fill", "white")
          .attr("pointer-events", "none")
          .text("+");
      }
    });

    // ── interactions ───────────────────────────────────────────────────────
    const connectedIds = (d: OldGraphNode): Set<string> => {
      const ids = new Set([d.id]);
      simEdges.forEach((e) => {
        if (e.source.id === d.id) ids.add(e.target.id);
        if (e.target.id === d.id) ids.add(e.source.id);
      });
      return ids;
    };

    node
      .on("mouseenter", function (event: MouseEvent, d) {
        // Highlight connected nodes
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

        // Show tooltip
        const rect = svgEl.getBoundingClientRect();
        showTip(adaptNode(d), event.clientX - rect.left, event.clientY - rect.top);
      })
      .on("mousemove", function (event: MouseEvent, d) {
        const rect = svgEl.getBoundingClientRect();
        showTip(adaptNode(d), event.clientX - rect.left, event.clientY - rect.top);
      })
      .on("mouseleave", function () {
        node.attr("opacity", 1);
        link.attr("opacity", (d) => edgeOpacity(d));
        edgeLabelGroup.attr("opacity", 0);
        d3.select(this).select("circle,rect,path").attr("filter", null);
        hideTip();
      })
      .on("click", (event: MouseEvent, d) => {
        event.stopPropagation();
        hideTip();
        setPopup(adaptNode(d));
        // Still fire legacy callback so parent can do other things
        handleClick(d);
      });

    // ── simulation ─────────────────────────────────────────────────────────
    const sim = d3
      .forceSimulation<OldGraphNode>(simNodes)
      .force(
        "link",
        d3
          .forceLink<OldGraphNode, SimLink>(simEdges)
          .id((d) => d.id)
          .distance(160)
          .strength(0.4)
      )
      .force("charge", d3.forceManyBody<OldGraphNode>().strength(-600))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collide", d3.forceCollide<OldGraphNode>()
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
  }, [nodes, edges, handleClick, onNodeClick, visualConfig, connectionSettings]);

  // ── NodeActions for popup ──────────────────────────────────────────────────
  const nodeActions: NodeActions = {
    recenter: (nodeId: string) => {
      const sim = simRef.current;
      if (!sim) return;
      const target = sim.nodes().find((n) => n.id === nodeId);
      if (!target) return;
      sim
        .force("center", d3.forceCenter(target.x ?? 0, target.y ?? 0))
        .alpha(0.3)
        .restart();
    },

    openProfile: (nodeId: string) => {
      window.open(`/officials/${nodeId}`, "_blank");
    },

    addToComparison: (nodeId: string) => {
      console.log("[ForceGraph] Add to comparison:", nodeId);
    },

    expandNode: (nodeId: string) => {
      const sim = simRef.current;
      if (!sim) return;
      const target = sim.nodes().find((n) => n.id === nodeId);
      if (target) onExpandNode?.(target);
    },
  };

  return (
    <div className={`relative w-full h-full ${className ?? ""}`}>
      <svg
        ref={svgRef}
        id="force-graph-canvas"
        className="w-full h-full"
        style={{ background: "transparent" }}
      />

      <Tooltip
        node={tooltip.node}
        x={tooltip.x}
        y={tooltip.y}
        visible={tooltip.visible}
      />

      <NodePopup
        node={popup}
        onClose={() => setPopup(null)}
        actions={nodeActions}
        vizType="force"
      />
    </div>
  );
});

ForceGraph.displayName = "ForceGraph";
