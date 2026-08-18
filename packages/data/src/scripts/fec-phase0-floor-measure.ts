/**
 * FIX-961 / PR 3a — phase-0 measurement rider. REPORT-ONLY.
 *
 * Nothing here changes behavior; it produces the number Craig's PR 3b go/no-go
 * reads. PR 3b's decided rule is a **$200 AGGREGATE** emit floor (with the
 * sub-floor residual bucketed by FEC-style size brackets). Today's rule is a
 * **$200 PER-TRANSACTION** floor applied at parse time. This script measures
 * the gap between them against real bulk data, using the FIX-961 external-sort
 * machinery so a floor-off pass (which keeps ~3-4× more rows) stays bounded.
 *
 * It answers, per recipient committee:
 *   - donors who emit TODAY, and by how much today's per-transaction floor
 *     UNDERSTATES their true cycle aggregate (they have both ≥$200 and <$200
 *     rows — the <$200 ones are silently dropped)
 *   - donors who emit NOTHING today but whose cycle aggregate reaches $200
 *     (every one of their rows is sub-floor) — these are NEW financial_
 *     relationships rows under PR 3b
 *   - the sub-$200-AGGREGATE residual — donors PR 3b buckets rather than emits
 *
 * The sub-$200 rows are in the bulk file at all because FEC's itemization rule
 * is per-donor-CYCLE-AGGREGATE, not per transaction: once a contributor passes
 * $200 cumulative, every later contribution is itemized however small. Those
 * rows are real, disclosed, and currently discarded.
 *
 * Usage (from packages/data):
 *   tsx src/scripts/fec-phase0-floor-measure.ts --txt <indiv.txt> --ccl <ccl.txt> --cm <cm.txt> \
 *       [--committee C00718866] [--all] [--json out.json] [--lines N]
 *
 *   --committee  restrict to one recipient committee (the Ossoff pass)
 *   --all        no restriction — every recipient in ccl/cm (the platform pass)
 *
 * No DB connection. Local files only.
 */

import * as fs   from "fs";
import * as os   from "os";
import * as path from "path";
import * as readline from "readline";

import {
  parseCcl,
  parseKeepTxTypes,
  donorFingerprint,
  isLikelyOrgName,
} from "../pipelines/fec-bulk/indiv";
import { parseCm24, buildNonCandRecipientSet } from "../pipelines/fec-bulk/index";
import { ExternalGroupSorter, compositeKey, KEY_FIELD_SEP } from "../lib/external-sort";

const INDIV_COL = {
  CMTE_ID: 0, TRANSACTION_TP: 5, NAME: 7, ZIP_CODE: 10, TRANSACTION_DT: 13, TRANSACTION_AMT: 14,
} as const;

/** FEC's own size brackets, the ones by_size reports and PR 3b will bucket by. */
const BRACKETS = [
  { label: "$0.01–$49.99",   lo: 1,      hi: 4_999 },
  { label: "$50–$99.99",     lo: 5_000,  hi: 9_999 },
  { label: "$100–$199.99",   lo: 10_000, hi: 19_999 },
] as const;

function arg(n: string): string | undefined {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (n: string) => process.argv.includes(`--${n}`);

const MIN_CENTS = 20_000;   // the $200 floor, in cents
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

/**
 * Per (donor × recipient) accumulator, floor OFF. Splits the dollars by which
 * side of today's per-transaction floor each row falls on, so both rules can be
 * evaluated from one pass.
 */
interface Cell {
  /** cents from rows ≥ $200 — what today's pipeline emits. */
  atOrAboveCents: number;
  atOrAboveRows:  number;
  /** cents from rows < $200 — what today's pipeline discards. */
  belowCents: number;
  belowRows:  number;
  /** Largest single row, cents. Used for the bracket histogram. */
  maxRowCents: number;
}

const CODEC = {
  encode: (v: Cell) => `${v.atOrAboveCents}\t${v.atOrAboveRows}\t${v.belowCents}\t${v.belowRows}\t${v.maxRowCents}`,
  decode: (s: string): Cell => {
    const f = s.split("\t");
    return {
      atOrAboveCents: +f[0]!, atOrAboveRows: +f[1]!,
      belowCents: +f[2]!, belowRows: +f[3]!, maxRowCents: +f[4]!,
    };
  },
  combine: (a: Cell, b: Cell): Cell => ({
    atOrAboveCents: a.atOrAboveCents + b.atOrAboveCents,
    atOrAboveRows:  a.atOrAboveRows  + b.atOrAboveRows,
    belowCents:     a.belowCents     + b.belowCents,
    belowRows:      a.belowRows      + b.belowRows,
    maxRowCents:    Math.max(a.maxRowCents, b.maxRowCents),
  }),
};

interface Bucket { donors: number; cents: number; rows: number }
const emptyBucket = (): Bucket => ({ donors: 0, cents: 0, rows: 0 });

async function main(): Promise<void> {
  const indivTxt = arg("txt");
  const cclTxt   = arg("ccl");
  const cmTxt    = arg("cm");
  if (!indivTxt || !cclTxt || !cmTxt) {
    console.error("need --txt <indiv.txt> --ccl <ccl.txt> --cm <cm.txt>");
    process.exit(2);
  }
  const onlyCmte = has("all") ? null : (arg("committee") ?? "C00718866").toUpperCase();
  const maxLines = parseInt(arg("lines") ?? "0", 10) || Infinity;
  const work     = arg("work") ?? path.join(os.tmpdir(), "fec-phase0");
  fs.mkdirSync(work, { recursive: true });

  const cmteToCand   = parseCcl(fs.readFileSync(cclTxt));
  const candidateSet = new Set(cmteToCand.values());
  const cmLookup     = parseCm24(fs.readFileSync(cmTxt));
  const nonCandCmtes = buildNonCandRecipientSet(cmLookup, cmteToCand);
  const keepTx       = parseKeepTxTypes();

  console.log("─".repeat(78));
  console.log("FIX-961 phase-0 — $200 per-transaction floor vs $200 aggregate floor (PR 3b)");
  console.log("─".repeat(78));
  console.log(`  indiv    : ${indivTxt} (${mb(fs.statSync(indivTxt).size)})`);
  console.log(`  scope    : ${onlyCmte ?? "ALL recipients (ccl P/A ∪ non-cand committees)"}`);
  console.log(`  tx types : [${[...keepTx].join(",")}]`);
  console.log("");

  const sorter = new ExternalGroupSorter<Cell>({
    tempDir: work, name: "phase0", maxBufferEntries: 400_000, ...CODEC,
  });

  let linesRead = 0, matchedCmte = 0, kept = 0, skippedOrg = 0, minDt = "", maxDt = "";
  const rl = readline.createInterface({
    input: fs.createReadStream(indivTxt, { encoding: "latin1" }), crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (linesRead >= maxLines) { rl.close(); break; }
    linesRead++;
    if (linesRead % 2_000_000 === 0) {
      console.log(`  ... ${linesRead.toLocaleString()} lines | ${kept.toLocaleString()} kept | rss ${mb(process.memoryUsage.rss())}`);
    }

    const cols = line.split("|");
    if (!keepTx.has((cols[INDIV_COL.TRANSACTION_TP] ?? "").trim())) continue;

    const cmteId = (cols[INDIV_COL.CMTE_ID] ?? "").trim();
    if (onlyCmte) {
      if (cmteId !== onlyCmte) continue;
    } else {
      const candId = cmteToCand.get(cmteId);
      if (candId) { if (!candidateSet.has(candId)) continue; }
      else if (!nonCandCmtes.has(cmteId)) continue;
    }
    matchedCmte++;

    // NO amount floor — that is the whole point of this pass.
    const amt = parseFloat((cols[INDIV_COL.TRANSACTION_AMT] ?? "").trim());
    if (isNaN(amt) || amt <= 0) continue;

    const name = (cols[INDIV_COL.NAME] ?? "").trim();
    if (!name) continue;
    const zipRaw = (cols[INDIV_COL.ZIP_CODE] ?? "").trim();
    const zip5 = zipRaw.length >= 5 ? zipRaw.slice(0, 5) : zipRaw;
    const fp = donorFingerprint(name, zip5);
    if (!fp) continue;
    const fpName = fp.includes("|") ? fp.slice(0, fp.indexOf("|")) : fp;
    if (isLikelyOrgName(fpName)) { skippedOrg++; continue; }

    const dt = (cols[INDIV_COL.TRANSACTION_DT] ?? "").trim();
    if (dt.length === 8) {
      const iso = dt.slice(4) + dt.slice(0, 4);          // MMDDYYYY → YYYYMMDD
      if (!minDt || iso < minDt) minDt = iso;
      if (iso > maxDt) maxDt = iso;
    }

    const cents = Math.round(amt * 100);
    const above = cents >= MIN_CENTS;
    kept++;
    // The recipient is part of the key: PR 3b's aggregate is per
    // (donor × recipient × cycle), which is exactly one FR row.
    const recipient = cmteToCand.get(cmteId) ?? cmteId;
    if (sorter.add(compositeKey(fp, recipient), {
      atOrAboveCents: above ? cents : 0,
      atOrAboveRows:  above ? 1 : 0,
      belowCents:     above ? 0 : cents,
      belowRows:      above ? 0 : 1,
      maxRowCents:    cents,
    })) await sorter.spill();
  }

  console.log(`  streamed ${linesRead.toLocaleString()} lines · ${matchedCmte.toLocaleString()} in scope · ${kept.toLocaleString()} kept (floor OFF) · ${skippedOrg.toLocaleString()} org-shaped dropped`);
  console.log(`  merging ${sorter.stats.runsWritten} run(s)...`);
  const groups = await sorter.finalize();

  // ── classify every (donor × recipient) cell ─────────────────────────────
  const emitsToday       = emptyBucket();   // ≥1 row ≥ $200
  let   emitsTodayTrue   = 0;               // their FULL aggregate (incl. sub-floor rows)
  let   understatedCells = 0;               // …of which also carry sub-floor rows
  const newlyEmits       = emptyBucket();   // 0 rows ≥ $200, aggregate ≥ $200
  const residual         = emptyBucket();   // aggregate < $200
  const residualBrackets = BRACKETS.map(() => emptyBucket());
  const donorsToday   = new Set<string>();
  const donorsNew     = new Set<string>();
  const donorsResidual = new Set<string>();

  for await (const { key, value: c } of groups) {
    const fp    = key.slice(0, key.indexOf(KEY_FIELD_SEP));
    const total = c.atOrAboveCents + c.belowCents;
    const rows  = c.atOrAboveRows + c.belowRows;
    if (c.atOrAboveRows > 0) {
      emitsToday.donors++; emitsToday.cents += c.atOrAboveCents; emitsToday.rows += c.atOrAboveRows;
      emitsTodayTrue += total;
      if (c.belowRows > 0) understatedCells++;
      donorsToday.add(fp);
    } else if (total >= MIN_CENTS) {
      newlyEmits.donors++; newlyEmits.cents += total; newlyEmits.rows += rows;
      donorsNew.add(fp);
    } else {
      residual.donors++; residual.cents += total; residual.rows += rows;
      donorsResidual.add(fp);
      for (let i = 0; i < BRACKETS.length; i++) {
        const b = BRACKETS[i]!;
        if (total >= b.lo && total <= b.hi) {
          residualBrackets[i]!.donors++; residualBrackets[i]!.cents += total; residualBrackets[i]!.rows += rows;
          break;
        }
      }
    }
  }

  const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);
  const allCents = emitsTodayTrue + newlyEmits.cents + residual.cents;
  const frToday  = emitsToday.donors;
  const frAfter  = emitsToday.donors + newlyEmits.donors;

  console.log("");
  console.log("─".repeat(78));
  console.log(`RESULT — ${onlyCmte ?? "all recipients"} (one row per financial_relationships row)`);
  console.log("─".repeat(78));
  console.log(`  FR rows emitted TODAY (≥1 tx ≥ $200)   ${frToday.toLocaleString().padStart(12)}   ${usd(emitsToday.cents).padStart(16)}`);
  console.log(`    …their TRUE cycle aggregate                        ${"".padStart(0)}   ${usd(emitsTodayTrue).padStart(16)}`);
  console.log(`    …understatement today                              ${"".padStart(0)}   ${usd(emitsTodayTrue - emitsToday.cents).padStart(16)}  (${pct(emitsTodayTrue - emitsToday.cents, emitsTodayTrue)} of their real total)`);
  console.log(`    …FR rows whose amount is understated   ${understatedCells.toLocaleString().padStart(12)}   ${pct(understatedCells, frToday).padStart(16)} of them`);
  console.log("");
  console.log(`  NEW FR rows under PR 3b (agg ≥ $200,`);
  console.log(`    no single tx ≥ $200)                 ${newlyEmits.donors.toLocaleString().padStart(12)}   ${usd(newlyEmits.cents).padStart(16)}`);
  console.log(`    …their tx rows                       ${newlyEmits.rows.toLocaleString().padStart(12)}`);
  console.log("");
  console.log(`  RESIDUAL — agg < $200, bucketed        ${residual.donors.toLocaleString().padStart(12)}   ${usd(residual.cents).padStart(16)}`);
  for (let i = 0; i < BRACKETS.length; i++) {
    const b = residualBrackets[i]!;
    console.log(`    ${BRACKETS[i]!.label.padEnd(36)} ${b.donors.toLocaleString().padStart(12)}   ${usd(b.cents).padStart(16)}`);
  }
  console.log("");
  console.log(`  FR row growth        ${frToday.toLocaleString()} → ${frAfter.toLocaleString()}   (+${(frAfter - frToday).toLocaleString()}, +${pct(frAfter - frToday, frToday)})`);
  console.log(`  dollars captured     ${usd(emitsToday.cents)} → ${usd(emitsTodayTrue + newlyEmits.cents)}   (+${pct(emitsTodayTrue + newlyEmits.cents - emitsToday.cents, emitsToday.cents)})`);
  console.log(`  dollars still unemitted (bucketed)     ${usd(residual.cents)}  (${pct(residual.cents, allCents)} of in-file itemized dollars)`);
  console.log("");
  console.log(`  file date span (TRANSACTION_DT): ${minDt || "—"} … ${maxDt || "—"}`);
  console.log(`  sort: ${sorter.stats.runsWritten} run(s), ${groups.groupCount.toLocaleString()} groups, peak disk ${mb(sorter.stats.peakDiskBytes)}, peak rss ${mb(process.memoryUsage.rss())}`);

  if (arg("json")) {
    fs.writeFileSync(arg("json")!, JSON.stringify({
      scope: onlyCmte ?? "all", linesRead, matchedCmte, kept, skippedOrg,
      dateSpan: { min: minDt, max: maxDt },
      emitsToday: { ...emitsToday, trueAggregateCents: emitsTodayTrue, understatedCells },
      newlyEmits, residual,
      residualBrackets: BRACKETS.map((b, i) => ({ label: b.label, ...residualBrackets[i]! })),
      frRows: { today: frToday, afterPr3b: frAfter },
      sort: sorter.stats,
    }, null, 2));
    console.log(`  json → ${arg("json")}`);
  }

  await groups.dispose();
}

main().catch((e) => { console.error(e); process.exit(1); });
