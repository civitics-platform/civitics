/**
 * GovTrack cosponsorship pipeline — Phase 2 onramp skeleton.
 *
 * Status: SKELETON ONLY. The migration (proposal_cosponsors table) landed in
 * Phase 1; the fetch/parse/upsert body is a Phase 2 task. Calling this pipeline
 * today returns a "not implemented" skip result without hitting the network.
 *
 * Source: https://www.govtrack.us/api/v2/cosponsorship
 * Fit: feeds a new `cosponsor` edge type in entity_connections (TODO in
 *      packages/data/src/pipelines/connections/delta.ts).
 * Risk: GovTrack endpoint has been intermittent historically — verify it's live
 *       before wiring this into runNightlySync.
 */

import { skipSync, startSync, type PipelineResult } from "../sync-log";

export async function runGovtrackCosponsorsPipeline(_sinceDate?: string): Promise<PipelineResult> {
  console.log("\n=== GovTrack cosponsors pipeline (skeleton) ===");
  const logId = await startSync("govtrack_cosponsors");
  const result: PipelineResult = { inserted: 0, updated: 0, failed: 0, estimatedMb: 0 };

  // TODO (Phase 2):
  //   1. Fetch /api/v2/cosponsorship?limit=6000&since=<sinceDate>
  //   2. Join on officials.source_ids->>bioguide_id for official_id
  //   3. Join on proposals.source_ids->>congress_gov_bill for proposal_id
  //   4. Upsert into proposal_cosponsors keyed on (proposal_id, official_id)
  //   5. Throttle 1 req / 500 ms; paginate via next cursor

  await skipSync(logId, "not_implemented");
  console.log("  Skeleton pipeline — no work performed (status=skipped).");
  return result;
}

if (require.main === module) {
  runGovtrackCosponsorsPipeline()
    .then(() => process.exit(0))
    .catch((err) => { console.error(err); process.exit(1); });
}
