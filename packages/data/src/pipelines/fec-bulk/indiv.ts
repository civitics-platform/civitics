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
 * Leadership/joint-fundraising designations (D/B/J) stay excluded — their
 * money is split downstream and re-itemized via transfers, so capturing
 * them at the source would double-count.
 *
 * Donor identity: indiv has no donor ID. We dedupe on
 *   fingerprint = upper(NAME) collapsed + "|" + ZIP5
 * which is FEC's own near-duplicate convention. canonical_name embeds the
 * fingerprint so the existing UNIQUE(canonical_name, entity_type='individual')
 * dedup contract is honored.
 *
 * Memory: streams the file line-by-line, but holds the per-cycle
 * aggregation maps in RAM. With both candidate and committee paths
 * active (FIX-236), heap pressure roughly doubles vs. the FIX-181-only
 * shape — empirical OOM at ~3.4 GB mid-2026 with the default 4 GB cap.
 * Run with NODE_OPTIONS=--max-old-space-size=8192 for non-presidential
 * cycles; 12 GB recommended for presidential cycles.
 */

import * as fs       from "fs";
import * as path     from "path";
import * as readline from "readline";
import { extractZipEntryToDisk } from "./util";

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

// Transaction types we keep:
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
const KEEP_TX_TYPES = new Set(["15", "15E", "10"]);

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

export interface IndivStreamResult {
  aggregations:          Map<string, IndivAggregation>;          // key = `${fingerprint}|${candId}`
  committeeAggregations: Map<string, IndivCommitteeAggregation>; // key = `${fingerprint}|${cmteId}` (FIX-236)
  donorMetas:            Map<string, IndivDonorMeta>;            // key = fingerprint
  stats: {
    linesRead:        number;
    passedTxType:     number;
    passedCmte:       number;     // line had cmteId in EITHER candidate OR committee map
    passedCand:       number;     // routed to the candidate aggregation
    passedCommittee:  number;     // routed to the non-candidate-committee aggregation
    passedAmt:        number;
  };
}

// ---------------------------------------------------------------------------
// ccl parser
// ---------------------------------------------------------------------------

/**
 * Build the CMTE_ID → CAND_ID lookup. Multi-committee candidates (a
 * principal + several authorized) all collapse to the same CAND_ID, so an
 * indiv contribution to any of those committees attributes correctly.
 *
 * Excludes joint-fundraising and leadership committees (CMTE_DSGN ∈ {J, D, B})
 * because their donations are split downstream and would double-count if we
 * also pulled them in here.
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
// Stream indiv{yy}.zip → in-memory aggregations
// ---------------------------------------------------------------------------

export async function streamIndiv(
  zipPath:        string,
  cmteToCandId:   Map<string, string>,
  candidateSet:   Set<string>,
  nonCandCmtes:   Set<string>,    // FIX-236: super PAC / party / other-PAC CMTE_IDs (not in ccl P/A)
  tempDir:        string,
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

  const txtMb = (fs.statSync(txtPath).size / 1024 / 1024).toFixed(0);
  console.log(`    Extracted indiv text (${txtMb} MB) — streaming line by line...`);

  const aggregations          = new Map<string, IndivAggregation>();
  const committeeAggregations = new Map<string, IndivCommitteeAggregation>();
  const donorMetas            = new Map<string, IndivDonorMeta>();

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

  for await (const line of rl) {
    linesRead++;
    if (linesRead % 1_000_000 === 0) {
      console.log(
        `    ... ${linesRead.toLocaleString()} lines | ` +
        `${aggregations.size.toLocaleString()} cand pairs | ` +
        `${committeeAggregations.size.toLocaleString()} cmte pairs | ` +
        `${donorMetas.size.toLocaleString()} donors`,
      );
    }

    const cols   = line.split("|");
    const txType = (cols[INDIV_COL.TRANSACTION_TP] ?? "").trim();
    if (!KEEP_TX_TYPES.has(txType)) continue;
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

  console.log(`    Lines read:                ${linesRead.toLocaleString()}`);
  console.log(`    Passed 15/15E/10 filter:   ${passedTxType.toLocaleString()}`);
  console.log(`    Passed cmte lookup:        ${passedCmte.toLocaleString()}`);
  console.log(`      → candidate path:        ${passedCand.toLocaleString()}`);
  console.log(`      → committee path:        ${passedCommittee.toLocaleString()}`);
  console.log(`    Passed $200+ filter:       ${passedAmt.toLocaleString()}`);
  console.log(`    Skipped org-shaped names:  ${skippedOrgShaped.toLocaleString()}`);
  console.log(`    Unique donors:             ${donorMetas.size.toLocaleString()}`);
  console.log(`    Donor × candidate pairs:   ${aggregations.size.toLocaleString()}`);
  console.log(`    Donor × committee pairs:   ${committeeAggregations.size.toLocaleString()}`);

  try { fs.unlinkSync(txtPath); } catch { /* best effort */ }

  return {
    aggregations,
    committeeAggregations,
    donorMetas,
    stats: { linesRead, passedTxType, passedCmte, passedCand, passedCommittee, passedAmt },
  };
}
