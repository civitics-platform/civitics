/**
 * packages/graph/src/nodeSize.test.ts — FIX-D (Graph Polish P5)
 *
 * Guards the domain-aware linear node-size scale (decision 7). The graph package
 * has no CI test runner (CI runs only @civitics/data), so — like nodeId.test.ts —
 * this uses a throw-based eq()/ok() and runs at module load. Execute with:
 *   pnpm --filter @civitics/data exec tsx packages/graph/src/nodeSize.test.ts
 *
 * The regression it pins: the OLD linear branch (`base + v`, v in $/1000) put
 * every donor past ~$56k at the 72px cap, so a $100k donor and a $100M whale
 * rendered identically. The new branch spreads [0,domainMax] over
 * [base, MAX_NODE_RADIUS], so different magnitudes get different radii.
 */

import { scaledRadius, nodeSizeMagnitude, sizeDomainMax, MAX_NODE_RADIUS } from './nodeSize';
import type { GraphNode } from './types';

let passed = 0;
function eq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`nodeSize.test FAIL — ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
  passed++;
}
function ok(actual: boolean, label: string): void {
  eq(actual, true, label);
}
function approx(actual: number, expected: number, label: string): void {
  ok(Math.abs(actual - expected) < 1e-6, `${label} (≈${expected}, got ${actual})`);
}

const BASE = 16;
const n = (over: Partial<GraphNode>): GraphNode =>
  ({ id: 'financial:x', name: 'x', type: 'financial', ...over });

// ── nodeSizeMagnitude: units ────────────────────────────────────────────────
// donation_total: cents → $/1000. $100k = 10_000_000 cents → 100.
approx(nodeSizeMagnitude(n({ donationTotal: 10_000_000 }), 'donation_total'), 100, 'donation magnitude ($100k)');
// contract_total: dollars → $/1000. $2.5M → 2500.
approx(nodeSizeMagnitude(n({ contractTotal: 2_500_000 }), 'contract_total'), 2500, 'contract magnitude ($2.5M)');
// connection_count: raw degree.
approx(nodeSizeMagnitude(n({ connectionCount: 7 }), 'connection_count'), 7, 'connection magnitude');
// missing field → 0.
approx(nodeSizeMagnitude(n({}), 'donation_total'), 0, 'missing donationTotal → 0');
approx(nodeSizeMagnitude(n({}), 'contract_total'), 0, 'missing contractTotal → 0');

// ── sizeDomainMax ───────────────────────────────────────────────────────────
const nodes: GraphNode[] = [
  n({ id: 'a', donationTotal: 10_000_000 }),      // $100k → 100
  n({ id: 'b', donationTotal: 10_000_000_000 }),  // $100M → 100_000
  n({ id: 'c', donationTotal: 500_000 }),         // $5k → 5
];
approx(sizeDomainMax(nodes, 'donation_total'), 100_000, 'sizeDomainMax picks the whale');
approx(sizeDomainMax([], 'donation_total'), 0, 'empty domain → 0');

// ── linear branch: DOMAIN-AWARE (the core regression) ───────────────────────
const domainMax = 100_000; // $100M whale
const rWhale = scaledRadius(BASE, 100_000, 'linear', domainMax);   // v == domainMax
const rMid   = scaledRadius(BASE, 100,     'linear', domainMax);   // $100k
const rSmall = scaledRadius(BASE, 5,       'linear', domainMax);   // $5k

// Max magnitude maps exactly to the cap.
approx(rWhale, MAX_NODE_RADIUS, 'linear: domain max → MAX_NODE_RADIUS');
// The old `base + v` clamped BOTH $100k (base+100) and $100M (base+100000) to 72
// → identical. The new scale must differentiate them.
ok(rMid < rWhale, 'linear: $100k radius < $100M radius (was equal under old cap bug)');
ok(rSmall < rMid, 'linear: $5k radius < $100k radius');
// Mid sits strictly between base and cap.
ok(rMid > BASE && rMid < MAX_NODE_RADIUS, 'linear: mid radius is between base and cap');
// Exact interpolation for the mid point: base + (100/100000)*(72-16).
approx(rMid, BASE + (100 / domainMax) * (MAX_NODE_RADIUS - BASE), 'linear: exact interpolation');
// domainMax=0 collapses to base (no data / non-money zero domain).
approx(scaledRadius(BASE, 42, 'linear', 0), BASE, 'linear: domainMax=0 → base');

// ── log / sqrt: independent of domainMax, always clamped ────────────────────
approx(scaledRadius(BASE, 999, 'log', 0), scaledRadius(BASE, 999, 'log', 12345), 'log: ignores domainMax');
approx(scaledRadius(BASE, 999, 'sqrt', 0), scaledRadius(BASE, 999, 'sqrt', 12345), 'sqrt: ignores domainMax');
ok(scaledRadius(BASE, 1e12, 'sqrt', 0) === MAX_NODE_RADIUS, 'sqrt: huge magnitude clamps at cap');
ok(scaledRadius(BASE, 1e12, 'log', 0) <= MAX_NODE_RADIUS, 'log: never exceeds cap');

console.log(`nodeSize.test — all ${passed} checks passed`);
