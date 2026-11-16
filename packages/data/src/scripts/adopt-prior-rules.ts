/**
 * FIX-1302 — the two rules `--adopt-prior` adds to merge-same-person-official-
 * dupes.ts, as pure functions. They live here, not in the script, because the
 * script runs main() on import; the tests call these directly.
 *
 *   D1  firstNameKeyGate — the FIX-929 three-letter first-name key, and the one
 *       thing that overrides it: under --adopt-prior, the congress-legislators
 *       dataset's `id.fec[]` listing for the survivor's bioguide names BOTH the
 *       survivor's live id and the pair's id (Craig, Q3, 2026-11-14). The FEC
 *       candidate file stores a legal first name, so the key refuses Bill Cassidy
 *       (BIL vs WIL), Jim Banks, Ted Budd and Tom Cotton; the dataset lists both of
 *       each one's ids under one bioguide, which is stronger evidence than three
 *       letters of a name.
 *
 *   D2  classifyCollision — what a shape-C merge does with a colliding
 *       (relationship_type, from_id, cycle_year) pair (Craig, Q4, 2026-11-15).
 *       FIX-933's "keep the fresher row, never sum" was written for ONE CAND_ID
 *       bound twice. An adopt-prior pair is two DIFFERENT CAND_IDs, and the
 *       weekly writer itself SUMS a donor who gave under both
 *       (fec-bulk/writer.ts, upsertDonationRelationshipsBatch and
 *       upsertIndependentExpendituresBatch: sum amounts, sum tx_count, keep the
 *       latest occurred_at). So:
 *
 *         stale         the survivor's row was last updated before the stub's
 *                       row was created — residue of an earlier binding. Today's
 *                       rule: the fresher row stays.
 *         ie_duplicate  not stale; an IE type; the two amounts are within
 *                       DUPLICATE_BAND_BP of the larger — one filing written
 *                       under two ids. Keep the fresher row, never sum.
 *         live          everything else. The writer's merge: the survivor's row
 *                       takes the sum and the stub's row is deleted.
 */

/** The relationship types the fec-bulk writer merges by summing. */
export const SUMMABLE_TYPES = ["donation", "ie_support", "ie_oppose"] as const;
export type SummableType = (typeof SUMMABLE_TYPES)[number];

/**
 * Per type, the band — basis points of the larger amount — inside which two LIVE
 * rows are one filing under two ids: kept once, never summed. `null` means never:
 * a live pair of that type is always summed.
 *
 * The two cells below are Cowork's reading of Craig's Q4, and cc-289's read 7
 * measured both for his confirmation before the prod apply. Each is one value:
 *
 *   donation  null — a live donation pair EQUAL TO THE CENT is summed, because the
 *             writer sums a donor who gave the same amount under both ids. Set it
 *             to 0 and an equal-to-the-cent pair is kept once instead.
 *   ie_*      200  — a live IE pair within 2 % is the same filing. Set it to 0
 *             and only an equal-to-the-cent IE pair is a duplicate.
 */
export const DUPLICATE_BAND_BP: Readonly<Record<SummableType, number | null>> = {
  donation: null,
  ie_support: 200,
  ie_oppose: 200,
};

export type CollisionClass = "stale" | "ie_duplicate" | "donation_duplicate" | "live";

/** Every class, in the order the run's table prints them. */
export const COLLISION_CLASSES: readonly CollisionClass[] = ["stale", "ie_duplicate", "donation_duplicate", "live"];

/**
 * One colliding pair. Timestamps are MICROSECONDS since the epoch: a
 * timestamptz carries microseconds and a JS Date keeps milliseconds, so two rows
 * written in the same millisecond would compare equal through a Date.
 */
export interface CollisionFacts {
  type: string;
  survCents: bigint | null;
  dupCents: bigint | null;
  survUpdatedUs: bigint;
  dupCreatedUs: bigint;
  dupUpdatedUs: bigint;
}

export interface CollisionVerdict {
  cls: CollisionClass;
  /**
   * `_collision.keep_dup`. stale and the duplicates: today's tie-break, the
   * stub's row stays when it is at least as fresh. live: false — the survivor's
   * row stays and takes the sum, and the stub's row is deleted.
   */
  keepDup: boolean;
}

const abs = (v: bigint): bigint => (v < 0n ? -v : v);

function isSummable(type: string): type is SummableType {
  return (SUMMABLE_TYPES as readonly string[]).includes(type);
}

/** True when the two amounts are within `bandBp` basis points of the larger. */
export function withinBand(a: bigint, b: bigint, bandBp: number): boolean {
  const larger = abs(a) > abs(b) ? abs(a) : abs(b);
  return abs(a - b) * 10000n <= BigInt(bandBp) * larger;
}

/** D2. Throws for a non-stale pair of a type the writer does not merge. */
export function classifyCollision(f: CollisionFacts): CollisionVerdict {
  const fresherIsDup = f.dupUpdatedUs >= f.survUpdatedUs;
  if (f.survUpdatedUs < f.dupCreatedUs) return { cls: "stale", keepDup: fresherIsDup };
  if (!isSummable(f.type)) {
    throw new Error(
      `no shape-C merge rule for a live ${f.type} collision — the writer sums only ${SUMMABLE_TYPES.join(", ")}`,
    );
  }
  const band = DUPLICATE_BAND_BP[f.type];
  if (band !== null && withinBand(f.survCents ?? 0n, f.dupCents ?? 0n, band)) {
    return { cls: f.type === "donation" ? "donation_duplicate" : "ie_duplicate", keepDup: fresherIsDup };
  }
  return { cls: "live", keepDup: false };
}

// ---------------------------------------------------------------------------
// D1 — the first-name key and its override
// ---------------------------------------------------------------------------

export interface FirstNameKeyInput {
  /** FIX-929's key: the first three letters, folded, of each side's first name. */
  survivorKey: string | null;
  dupKey: string | null;
  /**
   * The facts the override reads. null when the pair is not an --adopt-prior
   * adoption — the flag absent, or a pair whose survivor already claims the id —
   * and then a refusing key refuses, byte for byte as before FIX-1302.
   */
  adoption: { bioguide: string | null; survivorLiveId: string; pairId: string } | null;
  /** bioguide → `id.fec[]`, from legislators-current.json, read once per run. */
  listings: ReadonlyMap<string, readonly string[]> | null;
}

export type FirstNameKeyVerdict =
  | { verdict: "agree" }
  | { verdict: "override"; detail: string }
  | { verdict: "refuse"; reason: string };

/** D1. Undecidable is never agreement; only the dataset listing overrides. */
export function firstNameKeyGate(input: FirstNameKeyInput): FirstNameKeyVerdict {
  const { survivorKey, dupKey } = input;
  const refusal =
    !survivorKey || !dupKey
      ? `first-name key is undecidable (${survivorKey ?? "-"} vs ${dupKey ?? "-"})`
      : survivorKey !== dupKey
        ? `first names disagree (${survivorKey} vs ${dupKey}) — a FIX-934 question, not a merge`
        : null;
  if (refusal === null) return { verdict: "agree" };
  const a = input.adoption;
  if (a === null) return { verdict: "refuse", reason: refusal };

  const no = (why: string): FirstNameKeyVerdict => ({ verdict: "refuse", reason: `${refusal}; no override — ${why}` });
  if (!a.bioguide) return no("the survivor carries no bioguide (source_ids.congress_gov)");
  if (input.listings === null) return no("the congress-legislators dataset was not read");
  const listing = input.listings.get(a.bioguide);
  if (listing === undefined) return no(`bioguide ${a.bioguide} is not in legislators-current.json`);
  const missing = [a.survivorLiveId, a.pairId].filter((id) => !listing.includes(id));
  if (missing.length > 0) {
    return no(`the listing for ${a.bioguide} [${listing.join(", ")}] lacks ${missing.join(" and ")}`);
  }
  return {
    verdict: "override",
    detail: `keys ${survivorKey ?? "-"} vs ${dupKey ?? "-"}, bioguide ${a.bioguide} lists [${listing.join(", ")}]`,
  };
}
