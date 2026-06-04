/**
 * CourtListener writer — post-cutover, batched writes against public.
 *
 * Tables written:
 *   public.governing_bodies          one per federal court (type='judicial');
 *                                    resolved per-court since volume is 14
 *   public.officials                 federal judges; dedup via
 *                                    external_source_refs (source='courtlistener',
 *                                    entity_type='official')
 *   public.proposals                 court opinions (type='other',
 *                                    status='enacted')
 *   public.case_details              one per opinion (docket_number,
 *                                    court_name, case_name, filed_at, …)
 *   public.external_source_refs      (source='courtlistener',
 *                                    entity_type='proposal'|'official')
 *
 * All dedup goes through external_source_refs (UNIQUE(source, external_id)).
 * Migration 20260425000200 backfills refs for judges that pre-date the
 * cutover, so the writer's lookup finds them without schema change.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { createAdminClient } from "@civitics/db";
import { refreshPrimarySourceForEntities } from "@civitics/db";

type Db = any;

const CHUNK_SIZE = 500;
const LOOKUP_CHUNK_SIZE = 200;

const COURT_FULL_NAMES: Record<string, string> = {
  scotus: "Supreme Court of the United States",
  ca1:    "U.S. Court of Appeals for the First Circuit",
  ca2:    "U.S. Court of Appeals for the Second Circuit",
  ca3:    "U.S. Court of Appeals for the Third Circuit",
  ca4:    "U.S. Court of Appeals for the Fourth Circuit",
  ca5:    "U.S. Court of Appeals for the Fifth Circuit",
  ca6:    "U.S. Court of Appeals for the Sixth Circuit",
  ca7:    "U.S. Court of Appeals for the Seventh Circuit",
  ca8:    "U.S. Court of Appeals for the Eighth Circuit",
  ca9:    "U.S. Court of Appeals for the Ninth Circuit",
  ca10:   "U.S. Court of Appeals for the Tenth Circuit",
  ca11:   "U.S. Court of Appeals for the Eleventh Circuit",
  cadc:   "U.S. Court of Appeals for the D.C. Circuit",
  cafc:   "U.S. Court of Appeals for the Federal Circuit",
};

// ---------------------------------------------------------------------------
// Judicial governing bodies — find-or-create per court (volume 14)
// ---------------------------------------------------------------------------

export async function resolveJudicialGovBodies(
  db: Db,
  federalId: string,
  courtIds: string[],
): Promise<Map<string, string>> {
  const courtMap = new Map<string, string>();

  for (const courtId of courtIds) {
    const name = COURT_FULL_NAMES[courtId] ?? `Federal Court (${courtId})`;

    const { data: existing } = await db
      .from("governing_bodies")
      .select("id")
      .eq("name", name)
      .eq("jurisdiction_id", federalId)
      .maybeSingle();

    if (existing?.id) {
      courtMap.set(courtId, existing.id);
      continue;
    }

    const { data: inserted, error } = await db
      .from("governing_bodies")
      .insert({
        name,
        short_name: courtId.toUpperCase(),
        type: "judicial",
        jurisdiction_id: federalId,
        is_active: true,
        metadata: { courtlistener_court_id: courtId },
      })
      .select("id")
      .single();

    if (error || !inserted) {
      // 23505 = concurrent-insert race; retry select
      if (error?.code === "23505") {
        const { data: retry } = await db
          .from("governing_bodies")
          .select("id")
          .eq("name", name)
          .eq("jurisdiction_id", federalId)
          .maybeSingle();
        if (retry?.id) { courtMap.set(courtId, retry.id); continue; }
      }
      console.error(`    courtlistener writer: gov_body ${courtId}: ${error?.message}`);
      continue;
    }

    courtMap.set(courtId, inserted.id);
  }

  // FIX-477: external_source_refs coverage for judicial governing_bodies, so
  // the /institutions/[id] SourceBadge + attribution popover have an xsr row to
  // read. Covers BOTH paths — every court in courtMap (existing-row OR
  // fresh-insert) gets its row refreshed on every run (last_seen_at bump).
  // external_id is the real CourtListener court id (the FIX-477 backfill script
  // reads the identical value from metadata->>'courtlistener_court_id').
  // source_url stays null: no confidently-stable per-court public URL — null
  // beats a 404.
  if (courtMap.size > 0) {
    const gbRefRecords = [...courtMap.entries()].map(([courtId, gbId]) => ({
      source: "courtlistener",
      external_id: courtId,
      entity_type: "governing_body",
      entity_id: gbId,
      last_seen_at: new Date().toISOString(),
      metadata: {},
    }));
    // Merge-upsert (not ignoreDuplicates) so an existing court's last_seen_at is
    // refreshed on every run; entity_id stays the same value either way.
    const { error } = await db
      .from("external_source_refs")
      .upsert(gbRefRecords, { onConflict: "source,external_id" });
    if (error) {
      console.error(`    courtlistener writer: source_refs (governing_body): ${error.message}`);
    }
    await refreshPrimarySourceForEntities(db, "governing_body", [...courtMap.values()]);
  }

  return courtMap;
}

// ---------------------------------------------------------------------------
// Judges
// ---------------------------------------------------------------------------

export interface JudgeInput {
  courtlistenerPersonId: string;
  fullName: string;
  firstName: string | null;
  lastName: string | null;
  governingBodyId: string;
  jurisdictionId: string;
  isActive: boolean;
  termStart: string | null;
  termEnd: string | null;
  metadata: Record<string, unknown>;
}

export interface JudgeBatchResult {
  inserted: number;
  updated: number;
  failed: number;
}

function buildJudgeRecord(input: JudgeInput): Record<string, unknown> {
  return {
    full_name: input.fullName,
    first_name: input.firstName,
    last_name: input.lastName,
    role_title: "Federal Judge",
    governing_body_id: input.governingBodyId,
    jurisdiction_id: input.jurisdictionId,
    is_active: input.isActive,
    is_verified: false,
    term_start: input.termStart,
    term_end: input.termEnd,
    source_ids: { courtlistener_person_id: input.courtlistenerPersonId },
    metadata: input.metadata,
  };
}

export async function upsertJudgesBatch(
  db: Db,
  inputs: JudgeInput[],
): Promise<JudgeBatchResult> {
  const out: JudgeBatchResult = { inserted: 0, updated: 0, failed: 0 };
  if (inputs.length === 0) return out;

  // Client-side dedupe by personId (same judge can hold multiple positions
  // at the same court — the legacy loop skipped dupes via a seen-set).
  const byKey = new Map<string, JudgeInput>();
  for (const input of inputs) byKey.set(input.courtlistenerPersonId, input);
  const deduped = [...byKey.values()];
  const ids = deduped.map((i) => i.courtlistenerPersonId);

  // Lookup existing via external_source_refs
  const existingMap = new Map<string, string>();
  for (let i = 0; i < ids.length; i += LOOKUP_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + LOOKUP_CHUNK_SIZE);
    const { data, error } = await db
      .from("external_source_refs")
      .select("entity_id, external_id")
      .eq("source", "courtlistener")
      .eq("entity_type", "official")
      .in("external_id", chunk);
    if (error) {
      console.error(`    courtlistener writer: judge lookup ${i}-${i + chunk.length}: ${error.message}`);
      continue;
    }
    for (const r of (data ?? []) as Array<{ entity_id: string; external_id: string }>) {
      existingMap.set(r.external_id, r.entity_id);
    }
  }

  const toUpdate: Array<{ id: string; input: JudgeInput }> = [];
  const toInsert: JudgeInput[] = [];
  for (const input of deduped) {
    const existingId = existingMap.get(input.courtlistenerPersonId);
    if (existingId) toUpdate.push({ id: existingId, input });
    else toInsert.push(input);
  }

  const insertedIds: Array<string | null> = [];

  // ── Updates: full-row upsert on id (partial records violate NOT NULLs via
  // the INSERT clause of ON CONFLICT DO UPDATE, even when the row exists).
  if (toUpdate.length > 0) {
    for (let i = 0; i < toUpdate.length; i += CHUNK_SIZE) {
      const chunk = toUpdate.slice(i, i + CHUNK_SIZE);
      const records = chunk.map(({ id, input }) => ({ id, ...buildJudgeRecord(input) }));
      const { error } = await db
        .from("officials")
        .upsert(records, { onConflict: "id" });
      if (error) {
        console.error(`    courtlistener writer: judge update ${i}-${i + chunk.length}: ${error.message}`);
        out.failed += chunk.length;
      } else {
        out.updated += chunk.length;
      }
    }
  }

  // ── Inserts + source_refs
  if (toInsert.length > 0) {
    for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
      const chunk = toInsert.slice(i, i + CHUNK_SIZE);
      const records = chunk.map(buildJudgeRecord);
      const { data, error } = await db
        .from("officials")
        .insert(records)
        .select("id");
      if (error || !data) {
        console.error(`    courtlistener writer: judge insert ${i}-${i + chunk.length}: ${error?.message}`);
        out.failed += chunk.length;
        for (let k = 0; k < chunk.length; k++) insertedIds.push(null);
        continue;
      }
      for (const row of data as Array<{ id: string }>) insertedIds.push(row.id);
      out.inserted += data.length;
    }

    const refRecords = toInsert
      .map((input, idx) => {
        const entityId = insertedIds[idx];
        if (!entityId) return null;
        return {
          source: "courtlistener",
          external_id: input.courtlistenerPersonId,
          entity_type: "official",
          entity_id: entityId,
          metadata: { full_name: input.fullName },
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    for (let i = 0; i < refRecords.length; i += CHUNK_SIZE) {
      const chunk = refRecords.slice(i, i + CHUNK_SIZE);
      const { error } = await db
        .from("external_source_refs")
        .upsert(chunk, { onConflict: "source,external_id", ignoreDuplicates: true });
      if (error) {
        console.error(`    courtlistener writer: judge source_refs ${i}-${i + chunk.length}: ${error.message}`);
      }
    }
  }

  // FIX-404: refresh primary_source on judges whose xsr was just written
  // (insert path) or whose row was rewritten (update path).
  const refreshedIds = [
    ...insertedIds.filter((id): id is string => Boolean(id)),
    ...toUpdate.map((u) => u.id),
  ];
  if (refreshedIds.length > 0) {
    await refreshPrimarySourceForEntities(db, "official", refreshedIds);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Court opinions
// ---------------------------------------------------------------------------

export interface OpinionInput {
  clusterId: string;
  caseName: string;
  dateFiled: string | null;
  courtId: string;
  opinionUrl: string;
  syllabus: string;
  scdbId: string | null;
  jurisdictionId: string;
}

export interface OpinionBatchResult {
  inserted: number;
  updated: number;
  failed: number;
}

function buildOpinionProposalRecord(input: OpinionInput): Record<string, unknown> {
  return {
    title: (input.caseName || `Opinion ${input.clusterId}`).slice(0, 500),
    type: "other",
    status: "enacted",
    jurisdiction_id: input.jurisdictionId,
    introduced_at: input.dateFiled,
    last_action_at: input.dateFiled,
    external_url: input.opinionUrl,
    full_text_url: input.opinionUrl,
    metadata: {
      court: input.courtId,
      source: "courtlistener",
      syllabus: input.syllabus.slice(0, 300),
      ...(input.scdbId ? { scdb_id: input.scdbId } : {}),
    },
  };
}

function buildCaseDetailsRecord(input: OpinionInput, proposalId: string): Record<string, unknown> {
  return {
    proposal_id: proposalId,
    docket_number: `CL-${input.clusterId}`,
    court_name: COURT_FULL_NAMES[input.courtId] ?? input.courtId,
    case_name: input.caseName || null,
    filed_at: input.dateFiled,
    courtlistener_id: input.clusterId,
  };
}

export async function upsertOpinionsBatch(
  db: Db,
  inputs: OpinionInput[],
): Promise<OpinionBatchResult> {
  const out: OpinionBatchResult = { inserted: 0, updated: 0, failed: 0 };
  if (inputs.length === 0) return out;

  // Client-side dedupe by clusterId
  const byKey = new Map<string, OpinionInput>();
  for (const input of inputs) byKey.set(input.clusterId, input);
  const deduped = [...byKey.values()];
  const ids = deduped.map((i) => i.clusterId);

  // Lookup existing via external_source_refs
  const existingMap = new Map<string, string>();
  for (let i = 0; i < ids.length; i += LOOKUP_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + LOOKUP_CHUNK_SIZE);
    const { data, error } = await db
      .from("external_source_refs")
      .select("entity_id, external_id")
      .eq("source", "courtlistener")
      .eq("entity_type", "proposal")
      .in("external_id", chunk);
    if (error) {
      console.error(`    courtlistener writer: opinion lookup ${i}-${i + chunk.length}: ${error.message}`);
      continue;
    }
    for (const r of (data ?? []) as Array<{ entity_id: string; external_id: string }>) {
      existingMap.set(r.external_id, r.entity_id);
    }
  }

  const toUpdate: Array<{ id: string; input: OpinionInput }> = [];
  const toInsert: OpinionInput[] = [];
  for (const input of deduped) {
    const existingId = existingMap.get(input.clusterId);
    if (existingId) toUpdate.push({ id: existingId, input });
    else toInsert.push(input);
  }

  const insertedIds: Array<string | null> = [];

  // ── Updates (proposal + case_details)
  if (toUpdate.length > 0) {
    for (let i = 0; i < toUpdate.length; i += CHUNK_SIZE) {
      const chunk = toUpdate.slice(i, i + CHUNK_SIZE);
      const proposalRecords = chunk.map(({ id, input }) => ({
        id,
        ...buildOpinionProposalRecord(input),
      }));
      const { error } = await db
        .from("proposals")
        .upsert(proposalRecords, { onConflict: "id" });
      if (error) {
        console.error(`    courtlistener writer: opinion update ${i}-${i + chunk.length}: ${error.message}`);
        out.failed += chunk.length;
        continue;
      }
      out.updated += chunk.length;
    }

    // Also refresh case_details (onConflict on proposal_id PK)
    const caseRecords = toUpdate.map(({ id, input }) => buildCaseDetailsRecord(input, id));
    for (let i = 0; i < caseRecords.length; i += CHUNK_SIZE) {
      const chunk = caseRecords.slice(i, i + CHUNK_SIZE);
      const { error } = await db
        .from("case_details")
        .upsert(chunk, { onConflict: "proposal_id" });
      if (error) {
        console.error(`    courtlistener writer: case_details update ${i}-${i + chunk.length}: ${error.message}`);
      }
    }
  }

  // ── Inserts (proposals → case_details → source_refs)
  if (toInsert.length > 0) {
    for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
      const chunk = toInsert.slice(i, i + CHUNK_SIZE);
      const records = chunk.map(buildOpinionProposalRecord);
      const { data, error } = await db
        .from("proposals")
        .insert(records)
        .select("id");
      if (error || !data) {
        console.error(`    courtlistener writer: proposal insert ${i}-${i + chunk.length}: ${error?.message}`);
        out.failed += chunk.length;
        for (let k = 0; k < chunk.length; k++) insertedIds.push(null);
        continue;
      }
      for (const row of data as Array<{ id: string }>) insertedIds.push(row.id);
      out.inserted += data.length;
    }

    // case_details rows
    const caseRecords = toInsert
      .map((input, idx) => {
        const proposalId = insertedIds[idx];
        if (!proposalId) return null;
        return buildCaseDetailsRecord(input, proposalId);
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    for (let i = 0; i < caseRecords.length; i += CHUNK_SIZE) {
      const chunk = caseRecords.slice(i, i + CHUNK_SIZE);
      const { error } = await db
        .from("case_details")
        .upsert(chunk, { onConflict: "proposal_id" });
      if (error) {
        console.error(`    courtlistener writer: case_details insert ${i}-${i + chunk.length}: ${error.message}`);
      }
    }

    // external_source_refs
    const refRecords = toInsert
      .map((input, idx) => {
        const proposalId = insertedIds[idx];
        if (!proposalId) return null;
        return {
          source: "courtlistener",
          external_id: input.clusterId,
          entity_type: "proposal",
          entity_id: proposalId,
          source_url: input.opinionUrl,
          metadata: { court_id: input.courtId },
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    for (let i = 0; i < refRecords.length; i += CHUNK_SIZE) {
      const chunk = refRecords.slice(i, i + CHUNK_SIZE);
      const { error } = await db
        .from("external_source_refs")
        .upsert(chunk, { onConflict: "source,external_id", ignoreDuplicates: true });
      if (error) {
        console.error(`    courtlistener writer: opinion source_refs ${i}-${i + chunk.length}: ${error.message}`);
      }
    }
  }

  // FIX-404: refresh primary_source on opinions whose xsr was just written
  // (insert path) or whose proposal row was rewritten (update path).
  const refreshedIds = [
    ...insertedIds.filter((id): id is string => Boolean(id)),
    ...toUpdate.map((u) => u.id),
  ];
  if (refreshedIds.length > 0) {
    await refreshPrimarySourceForEntities(db, "proposal", refreshedIds);
  }

  return out;
}
