/**
 * FIX-742 — parseUsdCents must skip oversized / scientific-notation comp values
 * (e.g. "8.49e+22") instead of letting them overflow the total_compensation_cents
 * BIGINT column and fail the whole edgar_executive_officers upsert chunk.
 *
 * Runs via:  tsx --test src/pipelines/edgar/util.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUsdCents } from "./util";

test("parseUsdCents: normal dollar values parse to cents", () => {
  assert.equal(parseUsdCents("$1,234,567"), 123456700);
  assert.equal(parseUsdCents("1234567"), 123456700);
  assert.equal(parseUsdCents("1,234.56"), 123456);
});

test("parseUsdCents: oversized scientific-notation value is dropped, not returned (FIX-742)", () => {
  // The exact value that blew the bigint cast and dropped whole officer chunks
  // + 339 filings on 2026-07-05.
  assert.equal(parseUsdCents("8.49e+22"), null);
  // A raw huge integer string that overflows safe-integer range after *100.
  assert.equal(parseUsdCents("999999999999999999999"), null);
});

test("parseUsdCents: a bad value does not poison a good value in the same batch (FIX-742)", () => {
  // Mirrors the chunk semantics: the oversized cell is skipped (→ null, its
  // officer row is dropped upstream) while the normal cell still parses, so the
  // chunk is NOT failed.
  const parsed = ["8.49e+22", "$5,000,000"].map(parseUsdCents);
  assert.deepEqual(parsed, [null, 500000000]);
});

test("parseUsdCents: null / empty / non-numeric → null", () => {
  assert.equal(parseUsdCents(null), null);
  assert.equal(parseUsdCents(undefined), null);
  assert.equal(parseUsdCents(""), null);
  assert.equal(parseUsdCents("abc"), null);
});
