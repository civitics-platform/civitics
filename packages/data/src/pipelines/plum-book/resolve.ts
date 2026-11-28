/**
 * FIX-1468 (cc-342 G2) — plum-book's name match, as a stated rule.
 *
 * An appointee whose `plum_id` no `officials` row carries is looked up by
 * lower-cased `full_name` (index.ts phase 2). Before this file the read had no
 * ORDER BY and no tier or `is_active` in its select, and the FIRST row returned
 * won: `if (!has(key)) set(key, row)`. Phase 3b then wrote `plum_id` AND
 * `is_active: isCurrent` onto that row, so a sitting member who shares a name
 * with an appointee could be stamped inactive by an unordered read.
 *
 * The rule, rows in / one answer out, independent of row order:
 *   - drop every SITTING member of Congress (a bioguide in
 *     `source_ids.congress_gov`, `is_active`, tier `elected`): a sitting member
 *     holds no PLUM position;
 *   - one row left → link it;
 *   - two or more left → link none (`ambiguous`; the run counts it as
 *     `name_ambiguous`) and the appointee takes the path an unmatched name takes;
 *   - none left → the unmatched path too.
 * A former member, an inactive member and a candidate stub are all legitimate
 * targets: the hazard was a collision settled by row order, not the tier.
 *
 * And a name never rewrites a member's `is_active`: phase 3b writes it only on
 * a row that carries no `source_ids.congress_gov` (`plumLinkUpdate`).
 * Pinned by ./resolve.test.ts.
 */

/** An `officials` row as the name match reads it. */
export interface PlumNameRow {
  id:         string;
  tier:       string | null;
  is_active:  boolean | null;
  source_ids: Record<string, string> | null;
}

export type PlumNameMatch<R extends PlumNameRow = PlumNameRow> =
  /** Exactly one row once sitting members are dropped. */
  | { kind: "link"; row: R }
  /** Two or more rows once sitting members are dropped — none is linked. Sorted. */
  | { kind: "ambiguous"; ids: string[] }
  /** No row, or sitting members only (their ids, sorted). */
  | { kind: "none"; sitting: string[] };

/** A sitting member of Congress: a bioguide, active, tier `elected`. */
export function isSittingMember(row: PlumNameRow): boolean {
  return !!row.source_ids?.["congress_gov"] && row.is_active === true && row.tier === "elected";
}

/** The rule above, for the rows one name key returned. */
export function resolvePlumNameMatch<R extends PlumNameRow>(rows: readonly R[]): PlumNameMatch<R> {
  const byId = new Map<string, R>();
  for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, r);
  const sitting: string[] = [];
  const left: R[] = [];
  for (const r of byId.values()) {
    if (isSittingMember(r)) sitting.push(r.id);
    else left.push(r);
  }
  if (left.length === 1) return { kind: "link", row: left[0]! };
  if (left.length === 0) return { kind: "none", sitting: sitting.sort() };
  return { kind: "ambiguous", ids: left.map((r) => r.id).sort() };
}

/**
 * Phase 3b's write for a name-linked row: the `plum_id`, and `is_active` from
 * the appointee's occupancy ONLY when the row carries no bioguide — a member's
 * `is_active` belongs to the congress pipelines, never to a name match.
 */
export function plumLinkUpdate(
  existingSourceIds: Record<string, string> | null,
  plumId: string,
  isCurrent: boolean,
  now: string,
): { source_ids: Record<string, string>; is_active?: boolean; updated_at: string } {
  const update: { source_ids: Record<string, string>; is_active?: boolean; updated_at: string } = {
    source_ids: { ...(existingSourceIds ?? {}), plum_id: plumId },
    updated_at: now,
  };
  if (!existingSourceIds?.["congress_gov"]) update.is_active = isCurrent;
  return update;
}
