export { ForceGraph } from "./ForceGraph";
export type { ForceGraphProps } from "./ForceGraph";

export { EntitySelector } from "./EntitySelector";
export type { EntitySelectorProps } from "./EntitySelector";
export { DepthControl } from "./DepthControl";
export type { DepthControlProps } from "./DepthControl";
export { FilterPills } from "./FilterPills";
export type { FilterPillsProps } from "./FilterPills";
export { CustomizePanel } from "./CustomizePanel";
export type { CustomizePanelProps } from "./CustomizePanel";

/**
 * @civitics/graph
 *
 * D3 force simulation for the Civitics connection graph.
 *
 * CRITICAL: This must use D3, never React Flow.
 * The organic force layout IS the analysis — dense clusters mean deep entanglement,
 * bridge nodes reveal hidden connections. React Flow cannot reproduce this.
 *
 * Node types:
 *  - official:        circle with photo, border: blue=D, red=R, purple=I
 *  - governing_body:  rounded rectangle, gray border
 *  - proposal:        document rectangle, amber border
 *  - organization:    diamond, green border
 *
 * Edge types & visual encoding:
 *  - donation:        green, width proportional to dollar amount
 *  - vote_yes:        blue, fixed width
 *  - vote_no:         red, fixed width
 *  - appointment:     purple, dashed
 *  - revolving_door:  orange, fixed width
 *  - oversight:       gray, fixed width
 */

export type NodeType =
  | "official"       // elected/appointed public official
  | "governing_body" // committee, agency, legislative chamber
  | "proposal"       // bill, regulation, executive order
  | "corporation"    // private company, industry group
  | "pac"            // political action committee, super PAC
  | "individual";    // private citizen, donor
export type EdgeType =
  | "donation"
  | "vote_yes"
  | "vote_no"
  | "vote_abstain"
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
  // D3 simulation fields (assigned at runtime)
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}

export interface GraphEdge {
  id: string;
  source: string;   // node id
  target: string;   // node id
  type: EdgeType;
  amountCents?: number;   // for donation edges: drives visual width
  occurredAt?: string;
  strength: number;       // 0–1
}

export const NODE_COLORS: Record<NodeType, { fill: string; stroke: string }> = {
  official:       { fill: "#f8fafc", stroke: "#6366f1" },  // party overrides stroke
  governing_body: { fill: "#f1f5f9", stroke: "#94a3b8" },
  proposal:       { fill: "#fffbeb", stroke: "#f59e0b" },
  corporation:    { fill: "#f0fdf4", stroke: "#16a34a" },  // green — financial entity
  pac:            { fill: "#fff7ed", stroke: "#ea580c" },  // orange — political money
  individual:     { fill: "#eff6ff", stroke: "#3b82f6" },  // blue — person/donor
};

export const PARTY_COLORS: Record<string, string> = {
  democrat:    "#3b82f6",  // blue-500
  republican:  "#ef4444",  // red-500
  independent: "#a855f7",  // purple-500
  nonpartisan: "#94a3b8",  // slate-400
};

export const EDGE_COLORS: Record<EdgeType, string> = {
  donation:       "#22c55e",  // green
  vote_yes:       "#3b82f6",  // blue
  vote_no:        "#ef4444",  // red
  vote_abstain:   "#94a3b8",  // gray
  appointment:    "#a855f7",  // purple
  revolving_door: "#f97316",  // orange
  oversight:      "#94a3b8",  // gray
  lobbying:       "#eab308",  // yellow
  co_sponsorship: "#06b6d4",  // cyan
};

/**
 * Compute edge stroke width.
 * Donation edges scale with amount; all others are fixed.
 */
export function edgeWidth(edge: Pick<GraphEdge, "type" | "amountCents">): number {
  if (edge.type === "donation" && edge.amountCents) {
    // Scale: $1k = 1px, $100k = 3px, $1M+ = 6px (log scale)
    return Math.min(6, Math.max(1, Math.log10(edge.amountCents / 100_000) + 3));
  }
  return 1.5;
}

// ── Visual config ─────────────────────────────────────────────────────────────

export interface VisualConfig {
  nodeSizeEncoding: "connection_count" | "donation_total" | "votes_cast" | "bills_sponsored" | "years_in_office" | "uniform";
  nodeColorEncoding: "entity_type" | "party_affiliation" | "industry_sector" | "state_region" | "single_color";
  singleColor: string;
  edgeThicknessEncoding: "amount_proportional" | "strength_proportional" | "uniform";
  edgeOpacity: number; // 0–1
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

// ── Entity search ────────────────────────────────────────────────────────────

export interface EntitySearchResult {
  id: string;
  label: string;
  type: "official" | "agency" | "proposal";
  subtitle?: string;
  party?: string;
}
