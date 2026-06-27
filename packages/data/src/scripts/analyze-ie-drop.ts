/**
 * FIX-B — Quantify the unmatched-target drop in FEC Schedule E (IE) ingest.
 *
 * Read-only diagnostic. Writes NOTHING. It answers: of the *valid* independent-
 * expenditure money in FEC's Schedule E files, how much do we keep (target
 * candidate matches one of our officials) vs silently drop (target candidate is
 * not in our matched-official set)? That drop bounds how complete
 * `total_ie_*_cents` can ever be.
 *
 * It builds `candidateSet` exactly the way the pipeline does — load active
 * officials (`loadOfficials`) and key by FEC id via `buildMatchIndex` — then
 * runs the same `streamIndependentExpenditures` streamer over the cached
 * Schedule E CSV per cycle. (Junk billion-dollar filings are excluded from the
 * kept/dropped figures by the FIX-A upper-amount bound, so the drop reflects
 * *real* hidden money, not vexatious noise.)
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY from the active env. It
 * is read-only, so it is safe to point at either DB — the officials set differs
 * slightly between local and prod, but the conclusion (fraction hidden) is
 * stable. Source CSVs are downloaded fresh to the OS temp dir and deleted after.
 *
 *   pnpm --filter @civitics/data data:analyze:ie-drop
 *   FEC_CYCLES=2024 pnpm --filter @civitics/data data:analyze:ie-drop
 */

import * as fs   from "fs";
import * as os   from "os";
import * as path from "path";

import { createAdminClientWith } from "@civitics/db";
import {
  loadOfficials,
  buildMatchIndex,
  downloadFile,
} from "../pipelines/fec-bulk/index";
import { streamIndependentExpenditures } from "../pipelines/fec-bulk/indep-exp";

const usd = (cents: number) =>
  `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

async function main(): Promise<void> {
  const url    = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  const secret = process.env["SUPABASE_SECRET_KEY"];
  if (!url || !secret) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY");
    process.exit(2);
  }
  console.log(`IE drop analysis — target DB: ${url}\n`);

  const db = createAdminClientWith(url, secret);

  // Build candidateSet the same way the pipeline does (index.ts:819):
  //   buildMatchIndex(loadOfficials(db)).byFecId.keys()
  const officials   = await loadOfficials(db);
  const index       = buildMatchIndex(officials);
  const candidateSet = new Set<string>(index.byFecId.keys());
  console.log(
    `Loaded ${officials.length.toLocaleString()} active officials → ` +
    `${candidateSet.size.toLocaleString()} matched FEC candidate ids\n`,
  );

  const CYCLES = (process.env["FEC_CYCLES"] ?? "2020,2022,2024,2026")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  let grandKept = 0;
  let grandDropped = 0;

  for (const CYCLE of CYCLES) {
    const name = `independent_expenditure_${CYCLE}.csv`;
    const url2 = `https://www.fec.gov/files/bulk-downloads/${CYCLE}/${name}`;
    const dest = path.join(os.tmpdir(), `ie-drop-${CYCLE}-${process.pid}.csv`);

    console.log(`────────── Cycle ${CYCLE} ──────────`);
    try {
      await downloadFile(url2, dest);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  ✗ ${name} unavailable: ${msg} — skipping cycle\n`);
      continue;
    }

    try {
      const { stats, droppedByCand } = await streamIndependentExpenditures(
        dest,
        candidateSet,
        { collectDroppedByCand: true },
      );

      const validCents = stats.keptCents + stats.droppedUnmatchedCents;
      const totalCents = validCents + stats.rejectedHighCents;
      const pctHidden  = validCents > 0
        ? ((stats.droppedUnmatchedCents / validCents) * 100).toFixed(1)
        : "0.0";

      console.log(`  total IE $ in file (incl. junk):  ${usd(totalCents)}`);
      console.log(`  junk stripped (> bound, ${stats.rejectedHighAmount} rows): ${usd(stats.rejectedHighCents)}`);
      console.log(`  $ with valid amount:              ${usd(validCents)}`);
      console.log(`  $ kept (target matched):          ${usd(stats.keptCents)}  (${stats.passedCand.toLocaleString()} rows)`);
      console.log(`  $ dropped (target unmatched):     ${usd(stats.droppedUnmatchedCents)}`);
      console.log(`  → ${pctHidden}% of valid IE $ hidden by the matched-official filter`);

      if (droppedByCand && droppedByCand.size > 0) {
        const top = [...droppedByCand.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);
        console.log(`  top dropped target cand_ids by $ (not in our officials):`);
        for (const [candId, cents] of top) {
          console.log(`    ${candId.padEnd(12)} ${usd(cents)}`);
        }
      }
      console.log("");

      grandKept    += stats.keptCents;
      grandDropped += stats.droppedUnmatchedCents;
    } finally {
      try { fs.unlinkSync(dest); } catch { /* best effort */ }
    }
  }

  const grandValid = grandKept + grandDropped;
  const grandPct = grandValid > 0
    ? ((grandDropped / grandValid) * 100).toFixed(1)
    : "0.0";
  console.log("════════════ ALL CYCLES ════════════");
  console.log(`  kept:    ${usd(grandKept)}`);
  console.log(`  dropped: ${usd(grandDropped)}`);
  console.log(`  → ${grandPct}% of valid IE $ hidden by the matched-official filter`);
}

main().catch((e) => {
  console.error("fatal:", e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
