/**
 * FIX-492 (FIX-468 Wave A) — slugify ingest invariant.
 *
 * `governing_bodies.slug` is the canonical handle used by /institutions/[id]
 * slug URLs and the FIX-490 graph gb-expansion (`governingBody=<slug>`). The
 * idempotent `backfill_governing_body_slugs()` DB function (migration
 * 20260603000000, FIX-475) only ever fills NULL slugs — but the migration
 * explicitly deferred wiring it into the pipelines, so any gb rows inserted
 * after the one-shot migration run were stranded slugless (the 230 committee
 * rows from the FIX-478 wave were the surfacing case).
 *
 * Every pipeline that inserts `governing_bodies` rows calls this at the end of
 * its run so newly-landed gbs are never left without a slug again. The function
 * is idempotent and cheap (it touches only NULL-slug rows), so calling it
 * unconditionally per run is safe.
 */
import { createAdminClient } from "@civitics/db";

/** Admin Supabase client, typed the same way the pipelines hold it. */
type Db = ReturnType<typeof createAdminClient>;

/**
 * Fill slugs for any newly-inserted governing_bodies rows. Returns the count
 * filled (0 when everything was already slugged). Never throws — a slug
 * backfill failure must not fail the parent ingest; it logs and returns 0.
 */
export async function slugifyGoverningBodies(db: Db): Promise<number> {
  const { data, error } = await db.rpc("backfill_governing_body_slugs");
  if (error) {
    console.warn(`  [slugify-gb] backfill_governing_body_slugs failed: ${error.message}`);
    return 0;
  }
  const filled = typeof data === "number" ? data : 0;
  if (filled > 0) {
    console.log(`  [slugify-gb] filled ${filled} new governing_body slug(s)`);
  }
  return filled;
}
