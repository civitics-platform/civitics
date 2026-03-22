"use client";

import * as d3 from "d3";
import React, { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

interface DynamicGroup {
  label: string;
  icon: string;
  color: string;
  kind: "donor" | "recipient";
}

export interface ChordGraphProps {
  className?: string;
  svgRef?: RefObject<SVGSVGElement>;
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

type Tooltip = { x: number; y: number; html: string } | null;

function formatDollars(usd: number): string {
  if (usd >= 1_000_000_000) return `$${(usd / 1_000_000_000).toFixed(1)}B`;
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(0)}K`;
  return `$${usd.toFixed(0)}`;
}

function draw(
  svgEl: SVGSVGElement,
  containerEl: HTMLDivElement,
  squareMatrix: number[][],
  allGroups: DynamicGroup[],
  width: number,
  height: number,
  setTooltip: (t: Tooltip) => void
) {
  d3.select(svgEl).selectAll("*").remove();

  const size = Math.min(width, height);
  const outerR = size / 2 - 80;
  const innerR = outerR - 24;

  const g = d3.select(svgEl)
    .attr("width", width)
    .attr("height", height)
    .append("g")
    .attr("transform", `translate(${width / 2},${height / 2})`);

  const chord = d3.chord()
    .padAngle(0.05)
    .sortSubgroups(d3.descending);

  const chords = chord(squareMatrix);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const arc = d3.arc<d3.ChordGroup>()
    .innerRadius(innerR)
    .outerRadius(outerR) as any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ribbon = d3.ribbon<d3.Chord, d3.ChordSubgroup>()
    .radius(innerR) as any;

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
    .on("mouseover", (_event, d) => {
      const grp = allGroups[d.index];
      const row = squareMatrix[d.index];
      const total = row ? row.reduce((sum, v) => sum + v, 0) : 0;
      const rect = containerEl.getBoundingClientRect();
      const angle = (d.startAngle + d.endAngle) / 2 - Math.PI / 2;
      const r = (innerR + outerR) / 2;
      const x = width / 2 + r * Math.cos(angle);
      const y = height / 2 + r * Math.sin(angle);
      setTooltip({
        x: x + rect.left,
        y: y + rect.top,
        html: `<strong>${grp?.icon ?? ""} ${grp?.label ?? `Group ${d.index}`}</strong><br/>${formatDollars(total)} total`,
      });
      g.selectAll("path.ribbon")
        .style("opacity", (rd: unknown) => {
          const r = rd as d3.Chord;
          return r.source.index === d.index || r.target.index === d.index ? 0.9 : 0.1;
        });
    })
    .on("mouseout", () => {
      setTooltip(null);
      g.selectAll("path.ribbon").style("opacity", 0.7);
    });

  group.append("text")
    .each((d) => { (d as d3.ChordGroup & { angle: number }).angle = (d.startAngle + d.endAngle) / 2; })
    .attr("dy", "0.35em")
    .attr("transform", (d) => {
      const angle = (d.startAngle + d.endAngle) / 2;
      const rotate = (angle * 180) / Math.PI - 90;
      const flip = angle > Math.PI;
      return `rotate(${rotate}) translate(${outerR + 8},0)${flip ? " rotate(180)" : ""}`;
    })
    .attr("text-anchor", (d) => ((d.startAngle + d.endAngle) / 2 > Math.PI ? "end" : "start"))
    .attr("fill", "#9ca3af")
    .attr("font-size", "10px")
    .text((d) => {
      const grp = allGroups[d.index];
      return grp ? `${grp.icon} ${grp.label}`.trim() : `Group ${d.index}`;
    });

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
    .on("mouseover", (_event, d) => {
      const src = allGroups[d.source.index];
      const tgt = allGroups[d.target.index];
      const rect = containerEl.getBoundingClientRect();
      setTooltip({
        x: rect.left + width / 2,
        y: rect.top + height / 2,
        html: `<strong>${src?.label ?? "?"}</strong> → <strong>${tgt?.label ?? "?"}</strong><br/>${formatDollars(d.source.value)}`,
      });
      g.selectAll("path.ribbon")
        .style("opacity", (rd: unknown) => rd === d ? 1 : 0.1);
    })
    .on("mouseout", () => {
      setTooltip(null);
      g.selectAll("path.ribbon").style("opacity", 0.7);
    });
}

export function ChordGraph({ className = "", svgRef: externalSvgRef }: ChordGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const internalSvgRef = useRef<SVGSVGElement>(null);
  const svgRef = externalSvgRef ?? internalSvgRef;
  const [status, setStatus] = useState<"loading" | "empty" | "error" | "ok">("loading");
  const [tooltip, setTooltip] = useState<Tooltip>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setStatus("loading");
      try {
        const res = await fetch("/api/graph/chord");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json() as {
          groups?: { id: string; label: string; icon: string }[];
          recipients?: { id: string; label: string }[];
          matrix?: number[][];
          error?: string;
        };

        // Diagnostic: log API shape to confirm groups/recipients/matrix structure.
        // Remove once chord is confirmed working in production.
        console.log('[ChordGraph] data:', json);

        if (cancelled) return;

        // API returns { groups, recipients, matrix } — not { data }
        if (json.error || !json.groups?.length || !json.matrix?.length) {
          setStatus("empty");
          return;
        }

        const groups = json.groups;
        const recipients = json.recipients ?? [];
        const rawMatrix = json.matrix;

        // Build dynamic group metadata for all arcs (industries first, then parties)
        const allGroups: DynamicGroup[] = [
          ...groups.map((g, i) => ({
            label: g.label,
            icon: g.icon ?? "🏢",
            color: INDUSTRY_COLORS[i % INDUSTRY_COLORS.length] ?? "#94a3b8",
            kind: "donor" as const,
          })),
          ...recipients.map((r) => ({
            label: r.label,
            icon: "",
            color: PARTY_COLORS[r.id] ?? "#6b7280",
            kind: "recipient" as const,
          })),
        ];

        // Expand 13×4 (industry × party) matrix to NxN square for d3.chord().
        // Industries flow TO parties; parties don't flow to each other.
        // Make symmetric so the chord renders arcs on both sides.
        const N = groups.length + recipients.length;
        const square: number[][] = Array.from({ length: N }, () => Array(N).fill(0) as number[]);
        rawMatrix.forEach((row, i) => {
          row.forEach((val, j) => {
            const partyIdx = groups.length + j;
            const rowI = square[i];
            const rowP = square[partyIdx];
            if (rowI) rowI[partyIdx] = val;
            if (rowP) rowP[i] = val;
          });
        });

        setStatus("ok");
        const container = containerRef.current;
        const svgEl = svgRef.current;
        if (!container || !svgEl) return;
        const { width, height } = container.getBoundingClientRect();
        draw(svgEl, container, square, allGroups, width || 600, height || 500, setTooltip);
      } catch {
        if (!cancelled) setStatus("error");
      }
    }

    load();
    return () => { cancelled = true; };
  }, [svgRef]);

  // Resize: just update SVG dimensions (re-fetch would flash the viz)
  useEffect(() => {
    if (status !== "ok") return;
    const container = containerRef.current;
    if (!container) return;

    const obs = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (svgRef.current) {
        d3.select(svgRef.current).attr("width", width).attr("height", height);
      }
    });

    obs.observe(container);
    return () => obs.disconnect();
  }, [status, svgRef]);

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
        <svg id="chord-diagram-svg" ref={svgRef} className="w-full h-full" />
      )}

      {tooltip && (
        <div
          className="fixed z-50 pointer-events-none bg-gray-900 border border-gray-700 rounded px-3 py-2 text-xs text-gray-200 shadow-xl"
          style={{
            left: tooltip.x + 12,
            top: tooltip.y - 28,
            transform: "translateX(-50%)",
          }}
          dangerouslySetInnerHTML={{ __html: tooltip.html }}
        />
      )}
    </div>
  );
}
