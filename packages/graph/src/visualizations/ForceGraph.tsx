"use client";

/**
 * packages/graph/src/visualizations/ForceGraph.tsx
 *
 * G3: Updated to receive pre-fetched nodes + edges from useGraphData.
 * All data fetching removed — data comes from props.
 *
 * Three categories of real-time updates:
 *   Category A — visual only (no restart): connection styles, focus highlight, labels, loading ring
 *   Category B — simulation restart (~200ms): physics params, layout, node size encoding
 *   Category C — data change (full re-init with position preservation): nodes/edges from useGraphData
 */

import * as d3 from "d3";
import React, { useEffect, useRef, useState, useCallback } from "react";
import type {
  GraphNode,
  GraphEdge,
  FocusEntity,
  GraphView,
  ForceOptions,
  NodeActions,
} from "../types";
import { CONNECTION_TYPE_REGISTRY } from "../connections";
import { Tooltip, useTooltip } from "../components/Tooltip";
import { NodePopup } from "../components/NodePopup";

// ── Props ──────────────────────────────────────────────────────────────────────

export interface ForceGraphProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** ID of entity currently being loaded — shows animated ring on that node */
  loadingEntityId?: string | null;
  /** Focused entities — larger nodes with party-color rings + shared edge highlighting */
  focusEntities?: FocusEntity[];
  /** Connection settings from GraphView.connections — controls edge visibility/style */
  connections?: GraphView["connections"];
  /** Viz-type-specific rendering options */
  vizOptions?: ForceOptions;
  onNodeClick?: (node: GraphNode) => void;
  onNodeHover?: (node: GraphNode | null, x: number, y: number) => void;
  className?: string;
}

// ── D3 simulation types ────────────────────────────────────────────────────────

type SimNode = GraphNode & {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
  baseRadius?: number;
};

/** D3 mutates source/target from string to SimNode at runtime */
type SimLink = {
  source: SimNode;
  target: SimNode;
  connectionType: string;
  amountUsd?: number;
  strength: number;
  fromId: string;
  toId: string;
};

// ── Visual constants ──────────────────────────────────────────────────────────

const NODE_FILL: Record<string, string> = {
  official:     "#f8fafc",
  agency:       "#f5f3ff",
  proposal:     "#fffbeb",
  financial:    "#f0fdf4",
  organization: "#eff6ff",
  corporation:  "#f0fdf4",
  pac:          "#fff7ed",
  individual:   "#eff6ff",
};

const NODE_STROKE: Record<string, string> = {
  official:     "#6366f1",
  agency:       "#7c3aed",
  proposal:     "#f59e0b",
  financial:    "#16a34a",
  organization: "#0891b2",
  corporation:  "#16a34a",
  pac:          "#ea580c",
  individual:   "#3b82f6",
};

const PARTY_STROKE: Record<string, string> = {
  democrat:    "#2563eb",
  republican:  "#dc2626",
  independent: "#7c3aed",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function getBaseRadius(node: GraphNode): number {
  const BASE: Record<string, number> = {
    official: 24, agency: 20, proposal: 18, financial: 16,
    organization: 20, corporation: 20, pac: 18, individual: 14,
  };
  return BASE[node.type] ?? 20;
}

function getNodeRadius(node: GraphNode, sizeBy: string | undefined): number {
  const base = getBaseRadius(node);
  if (sizeBy === "uniform") return base;
  if (sizeBy === "donation_total")
    return base + Math.sqrt((node.donationTotal ?? 0) / 100_000) * 2;
  // default: connection_count
  return base + Math.sqrt(node.connectionCount ?? 0) * 2;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2)
    return ((parts[0]![0] ?? "") + (parts[parts.length - 1]![0] ?? "")).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// ── Component ─────────────────────────────────────────────────────────────────

export const ForceGraph = React.forwardRef<SVGSVGElement, ForceGraphProps>(
  function ForceGraph(
    {
      nodes,
      edges,
      loadingEntityId = null,
      focusEntities = [],
      connections = {},
      vizOptions,
      onNodeClick,
      onNodeHover,
      className,
    },
    forwardedRef
  ) {
    const svgRef       = useRef<SVGSVGElement>(null);
    const simRef       = useRef<d3.Simulation<SimNode, SimLink> | null>(null);
    const linkSelRef   = useRef<d3.Selection<SVGLineElement, SimLink, SVGGElement, unknown> | null>(null);
    const nodeGrpRef   = useRef<d3.Selection<SVGGElement, SimNode, SVGGElement, unknown> | null>(null);
    const zoomTransRef = useRef<d3.ZoomTransform>(d3.zoomIdentity);
    const zoomBehRef   = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);

    React.useImperativeHandle(forwardedRef, () => svgRef.current!, []);

    const { tooltip, show: showTip, hide: hideTip } = useTooltip();
    const [popup, setPopup] = useState<GraphNode | null>(null);

    // ── Category C — data change: full re-init preserving positions ───────────
    useEffect(() => {
      const svgEl = svgRef.current;
      if (!svgEl) return;

      const width  = svgEl.clientWidth  || 900;
      const height = svgEl.clientHeight || 600;

      // Stop previous simulation
      simRef.current?.stop();

      // Preserve existing node positions
      const oldPositions = new Map(
        (simRef.current?.nodes() ?? []).map((n) => [
          n.id,
          { x: n.x, y: n.y, vx: n.vx, vy: n.vy },
        ])
      );

      // Build sim nodes — apply old positions to existing nodes, scatter new ones
      const simNodes: SimNode[] = nodes.map((n) => {
        const old = oldPositions.get(n.id);
        const base = getBaseRadius(n);
        if (old)
          return { ...n, x: old.x, y: old.y, vx: old.vx, vy: old.vy, baseRadius: base };
        return {
          ...n,
          x: width / 2 + (Math.random() - 0.5) * 100,
          y: height / 2 + (Math.random() - 0.5) * 100,
          baseRadius: base,
        };
      });

      const nodeById = new Map(simNodes.map((n) => [n.id, n]));

      // Build sim links — D3 forceLink mutates source/target to SimNode refs
      const simLinks: SimLink[] = edges.map((e) => ({
        fromId: e.fromId,
        toId: e.toId,
        connectionType: e.connectionType,
        amountUsd: e.amountUsd,
        strength: e.strength,
        source: (nodeById.get(e.fromId) ?? simNodes[0]!) as SimNode,
        target: (nodeById.get(e.toId)   ?? simNodes[0]!) as SimNode,
      }));

      // ── Clear and rebuild SVG ──────────────────────────────────────────────
      const svg = d3.select(svgEl);
      svg.selectAll("*").remove();

      // ── Defs: arrowhead markers, drop shadow ──────────────────────────────
      const defs = svg.append("defs");

      Object.keys(CONNECTION_TYPE_REGISTRY).forEach((type) => {
        const color = connections[type]?.color
          ?? CONNECTION_TYPE_REGISTRY[type]?.color
          ?? "#94a3b8";
        defs
          .append("marker")
          .attr("id", `arrow-${type}`)
          .attr("viewBox", "0 -5 10 10")
          .attr("refX", 34).attr("refY", 0)
          .attr("markerWidth", 5).attr("markerHeight", 5)
          .attr("orient", "auto")
          .append("path")
          .attr("d", "M0,-5L10,0L0,5")
          .attr("fill", color)
          .attr("opacity", 0.75);
      });

      const shadow = defs.append("filter").attr("id", "fg-shadow");
      shadow.append("feDropShadow")
        .attr("dx", 0).attr("dy", 2)
        .attr("stdDeviation", 4)
        .attr("flood-color", "#6366f1")
        .attr("flood-opacity", 0.35);

      // ── Zoom layer ────────────────────────────────────────────────────────
      const g = svg.append("g").attr("class", "graph-root");
      // Restore previous zoom transform so data changes don't reset the view
      g.attr("transform", zoomTransRef.current.toString());

      const zoom = d3
        .zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.1, 5])
        .on("zoom", (e) => {
          g.attr("transform", e.transform);
          zoomTransRef.current = e.transform;
        });
      svg.call(zoom);
      zoomBehRef.current = zoom;

      // Dismiss popup on background click
      svg.on("click", () => setPopup(null));

      // ── Edge lines ────────────────────────────────────────────────────────
      const focusIds = new Set(focusEntities.map((fe) => fe.id));

      function edgeColor(d: SimLink): string {
        return connections[d.connectionType]?.color
          ?? CONNECTION_TYPE_REGISTRY[d.connectionType]?.color
          ?? "#94a3b8";
      }

      function edgeOpacityFn(d: SimLink): number {
        const isShared =
          focusIds.has(d.source?.id ?? d.fromId) &&
          focusIds.has(d.target?.id ?? d.toId);
        if (isShared) return 0.9;
        return connections[d.connectionType]?.opacity ?? 0.6;
      }

      function edgeWidthFn(d: SimLink): number {
        const isShared =
          focusIds.has(d.source?.id ?? d.fromId) &&
          focusIds.has(d.target?.id ?? d.toId);
        const base = connections[d.connectionType]?.thickness ?? 0.5;
        if (isShared) return base * 8;
        if (d.connectionType === "donation" && d.amountUsd) {
          return Math.max(1, Math.log10(d.amountUsd / 1_000) * base * 3);
        }
        return base * 4;
      }

      const linkGroup = g.append("g").attr("class", "links");
      const link = linkGroup
        .selectAll<SVGLineElement, SimLink>("line")
        .data(simLinks)
        .join("line")
        .attr("class", "link")
        .attr("stroke", edgeColor)
        .attr("stroke-width", edgeWidthFn)
        .attr("stroke-opacity", edgeOpacityFn)
        .style("display", (d) =>
          connections[d.connectionType]?.enabled !== false ? "block" : "none"
        )
        .attr("marker-end", (d) => `url(#arrow-${d.connectionType})`);

      linkSelRef.current = link;

      // Edge labels (shown on hover)
      const edgeLabelGroup = g.append("g").attr("class", "edge-labels").attr("opacity", 0);
      const edgeLabel = edgeLabelGroup
        .selectAll<SVGTextElement, SimLink>("text")
        .data(simLinks)
        .join("text")
        .attr("text-anchor", "middle")
        .attr("font-size", "9px")
        .attr("fill", edgeColor)
        .attr("font-weight", "600")
        .text((d) => (CONNECTION_TYPE_REGISTRY[d.connectionType]?.label ?? d.connectionType ?? '').replace(/_/g, " "));

      // ── Node groups ───────────────────────────────────────────────────────
      const nodeGroup = g.append("g").attr("class", "nodes");
      const sizeBy = vizOptions?.nodeSizeEncoding ?? "connection_count";

      const nodeGrp = nodeGroup
        .selectAll<SVGGElement, SimNode>("g")
        .data(simNodes, (d) => d.id)
        .join("g")
        .attr("class", "node")
        .attr("cursor", "pointer")
        .call(
          d3
            .drag<SVGGElement, SimNode>()
            .on("start", (event, d) => {
              if (!event.active) simRef.current?.alphaTarget(0.3).restart();
              d.fx = d.x;
              d.fy = d.y;
            })
            .on("drag", (event, d) => {
              d.fx = event.x;
              d.fy = event.y;
            })
            .on("end", (event, d) => {
              if (!event.active) simRef.current?.alphaTarget(0);
              // Keep pinned if FocusEntity has pinned=true
              const fe = focusEntities.find((fe) => fe.id === d.id);
              if (!fe?.pinned) {
                d.fx = null;
                d.fy = null;
              }
            })
        );

      nodeGrpRef.current = nodeGrp;

      // Draw shapes per node type
      nodeGrp.each(function (d) {
        const el     = d3.select(this);
        const r      = getNodeRadius(d, sizeBy);
        const fill   = NODE_FILL[d.type]   ?? "#f8fafc";
        const stroke = d.type === "official" && d.party
          ? (PARTY_STROKE[d.party.toLowerCase()] ?? NODE_STROKE[d.type] ?? "#6366f1")
          : (NODE_STROKE[d.type] ?? "#94a3b8");

        // Store baseRadius for focus highlight effect
        (d as SimNode).baseRadius = r;

        if (d.type === "official" || d.type === "individual") {
          el.append("circle")
            .attr("class", "node-circle")
            .attr("r", r)
            .attr("fill", fill)
            .attr("stroke", stroke)
            .attr("stroke-width", d.type === "official" ? 3 : 1.5)
            .attr("stroke-dasharray", d.type === "individual" ? "3,2" : null);
          el.append("text")
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "central")
            .attr("font-size", d.type === "official" ? "11px" : "9px")
            .attr("font-weight", "700")
            .attr("fill", d.type === "official" ? "#374151" : "#1e40af")
            .attr("pointer-events", "none")
            .text(initials(d.name));
        } else if (d.type === "agency" || d.type === "organization") {
          el.append("rect")
            .attr("class", "node-circle")
            .attr("x", -r).attr("y", -r * 0.6)
            .attr("width", r * 2).attr("height", r * 1.2)
            .attr("rx", 5)
            .attr("fill", fill)
            .attr("stroke", stroke)
            .attr("stroke-width", 2);
          el.append("text")
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "central")
            .attr("font-size", "9px")
            .attr("font-weight", "600")
            .attr("fill", "#374151")
            .attr("pointer-events", "none")
            .text(truncate(d.name, 11));
        } else if (d.type === "proposal") {
          el.append("rect")
            .attr("class", "node-circle")
            .attr("x", -r + 4).attr("y", -r)
            .attr("width", (r - 4) * 2).attr("height", r * 2)
            .attr("rx", 2)
            .attr("fill", fill)
            .attr("stroke", stroke)
            .attr("stroke-width", 2);
          el.append("path")
            .attr("d", `M${r * 0.4},-${r} L${r - 4},-${r * 0.3} L${r - 4},-${r} Z`)
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
            .text(truncate(d.name, 10));
        } else if (d.type === "financial" || d.type === "corporation") {
          // Diamond shape
          el.append("path")
            .attr("class", "node-circle")
            .attr("d", `M0,${-r} L${r},0 L0,${r} L${-r},0 Z`)
            .attr("fill", fill)
            .attr("stroke", stroke)
            .attr("stroke-width", 2);
          el.append("text")
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "central")
            .attr("font-size", "8px")
            .attr("font-weight", "600")
            .attr("fill", "#14532d")
            .attr("pointer-events", "none")
            .text(truncate(d.name, 9));
        } else if (d.type === "pac") {
          // Triangle
          el.append("path")
            .attr("class", "node-circle")
            .attr("d", `M0,${-r} L${r},${r * 0.75} L${-r},${r * 0.75} Z`)
            .attr("fill", fill)
            .attr("stroke", stroke)
            .attr("stroke-width", 2);
          el.append("text")
            .attr("text-anchor", "middle")
            .attr("y", "4")
            .attr("font-size", "7px")
            .attr("font-weight", "700")
            .attr("fill", "#7c2d12")
            .attr("pointer-events", "none")
            .text(truncate(d.name, 8));
        } else {
          // fallback: circle
          el.append("circle")
            .attr("class", "node-circle")
            .attr("r", r)
            .attr("fill", fill)
            .attr("stroke", stroke)
            .attr("stroke-width", 2);
        }

        // Node label below shape
        const labelY = d.type === "official" ? r + 16 :
                       d.type === "pac"       ? r + 14 :
                       d.type === "individual"? r + 12 : r + 16;
        el.append("text")
          .attr("class", "node-label")
          .attr("y", labelY)
          .attr("text-anchor", "middle")
          .attr("font-size", "10px")
          .attr("fill", "#6b7280")
          .attr("pointer-events", "none")
          .text(truncate(d.name, 22));

        // Loading ring (animated, hidden by default)
        el.append("circle")
          .attr("class", "node-loading-ring")
          .attr("r", r + 6)
          .attr("fill", "none")
          .attr("stroke", "#6366f1")
          .attr("stroke-width", 2)
          .attr("stroke-dasharray", "12,8")
          .style("display", "none")
          .style("animation", "spin 1s linear infinite");

        // Collapsed badge
        if (d.collapsed) {
          el.append("circle")
            .attr("cx", r - 2).attr("cy", -(r - 2))
            .attr("r", 9)
            .attr("fill", "#f97316")
            .attr("stroke", "#111827")
            .attr("stroke-width", 1.5)
            .attr("pointer-events", "none");
          el.append("text")
            .attr("x", r - 2).attr("y", -(r - 2))
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "central")
            .attr("font-size", "13px")
            .attr("font-weight", "800")
            .attr("fill", "white")
            .attr("pointer-events", "none")
            .text("+");
        }
      });

      // ── Interactions ──────────────────────────────────────────────────────
      const connectedIds = (d: SimNode): Set<string> => {
        const ids = new Set([d.id]);
        simLinks.forEach((e) => {
          const sid = (e.source as SimNode).id ?? e.fromId;
          const tid = (e.target as SimNode).id ?? e.toId;
          if (sid === d.id) ids.add(tid);
          if (tid === d.id) ids.add(sid);
        });
        return ids;
      };

      nodeGrp
        .on("mouseenter", function (event: MouseEvent, d) {
          const ids = connectedIds(d);
          nodeGrp.attr("opacity", (n) => (ids.has(n.id) ? 1 : 0.12));
          link.attr("opacity", (e) => {
            const sid = (e.source as SimNode).id ?? e.fromId;
            const tid = (e.target as SimNode).id ?? e.toId;
            return sid === d.id || tid === d.id ? 0.9 : 0.04;
          });
          edgeLabelGroup.attr("opacity", 1);
          edgeLabel.attr("opacity", (e) => {
            const sid = (e.source as SimNode).id ?? e.fromId;
            const tid = (e.target as SimNode).id ?? e.toId;
            return sid === d.id || tid === d.id ? 1 : 0;
          });
          d3.select(this).select("circle,rect,path").attr("filter", "url(#fg-shadow)");
          const rect = svgEl.getBoundingClientRect();
          showTip(d, event.clientX - rect.left, event.clientY - rect.top);
          onNodeHover?.(d, event.clientX - rect.left, event.clientY - rect.top);
        })
        .on("mousemove", function (event: MouseEvent, d) {
          const rect = svgEl.getBoundingClientRect();
          showTip(d, event.clientX - rect.left, event.clientY - rect.top);
          onNodeHover?.(d, event.clientX - rect.left, event.clientY - rect.top);
        })
        .on("mouseleave", function () {
          nodeGrp.attr("opacity", 1);
          link.attr("opacity", edgeOpacityFn);
          edgeLabelGroup.attr("opacity", 0);
          d3.select(this).select("circle,rect,path").attr("filter", null);
          hideTip();
          onNodeHover?.(null, 0, 0);
        })
        .on("click", (event: MouseEvent, d) => {
          event.stopPropagation();
          hideTip();
          setPopup(d);
          onNodeClick?.(d);
        });

      // ── Simulation ────────────────────────────────────────────────────────
      const charge      = vizOptions?.charge      ?? -300;
      const linkDist    = vizOptions?.linkDistance ?? 150;
      const gravity     = vizOptions?.gravity      ?? 0.1;

      const sim = d3
        .forceSimulation<SimNode>(simNodes)
        .force(
          "link",
          d3
            .forceLink<SimNode, SimLink>(simLinks)
            .id((d) => d.id)
            .distance(linkDist)
            .strength(0.4)
        )
        .force("charge", d3.forceManyBody<SimNode>().strength(charge))
        .force("center",  d3.forceCenter(width / 2, height / 2).strength(gravity))
        .force("collide", d3.forceCollide<SimNode>().radius((d) => (d.baseRadius ?? 20) + 10).strength(0.7))
        .alphaDecay(0.0228)
        .velocityDecay(0.4);

      sim.on("tick", () => {
        link
          .attr("x1", (d) => (d.source as SimNode).x ?? 0)
          .attr("y1", (d) => (d.source as SimNode).y ?? 0)
          .attr("x2", (d) => (d.target as SimNode).x ?? 0)
          .attr("y2", (d) => (d.target as SimNode).y ?? 0);

        edgeLabel
          .attr("x", (d) => (((d.source as SimNode).x ?? 0) + ((d.target as SimNode).x ?? 0)) / 2)
          .attr("y", (d) => (((d.source as SimNode).y ?? 0) + ((d.target as SimNode).y ?? 0)) / 2 - 4);

        nodeGrp.attr("transform", (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
      });

      simRef.current = sim;

      // Pin focused + pinned entities
      sim.nodes().forEach((n) => {
        const fe = focusEntities.find((fe) => fe.id === n.id);
        if (fe?.pinned) {
          n.fx = n.x;
          n.fy = n.y;
        }
      });

      return () => { sim.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [nodes, edges]);

    // ── Category A — Connection styles + shared edge highlighting ─────────────
    useEffect(() => {
      const link = linkSelRef.current;
      if (!link) return;

      const focusIds = new Set(focusEntities.map((fe) => fe.id));

      link
        .style("display", (d: SimLink) =>
          connections[d.connectionType]?.enabled !== false ? "block" : "none"
        )
        .attr("stroke", (d: SimLink) =>
          connections[d.connectionType]?.color
            ?? CONNECTION_TYPE_REGISTRY[d.connectionType]?.color
            ?? "#94a3b8"
        )
        .attr("stroke-opacity", (d: SimLink) => {
          const isShared =
            focusIds.has((d.source as SimNode).id ?? d.fromId) &&
            focusIds.has((d.target as SimNode).id ?? d.toId);
          if (isShared) return 0.9;
          return connections[d.connectionType]?.opacity ?? 0.6;
        })
        .attr("stroke-width", (d: SimLink) => {
          const isShared =
            focusIds.has((d.source as SimNode).id ?? d.fromId) &&
            focusIds.has((d.target as SimNode).id ?? d.toId);
          const thickness = connections[d.connectionType]?.thickness ?? 0.5;
          if (isShared) return thickness * 8;
          if (d.connectionType === "donation" && d.amountUsd) {
            return Math.max(1, Math.log10(d.amountUsd / 1_000) * thickness * 3);
          }
          return thickness * 4;
        });
    }, [connections, focusEntities]);

    // ── Category A — Node highlight for focus entities ─────────────────────────
    useEffect(() => {
      const nodeGrp = nodeGrpRef.current;
      if (!nodeGrp) return;

      const focusIds = new Set(focusEntities.map((fe) => fe.id));

      nodeGrp
        .selectAll<SVGGElement, SimNode>(".node-circle")
        .attr("stroke", (d: SimNode) => {
          if (focusIds.has(d.id)) {
            switch (d.party?.toLowerCase()) {
              case "democrat":   return "#2563eb";
              case "republican": return "#dc2626";
              default:           return "#7c3aed";
            }
          }
          return d.type === "official" && d.party
            ? (PARTY_STROKE[d.party.toLowerCase()] ?? NODE_STROKE[d.type] ?? "#6366f1")
            : (NODE_STROKE[d.type] ?? "#94a3b8");
        })
        .attr("stroke-width", (d: SimNode) => (focusIds.has(d.id) ? 3 : d.type === "official" ? 3 : 2));
    }, [focusEntities]);

    // ── Category A — Label visibility ─────────────────────────────────────────
    useEffect(() => {
      const svgEl = svgRef.current;
      if (!svgEl) return;
      const labelMode = vizOptions?.labels ?? "hover";
      d3.select(svgEl)
        .selectAll<SVGTextElement, SimNode>(".node-label")
        .style("display", () =>
          labelMode === "always" ? "block" :
          labelMode === "never"  ? "none"  : null
        );
    }, [vizOptions?.labels]);

    // ── Category A — Loading ring ──────────────────────────────────────────────
    useEffect(() => {
      const svgEl = svgRef.current;
      if (!svgEl) return;
      d3.select(svgEl)
        .selectAll<SVGCircleElement, SimNode>(".node-loading-ring")
        .style("display", (d: SimNode) =>
          d.id === loadingEntityId ? "block" : "none"
        );
    }, [loadingEntityId]);

    // ── Category B — Physics options ──────────────────────────────────────────
    useEffect(() => {
      const sim = simRef.current;
      if (!sim) return;

      const svgEl = svgRef.current;
      const width  = svgEl?.clientWidth  ?? 900;
      const height = svgEl?.clientHeight ?? 600;

      const charge   = vizOptions?.charge      ?? -300;
      const linkDist = vizOptions?.linkDistance ?? 150;
      const gravity  = vizOptions?.gravity      ?? 0.1;

      sim
        .force("charge", d3.forceManyBody<SimNode>().strength(charge))
        .force("center",  d3.forceCenter(width / 2, height / 2).strength(gravity));

      const linkForce = sim.force("link") as d3.ForceLink<SimNode, SimLink> | null;
      linkForce?.distance(linkDist);

      sim.alpha(0.3).restart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [vizOptions?.charge, vizOptions?.linkDistance, vizOptions?.gravity]);

    // ── Category B — Layout mode ───────────────────────────────────────────────
    useEffect(() => {
      const sim = simRef.current;
      if (!sim || !nodes.length) return;

      const svgEl = svgRef.current;
      const width  = svgEl?.clientWidth  ?? 900;
      const height = svgEl?.clientHeight ?? 600;

      const layout = vizOptions?.layout ?? "force_directed";

      switch (layout) {
        case "radial": {
          const radius = Math.min(width, height) / 3;
          sim
            .force("r", d3.forceRadial<SimNode>(radius, width / 2, height / 2).strength(0.8))
            .alpha(0.5)
            .restart();
          break;
        }
        default:
          sim.force("r", null).alpha(0.3).restart();
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [vizOptions?.layout]);

    // ── Category B — Node size encoding ──────────────────────────────────────
    useEffect(() => {
      const nodeGrp = nodeGrpRef.current;
      const sim     = simRef.current;
      if (!nodeGrp) return;

      const sizeBy = vizOptions?.nodeSizeEncoding ?? "connection_count";

      nodeGrp
        .selectAll<SVGGElement, SimNode>(".node-circle")
        .each(function (d) {
          const el = d3.select(this);
          const r  = getNodeRadius(d, sizeBy);
          d.baseRadius = r;
          const tagName = (this as SVGElement).tagName;
          if (tagName === "circle") {
            el.attr("r", r);
          } else if (tagName === "rect") {
            el.attr("x", -r).attr("y", -r * 0.6)
              .attr("width", r * 2).attr("height", r * 1.2);
          }
          // diamonds/triangles use complex paths; skip for now (require full redraw)
        });

      sim?.force("collide", d3.forceCollide<SimNode>().radius((d) => (d.baseRadius ?? 20) + 10).strength(0.7))
        .alpha(0.2)
        .restart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [vizOptions?.nodeSizeEncoding]);

    // ── NodeActions for popup ─────────────────────────────────────────────────
    const nodeActions: NodeActions = {
      recenter: useCallback((nodeId: string) => {
        const sim = simRef.current;
        if (!sim) return;
        const target = sim.nodes().find((n) => n.id === nodeId);
        if (!target) return;
        const svgEl = svgRef.current;
        const width  = svgEl?.clientWidth  ?? 900;
        const height = svgEl?.clientHeight ?? 600;
        sim.force("center", d3.forceCenter(target.x ?? width / 2, target.y ?? height / 2))
           .alpha(0.3)
           .restart();
      }, []),

      openProfile: useCallback((nodeId: string) => {
        window.open(`/officials/${nodeId}`, "_blank");
      }, []),

      addToComparison: useCallback((nodeId: string) => {
        console.log("[ForceGraph] Add to comparison:", nodeId);
      }, []),

      expandNode: useCallback((nodeId: string) => {
        console.log("[ForceGraph] Expand node:", nodeId);
      }, []),
    };

    return (
      <div className={`relative w-full h-full ${className ?? ""}`}>
        <svg
          ref={svgRef}
          id="force-graph-canvas"
          className="w-full h-full"
          style={{ background: "transparent" }}
        />

        <style>{`
          @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        `}</style>

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
  }
);

ForceGraph.displayName = "ForceGraph";
