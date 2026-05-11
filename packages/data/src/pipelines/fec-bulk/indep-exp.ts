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
// Public types
// ---------------------------------------------------------------------------

export interface IndepExpAggregation {
  spendingCmteId: string;
  candId:         string;
  supportOppose:  "S" | "O";    // raw FEC value
  totalCents:     number;
  txCount:        number;
  latestDate:     string | null; // ISO YYYY-MM-DD (already normalized from DD-MON-YY)
}

export interface IndepExpStreamResult {
  /** Key = `${spendingCmteId}|${candId}|${supportOppose}`. */
  aggregations: Map<string, IndepExpAggregation>;
  stats: {
    rowsRead:        number;
    passedSupOpp:    number; // sup_opp ∈ {S, O}
    passedCmteCand:  number; // both spe_id + cand_id present
    passedAmount:    number; // exp_amo parses to > 0
    passedCand:      number; // cand_id ∈ candidateSet
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
  cand_id?:   string;
  spe_id?:    string;
  exp_amo?:   string;
  exp_date?:  string;
  sup_opp?:   string;
}

// ---------------------------------------------------------------------------
// Stream the IE CSV → in-memory aggregations
// ---------------------------------------------------------------------------

export async function streamIndependentExpenditures(
  csvPath:      string,
  candidateSet: Set<string>,
): Promise<IndepExpStreamResult> {
  const aggregations = new Map<string, IndepExpAggregation>();

  let rowsRead       = 0;
  let passedSupOpp   = 0;
  let passedCmteCand = 0;
  let passedAmount   = 0;
  let passedCand     = 0;

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
    const candId         = (row.cand_id ?? "").trim();
    if (!spendingCmteId || !candId) continue;
    passedCmteCand++;

    const amt = parseFloat((row.exp_amo ?? "").trim());
    if (isNaN(amt) || amt <= 0) continue;
    passedAmount++;

    if (!candidateSet.has(candId)) continue;
    passedCand++;

    const dateIso = parseDdMonYy(row.exp_date);
    const amtCents = Math.round(amt * 100);
    const key      = `${spendingCmteId}|${candId}|${supOpp}`;

    const existing = aggregations.get(key);
    if (existing) {
      existing.totalCents += amtCents;
      existing.txCount++;
      if (dateIso && (!existing.latestDate || dateIso > existing.latestDate)) {
        existing.latestDate = dateIso;
      }
    } else {
      aggregations.set(key, {
        spendingCmteId,
        candId,
        supportOppose: supOpp as "S" | "O",
        totalCents:    amtCents,
        txCount:       1,
        latestDate:    dateIso,
      });
    }
  }

  console.log(`    Rows read:                 ${rowsRead.toLocaleString()}`);
  console.log(`    Passed sup_opp filter:     ${passedSupOpp.toLocaleString()}`);
  console.log(`    Passed cmte+cand filter:   ${passedCmteCand.toLocaleString()}`);
  console.log(`    Passed amount > 0 filter:  ${passedAmount.toLocaleString()}`);
  console.log(`    Passed candidateSet:       ${passedCand.toLocaleString()}`);
  console.log(`    Unique (cmte × cand × S/O): ${aggregations.size.toLocaleString()}`);

  return {
    aggregations,
    stats: { rowsRead, passedSupOpp, passedCmteCand, passedAmount, passedCand },
  };
}
