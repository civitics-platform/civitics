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
  const ours = (e.jurisdiction ?? "").toUpperCase();
  const theirs = fecState(e.twin_fec_id);
  return ours.length === 2 && theirs.length === 2 && ours === theirs;
}

/** Does the twin's FEC id describe the seat this suspect actually holds? */
export function seatAgrees(e: EnrichedRow): boolean {
  const office = fecOffice(e.twin_fec_id);
  if (!office) return false;
  const role = e.role_title ?? "";
  const officeOk =
    (office === "S" && (role === "Senator" || role === "Candidate for Senator")) ||
    (office === "H" && (role === "Representative" || role === "Candidate for Representative")) ||
    (office === "P" && (role === "President" || role === "Candidate for President"));
  // Anything else (Council Member, Mayor, agency titles…) holds no federal
  // seat at all, so a federal CAND_ID can never legitimately be theirs.
  if (!officeOk) return false;
  return stateAgrees(e);
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
