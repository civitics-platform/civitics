/**
 * FIX-1189 O2 — the `unitedstates/congress-legislators` `id.fec[]` conflict
 * table, as a pure function.
 *
 * The dataset publishes, per member, every FEC candidate id they have ever
 * filed under (House and Senate, every cycle), keyed by bioguide. Our
 * `officials.source_ids` holds the same fact in two slots — the CURRENT-office
 * id in `fec_candidate_id` and the rest in `prior_fec_candidate_ids` (FIX-1187)
 * — filled by three late, lossy paths. This module compares the two and names
 * the disagreement. It decides nothing and writes nothing: O2 is report-only
 * (design D1/D3). O1, the writer, is gated on a week of these reports (D2) and
 * will reuse `classifyBinding` with its classes turned into write actions.
 *
 * Deterministic and I/O-free so every branch is a fixture. The I/O half —
 * fetch, the population read, the `data_sync_log` stamp — is
 * `./legislator-ids-report.ts`.
 *
 * WHO CLAIMS AN ID IS DECIDED BY `authoritativeClaims()`, NEVER HERE. A row's
 * own ids and every other row's claims go through `../fec-bulk/claims`, so a
 * retired `merged_fec_candidate_ids` entry is not a claim here exactly as it is
 * not one in the cn{yy} stage (rule 139). This module never reads the arrays.
 *
 * THE CLASSES, in precedence order (first match wins, so every row lands in
 * exactly one — the reconciliation in `reconcileReport` depends on it):
 *
 *   no_bioguide           row has no `congress_gov` key — invisible to O1
 *   dataset_lag           the dataset lists no FEC id for this bioguide (or
 *                         does not list the bioguide at all) — design §2's
 *                         "a freshly sworn-in member may lag a week"
 *   cross_bioguide_claim  an id the dataset lists for this member is held by
 *                         a row with a DIFFERENT bioguide (§4 (e) — a human)
 *   unlisted_live_id      the row claims an id the dataset does not list for
 *                         this member (§4 (a) — reported, never demoted: D3)
 *   double_claim          another row with no bioguide (a stub) or the same
 *                         bioguide claims a listed id (§4 (d) — a manifest)
 *   bindable              the row claims nothing; the current-office id is
 *                         determinable (§4 (b) — the class-closing case)
 *   prior_office_live     the row's live id is listed, but as a PRIOR office
 *                         (§4 (c) — a House id on a now-Senator)
 *   prior_incomplete      live is the current-office id, but listed prior-office
 *                         ids are missing from `prior_fec_candidate_ids`
 *   ambiguous_current     the dataset cannot say which id is current (two ids
 *                         of the last term's chamber, neither matching its
 *                         state/district, or none of that chamber) AND the
 *                         row's state needs it to decide
 *   noop                  the row agrees: live = the current-office id and the
 *                         claims are exactly the listed ids
 *
 * `prior_incomplete`, `dataset_lag` and the row-level use of
 * `ambiguous_current` are not in the design's §4 table; the tree needed them
 * for the partition to hold (see cc-170's report).
 */

import { authoritativeClaims, retiredClaims } from "../fec-bulk/claims";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BindingAction =
  | "noop"
  | "bindable"
  | "prior_office_live"
  | "prior_incomplete"
  | "unlisted_live_id"
  | "double_claim"
  | "cross_bioguide_claim"
  | "ambiguous_current"
  | "dataset_lag"
  | "no_bioguide";

/** Every class, in the order a report renders them. */
export const BINDING_ACTIONS: readonly BindingAction[] = [
  "noop",
  "bindable",
  "prior_office_live",
  "prior_incomplete",
  "unlisted_live_id",
  "double_claim",
  "cross_bioguide_claim",
  "ambiguous_current",
  "dataset_lag",
  "no_bioguide",
];

/** One `officials` row, reduced to what the classifier reads. */
export interface BindingRow {
  official_id: string;
  bioguide: string | null;
  /** `source_ids.fec_candidate_id` as stored. */
  live: string | null;
  /** `source_ids.prior_fec_candidate_ids` as stored. */
  prior: string[];
  /** Retired ids — `merged_fec_candidate_ids` and the legacy scalar. */
  merged: string[];
}

/** One dataset member, reduced to what the classifier reads. */
export interface Listing {
  bioguide: string;
  name: string;
  fec: string[];
  /** `terms[last].type`. */
  currentType: "rep" | "sen";
  /** `terms[last].state`. */
  state: string;
  /** `terms[last].district`; null for a Senator. At-large is 0. */
  district: number | null;
}

/** A row that authoritatively claims some CAND_ID. */
export interface Claimant {
  official_id: string;
  bioguide: string | null;
}

/** CAND_ID → every row that claims it, per `authoritativeClaims()`. */
export type ClaimsMap = Map<string, Claimant[]>;

export type CurrentId =
  | { kind: "ok"; id: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "none" };

export interface Classification {
  action: BindingAction;
  /** The live id O1 would write — set only where the class determines one. */
  live?: string;
  /** The prior ids O1 would write, sorted — set only with `live`. */
  prior?: string[];
  /** The dataset's current-office id, when determinable. */
  current_id: string | null;
  /** double_claim only: the listed ids another row also claims. */
  contested?: string[];
  reason: string;
}

// ---------------------------------------------------------------------------
// Dataset parsing
// ---------------------------------------------------------------------------

/**
 * Parse `legislators-current.json` / `legislators-historical.json` into
 * listings. A member with no bioguide or no terms is dropped — neither file
 * carries one today, and a listing the classifier cannot key is not a listing.
 */
export function parseLegislators(raw: unknown): Listing[] {
  if (!Array.isArray(raw)) throw new Error("legislators feed is not an array");
  const out: Listing[] = [];
  for (const m of raw as Array<Record<string, unknown>>) {
    const id = (m["id"] ?? {}) as Record<string, unknown>;
    const bioguide = typeof id["bioguide"] === "string" ? id["bioguide"] : null;
    const terms = Array.isArray(m["terms"]) ? (m["terms"] as Array<Record<string, unknown>>) : [];
    const last = terms[terms.length - 1];
    if (!bioguide || !last) continue;
    const fec = Array.isArray(id["fec"])
      ? (id["fec"] as unknown[]).filter((v): v is string => typeof v === "string" && v.length > 0)
      : [];
    const nameObj = (m["name"] ?? {}) as Record<string, unknown>;
    const name =
      typeof nameObj["official_full"] === "string"
        ? nameObj["official_full"]
        : [nameObj["first"], nameObj["last"]].filter((s) => typeof s === "string").join(" ");
    out.push({
      bioguide,
      name,
      fec,
      currentType: last["type"] === "sen" ? "sen" : "rep",
      state: typeof last["state"] === "string" ? last["state"] : "",
      district: typeof last["district"] === "number" ? last["district"] : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The current-office id
// ---------------------------------------------------------------------------

/** A CAND_ID's office char: `rep` terms file `H…`, `sen` terms file `S…`. */
function officePrefix(type: Listing["currentType"]): string {
  return type === "sen" ? "S" : "H";
}

/**
 * The dataset's current-office id — the one design §2 says is "derivable but
 * not stated": the id whose prefix matches `terms[last].type`.
 *
 * Two ids of that prefix happen (a member who registered twice for the same
 * chamber — 15 of 539 current members, 2026-09-28). Then the one whose state
 * and, for the House, district (chars 3–6 of the CAND_ID: `H6FL11126` is FL-11)
 * agree with the last term wins. None or several agreeing → `ambiguous`, with
 * the agreeing ids as candidates when there are several, else every id of the
 * prefix. Redistricting is the usual cause: Castor's two ids are both FL-11 and
 * she now sits for FL-14.
 */
export function currentFecId(listing: Listing): CurrentId {
  const prefix = officePrefix(listing.currentType);
  const matches = listing.fec.filter((id) => id.startsWith(prefix));
  if (matches.length === 0) return { kind: "none" };
  if (matches.length === 1) return { kind: "ok", id: matches[0]! };
  const agree = matches.filter(
    (id) =>
      id.slice(2, 4) === listing.state &&
      (listing.currentType === "sen" || Number(id.slice(4, 6)) === listing.district),
  );
  if (agree.length === 1) return { kind: "ok", id: agree[0]! };
  return { kind: "ambiguous", candidates: [...(agree.length >= 2 ? agree : matches)].sort() };
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/** The `source_ids` shape `authoritativeClaims()` reads, rebuilt from a row. */
function carrier(row: BindingRow): { source_ids: Record<string, string> } {
  const source_ids: Record<string, unknown> = {};
  if (row.live) source_ids["fec_candidate_id"] = row.live;
  if (row.prior.length > 0) source_ids["prior_fec_candidate_ids"] = row.prior;
  if (row.merged.length > 0) source_ids["merged_fec_candidate_ids"] = row.merged;
  return { source_ids: source_ids as Record<string, string> };
}

/** Reduce a stored `source_ids` to the classifier's row shape. */
export function bindingRowFromSourceIds(
  official_id: string,
  source_ids: Record<string, unknown> | null,
): BindingRow {
  const s = (source_ids ?? {}) as Record<string, string>;
  const priorRaw = (s as Record<string, unknown>)["prior_fec_candidate_ids"];
  return {
    official_id,
    bioguide: typeof s["congress_gov"] === "string" && s["congress_gov"] ? s["congress_gov"] : null,
    live: typeof s["fec_candidate_id"] === "string" && s["fec_candidate_id"] ? s["fec_candidate_id"] : null,
    prior: Array.isArray(priorRaw) ? priorRaw.filter((v): v is string => typeof v === "string" && v.length > 0) : [],
    merged: retiredClaims({ source_ids: s }),
  };
}

/**
 * CAND_ID → claimants, through `authoritativeClaims()` and nothing else. Every
 * row the caller loaded contributes; a row's retired ids contribute nothing.
 */
export function buildClaimsMap(rows: BindingRow[]): ClaimsMap {
  const map: ClaimsMap = new Map();
  for (const row of rows) {
    for (const id of authoritativeClaims(carrier(row))) {
      const list = map.get(id);
      const entry = { official_id: row.official_id, bioguide: row.bioguide };
      if (list === undefined) map.set(id, [entry]);
      else if (!list.some((c) => c.official_id === row.official_id)) list.push(entry);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------

function sorted(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
}

/**
 * Classify one row against its dataset listing and the platform-wide claims.
 *
 * `listing` is null when the dataset does not list the row's bioguide at all.
 * `claims` must include every row that claims any id in `listing.fec` — the
 * row itself may be in it and is ignored.
 */
export function classifyBinding(
  row: BindingRow,
  listing: Listing | null,
  claims: ClaimsMap,
): Classification {
  if (!row.bioguide) {
    return { action: "no_bioguide", current_id: null, reason: "no source_ids.congress_gov" };
  }
  if (listing === null || listing.fec.length === 0) {
    return {
      action: "dataset_lag",
      current_id: null,
      reason:
        (listing === null ? `bioguide ${row.bioguide} not in the dataset` : `dataset lists no FEC id for ${row.bioguide}`) +
        (row.live ? `; row holds ${row.live}` : ""),
    };
  }

  // The row's own claims, through the one reader. `live` counts only if it is
  // still claimed — a live id the row has also retired is not a live claim.
  const held = authoritativeClaims(carrier(row));
  const live = row.live !== null && held.includes(row.live) ? row.live : null;
  const listed = new Set(listing.fec);
  const cur = currentFecId(listing);
  const currentId = cur.kind === "ok" ? cur.id : null;

  // Other rows claiming a listed id, split by whose they are.
  const cross: string[] = [];
  const doubles: string[] = [];
  const contested = new Set<string>();
  for (const id of sorted(listing.fec)) {
    for (const c of claims.get(id) ?? []) {
      if (c.official_id === row.official_id) continue;
      if (c.bioguide !== null && c.bioguide !== row.bioguide) {
        cross.push(`${id} held by ${c.official_id} (bioguide ${c.bioguide})`);
      } else {
        contested.add(id);
        doubles.push(`${id} also claimed by ${c.official_id}${c.bioguide === null ? " (no bioguide)" : " (same bioguide)"}`);
      }
    }
  }
  if (cross.length > 0) {
    return { action: "cross_bioguide_claim", current_id: currentId, reason: cross.join("; ") };
  }

  const unlisted = held.filter((id) => !listed.has(id));
  if (unlisted.length > 0) {
    return {
      action: "unlisted_live_id",
      current_id: currentId,
      reason: unlisted
        .map((id) => `${id === live ? "live" : "prior"} ${id} not listed for ${row.bioguide}`)
        .join("; "),
    };
  }

  if (doubles.length > 0) {
    return { action: "double_claim", current_id: currentId, contested: sorted(contested), reason: doubles.join("; ") };
  }

  // From here every id the row claims is listed and nobody else claims one.
  const target = (liveId: string): { live: string; prior: string[] } => ({
    live: liveId,
    prior: sorted(listing.fec.filter((id) => id !== liveId)),
  });
  const agreesWith = (liveId: string): Classification => {
    const missing = listing.fec.filter((id) => id !== liveId && !held.includes(id));
    return missing.length === 0
      ? { action: "noop", current_id: currentId ?? liveId, reason: "row agrees with the dataset" }
      : {
          action: "prior_incomplete",
          ...target(liveId),
          current_id: currentId ?? liveId,
          reason: `prior lacks ${sorted(missing).join(", ")}`,
        };
  };

  if (live === null) {
    if (cur.kind === "ok") {
      return {
        action: "bindable",
        ...target(cur.id),
        current_id: cur.id,
        reason: held.length === 0 ? "row holds no id" : `row holds only prior ids ${sorted(held).join(", ")}`,
      };
    }
    return {
      action: "ambiguous_current",
      current_id: null,
      reason:
        cur.kind === "none"
          ? `no id matches the last term (${listing.currentType})`
          : `row holds no live id; current is one of ${cur.candidates.join(", ")}`,
    };
  }

  if (cur.kind === "ok") {
    if (live === cur.id) return agreesWith(live);
    return {
      action: "prior_office_live",
      ...target(cur.id),
      current_id: cur.id,
      reason: `live ${live} is a prior-office id; current is ${cur.id}`,
    };
  }
  // The dataset cannot name the current id, but if the row's live id is one of
  // the candidates there is nothing to decide: the row's choice stands.
  if (cur.kind === "ambiguous" && cur.candidates.includes(live)) return agreesWith(live);
  return {
    action: "ambiguous_current",
    current_id: null,
    reason:
      cur.kind === "none"
        ? `no id matches the last term (${listing.currentType}); live is ${live}`
        : `live ${live} is not among the current candidates ${cur.candidates.join(", ")}`,
  };
}

// ---------------------------------------------------------------------------
// O1 — the writer's plan (FIX-1189, cc-193)
// ---------------------------------------------------------------------------

export type BindingWriteKind = "bind" | "promote" | "prior_append";

/**
 * One `officials.source_ids` write. Applied as a merge keyed by UUID with the
 * row's CURRENT live id asserted in the WHERE (the FIX-1195 restore shape), so
 * a row another writer changed after the read is refused, never overwritten.
 */
export interface BindingWrite {
  official_id: string;
  kind: BindingWriteKind;
  /** The `fec_candidate_id` the row must still hold — null means "holds none". */
  expect_live: string | null;
  /** The new `fec_candidate_id`, or null to leave it. */
  set_live: string | null;
  /** Ids appended to `prior_fec_candidate_ids` (each absent from it), sorted. */
  add_prior: string[];
}

/**
 * The write a class turns into, or null. Design D3 (ratified): O1 acts on
 * three classes and reports the rest.
 *
 *   bindable           → bind: live ← the current id, plus any listed prior ids
 *   prior_office_live  → promote: live ← the current id, the old live → prior
 *   prior_incomplete   → prior_append: the missing listed ids → prior
 *   everything else    → null
 *
 * A bind writes the prior ids in the same statement so the row reads `noop` on
 * the next run instead of `prior_incomplete` — one write, and a second run
 * plans nothing.
 *
 * Refusals on top of the classifier's, each a case the classifier cannot see:
 *   - another row claims the id that would become live (the classifier puts
 *     such a row in double_claim first, but the plan does not rely on that);
 *   - the id that would become live, or one to append, is RETIRED on this row
 *     (`merged_fec_candidate_ids`) — `authoritativeClaims()` drops a retired
 *     id, so writing it would change nothing and plan the same write forever.
 */
export function planBinding(row: BindingRow, c: Classification, claims: ClaimsMap): BindingWrite | null {
  const retired = new Set(row.merged);
  const inPrior = new Set(row.prior);
  const othersClaim = (id: string): boolean =>
    (claims.get(id) ?? []).some((x) => x.official_id !== row.official_id);
  const additions = (exclude: string | null): string[] =>
    sorted((c.prior ?? []).filter((id) => id !== exclude && !inPrior.has(id) && !retired.has(id)));

  switch (c.action) {
    case "bindable": {
      if (!c.live || retired.has(c.live) || othersClaim(c.live)) return null;
      return { official_id: row.official_id, kind: "bind", expect_live: row.live, set_live: c.live, add_prior: additions(c.live) };
    }
    case "prior_office_live": {
      if (!c.live || row.live === null || retired.has(c.live) || othersClaim(c.live)) return null;
      return { official_id: row.official_id, kind: "promote", expect_live: row.live, set_live: c.live, add_prior: additions(c.live) };
    }
    case "prior_incomplete": {
      const add = additions(row.live);
      if (add.length === 0) return null;
      return { official_id: row.official_id, kind: "prior_append", expect_live: row.live, set_live: null, add_prior: add };
    }
    default:
      return null;
  }
}

/**
 * Every write O1 would make for a population. Only rows the CURRENT file lists
 * are written: a row keyed only through the historical file is a former member
 * still marked elected, and what is "current" for them is not O1's to decide.
 *
 * Two plans that would make the same id live (two rows of one bioguide, both
 * claimless, both `bindable`) would manufacture a double claim; both are
 * dropped and reported by the caller as a plan of zero.
 */
export function planBindings(rows: BindingRow[], current: Listing[], claims: ClaimsMap): BindingWrite[] {
  const byBioguide = new Map(current.map((l) => [l.bioguide, l]));
  const plans: BindingWrite[] = [];
  for (const row of rows) {
    if (!row.bioguide) continue;
    const listing = byBioguide.get(row.bioguide);
    if (!listing) continue;
    const w = planBinding(row, classifyBinding(row, listing, claims), claims);
    if (w) plans.push(w);
  }
  const live = new Map<string, number>();
  for (const p of plans) if (p.set_live) live.set(p.set_live, (live.get(p.set_live) ?? 0) + 1);
  return plans.filter((p) => p.set_live === null || live.get(p.set_live) === 1);
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface PopulationRow extends BindingRow {
  name: string;
}

export interface ReportEntry {
  bioguide: string | null;
  official_id: string;
  name: string;
  state: string | null;
  live: string | null;
  dataset_ids: string[];
  current_id: string | null;
  reason: string;
}

export interface LegislatorIdReport {
  population: number;
  counts: Record<BindingAction, number>;
  /**
   * double_claim, split by WHICH id the other row holds. `current_id`: the
   * member's current-office id sits on another row — the money-on-a-stub shape
   * FIX-1187 cleaned up and the cn{yy} stage re-creates. `other_id`: another
   * row holds a prior-office id, or a live run for a DIFFERENT office (a
   * sitting Representative's Senate campaign) — a separate candidacy row, which
   * O1 must not treat as the same defect. Sums to counts.double_claim.
   */
  double_claim_split: { current_id: number; other_id: number };
  /** Top 20 per non-noop class, by name then official_id. */
  top_20: Partial<Record<BindingAction, ReportEntry[]>>;
  dataset_members: number;
  /** Current members matched to at least one population row. */
  matched_dataset_members: number;
  /** Current members matched to MORE than one row — each is a double_claim risk. */
  members_with_multiple_rows: number;
  /** Current members whose CURRENT id is ambiguous, whatever their row says. */
  dataset_ambiguous_current: number;
  /** Population rows keyed to a bioguide only in the historical file. */
  matched_via_historical: number;
  unmatched_dataset_members: { count: number; first_20: Array<{ bioguide: string; name: string }> };
}

function stateLabel(l: Listing): string {
  return l.currentType === "rep" && l.district !== null ? `${l.state}-${l.district}` : l.state;
}

/**
 * Classify the whole population and fold it into the stamp's shape.
 *
 * `current` keys the report; `historical` is consulted only for a row whose
 * bioguide the current file does not list (a former member still `elected`).
 */
export function buildReport(
  rows: PopulationRow[],
  current: Listing[],
  historical: Listing[],
  claims: ClaimsMap,
): LegislatorIdReport {
  const byBioguide = new Map(current.map((l) => [l.bioguide, l]));
  const histByBioguide = new Map(historical.map((l) => [l.bioguide, l]));

  const counts = Object.fromEntries(BINDING_ACTIONS.map((a) => [a, 0])) as Record<BindingAction, number>;
  const entries: Partial<Record<BindingAction, ReportEntry[]>> = {};
  /** bioguide → rows matched to it through the CURRENT file. */
  const matched = new Map<string, number>();
  const doubleSplit = { current_id: 0, other_id: 0 };
  let viaHistorical = 0;

  for (const row of rows) {
    let listing: Listing | null = null;
    if (row.bioguide) {
      listing = byBioguide.get(row.bioguide) ?? null;
      if (listing) matched.set(row.bioguide, (matched.get(row.bioguide) ?? 0) + 1);
      else {
        listing = histByBioguide.get(row.bioguide) ?? null;
        if (listing) viaHistorical++;
      }
    }
    const c = classifyBinding(row, listing, claims);
    counts[c.action]++;
    if (c.action === "double_claim") {
      if (c.current_id !== null && (c.contested ?? []).includes(c.current_id)) doubleSplit.current_id++;
      else doubleSplit.other_id++;
    }
    if (c.action === "noop") continue;
    (entries[c.action] ??= []).push({
      bioguide: row.bioguide,
      official_id: row.official_id,
      name: row.name,
      state: listing ? stateLabel(listing) : null,
      live: row.live,
      dataset_ids: listing ? sorted(listing.fec) : [],
      current_id: c.current_id,
      reason: c.reason,
    });
  }

  const top_20: Partial<Record<BindingAction, ReportEntry[]>> = {};
  for (const [action, list] of Object.entries(entries) as Array<[BindingAction, ReportEntry[]]>) {
    top_20[action] = [...list]
      .sort((a, b) => a.name.localeCompare(b.name) || a.official_id.localeCompare(b.official_id))
      .slice(0, 20);
  }

  const unmatched = current.filter((l) => !matched.has(l.bioguide));
  return {
    population: rows.length,
    counts,
    double_claim_split: doubleSplit,
    top_20,
    dataset_members: current.length,
    matched_dataset_members: matched.size,
    members_with_multiple_rows: [...matched.values()].filter((n) => n > 1).length,
    dataset_ambiguous_current: current.filter((l) => currentFecId(l).kind === "ambiguous").length,
    matched_via_historical: viaHistorical,
    unmatched_dataset_members: {
      count: unmatched.length,
      first_20: [...unmatched]
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 20)
        .map((l) => ({ bioguide: l.bioguide, name: l.name })),
    },
  };
}

/**
 * Rule 116 — the counts must reconcile, or the report is not stamped.
 *
 * Rows: the classes partition the population. Dataset: every current member is
 * either matched to a row or in `unmatched_dataset_members`, exactly once.
 * Returns the violations; empty means it holds.
 */
export function reconcileReport(r: LegislatorIdReport, currentMembers: number): string[] {
  const out: string[] = [];
  const sum = BINDING_ACTIONS.reduce((a, k) => a + r.counts[k], 0);
  if (sum !== r.population) out.push(`classes sum to ${sum}, population is ${r.population}`);
  const split = r.double_claim_split.current_id + r.double_claim_split.other_id;
  if (split !== r.counts.double_claim) out.push(`double_claim split sums to ${split}, class is ${r.counts.double_claim}`);
  for (const [action, list] of Object.entries(r.top_20) as Array<[BindingAction, ReportEntry[]]>) {
    if (list.length > r.counts[action]) out.push(`${action}: ${list.length} listed > ${r.counts[action]} counted`);
  }
  if (r.dataset_members !== currentMembers) {
    out.push(`dataset_members ${r.dataset_members} ≠ ${currentMembers} current members`);
  }
  // Matched is counted from the ROWS, unmatched from the FILE — two independent
  // walks, so a member counted twice or dropped shows up here.
  if (r.matched_dataset_members + r.unmatched_dataset_members.count !== currentMembers) {
    out.push(
      `matched ${r.matched_dataset_members} + unmatched ${r.unmatched_dataset_members.count} ≠ ${currentMembers} current members`,
    );
  }
  return out;
}
