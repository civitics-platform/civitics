/**
 * OpenSecrets bulk pipeline — Phase 2 onramp skeleton.
 *
 * Status: SKELETON ONLY. Migrations (industry_codes, lobbying_disclosures,
 * financial_relationships.opensecrets_industry_code) landed in Phase 1. Bulk
 * CSV download + stream parser is Phase 2 work.
 *
 * Source: bulk CSVs available after free registration at
 *   https://www.opensecrets.org/open-data/bulk-data
 * Files of interest:
 *   - lob_lobbyist.csv / lob_lob.csv — lobbying disclosures
 *   - CRP_Categories.txt             — industry code reference table
 *
 * Fit: new `lobbying` edge type in entity_connections derivation (TODO in
 *      packages/data/src/pipelines/connections/delta.ts). Enriches
 *      financial_relationships with standardized industry codes.
 * Risk: 50 MB CSV is the storage-heaviest of the three Phase 2 onramps.
 *       Filter to >$10k disclosures on first pass to stay within budget.
 */

import { skipSync, startSync, type PipelineResult } from "../sync-log";

export async function runOpenSecretsBulkPipeline(): Promise<PipelineResult> {
  console.log("\n=== OpenSecrets bulk pipeline (skeleton) ===");
  const logId = await startSync("opensecrets_bulk");
  const result: PipelineResult = { inserted: 0, updated: 0, failed: 0, estimatedMb: 0 };

  // TODO (Phase 2):
  //   1. Download CRP_Categories.txt → upsert into industry_codes
  //   2. Stream lob_lobbyist.csv (tab-separated, Windows-1252 encoding)
  //   3. Filter: amount >= $10,000 on first pass
  //   4. Resolve client_name / registrant_name to financial_entities where
  //      available; otherwise insert as raw rows in lobbying_disclosures
  //   5. Link to officials via manual FEC committee <-> client mapping table
  //      (Phase 2.5)
  //   6. Delete temp files after parse completes

  await skipSync(logId, "not_implemented");
  console.log("  Skeleton pipeline — no work performed (status=skipped).");
  return result;
}

if (require.main === module) {
  runOpenSecretsBulkPipeline()
    .then(() => process.exit(0))
    .catch((err) => { console.error(err); process.exit(1); });
}
