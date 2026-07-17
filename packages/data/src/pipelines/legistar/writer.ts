/**
 * Legistar writer — post-cutover, batched writes against public.
 *
 * Tables written per metro:
 *   public.governing_bodies        bodies (municipal councils + committees)
 *   public.officials               council members (persons)
 *   public.proposals               city matters (type from MatterTypeName)
 *   public.bill_details            one per matter (chamber='council')
 *   public.meetings                events
 *   public.agenda_items            event items (one per matter discussed)
 *   public.votes                   roll-call votes on agenda items
 *   public.external_source_refs    dedup primary for every entity above
 *                                  (source = `legistar:${client}:${type}`)
 *
 * Pre-cutover this wrote through shadowClient() to shadow.*, which was
 * dropped at promotion. Every dedup path now goes through
 * external_source_refs (UNIQUE(source, external_id)) instead of
 * per-row SELECT → INSERT/UPDATE; one page of matters (200 rows) used to
 * cost ~800 round-trips, now it's 4.
 *
 * Legistar's API is the dominant runtime cost (per-event eventitem +
 * vote fetches are sequential), but batching the DB side cuts the fixed
 * per-event overhead from ~N×4 round-trips to ~5.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { createAdminClient } from "@civitics/db";
import { refreshPrimarySourceForEntities, rowsOrThrow } from "@civitics/db";
import {
  bodyToGoverningBodyRow,
  personToOfficialRow,
  matterToProposalRow,
  matterToBillDetailsRow,
  eventToMeetingRow,
  eventItemToAgendaItemRow,
  legistarVoteToRow,
} from "./mappers";
import type {
  LegistarBody,
  LegistarPerson,
  LegistarMatter,
  LegistarEvent,
  LegistarEventItem,
  LegistarVote,
  MetroConfig,
} from "./types";

// Supabase-generated types treat `metadata` as `Json` (recursive), which
// mismatches the mapper outputs' `object` / `Record<string, unknown>`. The
// rest of the codebase opts out of strict client typing in pipeline writers;
// follow the same pattern here to avoid cast-every-insert noise.
type Db = any;

const CHUNK_SIZE = 500;
const LOOKUP_CHUNK_SIZE = 200;

// ---------------------------------------------------------------------------
// External-source-refs helpers
// ---------------------------------------------------------------------------

interface RefLookupResult {
  /** Map from external_id → entity_id for refs that already exist. */
  existing: Map<string, string>;
}

async function lookupRefs(
  db: Db,
  source: string,
  entityType: string,
  externalIds: string[],
): Promise<RefLookupResult> {
  const existing = new Map<string, string>();
  if (externalIds.length === 0) return { existing };

  for (let i = 0; i < externalIds.length; i += LOOKUP_CHUNK_SIZE) {
    const chunk = externalIds.slice(i, i + LOOKUP_CHUNK_SIZE);
    // FIX-545: this fed the insert-vs-reuse idempotency map; log-and-continue
    // on a chunk error meant already-bound items looked new and re-inserted.
    const rows = rowsOrThrow(
      await db
        .from("external_source_refs")
        .select("entity_id, external_id")
        .eq("source", source)
        .eq("entity_type", entityType)
        .in("external_id", chunk),
      `legistar ref lookup [${source}/${entityType}]`,
    ) as Array<{ entity_id: string; external_id: string }>;
    for (const r of rows) {
      existing.set(r.external_id, r.entity_id);
    }
  }

  return { existing };
}

interface RefRecord {
  source: string;
  external_id: string;
  entity_type: string;
  entity_id: string;
  metadata?: Record<string, unknown>;
}

async function upsertRefs(db: Db, records: RefRecord[]): Promise<void> {
  if (records.length === 0) return;
  const withTs = records.map((r) => ({
    ...r,
    last_seen_at: new Date().toISOString(),
  }));
  for (let i = 0; i < withTs.length; i += CHUNK_SIZE) {
    const chunk = withTs.slice(i, i + CHUNK_SIZE);
    const { error } = await db
      .from("external_source_refs")
      .upsert(chunk, { onConflict: "source,external_id", ignoreDuplicates: true });
    if (error) {
      console.error(`    legistar writer: ref upsert ${i}-${i + chunk.length}: ${error.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

export interface BodyBatchResult {
  /** LegistarBodyId → governing_bodies.id for every successfully upserted body. */
  bodyIdMap: Map<number, string>;
  inserted: number;
  failed: number;
}

export async function upsertBodiesBatch(
  db: Db,
  bodies: LegistarBody[],
  config: MetroConfig,
): Promise<BodyBatchResult> {
  const out: BodyBatchResult = {
    bodyIdMap: new Map(),
    inserted: 0,
    failed: 0,
  };
  if (bodies.length === 0) return out;

  const sourceKey = `${config.source}:body`;
  const externalIds = bodies.map((b) => String(b.BodyId));
  const { existing } = await lookupRefs(db, sourceKey, "governing_body", externalIds);

  for (const b of bodies) {
    const id = existing.get(String(b.BodyId));
    if (id) out.bodyIdMap.set(b.BodyId, id);
  }

  const toInsert = bodies.filter((b) => !existing.has(String(b.BodyId)));
  if (toInsert.length === 0) return out;

  // Insert new bodies (chunked), collect returned IDs
  const insertedIds: Array<string | null> = [];
  for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
    const chunk = toInsert.slice(i, i + CHUNK_SIZE);
    const records = chunk.map((b) => bodyToGoverningBodyRow(b, config.jurisdictionId));
    const { data, error } = await db
      .from("governing_bodies")
      .insert(records)
      .select("id");
    if (error || !data) {
      console.error(`    legistar writer: governing_bodies insert ${i}-${i + chunk.length}: ${error?.message}`);
      out.failed += chunk.length;
      for (let k = 0; k < chunk.length; k++) insertedIds.push(null);
      continue;
    }
    for (const row of data as Array<{ id: string }>) insertedIds.push(row.id);
    out.inserted += data.length;
  }

  // Build refs + map
  const refs: RefRecord[] = [];
  const newlyBoundIds: string[] = [];
  for (let i = 0; i < toInsert.length; i++) {
    const newId = insertedIds[i];
    if (!newId) continue;
    out.bodyIdMap.set(toInsert[i].BodyId, newId);
    newlyBoundIds.push(newId);
    refs.push({
      source: sourceKey,
      external_id: String(toInsert[i].BodyId),
      entity_type: "governing_body",
      entity_id: newId,
      metadata: {
        body_name: toInsert[i].BodyName,
        body_type: toInsert[i].BodyTypeName,
      },
    });
  }
  await upsertRefs(db, refs);

  // FIX-404: refresh primary_source on newly-bound governing_bodies. Existing
  // matches don't touch xsr (ignoreDuplicates: true) so they don't need refresh.
  if (newlyBoundIds.length > 0) {
    await refreshPrimarySourceForEntities(db, "governing_body", newlyBoundIds);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Persons
// ---------------------------------------------------------------------------

export interface PersonBatchResult {
  personIdMap: Map<number, string>;
  inserted: number;
  failed: number;
}

/**
 * @param councilBodyId    UUID of the metro's primary council body (FIX-471).
 *                         Every person is keyed here, not to an arbitrary body.
 * @param currentPersonIds Legistar PersonIds who currently sit on the council,
 *                         derived from OfficeRecords. is_active mirrors membership.
 */
export async function upsertPersonsBatch(
  db: Db,
  persons: LegistarPerson[],
  config: MetroConfig,
  councilBodyId: string,
  currentPersonIds: Set<number>,
): Promise<PersonBatchResult & { reactivated: number; deactivated: number; rekeyed: number }> {
  const out = {
    personIdMap: new Map<number, string>(),
    inserted: 0,
    failed: 0,
    reactivated: 0,
    deactivated: 0,
    rekeyed: 0,
  };
  if (persons.length === 0) return out;

  const sourceKey = `${config.source}:person`;
  const externalIds = persons.map((p) => String(p.PersonId));
  const { existing } = await lookupRefs(db, sourceKey, "official", externalIds);

  for (const p of persons) {
    const id = existing.get(String(p.PersonId));
    if (id) out.personIdMap.set(p.PersonId, id);
  }

  // ── Existing officials: re-key onto the council body + refresh is_active from
  // current membership (FIX-471). This is the self-healing backfill — a re-run
  // corrects rows the old writer parked on the wrong body / flagged active.
  const currentExistingIds: string[] = [];
  const formerExistingIds: string[] = [];
  for (const p of persons) {
    const officialId = existing.get(String(p.PersonId));
    if (!officialId) continue;
    if (currentPersonIds.has(p.PersonId)) currentExistingIds.push(officialId);
    else formerExistingIds.push(officialId);
  }
  const applyUpdate = async (ids: string[], isActive: boolean) => {
    for (let i = 0; i < ids.length; i += LOOKUP_CHUNK_SIZE) {
      const chunk = ids.slice(i, i + LOOKUP_CHUNK_SIZE);
      const { error } = await db
        .from("officials")
        .update({ governing_body_id: councilBodyId, is_active: isActive })
        .in("id", chunk);
      if (error) {
        console.error(`    legistar writer: officials re-key (${isActive ? "current" : "former"}) ${i}-${i + chunk.length}: ${error.message}`);
      } else {
        out.rekeyed += chunk.length;
        if (isActive) out.reactivated += chunk.length;
        else out.deactivated += chunk.length;
      }
    }
  };
  await applyUpdate(currentExistingIds, true);
  await applyUpdate(formerExistingIds, false);

  const toInsert = persons.filter((p) => !existing.has(String(p.PersonId)));
  if (toInsert.length === 0) return out;

  const insertedIds: Array<string | null> = [];
  for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
    const chunk = toInsert.slice(i, i + CHUNK_SIZE);
    const records = chunk.map((p) =>
      personToOfficialRow(
        p, config.source, councilBodyId, config.jurisdictionId,
        currentPersonIds.has(p.PersonId),
      ),
    );
    const { data, error } = await db
      .from("officials")
      .insert(records)
      .select("id");
    if (error || !data) {
      console.error(`    legistar writer: officials insert ${i}-${i + chunk.length}: ${error?.message}`);
      out.failed += chunk.length;
      for (let k = 0; k < chunk.length; k++) insertedIds.push(null);
      continue;
    }
    for (const row of data as Array<{ id: string }>) insertedIds.push(row.id);
    out.inserted += data.length;
  }

  const refs: RefRecord[] = [];
  const newlyBoundIds: string[] = [];
  for (let i = 0; i < toInsert.length; i++) {
    const newId = insertedIds[i];
    if (!newId) continue;
    out.personIdMap.set(toInsert[i].PersonId, newId);
    newlyBoundIds.push(newId);
    refs.push({
      source: sourceKey,
      external_id: String(toInsert[i].PersonId),
      entity_type: "official",
      entity_id: newId,
      metadata: { full_name: toInsert[i].PersonFullName },
    });
  }
  await upsertRefs(db, refs);

  // FIX-404: refresh primary_source on newly-bound officials. Existing
  // matches don't touch xsr (ignoreDuplicates: true) so they don't need refresh.
  if (newlyBoundIds.length > 0) {
    await refreshPrimarySourceForEntities(db, "official", newlyBoundIds);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Council-body reconcile (FIX-471)
// ---------------------------------------------------------------------------

/**
 * After persons are re-keyed onto the metro's real council body, make sure the
 * governing_bodies rows reflect reality:
 *   1. The council body is typed `municipal_council` and active.
 *   2. Any OTHER Legistar-sourced `municipal_council` body in the same
 *      jurisdiction — the mis-classified agenda/addendum variants the old
 *      classifier promoted (e.g. Austin's "City Council Addendum Agenda") — is
 *      demoted to `other` and deactivated. Not hard-deleted: history stays,
 *      it just stops presenting as a council roster.
 */
export async function reconcileCouncilBody(
  db: Db,
  jurisdictionId: string,
  councilBodyId: string,
): Promise<{ demoted: number }> {
  const { error: promoteErr } = await db
    .from("governing_bodies")
    .update({ type: "municipal_council", is_active: true })
    .eq("id", councilBodyId);
  if (promoteErr) {
    console.error(`    legistar writer: council promote ${councilBodyId}: ${promoteErr.message}`);
  }

  const { data, error: demoteErr } = await db
    .from("governing_bodies")
    .update({ type: "other", is_active: false })
    .eq("jurisdiction_id", jurisdictionId)
    .eq("type", "municipal_council")
    .neq("id", councilBodyId)
    .not("metadata->legistar_body_id", "is", null)
    .select("id");
  if (demoteErr) {
    console.error(`    legistar writer: council demote (${jurisdictionId}): ${demoteErr.message}`);
    return { demoted: 0 };
  }
  return { demoted: (data as Array<{ id: string }> | null)?.length ?? 0 };
}

// ---------------------------------------------------------------------------
// Matters (the big one)
// ---------------------------------------------------------------------------

export interface MatterBatchResult {
  matterIdMap: Map<number, string>;
  inserted: number;
  updated: number;
  failed: number;
}

export async function upsertMattersBatch(
  db: Db,
  matters: LegistarMatter[],
  config: MetroConfig,
  bodyIdMap: Map<number, string>,
): Promise<MatterBatchResult> {
  const out: MatterBatchResult = {
    matterIdMap: new Map(),
    inserted: 0,
    updated: 0,
    failed: 0,
  };
  if (matters.length === 0) return out;

  // Filter out matters with no displayable title — same behaviour as the
  // per-row legacy path. Unfiltered garbage matters don't land.
  const filtered = matters.filter(
    (m) => m.MatterTitle || m.MatterName || m.MatterFile,
  );

  const sourceKey = `${config.source}:matter`;
  const externalIds = filtered.map((m) => String(m.MatterId));
  const { existing } = await lookupRefs(db, sourceKey, "proposal", externalIds);

  const toUpdate: Array<{ id: string; matter: LegistarMatter }> = [];
  const toInsert: LegistarMatter[] = [];
  for (const m of filtered) {
    const existingId = existing.get(String(m.MatterId));
    if (existingId) {
      out.matterIdMap.set(m.MatterId, existingId);
      toUpdate.push({ id: existingId, matter: m });
    } else {
      toInsert.push(m);
    }
  }

  // ── Updates: refresh the whole row (ON CONFLICT DO UPDATE validates the
  // INSERT clause first, so partial records fail NOT NULL even when they'd
  // route to UPDATE). Mapper output includes title/type/etc. unchanged.
  if (toUpdate.length > 0) {
    for (let i = 0; i < toUpdate.length; i += CHUNK_SIZE) {
      const chunk = toUpdate.slice(i, i + CHUNK_SIZE);
      const records = chunk.map(({ id, matter }) => {
        const governingBodyId = matter.MatterBodyId
          ? bodyIdMap.get(matter.MatterBodyId) ?? null
          : null;
        const row = matterToProposalRow(
          matter,
          config.jurisdictionId,
          governingBodyId,
          config.client,
        );
        return { id, ...row };
      });
      const { error } = await db
        .from("proposals")
        .upsert(records, { onConflict: "id" });
      if (error) {
        console.error(`    legistar writer: proposal update ${i}-${i + chunk.length}: ${error.message}`);
        out.failed += chunk.length;
      } else {
        out.updated += chunk.length;
      }
    }
  }

  // ── Inserts: proposals → bill_details → external_source_refs ────────────
  const insertedIds: Array<string | null> = [];
  if (toInsert.length > 0) {
    for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
      const chunk = toInsert.slice(i, i + CHUNK_SIZE);
      const records = chunk.map((m) => {
        const governingBodyId = m.MatterBodyId
          ? bodyIdMap.get(m.MatterBodyId) ?? null
          : null;
        return matterToProposalRow(
          m,
          config.jurisdictionId,
          governingBodyId,
          config.client,
        );
      });
      const { data, error } = await db
        .from("proposals")
        .insert(records)
        .select("id");
      if (error || !data) {
        console.error(`    legistar writer: proposal insert ${i}-${i + chunk.length}: ${error?.message}`);
        out.failed += chunk.length;
        for (let k = 0; k < chunk.length; k++) insertedIds.push(null);
        continue;
      }
      for (const row of data as Array<{ id: string }>) insertedIds.push(row.id);
      out.inserted += data.length;
    }

    // bill_details — compound unique on (jurisdiction_id, session, bill_number),
    // ignoreDuplicates because cities reuse file numbers across years / cycles.
    const billDetailRecords = toInsert
      .map((m, idx) => {
        const proposalId = insertedIds[idx];
        if (!proposalId) return null;
        return matterToBillDetailsRow(m, proposalId, config.jurisdictionId);
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    for (let i = 0; i < billDetailRecords.length; i += CHUNK_SIZE) {
      const chunk = billDetailRecords.slice(i, i + CHUNK_SIZE);
      const { error } = await db
        .from("bill_details")
        .upsert(chunk, {
          onConflict: "jurisdiction_id,session,bill_number",
          ignoreDuplicates: true,
        });
      if (error) {
        console.error(`    legistar writer: bill_details ${i}-${i + chunk.length}: ${error.message}`);
      }
    }

    // external_source_refs
    const refs: RefRecord[] = [];
    for (let i = 0; i < toInsert.length; i++) {
      const newId = insertedIds[i];
      if (!newId) continue;
      out.matterIdMap.set(toInsert[i].MatterId, newId);
      refs.push({
        source: sourceKey,
        external_id: String(toInsert[i].MatterId),
        entity_type: "proposal",
        entity_id: newId,
        metadata: {
          matter_file: toInsert[i].MatterFile,
          matter_type: toInsert[i].MatterTypeName,
        },
      });
    }
    await upsertRefs(db, refs);
  }

  // FIX-404: refresh primary_source on matters whose xsr was just written
  // (insert path) or whose proposal row was rewritten (update path). Mirrors
  // the canonical congress/bills.ts pattern.
  const refreshedIds = [
    ...insertedIds.filter((id): id is string => Boolean(id)),
    ...toUpdate.map((u) => u.id),
  ];
  if (refreshedIds.length > 0) {
    await refreshPrimarySourceForEntities(db, "proposal", refreshedIds);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface EventBatchResult {
  eventIdMap: Map<number, string>;
  inserted: number;
  failed: number;
}

export async function upsertEventsBatch(
  db: Db,
  events: LegistarEvent[],
  config: MetroConfig,
  bodyIdMap: Map<number, string>,
): Promise<EventBatchResult> {
  const out: EventBatchResult = {
    eventIdMap: new Map(),
    inserted: 0,
    failed: 0,
  };
  if (events.length === 0) return out;

  // Filter to events whose body we know about.
  const withBody = events.filter((e) => bodyIdMap.has(e.EventBodyId));

  const sourceKey = `${config.source}:event`;
  const externalIds = withBody.map((e) => String(e.EventId));
  const { existing } = await lookupRefs(db, sourceKey, "meeting", externalIds);

  for (const e of withBody) {
    const id = existing.get(String(e.EventId));
    if (id) out.eventIdMap.set(e.EventId, id);
  }

  const toInsert = withBody.filter((e) => !existing.has(String(e.EventId)));
  if (toInsert.length === 0) return out;

  const insertedIds: Array<string | null> = [];
  for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
    const chunk = toInsert.slice(i, i + CHUNK_SIZE);
    const records = chunk.map((e) => {
      const bodyId = bodyIdMap.get(e.EventBodyId)!;
      return eventToMeetingRow(e, bodyId, config.client);
    });
    const { data, error } = await db
      .from("meetings")
      .insert(records)
      .select("id");
    if (error || !data) {
      console.error(`    legistar writer: meetings insert ${i}-${i + chunk.length}: ${error?.message}`);
      out.failed += chunk.length;
      for (let k = 0; k < chunk.length; k++) insertedIds.push(null);
      continue;
    }
    for (const row of data as Array<{ id: string }>) insertedIds.push(row.id);
    out.inserted += data.length;
  }

  const refs: RefRecord[] = [];
  for (let i = 0; i < toInsert.length; i++) {
    const newId = insertedIds[i];
    if (!newId) continue;
    out.eventIdMap.set(toInsert[i].EventId, newId);
    refs.push({
      source: sourceKey,
      external_id: String(toInsert[i].EventId),
      entity_type: "meeting",
      entity_id: newId,
      metadata: {
        event_date: toInsert[i].EventDate,
        body_name: toInsert[i].EventBodyName,
      },
    });
  }
  await upsertRefs(db, refs);

  return out;
}

// ---------------------------------------------------------------------------
// Agenda items (per event — batched within one event)
// ---------------------------------------------------------------------------

export interface AgendaItemBatchResult {
  /** EventItemId → agenda_items.id for successful upserts. */
  eventItemIdMap: Map<number, string>;
  inserted: number;
  failed: number;
}

export async function upsertEventItemsBatch(
  db: Db,
  items: LegistarEventItem[],
  meetingId: string,
  matterIdMap: Map<number, string>,
  config: MetroConfig,
): Promise<AgendaItemBatchResult> {
  const out: AgendaItemBatchResult = {
    eventItemIdMap: new Map(),
    inserted: 0,
    failed: 0,
  };
  if (items.length === 0) return out;

  // Sort by sequence to respect unique(meeting_id, sequence).
  const sorted = [...items].sort(
    (a, b) => (a.EventItemAgendaSequence ?? 999) - (b.EventItemAgendaSequence ?? 999),
  );

  const sourceKey = `${config.source}:item`;
  const externalIds = sorted.map((i) => String(i.EventItemId));
  const { existing } = await lookupRefs(db, sourceKey, "agenda_item", externalIds);

  for (const item of sorted) {
    const id = existing.get(String(item.EventItemId));
    if (id) out.eventItemIdMap.set(item.EventItemId, id);
  }

  const toInsert = sorted.filter((i) => !existing.has(String(i.EventItemId)));
  if (toInsert.length === 0) return out;

  // Resolve sequence collisions client-side — Legistar occasionally emits
  // duplicates within a meeting, which fails the UNIQUE(meeting_id, sequence)
  // constraint mid-batch with "cannot affect row a second time".
  const usedSeqs = new Set<number>();
  // Seed with existing sequences to avoid colliding with rows from a prior
  // partial run. For small volumes (~20-50 items per meeting) one SELECT is
  // fine; keep it per-batch, not per-row.
  const existingItems = rowsOrThrow(
    await db
      .from("agenda_items")
      .select("sequence")
      .eq("meeting_id", meetingId),
    "legistar agenda-item sequence preload",
  ) as Array<{ sequence: number }>;
  for (const r of existingItems) {
    usedSeqs.add(r.sequence);
  }

  const records = toInsert.map((item, idx) => {
    const proposalId = item.EventItemMatterId
      ? matterIdMap.get(item.EventItemMatterId) ?? null
      : null;
    let seq = item.EventItemAgendaSequence ?? item.EventItemMinutesSequence ?? idx;
    while (usedSeqs.has(seq)) seq++;
    usedSeqs.add(seq);
    return {
      ...eventItemToAgendaItemRow(item, meetingId, proposalId, config.client),
      sequence: seq,
    };
  });

  const insertedIds: Array<string | null> = [];
  for (let i = 0; i < records.length; i += CHUNK_SIZE) {
    const chunk = records.slice(i, i + CHUNK_SIZE);
    const { data, error } = await db
      .from("agenda_items")
      .insert(chunk)
      .select("id");
    if (error || !data) {
      console.error(`    legistar writer: agenda_items insert ${i}-${i + chunk.length}: ${error?.message}`);
      out.failed += chunk.length;
      for (let k = 0; k < chunk.length; k++) insertedIds.push(null);
      continue;
    }
    for (const row of data as Array<{ id: string }>) insertedIds.push(row.id);
    out.inserted += data.length;
  }

  const refs: RefRecord[] = [];
  for (let i = 0; i < toInsert.length; i++) {
    const newId = insertedIds[i];
    if (!newId) continue;
    out.eventItemIdMap.set(toInsert[i].EventItemId, newId);
    refs.push({
      source: sourceKey,
      external_id: String(toInsert[i].EventItemId),
      entity_type: "agenda_item",
      entity_id: newId,
    });
  }
  await upsertRefs(db, refs);

  return out;
}

// ---------------------------------------------------------------------------
// Votes (batched upsert of one event's votes at a time)
// ---------------------------------------------------------------------------

export interface VoteBatchInput {
  legiVote: LegistarVote;
  billProposalId: string;
  officialId: string;
  votedAt: string;
  agendaItemId: string | null;
}

export async function upsertVotesBatch(
  db: Db,
  inputs: VoteBatchInput[],
  config: MetroConfig,
): Promise<{ upserted: number; failed: number }> {
  const out = { upserted: 0, failed: 0 };
  if (inputs.length === 0) return out;

  const records = inputs
    .map((input) =>
      legistarVoteToRow(
        input.legiVote,
        input.billProposalId,
        input.officialId,
        input.votedAt,
        input.agendaItemId,
        config.client,
      ),
    )
    .filter((r): r is NonNullable<typeof r> => r !== null);

  // Client-side dedupe by (roll_call_id, official_id) — Legistar can return
  // duplicate votes for the same official on the same item; ON CONFLICT would
  // reject them mid-batch.
  const merged = new Map<string, typeof records[number]>();
  for (const r of records) merged.set(`${r.roll_call_id}|${r.official_id}`, r);
  const deduped = [...merged.values()];

  for (let i = 0; i < deduped.length; i += CHUNK_SIZE) {
    const chunk = deduped.slice(i, i + CHUNK_SIZE);
    const { error } = await db
      .from("votes")
      .upsert(chunk, { onConflict: "roll_call_id,official_id" });
    if (error) {
      console.error(`    legistar writer: votes upsert ${i}-${i + chunk.length}: ${error.message}`);
      out.failed += chunk.length;
      continue;
    }
    out.upserted += chunk.length;
  }
  return out;
}
