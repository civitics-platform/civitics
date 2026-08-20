/**
 * FEC indiv-stage ACCEPTANCE harness.
 *
 * ── What this file used to be ────────────────────────────────────────────────
 * FIX-961 / PR 3a's equivalence harness: it ran a slice of a real indiv file
 * through BOTH accumulators — `memory` (the pre-FIX-961 in-RAM Maps) and
 * `external` (sorted runs + k-way merge) — and asserted the emitted sets were
 * identical. That diff ran clean (zero divergence across every emitted set) and
 * PR 3a shipped. PR 3b then RETIRED the `memory` accumulator and its
 * FEC_INDIV_AGG_MODE flag, so there is no longer a second path to diff against
 * and the equivalence question is closed.
 *
 * ── What it is now ───────────────────────────────────────────────────────────
 * The acceptance instrument for PR 3b's semantics change. It drives the REAL
 * `streamIndivText` over a real file and reports what the stage will emit under
 * the $200 AGGREGATE floor, in exactly the units the phase-0 audit measured
 * (docs/audits/2026-08-18-fec-coverage-pr3a-phase0.md §2.3 / §2.4):
 *
 *   FR rows (donor × candidate, donor × committee), the dollars behind them,
 *   donor rows, and the sub-floor residual split by size bracket.
 *
 * A run whose numbers match the audit's is the acceptance check. A run that does
 * NOT match is a bug until explained.
 *
 * `--stage-only` is retained verbatim from PR 3a: it drains all accessors while
 * retaining nothing, so its peak RSS is the STAGE's, not the harness's. That is
 * the bounded-heap proof, and conflating the two is what made the first cut of
 * this harness unfalsifiable in the direction that flattered it.
 *
 * Recipient sets come from the real ccl/cm files, not the DB: `candidateSet` is
 * every CAND_ID in ccl (a SUPERSET of our matched officials, which is what makes
 * the totals comparable to the phase-0 script — the live pipeline narrows to
 * matched officials and so emits somewhat fewer candidate-route rows).
 *
 * Usage (from packages/data):
 *   tsx src/scripts/fec-indiv-equivalence.ts --txt <indiv.txt> --ccl <ccl.txt> --cm <cm.txt> [--lines N] [--buffer N]
 *   tsx src/scripts/fec-indiv-equivalence.ts --zip <indivNN.zip> --ccl-zip <cclNN.zip> --cm-zip <cmNN.zip>
 *   … --committee C00718866       restrict the report to one recipient committee
 *   … --stage-only                bounded-heap proof, no per-row retention
 *   … --json out.json             machine-readable result
 *
 * No DB connection. No prod. Local files only.
 */

import * as fs   from "fs";
import * as os   from "os";
import * as path from "path";

import {
  streamIndivText,
  parseCcl,
  parseKeepTxTypes,
  assignSmallDollarBracket,
  SMALL_DOLLAR_BRACKETS,
  MIN_AGGREGATE_CENTS,
  type SmallDollarBracketCode,
} from "../pipelines/fec-bulk/indiv";
import { parseCm24, buildNonCandRecipientSet } from "../pipelines/fec-bulk/index";
import { extractZipEntryToDisk } from "../pipelines/fec-bulk/util";

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const LINES  = parseInt(arg("lines")  ?? "0", 10) || Infinity;
const BUFFER = parseInt(arg("buffer") ?? "400000", 10);
const WORK   = arg("work") ?? path.join(os.tmpdir(), "fec-indiv-acceptance");

// ---------------------------------------------------------------------------
// peak-RSS sampler
// ---------------------------------------------------------------------------

class RssSampler {
  private timer: NodeJS.Timeout | null = null;
  peakRss = 0;
  peakHeapUsed = 0;
  start(): void {
    const tick = () => {
      const m = process.memoryUsage();
      if (m.rss > this.peakRss) this.peakRss = m.rss;
      if (m.heapUsed > this.peakHeapUsed) this.peakHeapUsed = m.heapUsed;
    };
    tick();
    this.timer = setInterval(tick, 50);
    this.timer.unref();
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}

const mb  = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const pad = (s: string | number, n: number) => String(s).padStart(n);

// ---------------------------------------------------------------------------
// inputs
// ---------------------------------------------------------------------------

async function resolveText(
  direct: string | undefined,
  zip: string | undefined,
  match: (n: string) => boolean,
  dest: string,
): Promise<string> {
  if (direct) return direct;
  if (!zip) throw new Error(`need --${path.basename(dest, ".txt")} or --${path.basename(dest, ".txt")}-zip`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    console.log(`  reusing extracted ${path.basename(dest)}`);
    return dest;
  }
  const ok = await extractZipEntryToDisk(zip, match, dest);
  if (!ok) throw new Error(`no matching entry in ${zip}`);
  return dest;
}

interface Bucket { groups: number; cents: number; tx: number }
const bucket = (): Bucket => ({ groups: 0, cents: 0, tx: 0 });

async function main(): Promise<void> {
  fs.mkdirSync(WORK, { recursive: true });

  const indivTxt = await resolveText(
    arg("txt"), arg("zip"),
    (n) => n.startsWith("itcont") || (n.startsWith("indiv") && n.endsWith(".txt")),
    path.join(WORK, "indiv.txt"),
  );
  const cclTxt = await resolveText(
    arg("ccl"), arg("ccl-zip"),
    (n) => n.startsWith("ccl") && n.endsWith(".txt"),
    path.join(WORK, "ccl.txt"),
  );
  const cmTxt = await resolveText(
    arg("cm"), arg("cm-zip"),
    (n) => n.startsWith("cm") && n.endsWith(".txt"),
    path.join(WORK, "cm.txt"),
  );

  const cmteToCandAll = parseCcl(fs.readFileSync(cclTxt));
  const candidateSet  = new Set(cmteToCandAll.values());
  const cmLookup      = parseCm24(fs.readFileSync(cmTxt));
  const nonCandCmtes  = buildNonCandRecipientSet(cmLookup, cmteToCandAll);

  // `--committee X` narrows BOTH recipient collections to X, mirroring the
  // FIX-701 FEC_INDIV_RECIPIENT_CMTES axis. That is what makes the Ossoff
  // numbers directly comparable to the phase-0 script's `--committee` pass.
  const onlyCmte = arg("committee")?.toUpperCase();
  const cmteToCand = new Map(cmteToCandAll);
  if (onlyCmte) {
    for (const k of [...cmteToCand.keys()]) if (k !== onlyCmte) cmteToCand.delete(k);
    for (const k of [...nonCandCmtes])      if (k !== onlyCmte) nonCandCmtes.delete(k);
  }

  console.log("─".repeat(78));
  console.log("PR 3b — indiv stage acceptance ($200 AGGREGATE floor, applied at emit)");
  console.log("─".repeat(78));
  console.log(`  indiv     : ${indivTxt} (${mb(fs.statSync(indivTxt).size)})`);
  console.log(`  scope     : ${onlyCmte ?? "ALL recipients (ccl P/A ∪ non-cand committees)"}`);
  console.log(`  lines     : ${LINES === Infinity ? "all" : LINES.toLocaleString()}   sort buffer: ${BUFFER.toLocaleString()} keys`);
  console.log(`  recipients: ${cmteToCand.size.toLocaleString()} cand cmtes / ${candidateSet.size.toLocaleString()} cand ids / ${nonCandCmtes.size.toLocaleString()} non-cand cmtes`);
  console.log(`  tx types  : [${[...parseKeepTxTypes()].join(",")}]`);
  console.log(`  floor     : ${usd(MIN_AGGREGATE_CENTS)} per (donor × recipient × cycle)`);
  console.log("");

  const sampler = new RssSampler();
  sampler.start();
  const t0 = Date.now();

  const res = await streamIndivText(
    indivTxt, cmteToCand, candidateSet, nonCandCmtes, WORK,
    parseKeepTxTypes(),
    { maxLines: LINES === Infinity ? undefined : LINES, sortBufferEntries: BUFFER, sortDirName: "sort-acceptance" },
  );
  const streamPeakRss = sampler.peakRss;
  const streamMs = Date.now() - t0;

  // ── stage-only: the bounded-heap proof ────────────────────────────────────
  // Drains every accessor while retaining NOTHING, so the peak RSS reported is
  // the stage's own. Any per-row retention here would be the harness's cost
  // masquerading as the pipeline's.
  const stageOnly = has("stage-only");

  const cand = bucket(), cmte = bucket();
  let donorRows = 0, donorCents = 0;

  for await (const a of res.readAggregations())          { cand.groups++; cand.cents += a.totalCents; cand.tx += a.txCount; }
  for await (const a of res.readCommitteeAggregations()) { cmte.groups++; cmte.cents += a.totalCents; cmte.tx += a.txCount; }
  for await (const d of res.readDonorInputs())           { donorRows++;   donorCents += d.totalDonatedCents; }

  const brackets = res.readSmallDollarBrackets();
  sampler.stop();
  const totalMs = Date.now() - t0;
  const stats = res.stats;

  // ── residual, folded to the audit's three bands ───────────────────────────
  const byBracket = new Map<SmallDollarBracketCode, Bucket>();
  for (const b of SMALL_DOLLAR_BRACKETS) byBracket.set(b.code, bucket());
  let residualGroups = 0, residualCents = 0;
  for (const r of brackets) {
    const b = byBracket.get(r.bracket)!;
    b.groups += r.donorCount;
    b.cents  += r.totalCents;
    b.tx     += r.txCount;
    residualGroups += r.donorCount;
    residualCents  += r.totalCents;
  }

  const frRows = cand.groups + cmte.groups;
  const frCents = cand.cents + cmte.cents;

  console.log("");
  console.log("─".repeat(78));
  console.log(`EMITTED — ${onlyCmte ?? "all recipients"} (one group = one financial_relationships row)`);
  console.log("─".repeat(78));
  console.log(`  donor × candidate rows        ${pad(cand.groups.toLocaleString(), 14)}   ${pad(usd(cand.cents), 18)}   ${pad(cand.tx.toLocaleString(), 12)} tx`);
  console.log(`  donor × committee rows        ${pad(cmte.groups.toLocaleString(), 14)}   ${pad(usd(cmte.cents), 18)}   ${pad(cmte.tx.toLocaleString(), 12)} tx`);
  console.log(`  ── FR rows total              ${pad(frRows.toLocaleString(), 14)}   ${pad(usd(frCents), 18)}`);
  console.log(`  donor entity rows             ${pad(donorRows.toLocaleString(), 14)}   ${pad(usd(donorCents), 18)}`);
  console.log(`  (donors in file, pre-floor)   ${pad(stats.uniqueDonors.toLocaleString(), 14)}`);
  console.log("");
  console.log(`  RESIDUAL — aggregate < ${usd(MIN_AGGREGATE_CENTS)}, bracketed not emitted`);
  console.log(`    ${"total".padEnd(24)} ${pad(residualGroups.toLocaleString(), 14)}   ${pad(usd(residualCents), 18)}`);
  for (const b of SMALL_DOLLAR_BRACKETS) {
    const v = byBracket.get(b.code)!;
    console.log(`    ${b.label.padEnd(24)} ${pad(v.groups.toLocaleString(), 14)}   ${pad(usd(v.cents), 18)}`);
  }
  console.log(`    rollup rows (recipient × bracket): ${brackets.length.toLocaleString()}`);
  console.log("");

  // Internal consistency — the stage's own counters must agree with what the
  // accessors actually yielded. A divergence here means the finalize pass and
  // the emit filters disagree about the floor, which would make every number
  // above unreliable.
  const checks: Array<[string, number, number]> = [
    ["stats.candPairs      vs emitted", stats.candPairs,      cand.groups],
    ["stats.cmtePairs      vs emitted", stats.cmtePairs,      cmte.groups],
    ["stats.donorRows      vs emitted", stats.donorRows,      donorRows],
    ["stats.residualGroups vs brackets", stats.residualGroups, residualGroups],
    ["stats.residualCents  vs brackets", stats.residualCents,  residualCents],
    ["Σ donor totals       vs Σ FR",     donorCents,           frCents],
  ];
  let mismatches = 0;
  console.log("─".repeat(78));
  console.log("SELF-CONSISTENCY");
  console.log("─".repeat(78));
  for (const [label, a, b] of checks) {
    const ok = a === b;
    if (!ok) mismatches++;
    console.log(`  ${label.padEnd(34)} ${pad(a.toLocaleString(), 16)} ${pad(b.toLocaleString(), 16)}  ${ok ? "✓" : "✗"}`);
  }
  // Every bracketed group must actually fall in its band.
  let misbracketed = 0;
  for (const r of brackets) {
    const avg = Math.round(r.totalCents / Math.max(1, r.donorCount));
    if (assignSmallDollarBracket(avg) === null && r.donorCount === 1) misbracketed++;
  }
  console.log(`  ${"singleton groups in-band".padEnd(34)} ${pad(brackets.length - misbracketed, 16)} ${pad(brackets.length, 16)}  ${misbracketed === 0 ? "✓" : "✗"}`);
  if (misbracketed > 0) mismatches++;
  console.log("");

  console.log("─".repeat(78));
  console.log("COST");
  console.log("─".repeat(78));
  console.log(`  lines read              ${pad(stats.linesRead.toLocaleString(), 16)}`);
  console.log(`  admitted (amount > 0)   ${pad(stats.passedAmount.toLocaleString(), 16)}`);
  console.log(`  peak RSS (stream)       ${pad(mb(streamPeakRss), 16)}`);
  console.log(`  peak RSS (incl. drain)  ${pad(mb(sampler.peakRss), 16)}${stageOnly ? "   ← bounded-heap proof" : ""}`);
  console.log(`  peak heapUsed           ${pad(mb(sampler.peakHeapUsed), 16)}`);
  console.log(`  stream ms               ${pad(streamMs.toLocaleString(), 16)}`);
  console.log(`  stream+drain ms         ${pad(totalMs.toLocaleString(), 16)}`);
  if (stats.sort) {
    console.log(`  sort runs (agg/meta)    ${pad(`${stats.sort.agg.runsWritten}/${stats.sort.meta.runsWritten}`, 16)}`);
    console.log(`  peak sort disk          ${pad(mb(stats.sort.peakDiskBytes), 16)}`);
  }
  console.log("");

  if (arg("json")) {
    fs.writeFileSync(arg("json")!, JSON.stringify({
      scope: onlyCmte ?? "all", lines: LINES === Infinity ? null : LINES, buffer: BUFFER,
      stats,
      emitted: {
        candRows: cand.groups, candCents: cand.cents, candTx: cand.tx,
        cmteRows: cmte.groups, cmteCents: cmte.cents, cmteTx: cmte.tx,
        frRows, frCents, donorRows, donorCents,
      },
      residual: {
        groups: residualGroups, cents: residualCents, rollupRows: brackets.length,
        byBracket: SMALL_DOLLAR_BRACKETS.map((b) => ({ ...b, ...byBracket.get(b.code)! })),
      },
      cost: {
        streamPeakRssBytes: streamPeakRss,
        peakRssBytes: sampler.peakRss,
        peakHeapBytes: sampler.peakHeapUsed,
        streamMs, totalMs,
      },
    }, null, 2));
    console.log(`  json → ${arg("json")}`);
  }

  await res.dispose();

  console.log(mismatches === 0
    ? "✓ SELF-CONSISTENT — compare the EMITTED block against the phase-0 audit for acceptance"
    : `✗ ${mismatches} internal inconsistency(ies) — the numbers above are NOT trustworthy`);
  process.exit(mismatches === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
