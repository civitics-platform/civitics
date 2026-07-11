/**
 * packages/graph/src/groups.ts
 *
 * Built-in group definitions.
 * Groups are queries not lists —
 * they store a filter that resolves
 * to matching entities at runtime.
 *
 * Never remove built-in groups —
 * they may be referenced by saved
 * user sessions.
 *
 * Group colors are `rgb(var(--c-x))` design-token strings (FIX-729): CSS
 * contexts (swatches, style=) consume them directly; SVG/canvas consumers
 * resolve them with resolveColor()/withAlpha() from ./tokens. Saved sessions
 * may still carry legacy hex — resolveColor passes those through unchanged.
 */

import type { FocusGroup, GroupFilter } from './types'

export const BUILT_IN_GROUPS: FocusGroup[] = [

  // ── Congress ──────────────────

  {
    id: 'group-full-senate',
    name: 'Full Senate',
    type: 'group',
    icon: '🏛',
    color: 'rgb(var(--c-viz-5))',
    filter: {
      entity_type: 'official',
      governingBody: 'senate',
    },
    isPremade: true,
    description: 'All 100 U.S. Senators',
  },
  {
    id: 'group-full-house',
    name: 'Full House',
    type: 'group',
    icon: '🏠',
    color: 'rgb(var(--c-viz-6))',
    filter: {
      entity_type: 'official',
      governingBody: 'house',
    },
    isPremade: true,
    description: 'All 435 U.S. Representatives',
  },
  {
    id: 'group-senate-dems',
    name: 'Senate Democrats',
    type: 'group',
    icon: '🔵',
    color: 'rgb(var(--c-blue))',
    filter: {
      entity_type: 'official',
      governingBody: 'senate',
      party: 'democrat',
    },
    isPremade: true,
    description: 'Democratic U.S. Senators',
  },
  {
    id: 'group-senate-reps',
    name: 'Senate Republicans',
    type: 'group',
    icon: '🔴',
    color: 'rgb(var(--c-accent))',
    filter: {
      entity_type: 'official',
      governingBody: 'senate',
      party: 'republican',
    },
    isPremade: true,
    description: 'Republican U.S. Senators',
  },
  {
    id: 'group-house-dems',
    name: 'House Democrats',
    type: 'group',
    icon: '🔵',
    color: 'rgb(var(--c-blue))',
    filter: {
      entity_type: 'official',
      governingBody: 'house',
      party: 'democrat',
    },
    isPremade: true,
    description: 'Democratic U.S. Representatives',
  },
  {
    id: 'group-house-reps',
    name: 'House Republicans',
    type: 'group',
    icon: '🔴',
    color: 'rgb(var(--c-accent))',
    filter: {
      entity_type: 'official',
      governingBody: 'house',
      party: 'republican',
    },
    isPremade: true,
    description: 'Republican U.S. Representatives',
  },
  // FIX-176: Federal Judges group is hidden from the GROUP_TREE — federal
  // judges aren't in the `officials` table (they're not elected), so this
  // filter returns the wrong cohort (any active nonpartisan official). The
  // entry stays in BUILT_IN_GROUPS so saved sessions referencing it still
  // resolve, but it's no longer offered from the browser. Rewire when a
  // proper judge data source / role filter is added.
  {
    id: 'group-federal-judges',
    name: 'Federal Judges',
    type: 'group',
    icon: '⚖️',
    color: 'rgb(var(--c-viz-7))',
    filter: {
      entity_type: 'official',
      party: 'nonpartisan',
    },
    isPremade: true,
    description: 'Federal judiciary officials (no data yet — see FIX-176)',
  },

  // ── Industry PACs ──────────────
  //
  // `industry` filter values must match entity_tags.tag exactly (case-sensitive).
  // Canonical tags are lowercase/snake_case. Verified against local DB 2026-05-03.

  {
    id: 'group-pac-lobby',
    name: 'Lobby & Advocacy PACs',
    type: 'group',
    icon: '🗣',
    color: 'rgb(var(--c-viz-7))',
    filter: {
      entity_type: 'pac',
      industry: 'lobby',
    },
    isPremade: true,
    description: 'Lobbying firms, advocacy groups, and trade associations',
  },
  {
    id: 'group-pac-finance',
    name: 'Finance PACs',
    type: 'group',
    icon: '💰',
    color: 'rgb(var(--c-amber))',
    filter: {
      entity_type: 'pac',
      industry: 'finance',
    },
    isPremade: true,
    description: 'Banking, investment, and insurance PACs',
  },
  {
    id: 'group-pac-energy',
    name: 'Oil & Gas PACs',
    type: 'group',
    icon: '⚡',
    color: 'rgb(var(--c-viz-6))',
    filter: {
      entity_type: 'pac',
      industry: 'oil_gas',
    },
    isPremade: true,
    description: 'Oil, gas, and energy sector PACs',
  },
  {
    id: 'group-pac-healthcare',
    name: 'Pharma PACs',
    type: 'group',
    icon: '💊',
    color: 'rgb(var(--c-viz-1))',
    filter: {
      entity_type: 'pac',
      industry: 'pharma',
    },
    isPremade: true,
    description: 'Pharmaceutical, biotech, and medical device PACs',
  },
  {
    id: 'group-pac-defense',
    name: 'Defense PACs',
    type: 'group',
    icon: '🛡',
    color: 'rgb(var(--c-viz-5))',
    filter: {
      entity_type: 'pac',
      industry: 'defense',
    },
    isPremade: true,
    description: 'Defense contractor and aerospace PACs',
  },
  {
    id: 'group-pac-labor',
    name: 'Labor PACs',
    type: 'group',
    icon: '👷',
    color: 'rgb(var(--c-viz-9))',
    filter: {
      entity_type: 'pac',
      industry: 'labor',
    },
    isPremade: true,
    description: 'Union and worker organization PACs',
  },
  {
    id: 'group-pac-tech',
    name: 'Tech PACs',
    type: 'group',
    icon: '💻',
    color: 'rgb(var(--c-viz-2))',
    filter: {
      entity_type: 'pac',
      industry: 'tech',
    },
    isPremade: true,
    description: 'Technology and telecom PACs',
  },
  {
    id: 'group-pac-agriculture',
    name: 'Agriculture PACs',
    type: 'group',
    icon: '🌾',
    color: 'rgb(var(--c-viz-8))',
    filter: {
      entity_type: 'pac',
      industry: 'agriculture',
    },
    isPremade: true,
    description: 'Farm bureau and agricultural PACs',
  },
  {
    id: 'group-pac-realestate',
    name: 'Real Estate PACs',
    type: 'group',
    icon: '🏘',
    color: 'rgb(var(--c-viz-3))',
    filter: {
      entity_type: 'pac',
      industry: 'real_estate',
    },
    isPremade: true,
    description: 'Realtor and housing PACs',
  },
  {
    id: 'group-pac-retail',
    name: 'Retail PACs',
    type: 'group',
    icon: '🛒',
    color: 'rgb(var(--c-viz-7))',
    filter: {
      entity_type: 'pac',
      industry: 'retail',
    },
    isPremade: true,
    description: 'Retail, consumer goods, and hospitality PACs',
  },
  {
    id: 'group-pac-legal',
    name: 'Legal PACs',
    type: 'group',
    icon: '⚖️',
    color: 'rgb(var(--c-blue))',
    filter: {
      entity_type: 'pac',
      industry: 'legal',
    },
    isPremade: true,
    description: 'Law firm and legal industry PACs',
  },
  {
    id: 'group-pac-transportation',
    name: 'Transportation PACs',
    type: 'group',
    icon: '🚛',
    color: 'rgb(var(--c-viz-5))',
    filter: {
      entity_type: 'pac',
      industry: 'transportation',
    },
    isPremade: true,
    description: 'Airlines, railroads, trucking, and shipping PACs',
  },

  // ── Federal Agencies ───────────

  {
    id: 'group-federal-agencies',
    name: 'Federal Agencies',
    type: 'group',
    icon: '🏛',
    color: 'rgb(var(--c-viz-5))',
    filter: {
      entity_type: 'agency',
    },
    isPremade: true,
    description: 'All active federal executive and regulatory agencies',
  },

  // ── Independent Agencies ───────

  {
    id: 'group-independent-agencies',
    name: 'Independent Agencies',
    type: 'group',
    icon: '🏢',
    color: 'rgb(var(--c-ink-soft))',
    filter: {
      entity_type: 'agency',
      agency_type: 'independent',
    },
    isPremade: true,
    description: 'Independent regulatory commissions and agencies',
  },

  // ── Judiciary / Cabinet ────────

  {
    id: 'group-judiciary',
    name: 'Federal Judiciary',
    type: 'group',
    icon: '⚖️',
    color: 'rgb(var(--c-viz-7))',
    filter: {
      entity_type: 'official',
      official_role: 'judiciary',
    },
    isPremade: true,
    description: 'Federal judges and justices',
  },

  {
    id: 'group-cabinet',
    name: 'Cabinet & Executive',
    type: 'group',
    icon: '🪪',
    color: 'rgb(var(--c-viz-6))',
    filter: {
      entity_type: 'official',
      official_role: 'cabinet',
    },
    isPremade: true,
    description: 'Cabinet secretaries and senior executive appointees',
  },

  // ── Financial entity types ─────

  {
    id: 'group-super-pacs',
    name: 'Super PACs',
    type: 'group',
    icon: '💲',
    color: 'rgb(var(--c-accent))',
    filter: {
      entity_type: 'financial',
      financial_type: 'super_pac',
    },
    isPremade: true,
    description: 'Super PACs — independent expenditure-only committees',
  },

  {
    id: 'group-party-committees',
    name: 'Party Committees',
    type: 'group',
    icon: '🎪',
    color: 'rgb(var(--c-viz-7))',
    filter: {
      entity_type: 'financial',
      financial_type: 'party_committee',
    },
    isPremade: true,
    description: 'DCCC, NRCC, DSCC, NRSC and state party committees',
  },

  {
    id: 'group-corporations',
    name: 'Corporations',
    type: 'group',
    icon: '🏭',
    color: 'rgb(var(--c-viz-2))',
    filter: {
      entity_type: 'financial',
      financial_type: 'corporation',
    },
    isPremade: true,
    // FIX-772: corporations carry no direct-contribution edges (FEC bars
    // corporate treasury donations to candidates) — their money surface on the
    // graph is federal contract awards, so the description says that.
    description: 'Corporations receiving federal contract dollars',
  },

  // FIX-772: Unions and Individual Donors are hidden from the GROUP_TREE (the
  // FIX-176 federal-judges pattern — entries stay in BUILT_IN_GROUPS so saved
  // sessions still resolve).
  //   Unions: the 'union' financial cohort is LittleSis org rows with zero
  //   dollar totals and zero money edges on both DBs (verified local + prod
  //   2026-07-10) — the bubble would render 100+ members and no connections.
  //   Labor money that actually flows lives in the Labor PACs group above.
  //   Rewire if a union-committee data source lands.
  //   Individual Donors: individuals are deliberately non-enumerable as a
  //   cohort (excluded from entity_search_index, FIX-236/FIX-748) — the route
  //   answers a structured 422 for saved sessions.
  {
    id: 'group-unions',
    name: 'Unions & Labor',
    type: 'group',
    icon: '👷',
    color: 'rgb(var(--c-viz-9))',
    filter: {
      entity_type: 'financial',
      financial_type: 'union',
    },
    isPremade: true,
    description: 'Labor unions and worker organizations (no money-edge data yet — see FIX-772)',
  },

  {
    id: 'group-individual-donors',
    name: 'Individual Donors',
    type: 'group',
    icon: '👤',
    color: 'rgb(var(--c-viz-1))',
    filter: {
      entity_type: 'financial',
      financial_type: 'individual',
    },
    isPremade: true,
    description: 'Individual campaign donors (not resolvable as a cohort — see FIX-772)',
  },

  // ── Proposal types ─────────────

  {
    id: 'group-proposals-bills',
    name: 'Bills',
    type: 'group',
    icon: '📋',
    color: 'rgb(var(--c-blue))',
    filter: {
      entity_type: 'proposal',
      proposal_type: 'bill',
    },
    isPremade: true,
    description: 'Legislation introduced in Congress',
  },

  {
    id: 'group-proposals-open-comment',
    name: 'Open for Comment',
    type: 'group',
    icon: '⚡',
    color: 'rgb(var(--c-green-ink))',
    filter: {
      entity_type: 'proposal',
      tag: 'open_comment',
    },
    isPremade: true,
    description: 'Regulations currently accepting public comment',
  },

  {
    id: 'group-proposals-regulations',
    name: 'Regulations',
    type: 'group',
    icon: '📜',
    color: 'rgb(var(--c-viz-3))',
    filter: {
      entity_type: 'proposal',
      proposal_type: 'regulation',
    },
    isPremade: true,
    description: 'Federal regulations and rulemaking',
  },

  // ── Initiatives ────────────────

  {
    id: 'group-initiatives-active',
    name: 'Active Initiatives',
    type: 'group',
    icon: '🌱',
    color: 'rgb(var(--c-green-ink))',
    filter: {
      entity_type: 'initiative',
      initiative_stage: 'mobilise',
    },
    isPremade: true,
    description: 'Civic initiatives in deliberation or mobilisation phase',
  },

  {
    id: 'group-initiatives-resolved',
    name: 'Resolved Initiatives',
    type: 'group',
    icon: '✅',
    color: 'rgb(var(--c-ink-soft))',
    filter: {
      entity_type: 'initiative',
      initiative_stage: 'resolved',
    },
    isPremade: true,
    description: 'Civic initiatives that have reached resolution',
  },
]

// ── Browse hierarchy (FIX-135) ─────────────────────────────────────────────────
//
// Recursive 5-category tree rendered by GroupBrowser.
// `kind: 'group'` leaves point at BUILT_IN_GROUPS by id.
// `kind: 'state-list'` / `kind: 'custom-form'` are slots GroupBrowser
//   renders as the 50-state drill-down (FIX-136) and Build-custom-group form.
// `kind: 'category'` is a recursive section header.
//
// Empty categories (Government, Legislation) are intentionally omitted until
// FIX-137 (topic tags), FIX-139 (committees), FIX-143 (contracts) etc. land
// — per app rule, no placeholder data.

export type GroupTreeNode =
  | { kind: 'group'; id: string }
  | { kind: 'state-list' }
  | { kind: 'topic-tag-list' }
  | { kind: 'committee-list' }
  | { kind: 'gb-list' }
  | { kind: 'home-location' }
  | { kind: 'recent-list' }
  | { kind: 'custom-form' }
  | {
      kind: 'category'
      label: string
      icon?: string
      defaultExpanded?: boolean
      children: GroupTreeNode[]
    }

export const GROUP_TREE: GroupTreeNode[] = [
  {
    kind: 'category',
    label: 'People',
    icon: '👥',
    defaultExpanded: true,
    children: [
      {
        kind: 'category',
        label: 'Officials',
        icon: '👤',
        defaultExpanded: true,
        children: [
          {
            kind: 'category',
            label: 'Federal',
            icon: '🏛',
            defaultExpanded: true,
            children: [
              {
                kind: 'category',
                label: 'Congress',
                icon: '🗳',
                defaultExpanded: false,
                children: [
                  { kind: 'home-location' },
                  { kind: 'group', id: 'group-full-senate' },
                  { kind: 'group', id: 'group-senate-dems' },
                  { kind: 'group', id: 'group-senate-reps' },
                  { kind: 'group', id: 'group-full-house' },
                  { kind: 'group', id: 'group-house-dems' },
                  { kind: 'group', id: 'group-house-reps' },
                ],
              },
              { kind: 'group', id: 'group-judiciary' },
              { kind: 'group', id: 'group-cabinet' },
            ],
          },
          {
            kind: 'category',
            label: 'By state',
            icon: '🗺',
            defaultExpanded: false,
            children: [{ kind: 'state-list' }],
          },
          {
            // FIX-493 (FIX-468 Wave B) — state-chamber gb groups, derived at
            // runtime from the slugged legislature_* governing_bodies rows.
            kind: 'category',
            label: 'State legislatures',
            icon: '🏛',
            defaultExpanded: false,
            children: [{ kind: 'gb-list' }],
          },
          {
            kind: 'category',
            label: 'By committee',
            icon: '🪪',
            defaultExpanded: false,
            children: [{ kind: 'committee-list' }],
          },
        ],
      },
    ],
  },
  {
    kind: 'category',
    label: 'Money',
    icon: '💰',
    defaultExpanded: true,
    children: [
      {
        kind: 'category',
        label: 'PACs by industry',
        icon: '💼',
        defaultExpanded: false,
        children: [
          { kind: 'group', id: 'group-pac-lobby' },
          { kind: 'group', id: 'group-pac-finance' },
          { kind: 'group', id: 'group-pac-energy' },
          { kind: 'group', id: 'group-pac-healthcare' },
          { kind: 'group', id: 'group-pac-defense' },
          { kind: 'group', id: 'group-pac-labor' },
          { kind: 'group', id: 'group-pac-tech' },
          { kind: 'group', id: 'group-pac-agriculture' },
          { kind: 'group', id: 'group-pac-realestate' },
          { kind: 'group', id: 'group-pac-retail' },
          { kind: 'group', id: 'group-pac-legal' },
          { kind: 'group', id: 'group-pac-transportation' },
        ],
      },
      { kind: 'group', id: 'group-super-pacs' },
      { kind: 'group', id: 'group-party-committees' },
      { kind: 'group', id: 'group-corporations' },
      // FIX-772: group-unions and group-individual-donors are intentionally
      // NOT offered here — see the BUILT_IN_GROUPS comment above their entries
      // (dead union money data / non-enumerable individuals). Saved sessions
      // referencing them still resolve through getGroupById.
    ],
  },
  {
    kind: 'category',
    label: 'Government',
    icon: '🏛',
    defaultExpanded: false,
    children: [
      {
        kind: 'category',
        label: 'Agencies',
        icon: '🏢',
        defaultExpanded: true,
        children: [
          { kind: 'group', id: 'group-federal-agencies' },
          { kind: 'group', id: 'group-independent-agencies' },
        ],
      },
    ],
  },
  {
    kind: 'category',
    label: 'Legislation',
    icon: '📜',
    defaultExpanded: false,
    children: [
      {
        kind: 'category',
        label: 'Proposals',
        icon: '📋',
        defaultExpanded: true,
        children: [
          { kind: 'group', id: 'group-proposals-open-comment' },
          { kind: 'group', id: 'group-proposals-bills' },
          { kind: 'group', id: 'group-proposals-regulations' },
        ],
      },
      {
        kind: 'category',
        label: 'By topic tag',
        icon: '🏷',
        defaultExpanded: false,
        children: [{ kind: 'topic-tag-list' }],
      },
    ],
  },
  {
    kind: 'category',
    label: 'Initiatives',
    icon: '🌱',
    defaultExpanded: false,
    children: [
      { kind: 'group', id: 'group-initiatives-active' },
      { kind: 'group', id: 'group-initiatives-resolved' },
    ],
  },
  {
    kind: 'category',
    label: 'Saved',
    icon: '⭐',
    defaultExpanded: false,
    children: [
      {
        kind: 'category',
        label: 'Recently viewed',
        icon: '🕒',
        defaultExpanded: false,
        children: [{ kind: 'recent-list' }],
      },
      {
        kind: 'category',
        label: 'Build custom group',
        icon: '✏️',
        defaultExpanded: false,
        children: [{ kind: 'custom-form' }],
      },
    ],
  },
]

// Helper to look up a group by ID:

export function getGroupById(id: string): FocusGroup | undefined {
  return BUILT_IN_GROUPS.find(g => g.id === id)
}

// Helper to build a custom group from a filter:

export function createCustomGroup(filter: GroupFilter, name?: string): FocusGroup {
  const id = 'group-custom-' + Math.random().toString(36).slice(2, 8)
  const autoName = name ?? buildGroupName(filter)

  return {
    id,
    name: autoName,
    type: 'group',
    icon: filter.entity_type === 'pac' ? '💼' : '👤',
    color: filter.party === 'democrat'
      ? 'rgb(var(--c-blue))'
      : filter.party === 'republican'
      ? 'rgb(var(--c-accent))'
      : 'rgb(var(--c-viz-5))',
    filter,
    isPremade: false,
  }
}

// Auto-generate a name from a filter for custom groups:

function buildGroupName(filter: GroupFilter): string {
  const parts: string[] = []

  if (filter.state)
    parts.push(filter.state)

  if (filter.party)
    parts.push(filter.party.charAt(0).toUpperCase() + filter.party.slice(1))

  if (filter.chamber)
    parts.push(filter.chamber.charAt(0).toUpperCase() + filter.chamber.slice(1))

  if (filter.entity_type === 'pac' && filter.industry)
    parts.push(filter.industry + ' PACs')
  else if (filter.entity_type === 'proposal' && filter.tag)
    parts.push(filter.tag + ' bills')
  else if (filter.entity_type === 'official')
    parts.push('Officials')

  return parts.join(' ') || 'Custom Group'
}
