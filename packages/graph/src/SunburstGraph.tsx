"use client";

import * as d3 from "d3";
import React, { useEffect, useRef, useState, useCallback } from "react";
import type { RefObject } from "react";
import type { GraphNode as NewGraphNode, NodeActions } from "./types";
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
}

export interface SunburstGraphProps {
  entityId?: string;
  entityLabel?: string;
  className?: string;
  svgRef?: RefObject<SVGSVGElement>;
}

const TYPE_COLORS: Record<string, string> = {
  vote:           "#3b82f6",
  vote_yes:       "#3b82f6",
  vote_no:        "#ef4444",
  donation:       "#22c55e",
  oversight:      "#a855f7",
  revolving_door: "#f97316",
  appointment:    "#8b5cf6",
  lobbying:       "#eab308",
  co_sponsorship: "#06b6d4",
  other:          "#6b7280",
};

function getColor(typeName: string, depth: number): string {
  const base = TYPE_COLORS[typeName.toLowerCase().replace(/ /g, "_")] ?? "#6b7280";
  if (depth <= 1) return base;
  return base + Math.floor(Math.min(depth - 1, 3) * 20).toString(16).padStart(2, "0");
}

type D3HierarchyNode = d3.HierarchyRectangularNode<SunburstNode>;

/** Map a sunburst node to NewGraphNode for popup (if it has an entityId) */
function arcToNode(d: D3HierarchyNode): NewGraphNode | null {
  const data = d.data;
  if (!data.entityId) return null;

  const type: NewGraphNode['type'] =
    data.entityType === 'official'  ? 'official'  :
    data.entityType === 'proposal'  ? 'proposal'  :
    data.entityType === 'agency'    ? 'agency'    : 'organization';

  return {
    id:           data.entityId,
    name:         data.name,
    type,
    donationTotal: data.value && data.type === 'donation' ? data.value : undefined,
  };
}

/** Always produce a tooltip node for any arc */
function arcToTooltipNode(d: D3HierarchyNode): NewGraphNode {
  return {
    id:           d.data.entityId ?? d.data.name,
    name:         d.data.name,
    type:         d.data.entityType === 'official' ? 'official'
                : d.data.entityType === 'proposal' ? 'proposal'
                : 'organization',
    donationTotal: d.data.value && d.data.type === 'donation' ? d.data.value : undefined,
  };
}

export function SunburstGraph({ entityId, entityLabel, className = "", svgRef: externalSvgRef }: SunburstGraphProps) {
  const containerRef   = useRef<HTMLDivElement>(null);
  const internalSvgRef = useRef<SVGSVGElement>(null);
  const svgRef         = externalSvgRef ?? internalSvgRef;

  const [status, setStatus] = useState<"idle" | "loading" | "empty" | "error" | "ok">("idle");
  const [breadcrumbs, setBreadcrumbs] = useState<string[]>([]);
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

  const render = useCallback((root: D3HierarchyNode, width: number, height: number) => {
    const svg = svgRef.current;
    if (!svg) return;

    d3.select(svg).selectAll("*").remove();

    const radius = Math.min(width, height) / 2;

    const g = d3.select(svg)
      .attr("width", width)
      .attr("height", height)
      .append("g")
      .attr("transform", `translate(${width / 2},${height / 2})`);

    const partition = d3.partition<SunburstNode>().size([2 * Math.PI, radius]);
    partition(root);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const arc = d3.arc<D3HierarchyNode>()
      .startAngle((d) => d.x0)
      .endAngle((d) => d.x1)
      .padAngle((d) => Math.min((d.x1 - d.x0) / 2, 0.005))
      .padRadius(radius / 2)
      .innerRadius((d) => d.y0)
      .outerRadius((d) => d.y1 - 1) as any;

    g.selectAll("path")
      .data(root.descendants().slice(1))
      .join("path")
      .attr("fill", (d) => {
        let ancestor = d;
        while (ancestor.depth > 1) ancestor = ancestor.parent!;
        const typeName = ancestor.data.type ?? ancestor.data.name ?? "other";
        return getColor(typeName, d.depth);
      })
      .attr("fill-opacity", (d) => (d.x1 - d.x0 > 0.001 ? 0.8 : 0))
      .attr("stroke", "#111827")
      .attr("stroke-width", 0.5)
      .attr("d", arc)
      .style("cursor", (d) => (d.children || d.data.entityId ? "pointer" : "default"))
      .on("mouseover", (event: MouseEvent, d) => {
        if (containerRef.current) {
          const rect = containerRef.current.getBoundingClientRect();
          const angle = (d.x0 + d.x1) / 2 - Math.PI / 2;
          const r = (d.y0 + d.y1) / 2;
          const x = width / 2 + r * Math.cos(angle);
          const y = height / 2 + r * Math.sin(angle);
          showTip(arcToTooltipNode(d), x, y);
        }
        void event;
      })
      .on("mouseout", () => hideTip())
      .on("click", (_event: MouseEvent, d) => {
        // If it has an entityId → popup
        const newNode = arcToNode(d);
        if (newNode) {
          setPopup(newNode);
          return;
        }
        // Otherwise zoom in if it has children
        if (d.children) zoom(d, width, height);
      });

    // Center label
    g.append("text")
      .attr("text-anchor", "middle")
      .attr("dy", "0.35em")
      .attr("fill", "#e5e7eb")
      .attr("font-size", "12px")
      .attr("font-weight", "600")
      .text(root.data.name.length > 20 ? root.data.name.slice(0, 18) + "…" : root.data.name);

    // Click center to zoom out
    g.append("circle")
      .attr("r", root.descendants()[0]?.y1 ?? 40)
      .attr("fill", "transparent")
      .style("cursor", currentRootRef.current !== rootRef.current ? "zoom-out" : "default")
      .on("click", () => {
        if (rootRef.current && currentRootRef.current !== rootRef.current) {
          zoom(rootRef.current, width, height);
        }
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svgRef, showTip, hideTip]);

  // Keep renderRef current so effects can call the latest render without adding it to deps
  useEffect(() => { renderRef.current = render; });

  function zoom(node: D3HierarchyNode, width: number, height: number) {
    currentRootRef.current = node;
    const crumbs: string[] = [];
    let cur: D3HierarchyNode | null = node;
    while (cur) { crumbs.unshift(cur.data.name); cur = cur.parent ?? null; }
    setBreadcrumbs(crumbs);
    render(node, width, height);
  }

  useEffect(() => {
    if (!entityId) { setStatus("idle"); return; }

    const controller = new AbortController();

    async function load() {
      // Serve from cache if available
      const cached = cacheRef.current.get(entityId!);
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
        setStatus("ok");
        renderRef.current?.(partitioned, w, h);
        return;
      }

      setStatus("loading");
      try {
        const url = `/api/graph/sunburst?entityId=${encodeURIComponent(entityId!)}` +
          (entityLabel ? `&entityLabel=${encodeURIComponent(entityLabel)}` : "");
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json() as SunburstNode & { error?: string };

        if (json.error) throw new Error(json.error);
        if (!json.children || json.children.length === 0) { setStatus("empty"); return; }

        cacheRef.current.set(entityId!, json);

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
        setStatus("ok");
        renderRef.current?.(partitioned, w, h);
      } catch (err) {
        if ((err as Error).name !== "AbortError") setStatus("error");
      }
    }

    void load();
    return () => { controller.abort(); };
  // render is intentionally excluded — renderRef.current always holds the latest version
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId]);

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
      {/* Breadcrumb trail */}
      {status === "ok" && breadcrumbs.length > 0 && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 bg-gray-900/80 border border-gray-800 rounded-full px-3 py-1">
          {breadcrumbs.map((crumb, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span className="text-gray-600 text-xs">›</span>}
              <span className="text-xs text-gray-300">{crumb}</span>
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
