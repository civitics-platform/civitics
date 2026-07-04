"use client";

/**
 * packages/graph/src/MatrixGraph.tsx
 *
 * Vote-agreement matrix — N×N heatmap of agreement between focused officials.
 * Cell color = agreement % (or Cohen's kappa). Sort by alphabetical, party,
 * or simple greedy cluster reorder. Per FIX-145 / GRAPH_PLAN §5.2.
 *
 * Applicable when ≥2 officials are in focus.
 */

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import * as d3 from "d3";
import type { RefObject } from "react";
import type { MatrixOptions } from "./types";
import { resolveColor, resolveToken } from "./tokens";

// ── Types ─────────────────────────────────────────────────────────────────────

interface MatrixOfficial {
  id: string;
  name: string;
  party: string | null;
  state: string | null;
  chamber: string | null;
}

interface MatrixCell {
  shared: number;
  agreed: number;
  agreement: number | null;
  kappa: number | null;
}

interface MatrixApiResponse {
  officials: MatrixOfficial[];
  cells: MatrixCell[][];
  proposalCount: number;
}

// Token strings (FIX-729) — resolve via resolveColor() at d3 attr sites.
const PARTY_COLORS: Record<string, string> = {
  D: "rgb(var(--c-blue))",
  R: "rgb(var(--c-accent))",
  I: "rgb(var(--c-viz-7))",
  L: "rgb(var(--c-viz-7))",
  G: "rgb(var(--c-green-ink))",
};

function partyColor(party: string | null): string {
  if (!party) return "rgb(var(--c-ink-soft))";
  return PARTY_COLORS[party.toUpperCase().charAt(0)] ?? "rgb(var(--c-ink-soft))";
}

function partyRank(party: string | null): number {
  // Group D first, R second, everything else after — matches how legislatures
  // are usually listed in agreement studies.
  if (!party) return 99;
  const c = party.toUpperCase().charAt(0);
  if (c === "D") return 0;
  if (c === "R") return 1;
  return 2;
}

/**
 * Greedy nearest-neighbour reorder so officials with similar voting records sit
 * next to each other. Not a real hierarchical cluster — D3-only and we don't want
 * to ship a clustering lib for one viz — but visually it does the job.
 */
function clusterOrder(officials: MatrixOfficial[], cells: MatrixCell[][], metric: "agreement" | "kappa"): number[] {
  const N = officials.length;
  if (N <= 2) return officials.map((_, i) => i);

  function score(i: number, j: number): number {
    const c = cells[i]?.[j];
    if (!c) return 0;
    const v = metric === "kappa" ? c.kappa : c.agreement;
    return v ?? 0;
  }

  // Seed with the row whose total agreement is highest — usually a centroid.
  const totals = officials.map((_, i) => {
    let t = 0;
    for (let j = 0; j < N; j++) if (j !== i) t += score(i, j);
    return t;
  });
  let seed = 0;
  for (let i = 1; i < N; i++) if ((totals[i] ?? 0) > (totals[seed] ?? 0)) seed = i;

  const visited = new Set<number>([seed]);
  const order: number[] = [seed];
  while (order.length < N) {
    const last = order[order.length - 1] ?? seed;
    let bestIdx = -1;
    let bestVal = -Infinity;
    for (let j = 0; j < N; j++) {
      if (visited.has(j)) continue;
      const s = score(last, j);
      if (s > bestVal) {
        bestVal = s;
        bestIdx = j;
      }
    }
    if (bestIdx === -1) {
      for (let j = 0; j < N; j++) if (!visited.has(j)) { bestIdx = j; break; }
    }
    if (bestIdx === -1) break;
    visited.add(bestIdx);
    order.push(bestIdx);
  }
  return order;
}

// ── Component ─────────────────────────────────────────────────────────────────

export interface MatrixGraphProps {
  className?: string;
  svgRef?: RefObject<SVGSVGElement>;
  vizOptions?: Partial<MatrixOptions>;
  /** Official UUIDs in current focus. Required (≥2). */
  officialIds: string[];
}

const DEFAULTS: MatrixOptions = {
  sortBy: "party",
  metric: "agreement",
  labelLimit: 12,
};

export function MatrixGraph({
  className = "",
  svgRef: externalSvgRef,
  vizOptions,
  officialIds,
}: MatrixGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const internalSvgRef = useRef<SVGSVGElement>(null);
  const svgRef = externalSvgRef ?? internalSvgRef;

  const [data, setData] = useState<MatrixApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const sortBy = vizOptions?.sortBy ?? DEFAULTS.sortBy;
  const metric = vizOptions?.metric ?? DEFAULTS.metric;
  const labelLimit = vizOptions?.labelLimit ?? DEFAULTS.labelLimit ?? 12;

  // Stable serialised key so refetch only fires when the *set* of ids changes.
  const idsKey = useMemo(() => [...officialIds].sort().join(","), [officialIds]);

  // ── Fetch ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (officialIds.length < 2) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);

    fetch(`/api/graph/matrix?ids=${encodeURIComponent(officialIds.join(","))}`)
      .then((r) => r.json())
      .then((res: MatrixApiResponse | { error: string }) => {
        if ("error" in res) throw new Error(res.error);
        setData(res);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  // ── Sort order ──────────────────────────────────────────────────────────────
  const order = useMemo<number[]>(() => {
    if (!data) return [];
    const officials = data.officials;
    const N = officials.length;
    const indices = Array.from({ length: N }, (_, i) => i);
    if (sortBy === "alphabetical") {
      return indices.sort((a, b) =>
        (officials[a]?.name ?? "").localeCompare(officials[b]?.name ?? ""),
      );
    }
    if (sortBy === "party") {
      return indices.sort((a, b) => {
        const pa = partyRank(officials[a]?.party ?? null);
        const pb = partyRank(officials[b]?.party ?? null);
        if (pa !== pb) return pa - pb;
        return (officials[a]?.name ?? "").localeCompare(officials[b]?.name ?? "");
      });
    }
    return clusterOrder(officials, data.cells, metric);
  }, [data, sortBy, metric]);

  // ── Render ──────────────────────────────────────────────────────────────────
  const render = useCallback(() => {
    const container = containerRef.current;
    const svg = svgRef.current;
    if (!container || !svg || !data) return;

    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width === 0 || height === 0) return;

    d3.select(svg).selectAll("*").remove();
    d3.select(svg).attr("width", width).attr("height", height);

    // SVG presentation attributes can't carry var() — resolve tokens to
    // concrete colors against the svg's scope at draw time (FIX-729).
    const T = {
      bg:       resolveToken("--c-term-bg", svg),
      panel:    resolveToken("--c-term-panel", svg),
      ink:      resolveToken("--c-ink", svg),
      inkSoft:  resolveToken("--c-ink-soft", svg),
      accent:   resolveToken("--c-accent", svg),
      ochre:    resolveToken("--c-viz-3", svg),
      greenInk: resolveToken("--c-green-ink", svg),
    };

    const officials = data.officials;
    const cells = data.cells;
    const N = officials.length;
    if (N < 2) return;

    // Margins: leave room for left + top labels. Long names get truncated to
    // 24 chars in the row labels; party color dot sits to the left of each.
    const labelMargin = N > labelLimit ? 16 : 200;
    const margin = { top: labelMargin, right: 24, bottom: 24, left: labelMargin };
    const innerW = Math.max(0, width - margin.left - margin.right);
    const innerH = Math.max(0, height - margin.top - margin.bottom);
    const grid = Math.max(0, Math.min(innerW, innerH));
    const cellSize = grid / N;

    const g = d3
      .select(svg)
      .append("g")
      .attr("transform", `translate(${margin.left},${margin.top})`);

    // Cell colour scale — diverging around 0.5 for agreement, around 0 for kappa.
    // Token-endpoint ramps (FIX-729): accent → ochre-gold → green-ink replaces
    // interpolateRdYlGn (yellow mid), accent → panel → green-ink replaces
    // interpolateRdBu. Domains unchanged.
    const colorAgreement = d3
      .scaleSequential<string>(d3.piecewise(d3.interpolateRgb, [T.accent, T.ochre, T.greenInk]))
      .domain([0, 1]);
    const colorKappa = d3
      .scaleSequential<string>(d3.piecewise(d3.interpolateRgb, [T.accent, T.panel, T.greenInk]))
      .domain([-1, 1]);

    function cellValue(i: number, j: number): number | null {
      const c = cells[i]?.[j];
      if (!c) return null;
      return metric === "kappa" ? c.kappa : c.agreement;
    }

    function fillFor(value: number | null, shared: number): string {
      if (value === null || shared === 0) return T.panel;
      return metric === "kappa" ? colorKappa(value) : colorAgreement(value);
    }

    // ── Grid cells ────────────────────────────────────────────────────────────
    type CellDatum = { i: number; j: number; oi: number; oj: number; cell: MatrixCell };
    const cellData: CellDatum[] = [];
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const oi = order[i] ?? i;
        const oj = order[j] ?? j;
        const row = cells[oi];
        if (!row) continue;
        const cell = row[oj];
        if (!cell) continue;
        cellData.push({ i, j, oi, oj, cell });
      }
    }

    const cellG = g
      .selectAll<SVGGElement, CellDatum>("g.cell")
      .data(cellData)
      .join("g")
      .attr("class", "cell")
      .attr("transform", (d) => `translate(${d.j * cellSize},${d.i * cellSize})`);

    cellG
      .append("rect")
      .attr("width", Math.max(1, cellSize - 1))
      .attr("height", Math.max(1, cellSize - 1))
      .attr("fill", (d) => fillFor(metric === "kappa" ? d.cell.kappa : d.cell.agreement, d.cell.shared))
      .attr("stroke", T.bg)
      .attr("stroke-width", 0.5)
      .style("cursor", "pointer");

    if (N <= labelLimit) {
      cellG
        .append("text")
        .attr("x", cellSize / 2)
        .attr("y", cellSize / 2)
        .attr("text-anchor", "middle")
        .attr("dominant-baseline", "central")
        .attr("font-size", Math.max(8, Math.min(14, cellSize / 4)))
        .attr("font-family", "system-ui, sans-serif")
        .attr("fill", T.bg)
        .attr("pointer-events", "none")
        .text((d) => {
          const v = metric === "kappa" ? d.cell.kappa : d.cell.agreement;
          if (v === null) return "—";
          return metric === "kappa" ? v.toFixed(2) : `${Math.round(v * 100)}%`;
        });
    }

    // Native SVG <title> tooltip — survives re-renders and doesn't need a portal.
    cellG.append("title").text((d) => {
      const oi = officials[d.oi];
      const oj = officials[d.oj];
      const c = d.cell;
      const ag = c.agreement === null ? "—" : `${Math.round(c.agreement * 100)}%`;
      const kp = c.kappa === null ? "—" : c.kappa.toFixed(2);
      return [
        `${oi?.name ?? "?"} ↔ ${oj?.name ?? "?"}`,
        `Agreement: ${ag} (${c.agreed}/${c.shared} shared votes)`,
        `Cohen's kappa: ${kp}`,
      ].join("\n");
    });

    // ── Row labels (left) ─────────────────────────────────────────────────────
    if (N <= labelLimit) {
      const rowLabels = g
        .selectAll<SVGGElement, number>("g.row-label")
        .data(order)
        .join("g")
        .attr("class", "row-label")
        .attr("transform", (_d, i) => `translate(0,${i * cellSize + cellSize / 2})`);

      rowLabels
        .append("circle")
        .attr("cx", -8)
        .attr("cy", 0)
        .attr("r", 3)
        .attr("fill", (d) => resolveColor(partyColor(officials[d]?.party ?? null), svg));

      rowLabels
        .append("text")
        .attr("x", -16)
        .attr("y", 0)
        .attr("text-anchor", "end")
        .attr("dominant-baseline", "central")
        .attr("font-size", 11)
        .attr("font-family", "system-ui, sans-serif")
        .attr("fill", T.ink)
        .text((d) => {
          const name = officials[d]?.name ?? "";
          return name.length > 24 ? name.slice(0, 22) + "…" : name;
        });

      // Top labels (rotated -45°)
      const colLabels = g
        .selectAll<SVGGElement, number>("g.col-label")
        .data(order)
        .join("g")
        .attr("class", "col-label")
        .attr(
          "transform",
          (_d, i) => `translate(${i * cellSize + cellSize / 2},-8) rotate(-45)`,
        );

      colLabels
        .append("text")
        .attr("text-anchor", "start")
        .attr("dominant-baseline", "central")
        .attr("font-size", 11)
        .attr("font-family", "system-ui, sans-serif")
        .attr("fill", (d) => resolveColor(partyColor(officials[d]?.party ?? null), svg))
        .text((d) => {
          const name = officials[d]?.name ?? "";
          // Top labels — last name only to keep them short.
          const last = name.split(/\s+/).slice(-1)[0] ?? name;
          return last.length > 14 ? last.slice(0, 12) + "…" : last;
        });
    }

    // ── Legend (bottom-right) ─────────────────────────────────────────────────
    const legendW = 140;
    const legendH = 8;
    const legendX = innerW - legendW;
    const legendY = innerH + 4;

    const defs = d3.select(svg).append("defs");
    const gradId = `matrix-legend-grad-${metric}`;
    const grad = defs
      .append("linearGradient")
      .attr("id", gradId)
      .attr("x1", "0%")
      .attr("x2", "100%");

    const stops = 10;
    for (let s = 0; s <= stops; s++) {
      const t = s / stops;
      const v = metric === "kappa" ? -1 + 2 * t : t;
      const fill = metric === "kappa" ? colorKappa(v) : colorAgreement(v);
      grad.append("stop").attr("offset", `${t * 100}%`).attr("stop-color", fill);
    }

    const legendG = g
      .append("g")
      .attr("transform", `translate(${legendX},${legendY})`);

    legendG
      .append("rect")
      .attr("width", legendW)
      .attr("height", legendH)
      .attr("fill", `url(#${gradId})`)
      .attr("stroke", T.panel);

    legendG
      .append("text")
      .attr("x", 0)
      .attr("y", legendH + 12)
      .attr("font-size", 10)
      .attr("fill", T.inkSoft)
      .text(metric === "kappa" ? "−1" : "0%");

    legendG
      .append("text")
      .attr("x", legendW)
      .attr("y", legendH + 12)
      .attr("text-anchor", "end")
      .attr("font-size", 10)
      .attr("fill", T.inkSoft)
      .text(metric === "kappa" ? "+1" : "100%");
  }, [data, order, metric, labelLimit, svgRef]);

  // Re-render on data + on resize
  useEffect(() => {
    render();
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(render);
    ro.observe(container);
    return () => ro.disconnect();
  }, [render]);

  // ── States ──────────────────────────────────────────────────────────────────

  if (officialIds.length < 2) {
    return (
      <div className={`flex items-center justify-center ${className}`}>
        <div className="text-center max-w-sm px-6">
          <p className="text-ink text-sm font-medium">Add at least 2 officials to focus</p>
          <p className="text-ink-soft text-xs mt-2 leading-relaxed">
            Matrix shows how often each pair voted the same way on shared bills.
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={`flex items-center justify-center ${className}`}>
        <div className="text-center">
          <div className="w-8 h-8 rounded-full border-2 border-accent border-t-transparent animate-spin mx-auto mb-3" />
          <p className="text-ink-soft text-sm">Computing vote agreement…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`flex items-center justify-center ${className}`}>
        <p className="text-accent text-sm">Failed to load matrix: {error}</p>
      </div>
    );
  }

  if (!data || data.officials.length < 2) {
    return (
      <div className={`flex items-center justify-center ${className}`}>
        <p className="text-ink-soft text-sm">No vote data available for these officials.</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className={`relative overflow-hidden flex flex-col ${className}`}>
      <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
        <span className="text-xs text-ink-soft bg-term-bg/70 px-2 py-0.5 rounded-full">
          Vote agreement · {data.proposalCount} proposals across {data.officials.length} officials
        </span>
      </div>

      <svg id="matrix-svg" ref={svgRef} className="w-full flex-1" />
    </div>
  );
}
