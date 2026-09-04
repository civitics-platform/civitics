/**
 * FIX-841 backfill — complete the SPENDER-side IE (Schedule E) gap.
 *
 * FIX-674 closed the unmatched-TARGET leak (IE money whose cand_id wasn't a
 * matched official). It surfaced a larger, separate SPENDER-side leak: prod
 * financial_relationships held only ~half the target-matched Schedule E money
 * because the spending super-PAC (spe_id) was missing from financial_entities,
 * so the IE writer could not resolve `from_id` and dropped the row.
 *
 * Two root causes, both closed here for ALL cycles (2020/22/24/26):
 *   (a) NIGHTLY CYCLE SCOPING — the Sunday FEC bulk only re-runs
 *       currentCycle-2,currentCycle (2024,2026 today), so 2020/2022 never
 *       re-ran under current (post-FIX-674) code; and the IE stage is step 6/7,
 *       late enough to be starved on Sundays even for 2024/26. This backfill is
 *       cycle-scoped and IE-only, so it completes every cycle regardless.
 *   (b) ORPHAN spe_ids — spenders in NEITHER financial_entities NOR the cm{yy}
 *       committee master. FIX-674's backfill deliberately left these unwritten
 *       (~$37M in the 674-unmatched slice alone). Here they are MINTED as
 *       name-only entities from the Schedule E `spe_nam` column
 *       (upsertIeSpenderEntitiesByName, metadata.source='schedule_e_spe_nam').
 *
 * Unlike backfill-ie-674 (which wrote ONLY the unmatched-target rows), this
 * writes the FULL matched + minted-target IE set per cycle: stream with
 * collectUnmatched + collectSpenderNames, resolve-or-mint targets, pre-upsert
 * EVERY missing spender (from cm when present, minted from spe_nam when orphan),
 * then upsert every (spe × cand × S/O) aggregation that resolves both ends.
 *
 * IE-ONLY BLAST RADIUS. It does NOT re-run weball / pas2 / indiv, so it cannot
 * touch donation rows — it only mints missing target tier='candidate' officials
 * + missing spender financial_entities and (idempotently) upserts
 * ie_support/ie_oppose financial_relationships. All spender pre-upserts leave
 * total_donated_cents at DEFAULT 0 (scoped column set) — pas2 outflow stays the
 * source of truth for that column. IE stays excluded from total_donated_cents
 * per the FIX-666..674 contract.
 *
 * The writers upsert on (relationship_type, from_id, to_id, cycle_year) and
 * (fec_committee_id), so the whole script is idempotent — safe to interrupt and
 * re-run. Running it against a DB that already has the complete set is a no-op.
 *
 * Local (default target = whatever .env.local points at):
 *   pnpm --filter @civitics/data data:backfill:ie-841
 *   pnpm --filter @civitics/data data:backfill:ie-841 -- --dry-run   # measure only
 *
 * Prod (off active hours — mints + writes to Pro; --allow-prod required):
 *   pnpm --filter @civitics/data exec tsx --env-file=<ABS>/.env.local.prod \
 *     <ABS>/packages/data/src/scripts/backfill-ie-841.ts --allow-prod
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
import { extractZipEntryToDisk } from "../pipelines/fec-bulk/util";
import {
  streamIndependentExpenditures,
  isMintableSpenderName,
  type IndepExpAggregation,
} from "../pipelines/fec-bulk/indep-exp";
import { resolveOrMintIeTargets, type IeTargetIdentity } from "../pipelines/fec-bulk/mint-ie-targets";
import {
  upsertPacEntitiesBatch,
  upsertIeSpenderEntitiesByName,
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
  const zip = path.join(tmp, `cm-841-${cycle}-${process.pid}.zip`);
  const txt = path.join(tmp, `cm-841-${cycle}-${process.pid}.txt`);
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

// ---------------------------------------------------------------------------
// Spender-resolution classification (shared by dry-run report + write path)
// ---------------------------------------------------------------------------

interface SpenderSplit {
  alreadyPresentCents:  number; // spe_id already in financial_entities
  resolvableViaCmCents: number; // spe_id in cm{yy} master (would upsert from cm)
  orphanMintableCents:  number; // spe_id ∉ cm, plausible spe_nam (would mint by name)
  orphanJunkCents:      number; // spe_id ∉ cm, blank spe_nam (skipped)
  orphanMintableIds:    Set<string>;
  orphanJunkIds:        Set<string>;
}

/** first non-empty spe_nam seen for each spe_id across the aggregation set. */
function spenderNameMap(aggs: Iterable<IndepExpAggregation>): Map<string, string> {
  const m = new Map<string, string>();
  for (const agg of aggs) {
    const nm = (agg.spenderName ?? "").trim();
    if (nm && !m.has(agg.spendingCmteId)) m.set(agg.spendingCmteId, nm);
  }
  return m;
}

function classifySpenders(
  aggs:            Iterable<IndepExpAggregation>,
  entityIdByCmte:  Map<string, string>,
  cmInfo:          Map<string, CommitteeInfo>,
  nameBySpe:       Map<string, string>,
): SpenderSplit {
  const s: SpenderSplit = {
    alreadyPresentCents: 0, resolvableViaCmCents: 0, orphanMintableCents: 0, orphanJunkCents: 0,
    orphanMintableIds: new Set(), orphanJunkIds: new Set(),
  };
  for (const agg of aggs) {
    const spe = agg.spendingCmteId;
    if (entityIdByCmte.has(spe)) { s.alreadyPresentCents += agg.totalCents; continue; }
    if (cmInfo.has(spe))         { s.resolvableViaCmCents += agg.totalCents; continue; }
    if (isMintableSpenderName(nameBySpe.get(spe))) {
      s.orphanMintableCents += agg.totalCents;
      s.orphanMintableIds.add(spe);
    } else {
      // Blank OR known-prankster name (FIX-841 denylist) → skipped as junk.
      s.orphanJunkCents += agg.totalCents;
      s.orphanJunkIds.add(spe);
    }
  }
  return s;
}

function logSplit(label: string, s: SpenderSplit): void {
  const total = s.alreadyPresentCents + s.resolvableViaCmCents + s.orphanMintableCents + s.orphanJunkCents;
  console.log(`  ${label} (Σ ${usd(total)}):`);
  console.log(`    already in financial_entities: ${usd(s.alreadyPresentCents)}`);
  console.log(`    resolvable via cm{yy} master:  ${usd(s.resolvableViaCmCents)}`);
  console.log(`    orphan — mintable by spe_nam:  ${usd(s.orphanMintableCents)}  (${s.orphanMintableIds.size} distinct spe_id)`);
  console.log(`    orphan — junk (blank spe_nam): ${usd(s.orphanJunkCents)}  (${s.orphanJunkIds.size} distinct spe_id)`);
}

// ---------------------------------------------------------------------------

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
  console.log(`FIX-841 backfill — target: ${url}${dryRun ? "  [DRY RUN — no writes]" : isProd ? "  [PROD WRITE]" : "  [LOCAL WRITE]"}\n`);

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

  let grandTargetsResolved = 0, grandTargetsMinted = 0, grandTargetsFailed = 0;
  let grandCmSpenders = 0, grandOrphanMinted = 0, grandOrphanJunk = 0;
  let grandRels = 0, grandCapturedCents = 0, grandOrphanJunkCents = 0, grandTargetUnresolvedCents = 0;

  for (const cycle of CYCLES) {
    console.log(`────────── Cycle ${cycle} ──────────`);
    const ieName = `independent_expenditure_${cycle}.csv`;
    const iePath = path.join(tmp, `ie-841-${cycle}-${process.pid}.csv`);
    try {
      await downloadFile(`https://www.fec.gov/files/bulk-downloads/${cycle}/${ieName}`, iePath);
    } catch (e) {
      console.warn(`  ✗ ${ieName} unavailable: ${e instanceof Error ? e.message : e} — skipping\n`);
      continue;
    }

    try {
      const candidateSet = new Set<string>(index.byFecId.keys());
      const ieResult = await streamIndependentExpenditures(iePath, candidateSet, {
        collectUnmatched:    true, // FIX-674 — capture unmatched-target money
        collectSpenderNames: true, // FIX-841 — retain spe_nam for orphan minting
      });

      const matched   = ieResult.aggregations;                       // targets already resolvable
      const unmatched = ieResult.unmatchedAggregations ?? new Map(); // targets needing resolve-or-mint

      // ── DRY RUN — classify without writing; report the reconciliation ──────
      if (dryRun) {
        // cm is only needed to split resolvable-via-cm vs orphan. Download once.
        const anyMissing = [...matched.values(), ...unmatched.values()]
          .some((a) => !entityIdByCmte.has(a.spendingCmteId));
        const cmInfo = anyMissing ? await loadCmInfo(cycle, tmp) : new Map<string, CommitteeInfo>();
        const nameBySpe = spenderNameMap([...matched.values(), ...unmatched.values()]);

        const matchedSplit   = classifySpenders(matched.values(),   entityIdByCmte, cmInfo, nameBySpe);
        const unmatchedSplit = classifySpenders(unmatched.values(), entityIdByCmte, cmInfo, nameBySpe);

        // Reconciliation: the matched-set split must sum to the streamer's
        // keptCents (Σ of matched-target amounts). The gate wants this proven.
        const matchedTotal = matchedSplit.alreadyPresentCents + matchedSplit.resolvableViaCmCents +
          matchedSplit.orphanMintableCents + matchedSplit.orphanJunkCents;
        logSplit("MATCHED-target spenders", matchedSplit);
        console.log(
          `    reconcile: split Σ ${usd(matchedTotal)} vs streamer keptCents ${usd(ieResult.stats.keptCents)} — ` +
          `${matchedTotal === ieResult.stats.keptCents ? "OK ✓" : "MISMATCH ✗"}`,
        );
        logSplit("UNMATCHED-target spenders (FIX-674 territory; 674 wrote the cm/present ones)", unmatchedSplit);

        // ~12-row sample of orphan (spe_id, spe_nam) across both sets so the
        // mint-plausibility call is visible.
        const mintableIds = new Set<string>([...matchedSplit.orphanMintableIds, ...unmatchedSplit.orphanMintableIds]);
        const junkIds     = new Set<string>([...matchedSplit.orphanJunkIds, ...unmatchedSplit.orphanJunkIds]);
        const orphanIds   = new Set<string>([...mintableIds, ...junkIds]);
        console.log(`  Orphan spe_id sample (of ${orphanIds.size} distinct — ${mintableIds.size} mintable, ${junkIds.size} junk):`);
        let shown = 0;
        for (const spe of orphanIds) {
          if (shown++ >= 12) break;
          const nm = nameBySpe.get(spe);
          const tag = mintableIds.has(spe) ? "MINT" : "JUNK";
          console.log(`    [${tag}] ${spe}  →  ${nm ? JSON.stringify(nm) : "(blank)"}`);
        }
        console.log("");
        continue;
      }

      // ── WRITE PATH ────────────────────────────────────────────────────────

      // 1. resolve-or-mint the unmatched targets, then merge their aggregations
      //    into the write set (same as the nightly IE stage).
      if (unmatched.size > 0) {
        const targetById = new Map<string, IeTargetIdentity>();
        for (const agg of unmatched.values()) {
          if (!targetById.has(agg.candId)) {
            targetById.set(agg.candId, {
              candId: agg.candId, candName: agg.candName, candOffice: agg.candOffice, candState: agg.candState,
            });
          }
        }
        const mintResult = await resolveOrMintIeTargets({
          db, targets: [...targetById.values()], existingByFecCandId, governingBodies, stateJurisdictions: stateIds, federalId,
        });
        grandTargetsResolved += mintResult.resolved;
        grandTargetsMinted   += mintResult.minted;
        grandTargetsFailed   += mintResult.failed;
        console.log(`  Targets — resolved: ${mintResult.resolved}  minted: ${mintResult.minted}  failed: ${mintResult.failed}`);
        for (const [candId, officialId] of mintResult.candIdToOfficialId) index.byFecId.set(candId, officialId);
        for (const [key, agg] of unmatched) {
          if (!matched.has(key)) matched.set(key, agg);
        }
      }

      // 2. pre-upsert EVERY missing spender referenced by the full write set:
      //    cm-present → from cm{yy}; orphan (∉ cm) → mint name-only from spe_nam.
      const missingSpenders = new Set<string>();
      for (const agg of matched.values()) {
        if (!entityIdByCmte.has(agg.spendingCmteId)) missingSpenders.add(agg.spendingCmteId);
      }
      if (missingSpenders.size > 0) {
        const cmInfo    = await loadCmInfo(cycle, tmp);
        const nameBySpe = spenderNameMap(matched.values());

        const cmInputs: Array<{ cmteId: string; name: string; cmteType: string; connectedOrg: string; totalDonatedCents: number }> = [];
        const orphanInputs: Array<{ cmteId: string; name: string }> = [];
        let orphanJunk = 0;
        for (const spe of missingSpenders) {
          const info = cmInfo.get(spe);
          if (info) {
            cmInputs.push({ cmteId: spe, name: info.name, cmteType: info.type, connectedOrg: info.connectedOrg, totalDonatedCents: 0 });
            continue;
          }
          const nm = (nameBySpe.get(spe) ?? "").trim();
          if (isMintableSpenderName(nm)) orphanInputs.push({ cmteId: spe, name: nm });
          else                           orphanJunk++; // blank OR denylisted prankster name
        }

        if (cmInputs.length > 0) {
          const r = await upsertPacEntitiesBatch(cmInputs, /* skipAggregateOverwrite */ true);
          for (const [cmteId, id] of r.entityIdByCmte.entries()) entityIdByCmte.set(cmteId, id);
          grandCmSpenders += r.upserted;
        }
        if (orphanInputs.length > 0) {
          const r = await upsertIeSpenderEntitiesByName(orphanInputs);
          for (const [cmteId, id] of r.entityIdByCmte.entries()) entityIdByCmte.set(cmteId, id);
          grandOrphanMinted += r.upserted;
        }
        grandOrphanJunk += orphanJunk;
        console.log(
          `  Missing spenders: ${missingSpenders.size} → cm-present ${cmInputs.length}, orphan-minted ${orphanInputs.length}, junk-skipped ${orphanJunk}`,
        );
      }

      // 3. build + write EVERY aggregation that resolves both ends.
      const ieInputs: IndependentExpenditureInput[] = [];
      let capturedCents = 0, orphanJunkCents = 0, targetUnresolvedCents = 0;
      for (const agg of matched.values()) {
        const toOfficialId = index.byFecId.get(agg.candId);
        if (!toOfficialId) { targetUnresolvedCents += agg.totalCents; continue; } // mint failed (bad office)
        const fromEntityId = entityIdByCmte.get(agg.spendingCmteId);
        if (!fromEntityId) { orphanJunkCents += agg.totalCents; continue; }       // orphan junk (blank spe_nam)
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
      grandOrphanJunkCents += orphanJunkCents;
      grandTargetUnresolvedCents += targetUnresolvedCents;
      console.log(
        `  IE relationships upserted: ${w.upserted}  (captured ${usd(capturedCents)}` +
        (orphanJunkCents > 0 ? `; ${usd(orphanJunkCents)} orphan-junk skipped` : "") +
        (targetUnresolvedCents > 0 ? `; ${usd(targetUnresolvedCents)} target-unresolved` : "") + `)\n`,
      );
    } finally {
      try { fs.unlinkSync(iePath); } catch { /* ok */ }
    }
  }

  console.log("════════════ FIX-841 backfill summary ════════════");
  if (dryRun) {
    console.log(`  (dry run — nothing written)`);
  } else {
    console.log(`  targets resolved (existing): ${grandTargetsResolved}`);
    console.log(`  targets minted (new candidate rows): ${grandTargetsMinted}  failed: ${grandTargetsFailed}`);
    console.log(`  spenders pre-upserted from cm{yy}: ${grandCmSpenders}`);
    console.log(`  spenders minted from spe_nam (orphan): ${grandOrphanMinted}`);
    console.log(`  orphan spe_ids skipped as junk (blank name): ${grandOrphanJunk}`);
    console.log(`  IE relationships upserted: ${grandRels}`);
    console.log(`  captured $: ${usd(grandCapturedCents)}`);
    if (grandOrphanJunkCents > 0)      console.log(`  orphan-junk $ skipped: ${usd(grandOrphanJunkCents)}`);
    if (grandTargetUnresolvedCents > 0) console.log(`  target-unresolved $ skipped: ${usd(grandTargetUnresolvedCents)}`);
  }
  console.log(`\n  Next: run 'pnpm --filter @civitics/data data:rebuild:ie-totals' against THIS env to`);
  console.log(`  recompute financial_entities IE totals, then the graph + rollup crons pick the new rows up.`);
}

main().catch((e) => { console.error("fatal:", e instanceof Error ? e.stack : String(e)); process.exit(1); });
