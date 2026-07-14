/**
 * packages/graph/src/csv.ts — FIX-829
 *
 * Client-side CSV serializer for the /graph "Export ▾" action. One combined
 * file with a leading `record_type` column (node | edge) so a single file
 * filters cleanly in Excel / Sheets — node rows fill the node columns and
 * leave the edge columns empty, edge rows vice-versa.
 *
 * RFC-4180 quoting (CRLF rows, doubled inner quotes, fields with
 * comma/quote/newline wrapped), UTF-8 BOM prefix so Excel reads it as UTF-8.
 * Pure + dependency-free (types only) — see csv.test.ts for the quoting cases.
 */

import type { GraphNode, GraphEdge } from './types';

// Column order is a stable contract — downstream sheets/scripts key on it.
const NODE_COLS = [
  'id', 'label', 'entity_type', 'party', 'state', 'industry',
  'donation_total_usd', 'connection_count',
] as const;

const EDGE_COLS = [
  'from_id', 'from_label', 'to_id', 'to_label', 'edge_type',
  'amount_usd', 'tx_count', 'occurred_at',
] as const;

const HEADER = ['record_type', ...NODE_COLS, ...EDGE_COLS];

const BOM = '﻿';

/** RFC-4180 field escape: quote when the value carries a comma, quote, CR, or LF. */
export function csvField(value: unknown): string {
  if (value == null) return '';
  const s = String(value);
  if (s === '') return '';
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function csvRow(cells: unknown[]): string {
  return cells.map(csvField).join(',');
}

/** Node.donationTotal is in CENTS (matches NodePopup) → whole USD, or '' when absent. */
function donationUsd(n: GraphNode): string {
  return n.donationTotal != null ? String(Math.round(n.donationTotal / 100)) : '';
}

function nodeIndustry(n: GraphNode): string {
  return n.industryLabel ?? n.industryTag ?? '';
}

/**
 * Serialize a node+edge set to a single combined CSV string (with BOM).
 * Empty cells where a record type has no value for a column.
 */
export function graphToCsv(nodes: GraphNode[], edges: GraphEdge[]): string {
  const nameById = new Map(nodes.map((n) => [n.id, n.name] as const));

  const lines: string[] = [csvRow(HEADER)];

  for (const n of nodes) {
    lines.push(
      csvRow([
        'node',
        n.id,
        n.name ?? '',
        n.type ?? '',
        n.party ?? '',
        n.state ?? '',
        nodeIndustry(n),
        donationUsd(n),
        n.connectionCount ?? '',
        // edge columns — empty for node rows
        '', '', '', '', '', '', '', '',
      ]),
    );
  }

  for (const e of edges) {
    lines.push(
      csvRow([
        'edge',
        // node columns — empty for edge rows
        '', '', '', '', '', '', '', '',
        e.fromId,
        nameById.get(e.fromId) ?? '',
        e.toId,
        nameById.get(e.toId) ?? '',
        e.connectionType ?? '',
        e.amountUsd ?? '',
        e.txCount ?? '',
        e.occurredAt ?? '',
      ]),
    );
  }

  return BOM + lines.join('\r\n');
}

/** `civitics-graph-YYYYMMDD.csv` from a Date (caller passes it — no Date.now() in render). */
export function graphCsvFilename(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `civitics-graph-${y}${m}${d}.csv`;
}

/**
 * Client-side blob download — mirrors the PNG export's anchor pattern
 * (ScreenshotPanel). Guarded for SSR; a no-op without `document`.
 */
export function downloadCsv(filename: string, csv: string): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
