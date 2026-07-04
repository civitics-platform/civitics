"use client";

/**
 * packages/graph/src/GanttGraph.tsx — FIX-217
 *
 * Per-position tenure bars for an agency. Reads
 * /api/graph/leadership-tenure?agencyId=X — each row carries start_date,
 * end_date, position_title, official_name, party. Bars colored by party,
 * solid stroke for current incumbents, dashed for past.
 *
 * Powers the "Leadership Tenure" preset.
 */

import { useEffect, useRef, useState } from "react";
import * as d3 from "d3";
import type { RefObject } from "react";
import type { GanttOptions } from "./types";
import { resolveToken, resolveColor } from "./tokens";

// ── Types ─────────────────────────────────────────────────────────────────────

interface TenureRow {
  officialId: string;
  officialName: string;
  positionTitle: string;
  startDate: string | null;     // ISO; null = unknown start
  endDate: string | null;       // ISO; null = current
  isCurrent: boolean;
  party: string | null;
}

export interface GanttGraphProps {
  className?: string;
  svgRef?: RefObject<SVGSVGElement>;
  vizOptions?: Partial<GanttOptions>;
  primaryEntityId?: string | null;   // agency id
  primaryEntityName?: string | null;
}

// Party color — token strings (FIX-729); wine (viz-7) stands in for
// independents (no purple in the token system). Wrap with
// resolveColor(…, svgEl) at d3 .attr() sites.
function partyColor(p: string | null): string {
  switch ((p ?? "").toLowerCase()) {
    case "democrat":    return "rgb(var(--c-blue))";
    case "republican":  return "rgb(var(--c-accent))";
    case "independent": return "rgb(var(--c-viz-7))";
    default:            return "rgb(var(--c-ink-soft))";
  }
}

export function GanttGraph({
  className = "",
  svgRef: externalSvgRef,
  vizOptions,
  primaryEntityId,
  primaryEntityName,
}: GanttGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const internalRef  = useRef<SVGSVGElement>(null);
  const svgRef       = externalSvgRef ?? internalRef;

  const [rows, setRows] = useState<TenureRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const groupBy     = vizOptions?.groupBy     ?? "position_title";
  const showCurrent = vizOptions?.showCurrent ?? true;
  const showLabels  = vizOptions?.showLabels  ?? true;

  useEffect(() => {
    if (!primaryEntityId) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    fetch(`/api/graph/leadership-tenure?agencyId=${encodeURIComponent(primaryEntityId)}`)
      .then(r => r.json())
      .then((data: TenureRow[] | { error: string }) => {
        if ("error" in data) throw new Error(data.error);
        setRows(data as TenureRow[]);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [primaryEntityId]);

  useEffect(() => {
    if (!svgRef.current || rows.length === 0) return;
    const svgEl = svgRef.current;
    const svg = d3.select(svgEl);
    svg.selectAll("*").remove();

    // SVG presentation attributes can't carry var() — resolve tokens to
    // concrete colors against the svg's scope at draw time (FIX-729).
    const T = {
      ink:     resolveToken("--c-ink", svgEl),
      inkSoft: resolveToken("--c-ink-soft", svgEl),
      amber:   resolveToken("--c-amber", svgEl),
      termBg:  resolveToken("--c-term-bg", svgEl),
    };

    const visible = showCurrent ? rows : rows.filter(r => !r.isCurrent);
    if (visible.length === 0) return;

    const container = containerRef.current;
    const width  = container?.clientWidth  ?? 800;
    const height = Math.max(container?.clientHeight ?? 600, visible.length * 22 + 80);
    const margin = { top: 40, right: 40, bottom: 30, left: 220 };
    const innerW = width  - margin.left - margin.right;
    const innerH = height - margin.top  - margin.bottom;

    // Date domain
    const parseDate = (s: string | null): Date | null => (s ? new Date(s) : null);
    const allStarts = visible.map(r => parseDate(r.startDate)).filter(Boolean) as Date[];
    const allEnds   = visible.map(r => parseDate(r.endDate) ?? new Date()).filter(Boolean) as Date[];
    const minDate = d3.min(allStarts) ?? new Date(2000, 0, 1);
    const maxDate = d3.max(allEnds)   ?? new Date();

    const xScale = d3.scaleTime().domain([minDate, maxDate]).range([0, innerW]);

    // Group rows by position title (default) → one row per group/official
    const grouped = d3.groups(visible, r => groupBy === "official" ? r.officialName : r.positionTitle);
    const yLabels = grouped.map(([k]) => k);
    const yScale  = d3.scaleBand().domain(yLabels).range([0, innerH]).padding(0.25);

    const g = svg
      .attr("viewBox", `0 0 ${width} ${height}`)
      .append("g")
      .attr("transform", `translate(${margin.left},${margin.top})`);

    // X axis — top
    g.append("g")
      .attr("transform", `translate(0,-10)`)
      .call(d3.axisTop(xScale).ticks(8))
      .selectAll("text").attr("fill", T.inkSoft);

    // Y labels — left
    g.append("g")
      .selectAll("text")
      .data(yLabels)
      .join("text")
      .attr("x", -10)
      .attr("y", d => (yScale(d) ?? 0) + (yScale.bandwidth() / 2) + 4)
      .attr("text-anchor", "end")
      .attr("fill", T.ink)
      .attr("font-size", 11)
      .text(d => d.length > 28 ? `${d.slice(0, 26)}…` : d);

    // Bars
    grouped.forEach(([groupKey, items]) => {
      const y = yScale(groupKey) ?? 0;
      g.selectAll(`rect.tenure-${cssSafe(groupKey)}`)
        .data(items)
        .join("rect")
        .attr("class", `tenure-${cssSafe(groupKey)}`)
        .attr("x", d => xScale(parseDate(d.startDate) ?? minDate))
        .attr("y", y)
        .attr("width", d => Math.max(2, xScale(parseDate(d.endDate) ?? new Date()) - xScale(parseDate(d.startDate) ?? minDate)))
        .attr("height", yScale.bandwidth())
        .attr("fill", d => resolveColor(partyColor(d.party), svgEl))
        .attr("fill-opacity", d => d.isCurrent ? 0.85 : 0.55)
        .attr("stroke", d => d.isCurrent ? T.amber : "transparent")
        .attr("stroke-width", d => d.isCurrent ? 1.5 : 0)
        .attr("stroke-dasharray", d => d.isCurrent ? "0" : "0")
        .style("cursor", "pointer")
        .append("title")
        .text(d =>
          `${d.officialName}\n` +
          `${d.positionTitle}\n` +
          `${d.startDate ?? "?"} → ${d.endDate ?? "present"}` +
          (d.isCurrent ? " (current)" : "")
        );

      // Inline labels (official name) when bar is wide enough
      if (showLabels) {
        g.selectAll(`text.lbl-${cssSafe(groupKey)}`)
          .data(items)
          .join("text")
          .attr("class", `lbl-${cssSafe(groupKey)}`)
          .attr("x", d => xScale(parseDate(d.startDate) ?? minDate) + 4)
          .attr("y", y + (yScale.bandwidth() / 2) + 3)
          .attr("font-size", 9)
          .attr("fill", T.termBg)
          .text(d => {
            const start = parseDate(d.startDate) ?? minDate;
            const end   = parseDate(d.endDate) ?? new Date();
            const widthPx = xScale(end) - xScale(start);
            return widthPx > 80 ? d.officialName : "";
          });
      }
    });

    // Title
    if (primaryEntityName) {
      svg.append("text")
        .attr("x", margin.left)
        .attr("y", 18)
        .attr("font-size", 13)
        .attr("font-weight", 600)
        .attr("fill", T.ink)
        .text(`${primaryEntityName} — Leadership Tenure`);
    }
  }, [rows, groupBy, showCurrent, showLabels, primaryEntityName, svgRef]);

  if (!primaryEntityId) {
    return (
      <div className={`flex items-center justify-center h-full text-ink-soft text-sm ${className}`}>
        Add an agency to view its leadership tenure
      </div>
    );
  }
  if (error) {
    return (
      <div className={`flex items-center justify-center h-full text-accent text-sm ${className}`}>
        Tenure error: {error}
      </div>
    );
  }
  if (loading) {
    return (
      <div className={`flex items-center justify-center h-full text-ink-soft text-sm ${className}`}>
        Loading appointment data…
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className={`flex items-center justify-center h-full text-ink-soft text-sm ${className}`}>
        No leadership data on file for this agency
      </div>
    );
  }

  return (
    <div ref={containerRef} className={`w-full h-full overflow-auto ${className}`}>
      <svg id="gantt-svg" ref={svgRef} className="w-full" style={{ minHeight: "100%" }} />
    </div>
  );
}

function cssSafe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}
