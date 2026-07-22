/**
 * FEC Schedule E — independent expenditures (FIX-240).
 *
 * Source: independent_expenditure_{cycle}.csv (~19 MB for 2024). Unlike the
 * other FEC bulk files this one is a plain comma-delimited CSV with a
 * header row, not pipe-delimited, so we stream through csv-parse rather
 * than splitting on '|' by hand. Dates come in "DD-MON-YY" form (e.g.
 * "27-SEP-24") instead of the MMDDYYYY string the rest of FEC uses.
 *
 * The streamer aggregates by (spending committee × candidate × cycle ×
 * support_oppose). Support and oppose stay distinct because they are
 * politically opposite — collapsing them would erase signal.
 *
 * Per FIX-240 design (see plan/foamy-hopping-meerkat.md), the writer
 * routes each aggregate to relationship_type='ie_support' or 'ie_oppose'.
 * The graph derivation in rebuild_entity_connections() folds ie_support
 * into the 'donation' edge derivation but NOT ie_oppose — opposing money
 * is not a donation.
 *
 * Memory: tens of thousands of unique (spe × cand × S/O) triples per
 * cycle. Negligible vs. the indiv stage's 8 GB heap.
 */

import * as fs   from "fs";
import { parse } from "csv-parse";

// ---------------------------------------------------------------------------
// Upper sanity bound on a single Schedule E transaction (FIX-A)
// ---------------------------------------------------------------------------
//
// FEC's public Schedule E corpus carries vexatious / fake filings — e.g. fake
// committees ("THE COURT OF DIVINE JUSTICE", "THE COMMITTEE OF 300",
// "Republican Emo Girl") and a serial prankster filing $1B–$9.98B
// "independent expenditures" under names like "Bettis, Shawn" / "Warren Buffet
// Apple Inc". These are genuine source rows — NOT a parse error; the CSV
// columns align cleanly (zero wrong-width rows) and exp_amo literally holds the
// billion-dollar value — so the only durable defense is an amount sanity bound.
// The largest *real* single 2024 Schedule E disbursement is ~$30M (Make America
// Great Again Inc.); the junk starts at $114M/row. $50M sits cleanly in that
// gap: it rejects every observed junk row while preserving the realistic
// ceiling. Rejected rows are counted and surfaced in the run log so any future
// junk above the bound stays visible.
const MAX_IE_AMOUNT_DOLLARS = 50_000_000;

// ---------------------------------------------------------------------------
// Known vexatious / prankster filer names — orphan-spender mint denylist (FIX-841)
// ---------------------------------------------------------------------------
//
// The $50M/row bound above screens the billion-dollar prank filings, but a
// residue of the SAME serial-prankster corpus lands UNDER the per-row bound —
// e.g. a ~$3M "WARREN BUFFET APPLE INC." (note the misspelled Buffett) IE in the
// 2026 file. That does not matter for a matched target whose spender is already a
// real committee, but when the FIX-841 orphan-spender mint keys a NEW entity off
// `spe_nam` alone (spe_id absent from both financial_entities and the cm master),
// a prankster name would mint a junk committee. Screen those by NORMALIZED name.
// Legit-but-odd real filers (a C9 Form-5 filer like "Casey Family Farms") are
// deliberately NOT here — only names the FEC prankster corpus is known to use.
function normalizeSpenderName(raw: string | undefined): string {
  return (raw ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

const IE_SPENDER_NAME_DENYLIST: ReadonlySet<string> = new Set(
  [
    "WARREN BUFFET APPLE INC",      // misspelled Buffett — serial prankster
    "BETTIS SHAWN",                 // serial prankster (documented above)
    "THE COURT OF DIVINE JUSTICE",  // fake committee
    "THE COMMITTEE OF 300",         // fake committee
    "REPUBLICAN EMO GIRL",          // fake committee
  ].map(normalizeSpenderName),
);

/**
 * FIX-841 — a Schedule E `spe_nam` is mintable as an orphan-spender entity iff it
 * is non-empty after trim AND not a known vexatious/prankster filer name. Shared
 * by the backfill (backfill-ie-841.ts) and the nightly IE-stage rider so the
 * denylist has one source of truth.
 */
export function isMintableSpenderName(name: string | undefined): boolean {
  const norm = normalizeSpenderName(name);
  if (!norm) return false;
  return !IE_SPENDER_NAME_DENYLIST.has(norm);
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IndepExpAggregation {
  spendingCmteId: string;
  candId:         string;
  supportOppose:  "S" | "O";    // raw FEC value
  totalCents:     number;
  txCount:        number;
  latestDate:     string | null; // ISO YYYY-MM-DD (already normalized from DD-MON-YY)
  /**
   * FIX-841 — the Schedule E `spe_nam` (spending committee / filer name),
   * populated ONLY when `opts.collectSpenderNames` is set. Default off so the
   * nightly IE stage's aggregation shape and memory profile are unchanged. The
   * FIX-841 backfill uses it to MINT a name-only financial_entity for spenders
   * whose spe_id appears in NEITHER financial_entities NOR the cm{yy} committee
   * master — the last identity source for orphan Schedule E spenders. First
   * non-empty value wins across the rows that aggregate into this key.
   */
  spenderName?:   string;
}

/**
 * FIX-674: an unmatched-target aggregation. Same shape as a matched
 * aggregation, plus the FEC-file identity fields the resolve-or-mint step needs
 * to create a `tier='candidate'` official for a target that isn't in our
 * officials set yet. `candId` is already uppercase-normalized.
 */
export interface UnmatchedIndepExpAggregation extends IndepExpAggregation {
  candName:   string; // FEC "LASTNAME, FIRST" (raw)
  candOffice: string; // H / S / P if present in the file, else ""
  candState:  string; // 2-letter postal if present in the file, else ""
}

export interface IndepExpStreamResult {
  /** Key = `${spendingCmteId}|${candId}|${supportOppose}`. */
  aggregations: Map<string, IndepExpAggregation>;
  /**
   * FIX-674: aggregations whose target cand_id was NOT in `candidateSet`.
   * Populated only when `opts.collectUnmatched` is set. Same key shape as
   * `aggregations`. The IE stage resolves-or-mints these targets and merges
   * them back into the write set so their money is captured rather than dropped.
   */
  unmatchedAggregations?: Map<string, UnmatchedIndepExpAggregation>;
  /**
   * Per-cand dropped totals (cents). Populated only when
   * `opts.collectDroppedByCand` is set — used by the `data:analyze:ie-drop`
   * diagnostic (FIX-B) to surface which unmatched target candidates hide the
   * most IE money. Key = uppercase FEC cand_id.
   */
  droppedByCand?: Map<string, number>;
  stats: {
    rowsRead:              number;
    passedSupOpp:          number; // sup_opp ∈ {S, O}
    passedCmteCand:        number; // both spe_id + cand_id present
    rejectedHighAmount:    number; // count of exp_amo > MAX_IE_AMOUNT_DOLLARS — junk (FIX-A)
    rejectedHighCents:     number; // Σ amount of those junk rows               (FIX-A)
    passedAmount:          number; // exp_amo parses to > 0 AND ≤ bound
    passedCand:            number; // cand_id ∈ candidateSet
    keptCents:             number; // Σ amount for rows passing candidateSet     (FIX-B)
    droppedUnmatchedCents: number; // Σ amount for valid rows w/ cand_id ∉ set   (FIX-B)
  };
}

// ---------------------------------------------------------------------------
// Date parsing — "DD-MON-YY" → "YYYY-MM-DD"
// ---------------------------------------------------------------------------

const MONTHS: Record<string, string> = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04",
  MAY: "05", JUN: "06", JUL: "07", AUG: "08",
  SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

function parseDdMonYy(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  // Expected form: "27-SEP-24" — 9 chars, two dashes
  if (s.length !== 9) return null;
  const dd  = s.slice(0, 2);
  const mon = s.slice(3, 6).toUpperCase();
  const yy  = s.slice(7, 9);
  const mm  = MONTHS[mon];
  if (!mm || !/^\d{2}$/.test(dd) || !/^\d{2}$/.test(yy)) return null;
  // FEC's two-digit years are post-2000 throughout the modern Schedule E
  // corpus (file format introduced 2009). Hard-coding the 20XX prefix is
  // safer than a sliding-window pivot that could mis-date a refiled 1990s
  // amendment if FEC ever republishes one.
  return `20${yy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// CSV row shape (after csv-parse with columns:true)
// ---------------------------------------------------------------------------

interface IeRow {
  cand_id?:        string;
  cand_name?:      string; // FIX-674 — identity for minting unmatched targets
  cand_office?:    string; // FIX-674 — "H"/"S"/"P" (often blank; derived from cand_id as fallback)
  cand_office_st?: string; // FIX-674 — 2-letter postal (often blank; derived from cand_id)
  spe_id?:         string;
  spe_nam?:        string; // FIX-841 — spending committee / filer name (Schedule E)
  exp_amo?:        string;
  exp_date?:       string;
  sup_opp?:        string;
}

// ---------------------------------------------------------------------------
// Stream the IE CSV → in-memory aggregations
// ---------------------------------------------------------------------------

export async function streamIndependentExpenditures(
  csvPath:      string,
  candidateSet: Set<string>,
  opts:         {
    collectDroppedByCand?: boolean;
    collectUnmatched?:     boolean;
    // FIX-841: retain the Schedule E spe_nam on each aggregation so the backfill
    // can mint name-only entities for orphan spenders (spe_id ∉ cm ∪ entities).
    // Default off — nightly IE-stage behavior and memory profile unchanged.
    collectSpenderNames?:  boolean;
  } = {},
): Promise<IndepExpStreamResult> {
  const aggregations = new Map<string, IndepExpAggregation>();
  const captureSpenderName = opts.collectSpenderNames === true;

  let rowsRead              = 0;
  let passedSupOpp          = 0;
  let passedCmteCand        = 0;
  let rejectedHighAmount    = 0;
  let rejectedHighCents     = 0;
  let passedAmount          = 0;
  let passedCand            = 0;
  let keptCents             = 0;
  let droppedUnmatchedCents = 0;
  const droppedByCand = opts.collectDroppedByCand
    ? new Map<string, number>()
    : undefined;
  // FIX-674: unmatched-target aggregations, so the IE stage can resolve-or-mint
  // the target and capture the money instead of dropping it.
  const unmatchedAggregations = opts.collectUnmatched
    ? new Map<string, UnmatchedIndepExpAggregation>()
    : undefined;

  const parser = fs.createReadStream(csvPath).pipe(
    parse({
      columns:          true,
      skip_empty_lines: true,
      relax_quotes:     true,
      relax_column_count: true,
      trim:             true,
    }),
  );

  for await (const row of parser as AsyncIterable<IeRow>) {
    rowsRead++;
    if (rowsRead % 50_000 === 0) {
      console.log(
        `    ... ${rowsRead.toLocaleString()} rows | ` +
        `${aggregations.size.toLocaleString()} (cmte×cand×S/O) keys`,
      );
    }

    const supOpp = (row.sup_opp ?? "").trim().toUpperCase();
    if (supOpp !== "S" && supOpp !== "O") continue;
    passedSupOpp++;

    const spendingCmteId = (row.spe_id  ?? "").trim();
    // FIX-674: uppercase-normalize the target id. FEC candidate ids are
    // canonically uppercase (H8FL26039); a handful of Schedule E rows carry a
    // lowercased id ("s4nc00162") that would otherwise miss candidateSet — and
    // any minted row — on a pure case difference.
    const candId         = (row.cand_id ?? "").trim().toUpperCase();
    if (!spendingCmteId || !candId) continue;
    passedCmteCand++;

    // FIX-841: spender name, captured only when requested. Kept even when empty
    // so the merge below can fill it from a later row that does carry a name.
    const spenderNam = captureSpenderName ? (row.spe_nam ?? "").trim() : "";

    const amt = parseFloat((row.exp_amo ?? "").trim());
    if (isNaN(amt) || amt <= 0) continue;
    // Upper sanity bound — reject vexatious / fake billion-dollar filings (FIX-A).
    if (amt > MAX_IE_AMOUNT_DOLLARS) {
      rejectedHighAmount++;
      rejectedHighCents += Math.round(amt * 100);
      continue;
    }
    passedAmount++;

    const amtCents = Math.round(amt * 100);

    // FIX-B instrumentation: quantify how much *valid* IE money the
    // matched-official filter hides. droppedUnmatchedCents accumulates rows
    // that are well-formed (valid amount, present cmte + cand) but whose
    // target candidate isn't one of our matched officials.
    if (!candidateSet.has(candId)) {
      droppedUnmatchedCents += amtCents;
      if (droppedByCand) {
        droppedByCand.set(candId, (droppedByCand.get(candId) ?? 0) + amtCents);
      }
      // FIX-674: retain the unmatched aggregation (with FEC identity) so the IE
      // stage can resolve-or-mint the target and capture the money.
      if (unmatchedAggregations) {
        const dateIsoU = parseDdMonYy(row.exp_date);
        const keyU     = `${spendingCmteId}|${candId}|${supOpp}`;
        const existingU = unmatchedAggregations.get(keyU);
        if (existingU) {
          existingU.totalCents += amtCents;
          existingU.txCount++;
          if (dateIsoU && (!existingU.latestDate || dateIsoU > existingU.latestDate)) {
            existingU.latestDate = dateIsoU;
          }
          if (captureSpenderName && !existingU.spenderName && spenderNam) {
            existingU.spenderName = spenderNam;
          }
        } else {
          unmatchedAggregations.set(keyU, {
            spendingCmteId,
            candId,
            supportOppose: supOpp as "S" | "O",
            totalCents:    amtCents,
            txCount:       1,
            latestDate:    dateIsoU,
            candName:      (row.cand_name      ?? "").trim(),
            candOffice:    (row.cand_office    ?? "").trim().toUpperCase(),
            candState:     (row.cand_office_st ?? "").trim().toUpperCase(),
            ...(captureSpenderName ? { spenderName: spenderNam } : {}),
          });
        }
      }
      continue;
    }
    passedCand++;
    keptCents += amtCents;

    const dateIso = parseDdMonYy(row.exp_date);
    const key      = `${spendingCmteId}|${candId}|${supOpp}`;

    const existing = aggregations.get(key);
    if (existing) {
      existing.totalCents += amtCents;
      existing.txCount++;
      if (dateIso && (!existing.latestDate || dateIso > existing.latestDate)) {
        existing.latestDate = dateIso;
      }
      if (captureSpenderName && !existing.spenderName && spenderNam) {
        existing.spenderName = spenderNam;
      }
    } else {
      aggregations.set(key, {
        spendingCmteId,
        candId,
        supportOppose: supOpp as "S" | "O",
        totalCents:    amtCents,
        txCount:       1,
        latestDate:    dateIso,
        ...(captureSpenderName ? { spenderName: spenderNam } : {}),
      });
    }
  }

  const usd = (cents: number) =>
    `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

  console.log(`    Rows read:                 ${rowsRead.toLocaleString()}`);
  console.log(`    Passed sup_opp filter:     ${passedSupOpp.toLocaleString()}`);
  console.log(`    Passed cmte+cand filter:   ${passedCmteCand.toLocaleString()}`);
  console.log(`    Rejected exp_amo > $${(MAX_IE_AMOUNT_DOLLARS / 1e6).toFixed(0)}M:  ${rejectedHighAmount.toLocaleString()}`);
  console.log(`    Passed amount filter:      ${passedAmount.toLocaleString()}`);
  console.log(`    Passed candidateSet:       ${passedCand.toLocaleString()}`);
  console.log(`    Kept $ (matched officials):   ${usd(keptCents)}`);
  console.log(`    Dropped $ (unmatched target): ${usd(droppedUnmatchedCents)}`);
  console.log(`    Unique (cmte × cand × S/O): ${aggregations.size.toLocaleString()}`);
  if (unmatchedAggregations) {
    console.log(`    Unmatched (cmte × cand × S/O): ${unmatchedAggregations.size.toLocaleString()} — will resolve-or-mint (FIX-674)`);
  }

  return {
    aggregations,
    unmatchedAggregations,
    droppedByCand,
    stats: {
      rowsRead,
      passedSupOpp,
      passedCmteCand,
      rejectedHighAmount,
      rejectedHighCents,
      passedAmount,
      passedCand,
      keptCents,
      droppedUnmatchedCents,
    },
  };
}
