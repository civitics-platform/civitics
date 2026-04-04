/**
 * packages/graph/src/types.ts
 *
 * New three-layer GraphView architecture types.
 * This is the single source of truth for all TypeScript interfaces.
 *
 * These types coexist with legacy types in index.ts during migration.
 * Old types remain in index.ts for backward compatibility with existing components.
 * New components import directly from this file.
 */

import type { ComponentType, ReactNode } from 'react'

// ── Viz Type ───────────────────────────────────────────────────────────────────

export type VizType = 'force' | 'chord' | 'treemap' | 'sunburst'

// ── Node ───────────────────────────────────────────────────────────────────────

export type NodeType =
  | 'official'
  | 'agency'
  | 'proposal'
  | 'financial'
  | 'organization'
  | 'corporation'
  | 'pac'
  | 'individual'
  | 'group'

export interface GraphNode {
  id: string
  name: string
  type: NodeType
  party?: 'democrat' | 'republican' | 'independent' | 'nonpartisan'
  /** Role or title, e.g. "Senator", "CEO" */
  role?: string
  /** Entity tags, e.g. industry sectors */
  tags?: string[]
  connectionCount?: number
  donationTotal?: number
  /** True when this node has 50+ connections and is collapsed (force graph only). */
  collapsed?: boolean
  /** Extra data from API — group nodes use isGroup, icon, color, memberCount */
  metadata?: Record<string, unknown>
}

// ── Edge ───────────────────────────────────────────────────────────────────────

export interface GraphEdge {
  /** Source node id */
  fromId: string
  /** Target node id */
  toId: string
  /** Key from CONNECTION_TYPE_REGISTRY */
  connectionType: string
  /** Dollar amount (USD) — donations only */
  amountUsd?: number
  /** 0–1. Derived from amount, certainty, or recency. */
  strength: number
  /** ISO date string */
  occurredAt?: string
  /** Extra data — group edges use memberCount, pctOfGroup */
  metadata?: Record<string, unknown>
}

// ── Connection Type Definition ─────────────────────────────────────────────────

export interface ConnectionTypeDefinition {
  label: string
  /** Emoji or short text icon */
  icon: string
  /** Hex color string */
  color: string
  description: string
  /** True if this connection type carries a dollar amount */
  hasAmount: boolean
}

// ── Viz-Specific Style Options ─────────────────────────────────────────────────

export interface ForceOptions {
  layout: 'force_directed' | 'radial' | 'hierarchical' | 'circular'
  nodeSizeEncoding:
    | 'connection_count'
    | 'donation_total'
    | 'votes_cast'
    | 'bills_sponsored'
    | 'years_in_office'
    | 'uniform'
  nodeColorEncoding:
    | 'entity_type'
    | 'party_affiliation'
    | 'industry_sector'
    | 'state_region'
    | 'single_color'
  singleColor: string
  edgeThicknessEncoding: 'amount_proportional' | 'strength_proportional' | 'uniform'
  edgeOpacity: number
  theme: 'light' | 'dark' | 'print'
  // Physics — Category B (restart simulation, no re-fetch)
  charge?: number        // many-body strength, default: -300
  linkDistance?: number  // link target distance, default: 150
  gravity?: number       // center force strength, default: 0.1
  // Display — Category A (update SVG styles directly, no restart)
  labels?: 'always' | 'hover' | 'never'
}

export interface ChordOptions {
  showLabels: boolean
  /** Show % of total raised instead of absolute dollars */
  normalizeMode: boolean
  padAngle: number
  /** Filter out flows below this dollar amount. 0 = show all. */
  minFlowUsd: number
  /** Hint: when true the preset is designed for entity-focused mode */
  entityMode?: boolean
}

export interface TreemapOptions {
  groupBy: 'party' | 'state' | 'chamber' | 'industry'
  sizeBy: 'donation_total' | 'connection_count' | 'vote_count'
  colorBy: 'party' | 'chamber' | 'industry'
  /** Hint: when true the preset is designed for entity-focused mode */
  entityMode?: boolean
  /**
   * Data source for the treemap.
   * 'officials'  = officials ranked by donations received (default)
   * 'pac_sector' = PAC donations grouped by industry sector
   * 'pac_party'  = PAC donations grouped by recipient party
   */
  dataMode?: 'officials' | 'pac_sector' | 'pac_party'
}

export interface SunburstOptions {
  ring1?: 'connection_types' | 'donation_industries' | 'vote_categories'
  ring2?: 'top_entities' | 'by_amount' | 'by_count'
  /** Max segments in ring 1. Default 8. */
  maxRing1?: number
  /** Max children per ring 1 segment. Default 10. */
  maxRing2?: number
  shape?: 'circle' | 'octagon'
  showLabels?: 'auto' | 'always' | 'never'
  badgeSize?: 'full' | 'large' | 'medium' | 'small' | 'tiny'
}

// ── Focus Entity ───────────────────────────────────────────────────────────────

export interface FocusEntity {
  id: string
  name: string
  type: 'official' | 'agency' | 'proposal' | 'financial'
  role?: string
  party?: string
  photoUrl?: string

  // Per-entity overrides
  /** Overrides global depth for this entity only */
  depth?: 1 | 2 | 3
  /** Render as larger node. Default: true for all focused entities */
  highlight?: boolean
  /** Lock position in simulation */
  pinned?: boolean
  /** Custom highlight ring color */
  color?: string
  /** Group tag set when added via Add Group (e.g. 'CA', 'DEMOCRAT') */
  groupTag?: string
}

// ── Group Filter ───────────────────────────────────────────────────────────────

export interface GroupFilter {
  entity_type: 'official' | 'pac' | 'agency'
  chamber?: 'senate' | 'house'
  party?: string
  state?: string
  industry?: string
}

// ── Focus Group ────────────────────────────────────────────────────────────────

export interface FocusGroup {
  /** Stable ID. Premade: 'group-senate-dems'. Custom: 'group-custom-{uuid}' */
  id: string
  name: string
  type: 'group'
  icon: string
  color: string
  filter: GroupFilter
  /** Resolved member count. Fetched lazily, not required. */
  count?: number
  isPremade: boolean
  /** Optional tooltip text */
  description?: string
}

// ── Focus Item ─────────────────────────────────────────────────────────────────

export type FocusItem = FocusEntity | FocusGroup

export function isFocusGroup(item: FocusItem): item is FocusGroup {
  return item.type === 'group'
}

export function isFocusEntity(item: FocusItem): item is FocusEntity {
  return item.type !== 'group'
}

/** Maximum number of entities that can be in focus simultaneously */
export const MAX_FOCUS_ENTITIES = 5

// ── Focus Operations ───────────────────────────────────────────────────────────

export type FocusOperation =
  | { type: 'add'; entity: FocusEntity }
  | { type: 'remove'; id: string }
  | { type: 'update'; id: string; options: Partial<FocusEntity> }
  | { type: 'clear' }

// ── Update Categories (real-time wiring) ──────────────────────────────────────
//
// Category A — Visual only (< 16ms): no simulation restart, update SVG styles directly
//   e.g. connection color, opacity, thickness
// Category B — Simulation restart (~200ms): data already loaded
//   e.g. layout change, node size encoding, add/remove connection type
// Category C — Re-fetch (~500–1000ms): new data needed from API
//   e.g. add/remove entity from focus, depth change, scope filter change

export type UpdateCategory =
  | 'visual'   // Cat A: no restart
  | 'physics'  // Cat B: restart
  | 'data'     // Cat C: re-fetch

// ── GraphView — The Three-Layer Model ─────────────────────────────────────────
//
// Every graph state is a GraphView. This is the single source of truth.
// The critical rule: switching vizType only changes style.vizType.
// focus and connections NEVER change when the user switches viz type.

export interface GraphView {
  // LAYER 1 — FOCUS
  // A SET of entities to explore.
  // The graph shows all of them plus their connections,
  // with shared connections becoming visually prominent.
  focus: {
    entities: FocusItem[]
    scope: 'all' | 'federal' | 'state' | 'senate' | 'house'
    depth: 1 | 2 | 3
    includeProcedural: boolean
  }

  // LAYER 2 — CONNECTIONS
  // Which relationships to show and how to weight/style them
  connections: {
    [connectionType: string]: {
      enabled: boolean
      color: string
      opacity: number     // 0–1
      thickness: number   // 0–1
      minAmount?: number  // USD — donations only
      dateRange?: {
        start: string | null
        end: string | null
      }
    }
  }

  // LAYER 3 — STYLE
  // How to render the data
  style: {
    vizType: VizType
    // Viz-specific options keyed by vizType.
    // Switching viz type preserves each viz's individual settings.
    vizOptions: {
      force?: ForceOptions
      chord?: ChordOptions
      treemap?: TreemapOptions
      sunburst?: SunburstOptions
    }
  }

  // METADATA
  meta?: {
    name?: string
    isPreset?: boolean
    presetId?: string
    /** True when this view has been modified from its preset baseline */
    isDirty?: boolean
  }
}

/**
 * A GraphViewPreset is a named, saved GraphView.
 * Built-in presets live in presets.ts.
 * Loading a preset replaces the entire GraphView state.
 */
export interface GraphViewPreset extends GraphView {
  meta: {
    name: string
    isPreset: true
    presetId: string
    isDirty?: boolean
  }
}

// ── Node Actions ───────────────────────────────────────────────────────────────
//
// Passed to onNodeClick so popup logic stays viz-agnostic.
// Each viz passes its node data through this interface.

export interface NodeActions {
  /** Re-center the graph on this node. Force viz only. */
  recenter: (nodeId: string) => void
  /** Navigate to the entity's profile page. All viz types. */
  openProfile: (nodeId: string) => void
  /** Add to side-by-side comparison. Force viz only. */
  addToComparison: (nodeId: string) => void
  /** Expand a collapsed node (50+ connections). Force viz only. */
  expandNode: (nodeId: string) => void
  /** Switch to treemap viz focused on this group. Group nodes only. */
  viewGroupAsTreemap?: (groupId: string) => void
  /** Switch to chord viz focused on this group. Group nodes only. */
  viewGroupAsChord?: (groupId: string) => void
  /** Switch to sunburst viz focused on this group. Group nodes only. */
  viewGroupAsSunburst?: (groupId: string) => void
  /** Remove the group from focus. Group nodes only. */
  removeGroup?: (groupId: string) => void
}

// ── Viz Props ──────────────────────────────────────────────────────────────────

export interface VizProps {
  graphView: GraphView
  nodes: GraphNode[]
  edges: GraphEdge[]
  onNodeClick: (node: GraphNode | null) => void
  width: number
  height: number
}

// ── Viz Definition ─────────────────────────────────────────────────────────────
//
// Every viz type is defined exactly once in visualizations/registry.ts.
// Adding a new viz = one new VizDefinition entry. Nothing else changes.

export interface VizDefinition {
  id: VizType
  label: string
  /** Inline SVG path string for the icon */
  icon: string
  group: 'standard' | 'coming_soon' | 'custom'
  description: string
  civicQuestion: string

  /**
   * The React component that renders this viz.
   * Optional in Stage 1 — filled in when components are moved in Stage 2.
   */
  component?: ComponentType<VizProps>

  /**
   * Does this viz require a focused entity?
   * true  = needs focus.entities (force, sunburst)
   * false = works globally without one (chord, treemap)
   */
  requiresEntity: boolean

  /**
   * Which connection types this viz can display.
   * force/sunburst: all types. chord/treemap: ['donation'] only.
   */
  supportedConnectionTypes: string[]

  /**
   * Default values for this viz's style options.
   * Auto-populates GraphView.style.vizOptions[id] on first use.
   */
  defaultOptions: Record<string, unknown>

  /**
   * CSS selector for the element to capture in screenshots.
   * e.g. '#chord-diagram-svg', '#force-graph-canvas'
   * Never hardcode this in the screenshot button — read from here.
   */
  screenshotTarget: string

  /**
   * Called before screenshot capture: hide tooltips, reset zoom, etc.
   * Defined per viz. Never put this logic in the header component.
   */
  screenshotPrep?: () => void

  /**
   * Tooltip rendered on node/arc/cell hover.
   * Stage 1: returns null. Real implementation in Prompt 3.
   */
  tooltip: (node: GraphNode) => ReactNode

  /**
   * Called on node/arc/cell click.
   * Use NodeActions so the popup stays viz-agnostic.
   */
  onNodeClick: (node: GraphNode, actions: NodeActions) => void
}
