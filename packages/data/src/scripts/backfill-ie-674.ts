/**
 * FIX-674 backfill — capture historical unmatched-target IE money (Schedule E).
 *
 * FIX-673 measured ~$636M of valid independent-expenditure money (6% of the
 * total; 13% in 2020) silently dropped because the target `cand_id` isn't a
 * matched official, so the IE writer can't resolve `to_id`. The pipeline fix
 * (resolve-or-mint in the IE stage) captures this going forward; this script
 * backfills the historical cycles.
 *
 * IE-ONLY BLAST RADIUS. It does NOT re-run weball / pas2 / indiv, so it cannot
 * touch donation rows — it only mints missing target `tier='candidate'`
 * officials and (idempotently) upserts `ie_support`/`ie_oppose`
 * financial_relationships. Spender committees are resolved against
 * financial_entities (already populated by prior full runs); IE-only spenders
 * missing from that set are pre-upserted from the cm{yy} committee master with
 * `total_donated_cents` left untouched.
 *
 * Reuses the shared, now-fixed helpers (streamer, resolve-or-mint, writers) so
 * the backfill exercises the same code path as the pipeline.
 *
 * Local (default target = whatever .env.local points at):
 *   pnpm --filter @civitics/data data:backfill:ie-674
 *   pnpm --filter @civitics/data data:backfill:ie-674 -- --dry-run   # measure only
 *
 * Prod (off active hours — mints + writes to Pro; --allow-prod required):
 *   pnpm --filter @civitics/data exec tsx --env-file=<ABS>/.env.local.prod \
 *     <ABS>/packages/data/src/scripts/backfill-ie-674.ts --allow-prod
 *
 * Override cycles with FEC_CYCLES (default 2020,2022,2024,2026).
 */

import * as fs   from "fs";
import * as os   from "os";
import * as path from "path";

import { createAdminClientWith, afterKey } from "@civitics/db";
import {
  downloadFile,
  loadOfficials,
  buildMatchIndex,
  parseCm24,
  type CommitteeInfo,
} from "../pipelines/fec-bulk/index";
import { loadOfficialsByFecIds } from "../pipelines/fec-bulk/candidates";
import { extractZipEntryToDisk, candMasterUrl } from "../pipelines/fec-bulk/util";
import { streamIndependentExpenditures } from "../pipelines/fec-bulk/indep-exp";
import { resolveOrMintIeTargets, type IeTargetIdentity } from "../pipelines/fec-bulk/mint-ie-targets";
import {
  upsertPacEntitiesBatch,
  upsertIndependentExpendituresBatch,
  type IndependentExpenditureInput,
} from "../pipelines/fec-bulk/writer";
import { seedJurisdictions, seedGoverningBodies } from "../jurisdictions/us-states";

const usd = (cents: number) =>
  `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

/** Load financial_entities → Map<fec_committee_id, entityId> for spender resolution. */
async function loadCommitteeEntityMap(
  db: ReturnType<typeof createAdminClientWith>,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const PAGE = 1000;
  let afterId: string | null = null; // FIX-984: keyset cursor, not an OFFSET
  for (;;) {
    const { data, error } = await afterKey(db
      .from("financial_entities")
      .select("id, fec_committee_id")
      .not("fec_committee_id", "is", null)
      .order("id")
      .limit(PAGE), "id", afterId);
    if (error) throw new Error(`loadCommitteeEntityMap: ${error.message}`);
    const rows = (data ?? []) as Array<{ id: string; fec_committee_id: string | null }>;
    for (const r of rows) if (r.fec_committee_id) map.set(r.fec_committee_id, r.id);
    if (rows.length < PAGE) break;
    afterId = rows[rows.length - 1]!.id;
  }
  return map;
}

/** Download cm{yy}.zip, extract the cm txt, parse to committee-info map. */
async function loadCmInfo(cycle: string, tmp: string): Promise<Map<string, CommitteeInfo>> {
  const zip = path.join(tmp, `cm-674-${cycle}-${process.pid}.zip`);
  const txt = path.join(tmp, `cm-674-${cycle}-${process.pid}.txt`);
  await downloadFile(`https://www.fec.gov/files/bulk-downloads/${cycle}/cm${cycle.slice(2)}.zip`, zip);
  try {
    const found = await extractZipEntryToDisk(
      zip,
      (name) => name.startsWith("cm") && name.endsWith(".txt"),
      txt,
    );
    if (!found) return new Map();
    return parseCm24(fs.readFileSync(txt));
  } finally {
    try { fs.unlinkSync(zip); } catch { /* ok */ }
    try { fs.unlinkSync(txt); } catch { /* ok */ }
  }
}

async function main(): Promise<void> {
  const dryRun    = process.argv.includes("--dry-run");
  const allowProd = process.argv.includes("--allow-prod");
  const url    = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  const secret = process.env["SUPABASE_SECRET_KEY"];
  if (!url || !secret) { console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY"); process.exit(2); }

  const isProd = !url.includes("127.0.0.1") && !url.includes("localhost");
  if (isProd && !dryRun && !allowProd) {
    console.error(`Refusing to write to prod (${url}) without --allow-prod. Add --allow-prod or --dry-run.`);
    process.exit(2);
  }
  console.log(`FIX-674 backfill — target: ${url}${dryRun ? "  [DRY RUN — no writes]" : isProd ? "  [PROD WRITE]" : "  [LOCAL WRITE]"}\n`);

  const db = createAdminClientWith(url, secret);

  // Shared identity/index scaffolding — mirrors the pipeline's setup.
  const { federalId, stateIds } = await seedJurisdictions(db);
  const governingBodies = await seedGoverningBodies(db, federalId);
  const existingByFecCandId = await loadOfficialsByFecIds(db);
  const officials = await loadOfficials(db);
  const index = buildMatchIndex(officials);
  const entityIdByCmte = await loadCommitteeEntityMap(db);
  console.log(
    `Loaded ${officials.length.toLocaleString()} active officials → ${index.byFecId.size.toLocaleString()} FEC-keyed; ` +
    `${existingByFecCandId.size.toLocaleString()} officials by-any-FEC-id; ${entityIdByCmte.size.toLocaleString()} committee entities\n`,
  );

  const CYCLES = (process.env["FEC_CYCLES"] ?? "2020,2022,2024,2026").split(",").map((c) => c.trim()).filter(Boolean);
  const tmp = os.tmpdir();

  let grandResolved = 0, grandMinted = 0, grandRels = 0, grandDroppedCents = 0, grandCapturedCents = 0;

  for (const cycle of CYCLES) {
    console.log(`────────── Cycle ${cycle} ──────────`);
    const ieName = `independent_expenditure_${cycle}.csv`;
    const iePath = path.join(tmp, `ie-674-${cycle}-${process.pid}.csv`);
    try {
      await downloadFile(`https://www.fec.gov/files/bulk-downloads/${cycle}/${ieName}`, iePath);
    } catch (e) {
      console.warn(`  ✗ ${ieName} unavailable: ${e instanceof Error ? e.message : e} — skipping\n`);
      continue;
    }

    try {
      const candidateSet = new Set<string>(index.byFecId.keys());
      const ieResult = await streamIndependentExpenditures(iePath, candidateSet, { collectUnmatched: true });

      const unmatched = ieResult.unmatchedAggregations ?? new Map();
      let droppedCents = 0;
      const targetById = new Map<string, IeTargetIdentity>();
      for (const agg of unmatched.values()) {
        droppedCents += agg.totalCents;
        if (!targetById.has(agg.candId)) {
          targetById.set(agg.candId, {
            candId: agg.candId, candName: agg.candName, candOffice: agg.candOffice, candState: agg.candState,
          });
        }
      }
      grandDroppedCents += droppedCents;
      console.log(`  Unmatched targets: ${targetById.size} distinct cand_ids, ${usd(droppedCents)}`);

      if (dryRun) {
        console.log(`  [dry-run] would resolve-or-mint ${targetById.size} targets and write their IE rels\n`);
        continue;
      }

      // 1. resolve-or-mint the unmatched targets.
      const mintResult = await resolveOrMintIeTargets({
        db, targets: [...targetById.values()], existingByFecCandId, governingBodies, stateJurisdictions: stateIds, federalId,
      });
      grandResolved += mintResult.resolved;
      grandMinted   += mintResult.minted;
      console.log(`  Targets — resolved: ${mintResult.resolved}  minted: ${mintResult.minted}  failed: ${mintResult.failed}`);
      for (const [candId, officialId] of mintResult.candIdToOfficialId) index.byFecId.set(candId, officialId);

      // SCOPE: this backfill writes ONLY the previously-unmatched-target rows
      // (FIX-674). It deliberately does NOT re-derive/complete the matched IE
      // set — that would also fill a separate spender-side completeness gap
      // (matched targets whose super-PAC spender is missing from
      // financial_entities), a much larger, distinct change that belongs to its
      // own FIX and its own prod-impact review. The nightly pipeline writes the
      // full matched set every run; this one-time backfill stays surgical.

      // 2. pre-upsert IE spenders missing from financial_entities — but only the
      //    ones referenced by the unmatched-target rows we're about to write.
      const missingSpenders = new Set<string>();
      for (const agg of unmatched.values()) {
        if (!entityIdByCmte.has(agg.spendingCmteId)) missingSpenders.add(agg.spendingCmteId);
      }
      if (missingSpenders.size > 0) {
        const cmInfo = await loadCmInfo(cycle, tmp);
        const inputs = [];
        let orphan = 0;
        for (const cmteId of missingSpenders) {
          const info = cmInfo.get(cmteId);
          if (!info) { orphan++; continue; }
          inputs.push({ cmteId, name: info.name, cmteType: info.type, connectedOrg: info.connectedOrg, totalDonatedCents: 0 });
        }
        if (inputs.length > 0) {
          const r = await upsertPacEntitiesBatch(inputs, /* skipAggregateOverwrite */ true);
          for (const [cmteId, id] of r.entityIdByCmte.entries()) entityIdByCmte.set(cmteId, id);
          console.log(`  IE spenders pre-upserted (for unmatched rows): ${r.upserted}${orphan ? ` (${orphan} orphan spe_id(s) missing from cm)` : ""}`);
        }
      }

      // 3. build + write ONLY the unmatched-target IE relationships.
      const ieInputs: IndependentExpenditureInput[] = [];
      let capturedCents = 0, orphanSpenderCents = 0;
      for (const agg of unmatched.values()) {
        const fromEntityId = entityIdByCmte.get(agg.spendingCmteId);
        const toOfficialId = index.byFecId.get(agg.candId);
        if (!toOfficialId) continue;                 // mint failed (bad office) — skip
        if (!fromEntityId) { orphanSpenderCents += agg.totalCents; continue; } // spender not in cm — out of scope
        ieInputs.push({
          fromEntityId, toOfficialId, cycleYear: parseInt(cycle, 10),
          amountCents: agg.totalCents, occurredAt: agg.latestDate, supportOppose: agg.supportOppose,
          spendingCmteId: agg.spendingCmteId, txCount: agg.txCount,
        });
        capturedCents += agg.totalCents;
      }
      const w = await upsertIndependentExpendituresBatch(ieInputs);
      grandRels += w.upserted;
      grandCapturedCents += capturedCents;
      console.log(
        `  IE relationships upserted: ${w.upserted}  (captured ${usd(capturedCents)} of ${usd(droppedCents)} dropped` +
        (orphanSpenderCents > 0 ? `; ${usd(orphanSpenderCents)} left for the spender-gap follow-up` : "") + `)\n`,
      );
    } finally {
      try { fs.unlinkSync(iePath); } catch { /* ok */ }
    }
  }

  console.log("════════════ FIX-674 backfill summary ════════════");
  console.log(`  targets resolved (existing): ${grandResolved}`);
  console.log(`  targets minted (new candidate rows): ${grandMinted}`);
  console.log(`  IE relationships upserted: ${grandRels}`);
  console.log(`  dropped $ seen: ${usd(grandDroppedCents)}   newly-captured $: ${usd(grandCapturedCents)}`);
  if (dryRun) console.log(`  (dry run — nothing written)`);
  console.log(`\n  Next: the graph + IE-total materializations pick these up on their normal cron cadence`);
  console.log(`  (entity_connections rebuild Sun/Wed; donor rollup + IE totals nightly).`);
}

main().catch((e) => { console.error("fatal:", e instanceof Error ? e.stack : String(e)); process.exit(1); });
