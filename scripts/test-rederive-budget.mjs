#!/usr/bin/env node
// Tests for scripts/lib/rederive-budget.mjs (FIX-1235, cc-163). Dependency-free:
//   node scripts/test-rederive-budget.mjs
//
// The load-bearing case is the wrong-but-green one (rule 105): cc-160's
// single-rate guard, fed a write-heavy prefix, over-projected 3.3× and stopped
// a run that would have fit. The two-term guard must NOT, on the same shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkIds, fitTwoTerm, budgetCheck } from "./lib/rederive-budget.mjs";

const MS_PER_ID = 15;
const MS_PER_ROW = 0.05;
const wall = (ids, rows) => MS_PER_ID * ids + MS_PER_ROW * rows;

// A manifest shaped like cc-163's: many small committees, a row-heavy tail.
function syntheticChunks() {
  const out = [];
  for (let i = 0; i < 12; i++) out.push({ ids: 200, rows: 20 + i * 40 }); // write-heavy prefix
  for (let i = 0; i < 8; i++) out.push({ ids: 40 + i * 2, rows: 45_000 + i * 500 }); // row-heavy tail
  return out.map((c) => ({ ...c, ms: wall(c.ids, c.rows) }));
}

test("fitTwoTerm recovers both coefficients from exact samples", () => {
  const s = syntheticChunks();
  const { msPerId, msPerRow } = fitTwoTerm(s);
  assert.ok(Math.abs(msPerId - MS_PER_ID) < 1e-6, `msPerId ${msPerId}`);
  assert.ok(Math.abs(msPerRow - MS_PER_ROW) < 1e-9, `msPerRow ${msPerRow}`);
});

test("rule 105: a write-heavy prefix does NOT over-project the row-heavy tail", () => {
  const all = syntheticChunks();
  const actualTotal = all.reduce((a, c) => a + c.ms, 0) / 1000;
  for (let k = 3; k < 12; k++) {
    // Prefix samples with a little noise, as real walls have.
    const prefix = all.slice(0, k).map((c, i) => ({ ...c, ms: c.ms * (i % 2 ? 1.08 : 0.93) }));
    const elapsed = prefix.reduce((a, c) => a + c.ms, 0) / 1000;
    const rest = all.slice(k);
    const r = budgetCheck({
      elapsedSeconds: elapsed,
      budgetSeconds: 1e9,
      done: prefix,
      idsLeft: rest.reduce((a, c) => a + c.ids, 0),
      rowsLeft: rest.reduce((a, c) => a + c.rows, 0),
      chunksLeft: rest.length,
      minChunks: 3,
    });
    // The single cumulative rows/s rate cc-160 used, for contrast.
    const rowsDone = prefix.reduce((a, c) => a + c.rows, 0);
    const singleRate = elapsed + rest.reduce((a, c) => a + c.rows, 0) / (rowsDone / elapsed);
    assert.ok(singleRate > 3 * actualTotal, `the single-rate shape over-projects here (k=${k}: ${singleRate.toFixed(0)} vs ${actualTotal.toFixed(0)})`);
    // With the prefix's rows nearly constant the per-row term is weakly
    // identified; the guard may under-project the tail, but it must never
    // manufacture the over-projection that stops a run which would fit.
    assert.ok(r.projectedSeconds <= actualTotal * 1.2, `two-term k=${k}: ${r.projectedSeconds.toFixed(1)} s vs actual ${actualTotal.toFixed(1)} s`);
  }
});

test("once the tail is sampled, the two-term projection is within ±20 % of the actual", () => {
  const all = syntheticChunks();
  const actualTotal = all.reduce((a, c) => a + c.ms, 0) / 1000;
  for (let k = 13; k < all.length; k++) {
    const prefix = all.slice(0, k).map((c, i) => ({ ...c, ms: c.ms * (i % 2 ? 1.1 : 0.9) }));
    const elapsed = prefix.reduce((a, c) => a + c.ms, 0) / 1000;
    const rest = all.slice(k);
    const r = budgetCheck({
      elapsedSeconds: elapsed, budgetSeconds: 1e9, done: prefix,
      idsLeft: rest.reduce((a, c) => a + c.ids, 0), rowsLeft: rest.reduce((a, c) => a + c.rows, 0), chunksLeft: rest.length, minChunks: 3,
    });
    assert.ok(Math.abs(r.projectedSeconds - actualTotal) / actualTotal < 0.2, `k=${k}: ${r.projectedSeconds.toFixed(1)} vs ${actualTotal.toFixed(1)}`);
  }
});

test("a genuinely over-budget run still stops, with nothing in flight", () => {
  const all = syntheticChunks();
  const prefix = all.slice(0, 14);
  const elapsed = prefix.reduce((a, c) => a + c.ms, 0) / 1000;
  const rest = all.slice(14);
  const r = budgetCheck({
    elapsedSeconds: elapsed, budgetSeconds: elapsed + 1, done: prefix,
    idsLeft: rest.reduce((a, c) => a + c.ids, 0), rowsLeft: rest.reduce((a, c) => a + c.rows, 0), chunksLeft: rest.length, minChunks: 3,
  });
  assert.equal(r.stop, true);
  assert.match(r.reason, /passes the .* s budget/);
});

test("below minChunks only elapsed is checked; elapsed at the budget stops", () => {
  const two = syntheticChunks().slice(0, 2);
  const go = budgetCheck({ elapsedSeconds: 5, budgetSeconds: 6, done: two, idsLeft: 1e6, rowsLeft: 1e9, chunksLeft: 1e3, minChunks: 3 });
  assert.equal(go.stop, false);
  assert.equal(go.projectedSeconds, null);
  const stop = budgetCheck({ elapsedSeconds: 6, budgetSeconds: 6, done: two, idsLeft: 0, rowsLeft: 0, chunksLeft: 0, minChunks: 3 });
  assert.equal(stop.stop, true);
  assert.match(stop.reason, /reached the 6 s budget/);
});

test("neither term identified (a fixed per-statement cost): project per chunk, not per row — the cc-163 clone rehearsal", () => {
  // The clone's first four chunks, as measured (ids, FR rows, server wall ms).
  // The whole 22-chunk run took 0.7 s of chunk walls. Picking the single term
  // with the smaller residual projected 362,694 rows × 0.078 ms = 28.8 s here.
  const clone = [
    { ids: 200, rows: 309, ms: 40 },
    { ids: 200, rows: 542, ms: 20 },
    { ids: 200, rows: 860, ms: 30 },
    { ids: 200, rows: 1_288, ms: 130 },
  ];
  const f = fitTwoTerm(clone);
  assert.equal(f.msPerId, 0);
  assert.equal(f.msPerRow, 0);
  assert.equal(f.msPerChunk, 55);
  const r = budgetCheck({
    elapsedSeconds: 0.4, budgetSeconds: 300, done: clone, idsLeft: 3_124, rowsLeft: 362_694, chunksLeft: 18, minChunks: 3,
  });
  assert.ok(r.projectedSeconds < 2, `projected ${r.projectedSeconds}`);
  assert.equal(r.stop, false);
});

test("the second clone rehearsal: one spike on the row-heaviest of four chunks is not a per-row cost", () => {
  // t = 2.1 for the per-row term at 2 dof — above 2, below 4.303.
  const clone = [
    { ids: 200, rows: 309, ms: 40 },
    { ids: 200, rows: 542, ms: 30 },
    { ids: 200, rows: 860, ms: 30 },
    { ids: 200, rows: 1_288, ms: 300 },
  ];
  const f = fitTwoTerm(clone);
  assert.deepEqual(f, { msPerId: 0, msPerRow: 0, msPerChunk: 100 });
  const r = budgetCheck({
    elapsedSeconds: 0.6, budgetSeconds: 300, done: clone, idsLeft: 3_124, rowsLeft: 362_694, chunksLeft: 18, minChunks: 3,
  });
  assert.ok(Math.abs(r.projectedSeconds - 2.4) < 1e-9, `projected ${r.projectedSeconds}`);
});

test("fitTwoTerm never returns a negative coefficient", () => {
  // Noise that drives the unconstrained per-row term negative.
  const s = [{ ids: 200, rows: 100, ms: 3100 }, { ids: 200, rows: 900, ms: 2950 }, { ids: 180, rows: 400, ms: 2800 }];
  const f = fitTwoTerm(s);
  assert.ok(f.msPerId >= 0 && f.msPerRow >= 0, JSON.stringify(f));
  // Collinear samples: every chunk the same ratio.
  const c = fitTwoTerm([{ ids: 10, rows: 100, ms: 50 }, { ids: 20, rows: 200, ms: 100 }, { ids: 30, rows: 300, ms: 150 }]);
  assert.ok(c.msPerId >= 0 && c.msPerRow >= 0 && Number.isFinite(c.msPerId + c.msPerRow));
});

test("chunkIds: ascending by rows, 200-id and 50,000-row cuts, whales last", () => {
  const rows = [];
  for (let i = 0; i < 450; i++) rows.push({ id: `a${String(i).padStart(4, "0")}`, fr_rows: 3 });
  for (let i = 0; i < 60; i++) rows.push({ id: `b${String(i).padStart(4, "0")}`, fr_rows: 1_500 });
  rows.push({ id: "whale", fr_rows: 12_000 });
  const chunks = chunkIds(rows, { idsPerChunk: 200, rowsPerChunk: 50_000, whaleRows: 10_000 });
  const byId = new Map(rows.map((r) => [r.id, r.fr_rows]));
  // 450 small → 200, 200, then the last 50 small share a chunk with 33 large
  // (150 + 33 × 1,500 = 49,650 ≤ 50,000); the other 27 large; the whale alone.
  assert.deepEqual(chunks.map((c) => c.length), [200, 200, 83, 27, 1]);
  for (const c of chunks.slice(0, -1)) assert.ok(c.reduce((a, id) => a + byId.get(id), 0) <= 50_000);
  assert.deepEqual(chunks.at(-1), ["whale"]);
  assert.equal(new Set(chunks.flat()).size, rows.length);
});
