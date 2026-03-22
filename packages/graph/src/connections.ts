/**
 * packages/graph/src/connections.ts
 *
 * Single source of truth for all connection types in the platform.
 * Never hardcode connection type strings anywhere else in the codebase.
 * Always reference CONNECTION_TYPE_REGISTRY keys.
 */

import type { ConnectionTypeDefinition, GraphView } from './types'

// ── Registry ───────────────────────────────────────────────────────────────────

export const CONNECTION_TYPE_REGISTRY: Record<string, ConnectionTypeDefinition> = {
  donation: {
    label: 'Donations',
    icon: '💰',
    color: '#f59e0b',
    description: 'PAC and individual donor contributions',
    hasAmount: true,
  },
  vote_yes: {
    label: 'Voted Yes',
    icon: '✓',
    color: '#22c55e',
    description: 'Affirmative votes on legislation',
    hasAmount: false,
  },
  vote_no: {
    label: 'Voted No',
    icon: '✗',
    color: '#ef4444',
    description: 'Negative votes on legislation',
    hasAmount: false,
  },
  vote_abstain: {
    label: 'Abstained',
    icon: '○',
    color: '#94a3b8',
    description: 'Present / not voting',
    hasAmount: false,
  },
  // NOTE: nomination_vote_yes/no are VALID and DISTINCT from vote_yes/vote_no.
  // They are derived from proposals with vote_category = 'nomination'.
  // Show in UI as "Nomination Votes" — never merge with "Legislation Votes".
  nomination_vote_yes: {
    label: 'Confirmed',
    icon: '⭐',
    color: '#8b5cf6',
    description: 'Voted to confirm nomination',
    hasAmount: false,
  },
  nomination_vote_no: {
    label: 'Rejected',
    icon: '✗',
    color: '#ec4899',
    description: 'Voted against confirmation',
    hasAmount: false,
  },
  oversight: {
    label: 'Oversight',
    icon: '👁',
    color: '#06b6d4',
    description: 'Committee oversight relationships',
    hasAmount: false,
  },
  co_sponsorship: {
    label: 'Co-Sponsored',
    icon: '🤝',
    color: '#84cc16',
    description: 'Bill co-sponsorship',
    hasAmount: false,
  },
}

// ── Default connection state for a new GraphView ───────────────────────────────
//
// These are the default enabled/opacity/thickness settings for each connection
// type when no preset is active. Note:
//   - vote_abstain and co_sponsorship are off by default (too noisy)
//   - All others are enabled by default
//   - Opacity and thickness are tuned for visual balance

export const DEFAULT_CONNECTION_STATE: GraphView['connections'] = {
  donation: {
    enabled: true,
    color: CONNECTION_TYPE_REGISTRY.donation!.color,
    opacity: 0.8,
    thickness: 0.7,
    minAmount: 0,
  },
  vote_yes: {
    enabled: true,
    color: CONNECTION_TYPE_REGISTRY.vote_yes!.color,
    opacity: 0.6,
    thickness: 0.4,
  },
  vote_no: {
    enabled: true,
    color: CONNECTION_TYPE_REGISTRY.vote_no!.color,
    opacity: 0.6,
    thickness: 0.4,
  },
  vote_abstain: {
    enabled: false,
    color: CONNECTION_TYPE_REGISTRY.vote_abstain!.color,
    opacity: 0.3,
    thickness: 0.2,
  },
  nomination_vote_yes: {
    enabled: true,
    color: CONNECTION_TYPE_REGISTRY.nomination_vote_yes!.color,
    opacity: 0.7,
    thickness: 0.5,
  },
  nomination_vote_no: {
    enabled: true,
    color: CONNECTION_TYPE_REGISTRY.nomination_vote_no!.color,
    opacity: 0.7,
    thickness: 0.5,
  },
  oversight: {
    enabled: true,
    color: CONNECTION_TYPE_REGISTRY.oversight!.color,
    opacity: 0.5,
    thickness: 0.3,
  },
  co_sponsorship: {
    enabled: false,
    color: CONNECTION_TYPE_REGISTRY.co_sponsorship!.color,
    opacity: 0.5,
    thickness: 0.3,
  },
}
