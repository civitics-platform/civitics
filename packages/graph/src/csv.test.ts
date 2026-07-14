/**
 * packages/graph/src/csv.test.ts — FIX-829
 *
 * Spec for the CSV serializer's RFC-4180 quoting + combined node/edge shape.
 *
 * The graph package has NO CI test runner (CI runs only the @civitics/data
 * suite) and no @types/node, so this deliberately avoids node:test/node:assert:
 * it uses a local throw-based `eq()` and runs its checks at module load. Execute
 * it with the data package's tsx during verification —
 *   pnpm --filter @civitics/data exec tsx packages/graph/src/csv.test.ts
 * It also documents the contract and guards regressions if a graph runner lands.
 */

import { csvField, graphToCsv, graphCsvFilename } from './csv';
import type { GraphNode, GraphEdge } from './types';

let passed = 0;
function eq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`csv.test FAIL — ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
  passed++;
}

// csvField — RFC-4180 quoting
eq(csvField('plain'), 'plain', 'plain passes through');
eq(csvField('a,b'), '"a,b"', 'comma → quoted');
eq(csvField('say "hi"'), '"say ""hi"""', 'quote → wrapped + doubled');
eq(csvField('line1\nline2'), '"line1\nline2"', 'newline → quoted');
eq(csvField('carriage\rreturn'), '"carriage\rreturn"', 'CR → quoted');
eq(csvField(null), '', 'null → empty');
eq(csvField(undefined), '', 'undefined → empty');
eq(csvField(0), '0', '0 is a value, not empty');

// graphToCsv — combined node/edge shape
const nodes: GraphNode[] = [
  { id: 'official:1', name: 'Jane Doe, Jr.', type: 'official', party: 'democrat', state: 'CA', connectionCount: 5, donationTotal: 123456 },
  { id: 'fin:2', name: 'Acme "Holdings", LLC', type: 'financial', industryLabel: 'Finance & Banking' },
];
const edges: GraphEdge[] = [
  { fromId: 'fin:2', toId: 'official:1', connectionType: 'donation', strength: 0.8, amountUsd: 4700000, txCount: 1234 },
];
const csv = graphToCsv(nodes, edges);
eq(csv.charCodeAt(0), 0xfeff, 'starts with UTF-8 BOM');

const rows = csv.slice(1).split('\r\n');
eq(rows[0], 'record_type,id,label,entity_type,party,state,industry,donation_total_usd,connection_count,from_id,from_label,to_id,to_label,edge_type,amount_usd,tx_count,occurred_at', 'header row');
eq(rows[1], 'node,official:1,"Jane Doe, Jr.",official,democrat,CA,,1235,5,,,,,,,,', 'node row: comma label quoted, cents→USD, edge cols empty');
eq(rows[2], 'node,fin:2,"Acme ""Holdings"", LLC",financial,,,Finance & Banking,,,,,,,,,,', 'node row: quotes+comma escaped');
eq(rows[3], 'edge,,,,,,,,,fin:2,"Acme ""Holdings"", LLC",official:1,"Jane Doe, Jr.",donation,4700000,1234,', 'edge row: node cols empty, amount passthrough, blank occurred_at');

// graphCsvFilename — zero-padded YYYYMMDD (month is 0-based)
eq(graphCsvFilename(new Date(2026, 6, 3)), 'civitics-graph-20260703.csv', 'July 3 filename');
eq(graphCsvFilename(new Date(2026, 11, 25)), 'civitics-graph-20261225.csv', 'Dec 25 filename');

// eslint-disable-next-line no-console
console.log(`csv.test — ${passed} assertions passed`);
