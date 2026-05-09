"use client";

/**
 * packages/graph/src/ScatterGraph.tsx — FIX-217
 *
 * Agency scatter plot. Plots agencies on configurable X/Y axes (FTE,
 * appointment count, contract total). Bubble size encodes one of those
 * dimensions, color groups by agency type. Highlights the focused agency
 * when primaryEntityId is set.
 *
 * Powers the "Agencies by Staffing" preset.
 */

import { useEffect, useRef, useState } from "react";
import * as d3 from "d3";
import type { RefObject } from "react";
import type { ScatterOptions, FocusGroup } from "./types";

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgencyStaffRow {
  agencyId: string;
  agencyName: string;
  agencyAcronym: string | null;
  agencyType: string;
  fte: number;
  appointmentCount: number;
  contractTotal: number;
  grantTotal: number;
  foundedYear: number | null;
}

export interface ScatterGraphProps {
  className?: string;
  svgRef?: RefObject<SVGSVGElement>;
  vizOptions?: Partial<ScatterOptions>;
  primaryEntityId?: string | null;
  primaryGroup?: FocusGroup | null;
}

// ── Color palette by agency type ──────────────────────────────────────────────

const TYPE_COLORS: Record<string, string> = {
  federal:     "#06b6d4",
  independent: "#a855f7",
  cabinet:     "#3b82f6",
  state:       "#22c55e",
  local:       "#f97316",
  default:     "#6b7280",
};

function colorForType(t: string): string {
  return TYPE_COLORS[t] ?? TYPE_COLORS.default!;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ScatterGraph({
  className = "",
  svgRef: externalSvgRef,
  vizOptions,
  primaryEntityId,
}: ScatterGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const internalRef  = useRef<SVGSVGElement>(null);
  const svgRef       = externalSvgRef ?? internalRef;

  const [rows, setRows] = useState<AgencyStaffRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const xAxis     = vizOptions?.xAxis     ?? "fte";
  const yAxis     = vizOptions?.yAxis     ?? "appointment_count";
  const sizeBy    = vizOptions?.sizeBy    ?? "fte";
  const showLabels = vizOptions?.showLabels ?? true;
  const logXAxis  = vizOptions?.logXAxis  ?? true;
  const logYAxis  = vizOptions?.logYAxis  ?? false;

  useEffect(() => {
    setLoading(true);
    fetch("/api/graph/agency-staffing")
      .then(r => r.json())
      .then((data: AgencyStaffRow[] | { error: string }) => {
        if ("error" in data) throw new Error(data.error);
        setRows(data as AgencyStaffRow[]);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!svgRef.current || rows.length === 0) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const container = containerRef.current;
    const width  = container?.clientWidth  ?? 800;
    const height = container?.clientHeight ?? 600;
    const margin = { top: 20, right: 30, bottom: 50, left: 70 };
    const innerW = width  - margin.left - margin.right;
    const innerH = height - margin.top  - margin.bottom;

    const xValue = (r: AgencyStaffRow): number => extractAxis(r, xAxis);
    const yValue = (r: AgencyStaffRow): number => extractAxis(r, yAxis);
    const sValue = (r: AgencyStaffRow): number => extractAxis(r, sizeBy);

    const filtered = rows.filter(r => xValue(r) > 0 && yValue(r) > 0);
    if (filtered.length === 0) return;

    const xExtent = d3.extent(filtered, xValue) as [number, number];
    const yExtent = d3.extent(filtered, yValue) as [number, number];
    const sExtent = d3.extent(filtered, sValue) as [number, number];

    const xScale = (logXAxis ? d3.scaleLog() : d3.scaleLinear())
      .domain(xExtent[0] > 0 ? xExtent : [Math.max(1, xExtent[0]), xExtent[1]])
      .range([0, innerW])
      .nice();
    const yScale = (logYAxis ? d3.scaleLog() : d3.scaleLinear())
      .domain(yExtent[0] > 0 ? yExtent : [Math.max(1, yExtent[0]), yExtent[1]])
      .range([innerH, 0])
      .nice();
    const rScale = d3.scaleSqrt().domain(sExtent).range([3, 22]);

    const g = svg
      .attr("viewBox", `0 0 ${width} ${height}`)
      .append("g")
      .attr("transform", `translate(${margin.left},${margin.top})`);

    // Axes
    g.append("g")
      .attr("transform", `translate(0,${innerH})`)
      .call(d3.axisBottom(xScale).ticks(6, "~s"))
      .selectAll("text").attr("fill", "#94a3b8");
    g.append("g")
      .call(d3.axisLeft(yScale).ticks(6, "~s"))
      .selectAll("text").attr("fill", "#94a3b8");

    // Axis labels
    g.append("text")
      .attr("x", innerW / 2)
      .attr("y", innerH + 38)
      .attr("text-anchor", "middle")
      .attr("fill", "#94a3b8")
      .attr("font-size", 12)
      .text(axisLabel(xAxis));
    g.append("text")
      .attr("transform", `rotate(-90)`)
      .attr("x", -innerH / 2)
      .attr("y", -50)
      .attr("text-anchor", "middle")
      .attr("fill", "#94a3b8")
      .attr("font-size", 12)
      .text(axisLabel(yAxis));

    // Circles
    const dots = g.selectAll<SVGCircleElement, AgencyStaffRow>("circle.agency")
      .data(filtered, d => d.agencyId)
      .join("circle")
      .attr("class", "agency")
      .attr("cx", d => xScale(xValue(d)))
      .attr("cy", d => yScale(yValue(d)))
      .attr("r",  d => rScale(sValue(d)))
      .attr("fill", d => colorForType(d.agencyType))
      .attr("fill-opacity", d => d.agencyId === primaryEntityId ? 0.9 : 0.55)
      .attr("stroke", d => d.agencyId === primaryEntityId ? "#facc15" : "#0f172a")
      .attr("stroke-width", d => d.agencyId === primaryEntityId ? 2.5 : 0.75)
      .style("cursor", "pointer");

    dots.append("title").text(d =>
      `${d.agencyName}\n` +
      `FTE: ${d.fte.toLocaleString()}\n` +
      `Appointments: ${d.appointmentCount}\n` +
      `Contracts: $${(d.contractTotal / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
    );

    // Labels — only top 12 by size to keep readable
    if (showLabels) {
      const top = [...filtered].sort((a, b) => sValue(b) - sValue(a)).slice(0, 12);
      g.selectAll("text.label")
        .data(top, (d: unknown) => (d as AgencyStaffRow).agencyId)
        .join("text")
        .attr("class", "label")
        .attr("x", d => xScale(xValue(d)) + rScale(sValue(d)) + 4)
        .attr("y", d => yScale(yValue(d)) + 3)
        .attr("font-size", 10)
        .attr("fill", "#cbd5e1")
        .text(d => d.agencyAcronym ?? d.agencyName);
    }
  }, [rows, xAxis, yAxis, sizeBy, showLabels, logXAxis, logYAxis, primaryEntityId, svgRef]);

  if (error) {
    return (
      <div className={`flex items-center justify-center h-full text-red-400 text-sm ${className}`}>
        Scatter error: {error}
      </div>
    );
  }
  if (loading) {
    return (
      <div className={`flex items-center justify-center h-full text-gray-400 text-sm ${className}`}>
        Loading agency data…
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className={`flex items-center justify-center h-full text-gray-400 text-sm ${className}`}>
        No agency staffing data available
      </div>
    );
  }

  return (
    <div ref={containerRef} className={`w-full h-full ${className}`}>
      <svg id="scatter-svg" ref={svgRef} className="w-full h-full" />
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractAxis(r: AgencyStaffRow, key: string): number {
  switch (key) {
    case "fte":              return r.fte;
    case "appointment_count": return r.appointmentCount;
    case "contract_total":   return r.contractTotal;
    case "grant_total":      return r.grantTotal;
    case "founded_year":     return r.foundedYear ?? 0;
    default:                 return 0;
  }
}

function axisLabel(key: string): string {
  switch (key) {
    case "fte":              return "FTE Headcount";
    case "appointment_count": return "Political Appointments";
    case "contract_total":   return "Contract Spending (cents)";
    case "grant_total":      return "Grant Spending (cents)";
    case "founded_year":     return "Founded Year";
    default:                 return key;
  }
}
