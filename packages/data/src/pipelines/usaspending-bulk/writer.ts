/**
 * USASpending writer — shared by the bulk archive pipeline.
 *
 * Tables written:
 *   public.financial_entities         corporation recipients (dedup via
 *                                     external_source_refs source='usaspending_recipient')
 *   public.external_source_refs       one row per recipient canonical name
 *   public.financial_relationships    one row per award (contract/grant);
 *                                     dedup via the FULL usaspending_award_id
 *                                     unique index (migration 20260424000000)
 *
 * All writes go through a direct session-pooler `pg.Client` (FIX-586) with the
 * SESSION statement_timeout raised past the 8s PostgREST role cap — the same
 * pattern lib/direct-pg-upsert.ts established for the FEC indiv stage (FIX-462).
 * Pre-FIX-586 these went through `createAdminClient().upsert()` / `.select()`
 * and died with `canceling statement due to statement timeout` on prod's large
 * financial_relationships / financial_entities tables — the 2026-06-14
 * enrichment-phase saw ~100 consecutive chunk timeouts then a fatal on the
 * recipient-ref lookup read, killing both the contracts and assistance runs.
 * The caller (index.ts flushBatch) opens one withDirectClient per file and
 * passes the connected client to both functions below.
 *
 * Recipient dedup strategy:
 *   USASpending awards do not carry a clean single external recipient key
 *   (UEI isn't in the standard award fields). The only practical handle is
 *   the recipient_name, normalised via canonicalizeEntityName. We store the
 *   canonical name in external_source_refs under source='usaspending_recipient'
 *   so multiple awards to the same recipient share one financial_entity row.
 *
 *   Why not UNIQUE(canonical_name, entity_type) directly: the FEC rewrite
 *   dropped that constraint because distinct FEC committees can normalise to
 *   the same name and must stay distinct. external_source_refs is the
 *   designed-for dedup primary and already has UNIQUE(source, external_id).
 */

import type { Client } from "pg";
import { bulkUpsert } from "../../lib/direct-pg-upsert";
import { canonicalizeEntityName } from "../fec-bulk/writer";

// Rows per financial_entities insert chunk. With the direct-pg path (no 8s role
// cap) the bound is Postgres's 65535 bind-param limit, not round-trip cost;
// 1000 keeps a wide margin (a single flush carries ≤1000 new recipients).
const ENTITY_CHUNK_SIZE = 1000;

// ---------------------------------------------------------------------------
// Recipient resolution
// ---------------------------------------------------------------------------

export interface RecipientInput {
  /** Source-cased recipient name from USASpending (pre-truncated ≤500 chars). */
  displayName: string;
}

export interface RecipientResolution {
  /** Map from canonical recipient name → financial_entities.id. */
  byCanonical: Map<string, string>;
  inserted: number;
  failed: number;
}

/**
 * Given a list of recipient display names, returns a map from canonical name
 * to the corresponding financial_entities UUID. Existing recipients are
 * looked up via external_source_refs; new ones are inserted in batch and
 * registered under source='usaspending_recipient'.
 *
 * Runs entirely on the passed direct-pg `client` (raised session timeout). The
 * `= ANY($1)` lookup has no URL-length limit, so the pre-FIX-586 100-name
 * LOOKUP_CHUNK_SIZE chunking is gone — one query resolves the whole flush.
 */
export async function resolveRecipients(
  client: Client,
  recipients: RecipientInput[],
): Promise<RecipientResolution> {
  const out: RecipientResolution = {
    byCanonical: new Map(),
    inserted: 0,
    failed: 0,
  };

  if (recipients.length === 0) return out;

  // Deduplicate the incoming recipient list by canonical name; keep the
  // first display_name we see as the canonical display.
  const canonicalToDisplay = new Map<string, string>();
  for (const r of recipients) {
    const canonical = canonicalizeEntityName(r.displayName);
    if (!canonical) continue;
    if (!canonicalToDisplay.has(canonical)) {
      canonicalToDisplay.set(canonical, r.displayName.trim().slice(0, 500));
    }
  }

  const canonicals = [...canonicalToDisplay.keys()];
  if (canonicals.length === 0) return out;

  // ── Step 1: batch-lookup existing refs in one query (no URL limit on the
  // direct path). FIX-545: a skipped/failed lookup chunk re-inserts every
  // recipient in it as a duplicate corporation row, so this MUST fail loud —
  // an exception here aborts the flush (the caller surfaces it) rather than
  // silently treating known recipients as new.
  const lookup = await client.query<{ external_id: string; entity_id: string }>(
    `SELECT external_id, entity_id
       FROM public.external_source_refs
      WHERE source = 'usaspending_recipient'
        AND entity_type = 'financial_entity'
        AND external_id = ANY($1::text[])`,
    [canonicals],
  );
  for (const row of lookup.rows) {
    out.byCanonical.set(row.external_id, row.entity_id);
  }

  // ── Step 2: determine which canonicals are new and need inserting
  const newCanonicals = canonicals.filter((c) => !out.byCanonical.has(c));
  if (newCanonicals.length === 0) return out;

  // ── Step 3: batch-insert financial_entities for new corporations, RETURNING
  // id + canonical_name so we map by name (robust — does not rely on multi-row
  // VALUES preserving RETURNING order).
  const newIds: string[] = [];
  for (let i = 0; i < newCanonicals.length; i += ENTITY_CHUNK_SIZE) {
    const chunk = newCanonicals.slice(i, i + ENTITY_CHUNK_SIZE);

    const tuples: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (const canonical of chunk) {
      // canonical_name, display_name, entity_type, total_donated_cents,
      // total_received_cents, metadata
      tuples.push(`($${p++}, $${p++}, 'corporation', 0, 0, $${p++}::jsonb)`);
      params.push(
        canonical,
        canonicalToDisplay.get(canonical) ?? canonical,
        JSON.stringify({ source: "usaspending" }),
      );
    }

    let insertedRows: { id: string; canonical_name: string }[];
    try {
      const res = await client.query<{ id: string; canonical_name: string }>(
        `INSERT INTO public.financial_entities
           (canonical_name, display_name, entity_type, total_donated_cents, total_received_cents, metadata)
         VALUES ${tuples.join(", ")}
         RETURNING id, canonical_name`,
        params,
      );
      insertedRows = res.rows;
    } catch (err) {
      console.error(
        `    usaspending writer: financial_entities insert chunk ${i}-${i + chunk.length} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      out.failed += chunk.length;
      continue;
    }

    const refRows: unknown[][] = [];
    for (const row of insertedRows) {
      out.byCanonical.set(row.canonical_name, row.id);
      newIds.push(row.id);
      refRows.push([
        "usaspending_recipient",
        row.canonical_name,
        "financial_entity",
        row.id,
        { display_name: canonicalToDisplay.get(row.canonical_name) ?? row.canonical_name },
      ]);
    }
    out.inserted += refRows.length;

    // ── Step 4: register external_source_refs for the new entities.
    // DO NOTHING on conflict (source, external_id) — matches the pre-FIX-586
    // ignoreDuplicates in case another run raced us.
    if (refRows.length > 0) {
      await bulkUpsert(client, {
        table: "external_source_refs",
        columns: ["source", "external_id", "entity_type", "entity_id", "metadata"],
        conflictColumns: ["source", "external_id"],
        updateColumns: [], // DO NOTHING
        jsonbColumns: ["metadata"],
        label: "usaspending source_refs",
        rows: refRows,
      });
    }
  }

  // ── Step 5 (FIX-397 + FIX-586): refresh primary_source on the newly-bound
  // financial_entities via the SAME direct client, so it runs under the raised
  // session timeout instead of the 8s PostgREST role cap that timed it out on
  // prod (the n=90484 `[primary-source] refresh failed` line on 2026-06-14).
  // Advisory — the nightly rebuild_all_primary_sources() safety net covers drift.
  if (newIds.length > 0) {
    try {
      await client.query(`SELECT public.refresh_primary_source_for_entities($1, $2::uuid[])`, [
        "financial_entity",
        newIds,
      ]);
    } catch (err) {
      console.warn(
        `  [primary-source] refresh failed (financial_entity, n=${newIds.length}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Award relationship upsert
// ---------------------------------------------------------------------------

export interface SpendingRelationshipInput {
  agencyId: string;
  recipientEntityId: string;
  relationshipType: "contract" | "grant";
  amountCents: number;
  /** ISO date (YYYY-MM-DD). Required — CHECK enforces one of occurred_at/started_at. */
  occurredAt: string;
  usaspendingAwardId: string;
  naicsCode: string | null;
  cfdaNumber: string | null;
  description: string | null;
  sourceUrl: string | null;
}

export interface RelationshipBatchResult {
  upserted: number;
  failed: number;
}

/**
 * Batched upsert of contract/grant relationships over the direct-pg `client`.
 * Dedup via the FULL unique index on usaspending_award_id (migration
 * 20260424000000 — changed from partial specifically to enable ON CONFLICT
 * batched upsert). The bare `ON CONFLICT (usaspending_award_id) DO UPDATE`
 * bulkUpsert emits matches PostgREST's former merge-duplicates resolution.
 */
export async function upsertSpendingRelationshipsBatch(
  client: Client,
  inputs: SpendingRelationshipInput[],
): Promise<RelationshipBatchResult> {
  if (inputs.length === 0) return { upserted: 0, failed: 0 };

  // Client-side dedupe by usaspending_award_id (same FEC-era defense against
  // "ON CONFLICT DO UPDATE cannot affect row a second time").
  const merged = new Map<string, SpendingRelationshipInput>();
  for (const input of inputs) {
    merged.set(input.usaspendingAwardId, input);
  }

  const rows: unknown[][] = [...merged.values()].map((input) => [
    input.relationshipType,
    "agency",
    input.agencyId,
    "financial_entity",
    input.recipientEntityId,
    input.amountCents,
    input.occurredAt,
    null, // started_at
    null, // ended_at
    input.usaspendingAwardId,
    input.sourceUrl,
    {
      source: "usaspending",
      ...(input.naicsCode ? { naics_code: input.naicsCode } : {}),
      ...(input.cfdaNumber ? { cfda_number: input.cfdaNumber } : {}),
      ...(input.description ? { description: input.description } : {}),
    },
  ]);

  const { upserted, failed } = await bulkUpsert(client, {
    table: "financial_relationships",
    columns: [
      "relationship_type",
      "from_type",
      "from_id",
      "to_type",
      "to_id",
      "amount_cents",
      "occurred_at",
      "started_at",
      "ended_at",
      "usaspending_award_id",
      "source_url",
      "metadata",
    ],
    conflictColumns: ["usaspending_award_id"],
    jsonbColumns: ["metadata"],
    label: "usaspending financial_relationships",
    rows,
  });

  return { upserted, failed };
}
