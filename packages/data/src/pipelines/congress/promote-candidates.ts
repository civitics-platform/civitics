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
 * rows live under official_seed_id, not bioguide_id, and FIX-A handles
 * common-name dedup separately.
 */

import type { createAdminClient } from "@civitics/db";

type Db = ReturnType<typeof createAdminClient>;

export interface PromoteCandidatesResult {
  pairsDetected: number;
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

export async function runCandidateToElectedPromotion(
  opts: { db: Db }
): Promise<PromoteCandidatesResult> {
  const { db } = opts;
  const out: PromoteCandidatesResult = {
    pairsDetected: 0,
    promoted:      0,
    failed:        0,
    details:       [],
  };

  // ── 1. Load all active elected rows with a bioguide_id, in scope families.
  // Need their jurisdiction's short_name (state code) for matching against
  // candidate rows' metadata->>'state'.
  const electedRows: Array<{
    id:           string;
    full_name:    string;
    role_title:   string;
    state_short:  string | null;
  }> = [];
  {
    const PAGE = 1000;
    let offset = 0;
    for (;;) {
      const { data, error } = await db
        .from("officials")
        .select("id, full_name, role_title, source_ids, jurisdictions(short_name)")
        .filter("source_ids->>congress_gov", "not.is", null)
        .eq("is_active", true)
        .range(offset, offset + PAGE - 1);
      if (error) throw new Error(`promote-candidates: elected load: ${error.message}`);
      const rows = (data ?? []) as unknown as Array<{
        id:           string;
        full_name:    string;
        role_title:   string;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        jurisdictions?: { short_name: string | null } | null;
      }>;
      for (const r of rows) {
        const fam = roleFamilyOf(r.role_title);
        if (!fam) continue;
        electedRows.push({
          id:          r.id,
          full_name:   r.full_name,
          role_title:  r.role_title,
          state_short: r.jurisdictions?.short_name ?? null,
        });
      }
      if (rows.length < PAGE) break;
      offset += PAGE;
    }
  }

  if (electedRows.length === 0) return out;

  // ── 2. Load all candidate rows in scope families.
  const candidateRows: Array<{
    id:         string;
    full_name:  string;
    role_title: string;
    state:      string | null;
  }> = [];
  {
    const PAGE = 1000;
    let offset = 0;
    for (;;) {
      const { data, error } = await db
        .from("officials")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .select("id, full_name, role_title, metadata" as any)
        .filter("tier", "eq", "candidate")
        .filter("source_ids->>fec_candidate_id", "not.is", null)
        .range(offset, offset + PAGE - 1);
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
      offset += PAGE;
    }
  }

  // ── 3. Index candidate rows by (name|state|family).
  const candidateIndex = new Map<string, Array<{ id: string; full_name: string; state: string | null }>>();
  for (const c of candidateRows) {
    if (!c.state) continue;
    const fam = candidateRoleFamilyOf(c.role_title)!;
    const key = `${normName(c.full_name)}|${c.state}|${fam}`;
    const bucket = candidateIndex.get(key) ?? [];
    bucket.push({ id: c.id, full_name: c.full_name, state: c.state });
    candidateIndex.set(key, bucket);
  }

  // ── 4. For each elected row, look for a single candidate match.
  for (const e of electedRows) {
    if (!e.state_short) continue;
    const fam = roleFamilyOf(e.role_title)!;
    const key = `${normName(e.full_name)}|${e.state_short.toUpperCase()}|${fam}`;
    const matches = candidateIndex.get(key) ?? [];
    if (matches.length !== 1) continue; // skip ambiguous or no-match
    const cand = matches[0]!;
    if (cand.id === e.id) continue; // shouldn't happen given the source_ids filters

    out.pairsDetected++;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any).rpc("promote_candidate_to_elected", {
      p_elected_id:   e.id,
      p_candidate_id: cand.id,
    });
    if (error) {
      out.failed++;
      out.details.push({
        candidateId: cand.id, electedId: e.id,
        fullName: e.full_name, state: e.state_short, roleFamily: fam,
        error: error.message,
      });
      console.error(`  promote-candidates: ${e.full_name} (${e.state_short} ${fam}) failed: ${error.message}`);
      continue;
    }
    out.promoted++;
    const result = (data ?? {}) as { votes_moved?: number; total_fks_moved?: number };
    out.details.push({
      candidateId:   cand.id,
      electedId:     e.id,
      fullName:      e.full_name,
      state:         e.state_short,
      roleFamily:    fam,
      votesMoved:    result.votes_moved,
      totalFksMoved: result.total_fks_moved,
    });
    console.log(
      `  promote-candidates: ${e.full_name} (${e.state_short} ${fam}) — ` +
      `${result.votes_moved ?? 0} votes + ${result.total_fks_moved ?? 0} total FKs moved`
    );
  }

  console.log(
    `  promote-candidates: detected=${out.pairsDetected} promoted=${out.promoted} failed=${out.failed}`
  );
  return out;
}
