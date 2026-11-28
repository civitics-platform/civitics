/**
 * FIX-940 — pure map-construction for the Congress votes writer.
 *
 * Extracted from `buildOfficialMaps` in ./votes.ts so the collision rules can be
 * pinned by ./votes-maps.test.ts without a DB harness. The DB reads stay in
 * votes.ts; everything below is rows-in / maps-out.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Senate branch of the votes writer has no bioguide to key on (the House
 * branch reads `@_name-id` off the XML and is correct precisely because of
 * that), so it resolves a member by `lastname:state`. It built that map by
 * iterating EVERY official in the Senate governing body — which carries ~1.95k
 * `tier='candidate'` rows minted by the FEC `cn{yy}` stage (FIX-246) alongside
 * the 100 sitting Senators — and doing an unconditional `.set()`. Rows were
 * ordered by uuid, so roughly half of contested `(surname, state)` slots
 * resolved to the candidate stub rather than the sitting Senator, and every
 * subsequent roll-call for that member landed on a row nobody can see. Measured
 * on the 2026-07-30 clone: 1,755 votes across 49 candidate-tier officials.
 * Nothing errored — the insert succeeded, it just pointed at the wrong row.
 *
 * TWO INDEPENDENT DEFECTS, TWO INDEPENDENT GUARDS
 * -----------------------------------------------
 * 1. The pool was unfiltered. votes.ts now scopes it with
 *    `currentGoverningBodyMembers()` (is_active + tier='elected'), the predicate
 *    the rest of the platform already agreed for exactly this pollution.
 * 2. A tier filter alone is NOT sufficient: two sitting Senators can share a
 *    `(surname, state)` slot, and `.set()` would still silently take the last
 *    row by uuid. So the builders below REFUSE to overwrite an occupied slot and
 *    report the collision with both ids. A logged unmatched vote is recoverable;
 *    a silently misattributed one is not.
 *
 * DIACRITICS ARE STRIPPED ON BOTH SIDES
 * -------------------------------------
 * Senate roll-call XML spells surnames ASCII-only (`<last_name>Lujan</last_name>`
 * for Ben Ray Luján, verified against 119th-Congress rolls), while `officials`
 * stores the accented form. Ben Ray Luján is the ONLY sitting Senator with a
 * non-ASCII surname, and he is also the only one whose elected row holds zero
 * votes — his key never matched, so his roll-calls fell through to the ASCII
 * `Lujan` candidate stub. A tier filter alone would therefore have turned a
 * misfiled vote into a DROPPED one. `senateNameKey` NFD-decomposes and strips
 * combining marks so both sides agree; because it is applied symmetrically it
 * can only ever widen a match, never redirect one, and any new collision it
 * creates is caught by the refusal guard rather than silently resolved.
 */

import { foldDiacritics } from "./diacritics";

/** A row from `officials` as the bioguide map needs it. */
export interface BioguideRow {
  id:         string;
  source_ids: Record<string, string> | null;
}

/** A row from `officials` as the senator name map needs it, state pre-resolved. */
export interface SenatorRow {
  id:         string;
  last_name:  string | null;
  /** Jurisdiction short_name, e.g. "GA". Resolved by the caller. */
  state:      string | null;
}

/** A refused overwrite: two rows claimed one key; the first one keeps it. */
export interface MapCollision {
  key:  string;
  /** The id already holding the slot — retained. */
  kept: string;
  /** The id refused the slot. */
  refused: string;
}

export interface BuiltMap {
  map:        Map<string, string>;
  collisions: MapCollision[];
}

/**
 * Fold a surname to its comparison form: Unicode-decomposed, combining marks
 * stripped, lowercased. `Luján` → `lujan`, so the DB's accented spelling and the
 * Senate XML's ASCII spelling produce the same key.
 */
export function normalizeSurname(raw: string | null | undefined): string {
  return foldDiacritics(raw ?? "")
    .trim()
    .toLowerCase();
}

/**
 * The Senate name-map key. Used to BUILD the map (from `officials`) and to READ
 * it (from the roll-call XML) — both sides must call this, or normalization is
 * asymmetric and the lookup silently misses.
 *
 * Returns "" when either component is missing; callers treat that as
 * "unkeyable", never as a real key.
 */
export function senateNameKey(
  lastName: string | null | undefined,
  state: string | null | undefined,
): string {
  const ln = normalizeSurname(lastName);
  const st = (state ?? "").trim().toUpperCase();
  if (!ln || !st) return "";
  return `${ln}:${st}`;
}

/**
 * Claim `key` for `id`, refusing to displace an existing holder.
 *
 * Re-claiming a key for the id that already holds it is a no-op, not a
 * collision — a row legitimately reachable twice is not evidence of ambiguity.
 */
function claim(
  map: Map<string, string>,
  collisions: MapCollision[],
  key: string,
  id: string,
): void {
  const held = map.get(key);
  if (held === undefined) {
    map.set(key, id);
    return;
  }
  if (held === id) return;
  collisions.push({ key, kept: held, refused: id });
}

/**
 * bioguide (`source_ids->>'congress_gov'`) → official id, for the House branch.
 *
 * Two officials rows sharing a bioguide is rare, but FIX-933's same-person merge
 * now puts `congress_gov` and `fec_candidate_id` on the SAME row, so the
 * one-row-per-bioguide invariant is worth asserting rather than assuming. Cheap,
 * and it turns a future silent misattribution into a log line.
 */
export function buildBioguideMap(rows: readonly BioguideRow[]): BuiltMap {
  const map = new Map<string, string>();
  const collisions: MapCollision[] = [];
  for (const r of rows) {
    const bioguide = r.source_ids?.["congress_gov"];
    if (bioguide) claim(map, collisions, bioguide, r.id);
  }
  return { map, collisions };
}

/**
 * FIX-1467 — the smallest member maps the votes writer may write with. From
 * about 2026-04-24 to 06-09 `buildOfficialMaps` read only the first 1,000
 * `officials` rows (PostgREST's cap; FIX-545 paginated the read), and every
 * roll written in that window stored only the members the cut map held, with
 * no error (FIX-1466). A House map holds every bioguide-keyed row (542 on prod
 * 2026-11-28) and the Senate map the sitting senators (about 100), so a map
 * under these is a broken read, not a smaller Congress.
 */
export const MEMBER_MAP_FLOOR = { house: 400, senate: 90 } as const;

export class MemberMapFloorError extends Error {
  constructor(readonly sizes: { house: number; senate: number }) {
    super(
      `FIX-1467: the member maps are under their floor — ${sizes.house} House bioguides ` +
        `(floor ${MEMBER_MAP_FLOOR.house}), ${sizes.senate} senators (floor ${MEMBER_MAP_FLOOR.senate}). ` +
        `A cut map stores every roll short and nothing re-reads it; no vote is written this run.`,
    );
    this.name = "MemberMapFloorError";
  }
}

/** Throws MemberMapFloorError when either map is under MEMBER_MAP_FLOOR. */
export function assertMemberMapFloor(sizes: { house: number; senate: number }): void {
  if (sizes.house < MEMBER_MAP_FLOOR.house || sizes.senate < MEMBER_MAP_FLOOR.senate) {
    throw new MemberMapFloorError(sizes);
  }
}

/**
 * FIX-1467 — the share of a roll's recorded votes that must resolve before the
 * nightly stores a roll of the sitting Congress. Prod 2026-11-28 (cc-341 read
 * 3): every whole 119th House roll resolves at least 97.6 % (within 10 of
 * about 432), while the cut map's rolls resolved 22.8–45 % (the 54 of
 * FIX-1465), 87.2–95.8 % (April 2026) and 93.8–94.9 % (2025). The prompt's 90 %
 * would have stored the last two; Craig chose 97 % (cc-341).
 */
export const SHORT_ROLL_SHARE = 0.97;

/** True when `resolved` of a roll's `recorded` votes is under SHORT_ROLL_SHARE. */
export function isShortRoll(resolved: number, recorded: number): boolean {
  return recorded > 0 && resolved < SHORT_ROLL_SHARE * recorded;
}

/**
 * The nightly's short-roll refusal, or none: the sitting Congress refuses a
 * short roll; the backfill path (CONGRESS_OVERRIDE) does not, because a 117th
 * roll resolves about 60 % until former members have rows (FIX-1464). Its map
 * floor still applies.
 */
export function shortRollGuard(
  currentCongress: number,
  sittingCongress: number,
): ((resolved: number, recorded: number) => boolean) | undefined {
  return currentCongress === sittingCongress ? isShortRoll : undefined;
}

/**
 * `lastname:STATE` → official id, for the Senate branch.
 *
 * Rows must already be scoped to current members (see
 * `currentGoverningBodyMembers()` at the call site) — this function does not
 * and cannot re-derive tier. It guards the residual ambiguity WITHIN that pool.
 */
export function buildSenatorNameStateMap(rows: readonly SenatorRow[]): BuiltMap {
  const map = new Map<string, string>();
  const collisions: MapCollision[] = [];
  for (const r of rows) {
    const key = senateNameKey(r.last_name, r.state);
    if (key) claim(map, collisions, key, r.id);
  }
  return { map, collisions };
}
