/**
 * FIX-674 — resolve-or-mint IE target officials.
 *
 * FEC Schedule E (independent expenditures) attributes money to a candidate by
 * `cand_id` (an FEC candidate id). The IE writer can only attach that money to
 * an `officials` row it can resolve `cand_id → to_id` against. FIX-673 measured
 * ~$636M of *valid* IE money (6% of the total; 13% in 2020) silently dropped
 * because the target `cand_id` isn't one of our matched officials.
 *
 * The investigation (see the FIX-674 report) showed 93% of that drop is a
 * genuine INSERT gap — no official carries the exact id at all — even though
 * most targets ARE in FEC's `cn{yy}` candidate master. Only ~6% (11 ids) are a
 * resolver gap: the exact id already lives on an official, but on an inactive
 * row the active match index skips. Fuzzy name-matching to fold the money onto
 * an existing person was rejected: it misattributes (false-positive last-name
 * collisions) and conflates distinct candidacies (a 2020 House run vs a 2024
 * Senate run under different ids).
 *
 * So, per target `cand_id` NOT in the active match index:
 *   1. RESOLVE — if the exact id already lives on some official (incl. inactive
 *      rows, via `existingByFecCandId`, which maps both `fec_candidate_id` and a
 *      role-matched `fec_id`), reuse that row. No new entity.
 *   2. MINT — otherwise insert a `tier='candidate'` official keyed on
 *      `fec_candidate_id`, exactly the way the `cn{yy}` candidate-master ingest
 *      does. Identity comes from the Schedule E file's `cand_name` plus the
 *      office/state/district encoded in the `cand_id` itself (party is unknown
 *      from Schedule E and left null — a later cn ingest owns that field).
 *
 * Keying on `fec_candidate_id` makes this dedup-safe across cycles: one row per
 * FEC candidacy regardless of how many cycles/files reference it. Dedup is at
 * the application layer (there is no unique index on `fec_candidate_id` — cross-
 * cycle casing dups predate this and would block one), mirroring `candidates.ts`.
 */

import type { createAdminClient, Database } from "@civitics/db";
import { parseFecName } from "./util";

type AdminDb = ReturnType<typeof createAdminClient>;

// Until Database types are regenerated post-migration the `tier` column may be
// absent from the generated Insert type; augment defensively (mirrors candidates.ts).
type OfficialInsert = Database["public"]["Tables"]["officials"]["Insert"] & {
  tier?: string;
};

export interface IeTargetIdentity {
  /** Uppercase FEC candidate id (already normalized by the streamer). */
  candId:     string;
  /** FEC "LASTNAME, FIRST[ MIDDLE]" as it appears in Schedule E (may be ""). */
  candName:   string;
  /** "H" | "S" | "P" if the file provides it, else "" (derived from candId). */
  candOffice: string;
  /** 2-letter postal if the file provides it, else "" (derived from candId). */
  candState:  string;
}

export interface ResolveOrMintOptions {
  db: AdminDb;
  targets: IeTargetIdentity[];
  /**
   * Map keyed by `fec_candidate_id` AND role-matched `fec_id`, over ALL
   * officials (incl. inactive) — the same map `candidates.ts` uses. Mutated in
   * place with newly-minted rows so repeat calls stay dedup-safe.
   */
  existingByFecCandId: Map<string, { officialId: string; tier: string }>;
  governingBodies: { senateId: string; houseId: string; presidencyId: string };
  /** Postal-code → jurisdiction UUID. */
  stateJurisdictions: Map<string, string>;
  federalId: string;
}

export interface ResolveOrMintResult {
  /** Targets satisfied by an existing official (no new row). */
  resolved: number;
  /** New `tier='candidate'` rows inserted. */
  minted: number;
  /** Targets that could not be resolved or minted (bad office, insert error). */
  failed: number;
  /** Every target that now has a home: `cand_id → officials.id`. */
  candIdToOfficialId: Map<string, string>;
}

const BATCH_SIZE = 500;

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function formatFecName(candName: string): { full: string; first: string; last: string } {
  const { last, first } = parseFecName(candName);
  const f = first ? titleCase(first) : "";
  const l = last ? titleCase(last) : "";
  const full = [f, l].filter(Boolean).join(" ").trim() || candName.trim();
  return { full, first: f, last: l };
}

/** office letter from an explicit field, else the cand_id prefix. */
function officeOf(t: IeTargetIdentity): "H" | "S" | "P" | null {
  const explicit = t.candOffice.trim().toUpperCase();
  if (explicit === "H" || explicit === "S" || explicit === "P") return explicit;
  const c = (t.candId[0] ?? "").toUpperCase();
  if (c === "H" || c === "S" || c === "P") return c;
  return null;
}

/**
 * FEC id encodes home state for House/Senate at chars 2-3:
 *   H8FL26039 → FL,  S4GA11285 → GA. President ids (P…) have no state.
 */
function stateOf(t: IeTargetIdentity, office: "H" | "S" | "P"): string | null {
  if (office === "P") return null;
  const explicit = t.candState.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(explicit)) return explicit;
  const fromId = t.candId.slice(2, 4).toUpperCase();
  return /^[A-Z]{2}$/.test(fromId) ? fromId : null;
}

/** House district lives at cand_id chars 4-5 (H8FL26039 → "26"). "00" = at-large. */
function districtOf(t: IeTargetIdentity, office: "H" | "S" | "P"): string | null {
  if (office !== "H") return null;
  const d = t.candId.slice(4, 6);
  return /^\d{2}$/.test(d) && d !== "00" ? d : null;
}

function roleTitleFor(office: "H" | "S" | "P"): string {
  if (office === "H") return "Candidate for Representative";
  if (office === "S") return "Candidate for Senator";
  return "Candidate for President";
}

function governingBodyFor(
  office: "H" | "S" | "P",
  gb: { senateId: string; houseId: string; presidencyId: string },
): string {
  if (office === "H") return gb.houseId;
  if (office === "S") return gb.senateId;
  return gb.presidencyId;
}

async function flushBatch(
  db: AdminDb,
  pending: Array<{ candId: string; row: OfficialInsert }>,
  existing: Map<string, { officialId: string; tier: string }>,
  candIdToOfficialId: Map<string, string>,
): Promise<{ minted: number; failed: number }> {
  if (pending.length === 0) return { minted: 0, failed: 0 };
  const rows = pending.map((p) => p.row);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await db.from("officials").insert(rows as any).select("id, source_ids");
  if (error) {
    console.error(`    IE-target mint failed (${pending.length} rows): ${error.message}`);
    return { minted: 0, failed: pending.length };
  }
  for (const inserted of data ?? []) {
    const sids = (inserted.source_ids ?? {}) as Record<string, string>;
    const candId = sids["fec_candidate_id"];
    if (candId) {
      const officialId = inserted.id as string;
      existing.set(candId, { officialId, tier: "candidate" });
      candIdToOfficialId.set(candId, officialId);
    }
  }
  return { minted: data?.length ?? pending.length, failed: 0 };
}

/**
 * Resolve each unmatched IE target to an existing official, or mint a new
 * `tier='candidate'` row. Idempotent: re-running against a DB that already has
 * the minted rows resolves them (they land in `existingByFecCandId`) and mints
 * nothing.
 */
export async function resolveOrMintIeTargets(opts: ResolveOrMintOptions): Promise<ResolveOrMintResult> {
  const { db, existingByFecCandId, governingBodies, stateJurisdictions, federalId } = opts;
  const candIdToOfficialId = new Map<string, string>();
  let resolved = 0, minted = 0, failed = 0;

  // Dedup the input to one entry per cand_id (prefer a non-empty name).
  const byCand = new Map<string, IeTargetIdentity>();
  for (const t of opts.targets) {
    const prev = byCand.get(t.candId);
    if (!prev || (!prev.candName && t.candName)) byCand.set(t.candId, t);
  }

  const pending: Array<{ candId: string; row: OfficialInsert }> = [];

  for (const t of byCand.values()) {
    // 1. RESOLVE — exact id already on some official (incl. inactive).
    const hit = existingByFecCandId.get(t.candId);
    if (hit) {
      candIdToOfficialId.set(t.candId, hit.officialId);
      resolved++;
      continue;
    }

    // 2. MINT — build a tier='candidate' row keyed on fec_candidate_id.
    const office = officeOf(t);
    if (!office) { failed++; continue; }
    const state = stateOf(t, office);
    const district = districtOf(t, office);
    const { full, first, last } = formatFecName(t.candName);
    const jurisdictionId = office === "P"
      ? federalId
      : (state ? (stateJurisdictions.get(state) ?? federalId) : federalId);

    const row: OfficialInsert = {
      governing_body_id: governingBodyFor(office, governingBodies),
      jurisdiction_id:   jurisdictionId,
      full_name:         full || t.candId,
      first_name:        first || null,
      last_name:         last || null,
      role_title:        roleTitleFor(office),
      party:             null, // Schedule E carries no party; cn ingest owns it
      district_name:     district,
      is_active:         true,
      is_verified:       false,
      tier:              "candidate",
      source_ids:        { fec_candidate_id: t.candId },
      metadata: {
        state:  state,
        source: "fec_bulk_ie", // minted by the IE stage (FIX-674), not cn
        fec_office: office,
      },
    };
    pending.push({ candId: t.candId, row });

    if (pending.length >= BATCH_SIZE) {
      const r = await flushBatch(db, pending, existingByFecCandId, candIdToOfficialId);
      minted += r.minted; failed += r.failed;
      pending.length = 0;
    }
  }

  if (pending.length > 0) {
    const r = await flushBatch(db, pending, existingByFecCandId, candIdToOfficialId);
    minted += r.minted; failed += r.failed;
  }

  return { resolved, minted, failed, candIdToOfficialId };
}
