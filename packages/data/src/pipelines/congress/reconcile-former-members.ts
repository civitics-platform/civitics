/**
 * Former-member reconciliation (FIX-409).
 *
 * The congress officials pipeline only ever ingests *current* members and only
 * ever sets is_active=true. Members who leave Congress fall out of the
 * Congress.gov feed but their officials rows stay is_active=true forever — so
 * ex-members render with no Former badge (FIX-457) and the wrong tier (FIX-249).
 *
 * This pass closes that gap: after the member loop builds the feed, it diffs
 * the set of feed bioguideIds against the currently-active congress officials
 * and flips the ones that fell out of the feed to is_active=false,
 * tier='former'. A returning member is re-activated automatically by the normal
 * in-loop is_active:true upsert, so this only ever deactivates genuine departures.
 *
 * THE PARTIAL-FETCH GUARD IS NON-NEGOTIABLE (decision #5): the deactivation only
 * runs if fetchAllMembers returned a plausibly-complete roster (House 435 +
 * Senate 100 + delegates ≈ 541; floor of 500). A truncated or failed fetch must
 * never mass-deactivate — if the roster is short we SKIP with a loud warning.
 *
 * Mirrors the post-loop, non-fatal try/catch step pattern of
 * runCandidateToElectedPromotion (promote-candidates.ts).
 */

import type { createAdminClient } from "@civitics/db";
import { ID_CHUNK_SIZE } from "@civitics/db";

type Db = ReturnType<typeof createAdminClient>;

/** A plausibly-complete current-Congress roster: 435 House + 100 Senate +
 *  ~6 non-voting delegates ≈ 541. Floor below that → treat the feed as
 *  truncated and skip deactivation entirely. */
export const ROSTER_FLOOR = 500;

export interface ReconcileFormerInput {
  /** Set of bioguideIds present in the freshly-fetched feed. */
  feedBioguideIds: Set<string>;
  /** members.length from fetchAllMembers — the partial-fetch guard reads this,
   *  NOT feedBioguideIds.size (which could be deduped/smaller). */
  feedMemberCount: number;
  /** Currently-active congress officials in scope: source_ids->>congress_gov
   *  present, is_active=true, tier <> 'candidate'. */
  activeOfficials: Array<{ id: string; bioguideId: string }>;
  /** Override the roster floor (tests). Defaults to ROSTER_FLOOR. */
  rosterFloor?: number;
}

export interface ReconcileFormerDiff {
  /** True if the feed roster cleared the floor and deactivation may proceed. */
  guardPassed: boolean;
  rosterFloor: number;
  feedMemberCount: number;
  /** officials.id values to flip is_active=false, tier='former'. Empty when
   *  the guard fails. */
  staleIds: string[];
  /** Parallel bioguideIds for logging. */
  staleBioguideIds: string[];
}

/**
 * Pure diff + guard. Given the feed and the active set, return the officials to
 * deactivate — or NONE if the feed roster is below the floor (guard fires).
 *
 * Exported standalone so the test can exercise the diff and the short-feed
 * guard without a database.
 */
export function computeFormerMemberDiff(
  input: ReconcileFormerInput
): ReconcileFormerDiff {
  const rosterFloor = input.rosterFloor ?? ROSTER_FLOOR;
  const guardPassed = input.feedMemberCount >= rosterFloor;

  if (!guardPassed) {
    return {
      guardPassed: false,
      rosterFloor,
      feedMemberCount: input.feedMemberCount,
      staleIds: [],
      staleBioguideIds: [],
    };
  }

  const staleIds: string[] = [];
  const staleBioguideIds: string[] = [];
  for (const o of input.activeOfficials) {
    if (!input.feedBioguideIds.has(o.bioguideId)) {
      staleIds.push(o.id);
      staleBioguideIds.push(o.bioguideId);
    }
  }

  return {
    guardPassed: true,
    rosterFloor,
    feedMemberCount: input.feedMemberCount,
    staleIds,
    staleBioguideIds,
  };
}

export interface ReconcileFormerResult {
  guardPassed: boolean;
  deactivated: number;
  staleBioguideIds: string[];
}

/**
 * DB-side reconciliation step. Fetches the currently-active congress officials,
 * diffs against the feed, and (guard permitting) flips the departed members to
 * is_active=false, tier='former'.
 *
 * Throws on a query/update error so the caller's non-fatal try/catch can log it
 * without voiding the upstream ingest.
 */
export async function runReconcileFormerMembers(opts: {
  db: Db;
  feedBioguideIds: Set<string>;
  feedMemberCount: number;
}): Promise<ReconcileFormerResult> {
  const { db, feedBioguideIds, feedMemberCount } = opts;

  // Active congress officials in scope. tier <> 'candidate' is defensive:
  // candidate rows are a different lifecycle owned by FEC + promote-candidates.
  const { data, error } = await db
    .from("officials")
    .select("id, source_ids")
    .not("source_ids->>congress_gov", "is", null)
    .eq("is_active", true)
    .neq("tier", "candidate");
  if (error) {
    throw new Error(`reconcile-former-members: active load: ${error.message}`);
  }

  const activeOfficials: Array<{ id: string; bioguideId: string }> = [];
  for (const row of (data ?? []) as Array<{
    id: string;
    source_ids: Record<string, string> | null;
  }>) {
    const bioguideId = row.source_ids?.["congress_gov"];
    if (bioguideId) activeOfficials.push({ id: row.id, bioguideId });
  }

  const diff = computeFormerMemberDiff({
    feedBioguideIds,
    feedMemberCount,
    activeOfficials,
  });

  if (!diff.guardPassed) {
    console.warn(
      `  reconcile-former-members: SKIP — feed roster ${feedMemberCount} ` +
        `below floor ${diff.rosterFloor}; refusing to mass-deactivate on a ` +
        `truncated/failed fetch.`
    );
    return { guardPassed: false, deactivated: 0, staleBioguideIds: [] };
  }

  if (diff.staleIds.length === 0) {
    console.log(
      `  reconcile-former-members: 0 departed members (${activeOfficials.length} active, feed ${feedMemberCount}).`
    );
    return { guardPassed: true, deactivated: 0, staleBioguideIds: [] };
  }

  // Log the to-deactivate list BEFORE applying (decision #6).
  console.log(
    `  reconcile-former-members: deactivating ${diff.staleIds.length} departed ` +
      `member(s): ${diff.staleBioguideIds.join(", ")}`
  );

  // FIX-1037: chunked. The id list rides the request URL on an UPDATE exactly
  // as it does on a read (the FIX-902 finding at src/lib/notifications.ts:124),
  // and `staleIds` is every departed member -- single digits in a steady week,
  // but a post-election Congress turnover is ~60-100 in one run, and a first
  // reconcile after a gap is unbounded. Hand-rolled rather than through
  // fetchChunkedByIds because that helper is a READ helper; the constant is the
  // shared one either way, which is the whole point.
  for (let i = 0; i < diff.staleIds.length; i += ID_CHUNK_SIZE) {
    const { error: updateError } = await db
      .from("officials")
      .update({ is_active: false, tier: "former" })
      .in("id", diff.staleIds.slice(i, i + ID_CHUNK_SIZE));
    if (updateError) {
      throw new Error(
        `reconcile-former-members: deactivate update: ${updateError.message}`
      );
    }
  }

  console.log(
    `  reconcile-former-members: deactivated ${diff.staleIds.length} member(s) → is_active=false, tier='former'.`
  );
  return {
    guardPassed: true,
    deactivated: diff.staleIds.length,
    staleBioguideIds: diff.staleBioguideIds,
  };
}
