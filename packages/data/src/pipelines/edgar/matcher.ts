/**
 * FIX-253 · Donor matcher (exec / person-shareholder → FEC individual donor).
 *
 * Match rule (V1, conservative — Craig's explicit answer):
 *   exact normalizeName(person) == donor.normalize(display_name)   AND
 *   canonicalizeEntityName(donor.metadata->>'employer') == company.canonical_name
 *
 * Implementation:
 *   - Use the existing donor_fingerprint UNIQUE index for fast prefix range
 *     scan: `donor_fingerprint LIKE '<canonical>|%'`. This pulls all donors
 *     whose normalizeName-of-display-name == canonical, across all ZIPs.
 *   - Filter the result set by employer canonical match.
 *   - 1 employer-matched candidate → auto-link (confidence='high').
 *   - 0 employer-matched but ≥1 name-only candidates → review queue.
 *   - >1 employer-matched candidates → review queue (tie-break needed).
 *   - >50 raw name candidates → review queue (too-many-lastname-hits, mirrors
 *     LittleSis pattern).
 */

import { createAdminClient } from "@civitics/db";
import { canonicalizeEntityName } from "../fec-bulk/writer";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

const MAX_CANDIDATES = 50;

// A canonical "person name" should have at least 2 tokens and be a sensible
// length. Strings like "EXECUTIVE OFFICERS" technically have 2 tokens but the
// def14a parser's blocklist drops them upstream; this is a belt-and-braces
// guard so a slip in the parser can't trigger a million-row LIKE scan.
function looksLikePersonCanonical(canonical: string): boolean {
  if (!canonical) return false;
  if (canonical.length < 4 || canonical.length > 80) return false;
  const tokens = canonical.split(" ").filter(Boolean);
  if (tokens.length < 2 || tokens.length > 6) return false;
  return true;
}

export interface CandidateDonor {
  id:           string;
  displayName:  string;
  employerRaw:  string | null;
}

/**
 * Build the LAST-FIRST permutation of a normalized FIRST-LAST name, swapping
 * the last token to the front. FEC stores donor names as "LAST, FIRST MIDDLE",
 * so the donor_fingerprint is "LAST FIRST [...]|ZIP" — the inverse of EDGAR's
 * "FIRST LAST" filing convention. Until FIX-238 reorders donor canonical_name
 * we have to probe both shapes.
 *
 *   "TIM COOK"           → "COOK TIM"
 *   "JAMIE LEE DIMON"    → "DIMON JAMIE LEE"
 */
function reversedNameOrder(canonical: string): string {
  const tokens = canonical.split(" ").filter(Boolean);
  if (tokens.length < 2) return canonical;
  const last = tokens[tokens.length - 1]!;
  const rest = tokens.slice(0, -1).join(" ");
  return `${last} ${rest}`;
}

/**
 * Pull donor candidates matching either FIRST-LAST or LAST-FIRST normalization
 * from financial_entities. Caps at MAX_CANDIDATES; signals overflow via the
 * second tuple element. Two queries needed because the donor_fingerprint
 * UNIQUE index is on the LAST-FIRST shape (FEC's raw storage) — see FIX-238.
 */
export async function findDonorCandidates(canonical: string): Promise<{ candidates: CandidateDonor[]; overflow: boolean }> {
  if (!looksLikePersonCanonical(canonical)) return { candidates: [], overflow: false };
  const db = createAdminClient() as Db;

  const probes = [canonical, reversedNameOrder(canonical)].filter(
    (v, i, a) => v && a.indexOf(v) === i,
  );
  const merged = new Map<string, CandidateDonor>();
  let overflow = false;

  for (const probe of probes) {
    // LIKE 'prefix|%' against the text_pattern_ops index added in the FIX-253
    // schema migration. Captures every donor whose normalizeName-of-display
    // matches `probe`, across all ZIPs.
    const { data, error } = await db
      .from("financial_entities")
      .select("id, display_name, metadata")
      .eq("entity_type", "individual")
      .like("donor_fingerprint", `${probe}|%`)
      .limit(MAX_CANDIDATES + 1);
    if (error) {
      console.warn(`  [edgar/matcher] findDonorCandidates(${probe}): ${error.message}`);
      continue;
    }
    const rows = (data ?? []) as Array<{ id: string; display_name: string; metadata: Record<string, unknown> | null }>;
    if (rows.length > MAX_CANDIDATES) overflow = true;
    for (const r of rows.slice(0, MAX_CANDIDATES)) {
      if (merged.has(r.id)) continue;
      merged.set(r.id, {
        id:          r.id,
        displayName: r.display_name,
        employerRaw: (r.metadata?.["employer"] as string | null | undefined) ?? null,
      });
      if (merged.size >= MAX_CANDIDATES) break;
    }
    if (merged.size >= MAX_CANDIDATES) break;
  }

  return { candidates: [...merged.values()], overflow };
}

export type MatchOutcome =
  | { kind: "exact"; donor: CandidateDonor }
  | { kind: "name_only"; candidates: CandidateDonor[] }
  | { kind: "too_many"; raw_count: "overflow" }
  | { kind: "none" };

export async function matchPersonToDonor(
  personCanonical: string,
  companyCanonical: string,
): Promise<MatchOutcome> {
  const { candidates, overflow } = await findDonorCandidates(personCanonical);
  if (overflow) return { kind: "too_many", raw_count: "overflow" };
  if (candidates.length === 0) return { kind: "none" };

  const employerMatches = candidates.filter(
    (c) => c.employerRaw && canonicalizeEntityName(c.employerRaw) === companyCanonical,
  );
  if (employerMatches.length === 1) return { kind: "exact", donor: employerMatches[0]! };
  if (employerMatches.length > 1) return { kind: "name_only", candidates: employerMatches };
  return { kind: "name_only", candidates };
}
