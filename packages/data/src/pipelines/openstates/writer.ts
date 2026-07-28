/**
 * OpenStates writer — post-cutover, batched writes against public.
 *
 * Tables written:
 *   public.governing_bodies          one per (state × chamber); small volume,
 *                                    resolved in one batched SELECT + per-miss INSERT
 *   public.officials                 state legislators; dedup via external_source_refs
 *                                    (source='openstates', entity_type='official')
 *   public.proposals                 state bills (type from mapBillType)
 *   public.bill_details              chamber + session + bill_number per proposal
 *   public.external_source_refs      (source='openstates', entity_type='proposal'|'official')
 *
 * All phases write through chunked upserts; no per-row SELECT → INSERT/UPDATE.
 * The pipeline is rate-limited by OpenStates (10 req/min for bills → 7s sleep
 * per page), so the DB side rarely matters — but batching keeps the runtime
 * free to wait on the API rather than on round-trips.
 *
 * Pre-cutover this wrote to shadow.* through `shadowClient()`; the shadow
 * schema was dropped at promotion. Dedup for officials used to go through
 * `officials.source_ids->>'openstates_id'` which works but can't be backed
 * by a unique index. Migration 20260425000100 backfills external_source_refs
 * for any existing state legislators so the new writer's lookup is
 * authoritative.
 */

import type { createAdminClient } from "@civitics/db";
import type { Database, Json } from "@civitics/db";
import { refreshPrimarySourceForEntities, rowsOrThrow } from "@civitics/db";

type Db = ReturnType<typeof createAdminClient>;
type OfficialInsert = Database["public"]["Tables"]["officials"]["Insert"];
type GovBodyInsert = Database["public"]["Tables"]["governing_bodies"]["Insert"];
type GovBodyType = Database["public"]["Enums"]["governing_body_type"];
type ProposalInsert = Database["public"]["Tables"]["proposals"]["Insert"];
type ProposalType = Database["public"]["Enums"]["proposal_type"];
type ProposalStatus = Database["public"]["Enums"]["proposal_status"];
type PartyValue = Database["public"]["Tables"]["officials"]["Row"]["party"];

const CHUNK_SIZE = 500;
// 100 keeps PostgREST URL under ~6KB even with long ocd-person/ocd-bill IDs.
// 200 was overflowing on bigger states (NH, IL, NY) — failed lookups silently
// re-inserted existing rows as orphans. (FIX-160 hardening.)
const LOOKUP_CHUNK_SIZE = 100;

// ---------------------------------------------------------------------------
// Governing bodies
// ---------------------------------------------------------------------------

export interface GovBodyKey {
  jurisdictionId: string;
  stateAbbr: string;
  stateName: string;
  type: GovBodyType;
  // FIX-548 — proper-name overrides for the insert path. Unicameral chambers
  // (DC/NE/GU/VI) carry their real names from LEGISLATURE_SHAPES so a fresh
  // seed creates "Council of the District of Columbia", never "District of
  // Columbia State Legislature". Absent → the type-derived default below.
  name?: string;
  shortName?: string;
}

/**
 * Resolve the governing_body for each (jurisdiction × legislative chamber).
 * Volume is tiny (50 states × up to 3 chamber types), so we batch the SELECT
 * once then insert any misses individually — no schema change needed.
 */
export async function resolveGoverningBodies(
  db: Db,
  keys: GovBodyKey[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (keys.length === 0) return out;

  const mapKey = (jurisdictionId: string, type: GovBodyType) =>
    `${jurisdictionId}|${type}`;

  // Batch lookup existing bodies across the requested jurisdictions
  const jurisdictionIds = [...new Set(keys.map((k) => k.jurisdictionId))];
  for (let i = 0; i < jurisdictionIds.length; i += LOOKUP_CHUNK_SIZE) {
    const chunk = jurisdictionIds.slice(i, i + LOOKUP_CHUNK_SIZE);
    const { data, error } = await db
      .from("governing_bodies")
      .select("id, jurisdiction_id, type")
      .in("jurisdiction_id", chunk);
    if (error) {
      console.error(`    openstates writer: governing_bodies lookup ${i}-${i + chunk.length}: ${error.message}`);
      continue;
    }
    for (const row of (data ?? []) as Array<{ id: string; jurisdiction_id: string; type: GovBodyType }>) {
      out.set(mapKey(row.jurisdiction_id, row.type), row.id);
    }
  }

  // Per-miss insert for any legislative body we haven't seen yet.
  const missing = keys.filter((k) => !out.has(mapKey(k.jurisdictionId, k.type)));
  for (const key of missing) {
    const chamberLabel =
      key.type === "legislature_upper" ? "Senate" :
      key.type === "legislature_lower" ? "House" :
      "Legislature";
    const row: GovBodyInsert = {
      jurisdiction_id: key.jurisdictionId,
      type: key.type,
      name: key.name ?? `${key.stateName} State ${chamberLabel}`,
      short_name: key.shortName ?? `${key.stateAbbr} ${chamberLabel}`,
      is_active: true,
    };
    const { data, error } = await db
      .from("governing_bodies")
      .insert(row)
      .select("id")
      .single();
    if (error || !data) {
      console.error(`    openstates writer: governing_body insert ${key.stateAbbr}/${key.type}: ${error?.message}`);
      continue;
    }
    out.set(mapKey(key.jurisdictionId, key.type), data.id);
  }

  // FIX-477: external_source_refs coverage for governing_bodies, so the
  // /institutions/[id] SourceBadge + attribution popover have an xsr row to
  // read. Covers BOTH paths — every gb in `out` (preexisting-row OR
  // fresh-insert) gets its row refreshed on every run (last_seen_at bump).
  // external_id is the deterministic synthetic key the FIX-477 backfill script
  // uses verbatim: gb/<jurisdiction_id>/<gb.type>. (No org id is captured for
  // these bodies — metadata is {} — and jurisdiction_id is the only stable fact
  // that is unique per gb; fips/abbr collide on the duplicate-DC-jurisdiction
  // pollution.) source_url stays null: there's no stable per-chamber openstates
  // URL and the external_id is a synthetic key — null beats a 404.
  const gbRefByGbId = new Map<string, GovBodyKey>();
  for (const key of keys) {
    const gbId = out.get(mapKey(key.jurisdictionId, key.type));
    if (gbId) gbRefByGbId.set(gbId, key);
  }
  if (gbRefByGbId.size > 0) {
    const gbRefRecords = [...gbRefByGbId.entries()].map(([gbId, key]) => ({
      source: "openstates",
      external_id: `gb/${key.jurisdictionId}/${key.type}`,
      entity_type: "governing_body",
      entity_id: gbId,
      last_seen_at: new Date().toISOString(),
      metadata: {},
    }));
    // Merge-upsert (not ignoreDuplicates) so an existing gb's last_seen_at is
    // refreshed on every run; entity_id stays the same value either way.
    const { error } = await db
      .from("external_source_refs")
      .upsert(gbRefRecords, { onConflict: "source,external_id" });
    if (error) {
      console.error(`    openstates writer: source_refs (governing_body): ${error.message}`);
    }
    await refreshPrimarySourceForEntities(db, "governing_body", [...gbRefByGbId.keys()]);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Legislators
// ---------------------------------------------------------------------------

export interface LegislatorInput {
  openstatesId: string;
  fullName: string;
  roleTitle: string;
  governingBodyId: string;
  jurisdictionId: string;
  party: PartyValue;
  districtName: string | null;
  // termStart/termEnd are optional. The bulk-CSV path omits them so existing
  // dates (set by the API pipeline) aren't clobbered with null on update.
  termStart?: string | null;
  termEnd?: string | null;
  websiteUrl: string | null;
  metadata: { org_classification: string; state: string };
}

export interface LegislatorBatchResult {
  inserted: number;
  updated: number;
  failed: number;
}

export type ExistingMetadata = Record<string, Json | undefined>;

/**
 * `existingMetadata` is supplied on the UPDATE path only (FIX-915). The upsert
 * REPLACES officials.metadata rather than merging it — PostgREST cannot express
 * a server-side jsonb merge — so any key the pipeline doesn't re-supply is
 * destroyed on contact. Incoming keys win; everything else survives. On the
 * INSERT path there is nothing to preserve, so it stays undefined.
 */
function buildOfficialInsert(
  input: LegislatorInput,
  existingMetadata?: ExistingMetadata,
): OfficialInsert {
  const insert: OfficialInsert = {
    full_name: input.fullName,
    role_title: input.roleTitle,
    governing_body_id: input.governingBodyId,
    jurisdiction_id: input.jurisdictionId,
    party: input.party,
    district_name: input.districtName,
    is_active: true,
    is_verified: false,
    website_url: input.websiteUrl,
    source_ids: { openstates_id: input.openstatesId },
    metadata: existingMetadata
      ? { ...existingMetadata, ...input.metadata }
      : input.metadata,
  };
  if (input.termStart !== undefined) insert.term_start = input.termStart;
  if (input.termEnd !== undefined) insert.term_end = input.termEnd;
  return insert;
}

export async function upsertLegislatorsBatch(
  db: Db,
  items: LegislatorInput[],
): Promise<LegislatorBatchResult> {
  const out: LegislatorBatchResult = { inserted: 0, updated: 0, failed: 0 };
  if (items.length === 0) return out;

  // Client-side dedupe by openstates_id
  const byKey = new Map<string, LegislatorInput>();
  for (const item of items) byKey.set(item.openstatesId, item);
  const deduped = [...byKey.values()];
  const ids = deduped.map((i) => i.openstatesId);

  // Lookup existing via external_source_refs. FIX-545: this feeds the
  // insert-vs-update split and the insert path is a plain .insert() — a
  // skipped lookup chunk re-inserted every legislator in it as a duplicate.
  const existingMap = new Map<string, string>();
  for (let i = 0; i < ids.length; i += LOOKUP_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + LOOKUP_CHUNK_SIZE);
    const rows = rowsOrThrow(
      await db
        .from("external_source_refs")
        .select("entity_id, external_id")
        .eq("source", "openstates")
        .eq("entity_type", "official")
        .in("external_id", chunk),
      "openstates official ref lookup",
    ) as Array<{ entity_id: string; external_id: string }>;
    for (const r of rows) {
      existingMap.set(r.external_id, r.entity_id);
    }
  }

  const toUpdate: Array<{ id: string; item: LegislatorInput }> = [];
  const toInsert: LegislatorInput[] = [];
  for (const item of deduped) {
    const existingId = existingMap.get(item.openstatesId);
    if (existingId) toUpdate.push({ id: existingId, item });
    else toInsert.push(item);
  }

  const insertedIds: Array<string | null> = [];

  // Batched update
  if (toUpdate.length > 0) {
    // FIX-915 — pre-fetch existing metadata for the update targets so the
    // upsert below merges instead of replacing. Without this, every legislator
    // upsert wrote metadata down to just {org_classification, state} and
    // destroyed `district_jurisdiction_id`, the SLD choropleth cross-link
    // derived by link_officials_to_districts(). BOTH OpenStates pipelines share
    // this writer: the daily bulk-people run repaired it afterwards via the
    // linker RPC, but the weekly API run (runOpenStatesPipeline) never called
    // the linker at all, so it landed after the repair and undid it.
    //
    // rowsOrThrow, not a swallowed error: a skipped chunk here makes every
    // existing metadata look empty and silently re-clobbers exactly the keys
    // this pass exists to preserve. Same failure shape as the FIX-545
    // summary_plain regression — fail loud.
    const existingMetadata = new Map<string, ExistingMetadata>();
    const updateIds = toUpdate.map((u) => u.id);
    for (let i = 0; i < updateIds.length; i += LOOKUP_CHUNK_SIZE) {
      const chunk = updateIds.slice(i, i + LOOKUP_CHUNK_SIZE);
      const rows = rowsOrThrow(
        await db
          .from("officials")
          .select("id, metadata")
          .in("id", chunk),
        "openstates official metadata prefetch",
      ) as Array<{ id: string; metadata: Json | null }>;
      for (const r of rows) {
        // Defensive: metadata is jsonb and could in principle hold a scalar or
        // array. Only a plain object is spreadable.
        if (r.metadata && typeof r.metadata === "object" && !Array.isArray(r.metadata)) {
          existingMetadata.set(r.id, r.metadata as ExistingMetadata);
        }
      }
    }

    for (let i = 0; i < toUpdate.length; i += CHUNK_SIZE) {
      const chunk = toUpdate.slice(i, i + CHUNK_SIZE);
      const records = chunk.map(({ id, item }) => ({
        id,
        ...buildOfficialInsert(item, existingMetadata.get(id)),
      }));
      const { error } = await db
        .from("officials")
        .upsert(records, { onConflict: "id" });
      if (error) {
        console.error(`    openstates writer: official update ${i}-${i + chunk.length}: ${error.message}`);
        out.failed += chunk.length;
      } else {
        out.updated += chunk.length;
      }
    }
  }

  // Batched insert + external_source_refs
  if (toInsert.length > 0) {
    for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
      const chunk = toInsert.slice(i, i + CHUNK_SIZE);
      // Explicit arrow, NOT the point-free `chunk.map(buildOfficialInsert)`:
      // Array.map passes (item, index), and buildOfficialInsert's second
      // parameter is now existingMetadata, so the point-free form hands it the
      // array index. TypeScript rejects that outright, which is the point —
      // the insert path must stay merge-free (there is nothing to preserve).
      const records = chunk.map((item) => buildOfficialInsert(item));
      const { data, error } = await db
        .from("officials")
        .insert(records)
        .select("id");
      if (error || !data) {
        console.error(`    openstates writer: official insert ${i}-${i + chunk.length}: ${error?.message}`);
        out.failed += chunk.length;
        for (let k = 0; k < chunk.length; k++) insertedIds.push(null);
        continue;
      }
      for (const row of data as Array<{ id: string }>) insertedIds.push(row.id);
      out.inserted += data.length;
    }

    const refRecords = toInsert
      .map((item, idx) => {
        const entityId = insertedIds[idx];
        if (!entityId) return null;
        return {
          source: "openstates",
          external_id: item.openstatesId,
          entity_type: "official",
          entity_id: entityId,
          metadata: {
            state: item.metadata.state,
            chamber: item.metadata.org_classification,
          },
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
        console.error(`    openstates writer: source_refs (official) ${i}-${i + chunk.length}: ${error.message}`);
      }
    }
  }

  // FIX-404: refresh primary_source on officials whose xsr was just written
  // (insert path) or whose row was rewritten (update path). Mirrors the
  // canonical congress/bills.ts pattern.
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
// State bills
// ---------------------------------------------------------------------------

export interface StateBillInput {
  openstatesId: string;
  title: string;
  billNumber: string;
  session: string;
  chamber: "house" | "senate" | null;
  type: ProposalType;
  status: ProposalStatus;
  jurisdictionId: string;
  introducedAt: string | null;
  lastActionAt: string | null;
  // Plain-language summary from the OpenStates abstract (FIX-435). null when
  // the state doesn't publish abstracts. Owned by source text, never AI — and
  // the writer never clobbers an existing non-null value (see update path).
  summaryPlain: string | null;
  externalUrl: string;
  metadata: {
    source: "openstates";
    openstates_id: string;
    state: string;
    latest_action: string;
  };
}

export interface StateBillBatchResult {
  inserted: number;
  updated: number;
  failed: number;
}

function buildBillProposalInsert(input: StateBillInput): ProposalInsert {
  return {
    title: input.title.slice(0, 500),
    type: input.type,
    status: input.status,
    jurisdiction_id: input.jurisdictionId,
    external_url: input.externalUrl,
    introduced_at: input.introducedAt,
    last_action_at: input.lastActionAt,
    // Insert path: nothing to clobber, take the abstract directly (null-safe).
    summary_plain: input.summaryPlain,
    metadata: input.metadata,
  };
}

export async function upsertStateBillsBatch(
  db: Db,
  items: StateBillInput[],
): Promise<StateBillBatchResult> {
  const out: StateBillBatchResult = { inserted: 0, updated: 0, failed: 0 };
  if (items.length === 0) return out;

  // Client-side dedupe
  const byKey = new Map<string, StateBillInput>();
  for (const item of items) byKey.set(item.openstatesId, item);
  const deduped = [...byKey.values()];
  const ids = deduped.map((i) => i.openstatesId);

  // Lookup existing via external_source_refs. FIX-545: same duplicate-insert
  // hazard as the legislator lookup above — fail loud.
  const existingMap = new Map<string, string>();
  for (let i = 0; i < ids.length; i += LOOKUP_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + LOOKUP_CHUNK_SIZE);
    const rows = rowsOrThrow(
      await db
        .from("external_source_refs")
        .select("entity_id, external_id")
        .eq("source", "openstates")
        .eq("entity_type", "proposal")
        .in("external_id", chunk),
      "openstates bill ref lookup",
    ) as Array<{ entity_id: string; external_id: string }>;
    for (const r of rows) {
      existingMap.set(r.external_id, r.entity_id);
    }
  }

  const toUpdate: Array<{ id: string; item: StateBillInput }> = [];
  const toInsert: StateBillInput[] = [];
  for (const item of deduped) {
    const existingId = existingMap.get(item.openstatesId);
    if (existingId) toUpdate.push({ id: existingId, item });
    else toInsert.push(item);
  }

  const insertedIds: Array<string | null> = [];

  // Updates
  if (toUpdate.length > 0) {
    // Pre-fetch current summary_plain for the update targets. The bulk upsert
    // below can't express COALESCE, so we resolve don't-clobber-non-null in
    // code: an existing non-empty summary_plain wins; otherwise the abstract
    // fills the NULL. (FIX-435 — source text owns this column.)
    // FIX-545: a skipped prefetch chunk made every existing summary look
    // NULL, so the abstract re-clobbered curated summary_plain values — the
    // exact regression FIX-435 fixed. Fail loud instead.
    const existingSummary = new Map<string, string | null>();
    const updateIds = toUpdate.map((u) => u.id);
    for (let i = 0; i < updateIds.length; i += LOOKUP_CHUNK_SIZE) {
      const chunk = updateIds.slice(i, i + LOOKUP_CHUNK_SIZE);
      const rows = rowsOrThrow(
        await db
          .from("proposals")
          .select("id, summary_plain")
          .in("id", chunk),
        "openstates summary_plain prefetch",
      ) as Array<{ id: string; summary_plain: string | null }>;
      for (const r of rows) {
        existingSummary.set(r.id, r.summary_plain);
      }
    }

    for (let i = 0; i < toUpdate.length; i += CHUNK_SIZE) {
      const chunk = toUpdate.slice(i, i + CHUNK_SIZE);
      const records = chunk.map(({ id, item }) => {
        const record = { id, ...buildBillProposalInsert(item) };
        // Don't-clobber-non-null: keep an existing non-empty summary, else fill.
        const existing = existingSummary.get(id);
        record.summary_plain =
          existing && existing.trim().length > 0 ? existing : item.summaryPlain;
        return record;
      });
      const { error } = await db
        .from("proposals")
        .upsert(records, { onConflict: "id" });
      if (error) {
        console.error(`    openstates writer: bill update ${i}-${i + chunk.length}: ${error.message}`);
        out.failed += chunk.length;
      } else {
        out.updated += chunk.length;
      }
    }
  }

  // Inserts (proposals → bill_details → external_source_refs)
  if (toInsert.length > 0) {
    for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
      const chunk = toInsert.slice(i, i + CHUNK_SIZE);
      const records = chunk.map(buildBillProposalInsert);
      const { data, error } = await db
        .from("proposals")
        .insert(records)
        .select("id");
      if (error || !data) {
        console.error(`    openstates writer: proposal insert ${i}-${i + chunk.length}: ${error?.message}`);
        out.failed += chunk.length;
        for (let k = 0; k < chunk.length; k++) insertedIds.push(null);
        continue;
      }
      for (const row of data as Array<{ id: string }>) insertedIds.push(row.id);
      out.inserted += data.length;
    }

    // bill_details (ignore duplicates — states reuse bill_number across sessions)
    const billDetailRecords = toInsert
      .map((item, idx) => {
        const proposalId = insertedIds[idx];
        if (!proposalId) return null;
        return {
          proposal_id: proposalId,
          bill_number: item.billNumber.slice(0, 100),
          chamber: item.chamber ?? undefined,
          session: item.session,
          jurisdiction_id: item.jurisdictionId,
        };
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
        console.error(`    openstates writer: bill_details ${i}-${i + chunk.length}: ${error.message}`);
      }
    }

    // external_source_refs
    const refRecords = toInsert
      .map((item, idx) => {
        const proposalId = insertedIds[idx];
        if (!proposalId) return null;
        return {
          source: "openstates",
          external_id: item.openstatesId,
          entity_type: "proposal",
          entity_id: proposalId,
          source_url: item.externalUrl,
          metadata: { state: item.metadata.state, session: item.session },
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
        console.error(`    openstates writer: source_refs (bill) ${i}-${i + chunk.length}: ${error.message}`);
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
