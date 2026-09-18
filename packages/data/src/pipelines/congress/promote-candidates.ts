/**
 * Candidate → elected promotion (FIX-248).
 *
 * Detects pairs of officials rows where the same real person exists twice —
 * once as a freshly-created congress-side `tier='elected'` row (with
 * source_ids->>'congress_gov' = bioguide_id) and once as the prior
 * `tier='candidate'` row from the FEC cn{yy}.zip ingest (with
 * source_ids->>'fec_candidate_id').
 *
 * For each match, calls the SQL function `promote_candidate_to_elected()`
 * which transactionally:
 *   - promotes the candidate row in-place (tier→elected, merges source_ids,
 *     adopts elected's role_title / jurisdiction / governing_body)
 *   - rewrites every FK reference (votes, financial_relationships,
 *     entity_connections, external_*, irs990_*, entity_tags, …) from the
 *     elected row's UUID to the candidate row's UUID
 *   - deletes the elected row
 *
 * The candidate row "wins" UUID-wise because it's bound to FEC IE attribution
 * via FIX-240's fec_candidate_id, and changing that UUID would orphan the
 * existing IE relationships.
 *
 * Detection key: (normalized_full_name, state, role_title_family) where
 *   role_title_family ∈ {senator, representative}
 * Presidential candidates are out of scope here — the seeded POTUS/VPOTUS
 * rows live under official_seed_id, not bioguide_id, and FIX-375 handles
 * common-name dedup separately.
 */

import type { createAdminClient } from "@civitics/db";
import { afterKey } from "@civitics/db";
import { promoteCandidatesDirect } from "../../lib/heavy-rebuild";

type Db = ReturnType<typeof createAdminClient>;

export interface PromoteCandidatesResult {
  pairsDetected: number;
  /**
   * FIX-1196 — active elected rows in a scope family that were REFUSED as
   * promotion inputs because they already hold `source_ids.fec_candidate_id`.
   * See `selectPromotionPairs`.
   */
  skippedBound:  number;
  promoted:      number;
  failed:        number;
  details:       Array<{
    candidateId:    string;
    electedId:      string;
    fullName:       string;
    state:          string;
    roleFamily:     string;
    totalFksMoved?: number;
    votesMoved?:    number;
    error?:         string;
  }>;
}

/** "Senator" → "senator", "Representative" → "representative", else null. */
function roleFamilyOf(roleTitle: string | null): "senator" | "representative" | null {
  if (!roleTitle) return null;
  const t = roleTitle.trim().toLowerCase();
  if (t === "senator")        return "senator";
  if (t === "representative") return "representative";
  return null;
}

/** "Candidate for Senator" → "senator", "Candidate for Representative" → "representative", else null. */
function candidateRoleFamilyOf(roleTitle: string | null): "senator" | "representative" | null {
  if (!roleTitle) return null;
  const t = roleTitle.trim().toLowerCase();
  if (t === "candidate for senator")        return "senator";
  if (t === "candidate for representative") return "representative";
  return null;
}

function normName(s: string | null): string {
  if (!s) return "";
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface ElectedInput {
  id:               string;
  full_name:        string;
  role_title:       string;
  state_short:      string | null;
  /** `source_ids.fec_candidate_id`, or null. FIX-1196's guard reads this. */
  fec_candidate_id: string | null;
}

export interface CandidateInput {
  id:         string;
  full_name:  string;
  role_title: string;
  state:      string | null;
}

export interface PromotionPair {
  electedId:   string;
  candidateId: string;
  fullName:    string;
  state:       string;
  roleFamily:  string;
}

export interface PromotionSelection {
  pairs:        PromotionPair[];
  /** FIX-1196 — elected rows refused by the bound-identity guard. */
  skippedBound: number;
}

/**
 * Pair selection — pure, so the guards below are testable without a database.
 *
 * FIX-1196 — THE BOUND-IDENTITY GUARD. An elected row that already holds
 * `source_ids.fec_candidate_id` is never a promotion input.
 *
 * The FIX-248 promotion is a row-DELETING operation: it moves every FK onto the
 * candidate row and deletes the elected one. Its only safety rail is the
 * ambiguity guard below (`matches.length !== 1`) — a lone same-key candidate is
 * taken as "this is the same person, freshly elected".
 *
 * That inference is false for a row that is already FEC-bound. A shared-CAND_ID
 * merge retires the stubs around a sitting member, which DROPS that member's
 * same-key candidate count to exactly one — so the merge itself manufactures the
 * lone match the promotion treats as licence, and the next nightly deletes the
 * merge's own survivor. That is the FIX-1196 mechanism, and it is what deleted
 * three of set 1's survivors on 2026-09-17.
 *
 * An elected row holding an authoritative FEC claim is already bound to its FEC
 * identity; whatever candidate rows still share its name are a different office
 * or a different cycle. Reconciling those is
 * `merge-same-person-official-dupes`' `--manifest` / `--promote-manifest`
 * business — a reviewed, per-row authorisation that keeps both rows — not a
 * row-deleting promotion that fires unattended every night.
 *
 * The guard runs BEFORE indexing, so a bound row never even reaches the
 * ambiguity test.
 */
export function selectPromotionPairs(
  electedRows:   ElectedInput[],
  candidateRows: CandidateInput[],
): PromotionSelection {
  const pairs: PromotionPair[] = [];
  let skippedBound = 0;

  // ── Index candidate rows by (name|state|family).
  const candidateIndex = new Map<string, Array<{ id: string; full_name: string; state: string | null }>>();
  for (const c of candidateRows) {
    if (!c.state) continue;
    const fam = candidateRoleFamilyOf(c.role_title);
    if (!fam) continue;
    const key = `${normName(c.full_name)}|${c.state}|${fam}`;
    const bucket = candidateIndex.get(key) ?? [];
    bucket.push({ id: c.id, full_name: c.full_name, state: c.state });
    candidateIndex.set(key, bucket);
  }

  // ── For each elected row, collect a single unambiguous candidate match.
  for (const e of electedRows) {
    // FIX-1196 — bound identity: refuse before indexing. See the doc comment.
    if (e.fec_candidate_id) { skippedBound++; continue; }
    if (!e.state_short) continue;
    const fam = roleFamilyOf(e.role_title);
    if (!fam) continue;
    const key = `${normName(e.full_name)}|${e.state_short.toUpperCase()}|${fam}`;
    const matches = candidateIndex.get(key) ?? [];
    if (matches.length !== 1) continue; // skip ambiguous or no-match
    const cand = matches[0]!;
    if (cand.id === e.id) continue; // shouldn't happen given the source_ids filters

    pairs.push({
      electedId:   e.id,
      candidateId: cand.id,
      fullName:    e.full_name,
      state:       e.state_short.toUpperCase(),
      roleFamily:  fam,
    });
  }

  return { pairs, skippedBound };
}

// FIX-755: per-run promotion cap — see the step-5 comment below. ~17s/pair
// keeps a capped run under ~8 min of the daily fec-phase budget.
const PROMOTION_CAP = 25;

export async function runCandidateToElectedPromotion(
  opts: { db: Db }
): Promise<PromoteCandidatesResult> {
  const { db } = opts;
  const out: PromoteCandidatesResult = {
    pairsDetected: 0,
    skippedBound:  0,
    promoted:      0,
    failed:        0,
    details:       [],
  };

  // ── 1. Load all active elected rows with a bioguide_id, in scope families.
  // Need their jurisdiction's short_name (state code) for matching against
  // candidate rows' metadata->>'state'.
  const electedRows: ElectedInput[] = [];
  {
    const PAGE = 1000;
    let afterId: string | null = null; // FIX-984: keyset cursor, not an OFFSET
    for (;;) {
      const { data, error } = await afterKey(db
        .from("officials")
        .select("id, full_name, role_title, source_ids, jurisdictions(short_name)")
        .filter("source_ids->>congress_gov", "not.is", null)
        .eq("is_active", true)
        // FIX-760 total order / FIX-984 keyset key: the same unique column
        // must appear in .order(), in .limit()'s cursor, and in the seek.
        .order("id")
        .limit(PAGE), "id", afterId);
      if (error) throw new Error(`promote-candidates: elected load: ${error.message}`);
      const rows = (data ?? []) as unknown as Array<{
        id:           string;
        full_name:    string;
        role_title:   string;
        source_ids?:  Record<string, string> | null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        jurisdictions?: { short_name: string | null } | null;
      }>;
      for (const r of rows) {
        const fam = roleFamilyOf(r.role_title);
        if (!fam) continue;
        electedRows.push({
          id:               r.id,
          full_name:        r.full_name,
          role_title:       r.role_title,
          state_short:      r.jurisdictions?.short_name ?? null,
          // FIX-1196 — the guard's input. Selected above but previously unread.
          fec_candidate_id: r.source_ids?.["fec_candidate_id"] ?? null,
        });
      }
      if (rows.length < PAGE) break;
      afterId = rows[rows.length - 1]!.id;
    }
  }

  if (electedRows.length === 0) return out;

  // ── 2. Load all candidate rows in scope families.
  const candidateRows: CandidateInput[] = [];
  {
    const PAGE = 1000;
    let afterId: string | null = null; // FIX-984: keyset cursor, not an OFFSET
    for (;;) {
      const { data, error } = await afterKey(db
        .from("officials")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .select("id, full_name, role_title, metadata" as any)
        .filter("tier", "eq", "candidate")
        .filter("source_ids->>fec_candidate_id", "not.is", null)
        // FIX-760: stable unique order (see elected load above).
        .order("id")
        .limit(PAGE), "id", afterId);
      if (error) throw new Error(`promote-candidates: candidate load: ${error.message}`);
      const rows = (data ?? []) as unknown as Array<{
        id:         string;
        full_name:  string;
        role_title: string;
        metadata?:  Record<string, unknown> | null;
      }>;
      for (const r of rows) {
        const fam = candidateRoleFamilyOf(r.role_title);
        if (!fam) continue;
        const state = (r.metadata?.["state"] as string | null) ?? null;
        candidateRows.push({
          id:         r.id,
          full_name:  r.full_name,
          role_title: r.role_title,
          state:      state ? state.toUpperCase() : null,
        });
      }
      if (rows.length < PAGE) break;
      afterId = rows[rows.length - 1]!.id;
    }
  }

  // ── 3+4. Pair selection (pure — see `selectPromotionPairs`).
  const selection = selectPromotionPairs(electedRows, candidateRows);
  const pairs = selection.pairs;
  out.pairsDetected = pairs.length;
  out.skippedBound  = selection.skippedBound;

  // ── 5. Cap, then promote each pair over a single direct-pg connection with a
  // raised SESSION statement_timeout (FIX-463). Autocommit per pair, so a data
  // error on one pair doesn't abort the rest.
  //
  // FIX-755: per-run promotion cap. Each promotion is ~17s of transactional FK
  // rewrites across ~20 tables; an uncapped run promoted 278 pairs on
  // 2026-07-05 and burned 2h04m of the fec-phase budget before fec_bulk
  // started. A mass event now drains across nights — and loudly. Legit bursts
  // above the cap exist (a new Congress seats ~60-100 freshmen every 2 years);
  // anything whole-chamber-scale means a generator bug (the FIX-755 source_ids
  // clobber was one), so investigate before assuming backlog.
  if (pairs.length > PROMOTION_CAP) {
    console.warn(
      `  ⚠ promote-candidates: detected=${pairs.length} exceeds the per-run cap (${PROMOTION_CAP}) — ` +
        `promoting ${PROMOTION_CAP} this run, deferring ${pairs.length - PROMOTION_CAP} to future nights (FIX-755)`,
    );
  }
  const toPromote = [...pairs]
    .sort((a, b) => a.fullName.localeCompare(b.fullName)) // deterministic drain order across nights
    .slice(0, PROMOTION_CAP);

  const outcomes = await promoteCandidatesDirect(
    toPromote.map((p) => ({ electedId: p.electedId, candidateId: p.candidateId })),
  );
  const pairByElected = new Map(pairs.map((p) => [p.electedId, p]));
  for (const o of outcomes) {
    const p = pairByElected.get(o.electedId)!;
    if (o.error) {
      out.failed++;
      out.details.push({
        candidateId: o.candidateId, electedId: o.electedId,
        fullName: p.fullName, state: p.state, roleFamily: p.roleFamily,
        error: o.error,
      });
      console.error(`  promote-candidates: ${p.fullName} (${p.state} ${p.roleFamily}) failed: ${o.error}`);
      continue;
    }
    out.promoted++;
    out.details.push({
      candidateId:   o.candidateId,
      electedId:     o.electedId,
      fullName:      p.fullName,
      state:         p.state,
      roleFamily:    p.roleFamily,
      votesMoved:    o.result?.votes_moved,
      totalFksMoved: o.result?.total_fks_moved,
    });
    console.log(
      `  promote-candidates: ${p.fullName} (${p.state} ${p.roleFamily}) — ` +
      `${o.result?.votes_moved ?? 0} votes + ${o.result?.total_fks_moved ?? 0} total FKs moved`
    );
  }

  const deferred = pairs.length - toPromote.length;
  console.log(
    `  promote-candidates: detected=${out.pairsDetected} promoted=${out.promoted} failed=${out.failed} ` +
      `skipped_bound=${out.skippedBound}` +
      (deferred > 0 ? ` deferred=${deferred} (cap ${PROMOTION_CAP}, FIX-755)` : "")
  );
  return out;
}
