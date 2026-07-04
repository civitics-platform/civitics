"use client";

/**
 * packages/graph/src/AlignmentGraph.tsx
 *
 * USER-centric radial alignment chart. The user sits at the centre, each rep
 * fans out as a labelled radial bar whose fill = alignment ratio.
 * Per FIX-146 / GRAPH_PLAN §5.3.
 *
 * Inputs are passed in directly — alignment data is computed in GraphPage from
 * /api/graph/my-representatives, not refetched here. This keeps the viz pure.
 */

import { useEffect, useMemo, useRef, useCallback } from "react";
import * as d3 from "d3";
import type { RefObject } from "react";
import type { AlignmentOptions, GraphNode, GraphEdge } from "./types";
import { resolveToken, resolveColor } from "./tokens";

// ── Types ─────────────────────────────────────────────────────────────────────

interface RepDatum {
  id: string;
  name: string;
  role: string;
  party: string;
  ratio: number | null;
  matched: number;
  total: number;
}

// Token strings (FIX-729) — wine (viz-7) stands in for independents; the token
// system has no purple. Wrap with resolveColor(…, svgEl) at d3 .attr() sites.
const PARTY_COLORS: Record<string, string> = {
  democrat:    "rgb(var(--c-blue))",
  republican:  "rgb(var(--c-accent))",
  independent: "rgb(var(--c-viz-7))",
  nonpartisan: "rgb(var(--c-ink-soft))",
};

function partyColor(party: string | undefined): string {
  if (!party) return "rgb(var(--c-ink-soft))";
  return PARTY_COLORS[party.toLowerCase()] ?? "rgb(var(--c-ink-soft))";
}

function partyRank(party: string | undefined): number {
  if (!party) return 99;
  const p = party.toLowerCase();
  if (p === "democrat") return 0;
  if (p === "republican") return 1;
  return 2;
}

function ratioColor(
  ratio: number | null,
  base: string,
  gradient: boolean,
  noData: string,
  diverging: (t: number) => string,
): string {
  if (ratio === null) return noData;
  if (!gradient) return base;
  // Low alignment leans red, high alignment leans green. Useful when the user
  // explicitly wants to see who's most + least aligned at a glance regardless
  // of party. Was d3.interpolateRdYlGn — now the token-native alignment ramp
  // accent → amber → green-ink, resolved per scope (FIX-729).
  return diverging(ratio);
}

// ── Component ─────────────────────────────────────────────────────────────────

export interface AlignmentGraphProps {
  className?: string;
  svgRef?: RefObject<SVGSVGElement>;
  vizOptions?: Partial<AlignmentOptions>;
  /** USER node — pass null when the user has not configured a home district. */
  userNode: GraphNode | null;
  /** Rep nodes (officials linked to USER via alignment edges). */
  repNodes: GraphNode[];
  /** Alignment edges from USER to each rep. metadata carries the ratio + counts. */
  alignmentEdges: GraphEdge[];
}

const DEFAULTS: AlignmentOptions = {
  sortBy: "alignment",
  showLabels: true,
  fillMode: "ratio",
};

export function AlignmentGraph({
  className = "",
  svgRef: externalSvgRef,
  vizOptions,
  userNode,
  repNodes,
  alignmentEdges,
}: AlignmentGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const internalSvgRef = useRef<SVGSVGElement>(null);
  const svgRef = externalSvgRef ?? internalSvgRef;

  const sortBy    = vizOptions?.sortBy    ?? DEFAULTS.sortBy;
  const showLabels = vizOptions?.showLabels ?? DEFAULTS.showLabels ?? true;
  const fillMode  = vizOptions?.fillMode  ?? DEFAULTS.fillMode;

  // ── Build rep data from edges ────────────────────────────────────────────────
  const reps = useMemo<RepDatum[]>(() => {
    if (!userNode) return [];
    const repById = new Map(repNodes.map((r) => [r.id, r]));
    const out: RepDatum[] = [];
    for (const e of alignmentEdges) {
      if (e.connectionType !== "alignment") continue;
      // USER → rep edges
      const repId = e.fromId === userNode.id ? e.toId : e.toId === userNode.id ? e.fromId : null;
      if (!repId) continue;
      const node = repById.get(repId);
      if (!node) continue;
      const meta = e.metadata ?? {};
      const ratio = typeof meta.alignmentRatio === "number" ? meta.alignmentRatio : null;
      const matched = typeof meta.matchedVotes === "number" ? meta.matchedVotes : 0;
      const total = typeof meta.totalVotes === "number" ? meta.totalVotes : 0;
      out.push({
        id: node.id,
        name: node.name,
        role: node.role ?? "",
        party: node.party ?? "",
        ratio,
        matched,
        total,
      });
    }

    // Sort
    if (sortBy === "alignment") {
      out.sort((a, b) => (b.ratio ?? -1) - (a.ratio ?? -1));
    } else if (sortBy === "party") {
      out.sort((a, b) => partyRank(a.party) - partyRank(b.party) || a.name.localeCompare(b.name));
    } else if (sortBy === "role") {
      out.sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name));
    } else {
      out.sort((a, b) => a.name.localeCompare(b.name));
    }
    return out;
  }, [userNode, repNodes, alignmentEdges, sortBy]);

  // ── Render ──────────────────────────────────────────────────────────────────
  const render = useCallback(() => {
    const container = containerRef.current;
    const svg = svgRef.current;
    if (!container || !svg || !userNode || reps.length === 0) return;

    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width === 0 || height === 0) return;

    d3.select(svg).selectAll("*").remove();
    d3.select(svg).attr("width", width).attr("height", height);

    // SVG presentation attributes can't carry var() — resolve tokens to
    // concrete colors against the svg's scope at draw time (FIX-729).
    const T = {
      ink:       resolveToken("--c-ink", svg),
      inkSoft:   resolveToken("--c-ink-soft", svg),
      accent:    resolveToken("--c-accent", svg),
      amber:     resolveToken("--c-amber", svg),
      greenInk:  resolveToken("--c-green-ink", svg),
      viz7:      resolveToken("--c-viz-7", svg),
      termBg:    resolveToken("--c-term-bg", svg),
      termPanel: resolveToken("--c-term-panel", svg),
      termLine:  resolveToken("--c-term-line", svg),
      termFaint: resolveToken("--c-term-faint", svg),
    };
    // Gradient fill mode: misaligned → mixed → aligned.
    const diverging = d3.piecewise(d3.interpolateRgb, [T.accent, T.amber, T.greenInk]) as (
      t: number,
    ) => string;

    const cx = width / 2;
    const cy = height / 2;

    // Layout — bars start at innerR, fill to outerR proportional to ratio.
    const maxR = Math.min(width, height) / 2 - 24;
    const innerR = 38;
    const outerR = Math.max(innerR + 40, maxR);
    const trackInner = innerR + 8;

    const N = reps.length;
    const angleStep = (2 * Math.PI) / N;
    const barAngularWidth = angleStep * 0.6; // 60% fill, 40% gap

    const root = d3.select(svg).append("g").attr("transform", `translate(${cx},${cy})`);

    // ── Concentric guide rings (25/50/75/100) ─────────────────────────────────
    const guideRatios = [0.25, 0.5, 0.75, 1];
    const guides = root.append("g").attr("class", "guides");
    for (const r of guideRatios) {
      const radius = trackInner + (outerR - trackInner) * r;
      guides
        .append("circle")
        .attr("r", radius)
        .attr("fill", "none")
        .attr("stroke", T.termLine)
        .attr("stroke-width", 1)
        .attr("stroke-dasharray", r === 1 ? "0" : "2 4");
      guides
        .append("text")
        .attr("x", 0)
        .attr("y", -radius)
        .attr("dy", -3)
        .attr("text-anchor", "middle")
        .attr("font-size", 9)
        .attr("fill", T.termFaint)
        .attr("font-family", "system-ui, sans-serif")
        .text(`${Math.round(r * 100)}%`);
    }

    // ── USER node at centre ───────────────────────────────────────────────────
    const userG = root.append("g").attr("class", "user-node");
    userG
      .append("circle")
      .attr("r", innerR - 4)
      .attr("fill", T.termBg)
      .attr("stroke", T.viz7) // was purple → wine
      .attr("stroke-width", 2);
    userG
      .append("text")
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "central")
      .attr("font-size", 11)
      .attr("fill", T.ink)
      .attr("font-family", "system-ui, sans-serif")
      .text("YOU");

    // ── Bars ──────────────────────────────────────────────────────────────────
    type Datum = RepDatum & { angle: number };
    const data: Datum[] = reps.map((r, i) => ({
      ...r,
      // -π/2 puts the first bar at 12 o'clock, then we sweep clockwise.
      angle: -Math.PI / 2 + i * angleStep,
    }));

    const arcGen = d3
      .arc<Datum>()
      .startAngle((d) => d.angle - barAngularWidth / 2)
      .endAngle((d) => d.angle + barAngularWidth / 2)
      .innerRadius(trackInner)
      .outerRadius((d) => trackInner + (outerR - trackInner) * (d.ratio ?? 0));

    const trackArc = d3
      .arc<Datum>()
      .startAngle((d) => d.angle - barAngularWidth / 2)
      .endAngle((d) => d.angle + barAngularWidth / 2)
      .innerRadius(trackInner)
      .outerRadius(outerR);

    const barG = root
      .selectAll<SVGGElement, Datum>("g.bar")
      .data(data)
      .join("g")
      .attr("class", "bar")
      .style("cursor", "pointer");

    // Track (full-extent, semi-transparent) — provides a hover target when
    // ratio is small.
    barG
      .append("path")
      .attr("d", trackArc)
      .attr("fill", T.termPanel)
      .attr("opacity", 0.6);

    // Bar (ratio-filled).
    barG
      .append("path")
      .attr("d", arcGen)
      .attr("fill", (d) =>
        ratioColor(
          d.ratio,
          resolveColor(partyColor(d.party), svg),
          fillMode === "gradient",
          T.inkSoft,
          diverging,
        ),
      );

    // Native <title> tooltip on the whole bar group — picks up either the
    // track or the fill.
    barG.append("title").text((d) => {
      const pct = d.ratio === null ? "—" : `${Math.round(d.ratio * 100)}%`;
      return `${d.name}${d.role ? ` · ${d.role}` : ""}\nAligned: ${pct} (${d.matched}/${d.total} votes)`;
    });

    // ── Labels (rep names hugging the outer ring) ─────────────────────────────
    if (showLabels) {
      const labelRadius = outerR + 14;
      barG
        .append("text")
        .attr("transform", (d) => {
          const x = labelRadius * Math.cos(d.angle);
          const y = labelRadius * Math.sin(d.angle);
          // Rotate so text reads outward; flip on the left half so it's not upside down.
          const angleDeg = (d.angle * 180) / Math.PI;
          const flipped = angleDeg > 90 || angleDeg < -90;
          const rot = flipped ? angleDeg + 180 : angleDeg;
          return `translate(${x},${y}) rotate(${rot})`;
        })
        .attr("text-anchor", (d) => {
          const angleDeg = (d.angle * 180) / Math.PI;
          const flipped = angleDeg > 90 || angleDeg < -90;
          return flipped ? "end" : "start";
        })
        .attr("dominant-baseline", "central")
        .attr("font-size", N <= 6 ? 12 : N <= 12 ? 11 : 10)
        .attr("font-family", "system-ui, sans-serif")
        .attr("fill", (d) => resolveColor(partyColor(d.party), svg))
        .text((d) => {
          const last = d.name.split(/\s+/).slice(-1)[0] ?? d.name;
          return last.length > 16 ? last.slice(0, 14) + "…" : last;
        });

      // Percentage label inside the bar (only when bar is wide enough).
      if (N <= 12) {
        barG
          .append("text")
          .attr("transform", (d) => {
            const r = trackInner + (outerR - trackInner) * (d.ratio ?? 0) - 12;
            const x = r * Math.cos(d.angle);
            const y = r * Math.sin(d.angle);
            return `translate(${x},${y})`;
          })
          .attr("text-anchor", "middle")
          .attr("dominant-baseline", "central")
          .attr("font-size", 10)
          .attr("font-family", "system-ui, sans-serif")
          .attr("fill", T.termBg)
          .attr("pointer-events", "none")
          .text((d) => (d.ratio === null ? "" : `${Math.round(d.ratio * 100)}%`));
      }
    }
  }, [userNode, reps, fillMode, showLabels, svgRef]);

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

  if (!userNode) {
    return (
      <div className={`flex items-center justify-center ${className}`}>
        <div className="text-center max-w-sm px-6">
          <p className="text-ink text-sm font-medium">Set your home district</p>
          <p className="text-ink-soft text-xs mt-2 leading-relaxed">
            Add your address in the Profile to see how well your reps vote with you.
          </p>
        </div>
      </div>
    );
  }

  if (reps.length === 0) {
    return (
      <div className={`flex items-center justify-center ${className}`}>
        <div className="text-center max-w-sm px-6">
          <p className="text-ink text-sm font-medium">No alignment data yet</p>
          <p className="text-ink-soft text-xs mt-2 leading-relaxed">
            We need at least one tracked vote to score alignment with each rep.
          </p>
        </div>
      </div>
    );
  }

  // Aggregate stat for the dial header.
  const ratios = reps.map((r) => r.ratio).filter((v): v is number => typeof v === "number");
  const avg = ratios.length > 0 ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null;

  return (
    <div ref={containerRef} className={`relative overflow-hidden flex flex-col ${className}`}>
      <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
        <span className="text-xs text-ink-soft bg-term-bg/70 px-2 py-0.5 rounded-full">
          {reps.length} {reps.length === 1 ? "rep" : "reps"}
          {avg !== null && (
            <span className="ml-2 text-green-ink font-medium">
              avg {Math.round(avg * 100)}% aligned
            </span>
          )}
        </span>
      </div>

      <svg id="alignment-svg" ref={svgRef} className="w-full flex-1" />
    </div>
  );
}
