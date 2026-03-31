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
  NodeActions,
  NodeType as NodeTypeV2,
  ConnectionTypeDefinition,
} from "./types";
export { MAX_FOCUS_ENTITIES, isFocusGroup, isFocusEntity } from "./types";

// ── Presets + connections ───────────────────────────────────────────────────
export { DEFAULT_GRAPH_VIEW, BUILT_IN_PRESETS, applyPreset, markDirty } from "./presets";
export { CONNECTION_TYPE_REGISTRY, DEFAULT_CONNECTION_STATE } from "./connections";

// ── Groups ──────────────────────────────────────────────────────────────────
export {
  BUILT_IN_GROUPS,
  GROUP_CATEGORIES,
  getGroupById,
  createCustomGroup,
} from "./groups";

// ── Registry ────────────────────────────────────────────────────────────────
export { VIZ_REGISTRY, vizRegistry } from "./visualizations/registry";
export type { VizMode, VizRegistryEntry } from "./visualizations/registry";

// ── Hooks ───────────────────────────────────────────────────────────────────
export { useGraphView } from "./hooks/useGraphView";
export type { UseGraphViewReturn } from "./hooks/useGraphView";
export { useGraphData } from "./hooks/useGraphData";
export { useEntitySearch } from "./hooks/useEntitySearch";

// ── Visualizations ──────────────────────────────────────────────────────────
export { ForceGraph } from "./visualizations/ForceGraph";
export type { ForceGraphProps } from "./visualizations/ForceGraph";

export { TreemapGraph } from "./TreemapGraph";
export type { TreemapGraphProps } from "./TreemapGraph";

export { ChordGraph } from "./ChordGraph";
export type { ChordGraphProps } from "./ChordGraph";

export { SunburstGraph } from "./SunburstGraph";
export type { SunburstGraphProps } from "./SunburstGraph";

// ── Components — panels ─────────────────────────────────────────────────────
export { GraphHeader } from "./components/GraphHeader";
export type { GraphHeaderProps } from "./components/GraphHeader";

export { DataExplorerPanel } from "./components/DataExplorerPanel";
export type { DataExplorerPanelProps } from "./components/DataExplorerPanel";

export { GraphConfigPanel } from "./components/GraphConfigPanel";
export type { GraphConfigPanelProps } from "./components/GraphConfigPanel";

// ── Components — panel primitives ───────────────────────────────────────────
export { TreeNode, TreeSection } from "./components/TreeNode";
export type { TreeNodeProps, TreeNodeAction, TreeNodeVariant, TreeSectionProps } from "./components/TreeNode";

export { FocusTree } from "./components/FocusTree";
export type { FocusTreeProps } from "./components/FocusTree";

export { ConnectionsTree } from "./components/ConnectionsTree";
export type { ConnectionsTreeProps } from "./components/ConnectionsTree";

export { EntitySearchInput } from "./components/EntitySearchInput";
export type { EntitySearchInputProps } from "./components/EntitySearchInput";

export { GroupBrowser } from "./components/GroupBrowser";
export type { GroupBrowserProps } from "./components/GroupBrowser";

export { ConnectionStyleRow } from "./components/ConnectionStyleRow";
export type { ConnectionStyleRowProps, ConnectionTypeSettings } from "./components/ConnectionStyleRow";

// ── Components — shared overlays ────────────────────────────────────────────
export { NodePopup } from "./components/NodePopup";
export type { NodePopupProps } from "./components/NodePopup";

export { Tooltip, useTooltip } from "./components/Tooltip";
export type { TooltipProps, TooltipState } from "./components/Tooltip";

// ── Standalone tools (kept, not embedded in panels) ─────────────────────────
export { PathFinder } from "./PathFinder";
export type { PathFinderProps } from "./PathFinder";

export { AiNarrative } from "./AiNarrative";
export type { AiNarrativeProps } from "./AiNarrative";

export { EmbedModal } from "./EmbedModal";
export type { EmbedModalProps } from "./EmbedModal";

export { CollapsiblePanel } from "./CollapsiblePanel";
export type { CollapsiblePanelProps } from "./CollapsiblePanel";

// ── Legacy types — kept for backward compat with any external consumers ─────
// These are the old flat GraphNode / GraphEdge used in the original ForceGraph.
// New code should import GraphNodeV2 / GraphEdgeV2 from types.ts instead.
export type NodeType =
  | "official"
  | "governing_body"
  | "proposal"
  | "corporation"
  | "pac"
  | "individual";

export type EdgeType =
  | "donation"
  | "vote_yes"
  | "vote_no"
  | "vote_abstain"
  | "nomination_vote_yes"
  | "nomination_vote_no"
  | "appointment"
  | "revolving_door"
  | "oversight"
  | "lobbying"
  | "co_sponsorship";

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

export const NODE_COLORS: Record<NodeType, { fill: string; stroke: string }> = {
  official:       { fill: "#f8fafc", stroke: "#6366f1" },
  governing_body: { fill: "#f5f3ff", stroke: "#7c3aed" },
  proposal:       { fill: "#fffbeb", stroke: "#f59e0b" },
  corporation:    { fill: "#f0fdf4", stroke: "#16a34a" },
  pac:            { fill: "#fff7ed", stroke: "#ea580c" },
  individual:     { fill: "#eff6ff", stroke: "#3b82f6" },
};

export const PARTY_COLORS: Record<string, string> = {
  democrat:    "#3b82f6",
  republican:  "#ef4444",
  independent: "#a855f7",
  nonpartisan: "#94a3b8",
};

export const EDGE_COLORS: Record<EdgeType, string> = {
  donation:            "#22c55e",
  vote_yes:            "#3b82f6",
  vote_no:             "#ef4444",
  vote_abstain:        "#94a3b8",
  nomination_vote_yes: "#8b5cf6",
  nomination_vote_no:  "#db2777",
  appointment:         "#a855f7",
  revolving_door:      "#f97316",
  oversight:           "#94a3b8",
  lobbying:            "#eab308",
  co_sponsorship:      "#06b6d4",
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
  singleColor: "#3b82f6",
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
