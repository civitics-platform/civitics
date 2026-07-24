/**
 * @civitics/graph
 *
 * D3 force simulation for the Civitics connection graph.
 * G3: New three-layer architecture. Old sidebar/panel components removed.
 *
 * CRITICAL: This must use D3, never React Flow.
 * The organic force layout IS the analysis — dense clusters mean deep entanglement,
 * bridge nodes reveal hidden connections. React Flow cannot reproduce this.
 */

// ── Core types ──────────────────────────────────────────────────────────────
export type {
  GraphView,
  GraphViewPreset,
  VizType,
  VizProps,
  VizDefinition,
  GraphNode as GraphNodeV2,
  GraphEdge as GraphEdgeV2,
  FocusEntity,
  FocusGroup,
  FocusItem,
  GroupFilter,
  FocusOperation,
  UpdateCategory,
  ForceOptions,
  ChordOptions,
  TreemapOptions,
  SunburstOptions,
  HierarchyOptions,
  MatrixOptions,
  AlignmentOptions,
  SankeyOptions,
  SpendingOptions,
  ScatterOptions,
  ChoroplethOptions,
  GanttOptions,
  NodeActions,
  NodeType as NodeTypeV2,
  ConnectionTypeDefinition,
} from "./types";
export type { VizApplicability, VizApplicabilityMeta } from "./types";
export type { IndividualDisplayMode, BracketTier } from "./types";
export { MAX_FOCUS_ENTITIES, isFocusGroup, isFocusEntity, isSelectionGroup, BRACKET_TIERS } from "./types";

// ── Canonical node-id scheme (FIX-849) ──────────────────────────────────────
export { makeNodeId, extractUuid, matchesFocus, isFocusNode, NODE_ID_TYPES } from "./nodeId";
export type { NodeIdType } from "./nodeId";
export { graphGroupParams } from "./groupQuery";

// ── Presets + connections ───────────────────────────────────────────────────
export { DEFAULT_GRAPH_VIEW, BUILT_IN_PRESETS, applyPreset, markDirty } from "./presets";
export { CONNECTION_TYPE_REGISTRY, DEFAULT_CONNECTION_STATE, DEFAULT_DONATION_LIMIT } from "./connections";

// ── Saved views (FIX-817) ───────────────────────────────────────────────────
export {
  listSavedViews,
  saveView,
  deleteSavedView,
  clampLegacyView,
  SAVED_VIEWS_CHANGE_EVENT,
} from "./saved-views";
export type { SavedView } from "./saved-views";

// ── Design-token helpers (FIX-729) ──────────────────────────────────────────
export { resolveToken, resolvePaperToken, resolveColor, withAlpha, toHexColor } from "./tokens";

// ── Icon registry (FIX-730) ─────────────────────────────────────────────────
export { Icon, resolveIcon, hasIcon, ICON_REGISTRY, GENERIC_ICON } from "./icons";

import { CONNECTION_TYPE_REGISTRY } from "./connections";

// ── Groups ──────────────────────────────────────────────────────────────────
export {
  BUILT_IN_GROUPS,
  getGroupById,
  createCustomGroup,
} from "./groups";

// ── Recently viewed (FIX-140) ───────────────────────────────────────────────
export { recordRecent, loadRecent, clearRecent } from "./recently-viewed";
export type { RecentEntity } from "./recently-viewed";

// ── Registry ────────────────────────────────────────────────────────────────
export { VIZ_REGISTRY, vizRegistry, getVizApplicability } from "./visualizations/registry";
export type { VizMode, VizRegistryEntry } from "./visualizations/registry";

// ── Hooks ───────────────────────────────────────────────────────────────────
export { useGraphView } from "./hooks/useGraphView";
export type { UseGraphViewReturn } from "./hooks/useGraphView";
export { useGraphData } from "./hooks/useGraphData";
export type { GraphMeta } from "./hooks/useGraphData";
export { useEntitySearch } from "./hooks/useEntitySearch";

// ── Visualizations ──────────────────────────────────────────────────────────
export { ForceGraph } from "./visualizations/ForceGraph";
export type { ForceGraphProps } from "./visualizations/ForceGraph";

export { TreemapGraph } from "./TreemapGraph";
export type { TreemapGraphProps } from "./TreemapGraph";

export { ChordGraph } from "./ChordGraph";
export type { ChordGraphProps } from "./ChordGraph";

export { SunburstGraph, CivicBadge } from "./SunburstGraph";
export type { SunburstGraphProps } from "./SunburstGraph";

export { SpendingGraph } from "./SpendingGraph";
export type { SpendingGraphProps } from "./SpendingGraph";

export { HierarchyGraph } from "./HierarchyGraph";
export type { HierarchyGraphProps } from "./HierarchyGraph";

export { MatrixGraph } from "./MatrixGraph";
export type { MatrixGraphProps } from "./MatrixGraph";

export { AlignmentGraph } from "./AlignmentGraph";
export type { AlignmentGraphProps } from "./AlignmentGraph";

export { SankeyGraph } from "./SankeyGraph";
export type { SankeyGraphProps } from "./SankeyGraph";

// FIX-217 — new viz components
export { ScatterGraph } from "./ScatterGraph";
export type { ScatterGraphProps } from "./ScatterGraph";

export { ChoroplethGraph } from "./ChoroplethGraph";
export type { ChoroplethGraphProps } from "./ChoroplethGraph";

export { GanttGraph } from "./GanttGraph";
export type { GanttGraphProps } from "./GanttGraph";

// ── Components — panels ─────────────────────────────────────────────────────
export { GraphHeader } from "./components/GraphHeader";
export type { GraphHeaderProps } from "./components/GraphHeader";

export { DataExplorerPanel, LEFT_PANEL_DEFAULT_WIDTH } from "./components/DataExplorerPanel";
export type { DataExplorerPanelProps } from "./components/DataExplorerPanel";

export { GraphConfigPanel, RIGHT_PANEL_DEFAULT_WIDTH } from "./components/GraphConfigPanel";
export type { GraphConfigPanelProps } from "./components/GraphConfigPanel";

// ── Components — panel primitives ───────────────────────────────────────────
export { TreeNode, TreeSection } from "./components/TreeNode";
export type { TreeNodeProps, TreeNodeAction, TreeNodeVariant, TreeSectionProps } from "./components/TreeNode";

export { FocusTree } from "./components/FocusTree";
export type { FocusTreeProps, UserNodeInfo } from "./components/FocusTree";

export { ConnectionsTree } from "./components/ConnectionsTree";
export type { ConnectionsTreeProps } from "./components/ConnectionsTree";

export { ConnectionStyleRow } from "./components/ConnectionStyleRow";
export type { ConnectionStyleRowProps, ConnectionTypeSettings } from "./components/ConnectionStyleRow";

export { AlignmentPanel } from "./components/AlignmentPanel";
export type { AlignmentPanelProps } from "./components/AlignmentPanel";

export { SharedConnectionsBar, findSharedConnections } from "./components/SharedConnectionsBar";
export type { SharedConnectionsBarProps, SharedConnection } from "./components/SharedConnectionsBar";

// ── Components — shared overlays ────────────────────────────────────────────
export { NodePopup } from "./components/NodePopup";
export type { NodePopupProps } from "./components/NodePopup";

export { DonorListPanel } from "./components/DonorListPanel";
export type { DonorListPanelProps } from "./components/DonorListPanel";

// ── G5 (FIX-826/828) — selection pill + edge sheet ──────────────────────────
export { SelectionPill } from "./components/SelectionPill";
export type { SelectionPillProps } from "./components/SelectionPill";

export { EdgeSheet } from "./components/EdgeSheet";
export type { EdgeSheetProps, EdgeSheetData } from "./components/EdgeSheet";

export type { EdgeClickPayload } from "./visualizations/ForceGraph";

// ── CSV export (FIX-829) ────────────────────────────────────────────────────
export { graphToCsv, downloadCsv, graphCsvFilename, csvField } from "./csv";

export { Tooltip, useTooltip } from "./components/Tooltip";
export type { TooltipProps, TooltipState } from "./components/Tooltip";

// ── Standalone tools (kept, not embedded in panels) ─────────────────────────
export { PathFinder } from "./PathFinder";
export type { PathFinderProps } from "./PathFinder";

export { AiNarrative } from "./AiNarrative";
export type { AiNarrativeProps } from "./AiNarrative";

// EmbedModal + CollapsiblePanel deleted (FIX-806) — zero consumers left;
// SharePanel's embed snippet is the surviving embed path.

// ── Legacy types — kept for backward compat with any external consumers ─────
// These are the old flat GraphNode / GraphEdge used in the original ForceGraph.
// New code should import GraphNodeV2 / GraphEdgeV2 from types.ts instead.
export type NodeType =
  | "official"
  | "governing_body"
  | "proposal"
  | "initiative"
  | "corporation"
  | "pac"
  | "individual";

export type EdgeType =
  | "donation"
  | "opposition"
  | "vote_yes"
  | "vote_no"
  | "vote_abstain"
  | "nomination_vote_yes"
  | "nomination_vote_no"
  | "appointment"
  | "revolving_door"
  | "oversight"
  | "lobbying"
  | "co_sponsorship"
  | "contract_award";

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  photoUrl?: string;
  party?: "democrat" | "republican" | "independent" | "nonpartisan";
  metadata: Record<string, unknown>;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  amountCents?: number;
  occurredAt?: string;
  strength: number;
}

// ── Token palettes (FIX-729) ────────────────────────────────────────────────
// Values are `rgb(var(--c-x))` design-token strings. In SVG apply via style=/
// d3 .style(), or resolve with resolveColor()/resolveToken() from ./tokens for
// .attr()/interpolator/export contexts. Node FILLS are paper-family on purpose
// ("records on the terminal") — resolve them from :root (no scope element) so
// they stay light chips on the dark instrument.

export const NODE_COLORS: Record<NodeType, { fill: string; stroke: string }> = {
  official:       { fill: "rgb(var(--c-card))", stroke: "rgb(var(--c-blue))" },
  governing_body: { fill: "rgb(var(--c-card))", stroke: "rgb(var(--c-viz-5))" },
  proposal:       { fill: "rgb(var(--c-card))", stroke: "rgb(var(--c-amber))" },
  initiative:     { fill: "rgb(var(--c-card))", stroke: "rgb(var(--c-green-ink))" },
  corporation:    { fill: "rgb(var(--c-card))", stroke: "rgb(var(--c-green-ink))" },
  pac:            { fill: "rgb(var(--c-card))", stroke: "rgb(var(--c-viz-6))" },
  individual:     { fill: "rgb(var(--c-card))", stroke: "rgb(var(--c-blue))" },
};

// Canonical party palette (value form). The Badge component in @civitics/ui is
// the class-form reference. Wine (viz-7) stands in for independents — the
// token system has no purple (FIX-719).
export const PARTY_COLORS: Record<string, string> = {
  democrat:    "rgb(var(--c-blue))",
  republican:  "rgb(var(--c-accent))",
  independent: "rgb(var(--c-viz-7))",
  nonpartisan: "rgb(var(--c-ink-soft))",
};

// Derived from CONNECTION_TYPE_REGISTRY — the registry is the single
// authoritative edge palette (FIX-729). `lobbying` is a legacy edge type with
// no registry entry (no derived data writes it today); it keeps a ramp hue
// here so old consumers stay total over EdgeType.
export const EDGE_COLORS: Record<EdgeType, string> = {
  donation:            CONNECTION_TYPE_REGISTRY['donation']!.color,
  opposition:          CONNECTION_TYPE_REGISTRY['opposition']!.color,
  vote_yes:            CONNECTION_TYPE_REGISTRY['vote_yes']!.color,
  vote_no:             CONNECTION_TYPE_REGISTRY['vote_no']!.color,
  vote_abstain:        CONNECTION_TYPE_REGISTRY['vote_abstain']!.color,
  nomination_vote_yes: CONNECTION_TYPE_REGISTRY['nomination_vote_yes']!.color,
  nomination_vote_no:  CONNECTION_TYPE_REGISTRY['nomination_vote_no']!.color,
  appointment:         CONNECTION_TYPE_REGISTRY['appointment']!.color,
  revolving_door:      CONNECTION_TYPE_REGISTRY['revolving_door']!.color,
  oversight:           CONNECTION_TYPE_REGISTRY['oversight']!.color,
  lobbying:            "rgb(var(--c-viz-3))",
  co_sponsorship:      CONNECTION_TYPE_REGISTRY['co_sponsorship']!.color,
  contract_award:      CONNECTION_TYPE_REGISTRY['contract_award']!.color,
};

export function edgeWidth(edge: Pick<GraphEdge, "type" | "amountCents">): number {
  if (edge.type === "donation" && edge.amountCents) {
    return Math.min(6, Math.max(1, Math.log10(edge.amountCents / 100_000) + 3));
  }
  return 1.5;
}

export interface VisualConfig {
  nodeSizeEncoding: "connection_count" | "donation_total" | "votes_cast" | "bills_sponsored" | "years_in_office" | "uniform";
  nodeColorEncoding: "entity_type" | "party_affiliation" | "industry_sector" | "state_region" | "single_color";
  singleColor: string;
  edgeThicknessEncoding: "amount_proportional" | "strength_proportional" | "uniform";
  edgeOpacity: number;
  layout: "force" | "radial" | "circular";
  theme: "light" | "dark" | "print";
}

export const DEFAULT_VISUAL_CONFIG: VisualConfig = {
  nodeSizeEncoding: "connection_count",
  nodeColorEncoding: "entity_type",
  singleColor: "rgb(var(--c-blue))",
  edgeThicknessEncoding: "amount_proportional",
  edgeOpacity: 0.7,
  layout: "force",
  theme: "dark",
};

export interface EntitySearchResult {
  id: string;
  label: string;
  type: "official" | "agency" | "proposal" | "financial_entity";
  subtitle?: string;
  party?: string;
  connectionCount?: number;
}
