/**
 * FEC individual contributions (indiv{yy}.zip) — FIX-181 + FIX-236.
 *
 * Each cycle's indiv file is ~2 GB compressed (~10 GB uncompressed) and
 * contains every itemized individual contribution to FEC-registered
 * committees for the cycle. Roughly 30M rows for a presidential cycle.
 *
 * Indiv rows reference the recipient committee (CMTE_ID). There are two
 * recipient classes we care about:
 *   1. Candidate-authorized committees (designation P/A in ccl{yy}.zip)
 *      → donation flows to a specific CAND_ID → official.
 *   2. Non-candidate committees (super PACs, party committees, other PACs
 *      — CMTE_TP O/X/Y/Z/N/Q/V/W in cm{yy}.zip) → donation flows to the
 *      committee as a financial_entity. This is the path that captures
 *      Form 3X Schedule A — Musk → America PAC, Soros → Democracy PAC, etc.
 *      Pre-FIX-236 these contributions were silently dropped.
 *
 * Joint-fundraising committees (CMTE_DSGN='J') stay excluded — their money is
 * split downstream and re-itemized via JFC→participant transfers, so capturing
 * them at the source would double-count. FIX-701: leadership PACs (D) and SSFs
 * (B) are NOT double-counts and are captured as their own committee entities
 * (see buildNonCandRecipientSet in index.ts); they are correctly kept OUT of the
 * candidate-attribution path below (parseCcl), which is a P/A allow-list.
 *
 * Donor identity: indiv has no donor ID. We dedupe on
 *   fingerprint = upper(NAME) collapsed + "|" + ZIP5
 * which is FEC's own near-duplicate convention. canonical_name embeds the
 * fingerprint so the existing UNIQUE(canonical_name, entity_type='individual')
 * dedup contract is honored.
 *
 * Memory (FIX-961 / PR 3a): the file streams line-by-line, and the per-cycle
 * aggregation is now EXTERNAL — projected records go to gzip'd sorted runs on
 * disk and are reduced by a k-way merge, so peak heap is one sort buffer plus
 * the merge cursors, independent of cycle size. The previous shape held three
 * in-RAM Maps sized O(distinct groups): it OOM'd a 12 GB heap at ~53M of ~69M
 * lines of indiv20 (1.7M cand pairs / 872k cmte pairs / 1.54M donors at death).
 *
 * PR 3b retired the pre-FIX-961 in-memory accumulator and its
 * FEC_INDIV_AGG_MODE=memory flag. The external sort is the only path.
 *
 * ── The $200 floor is an AGGREGATE floor, applied at EMIT (PR 3b) ───────────
 *
 * FEC's itemization rule is a per-donor CYCLE AGGREGATE, not a per-transaction
 * threshold: once a contributor passes $200 cumulative to a committee, every
 * later contribution is itemized HOWEVER SMALL. `indiv{yy}.zip` therefore holds
 * a large population of disclosed sub-$200 rows, and the pre-3b parse-time
 * `amt < 200` filter dropped all of them. Measured on the full cycle-2026 file
 * (docs/audits/2026-08-18-fec-coverage-pr3a-phase0.md §2.4): the per-transaction
 * floor discarded 90.2% of in-scope rows, understated 201,489 already-emitted
 * relationships by $69.1M, and dropped 664,178 relationships whose cycle
 * aggregate clears $200 outright ($412.6M).
 *
 * So: every itemized row now enters the aggregation, and the floor is applied
 * once per (donor × recipient × cycle) group at emit time.
 *
 *   aggregate ≥ $200  → an FR row, with the CORRECT (full) amount
 *   aggregate < $200  → NO FR row and NO financial_entities row; the group is
 *                       counted into a per-recipient size bracket instead
 *                       (readSmallDollarBrackets), so the residual is measured
 *                       rather than silently discarded
 *
 * Truly unitemized money — a donor who never crosses $200 with a committee and
 * so never appears in the file at all — remains unrecoverable under any rule.
 */

import * as fs       from "fs";
import * as path     from "path";
import * as readline from "readline";
import { extractZipEntryToDisk } from "./util";
import {
  ExternalGroupSorter,
  mergeJoinGrouped,
  compositeKey,
  escapeField,
  unescapeField,
  KEY_FIELD_SEP,
  type SortedGroups,
  type ExternalSortStats,
} from "../../lib/external-sort";

// ---------------------------------------------------------------------------
// Column maps
// ---------------------------------------------------------------------------

// indiv pipe-delimited column indices (0-based). Ref:
// https://www.fec.gov/campaign-finance-data/contributions-individuals-file-description/
const INDIV_COL = {
  CMTE_ID:         0,
  TRANSACTION_TP:  5,
  ENTITY_TP:       6,
  NAME:            7,
  CITY:            8,
  STATE:           9,
  ZIP_CODE:        10,
  EMPLOYER:        11,
  OCCUPATION:      12,
  TRANSACTION_DT:  13,
  TRANSACTION_AMT: 14,
} as const;

// ccl pipe-delimited column indices. Ref:
// https://www.fec.gov/campaign-finance-data/candidate-committee-linkage-file-description/
const CCL_COL = {
  CAND_ID:   0,
  CMTE_ID:   3,
  CMTE_TP:   4,
  CMTE_DSGN: 5,
} as const;

// Transaction types we keep (the DEFAULT set):
//   '15'  direct individual contribution to a non-super-PAC committee
//   '15E' earmarked through a conduit (ActBlue, WinRed, etc.) — still attributed to individual
//   '10'  direct individual contribution to an independent-expenditure-only
//         committee (Super PAC) or Hybrid PAC non-contribution account — the
//         super-PAC analog of '15' (FEC: "Contribution to Independent
//         Expenditure-Only Committees (Super PACs)... from a person"). FIX-677:
//         omitting it silently dropped ~all super-PAC individual receipts —
//         e.g. United Democracy Project (C00799031) showed $0 received despite
//         1,337 itemized type-10 contributions totaling ~$86M; across all super
//         PACs in indiv24 it was 84,301 rows / $3.79B dropped. '10' is a direct
//         receipt (counterpart to '15'), NOT a passthrough memo, so there is no
//         double-count risk.
// Excluded: '15I'/'15T'/'24I'/'24T' earmark passthrough memos (would
//   double-count), '15J' memo, '20Y'/'22Y' refunds, transfers.
//
// FIX-700: the active set is overridable via FEC_INDIV_TX_TYPES so a surgical
// re-run can process just one type (the FIX-677 finish re-ingests only type 10).
// A narrowed set marks the run "scoped" (see isIndivTxScoped) which suppresses
// entity-aggregate overwrite in the writers — the totals rebuild re-derives the
// authoritative values afterward.
export const DEFAULT_INDIV_TX_TYPES = ["15", "15E", "10"] as const;

// Known FEC receipt-side transaction types — used only to WARN on a likely typo
// in FEC_INDIV_TX_TYPES (individual contributions, earmarks, refunds, memos).
// Not exhaustive of every FEC code; unknowns pass through with a warning, never
// a hard error. Ref: FEC transaction-type-code table.
const KNOWN_INDIV_TX_TYPES: ReadonlySet<string> = new Set([
  "10", "10J", "11", "11J",
  "15", "15C", "15E", "15F", "15I", "15J", "15T", "15Z",
  "18G", "18H", "18J", "18K", "18L", "18U",
  "19", "19J",
  "20", "20A", "20B", "20C", "20D", "20F", "20G", "20R", "20V", "20Y",
  "21Y",
  "22H", "22J", "22K", "22L", "22R", "22U", "22X", "22Y", "22Z",
  "23Y",
  "24I", "24T",
  "30", "30T", "31", "31T", "32", "32T",
]);

/**
 * Resolve the active indiv transaction-type filter set. Reads
 * FEC_INDIV_TX_TYPES (comma-separated, case-insensitive); falls back to the
 * default 15/15E/10 when unset or empty. Warns on unrecognized codes but keeps
 * them (the KNOWN set is not exhaustive). Uppercased so it matches the raw
 * FEC file values ("15E", "10", …) which are always uppercase.
 */
export function parseKeepTxTypes(raw: string | undefined = process.env.FEC_INDIV_TX_TYPES): Set<string> {
  const parts = (raw ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (parts.length === 0) return new Set(DEFAULT_INDIV_TX_TYPES);
  const unknown = parts.filter((p) => !KNOWN_INDIV_TX_TYPES.has(p));
  if (unknown.length > 0) {
    console.warn(
      `    [fec-bulk:indiv] FEC_INDIV_TX_TYPES has unrecognized FEC tx type(s): ${unknown.join(", ")} ` +
        `— proceeding, but verify against the FEC transaction-type-code list`,
    );
  }
  return new Set(parts);
}

/**
 * A run is tx-scoped when the active set NARROWS below the full default — i.e.
 * omits any of 15/15E/10. Widening (adding extra types) is NOT scoped. Scoped
 * runs skip entity-aggregate overwrite in the writers (see writer.ts).
 */
export function isIndivTxScoped(active: Set<string> = parseKeepTxTypes()): boolean {
  return !DEFAULT_INDIV_TX_TYPES.every((t) => active.has(t));
}

// ---------------------------------------------------------------------------
// FIX-701: recipient-committee scope axis (FEC_INDIV_RECIPIENT_CMTES).
//
// A third surgical axis alongside FEC_INDIV_TX_TYPES / FEC_INDIV_STAGES. D/B
// donations are type-15 (the bulk of ALL individual donations), so tx-type
// scoping cannot isolate them — the recipient committee is the only handle. When
// this allow-list is set, the indiv stage captures ONLY donations whose recipient
// committee is in the list (both the candidate-attribution and the non-candidate
// committee paths are narrowed to it). Empty ⇒ unset ⇒ every recipient (today's
// full-run behavior). Genuinely reusable: "re-run donations to these specific
// committees". Its surfacing use is the FIX-701 2024 D/B re-capture (the rows the
// FIX-677 finish's Phase-1 cleanup over-deleted).
// ---------------------------------------------------------------------------

/**
 * Resolve the recipient-committee allow-list from FEC_INDIV_RECIPIENT_CMTES
 * (comma-separated FEC committee IDs, case-insensitive). Empty Set ⇒ no filter.
 * FEC committee IDs are uppercase alphanumeric (C00XXXXXX), so uppercasing is
 * safe and matches the raw cm/ccl file values.
 */
export function parseRecipientCmtes(
  raw: string | undefined = process.env.FEC_INDIV_RECIPIENT_CMTES,
): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );
}

/** A run is recipient-scoped when the allow-list is non-empty. */
export function isRecipientScoped(allow: Set<string> = parseRecipientCmtes()): boolean {
  return allow.size > 0;
}

/**
 * Apply the recipient-committee allow-list to the two recipient collections
 * IN PLACE. Empty allow-list ⇒ no-op (full run). Pure aside from the in-place
 * mutation the caller owns; returns the surviving counts for logging.
 */
export function applyRecipientCmteScope(
  cmteToCand:   Map<string, string>,
  nonCandCmtes: Set<string>,
  allow:        Set<string> = parseRecipientCmtes(),
): { candKept: number; nonCandKept: number } {
  if (allow.size > 0) {
    for (const cmteId of [...cmteToCand.keys()]) {
      if (!allow.has(cmteId)) cmteToCand.delete(cmteId);
    }
    for (const cmteId of [...nonCandCmtes]) {
      if (!allow.has(cmteId)) nonCandCmtes.delete(cmteId);
    }
  }
  return { candKept: cmteToCand.size, nonCandKept: nonCandCmtes.size };
}

/**
 * FEC's itemization floor, in cents — applied to the (donor × recipient × cycle)
 * AGGREGATE at emit time, never to a single transaction (see the file header).
 * The pas2 pipeline applies the same threshold to its own (committee × candidate)
 * aggregate.
 */
export const MIN_AGGREGATE_CENTS = 20_000;

// ---------------------------------------------------------------------------
// Sub-floor residual brackets (PR 3b)
//
// A (donor × recipient × cycle) aggregate below the floor emits no row. It is
// real disclosed money, so it is COUNTED into a size bracket per recipient
// rather than dropped: `small_dollar_bracket_rollup` is the substrate, and the
// honest "small-dollar (sub-$200 aggregate)" figure on an official's page is
// derived from it.
//
// Bands mirror FEC's own by_size display convention at sub-floor grain, and are
// the bands the phase-0 audit measured, so the acceptance numbers are directly
// comparable. Ordered low→high; `assignSmallDollarBracket` takes the first
// match, so the ranges must stay disjoint and contiguous over [1, floor).
// ---------------------------------------------------------------------------

export const SMALL_DOLLAR_BRACKETS = [
  { code: "lt_50",   label: "$0.01–$49.99", loCents: 1,      hiCents: 4_999  },
  { code: "50_99",   label: "$50–$99.99",   loCents: 5_000,  hiCents: 9_999  },
  { code: "100_199", label: "$100–$199.99", loCents: 10_000, hiCents: 19_999 },
] as const;

export type SmallDollarBracketCode = (typeof SMALL_DOLLAR_BRACKETS)[number]["code"];

/** Bracket for a sub-floor aggregate, or null when it is not sub-floor. */
export function assignSmallDollarBracket(totalCents: number): SmallDollarBracketCode | null {
  for (const b of SMALL_DOLLAR_BRACKETS) {
    if (totalCents >= b.loCents && totalCents <= b.hiCents) return b.code;
  }
  return null;
}

/** One (recipient × bracket) residual row for a single cycle. */
export interface SmallDollarBracketRow {
  /** ROUTE_CAND ⇒ `recipient` is an FEC CAND_ID; ROUTE_CMTE ⇒ a CMTE_ID. */
  route:      "C" | "M";
  recipient:  string;
  bracket:    SmallDollarBracketCode;
  /** (donor × recipient) groups in this bracket — donor-and-recipient pairs. */
  donorCount: number;
  totalCents: number;
  txCount:    number;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IndivAggregation {
  donorFingerprint: string;
  candId:           string;
  totalCents:       number;
  txCount:          number;
  latestDate:       string | null; // raw MMDDYYYY
}

/** FIX-236: per-cycle donor → non-candidate-committee aggregate. */
export interface IndivCommitteeAggregation {
  donorFingerprint: string;
  cmteId:           string;
  totalCents:       number;
  txCount:          number;
  latestDate:       string | null;
}

export interface IndivDonorMeta {
  fingerprint: string;
  displayName: string;
  city:        string;
  state:       string;
  zip5:        string;
  employer:    string;
  occupation:  string;
}

/** A donor row ready for upsertIndividualDonorsBatch — meta + cycle total. */
export interface IndivDonorInput extends IndivDonorMeta {
  /**
   * Sum of this donor's cycle contributions across BOTH recipient routes. A
   * donor who gives to a candidate AND a super PAC counts both.
   */
  totalDonatedCents: number;
}

export interface IndivStreamStats {
  linesRead:        number;
  passedTxType:     number;
  passedCmte:       number;     // line had cmteId in EITHER candidate OR committee map
  passedCand:       number;     // routed to the candidate aggregation
  passedCommittee:  number;     // routed to the non-candidate-committee aggregation
  /** PR 3b: rows admitted to the aggregation (amount > 0). Was `passedAmt`, the
   *  count that survived the per-transaction $200 filter — a different number
   *  with a different meaning, so it got a different name. */
  passedAmount:     number;
  /** Distinct donors IN THE FILE (pre-floor). */
  uniqueDonors:     number;
  /** (donor × candidate) groups that CLEAR the aggregate floor — i.e. FR rows. */
  candPairs:        number;
  /** (donor × committee) groups that CLEAR the aggregate floor. */
  cmtePairs:        number;
  /**
   * FIX-1061 — rows `readDonorInputs()` will yield, i.e. donors with at least
   * one above-floor aggregate. The donor writer's FIX-754 cursor TOTAL. Below
   * `uniqueDonors` by exactly the donors whose every group is sub-floor.
   */
  donorRows:        number;
  /** PR 3b: (donor × recipient) groups BELOW the floor — bracketed, not emitted. */
  residualGroups:   number;
  /** PR 3b: dollars in those groups. */
  residualCents:    number;
  /** FIX-961: external-sort accounting. */
  sort?: {
    agg:  ExternalSortStats;
    meta: ExternalSortStats;
    /** High-water of BOTH sorters' simultaneous on-disk footprint, bytes. */
    peakDiskBytes: number;
  };
}

/**
 * FIX-961: the stage's output is consumed through async iterators, so nothing
 * has to materialize a whole cycle — the accessors re-read the merged sort files
 * (cheap; the merged output is ~40 MB gzip'd for a presidential cycle).
 *
 * PR 3b: every aggregate accessor applies the $200 AGGREGATE floor, so what they
 * yield is exactly what gets written. The sub-floor residual is not silently
 * dropped — it comes back through `readSmallDollarBrackets()`.
 *
 * Every accessor is re-readable. `dispose()` removes the on-disk artifacts and
 * MUST be called when the cycle's writer stages are done.
 */
export interface IndivStreamResult {
  /** Donor × candidate aggregates ≥ the floor, ordered by fingerprint. */
  readAggregations(): AsyncIterable<IndivAggregation>;
  /** Donor × non-cand-committee aggregates ≥ the floor (FIX-236). */
  readCommitteeAggregations(): AsyncIterable<IndivCommitteeAggregation>;
  /**
   * Donor meta joined to the donor's cycle total. PR 3b: donors with NO
   * above-floor aggregate are omitted entirely (no FR row ⇒ no donor entity),
   * and the total sums ONLY above-floor groups so it agrees with the FR rows
   * this run writes — the same convention
   * `rebuild_financial_entity_donation_totals()` re-derives from.
   */
  readDonorInputs(): AsyncIterable<IndivDonorInput>;
  /**
   * PR 3b: the sub-floor residual, aggregated to (recipient × bracket). Small
   * and bounded (recipients × 3), so it is materialized rather than streamed.
   */
  readSmallDollarBrackets(): SmallDollarBracketRow[];
  dispose(): Promise<void>;
  stats: IndivStreamStats;
}

// ---------------------------------------------------------------------------
// PR 3b — the FEC_INDIV_AGG_MODE flag and its `memory` accumulator are GONE.
//
// The flag existed for exactly one reason: to let `data:fec:indiv-equivalence`
// diff the pre-FIX-961 in-RAM Maps against the external sort. That diff ran
// (zero divergence across every emitted set, plus an end-to-end check against
// rows the old path had already persisted) and PR 3a shipped on the strength of
// it. Keeping a second accumulator alive past that point buys nothing and costs
// a great deal: it is the path that OOMs, every semantics change has to be made
// twice, and "which mode was that run?" becomes a question every incident has to
// answer. A run that sets FEC_INDIV_AGG_MODE now simply gets the external sort.
// ---------------------------------------------------------------------------

/**
 * Distinct keys held per sort buffer before it spills. ~400k measured ~55 MB
 * retained for the aggregate record shape. Override with FEC_INDIV_SORT_BUFFER
 * when tuning against a heap ceiling.
 */
function resolveSortBuffer(raw: string | undefined = process.env.FEC_INDIV_SORT_BUFFER): number {
  const n = parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 400_000;
}

// ---------------------------------------------------------------------------
// ccl parser
// ---------------------------------------------------------------------------

/**
 * Build the CMTE_ID → CAND_ID lookup. Multi-committee candidates (a
 * principal + several authorized) all collapse to the same CAND_ID, so an
 * indiv contribution to any of those committees attributes correctly.
 *
 * This is an ALLOW-list of P (principal campaign committee) and A (authorized
 * committee) designations only — the committees a candidate has authorized for
 * their OWN campaign. Everything else (J/D/B and any other designation) is left
 * out on purpose: a donation to a leadership PAC (D) or SSF (B) is real money to
 * THAT committee, not to the sponsoring candidate's campaign, so attributing it
 * here would be wrong. Those receipts are captured as their own committee
 * entities via buildNonCandRecipientSet (FIX-701). JFCs (J) stay out of both
 * paths — they double-count (see the file header).
 */
export function parseCcl(buffer: Buffer): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const line of buffer.toString("latin1").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols     = line.split("|");
    const candId   = (cols[CCL_COL.CAND_ID]   ?? "").trim();
    const cmteId   = (cols[CCL_COL.CMTE_ID]   ?? "").trim();
    const cmteDsgn = (cols[CCL_COL.CMTE_DSGN] ?? "").trim().toUpperCase();
    if (!candId || !cmteId) continue;
    if (cmteDsgn !== "P" && cmteDsgn !== "A") continue;
    if (!lookup.has(cmteId)) lookup.set(cmteId, candId);
  }
  return lookup;
}

// ---------------------------------------------------------------------------
// Donor fingerprinting — FIX-239 Layer 1 + FIX-244 + FIX-245.
//
// Mirrors the SQL function `public.canonical_donor_fingerprint(name, zip5)`
// (defined originally in 20260510000005, last updated by FIX-245's
// 20260525065710_entity_backfill_bundle.sql). The two MUST stay in sync —
// the FEC pipeline's idempotency under the donor_fingerprint UNIQUE index
// depends on TS output ≡ SQL output for every (name, zip5) pair.
//
// Layer 1 rule set (investigation docs/FIX_239_INVESTIGATION.md §4):
//   1. Uppercase.
//   2. Strip backtick, apostrophe, and period to EMPTY STRING (FIX-244 added
//      apostrophe + period; FIX-245 added backtick to cover ``O`BRIEN``).
//      M.D. -> MD, ST. -> ST.
//   3. Replace other non-alphanumeric with whitespace; collapse runs.
//   4. Tokenize.
//   5. Drop honorific noise tokens (MR/MRS/MD/PHD/...). Preserve generational
//      tokens (JR/SR/II-V) and middle initials — these are the signal that
//      keeps the §2.4 father/son cases split.
//   6. FIX-245: position-0 particle joiner. When tokens[0] ∈ {O,D,DE,ST,MC}
//      and tokens[1] is all-uppercase ASCII, fuse the two. Handles the
//      space/backtick FEC NAME residue that wasn't an apostrophe in the
//      source (`O BRIEN`, `O' BRIEN`, ``O`BRIEN``). Narrow allow-list of 5
//      particles, position 0 only — aggressive joining would fuse legitimate
//      mononyms.
//   7. Emit `tokens.join(' ') + '|' + zip5` (or name-only if zip5 blank).
// ---------------------------------------------------------------------------

const NOISE_TOKENS: ReadonlySet<string> = new Set([
  "MR", "MRS", "MS", "DR", "MD", "PHD", "ESQ", "REV", "HON",
  "CPA", "CFP", "JD", "RN", "DDS", "DO", "MBA",
]);

const PARTICLE_TOKENS: ReadonlySet<string> = new Set(["O", "D", "DE", "ST", "MC"]);

export function normalizeName(raw: string): string {
  if (!raw) return "";
  const cleaned = raw
    .toUpperCase()
    .replace(/[`'.]/g, "")         // FIX-244 + FIX-245: backtick + apostrophe + period → empty
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  const tokens = cleaned.split(" ").filter((t) => t && !NOISE_TOKENS.has(t));
  // FIX-245 position-0 particle joiner. Must run after the noise filter so
  // an "MR O BRIEN" input (LAST,FIRST swapped with a leading honorific) gets
  // MR dropped first, then O+BRIEN fused.
  if (
    tokens.length >= 2 &&
    PARTICLE_TOKENS.has(tokens[0]!) &&
    /^[A-Z]+$/.test(tokens[1]!)
  ) {
    tokens.splice(0, 2, tokens[0]! + tokens[1]!);
  }
  return tokens.join(" ");
}

function zip5Of(raw: string): string {
  const s = (raw ?? "").trim();
  return s.length >= 5 ? s.slice(0, 5) : s;
}

export function donorFingerprint(name: string, zip5: string): string {
  const n = normalizeName(name);
  if (!n) return "";
  const z = zip5Of(zip5);
  return z ? `${n}|${z}` : n;
}

// ---------------------------------------------------------------------------
// Natural-order canonical name for the search-side index (FIX-238).
//
// FEC stores individual NAME as "LAST, FIRST [MI] [SFX/HONORIFIC]". The
// donor_fingerprint normalizes that into a comma-less "LAST FIRST" form for
// dedup — but a natural-order search like "Elon Musk" can't substring-match
// "MUSK ELON" via trigrams in any useful way. canonical_name is the search
// target (trgm GIN added by 20260512000002), so we reorder it to natural
// "FIRST [MI] LAST" form at write time and the search route can ilike it
// directly without the LAST-FIRST reversal fallback FIX-236 added.
//
// Fingerprint stays in LAST-FIRST normalized form — it's the UNIQUE-index
// dedup key, must remain stable across pipeline runs.
// ---------------------------------------------------------------------------

export function canonicalDonorName(rawName: string): string {
  if (!rawName) return "";
  const commaIdx = rawName.indexOf(",");
  const reordered =
    commaIdx >= 0
      ? `${rawName.slice(commaIdx + 1).trim()} ${rawName.slice(0, commaIdx).trim()}`
      : rawName;
  return normalizeName(reordered);
}

// ---------------------------------------------------------------------------
// FIX-274 · org-shape guard for individual donor NAME field
//
// FEC's indiv schedule is "itemized contributions from individuals", but the
// NAME column accepts free text from the filer. Real-world data has org names
// land in there — donors who file "AMERICANS FOR PROSPERITY" as their own
// NAME, treasurer-style "DEMOCRACY ENGINE LLC" entries, etc. Without a
// guard, every one of these becomes an `entity_type='individual'` row that
// then competes with the legitimate org's nonprofit/PAC/LittleSis row by
// canonical_name (investigation §2.5: AfP has 5 rows total, 2 of them
// accidentally indiv).
//
// Two layers, both conservative:
//   1. Static blacklist — exact-canonical matches for the worst offenders we
//      already know about (investigation §2.5).
//   2. Heuristic — tokenized check against a small suffix set. Word boundary
//      via split-by-whitespace avoids false-positives on real surnames that
//      embed substrings (MICHAEL PACE doesn't match `PAC`; KEITH FOSTER does
//      not match `FOUNDATION` either way). False-positive cost is silent
//      loss of a real individual donor, so additions to ORG_SUFFIX_TOKENS
//      should be paranoid.
// ---------------------------------------------------------------------------

const ORG_SUFFIX_TOKENS: ReadonlySet<string> = new Set([
  "INC", "LLC", "LTD", "CORP", "CORPORATION", "COMPANY",
  "PAC", "FOUNDATION", "ASSOCIATION", "SOCIETY", "FUND", "COMMITTEE",
]);

const ORG_NAME_BLACKLIST: ReadonlySet<string> = new Set([
  "AMERICANS FOR PROSPERITY",
  "ONE NATION",
]);

export function isLikelyOrgName(normalizedName: string): boolean {
  if (!normalizedName) return false;
  if (ORG_NAME_BLACKLIST.has(normalizedName)) return true;
  const tokens = normalizedName.split(" ").filter(Boolean);
  for (const tok of tokens) {
    if (ORG_SUFFIX_TOKENS.has(tok)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Stream indiv{yy}.zip → aggregates
//
// FIX-961 / PR 3a: each surviving row is projected to two compact sorted records
// and spilled to gzip'd runs; a k-way merge reduces them. Peak heap is one sort
// buffer, independent of cycle size.
//
// The folds are sum / count / lexicographic-max-over-non-empty (all associative
// and commutative, as ExternalGroupSorter requires) plus first-seen donor meta,
// preserved by carrying the row ordinal in the record and combining on
// min-ordinal.
//
// PR 3b: the ADMISSION test is now `amount > 0` — the $200 rule is a property of
// the (donor × recipient × cycle) AGGREGATE, so it cannot be evaluated until the
// group is complete. See the file header.
// ---------------------------------------------------------------------------

/** Route marker in the aggregate sort key. 'C' sorts before 'M'. */
const ROUTE_CAND = "C";
const ROUTE_CMTE = "M";

interface AggValue { cents: number; count: number; maxDt: string | null }
interface MetaValue {
  ordinal:     number;
  displayName: string;
  city:        string;
  state:       string;
  zip5:        string;
  employer:    string;
  occupation:  string;
}

const AGG_CODEC = {
  encode: (v: AggValue) => `${v.cents}\t${v.count}\t${v.maxDt ?? ""}`,
  decode: (s: string): AggValue => {
    const t1 = s.indexOf("\t");
    const t2 = s.indexOf("\t", t1 + 1);
    const dt = s.slice(t2 + 1);
    return { cents: +s.slice(0, t1), count: +s.slice(t1 + 1, t2), maxDt: dt === "" ? null : dt };
  },
  // Mirrors the map path exactly: sum, count, and `dt > (latest ?? "")`.
  combine: (a: AggValue, b: AggValue): AggValue => ({
    cents: a.cents + b.cents,
    count: a.count + b.count,
    maxDt: (b.maxDt ?? "") > (a.maxDt ?? "") ? b.maxDt : a.maxDt,
  }),
};

const META_CODEC = {
  encode: (v: MetaValue) =>
    `${v.ordinal}\t${escapeField(v.displayName)}\t${escapeField(v.city)}\t${v.state}\t` +
    `${v.zip5}\t${escapeField(v.employer)}\t${escapeField(v.occupation)}`,
  decode: (s: string): MetaValue => {
    const f = s.split("\t");
    return {
      ordinal:     +(f[0] ?? "0"),
      displayName: unescapeField(f[1] ?? ""),
      city:        unescapeField(f[2] ?? ""),
      state:       f[3] ?? "",
      zip5:        f[4] ?? "",
      employer:    unescapeField(f[5] ?? ""),
      occupation:  unescapeField(f[6] ?? ""),
    };
  },
  // `donorMetas.set(fp, …)` only when absent ⇒ FIRST occurrence in file order
  // wins. The ordinal makes that order-independent, so it survives spilling.
  combine: (a: MetaValue, b: MetaValue): MetaValue => (b.ordinal < a.ordinal ? b : a),
};

/**
 * Split an aggregate sort key `fp ␟ route ␟ recipient` into its parts.
 *
 * The separator is KEY_FIELD_SEP, NOT a tab. The line format reserves the first
 * tab as the key/payload boundary, so tab-separated key fields reframe every
 * line — the reader takes field 1 as the whole key and folds route/recipient
 * into the payload, which silently groups by donor instead of by
 * (donor, route, recipient). That was a real bug in this PR's first pass; the
 * always-on first-key assertion in external-sort.ts now catches it at add().
 */
function splitAggKey(key: string): { fp: string; route: string; recipient: string } {
  const t1 = key.indexOf(KEY_FIELD_SEP);
  const t2 = key.indexOf(KEY_FIELD_SEP, t1 + 1);
  return { fp: key.slice(0, t1), route: key.slice(t1 + 1, t2), recipient: key.slice(t2 + 1) };
}

/** Join key of an aggregate record = the donor fingerprint prefix. */
function aggKeyDonor(key: string): string {
  const t = key.indexOf(KEY_FIELD_SEP);
  return t < 0 ? key : key.slice(0, t);
}

export async function streamIndiv(
  zipPath:        string,
  cmteToCandId:   Map<string, string>,
  candidateSet:   Set<string>,
  nonCandCmtes:   Set<string>,    // FIX-236: super PAC / party / other-PAC CMTE_IDs (not in ccl P/A)
  tempDir:        string,
  // FIX-700: active tx-type filter. Defaults to FEC_INDIV_TX_TYPES / 15,15E,10.
  // index.ts passes the already-resolved set so the parse + warning run once.
  keepTxTypes:    Set<string> = parseKeepTxTypes(),
): Promise<IndivStreamResult> {
  const txtPath = path.join(tempDir, "indiv-extracted.txt");
  const found = await extractZipEntryToDisk(
    zipPath,
    (name) => name.startsWith("itcont") || (name.startsWith("indiv") && name.endsWith(".txt")),
    txtPath,
  );
  if (!found) {
    throw new Error(`indiv .txt entry not found inside ${zipPath} (looked for itcont*.txt or indiv*.txt)`);
  }

  return streamIndivText(txtPath, cmteToCandId, candidateSet, nonCandCmtes, tempDir, keepTxTypes, {
    deleteInputAfterStream: true,
  });
}

/** Knobs the acceptance harness needs and the pipeline does not. FIX-961. */
export interface StreamIndivTextOptions {
  /** Unlink the input text once the stream drains (the pipeline's behavior). */
  deleteInputAfterStream?: boolean;
  /** Stop after this many lines. Used to take a deterministic file slice. */
  maxLines?: number;
  /** Override the sort-buffer size — small values force multi-run merging. */
  sortBufferEntries?: number;
  /** Name the sort scratch dir, so two runs can work side by side. */
  sortDirName?: string;
}

/**
 * The stage proper, over an already-extracted indiv text file.
 *
 * Split out of `streamIndiv` by FIX-961 so a harness can drive a deterministic
 * slice of a real file without materializing a zip.
 */
export async function streamIndivText(
  txtPath:        string,
  cmteToCandId:   Map<string, string>,
  candidateSet:   Set<string>,
  nonCandCmtes:   Set<string>,
  tempDir:        string,
  keepTxTypes:    Set<string> = parseKeepTxTypes(),
  opts:           StreamIndivTextOptions = {},
): Promise<IndivStreamResult> {
  const txtMb = (fs.statSync(txtPath).size / 1024 / 1024).toFixed(0);
  console.log(`    Extracted indiv text (${txtMb} MB) — streaming line by line...`);
  console.log(`    Tx-type filter: [${[...keepTxTypes].join(",")}]`);
  console.log(`    Floor: $${(MIN_AGGREGATE_CENTS / 100).toFixed(0)} per (donor × recipient × cycle) AGGREGATE, applied at EMIT (PR 3b)`);

  const sortDir = path.join(tempDir, opts.sortDirName ?? "indiv-sort");
  const bufferEntries = opts.sortBufferEntries ?? resolveSortBuffer();
  fs.mkdirSync(sortDir, { recursive: true });
  const aggSorter = new ExternalGroupSorter<AggValue>({
    tempDir: sortDir, name: "agg",  maxBufferEntries: bufferEntries, ...AGG_CODEC,
  });
  const metaSorter = new ExternalGroupSorter<MetaValue>({
    // Meta collapses to one record per donor inside the buffer, so it holds
    // far more input rows per spill than the aggregate sorter does.
    tempDir: sortDir, name: "meta", maxBufferEntries: bufferEntries, ...META_CODEC,
  });
  console.log(`    Sort buffer: ${bufferEntries.toLocaleString()} keys/run · gzip level 1 · ${sortDir}`);

  let linesRead = 0,
      passedTxType = 0,
      passedCmte = 0,
      passedCand = 0,
      passedCommittee = 0,
      passedAmount = 0,
      skippedOrgShaped = 0;

  const rl = readline.createInterface({
    input:     fs.createReadStream(txtPath, { encoding: "latin1" }),
    crlfDelay: Infinity,
  });

  const maxLines = opts.maxLines ?? Infinity;

  for await (const line of rl) {
    if (linesRead >= maxLines) { rl.close(); break; }
    linesRead++;
    if (linesRead % 1_000_000 === 0) {
      console.log(
        `    ... ${linesRead.toLocaleString()} lines | ` +
        `${passedAmount.toLocaleString()} kept | ` +
        `${aggSorter.stats.runsWritten}+${metaSorter.stats.runsWritten} runs | ` +
        `rss ${(process.memoryUsage.rss() / 1024 / 1024).toFixed(0)} MB`,
      );
    }

    const cols   = line.split("|");
    const txType = (cols[INDIV_COL.TRANSACTION_TP] ?? "").trim();
    if (!keepTxTypes.has(txType)) continue;
    passedTxType++;

    const cmteId = (cols[INDIV_COL.CMTE_ID] ?? "").trim();

    // Route by recipient class. cmteToCandId is the ccl P/A → CAND_ID set;
    // nonCandCmtes is super PAC / party / other-PAC committees from cm{yy}
    // that are *not* in ccl P/A. The two sets are disjoint by construction
    // in index.ts; route candidate-first to keep existing path stable.
    const candId      = cmteToCandId.get(cmteId);
    const isCmteOnly  = !candId && nonCandCmtes.has(cmteId);
    if (!candId && !isCmteOnly) continue;
    passedCmte++;

    // Candidate path additionally requires the CAND_ID to map to one of our
    // matched officials. Committee path skips this — every committee we
    // kept in nonCandCmtes is already an entity we'll surface.
    if (candId && !candidateSet.has(candId)) continue;
    if (candId)     passedCand++;
    if (isCmteOnly) passedCommittee++;

    const amtStr = (cols[INDIV_COL.TRANSACTION_AMT] ?? "").trim();
    const amt    = parseFloat(amtStr);
    // PR 3b: admission is `amount > 0`, NOT `amount >= $200`. The itemization
    // rule is a property of the donor's cycle aggregate (file header), so it
    // cannot be evaluated here — it is applied once per group at emit. `<= 0`
    // still rejects the unparseable, the zero and the negative (refund/
    // correction) rows, exactly as the old `< 200` test incidentally did.
    if (isNaN(amt) || amt <= 0) continue;
    passedAmount++;

    const name = (cols[INDIV_COL.NAME] ?? "").trim();
    if (!name) continue;

    const zip5 = zip5Of(cols[INDIV_COL.ZIP_CODE] ?? "");
    const fp   = donorFingerprint(name, zip5);
    if (!fp) continue;            // name was empty / pure noise after Layer 1 normalization

    // FIX-274: drop org-shaped names before they become individual rows.
    // donorFingerprint's first half is the normalizedName; if it carries an
    // org-suffix token or is on the static blacklist, this is an org filed
    // in the NAME field, not a real individual donor.
    const fpName = fp.includes("|") ? fp.slice(0, fp.indexOf("|")) : fp;
    if (isLikelyOrgName(fpName)) {
      skippedOrgShaped++;
      if (skippedOrgShaped <= 20) {
        console.log(`    [fec-bulk:indiv] skipped org-shaped name: ${fpName}`);
      }
      continue;
    }

    const dt   = (cols[INDIV_COL.TRANSACTION_DT] ?? "").trim();
    const amtCents = Math.round(amt * 100);

    // `linesRead` is the ordinal: strictly increasing, and its ORDER (not its
    // value) is what first-seen-wins depends on.
    if (metaSorter.add(fp, {
      ordinal:     linesRead,
      // .slice() forces a flat copy so the record does not pin the whole
      // parent line through V8's sliced-string representation.
      displayName: name.slice(),
      city:        (cols[INDIV_COL.CITY]       ?? "").trim().slice(),
      state:       (cols[INDIV_COL.STATE]      ?? "").trim().toUpperCase(),
      zip5,
      employer:    (cols[INDIV_COL.EMPLOYER]   ?? "").trim().slice(),
      occupation:  (cols[INDIV_COL.OCCUPATION] ?? "").trim().slice(),
    })) await metaSorter.spill();

    const route     = candId ? ROUTE_CAND : ROUTE_CMTE;
    const recipient = candId ?? cmteId;
    if (aggSorter.add(compositeKey(fp, route, recipient), {
      cents: amtCents, count: 1, maxDt: dt || null,
    })) await aggSorter.spill();
  }

  // Released BEFORE the merge — a presidential cycle's extracted text is ~13 GB
  // and the merge wants that disk for its runs.
  if (opts.deleteInputAfterStream) {
    try { fs.unlinkSync(txtPath); } catch { /* best effort */ }
  }

  // ── finalize ────────────────────────────────────────────────────────────
  console.log(`    Merging sorted runs (${aggSorter.stats.runsWritten} agg + ${metaSorter.stats.runsWritten} meta)...`);
  const aggSorted  = await aggSorter.finalize();
  const metaSorted = await metaSorter.finalize();

  // ONE pass over the merged aggregates does three jobs at once (the merged
  // output is a few tens of MB gzip'd, so this is cheap):
  //   1. the two emitted-pair counts, which are the writers' FIX-754 cursor
  //      TOTALS and so must be the post-floor counts, not the group counts;
  //   2. the donor-row count — donors with ≥1 above-floor group. The stream is
  //      fingerprint-ordered, so a donor's groups are contiguous and one
  //      boolean carries the answer;
  //   3. the sub-floor residual, folded to (recipient × bracket).
  // Doing it here rather than inside the emit iterators matters: those are
  // re-read several times per cycle, and an accumulator inside them would
  // multiply-count.
  let candPairs = 0, cmtePairs = 0, donorRows = 0;
  let residualGroups = 0, residualCents = 0;
  const brackets = new Map<string, SmallDollarBracketRow>();
  let curDonor: string | null = null;
  let curDonorEmits = false;

  for await (const { key, value } of aggSorted) {
    const { fp, route, recipient } = splitAggKey(key);
    if (fp !== curDonor) {
      if (curDonorEmits) donorRows++;
      curDonor = fp;
      curDonorEmits = false;
    }

    if (value.cents >= MIN_AGGREGATE_CENTS) {
      curDonorEmits = true;
      if (route === ROUTE_CAND) candPairs++; else cmtePairs++;
      continue;
    }

    // Sub-floor: no FR row, no donor entity — bracketed instead.
    residualGroups++;
    residualCents += value.cents;
    const bracket = assignSmallDollarBracket(value.cents);
    if (!bracket) continue;   // unreachable while admission is amount > 0
    const bKey = `${route}${KEY_FIELD_SEP}${recipient}${KEY_FIELD_SEP}${bracket}`;
    const row  = brackets.get(bKey);
    if (row) {
      row.donorCount++;
      row.totalCents += value.cents;
      row.txCount    += value.count;
    } else {
      brackets.set(bKey, {
        route:      route === ROUTE_CAND ? ROUTE_CAND : ROUTE_CMTE,
        recipient,
        bracket,
        donorCount: 1,
        totalCents: value.cents,
        txCount:    value.count,
      });
    }
  }
  if (curDonorEmits) donorRows++;   // the last donor never hits a key change

  const uniqueDonors = metaSorted.groupCount;
  const bracketRows  = [...brackets.values()];
  const result = makeExternalResult(aggSorted, metaSorted, bracketRows, sortDir);

  console.log(`    Lines read:                ${linesRead.toLocaleString()}`);
  console.log(`    Passed tx-type filter [${[...keepTxTypes].join(",")}]: ${passedTxType.toLocaleString()}`);
  console.log(`    Passed cmte lookup:        ${passedCmte.toLocaleString()}`);
  console.log(`      → candidate path:        ${passedCand.toLocaleString()}`);
  console.log(`      → committee path:        ${passedCommittee.toLocaleString()}`);
  console.log(`    Admitted (amount > 0):     ${passedAmount.toLocaleString()}`);
  console.log(`    Skipped org-shaped names:  ${skippedOrgShaped.toLocaleString()}`);
  console.log(`    Unique donors in file:     ${uniqueDonors.toLocaleString()}`);
  console.log(`    Donor rows to write:       ${donorRows.toLocaleString()}  (donors with ≥1 aggregate ≥ $${(MIN_AGGREGATE_CENTS / 100).toFixed(0)})`);
  console.log(`    Donor × candidate pairs:   ${candPairs.toLocaleString()}  (≥ floor)`);
  console.log(`    Donor × committee pairs:   ${cmtePairs.toLocaleString()}  (≥ floor)`);
  console.log(
    `    Sub-floor residual:        ${residualGroups.toLocaleString()} group(s) · ` +
    `$${(residualCents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })} · ` +
    `${bracketRows.length.toLocaleString()} (recipient × bracket) rollup row(s) (PR 3b)`,
  );

  result.stats = {
    linesRead, passedTxType, passedCmte, passedCand, passedCommittee, passedAmount,
    uniqueDonors, candPairs, cmtePairs, donorRows, residualGroups, residualCents,
  };
  const peak = aggSorter.stats.peakDiskBytes + metaSorter.stats.peakDiskBytes;
  result.stats.sort = { agg: aggSorter.stats, meta: metaSorter.stats, peakDiskBytes: peak };
  console.log(
    `    Sort: ${aggSorter.stats.runsWritten} agg run(s) + ${metaSorter.stats.runsWritten} meta run(s) · ` +
    `peak sort disk ${(peak / 1024 / 1024).toFixed(0)} MB · ` +
    `peak rss ${(process.memoryUsage.rss() / 1024 / 1024).toFixed(0)} MB (FIX-961)`,
  );

  return result;
}

// ---------------------------------------------------------------------------
// Result adapters
// ---------------------------------------------------------------------------

const EMPTY_STATS: IndivStreamStats = {
  linesRead: 0, passedTxType: 0, passedCmte: 0, passedCand: 0,
  passedCommittee: 0, passedAmount: 0, uniqueDonors: 0, candPairs: 0, cmtePairs: 0,
  donorRows: 0, residualGroups: 0, residualCents: 0,
};

/**
 * The emit side. Every accessor re-reads the merged sorted file and applies the
 * PR 3b aggregate floor, so a caller cannot accidentally consume the sub-floor
 * population: what these yield is exactly what gets written.
 */
function makeExternalResult(
  aggSorted:   SortedGroups<AggValue>,
  metaSorted:  SortedGroups<MetaValue>,
  bracketRows: SmallDollarBracketRow[],
  sortDir:     string,
): IndivStreamResult {
  return {
    stats: { ...EMPTY_STATS },

    async *readAggregations() {
      for await (const { key, value } of aggSorted) {
        if (value.cents < MIN_AGGREGATE_CENTS) continue;   // PR 3b emit floor
        const { fp, route, recipient } = splitAggKey(key);
        if (route !== ROUTE_CAND) continue;
        yield {
          donorFingerprint: fp,
          candId:           recipient,
          totalCents:       value.cents,
          txCount:          value.count,
          latestDate:       value.maxDt,
        };
      }
    },

    async *readCommitteeAggregations() {
      for await (const { key, value } of aggSorted) {
        if (value.cents < MIN_AGGREGATE_CENTS) continue;   // PR 3b emit floor
        const { fp, route, recipient } = splitAggKey(key);
        if (route !== ROUTE_CMTE) continue;
        yield {
          donorFingerprint: fp,
          cmteId:           recipient,
          totalCents:       value.cents,
          txCount:          value.count,
          latestDate:       value.maxDt,
        };
      }
    },

    readSmallDollarBrackets() { return bracketRows; },

    // Merge-join: both files are fingerprint-ordered, so the donor's cycle
    // total is summed on the fly. This is what removed the last O(donors) map
    // from the stage — the pre-FIX-961 code built a `cycleDonorTotals` Map over
    // every fingerprint before the donor upsert.
    //
    // PR 3b: the total sums ONLY above-floor groups, and a donor with none is
    // dropped (emit returns null, filtered below). Two reasons, and they are the
    // same reason: no FR row means no money to attribute, and
    // `total_donated_cents` must agree with the FR rows this run writes because
    // `rebuild_financial_entity_donation_totals()` re-derives it from exactly
    // those rows. Minting a donor entity for someone whose every group is
    // sub-floor would create a $0 individual with no relationships — a row that
    // shows up in search and dead-ends.
    async *readDonorInputs() {
      const joined = mergeJoinGrouped<MetaValue, AggValue, IndivDonorInput | null>(
        metaSorted, aggSorted, aggKeyDonor,
        (fp, meta, aggs) => {
          let total = 0;
          for (const a of aggs) if (a.cents >= MIN_AGGREGATE_CENTS) total += a.cents;
          if (total === 0) return null;
          return {
            fingerprint:       fp,
            displayName:       meta.displayName,
            city:              meta.city,
            state:             meta.state,
            zip5:              meta.zip5,
            employer:          meta.employer,
            occupation:        meta.occupation,
            totalDonatedCents: total,
          };
        },
      );
      for await (const d of joined) {
        if (d !== null) yield d;
      }
    },

    async dispose() {
      await aggSorted.dispose();
      await metaSorted.dispose();
      try { fs.rmSync(sortDir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}
