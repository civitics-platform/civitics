/**
 * packages/graph/src/tokens.test.ts — FIX-860
 *
 * Pins the tokens-layer color contract: the string handed to d3's color
 * interpolators MUST be parseable by d3-color. The choropleth black-map bug
 * (every valued district painted rgb(0,0,0)) was `resolveToken` emitting the
 * CSS space form `rgb(R G B)` — browser-valid, but `d3.color()` returns null
 * for it, so `interpolateRgb` collapsed to black. The fix emits the comma form
 * `rgb(R, G, B)`, valid CSS AND d3-parseable.
 *
 * Same runner convention as csv.test.ts — the graph package has no CI test
 * runner and no @types/node, so this is throw-based and runs at module load:
 *   pnpm --filter @civitics/data exec tsx packages/graph/src/tokens.test.ts
 */

import * as d3 from 'd3';
import { formatRgbTriplet, resolveToken } from './tokens';

let passed = 0;
function eq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`tokens.test FAIL — ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
  passed++;
}
function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`tokens.test FAIL — ${label}`);
  passed++;
}

// ── formatRgbTriplet — pure formatter ─────────────────────────────────────────
eq(formatRgbTriplet('43 74 139'), 'rgb(43, 74, 139)', 'space triplet → comma form');
eq(formatRgbTriplet('43, 74, 139'), 'rgb(43, 74, 139)', 'comma triplet tolerated (idempotent)');
eq(formatRgbTriplet('  43   74\t139 '), 'rgb(43, 74, 139)', 'messy whitespace collapses');
eq(formatRgbTriplet(''), 'rgb(0, 0, 0)', 'empty → fallback');

// ── The contract: output must be d3-parseable ─────────────────────────────────
const c = d3.color(formatRgbTriplet('43 74 139'));
assert(c !== null, 'd3.color(formatRgbTriplet(...)) is non-null');
const rgb = d3.rgb(formatRgbTriplet('43 74 139'));
assert(rgb.r === 43 && rgb.g === 74 && rgb.b === 139, 'channels round-trip through d3.rgb');

// ── Document the bug the fix cures: the OLD space form is null / black ─────────
// (guards against a regression that reintroduces `rgb(${triplet})`.)
assert(d3.color('rgb(43 74 139)') === null, 'space form rgb(R G B) is unparseable by d3-color (the bug)');
eq(d3.interpolateRgb('rgb(43 74 139)', 'rgb(157 43 43)')(0.1), 'rgb(0, 0, 0)', 'space-form interpolation collapses to black (the symptom)');

// ── Interpolation over the fixed comma form produces real, non-black color ────
const mid = d3.interpolateRgb(formatRgbTriplet('43 74 139'), formatRgbTriplet('157 43 43'))(0.1);
assert(mid !== 'rgb(0, 0, 0)', 'comma-form interpolation is NOT black');
const midRgb = d3.rgb(mid);
assert(midRgb.r > 0 && midRgb.b > 0, 'interpolated mid color has live channels');

// ── resolveToken SSR fallback is itself comma-form (d3-safe) ───────────────────
// No window in the tsx runner, so resolveToken returns FALLBACK — assert it too
// is the d3-parseable comma form, so even the degraded path never blackens.
eq(resolveToken('--c-blue'), 'rgb(0, 0, 0)', 'SSR/no-DOM resolveToken → comma-form fallback');
assert(d3.color(resolveToken('--c-blue')) !== null, 'fallback is d3-parseable');

// eslint-disable-next-line no-console
console.log(`tokens.test — ${passed} assertions passed`);
