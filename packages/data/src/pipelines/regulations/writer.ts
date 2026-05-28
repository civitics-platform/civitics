/**
 * Regulations.gov writer — post-cutover, batched writes against public.
 *
 * Tables written:
 *   public.agencies                  one row per acronym encountered (dedup on acronym UNIQUE)
 *   public.proposals                 one row per regulations.gov document (type='regulation')
 *   public.external_source_refs      (source='regulations_gov', entity_type='proposal')
 *
 * Post-promotion, `proposals` has no dedicated regulations_gov_id / source_ids
 * columns. Dedup goes through external_source_refs; all regulations-specific
 * fields (docket_id, agency_id acronym, document_type, object_id,
 * comment_period_{start,end}) live in metadata JSONB.
 *
 * Chunked upsert pattern matches FEC bulk + USASpending writers: one batched
 * lookup, partition into update vs insert buckets, then chunked upsert calls.
 */

import type { createAdminClient } from "@civitics/db";
import type { Database } from "@civitics/db";
import { agencyFullName, AGENCY_NAMES, refreshPrimarySourceForEntities } from "@civitics/db";

type Db = ReturnType<typeof createAdminClient>;
type AgencyInsert = Database["public"]["Tables"]["agencies"]["Insert"];
type ProposalInsert = Database["public"]["Tables"]["proposals"]["Insert"];
type ProposalStatus = Database["public"]["Enums"]["proposal_status"];

const CHUNK_SIZE = 500;
// `.in("external_id", list)` serialises values into the URL. Keep lookup
// chunks small so the query stays under PostgREST's URL limit.
const LOOKUP_CHUNK_SIZE = 200;

// ---------------------------------------------------------------------------
// Agency resolution — batched
// ---------------------------------------------------------------------------

export interface AgencyResolutionResult {
  /** Map from acronym → agencies.id for every successfully resolved agency. */
  byAcronym: Map<string, string>;
  inserted: number;
  /** Acronyms not in AGENCY_NAMES (typically new regulations.gov agencies). */
  unmappedAcronyms: string[];
}

export async function resolveAgencies(
  db: Db,
  acronyms: string[],
  federalId: string,
): Promise<AgencyResolutionResult> {
  const out: AgencyResolutionResult = {
    byAcronym: new Map(),
    inserted: 0,
    unmappedAcronyms: [],
  };

  const unique = [...new Set(acronyms.map((a) => a.trim()).filter(Boolean))];
  if (unique.length === 0) return out;

  // ── Step 1: batched lookup of existing agencies by acronym ───────────────
  for (let i = 0; i < unique.length; i += LOOKUP_CHUNK_SIZE) {
    const chunk = unique.slice(i, i + LOOKUP_CHUNK_SIZE);
    const { data, error } = await db
      .from("agencies")
      .select("id, acronym, name")
      .in("acronym", chunk);
    if (error) {
      console.error(`    regulations writer: agency lookup chunk ${i}-${i + chunk.length}: ${error.message}`);
      continue;
    }
    for (const row of (data ?? []) as Array<{ id: string; acronym: string | null; name: string }>) {
      if (row.acronym) out.byAcronym.set(row.acronym, row.id);
    }
  }

  // ── Step 2: batched insert for new agencies ──────────────────────────────
  const newAcronyms = unique.filter((a) => !out.byAcronym.has(a));
  out.unmappedAcronyms = newAcronyms.filter((a) => !(a.toUpperCase() in AGENCY_NAMES));

  for (let i = 0; i < newAcronyms.length; i += CHUNK_SIZE) {
    const chunk = newAcronyms.slice(i, i + CHUNK_SIZE);
    const records: AgencyInsert[] = chunk.map((acronym) => ({
      name: agencyFullName(acronym) ?? acronym,
      acronym,
      jurisdiction_id: federalId,
      agency_type: "federal",
      is_active: true,
      source_ids: { regulations_gov_agency_id: acronym },
    }));

    const { data: inserted, error } = await db
      .from("agencies")
      .upsert(records, { onConflict: "acronym" })
      .select("id, acronym");

    if (error || !inserted) {
      console.error(`    regulations writer: agency insert chunk ${i}-${i + chunk.length}: ${error?.message}`);
      continue;
    }
    for (const row of inserted as Array<{ id: string; acronym: string | null }>) {
      if (row.acronym) out.byAcronym.set(row.acronym, row.id);
    }
    out.inserted += inserted.length;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Proposal upserts — batched
// ---------------------------------------------------------------------------

export interface RegulationProposalInput {
  /** regulations.gov document id — used as external_source_refs.external_id. */
  regulationsGovId: string;
  title: string;
  status: ProposalStatus;
  /** ISO timestamp or null. */
  introducedAt: string | null;
  /** Publicly browsable regulations.gov URL. */
  externalUrl: string;
  /** Raw full-text attachment URL if available. */
  fullTextUrl: string | null;
  /** All regulations-specific fields ride in metadata. */
  metadata: {
    regulations_gov_id: string;
    agency_id: string;
    docket_id: string;
    document_type: string;
    object_id: string;
    comment_period_start: string | null;
    comment_period_end: string | null;
  };
  jurisdictionId: string;
}

export interface ProposalBatchResult {
  inserted: number;
  updated: number;
  failed: number;
}

function buildProposalInsert(input: RegulationProposalInput): ProposalInsert {
  return {
    title: input.title.slice(0, 500),
    type: "regulation",
    status: input.status,
    jurisdiction_id: input.jurisdictionId,
    external_url: input.externalUrl,
    introduced_at: input.introducedAt,
    last_action_at: input.metadata.comment_period_end ?? input.introducedAt,
    full_text_url: input.fullTextUrl,
    metadata: input.metadata,
  };
}

export async function upsertRegulationProposalsBatch(
  db: Db,
  items: RegulationProposalInput[],
): Promise<ProposalBatchResult> {
  const out: ProposalBatchResult = { inserted: 0, updated: 0, failed: 0 };
  if (items.length === 0) return out;

  // Client-side dedupe by regulations_gov_id — same "cannot affect row a
  // second time" defense we use elsewhere.
  const byKey = new Map<string, RegulationProposalInput>();
  for (const item of items) byKey.set(item.regulationsGovId, item);
  const deduped = [...byKey.values()];
  const regIds = deduped.map((i) => i.regulationsGovId);

  // ── Step 1: batched lookup of existing proposals via external_source_refs
  const existingMap = new Map<string, string>();
  for (let i = 0; i < regIds.length; i += LOOKUP_CHUNK_SIZE) {
    const chunk = regIds.slice(i, i + LOOKUP_CHUNK_SIZE);
    const { data, error } = await db
      .from("external_source_refs")
      .select("entity_id, external_id")
      .eq("source", "regulations_gov")
      .eq("entity_type", "proposal")
      .in("external_id", chunk);
    if (error) {
      console.error(`    regulations writer: lookup chunk ${i}-${i + chunk.length}: ${error.message}`);
      continue;
    }
    for (const r of (data ?? []) as Array<{ entity_id: string; external_id: string }>) {
      existingMap.set(r.external_id, r.entity_id);
    }
  }

  // ── Step 2: partition
  const toUpdate: Array<{ id: string; item: RegulationProposalInput }> = [];
  const toInsert: RegulationProposalInput[] = [];
  for (const item of deduped) {
    const existingId = existingMap.get(item.regulationsGovId);
    if (existingId) toUpdate.push({ id: existingId, item });
    else toInsert.push(item);
  }

  const insertedIds: Array<string | null> = [];

  // ── Step 3: batched update via upsert(onConflict='id')
  if (toUpdate.length > 0) {
    for (let i = 0; i < toUpdate.length; i += CHUNK_SIZE) {
      const chunk = toUpdate.slice(i, i + CHUNK_SIZE);
      const records = chunk.map(({ id, item }) => ({
        id,
        ...buildProposalInsert(item),
      }));
      const { error } = await db
        .from("proposals")
        .upsert(records, { onConflict: "id" });
      if (error) {
        console.error(`    regulations writer: update chunk ${i}-${i + chunk.length}: ${error.message}`);
        out.failed += chunk.length;
      } else {
        out.updated += chunk.length;
      }
    }
  }

  // ── Step 4: batched insert of new proposals + external_source_refs
  if (toInsert.length > 0) {
    for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
      const chunk = toInsert.slice(i, i + CHUNK_SIZE);
      const records = chunk.map(buildProposalInsert);
      const { data, error } = await db
        .from("proposals")
        .insert(records)
        .select("id");
      if (error || !data) {
        console.error(`    regulations writer: proposal insert chunk ${i}-${i + chunk.length}: ${error?.message}`);
        out.failed += chunk.length;
        for (let k = 0; k < chunk.length; k++) insertedIds.push(null);
        continue;
      }
      for (const row of data as Array<{ id: string }>) insertedIds.push(row.id);
      out.inserted += data.length;
    }

    // ── Step 5: batched insert of external_source_refs
    const refRecords = toInsert
      .map((item, idx) => {
        const proposalId = insertedIds[idx];
        if (!proposalId) return null;
        return {
          source: "regulations_gov",
          external_id: item.regulationsGovId,
          entity_type: "proposal",
          entity_id: proposalId,
          source_url: item.externalUrl,
          metadata: { docket_id: item.metadata.docket_id },
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    for (let i = 0; i < refRecords.length; i += CHUNK_SIZE) {
      const chunk = refRecords.slice(i, i + CHUNK_SIZE);
      const { error } = await db
        .from("external_source_refs")
        .upsert(chunk, {
          onConflict: "source,external_id",
          ignoreDuplicates: true,
        });
      if (error) {
        console.error(`    regulations writer: source_refs chunk ${i}-${i + chunk.length}: ${error.message}`);
      }
    }
  }

  // FIX-404: refresh primary_source on proposals whose xsr was just written
  // (insert path) or whose row was rewritten (update path).
  const refreshedIds = [
    ...insertedIds.filter((id): id is string => Boolean(id)),
    ...toUpdate.map((u) => u.id),
  ];
  if (refreshedIds.length > 0) {
    await refreshPrimarySourceForEntities(db, "proposal", refreshedIds);
  }

  return out;
}
