/**
 * FIX-548 — diagnostic: verify the openstates Phase-0 governing-body
 * resolution converges (no inserts) against the active DB.
 *
 * Mirrors runOpenStatesPipeline's Phase 0 exactly — shape-aware chamber keys
 * from LEGISLATURE_SHAPES, proper-name overrides for unicameral chambers —
 * then calls resolveGoverningBodies and reports the before/after gb count.
 * Zero OpenStates API calls, so it can run any time without quota cost.
 *
 * A converged DB resolves every requested key with ZERO inserts: 52 bicameral
 * pairs + 4 unicameral (DC/NE/GU/VI) = 108 chamber gbs. A non-zero insert
 * count means the DB and LEGISLATURE_SHAPES disagree — e.g. the FIX-489/548
 * unicameral merge hasn't run on this env yet (the pre-merge pair would
 * resolve upper/lower while the unicameral key inserts a THIRD gb; run the
 * merge first), or a new jurisdiction was added without chambers.
 *
 * NOTE: resolveGoverningBodies refreshes the FIX-477 synthetic xsr rows
 * (last_seen_at bump) as a side effect — same as any pipeline run, harmless.
 *
 * Run:  pnpm --filter @civitics/data diag:gb-resolution
 */

import { createAdminClient } from "@civitics/db";
import { seedJurisdictions, STATE_DATA } from "../jurisdictions/us-states";
import { legislatureShapeFor } from "../jurisdictions/legislature-shapes";
import { resolveGoverningBodies, type GovBodyKey } from "../pipelines/openstates/writer";

async function chamberGbCount(db: ReturnType<typeof createAdminClient>): Promise<number> {
  const { count, error } = await db
    .from("governing_bodies")
    .select("id", { count: "exact", head: true })
    .in("type", ["legislature_upper", "legislature_lower", "legislature_unicameral"]);
  if (error) throw error;
  return count ?? 0;
}

async function main(): Promise<void> {
  const db = createAdminClient();
  const { stateIds } = await seedJurisdictions(db);

  const govBodyKeys: GovBodyKey[] = [];
  for (const state of STATE_DATA) {
    const jurisdictionId = stateIds.get(state.name);
    if (!jurisdictionId) continue;
    const shape = legislatureShapeFor(state.abbr);
    const orgClasses = shape.shape === "unicameral" ? (["legislature"] as const) : (["upper", "lower"] as const);
    for (const orgClass of orgClasses) {
      govBodyKeys.push({
        jurisdictionId,
        stateAbbr: state.abbr,
        stateName: state.name,
        type:
          orgClass === "upper" ? "legislature_upper" :
          orgClass === "lower" ? "legislature_lower" :
          "legislature_unicameral",
        name: orgClass === "legislature" ? shape.unicameralName : undefined,
        shortName: orgClass === "legislature" ? shape.unicameralShortName : undefined,
      });
    }
  }

  const before = await chamberGbCount(db);
  const map = await resolveGoverningBodies(db, govBodyKeys);
  const after = await chamberGbCount(db);

  const converged = map.size >= govBodyKeys.length && after === before;
  console.log(`Phase-0 keys requested:   ${govBodyKeys.length}`);
  console.log(`Resolved:                 ${map.size}`);
  console.log(`Chamber gbs before/after: ${before} → ${after}`);
  console.log(converged ? "✓ CONVERGED — zero inserts" : "✗ NOT CONVERGED — inserts occurred or keys unresolved");
  if (!converged) process.exitCode = 1;
  // createAdminClient keeps the event loop alive briefly; mirror the pipeline entrypoint.
  setTimeout(() => process.exit(process.exitCode ?? 0), 500);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
