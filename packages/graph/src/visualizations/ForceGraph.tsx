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

/** FIX-828 — money-edge click payload handed to GraphPage for the edge sheet. */
export interface EdgeClickPayload {
  fromId: string;
  fromName: string;
  fromType: string;
  toId: string;
  toName: string;
  toType: string;
  connectionType: string;
  amountUsd?: number;
  txCount?: number;
  occurredAt?: string;
}

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
   * FIX-812 — transient neighborhood spotlight driven by hovering an entity
   * row in the left panel. Accepts the focus entity id (raw or type-prefixed);
   * resolves through the same FIX-807 hover pathway as canvas node hover and
   * clears on null. Panel hover and canvas hover can't overlap (the pointer is
   * in one place), so sharing the hover refs is safe.
   */
  panelHoverEntityId?: string | null;
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
  /**
   * FIX-827 — NodePopup "Expand here" on a node. Receives the full node so the
   * caller can drive the incremental neighborhood merge in useGraphData.
   */
  onExpandNode?: (node: GraphNode) => void;
  /** FIX-827 — collapse an expanded origin (undo its expansion). */
  onCollapseNode?: (node: GraphNode) => void;
  /** FIX-827 — promote an expanded origin into a real focus entity. */
  onPromoteNode?: (node: GraphNode) => void;
  /** FIX-827 — origins currently expanded (badge flips + / expanded indicator). */
  expandedOriginIds?: Set<string>;
  /** FIX-827 — nodes introduced by an expansion (rendered lightweight/dashed). */
  expansionAddedIds?: Set<string>;
  /** FIX-827 — current donation Top-N, surfaced in the "Expand here (top N)" label. */
  donationLimit?: number;
  /** FIX-826 — currently multi-selected node ids (shift-click). Dashed accent ring. */
  selectedNodeIds?: Set<string>;
  /** FIX-826 — toggle a node in/out of the selection set (shift-click). */
  onToggleSelect?: (nodeId: string) => void;
  /** FIX-828 — a money edge (donation/opposition/contract) was clicked → open the edge sheet. */
  onEdgeSelect?: (payload: EdgeClickPayload) => void;
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
  // FIX-807 — hover label inputs: txCount rides rollup-sourced aggregate
  // edges (FIX-802); occurredAt dates vote edges.
  txCount?: number;
  occurredAt?: string;
  // FIX-585 — investigation-promoted edges render distinctly + filterable + attributed.
  evidenceSource?: string;
  investigationId?: string;
  investigationTitle?: string;
  reviewedAt?: string;
};

const linkSrcId = (d: SimLink): string => (d.source as SimNode)?.id ?? d.fromId;
const linkTgtId = (d: SimLink): string => (d.target as SimNode)?.id ?? d.toId;

// ── FIX-807 — single opacity resolver ─────────────────────────────────────────
// Previously four channels fought over dimming: hover attr("opacity"), the
// connection-style effect attr("stroke-opacity") + style("display"), the
// strength filter's own style("display"), and SharedConnectionsBar's
// style("opacity") — inline style silently wins over attrs, and the hover
// handlers closed over a stale opacity fn, so toggling a type then hovering
// restored last-load opacities. Everything now resolves through ONE ctx-driven
// pair and applies through ONE channel: style("opacity"), with
// style("display") computed in the same pass.

interface OpacityCtx {
  connections: GraphView["connections"];
  focusIds: Set<string>;
  /** Hovered node id, or null. */
  hoverId: string | null;
  /** Hovered node + its neighbors (set only while hovering). */
  hoverNeighborIds: Set<string> | null;
  /** SharedConnectionsBar pinned node id (FIX-149), or null. */
  highlightedId: string | null;
  showInvestigation: boolean;
  strengthFilter: number;
}

function edgeVisible(d: SimLink, ctx: OpacityCtx): boolean {
  // FIX-585 — investigation edges follow their own toggle, not the type filter.
  if (d.evidenceSource === "investigation") {
    if (!ctx.showInvestigation) return false;
  } else if (Object.keys(ctx.connections).length > 0) {
    const conn = ctx.connections[d.connectionType];
    if (conn && conn.enabled === false) return false; // unknown type: show
  }
  return (d.strength ?? 1) >= ctx.strengthFilter;
}

function baseEdgeOpacity(d: SimLink, ctx: OpacityCtx): number {
  if (d.connectionType === "alignment") return 0.85;
  const isShared = ctx.focusIds.has(linkSrcId(d)) && ctx.focusIds.has(linkTgtId(d));
  if (isShared) return 0.9;
  return ctx.connections[d.connectionType]?.opacity ?? 0.6;
}

/** Hover > pinned shared-connections highlight > per-type settings. */
function resolveEdgeOpacity(d: SimLink, ctx: OpacityCtx): number {
  if (ctx.hoverId) {
    const incident = linkSrcId(d) === ctx.hoverId || linkTgtId(d) === ctx.hoverId;
    return incident ? 0.9 : 0.04;
  }
  if (ctx.highlightedId) {
    // Spotlight edges between the pinned node and a focused entity (FIX-149).
    const s = linkSrcId(d);
    const t = linkTgtId(d);
    const spotlight =
      (s === ctx.highlightedId && ctx.focusIds.has(t)) ||
      (t === ctx.highlightedId && ctx.focusIds.has(s));
    return spotlight ? 1 : 0.1;
  }
  return baseEdgeOpacity(d, ctx);
}

function resolveNodeOpacity(n: SimNode, ctx: OpacityCtx): number {
  if (ctx.hoverNeighborIds) return ctx.hoverNeighborIds.has(n.id) ? 1 : 0.12;
  if (ctx.highlightedId) {
    return n.id === ctx.highlightedId || ctx.focusIds.has(n.id) ? 1 : 0.2;
  }
  return 1;
}

// ── FIX-807 — edge hover labels with amounts ──────────────────────────────────
// Compact-$ idiom shared by ChordGraph/SankeyGraph/etc. (this package doesn't
// depend on @civitics/ui, where formatUSD lives).
function fmtCompactUsd(usd: number): string {
  if (usd >= 1_000_000_000) return `$${(usd / 1_000_000_000).toFixed(1)}B`;
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(0)}K`;
  return `$${Math.round(usd).toLocaleString("en-US")}`;
}

const VOTE_EDGE_TYPES = new Set([
  "vote_yes", "vote_no", "vote_abstain", "nomination_vote_yes", "nomination_vote_no",
]);

function edgeHoverLabel(d: SimLink): string {
  const typeLabel = (CONNECTION_TYPE_REGISTRY[d.connectionType]?.label ?? d.connectionType ?? "").replace(/_/g, " ");
  if (CONNECTION_TYPE_REGISTRY[d.connectionType]?.hasAmount && d.amountUsd) {
    const base = `${typeLabel} — ${fmtCompactUsd(d.amountUsd)}`;
    return d.txCount ? `${base} · ${d.txCount.toLocaleString("en-US")} txs` : base;
  }
  if (VOTE_EDGE_TYPES.has(d.connectionType) && d.occurredAt) {
    const date = new Date(d.occurredAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    return `${typeLabel} · ${date}`;
  }
  return typeLabel;
}

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
      panelHoverEntityId = null,
      onNodeClick,
      onNodeHover,
      className,
      onViewGroupAsTreemap,
      onViewGroupAsChord,
      onViewGroupAsSunburst,
      onRemoveGroup,
      onRetryGroup,
      onOpenDonorList,
      onExpandNode,
      onCollapseNode,
      onPromoteNode,
      expandedOriginIds,
      expansionAddedIds,
      donationLimit = 25,
      selectedNodeIds,
      onToggleSelect,
      onEdgeSelect,
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

    // ── FIX-807 — latest-value refs for the opacity resolver ─────────────────
    // Hover handlers are bound once per data rebuild; reading through refs
    // means they never close over stale settings (the old bug: toggling a
    // connection type didn't rebind them, so mouseleave restored last-load
    // opacities).
    const settingsRef = useRef(connections);
    settingsRef.current = connections;
    const focusIdsRef = useRef<Set<string>>(new Set());
    focusIdsRef.current = new Set(focusEntities.map((fe) => fe.id));
    const highlightedIdRef = useRef<string | null>(highlightedNodeId);
    highlightedIdRef.current = highlightedNodeId;
    const showInvestigationRef = useRef(showInvestigation);
    showInvestigationRef.current = showInvestigation;
    const strengthFilterRef = useRef(vizOptions?.strengthFilter ?? 0);
    strengthFilterRef.current = vizOptions?.strengthFilter ?? 0;
    const hoverIdRef = useRef<string | null>(null);
    const hoverNeighborIdsRef = useRef<Set<string> | null>(null);
    const edgeLabelGrpRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
    const edgeLabelSelRef = useRef<d3.Selection<SVGTextElement, SimLink, SVGGElement, unknown> | null>(null);
    // FIX-828 — transparent wide hit-area lines carry the edge click (below the
    // visible links so the FIX-807 hover handlers on the visible lines are
    // untouched; near-miss clicks land here). Display is synced in applyOpacity.
    const hitLinkSelRef = useRef<d3.Selection<SVGLineElement, SimLink, SVGGElement, unknown> | null>(null);

    // FIX-826/828 — latest-value refs so d3 handlers (bound once per rebuild)
    // never close over a stale callback / selection.
    const onToggleSelectRef = useRef(onToggleSelect);
    onToggleSelectRef.current = onToggleSelect;
    const onEdgeSelectRef = useRef(onEdgeSelect);
    onEdgeSelectRef.current = onEdgeSelect;

    // The ONE writer for dimming/visibility. Every trigger (hover, type
    // toggle, strength filter, shared-connections pin, data rebuild) funnels
    // through here; style() is the only channel so nothing silently loses to
    // an inline style set elsewhere.
    const applyOpacity = useCallback(() => {
      const link = linkSelRef.current;
      const nodeGrp = nodeGrpRef.current;
      if (!link || !nodeGrp) return;
      const ctx: OpacityCtx = {
        connections: settingsRef.current ?? {},
        focusIds: focusIdsRef.current,
        hoverId: hoverIdRef.current,
        hoverNeighborIds: hoverNeighborIdsRef.current,
        highlightedId: highlightedIdRef.current,
        showInvestigation: showInvestigationRef.current,
        strengthFilter: strengthFilterRef.current,
      };

      link
        .style("display", (d: SimLink) => (edgeVisible(d, ctx) ? null : "none"))
        .style("opacity", (d: SimLink) => resolveEdgeOpacity(d, ctx));

      // FIX-828 — hidden edges must not be clickable: mirror display onto the
      // transparent hit-area lines (they carry no opacity of their own).
      hitLinkSelRef.current?.style("display", (d: SimLink) => (edgeVisible(d, ctx) ? null : "none"));

      // Nodes whose every edge is hidden hide too. Focused entities, groups,
      // and the USER node always stay visible.
      const visibleNodeIds = new Set<string>();
      link.each(function (d: SimLink) {
        if (!edgeVisible(d, ctx)) return;
        visibleNodeIds.add(linkSrcId(d));
        visibleNodeIds.add(linkTgtId(d));
      });
      nodeGrp
        .style("display", (n: SimNode) => {
          if (ctx.focusIds.has(n.id)) return null;
          if (n.type === "user" || n.type === "group") return null;
          return visibleNodeIds.has(n.id) ? null : "none";
        })
        .style("opacity", (n: SimNode) => resolveNodeOpacity(n, ctx));

      // Edge hover labels follow the hover target (visible edges only).
      edgeLabelGrpRef.current?.attr("opacity", ctx.hoverId ? 1 : 0);
      edgeLabelSelRef.current?.attr("opacity", (d: SimLink) => {
        if (!ctx.hoverId || !edgeVisible(d, ctx)) return 0;
        return linkSrcId(d) === ctx.hoverId || linkTgtId(d) === ctx.hoverId ? 1 : 0;
      });
    }, []);

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
        txCount: e.txCount,
        occurredAt: e.occurredAt,
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

      // FIX-828 — edge click: money edges (hasAmount) open the aggregate sheet;
      // vote edges navigate to the proposal; every other edge is inert.
      function handleEdgeClick(event: MouseEvent, d: SimLink) {
        event.stopPropagation();
        const reg = CONNECTION_TYPE_REGISTRY[d.connectionType];
        if (reg?.hasAmount) {
          const s = d.source as SimNode;
          const t = d.target as SimNode;
          onEdgeSelectRef.current?.({
            fromId: s.id, fromName: s.name, fromType: s.type,
            toId: t.id, toName: t.name, toType: t.type,
            connectionType: d.connectionType,
            amountUsd: d.amountUsd, txCount: d.txCount, occurredAt: d.occurredAt,
          });
          return;
        }
        if (VOTE_EDGE_TYPES.has(d.connectionType)) {
          const proposal = [d.source as SimNode, d.target as SimNode].find((n) => n?.type === "proposal");
          if (proposal) window.open(`/proposals/${proposal.id.replace(/^proposal:/, "")}`, "_blank");
        }
      }

      // Transparent wide hit-area lines UNDER the visible links so near-miss
      // clicks on thin edges still register. Kept below the visible links so the
      // FIX-807 hover handlers (align/investigation) on the visible lines fire
      // normally when the pointer is directly over them.
      const hitGroup = g.append("g").attr("class", "link-hitarea");
      const hitLink = hitGroup
        .selectAll<SVGLineElement, SimLink>("line")
        .data(simLinks)
        .join("line")
        .attr("stroke", "transparent")
        .attr("stroke-width", 14)
        .attr("fill", "none")
        .style("cursor", "pointer")
        .style("pointer-events", "stroke")
        .on("click", handleEdgeClick);
      hitLinkSelRef.current = hitLink;

      const linkGroup = g.append("g").attr("class", "links");
      const link = linkGroup
        .selectAll<SVGLineElement, SimLink>("line")
        .data(simLinks)
        .join("line")
        .attr("class", "link")
        .attr("stroke", edgeColor)
        .attr("stroke-width", edgeWidthFn)
        // FIX-807 — opacity + display are owned by applyOpacity() (single
        // channel), called at the end of this rebuild.
        // FIX-585 — dash investigation edges so they read as asserted-not-derived.
        // FIX-747 — dash opposition (IE-against) edges so red opposition spend
        // reads as distinct from support money and from solid-red vote_no.
        .attr("stroke-dasharray", (d) =>
          d.evidenceSource === "investigation" ? "5 3" : d.connectionType === "opposition" ? "6 4" : null)
        .attr("marker-end", (d) => `url(#arrow-${d.connectionType})`);

      linkSelRef.current = link;

      // FIX-828 — a click directly on the (topmost) visible line also opens the
      // sheet; the hit-area beneath handles the wider near-miss target.
      link.style("cursor", "pointer").on("click", handleEdgeClick);

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

      // Edge labels (shown on hover). FIX-807 — amount-bearing edges carry
      // "$47.2M · 1,234 txs" (txCount from the FIX-802 rollup); vote edges
      // carry their date.
      const edgeLabelGroup = g.append("g").attr("class", "edge-labels").attr("opacity", 0);
      const edgeLabel = edgeLabelGroup
        .selectAll<SVGTextElement, SimLink>("text")
        .data(simLinks)
        .join("text")
        .attr("text-anchor", "middle")
        .attr("font-size", "9px")
        .attr("fill", edgeColor)
        .attr("font-weight", "600")
        .text(edgeHoverLabel);

      edgeLabelGrpRef.current = edgeLabelGroup;
      edgeLabelSelRef.current = edgeLabel;

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

        // FIX-827 — expansion-added nodes render lightweight (dashed stroke) so
        // they read as "pulled in by an expand", distinct from focus-fetched
        // nodes. Focus entities keep their solid highlight stroke.
        if (expansionAddedIds?.has(d.id) && !focusIds.has(d.id)) {
          el.select<SVGElement>(".node-circle").attr("stroke-dasharray", "4,3");
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

        // Collapsed / expanded badge (top-right). FIX-827 — an expanded origin
        // flips the collapsed "+" to a blue "−" (click → Collapse in the popup).
        if (expandedOriginIds?.has(d.id)) {
          el.append("circle")
            .attr("cx", r - 2).attr("cy", -(r - 2))
            .attr("r", 9)
            .attr("fill", pal.blue)
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
            .text("−");
        } else if (d.collapsed) {
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
          // FIX-807 — set hover state on refs and repaint through the single
          // resolver. No direct opacity writes here: leaving hover restores
          // CURRENT settings (the old handlers closed over a stale opacity fn).
          hoverIdRef.current = d.id;
          hoverNeighborIdsRef.current = connectedIds(d);
          applyOpacity();
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
          hoverIdRef.current = null;
          hoverNeighborIdsRef.current = null;
          applyOpacity();
          d3.select(this).select("circle,rect,path").attr("filter", null);
          hideTip();
          onNodeHover?.(null, 0, 0);
        })
        .on("click", (event: MouseEvent, d) => {
          event.stopPropagation();
          hideTip();
          // FIX-826 — shift-click toggles multi-selection instead of the popup
          // (plain click keeps the existing popup behavior).
          if (event.shiftKey && onToggleSelectRef.current && d.type !== "user") {
            onToggleSelectRef.current(d.id);
            return;
          }
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
        // FIX-815 — cooling tuned so the layout comes to rest within ~2s of a
        // full reheat instead of drifting for 5s+ (d3 defaults: alphaDecay
        // 0.0228 / alphaMin 0.001 / velocityDecay 0.4). Drag (alphaTarget 0.3)
        // and expand (rebuild at alpha 1) still reheat as before.
        .alphaDecay(0.04)
        .alphaMin(0.005)
        .velocityDecay(0.5);

      sim.on("tick", () => {
        link
          .attr("x1", (d) => (d.source as SimNode).x ?? 0)
          .attr("y1", (d) => (d.source as SimNode).y ?? 0)
          .attr("x2", (d) => (d.target as SimNode).x ?? 0)
          .attr("y2", (d) => (d.target as SimNode).y ?? 0);

        // FIX-828 — keep the transparent hit-area lines aligned with the visible ones.
        hitLink
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

      // FIX-807 — the DOM was rebuilt: any in-flight hover is gone. Reset
      // hover state and paint the initial opacity/visibility pass.
      hoverIdRef.current = null;
      hoverNeighborIdsRef.current = null;
      applyOpacity();

      return () => { sim.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [nodes, edges]);

    // ── Category A — Connection styles (color/width/dash) ─────────────────────
    // FIX-807 — opacity + display moved into applyOpacity(); this effect only
    // owns the paint attributes that per-type settings drive.
    useEffect(() => {
      const link = linkSelRef.current;
      if (!link) return;
      // FIX-729 — scope-aware token resolution for SVG presentation attrs
      // (var() fails in .attr(); resolve to concrete rgb() first).
      const svgEl = svgRef.current;

      const focusIds = new Set(focusEntities.map((fe) => fe.id));

      link
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

      applyOpacity();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // Driven by SharedConnectionsBar pill clicks. FIX-807 — both the highlight
    // and its clear go through the single resolver (the pin survives hover and
    // clears fully; refs were updated during render).
    useEffect(() => {
      applyOpacity();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [highlightedNodeId, focusEntities]);

    // ── Category A — Panel-row hover spotlight (FIX-812) ───────────────────────
    // Entity-row hover in the left panel feeds the same hover refs the canvas
    // mouseenter handler uses, so the FIX-807 resolver treats both identically.
    useEffect(() => {
      const sim = simRef.current;
      const links = (linkSelRef.current?.data() ?? []) as SimLink[];
      if (!sim) return;

      if (!panelHoverEntityId) {
        if (hoverIdRef.current !== null || hoverNeighborIdsRef.current !== null) {
          hoverIdRef.current = null;
          hoverNeighborIdsRef.current = null;
          applyOpacity();
        }
        return;
      }

      // Focus entity ids are raw uuids; node ids may be raw or "type:uuid".
      const target = sim.nodes().find(
        (n) => n.id === panelHoverEntityId || n.id.endsWith(`:${panelHoverEntityId}`)
      );
      if (!target) return;

      const neighbors = new Set([target.id]);
      for (const e of links) {
        const sid = linkSrcId(e);
        const tid = linkTgtId(e);
        if (sid === target.id) neighbors.add(tid);
        if (tid === target.id) neighbors.add(sid);
      }
      hoverIdRef.current = target.id;
      hoverNeighborIdsRef.current = neighbors;
      applyOpacity();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [panelHoverEntityId]);

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
        // FIX-815 — only restart when tearing down an actually-mounted force.
        // This effect re-runs on every focusEntities identity change; the old
        // unconditional restart reheated a settled layout on unrelated
        // re-renders (GraphPage passed a fresh .filter() array each render).
        if (sim.force("type-cluster")) {
          sim.force("type-cluster", null).alpha(0.3).restart();
        }
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
    // FIX-807 — folded into the single pass: this effect and the type-toggle
    // effect previously both wrote style("display") on the same lines, so
    // whichever ran last clobbered the other's hides.
    useEffect(() => {
      applyOpacity();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [vizOptions?.strengthFilter]);

    // ── Category A — FIX-826 multi-select dashed ring ─────────────────────────
    // Selecting is visual-only: toggle a dashed accent ring per selected node.
    // Re-runs on selection change AND on data rebuild (which recreates the node
    // groups, dropping the rings) so the rings reattach.
    useEffect(() => {
      const nodeGrp = nodeGrpRef.current;
      const svgEl = svgRef.current;
      if (!nodeGrp) return;
      const accent = resolveToken("--c-accent", svgEl);
      const sel = selectedNodeIds ?? new Set<string>();
      nodeGrp.each(function (d) {
        const el = d3.select(this);
        el.selectAll(".selection-ring").remove();
        if (sel.has(d.id)) {
          el.append("circle")
            .attr("class", "selection-ring")
            .attr("r", (d.baseRadius ?? 20) + 5)
            .attr("fill", "none")
            .attr("stroke", accent)
            .attr("stroke-width", 2)
            .attr("stroke-dasharray", "4,3")
            .attr("opacity", 0.95)
            .attr("pointer-events", "none");
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedNodeIds, nodes]);

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

      // FIX-827 — incremental expand / collapse / promote. Each hands the full
      // node to GraphPage, which drives useGraphData's merge-based expansion.
      expandNode: useCallback((nodeId: string) => {
        const target = nodes.find((n) => n.id === nodeId);
        if (target) onExpandNode?.(target);
      }, [nodes, onExpandNode]),

      collapseNode: useCallback((nodeId: string) => {
        const target = nodes.find((n) => n.id === nodeId);
        if (target) onCollapseNode?.(target);
      }, [nodes, onCollapseNode]),

      promoteNode: useCallback((nodeId: string) => {
        const target = nodes.find((n) => n.id === nodeId);
        if (target) onPromoteNode?.(target);
      }, [nodes, onPromoteNode]),

      viewGroupAsTreemap: onViewGroupAsTreemap,
      viewGroupAsChord: onViewGroupAsChord,
      viewGroupAsSunburst: onViewGroupAsSunburst,
      removeGroup: onRemoveGroup,
      retryGroup: onRetryGroup,
      openDonorList: onOpenDonorList,
    };

    // FIX-827 — expand affordance state for the popup node. Expanded origins
    // offer Collapse/Promote; expandable entities (real uuid, not already in
    // focus) offer "Expand here (top N)".
    const EXPANDABLE_TYPES = new Set([
      "official", "agency", "proposal", "financial", "corporation", "individual", "organization", "pac",
    ]);
    function popupExpandState(n: GraphNode | null): "none" | "expandable" | "expanded" {
      if (!n) return "none";
      if (expandedOriginIds?.has(n.id)) return "expanded";
      const isFocus = focusEntities.some((fe) => fe.id === n.id || n.id.endsWith(`:${fe.id}`));
      if (isFocus || !EXPANDABLE_TYPES.has(n.type)) return "none";
      const raw = n.id.replace(/^[a-z_]+:/, "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return "none";
      return "expandable";
    }

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
          expandState={popupExpandState(popup)}
          expandLabel={`Expand here (top ${donationLimit})`}
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
