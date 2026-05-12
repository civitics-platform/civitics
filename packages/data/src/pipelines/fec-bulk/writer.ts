/**
 * FEC bulk writer — post-cutover, batched writes against public.
 *
 * Tables written:
 *   public.financial_entities        (dedup via fec_committee_id UNIQUE)
 *   public.financial_relationships   (dedup via financial_relationships_donation_unique
 *                                     partial index, added in 20260423000000)
 *
 * All writes go through `upsert` with `onConflict` so a full run collapses to
 * O(chunks) round-trips instead of O(rows). Earlier revision did SELECT +
 * INSERT per row; on local Docker that was fine, but against Pro with ~100ms
 * RTT, 33k round-trips put one run at ~55 min. Batched it's under a minute.
 *
 * entity_connections is NOT written here. Per L5 it's derivation-only; the
 * rebuild_entity_connections() SQL function handles donation edges.
 */

import type { createAdminClient } from "@civitics/db";
import { canonicalDonorName } from "./indiv";

type Db = ReturnType<typeof createAdminClient>;

const ENTITY_CHUNK = 500;
const RELATIONSHIP_CHUNK = 500;

// ---------------------------------------------------------------------------
// Name canonicalization
// ---------------------------------------------------------------------------

/**
 * Canonical (dedup-friendly) form of a committee / entity name.
 *   - uppercase, strip punctuation, collapse whitespace
 *   - strip trailing corporate suffix (INC/LLC/CORP/PAC/COMMITTEE)
 */
export function canonicalizeEntityName(raw: string): string {
  const base = (raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return base
    .replace(/\s+(INC|LLC|LTD|CORP|CORPORATION|COMPANY|CO|PAC|COMMITTEE)$/i, "")
    .trim();
}

// ---------------------------------------------------------------------------
// FEC CMTE_TP → financial_entities.entity_type
// ---------------------------------------------------------------------------

export type FinancialEntityType =
  | "individual"
  | "pac"
  | "super_pac"
  | "corporation"
  | "union"
  | "party_committee"
  | "small_donor_aggregate"
  | "tribal"
  | "527"
  | "other";

export function cmteTypeToEntityType(cmteType: string): FinancialEntityType {
  const c = (cmteType ?? "").trim().toUpperCase();
  if (c === "O") return "super_pac";
  if (["X", "Y", "Z"].includes(c)) return "party_committee";
  if (["N", "Q", "V", "W"].includes(c)) return "pac";
  return "other";
}

// ---------------------------------------------------------------------------
// Batched entity upsert
// ---------------------------------------------------------------------------

export interface PacEntityInput {
  cmteId: string;
  name: string;
  cmteType: string;
  connectedOrg: string;
  totalDonatedCents: number;
}

export interface EntityBatchResult {
  /** Map from fec_committee_id → entity UUID for every successfully upserted row. */
  entityIdByCmte: Map<string, string>;
  upserted: number;
  failed: number;
}

/**
 * Upsert every committee in one batched call per chunk.
 *
 * Dedup via `financial_entities.fec_committee_id` UNIQUE. PostgREST returns
 * all columns we ask for from the upsert, including id, so we can build the
 * cmte→id map from a single round-trip per chunk.
 */
export async function upsertPacEntitiesBatch(
  db: Db,
  inputs: PacEntityInput[],
): Promise<EntityBatchResult> {
  const entityIdByCmte = new Map<string, string>();
  let upserted = 0;
  let failed = 0;

  if (inputs.length === 0) return { entityIdByCmte, upserted, failed };

  const records = inputs.map((input) => {
    const entityType = cmteTypeToEntityType(input.cmteType);
    const displayName = (input.name || input.cmteId).trim();
    return {
      canonical_name: canonicalizeEntityName(displayName),
      display_name: displayName,
      entity_type: entityType,
      fec_committee_id: input.cmteId,
      total_donated_cents: input.totalDonatedCents,
      total_received_cents: 0,
      metadata: {
        fec_cmte_type_raw: input.cmteType,
        fec_connected_org_nm: input.connectedOrg?.trim() || null,
      },
    };
  });

  for (let i = 0; i < records.length; i += ENTITY_CHUNK) {
    const chunk = records.slice(i, i + ENTITY_CHUNK);

    const { data, error } = await db
      .from("financial_entities")
      .upsert(chunk, { onConflict: "fec_committee_id" })
      .select("id, fec_committee_id");

    if (error) {
      console.error(
        `    financial_entities chunk ${i}-${i + chunk.length} failed: ${error.message}`,
      );
      failed += chunk.length;
      continue;
    }

    for (const row of (data ?? []) as Array<{ id: string; fec_committee_id: string | null }>) {
      if (row.fec_committee_id) entityIdByCmte.set(row.fec_committee_id, row.id);
    }
    upserted += chunk.length;
  }

  return { entityIdByCmte, upserted, failed };
}

// ---------------------------------------------------------------------------
// Batched individual-donor entity upsert (FIX-181)
// ---------------------------------------------------------------------------

export interface IndividualDonorInput {
  fingerprint: string;     // donor dedup key — `${nameNorm}|${zip5}`
  displayName: string;     // freeform NAME from FEC, source-cased
  city:        string;
  state:       string;     // 2-letter state
  zip5:        string;
  employer:    string;
  occupation:  string;
  totalDonatedCents: number; // sum across the cycle being processed (initial value;
                             // financial_entities is shared across cycles, so this
                             // gets refreshed cycle-by-cycle in the same way the
                             // PAC pipeline refreshes total_donated_cents)
}

export interface IndividualDonorBatchResult {
  /** Map from fingerprint → entity UUID for every successfully upserted row. */
  donorIdByFingerprint: Map<string, string>;
  upserted: number;
  failed:   number;
}

/**
 * Upsert individual-donor entities. Dedup via UNIQUE(donor_fingerprint) added
 * by migration 20260502120000 (FIX-181). PACs continue to dedup on
 * fec_committee_id UNIQUE (per FIX-101); the two paths don't interfere
 * because PAC rows leave donor_fingerprint NULL and Postgres allows
 * multiple NULLs in a unique index by default.
 *
 * canonical_name carries the searchable normalized name (NO zip), so
 * existing GIN trigram search on canonical_name still finds donors by name.
 */
export async function upsertIndividualDonorsBatch(
  db:     Db,
  inputs: IndividualDonorInput[],
): Promise<IndividualDonorBatchResult> {
  const donorIdByFingerprint = new Map<string, string>();
  let upserted = 0;
  let failed   = 0;

  if (inputs.length === 0) return { donorIdByFingerprint, upserted, failed };

  // Client-side dedupe by fingerprint — Postgres rejects two rows that hit
  // the same conflict arbiter in a single statement. Sum totals so the
  // surviving row carries the merged donation total. Prefer the longer/
  // more complete metadata when merging.
  const merged = new Map<string, IndividualDonorInput>();
  for (const input of inputs) {
    const existing = merged.get(input.fingerprint);
    if (!existing) {
      merged.set(input.fingerprint, { ...input });
      continue;
    }
    existing.totalDonatedCents += input.totalDonatedCents;
    if (input.displayName.length > existing.displayName.length) existing.displayName = input.displayName;
    if (!existing.employer   && input.employer)   existing.employer   = input.employer;
    if (!existing.occupation && input.occupation) existing.occupation = input.occupation;
    if (!existing.city       && input.city)       existing.city       = input.city;
    if (!existing.state      && input.state)      existing.state      = input.state;
    if (!existing.zip5       && input.zip5)       existing.zip5       = input.zip5;
  }

  // canonical_name = natural-order "FIRST [MI] LAST" reorder of the raw FEC
  // display name (FIX-238). The trgm GIN on canonical_name (migration
  // 20260512000002) backs the search-route ilike. display_name keeps the
  // raw FEC "LAST, FIRST" source-cased form for UI display.
  const records = [...merged.values()].map((input) => {
    return {
      canonical_name:       canonicalDonorName(input.displayName),
      display_name:         input.displayName,
      entity_type:          "individual" as const,
      fec_committee_id:     null,
      donor_fingerprint:    input.fingerprint,
      total_donated_cents:  input.totalDonatedCents,
      total_received_cents: 0,
      metadata: {
        city:       input.city       || null,
        state:      input.state      || null,
        zip5:       input.zip5       || null,
        employer:   input.employer   || null,
        occupation: input.occupation || null,
        source:     "fec_bulk_indiv",
      },
    };
  });

  for (let i = 0; i < records.length; i += ENTITY_CHUNK) {
    const chunk = records.slice(i, i + ENTITY_CHUNK);

    const { data, error } = await db
      .from("financial_entities")
      .upsert(chunk, { onConflict: "donor_fingerprint" })
      .select("id, donor_fingerprint");

    if (error) {
      console.error(
        `    individual-donor chunk ${i}-${i + chunk.length} failed: ${error.message}`,
      );
      failed += chunk.length;
      continue;
    }

    for (const row of (data ?? []) as Array<{ id: string; donor_fingerprint: string | null }>) {
      if (row.donor_fingerprint) donorIdByFingerprint.set(row.donor_fingerprint, row.id);
    }
    upserted += chunk.length;
  }

  return { donorIdByFingerprint, upserted, failed };
}

// ---------------------------------------------------------------------------
// Batched relationship upsert
// ---------------------------------------------------------------------------

export interface DonationRelationshipInput {
  fromEntityId: string;
  toOfficialId: string;
  cycleYear: number;
  amountCents: number;
  occurredAt: string | null;
  cmteId: string;
  txCount: number;
}

export interface RelationshipBatchResult {
  upserted: number;
  failed: number;
}

/**
 * Upsert every donation aggregate in batched calls.
 *
 * Dedup via the partial unique index `financial_relationships_donation_unique`
 * on (relationship_type, from_id, to_id, cycle_year) WHERE relationship_type
 * = 'donation' AND cycle_year IS NOT NULL. Migration 20260423000000 adds it.
 */
export async function upsertDonationRelationshipsBatch(
  db: Db,
  inputs: DonationRelationshipInput[],
): Promise<RelationshipBatchResult> {
  let upserted = 0;
  let failed = 0;

  if (inputs.length === 0) return { upserted, failed };

  // Client-side dedupe by (from_id, to_id, cycle_year). Duplicates arise when
  // one official holds multiple FEC candidate IDs (a House fec_candidate_id
  // + a later Senate fec_id, say) and a PAC gave to both — pacAggs has two
  // entries pointing to the same official. Batched upsert rejects two rows
  // that would collide on the same conflict arbiter in one statement
  // ("ON CONFLICT DO UPDATE command cannot affect row a second time"), so we
  // merge here: sum amounts, sum tx_count, keep the latest occurred_at.
  const merged = new Map<string, DonationRelationshipInput>();
  for (const input of inputs) {
    const key = `${input.fromEntityId}|${input.toOfficialId}|${input.cycleYear}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...input });
      continue;
    }
    existing.amountCents += input.amountCents;
    existing.txCount += input.txCount;
    if (input.occurredAt && (!existing.occurredAt || input.occurredAt > existing.occurredAt)) {
      existing.occurredAt = input.occurredAt;
    }
  }

  const records = [...merged.values()].map((input) => {
    // occurred_at fallback — the CHECK constraint requires exactly one of
    // (occurred_at) / (started_at). When FEC txn date is blank we pin to
    // Jan 1 of the cycle so the row validates.
    const occurredAt = input.occurredAt ?? `${input.cycleYear}-01-01`;
    return {
      relationship_type: "donation" as const,
      from_type: "financial_entity",
      from_id: input.fromEntityId,
      to_type: "official",
      to_id: input.toOfficialId,
      amount_cents: input.amountCents,
      occurred_at: occurredAt,
      started_at: null,
      ended_at: null,
      cycle_year: input.cycleYear,
      source_url: `https://www.fec.gov/data/committee/${input.cmteId}/`,
      metadata: {
        fec_committee_id: input.cmteId,
        tx_count: input.txCount,
        source: "fec_bulk_pac",
        aggregated: true,
      },
    };
  });

  for (let i = 0; i < records.length; i += RELATIONSHIP_CHUNK) {
    const chunk = records.slice(i, i + RELATIONSHIP_CHUNK);

    const { error } = await db
      .from("financial_relationships")
      .upsert(chunk, {
        onConflict: "relationship_type,from_id,to_id,cycle_year",
      });

    if (error) {
      console.error(
        `    financial_relationships chunk ${i}-${i + chunk.length} failed: ${error.message}`,
      );
      failed += chunk.length;
      continue;
    }

    upserted += chunk.length;
  }

  return { upserted, failed };
}

// ---------------------------------------------------------------------------
// Batched individual-donation relationship upsert (FIX-181)
// ---------------------------------------------------------------------------

export interface IndividualDonationInput {
  fromEntityId:     string; // financial_entities.id of the individual donor
  toOfficialId:     string;
  cycleYear:        number;
  amountCents:      number; // cycle-level aggregate
  occurredAt:       string | null;
  donorFingerprint: string; // for provenance — also the donor entity's canonical_name
  txCount:          number;
}

/**
 * Upsert individual-donor → official donation relationships. Same target
 * table and unique constraint as the PAC writer; metadata differs to mark
 * source='fec_bulk_indiv' and embed the donor fingerprint instead of an
 * FEC committee id.
 */
export async function upsertIndividualDonationsBatch(
  db:     Db,
  inputs: IndividualDonationInput[],
): Promise<RelationshipBatchResult> {
  let upserted = 0;
  let failed   = 0;

  if (inputs.length === 0) return { upserted, failed };

  // Same client-side dedup as PAC: collapse rows that would collide on
  // (relationship_type, from_id, to_id, cycle_year). For indiv this only
  // happens if our donor-fingerprint hash collides for two distinct people
  // donating to the same candidate in the same cycle — unlikely but cheap
  // to defend against.
  const merged = new Map<string, IndividualDonationInput>();
  for (const input of inputs) {
    const key = `${input.fromEntityId}|${input.toOfficialId}|${input.cycleYear}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...input });
      continue;
    }
    existing.amountCents += input.amountCents;
    existing.txCount     += input.txCount;
    if (input.occurredAt && (!existing.occurredAt || input.occurredAt > existing.occurredAt)) {
      existing.occurredAt = input.occurredAt;
    }
  }

  const records = [...merged.values()].map((input) => {
    const occurredAt = input.occurredAt ?? `${input.cycleYear}-01-01`;
    return {
      relationship_type: "donation" as const,
      from_type:         "financial_entity",
      from_id:           input.fromEntityId,
      to_type:           "official",
      to_id:             input.toOfficialId,
      amount_cents:      input.amountCents,
      occurred_at:       occurredAt,
      started_at:        null,
      ended_at:          null,
      cycle_year:        input.cycleYear,
      source_url:        "https://www.fec.gov/data/receipts/individual-contributions/",
      metadata: {
        donor_fingerprint: input.donorFingerprint,
        tx_count:          input.txCount,
        source:            "fec_bulk_indiv",
        aggregated:        true,
      },
    };
  });

  for (let i = 0; i < records.length; i += RELATIONSHIP_CHUNK) {
    const chunk = records.slice(i, i + RELATIONSHIP_CHUNK);

    const { error } = await db
      .from("financial_relationships")
      .upsert(chunk, {
        onConflict: "relationship_type,from_id,to_id,cycle_year",
      });

    if (error) {
      console.error(
        `    indiv-donation chunk ${i}-${i + chunk.length} failed: ${error.message}`,
      );
      failed += chunk.length;
      continue;
    }

    upserted += chunk.length;
  }

  return { upserted, failed };
}

// ---------------------------------------------------------------------------
// Batched independent-expenditure upsert (FIX-240)
//
// FEC Schedule E rows: a spending committee (typically a super PAC) makes
// an independent expenditure for or against a candidate. SUP_OPP carries
// the direction — 'S' (support) or 'O' (oppose). Support and oppose
// stay distinct rows in financial_relationships because they are
// politically opposite; collapsing them would erase the most important
// signal in the data.
//
// Schema choice: two new relationship_type enum values, 'ie_support' and
// 'ie_oppose', added by migration 20260510000000. The existing 4-col
// arbiter `(relationship_type, from_id, to_id, cycle_year)` naturally
// distinguishes S vs O via relationship_type — no new column, no new
// index needed. Raw 'S'/'O' is still preserved in metadata.support_oppose.
//
// Graph derivation: rebuild_entity_connections() includes ie_support in
// the 'donation' edge case (positive money flow toward a candidate). It
// does NOT include ie_oppose, since opposition spending is anti-candidate
// and showing it as a "donation" edge would misrepresent the influence
// direction. A dedicated opposition connection_type is a follow-up.
// ---------------------------------------------------------------------------

export interface IndependentExpenditureInput {
  fromEntityId:   string;  // spending committee's financial_entities.id
  toOfficialId:   string;
  cycleYear:      number;
  amountCents:    number;  // cycle-level aggregate (one direction only)
  occurredAt:     string | null;
  supportOppose:  "S" | "O";
  spendingCmteId: string;  // for source_url + provenance
  txCount:        number;
}

export async function upsertIndependentExpendituresBatch(
  db:     Db,
  inputs: IndependentExpenditureInput[],
): Promise<RelationshipBatchResult> {
  let upserted = 0;
  let failed   = 0;

  if (inputs.length === 0) return { upserted, failed };

  // Client-side dedup. Two aggregations for the same (cmte, cand, cycle,
  // S/O) shouldn't arise from a single pipeline run because we aggregate
  // by exactly that key in the streamer — but if an official ever ends up
  // double-mapped (carries both an H-prefixed and S-prefixed FEC ID, etc.)
  // the writer might see two inputs that resolve to the same officialId.
  // Same pattern as upsertDonationRelationshipsBatch.
  const merged = new Map<string, IndependentExpenditureInput>();
  for (const input of inputs) {
    const key = `${input.fromEntityId}|${input.toOfficialId}|${input.cycleYear}|${input.supportOppose}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...input });
      continue;
    }
    existing.amountCents += input.amountCents;
    existing.txCount     += input.txCount;
    if (input.occurredAt && (!existing.occurredAt || input.occurredAt > existing.occurredAt)) {
      existing.occurredAt = input.occurredAt;
    }
  }

  const records = [...merged.values()].map((input) => {
    const occurredAt = input.occurredAt ?? `${input.cycleYear}-01-01`;
    const relationshipType =
      input.supportOppose === "S" ? "ie_support" : "ie_oppose";
    return {
      relationship_type: relationshipType,
      from_type:         "financial_entity",
      from_id:           input.fromEntityId,
      to_type:           "official",
      to_id:             input.toOfficialId,
      amount_cents:      input.amountCents,
      occurred_at:       occurredAt,
      started_at:        null,
      ended_at:          null,
      cycle_year:        input.cycleYear,
      source_url:        `https://www.fec.gov/data/committee/${input.spendingCmteId}/`,
      metadata: {
        fec_committee_id: input.spendingCmteId,
        support_oppose:   input.supportOppose, // raw 'S' or 'O' from FEC
        tx_count:         input.txCount,
        source:           "fec_bulk_ie",
        aggregated:       true,
      },
    };
  });

  for (let i = 0; i < records.length; i += RELATIONSHIP_CHUNK) {
    const chunk = records.slice(i, i + RELATIONSHIP_CHUNK);

    const { error } = await db
      .from("financial_relationships")
      .upsert(chunk, {
        onConflict: "relationship_type,from_id,to_id,cycle_year",
      });

    if (error) {
      console.error(
        `    indep-exp chunk ${i}-${i + chunk.length} failed: ${error.message}`,
      );
      failed += chunk.length;
      continue;
    }

    upserted += chunk.length;
  }

  return { upserted, failed };
}

// ---------------------------------------------------------------------------
// Batched individual → committee donation upsert (FIX-236)
//
// Donations from an individual donor to a non-candidate committee — super
// PACs (CMTE_TP O), party committees (X/Y/Z), other PACs (N/Q/V/W). Same
// dedup arbiter as the donor-to-official path; differs only in to_type
// (financial_entity instead of official) and source metadata.
//
// This is the path that captures Form 3X Schedule A — Musk → America PAC,
// Soros → Democracy PAC, etc. Pre-FIX-236 these contributions were silently
// dropped at the indiv stream filter.
// ---------------------------------------------------------------------------

export interface IndividualToCommitteeDonationInput {
  fromEntityId:     string; // financial_entities.id of the individual donor
  toEntityId:       string; // financial_entities.id of the recipient committee
  cycleYear:        number;
  amountCents:      number; // cycle-level aggregate
  occurredAt:       string | null;
  donorFingerprint: string;
  cmteId:           string; // recipient FEC committee id (for source_url + provenance)
  txCount:          number;
}

export async function upsertIndividualToCommitteeDonationsBatch(
  db:     Db,
  inputs: IndividualToCommitteeDonationInput[],
): Promise<RelationshipBatchResult> {
  let upserted = 0;
  let failed   = 0;

  if (inputs.length === 0) return { upserted, failed };

  // Same client-side dedup as the donor→official writer: collapse rows that
  // would collide on the partial unique arbiter
  // (relationship_type, from_id, to_id, cycle_year). Two identical
  // (donor, committee, cycle) tuples can arise if a donor's NAME is
  // recorded with two different formattings the fingerprint normalizes
  // to the same string.
  const merged = new Map<string, IndividualToCommitteeDonationInput>();
  for (const input of inputs) {
    const key = `${input.fromEntityId}|${input.toEntityId}|${input.cycleYear}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...input });
      continue;
    }
    existing.amountCents += input.amountCents;
    existing.txCount     += input.txCount;
    if (input.occurredAt && (!existing.occurredAt || input.occurredAt > existing.occurredAt)) {
      existing.occurredAt = input.occurredAt;
    }
  }

  const records = [...merged.values()].map((input) => {
    const occurredAt = input.occurredAt ?? `${input.cycleYear}-01-01`;
    return {
      relationship_type: "donation" as const,
      from_type:         "financial_entity",
      from_id:           input.fromEntityId,
      to_type:           "financial_entity",
      to_id:             input.toEntityId,
      amount_cents:      input.amountCents,
      occurred_at:       occurredAt,
      started_at:        null,
      ended_at:          null,
      cycle_year:        input.cycleYear,
      source_url:        `https://www.fec.gov/data/committee/${input.cmteId}/`,
      metadata: {
        donor_fingerprint: input.donorFingerprint,
        fec_committee_id:  input.cmteId,
        tx_count:          input.txCount,
        source:            "fec_bulk_indiv_to_committee",
        aggregated:        true,
      },
    };
  });

  for (let i = 0; i < records.length; i += RELATIONSHIP_CHUNK) {
    const chunk = records.slice(i, i + RELATIONSHIP_CHUNK);

    const { error } = await db
      .from("financial_relationships")
      .upsert(chunk, {
        onConflict: "relationship_type,from_id,to_id,cycle_year",
      });

    if (error) {
      console.error(
        `    indiv-to-committee chunk ${i}-${i + chunk.length} failed: ${error.message}`,
      );
      failed += chunk.length;
      continue;
    }

    upserted += chunk.length;
  }

  return { upserted, failed };
}
