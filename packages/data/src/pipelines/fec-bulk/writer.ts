/**
 * FEC bulk writer — post-cutover, batched writes against public.
 *
 * Tables written:
 *   public.financial_entities        (dedup via fec_committee_id UNIQUE)
 *   public.financial_relationships   (dedup via financial_relationships_donation_unique
 *                                     partial index, added in 20260423000000)
 *
 * All writes go through direct-pg `bulkUpsert` (multi-row INSERT ... ON
 * CONFLICT over one pooled connection with a raised SESSION statement_timeout)
 * — the indiv writers moved off PostgREST in FIX-462/FIX-741; the pas2 entity/
 * relationship and IE writers followed in FIX-756 after the 2026-07-05 nightly
 * died in the pas2 writer under a PostgREST ~8s statement-timeout storm.
 *
 * entity_connections is NOT written here. Per L5 it's derivation-only; the
 * rebuild_entity_connections() SQL function handles donation edges.
 */

import type { Client } from "pg";
import { canonicalDonorName } from "./indiv";
import { withDirectClient, bulkUpsert } from "../../lib/direct-pg-upsert";
import { resolveResumeCursor, type StageProgress } from "./run-state";

// ---------------------------------------------------------------------------
// FIX-754 — resume plumbing for the three cursored indiv writers
// ---------------------------------------------------------------------------

/** `progress` is the stored stage progress (cursor + recorded rows total);
 *  `onProgress` is awaited with (processedRows, totalRows) once at stage start
 *  and again after every chunk attempt, so the run-state cursor is durable
 *  before the next chunk begins. Only unscoped runs pass this. */
export interface WriterResume {
  progress: StageProgress | undefined;
  onProgress: (processedRows: number, totalRows: number) => Promise<void> | void;
}

/** Resolve the start offset for a cursored writer and record the stage as
 *  in-progress. Logs the FIX-754 defensive reset when the rebuilt rows array
 *  no longer matches the stored total. */
async function beginCursoredStage(
  resume: WriterResume | undefined,
  label: string,
  totalRows: number,
): Promise<number> {
  if (!resume) return 0;
  const { start, reset } = resolveResumeCursor(resume.progress, totalRows);
  if (reset) {
    console.warn(
      `    [fec-resume] ${label} rebuilt rows=${totalRows.toLocaleString()} != stored total=` +
        `${resume.progress?.total_rows?.toLocaleString() ?? "?"} — cursor reset to 0 (idempotent re-upsert)`,
    );
  }
  await resume.onProgress(start, totalRows);
  return start;
}

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
  // Independent-expenditure-only filers all bucket as super_pac (FIX-669):
  //   O = qualified IE-only committee (Super PAC)
  //   U = single-candidate independent-expenditure committee
  //   I = independent-expenditure filer (FEC Form 5; not a registered committee)
  // U + I previously fell through to 'other', mistyping ~147 IE spenders.
  // Candidate committees (H/S/P) that occasionally appear as Schedule E
  // spenders are deliberately NOT mapped here — they are not super PACs.
  if (["O", "U", "I"].includes(c)) return "super_pac";
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
 * Upsert every committee in batched multi-row statements.
 *
 * Dedup via `financial_entities.fec_committee_id` UNIQUE. RETURNING gives us
 * id + fec_committee_id per row, so the cmte→id map costs no extra round-trip.
 */
// FIX-756: direct-pg, not PostgREST (see upsertIndividualDonorsBatch / FIX-462).
// This was one of the three writers still on the admin PostgREST path, each
// chunk subject to the prod ~8s role/statement_timeout — the 2026-07-05 nightly
// died fatally here-adjacent (pas2 writer) under a timeout storm while the
// whole-chamber promotion (FIX-755) saturated the Micro.
export async function upsertPacEntitiesBatch(
  inputs: PacEntityInput[],
  // FIX-700: on a scoped run, OMIT total_donated_cents / total_received_cents from
  // the INSERT column list entirely. They then take the column default on insert
  // (both BIGINT NOT NULL DEFAULT 0) and stay unchanged on conflict — so a
  // partial-slice re-run can't clobber a committee's real aggregate. The totals
  // rebuild re-derives the authoritative values afterward.
  skipAggregateOverwrite = false,
): Promise<EntityBatchResult> {
  const entityIdByCmte = new Map<string, string>();

  if (inputs.length === 0) return { entityIdByCmte, upserted: 0, failed: 0 };

  // Column order must match PAC_ENTITY_COLUMNS below; metadata is jsonb.
  // FIX-700: scoped runs use the reduced column set (aggregate columns omitted).
  const columns = skipAggregateOverwrite ? PAC_ENTITY_COLUMNS_SCOPED : PAC_ENTITY_COLUMNS;
  const rows = inputs.map((input) => {
    const entityType = cmteTypeToEntityType(input.cmteType);
    const displayName = (input.name || input.cmteId).trim();
    const meta = {
      fec_cmte_type_raw: input.cmteType,
      fec_connected_org_nm: input.connectedOrg?.trim() || null,
    };
    return skipAggregateOverwrite
      ? [canonicalizeEntityName(displayName), displayName, entityType, input.cmteId, meta]
      : [
          canonicalizeEntityName(displayName),
          displayName,
          entityType,
          input.cmteId,
          input.totalDonatedCents,
          0,
          meta,
        ];
  });

  const { upserted, failed, returned } = await withDirectClient((client) =>
    bulkUpsert(client, {
      table:            "financial_entities",
      label:            "pac-entity",
      columns,
      conflictColumns:  ["fec_committee_id"],
      jsonbColumns:     ["metadata"],
      returningColumns: ["id", "fec_committee_id"],
      rows,
    }),
  );

  // FIX-686 loud-abort contract, preserved across the FIX-756 rewrite:
  // bulkUpsert counts a failed chunk and continues, but a silently dropped
  // entity chunk means missing entityIdByCmte entries → those committees'
  // donations are skipped downstream with a clean count (the 500-committee
  // silent partial that motivated FIX-686). THROW so the (idempotent) run
  // is re-tried instead.
  if (failed > 0) {
    throw new Error(
      `pac-entity upsert: ${failed}/${rows.length} rows failed after direct-pg chunking — aborting (FIX-686)`,
    );
  }

  for (const row of returned as Array<{ id: string; fec_committee_id: string | null }>) {
    if (row.fec_committee_id) entityIdByCmte.set(row.fec_committee_id, row.id);
  }

  return { entityIdByCmte, upserted, failed };
}

const PAC_ENTITY_COLUMNS: string[] = [
  "canonical_name",
  "display_name",
  "entity_type",
  "fec_committee_id",
  "total_donated_cents",
  "total_received_cents",
  "metadata",
];

// FIX-700: scoped-run column set — aggregate columns dropped so a partial-slice
// re-run leaves existing committee totals intact (insert → DEFAULT 0, conflict →
// unchanged). Row builder above must emit tuples aligned to this order.
const PAC_ENTITY_COLUMNS_SCOPED: string[] = PAC_ENTITY_COLUMNS.filter(
  (c) => c !== "total_donated_cents" && c !== "total_received_cents",
);

// ---------------------------------------------------------------------------
// FIX-841 — name-only IE spender entities (orphan spe_ids)
// ---------------------------------------------------------------------------

export interface IeSpenderNameInput {
  cmteId: string; // Schedule E spe_id
  name:   string; // Schedule E spe_nam — caller must pass a non-empty, trimmed value
}

// FIX-841 orphan-spender column set. Mirrors PAC_ENTITY_COLUMNS_SCOPED (aggregate
// columns OMITTED so total_donated_cents / total_received_cents take DEFAULT 0 on
// insert and are never touched on conflict) — the same "don't clobber a real
// total from a partial slice" contract as FIX-700.
const IE_SPENDER_NAME_COLUMNS: string[] = [
  "canonical_name",
  "display_name",
  "entity_type",
  "fec_committee_id",
  "metadata",
];

/**
 * Mint name-only `financial_entities` for Schedule E spenders whose `spe_id`
 * appears in NEITHER `financial_entities` NOR the cm{yy} committee master
 * (FIX-841). cm is normally the only committee-identity source, but a residue
 * of real IE spenders never appear there; without a `from_id` their matched IE
 * money is silently dropped (the spender-side leak FIX-841 closes).
 *
 * entity_type is set to `super_pac` — the dominant Schedule E filer type; the
 * FEC IE-only committee codes (O/U/I) already bucket there via
 * `cmteTypeToEntityType`. It is a best-guess, so provenance is marked
 * `metadata.source='schedule_e_spe_nam'` and `fec_cmte_type_raw=null` so a later
 * cm ingest can correct both the type and the aggregate totals.
 *
 * Dedup via `fec_committee_id` UNIQUE (same arbiter as `upsertPacEntitiesBatch`).
 * Callers only reach this for spe_ids absent from `financial_entities` at load
 * time, so on a fresh run every row INSERTs and RETURNING yields the full id
 * map; a re-run finds them already present (skipped upstream) and never revisits
 * them, so the DO UPDATE never clobbers a since-corrected row.
 */
// FIX-756 direct-pg path + FIX-686 loud-abort contract, same as the sibling
// entity writers.
export async function upsertIeSpenderEntitiesByName(
  inputs: IeSpenderNameInput[],
): Promise<EntityBatchResult> {
  const entityIdByCmte = new Map<string, string>();
  if (inputs.length === 0) return { entityIdByCmte, upserted: 0, failed: 0 };

  const rows = inputs.map((input) => {
    const displayName = (input.name || input.cmteId).trim();
    return [
      canonicalizeEntityName(displayName),
      displayName,
      "super_pac",
      input.cmteId,
      { source: "schedule_e_spe_nam", fec_cmte_type_raw: null },
    ];
  });

  const { upserted, failed, returned } = await withDirectClient((client) =>
    bulkUpsert(client, {
      table:            "financial_entities",
      label:            "ie-spender-name",
      columns:          IE_SPENDER_NAME_COLUMNS,
      conflictColumns:  ["fec_committee_id"],
      jsonbColumns:     ["metadata"],
      returningColumns: ["id", "fec_committee_id"],
      rows,
    }),
  );

  if (failed > 0) {
    throw new Error(
      `ie-spender-name upsert: ${failed}/${rows.length} rows failed after direct-pg chunking — aborting (FIX-686)`,
    );
  }

  for (const row of returned as Array<{ id: string; fec_committee_id: string | null }>) {
    if (row.fec_committee_id) entityIdByCmte.set(row.fec_committee_id, row.id);
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
// FIX-462: direct-pg, not PostgREST. The 768k-row donor upsert was ~1,500
// PostgREST round-trips against a million-row table, each chunk capped by the
// prod ~8s role/statement_timeout — slow chunks were silently dropped and the
// cumulative ~24 min helped blow the fec-phase budget. Routed through one
// pooled pg.Client with a raised SESSION statement_timeout instead.
export async function upsertIndividualDonorsBatch(
  inputs: IndividualDonorInput[],
  // FIX-700: on a scoped run, OMIT total_donated_cents / total_received_cents from
  // the INSERT column list so existing donors keep their current aggregate (the
  // ON CONFLICT DO UPDATE set can't touch a column that isn't inserted) and new
  // donors take the BIGINT NOT NULL DEFAULT 0. A tx-type-10-only run would
  // otherwise overwrite a mixed donor's real total with just their super-PAC
  // slice; the totals rebuild re-derives the authoritative value afterward.
  skipAggregateOverwrite = false,
  // FIX-754: checkpoint cursor for killed-run resume. Unscoped runs only.
  resume?: WriterResume,
): Promise<IndividualDonorBatchResult> {
  const donorIdByFingerprint = new Map<string, string>();

  if (inputs.length === 0) return { donorIdByFingerprint, upserted: 0, failed: 0 };

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
  //
  // Column order must match DONOR_COLUMNS below. metadata is jsonb (cast in the
  // builder). DO UPDATE updates all non-conflict columns, matching the prior
  // PostgREST merge-duplicates behavior (incl. resetting total_received_cents=0,
  // which the indiv path has always done — pas2 owns received-side totals).
  // FIX-700: scoped runs use the reduced column set (aggregate columns omitted).
  const columns = skipAggregateOverwrite ? DONOR_COLUMNS_SCOPED : DONOR_COLUMNS;
  const rows = [...merged.values()].map((input) => {
    const meta = {
      city:       input.city       || null,
      state:      input.state      || null,
      zip5:       input.zip5       || null,
      employer:   input.employer   || null,
      occupation: input.occupation || null,
      source:     "fec_bulk_indiv",
    };
    return skipAggregateOverwrite
      ? [
          canonicalDonorName(input.displayName),
          input.displayName,
          "individual",
          null,
          input.fingerprint,
          meta,
        ]
      : [
          canonicalDonorName(input.displayName),
          input.displayName,
          "individual",
          null,
          input.fingerprint,
          input.totalDonatedCents,
          0,
          meta,
        ];
  });

  const startRowOffset = await beginCursoredStage(resume, "individual-donor", rows.length);

  const { upserted, failed, returned } = await withDirectClient((client) =>
    bulkUpsert(client, {
      table:            "financial_entities",
      label:            "individual-donor",
      columns,
      conflictColumns:  ["donor_fingerprint"],
      jsonbColumns:     ["metadata"],
      returningColumns: ["id", "donor_fingerprint"],
      rows,
      startRowOffset,
      onChunkProcessed: resume ? (n) => resume.onProgress(n, rows.length) : undefined,
    }),
  );

  for (const row of returned as Array<{ id: string; donor_fingerprint: string | null }>) {
    if (row.donor_fingerprint) donorIdByFingerprint.set(row.donor_fingerprint, row.id);
  }

  return { donorIdByFingerprint, upserted, failed };
}

const DONOR_COLUMNS: string[] = [
  "canonical_name",
  "display_name",
  "entity_type",
  "fec_committee_id",
  "donor_fingerprint",
  "total_donated_cents",
  "total_received_cents",
  "metadata",
];

// FIX-700: scoped-run column set — aggregate columns dropped so a partial-slice
// re-run leaves existing donor totals intact (insert → DEFAULT 0, conflict →
// unchanged). Row builder above must emit tuples aligned to this order.
const DONOR_COLUMNS_SCOPED: string[] = DONOR_COLUMNS.filter(
  (c) => c !== "total_donated_cents" && c !== "total_received_cents",
);

// Shared column order for the two individual-donation relationship writers.
const REL_COLUMNS: string[] = [
  "relationship_type",
  "from_type",
  "from_id",
  "to_type",
  "to_id",
  "amount_cents",
  "occurred_at",
  "started_at",
  "ended_at",
  "cycle_year",
  "source_url",
  "metadata",
];

const REL_CONFLICT: string[] = ["relationship_type", "from_id", "to_id", "cycle_year"];

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
 * Dedup via the full unique index on (relationship_type, from_id, to_id,
 * cycle_year) — the same arbiter the indiv relationship writers use.
 */
// FIX-756: direct-pg (see upsertPacEntitiesBatch). This is the writer the
// 2026-07-05 nightly died in — cycle-2024 pas2, PostgREST statement-timeout
// storm, retries exhausted.
export async function upsertDonationRelationshipsBatch(
  inputs: DonationRelationshipInput[],
): Promise<RelationshipBatchResult> {
  if (inputs.length === 0) return { upserted: 0, failed: 0 };

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

  // Column order must match REL_COLUMNS. occurred_at fallback — the CHECK
  // constraint requires exactly one of (occurred_at) / (started_at). When FEC
  // txn date is blank we pin to Jan 1 of the cycle so the row validates.
  const rows = [...merged.values()].map((input) => {
    const occurredAt = input.occurredAt ?? `${input.cycleYear}-01-01`;
    return [
      "donation",
      "financial_entity",
      input.fromEntityId,
      "official",
      input.toOfficialId,
      input.amountCents,
      occurredAt,
      null,
      null,
      input.cycleYear,
      `https://www.fec.gov/data/committee/${input.cmteId}/`,
      {
        fec_committee_id: input.cmteId,
        tx_count: input.txCount,
        source: "fec_bulk_pac",
        aggregated: true,
      },
    ];
  });

  const { upserted, failed } = await withDirectClient((client) =>
    bulkUpsert(client, {
      table:           "financial_relationships",
      label:           "pac-donation",
      columns:         REL_COLUMNS,
      conflictColumns: REL_CONFLICT,
      jsonbColumns:    ["metadata"],
      rows,
    }),
  );

  // FIX-686 loud-abort contract (same silent-partial bug class as
  // upsertPacEntitiesBatch): a dropped chunk silently loses donation rows
  // with a clean count. THROW so the (idempotent) run is re-tried.
  if (failed > 0) {
    throw new Error(
      `pac-donation upsert: ${failed}/${rows.length} rows failed after direct-pg chunking — aborting (FIX-686)`,
    );
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
// FIX-462: direct-pg (see upsertIndividualDonorsBatch). ~590k rows; the prior
// PostgREST path took ~36 min and dropped ~1,500 rows to statement timeouts.
export async function upsertIndividualDonationsBatch(
  inputs: IndividualDonationInput[],
  // FIX-754: checkpoint cursor for killed-run resume. Unscoped runs only.
  resume?: WriterResume,
): Promise<RelationshipBatchResult> {
  if (inputs.length === 0) return { upserted: 0, failed: 0 };

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

  // Column order must match REL_COLUMNS.
  const rows = [...merged.values()].map((input) => {
    const occurredAt = input.occurredAt ?? `${input.cycleYear}-01-01`;
    return [
      "donation",
      "financial_entity",
      input.fromEntityId,
      "official",
      input.toOfficialId,
      input.amountCents,
      occurredAt,
      null,
      null,
      input.cycleYear,
      "https://www.fec.gov/data/receipts/individual-contributions/",
      {
        donor_fingerprint: input.donorFingerprint,
        tx_count:          input.txCount,
        source:            "fec_bulk_indiv",
        aggregated:        true,
      },
    ];
  });

  const startRowOffset = await beginCursoredStage(resume, "indiv-donation", rows.length);

  return withDirectClient((client) =>
    bulkUpsert(client, {
      table:           "financial_relationships",
      label:           "indiv-donation",
      columns:         REL_COLUMNS,
      conflictColumns: REL_CONFLICT,
      jsonbColumns:    ["metadata"],
      rows,
      startRowOffset,
      onChunkProcessed: resume ? (n) => resume.onProgress(n, rows.length) : undefined,
    }).then(({ upserted, failed }) => ({ upserted, failed })),
  );
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

// FIX-756: direct-pg (see upsertPacEntitiesBatch) — last of the three
// PostgREST-exposed fec-bulk writers.
export async function upsertIndependentExpendituresBatch(
  inputs: IndependentExpenditureInput[],
): Promise<RelationshipBatchResult> {
  if (inputs.length === 0) return { upserted: 0, failed: 0 };

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

  // Column order must match REL_COLUMNS. relationship_type carries the S/O
  // direction (ie_support / ie_oppose) — the existing 4-col arbiter naturally
  // keeps support and oppose as distinct rows.
  const rows = [...merged.values()].map((input) => {
    const occurredAt = input.occurredAt ?? `${input.cycleYear}-01-01`;
    return [
      input.supportOppose === "S" ? "ie_support" : "ie_oppose",
      "financial_entity",
      input.fromEntityId,
      "official",
      input.toOfficialId,
      input.amountCents,
      occurredAt,
      null,
      null,
      input.cycleYear,
      `https://www.fec.gov/data/committee/${input.spendingCmteId}/`,
      {
        fec_committee_id: input.spendingCmteId,
        support_oppose:   input.supportOppose, // raw 'S' or 'O' from FEC
        tx_count:         input.txCount,
        source:           "fec_bulk_ie",
        aggregated:       true,
      },
    ];
  });

  const { upserted, failed } = await withDirectClient((client) =>
    bulkUpsert(client, {
      table:           "financial_relationships",
      label:           "indep-exp",
      columns:         REL_COLUMNS,
      conflictColumns: REL_CONFLICT,
      jsonbColumns:    ["metadata"],
      rows,
    }),
  );

  // FIX-686 loud-abort contract — same silent-partial bug class as the other
  // writers. THROW so the (idempotent) cycle is re-run.
  if (failed > 0) {
    throw new Error(
      `indep-exp upsert: ${failed}/${rows.length} rows failed after direct-pg chunking — aborting (FIX-686)`,
    );
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

// FIX-462: direct-pg (see upsertIndividualDonorsBatch). ~533k rows; the prior
// PostgREST path was the stage being SIGTERM'd mid-stream every Sunday.
export async function upsertIndividualToCommitteeDonationsBatch(
  inputs: IndividualToCommitteeDonationInput[],
  // FIX-754: checkpoint cursor for killed-run resume. Unscoped runs only.
  resume?: WriterResume,
): Promise<RelationshipBatchResult> {
  if (inputs.length === 0) return { upserted: 0, failed: 0 };

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

  // Column order must match REL_COLUMNS. to_type differs from the →official
  // writer (financial_entity, not official); arbiter + jsonb handling identical.
  const rows = [...merged.values()].map((input) => {
    const occurredAt = input.occurredAt ?? `${input.cycleYear}-01-01`;
    return [
      "donation",
      "financial_entity",
      input.fromEntityId,
      "financial_entity",
      input.toEntityId,
      input.amountCents,
      occurredAt,
      null,
      null,
      input.cycleYear,
      `https://www.fec.gov/data/committee/${input.cmteId}/`,
      {
        donor_fingerprint: input.donorFingerprint,
        fec_committee_id:  input.cmteId,
        tx_count:          input.txCount,
        source:            "fec_bulk_indiv_to_committee",
        aggregated:        true,
      },
    ];
  });

  const startRowOffset = await beginCursoredStage(resume, "indiv-to-committee", rows.length);

  return withDirectClient((client) =>
    bulkUpsert(client, {
      table:           "financial_relationships",
      label:           "indiv-to-committee",
      columns:         REL_COLUMNS,
      conflictColumns: REL_CONFLICT,
      jsonbColumns:    ["metadata"],
      rows,
      startRowOffset,
      onChunkProcessed: resume ? (n) => resume.onProgress(n, rows.length) : undefined,
    }).then(({ upserted, failed }) => ({ upserted, failed })),
  );
}

// ---------------------------------------------------------------------------
// FIX-754 — resume-time id-map rebuilds
//
// When a resumed run finds a writer stage already complete, it must NOT re-run
// the upsert just to recover the RETURNING id map. These batched direct-pg
// reads rebuild the maps instead — `= ANY($1)` over the streamed keys, because
// a PostgREST `.in()` caps out far below these sizes (~784k fingerprints).
// A key with no matching row (e.g. its chunk failed in the prior run) is
// simply absent from the map, matching live-run behavior downstream.
// ---------------------------------------------------------------------------

const RESUME_READ_BATCH = 10_000;

export async function fetchDonorIdsByFingerprint(
  fingerprints: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (fingerprints.length === 0) return map;
  await withDirectClient(async (client) => {
    for (let i = 0; i < fingerprints.length; i += RESUME_READ_BATCH) {
      const res = await client.query(
        `SELECT id, donor_fingerprint FROM public.financial_entities WHERE donor_fingerprint = ANY($1)`,
        [fingerprints.slice(i, i + RESUME_READ_BATCH)],
      );
      for (const row of res.rows as Array<{ id: string; donor_fingerprint: string }>) {
        map.set(row.donor_fingerprint, row.id);
      }
    }
  });
  return map;
}

export async function fetchEntityIdsByCmteId(cmteIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (cmteIds.length === 0) return map;
  await withDirectClient(async (client) => {
    for (let i = 0; i < cmteIds.length; i += RESUME_READ_BATCH) {
      const res = await client.query(
        `SELECT id, fec_committee_id FROM public.financial_entities WHERE fec_committee_id = ANY($1)`,
        [cmteIds.slice(i, i + RESUME_READ_BATCH)],
      );
      for (const row of res.rows as Array<{ id: string; fec_committee_id: string }>) {
        map.set(row.fec_committee_id, row.id);
      }
    }
  });
  return map;
}

// ---------------------------------------------------------------------------
// FIX-759 — end-of-run FEC ID persist (officials.source_ids)
// ---------------------------------------------------------------------------

export interface NewFecIdRow {
  officialId: string;
  fecId:      string;
  storageKey: "fec_id" | "fec_candidate_id";
}

/**
 * Merge newly discovered FEC IDs into officials.source_ids SERVER-SIDE.
 *
 * The old inline loop wrote `{ ...o.source_ids, [storageKey]: fecId }` from
 * the pipeline-START officials snapshot — hours stale by the end of a Sunday
 * run — so it silently dropped any source_ids key another writer merged in
 * mid-run (the congress nightly, promotion's fec_candidate_id merge). The
 * `||` merge reads the row's LIVE value inside the UPDATE, so there is no
 * lost-update window at all. Tens of rows per run — per-row statements over
 * one direct-pg connection are fine.
 */
export async function persistNewFecIds(client: Client, ids: NewFecIdRow[]): Promise<void> {
  for (const { officialId, fecId, storageKey } of ids) {
    // FIX-955 — never re-write a claim this row has RETIRED.
    //
    // FIX-933 moves a merged duplicate's `fec_candidate_id` to
    // `merged_fec_candidate_id`; this unconditional jsonb merge used to put it
    // straight back on the next run, which re-split the money across the pair
    // and undid the merge ($309,080,435 over 95 rows, measured on a clone).
    // The guard is in SQL rather than in the caller so it holds even if a
    // concurrent writer retires the claim between match time and now.
    await client.query(
      `UPDATE public.officials
          SET source_ids = COALESCE(source_ids, '{}'::jsonb) || jsonb_build_object($1::text, $2::text)
        WHERE id = $3::uuid
          AND COALESCE(source_ids->>'merged_fec_candidate_id', '') <> $2::text`,
      [storageKey, fecId, officialId],
    );
  }
}
