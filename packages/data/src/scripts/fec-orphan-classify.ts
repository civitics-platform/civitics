/**
 * FIX-930 / FIX-933 — shared classifier for the FEC attribution-orphan branches.
 *
 * WHY THIS IS A MODULE AND NOT COPY-PASTE
 * ---------------------------------------
 * `audit-fec-orphan-attribution.ts` (FIX-930) enumerates the orphan population
 * and splits it into three branches that need OPPOSITE remediations. The PR-2
 * remediation scripts must act on EXACTLY the population the audit describes —
 * so the suspect query, the branch boundary derivation and the same-vs-cross
 * decision all live here and are imported by both sides. A second copy of this
 * logic in a merge script is a correctness hazard, not a convenience: the
 * boundary is DERIVED from the data (widest empty band in the observed overlap
 * fraction), so two copies would silently diverge the moment the data moved.
 *
 * The extraction is a pure move — no logic changed. See the audit script header
 * for the full derivation rationale.
 */

import { roleMayHoldFecOffice } from "../pipelines/fec-bulk/electable-role";

// ---------------------------------------------------------------------------
// The enumeration query
//
// Built as one statement so the (from_id, cycle_year) overlap join runs
// server-side against financial_relationships_donor_rollup_idx rather than
// shipping ~250k donation keys per suspect over the wire.
// ---------------------------------------------------------------------------

export const SUSPECT_SQL = `
WITH suspect AS (
  SELECT o.id
  FROM officials o
  WHERE EXISTS (
          SELECT 1 FROM financial_relationships fr
          WHERE fr.to_type = 'official'
            AND fr.relationship_type = 'donation'
            AND fr.to_id = o.id
            AND fr.metadata->>'source' LIKE 'fec_bulk%')
    AND o.source_ids->>'fec_candidate_id' IS NULL
    AND NOT (
      o.source_ids->>'fec_id' IS NOT NULL AND (
        (o.role_title = 'Senator'        AND upper(left(o.source_ids->>'fec_id', 1)) = 'S') OR
        (o.role_title = 'Representative' AND upper(left(o.source_ids->>'fec_id', 1)) = 'H')
      ))
),
-- normalised surname + "does this official carry any FEC id at all"
lk AS (
  SELECT o.id,
         regexp_replace(upper(COALESCE(NULLIF(o.last_name, ''), o.full_name)), '[^A-Z]', '', 'g') AS lastkey,
         (o.source_ids ? 'fec_candidate_id' OR o.source_ids ? 'fec_id') AS has_fec
  FROM officials o
),
pair AS (
  SELECT s.id AS suspect_id, t.id AS twin_id
  FROM suspect s
  JOIN lk sl ON sl.id = s.id
  JOIN lk t  ON t.lastkey = sl.lastkey AND t.has_fec AND t.id <> s.id
  WHERE sl.lastkey <> ''
),
-- donation keys for every official involved on either side of a pair
d AS (
  SELECT fr.to_id, fr.from_id, fr.cycle_year
  FROM financial_relationships fr
  WHERE fr.to_type = 'official'
    AND fr.relationship_type = 'donation'
    AND fr.to_id IN (SELECT suspect_id FROM pair UNION SELECT twin_id FROM pair)
),
ov AS (
  SELECT p.suspect_id, p.twin_id, count(*)::bigint AS shared
  FROM pair p
  JOIN d a ON a.to_id = p.suspect_id
  JOIN d b ON b.to_id = p.twin_id
          AND b.from_id = a.from_id
          AND b.cycle_year IS NOT DISTINCT FROM a.cycle_year
  GROUP BY 1, 2
),
best AS (
  SELECT DISTINCT ON (suspect_id) suspect_id, twin_id, shared
  FROM ov ORDER BY suspect_id, shared DESC, twin_id
),
-- suspect-side facts, straight off the donation rows
facts AS (
  SELECT fr.to_id AS official_id,
         count(*)::bigint          AS donation_rows,
         sum(fr.amount_cents)::bigint AS fec_cents,
         min(fr.occurred_at)       AS first_at,
         max(fr.occurred_at)       AS last_at
  FROM financial_relationships fr
  WHERE fr.to_type = 'official'
    AND fr.relationship_type = 'donation'
    AND fr.to_id IN (SELECT id FROM suspect)
  GROUP BY 1
)
SELECT
  o.id                                        AS official_id,
  o.full_name,
  o.first_name,
  o.last_name,
  o.tier,
  o.is_active,
  o.role_title,
  j.short_name                                AS jurisdiction,
  o.source_ids->>'fec_id'                     AS stored_fec_id,
  COALESCE(odt.total_cents, 0)::bigint        AS totals_table_cents,
  COALESCE(f.fec_cents, 0)::bigint            AS donation_cents,
  COALESCE(f.donation_rows, 0)::bigint        AS donation_rows,
  f.first_at,
  f.last_at,
  b.twin_id,
  tw.full_name                                AS twin_name,
  tw.first_name                               AS twin_first_name,
  tw.tier                                     AS twin_tier,
  COALESCE(tw.source_ids->>'fec_candidate_id', tw.source_ids->>'fec_id') AS twin_fec_id,
  COALESCE(twodt.total_cents, 0)::bigint      AS twin_total_cents,
  COALESCE(b.shared, 0)::bigint               AS shared_pairs
FROM suspect s
JOIN officials o                     ON o.id = s.id
LEFT JOIN jurisdictions j            ON j.id = o.jurisdiction_id
LEFT JOIN official_donor_totals odt  ON odt.official_id = o.id
LEFT JOIN facts f                    ON f.official_id = o.id
LEFT JOIN best b                     ON b.suspect_id = o.id
LEFT JOIN officials tw               ON tw.id = b.twin_id
LEFT JOIN official_donor_totals twodt ON twodt.official_id = b.twin_id
ORDER BY COALESCE(f.fec_cents, 0) DESC;
`;

export const PLATFORM_SQL = `
SELECT
  count(DISTINCT to_id)::bigint AS officials,
  sum(amount_cents)::bigint     AS cents
FROM financial_relationships
WHERE to_type = 'official' AND relationship_type = 'donation';
`;

/**
 * The suspect predicate ALONE, counted independently of SUSPECT_SQL's CTE chain.
 *
 * SUSPECT_SQL wraps this predicate in five more CTEs (surname pairing, the
 * donation-key overlap join, DISTINCT ON best-twin selection, per-suspect facts)
 * and any of those joins silently dropping rows would understate the suspect
 * population — which reads as "clean" rather than as "broken". This is the
 * cross-check: the two counts MUST agree, because every CTE downstream of
 * `suspect` is a LEFT JOIN onto it and none of them may remove a suspect.
 *
 * Cheap enough to always run (~6s on the local clone) because it skips exactly
 * the expensive part — the overlap join.
 */
export const SUSPECT_COUNT_SQL = `
SELECT count(*)::bigint AS n
  FROM officials o
 WHERE EXISTS (SELECT 1 FROM financial_relationships fr
                WHERE fr.to_type = 'official'
                  AND fr.relationship_type = 'donation'
                  AND fr.to_id = o.id
                  AND fr.metadata->>'source' LIKE 'fec_bulk%')
   AND o.source_ids->>'fec_candidate_id' IS NULL
   AND NOT (
     o.source_ids->>'fec_id' IS NOT NULL AND (
       (o.role_title = 'Senator'        AND upper(left(o.source_ids->>'fec_id', 1)) = 'S') OR
       (o.role_title = 'Representative' AND upper(left(o.source_ids->>'fec_id', 1)) = 'H')
     ));
`;

export interface SuspectRow {
  official_id: string;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  tier: string | null;
  is_active: boolean;
  role_title: string | null;
  jurisdiction: string | null;
  stored_fec_id: string | null;
  totals_table_cents: string;
  donation_cents: string;
  donation_rows: string;
  first_at: Date | null;
  last_at: Date | null;
  twin_id: string | null;
  twin_name: string | null;
  twin_first_name: string | null;
  twin_tier: string | null;
  twin_fec_id: string | null;
  twin_total_cents: string;
  shared_pairs: string;
}

export type Branch = "SAME-PERSON DUPLICATE" | "CROSS-PERSON MISATTRIBUTION" | "UNIQUE HOLDER";

/** SuspectRow plus the derived overlap numbers the classifier needs. */
export type EnrichedRow = SuspectRow & { rows: number; shared: number; frac: number };

export function enrich(rows: SuspectRow[]): EnrichedRow[] {
  return rows.map((r) => {
    const n = Number(r.donation_rows);
    const shared = Number(r.shared_pairs);
    return { ...r, rows: n, shared, frac: n > 0 ? shared / n : 0 };
  });
}

// ---------------------------------------------------------------------------
// Name agreement — same 3-letter key the FIX-929 gate uses, so the branch
// boundary and the matcher agree on what "same person" means.
// ---------------------------------------------------------------------------

export function firstNameKey(raw: string | null | undefined): string {
  const norm = (raw ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  return norm.length >= 3 ? norm.slice(0, 3) : "";
}

export function officialFirstKey(first: string | null, full: string | null): string {
  return firstNameKey(first) || firstNameKey((full ?? "").split(/\s+/)[0]);
}

// ---------------------------------------------------------------------------
// Branch boundary — DERIVED from the data, not hardcoded.
//
// The raw shared-pair count is the wrong instrument: 90 shared pairs out of an
// official's 100 rows is damning, 90 out of 45,000 is noise. Measured on this
// data the raw counts are NOT bimodal — they spread near-continuously from 0 to
// the maximum. So the boundary is drawn on the OVERLAP FRACTION (shared / the
// suspect's own donation rows), which normalises for size and IS bimodal.
//
// The cut is the midpoint of the widest empty band in the observed fraction
// distribution, searched within [BAND_LO, BAND_HI] — outside that range a "gap"
// is just the distribution's own sparse tail, not a boundary.
//
// A second, absolute floor guards ONE specific corner the fraction cannot see:
// an official with 2 donation rows that both happen to land on a same-surname
// twin scores frac=1.0 by coincidence (one PAC giving to two same-surname
// officials in a cycle is entirely ordinary). The floor is derived from the low
// tail of the shared-count distribution AMONG SUSPECTS THAT ALREADY PASS THE
// FRACTION CUT — that is the only population it operates on, so it is the only
// population it should be measured against. Deriving it from the below-cut
// population instead gives a wildly inflated floor: high-volume officials sit
// below the cut while still sharing hundreds of pairs in absolute terms.
// ---------------------------------------------------------------------------

export const BAND_LO = 0.02;
export const BAND_HI = 0.6;
/** Above this many shared pairs, coincidence stops being a plausible story. */
export const FLOOR_SEARCH_HI = 50;

export interface Boundary {
  fracCut: number;
  gapLo: number;
  gapHi: number;
  gapWidth: number;
  sharedFloor: number;
  floorGapLo: number;
  floorGapHi: number;
  bimodal: boolean;
}

/** Midpoint + edges of the widest empty band in `values` within [lo, hi]. */
export function widestGap(
  values: number[],
  lo: number,
  hi: number,
): { gapLo: number; gapHi: number; width: number } {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  let gapLo = lo;
  let gapHi = hi;
  let width = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (b < lo || a > hi) continue;
    if (b - a > width) {
      width = b - a;
      gapLo = a;
      gapHi = b;
    }
  }
  return { gapLo, gapHi, width };
}

export function deriveBoundary(rows: Array<{ frac: number; shared: number }>): Boundary {
  const fg = widestGap(rows.map((r) => r.frac), BAND_LO, BAND_HI);
  const fracCut = fg.width > 0 ? (fg.gapLo + fg.gapHi) / 2 : BAND_HI;

  // Floor: low tail of the shared counts among suspects that clear the cut.
  const above = rows.filter((r) => r.frac >= fracCut).map((r) => r.shared);
  const sg = widestGap(above, 1, FLOOR_SEARCH_HI);
  const sharedFloor = sg.width > 0 ? sg.gapHi : 1;

  const nBelow = rows.filter((r) => r.frac < fracCut).length;
  const bimodal = fg.width >= 0.05 && nBelow > 0 && above.length > 0;

  return {
    fracCut,
    gapLo: fg.gapLo,
    gapHi: fg.gapHi,
    gapWidth: fg.width,
    sharedFloor,
    floorGapLo: sg.gapLo,
    floorGapHi: sg.gapHi,
    bimodal,
  };
}

// ---------------------------------------------------------------------------
// Seat agreement
//
// A FEC CAND_ID encodes the seat: office in char 0 (H/S/P), a cycle digit in
// char 1, then the two-letter state in chars 2-3. `H8TN07076` is a Tennessee
// House seat, `S8GA00180` a Georgia Senate seat. Both halves are compared —
// chamber alone is far too coarse, since most suspects are Representatives
// and would therefore agree on chamber by default.
// ---------------------------------------------------------------------------

export const fecOffice = (id: string | null): string => (id ?? "")[0]?.toUpperCase() ?? "";
export const fecState = (id: string | null): string => (id ?? "").slice(2, 4).toUpperCase();

/**
 * Suspect's jurisdiction vs the state baked into the twin's CAND_ID.
 * Municipal jurisdictions (AUS, SF, …) are not two-letter state codes and can
 * never match a federal seat — which is the correct answer for them.
 */
export function stateAgrees(e: EnrichedRow): boolean {
  return stateMatches(e.jurisdiction, e.twin_fec_id);
}

/** Lower-level form of `stateAgrees`, usable against any CAND_ID. */
export function stateMatches(jurisdiction: string | null, fecId: string | null): boolean {
  const ours = (jurisdiction ?? "").toUpperCase();
  const theirs = fecState(fecId);
  return ours.length === 2 && theirs.length === 2 && ours === theirs;
}

/**
 * Does `fecId` describe the seat an official with this role + jurisdiction
 * actually holds? Chamber AND state — chamber alone is far too coarse.
 */
export function seatMatches(
  roleTitle: string | null,
  jurisdiction: string | null,
  fecId: string | null,
): boolean {
  const office = fecOffice(fecId);
  if (!office) return false;
  // FIX-1025 — one rule, ../pipelines/fec-bulk/electable-role. This was a
  // fourth hand-written spelling of the same office↔role table. Anything not in
  // it (Council Member, Mayor, agency titles…) holds no federal seat at all, so
  // a federal CAND_ID can never legitimately be theirs.
  if (!roleMayHoldFecOffice(roleTitle, office)) return false;
  return stateMatches(jurisdiction, fecId);
}

/** Does the twin's FEC id describe the seat this suspect actually holds? */
export function seatAgrees(e: EnrichedRow): boolean {
  return seatMatches(e.role_title, e.jurisdiction, e.twin_fec_id);
}

/**
 * Same-person evidence is the UNION of two independent signals, because
 * neither alone survives contact with this data:
 *
 *   name  — the two first names agree on a 3-letter key.
 *   seat  — the twin's CAND_ID describes the seat this official actually
 *           holds (chamber AND state).
 *
 * Name alone is not sufficient. FEC files candidates under their LEGAL name
 * while we hold the name they go by, and that pair disagrees constantly:
 * Ted/Rafael Cruz, Mike/James Johnson, Jack/John Reed, Bill/William Cassidy,
 * Jim/James Banks, Andy/Garland Barr — ten of the top twelve overlaps on this
 * clone. Routing those into CROSS-PERSON tells PR 2 to delete a person's own
 * donors as if they were someone else's, so name-only is not merely imprecise
 * here, it is destructive.
 *
 * Nor is name alone NECESSARY: a first name can be uncomparable because the
 * twin is an FEC initial (cn{yy} mints candidate rows from CAND_NAME and
 * parseFecName reduces a leading initial cluster to the initial, so Jon
 * Ossoff's own candidate row is literally named "T Ossoff") or because the
 * suspect's own first name is under three letters ("Ro" Khanna, "Al" Green).
 * Undecidable is not "disagrees".
 *
 * Seat alone is not sufficient either — it cannot see municipal officials at
 * all, and Scott Wiener / Connie Chan are same-name pairs on a city seat.
 *
 * The union keeps both reference cases right for the RIGHT reason:
 *   Shontel Brown  Representative-OH vs Sherrod's S6OH00163 (Senate) →
 *                  names disagree AND seat disagrees → CROSS-PERSON.
 *   Jon Ossoff     Senator-GA vs S8GA00180 → name undecidable, seat agrees →
 *                  SAME-PERSON.
 */
export function branchOf(
  e: EnrichedRow,
  boundary: Boundary,
): { branch: Branch; decidedBy: string } {
  const overlapping =
    e.twin_id !== null && e.frac >= boundary.fracCut && e.shared >= boundary.sharedFloor;
  if (!overlapping) return { branch: "UNIQUE HOLDER", decidedBy: "" };

  const a = officialFirstKey(e.first_name, e.full_name);
  const b = officialFirstKey(e.twin_first_name, e.twin_name);
  const nameOk = a !== "" && b !== "" && a === b;
  const seatOk = seatAgrees(e);

  if (!nameOk && !seatOk) return { branch: "CROSS-PERSON MISATTRIBUTION", decidedBy: "neither" };
  return {
    branch: "SAME-PERSON DUPLICATE",
    decidedBy: nameOk && seatOk ? "name+seat" : nameOk ? "name" : "seat",
  };
}

/**
 * FIX-1064 — has a CROSS-PERSON delete remediation demonstrably landed?
 *
 * Asked of a reference case that has LEFT the suspect population, where "is it
 * in the expected branch" can no longer be evaluated. The question is not "is
 * this row empty" — that describes a phantom/duplicate row, and the reference
 * case is a sitting Representative who legitimately holds her own donors and
 * her own CAND_ID. The question is whether the MIS-BOUND money is gone.
 *
 * Two things must hold:
 *   1. the residual overlap against the named twin no longer clears the
 *      classifier's own boundary — i.e. `branchOf` would not call this row
 *      CROSS-PERSON MISATTRIBUTION again;
 *   2. the row does not claim the twin's CAND_ID, which IS the mis-binding.
 *
 * Deliberately expressed with `branchOf`'s exact conjunction rather than a
 * hardcoded count, so the guard moves when the boundary moves. Neither input
 * comes from SUSPECT_SQL, so a broken suspect predicate cannot fake a pass —
 * which is the property the whole reference-case check exists to have.
 */
export function deleteEvidenceCleared(
  facts: { twinShared: number; ownRows: number; claimsTwinCandId: boolean },
  boundary: Pick<Boundary, "fracCut" | "sharedFloor">,
): { ok: boolean; frac: number; stillOverlapping: boolean } {
  const frac = facts.ownRows > 0 ? facts.twinShared / facts.ownRows : 0;
  const stillOverlapping =
    frac >= boundary.fracCut && facts.twinShared >= boundary.sharedFloor;
  return { ok: !stillOverlapping && !facts.claimsTwinCandId, frac, stillOverlapping };
}

export type ClassifiedRow = EnrichedRow & { branch: Branch; decidedBy: string; stateOk: boolean };

/** Enrich + derive the boundary + classify, in one pass. */
export function classify(rows: SuspectRow[]): { boundary: Boundary; classified: ClassifiedRow[] } {
  const enriched = enrich(rows);
  const boundary = deriveBoundary(enriched.map((e) => ({ frac: e.frac, shared: e.shared })));
  const classified = enriched.map((e) => {
    const { branch, decidedBy } = branchOf(e, boundary);
    return { ...e, branch, decidedBy, stateOk: stateAgrees(e) };
  });
  return { boundary, classified };
}

// ---------------------------------------------------------------------------
// FIX-934 — CROSS-PERSON decomposition
//
// WHY THIS IS ROW-LEVEL AND NOT PER-OFFICIAL
// ------------------------------------------
// The PR-2b design assumed one suspect maps to ONE diverted CAND_ID, so a
// single collision rate against the best twin would classify it DIVERTED (move
// the money) or DUPLICATED (delete it). Measured on the data that assumption is
// false, and the reference case is the one the design was written around:
//
//   David Porter (federal judge) holds $7,391,766 in 6,133 rows, which decompose
//   by cycle into THREE different people's money —
//     2024  5,660 rows  $5,693,249  100% held by Katherine Porter  S4CA00522
//     2026     31 rows     $25,510  100% held by Ferguson Porter   H6CA41232
//     2020+22 442 rows  $1,673,007  held by NOBODY (all PAC, Orange-County
//                                   signature — Katie Porter's HOUSE money,
//                                   whose row H8CA45130 sits at $0)
//
// A surname-matched suspect accumulates money from EVERY same-surname CAND_ID
// the matcher ever mis-resolved, so composite holdings are the normal shape
// rather than the exception. A whole-official collision rate against the single
// best twin reports 92.3% for that judge — close enough to "~100%" to read as
// DUPLICATED, which would delete $1,673,007 that no other row holds.
//
// So the unit of analysis is the ROW, not the official: a row whose
// (relationship_type, from_id, cycle_year) key is already held by a
// surname-matched FEC-bound official is DUPLICATED (deleting it loses nothing);
// a row held by nobody is DIVERTED (it is the only copy, so it must be moved,
// never deleted). The per-official verdict is then just the shape of its own
// row split, and MIXED is a description rather than a failure.
// ---------------------------------------------------------------------------

/**
 * Candidate owners for each suspect: same normalised surname, carrying any FEC
 * id. Surname scope is not a convenience cut — the mis-binding mechanism is
 * byLastName-pool-driven, so a wrong binding is ALWAYS same-surname.
 *
 * Expects a temp table `_xp(suspect_id uuid)`.
 */
export const OWNER_SQL = `
DROP TABLE IF EXISTS _owner;
CREATE TEMP TABLE _owner AS
SELECT x.suspect_id,
       o.id                                AS owner_id,
       o.full_name                         AS owner_name,
       o.first_name                        AS owner_first,
       o.tier                              AS owner_tier,
       o.role_title                        AS owner_role,
       COALESCE(o.source_ids->>'fec_candidate_id', o.source_ids->>'fec_id') AS fec_id,
       COALESCE((SELECT sum(fr.amount_cents) FROM financial_relationships fr
                  WHERE fr.to_type='official' AND fr.relationship_type='donation'
                    AND fr.to_id = o.id), 0)::bigint AS owner_donation_cents
  FROM _xp x
  JOIN officials s ON s.id = x.suspect_id
  JOIN officials o
    ON o.id <> s.id
   AND regexp_replace(upper(COALESCE(NULLIF(o.last_name,''), o.full_name)), '[^A-Z]', '', 'g')
     = regexp_replace(upper(COALESCE(NULLIF(s.last_name,''), s.full_name)), '[^A-Z]', '', 'g')
 WHERE COALESCE(o.source_ids->>'fec_candidate_id', o.source_ids->>'fec_id') IS NOT NULL
   AND regexp_replace(upper(COALESCE(NULLIF(s.last_name,''), s.full_name)), '[^A-Z]', '', 'g') <> '';
CREATE INDEX ON _owner(suspect_id);
`;

/**
 * Every (suspect row, owner) pair that would COLLIDE under
 * financial_relationships_relcycle_unique if that row's to_id moved to that
 * owner.
 *
 * `=` rather than IS NOT DISTINCT FROM on from_id / cycle_year: the index is
 * NULLS DISTINCT, so NULL-keyed rows do not actually collide. (Measured 0 NULL
 * from_id and 0 NULL cycle_year across all 2,786,610 official-donation rows.)
 *
 * SHAPE: both sides are materialized into small temp tables first and then
 * hash-joined. The obvious formulation — join the suspect's rows straight back
 * against `financial_relationships` on all four index columns — looks like a
 * cheap index lookup per row, but it is a nested loop of roughly
 * (suspect rows x same-surname owners) btree descents into the 8.3M-row index:
 * measured >12 min on local Docker without finishing, against a 15-minute
 * statement_timeout. Materializing costs two bounded scans over
 * `financial_relationships_to` and turns the probe into a hash lookup.
 */
export const ROWHIT_SQL = `
DROP TABLE IF EXISTS _skey;
CREATE TEMP TABLE _skey AS
SELECT fr.id AS row_id, fr.to_id AS suspect_id, fr.relationship_type,
       fr.from_id, fr.cycle_year, fr.amount_cents
  FROM financial_relationships fr
  JOIN _xp x ON x.suspect_id = fr.to_id
 WHERE fr.to_type = 'official';

DROP TABLE IF EXISTS _okey;
CREATE TEMP TABLE _okey AS
SELECT ow.suspect_id, ow.owner_id, b.relationship_type, b.from_id, b.cycle_year,
       b.amount_cents AS owner_amount_cents
  FROM _owner ow
  JOIN financial_relationships b
    ON b.to_type = 'official' AND b.to_id = ow.owner_id;

ANALYZE _skey;
ANALYZE _okey;

DROP TABLE IF EXISTS _rowhit;
CREATE TEMP TABLE _rowhit AS
SELECT k.row_id, k.suspect_id, o.owner_id, k.relationship_type, k.cycle_year, k.amount_cents,
       o.owner_amount_cents
  FROM _skey k
  JOIN _okey o
    ON o.suspect_id        = k.suspect_id
   AND o.relationship_type = k.relationship_type
   AND o.from_id           = k.from_id
   AND o.cycle_year        = k.cycle_year;
CREATE INDEX ON _rowhit(suspect_id);
CREATE INDEX ON _rowhit(row_id);
ANALYZE _rowhit;
`;

/**
 * Amount parity on the deletable (CROSS) rows.
 *
 * "The true owner already holds it, so deleting the suspect's copy loses
 * nothing" is only true if the two copies carry the SAME amount. They are
 * aggregated rows (`aggregated: true, tx_count: N`), so two bindings written by
 * runs at different times can hold different cumulative totals for the same
 * (relationship_type, from_id, cycle_year) key — and the suspect's copy is
 * sometimes the LARGER one. Measured on Shontel M. Brown: 42,681 shared keys
 * against Sherrod Brown, of which 533 disagree, with the suspect's side higher
 * by $455,149 in aggregate. A plain delete would destroy that difference rather
 * than de-duplicate it, so phase 2 needs FIX-933's fresher-wins rule on these
 * rows, not an unconditional delete.
 */
export const PARITY_SQL = `
SELECT p.suspect_id,
       count(*)::bigint                                                        AS cross_rows,
       count(*) FILTER (WHERE p.suspect_cents <> p.owner_cents)::bigint        AS mismatch_rows,
       COALESCE(sum(p.suspect_cents - p.owner_cents)
                FILTER (WHERE p.suspect_cents > p.owner_cents), 0)::bigint     AS suspect_excess_cents,
       COALESCE(sum(p.owner_cents - p.suspect_cents)
                FILTER (WHERE p.owner_cents > p.suspect_cents), 0)::bigint     AS owner_excess_cents
  FROM (
    SELECT rc.suspect_id, rc.row_id,
           rc.amount_cents             AS suspect_cents,
           max(h.owner_amount_cents)   AS owner_cents
      FROM _rowclass rc
      JOIN _rowhit h   ON h.row_id = rc.row_id
      JOIN _ownrel rel ON rel.suspect_id = h.suspect_id AND rel.owner_id = h.owner_id
                      AND rel.relation = 'CROSS'
     WHERE rc.class = 'CROSS'
     GROUP BY 1,2,3) p
 GROUP BY 1;
`;

export interface ParityRow {
  suspect_id: string;
  cross_rows: string;
  mismatch_rows: string;
  suspect_excess_cents: string;
  owner_excess_cents: string;
}

/** The `_owner` table verbatim, so owners can be SAME/CROSS-classified in TS. */
export const ALL_OWNERS_SQL = `
SELECT suspect_id, owner_id, owner_name, owner_first, owner_tier, owner_role, fec_id,
       owner_donation_cents
  FROM _owner ORDER BY suspect_id, fec_id;
`;

export interface OwnerBase {
  suspect_id: string;
  owner_id: string;
  owner_name: string | null;
  owner_first: string | null;
  owner_tier: string | null;
  owner_role: string | null;
  fec_id: string | null;
  owner_donation_cents: string;
}

export type OwnerRelation = "SAME" | "CROSS";

/**
 * Is this owner the SAME human as the suspect, or a different one?
 *
 * THIS IS THE DISTINCTION THE WHOLE-OFFICIAL MODEL COLLAPSED, AND IT DECIDES
 * WHETHER A DUPLICATED ROW MAY BE DELETED.
 *
 * The FIX-930 branch classifier answers same-vs-cross once, for the suspect
 * against its single best-overlap twin. But a suspect overlaps MANY
 * same-surname owners, and they are not all the same kind of counterparty. Two
 * measured cases where the best twin is a different person but a lesser-overlap
 * owner is the suspect HERSELF:
 *
 *   Shontel M. Brown  (Representative, OH-11)
 *     best twin  Sherrod Brown   S6OH00163   $47.3M  → different person
 *     but also   M Brown         H2OH11169    $2.3M  → Candidate for
 *                Representative, OH, district 11 — HER OWN candidate row.
 *   Al Green  (Representative, TX-9)
 *     also       Alexander Green H4TX09095    $1.2M  → Candidate for
 *                Representative, TX, district 09 — HIS OWN row; FEC files his
 *                legal name, so the first names disagree on the surface.
 *
 * Deleting the suspect's side of a SAME-person overlap deletes a sitting
 * member's own money from their own page. Those pairs are FIX-933 merges (the
 * ELECTED row survives, the candidate row is neutralised) — the opposite
 * direction from a cross-person delete.
 *
 * Uses the same union-of-two-signals rule as `branchOf`, for the same reasons:
 * name alone is unreliable (FEC files legal names) and seat alone cannot see
 * municipal officials.
 */
export function ownerRelation(
  suspect: {
    first_name: string | null;
    full_name: string;
    role_title: string | null;
    jurisdiction: string | null;
  },
  owner: Pick<OwnerBase, "owner_first" | "owner_name" | "fec_id">,
): { relation: OwnerRelation; decidedBy: string } {
  const a = officialFirstKey(suspect.first_name, suspect.full_name);
  const b = officialFirstKey(owner.owner_first, owner.owner_name);
  const nameOk = a !== "" && b !== "" && a === b;
  const seatOk = seatMatches(suspect.role_title, suspect.jurisdiction, owner.fec_id);
  if (!nameOk && !seatOk) return { relation: "CROSS", decidedBy: "neither" };
  return {
    relation: "SAME",
    decidedBy: nameOk && seatOk ? "name+seat" : nameOk ? "name" : "seat",
  };
}

/**
 * Classify every suspect row by the STRONGEST claim on it. Expects a temp table
 * `_ownrel(suspect_id uuid, owner_id uuid, relation text)`.
 *
 * SAME wins over CROSS deliberately: if the suspect's own candidate row holds
 * the same key, the money is the suspect's own regardless of which other people
 * also happen to hold it, and it must not be deleted from the suspect.
 */
export const ROWCLASS_SQL = `
DROP TABLE IF EXISTS _rowclass;
CREATE TEMP TABLE _rowclass AS
SELECT k.row_id, k.suspect_id, k.amount_cents, k.cycle_year, k.relationship_type,
       CASE WHEN bool_or(rel.relation = 'SAME')  THEN 'SAME'
            WHEN count(rel.relation) > 0         THEN 'CROSS'
            ELSE 'DIVERTED' END AS class
  FROM _skey k
  LEFT JOIN _rowhit h  ON h.row_id = k.row_id
  LEFT JOIN _ownrel rel ON rel.suspect_id = h.suspect_id AND rel.owner_id = h.owner_id
 GROUP BY 1,2,3,4,5;
CREATE INDEX ON _rowclass(suspect_id);
ANALYZE _rowclass;
`;

/**
 * Per-suspect three-way split.
 *
 *   same_*  — duplicated against the suspect's OWN other row. FIX-933 merge
 *             territory; the suspect KEEPS this money.
 *   cross_* — duplicated against a DIFFERENT person who already holds it.
 *             Deletable from the suspect; that is the only safe delete here.
 *   div_*   — held by nobody. The only copy, so it can only ever be moved.
 */
export const SPLIT_SQL = `
SELECT s.suspect_id,
       COALESCE(c.total_rows, 0)::bigint  AS total_rows,
       COALESCE(c.total_cents, 0)::bigint AS total_cents,
       COALESCE(c.same_rows, 0)::bigint   AS same_rows,
       COALESCE(c.same_cents, 0)::bigint  AS same_cents,
       COALESCE(c.cross_rows, 0)::bigint  AS cross_rows,
       COALESCE(c.cross_cents, 0)::bigint AS cross_cents,
       COALESCE(c.div_rows, 0)::bigint    AS div_rows,
       COALESCE(c.div_cents, 0)::bigint   AS div_cents
  FROM _xp s
  LEFT JOIN LATERAL (
        SELECT count(*)::bigint                                                  AS total_rows,
               COALESCE(sum(r.amount_cents), 0)::bigint                          AS total_cents,
               count(*) FILTER (WHERE r.class='SAME')::bigint                    AS same_rows,
               COALESCE(sum(r.amount_cents) FILTER (WHERE r.class='SAME'), 0)::bigint  AS same_cents,
               count(*) FILTER (WHERE r.class='CROSS')::bigint                   AS cross_rows,
               COALESCE(sum(r.amount_cents) FILTER (WHERE r.class='CROSS'), 0)::bigint AS cross_cents,
               count(*) FILTER (WHERE r.class='DIVERTED')::bigint                AS div_rows,
               COALESCE(sum(r.amount_cents) FILTER (WHERE r.class='DIVERTED'), 0)::bigint AS div_cents
          FROM _rowclass r WHERE r.suspect_id = s.suspect_id) c ON TRUE;
`;

/** Per-(suspect, owner) overlap — which owner already holds how much of it. */
export const PER_OWNER_SQL = `
SELECT r.suspect_id, r.owner_id, o.owner_name, o.fec_id, o.owner_tier, o.owner_role,
       o.owner_donation_cents, rel.relation,
       count(*)::bigint                       AS shared_rows,
       COALESCE(sum(r.amount_cents), 0)::bigint AS shared_cents,
       min(r.cycle_year)                      AS first_cycle,
       max(r.cycle_year)                      AS last_cycle
  FROM _rowhit r
  JOIN _owner o    ON o.suspect_id = r.suspect_id AND o.owner_id = r.owner_id
  JOIN _ownrel rel ON rel.suspect_id = r.suspect_id AND rel.owner_id = r.owner_id
 GROUP BY 1,2,3,4,5,6,7,8
 ORDER BY r.suspect_id, shared_rows DESC;
`;

/**
 * The DIVERTED residue, per suspect and cycle: rows NO surname-matched
 * FEC-bound official holds. These are the only copy of that money, so they can
 * only ever be MOVED — deleting them destroys data. Reported per cycle because
 * that is the axis the composite splits on.
 */
export const DIVERTED_SQL = `
SELECT r.suspect_id, r.relationship_type, r.cycle_year,
       count(*)::bigint                          AS rows,
       COALESCE(sum(r.amount_cents), 0)::bigint  AS cents,
       count(*) FILTER (WHERE fr.metadata->>'fec_committee_id' IS NOT NULL)::bigint AS pac_rows
  FROM _rowclass r
  JOIN financial_relationships fr ON fr.id = r.row_id
 WHERE r.class = 'DIVERTED'
 GROUP BY 1,2,3
 ORDER BY 1,2,3;
`;

/**
 * Same-surname FEC-bound officials holding at or near $0 — the candidate
 * destinations for a suspect's DIVERTED rows. A $0 row adjacent to a suspect
 * holding money is the strongest reattribution signal available, but it is a
 * HYPOTHESIS: nothing in financial_relationships records which CAND_ID a row
 * was written for (metadata carries only `source`, `tx_count`, `aggregated`,
 * `donor_fingerprint` or `fec_committee_id` — never a CAND_ID), so the owner
 * cannot be DERIVED from the money. It has to be reviewed.
 */
export const ZERO_OWNER_SQL = `
SELECT suspect_id, owner_id, owner_name, fec_id, owner_tier, owner_role, owner_donation_cents
  FROM _owner
 WHERE owner_donation_cents = 0
 ORDER BY suspect_id, fec_id;
`;

export interface SplitRow {
  suspect_id: string;
  total_rows: string;
  total_cents: string;
  same_rows: string;
  same_cents: string;
  cross_rows: string;
  cross_cents: string;
  div_rows: string;
  div_cents: string;
}

export interface OwnerRow {
  suspect_id: string;
  owner_id: string;
  owner_name: string | null;
  fec_id: string | null;
  owner_tier: string | null;
  owner_role: string | null;
  owner_donation_cents: string;
  relation: OwnerRelation;
  shared_rows: string;
  shared_cents: string;
  first_cycle: number | null;
  last_cycle: number | null;
}

export interface DivertedRow {
  suspect_id: string;
  relationship_type: string;
  cycle_year: number | null;
  rows: string;
  cents: string;
  pac_rows: string;
}

export interface ZeroOwnerRow {
  suspect_id: string;
  owner_id: string;
  owner_name: string | null;
  fec_id: string | null;
  owner_tier: string | null;
  owner_role: string | null;
  owner_donation_cents: string;
}

export type Verdict = "DIVERTED" | "DUPLICATED" | "MIXED" | "SELF-SPLIT" | "EMPTY";

/**
 * Verdict from the three-way row split. `MIXED` is a real and common outcome —
 * see the header — not an error state; it means the remediation for that
 * official is per-row rather than per-official.
 *
 * `SELF-SPLIT` means every duplicated row belongs to the suspect themselves, so
 * NOTHING here may be deleted from them — it is a FIX-933 same-person merge
 * wearing a cross-person label, and it belongs in that PR rather than this one.
 */
export function verdictOf(sameRows: number, crossRows: number, divRows: number): Verdict {
  if (sameRows + crossRows + divRows === 0) return "EMPTY";
  if (crossRows === 0 && divRows === 0) return "SELF-SPLIT";
  if (divRows === 0 && sameRows === 0) return "DUPLICATED";
  if (crossRows === 0 && sameRows === 0) return "DIVERTED";
  return "MIXED";
}

// ---------------------------------------------------------------------------
// Connection helpers — shared by the audit and the remediation scripts so
// "which DB am I on" is answered exactly one way.
// ---------------------------------------------------------------------------

export function constructDbUrlFromEnv(): string {
  const explicit = process.env["SUPABASE_DB_URL"];
  if (explicit) return explicit;
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  if (!supabaseUrl) return "";
  if (/127\.0\.0\.1:54321|localhost:54321/.test(supabaseUrl)) {
    return "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  }
  const m = supabaseUrl.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!m) return "";
  const password = process.env["SUPABASE_DB_PASSWORD"];
  if (!password) return "";
  const region = process.env["SUPABASE_DB_REGION"] ?? "us-west-2";
  return `postgresql://postgres.${m[1]}:${encodeURIComponent(password)}@aws-0-${region}.pooler.supabase.com:5432/postgres`;
}

export function envLabel(): "local" | "prod" {
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "";
  return /127\.0\.0\.1|localhost/.test(url) ? "local" : "prod";
}

/** node-postgres hands bigint columns back as strings, so accept those too. */
export const usd = (cents: number | bigint | string): string =>
  `$${(Number(cents) / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
