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

import type { VizDefinition, VizType, GraphNode, NodeActions } from '../types'
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
    supportedConnectionTypes: ['donation'],
    defaultOptions: {
      showLabels: true,
      normalizeMode: false,
      padAngle: 0.05,
    },

    screenshotTarget: '#chord-diagram-svg',
    screenshotPrep: prepScreenshot,
    tooltip: placeholderTooltip,
    onNodeClick: defaultOnNodeClick,
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
  },
]

export const vizRegistry = new Map<VizType, VizRegistryEntry>(
  VIZ_REGISTRY.map((v) => [v.id, v])
)
