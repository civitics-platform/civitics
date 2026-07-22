/**
 * FIX-841 — streamer spender-name capture (opt-in `collectSpenderNames`).
 *
 * Runs via:  tsx --test src/pipelines/fec-bulk/indep-exp.test.ts
 *
 * The streamer aggregates Schedule E rows by (spe_id × cand_id × S/O). FIX-841
 * adds an opt-in that retains the `spe_nam` (spender/filer name) on each
 * aggregation so the backfill can MINT a name-only financial_entity for orphan
 * spenders (spe_id absent from both financial_entities and the cm{yy} master).
 * These tests pin: (a) default-off leaves the aggregation shape unchanged;
 * (b) the flag threads spe_nam onto both matched and unmatched aggregations;
 * (c) the first NON-EMPTY name wins when rows for one spe_id disagree; and
 * (d) the existing $50M junk bound + S/O split are unaffected by the new opt.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { streamIndependentExpenditures, isMintableSpenderName } from "./indep-exp";

// A matched target (in candidateSet) and an unmatched one (not in the set).
const MATCHED_CAND   = "H8FL26039";
const UNMATCHED_CAND = "S4NC00162";

const HEADER = "cand_id,cand_name,cand_office,cand_office_st,spe_id,spe_nam,exp_amo,exp_date,sup_opp";

/** Write `rows` (already CSV-joined lines) to a temp file, run the streamer, delete the file. */
async function runOnCsv(
  lines: string[],
  candidateSet: Set<string>,
  opts: Parameters<typeof streamIndependentExpenditures>[2],
): Promise<Awaited<ReturnType<typeof streamIndependentExpenditures>>> {
  const p = path.join(os.tmpdir(), `ie-841-test-${process.pid}-${lines.length}-${Math.round(lines[0].length)}.csv`);
  fs.writeFileSync(p, [HEADER, ...lines].join("\n") + "\n");
  try {
    return await streamIndependentExpenditures(p, candidateSet, opts);
  } finally {
    try { fs.unlinkSync(p); } catch { /* ok */ }
  }
}

const row = (cand: string, spe: string, speNam: string, amt: string, so: string) =>
  `${cand},"DOE, JOHN",H,FL,${spe},"${speNam}",${amt},27-SEP-24,${so}`;

test("FIX-841 default (no collectSpenderNames) leaves spenderName undefined", async () => {
  const r = await runOnCsv(
    [row(MATCHED_CAND, "C00111111", "SUPER PAC ALPHA", "1000.00", "S")],
    new Set([MATCHED_CAND]),
    {},
  );
  const agg = [...r.aggregations.values()][0];
  assert.equal(agg.spenderName, undefined, "spenderName must be absent when the opt is off");
  assert.equal(agg.totalCents, 100_000);
});

test("FIX-841 collectSpenderNames threads spe_nam onto matched aggregations", async () => {
  const r = await runOnCsv(
    [row(MATCHED_CAND, "C00111111", "SUPER PAC ALPHA", "1000.00", "S")],
    new Set([MATCHED_CAND]),
    { collectSpenderNames: true },
  );
  const agg = [...r.aggregations.values()][0];
  assert.equal(agg.spenderName, "SUPER PAC ALPHA");
});

test("FIX-841 collectSpenderNames threads spe_nam onto unmatched aggregations", async () => {
  const r = await runOnCsv(
    [row(UNMATCHED_CAND, "C00222222", "ORPHAN IE FILER", "2500.00", "O")],
    new Set([MATCHED_CAND]), // UNMATCHED_CAND deliberately absent
    { collectUnmatched: true, collectSpenderNames: true },
  );
  assert.equal(r.aggregations.size, 0, "unmatched target must not land in the matched set");
  const u = [...(r.unmatchedAggregations ?? new Map()).values()][0];
  assert.ok(u, "unmatched aggregation present");
  assert.equal(u.spenderName, "ORPHAN IE FILER");
  assert.equal(u.supportOppose, "O");
});

test("FIX-841 first NON-EMPTY spe_nam wins across rows for one (spe × cand × S/O)", async () => {
  // Same aggregation key; first row has a blank name, second carries it.
  const r = await runOnCsv(
    [
      row(MATCHED_CAND, "C00333333", "",            "500.00", "S"),
      row(MATCHED_CAND, "C00333333", "LATE NAMER",  "500.00", "S"),
    ],
    new Set([MATCHED_CAND]),
    { collectSpenderNames: true },
  );
  const agg = [...r.aggregations.values()][0];
  assert.equal(agg.spenderName, "LATE NAMER", "empty first name is backfilled from a later row");
  assert.equal(agg.totalCents, 100_000, "both rows still aggregate");
  assert.equal(agg.txCount, 2);
});

test("FIX-841 isMintableSpenderName — non-empty real names mint, blank does not", () => {
  assert.equal(isMintableSpenderName("Casey Family Farms"), true);
  assert.equal(isMintableSpenderName("SPIRIT OF REFORMING AMERICA"), true);
  assert.equal(isMintableSpenderName(""), false);
  assert.equal(isMintableSpenderName("   "), false);
  assert.equal(isMintableSpenderName(undefined), false);
});

test("FIX-841 isMintableSpenderName — known prankster names are denylisted (normalized match)", () => {
  // Exact, and robust to case / punctuation / spacing variants.
  assert.equal(isMintableSpenderName("WARREN BUFFET APPLE INC."), false);
  assert.equal(isMintableSpenderName("warren buffet apple inc"), false);
  assert.equal(isMintableSpenderName("  Warren   Buffet  Apple   Inc  "), false);
  assert.equal(isMintableSpenderName("Bettis, Shawn"), false);
  assert.equal(isMintableSpenderName("The Court of Divine Justice"), false);
  // A real committee whose name merely CONTAINS a denylisted substring still mints
  // (the match is on the whole normalized name, not a substring).
  assert.equal(isMintableSpenderName("WARREN COUNTY DEMOCRATS"), true);
});

test("FIX-841 spender-name capture does not disturb the $50M junk bound", async () => {
  const r = await runOnCsv(
    [
      row(MATCHED_CAND, "C00444444", "REAL PAC",  "1000000.00",  "S"), // $1M — kept
      row(MATCHED_CAND, "C00444444", "FAKE FILER", "999999999.00", "S"), // ~$1B — rejected
    ],
    new Set([MATCHED_CAND]),
    { collectSpenderNames: true },
  );
  assert.equal(r.stats.rejectedHighAmount, 1, "the billion-dollar row is still rejected");
  const agg = [...r.aggregations.values()][0];
  assert.equal(agg.totalCents, 100_000_000, "only the $1M row survives");
  assert.equal(agg.spenderName, "REAL PAC");
});
