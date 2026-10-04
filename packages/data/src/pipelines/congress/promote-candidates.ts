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
 *
 * FIX-1189 — a SECOND key, the congress-legislators dataset's. FEC files legal
 * names, so the name key misses a member whose FEC spelling differs from
 * Congress.gov's (accents, middle names, compound surnames, a different
 * surname string, a legal first name — the 11 of cc-186 §7 Table E1, every one
 * a miss). The dataset lists, per bioguide, every CAND_ID the member filed
 * under; the elected row carries the bioguide, the stub carries the CAND_ID, so
 * the pair is the same person by construction. See `selectPromotionPairs`'
 * pass 2. In the nightly it runs only under CIVITICS_PROMOTION_DATASET_KEY=1;
 * the standalone runner (scripts/promote-candidates-run.ts) takes --dataset-key.
 */

import type { createAdminClient } from "@civitics/db";
import { afterKey } from "@civitics/db";
import { promoteCandidatesDirect } from "../../lib/heavy-rebuild";
import { currentFecId, type Listing } from "./legislator-ids";
import { fetchFeed, LEGISLATORS_CURRENT_URL } from "./legislator-ids-report";
import { ROSTER_FLOOR } from "./reconcile-former-members";

type Db = ReturnType<typeof createAdminClient>;

/**
 * FIX-1189 — the nightly's switch for pass 2. Read from the workflow env, and
 * unset there until the supervised landing (cc-194) has promoted the eleven by
 * hand: the 21:00 UTC nightly fires before anyone is at the keyboard, and it
 * must not be the run that first deletes eleven sitting members' elected rows.
 */
export const PROMOTION_DATASET_KEY_ENV = "CIVITICS_PROMOTION_DATASET_KEY";

export function isPromotionDatasetKeyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PROMOTION_DATASET_KEY_ENV] === "1";
}

export interface PromoteCandidatesResult {
  pairsDetected: number;
  /**
   * FIX-1196 — active elected rows in a scope family that were REFUSED as
   * promotion inputs because they already hold `source_ids.fec_candidate_id`.
   * See `selectPromotionPairs`.
   */
  skippedBound:  number;
  /** FIX-1189 — the pass counters, see `PromotionSelection`. */
  counters:      PromotionCounters;
  /** FIX-1189 — pass 2 was asked for and the listing could not be fetched. */
  listingUnavailable: boolean;
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
  /** FIX-1189 — `source_ids.congress_gov`, the dataset key's elected side. */
  bioguide:         string | null;
}

export interface CandidateInput {
  id:         string;
  full_name:  string;
  role_title: string;
  state:      string | null;
  /** FIX-1189 — `source_ids.fec_candidate_id`, the dataset key's stub side. */
  fec_candidate_id: string | null;
}

/** Which pass found the pair. A pair both passes agree on is `name_key`. */
export type PromotionReason = "name_key" | "dataset_key";

export interface PromotionPair {
  electedId:   string;
  candidateId: string;
  fullName:    string;
  state:       string;
  roleFamily:  string;
  reason:      PromotionReason;
}

/**
 * FIX-1189 — what each pass decided. Every elected row pass 2 looks at lands in
 * at most one of `by_dataset_key` / `dataset_no_stub` / `dataset_ambiguous` /
 * `family_mismatch` / `conflict`; `prior_office_stub` counts STUBS, not rows.
 */
export interface PromotionCounters {
  /** Pairs from the name key (including those the dataset key agrees with). */
  by_name:           number;
  /** Pairs only the dataset key found. */
  by_dataset_key:    number;
  /** The member's current id is listed, but no candidate stub holds it. */
  dataset_no_stub:   number;
  /** More than one candidate stub holds the member's current id. */
  dataset_ambiguous: number;
  /** A stub holds a LISTED id that is not the current one — never paired. */
  prior_office_stub: number;
  /** The stub's office (Candidate for X) is not the elected row's office. */
  family_mismatch:   number;
  /** The two passes name different stubs, or one stub for two members. */
  conflict:          number;
}

export interface PromotionSelection extends PromotionCounters {
  pairs:        PromotionPair[];
  /** FIX-1196 — elected rows refused by the bound-identity guard. */
  skippedBound: number;
}

function zeroCounters(): PromotionCounters {
  return {
    by_name: 0,
    by_dataset_key: 0,
    dataset_no_stub: 0,
    dataset_ambiguous: 0,
    prior_office_stub: 0,
    family_mismatch: 0,
    conflict: 0,
  };
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
 *
 * FIX-1189 — PASS 2, the dataset key, only when `listing` is given. For an
 * elected row the guard let through (no live id) whose bioguide the dataset
 * lists with a determinable current-office id (`currentFecId`), the candidate
 * stubs holding exactly that id:
 *
 *   one   → a `dataset_key` pair, if the stub's office is the row's office
 *   none  → `dataset_no_stub`, no pair
 *   many  → `dataset_ambiguous`, no pair
 *
 * A stub holding one of the member's OTHER listed ids is a prior-office
 * candidacy (`prior_office_stub`), counted and never paired: the row-deleting
 * RPC would make it the member's row with the wrong live id.
 *
 * The passes must agree. A row both pair with the same stub is one `name_key`
 * pair. A row they pair with different stubs, a name-key stub the dataset calls
 * a prior office, or one stub claimed for two rows (where the dataset key is
 * one of them) is a `conflict` and is not paired at all — the dataset key's
 * whole value is that it cannot produce a wrong pair, so a disagreement is a
 * question for a human, not a tie to break.
 *
 * Without `listing` the result is pass 1 exactly, in the same order.
 */
export function selectPromotionPairs(
  electedRows:   ElectedInput[],
  candidateRows: CandidateInput[],
  listing?:      Map<string, Listing>,
): PromotionSelection {
  const byName = new Map<string, PromotionPair>();
  const counters = zeroCounters();
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

    byName.set(e.id, {
      electedId:   e.id,
      candidateId: cand.id,
      fullName:    e.full_name,
      state:       e.state_short.toUpperCase(),
      roleFamily:  fam,
      reason:      "name_key",
    });
  }

  // ── Pass 2 (FIX-1189): the dataset key. See the doc comment.
  const byDataset = new Map<string, PromotionPair>();
  const refused = new Set<string>();
  if (listing) {
    const byFecId = new Map<string, CandidateInput[]>();
    for (const c of candidateRows) {
      if (!c.fec_candidate_id) continue;
      const bucket = byFecId.get(c.fec_candidate_id) ?? [];
      bucket.push(c);
      byFecId.set(c.fec_candidate_id, bucket);
    }
    const fecOf = new Map(candidateRows.map((c) => [c.id, c.fec_candidate_id]));

    for (const e of electedRows) {
      if (e.fec_candidate_id) continue; // FIX-1196 — counted in pass 1, untouched here
      if (!e.bioguide) continue;
      const fam = roleFamilyOf(e.role_title);
      if (!fam) continue;
      const l = listing.get(e.bioguide);
      if (!l) continue;
      const cur = currentFecId(l);
      if (cur.kind !== "ok") continue; // the dataset cannot say; pass 1 stands

      for (const id of l.fec) {
        if (id !== cur.id) counters.prior_office_stub += byFecId.get(id)?.length ?? 0;
      }

      const named = byName.get(e.id);
      const namedFec = named ? (fecOf.get(named.candidateId) ?? null) : null;
      const namedIsPriorOffice = namedFec !== null && namedFec !== cur.id && l.fec.includes(namedFec);
      const onCurrent = byFecId.get(cur.id) ?? [];

      if (onCurrent.length === 1) {
        const stub = onCurrent[0]!;
        if (named) {
          if (named.candidateId !== stub.id) {
            counters.conflict++;
            refused.add(e.id);
          }
          continue; // agreement stays the name-key pair
        }
        if (candidateRoleFamilyOf(stub.role_title) !== fam) {
          counters.family_mismatch++;
          continue;
        }
        byDataset.set(e.id, {
          electedId:   e.id,
          candidateId: stub.id,
          fullName:    e.full_name,
          state:       (e.state_short ?? stub.state ?? "").toUpperCase(),
          roleFamily:  fam,
          reason:      "dataset_key",
        });
        continue;
      }
      if (namedIsPriorOffice) {
        counters.conflict++;
        refused.add(e.id);
        continue;
      }
      if (onCurrent.length === 0) counters.dataset_no_stub++;
      else counters.dataset_ambiguous++;
    }
  }

  // ── Merge in elected-row order, then hold the dataset key's pairs to 1:1 on
  // the stub. Two name-key pairs sharing a stub are left as pass 1 always left
  // them (the RPC refuses the second); the dataset key never shares one.
  const merged: PromotionPair[] = [];
  for (const e of electedRows) {
    if (refused.has(e.id)) continue;
    const p = byName.get(e.id) ?? byDataset.get(e.id);
    if (p) merged.push(p);
  }
  const uses = new Map<string, PromotionPair[]>();
  for (const p of merged) {
    const list = uses.get(p.candidateId) ?? [];
    list.push(p);
    uses.set(p.candidateId, list);
  }
  const pairs = merged.filter((p) => {
    const u = uses.get(p.candidateId)!;
    return u.length === 1 || u.every((x) => x.reason === "name_key");
  });
  counters.conflict += merged.length - pairs.length;
  counters.by_name = pairs.filter((p) => p.reason === "name_key").length;
  counters.by_dataset_key = pairs.filter((p) => p.reason === "dataset_key").length;

  return { pairs, skippedBound, ...counters };
}

// FIX-755: per-run promotion cap — see the step-5 comment below. ~17s/pair
// keeps a capped run under ~8 min of the daily fec-phase budget.
export const PROMOTION_CAP = 25;

/** The two populations `selectPromotionPairs` reads, loaded the one way. */
export async function loadPromotionInputs(
  db: Db,
): Promise<{ electedRows: ElectedInput[]; candidateRows: CandidateInput[] }> {
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
          // FIX-1189 — the dataset key's elected side; the filter above
          // guarantees it is present.
          bioguide:         r.source_ids?.["congress_gov"] ?? null,
        });
      }
      if (rows.length < PAGE) break;
      afterId = rows[rows.length - 1]!.id;
    }
  }

  if (electedRows.length === 0) return { electedRows, candidateRows: [] };

  // ── 2. Load all candidate rows in scope families.
  const candidateRows: CandidateInput[] = [];
  {
    const PAGE = 1000;
    let afterId: string | null = null; // FIX-984: keyset cursor, not an OFFSET
    for (;;) {
      const { data, error } = await afterKey(db
        .from("officials")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .select("id, full_name, role_title, metadata, source_ids" as any)
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
        source_ids?: Record<string, string> | null;
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
          // FIX-1189 — the dataset key's stub side (the filter above guarantees it).
          fec_candidate_id: r.source_ids?.["fec_candidate_id"] ?? null,
        });
      }
      if (rows.length < PAGE) break;
      afterId = rows[rows.length - 1]!.id;
    }
  }
  return { electedRows, candidateRows };
}

/**
 * FIX-1189 — the dataset, as pass 2 reads it: `legislators-current.json` keyed
 * by bioguide, through the same fetch + parse + floor the O2 report uses. Never
 * throws: a failed fetch is `listing: null` and the reason, and the run goes on
 * with the name key alone.
 */
export async function loadPromotionListing(): Promise<{
  listing: Map<string, Listing> | null;
  etag:    string | null;
  error?:  string;
}> {
  try {
    const feed = await fetchFeed(LEGISLATORS_CURRENT_URL, ROSTER_FLOOR);
    return { listing: new Map(feed.listings.map((l) => [l.bioguide, l])), etag: feed.ref.etag };
  } catch (err) {
    return { listing: null, etag: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Everything a run decided before it touches a row. */
export interface PromotionPlan {
  selection:          PromotionSelection;
  /** Pass 2 was asked for. */
  datasetKey:         boolean;
  /** Pass 2 was asked for and the listing could not be fetched. */
  listingUnavailable: boolean;
  listingError?:      string;
  listingEtag:        string | null;
  /** Capped and in drain order — exactly what an apply would promote. */
  toPromote:          PromotionPair[];
  deferred:           number;
  cap:                number;
}

/**
 * Load, fetch (if asked) and select — reads only. The nightly and the
 * standalone runner both go through here, so a dry run plans exactly what the
 * apply would promote.
 */
export async function planCandidateToElectedPromotion(opts: {
  db:          Db;
  datasetKey?: boolean;
  cap?:        number;
}): Promise<PromotionPlan> {
  const datasetKey = opts.datasetKey === true;
  const cap = opts.cap ?? PROMOTION_CAP;
  const { electedRows, candidateRows } = await loadPromotionInputs(opts.db);

  let listing: Map<string, Listing> | undefined;
  let listingUnavailable = false;
  let listingError: string | undefined;
  let listingEtag: string | null = null;
  if (datasetKey && electedRows.length > 0) {
    const l = await loadPromotionListing();
    if (l.listing) {
      listing = l.listing;
      listingEtag = l.etag;
    } else {
      listingUnavailable = true;
      listingError = l.error;
    }
  }

  // ── 3+4. Pair selection (pure — see `selectPromotionPairs`).
  const selection = selectPromotionPairs(electedRows, candidateRows, listing);
  const toPromote = [...selection.pairs]
    .sort((a, b) => a.fullName.localeCompare(b.fullName)) // deterministic drain order across nights
    .slice(0, cap);
  return {
    selection,
    datasetKey,
    listingUnavailable,
    ...(listingError !== undefined ? { listingError } : {}),
    listingEtag,
    toPromote,
    deferred: selection.pairs.length - toPromote.length,
    cap,
  };
}

/** The counters line — one per run, in the step log (FIX-758: no metadata keys). */
export function promotionCountersLine(plan: PromotionPlan): string {
  const s = plan.selection;
  if (!plan.datasetKey) {
    return `  promote-candidates: by_name=${s.by_name} dataset_key=off (${PROMOTION_DATASET_KEY_ENV} unset)`;
  }
  if (plan.listingUnavailable) {
    return (
      `  promote-candidates: by_name=${s.by_name} listing_unavailable=1 — pass 2 skipped, ` +
      `name key only (${plan.listingError ?? "fetch failed"})`
    );
  }
  return (
    `  promote-candidates: by_name=${s.by_name} by_dataset_key=${s.by_dataset_key} ` +
    `dataset_no_stub=${s.dataset_no_stub} dataset_ambiguous=${s.dataset_ambiguous} ` +
    `prior_office_stub=${s.prior_office_stub} family_mismatch=${s.family_mismatch} ` +
    `conflict=${s.conflict} listing_etag=${plan.listingEtag ?? "?"}`
  );
}

export async function runCandidateToElectedPromotion(opts: {
  db:          Db;
  /** FIX-1189 — run pass 2. The nightly passes `isPromotionDatasetKeyEnabled()`. */
  datasetKey?: boolean;
  /** A plan already made (the runner's dry-run table) — promote exactly it. */
  plan?:       PromotionPlan;
}): Promise<PromoteCandidatesResult> {
  const plan = opts.plan ?? (await planCandidateToElectedPromotion({ db: opts.db, datasetKey: opts.datasetKey }));
  const { selection, toPromote } = plan;
  const pairs = selection.pairs;
  const out: PromoteCandidatesResult = {
    pairsDetected: pairs.length,
    skippedBound:  selection.skippedBound,
    counters: {
      by_name:           selection.by_name,
      by_dataset_key:    selection.by_dataset_key,
      dataset_no_stub:   selection.dataset_no_stub,
      dataset_ambiguous: selection.dataset_ambiguous,
      prior_office_stub: selection.prior_office_stub,
      family_mismatch:   selection.family_mismatch,
      conflict:          selection.conflict,
    },
    listingUnavailable: plan.listingUnavailable,
    promoted:      0,
    failed:        0,
    details:       [],
  };

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
  if (pairs.length > plan.cap) {
    console.warn(
      `  ⚠ promote-candidates: detected=${pairs.length} exceeds the per-run cap (${plan.cap}) — ` +
        `promoting ${plan.cap} this run, deferring ${pairs.length - plan.cap} to future nights (FIX-755)`,
    );
  }

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
    console.info(
      `  promote-candidates: ${p.fullName} (${p.state} ${p.roleFamily}) — ` +
      `${o.result?.votes_moved ?? 0} votes + ${o.result?.total_fks_moved ?? 0} total FKs moved`
    );
  }

  const deferred = plan.deferred;
  console.info(
    `  promote-candidates: detected=${out.pairsDetected} promoted=${out.promoted} failed=${out.failed} ` +
      `skipped_bound=${out.skippedBound}` +
      (deferred > 0 ? ` deferred=${deferred} (cap ${plan.cap}, FIX-755)` : "")
  );
  console.info(promotionCountersLine(plan));
  return out;
}
