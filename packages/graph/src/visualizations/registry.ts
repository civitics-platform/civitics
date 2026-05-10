/**
 * packages/graph/src/visualizations/registry.ts
 *
 * The Viz Registry — single source of truth for all visualization types.
 * Adding a new viz = add one entry here. Nothing else in the codebase changes.
 *
 * Stage 1 note: `component` is not yet wired up (components still live flat
 * in src/). It will be filled in during Stage 2 when components are moved
 * to src/visualizations/. tooltip and onNodeClick are placeholders for
 * Stage 1 — real implementations come in Prompt 3 (interactions).
 */

import type {
  VizDefinition,
  VizType,
  GraphNode,
  NodeActions,
  GraphView,
  VizApplicability,
  VizApplicabilityMeta,
} from '../types'
import { isFocusGroup } from '../types'
import { CONNECTION_TYPE_REGISTRY } from '../connections'

// Re-export VizType as VizMode for backward compatibility with existing
// components (GraphSidebar.tsx, GraphPage.tsx) that import VizMode.
export type { VizType as VizMode } from '../types'

/**
 * Extends VizDefinition with a `status` field for backward compatibility
 * with GraphSidebar.tsx until it is replaced by GraphHeader.tsx +
 * SettingsPanel.tsx in Stage 2.
 *
 * @deprecated Use `group` instead of `status`.
 * Remove this type alias once GraphSidebar.tsx is deleted.
 */
export type VizRegistryEntry = VizDefinition & {
  /** @deprecated Use group field instead */
  status: 'active' | 'coming_soon'
}

// All connection types — used by force and sunburst which support everything.
const ALL_CONNECTION_TYPES = Object.keys(CONNECTION_TYPE_REGISTRY)

// Shared screenshotPrep: remove any open tooltips before capture.
function prepScreenshot(): void {
  document.querySelectorAll<HTMLElement>('.graph-tooltip').forEach((el) => el.remove())
}

// Placeholder tooltip — returns null for Stage 1.
// Real per-viz tooltip implementations come in Prompt 3 (interactions).
function placeholderTooltip(_node: GraphNode): null {
  return null
}

// Default click handler — open the entity's profile page.
// Recenter/Compare/Expand are force-only; those are added in Prompt 3.
function defaultOnNodeClick(node: GraphNode, actions: NodeActions): void {
  actions.openProfile(node.id)
}

// ── Applicability helpers (FIX-129) ────────────────────────────────────────────

const APPLICABLE: VizApplicability = { applicable: true }

function focusHasEntityType(
  focus: GraphView['focus'],
  type: 'official' | 'agency' | 'proposal' | 'financial',
): boolean {
  for (const item of focus.entities) {
    if (isFocusGroup(item)) {
      // Groups carry a filter-level entity_type. PAC groups count as financial.
      const et = item.filter.entity_type
      if (type === 'financial' && et === 'pac') return true
      if (type === et) return true
    } else if (item.type === type) {
      return true
    }
  }
  return false
}

/**
 * Count officials directly in focus (entities only — does not expand groups).
 * Matrix viz needs ≥2 individual officials, since group expansion is async.
 */
function focusedOfficialCount(focus: GraphView['focus']): number {
  let n = 0
  for (const item of focus.entities) {
    if (!isFocusGroup(item) && item.type === 'official') n++
  }
  return n
}

function donationCount(graphMeta?: VizApplicabilityMeta): number {
  return graphMeta?.connectionTypes['donation']?.count ?? 0
}

export const VIZ_REGISTRY: VizRegistryEntry[] = [
  {
    id: 'force',
    label: 'Force Graph',
    civicQuestion: 'How is this official connected to donors and legislation?',
    description: 'Organic force-directed layout reveals clusters and bridge nodes',
    group: 'standard',
    status: 'active',
    icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z',

    requiresEntity: true,
    supportedConnectionTypes: ALL_CONNECTION_TYPES,
    defaultOptions: {
      layout: 'force_directed',
      nodeSizeEncoding: 'connection_count',
      nodeColorEncoding: 'entity_type',
      singleColor: '#3b82f6',
      edgeThicknessEncoding: 'amount_proportional',
      edgeOpacity: 0.7,
      theme: 'dark',
    },

    screenshotTarget: '#force-graph-canvas',
    screenshotPrep: prepScreenshot,
    tooltip: placeholderTooltip,
    onNodeClick: defaultOnNodeClick,

    // Force is the universal canvas — works for any focus + connection mix.
    isApplicable: () => APPLICABLE,
  },

  {
    id: 'treemap',
    label: 'Treemap',
    civicQuestion: 'Which officials receive the most donor money?',
    description: 'Officials sized by donations received, grouped by party',
    group: 'standard',
    status: 'active',
    icon: 'M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z',

    requiresEntity: false,
    supportedConnectionTypes: ['donation'],
    defaultOptions: {
      groupBy: 'party',
      sizeBy: 'donation_total',
    },

    screenshotTarget: '#treemap-svg',
    screenshotPrep: prepScreenshot,
    tooltip: placeholderTooltip,
    onNodeClick: defaultOnNodeClick,

    // Treemap renders officials-by-donations OR PACs-by-sector. Either branch
    // requires either donation data or an official in focus (officials still
    // populate the treemap by connection-count when no donation data exists).
    isApplicable: (focus, _connections, graphMeta) => {
      if (graphMeta?.hasDonations) return APPLICABLE
      if (focusHasEntityType(focus, 'official')) return APPLICABLE
      if (focusHasEntityType(focus, 'financial')) return APPLICABLE
      return { applicable: false, reason: 'Add an official or PAC to enable Treemap' }
    },
  },

  {
    id: 'chord',
    label: 'Chord Diagram',
    civicQuestion: 'Which industries fund which political groups — and how much?',
    description: 'Flows between donor industries and recipient party groups',
    group: 'standard',
    status: 'active',
    icon: 'M12 2a10 10 0 100 20A10 10 0 0012 2zm0 2a8 8 0 110 16A8 8 0 0112 4z',

    requiresEntity: false,
    // Chord can render donation flows or vote-outcome flows depending on
    // the selected `dataMode`. Listing both keeps the connection-type
    // registry honest — sector↔vote needs vote edges loaded to be useful.
    supportedConnectionTypes: ['donation', 'vote_yes', 'vote_no'],
    defaultOptions: {
      showLabels: true,
      normalizeMode: false,
      padAngle: 0.05,
      dataMode: 'industry-party',
    },

    screenshotTarget: '#chord-diagram-svg',
    screenshotPrep: prepScreenshot,
    tooltip: placeholderTooltip,
    onNodeClick: defaultOnNodeClick,

    // Chord is always applicable — it has multiple data modes that read
    // server-side aggregates directly, so it can render whether or not
    // graph edges are loaded:
    //   - default industry-party hits the global chord_industry_flows MV
    //   - donor-type-party / state-party hit global FEC aggregates
    //   - sector-group reads from a focused group's members
    //   - sector-vote / industry-official read from a focused official
    // The Settings → Data picker disables specific modes whose required
    // focus isn't present, but the viz itself is always available.
    isApplicable: () => APPLICABLE,
  },

  {
    id: 'sunburst',
    label: 'Sunburst',
    civicQuestion: "What is this official's full relationship profile?",
    description: 'Concentric rings show votes, donors, and oversight connections',
    group: 'standard',
    status: 'active',
    icon: 'M12 3v1m0 16v1M4.22 4.22l.707.707m12.02 12.02l.707.707M1 12h2m18 0h2M4.22 19.78l.707-.707m12.02-12.02l.707-.707',

    requiresEntity: true,
    supportedConnectionTypes: ALL_CONNECTION_TYPES,
    defaultOptions: {
      maxDepth: 3,
      showLabels: true,
    },

    screenshotTarget: '#sunburst-svg',
    screenshotPrep: prepScreenshot,
    tooltip: placeholderTooltip,
    onNodeClick: defaultOnNodeClick,

    // Sunburst is entity-centric — every ring radiates out from one focused entity.
    isApplicable: (focus) => {
      if (focus.entities.length >= 1) return APPLICABLE
      return { applicable: false, reason: 'Add an entity to focus to enable Sunburst' }
    },
  },

  {
    id: 'hierarchy',
    label: 'Hierarchy',
    civicQuestion: 'How is this department structured, and where is the money concentrated?',
    description: 'Tree/dendrogram of agency org structure, sized by contract budget',
    group: 'standard',
    status: 'active',
    icon: 'M12 2v4m0 12v4M4 12H2m20 0h-2M5.6 5.6l-1.4-1.4m15.6 15.6l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4',

    requiresEntity: false,
    supportedConnectionTypes: ['oversight'],
    defaultOptions: {
      orientation: 'horizontal',
      nodeSizeBy: 'budget',
      collapseDepth: 2,
      showLabels: true,
    },

    screenshotTarget: '#hierarchy-svg',
    screenshotPrep: prepScreenshot,
    tooltip: placeholderTooltip,
    onNodeClick: defaultOnNodeClick,

    // Hierarchy renders the federal agency tree by default — always applicable.
    // When an agency is in focus the tree re-roots at that agency.
    isApplicable: () => APPLICABLE,
  },

  {
    id: 'spending',
    label: 'Spending',
    civicQuestion: 'How is taxpayer money flowing to government contractors?',
    description: 'Contract flows from agencies to recipient companies by NAICS sector',
    group: 'standard',
    status: 'active',
    icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z',

    requiresEntity: false,
    supportedConnectionTypes: ['contract_award'],
    defaultOptions: {
      topAgencies: 8,
      topRecipients: 20,
      minFlowUsd: 0,
      showSectors: true,
    },

    screenshotTarget: '#spending-panel',
    screenshotPrep: prepScreenshot,
    tooltip: placeholderTooltip,
    onNodeClick: defaultOnNodeClick,

    // Spending is the agency-contracts viz — needs an agency in focus or
    // contract data already loaded into the graph.
    isApplicable: (focus, _connections, graphMeta) => {
      if (focusHasEntityType(focus, 'agency')) return APPLICABLE
      if (graphMeta?.entityTypes.has('agency')) return APPLICABLE
      if ((graphMeta?.connectionTypes['contract_award']?.count ?? 0) > 0) return APPLICABLE
      return { applicable: false, reason: 'Add an agency to enable Spending' }
    },
  },

  {
    id: 'matrix',
    label: 'Matrix',
    civicQuestion: 'Which officials vote together — and which break ranks?',
    description: 'N×N heatmap of pairwise vote agreement; sortable, clusterable',
    group: 'standard',
    status: 'active',
    icon: 'M3 3h6v6H3zm0 8h6v6H3zm0 8h6v2H3zm8-16h6v6h-6zm0 8h6v6h-6zm0 8h6v2h-6zm8-16h2v6h-2zm0 8h2v6h-2zm0 8h2v2h-2z',

    requiresEntity: true,
    supportedConnectionTypes: ['vote_yes', 'vote_no'],
    defaultOptions: {
      sortBy: 'party',
      metric: 'agreement',
      labelLimit: 12,
    },

    screenshotTarget: '#matrix-svg',
    screenshotPrep: prepScreenshot,
    tooltip: placeholderTooltip,
    onNodeClick: defaultOnNodeClick,

    // Matrix needs at least two officials in focus to be meaningful — the
    // single-cell self-agreement matrix carries no information.
    isApplicable: (focus) => {
      if (focusedOfficialCount(focus) >= 2) return APPLICABLE
      return { applicable: false, reason: 'Add at least 2 officials to enable Matrix' }
    },
  },

  {
    id: 'alignment',
    label: 'Alignment',
    civicQuestion: 'How well do my reps vote with me?',
    description: 'Radial bar chart — YOU at centre, reps fan out by alignment ratio',
    group: 'standard',
    status: 'active',
    icon: 'M12 2a10 10 0 100 20 10 10 0 000-20zm0 4v6l4 2',

    requiresEntity: false,
    supportedConnectionTypes: ['alignment'],
    defaultOptions: {
      sortBy: 'alignment',
      showLabels: true,
      fillMode: 'ratio',
    },

    screenshotTarget: '#alignment-svg',
    screenshotPrep: prepScreenshot,
    tooltip: placeholderTooltip,
    onNodeClick: defaultOnNodeClick,

    // Alignment is the bespoke USER-centric viz. Only meaningful when the user
    // has alignment edges loaded (home district configured + at least one
    // rep with a scored vote overlap). graphMeta is populated by GraphPage's
    // displayGraphMeta which surfaces alignment edge counts.
    isApplicable: (_focus, _connections, graphMeta) => {
      const count = graphMeta?.connectionTypes['alignment']?.count ?? 0
      if (count > 0) return APPLICABLE
      return { applicable: false, reason: 'Set your home district to enable Alignment' }
    },
  },

  {
    id: 'sankey',
    label: 'Sankey',
    civicQuestion: 'Where does federal contract money flow — Treasury → agency → sector → vendor?',
    description: 'Multi-tier flow diagram of contract budget down to top vendors',
    group: 'standard',
    status: 'active',
    icon: 'M3 6h18M3 12h12m-12 6h6',

    requiresEntity: false,
    supportedConnectionTypes: ['contract_award'],
    defaultOptions: {
      levels: 4,
      minFlowUsd: 0,
      topN: 12,
      showLabels: true,
    },

    screenshotTarget: '#sankey-svg',
    screenshotPrep: prepScreenshot,
    tooltip: placeholderTooltip,
    onNodeClick: defaultOnNodeClick,

    // Sankey reads from the global contract flow set — no focus required.
    // It always has data to draw against in Pro since USASpending is loaded.
    isApplicable: () => APPLICABLE,
  },

  // FIX-217 — Scatter: agencies plotted on configurable X/Y axes.
  {
    id: 'scatter',
    label: 'Scatter',
    civicQuestion: 'Are larger agencies more politically appointed — or less?',
    description: 'Agencies plotted by FTE × appointments × spending; bubble size encodes one axis',
    group: 'standard',
    status: 'active',
    icon: 'M3 21h18M5 17l4-8 4 4 6-12',

    requiresEntity: false,
    supportedConnectionTypes: ['appointment', 'contract_award'],
    defaultOptions: {
      xAxis: 'fte',
      yAxis: 'appointment_count',
      sizeBy: 'fte',
      colorBy: 'agency_type',
      showLabels: true,
      logXAxis: true,
    },

    screenshotTarget: '#scatter-svg',
    screenshotPrep: prepScreenshot,
    tooltip: placeholderTooltip,
    onNodeClick: defaultOnNodeClick,

    // Scatter is the agency overview viz. Always available — global default
    // when nothing focused. Highlights the focused agency when one is in focus.
    isApplicable: () => APPLICABLE,
  },

  // FIX-217 — Choropleth: per-district map of a derived metric.
  {
    id: 'choropleth',
    label: 'Choropleth Map',
    civicQuestion: 'Where do districts diverge from their party line?',
    description: 'Per-district map; color encodes within-district party-cohesion or vote divergence',
    group: 'standard',
    status: 'active',
    icon: 'M3 5l6-2 6 2 6-2v16l-6 2-6-2-6 2zM9 3v16M15 5v16',

    requiresEntity: false,
    supportedConnectionTypes: ['vote_yes', 'vote_no'],
    defaultOptions: {
      measure: 'party_cohesion',
      bandLevel: 'congressional',
      colorScale: 'diverging',
      showLabels: false,
    },

    screenshotTarget: '#choropleth-svg',
    screenshotPrep: prepScreenshot,
    tooltip: placeholderTooltip,
    onNodeClick: defaultOnNodeClick,

    // Choropleth always has districts to render. Highlights the focused
    // official's district when one is set.
    isApplicable: () => APPLICABLE,
  },

  // FIX-217 — Gantt: time-tenure bars for agency leadership.
  {
    id: 'gantt',
    label: 'Tenure Gantt',
    civicQuestion: 'Who has led this agency, and for how long?',
    description: 'Per-position tenure bars — start/end dates, party color, current vs past',
    group: 'standard',
    status: 'active',
    icon: 'M3 6h8M3 12h12m-12 6h6',

    requiresEntity: true,
    supportedConnectionTypes: ['appointment'],
    defaultOptions: {
      groupBy: 'position_title',
      showCurrent: true,
      showLabels: true,
    },

    screenshotTarget: '#gantt-svg',
    screenshotPrep: prepScreenshot,
    tooltip: placeholderTooltip,
    onNodeClick: defaultOnNodeClick,

    // Gantt is agency-leadership-only. Needs an agency in focus to scope
    // the tenure query.
    isApplicable: (focus) => {
      if (focusHasEntityType(focus, 'agency')) return APPLICABLE
      return { applicable: false, reason: 'Add an agency to enable Tenure Gantt' }
    },
  },
]

// ── Public helper (FIX-129) ────────────────────────────────────────────────────

/**
 * Compute applicability for any viz entry. Default (entry has no isApplicable)
 * is `{ applicable: true }`. The right-panel Visualization section and the
 * header viz dropdown both call this — keep it cheap.
 */
export function getVizApplicability(
  entry: VizDefinition,
  focus: GraphView['focus'],
  connections: GraphView['connections'],
  graphMeta?: VizApplicabilityMeta,
): VizApplicability {
  return entry.isApplicable
    ? entry.isApplicable(focus, connections, graphMeta)
    : APPLICABLE
}

export const vizRegistry = new Map<VizType, VizRegistryEntry>(
  VIZ_REGISTRY.map((v) => [v.id, v])
)
