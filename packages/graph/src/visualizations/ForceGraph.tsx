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
import { BRACKET_TIERS } from "../types";
import { Tooltip, useTooltip } from "../components/Tooltip";
import { NodePopup } from "../components/NodePopup";
import { resolveToken, resolvePaperToken, resolveColor, withAlpha } from "../tokens";

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
  /**
   * FIX-149: when set, the matching node gets a glowing emerald ring and its
   * incident edges are highlighted. Driven by SharedConnectionsBar pill clicks.
   */
  highlightedNodeId?: string | null;
  /**
   * FIX-731 — external ref to the rendered <svg>, same convention as every
   * other viz (Treemap/Chord/…): GraphPage's ScreenshotPanel reads it for PNG
   * export. A prop (not a JSX ref) because next/dynamic does not forward refs.
   */
  svgRef?: React.RefObject<SVGSVGElement>;
  onNodeClick?: (node: GraphNode) => void;
  onNodeHover?: (node: GraphNode | null, x: number, y: number) => void;
  className?: string;
  onViewGroupAsTreemap?: (groupId: string) => void;
  onViewGroupAsChord?: (groupId: string) => void;
  onViewGroupAsSunburst?: (groupId: string) => void;
  onRemoveGroup?: (groupId: string) => void;
  onRetryGroup?: (groupId: string) => void;
  onOpenDonorList?: (officialId: string, tierOrEmployer: string) => void;
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
  metadata?: Record<string, unknown>;
  // FIX-585 — investigation-promoted edges render distinctly + filterable + attributed.
  evidenceSource?: string;
  investigationId?: string;
  investigationTitle?: string;
  reviewedAt?: string;
};

// FIX-585 — distinct color for community-asserted edges promoted to the graph.
// FIX-729 — ink: investigation edges read as hand-annotations on the record;
// the dash pattern stays their distinguisher. Token string — wrap with
// resolveColor() at d3 .attr() sites; CSS/style contexts consume it directly.
const INVESTIGATION_EDGE_COLOR = "rgb(var(--c-ink))";

// ── Visual constants ──────────────────────────────────────────────────────────
// FIX-729 — node FILLS are paper-family light chips in every scope ("records on
// the terminal"): resolved at render via resolvePaperToken("--c-card"). Group and
// individual_bracket fills are data-driven (metadata/tier color) at the draw
// site. STROKES below are token strings — resolveColor() them at .attr() sites.

const NODE_STROKE: Record<string, string> = {
  official:           "rgb(var(--c-blue))",
  agency:             "rgb(var(--c-viz-5))",
  proposal:           "rgb(var(--c-amber))",
  financial:          "rgb(var(--c-green-ink))",
  organization:       "rgb(var(--c-viz-2))",
  corporation:        "rgb(var(--c-green-ink))",
  pac:                "rgb(var(--c-viz-6))",
  individual:         "rgb(var(--c-blue))",
  individual_bracket: "rgb(var(--c-viz-3))", // overridden per-tier at render time
  group:              "rgb(var(--c-viz-5))",
  user:               "rgb(var(--c-amber))",
};

// Mirrors the barrel's PARTY_COLORS (index.ts, FIX-729) — duplicated here
// because importing from ../index would cycle (index re-exports this file).
const PARTY_STROKE: Record<string, string> = {
  democrat:    "rgb(var(--c-blue))",
  republican:  "rgb(var(--c-accent))",
  independent: "rgb(var(--c-viz-7))", // wine — the token system has no purple
  nonpartisan: "rgb(var(--c-ink-soft))",
};

// FIX-804 — "Color by" support. Neutral for nodes a mode doesn't apply to.
const NEUTRAL_STROKE = "rgb(var(--c-ink-soft))";

// Categorical hash into the viz ramp for the industry/state encodings. Stable
// per key so the same industry/state always gets the same hue within a session.
const VIZ_RAMP = [
  "rgb(var(--c-viz-1))", "rgb(var(--c-viz-2))", "rgb(var(--c-viz-3))",
  "rgb(var(--c-viz-4))", "rgb(var(--c-viz-5))", "rgb(var(--c-viz-6))",
  "rgb(var(--c-viz-7))", "rgb(var(--c-viz-8))", "rgb(var(--c-viz-9))",
];

function rampColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return VIZ_RAMP[h % VIZ_RAMP.length]!;
}

/**
 * FIX-804 — stroke token for a node under the active nodeColorEncoding.
 * 'entity_type' preserves the historical behavior exactly (officials stroke by
 * party, everything else by NODE_STROKE). Group nodes always keep their own
 * color; individual_bracket keeps its per-tier color (drawn at render time)
 * only under 'entity_type' — other modes treat brackets as neutral.
 * Returns a token string — resolveColor() it at .attr() sites.
 */
function nodeStrokeToken(d: GraphNode, encoding: string | undefined): string {
  if (d.type === "group" && d.metadata?.color) return d.metadata.color as string;
  switch (encoding) {
    case "party_affiliation":
      return d.party ? (PARTY_STROKE[d.party.toLowerCase()] ?? NEUTRAL_STROKE) : NEUTRAL_STROKE;
    case "industry_sector":
      return d.industryTag ? rampColor(d.industryTag) : NEUTRAL_STROKE;
    case "state_region":
      return d.state ? rampColor(d.state) : NEUTRAL_STROKE;
    default: // 'entity_type' + unknown values
      return d.type === "official" && d.party
        ? (PARTY_STROKE[d.party.toLowerCase()] ?? NODE_STROKE[d.type] ?? "rgb(var(--c-blue))")
        : (NODE_STROKE[d.type] ?? NEUTRAL_STROKE);
  }
}

// ── Type-cluster angles ───────────────────────────────────────────────────────
// Fixed semantic compass: 0 = right, -π/2 = up, π/2 = down (SVG y-down).

const TYPE_CLUSTER_ANGLES: Record<string, number> = {
  proposal:      (-Math.PI * 3) / 4,   // upper-left  — civic action
  official:      -Math.PI / 2,          // straight up — authority
  agency:        -Math.PI / 4,          // upper-right — government
  organization:  -Math.PI / 4,          // same sector as agency
  corporation:    0,                    // right       — money
  financial:      Math.PI / 6,          // lower-right
  pac:            Math.PI / 3,          // lower-right — dark money
  individual:   (-Math.PI * 2) / 3,    // lower-left  — citizens
  group:          Math.PI / 2,          // straight down — aggregates
};

function forceTypeCluster(
  nodes: SimNode[],
  clusterAngle: Map<string, number>,
  cx: number,
  cy: number,
  radius: number,
  focusedIds: Set<string>,
  strength: number
): (alpha: number) => void {
  return function (alpha: number) {
    for (const node of nodes) {
      if (focusedIds.has(node.id)) continue;
      if (node.type === "user") continue;
      const clusterKey = node.type === "individual_bracket" ? "individual" : node.type;
      const angle = clusterAngle.get(clusterKey);
      if (angle === undefined) continue;
      const tx = cx + Math.cos(angle) * radius;
      const ty = cy + Math.sin(angle) * radius;
      node.vx = (node.vx ?? 0) + (tx - (node.x ?? cx)) * strength * alpha;
      node.vy = (node.vy ?? 0) + (ty - (node.y ?? cy)) * strength * alpha;
    }
  };
}

// ── Type legend (shown in canvas when type clusters enabled) ──────────────────

const TYPE_LEGEND: Record<string, { label: string; compass: string }> = {
  official:     { label: 'Officials',     compass: '↑'  },
  proposal:     { label: 'Proposals',     compass: '↖' },
  agency:       { label: 'Agencies',      compass: '↗' },
  organization: { label: 'Organizations', compass: '↗' },
  financial:    { label: 'Financial',     compass: '→' },
  corporation:  { label: 'Corporations',  compass: '→' },
  pac:          { label: 'PACs',          compass: '↘' },
  individual:   { label: 'Donors',        compass: '↙' },
  group:        { label: 'Groups',        compass: '↓' },
};

// ── BFS depth from focus nodes (for hierarchical layout) ─────────────────────

function computeNodeDepths(
  nodes: SimNode[],
  links: SimLink[],
  focusIds: Set<string>
): Map<string, number> {
  const depths = new Map<string, number>();
  const queue: string[] = [];

  for (const id of focusIds) { depths.set(id, 0); queue.push(id); }

  const adj = new Map<string, string[]>();
  for (const e of links) {
    const s = (e.source as SimNode).id ?? e.fromId;
    const t = (e.target as SimNode).id ?? e.toId;
    (adj.get(s) ?? (adj.set(s, []), adj.get(s)!)).push(t);
    (adj.get(t) ?? (adj.set(t, []), adj.get(t)!)).push(s);
  }

  let i = 0;
  while (i < queue.length) {
    const id = queue[i++]!;
    const d  = depths.get(id)!;
    for (const nb of adj.get(id) ?? []) {
      if (!depths.has(nb)) { depths.set(nb, d + 1); queue.push(nb); }
    }
  }

  // Nodes unreachable from focus get maxDepth + 1
  const maxD = depths.size ? Math.max(...depths.values()) : 0;
  for (const n of nodes) { if (!depths.has(n.id)) depths.set(n.id, maxD + 1); }

  return depths;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getBaseRadius(node: GraphNode): number {
  const BASE: Record<string, number> = {
    official: 24, agency: 20, proposal: 18, financial: 16,
    organization: 20, corporation: 20, pac: 18, individual: 14,
    group: 30, user: 28,
  };
  if (node.type === 'individual_bracket') {
    const donorCount = (node.metadata?.donorCount as number | undefined) ?? 1;
    return Math.round(14 + Math.log10(Math.max(1, donorCount)) * 6);
  }
  return BASE[node.type] ?? 20;
}

// Returns token strings — wrap in resolveColor(…, svgEl) at .attr() sites (FIX-729).
function alignmentEdgeColor(ratio: number | null | undefined): string {
  if (ratio == null) return "rgb(var(--c-ink-soft))";  // no overlap yet — muted
  if (ratio >= 0.6)  return "rgb(var(--c-green-ink))"; // aligned
  if (ratio >= 0.4)  return "rgb(var(--c-amber))";     // mixed
  return "rgb(var(--c-accent))";                       // misaligned
}

function getNodeRadius(node: GraphNode, sizeBy: string | undefined): number {
  const base = getBaseRadius(node);
  if (sizeBy === "uniform") return base;
  if (sizeBy === "donation_total")
    return base + Math.sqrt((node.donationTotal ?? 0) / 100_000) * 2;
  // default: connection_count
  return base + Math.sqrt(node.connectionCount ?? 0) * 2;
}

function initials(name: string | undefined | null): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2)
    return ((parts[0]![0] ?? "") + (parts[parts.length - 1]![0] ?? "")).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function truncate(s: string | undefined | null, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// ── Alignment Edge Tooltip ────────────────────────────────────────────────────

interface AlignmentEdgeTooltipProps {
  officialName: string;
  ratio: number | null;
  matchedVotes: number;
  totalVotes: number;
  voteDetails: Array<{ title: string; user_pos: string; official_vote: string; aligned: boolean }>;
  x: number;
  y: number;
}

function AlignmentEdgeTooltip({
  officialName, ratio, matchedVotes, totalVotes, voteDetails, x, y,
}: AlignmentEdgeTooltipProps) {
  const pct = ratio != null ? Math.round(ratio * 100) : null;
  // Paper-safe token classes — this HTML renders inside the terminal-scoped
  // graph page AND on paper embeds (FIX-729). Mixed reads as plain ink.
  const color =
    pct == null  ? "text-ink-soft"  :
    pct >= 60    ? "text-green-ink" :
    pct >= 40    ? "text-ink" : "text-accent";

  const TOOLTIP_W = 260;
  const safeX = Math.min(x + 14, (typeof window !== "undefined" ? window.innerWidth : 1024) - TOOLTIP_W - 8);

  return (
    <div
      className="absolute z-50 pointer-events-none bg-card border border-rule rounded-lg shadow-lg px-3 py-3 text-sm"
      style={{ left: safeX, top: y - 8, width: TOOLTIP_W }}
    >
      <div className="font-semibold text-ink leading-tight mb-1">{officialName}</div>
      {pct != null ? (
        <div className={`text-2xl font-bold ${color}`}>{pct}% aligned</div>
      ) : (
        <div className="text-ink-soft text-xs">No overlapping votes yet</div>
      )}
      {totalVotes > 0 && (
        <div className="text-ink-soft text-xs mt-0.5">
          {matchedVotes} of {totalVotes} overlapping votes match
        </div>
      )}
      {voteDetails.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-rule pt-2">
          {voteDetails.map((v, i) => (
            <li key={i} className="flex items-start gap-1.5 text-xs text-ink-soft">
              <span className={v.aligned ? "text-green-ink shrink-0" : "text-accent shrink-0"}>
                {v.aligned ? "✓" : "✗"}
              </span>
              <span className="truncate">{v.title ?? "Untitled"}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// FIX-585 — attribution popover for an investigation-promoted edge.
function InvestigationEdgeTooltip({
  title, investigationId, reviewedAt, relationship, x, y,
}: {
  title: string;
  investigationId?: string;
  reviewedAt?: string;
  relationship: string;
  x: number;
  y: number;
}) {
  const TOOLTIP_W = 260;
  const safeX = Math.min(x + 14, (typeof window !== "undefined" ? window.innerWidth : 1024) - TOOLTIP_W - 8);
  const reviewed = reviewedAt ? new Date(reviewedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null;
  return (
    <div
      className="absolute z-50 bg-card border rounded-lg shadow-lg px-3 py-3 text-sm"
      style={{ left: safeX, top: y - 8, width: TOOLTIP_W, borderColor: INVESTIGATION_EDGE_COLOR }}
    >
      <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: INVESTIGATION_EDGE_COLOR }}>
        Community claim · promoted
      </div>
      <div className="mt-0.5 text-xs text-ink-soft">{relationship} relationship asserted in</div>
      {investigationId ? (
        <a href={`/investigations/${investigationId}`} target="_blank" rel="noopener noreferrer"
          className="font-semibold text-ink leading-tight hover:underline">
          {title} ↗
        </a>
      ) : (
        <div className="font-semibold text-ink leading-tight">{title}</div>
      )}
      {reviewed && <div className="text-ink-soft text-xs mt-1">Reviewed {reviewed}</div>}
    </div>
  );
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
      highlightedNodeId = null,
      onNodeClick,
      onNodeHover,
      className,
      onViewGroupAsTreemap,
      onViewGroupAsChord,
      onViewGroupAsSunburst,
      onRemoveGroup,
      onRetryGroup,
      onOpenDonorList,
      svgRef: externalSvgRef,
    },
    forwardedRef
  ) {
    const internalSvgRef = useRef<SVGSVGElement>(null);
    // FIX-731 — external prop ref wins (screenshot export); internal fallback.
    const svgRef       = externalSvgRef ?? internalSvgRef;
    const simRef       = useRef<d3.Simulation<SimNode, SimLink> | null>(null);
    const linkSelRef   = useRef<d3.Selection<SVGLineElement, SimLink, SVGGElement, unknown> | null>(null);
    const nodeGrpRef   = useRef<d3.Selection<SVGGElement, SimNode, SVGGElement, unknown> | null>(null);
    const zoomTransRef = useRef<d3.ZoomTransform>(d3.zoomIdentity);
    const zoomBehRef   = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);

    React.useImperativeHandle(forwardedRef, () => svgRef.current!, []);

    const { tooltip, show: showTip, hide: hideTip } = useTooltip();
    const [popup, setPopup] = useState<GraphNode | null>(null);

    interface AlignTooltipState {
      officialName: string;
      ratio: number | null;
      matchedVotes: number;
      totalVotes: number;
      voteDetails: Array<{ title: string; user_pos: string; official_vote: string; aligned: boolean }>;
      x: number;
      y: number;
    }
    const [alignTooltip, setAlignTooltip] = useState<AlignTooltipState | null>(null);

    // FIX-585 — investigation edge attribution popover + show/hide toggle.
    interface InvestTooltipState {
      title: string;
      investigationId?: string;
      reviewedAt?: string;
      relationship: string;
      x: number;
      y: number;
    }
    const [investTooltip, setInvestTooltip] = useState<InvestTooltipState | null>(null);
    const [showInvestigation, setShowInvestigation] = useState(true);
    const hasInvestigationEdges = edges.some((e) => e.evidenceSource === "investigation");

    // ── Category C — data change: full re-init preserving positions ───────────
    useEffect(() => {
      const svgEl = svgRef.current;
      if (!svgEl) return;

      const width  = svgEl.clientWidth  || 900;
      const height = svgEl.clientHeight || 600;

      // FIX-729 — resolve the scope-aware palette once per rebuild. Strokes and
      // canvas chrome resolve against the svg's scope (terminal → luminous
      // values; paper embeds → ink values). Node fills and on-chip text are
      // paper-locked — "records on the terminal".
      const pal = {
        inkSoft:   resolveToken("--c-ink-soft", svgEl),
        amber:     resolveToken("--c-amber", svgEl),
        greenInk:  resolveToken("--c-green-ink", svgEl),
        accent:    resolveToken("--c-accent", svgEl),
        blue:      resolveToken("--c-blue", svgEl),
        viz6:      resolveToken("--c-viz-6", svgEl),
        termBg:    resolveToken("--c-term-bg", svgEl),
        termPanel: resolveToken("--c-term-panel", svgEl),
        cardFill:  resolvePaperToken("--c-card"),
        paperInk:  resolvePaperToken("--c-ink"),
      };

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
        metadata: e.metadata,
        evidenceSource: e.evidenceSource,
        investigationId: e.investigationId,
        investigationTitle: e.investigationTitle,
        reviewedAt: e.reviewedAt,
        source: (nodeById.get(e.fromId) ?? simNodes[0]!) as SimNode,
        target: (nodeById.get(e.toId)   ?? simNodes[0]!) as SimNode,
      }));

      // ── Clear and rebuild SVG ──────────────────────────────────────────────
      const svg = d3.select(svgEl);
      svg.selectAll("*").remove();

      // ── Defs: arrowhead markers, drop shadow ──────────────────────────────
      const defs = svg.append("defs");

      Object.keys(CONNECTION_TYPE_REGISTRY).forEach((type) => {
        const color = resolveColor(
          connections[type]?.color
            ?? CONNECTION_TYPE_REGISTRY[type]?.color
            ?? pal.inkSoft,
          svgEl
        );
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
        .attr("flood-color", pal.amber)
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
        // FIX-585 — source wins over connection_type for the distinct investigation render.
        if (d.evidenceSource === "investigation") return resolveColor(INVESTIGATION_EDGE_COLOR, svgEl);
        if (d.connectionType === "alignment") {
          return resolveColor(alignmentEdgeColor(d.metadata?.alignmentRatio as number | null), svgEl);
        }
        return resolveColor(
          connections[d.connectionType]?.color
            ?? CONNECTION_TYPE_REGISTRY[d.connectionType]?.color
            ?? pal.inkSoft,
          svgEl
        );
      }

      function edgeOpacityFn(d: SimLink): number {
        if (d.connectionType === "alignment") return 0.85;
        const isShared =
          focusIds.has(d.source?.id ?? d.fromId) &&
          focusIds.has(d.target?.id ?? d.toId);
        if (isShared) return 0.9;
        return connections[d.connectionType]?.opacity ?? 0.6;
      }

      function edgeWidthFn(d: SimLink): number {
        if (d.connectionType === "alignment") return 2;
        const isShared =
          focusIds.has(d.source?.id ?? d.fromId) &&
          focusIds.has(d.target?.id ?? d.toId);
        const base = connections[d.connectionType]?.thickness ?? 0.5;
        if (isShared) return base * 8;
        // Group edges: scale width by pctOfGroup (0–100) → 1–8px
        const pct = d.metadata?.pctOfGroup as number | undefined;
        if (pct !== undefined) {
          return Math.max(1, (pct / 100) * 8);
        }
        if (d.connectionType === "donation" && d.amountUsd) {
          return Math.max(1, Math.log10(d.amountUsd / 1_000) * base * 3);
        }
        return base * 4;
      }

      const hasConnectionFilter = connections && Object.keys(connections).length > 0;

      const linkGroup = g.append("g").attr("class", "links");
      const link = linkGroup
        .selectAll<SVGLineElement, SimLink>("line")
        .data(simLinks)
        .join("line")
        .attr("class", "link")
        .attr("stroke", edgeColor)
        .attr("stroke-width", edgeWidthFn)
        .attr("stroke-opacity", edgeOpacityFn)
        // FIX-585 — dash investigation edges so they read as asserted-not-derived.
        // FIX-747 — dash opposition (IE-against) edges so red opposition spend
        // reads as distinct from support money and from solid-red vote_no.
        .attr("stroke-dasharray", (d) =>
          d.evidenceSource === "investigation" ? "5 3" : d.connectionType === "opposition" ? "6 4" : null)
        .style("display", (d) => {
          // FIX-585 — investigation edges have their own toggle (independent of the
          // connection-type filter, since they carry a real connection_type).
          if (d.evidenceSource === "investigation") return showInvestigation ? "block" : "none";
          if (!hasConnectionFilter) return "block";
          const conn = connections[d.connectionType];
          if (!conn) return "block";           // unknown type: show
          if (conn.enabled === false) return "none"; // explicitly disabled: hide
          return "block";
        })
        .attr("marker-end", (d) => `url(#arrow-${d.connectionType})`);

      linkSelRef.current = link;

      // Alignment edge tooltip on hover
      link
        .on("mouseenter.align", function (event: MouseEvent, d: SimLink) {
          if (d.connectionType !== "alignment") return;
          const rect = svgEl.getBoundingClientRect();
          setAlignTooltip({
            officialName: d.metadata?.officialName as string ?? "",
            ratio: d.metadata?.alignmentRatio as number | null,
            matchedVotes: d.metadata?.matchedVotes as number ?? 0,
            totalVotes: d.metadata?.totalVotes as number ?? 0,
            voteDetails: d.metadata?.voteDetails as AlignTooltipState["voteDetails"] ?? [],
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
          });
        })
        .on("mousemove.align", function (event: MouseEvent, d: SimLink) {
          if (d.connectionType !== "alignment") return;
          const rect = svgEl.getBoundingClientRect();
          setAlignTooltip(prev => prev ? { ...prev, x: event.clientX - rect.left, y: event.clientY - rect.top } : prev);
        })
        .on("mouseleave.align", (_event: MouseEvent, d: SimLink) => {
          if (d.connectionType !== "alignment") return;
          setAlignTooltip(null);
        });

      // FIX-585 — investigation edge attribution popover on hover.
      link
        .on("mouseenter.invest", function (event: MouseEvent, d: SimLink) {
          if (d.evidenceSource !== "investigation") return;
          const rect = svgEl.getBoundingClientRect();
          setInvestTooltip({
            title: d.investigationTitle ?? "Investigation",
            investigationId: d.investigationId,
            reviewedAt: d.reviewedAt,
            relationship: (CONNECTION_TYPE_REGISTRY[d.connectionType]?.label ?? d.connectionType ?? "").replace(/_/g, " "),
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
          });
        })
        .on("mousemove.invest", function (event: MouseEvent, d: SimLink) {
          if (d.evidenceSource !== "investigation") return;
          const rect = svgEl.getBoundingClientRect();
          setInvestTooltip((prev) => (prev ? { ...prev, x: event.clientX - rect.left, y: event.clientY - rect.top } : prev));
        })
        .on("mouseleave.invest", (_event: MouseEvent, d: SimLink) => {
          if (d.evidenceSource !== "investigation") return;
          setInvestTooltip(null);
        });

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
        // Group nodes use their metadata color; others get the paper-locked
        // light chip fill in every scope (FIX-729 "records on the terminal").
        const fill = d.type === "group"
          ? (d.metadata?.color
              ? withAlpha(d.metadata.color as string, 0.2, svgEl)
              : pal.termPanel)
          : pal.cardFill;
        // FIX-804 — stroke honors the active "Color by" encoding.
        const stroke = resolveColor(nodeStrokeToken(d, vizOptions?.nodeColorEncoding), svgEl);

        // Store baseRadius for focus highlight effect
        (d as SimNode).baseRadius = r;

        if (d.type === "group") {
          // Large circle with color-tinted fill
          el.append("circle")
            .attr("class", "node-circle")
            .attr("r", r)
            .attr("fill", fill)
            .attr("stroke", stroke)
            .attr("stroke-width", 3);
          // Emoji icon in center
          el.append("text")
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "central")
            .attr("font-size", "22px")
            .attr("pointer-events", "none")
            .style("user-select", "none")
            .text((d.metadata?.icon as string) ?? "👥");
          // Member count badge — small circle top-right
          const memberCount = d.metadata?.memberCount as number | undefined;
          if (memberCount) {
            el.append("circle")
              .attr("r", 9)
              .attr("cx", r * 0.7)
              .attr("cy", -r * 0.7)
              .attr("fill", pal.blue)
              .attr("stroke", pal.termBg)
              .attr("stroke-width", 1)
              .attr("pointer-events", "none");
            el.append("text")
              .attr("x", r * 0.7)
              .attr("y", -r * 0.7)
              .attr("text-anchor", "middle")
              .attr("dominant-baseline", "central")
              .attr("font-size", "8px")
              .attr("fill", "white")
              .attr("pointer-events", "none")
              .style("user-select", "none")
              .text(memberCount > 99 ? "99+" : String(memberCount));
          }
        } else if (d.type === "official" || d.type === "individual") {
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
            .attr("fill", pal.paperInk)
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
            .attr("fill", pal.paperInk)
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
            .attr("fill", pal.paperInk)
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
            .attr("fill", pal.paperInk)
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
            .attr("fill", pal.paperInk)
            .attr("pointer-events", "none")
            .text(truncate(d.name, 8));
        } else if (d.type === "individual_bracket") {
          // Stacked diamond cluster — three layered diamonds to signal "many donors"
          // Tier color drives both fill and stroke.
          const tierMeta = d.metadata?.tier as string | undefined;
          const isEmployer = d.metadata?.isEmployerNode as boolean | undefined;
          const tierDef = BRACKET_TIERS.find(t => t.id === tierMeta);
          const tierColor  = tierDef?.color ?? "rgb(var(--c-viz-3))";
          const tierStroke = resolveColor(tierColor, svgEl);
          const tierFill   = withAlpha(tierColor, 0.13, svgEl); // ~13% opacity fill

          // Back diamond (offset -3,-3), mid diamond (offset -1.5,-1.5), front diamond
          const offsets: [number, number][] = [[-3, -3], [-1.5, -1.5], [0, 0]];
          offsets.forEach(([ox, oy], idx) => {
            const opacity = 0.4 + idx * 0.3; // 0.4, 0.7, 1.0
            el.append("path")
              .attr("class", idx === 2 ? "node-circle" : null)
              .attr("d", `M${ox},${oy - r} L${ox + r},${oy} L${ox},${oy + r} L${ox - r},${oy} Z`)
              .attr("fill", idx === 2 ? tierFill : "none")
              .attr("stroke", tierStroke)
              .attr("stroke-width", idx === 2 ? 2 : 1)
              .attr("opacity", opacity)
              .attr("pointer-events", idx === 2 ? null : "none");
          });

          // Icon inside front diamond
          el.append("text")
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "central")
            .attr("font-size", "11px")
            .attr("pointer-events", "none")
            .text(isEmployer ? "🏢" : "👤");

          // Donor count badge (top-right of front diamond)
          const donorCount = (d.metadata?.donorCount as number | undefined) ?? 0;
          if (donorCount > 0) {
            el.append("circle")
              .attr("cx", r * 0.65).attr("cy", -r * 0.65)
              .attr("r", 9)
              .attr("fill", tierStroke)
              .attr("stroke", pal.termBg)
              .attr("stroke-width", 1)
              .attr("pointer-events", "none");
            el.append("text")
              .attr("x", r * 0.65).attr("y", -r * 0.65)
              .attr("text-anchor", "middle")
              .attr("dominant-baseline", "central")
              .attr("font-size", "7px")
              .attr("font-weight", "800")
              .attr("fill", "white")
              .attr("pointer-events", "none")
              .text(donorCount > 999 ? "999+" : String(donorCount));
          }
        } else if (d.type === "user") {
          // YOU node: distinct visual (FIX-120)
          //   - Larger than typical official nodes (baseRadius=28)
          //   - Outer ring color reflects aggregate alignment across reps:
          //       green-ink ≥ 0.6, accent < 0.4, ink-soft otherwise
          //   - Inner circle keeps the amber user stroke to read as "this is YOU"
          const alignmentRatios = simLinks
            .filter(e => e.fromId === d.id && e.connectionType === "alignment")
            .map(e => e.metadata?.alignmentRatio as number | null)
            .filter((v): v is number => typeof v === "number");
          const avgRatio = alignmentRatios.length > 0
            ? alignmentRatios.reduce((a, b) => a + b, 0) / alignmentRatios.length
            : null;
          const ringColor =
            avgRatio == null ? pal.inkSoft :  // no signal
            avgRatio >= 0.6  ? pal.greenInk : // aligned
            avgRatio <  0.4  ? pal.accent :   // misaligned
                               pal.inkSoft;   // mixed → muted
          el.append("circle")
            .attr("r", r + 8)
            .attr("fill", "none")
            .attr("stroke", ringColor)
            .attr("stroke-width", 3)
            .attr("opacity", 0.85)
            .attr("pointer-events", "none");
          el.append("circle")
            .attr("r", r + 4)
            .attr("fill", "none")
            .attr("stroke", stroke)
            .attr("stroke-width", 1)
            .attr("opacity", 0.35)
            .attr("pointer-events", "none");
          el.append("circle")
            .attr("class", "node-circle")
            .attr("r", r)
            .attr("fill", fill)
            .attr("stroke", stroke)
            .attr("stroke-width", 3);
          el.append("text")
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "central")
            .attr("font-size", "10px")
            .attr("font-weight", "800")
            .attr("fill", pal.paperInk)
            .attr("pointer-events", "none")
            .text("YOU");
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
        const labelY = d.type === "official"          ? r + 16 :
                       d.type === "pac"               ? r + 14 :
                       d.type === "individual"        ? r + 12 :
                       d.type === "individual_bracket"? r + 14 : r + 16;
        const labelText = d.type === "group"
          ? (() => {
              const count = d.metadata?.memberCount as number | undefined;
              return count ? `${d.name} (${count})` : (d.name ?? "");
            })()
          : d.type === "individual_bracket"
          ? (() => {
              const donorCount = d.metadata?.donorCount as number | undefined;
              const total = d.donationTotal != null
                ? `$${Math.round(d.donationTotal / 100_000)}k`
                : "";
              return donorCount ? `${truncate(d.name, 16)} · ${total}` : truncate(d.name, 22);
            })()
          : truncate(d.name, 22);
        el.append("text")
          .attr("class", "node-label")
          .attr("y", labelY)
          .attr("text-anchor", "middle")
          .attr("font-size", "10px")
          .attr("fill", pal.inkSoft)
          .attr("pointer-events", "none")
          .text(labelText);

        // Loading ring (animated, hidden by default)
        el.append("circle")
          .attr("class", "node-loading-ring")
          .attr("r", r + 6)
          .attr("fill", "none")
          .attr("stroke", pal.amber)
          .attr("stroke-width", 2)
          .attr("stroke-dasharray", "12,8")
          .style("display", "none")
          .style("animation", "spin 1s linear infinite");

        // Collapsed badge
        if (d.collapsed) {
          el.append("circle")
            .attr("cx", r - 2).attr("cy", -(r - 2))
            .attr("r", 9)
            .attr("fill", pal.viz6)
            .attr("stroke", pal.termBg)
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

        // Synthetic badge — persistent on-canvas mark for AI-generated
        // demonstration entities (node.isSynthetic, FIX-572 / SF-P2). Amber
        // dashed ring + "S", placed top-left so it never collides with the
        // top-right collapsed "+" badge. 0 nodes synthetic today.
        if (d.isSynthetic) {
          el.append("circle")
            .attr("cx", -(r - 2)).attr("cy", -(r - 2))
            .attr("r", 9)
            .attr("fill", pal.cardFill)
            .attr("stroke", pal.amber)
            .attr("stroke-width", 1.5)
            .attr("stroke-dasharray", "2,1.5")
            .attr("pointer-events", "none");
          const synthLabel = el.append("text")
            .attr("x", -(r - 2)).attr("y", -(r - 2))
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "central")
            .attr("font-size", "11px")
            .attr("font-weight", "800")
            .attr("fill", pal.paperInk)
            .attr("pointer-events", "none")
            .text("S");
          synthLabel.append("title")
            .text("Synthetic — AI-generated demonstration content");
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
          // USER node has no profile page — skip popup
          if (d.type !== "user") {
            setPopup(d);
            onNodeClick?.(d);
          }
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

      // Pin focused + pinned entities; also pin the USER node at canvas center
      sim.nodes().forEach((n) => {
        if (n.type === "user") {
          n.fx = width / 2;
          n.fy = height / 2;
          return;
        }
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
      const nodeGrp = nodeGrpRef.current;
      if (!link) return;
      // FIX-729 — scope-aware token resolution for SVG presentation attrs
      // (var() fails in .attr(); resolve to concrete rgb() first).
      const svgEl = svgRef.current;

      const focusIds = new Set(focusEntities.map((fe) => fe.id));
      const hasConnectionFilter = connections && Object.keys(connections).length > 0;

      const edgeVisible = (d: SimLink): boolean => {
        // FIX-585 — investigation edges follow their own toggle, not the type filter.
        if (d.evidenceSource === "investigation") return showInvestigation;
        if (!hasConnectionFilter) return true;
        const conn = connections[d.connectionType];
        if (!conn) return true;
        return conn.enabled !== false;
      };

      link
        .style("display", (d: SimLink) => (edgeVisible(d) ? "block" : "none"))
        .attr("stroke-dasharray", (d: SimLink) =>
          d.evidenceSource === "investigation" ? "5 3" : d.connectionType === "opposition" ? "6 4" : null)
        .attr("stroke", (d: SimLink) => {
          if (d.evidenceSource === "investigation") return resolveColor(INVESTIGATION_EDGE_COLOR, svgEl);
          if (d.connectionType === "alignment") {
            return resolveColor(alignmentEdgeColor(d.metadata?.alignmentRatio as number | null), svgEl);
          }
          return resolveColor(
            connections[d.connectionType]?.color
              ?? CONNECTION_TYPE_REGISTRY[d.connectionType]?.color
              ?? "rgb(var(--c-ink-soft))",
            svgEl
          );
        })
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
          const pct = d.metadata?.pctOfGroup as number | undefined;
          if (pct !== undefined) return Math.max(1, (pct / 100) * 8);
          if (d.connectionType === "donation" && d.amountUsd) {
            return Math.max(1, Math.log10(d.amountUsd / 1_000) * thickness * 3);
          }
          return thickness * 4;
        });

      // Hide nodes whose only edges were just disabled. Focused entities,
      // FocusGroup nodes, and the USER node always stay visible.
      if (nodeGrp) {
        const visibleNodeIds = new Set<string>();
        link.each(function (d: SimLink) {
          if (!edgeVisible(d)) return;
          const sid = (d.source as SimNode).id ?? d.fromId;
          const tid = (d.target as SimNode).id ?? d.toId;
          visibleNodeIds.add(sid);
          visibleNodeIds.add(tid);
        });
        nodeGrp.style("display", (n: SimNode) => {
          if (focusIds.has(n.id)) return null;
          if (n.type === "user" || n.type === "group") return null;
          if (n.type === "individual_bracket") return visibleNodeIds.has(n.id) ? null : "none";
          return visibleNodeIds.has(n.id) ? null : "none";
        });
      }
    }, [connections, focusEntities, showInvestigation]);

    // ── Category A — Node highlight for focus entities + color-by (FIX-804) ────
    useEffect(() => {
      const nodeGrp = nodeGrpRef.current;
      if (!nodeGrp) return;
      // FIX-729 — resolve tokens against the svg's scope for presentation attrs.
      const svgEl = svgRef.current;

      const focusIds = new Set(focusEntities.map((fe) => fe.id));
      const encoding = vizOptions?.nodeColorEncoding;

      nodeGrp
        .selectAll<SVGGElement, SimNode>(".node-circle")
        .attr("stroke", (d: SimNode) => {
          if (focusIds.has(d.id)) {
            switch (d.party?.toLowerCase()) {
              case "democrat":   return resolveToken("--c-blue", svgEl);
              case "republican": return resolveToken("--c-accent", svgEl);
              default:           return resolveToken("--c-viz-7", svgEl); // wine — no purple in the token system
            }
          }
          return resolveColor(nodeStrokeToken(d, encoding), svgEl);
        })
        .attr("stroke-width", (d: SimNode) => (focusIds.has(d.id) ? 3 : d.type === "official" ? 3 : 2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [focusEntities, vizOptions?.nodeColorEncoding]);

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

    // ── Category A — Shared-connections highlight (FIX-149) ────────────────────
    // Driven by SharedConnectionsBar pill clicks. Pulls focus to one node + its
    // edges to the focused entities, fading everything else.
    useEffect(() => {
      const svgEl = svgRef.current;
      const link = linkSelRef.current;
      if (!svgEl) return;

      const root = d3.select(svgEl);

      if (!highlightedNodeId) {
        // Clear: restore everyone to normal opacity. Stroke style is owned by
        // the focus-entities effect, so we only touch what we changed.
        root.selectAll<SVGGElement, SimNode>("g.node").style("opacity", 1);
        link?.style("opacity", null);
        return;
      }

      const focusIds = new Set(focusEntities.map((fe) => fe.id));
      // Edges incident to the highlighted node + at least one focused entity:
      // those are the "shared" edges we want to spotlight.
      const isIncidentSharedEdge = (d: SimLink): boolean => {
        const srcId = (d.source as SimNode).id ?? d.fromId;
        const tgtId = (d.target as SimNode).id ?? d.toId;
        if (srcId === highlightedNodeId && focusIds.has(tgtId)) return true;
        if (tgtId === highlightedNodeId && focusIds.has(srcId)) return true;
        return false;
      };
      const isIncidentNode = (d: SimNode): boolean =>
        d.id === highlightedNodeId || focusIds.has(d.id);

      root
        .selectAll<SVGGElement, SimNode>("g.node")
        .style("opacity", (d: SimNode) => (isIncidentNode(d) ? 1 : 0.2));

      link?.style("opacity", (d: SimLink) => (isIncidentSharedEdge(d) ? 1 : 0.1));
    }, [highlightedNodeId, focusEntities]);

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
        case "hierarchical": {
          const focusIdSet = new Set((focusEntities ?? []).map(fe => fe.id));
          const linkForce  = sim.force("link") as d3.ForceLink<SimNode, SimLink> | null;
          const curLinks   = (linkForce?.links() ?? []) as SimLink[];
          const depths     = computeNodeDepths(sim.nodes(), curLinks, focusIdSet);
          const maxDepth   = Math.max(1, ...[...depths.values()]);

          sim
            .force("r", null)
            .force("x", d3.forceX<SimNode>(width / 2).strength(0.15))
            .force("y", d3.forceY<SimNode>((d) => {
              const depth = depths.get(d.id) ?? maxDepth;
              return height * 0.1 + (height * 0.8) * (depth / maxDepth);
            }).strength(0.7))
            .alpha(0.5)
            .restart();
          break;
        }
        default:
          sim.force("r", null).force("x", null).force("y", null).alpha(0.3).restart();
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [vizOptions?.layout]);

    // ── Category B — Type-cluster force ──────────────────────────────────────
    useEffect(() => {
      const sim = simRef.current;
      if (!sim || !nodes.length) return;
      const svgEl = svgRef.current;
      const width  = svgEl?.clientWidth  ?? 900;
      const height = svgEl?.clientHeight ?? 600;
      const cx = width  / 2;
      const cy = height / 2;

      if (!vizOptions?.typeClusterEnabled) {
        sim.force("type-cluster", null).alpha(0.3).restart();
        return;
      }

      const strength = vizOptions?.typeClusterStrength ?? 0.08;
      const radius   = Math.min(width, height) * 0.35;
      const focusedIds = new Set(focusEntities.map(fe => fe.id));
      const currentNodes = sim.nodes();

      const clusterAngle = new Map<string, number>();
      const typesPresent = new Set<string>(
        currentNodes.map(n => n.type === "individual_bracket" ? "individual" : n.type)
      );
      for (const [type, angle] of Object.entries(TYPE_CLUSTER_ANGLES)) {
        if (typesPresent.has(type)) clusterAngle.set(type, angle);
      }

      sim
        .force("type-cluster", forceTypeCluster(currentNodes, clusterAngle, cx, cy, radius, focusedIds, strength))
        .alpha(0.5)
        .restart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [vizOptions?.typeClusterEnabled, vizOptions?.typeClusterStrength, focusEntities]);

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
          const t = el.transition().duration(200);
          if (tagName === "circle") {
            t.attr("r", r);
          } else if (tagName === "rect") {
            t.attr("x", -r).attr("y", -r * 0.6)
              .attr("width", r * 2).attr("height", r * 1.2);
          } else if (tagName === "path") {
            if (d.type === "financial" || d.type === "corporation") {
              t.attr("d", `M0,${-r} L${r},0 L0,${r} L${-r},0 Z`);
            } else if (d.type === "pac") {
              t.attr("d", `M0,${-r} L${r},${r * 0.75} L${-r},${r * 0.75} Z`);
            } else if (d.type === "individual_bracket") {
              t.attr("d", `M0,${-r} L${r},0 L0,${r} L${-r},0 Z`);
            }
          }
        });

      sim?.force("collide", d3.forceCollide<SimNode>().radius((d) => (d.baseRadius ?? 20) + 10).strength(0.7))
        .alpha(0.2)
        .restart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [vizOptions?.nodeSizeEncoding]);

    // ── Category A — Strength filter ─────────────────────────────────────────
    useEffect(() => {
      const svgEl = svgRef.current;
      if (!svgEl) return;
      const threshold = vizOptions?.strengthFilter ?? 0;
      d3.select(svgEl)
        .selectAll<SVGLineElement, SimLink>(".links line")
        .style("display", (d) => (d.strength ?? 1) >= threshold ? null : "none");
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [vizOptions?.strengthFilter]);

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
        const cleanId = nodeId.replace(/^official:/, '');
        window.open(`/officials/${cleanId}`, "_blank");
      }, []),

      addToComparison: useCallback((_nodeId: string) => {
      }, []),

      expandNode: useCallback((_nodeId: string) => {
      }, []),

      viewGroupAsTreemap: onViewGroupAsTreemap,
      viewGroupAsChord: onViewGroupAsChord,
      viewGroupAsSunburst: onViewGroupAsSunburst,
      removeGroup: onRemoveGroup,
      retryGroup: onRetryGroup,
      openDonorList: onOpenDonorList,
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

        {/* Alignment edge tooltip */}
        {alignTooltip && (
          <AlignmentEdgeTooltip
            officialName={alignTooltip.officialName}
            ratio={alignTooltip.ratio}
            matchedVotes={alignTooltip.matchedVotes}
            totalVotes={alignTooltip.totalVotes}
            voteDetails={alignTooltip.voteDetails}
            x={alignTooltip.x}
            y={alignTooltip.y}
          />
        )}

        {/* FIX-585 — investigation edge attribution popover */}
        {investTooltip && (
          <InvestigationEdgeTooltip
            title={investTooltip.title}
            investigationId={investTooltip.investigationId}
            reviewedAt={investTooltip.reviewedAt}
            relationship={investTooltip.relationship}
            x={investTooltip.x}
            y={investTooltip.y}
          />
        )}

        {/* FIX-585 — investigation-edge filter toggle (shown only when present) */}
        {hasInvestigationEdges && (
          <button
            type="button"
            onClick={() => setShowInvestigation((v) => !v)}
            className="absolute top-4 right-4 flex items-center gap-1.5 rounded-full border bg-card/90 px-2.5 py-1 text-[11px] font-medium shadow-sm backdrop-blur-sm"
            style={{ borderColor: INVESTIGATION_EDGE_COLOR, color: INVESTIGATION_EDGE_COLOR }}
            title="Community claims promoted to the graph"
          >
            <span
              className="inline-block h-2 w-4 rounded-full"
              style={{
                background: showInvestigation
                  ? `repeating-linear-gradient(90deg, ${INVESTIGATION_EDGE_COLOR} 0 5px, transparent 5px 8px)`
                  : "transparent",
                border: `1px solid ${INVESTIGATION_EDGE_COLOR}`,
              }}
            />
            Investigation edges {showInvestigation ? "on" : "off"}
          </button>
        )}

        <NodePopup
          node={popup}
          onClose={() => setPopup(null)}
          actions={nodeActions}
          vizType="force"
        />

        {/* Type-cluster sector legend */}
        {vizOptions?.typeClusterEnabled && (() => {
          const seen = new Set<string>();
          for (const n of nodes) {
            const k = n.type === "individual_bracket" ? "individual" : n.type;
            if (k in TYPE_LEGEND) seen.add(k);
          }
          const items = [...seen].sort(
            (a, b) => (TYPE_CLUSTER_ANGLES[a] ?? 0) - (TYPE_CLUSTER_ANGLES[b] ?? 0)
          );
          if (!items.length) return null;
          return (
            <div className="absolute bottom-4 left-4 bg-card/90 backdrop-blur-sm border border-rule rounded-lg px-2.5 py-2 shadow-sm pointer-events-none">
              <div className="text-[9px] font-semibold text-ink-soft uppercase tracking-wide mb-1.5">Type sectors</div>
              <div className="space-y-0.5">
                {items.map(k => (
                  <div key={k} className="flex items-center gap-1.5 text-[10px] text-ink">
                    <span className="w-4 text-center text-ink-soft font-medium">{TYPE_LEGEND[k]!.compass}</span>
                    <span>{TYPE_LEGEND[k]!.label}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {/* Donation size scale legend */}
        {vizOptions?.nodeSizeEncoding === "donation_total" && (() => {
          const BASE = 16;
          const entries: { amt: number; label: string }[] = [
            { amt: 100_000,    label: '$100K' },
            { amt: 1_000_000,  label: '$1M'   },
            { amt: 10_000_000, label: '$10M'  },
          ];
          const maxR = BASE + Math.sqrt(10_000_000 / 100_000) * 2;
          return (
            <div className="absolute bottom-4 right-4 bg-card/90 backdrop-blur-sm border border-rule rounded-lg px-2.5 py-2 shadow-sm pointer-events-none">
              <div className="text-[9px] font-semibold text-ink-soft uppercase tracking-wide mb-2">Node size</div>
              <div className="space-y-1.5">
                {entries.map(({ amt, label }) => {
                  const r = BASE + Math.sqrt(amt / 100_000) * 2;
                  const px = Math.round(r * 1.4);
                  return (
                    <div key={amt} className="flex items-center gap-2 text-[10px] text-ink">
                      <div className="flex items-center justify-center" style={{ width: Math.round(maxR * 1.4) + 2 }}>
                        <div className="rounded-full bg-amber/10 border border-amber" style={{ width: px, height: px }} />
                      </div>
                      <span>{label}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}
      </div>
    );
  }
);

ForceGraph.displayName = "ForceGraph";
