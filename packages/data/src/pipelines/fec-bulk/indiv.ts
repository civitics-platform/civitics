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
 * The old in-memory path is still selectable via FEC_INDIV_AGG_MODE=memory —
 * it is what the equivalence harness (data:fec:indiv-equivalence) diffs the new
 * path against. PR 3b retires it.
 *
 * NOTE: this PR changes NO semantics. The per-transaction $200 floor
 * (MIN_AMT_DOLLARS) stays applied at parse time, exactly where it was; moving
 * it to emit time is PR 3b.
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

// FEC's itemization floor. Same threshold the pas2 pipeline uses post-FIX-182.
const MIN_AMT_DOLLARS = 200;

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
  passedAmt:        number;
  uniqueDonors:     number;
  candPairs:        number;
  cmtePairs:        number;
  /** FIX-961: external-sort accounting. Absent in mode="memory". */
  sort?: {
    agg:  ExternalSortStats;
    meta: ExternalSortStats;
    /** High-water of BOTH sorters' simultaneous on-disk footprint, bytes. */
    peakDiskBytes: number;
  };
}

/**
 * FIX-961: the stage's output is consumed through async iterators so neither
 * mode has to materialize a whole cycle. `mode="memory"` iterates the legacy
 * Maps; `mode="external"` re-reads the merged sort files (cheap — the merged
 * output is ~40 MB gzip'd for a presidential cycle).
 *
 * Every accessor is re-readable. `dispose()` removes the on-disk artifacts and
 * MUST be called when the cycle's writer stages are done.
 */
export interface IndivStreamResult {
  mode: IndivAggMode;
  /** Donor × candidate aggregates. In external mode, ordered by fingerprint. */
  readAggregations(): AsyncIterable<IndivAggregation>;
  /** Donor × non-cand-committee aggregates (FIX-236). */
  readCommitteeAggregations(): AsyncIterable<IndivCommitteeAggregation>;
  /** Donor meta joined to the donor's cycle total across both routes. */
  readDonorInputs(): AsyncIterable<IndivDonorInput>;
  dispose(): Promise<void>;
  stats: IndivStreamStats;
}

// ---------------------------------------------------------------------------
// FIX-961 — aggregation mode
// ---------------------------------------------------------------------------

export type IndivAggMode = "external" | "memory";

/**
 * Resolve the aggregation mechanism. Default `external` (the O(1)-in-cycle-size
 * path). `memory` restores the pre-FIX-961 in-RAM Maps and exists so the
 * equivalence harness can diff old against new; it is NOT a supported setting
 * for a presidential-cycle run and says so on stderr.
 */
export function resolveIndivAggMode(
  raw: string | undefined = process.env.FEC_INDIV_AGG_MODE,
): IndivAggMode {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "memory") return "memory";
  if (v && v !== "external") {
    console.warn(
      `    [fec-bulk:indiv] FEC_INDIV_AGG_MODE="${raw}" not recognized (expected external|memory) — using external`,
    );
  }
  return "external";
}

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
// FIX-961 / PR 3a. The parse, filter and projection below are byte-for-byte the
// pre-FIX-961 logic; only the ACCUMULATOR changed. Two accumulators exist:
//
//   external (default) — each surviving row is projected to two compact sorted
//     records and spilled to gzip'd runs; a k-way merge reduces them. Peak heap
//     is one sort buffer, independent of cycle size.
//   memory — the original three Maps. Kept callable for the equivalence
//     harness; PR 3b retires it.
//
// Both accumulators MUST produce the same aggregate set. The three folds are
// sum / count / lexicographic-max-over-non-empty (all associative and
// commutative) plus first-seen donor meta, which the external path preserves by
// carrying the row ordinal in the record and combining on min-ordinal.
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
  // FIX-961: accumulator selection. Defaults to FEC_INDIV_AGG_MODE / external.
  mode:           IndivAggMode = resolveIndivAggMode(),
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

  return streamIndivText(txtPath, cmteToCandId, candidateSet, nonCandCmtes, tempDir, keepTxTypes, mode, {
    deleteInputAfterStream: true,
  });
}

/** Knobs the equivalence harness needs and the pipeline does not. FIX-961. */
export interface StreamIndivTextOptions {
  /** Unlink the input text once the stream drains (the pipeline's behavior). */
  deleteInputAfterStream?: boolean;
  /** Stop after this many lines. Used to take a deterministic file slice. */
  maxLines?: number;
  /** Override the sort-buffer size — small values force multi-run merging. */
  sortBufferEntries?: number;
  /** Name the sort scratch dir, so two modes can run side by side. */
  sortDirName?: string;
}

/**
 * The stage proper, over an already-extracted indiv text file.
 *
 * Split out of `streamIndiv` by FIX-961 so the equivalence harness can drive a
 * deterministic slice through BOTH accumulators without materializing a zip.
 */
export async function streamIndivText(
  txtPath:        string,
  cmteToCandId:   Map<string, string>,
  candidateSet:   Set<string>,
  nonCandCmtes:   Set<string>,
  tempDir:        string,
  keepTxTypes:    Set<string> = parseKeepTxTypes(),
  mode:           IndivAggMode = resolveIndivAggMode(),
  opts:           StreamIndivTextOptions = {},
): Promise<IndivStreamResult> {
  const txtMb = (fs.statSync(txtPath).size / 1024 / 1024).toFixed(0);
  console.log(`    Extracted indiv text (${txtMb} MB) — streaming line by line...`);
  console.log(`    Tx-type filter: [${[...keepTxTypes].join(",")}]`);
  console.log(`    Aggregation mode: ${mode}${mode === "memory" ? "  ⚠ pre-FIX-961 in-RAM maps — heap scales with cycle size" : ""}`);

  // ── accumulators ────────────────────────────────────────────────────────
  // Exactly one of these pairs is live; the other stays empty.
  const aggregations          = new Map<string, IndivAggregation>();
  const committeeAggregations = new Map<string, IndivCommitteeAggregation>();
  const donorMetas            = new Map<string, IndivDonorMeta>();

  const sortDir = path.join(tempDir, opts.sortDirName ?? "indiv-sort");
  const bufferEntries = opts.sortBufferEntries ?? resolveSortBuffer();
  let aggSorter:  ExternalGroupSorter<AggValue>  | null = null;
  let metaSorter: ExternalGroupSorter<MetaValue> | null = null;
  if (mode === "external") {
    fs.mkdirSync(sortDir, { recursive: true });
    aggSorter  = new ExternalGroupSorter<AggValue>({
      tempDir: sortDir, name: "agg",  maxBufferEntries: bufferEntries, ...AGG_CODEC,
    });
    metaSorter = new ExternalGroupSorter<MetaValue>({
      // Meta collapses to one record per donor inside the buffer, so it holds
      // far more input rows per spill than the aggregate sorter does.
      tempDir: sortDir, name: "meta", maxBufferEntries: bufferEntries, ...META_CODEC,
    });
    console.log(`    Sort buffer: ${bufferEntries.toLocaleString()} keys/run · gzip level 1 · ${sortDir}`);
  }

  let linesRead = 0,
      passedTxType = 0,
      passedCmte = 0,
      passedCand = 0,
      passedCommittee = 0,
      passedAmt = 0,
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
      if (mode === "external") {
        console.log(
          `    ... ${linesRead.toLocaleString()} lines | ` +
          `${passedAmt.toLocaleString()} kept | ` +
          `${aggSorter!.stats.runsWritten}+${metaSorter!.stats.runsWritten} runs | ` +
          `rss ${(process.memoryUsage.rss() / 1024 / 1024).toFixed(0)} MB`,
        );
      } else {
        console.log(
          `    ... ${linesRead.toLocaleString()} lines | ` +
          `${aggregations.size.toLocaleString()} cand pairs | ` +
          `${committeeAggregations.size.toLocaleString()} cmte pairs | ` +
          `${donorMetas.size.toLocaleString()} donors`,
        );
      }
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
    // PR 3a keeps the per-transaction floor exactly here. PR 3b moves it to
    // emit time (a $200 AGGREGATE floor) — do not move it in this PR.
    if (isNaN(amt) || amt < MIN_AMT_DOLLARS) continue;
    passedAmt++;

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

    if (mode === "external") {
      // `linesRead` is the ordinal: strictly increasing, and its ORDER (not its
      // value) is what first-seen-wins depends on.
      if (metaSorter!.add(fp, {
        ordinal:     linesRead,
        // .slice() forces a flat copy so the record does not pin the whole
        // parent line through V8's sliced-string representation.
        displayName: name.slice(),
        city:        (cols[INDIV_COL.CITY]       ?? "").trim().slice(),
        state:       (cols[INDIV_COL.STATE]      ?? "").trim().toUpperCase(),
        zip5,
        employer:    (cols[INDIV_COL.EMPLOYER]   ?? "").trim().slice(),
        occupation:  (cols[INDIV_COL.OCCUPATION] ?? "").trim().slice(),
      })) await metaSorter!.spill();

      const route     = candId ? ROUTE_CAND : ROUTE_CMTE;
      const recipient = candId ?? cmteId;
      if (aggSorter!.add(compositeKey(fp, route, recipient), {
        cents: amtCents, count: 1, maxDt: dt || null,
      })) await aggSorter!.spill();
      continue;
    }

    // ── mode === "memory": the pre-FIX-961 path, unchanged ────────────────
    if (!donorMetas.has(fp)) {
      donorMetas.set(fp, {
        fingerprint: fp,
        displayName: name,
        city:        (cols[INDIV_COL.CITY]       ?? "").trim(),
        state:       (cols[INDIV_COL.STATE]      ?? "").trim().toUpperCase(),
        zip5,
        employer:    (cols[INDIV_COL.EMPLOYER]   ?? "").trim(),
        occupation:  (cols[INDIV_COL.OCCUPATION] ?? "").trim(),
      });
    }

    if (candId) {
      const aggKey  = `${fp}|${candId}`;
      const existing = aggregations.get(aggKey);
      if (existing) {
        existing.totalCents += amtCents;
        existing.txCount++;
        if (dt && dt > (existing.latestDate ?? "")) existing.latestDate = dt;
      } else {
        aggregations.set(aggKey, {
          donorFingerprint: fp,
          candId,
          totalCents:       amtCents,
          txCount:          1,
          latestDate:       dt || null,
        });
      }
    } else {
      const aggKey  = `${fp}|${cmteId}`;
      const existing = committeeAggregations.get(aggKey);
      if (existing) {
        existing.totalCents += amtCents;
        existing.txCount++;
        if (dt && dt > (existing.latestDate ?? "")) existing.latestDate = dt;
      } else {
        committeeAggregations.set(aggKey, {
          donorFingerprint: fp,
          cmteId,
          totalCents:       amtCents,
          txCount:          1,
          latestDate:       dt || null,
        });
      }
    }
  }

  // Released BEFORE the merge — a presidential cycle's extracted text is ~13 GB
  // and the merge wants that disk for its runs.
  if (opts.deleteInputAfterStream) {
    try { fs.unlinkSync(txtPath); } catch { /* best effort */ }
  }

  // ── finalize ────────────────────────────────────────────────────────────
  let result: IndivStreamResult;
  let uniqueDonors: number, candPairs: number, cmtePairs: number;

  if (mode === "external") {
    console.log(`    Merging sorted runs (${aggSorter!.stats.runsWritten} agg + ${metaSorter!.stats.runsWritten} meta)...`);
    const aggSorted  = await aggSorter!.finalize();
    const metaSorted = await metaSorter!.finalize();

    // One pass to split the aggregate groups by route — the same two counts the
    // map path printed. Cheap (the merged output is a few tens of MB gzip'd).
    candPairs = 0; cmtePairs = 0;
    for await (const { key } of aggSorted) {
      if (splitAggKey(key).route === ROUTE_CAND) candPairs++; else cmtePairs++;
    }
    uniqueDonors = metaSorted.groupCount;

    result = makeExternalResult(aggSorted, metaSorted, sortDir);
  } else {
    uniqueDonors = donorMetas.size;
    candPairs    = aggregations.size;
    cmtePairs    = committeeAggregations.size;
    result = makeMemoryResult(aggregations, committeeAggregations, donorMetas);
  }

  console.log(`    Lines read:                ${linesRead.toLocaleString()}`);
  console.log(`    Passed tx-type filter [${[...keepTxTypes].join(",")}]: ${passedTxType.toLocaleString()}`);
  console.log(`    Passed cmte lookup:        ${passedCmte.toLocaleString()}`);
  console.log(`      → candidate path:        ${passedCand.toLocaleString()}`);
  console.log(`      → committee path:        ${passedCommittee.toLocaleString()}`);
  console.log(`    Passed $200+ filter:       ${passedAmt.toLocaleString()}`);
  console.log(`    Skipped org-shaped names:  ${skippedOrgShaped.toLocaleString()}`);
  console.log(`    Unique donors:             ${uniqueDonors.toLocaleString()}`);
  console.log(`    Donor × candidate pairs:   ${candPairs.toLocaleString()}`);
  console.log(`    Donor × committee pairs:   ${cmtePairs.toLocaleString()}`);

  result.stats = {
    linesRead, passedTxType, passedCmte, passedCand, passedCommittee, passedAmt,
    uniqueDonors, candPairs, cmtePairs,
  };
  if (mode === "external") {
    const peak = aggSorter!.stats.peakDiskBytes + metaSorter!.stats.peakDiskBytes;
    result.stats.sort = { agg: aggSorter!.stats, meta: metaSorter!.stats, peakDiskBytes: peak };
    console.log(
      `    Sort: ${aggSorter!.stats.runsWritten} agg run(s) + ${metaSorter!.stats.runsWritten} meta run(s) · ` +
      `peak sort disk ${(peak / 1024 / 1024).toFixed(0)} MB · ` +
      `peak rss ${(process.memoryUsage.rss() / 1024 / 1024).toFixed(0)} MB (FIX-961)`,
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Result adapters
// ---------------------------------------------------------------------------

const EMPTY_STATS: IndivStreamStats = {
  linesRead: 0, passedTxType: 0, passedCmte: 0, passedCand: 0,
  passedCommittee: 0, passedAmt: 0, uniqueDonors: 0, candPairs: 0, cmtePairs: 0,
};

function makeExternalResult(
  aggSorted:  SortedGroups<AggValue>,
  metaSorted: SortedGroups<MetaValue>,
  sortDir:    string,
): IndivStreamResult {
  return {
    mode: "external",
    stats: { ...EMPTY_STATS },

    async *readAggregations() {
      for await (const { key, value } of aggSorted) {
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

    // Merge-join: both files are fingerprint-ordered, so the donor's cycle
    // total (across BOTH routes) is summed on the fly. This is what removed the
    // last O(donors) map from the stage — the pre-FIX-961 code built a
    // `cycleDonorTotals` Map over every fingerprint before the donor upsert.
    readDonorInputs() {
      return mergeJoinGrouped<MetaValue, AggValue, IndivDonorInput>(
        metaSorted, aggSorted, aggKeyDonor,
        (fp, meta, aggs) => {
          let total = 0;
          for (const a of aggs) total += a.cents;
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
    },

    async dispose() {
      await aggSorted.dispose();
      await metaSorted.dispose();
      try { fs.rmSync(sortDir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

function makeMemoryResult(
  aggregations:          Map<string, IndivAggregation>,
  committeeAggregations: Map<string, IndivCommitteeAggregation>,
  donorMetas:            Map<string, IndivDonorMeta>,
): IndivStreamResult {
  return {
    mode: "memory",
    stats: { ...EMPTY_STATS },

    async *readAggregations() { yield* aggregations.values(); },
    async *readCommitteeAggregations() { yield* committeeAggregations.values(); },

    async *readDonorInputs() {
      // The pre-FIX-961 shape, verbatim: sum both aggregation maps into a
      // per-donor total, then walk donorMetas in insertion order.
      const totals = new Map<string, number>();
      for (const agg of aggregations.values()) {
        totals.set(agg.donorFingerprint, (totals.get(agg.donorFingerprint) ?? 0) + agg.totalCents);
      }
      for (const agg of committeeAggregations.values()) {
        totals.set(agg.donorFingerprint, (totals.get(agg.donorFingerprint) ?? 0) + agg.totalCents);
      }
      for (const [fp, meta] of donorMetas.entries()) {
        yield { ...meta, totalDonatedCents: totals.get(fp) ?? 0 };
      }
    },

    async dispose() {
      aggregations.clear();
      committeeAggregations.clear();
      donorMetas.clear();
    },
  };
}
