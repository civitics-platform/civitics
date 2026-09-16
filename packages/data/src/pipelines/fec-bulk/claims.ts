/**
 * CAND_ID claim helpers — the ONE place a row's FEC candidate-id claims are
 * read, in every shape they have ever been stored in.
 *
 * FIX-1187 moved these out of ./index so `candidates.ts` can call them.
 * `index.ts` imports `./candidates`, so a `candidates.ts -> ./index` import
 * would be a cycle and `authoritativeClaims` could be undefined at module-init
 * time. `index.ts` re-exports everything here, so the published paths that six
 * call sites and the test suite already use are unchanged.
 *
 * THE DISTINCTION THIS MODULE EXISTS TO KEEP. A CAND_ID is two things at once:
 * an identity (this FEC candidacy belongs to this person) and a description of
 * a seat (office char, state chars, House district digits, all of the race it
 * was FIRST registered for). A site that asks "does this row claim this id?"
 * wants the identity and must read `authoritativeClaims`. A site that builds a
 * fec.gov URL, or derives chamber/state from the prefix, wants the seat and
 * must keep reading `source_ids.fec_candidate_id` alone.
 */

/**
 * The only field these helpers read. Deliberately narrower than
 * `OfficialRecord` so `loadOfficialsByFecIds`, which selects just
 * `id, tier, role_title, source_ids`, can call them without inventing the
 * name/state fields it does not load.
 */
export interface SourceIdsCarrier {
  source_ids: Record<string, string>;
}

/**
 * FIX-956 — the retired-claim marker is an ARRAY, and both shapes are read here.
 *
 * The original marker was a scalar `merged_fec_candidate_id`, which can hold
 * exactly one retired id. That is wrong for anyone who has run for two
 * different federal seats: a House member who then wins a Senate race retires
 * an H-id at one merge and an S-id at another, and the second write silently
 * overwrote the first — un-retiring the earlier claim, which the pipeline then
 * re-bound on its next pass. `merged_fec_candidate_ids` (a jsonb array) is the
 * shape that can hold both.
 *
 * READERS ACCEPT BOTH, WRITERS WRITE THE ARRAY. This function is the ONE place
 * the two shapes are reconciled, so nothing downstream has to know there was a
 * transition. Prod 2026-09-05: 86 rows carry the scalar, 0 carry the array;
 * converting those 86 is a DATA pass and is deliberately NOT in this bundle.
 */
export function retiredClaims(o: SourceIdsCarrier): string[] {
  const out: string[] = [];
  const arr = (o.source_ids as Record<string, unknown>)["merged_fec_candidate_ids"];
  if (Array.isArray(arr)) {
    for (const v of arr) if (typeof v === "string" && v) out.push(v);
  }
  const scalar = o.source_ids["merged_fec_candidate_id"];
  if (typeof scalar === "string" && scalar && !out.includes(scalar)) out.push(scalar);
  return out;
}

/** FIX-956 — does this row carry a retired claim of ANY id? The key-PRESENCE
 *  test: a merge stub must never re-enter a name pool, whatever it retired. */
export function hasAnyRetiredClaim(o: SourceIdsCarrier): boolean {
  return retiredClaims(o).length > 0;
}

export function hasRetiredClaim(o: SourceIdsCarrier, key: string): boolean {
  return retiredClaims(o).includes(key);
}

/**
 * FIX-1187 — `source_ids.prior_fec_candidate_ids`, the CAND_IDs this official
 * held under a PREVIOUS office.
 *
 * A CAND_ID encodes the office, state and (for the House) the district of the
 * race it was first registered for, so a member who moves House -> Senate ends
 * up with two authoritative ids for one person. `fec_candidate_id` holds the
 * CURRENT-office id — `rebuild_all_primary_sources` /
 * `refresh_primary_source_for_entities` build the fec.gov candidate URL from it
 * and `treemap_officials_by_donations` derives chamber/state from its prefix, so
 * that slot has to name the seat the person actually holds. The prior-office ids
 * live here instead.
 *
 * NOT role-gated, ever. The office IS prior by definition, so the pass-2 rule
 * (`roleMayHoldFecOffice`) would refuse every entry by construction — which is
 * precisely why the prior ids cannot live in `fec_id`.
 */
export function priorClaims(o: SourceIdsCarrier): string[] {
  const out: string[] = [];
  const arr = (o.source_ids as Record<string, unknown>)["prior_fec_candidate_ids"];
  if (Array.isArray(arr)) {
    for (const v of arr) if (typeof v === "string" && v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * FIX-1187 — every CAND_ID this row authoritatively claims: the current-office
 * id first, then the prior-office ids, deduped, with retired claims removed.
 *
 * This is the ONE list a claim/has-id site should read. A display/URL/seat site
 * must keep reading `fec_candidate_id` alone.
 */
export function authoritativeClaims(o: SourceIdsCarrier): string[] {
  const out: string[] = [];
  const current = o.source_ids["fec_candidate_id"];
  if (typeof current === "string" && current) out.push(current);
  for (const p of priorClaims(o)) if (!out.includes(p)) out.push(p);
  // FIX-955 — a re-written claim on an id this row already retired is exactly
  // the defect; it never reaches a caller.
  return out.filter((id) => !hasRetiredClaim(o, id));
}
