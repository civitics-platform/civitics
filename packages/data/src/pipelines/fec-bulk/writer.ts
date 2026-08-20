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
 *  before the next chunk begins. Only unscoped runs pass this.
 *
 *  FIX-996: the per-chunk calls also pass the LIVE direct-pg client bulkUpsert
 *  is writing on, so the checkpoint can ride that connection instead of going
 *  back out over PostgREST (8s role cap, ~100s gateway cap) at the exact moment
 *  the DB is saturated by the writes being checkpointed. The stage-start call
 *  has no client — it happens before withDirectClient opens one — so the
 *  parameter is optional and the hook must handle its absence. */
export interface WriterResume {
  progress: StageProgress | undefined;
  onProgress: (
    processedRows: number,
    totalRows: number,
    client?: Client,
  ) => Promise<void> | void;
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
// FIX-1061 — streamed writer core
//
// FIX-961 (PR 3a) bounded the indiv STREAMING stage but not the WRITE stages:
// index.ts drained each sorted stream into a whole-cycle array before calling a
// writer, because the writers took arrays. Measured cycle-2026 scale — 879,782
// donors, 762,891 candidate pairs, 553,717 committee pairs — that is ~2.2M live
// objects, and cycle 2020 is materially bigger. With the streaming maps gone it
// was the binding constraint, and the emit-time floor grows it further.
//
// `upsertStreamed` is the replacement: pull a bounded batch off a sorted async
// iterable, resolve whatever foreign ids that batch needs, build its rows,
// upsert, advance the cursor, drop it. Peak memory is one batch.
//
// ── The cursor domain changed, deliberately ─────────────────────────────────
// FIX-754's cursor used to be "rows in the merged input array". A streamed
// writer cannot know that number without materializing the array it exists to
// avoid — rows are dropped mid-stream when a donor or recipient id fails to
// resolve. The cursor is therefore now **items consumed from the sorted
// stream**, whose total IS known up front (the sorter's group count) and whose
// order is the sort order, i.e. deterministic across runs and across machines.
//
// Old state resumes safely by construction: a stored `total_rows` recorded in
// the old domain will not match the new one, so `resolveResumeCursor` resets
// that stage to 0 and the (idempotent) upserts simply re-run. That is the
// FIX-754 defensive reset doing exactly its job.
//
// ── Batches are aligned to group boundaries ─────────────────────────────────
// Two aggregates can collide on the upsert arbiter — an official holding both a
// House and a Senate FEC candidate id receives two `(fp, C, candId)` aggregates
// that resolve to one `to_id`. Postgres rejects two such rows in ONE statement
// ("cannot affect row a second time"), and splitting them across two statements
// is WORSE: the second silently overwrites the first instead of summing. The
// array writers dedupe with a whole-population Map. A streamed writer cannot,
// so batches are closed only on a change of group key (the donor fingerprint) —
// every colliding pair is contiguous in the sort order, so a group-aligned
// batch sees all of them and the in-batch merge is exactly equivalent to the
// global one.
// ---------------------------------------------------------------------------

/** Items per DB round-trip. Matches direct-pg-upsert's DEFAULT_CHUNK so a batch
 *  is normally one statement. */
const STREAM_BATCH_ITEMS = 4000;

/**
 * Group-boundary-aligned batching over a key-sorted async iterable.
 *
 * Fills to `size`, then keeps pulling while the key is unchanged, so no group
 * is ever split across two batches. Exported for the unit test.
 */
export async function* batchByGroup<T>(
  source: AsyncIterable<T>,
  size: number,
  keyOf: (item: T) => string,
): AsyncGenerator<T[]> {
  let batch: T[] = [];
  let lastKey: string | null = null;
  for await (const item of source) {
    const key = keyOf(item);
    if (batch.length >= size && key !== lastKey) {
      yield batch;
      batch = [];
    }
    batch.push(item);
    lastKey = key;
  }
  if (batch.length > 0) yield batch;
}

export interface StreamedUpsertSpec<T> {
  /** Greppable stage label (also the bulkUpsert label). */
  label: string;
  table: string;
  columns: string[];
  conflictColumns: string[];
  updateColumns?: string[];
  jsonbColumns?: string[];
  skipUnchangedRows?: boolean;
  /** Items in sort order. The cursor domain. */
  source: AsyncIterable<T>;
  /** How many items `source` will yield — the sorter's group count. */
  totalItems: number;
  /** Group key; batches never split a group. */
  groupKeyOf: (item: T) => string;
  /**
   * Called once per batch BEFORE rows are built, on the live connection, so the
   * batch's foreign ids can be resolved in one round-trip instead of from a
   * whole-cycle map.
   */
  prepareBatch?: (items: T[], client: Client) => Promise<void>;
  /** Build a row aligned to `columns`. Return null to drop the item. */
  toRow: (item: T) => unknown[] | null;
  /**
   * Merge key for two rows that would collide on the upsert arbiter, computed
   * from the BUILT row. Rows sharing one are folded via `mergeRows`. Omit when
   * collisions are impossible.
   */
  rowMergeKeyOf?: (row: unknown[]) => string;
  /** Fold `b` into `a` in place. Required when `rowMergeKeyOf` is set. */
  mergeRows?: (a: unknown[], b: unknown[]) => void;
  resume?: WriterResume;
  batchItems?: number;
}

export interface StreamedUpsertResult extends RelationshipBatchResult {
  /** Items `toRow` dropped (unresolvable foreign id). */
  skipped: number;
  /** Rows the server actually wrote (FIX-1008 skip accounting). */
  changed: number;
}

/**
 * Stream a sorted aggregate iterable straight into chunked upserts.
 *
 * One direct-pg connection for the whole stage (as the array writers had), one
 * statement per batch, cursor persisted after every batch commits.
 */
export async function upsertStreamed<T>(spec: StreamedUpsertSpec<T>): Promise<StreamedUpsertResult> {
  const batchSize = spec.batchItems ?? STREAM_BATCH_ITEMS;

  // FIX-754: resolve the resume offset in the ITEM domain. A stored total from
  // the pre-FIX-1061 row domain will not match and resets the cursor to 0.
  const startItem = await beginCursoredStage(spec.resume, spec.label, spec.totalItems);

  let consumed = 0, upserted = 0, failed = 0, changed = 0, skipped = 0;

  await withDirectClient(async (client) => {
    for await (const batch of batchByGroup(spec.source, batchSize, spec.groupKeyOf)) {
      // Rows before the cursor were committed by a prior run. Skip WITHOUT
      // building rows or resolving ids — the whole point of resuming.
      if (consumed + batch.length <= startItem) {
        consumed += batch.length;
        continue;
      }
      // A partially-consumed batch can only happen when a prior run's cursor
      // landed mid-batch, which group alignment makes possible if batch sizes
      // shift. Re-doing the whole batch is idempotent, so take the safe path.
      consumed += batch.length;

      if (spec.prepareBatch) await spec.prepareBatch(batch, client);

      let rows: unknown[][] = [];
      for (const item of batch) {
        const row = spec.toRow(item);
        if (row === null) { skipped++; continue; }
        rows.push(row);
      }
      if (spec.rowMergeKeyOf && spec.mergeRows) {
        rows = mergeRowsByKey(rows, spec.rowMergeKeyOf, spec.mergeRows);
      }

      if (rows.length > 0) {
        const res = await bulkUpsert(client, {
          table:             spec.table,
          label:             spec.label,
          columns:           spec.columns,
          conflictColumns:   spec.conflictColumns,
          updateColumns:     spec.updateColumns,
          jsonbColumns:      spec.jsonbColumns,
          skipUnchangedRows: spec.skipUnchangedRows,
          rows,
        });
        upserted += res.upserted;
        failed   += res.failed;
        changed  += res.changed;
      }

      // FIX-996: the cursor rides the live connection, and is advanced only
      // AFTER the batch's statement committed.
      if (spec.resume) await spec.resume.onProgress(consumed, spec.totalItems, client);
    }
  });

  logSkipRatio(spec.label, upserted, changed);
  return { upserted, failed, changed, skipped };
}

/** Fold rows that share a merge key, preserving first-seen order. */
function mergeRowsByKey(
  rows: unknown[][],
  keyOf: (row: unknown[]) => string,
  merge: (a: unknown[], b: unknown[]) => void,
): unknown[][] {
  const byKey = new Map<string, unknown[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const existing = byKey.get(key);
    if (existing) merge(existing, row);
    else byKey.set(key, row);
  }
  return [...byKey.values()];
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
/**
 * Client-side dedupe by fingerprint — Postgres rejects two rows that hit the
 * same conflict arbiter in a single statement. Sum totals so the surviving row
 * carries the merged donation total; prefer the longer displayName and the
 * first non-empty value for each metadata field.
 *
 * FIX-995 — entries are stored BY REFERENCE and merged IN PLACE. This used to
 * store `{ ...input }`, building a second full object graph of the donor
 * population (~840k objects on a presidential cycle) purely so the merge could
 * mutate safely. The merge branch is unreachable for the one production
 * caller — fec-bulk builds `donorInputs` by iterating a Map keyed by
 * fingerprint with `fingerprint: fp`, so it is unique by construction — so the
 * clone was paying for the whole population to protect a branch that never
 * runs. MEASURED at N=840,338 (`pnpm --filter @civitics/data
 * data:measure:donor-heap`): 98.5 MB → 27.9 MB, a 70.6 MB saving; the residue
 * is the Map's own entry storage, which the dedupe genuinely needs.
 *
 * CONTRACT: elements of `inputs` MAY BE MUTATED when duplicate fingerprints
 * are present. Merge semantics are unchanged and pinned by writer-dedupe.test.ts.
 * Callers must not rely on `inputs` being pristine afterwards. `fingerprint` is
 * the merge key, so it is invariant under merging — which is what makes the
 * fec-bulk caller's post-call reads (`.length`, `.fingerprint`) safe.
 *
 * Exported for the unit test; not part of the pipeline's public surface.
 */
export function mergeIndividualDonorInputs(
  inputs: IndividualDonorInput[],
): Map<string, IndividualDonorInput> {
  const merged = new Map<string, IndividualDonorInput>();
  for (const input of inputs) {
    const existing = merged.get(input.fingerprint);
    if (!existing) {
      merged.set(input.fingerprint, input);
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
  return merged;
}

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
  //
  // FIX-1009: an UNSCOPED run no longer overwrites those columns either — it
  // just does it by narrowing the DO UPDATE SET list instead of the INSERT list,
  // so a brand-new donor still lands with a real value. See
  // DONOR_UPDATE_COLUMNS_UNSCOPED for the gate that decided the difference.
  skipAggregateOverwrite = false,
  // FIX-754: checkpoint cursor for killed-run resume. Unscoped runs only.
  resume?: WriterResume,
): Promise<IndividualDonorBatchResult> {
  const donorIdByFingerprint = new Map<string, string>();

  if (inputs.length === 0) return { donorIdByFingerprint, upserted: 0, failed: 0 };

  const merged = mergeIndividualDonorInputs(inputs);

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

  // FIX-995: fold the RETURNING rows into donorIdByFingerprint PER CHUNK
  // instead of accumulating all ~840k row objects for the whole stage and
  // folding at the end. The resulting map is byte-identical; only the retention
  // window changes. Measured 208.7 MB → 168.2 MB at N=840,338.
  const fpIdx = columns.indexOf("donor_fingerprint");
  const { upserted, failed, changed } = await withDirectClient(async (client) => {
    const res = await bulkUpsert(client, {
      table:            "financial_entities",
      label:            "individual-donor",
      columns,
      conflictColumns:  ["donor_fingerprint"],
      // FIX-1009: on an UNSCOPED run the aggregate columns are INSERTed (a new
      // donor needs a real value — see DONOR_UPDATE_COLUMNS_UNSCOPED) but never
      // SET on conflict, so `rebuild_financial_entity_donation_totals()` and the
      // pg_cron totals jobs are the only writers of an EXISTING donor's
      // all-cycle aggregate. A scoped run keeps FIX-700's column drop, so its
      // SET list is already aggregate-free and needs no override.
      updateColumns:    skipAggregateOverwrite ? undefined : DONOR_UPDATE_COLUMNS_UNSCOPED,
      jsonbColumns:     ["metadata"],
      returningColumns: ["id", "donor_fingerprint"],
      // FIX-1008: skip the no-op re-upserts. See the id backfill directly below
      // — this is the `RETURNING goes quiet` consequence, handled explicitly.
      skipUnchangedRows: true,
      rows,
      startRowOffset,
      // FIX-996: hand the live client to the checkpoint hook so the cursor
      // write rides this connection rather than PostgREST.
      onChunkProcessed: resume ? (n) => resume.onProgress(n, rows.length, client) : undefined,
      onReturnedRows: (chunkRows) => {
        for (const row of chunkRows as Array<{ id: string; donor_fingerprint: string | null }>) {
          if (row.donor_fingerprint) donorIdByFingerprint.set(row.donor_fingerprint, row.id);
        }
      },
    });

    // FIX-1008 — recover the ids RETURNING no longer hands back. A donor whose
    // every column already matched is not updated, so it emits no RETURNING
    // row, but the three relationship stages still need its id as `from_id`.
    // Re-read those on the SAME connection (no second pooler login), in
    // RESUME_READ_BATCH-sized `= ANY($1)` reads — the FIX-754 rebuild path's
    // shape, which already had to solve exactly this problem.
    //
    // This also closes a pre-existing gap in the FIX-754 mid-stage resume: rows
    // BEFORE `startRowOffset` were committed by an earlier run and likewise
    // never produced a RETURNING row for this one.
    const missing: string[] = [];
    for (const row of rows) {
      const fp = row[fpIdx] as string | null;
      if (fp && !donorIdByFingerprint.has(fp)) missing.push(fp);
    }
    if (missing.length > 0) {
      console.log(
        `    individual-donor: re-reading ${missing.length.toLocaleString()} donor id(s) ` +
          `not returned by the upsert (unchanged rows / prior-run chunks) (FIX-1008)`,
      );
      for (let i = 0; i < missing.length; i += RESUME_READ_BATCH) {
        const batch = missing.slice(i, i + RESUME_READ_BATCH);
        const q = await client.query(
          `SELECT id, donor_fingerprint FROM public.financial_entities WHERE donor_fingerprint = ANY($1)`,
          [batch],
        );
        for (const r of q.rows as Array<{ id: string; donor_fingerprint: string }>) {
          donorIdByFingerprint.set(r.donor_fingerprint, r.id);
        }
      }
    }

    return res;
  });

  console.log(
    `    individual-donor: ${changed.toLocaleString()}/${upserted.toLocaleString()} rows ` +
      `actually written (${(upserted - changed).toLocaleString()} unchanged, skipped) (FIX-1008)`,
  );

  return { donorIdByFingerprint, upserted, failed };
}

/**
 * FIX-1061 — streamed donor-entity upsert.
 *
 * Same table, columns, arbiter and FIX-700/1009/1008 semantics as
 * `upsertIndividualDonorsBatch`; the differences are all consequences of not
 * holding the population:
 *
 *   - NO `mergeIndividualDonorInputs`. The external sort emits exactly one
 *     record per fingerprint (`metaSorted.groupCount` IS the donor count), so
 *     the merge was already a no-op for this caller — FIX-995 says as much in
 *     its own comment. Nothing can collide, so nothing needs merging.
 *   - NO `RETURNING`, and so no `donorIdByFingerprint` and no FIX-1008 id
 *     recovery. The relationship stages resolve their own batch's donors
 *     against the unique index instead of inheriting a ~1.9M-entry map.
 */
export async function streamIndividualDonorEntities(
  source: AsyncIterable<IndividualDonorInput>,
  totalItems: number,
  skipAggregateOverwrite = false,
  resume?: WriterResume,
): Promise<StreamedUpsertResult> {
  const columns = skipAggregateOverwrite ? DONOR_COLUMNS_SCOPED : DONOR_COLUMNS;
  return upsertStreamed<IndividualDonorInput>({
    label:            "individual-donor",
    table:            "financial_entities",
    columns,
    conflictColumns:  ["donor_fingerprint"],
    updateColumns:    skipAggregateOverwrite ? undefined : DONOR_UPDATE_COLUMNS_UNSCOPED,
    jsonbColumns:     ["metadata"],
    skipUnchangedRows: true,
    source,
    totalItems,
    groupKeyOf: (d) => d.fingerprint,
    toRow: (input) => {
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
    },
    resume,
  });
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

/** Entity aggregate columns no pipeline writer should own on a conflict. */
export const ENTITY_AGGREGATE_COLUMNS = ["total_donated_cents", "total_received_cents"] as const;

/**
 * FIX-1009 — `DO UPDATE SET` list for an UNSCOPED donor upsert: every non-arbiter
 * column EXCEPT the aggregates.
 *
 * WHY THIS AND NOT FIX-700's COLUMN DROP. Both stop an existing donor's
 * authoritative all-cycle total being clobbered with a cycle-only value, but
 * they differ on the NEW-donor path, and that difference is the whole gate:
 *
 *   FIX-700 (scoped)   column absent from the INSERT list  → new donor gets 0
 *   FIX-1009 (unscoped) column present, absent from SET    → new donor gets the
 *                                                            real inserted value
 *
 * A new donor must not land at 0. `rebuild_financial_entity_donation_totals()`
 * is no longer called by this pipeline at all (FIX-702/726 moved it to pg_cron),
 * and MEASURED on the local clone 2026-08-12 the weekly
 * `financial-entity-totals-incremental` job is still `active = false` — created
 * paused by 20260704000000 and never enabled by any migration. Only
 * `financial-entity-totals-reconcile` (1st of month, 12:00 UTC) is active. So
 * the real coverage window for a brand-new donor is up to ~31 days, not a week,
 * and dropping the column outright would park every newly-itemised donor at $0
 * on their public page for most of a month.
 *
 * Keeping the INSERT value closes that with no new machinery: a donor who is
 * NEW to `financial_entities` has no prior-cycle rows by construction, so the
 * cycle total this run computed IS their all-cycle total. The lossy case FIX-269
 * exists for — a donor who gave in an EARLIER cycle — is exactly the conflict
 * path, which now leaves the stored value alone.
 *
 * `skipUnchangedRows` (FIX-1008) builds its "did anything change" predicate from
 * the SET list, so narrowing the SET list narrows the predicate in lockstep and
 * the invariant "the predicate always covers EXACTLY the SET list" still holds.
 * That is the payoff: a multi-cycle donor whose stored all-cycle total can never
 * equal the cycle-only value being written was rewritten every single week no
 * matter what — 24.2% of donors, per the FIX-1009 prod sample — and is now
 * skippable like everyone else.
 */
const DONOR_UPDATE_COLUMNS_UNSCOPED: string[] = DONOR_COLUMNS.filter(
  (c) =>
    c !== "donor_fingerprint" &&
    !(ENTITY_AGGREGATE_COLUMNS as readonly string[]).includes(c),
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
      // FIX-1008: a re-upserted PAC→candidate aggregate whose amount, date,
      // source_url and metadata all already match is left untouched. No
      // RETURNING here, so nothing downstream changes.
      skipUnchangedRows: true,
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
      // FIX-1008: the weekly FEC file is a superset — measured 0.5–6.3% of the
      // rows this stage writes are new. The rest are byte-identical re-upserts
      // that cost a full 16-index rewrite because FR takes zero HOT updates.
      skipUnchangedRows: true,
      rows,
      startRowOffset,
      // FIX-996: hand the live client to the checkpoint hook so the cursor
      // write rides this connection rather than PostgREST.
      onChunkProcessed: resume ? (n) => resume.onProgress(n, rows.length, client) : undefined,
    }).then(({ upserted, failed, changed }) => {
      logSkipRatio("indiv-donation", upserted, changed);
      return { upserted, failed };
    }),
  );
}

// ---------------------------------------------------------------------------
// FIX-1061 — streamed relationship writers
//
// Both take the indiv stage's sorted aggregate iterable directly. Because that
// stream is fingerprint-ordered, a batch touches ~`batchItems` distinct donors,
// so resolving their ids is ONE indexed `donor_fingerprint = ANY($1)` probe on
// the connection already open for the writes. That is what replaces the
// ~1.9M-entry `donorIdByFingerprint` map the array path carried for the whole
// cycle — and it is the same read the FIX-754 resume path already performs, just
// a batch at a time.
//
// Consequence worth knowing: a run that SKIPS the donor-entities stage
// (FEC_INDIV_STAGES) used to write zero relationships, because the id map it
// inherited was empty. It now resolves donors that already exist in the DB and
// writes their relationships. That is strictly more useful (it is what the
// FIX-754 already-complete path does deliberately) and it drives the FIX-686
// skipped_unresolved counter toward 0 rather than toward the stage count.
// ---------------------------------------------------------------------------

/** The indiv → candidate aggregate as the writer needs it. */
export interface StreamedIndivCandidateItem {
  donorFingerprint: string;
  candId:           string;
  totalCents:       number;
  txCount:          number;
  latestDate:       string | null;
}

/** The indiv → non-candidate-committee aggregate as the writer needs it. */
export interface StreamedIndivCommitteeItem {
  donorFingerprint: string;
  cmteId:           string;
  totalCents:       number;
  txCount:          number;
  latestDate:       string | null;
}

/** Resolve a batch's donor fingerprints on an already-open connection. */
async function resolveDonorIdsOn(
  client: Client,
  fingerprints: Iterable<string>,
  into: Map<string, string>,
): Promise<void> {
  const wanted = [...new Set(fingerprints)];
  if (wanted.length === 0) return;
  for (let i = 0; i < wanted.length; i += RESUME_READ_BATCH) {
    const res = await client.query(
      `SELECT id, donor_fingerprint FROM public.financial_entities WHERE donor_fingerprint = ANY($1)`,
      [wanted.slice(i, i + RESUME_READ_BATCH)],
    );
    for (const r of res.rows as Array<{ id: string; donor_fingerprint: string }>) {
      into.set(r.donor_fingerprint, r.id);
    }
  }
}

/** Index of the arbiter columns inside REL_COLUMNS, for the in-batch merge. */
const REL_FROM_ID_IDX = REL_COLUMNS.indexOf("from_id");
const REL_TO_ID_IDX   = REL_COLUMNS.indexOf("to_id");
const REL_CYCLE_IDX   = REL_COLUMNS.indexOf("cycle_year");
const REL_AMOUNT_IDX  = REL_COLUMNS.indexOf("amount_cents");
const REL_OCCURRED_IDX = REL_COLUMNS.indexOf("occurred_at");
const REL_METADATA_IDX = REL_COLUMNS.indexOf("metadata");

/** Arbiter key of a built relationship row. */
function relMergeKey(row: unknown[]): string {
  return `${row[REL_FROM_ID_IDX]}|${row[REL_TO_ID_IDX]}|${row[REL_CYCLE_IDX]}`;
}

/**
 * Fold two relationship rows that hit the same arbiter: sum amount and tx_count,
 * keep the later occurred_at. Mirrors the array writers' `merged` Map exactly.
 */
function mergeRelRows(a: unknown[], b: unknown[]): void {
  a[REL_AMOUNT_IDX] = (a[REL_AMOUNT_IDX] as number) + (b[REL_AMOUNT_IDX] as number);
  const aMeta = a[REL_METADATA_IDX] as { tx_count: number };
  const bMeta = b[REL_METADATA_IDX] as { tx_count: number };
  aMeta.tx_count += bMeta.tx_count;
  const aAt = a[REL_OCCURRED_IDX] as string | null;
  const bAt = b[REL_OCCURRED_IDX] as string | null;
  if (bAt && (!aAt || bAt > aAt)) a[REL_OCCURRED_IDX] = bAt;
}

/**
 * FIX-1061 — streamed individual → official donation upsert. Replaces
 * `upsertIndividualDonationsBatch` on the pipeline path.
 */
export async function streamIndividualDonations(opts: {
  source:      AsyncIterable<StreamedIndivCandidateItem>;
  totalItems:  number;
  cycleYear:   number;
  /** FEC CAND_ID → officials.id. Bounded by candidate count; safe to hold. */
  officialIdByCandId: Map<string, string>;
  /** MMDDYYYY → ISO date, or null. */
  parseDate:   (raw: string) => string | null;
  resume?:     WriterResume;
}): Promise<StreamedUpsertResult> {
  const donorIds = new Map<string, string>();
  return upsertStreamed<StreamedIndivCandidateItem>({
    label:            "indiv-donation",
    table:            "financial_relationships",
    columns:          REL_COLUMNS,
    conflictColumns:  REL_CONFLICT,
    jsonbColumns:     ["metadata"],
    skipUnchangedRows: true,
    source:           opts.source,
    totalItems:       opts.totalItems,
    groupKeyOf:       (a) => a.donorFingerprint,
    prepareBatch: async (items, client) => {
      // Only this batch's donors are resolved, and the map is reset per batch so
      // nothing accumulates across the cycle.
      donorIds.clear();
      await resolveDonorIdsOn(client, items.map((i) => i.donorFingerprint), donorIds);
    },
    toRow: (agg) => {
      const fromEntityId = donorIds.get(agg.donorFingerprint);
      if (!fromEntityId) return null;
      const toOfficialId = opts.officialIdByCandId.get(agg.candId);
      if (!toOfficialId) return null;
      const occurredAt =
        (agg.latestDate ? opts.parseDate(agg.latestDate) : null) ?? `${opts.cycleYear}-01-01`;
      return [
        "donation",
        "financial_entity",
        fromEntityId,
        "official",
        toOfficialId,
        agg.totalCents,
        occurredAt,
        null,
        null,
        opts.cycleYear,
        "https://www.fec.gov/data/receipts/individual-contributions/",
        {
          donor_fingerprint: agg.donorFingerprint,
          tx_count:          agg.txCount,
          source:            "fec_bulk_indiv",
          aggregated:        true,
        },
      ];
    },
    // One official can hold two FEC candidate ids (a House id and a later Senate
    // id), so two of a donor's aggregates can resolve to the same to_id.
    rowMergeKeyOf: relMergeKey,
    mergeRows:     mergeRelRows,
    resume:        opts.resume,
  });
}

/**
 * FIX-1061 — streamed individual → committee donation upsert. Replaces
 * `upsertIndividualToCommitteeDonationsBatch` on the pipeline path.
 */
export async function streamIndividualToCommitteeDonations(opts: {
  source:      AsyncIterable<StreamedIndivCommitteeItem>;
  totalItems:  number;
  cycleYear:   number;
  /** FEC CMTE_ID → financial_entities.id. Bounded by committee count. */
  entityIdByCmteId: Map<string, string>;
  parseDate:   (raw: string) => string | null;
  resume?:     WriterResume;
  /** FIX-686: called for each aggregate dropped for an unresolved id. */
  onUnresolved?: () => void;
}): Promise<StreamedUpsertResult> {
  const donorIds = new Map<string, string>();
  return upsertStreamed<StreamedIndivCommitteeItem>({
    label:            "indiv-to-committee",
    table:            "financial_relationships",
    columns:          REL_COLUMNS,
    conflictColumns:  REL_CONFLICT,
    jsonbColumns:     ["metadata"],
    skipUnchangedRows: true,
    source:           opts.source,
    totalItems:       opts.totalItems,
    groupKeyOf:       (a) => a.donorFingerprint,
    prepareBatch: async (items, client) => {
      donorIds.clear();
      await resolveDonorIdsOn(client, items.map((i) => i.donorFingerprint), donorIds);
    },
    toRow: (agg) => {
      const fromEntityId = donorIds.get(agg.donorFingerprint);
      if (!fromEntityId) { opts.onUnresolved?.(); return null; }   // FIX-686
      const toEntityId = opts.entityIdByCmteId.get(agg.cmteId);
      if (!toEntityId) { opts.onUnresolved?.(); return null; }     // FIX-686
      const occurredAt =
        (agg.latestDate ? opts.parseDate(agg.latestDate) : null) ?? `${opts.cycleYear}-01-01`;
      return [
        "donation",
        "financial_entity",
        fromEntityId,
        "financial_entity",
        toEntityId,
        agg.totalCents,
        occurredAt,
        null,
        null,
        opts.cycleYear,
        `https://www.fec.gov/data/committee/${agg.cmteId}/`,
        {
          donor_fingerprint: agg.donorFingerprint,
          fec_committee_id:  agg.cmteId,
          tx_count:          agg.txCount,
          source:            "fec_bulk_indiv_to_committee",
          aggregated:        true,
        },
      ];
    },
    // Distinct committees are distinct entities, so a collision here needs two
    // fingerprints resolving to one donor id — impossible under the
    // donor_fingerprint UNIQUE. Kept for symmetry and cheap insurance.
    rowMergeKeyOf: relMergeKey,
    mergeRows:     mergeRelRows,
    resume:        opts.resume,
  });
}

/** FIX-1008 — one line per stage showing how much of the re-upsert was real
 *  work. `changed` is the server's row count; the remainder is rows whose every
 *  SET column already matched and which were therefore never rewritten. */
function logSkipRatio(label: string, upserted: number, changed: number): void {
  console.log(
    `    ${label}: ${changed.toLocaleString()}/${upserted.toLocaleString()} rows actually ` +
      `written (${(upserted - changed).toLocaleString()} unchanged, skipped) (FIX-1008)`,
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
      // FIX-1008: Schedule E is re-aggregated whole every run; only the rows
      // whose amount or date actually moved need rewriting.
      skipUnchangedRows: true,
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
      // FIX-1008: same superset economics as indiv-donation above.
      skipUnchangedRows: true,
      rows,
      startRowOffset,
      // FIX-996: hand the live client to the checkpoint hook so the cursor
      // write rides this connection rather than PostgREST.
      onChunkProcessed: resume ? (n) => resume.onProgress(n, rows.length, client) : undefined,
    }).then(({ upserted, failed, changed }) => {
      logSkipRatio("indiv-to-committee", upserted, changed);
      return { upserted, failed };
    }),
  );
}

// ---------------------------------------------------------------------------
// FIX-1068 — sub-$200 residual bracket rollup
// ---------------------------------------------------------------------------

export interface SmallDollarBracketWriteRow {
  recipientType: "official" | "financial_entity";
  recipientId:   string;
  bracket:       string;
  donorCount:    number;
  totalCents:    number;
  txCount:       number;
}

const BRACKET_COLUMNS: string[] = [
  "recipient_type",
  "recipient_id",
  "cycle_year",
  "bracket",
  "donor_count",
  "total_cents",
  "tx_count",
  "source",
  "updated_at",
];

const BRACKET_CONFLICT: string[] = [
  "recipient_type", "recipient_id", "cycle_year", "bracket", "source",
];

/**
 * Replace this (cycle, source) slice of `small_dollar_bracket_rollup`.
 *
 * DELETE-then-INSERT, not a bare upsert: a recipient whose sub-floor residual
 * moved out of a bracket between runs (their donors crossed $200, or FEC revised
 * the file) must lose the stale row, and an upsert cannot express that. The
 * whole slice is small — tens of thousands of rows — so this is cheap.
 *
 * Wrapped in an explicit transaction. `bulkUpsert` is autocommit-per-chunk by
 * design (FIX-949) and atomicity is the caller's job; a run killed between the
 * DELETE and the last INSERT would otherwise leave the rollup truncated, which
 * is the FIX-945 rule-tagger failure exactly. Bounded row count is what makes
 * one transaction affordable here — do NOT copy this shape onto the
 * million-row writers.
 */
export async function replaceSmallDollarBrackets(
  cycleYear: number,
  rows:      SmallDollarBracketWriteRow[],
  source = "fec_bulk_indiv",
): Promise<{ deleted: number; inserted: number; failed: number }> {
  return withDirectClient(async (client) => {
    await client.query("BEGIN");
    try {
      const del = await client.query(
        `DELETE FROM public.small_dollar_bracket_rollup WHERE cycle_year = $1 AND source = $2`,
        [cycleYear, source],
      );
      let inserted = 0, failed = 0;
      if (rows.length > 0) {
        const now = new Date().toISOString();
        const res = await bulkUpsert(client, {
          table:           "small_dollar_bracket_rollup",
          label:           "small-dollar-brackets",
          columns:         BRACKET_COLUMNS,
          conflictColumns: BRACKET_CONFLICT,
          rows: rows.map((r) => [
            r.recipientType, r.recipientId, cycleYear, r.bracket,
            r.donorCount, r.totalCents, r.txCount, source, now,
          ]),
        });
        inserted = res.upserted;
        failed   = res.failed;
      }
      if (failed > 0) {
        // FIX-686 loud-abort contract: a partially-written rollup reads as a
        // real (smaller) residual, which is worse than no rollup at all.
        throw new Error(
          `small-dollar-brackets: ${failed}/${rows.length} rows failed — rolling back (FIX-686)`,
        );
      }
      await client.query("COMMIT");
      return { deleted: del.rowCount ?? 0, inserted, failed };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => { /* best effort */ });
      throw err;
    }
  });
}

/**
 * FIX-1068 — re-aggregate `official_small_dollar_rollup` for the officials whose
 * bracket rows this run just wrote.
 *
 * WHY THE INGEST DOES THIS RATHER THAN LEAVING IT TO THE DAILY REFRESH. The
 * FIX-704/832 dirty set is derived from `financial_relationships.updated_at`, so
 * it captures officials whose FR rows moved. An official who received ONLY
 * sub-floor money this cycle has no FR rows to move, is therefore never dirty,
 * and their residual would sit in the bracket table forever without reaching the
 * summary the route reads. Any official who also received above-floor money is
 * picked up by the dirty set anyway — so this call is redundant for the common
 * case and load-bearing for the tail, which is the right way round.
 *
 * Chunked at the same 500 the FIX-776 backfill uses, on one connection.
 */
export async function rebuildSmallDollarForOfficials(officialIds: string[]): Promise<number> {
  const unique = [...new Set(officialIds)];
  if (unique.length === 0) return 0;
  const CHUNK = 500;
  let rebuilt = 0;
  await withDirectClient(async (client) => {
    for (let i = 0; i < unique.length; i += CHUNK) {
      const chunk = unique.slice(i, i + CHUNK);
      await client.query(`SELECT public.small_dollar_rebuild_officials($1::uuid[])`, [chunk]);
      rebuilt += chunk.length;
    }
  });
  return rebuilt;
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
