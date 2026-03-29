/**
 * packages/graph/src/presets.ts
 *
 * Built-in graph presets. Every preset is a complete GraphView object
 * with meta.isPreset = true. Nothing more, nothing less.
 *
 * Loading a preset replaces the entire GraphView state.
 * Modifying anything after loading sets meta.isDirty = true.
 *
 * Never remove any built-in preset — they are part of the civic toolset.
 */

import type { GraphView, GraphViewPreset } from './types'
import { DEFAULT_CONNECTION_STATE } from './connections'

// ── Default GraphView ──────────────────────────────────────────────────────────
//
// The starting state for a new graph session with no preset loaded.

export const DEFAULT_GRAPH_VIEW: GraphView = {
  focus: {
    entities: [],
    scope: 'all',
    depth: 1,
    includeProcedural: false,
  },
  connections: DEFAULT_CONNECTION_STATE,
  style: {
    vizType: 'force',
    vizOptions: {},
  },
}

// ── Preset Builder Helper ──────────────────────────────────────────────────────
//
// Builds a complete connections object by enabling only the specified types.
// All other types are disabled but their style defaults (color, opacity,
// thickness) are preserved from DEFAULT_CONNECTION_STATE.

type ConnectionOverride = Partial<{
  enabled: boolean
  minAmount: number
  opacity: number
  thickness: number
}>

function buildConnections(
  enabledTypes: string[],
  overrides: { [key: string]: ConnectionOverride } = {}
): GraphView['connections'] {
  const result: GraphView['connections'] = {}
  for (const [type, defaults] of Object.entries(DEFAULT_CONNECTION_STATE)) {
    result[type] = {
      ...defaults,
      enabled: enabledTypes.includes(type),
      ...(overrides[type] ?? {}),
    }
  }
  return result
}

// ── Built-in Presets ───────────────────────────────────────────────────────────

export const FOLLOW_THE_MONEY: GraphViewPreset = {
  focus: {
    entities: [],
    scope: 'all',
    depth: 1,           // financial networks are dense — depth 1 by default
    includeProcedural: false,
  },
  connections: buildConnections(['donation']),
  style: {
    vizType: 'force',
    vizOptions: {
      force: {
        layout: 'force_directed',
        nodeSizeEncoding: 'donation_total',
        nodeColorEncoding: 'entity_type',
        singleColor: '#3b82f6',
        edgeThicknessEncoding: 'amount_proportional',
        edgeOpacity: 0.7,
        theme: 'dark',
      },
    },
  },
  meta: {
    name: 'Follow the Money',
    isPreset: true,
    presetId: 'follow-the-money',
    isDirty: false,
  },
}

export const VOTES_AND_BILLS: GraphViewPreset = {
  focus: {
    entities: [],
    scope: 'all',
    depth: 2,
    includeProcedural: false, // procedural votes (cloture, passage) hidden by default
  },
  connections: buildConnections(['vote_yes', 'vote_no', 'co_sponsorship']),
  style: {
    vizType: 'force',
    vizOptions: {
      force: {
        layout: 'force_directed',
        nodeSizeEncoding: 'bills_sponsored',
        nodeColorEncoding: 'party_affiliation',
        singleColor: '#3b82f6',
        edgeThicknessEncoding: 'uniform',
        edgeOpacity: 0.65,
        theme: 'dark',
      },
    },
  },
  meta: {
    name: 'Votes & Bills',
    isPreset: true,
    presetId: 'votes-and-bills',
    isDirty: false,
  },
}

export const NOMINATIONS: GraphViewPreset = {
  focus: {
    entities: [],
    scope: 'senate', // nominations are confirmed by the Senate
    depth: 2,
    includeProcedural: false,
  },
  connections: buildConnections(['nomination_vote_yes', 'nomination_vote_no']),
  style: {
    vizType: 'force',
    vizOptions: {
      force: {
        layout: 'force_directed',
        nodeSizeEncoding: 'connection_count',
        nodeColorEncoding: 'party_affiliation',
        singleColor: '#3b82f6',
        edgeThicknessEncoding: 'uniform',
        edgeOpacity: 0.7,
        theme: 'dark',
      },
    },
  },
  meta: {
    name: 'Nominations',
    isPreset: true,
    presetId: 'nominations',
    isDirty: false,
  },
}

export const COMMITTEE_POWER: GraphViewPreset = {
  focus: {
    entities: [],
    scope: 'all',
    depth: 2,
    includeProcedural: false,
  },
  connections: buildConnections(['oversight']),
  style: {
    vizType: 'force',
    vizOptions: {
      force: {
        layout: 'force_directed',
        nodeSizeEncoding: 'years_in_office',
        nodeColorEncoding: 'entity_type',
        singleColor: '#3b82f6',
        edgeThicknessEncoding: 'uniform',
        edgeOpacity: 0.6,
        theme: 'dark',
      },
    },
  },
  meta: {
    name: 'Committee Power',
    isPreset: true,
    presetId: 'committee-power',
    isDirty: false,
  },
}

// All connection types enabled including procedural votes.
// For researchers and journalists who need the complete record.
export const FULL_RECORD: GraphViewPreset = {
  focus: {
    entities: [],
    scope: 'all',
    depth: 2,
    includeProcedural: true,  // show procedural votes (cloture, etc.)
  },
  connections: buildConnections(Object.keys(DEFAULT_CONNECTION_STATE)),
  style: {
    vizType: 'force',
    vizOptions: {
      force: {
        layout: 'force_directed',
        nodeSizeEncoding: 'connection_count',
        nodeColorEncoding: 'entity_type',
        singleColor: '#3b82f6',
        edgeThicknessEncoding: 'amount_proportional',
        edgeOpacity: 0.55,
        theme: 'dark',
      },
    },
  },
  meta: {
    name: 'Full Record',
    isPreset: true,
    presetId: 'full-record',
    isDirty: false,
  },
}

// All connection types enabled, donation threshold applied.
// Shows only meaningful amounts — reduces visual noise for public audiences.
export const CLEAN_VIEW: GraphViewPreset = {
  focus: {
    entities: [],
    scope: 'all',
    depth: 1,
    includeProcedural: false,
  },
  connections: buildConnections(
    Object.keys(DEFAULT_CONNECTION_STATE),
    { donation: { minAmount: 10000 } } // only show donations $10k+
  ),
  style: {
    vizType: 'force',
    vizOptions: {
      force: {
        layout: 'force_directed',
        nodeSizeEncoding: 'connection_count',
        nodeColorEncoding: 'entity_type',
        singleColor: '#3b82f6',
        edgeThicknessEncoding: 'amount_proportional',
        edgeOpacity: 0.75,
        theme: 'dark',
      },
    },
  },
  meta: {
    name: 'Clean View',
    isPreset: true,
    presetId: 'clean-view',
    isDirty: false,
  },
}

export const CHORD_TOP_DONORS: GraphViewPreset = {
  focus: {
    entities: [],
    scope: 'all',
    depth: 1,
    includeProcedural: false,
  },
  connections: DEFAULT_CONNECTION_STATE,
  style: {
    vizType: 'chord',
    vizOptions: {
      chord: {
        normalizeMode: false,
        showLabels: true,
        padAngle: 0.05,
        minFlowUsd: 1_000_000,
      },
    },
  },
  meta: {
    name: 'Top Donors Only',
    isPreset: true,
    presetId: 'chord-top-donors',
    isDirty: false,
  },
}

export const TREEMAP_BY_STATE: GraphViewPreset = {
  focus: {
    entities: [],
    scope: 'all',
    depth: 1,
    includeProcedural: false,
  },
  connections: DEFAULT_CONNECTION_STATE,
  style: {
    vizType: 'treemap',
    vizOptions: {
      treemap: {
        groupBy: 'state',
        sizeBy: 'donation_total',
        colorBy: 'party',
      },
    },
  },
  meta: {
    name: 'By State',
    isPreset: true,
    presetId: 'treemap-by-state',
    isDirty: false,
  },
}

export const TREEMAP_BY_CHAMBER: GraphViewPreset = {
  focus: {
    entities: [],
    scope: 'all',
    depth: 1,
    includeProcedural: false,
  },
  connections: DEFAULT_CONNECTION_STATE,
  style: {
    vizType: 'treemap',
    vizOptions: {
      treemap: {
        groupBy: 'chamber',
        sizeBy: 'donation_total',
        colorBy: 'chamber',
      },
    },
  },
  meta: {
    name: 'By Chamber',
    isPreset: true,
    presetId: 'treemap-by-chamber',
    isDirty: false,
  },
}

// ── Preset Collection ──────────────────────────────────────────────────────────

export const BUILT_IN_PRESETS: GraphViewPreset[] = [
  FOLLOW_THE_MONEY,
  VOTES_AND_BILLS,
  NOMINATIONS,
  COMMITTEE_POWER,
  FULL_RECORD,
  CLEAN_VIEW,
  CHORD_TOP_DONORS,
  TREEMAP_BY_STATE,
  TREEMAP_BY_CHAMBER,
]

// ── Preset Utilities ───────────────────────────────────────────────────────────

/**
 * Apply a preset to the current view.
 * Replaces connections and style with preset values.
 * Preserves current focus.entities so the active search context is not lost.
 * Sets meta.isDirty = false since we just loaded the preset clean.
 *
 * Presets are viz-type specific. A preset with vizType 'force' only shows
 * when the force viz is active. Use vizType 'any' for presets that work
 * across viz types.
 */
export function applyPreset(
  preset: GraphViewPreset,
  current: GraphView
): GraphView {
  return {
    ...preset,
    focus: {
      ...preset.focus,
      // Preserve current entities so focused officials/agencies survive preset switches
      entities: current.focus.entities,
    },
    meta: {
      ...preset.meta,
      isDirty: false,
    },
  }
}

/**
 * Mark the current view as dirty (modified from its preset baseline).
 * Call this whenever the user changes any setting while a preset is active.
 * When isDirty = true, the panel footer shows [💾 Save changes] instead of
 * [💾 Save as preset].
 */
export function markDirty(view: GraphView): GraphView {
  return {
    ...view,
    meta: {
      ...view.meta,
      isDirty: true,
    },
  }
}
