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
 */

import type { FocusGroup, GroupFilter } from './types'

export const BUILT_IN_GROUPS: FocusGroup[] = [

  // ── Congress ──────────────────

  {
    id: 'group-full-senate',
    name: 'Full Senate',
    type: 'group',
    icon: '🏛',
    color: '#6366f1',
    filter: {
      entity_type: 'official',
      chamber: 'senate',
    },
    isPremade: true,
    description: 'All 100 U.S. Senators',
  },
  {
    id: 'group-full-house',
    name: 'Full House',
    type: 'group',
    icon: '🏠',
    color: '#8b5cf6',
    filter: {
      entity_type: 'official',
      chamber: 'house',
    },
    isPremade: true,
    description: 'All 435 U.S. Representatives',
  },
  {
    id: 'group-senate-dems',
    name: 'Senate Democrats',
    type: 'group',
    icon: '🔵',
    color: '#3b82f6',
    filter: {
      entity_type: 'official',
      chamber: 'senate',
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
    color: '#ef4444',
    filter: {
      entity_type: 'official',
      chamber: 'senate',
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
    color: '#2563eb',
    filter: {
      entity_type: 'official',
      chamber: 'house',
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
    color: '#dc2626',
    filter: {
      entity_type: 'official',
      chamber: 'house',
      party: 'republican',
    },
    isPremade: true,
    description: 'Republican U.S. Representatives',
  },
  {
    id: 'group-federal-judges',
    name: 'Federal Judges',
    type: 'group',
    icon: '⚖️',
    color: '#64748b',
    filter: {
      entity_type: 'official',
      party: 'nonpartisan',
    },
    isPremade: true,
    description: 'Federal judiciary officials',
  },

  // ── Industry PACs ──────────────

  {
    id: 'group-pac-finance',
    name: 'Finance PACs',
    type: 'group',
    icon: '💰',
    color: '#f59e0b',
    filter: {
      entity_type: 'pac',
      industry: 'Finance',
    },
    isPremade: true,
    description: 'Banking, investment, and insurance PACs',
  },
  {
    id: 'group-pac-energy',
    name: 'Energy PACs',
    type: 'group',
    icon: '⚡',
    color: '#f97316',
    filter: {
      entity_type: 'pac',
      industry: 'Energy',
    },
    isPremade: true,
    description: 'Oil, gas, coal, and utility PACs',
  },
  {
    id: 'group-pac-healthcare',
    name: 'Healthcare PACs',
    type: 'group',
    icon: '🏥',
    color: '#10b981',
    filter: {
      entity_type: 'pac',
      industry: 'Healthcare',
    },
    isPremade: true,
    description: 'Pharma, hospital, and medical PACs',
  },
  {
    id: 'group-pac-defense',
    name: 'Defense PACs',
    type: 'group',
    icon: '🛡',
    color: '#64748b',
    filter: {
      entity_type: 'pac',
      industry: 'Defense',
    },
    isPremade: true,
    description: 'Defense contractor and aerospace PACs',
  },
  {
    id: 'group-pac-labor',
    name: 'Labor PACs',
    type: 'group',
    icon: '👷',
    color: '#f43f5e',
    filter: {
      entity_type: 'pac',
      industry: 'Labor',
    },
    isPremade: true,
    description: 'Union and worker organization PACs',
  },
  {
    id: 'group-pac-tech',
    name: 'Tech PACs',
    type: 'group',
    icon: '💻',
    color: '#06b6d4',
    filter: {
      entity_type: 'pac',
      industry: 'Tech',
    },
    isPremade: true,
    description: 'Technology and telecom PACs',
  },
  {
    id: 'group-pac-agriculture',
    name: 'Agriculture PACs',
    type: 'group',
    icon: '🌾',
    color: '#84cc16',
    filter: {
      entity_type: 'pac',
      industry: 'Agriculture',
    },
    isPremade: true,
    description: 'Farm bureau and agricultural PACs',
  },
  {
    id: 'group-pac-realestate',
    name: 'Real Estate PACs',
    type: 'group',
    icon: '🏘',
    color: '#a78bfa',
    filter: {
      entity_type: 'pac',
      industry: 'Real Estate',
    },
    isPremade: true,
    description: 'Realtor and housing PACs',
  },
]

// Group definitions by category for display in GroupBrowser:

export const GROUP_CATEGORIES: Record<string, string[]> = {
  'Congress': [
    'group-full-senate',
    'group-full-house',
    'group-senate-dems',
    'group-senate-reps',
    'group-house-dems',
    'group-house-reps',
    'group-federal-judges',
  ],
  'Industry PACs': [
    'group-pac-finance',
    'group-pac-energy',
    'group-pac-healthcare',
    'group-pac-defense',
    'group-pac-labor',
    'group-pac-tech',
    'group-pac-agriculture',
    'group-pac-realestate',
  ],
}

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
      ? '#3b82f6'
      : filter.party === 'republican'
      ? '#ef4444'
      : '#6366f1',
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
  else if (filter.entity_type === 'official')
    parts.push('Officials')

  return parts.join(' ') || 'Custom Group'
}
