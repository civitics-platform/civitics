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
    icon: 'legislature_upper',
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
    icon: 'legislature_lower',
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
    icon: 'users',
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
    icon: 'users',
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
    icon: 'users',
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
    icon: 'users',
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
    icon: 'judicial',
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
    icon: 'lobbying',
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
    icon: 'finance',
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
    icon: 'oil_gas',
    color: 'rgb(var(--c-viz-6))',
    filter: {
      entity_type: 'pac',
      industry: 'oil_gas',
    },
    isPremade: true,
    description: 'Oil, gas, and energy sector PACs',
  },
  {
    // FIX-908: `pharma` → `health`. The group ID is a STABLE HANDLE referenced by
    // saved sessions and share codes — renamed the label and repointed the
    // filter, never the id.
    id: 'group-pac-healthcare',
    name: 'Health Care PACs',
    type: 'group',
    icon: 'health',
    color: 'rgb(var(--c-viz-1))',
    filter: {
      entity_type: 'pac',
      industry: 'health',
    },
    isPremade: true,
    description: 'Hospital, physician, insurer, pharmaceutical, and biotech PACs',
  },
  {
    id: 'group-pac-defense',
    name: 'Defense PACs',
    type: 'group',
    icon: 'defense',
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
    icon: 'labor',
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
    icon: 'tech',
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
    icon: 'agriculture',
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
    icon: 'real_estate',
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
    icon: 'retail',
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
    icon: 'legal',
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
    icon: 'transportation',
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
    icon: 'agency',
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
    icon: 'agency',
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
    icon: 'judicial',
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
    icon: 'executive',
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
    icon: 'super_pac',
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
    icon: 'party_committee',
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
    icon: 'corporation',
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
    icon: 'union',
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
    icon: 'individual',
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
    icon: 'bill',
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
    icon: 'deadline',
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
    icon: 'regulation',
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
    icon: 'initiative',
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
    icon: 'complete',
    color: 'rgb(var(--c-ink-soft))',
    filter: {
      entity_type: 'initiative',
      initiative_stage: 'resolved',
    },
    isPremade: true,
    description: 'Civic initiatives that have reached resolution',
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
    icon: filter.entity_type === 'pac' ? 'pac' : 'official',
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
