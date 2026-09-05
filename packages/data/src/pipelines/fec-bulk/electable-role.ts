/**
 * FIX-1025 — ONE rule for "which `officials.role_title` may hold which FEC
 * office", in one place.
 *
 * WHY THIS FILE EXISTS. The same rule was spelled six different ways across the
 * package, and two of the spellings were wrong in opposite directions:
 *
 *   1. `index.ts` buildMatchIndex pass 2 — `role_title === "Senator"` /
 *      `=== "Representative"`, exact, with NO President arm at all. Too tight:
 *      a `Candidate for Senator` row could not read back its own stored S-id.
 *   2. `candidates.ts` loadOfficialsByFecIds — `role.includes("Senator")`,
 *      `.includes("Representative")`, `.includes("President")`. Too loose:
 *      `"State Senator"` contains `"Senator"`, and `"Vice President, Marketing"`
 *      (a real USPS row) contains `"President"`.
 *   3-6. `fec-orphan-classify.ts` and three sites in
 *      `merge-same-person-official-dupes.ts` — exact office↔role pairs, each
 *      hand-written, two of them missing the `Candidate for …` arms.
 *
 * A read side that is stricter than the write side is exactly the asymmetry
 * FIX-937 closed for the ALLOW-LIST; this closes it for the OFFICE PREFIX. Both
 * now derive from a single table, so "may this official hold THIS CAND_ID" is
 * one function call and cannot drift again.
 *
 * EXACT strings, never `includes`/`ILIKE` — see the FIX-937 note on
 * `FEC_ELECTABLE_ROLE_TITLES` below. Measured on prod 2026-09-05: 5,442
 * `State Representative` and 2,012 `State Senator` rows (0 carrying any federal
 * id today, so the loose spelling has not yet bound one — this is the trap
 * closed before it fires), plus 119 `Council Member` rows that DO carry an
 * H / S / P `fec_id` and which every spelling here correctly refuses.
 */

/** The FEC CAND_ID office prefixes an `officials` row can legitimately hold. */
export type FecOfficePrefix = "H" | "S" | "P";

/**
 * FIX-1025 — the single role → office table. Every predicate below reads it.
 *
 * `Vice President` maps to `P` because FEC carries presidential-ticket ids
 * under the P prefix; it is listed for the same reason `President` is (FIX-937)
 * — so a future seed does not silently fall out of the pool. It does NOT admit
 * `"Vice President, Marketing"`, which is a different exact string.
 */
const ROLE_TO_OFFICE: ReadonlyMap<string, FecOfficePrefix> = new Map([
  ["Senator", "S"],
  ["Candidate for Senator", "S"],
  ["Representative", "H"],
  ["Candidate for Representative", "H"],
  ["President", "P"],
  ["Candidate for President", "P"],
  ["Vice President", "P"],
] as Array<[string, FecOfficePrefix]>);

/**
 * FIX-937 — the only `role_title`s that can legitimately hold an FEC
 * House / Senate / President CAND_ID.
 *
 * WHY A ROLE ALLOW-LIST AND NOT THE `short_name` SYMPTOM. FIX-937 found the
 * population via jurisdiction `short_name` values that are not two-letter state
 * codes (`AUS`, `SEA`, `SF`, `US`), because such an official can never satisfy
 * `matchRow`'s state narrowing and therefore only ever bound through the
 * national-pool fallback FIX-936 closed. But `short_name` is a *consequence* of
 * where the row came from, not a statement about the seat: `US` is also the
 * jurisdiction of every presidential candidate the cn{yy} stage mints, which IS
 * federally electable. The stable signal is the role.
 *
 * An allow-list also fails in the recoverable direction — an unrecognised
 * federal role is refused a name match, which lands in FIX-935's UNIQUE HOLDER
 * branch (write the id later), rather than binding someone else's donors
 * (FIX-934).
 *
 * Derived from ROLE_TO_OFFICE (FIX-1025) so the two cannot drift.
 */
export const FEC_ELECTABLE_ROLE_TITLES: ReadonlySet<string> = new Set(ROLE_TO_OFFICE.keys());

/**
 * FIX-1025 — the office-prefix companion. `null` means "this role may hold no
 * FEC candidate id at all", which is the same answer `isFecElectableRole`
 * gives; the two can never disagree because this is what it is built on.
 */
export function fecOfficePrefixFor(roleTitle: string | null | undefined): FecOfficePrefix | null {
  return ROLE_TO_OFFICE.get((roleTitle ?? "").trim()) ?? null;
}

/**
 * FIX-1025 — "may an official with this role hold a CAND_ID for this office?"
 * `office` is the FEC prefix, i.e. `candId[0]` upper-cased, or the `cand_office`
 * column of a cn{yy} row. A non-H/S/P office is refused.
 */
export function roleMayHoldFecOffice(
  roleTitle: string | null | undefined,
  office: string | null | undefined,
): boolean {
  const want = (office ?? "").trim().toUpperCase();
  if (want !== "H" && want !== "S" && want !== "P") return false;
  return fecOfficePrefixFor(roleTitle) === want;
}

/** FIX-937 — may this official hold an FEC candidate id at all? */
export function isFecElectableRole(o: { role_title?: string | null }): boolean {
  return fecOfficePrefixFor(o.role_title) !== null;
}
