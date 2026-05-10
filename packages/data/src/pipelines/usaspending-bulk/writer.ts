/**
 * USASpending writer — shared by the bulk archive pipeline.
 *
 * Tables written:
 *   public.financial_entities         corporation recipients (dedup via
 *                                     external_source_refs source='usaspending_recipient')
 *   public.external_source_refs       one row per recipient canonical name
 *   public.financial_relationships    one row per award (contract/grant);
 *                                     dedup via usaspending_award_id partial
 *                                     unique index
 *
 * All writes go through chunked `.upsert()` — O(chunks) round-trips, not
 * O(rows). Matches the FEC bulk writer pattern.
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

import type { createAdminClient } from "@civitics/db";
import { canonicalizeEntityName } from "../fec-bulk/writer";

type Db = ReturnType<typeof createAdminClient>;

const CHUNK_SIZE = 500;

// Lookup chunks stay small — `.in("external_id", values)` serialises values
// into the URL; 500 recipient canonical names (50+ chars each) blows past
// PostgREST's URL limit with "URI too long". Keep lookup-side chunks under
// ~100 to stay under 8KB.
const LOOKUP_CHUNK_SIZE = 100;

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
 */
export async function resolveRecipients(
  db: Db,
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

  // ── Step 1: batch-lookup existing refs (chunked to stay inside PostgREST's
  // URL length limits — `.in()` with many values explodes the URL).
  for (let i = 0; i < canonicals.length; i += LOOKUP_CHUNK_SIZE) {
    const chunk = canonicals.slice(i, i + LOOKUP_CHUNK_SIZE);
    const { data, error } = await db
      .from("external_source_refs")
      .select("external_id, entity_id")
      .eq("source", "usaspending_recipient")
      .eq("entity_type", "financial_entity")
      .in("external_id", chunk);
    if (error) {
      console.error(`    usaspending writer: recipient lookup chunk ${i}-${i + chunk.length}: ${error.message}`);
      continue;
    }
    for (const row of (data ?? []) as Array<{ external_id: string; entity_id: string }>) {
      out.byCanonical.set(row.external_id, row.entity_id);
    }
  }

  // ── Step 2: determine which canonicals are new and need inserting
  const newCanonicals = canonicals.filter((c) => !out.byCanonical.has(c));
  if (newCanonicals.length === 0) return out;

  // ── Step 3: batch-insert financial_entities for new corporations
  //
  // We insert chunks, then pull the ids back from `.select()`. Postgres
  // guarantees the returned rows line up with the inserted rows within a
  // single statement.
  for (let i = 0; i < newCanonicals.length; i += CHUNK_SIZE) {
    const chunk = newCanonicals.slice(i, i + CHUNK_SIZE);
    const records = chunk.map((canonical) => ({
      canonical_name: canonical,
      display_name: canonicalToDisplay.get(canonical) ?? canonical,
      entity_type: "corporation",
      total_donated_cents: 0,
      total_received_cents: 0,
      metadata: { source: "usaspending" },
    }));

    const { data: inserted, error: insErr } = await db
      .from("financial_entities")
      .insert(records)
      .select("id");

    if (insErr || !inserted) {
      console.error(`    usaspending writer: financial_entities insert chunk ${i}-${i + chunk.length}: ${insErr?.message}`);
      out.failed += chunk.length;
      continue;
    }

    // Zip canonical names with the returned IDs (Postgres preserves order).
    const refRecords = chunk.map((canonical, idx) => {
      const id = (inserted[idx] as { id: string } | undefined)?.id;
      if (!id) return null;
      out.byCanonical.set(canonical, id);
      return {
        source: "usaspending_recipient",
        external_id: canonical,
        entity_type: "financial_entity",
        entity_id: id,
        metadata: { display_name: canonicalToDisplay.get(canonical) ?? canonical },
      };
    }).filter((r): r is NonNullable<typeof r> => r !== null);

    out.inserted += refRecords.length;

    // ── Step 4: batch-register external_source_refs for the new entities
    // `ignoreDuplicates` in case another run raced us.
    const { error: refErr } = await db
      .from("external_source_refs")
      .upsert(refRecords, {
        onConflict: "source,external_id",
        ignoreDuplicates: true,
      });
    if (refErr) {
      console.error(`    usaspending writer: source_refs chunk ${i}-${i + chunk.length}: ${refErr.message}`);
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
 * Batched upsert of contract/grant relationships. Dedup via the existing
 * partial unique index `financial_relationships_usaspending_unique`
 * (WHERE usaspending_award_id IS NOT NULL). All inserted rows have a
 * non-null usaspending_award_id, so the predicate is trivially satisfied.
 */
export async function upsertSpendingRelationshipsBatch(
  db: Db,
  inputs: SpendingRelationshipInput[],
): Promise<RelationshipBatchResult> {
  const out: RelationshipBatchResult = { upserted: 0, failed: 0 };
  if (inputs.length === 0) return out;

  // Client-side dedupe by usaspending_award_id (same FEC-era defense against
  // "ON CONFLICT DO UPDATE cannot affect row a second time").
  const merged = new Map<string, SpendingRelationshipInput>();
  for (const input of inputs) {
    merged.set(input.usaspendingAwardId, input);
  }

  const records = [...merged.values()].map((input) => ({
    relationship_type: input.relationshipType,
    from_type: "agency",
    from_id: input.agencyId,
    to_type: "financial_entity",
    to_id: input.recipientEntityId,
    amount_cents: input.amountCents,
    occurred_at: input.occurredAt,
    started_at: null,
    ended_at: null,
    usaspending_award_id: input.usaspendingAwardId,
    source_url: input.sourceUrl,
    metadata: {
      source: "usaspending",
      ...(input.naicsCode ? { naics_code: input.naicsCode } : {}),
      ...(input.cfdaNumber ? { cfda_number: input.cfdaNumber } : {}),
      ...(input.description ? { description: input.description } : {}),
    },
  }));

  for (let i = 0; i < records.length; i += CHUNK_SIZE) {
    const chunk = records.slice(i, i + CHUNK_SIZE);
    const { error } = await db
      .from("financial_relationships")
      .upsert(chunk, { onConflict: "usaspending_award_id" });

    if (error) {
      console.error(`    usaspending writer: financial_relationships chunk ${i}-${i + chunk.length}: ${error.message}`);
      out.failed += chunk.length;
      continue;
    }
    out.upserted += chunk.length;
  }

  return out;
}
