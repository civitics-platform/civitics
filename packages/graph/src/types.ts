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

export type VizType =
  | 'force'
  | 'chord'
  | 'treemap'
  | 'sunburst'
  | 'spending'
  | 'hierarchy'
  | 'matrix'
  | 'alignment'
  | 'sankey'
  | 'scatter'      // FIX-217 — agency staffing X×Y plot
  | 'choropleth'   // FIX-217 — voting-divergence map
  | 'gantt'        // FIX-217 — agency leadership tenure

// ── Node ───────────────────────────────────────────────────────────────────────

export type NodeType =
  | 'official'
  | 'agency'
  | 'proposal'
  | 'initiative'
  | 'financial'
  | 'organization'
  | 'corporation'
  | 'pac'
  | 'individual'
  | 'individual_bracket'  // synthetic aggregate — not a real entity
  | 'group'
  | 'user'

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
  /**
   * State name for officials — jurisdictions.name via officials.jurisdiction_id
   * (NOT metadata->>'state', which is {} for federal officials). Drives the
   * "Color by: State" encoding (FIX-804).
   */
  state?: string
  /**
   * Donor industry, denormalized from official_donor_rollup_mv on
   * rollup-sourced donor nodes (FIX-802 read path). Drives the
   * "Color by: Industry" encoding (FIX-804). Absent on non-donor /
   * untagged nodes — those render neutral.
   */
  industryTag?: string
  industryLabel?: string
  /**
   * True when the backing entity is AI-generated demonstration content
   * (entity.is_synthetic, FIX-572). Drives the persistent SYNTHETIC mark on the
   * node + in NodePopup (SF-P2). 0 rows true today — behavior-neutral wiring.
   */
  isSynthetic?: boolean
  /**
   * Extra data from API.
   * - group nodes:            isGroup, icon, color, memberCount
   * - individual_bracket:     isBracketNode, tier (BracketTier['id']), donorCount, officialId
   * - employer bracket:       isEmployerNode, employer (normalized), donorCount, officialId
   */
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
  /** Underlying transaction count — set on rollup-sourced aggregate edges
   *  (donation/opposition read from official_donor_rollup_mv, FIX-802).
   *  Per-event edges omit it. G2's hover $ labels consume this. */
  txCount?: number
  /** Provenance tag from entity_connections.evidence_source. The narrow slice this
   *  package cares about is 'investigation' — a community claim promoted to the graph
   *  (FIX-584/585) — which renders distinctly, filterable, and attributed. Other
   *  derived sources (financial_relationships, votes, …) pass through untouched. */
  evidenceSource?: string
  /** Investigation (case-file) id backing an evidence_source==='investigation' edge —
   *  for the attribution popover deep-link to /investigations/[investigationId]. */
  investigationId?: string
  /** Title of that investigation, for the attribution popover. */
  investigationTitle?: string
  /** ISO date the promoting card was last reviewed (status change), for the popover. */
  reviewedAt?: string
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
  /**
   * FIX-802 — when set, ConnectionStyleRow renders a fetch-cap dropdown for
   * this type (e.g. donation "Top donors: 10/25/50/100"). The chosen value is
   * stored as `fetchLimit` on the type's connection settings and forwarded to
   * /api/graph/connections. Vote types share ONE control in ConnectionsTree
   * instead — do not set this on them.
   */
  fetchLimitControl?: {
    label: string
    options: readonly number[]
    defaultValue: number
  }
}

// ── Individual Donor Display (FIX-194) ────────────────────────────────────────

/**
 * Controls how individual donors are aggregated in the Force Graph.
 *
 * 'bracket'   — collapse all individuals into 4 tier nodes per official (default)
 * 'connector' — real nodes only for donors who gave to 2+ officials; rest → brackets
 * 'employer'  — synthetic employer-group nodes per official
 * 'off'       — pass all individual nodes through unchanged (researcher mode)
 */
export type IndividualDisplayMode = 'bracket' | 'connector' | 'employer' | 'off'

export interface BracketTier {
  id: 'mega' | 'major' | 'mid' | 'small'
  /** Full label shown in tooltips and panels, e.g. "Mega ($10k+)" */
  label: string
  /** Short label shown on node, e.g. "Mega" */
  shortLabel: string
  minCents: number
  maxCents: number | null
  /** Fill color for this tier's node — `rgb(var(--c-x))` token string (FIX-729) */
  color: string
}

// Warm intensity ladder: bronze (heaviest) → terracotta → ochre → amber.
// Resolve with resolveColor()/withAlpha() from ./tokens in SVG attr contexts.
export const BRACKET_TIERS: BracketTier[] = [
  { id: 'mega',  label: 'Mega ($10k+)',        shortLabel: 'Mega',  minCents: 1_000_000, maxCents: null,    color: 'rgb(var(--c-viz-9))' },
  { id: 'major', label: 'Major ($2.5k–$10k)',  shortLabel: 'Major', minCents:   250_000, maxCents: 999_999, color: 'rgb(var(--c-viz-6))' },
  { id: 'mid',   label: 'Mid ($500–$2.5k)',    shortLabel: 'Mid',   minCents:    50_000, maxCents: 249_999, color: 'rgb(var(--c-viz-3))' },
  { id: 'small', label: 'Small ($200–$500)',   shortLabel: 'Small', minCents:    20_000, maxCents:  49_999, color: 'rgb(var(--c-amber))' },
]

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
  /**
   * @deprecated FIX-804 — the global edge-opacity control was a placebo (read
   * only by the deleted legacy ForceGraph) and redundant with per-type opacity
   * in ConnectionStyleRow. Key retained so serialized snapshots/presets
   * deserialize cleanly; ignored on read.
   */
  edgeOpacity?: number
  theme: 'light' | 'dark' | 'print'
  // Physics — Category B (restart simulation, no re-fetch)
  charge?: number        // many-body strength, default: -300
  linkDistance?: number  // link target distance, default: 150
  gravity?: number       // center force strength, default: 0.1
  typeClusterEnabled?:  boolean  // angular separation by node type, default: false
  typeClusterStrength?: number   // 0–0.3, default: 0.08
  // Connections filter — Category A (visual only, no restart)
  strengthFilter?: number              // min edge strength to display, 0–1, default: 0.0
  // Display — Category A (update SVG styles directly, no restart)
  labels?: 'always' | 'hover' | 'never'
  // Individual donor display — Category C (triggers API re-fetch)
  individualDisplayMode?: IndividualDisplayMode  // default: 'bracket'
  connectorMinRecipients?: number                // default: 2 (connector mode only)
}

/**
 * Data shape rendered by the chord diagram. Driven by an explicit
 * `dataMode`; falls back to the legacy inferred mode (props-driven) when
 * unset, so existing presets and `primaryEntityId` / `primaryGroup` paths
 * continue to work unchanged.
 *
 * 'industry-party'        — Industry sectors → party chambers (global)
 * 'industry-official'     — Donor industries → focused official
 * 'sector-group'          — Sectors → focused group cohort
 * 'sector-group-pair'     — Sectors split between two focused groups
 * 'sector-vote'           — Donor sectors ↔ vote outcomes (yes/no/other)
 *                           for the focused official(s)
 * 'subject-party'         — Bill subjects ↔ party chambers, weighted by
 *                           affirmative votes (global or cohort-scoped)
 * 'donor-type-party'      — Donor entity_type ↔ party chambers
 * 'state-party'           — Donor home state ↔ recipient party chamber
 */
export type ChordDataMode =
  | 'industry-party'
  | 'industry-official'
  | 'sector-group'
  | 'sector-group-pair'
  | 'sector-vote'
  | 'subject-party'
  | 'donor-type-party'
  | 'state-party'

/**
 * How donor-side arcs are grouped. Applies to modes whose source axis is
 * the donor cohort (industry-party, industry-official, sector-group,
 * sector-group-pair, sector-vote). Other modes ignore this option.
 *
 * 'aggregate'   — one arc per industry/sector (default; maps to existing
 *                 chord_industry_flows / get_group_sector_totals behavior)
 * 'top-pacs'    — one arc per top-N PAC entity, colored by its industry.
 *                 Reveals which specific organizations dominate a flow.
 * 'by-bracket'  — donors aggregated into Mega ($10k+) / Major ($2.5k–10k) /
 *                 Mid ($500–2.5k) / Small (<$500) size brackets.
 */
export type ChordGranularity = 'aggregate' | 'top-pacs' | 'by-bracket'

export interface ChordOptions {
  showLabels: boolean
  /** Show % of total raised instead of absolute dollars */
  normalizeMode: boolean
  padAngle: number
  /** Filter out flows below this dollar amount. 0 = show all. */
  minFlowUsd: number
  /** Hint: when true the preset is designed for entity-focused mode */
  entityMode?: boolean
  /**
   * Explicit data shape. When unset the route infers the mode from props
   * (entityId / groupId / secondaryGroupId), preserving legacy behavior.
   */
  dataMode?: ChordDataMode
  /** How donor arcs are grouped. Default: 'aggregate'. */
  granularity?: ChordGranularity
  /** When granularity='top-pacs', how many PAC arcs to show (default 12). */
  topPacsLimit?: number
}

export interface TreemapOptions {
  groupBy: 'party' | 'state' | 'chamber' | 'industry' | 'donor_type'
  sizeBy: 'donation_total' | 'connection_count' | 'vote_count'
  colorBy: 'party' | 'chamber' | 'industry' | 'donor_type'
  /** Hint: when true the preset is designed for entity-focused mode */
  entityMode?: boolean
  /**
   * Data source for the treemap.
   * 'officials'             = officials ranked by donations received (default)
   * 'pac_sector'            = PAC donations grouped by industry sector
   * 'pac_party'             = PAC donations grouped by recipient party
   * 'individuals_by_state'  = individual contributors aggregated by donor state (FIX-218)
   */
  dataMode?: 'officials' | 'pac_sector' | 'pac_party' | 'individuals_by_state'
  /**
   * How treemap cell area encodes the size value.
   * 'log'    = log10(value+1)+1 — every cell visible regardless of distribution
   * 'linear' = raw value with a small floor — preserves true ratios but
   *            renders sub-pixel cells when distribution is skewed (e.g. one
   *            senator at $1M next to one at $0).
   * Default: 'log' — the donation distribution is heavily skewed and zero-data
   * cells are common until FEC seeding catches up (FIX-178).
   */
  sizeScale?: 'log' | 'linear'
  /**
   * FIX-186 — Compare mode. When true AND 2+ FocusEntity items are in focus,
   * render one top-level cell per focused entity, each subdivided by their
   * donors. Donors that gave to multiple focused entities render in matching
   * colors so overlap is visible at a glance. Best for "how aligned are
   * Warren's and Cruz's donor bases?" investigations. Off by default.
   */
  compareMode?: boolean
}

export interface HierarchyOptions {
  /** Tree layout direction. Horizontal reads left-to-right, vertical top-to-bottom. */
  orientation: 'horizontal' | 'vertical'
  /** Encoding driving the leaf node radius. */
  nodeSizeBy: 'budget' | 'employees' | 'uniform'
  /** Auto-collapse nodes deeper than this depth (0 = root only visible). */
  collapseDepth: number
  /** When true, render leaf labels even at deep levels. */
  showLabels?: boolean
}

export interface MatrixOptions {
  /** Row/column ordering. 'cluster' uses a simple greedy nearest-neighbour reorder. */
  sortBy: 'alphabetical' | 'party' | 'cluster'
  /**
   * 'agreement' — % of shared votes where both cast the same yes/no
   * 'kappa'     — Cohen's kappa, agreement corrected for chance
   */
  metric: 'agreement' | 'kappa'
  /** Hide cell labels when officials > N. Default 12. */
  labelLimit?: number
}

export interface SpendingOptions {
  /** Number of top agencies shown in the agency breakdown. */
  topAgencies: number
  /** Number of top recipients shown in the right pane. */
  topRecipients: number
  /** Hide flows / recipients with aggregate spend below this dollar amount. */
  minFlowUsd: number
  /** Render the sector breakdown panel. False shrinks the left pane to agencies only. */
  showSectors?: boolean
}

export interface SankeyOptions {
  /** How many flow tiers to show: 2 = Federal→Agency, 3 = +Sector, 4 = +Vendor. */
  levels: 2 | 3 | 4
  /** Hide flows below this dollar amount. 0 = show all. */
  minFlowUsd: number
  /** Top-N at each tier (Agency / Sector / Vendor). 0 = no cap. */
  topN: number
  /** When true, render numeric labels on nodes. */
  showLabels?: boolean
}

export interface AlignmentOptions {
  /** Bar ordering around the dial. Default = ratio descending. */
  sortBy: 'alignment' | 'party' | 'name' | 'role'
  /** Whether to show numeric percentages on each bar. */
  showLabels?: boolean
  /**
   * Bar fill mode.
   *  'ratio'   — fill proportional to alignment ratio (default)
   *  'gradient'— same fill but with a low→high colour gradient
   */
  fillMode?: 'ratio' | 'gradient'
}

// FIX-217 — Scatter: agencies plotted on configurable X/Y axes.
export interface ScatterOptions {
  xAxis: 'fte' | 'budget' | 'founded_year' | 'appointment_count'
  yAxis: 'appointment_count' | 'contract_total' | 'grant_total' | 'fte'
  sizeBy: 'fte' | 'contract_total' | 'uniform'
  colorBy: 'agency_type' | 'tenure' | 'founded_decade'
  showLabels?: boolean
  logXAxis?: boolean
  logYAxis?: boolean
}

// FIX-217 — Choropleth: per-district map of a derived metric.
export interface ChoroplethOptions {
  /**
   * 'party_cohesion' — within-district party-line cohesion rate
   *                    (% of district reps voting same way on legislation)
   * 'divergence'     — for a focused proposal, district vote distribution
   * 'small_dollar_share' — % of donations under $500 per district's reps
   */
  measure: 'party_cohesion' | 'divergence' | 'small_dollar_share'
  bandLevel: 'state' | 'congressional' | 'sld_u' | 'sld_l'
  colorScale: 'diverging' | 'sequential'
  showLabels?: boolean
}

// FIX-217 — Gantt: time-tenure bars for agency leadership.
export interface GanttOptions {
  groupBy: 'position_title' | 'official' | 'administration'
  showCurrent: boolean
  dateRange?: { start: string; end: string }
  showLabels?: boolean
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
  entity_type: 'official' | 'pac' | 'agency' | 'proposal' | 'financial' | 'initiative'
  chamber?: 'senate' | 'house'
  party?: string
  state?: string
  industry?: string
  /** Topic-tag slug from entity_tags.tag. proposal groups only. (FIX-137) */
  tag?: string
  /** governing_bodies UUID (type='committee'). official groups only. (FIX-139) */
  committeeId?: string
  /**
   * governing_bodies slug (canonical) or UUID (fallback, forever). official
   * groups only. (FIX-490) The route resolves the gb, gates on its jurisdiction
   * type, and expands it to the member cohort. Slug is preferred because gb
   * UUIDs differ local↔prod and slugs make share URLs readable
   * (`governingBody=senate`); UUID is accepted so synthetic group ids in saved
   * sessions (`group-gb-<uuid>`) keep resolving indefinitely.
   */
  governingBody?: string
  /** Narrows officials by governing_body type: congress|judiciary|cabinet|state_gov */
  official_role?: 'congress' | 'judiciary' | 'cabinet' | 'state_gov'
  /** Narrows financial entities by entity_type enum value */
  financial_type?: 'individual' | 'pac' | 'super_pac' | 'corporation' | 'union' | 'party_committee'
  /** Narrows proposals by type enum value */
  proposal_type?: 'bill' | 'regulation' | 'executive_order' | 'treaty' | 'referendum' | 'ordinance'
  /** Narrows agencies by agency_type enum value */
  agency_type?: 'federal' | 'state' | 'local' | 'independent'
  /** Narrows initiatives by stage enum value */
  initiative_stage?: 'draft' | 'deliberate' | 'mobilise' | 'resolved'
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
    /**
     * FIX-184 — pinned focus item that drives single-entity vizes
     * (treemap, sunburst, chord). One per type so the user can pin a
     * cohort entity and a filter group simultaneously. When unset the
     * single-entity vizes fall back to the last-added item of each type.
     */
    primaryEntityId?: string
    primaryGroupId?: string
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
      /**
       * FIX-802 — server-side fetch cap for this type. donation: named
       * top-N donors by rollup rank (10|25|50|100, default 25). Vote types:
       * rows loaded (50|100|250|500, default 50) — one shared control writes
       * the same value to every vote-type key. Round-trips through
       * snapshots/presets like every other per-type setting.
       */
      fetchLimit?: number
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
      spending?: SpendingOptions
      hierarchy?: HierarchyOptions
      matrix?: MatrixOptions
      alignment?: AlignmentOptions
      sankey?: SankeyOptions
      scatter?: ScatterOptions       // FIX-217
      choropleth?: ChoroplethOptions // FIX-217
      gantt?: GanttOptions           // FIX-217
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
 * Entity-type "kinds" a preset can declare itself applicable to.
 * Broader than `FocusEntity['type']` because presets care about
 * `pac` / `individual` (subtypes of `financial`) and the unfocused state.
 * (FIX-216)
 */
export type PresetEntityKind =
  | 'official'
  | 'agency'
  | 'proposal'
  | 'financial'  // any financial entity
  | 'pac'        // financial subtype
  | 'individual' // financial subtype
  | 'group'
  | 'unfocused'  // empty focus
  | 'any'        // matches everything

/**
 * Per-focus-kind override for a preset's vizOptions. The resolver
 * deep-merges the matching key into `style.vizOptions[vizType]` before
 * the preset is applied (or whenever focus changes for a clean preset).
 * (FIX-216)
 */
export type DataModeByEntity = Partial<Record<
  Exclude<PresetEntityKind, 'any'>,
  Partial<GraphView['style']['vizOptions']>
>>

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
    /**
     * FIX-216 — Entity kinds this preset is *natively* designed for.
     * Used by `isPresetApplicableToView` to pick Native vs Adapted bucket
     * in the right-panel preset list. Omit (or include 'any') = always native.
     */
    applicableEntityTypes?: ReadonlyArray<PresetEntityKind>
    /** FIX-216 — Kinds where this preset is shown disabled with a reason. */
    inapplicableEntityTypes?: ReadonlyArray<PresetEntityKind>
    /** FIX-216 — Per-focus-kind overrides for vizOptions. Resolver applies these. */
    dataModeByEntity?: DataModeByEntity
    /**
     * FIX-216 — Stable string the per-viz fetch builders read to choose
     * the API endpoint and params. Lets one preset ride multiple endpoints
     * (e.g. global PAC sectors vs PACs-to-an-official) without ad-hoc
     * branching in TreemapGraph.
     */
    intent?: PresetIntent
  }
}

/** FIX-216 — Intent strings consumed by per-viz fetch URL builders. */
export type PresetIntent =
  | 'official-donors'           // /api/graph/treemap?entityId=X
  | 'pacs-to-official'          // /api/graph/treemap-pac?entityId=X (FIX-216)
  | 'pacs-by-sector-global'     // /api/graph/treemap-pac (no entityId)
  | 'individuals-by-state'      // /api/graph/treemap-individuals (FIX-218)
  | 'fundraising-by-donor-type' // /api/graph/treemap?entityId=X&groupBy=donor_type (FIX-218)
  | 'agency-spending-flows'     // /api/graph/sankey?agencyId=X (FIX-218)
  | 'agency-staffing'           // /api/graph/agency-staffing (FIX-217/218)
  | 'leadership-tenure'         // /api/graph/leadership-tenure?agencyId=X (FIX-217/218)
  | 'voting-divergence-map'     // /api/graph/voting-divergence (FIX-217/218)
  | 'small-dollar-share'        // /api/graph/small-dollar?entityId=X (FIX-218)
  | 'sector-affinity'           // /api/graph/sector-affinity?entityId=X (FIX-218)
  | 'co-sponsorship-network'    // existing /api/graph/connections
  | 'votes-and-bills'           // existing
  | 'follow-the-money'          // existing
  | 'industry-capture'          // existing
  | 'committee-power'           // existing
  | 'nominations'               // existing
  | 'top-donors-chord'          // existing
  | 'industry-donors-chord'     // existing
  | 'sector-vote-chord'         // chord: sector ↔ vote outcome (new)
  | 'subject-party-chord'       // chord: bill subject ↔ party (new)
  | 'donor-type-party-chord'    // chord: donor type ↔ party (new)
  | 'state-party-chord'         // chord: donor state ↔ party (new)
  | 'alignment-my-reps'         // existing
  | 'group-overview'            // existing
  | 'full-record'               // existing
  | 'clean-view'                // existing

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
  /** Re-request a group whose donor aggregation failed (FIX-497). Group nodes only. */
  retryGroup?: (groupId: string) => void
  /** Open the donor list side panel for a bracket node. individual_bracket nodes only. */
  openDonorList?: (officialId: string, tier: string) => void
  /** Pin an individual donor as a real graph node (from DonorListPanel). */
  pinDonor?: (donorId: string, donorName: string) => void
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

  /**
   * FIX-129: Whether this viz can produce a meaningful render given the current
   * focus + connections + loaded graph data. The header dropdown and right-panel
   * Visualization section group entries by applicability — applicable on top,
   * non-applicable below (greyed) with the returned `reason` shown to the user.
   *
   * Default (omitted) = always applicable. Implementations should be cheap —
   * they run on every render of the dropdown.
   */
  isApplicable?: (
    focus: GraphView['focus'],
    connections: GraphView['connections'],
    graphMeta?: VizApplicabilityMeta,
  ) => VizApplicability
}

// ── Viz Applicability (FIX-129) ────────────────────────────────────────────────
//
// `VizApplicabilityMeta` is the subset of GraphMeta the registry's
// `isApplicable` callbacks read. Re-declaring it here (instead of importing
// from hooks/useGraphData) keeps types.ts free of React-side imports.

export interface VizApplicabilityMeta {
  connectionTypes: Record<string, { count: number; totalAmount: number }>
  entityTypes: Set<string>
  hasVotes: boolean
  hasDonations: boolean
  hasOversight: boolean
  hasNominations: boolean
  hasGroups: boolean
  isPacFocus: boolean
}

export type VizApplicability =
  | { applicable: true }
  | { applicable: false; reason: string }
