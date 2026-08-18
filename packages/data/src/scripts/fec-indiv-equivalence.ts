/**
 * FIX-961 / PR 3a — equivalence harness for the indiv-stage accumulator swap.
 *
 * Runs a deterministic slice of a REAL indiv file through both accumulators —
 * `memory` (the pre-FIX-961 in-RAM Maps) and `external` (sorted runs + k-way
 * merge) — and asserts the emitted aggregate sets are identical: same keys,
 * same sums, same tx counts, same latest dates, same donor rows, same totals.
 *
 * This PR changes NO semantics, so the expected diff is EMPTY. Any divergence
 * is a bug in the new path until proven otherwise.
 *
 * It also records what the swap was for: peak RSS per mode, and the external
 * path's on-disk high-water.
 *
 * Usage (from packages/data):
 *   tsx src/scripts/fec-indiv-equivalence.ts --txt <indiv.txt> --ccl <ccl.txt> --cm <cm.txt> [--lines N] [--buffer N]
 *   tsx src/scripts/fec-indiv-equivalence.ts --zip <indivNN.zip> --ccl-zip <cclNN.zip> --cm-zip <cmNN.zip> [--lines N]
 *
 * The recipient sets come from the real ccl/cm files, not the DB: `candidateSet`
 * is every CAND_ID in ccl (a superset of our matched officials, which maximizes
 * the rows under test) and `nonCandCmtes` is the production
 * buildNonCandRecipientSet. Routing is therefore the real routing; what is under
 * test is the accumulator.
 *
 * No DB connection. No prod. Local files only.
 */

import * as fs   from "fs";
import * as os   from "os";
import * as path from "path";
import { spawnSync } from "child_process";

import {
  streamIndivText,
  parseCcl,
  parseKeepTxTypes,
  type IndivStreamResult,
  type IndivStreamStats,
  type IndivAggregation,
  type IndivCommitteeAggregation,
  type IndivDonorInput,
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

const LINES  = parseInt(arg("lines")  ?? "3000000", 10);
const BUFFER = parseInt(arg("buffer") ?? "25000", 10);   // small ⇒ many runs ⇒ real merge
const WORK   = arg("work") ?? path.join(os.tmpdir(), "fec-indiv-equivalence");

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

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

// ---------------------------------------------------------------------------
// collection — the emitted sets, keyed exactly as the writers key them
// ---------------------------------------------------------------------------

interface Collected {
  cand:  Map<string, string>;   // `${fp}|${candId}` → "cents|count|latestDate"
  cmte:  Map<string, string>;   // `${fp}|${cmteId}` → "cents|count|latestDate"
  donor: Map<string, string>;   // fp → "name|city|state|zip|employer|occupation|total"
  candOrder:  string[];
  cmteOrder:  string[];
  donorOrder: string[];
}

const aggRow = (a: IndivAggregation | IndivCommitteeAggregation) =>
  `${a.totalCents}|${a.txCount}|${a.latestDate ?? "∅"}`;

const donorRow = (d: IndivDonorInput) =>
  [d.displayName, d.city, d.state, d.zip5, d.employer, d.occupation, d.totalDonatedCents].join("|");

async function collect(res: IndivStreamResult): Promise<Collected> {
  const out: Collected = {
    cand: new Map(), cmte: new Map(), donor: new Map(),
    candOrder: [], cmteOrder: [], donorOrder: [],
  };
  for await (const a of res.readAggregations()) {
    const k = `${a.donorFingerprint}|${a.candId}`;
    if (out.cand.has(k)) throw new Error(`[${res.mode}] duplicate candidate group emitted: ${k}`);
    out.cand.set(k, aggRow(a));
    out.candOrder.push(k);
  }
  for await (const a of res.readCommitteeAggregations()) {
    const k = `${a.donorFingerprint}|${a.cmteId}`;
    if (out.cmte.has(k)) throw new Error(`[${res.mode}] duplicate committee group emitted: ${k}`);
    out.cmte.set(k, aggRow(a));
    out.cmteOrder.push(k);
  }
  for await (const d of res.readDonorInputs()) {
    if (out.donor.has(d.fingerprint)) throw new Error(`[${res.mode}] duplicate donor emitted: ${d.fingerprint}`);
    out.donor.set(d.fingerprint, donorRow(d));
    out.donorOrder.push(d.fingerprint);
  }
  return out;
}

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

interface Divergence { set: string; key: string; oldValue: string | null; newValue: string | null }

function diffMaps(label: string, a: Map<string, string>, b: Map<string, string>): Divergence[] {
  const out: Divergence[] = [];
  for (const [k, v] of a) {
    const w = b.get(k);
    if (w === undefined)  out.push({ set: label, key: k, oldValue: v, newValue: null });
    else if (w !== v)     out.push({ set: label, key: k, oldValue: v, newValue: w });
  }
  for (const [k, v] of b) {
    if (!a.has(k)) out.push({ set: label, key: k, oldValue: null, newValue: v });
  }
  return out;
}

function sum(m: Map<string, string>, field: number): number {
  let t = 0;
  for (const v of m.values()) t += Number(v.split("|")[field]);
  return t;
}

// ---------------------------------------------------------------------------
// inputs
// ---------------------------------------------------------------------------

async function resolveText(direct: string | undefined, zip: string | undefined, match: (n: string) => boolean, dest: string): Promise<string> {
  if (direct) return direct;
  if (!zip) throw new Error(`need one of --${path.basename(dest, ".txt")} / --${path.basename(dest, ".txt")}-zip`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    console.log(`  reusing extracted ${path.basename(dest)}`);
    return dest;
  }
  const ok = await extractZipEntryToDisk(zip, match, dest);
  if (!ok) throw new Error(`no matching entry in ${zip}`);
  return dest;
}

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

  console.log("─".repeat(78));
  console.log("FIX-961 / PR 3a — indiv accumulator equivalence");
  console.log("─".repeat(78));
  console.log(`  indiv : ${indivTxt} (${mb(fs.statSync(indivTxt).size)})`);
  console.log(`  lines : ${LINES.toLocaleString()}   sort buffer: ${BUFFER.toLocaleString()} keys`);

  const cmteToCand = parseCcl(fs.readFileSync(cclTxt));
  const candidateSet = new Set(cmteToCand.values());
  const cmLookup     = parseCm24(fs.readFileSync(cmTxt));
  const nonCandCmtes = buildNonCandRecipientSet(cmLookup, cmteToCand);
  console.log(`  recipients: ${cmteToCand.size.toLocaleString()} cand cmtes / ${candidateSet.size.toLocaleString()} cand ids / ${nonCandCmtes.size.toLocaleString()} non-cand cmtes`);
  console.log(`  tx types  : [${[...parseKeepTxTypes()].join(",")}]`);
  console.log("");

  const runOne = async (mode: "memory" | "external") => {
    const s = new RssSampler();
    s.start();
    const t0 = Date.now();
    const res = await streamIndivText(
      indivTxt, cmteToCand, candidateSet, nonCandCmtes, WORK,
      parseKeepTxTypes(), mode,
      { maxLines: LINES, sortBufferEntries: BUFFER, sortDirName: `sort-${mode}` },
    );
    const streamMs = Date.now() - t0;
    // Peak RSS of the STAGE, sampled before the harness's own collection Maps
    // (which are the same cost in both modes and would swamp the comparison).
    const stagePeakRss = s.peakRss, stagePeakHeap = s.peakHeapUsed;
    const got = await collect(res);
    const totalMs = Date.now() - t0;
    s.stop();
    const stats = res.stats;
    await res.dispose();
    return {
      mode, got, stats, streamMs, totalMs,
      stagePeakRss, stagePeakHeap,
      peakRss: s.peakRss, peakHeap: s.peakHeapUsed,
    };
  };

  // ── one mode per process ────────────────────────────────────────────────
  // `--only <mode>` runs a single accumulator and dumps a canonical digest.
  // The parent below spawns two of these. Running both in ONE process makes
  // the RSS comparison meaningless: mode-1's garbage stays resident (RSS never
  // returns to the OS), so mode-2 always looks worse than it is. The first cut
  // of this harness had exactly that flaw and reported external as the heavier
  // path on a slice where it holds ~1/40th the live set.
  // `--stage-only <mode>` measures the STAGE and nothing else: it drains all
  // three accessors counting and summing, never retaining a row. The `--only`
  // path below builds the full comparison Maps (2.2M rows on a full cycle),
  // which is the harness's cost, not the pipeline's — conflating the two makes
  // the memory claim unfalsifiable in the direction that flatters it.
  const stageOnly = arg("stage-only") as "memory" | "external" | undefined;
  if (stageOnly) {
    const s = new RssSampler();
    s.start();
    const t0 = Date.now();
    const res = await streamIndivText(
      indivTxt, cmteToCand, candidateSet, nonCandCmtes, WORK,
      parseKeepTxTypes(), stageOnly,
      { maxLines: LINES, sortBufferEntries: BUFFER, sortDirName: `stage-${stageOnly}` },
    );
    const streamPeak = s.peakRss;
    let nCand = 0, nCmte = 0, nDonor = 0, cents = 0;
    for await (const a of res.readAggregations())          { nCand++;  cents += a.totalCents; }
    for await (const a of res.readCommitteeAggregations()) { nCmte++;  cents += a.totalCents; }
    for await (const d of res.readDonorInputs())           { nDonor++; }
    s.stop();
    await res.dispose();
    console.log(`  STAGE-ONLY mode=${stageOnly}  cand=${nCand.toLocaleString()} cmte=${nCmte.toLocaleString()} donors=${nDonor.toLocaleString()} Σcents=${cents.toLocaleString()}`);
    console.log(`  peak RSS during stream: ${mb(streamPeak)}   peak RSS incl. drain: ${mb(s.peakRss)}   heap peak: ${mb(s.peakHeapUsed)}   ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    if (res.stats.sort) console.log(`  sort: ${res.stats.sort.agg.runsWritten}+${res.stats.sort.meta.runsWritten} runs, peak disk ${mb(res.stats.sort.peakDiskBytes)}`);
    process.exit(0);
  }

  const only = arg("only") as "memory" | "external" | undefined;
  if (only) {
    console.log(`▶ mode=${only} (isolated process)`);
    const r = await runOne(only);
    const dump = arg("dump");
    if (dump) {
      const lines: string[] = [];
      for (const [k, v] of [...r.got.cand].sort()) lines.push(`C\t${k}\t${v}`);
      for (const [k, v] of [...r.got.cmte].sort()) lines.push(`M\t${k}\t${v}`);
      for (const [k, v] of [...r.got.donor].sort()) lines.push(`D\t${k}\t${v}`);
      fs.writeFileSync(dump, lines.join("\n"));
      fs.writeFileSync(`${dump}.meta.json`, JSON.stringify({
        mode: only, stats: r.stats,
        cost: {
          stagePeakRssBytes: r.stagePeakRss, stagePeakHeapBytes: r.stagePeakHeap,
          harnessPeakRssBytes: r.peakRss,
          streamMs: r.streamMs, totalMs: r.totalMs,
        },
        counts: { cand: r.got.cand.size, cmte: r.got.cmte.size, donor: r.got.donor.size },
      }, null, 2));
      console.log(`  dump → ${dump} (${lines.length.toLocaleString()} rows, ${mb(fs.statSync(dump).size)})`);
    }
    process.exit(0);
  }

  const child = (mode: string, dump: string) => {
    const argv = [process.argv[1]!, "--only", mode, "--dump", dump,
      "--txt", indivTxt, "--ccl", cclTxt, "--cm", cmTxt,
      "--lines", String(LINES), "--buffer", String(BUFFER), "--work", WORK];
    const r = spawnSync(process.execPath, ["--import", "tsx", ...argv], {
      stdio: "inherit", env: process.env,
    });
    if (r.status !== 0) throw new Error(`mode=${mode} child exited ${r.status}`);
    return {
      dump,
      meta: JSON.parse(fs.readFileSync(`${dump}.meta.json`, "utf8")) as {
        stats: IndivStreamStats;
        cost: { stagePeakRssBytes: number; stagePeakHeapBytes: number; harnessPeakRssBytes: number; streamMs: number; totalMs: number };
      },
    };
  };

  // memory first: it is the reference, and running it first means the external
  // run cannot be flattered by a warm page cache the reference did not get.
  const oldChild = child("memory", path.join(WORK, "dump-memory.tsv"));
  console.log("");
  const newChild = child("external", path.join(WORK, "dump-external.tsv"));
  console.log("");

  const loadDump = (p: string): Collected => {
    const out: Collected = { cand: new Map(), cmte: new Map(), donor: new Map(), candOrder: [], cmteOrder: [], donorOrder: [] };
    const raw = fs.readFileSync(p, "utf8");
    if (raw) for (const line of raw.split("\n")) {
      const i = line.indexOf("\t"), j = line.lastIndexOf("\t");
      const tag = line.slice(0, i), key = line.slice(i + 1, j), val = line.slice(j + 1);
      (tag === "C" ? out.cand : tag === "M" ? out.cmte : out.donor).set(key, val);
    }
    return out;
  };

  const oldRun = { got: loadDump(oldChild.dump), stats: oldChild.meta.stats, ...oldChild.meta.cost };
  const newRun = { got: loadDump(newChild.dump), stats: newChild.meta.stats, ...newChild.meta.cost };

  // ── diff ───────────────────────────────────────────────────────────────
  const divergences = [
    ...diffMaps("donor×candidate", oldRun.got.cand,  newRun.got.cand),
    ...diffMaps("donor×committee", oldRun.got.cmte,  newRun.got.cmte),
    ...diffMaps("donor",           oldRun.got.donor, newRun.got.donor),
  ];

  console.log("─".repeat(78));
  console.log("EQUIVALENCE");
  console.log("─".repeat(78));
  const rows: Array<[string, number | string, number | string]> = [
    ["lines read",              oldRun.stats.linesRead,       newRun.stats.linesRead],
    ["passed tx-type",          oldRun.stats.passedTxType,    newRun.stats.passedTxType],
    ["passed cmte lookup",      oldRun.stats.passedCmte,      newRun.stats.passedCmte],
    ["  → candidate path",      oldRun.stats.passedCand,      newRun.stats.passedCand],
    ["  → committee path",      oldRun.stats.passedCommittee, newRun.stats.passedCommittee],
    ["passed $200 floor",       oldRun.stats.passedAmt,       newRun.stats.passedAmt],
    ["donor×candidate groups",  oldRun.got.cand.size,         newRun.got.cand.size],
    ["donor×committee groups",  oldRun.got.cmte.size,         newRun.got.cmte.size],
    ["donor rows",              oldRun.got.donor.size,        newRun.got.donor.size],
    ["Σ cand cents",            sum(oldRun.got.cand, 0),      sum(newRun.got.cand, 0)],
    ["Σ cmte cents",            sum(oldRun.got.cmte, 0),      sum(newRun.got.cmte, 0)],
    ["Σ cand txCount",          sum(oldRun.got.cand, 1),      sum(newRun.got.cand, 1)],
    ["Σ cmte txCount",          sum(oldRun.got.cmte, 1),      sum(newRun.got.cmte, 1)],
    ["Σ donor totalCents",      sum(oldRun.got.donor, 6),     sum(newRun.got.donor, 6)],
  ];
  const pad = (s: string | number, n: number) => String(s).padStart(n);
  console.log(`  ${"metric".padEnd(24)} ${pad("memory", 16)} ${pad("external", 16)}  ok`);
  let statMismatch = 0;
  for (const [k, a, b] of rows) {
    const ok = String(a) === String(b);
    if (!ok) statMismatch++;
    console.log(`  ${k.padEnd(24)} ${pad(typeof a === "number" ? a.toLocaleString() : a, 16)} ${pad(typeof b === "number" ? b.toLocaleString() : b, 16)}  ${ok ? "✓" : "✗"}`);
  }
  console.log("");
  console.log(`  per-key divergences: ${divergences.length}`);
  for (const d of divergences.slice(0, 25)) {
    console.log(`    [${d.set}] ${d.key}\n       memory  : ${d.oldValue ?? "<absent>"}\n       external: ${d.newValue ?? "<absent>"}`);
  }
  if (divergences.length > 25) console.log(`    … and ${divergences.length - 25} more`);

  // Emission ORDER is not part of the contract (the writers key by content),
  // but report it — external emits fingerprint-sorted, memory emits in
  // first-seen order, and a reader should not be surprised by that.
  const orderSame = oldRun.got.candOrder.join(" ") === newRun.got.candOrder.join(" ");
  console.log(`  emission order identical: ${orderSame ? "yes" : "no (expected — external emits fingerprint-sorted)"}`);

  // ── cost ───────────────────────────────────────────────────────────────
  console.log("");
  console.log("─".repeat(78));
  console.log("COST");
  console.log("─".repeat(78));
  console.log(`  ${"".padEnd(24)} ${pad("memory", 16)} ${pad("external", 16)}`);
  console.log(`  ${"stage peak RSS".padEnd(24)} ${pad(mb(oldRun.stagePeakRssBytes), 16)} ${pad(mb(newRun.stagePeakRssBytes), 16)}`);
  console.log(`  ${"stage peak heapUsed".padEnd(24)} ${pad(mb(oldRun.stagePeakHeapBytes), 16)} ${pad(mb(newRun.stagePeakHeapBytes), 16)}`);
console.log(`  ${"process peak RSS".padEnd(24)} ${pad(mb(oldRun.harnessPeakRssBytes), 16)} ${pad(mb(newRun.harnessPeakRssBytes), 16)}`);
  console.log(`  ${"stream ms".padEnd(24)} ${pad(oldRun.streamMs.toLocaleString(), 16)} ${pad(newRun.streamMs.toLocaleString(), 16)}`);
  console.log(`  ${"stream+drain ms".padEnd(24)} ${pad(oldRun.totalMs.toLocaleString(), 16)} ${pad(newRun.totalMs.toLocaleString(), 16)}`);
  const srt = newRun.stats.sort;
  if (srt) {
    console.log(`  ${"sort runs (agg/meta)".padEnd(24)} ${pad("—", 16)} ${pad(`${srt.agg.runsWritten}/${srt.meta.runsWritten}`, 16)}`);
    console.log(`  ${"peak sort disk".padEnd(24)} ${pad("0 B", 16)} ${pad(mb(srt.peakDiskBytes), 16)}`);
    console.log(`  ${"bytes written (agg)".padEnd(24)} ${pad("0 B", 16)} ${pad(mb(srt.agg.bytesWritten), 16)}`);
    console.log(`  ${"bytes written (meta)".padEnd(24)} ${pad("0 B", 16)} ${pad(mb(srt.meta.bytesWritten), 16)}`);
  }
  console.log("");

  const failed = divergences.length > 0 || statMismatch > 0;
  console.log(failed
    ? `✗ NOT EQUIVALENT — ${statMismatch} stat mismatch(es), ${divergences.length} per-key divergence(s)`
    : "✓ EQUIVALENT — zero divergence across every emitted set");

  if (arg("json")) {
    fs.writeFileSync(arg("json")!, JSON.stringify({
      lines: LINES, buffer: BUFFER,
      stats: { memory: oldRun.stats, external: newRun.stats },
      counts: Object.fromEntries(rows.map(([k, a, b]) => [k, { memory: a, external: b }])),
      cost: {
        memory:   { stagePeakRssBytes: oldRun.stagePeakRssBytes, stagePeakHeapBytes: oldRun.stagePeakHeapBytes, processPeakRssBytes: oldRun.harnessPeakRssBytes, streamMs: oldRun.streamMs, totalMs: oldRun.totalMs },
        external: { stagePeakRssBytes: newRun.stagePeakRssBytes, stagePeakHeapBytes: newRun.stagePeakHeapBytes, processPeakRssBytes: newRun.harnessPeakRssBytes, streamMs: newRun.streamMs, totalMs: newRun.totalMs, sort: srt },
      },
      divergences,
    }, null, 2));
    console.log(`  json → ${arg("json")}`);
  }

  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
