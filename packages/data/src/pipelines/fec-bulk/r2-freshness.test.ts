/**
 * FIX-1014 — R2 cache freshness compares FEC-reported-then vs FEC-reported-now.
 *
 * Runs via:  tsx --test src/pipelines/fec-bulk/r2-freshness.test.ts
 *
 * The bug these lock down: freshness used to be
 * `r2Object.LastModified >= fec.LastModified`, which compares WHEN WE FINISHED
 * UPLOADING against WHEN FEC PUBLISHED. A republish landing between our HEAD
 * and our upload stamps superseded bytes with the newer timestamp, and every
 * later run reads that as fresh.
 *
 * Pure functions only — no network, no R2, no clock.
 *
 * Values below are real. The Aug-2 vs Aug-9 pair is the near-miss measured in
 * the FIX-1014 bullet; the Aug-11 R2 object figures are a live HEAD taken while
 * writing this fix (and differ from the bullet's — the cached indiv26 was
 * re-uploaded 2026-08-09T22:31:53Z in the interim).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateR2Freshness,
  buildFecCacheMetadata,
  readStoredFecProvenance,
  formatR2FreshnessDecision,
  FEC_META_LAST_MODIFIED,
  FEC_META_CONTENT_LENGTH,
  FEC_META_ETAG,
  type FecHead,
} from "./util";

// FEC's live HEAD of indiv26.zip, measured 2026-08-11.
const FEC_AUG_09: FecHead = {
  lastModified:  "Sun, 09 Aug 2026 16:03:26 GMT",
  contentLength: 2_061_619_898,
  etag:          '"9167f97b6dfbd1c58e4f4f50997b8c2f-246"',
};

// The prior publish — what the fec-backfill run HEADed at 15:57:17Z on 08-09.
const FEC_AUG_02: FecHead = {
  lastModified:  "Sun, 02 Aug 2026 15:45:35 GMT",
  contentLength: 1_995_728_131,
  etag:          '"44e6967bdbad3e73b09964f1e7677b28-238"',
};

/** An R2 HEAD whose metadata carries the provenance FEC reported at upload. */
function cachedFrom(head: FecHead, override: Record<string, string> = {}) {
  return {
    metadata: {
      ...(buildFecCacheMetadata(head) ?? {}),
      ...override,
    },
    // The object's OWN identity — present precisely so the tests can prove it
    // is never consulted. Our multipart chunking gives `-123` parts for the
    // same bytes FEC serves as `-246`.
    lastModified: new Date("2026-08-09T22:31:53.000Z"),
    contentLength: 2_061_619_898,
    etag: '"cf78e97b9cc43e64879ab462aeb31253-123"',
  };
}

// ---------------------------------------------------------------------------
// The core contract
// ---------------------------------------------------------------------------

test("stored metadata present and every field matches → fresh", () => {
  const d = evaluateR2Freshness(cachedFrom(FEC_AUG_09), FEC_AUG_09);
  assert.equal(d.fresh, true);
  assert.equal(d.reason, "match");
  assert.equal(d.stored.lastModified, FEC_AUG_09.lastModified);
  assert.equal(d.live.lastModified, FEC_AUG_09.lastModified);
});

test("THE BUG: cached Aug-2 bytes vs republished Aug-9 file → stale", () => {
  // Under the old rule this was FRESH, because the R2 object's own
  // LastModified (our 22:31 upload) is later than FEC's 16:03 publish.
  const d = evaluateR2Freshness(cachedFrom(FEC_AUG_02), FEC_AUG_09);
  assert.equal(d.fresh, false);
  assert.equal(d.reason, "last-modified-mismatch");
});

test("Last-Modified mismatch → stale", () => {
  const d = evaluateR2Freshness(
    cachedFrom(FEC_AUG_09, { [FEC_META_LAST_MODIFIED]: "Sun, 02 Aug 2026 15:45:35 GMT" }),
    FEC_AUG_09,
  );
  assert.equal(d.fresh, false);
  assert.equal(d.reason, "last-modified-mismatch");
});

test("Content-Length mismatch alone → stale (the 3.3% the near-miss would have shown)", () => {
  const d = evaluateR2Freshness(
    cachedFrom(FEC_AUG_09, { [FEC_META_CONTENT_LENGTH]: String(FEC_AUG_02.contentLength) }),
    FEC_AUG_09,
  );
  assert.equal(d.fresh, false);
  assert.equal(d.reason, "content-length-mismatch");
});

test("ETag mismatch alone → stale", () => {
  const d = evaluateR2Freshness(
    cachedFrom(FEC_AUG_09, { [FEC_META_ETAG]: FEC_AUG_02.etag as string }),
    FEC_AUG_09,
  );
  assert.equal(d.fresh, false);
  assert.equal(d.reason, "etag-mismatch");
});

test("no fec-* metadata (every object cached before FIX-1014) → stale by design", () => {
  // Measured 2026-08-11: all six cycle-2026 objects return `meta={}`.
  const d = evaluateR2Freshness({ metadata: {} }, FEC_AUG_09);
  assert.equal(d.fresh, false);
  assert.equal(d.reason, "no-stored-metadata");

  assert.equal(evaluateR2Freshness({ metadata: null }, FEC_AUG_09).reason, "no-stored-metadata");
  assert.equal(evaluateR2Freshness({}, FEC_AUG_09).reason, "no-stored-metadata");
});

// ---------------------------------------------------------------------------
// The object's own identity is never an input
// ---------------------------------------------------------------------------

test("the R2 object's own ETag and LastModified are never consulted", () => {
  // (a) Object timestamp far NEWER than FEC's publish and object ETag byte-equal
  //     to FEC's — the exact shape that made the old rule return fresh — but the
  //     stamped provenance is last week's. Must be stale.
  const trap = {
    metadata: buildFecCacheMetadata(FEC_AUG_02) ?? {},
    lastModified: new Date("2099-01-01T00:00:00.000Z"),
    contentLength: FEC_AUG_09.contentLength,
    etag: FEC_AUG_09.etag,
  };
  assert.equal(evaluateR2Freshness(trap, FEC_AUG_09).fresh, false);

  // (b) Object timestamp OLDER than FEC's publish and object ETag wildly
  //     different (different multipart chunking), but the stamped provenance
  //     matches. Must be fresh.
  const good = {
    metadata: buildFecCacheMetadata(FEC_AUG_09) ?? {},
    lastModified: new Date("1999-01-01T00:00:00.000Z"),
    contentLength: 1,
    etag: '"totally-different-123"',
  };
  assert.equal(evaluateR2Freshness(good, FEC_AUG_09).fresh, true);

  // (c) And the decision is byte-identical whether or not those fields exist.
  const stripped = { metadata: buildFecCacheMetadata(FEC_AUG_09) ?? {} };
  assert.deepEqual(
    evaluateR2Freshness(stripped, FEC_AUG_09),
    evaluateR2Freshness(good, FEC_AUG_09),
  );
});

// ---------------------------------------------------------------------------
// Unknowable → stale
// ---------------------------------------------------------------------------

test("no cache object at all → stale", () => {
  assert.equal(evaluateR2Freshness(null, FEC_AUG_09).reason, "no-cache-object");
  assert.equal(evaluateR2Freshness(undefined, FEC_AUG_09).reason, "no-cache-object");
});

test("FEC HEAD failed → stale, never serve the cache on an unverifiable comparison", () => {
  const d = evaluateR2Freshness(cachedFrom(FEC_AUG_09), null);
  assert.equal(d.fresh, false);
  assert.equal(d.reason, "no-live-last-modified");

  const noLm: FecHead = { lastModified: null, contentLength: 2_061_619_898, etag: null };
  assert.equal(evaluateR2Freshness(cachedFrom(FEC_AUG_09), noLm).reason, "no-live-last-modified");
});

test("metadata present but Last-Modified missing from it → stale", () => {
  const d = evaluateR2Freshness(
    { metadata: { [FEC_META_CONTENT_LENGTH]: "2061619898" } },
    FEC_AUG_09,
  );
  assert.equal(d.fresh, false);
  assert.equal(d.reason, "no-stored-last-modified");
});

test("one-sided presence of length/etag is a mismatch, not an abstention", () => {
  const liveNoEtag: FecHead = { ...FEC_AUG_09, etag: null };
  assert.equal(evaluateR2Freshness(cachedFrom(FEC_AUG_09), liveNoEtag).reason, "etag-mismatch");

  const liveNoLen: FecHead = { ...FEC_AUG_09, contentLength: null };
  assert.equal(
    evaluateR2Freshness(cachedFrom(FEC_AUG_09), liveNoLen).reason,
    "content-length-mismatch",
  );
});

test("both sides absent for a field is equal, not a mismatch", () => {
  const bare: FecHead = { lastModified: FEC_AUG_09.lastModified, contentLength: null, etag: null };
  const d = evaluateR2Freshness(cachedFrom(bare), bare);
  assert.equal(d.fresh, true);
  assert.equal(d.reason, "match");
});

// ---------------------------------------------------------------------------
// Format tolerance — a header format change must not read as a republish
// ---------------------------------------------------------------------------

test("equivalent HTTP date spellings compare equal (same rule as FIX-754)", () => {
  const utcSpelling: FecHead = { ...FEC_AUG_09, lastModified: "Sun, 09 Aug 2026 16:03:26 UTC" };
  assert.equal(evaluateR2Freshness(cachedFrom(FEC_AUG_09), utcSpelling).fresh, true);
});

test("unparseable-but-identical date strings still compare equal", () => {
  const weird: FecHead = { ...FEC_AUG_09, lastModified: "not-a-date" };
  assert.equal(evaluateR2Freshness(cachedFrom(weird), weird).fresh, true);
});

test("Content-Length compares numerically, not as text", () => {
  const d = evaluateR2Freshness(
    cachedFrom(FEC_AUG_09, { [FEC_META_CONTENT_LENGTH]: " 2061619898 " }),
    FEC_AUG_09,
  );
  assert.equal(d.fresh, true);
});

// ---------------------------------------------------------------------------
// buildFecCacheMetadata — what gets stamped, and when nothing does
// ---------------------------------------------------------------------------

test("metadata is stamped under the x-amz-meta-fec-* key names", () => {
  const meta = buildFecCacheMetadata(FEC_AUG_09, FEC_AUG_09.contentLength);
  assert.deepEqual(meta, {
    "fec-last-modified":  "Sun, 09 Aug 2026 16:03:26 GMT",
    "fec-content-length": "2061619898",
    "fec-etag":           '"9167f97b6dfbd1c58e4f4f50997b8c2f-246"',
  });
});

test("round-trip: stamp from a head, read it back, compare against the same head → fresh", () => {
  const stored = readStoredFecProvenance(buildFecCacheMetadata(FEC_AUG_09));
  assert.equal(stored.lastModified, FEC_AUG_09.lastModified);
  assert.equal(stored.contentLength, String(FEC_AUG_09.contentLength));
  assert.equal(stored.etag, FEC_AUG_09.etag);
  assert.equal(evaluateR2Freshness({ metadata: buildFecCacheMetadata(FEC_AUG_09) }, FEC_AUG_09).fresh, true);
});

test("no live Last-Modified → nothing to stamp, so do not cache", () => {
  assert.equal(buildFecCacheMetadata(null), null);
  assert.equal(buildFecCacheMetadata({ lastModified: null, contentLength: 1, etag: '"x"' }), null);
});

test("on-disk size disagreeing with FEC's advertised length → do not cache", () => {
  assert.equal(buildFecCacheMetadata(FEC_AUG_09, FEC_AUG_02.contentLength), null);
  // Unknown on-disk size doesn't block the stamp — only a KNOWN disagreement does.
  assert.notEqual(buildFecCacheMetadata(FEC_AUG_09, null), null);
  assert.notEqual(buildFecCacheMetadata(FEC_AUG_09, FEC_AUG_09.contentLength), null);
});

test("a head with no advertised length stamps only what it knows", () => {
  const partial: FecHead = { lastModified: FEC_AUG_09.lastModified, contentLength: null, etag: null };
  assert.deepEqual(buildFecCacheMetadata(partial, 123), {
    "fec-last-modified": FEC_AUG_09.lastModified,
  });
});

// ---------------------------------------------------------------------------
// The audit line (FIX-1014 requires every decision to leave a signal)
// ---------------------------------------------------------------------------

test("the log line shows both sides and the deciding clause", () => {
  const line = formatR2FreshnessDecision(
    "fec/2026/indiv26.zip",
    evaluateR2Freshness(cachedFrom(FEC_AUG_02), FEC_AUG_09),
  );
  assert.match(line, /MISS/);
  assert.match(line, /fec\/2026\/indiv26\.zip/);
  assert.match(line, /\[last-modified-mismatch\]/);
  assert.match(line, /stored .*Sun, 02 Aug 2026 15:45:35 GMT/);
  assert.match(line, /live .*Sun, 09 Aug 2026 16:03:26 GMT/);
  assert.match(line, /1995728131/);
  assert.match(line, /2061619898/);

  const hit = formatR2FreshnessDecision("k", evaluateR2Freshness(cachedFrom(FEC_AUG_09), FEC_AUG_09));
  assert.match(hit, /HIT/);
  assert.match(hit, /\[match\]/);
});
