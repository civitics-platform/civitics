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

import type {
  GraphView,
  GraphViewPreset,
  PresetEntityKind,
  FocusItem,
  FocusEntity,
} from './types'
import { isFocusGroup } from './types'
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
    applicableEntityTypes: ['official', 'agency', 'pac', 'financial', 'proposal', 'unfocused'],
    intent: 'follow-the-money',
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
    applicableEntityTypes: ['official', 'proposal'],
    inapplicableEntityTypes: ['pac', 'financial', 'individual'],
    intent: 'votes-and-bills',
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
    applicableEntityTypes: ['official'],
    intent: 'nominations',
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
    applicableEntityTypes: ['official', 'agency'],
    intent: 'committee-power',
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
    applicableEntityTypes: ['official', 'agency', 'pac', 'financial', 'proposal', 'unfocused'],
    intent: 'full-record',
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
    applicableEntityTypes: ['any'],
    intent: 'clean-view',
  },
}

// QWEN-ADDED: Shows which industries and PACs fund which officials
export const INDUSTRY_CAPTURE: GraphViewPreset = {
  focus: {
    entities: [],
    scope: 'all',
    depth: 2,
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
        edgeOpacity: 0.75,
        theme: 'dark',
      },
    },
  },
  meta: {
    name: 'Industry Capture',
    isPreset: true,
    presetId: 'industry-capture',
    isDirty: false,
    applicableEntityTypes: ['official', 'pac', 'financial', 'agency'],
    intent: 'industry-capture',
  },
}

// QWEN-ADDED: Shows co-sponsorship networks between legislators
export const CO_SPONSOR_NETWORK: GraphViewPreset = {
  focus: {
    entities: [],
    scope: 'all',
    depth: 2,
    includeProcedural: false,
  },
  connections: buildConnections(['co_sponsorship']),
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
    name: 'Co-Sponsor Network',
    isPreset: true,
    presetId: 'co-sponsor-network',
    isDirty: false,
    applicableEntityTypes: ['official', 'proposal'],
    intent: 'co-sponsorship-network',
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
    applicableEntityTypes: ['official', 'pac', 'financial', 'unfocused'],
    intent: 'top-donors-chord',
    dataModeByEntity: {
      official: { chord: { entityMode: true, normalizeMode: false, showLabels: true, padAngle: 0.05, minFlowUsd: 1_000_000 } },
    },
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
    applicableEntityTypes: ['official', 'unfocused'],
    intent: 'official-donors',
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
    applicableEntityTypes: ['official', 'unfocused'],
    intent: 'official-donors',
  },
}

export const TREEMAP_DONOR_BREAKDOWN: GraphViewPreset = {
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
        groupBy: 'industry',
        sizeBy: 'donation_total',
        colorBy: 'party',
        entityMode: true,
      },
    },
  },
  meta: {
    name: 'Donor Breakdown',
    isPreset: true,
    presetId: 'treemap-donor-breakdown',
    isDirty: false,
    applicableEntityTypes: ['official'],
    intent: 'official-donors',
    dataModeByEntity: {
      pac: { treemap: { dataMode: 'pac_sector', groupBy: 'industry', sizeBy: 'donation_total', colorBy: 'industry' } },
    },
  },
}

export const TREEMAP_PAC_SECTOR: GraphViewPreset = {
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
        dataMode: 'pac_sector',
        groupBy: 'industry',
        sizeBy: 'donation_total',
        colorBy: 'industry',
      },
    },
  },
  meta: {
    name: 'PAC Money by Sector',
    isPreset: true,
    presetId: 'treemap-pac-sector',
    isDirty: false,
    // FIX-216 — when an official is focused, the resolver flips the intent
    // to 'pacs-to-official' and TreemapGraph forwards entityId to the
    // /api/graph/treemap-pac endpoint. Otherwise the global view applies.
    applicableEntityTypes: ['official', 'pac', 'financial', 'agency', 'unfocused'],
    intent: 'pacs-by-sector-global',
    dataModeByEntity: {
      official: { treemap: { dataMode: 'pac_sector', groupBy: 'industry', sizeBy: 'donation_total', colorBy: 'industry' } },
    },
  },
}

export const TREEMAP_PAC_PARTY: GraphViewPreset = {
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
        dataMode: 'pac_party',
        groupBy: 'party',
        sizeBy: 'donation_total',
        colorBy: 'party',
      },
    },
  },
  meta: {
    name: 'PAC Money by Party',
    isPreset: true,
    presetId: 'treemap-pac-party',
    isDirty: false,
    // FIX-216 — official focus → degenerate single-group hierarchy
    // (one party). Resolver still applies entityId via intent flip.
    applicableEntityTypes: ['official', 'pac', 'financial', 'unfocused'],
    intent: 'pacs-by-sector-global',
    dataModeByEntity: {
      official: { treemap: { dataMode: 'pac_party', groupBy: 'party', sizeBy: 'donation_total', colorBy: 'party' } },
    },
  },
}

export const CHORD_DONOR_INDUSTRIES: GraphViewPreset = {
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
        minFlowUsd: 0,
        entityMode: true,
      },
    },
  },
  meta: {
    name: 'Industry Donors',
    isPreset: true,
    presetId: 'chord-donor-industries',
    isDirty: false,
    applicableEntityTypes: ['official', 'pac', 'financial'],
    intent: 'industry-donors-chord',
  },
}

// FIX-146: alignment viz auto-loads alongside the USER node + rep edges that
// GraphPage already fetches when the user has a home district configured.
// Selecting this preset switches viz; alignment data lights up on its own.
export const HOW_ALIGNED_ARE_MY_REPS: GraphViewPreset = {
  focus: {
    entities: [],
    scope: 'all',
    depth: 1,
    includeProcedural: false,
  },
  connections: buildConnections(['alignment']),
  style: {
    vizType: 'alignment',
    vizOptions: {
      alignment: {
        sortBy: 'alignment',
        showLabels: true,
        fillMode: 'ratio',
      },
    },
  },
  meta: {
    name: 'How aligned are my reps?',
    isPreset: true,
    presetId: 'alignment-my-reps',
    isDirty: false,
    applicableEntityTypes: ['official', 'unfocused'],
    intent: 'alignment-my-reps',
  },
}

// Optimized for groups (Full Senate, Finance PACs, Federal Agencies, etc.).
// Radial layout puts the group node at center with donors/overseers fanning out.
// Sizes nodes by donation total so the biggest institutional donors are obvious.
// $25k floor suppresses small bundlers while keeping mid-size PAC connections.
export const GROUP_OVERVIEW: GraphViewPreset = {
  focus: {
    entities: [],
    scope: 'federal',
    depth: 1,
    includeProcedural: false,
  },
  connections: buildConnections(['donation'], {
    donation: { minAmount: 25_000 },
  }),
  style: {
    vizType: 'force',
    vizOptions: {
      force: {
        layout: 'radial',
        nodeSizeEncoding: 'donation_total',
        nodeColorEncoding: 'entity_type',
        singleColor: '#6366f1',
        edgeThicknessEncoding: 'amount_proportional',
        edgeOpacity: 0.75,
        theme: 'dark',
      },
    },
  },
  meta: {
    name: 'Group Overview',
    isPreset: true,
    presetId: 'group-overview',
    isDirty: false,
    applicableEntityTypes: ['group'],
    intent: 'group-overview',
  },
}

// ── Preset Collection ──────────────────────────────────────────────────────────

export const BUILT_IN_PRESETS: GraphViewPreset[] = [
  GROUP_OVERVIEW,
  FOLLOW_THE_MONEY,
  VOTES_AND_BILLS,
  NOMINATIONS,
  COMMITTEE_POWER,
  FULL_RECORD,
  CLEAN_VIEW,
  INDUSTRY_CAPTURE,
  CO_SPONSOR_NETWORK,
  CHORD_TOP_DONORS,
  TREEMAP_BY_STATE,
  TREEMAP_BY_CHAMBER,
  TREEMAP_DONOR_BREAKDOWN,
  TREEMAP_PAC_SECTOR,
  TREEMAP_PAC_PARTY,
  CHORD_DONOR_INDUSTRIES,
  HOW_ALIGNED_ARE_MY_REPS,
]

// ── FIX-216 — Entity-Type Awareness ────────────────────────────────────────────

/**
 * Concrete focus kinds excluding the 'any' wildcard, which is only meaningful
 * in `applicableEntityTypes`. The resolver and applicability logic always
 * see one of these — never 'any'.
 */
type ConcreteFocusKind = Exclude<PresetEntityKind, 'any'>

/**
 * Map a FocusItem to a ConcreteFocusKind. PACs/individuals are "financial"
 * subtypes — surfaced separately so presets can target them precisely.
 */
function focusItemToKind(item: FocusItem): ConcreteFocusKind {
  if (isFocusGroup(item)) return 'group'
  const ent = item as FocusEntity
  if (ent.type === 'financial') {
    // Heuristic: roles/names with INDIVIDUAL → 'individual', else treat as 'pac'.
    // The proper subtype lives in the API result (entity_type), but FocusEntity
    // doesn't carry it; treat unspecified financial as 'pac' since presets
    // overwhelmingly target PACs (individuals are rarely focused directly).
    const role = (ent.role ?? '').toUpperCase()
    if (role.includes('INDIVIDUAL')) return 'individual'
    return 'pac'
  }
  return ent.type as ConcreteFocusKind
}

/**
 * Reduce a focus entities[] list to its dominant kind for resolver lookup.
 * Picks the first focused entity's kind. Returns 'unfocused' for empty focus.
 */
function dominantFocusKind(focus: GraphView['focus']): ConcreteFocusKind {
  const head = focus.entities[0]
  if (!head) return 'unfocused'
  return focusItemToKind(head)
}

/**
 * FIX-216 — Rewrite a preset's vizOptions based on the current focus.
 *
 * If the preset declares a `dataModeByEntity[<focusKind>]` override, deep-
 * merge that into `style.vizOptions[vizType]`. Otherwise return the preset
 * unchanged. Presets with no `dataModeByEntity` are no-ops (full backward
 * compat).
 *
 * Called from `applyPreset` and from `useGraphView`'s focus-change effect.
 */
export function resolvePresetForFocus(
  preset: GraphViewPreset,
  focus: GraphView['focus'],
): GraphViewPreset {
  const overrides = preset.meta.dataModeByEntity
  if (!overrides) return preset

  const kind = dominantFocusKind(focus)
  const branch = overrides[kind]
  if (!branch) return preset

  // Deep-merge: existing vizOptions + branch overrides keyed per viz.
  const mergedVizOptions: GraphView['style']['vizOptions'] = { ...preset.style.vizOptions }
  for (const [vizKey, vizOpts] of Object.entries(branch)) {
    const key = vizKey as keyof GraphView['style']['vizOptions']
    mergedVizOptions[key] = {
      ...(mergedVizOptions[key] ?? {}),
      ...(vizOpts ?? {}),
    } as never
  }

  return {
    ...preset,
    style: {
      ...preset.style,
      vizOptions: mergedVizOptions,
    },
  }
}

/**
 * FIX-216 — Decide whether a preset should appear in the right panel
 * for the current view. Returns:
 *   - 'native'   : preset matches focus type natively
 *   - 'adapted'  : preset has a dataModeByEntity override for this focus
 *   - 'inapplicable' : focus matches inapplicableEntityTypes — render disabled
 *   - 'hidden'   : viz mismatch or otherwise irrelevant
 *
 * `vizType` filtering still happens upstream — this is purely the
 * focus-vs-preset compatibility check.
 */
export type PresetApplicability = 'native' | 'adapted' | 'inapplicable' | 'hidden'

export function isPresetApplicableToView(
  preset: GraphViewPreset,
  view: GraphView,
): PresetApplicability {
  // Viz mismatch is a hard hide (callers usually pre-filter, but be safe)
  if (preset.style.vizType !== view.style.vizType) return 'hidden'

  // No applicableEntityTypes declared → treat as 'any' (always native)
  const apply = preset.meta.applicableEntityTypes
  if (!apply || apply.includes('any')) return 'native'

  const kind = dominantFocusKind(view.focus)

  // Explicit inapplicability wins
  if (preset.meta.inapplicableEntityTypes?.includes(kind)) return 'inapplicable'

  if (apply.includes(kind)) return 'native'

  // Adapted = preset has an override for this kind
  if (preset.meta.dataModeByEntity?.[kind]) return 'adapted'

  return 'hidden'
}

// ── Preset Utilities ───────────────────────────────────────────────────────────

/**
 * Apply a preset to the current view.
 * Replaces connections and style with preset values.
 * Preserves current focus.entities so the active search context is not lost.
 * Sets meta.isDirty = false since we just loaded the preset clean.
 *
 * FIX-216 — runs `resolvePresetForFocus` first so per-focus-kind
 * `dataModeByEntity` overrides are merged into the applied vizOptions.
 *
 * Presets are viz-type specific. A preset with vizType 'force' only shows
 * when the force viz is active. Use vizType 'any' for presets that work
 * across viz types.
 */
export function applyPreset(
  preset: GraphViewPreset,
  current: GraphView
): GraphView {
  const resolved = resolvePresetForFocus(preset, current.focus)
  return {
    ...resolved,
    focus: {
      ...resolved.focus,
      // Preserve current entities so focused officials/agencies survive preset switches
      entities: current.focus.entities,
    },
    meta: {
      ...resolved.meta,
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
