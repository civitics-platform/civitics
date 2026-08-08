/**
 * FIX-995 — measure the donor-stage heap copies this PR removed.
 *
 * NO DATABASE. Synthesises an 840,338-row donor population with realistic
 * string lengths (the cycle-2026 count from prod `fec_bulk_run_state`:
 * donor-entities total_rows = 840,338) and measures, with `global.gc()` between
 * every snapshot, the three structures the PR deletes:
 *
 *   A. the writer's dedupe CLONE          — `merged.set(fp, { ...input })`
 *                                           vs storing by reference
 *   B. the accumulated `returned` array   — 840k {id, donor_fingerprint} rows,
 *                                           each with a fresh 36-char uuid,
 *                                           vs the per-chunk callback fold
 *   C. the retained `donorMetas` map      — held live through the whole 4-stage
 *                                           writer run, vs `.clear()`ed once
 *                                           donorInputs is built
 *
 * WHAT THIS DOES NOT CLAIM: the 2026-08-03..08-08 nightly deaths were job
 * timeouts, one lost runner and one human cancel — NOT a V8 heap OOM (no
 * `Reached heap limit` appears in any retrievable log). So these numbers are
 * about GC pressure and live-set size, not about avoiding an OOM. Read them as
 * "how much of the donor population was being kept alive for no reason".
 *
 * Run:
 *   pnpm --filter @civitics/data data:measure:donor-heap
 *   (or: node --expose-gc --import tsx src/scripts/measure-donor-stage-heap.ts)
 *
 * Without --expose-gc it refuses to run rather than print numbers polluted by
 * uncollected garbage.
 */

import { mergeIndividualDonorInputs } from "../pipelines/fec-bulk/writer";
import type { IndividualDonorInput } from "../pipelines/fec-bulk/writer";

// Cycle-2026 donor count, from prod pipeline_state.fec_bulk_run_state
// (stages['donor-entities'].total_rows) as of 2026-08-08.
const N = 840_338;
const CHUNK = 4000; // DEFAULT_CHUNK in lib/direct-pg-upsert.ts

const MB = 1024 * 1024;

/**
 * Module-scope sink. V8's scope analysis drops a local as soon as its LAST use
 * is behind the current instruction pointer, so `inputs` was being collected
 * mid-measurement and one block reported a 236 MB *saving* that was really the
 * donor population disappearing. Parking a reference here is the fix: the
 * population stays reachable for the whole run, exactly as it does in the
 * pipeline, where it is live across all four writer stages.
 */
const RETAIN: unknown[] = [];
function keepAlive(v: unknown): void {
  RETAIN[0] = v;
}

function gc(): void {
  const g = (globalThis as { gc?: () => void }).gc;
  if (!g) throw new Error("run with --expose-gc");
  // Two passes: the first can leave freshly-unreachable objects in the young
  // generation, the second sweeps them.
  g();
  g();
}

function heapMb(): number {
  gc();
  return process.memoryUsage().heapUsed / MB;
}

function line(label: string, mb: number): void {
  console.log(`  ${label.padEnd(52)} ${mb.toFixed(1).padStart(8)} MB`);
}

function delta(label: string, before: number, after: number): void {
  const d = after - before;
  const pct = before > 0 ? ` (${((d / before) * 100).toFixed(1)}%)` : "";
  console.log(`  ${label.padEnd(52)} ${d >= 0 ? "+" : ""}${d.toFixed(1).padStart(7)} MB${pct}`);
}

/** Realistic field widths, sampled from the FEC indiv format. */
function makeDonor(i: number): IndividualDonorInput {
  const seq = String(i).padStart(7, "0");
  return {
    fingerprint: `MCLAUGHLIN, KATHERINE ${seq}|9${seq.slice(0, 4)}`,
    displayName: `MCLAUGHLIN, KATHERINE ${seq}`,
    city: "SAN FRANCISCO",
    state: "CA",
    zip5: `9${seq.slice(0, 4)}`,
    employer: "SELF-EMPLOYED CONSULTING GROUP LLC",
    occupation: "SOFTWARE ENGINEER",
    totalDonatedCents: 250_00 + (i % 90_000),
  };
}

/** A 36-char uuid-shaped string, freshly allocated per row (as pg returns). */
function fakeUuid(i: number): string {
  const h = (i >>> 0).toString(16).padStart(8, "0");
  return `${h}-1f2e-4c3b-9a8d-${h}00${h.slice(0, 2)}`;
}

async function main(): Promise<void> {
  gc();
  const baseline = heapMb();
  console.log(`\nFIX-995 donor-stage heap measurement — N = ${N.toLocaleString()} donors\n`);
  line("baseline (empty process)", baseline);

  // ── Build the population once. This is the FLOOR: donorInputs itself is not
  //    removable, it is the rows the stage exists to write. ─────────────────
  const inputs: IndividualDonorInput[] = new Array(N);
  for (let i = 0; i < N; i++) inputs[i] = makeDonor(i);
  keepAlive(inputs); // see RETAIN — without this V8 collects it mid-run
  const afterInputs = heapMb();
  line("after building donorInputs (irreducible floor)", afterInputs);
  delta("  cost of donorInputs", baseline, afterInputs);

  // ── A. dedupe: clone (OLD) vs by-reference (NEW) ─────────────────────────
  console.log("\nA. writer dedupe map");
  {
    // OLD: merged.set(input.fingerprint, { ...input })
    const oldMerged = new Map<string, IndividualDonorInput>();
    for (const input of inputs) if (!oldMerged.has(input.fingerprint)) oldMerged.set(input.fingerprint, { ...input });
    keepAlive([inputs, oldMerged]);
    const afterOld = heapMb();
    delta("  OLD (clone per donor)", afterInputs, afterOld);
    oldMerged.clear();
  }
  gc();
  {
    // NEW: the shipped mergeIndividualDonorInputs — stores by reference.
    const newMerged = mergeIndividualDonorInputs(inputs);
    keepAlive([inputs, newMerged]);
    const afterNew = heapMb();
    delta("  NEW (by reference)", afterInputs, afterNew);
    if (newMerged.size !== N) throw new Error(`dedupe lost rows: ${newMerged.size} != ${N}`);
    newMerged.clear();
  }
  gc();

  // ── B. RETURNING rows: accumulate (OLD) vs per-chunk fold (NEW) ──────────
  console.log("\nB. RETURNING rows from the financial_entities upsert");
  const beforeB = heapMb();
  {
    // OLD: bulkUpsert pushed every chunk's rows into `returned`, then writer.ts
    // folded the whole array into the map at the end.
    const returned: Array<Record<string, unknown>> = [];
    for (let i = 0; i < N; i += CHUNK) {
      const end = Math.min(i + CHUNK, N);
      const rows: Array<Record<string, unknown>> = [];
      for (let j = i; j < end; j++) rows.push({ id: fakeUuid(j), donor_fingerprint: inputs[j]!.fingerprint });
      returned.push(...rows);
    }
    const map = new Map<string, string>();
    for (const r of returned) map.set(String(r["donor_fingerprint"]), String(r["id"]));
    keepAlive([inputs, returned, map]);
    const afterOld = heapMb();
    delta("  OLD (accumulate all rows, fold at end)", beforeB, afterOld);
    map.clear();
    returned.length = 0;
  }
  gc();
  {
    // NEW: onReturnedRows folds per chunk; each chunk's rows are garbage
    // immediately. Only the id map survives — which both versions need.
    const map = new Map<string, string>();
    for (let i = 0; i < N; i += CHUNK) {
      const end = Math.min(i + CHUNK, N);
      const rows: Array<Record<string, unknown>> = [];
      for (let j = i; j < end; j++) rows.push({ id: fakeUuid(j), donor_fingerprint: inputs[j]!.fingerprint });
      for (const r of rows) map.set(String(r["donor_fingerprint"]), String(r["id"]));
    }
    keepAlive([inputs, map]);
    const afterNew = heapMb();
    delta("  NEW (per-chunk fold, rows collectable)", beforeB, afterNew);
    map.clear();
  }
  gc();

  // ── C. donorMetas retention ─────────────────────────────────────────────
  console.log("\nC. indivResult.donorMetas + cycleDonorTotals retention");
  const beforeC = heapMb();
  {
    // Shape of streamIndiv's donorMetas map and the per-cycle totals map, both
    // of which used to stay reachable through `indivResult` for the whole
    // 4-stage writer run despite being dead after donorInputs was built.
    const donorMetas = new Map<string, Omit<IndividualDonorInput, "totalDonatedCents">>();
    const cycleDonorTotals = new Map<string, number>();
    for (const d of inputs) {
      donorMetas.set(d.fingerprint, {
        fingerprint: d.fingerprint, displayName: d.displayName, city: d.city,
        state: d.state, zip5: d.zip5, employer: d.employer, occupation: d.occupation,
      });
      cycleDonorTotals.set(d.fingerprint, d.totalDonatedCents);
    }
    keepAlive([inputs, donorMetas, cycleDonorTotals]);
    const held = heapMb();
    delta("  OLD (held live through all 4 writer stages)", beforeC, held);
    donorMetas.clear();
    cycleDonorTotals.clear();
    keepAlive([inputs, donorMetas, cycleDonorTotals]);
    const released = heapMb();
    delta("  NEW (.clear()ed once donorInputs is built)", beforeC, released);
  }

  keepAlive(inputs);
  console.log(
    "\nReading these numbers:\n" +
      "  - Strings are SHARED by reference between donorInputs and every structure above,\n" +
      "    so the deltas are object headers, property slots and Map entries — not duplicated text.\n" +
      "  - In B, the uuid strings are retained by donorIdByFingerprint in BOTH versions (that map\n" +
      "    is the point of the RETURNING clause). The saving is the row OBJECTS and the array that\n" +
      "    held them, not the uuids.\n",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
