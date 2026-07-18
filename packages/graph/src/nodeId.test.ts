/**
 * packages/graph/src/nodeId.test.ts — FIX-849 (Graph Polish P2)
 *
 * Contract test pinning the canonical `type:{uuid}` node-id scheme. The graph
 * package has NO CI test runner (CI runs only the @civitics/data suite) and no
 * @types/node, so — like csv.test.ts — this uses a local throw-based `eq()` and
 * runs its checks at module load. Execute with the data package's tsx:
 *   pnpm --filter @civitics/data exec tsx packages/graph/src/nodeId.test.ts
 *
 * It guards the drift that let the same real-world entity render as 2–3 nodes
 * depending on the path it was reached by: connections route (`official:{uuid}`),
 * group route (was `donor-{uuid}` + raw uuids), focus (raw uuid). It asserts:
 *   - helper round-trips (make → extract → match)
 *   - entity-route + group-route id fixtures canonicalize per the helper
 *   - aggregate ids (bracket/tail/employer/group/user) never match a focus
 *   - graphGroupParams forwards `limit` (FIX-842) and the filter set
 */

import { makeNodeId, extractUuid, matchesFocus, isFocusNode, NODE_ID_TYPES } from './nodeId';
import { graphGroupParams } from './groupQuery';
import type { FocusGroup } from './types';

let passed = 0;
function eq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`nodeId.test FAIL — ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
  passed++;
}
function ok(actual: boolean, label: string): void {
  eq(actual, true, label);
}

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

// ── Helper round-trips: make → extract → match ──────────────────────────────
for (const type of NODE_ID_TYPES) {
  const id = makeNodeId(type, UUID_A);
  eq(id, `${type}:${UUID_A}`, `makeNodeId(${type})`);
  eq(extractUuid(id), UUID_A, `extractUuid(${type}:uuid)`);
  ok(matchesFocus(id, UUID_A), `matchesFocus(${type}:uuid, uuid)`);
  ok(!matchesFocus(id, UUID_B), `matchesFocus(${type}:uuid, otherUuid) is false`);
}

// A bare uuid (a FocusEntity id) extracts to itself and matches itself.
eq(extractUuid(UUID_A), UUID_A, 'extractUuid(bareUuid)');
ok(matchesFocus(UUID_A, UUID_A), 'matchesFocus(bareUuid, uuid)');

// ── Canonical id-scheme regex — the shapes each route emits ─────────────────
const CANONICAL_RE = /^(official|agency|proposal|financial_entity|governing_body|initiative):[0-9a-f-]{36}$/i;
// Entity route (connections) + migrated group route entity nodes:
const entityIds = [
  makeNodeId('official', UUID_A),           // connections + group official member
  makeNodeId('financial_entity', UUID_A),   // connections donor + migrated group donor
  makeNodeId('agency', UUID_A),             // group awarder
  makeNodeId('governing_body', UUID_A),     // group overseer
  makeNodeId('proposal', UUID_A),
];
for (const id of entityIds) {
  ok(CANONICAL_RE.test(id), `canonical entity id: ${id}`);
  eq(extractUuid(id), UUID_A, `entity id resolves to focus uuid: ${id}`);
}

// ── Aggregate / synthetic ids never resolve to a focus entity ───────────────
const aggregateIds = [
  `bracket:${UUID_A}:small`,          // per-official bracket (embeds a uuid!)
  `tail:donation:${UUID_A}`,          // unnamed-remainder tail
  `employer:${UUID_A}:GOLDMAN`,       // employer bucket
  'group-gb-abc',                     // gb group node
  'group-selection-x1y2',             // client selection group
  'user:me',                          // USER node
];
for (const id of aggregateIds) {
  eq(extractUuid(id), null, `aggregate id does not extract a uuid: ${id}`);
  ok(!matchesFocus(id, UUID_A), `aggregate id never matches a focus: ${id}`);
}

// isFocusNode set membership (the hot-loop form).
const focusSet = new Set([UUID_A]);
ok(isFocusNode(makeNodeId('official', UUID_A), focusSet), 'isFocusNode(official:uuid, {uuid})');
ok(isFocusNode(UUID_A, focusSet), 'isFocusNode(bareUuid, {uuid})');
ok(!isFocusNode(makeNodeId('official', UUID_B), focusSet), 'isFocusNode(official:otherUuid) is false');
ok(!isFocusNode(`bracket:${UUID_A}:small`, focusSet), 'isFocusNode(bracket:uuid:tier) is false');

// ── graphGroupParams forwards limit (FIX-842) + the filter set ──────────────
const group: FocusGroup = {
  id: 'group-gb-abc',
  name: 'Full Senate',
  type: 'group',
  icon: '🏛',
  color: 'rgb(var(--c-viz-5))',
  filter: { entity_type: 'official', chamber: 'senate', party: 'democrat' },
  isPremade: false,
};
const gp = graphGroupParams(group, 25);
eq(gp.get('limit'), '25', 'graphGroupParams forwards limit');
eq(gp.get('groupId'), 'group-gb-abc', 'graphGroupParams groupId');
eq(gp.get('entity_type'), 'official', 'graphGroupParams entity_type');
eq(gp.get('chamber'), 'senate', 'graphGroupParams chamber');
eq(gp.get('party'), 'democrat', 'graphGroupParams party');
eq(gp.get('state'), null, 'graphGroupParams omits unset filters');
eq(graphGroupParams(group, 100).get('limit'), '100', 'graphGroupParams forwards a different limit');

// eslint-disable-next-line no-console
console.log(`nodeId.test — all ${passed} checks passed ✓`);
