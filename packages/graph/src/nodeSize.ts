/**
 * packages/graph/src/nodeSize.ts — FIX-D (Graph Polish P5)
 *
 * Pure node-size-scale helpers, extracted from ForceGraph so the domain-aware
 * linear scale is unit-testable (the force component itself pulls in d3 + React
 * and can't load in the tsx test harness). ForceGraph re-imports these; the
 * legend uses the same scaledRadius() so it can never disagree with the nodes.
 */

import type { GraphNode } from './types'
import type { ForceOptions } from './types'

export type SizeScale = NonNullable<ForceOptions['sizeScale']>

// FIX-847 — hard ceiling applied in EVERY size mode. The old uncapped
// `base + sqrt(donationTotal/100_000)*2` gave a $100M donor a +632px radius that
// swallowed the canvas; linear mode would be far worse.
export const MAX_NODE_RADIUS = 72

/**
 * Normalized magnitude `v` for a node under the active size encoding. Money
 * encodings are expressed in $/1000 so log/sqrt behave identically across
 * donation and contract dollars (mind units: node.contractTotal is DOLLARS,
 * node.donationTotal is CENTS). connection_count — and the retired placebo
 * aliases votes_cast/bills_sponsored/years_in_office (coerced away in the panel)
 * — fall through to the raw degree.
 */
export function nodeSizeMagnitude(node: GraphNode, sizeBy: string | undefined): number {
  if (sizeBy === 'donation_total') return (node.donationTotal ?? 0) / 100_000 // cents → $/1000
  if (sizeBy === 'contract_total') return (node.contractTotal ?? 0) / 1_000   // $ → $/1000
  return node.connectionCount ?? 0
}

/** Largest magnitude across the graph for the active encoding (linear + legend). */
export function sizeDomainMax(nodes: ReadonlyArray<GraphNode>, sizeBy: string | undefined): number {
  let max = 0
  for (const n of nodes) {
    const v = nodeSizeMagnitude(n, sizeBy)
    if (v > max) max = v
  }
  return max
}

/**
 * Map a normalized magnitude `v` to a radius under the chosen scale, then clamp
 * to MAX_NODE_RADIUS. FIX-D — linear is DOMAIN-AWARE: it spreads [0,domainMax]
 * across [base, MAX_NODE_RADIUS] so sizes are DIFFERENTIATED instead of every
 * node past ~$56k pinning at the cap (the old `base + v` put a $100k donor at
 * base+100 → clamped, so a whale and a mid donor looked identical). domainMax=0
 * collapses to base.
 */
export function scaledRadius(base: number, v: number, sizeScale: SizeScale | undefined, domainMax = 0): number {
  const safeV = Math.max(0, v)
  let r: number
  switch (sizeScale) {
    case 'log':
      r = base + Math.log10(safeV + 1) * 8
      break
    case 'linear':
      r = domainMax > 0 ? base + (safeV / domainMax) * (MAX_NODE_RADIUS - base) : base
      break
    case 'sqrt':
    default:
      r = base + Math.sqrt(safeV) * 2 // historical default
      break
  }
  return Math.min(r, MAX_NODE_RADIUS)
}
