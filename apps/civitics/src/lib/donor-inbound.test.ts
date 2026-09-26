/**
 * FIX-1217 / FIX-1225 — the donor page's inbound fold over rollup rows, and the
 * fallbacks when a recipient has no totals row.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  foldInboundRollup,
  inboundStats,
  totalReceivedCents,
  type InboundRollupRow,
  type InboundTotals,
} from "./donor-inbound";

const rows: InboundRollupRow[] = [
  { from_id: "b", total_cents: 500, tx_count: 2, rank: 2 },
  { from_id: "a", total_cents: 900, tx_count: 1, rank: 1 },
  { from_id: "c", total_cents: 500, tx_count: 7, rank: 3 },
];
const info = new Map([
  ["a", { display_name: "ACME PAC", entity_type: "pac" }],
  ["b", { display_name: "DOE, JANE", entity_type: "individual" }],
]);

test("the fold keeps the rollup's rank order and its per-donor totals — nothing is re-summed", () => {
  const out = foldInboundRollup(rows, info, (id) => (id === "a" ? "Finance" : null));
  assert.deepEqual(out.map((d) => d.id), ["a", "b", "c"], "rank 1, 2, 3 whatever order PostgREST returned");
  assert.deepEqual(out[0], { id: "a", name: "ACME PAC", industry: "Finance", donor_type: "pac", total_cents: 900, count: 1 });
  assert.equal(out[1]!.count, 2, "tx_count is the donor's whole count, not rows seen");
  assert.deepEqual(
    { name: out[2]!.name, donor_type: out[2]!.donor_type, industry: out[2]!.industry },
    { name: "Unknown", donor_type: "other", industry: null },
    "a donor whose entity lookup missed still renders",
  );
});

test("the fold of no rows is empty; it never mutates its input", () => {
  assert.deepEqual(foldInboundRollup([], info, () => null), []);
  const copy = rows.map((r) => ({ ...r }));
  foldInboundRollup(rows, info, () => null);
  assert.deepEqual(rows, copy);
});

test("stats come from the totals row — the RNC reads its true donor count, not a sample's", () => {
  const rnc: InboundTotals = { donor_count: 283_715, tx_total: 337_058, sum_total: 21_031_139_400, refreshed_at: "2026-09-26T03:00:00Z" };
  assert.deepEqual(inboundStats(rnc), { uniqueDonors: 283_715, donorTxCount: 337_058 });
});

test("no totals row: 0 donors, and Total received falls back to the FE column", () => {
  assert.deepEqual(inboundStats(null), { uniqueDonors: 0, donorTxCount: 0 });
  assert.equal(totalReceivedCents(null, 12_345), 12_345);
  assert.equal(totalReceivedCents(null, null), 0);
  assert.equal(totalReceivedCents(null, undefined), 0);
});

test("a totals row wins over the FE column, including over a zeroed one (FIX-1226)", () => {
  const t: InboundTotals = { donor_count: 3, tx_total: 4, sum_total: 21_031_139_400, refreshed_at: "x" };
  assert.equal(totalReceivedCents(t, 0), 21_031_139_400, "the RNC's column read 0 on prod");
  assert.equal(totalReceivedCents({ ...t, sum_total: 0 }, 99), 0, "a zero summary is the truth for a recipient whose donations are gone");
});
