"use client";

import * as d3 from "d3";
import React, { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { GraphNode as NewGraphNode, NodeActions, ChordOptions } from "./types";
import { Tooltip, useTooltip } from "./components/Tooltip";
import { NodePopup } from "./components/NodePopup";

interface DynamicGroup {
  label: string;
  icon: string;
  color: string;
  kind: "donor" | "recipient";
}

interface RawGroup {
  id: string;
  label: string;
  icon?: string;
  total_usd: number;
  pac_count: number;
}

interface RawRecipient {
  id: string;
  label: string;
  total_received_usd: number;
  official_count: number;
}

export interface ChordGraphProps {
  className?: string;
  svgRef?: RefObject<SVGSVGElement>;
  vizOptions?: Partial<ChordOptions>;
  primaryEntityId?: string | null;
}

// Industry arc colors — enough for up to 13 industries
const INDUSTRY_COLORS = [
  "#ec4899", "#f97316", "#06b6d4", "#6366f1", "#64748b",
  "#a78bfa", "#fbbf24", "#4ade80", "#94a3b8", "#f43f5e",
  "#10b981", "#8b5cf6", "#0ea5e9",
];

// Party arc colors keyed to API party_chamber values
const PARTY_COLORS: Record<string, string> = {
  dem_senate:  "#3b82f6",
  rep_senate:  "#ef4444",
  dem_house:   "#2563eb",
  rep_house:   "#dc2626",
  independent: "#a855f7",
};

function formatDollars(usd: number): string {
  if (usd >= 1_000_000_000) return `$${(usd / 1_000_000_000).toFixed(1)}B`;
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(0)}K`;
  return `$${usd.toFixed(0)}`;
}

function draw(
  svgEl: SVGSVGElement,
  squareMatrix: number[][],
  allGroups: DynamicGroup[],
  width: number,
  height: number,
  showLabels: boolean,
  onGroupHover: (index: number, x: number, y: number) => void,
  onGroupLeave: () => void,
  onGroupClick: (index: number) => void
) {
  d3.select(svgEl).selectAll("*").remove();

  if (width < 100 || height < 100) {
    d3.select(svgEl)
      .attr("width", width)
      .attr("height", height)
      .append("text")
      .attr("x", width / 2)
      .attr("y", height / 2)
      .attr("text-anchor", "middle")
      .attr("fill", "#9ca3af")
      .attr("font-size", "12px")
      .text("Expand panel to see chord diagram");
    return;
  }

  const size   = Math.min(width, height);
  const outerR = Math.max(10, size / 2 - 80);
  const innerR = Math.max(5, outerR - 24);

  const g = d3.select(svgEl)
    .attr("width", width)
    .attr("height", height)
    .append("g")
    .attr("transform", `translate(${width / 2},${height / 2})`);

  const chord  = d3.chord().padAngle(0.05).sortSubgroups(d3.descending);
  const chords = chord(squareMatrix);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const arc    = d3.arc<d3.ChordGroup>().innerRadius(innerR).outerRadius(outerR) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ribbon = d3.ribbon<d3.Chord, d3.ChordSubgroup>().radius(innerR) as any;

  const group = g.append("g")
    .selectAll("g")
    .data(chords.groups)
    .join("g");

  group.append("path")
    .attr("fill", (d) => allGroups[d.index]?.color ?? "#6b7280")
    .attr("stroke", "#111827")
    .attr("stroke-width", 1)
    .attr("d", arc)
    .style("cursor", "pointer")
    .on("mouseover", (event: MouseEvent, d) => {
      const rect = svgEl.getBoundingClientRect();
      const angle = (d.startAngle + d.endAngle) / 2 - Math.PI / 2;
      const r = (innerR + outerR) / 2;
      const x = width / 2 + r * Math.cos(angle);
      const y = height / 2 + r * Math.sin(angle);
      onGroupHover(d.index, x + rect.left - rect.left, y + rect.top - rect.top);
      g.selectAll("path.ribbon")
        .style("opacity", (rd: unknown) => {
          const r = rd as d3.Chord;
          return r.source.index === d.index || r.target.index === d.index ? 0.9 : 0.1;
        });
    })
    .on("mouseout", () => {
      onGroupLeave();
      g.selectAll("path.ribbon").style("opacity", 0.7);
    })
    .on("click", (_event: MouseEvent, d) => {
      onGroupClick(d.index);
    });

  if (showLabels) {
    group.append("text")
      .each((d) => { (d as d3.ChordGroup & { angle: number }).angle = (d.startAngle + d.endAngle) / 2; })
      .attr("dy", "0.35em")
      .attr("transform", (d) => {
        const angle  = (d.startAngle + d.endAngle) / 2;
        const rotate = (angle * 180) / Math.PI - 90;
        const flip   = angle > Math.PI;
        return `rotate(${rotate}) translate(${outerR + 8},0)${flip ? " rotate(180)" : ""}`;
      })
      .attr("text-anchor", (d) => ((d.startAngle + d.endAngle) / 2 > Math.PI ? "end" : "start"))
      .attr("fill", "#9ca3af")
      .attr("font-size", "10px")
      .text((d) => {
        const grp = allGroups[d.index];
        return grp ? `${grp.icon} ${grp.label}`.trim() : `Group ${d.index}`;
      });
  }

  g.append("g")
    .attr("fill-opacity", 0.7)
    .selectAll("path")
    .data(chords)
    .join("path")
    .attr("class", "ribbon")
    .attr("d", ribbon)
    .attr("fill", (d) => allGroups[d.source.index]?.color ?? "#6b7280")
    .attr("stroke", "#111827")
    .attr("stroke-width", 0.5)
    .style("cursor", "pointer")
    .on("mouseover", (_event: MouseEvent, d) => {
      const src = allGroups[d.source.index];
      const tgt = allGroups[d.target.index];
      // Show tooltip at center of SVG for ribbons
      const rect = svgEl.getBoundingClientRect();
      onGroupHover(d.source.index, rect.width / 2, rect.height / 2);
      void tgt; void src; // used in label below
      g.selectAll("path.ribbon")
        .style("opacity", (rd: unknown) => rd === d ? 1 : 0.1);
    })
    .on("mouseout", () => {
      onGroupLeave();
      g.selectAll("path.ribbon").style("opacity", 0.7);
    });
}

// ── Chart data stored in state ─────────────────────────────────────────────────

interface ChartData {
  square:     number[][];
  allGroups:  DynamicGroup[];
  rawGroups:  RawGroup[];
  rawRecipients: RawRecipient[];
}

export function ChordGraph({ className = "", svgRef: externalSvgRef, vizOptions, primaryEntityId }: ChordGraphProps) {
  const containerRef  = useRef<HTMLDivElement>(null);
  const internalSvgRef = useRef<SVGSVGElement>(null);
  const svgRef        = externalSvgRef ?? internalSvgRef;
  const lastSizeRef   = useRef({ w: 0, h: 0 });

  const [status,    setStatus]    = useState<"loading" | "empty" | "error" | "ok">("loading");
  const [rawData,   setRawData]   = useState<{ groups: RawGroup[]; recipients: RawRecipient[]; matrix: number[][] } | null>(null);
  const [chartData, setChartData] = useState<ChartData | null>(null);
  const [entityName, setEntityName] = useState<string | null>(null);

  const { tooltip, show: showTip, hide: hideTip } = useTooltip();
  const [popup, setPopup] = useState<NewGraphNode | null>(null);

  // Map a chord group index → NewGraphNode for Tooltip/NodePopup
  const groupToNode = (i: number, data: ChartData): NewGraphNode => {
    if (i < data.rawGroups.length) {
      const g = data.rawGroups[i]!;
      return {
        id:              g.id,
        name:            g.label,
        type:            'financial',
        connectionCount: g.pac_count,
        donationTotal:   g.total_usd * 100,
      };
    }
    const r = data.rawRecipients[i - data.rawGroups.length];
    if (!r) return { id: String(i), name: `Group ${i}`, type: 'organization' };
    return {
      id:              r.id,
      name:            r.label,
      type:            'official',
      connectionCount: r.official_count,
      donationTotal:   r.total_received_usd * 100,
    };
  };

  // ── Effect 1: Fetch raw data ──────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setStatus("loading");
      setEntityName(null);
      try {
        const minFlow = vizOptions?.minFlowUsd ?? 0;
        const url = primaryEntityId
          ? `/api/graph/chord?entityId=${encodeURIComponent(primaryEntityId)}&minFlowUsd=${minFlow}`
          : `/api/graph/chord?minFlowUsd=${minFlow}`;

        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const json = await res.json() as {
          groups?:     RawGroup[];
          recipients?: RawRecipient[];
          matrix?:     number[][];
          error?: string;
        };

        if (cancelled) return;

        if (json.error || !json.groups?.length || !json.matrix?.length) {
          setStatus("empty");
          return;
        }

        if (!cancelled) {
          // In entity mode the single recipient label is the official's name
          if (primaryEntityId && json.recipients?.[0]?.label) {
            setEntityName(json.recipients[0].label);
          }
          setRawData({
            groups:     json.groups,
            recipients: json.recipients ?? [],
            matrix:     json.matrix,
          });
        }
      } catch (err) {
        console.error('[ChordGraph] fetch error:', err);
        if (!cancelled) setStatus("error");
      }
    }

    void load();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryEntityId]);

  // ── Effect 2: Apply vizOptions to raw data → chartData ───────────────────
  useEffect(() => {
    if (!rawData) return;

    const minFlow      = vizOptions?.minFlowUsd ?? 0;
    const normalizeMode = vizOptions?.normalizeMode ?? false;

    // Filter groups by minFlowUsd
    const filteredGroups = minFlow > 0
      ? rawData.groups.filter(g => g.total_usd >= minFlow)
      : rawData.groups;

    // If all groups filtered out, show empty state
    if (filteredGroups.length === 0) {
      setStatus("empty");
      return;
    }

    // Build index map: original group index → new filtered index
    const originalIndices = filteredGroups.map(g => rawData.groups.indexOf(g));

    const recipients = rawData.recipients;

    const allGroups: DynamicGroup[] = [
      ...filteredGroups.map((g, i) => ({
        label: g.label,
        icon:  g.icon ?? "🏢",
        color: INDUSTRY_COLORS[i % INDUSTRY_COLORS.length] ?? "#94a3b8",
        kind:  "donor" as const,
      })),
      ...recipients.map((r) => ({
        label: r.label,
        icon:  "",
        color: PARTY_COLORS[r.id] ?? "#6b7280",
        kind:  "recipient" as const,
      })),
    ];

    // Rebuild matrix using only filtered groups
    const N = filteredGroups.length + recipients.length;
    let rawMatrix: number[][] = Array.from({ length: N }, () => Array(N).fill(0) as number[]);

    originalIndices.forEach((origI, newI) => {
      const row = rawData.matrix[origI];
      if (!row) return;
      row.forEach((val, j) => {
        const partyIdx = filteredGroups.length + j;
        const rowN = rawMatrix[newI];
        const rowP = rawMatrix[partyIdx];
        if (rowN) rowN[partyIdx] = val;
        if (rowP) rowP[newI] = val;
      });
    });

    // Apply normalizeMode: normalize each donor row to 100%
    const square = normalizeMode
      ? rawMatrix.map(row => {
          const total = row.reduce((s, v) => s + v, 0);
          return total === 0 ? row : row.map(v => v / total);
        })
      : rawMatrix;

    setChartData({ square, allGroups, rawGroups: filteredGroups, rawRecipients: recipients });
    setStatus("ok");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawData, vizOptions?.minFlowUsd, vizOptions?.normalizeMode]);

  // ── Effect 3: Draw ────────────────────────────────────────────────────────
  useEffect(() => {
    if (status !== "ok" || !chartData) return;
    const svgEl = svgRef.current;
    if (!svgEl) return;

    const container = containerRef.current;
    const { width, height } = container
      ? container.getBoundingClientRect()
      : { width: 600, height: 500 };

    draw(
      svgEl,
      chartData.square,
      chartData.allGroups,
      width || 600,
      height || 500,
      vizOptions?.showLabels ?? true,
      (index, x, y) => showTip(groupToNode(index, chartData), x, y),
      hideTip,
      (index) => setPopup(groupToNode(index, chartData))
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, chartData, vizOptions?.showLabels, svgRef]);

  // ── Resize observer ───────────────────────────────────────────────────────
  useEffect(() => {
    if (status !== "ok" || !chartData) return;
    const container = containerRef.current;
    if (!container) return;

    const obs = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || !svgRef.current) return;
      const w = Math.floor(entry.contentRect.width);
      const h = Math.floor(entry.contentRect.height);
      if (w === lastSizeRef.current.w && h === lastSizeRef.current.h) return;
      lastSizeRef.current = { w, h };
      if (w > 0 && h > 0) {
        draw(
          svgRef.current,
          chartData.square,
          chartData.allGroups,
          w,
          h,
          vizOptions?.showLabels ?? true,
          (index, x, y) => showTip(groupToNode(index, chartData), x, y),
          hideTip,
          (index) => setPopup(groupToNode(index, chartData))
        );
      }
    });

    obs.observe(container);
    return () => obs.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, chartData, vizOptions?.showLabels, svgRef]);

  // NodeActions for chord — no recenter/comparison (groups aren't individual officials)
  const nodeActions: NodeActions = {
    recenter:         () => {},
    openProfile:      (nodeId) => window.open(`/officials/${nodeId}`, "_blank"),
    addToComparison:  () => {},
    expandNode:       () => {},
  };

  return (
    <div ref={containerRef} className={`relative w-full h-full flex items-center justify-center ${className}`}>
      {status === "loading" && (
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" />
          <p className="text-gray-500 text-sm">Loading donation flows…</p>
        </div>
      )}

      {status === "error" && (
        <div className="text-center">
          <p className="text-red-400 text-sm">Failed to load chord data.</p>
          <button
            onClick={() => window.location.reload()}
            className="mt-3 text-xs text-indigo-400 hover:underline"
          >
            Retry
          </button>
        </div>
      )}

      {status === "empty" && (
        <div className="text-center max-w-sm px-8 py-10 rounded-2xl bg-gray-900/80 border border-gray-800">
          <div className="w-10 h-10 mx-auto mb-4 rounded-full border border-gray-700 flex items-center justify-center">
            <svg className="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <p className="text-gray-300 text-sm font-medium">No donation flow data available.</p>
          <p className="text-gray-500 text-xs mt-2 leading-relaxed">
            Data is being processed. Industry-to-party donation flows will appear here once the pipeline completes.
          </p>
        </div>
      )}

      {status === "ok" && (
        <>
          <svg id="chord-diagram-svg" ref={svgRef} className="w-full h-full" />
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
            <span className="text-xs text-gray-400 bg-gray-950/70 px-2 py-0.5 rounded-full">
              {primaryEntityId && entityName
                ? `${entityName}'s Industry Donors`
                : "Industry → Party Flows"}
            </span>
          </div>
        </>
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
        vizType="chord"
      />
    </div>
  );
}
