/**
 * FIX-250 — IRS Form 990 bulk pipeline (officers + grants-out, NOT donors).
 *
 * Per-year flow:
 *   1. HEAD the index CSV for the year. If Last-Modified matches the stored
 *      watermark, skip the year entirely.
 *   2. Stream-parse the index CSV. Keep only rows whose EIN ∈ SEED_EIN_SET.
 *   3. Filter to objectIds we haven't yet ingested (irs990_filings.object_id UNIQUE).
 *   4. For each new objectId:
 *      a. fetch + parse the per-filing XML (with retry/backoff)
 *      b. upsert nonprofit financial_entities row + external_source_refs binding
 *      c. insert irs990_filings row
 *      d. upsert officers (with officials name-match)
 *      e. resolve grants-out recipients + upsert irs990_grants_out
 *      f. write financial_relationships rows for resolved grants
 *   5. Advance the watermark on success.
 *
 * Cadence: weekly Sunday (matches fec-bulk). 990s are filed annually with
 * a ~1-month bulk-availability lag; weekly re-poll is cheap (HEAD short-
 * circuits most weeks).
 *
 * Bulk-first per CLAUDE.md per-source policy. ProPublica is NOT used here —
 * it's a separate opt-in EIN-resolution helper.
 */

import { createAdminClient } from "@civitics/db";
import { startSync, completeSync, failSync, type PipelineResult } from "../sync-log";
import { SEED_EIN_SET, SEED_NONPROFITS } from "./seed";
import * as path from "path";
import {
  indexCsvUrl,
  headIrsFile,
  streamIndexCsv,
  getYearZipUrls,
  downloadFileToTemp,
  extractObjectIdXmlsFromZip,
  tempDir,
  safeUnlink,
  loadIndexWatermark,
  saveIndexWatermark,
  fingerprintSeedEins,
  normalizeEin,
  parseTaxYear,
  type IndexRow,
} from "./util";
import { parse990Xml } from "./parse";
import {
  upsertNonprofitEntity,
  insertFiling,
  upsertOfficersBatch,
  upsertGrantsOutBatch,
  writeGrantRelationships,
  loadOfficialsByCanonicalName,
  resolveGrantRecipient,
  filterUningestedObjectIds,
  type GrantRelationshipInput,
  type OfficerInsertInput,
  type GrantInsertInput,
} from "./writer";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default tax years to ingest. Override with `IRS990_TAX_YEARS=2022,2023,2024`. */
const DEFAULT_TAX_YEARS = (() => {
  const yr = new Date().getFullYear();
  // The current calendar year's 990s are usually 1mo behind; the previous 2
  // years are usually fully landed. Include yr − 2, yr − 1, yr.
  return [yr - 3, yr - 2, yr - 1];
})();

function taxYears(): number[] {
  const override = process.env["IRS990_TAX_YEARS"];
  if (!override) return DEFAULT_TAX_YEARS;
  return override
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n >= 2014 && n <= 2030);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runIrs990Pipeline(): Promise<PipelineResult> {
  const logId = await startSync("irs990");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;

  const result: PipelineResult = { inserted: 0, updated: 0, failed: 0, estimatedMb: 0 };

  try {
    console.log("\n=== IRS 990 pipeline ===");
    console.log(`  Seed orgs: ${SEED_NONPROFITS.length}`);
    const years = taxYears();
    console.log(`  Tax years: ${years.join(", ")}`);

    // Load officials lookup once (re-used across all years).
    console.log("  Loading officials → canonical-name map...");
    const officialsByName = await loadOfficialsByCanonicalName(db);
    console.log(`    ${officialsByName.size.toLocaleString()} canonical names indexed`);

    const watermark = await loadIndexWatermark(db);
    const seedFp = fingerprintSeedEins(SEED_NONPROFITS.map((s) => s.ein));

    for (const year of years) {
      console.log(`\n  [year=${year}]`);
      const url = indexCsvUrl(year);

      // Watermark check — skip only when BOTH the index Last-Modified AND
      // the seed-EIN fingerprint match the stored values. Without the
      // second check, expanding the seed list never re-streams the index.
      const head = await headIrsFile(url);
      const lm = head?.lastModified ?? null;
      const wmKey = String(year);
      const stored = watermark[wmKey];
      if (lm && stored && stored.lastModified === lm && stored.seedFingerprint === seedFp) {
        console.log(`    Index unchanged + seed fingerprint matches (lm=${lm}, fp=${seedFp}) — skipping`);
        continue;
      }
      if (lm && stored && stored.lastModified === lm && stored.seedFingerprint !== seedFp) {
        console.log(`    Index unchanged but seed fingerprint differs (was ${stored.seedFingerprint || "<legacy>"}, now ${seedFp}) — re-streaming`);
      }

      // Stream the index CSV, collecting only rows whose EIN is in the seed set.
      console.log(`    Streaming index ${url}...`);
      const matches: Array<{ row: IndexRow; ein: string }> = [];
      try {
        const { rowCount } = await streamIndexCsv(url, (row) => {
          const ein = normalizeEin(row.EIN);
          if (SEED_EIN_SET.has(ein)) matches.push({ row, ein });
        });
        console.log(`    Index rows: ${rowCount.toLocaleString()}, seed matches: ${matches.length}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`    Index stream failed for year ${year}: ${msg} — skipping year`);
        result.failed += 1;
        continue;
      }

      if (matches.length === 0) continue;

      // Filter out object_ids we've already ingested.
      const candidateObjectIds = matches.map((m) => m.row.OBJECT_ID).filter(Boolean);
      const alreadyIngested = await filterUningestedObjectIds(db, candidateObjectIds);
      const newMatches = matches.filter((m) => m.row.OBJECT_ID && !alreadyIngested.has(m.row.OBJECT_ID));
      console.log(`    New filings to ingest: ${newMatches.length} (skipping ${alreadyIngested.size} already-present)`);
      if (newMatches.length === 0) {
        if (lm) {
          watermark[wmKey] = { lastModified: lm, seedFingerprint: seedFp };
          await saveIndexWatermark(db, watermark);
        }
        continue;
      }

      // Bulk-ZIP discovery + extraction. Per-filing XMLs are no longer
      // individually addressable on apps.irs.gov — they live inside the
      // monthly TEOS_XML ZIPs. We download each ZIP for the year, stream
      // through it, and extract only entries whose object_id is in our
      // needed set.
      const zipUrls = await getYearZipUrls(year);
      console.log(`    ZIP archives for year ${year}: ${zipUrls.length}`);
      if (zipUrls.length === 0) {
        console.warn(`    No ZIP archives found for year ${year} — IRS page may have changed`);
        result.failed += newMatches.length;
        continue;
      }

      const objectIdToRow = new Map(newMatches.map((m) => [m.row.OBJECT_ID, m] as const));
      const needed = new Set(objectIdToRow.keys());

      const dir = tempDir();
      for (const zipUrl of zipUrls) {
        if (needed.size === 0) break;  // every needed filing accounted for
        const zipName = path.basename(new URL(zipUrl).pathname);
        const zipPath = path.join(dir, zipName);
        console.log(`      Downloading ${zipName}...`);
        try {
          await downloadFileToTemp(zipUrl, zipPath);
        } catch (err) {
          console.warn(`      [skip] ${zipName}: download failed — ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }

        let xmlMap: Map<string, string>;
        try {
          xmlMap = await extractObjectIdXmlsFromZip(zipPath, needed);
        } catch (err) {
          console.warn(`      [skip] ${zipName}: extract failed — ${err instanceof Error ? err.message : String(err)}`);
          safeUnlink(zipPath);
          continue;
        } finally {
          // ZIP off disk before processing — the extracted XMLs are in memory now.
        }
        safeUnlink(zipPath);

        if (xmlMap.size === 0) {
          console.log(`      ${zipName}: 0 matches`);
          continue;
        }
        console.log(`      ${zipName}: ${xmlMap.size} matches`);

        for (const [objectId, xml] of xmlMap.entries()) {
          const entry = objectIdToRow.get(objectId);
          if (!entry) continue;
          const { row, ein } = entry;
          needed.delete(objectId);

          let parsed;
          try {
            parsed = parse990Xml(xml);
          } catch (err) {
            console.warn(`      [skip] ${ein}/${objectId}: parse failed — ${err instanceof Error ? err.message : String(err)}`);
            result.failed += 1;
            continue;
          }

          const taxYear = parsed.filing.taxYear ?? parseTaxYear(row.TAX_PERIOD) ?? year;
          const orgName = parsed.filing.organizationName !== "(unknown)"
            ? parsed.filing.organizationName
            : (row.TAXPAYER_NAME ?? "(unknown)");

          // 1. Upsert nonprofit entity + EIN binding.
          let entityId: string;
          try {
            const r = await upsertNonprofitEntity(db, {
              ein,
              displayName:  orgName,
              state:        parsed.filing.addressState,
              nteeCode:     parsed.filing.nteeCode,
              subsectionCd: parsed.filing.subsectionCode,
            });
            entityId = r.entityId;
          } catch (err) {
            console.warn(`      [skip] ${ein}/${objectId}: entity upsert failed — ${err instanceof Error ? err.message : String(err)}`);
            result.failed += 1;
            continue;
          }

          // 2. Insert filing.
          const sourceUrl = zipUrl + "#" + objectId;
          const filingId = await insertFiling(db, {
            financialEntityId: entityId,
            ein,
            taxYear,
            filingType:        parsed.filing.filingType,
            objectId,
            filing:            parsed.filing,
            sourceUrl,
          });
          if (!filingId) {
            result.failed += 1;
            continue;
          }
          result.inserted += 1;
          result.estimatedMb += xml.length / (1024 * 1024);

          // 3. Officers.
          if (parsed.officers.length > 0) {
            const officerInputs: OfficerInsertInput[] = parsed.officers.map((o) => ({ filingId, officer: o }));
            const r = await upsertOfficersBatch(db, officerInputs, officialsByName);
            result.inserted += r.inserted;
            result.failed += r.failed;
          }

          // 4. Grants-out + resolution + financial_relationships writeback.
          if (parsed.grantsOut.length > 0) {
            const grantInputs: GrantInsertInput[] = [];
            const grantRels:   GrantRelationshipInput[] = [];
            for (const g of parsed.grantsOut) {
              const resolved = await resolveGrantRecipient(db, g);
              grantInputs.push({
                filingId,
                grant:              g,
                matchedEntityId:    resolved?.entityId ?? null,
                matchedEntityType:  resolved ? resolved.entityType : null,
              });
              if (resolved) {
                grantRels.push({
                  fromEntityId:   entityId,
                  toEntityType:   resolved.entityType,
                  toEntityId:     resolved.entityId,
                  amountCents:    g.amountCents,
                  taxYear,
                  filingObjectId: objectId,
                });
              }
            }
            const gr = await upsertGrantsOutBatch(db, grantInputs);
            result.inserted += gr.inserted;
            result.failed += gr.failed;

            if (grantRels.length > 0) {
              const rr = await writeGrantRelationships(db, grantRels);
              result.inserted += rr.inserted;
              result.failed += rr.failed;
            }
          }

          console.log(`      [ok]   ${ein}/${objectId} (${orgName.slice(0, 40)}): ${parsed.officers.length} officers, ${parsed.grantsOut.length} grants`);
        }
      }

      if (needed.size > 0) {
        console.warn(`    ${needed.size} filings not found in any ZIP archive (may be in a B/C/D variant not yet listed): ${Array.from(needed).slice(0, 5).join(", ")}${needed.size > 5 ? "..." : ""}`);
        result.failed += needed.size;
      }

      // Advance watermark on a successful year (only when ALL matched filings
      // resolved cleanly — otherwise leave the year unwatermarked so the
      // next run retries).
      if (lm && needed.size === 0) {
        watermark[wmKey] = { lastModified: lm, seedFingerprint: seedFp };
        await saveIndexWatermark(db, watermark);
      }
    }

    await completeSync(logId, result);
    console.log(`\n  IRS 990 complete: ${result.inserted} rows inserted, ${result.failed} failed, ${result.estimatedMb.toFixed(1)} MB XML processed`);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("IRS 990 pipeline threw:", msg);
    await failSync(logId, msg);
    throw err;
  }
}

// CLI entry — `pnpm --filter @civitics/data data:irs990`.
if (require.main === module) {
  runIrs990Pipeline()
    .then(() => process.exit(0))
    .catch((err) => { console.error(err); process.exit(1); });
}
