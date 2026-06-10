/**
 * Congress bills writer — post-cutover, single-write against public.
 *
 * After the shadow→public promotion (migration 20260422000000), the shadow
 * schema is gone and its tables were renamed into public. This module now
 * writes exclusively to:
 *   - public.proposals          (core row)
 *   - public.bill_details       (proposal_id + bill-specific columns)
 *   - public.external_source_refs (source='congress_gov', entity_type='proposal')
 *
 * Lookup for dedup uses external_source_refs (unique on source+external_id).
 * The legacy public.proposals.source_ids JSONB path is gone — the source_ids
 * column was dropped as part of the promotion.
 */

import type { createAdminClient } from "@civitics/db";
import type { Database } from "@civitics/db";
import { refreshPrimarySourceForEntities, rowsOrThrow } from "@civitics/db";

type ProposalInsert = Database["public"]["Tables"]["proposals"]["Insert"];
type ProposalType = Database["public"]["Enums"]["proposal_type"];
type ProposalStatus = Database["public"]["Enums"]["proposal_status"];

type Db = ReturnType<typeof createAdminClient>;

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface BillProposalArgs {
  /** Canonical external ID for the bill, e.g. "119-HR-1234". */
  billKey: string;
  /** Display title (trimmed to 500 chars downstream). */
  title: string;
  /** Bill number as it appears on legislation, e.g. "HR 1234". */
  billNumber: string;
  /** Bill type (hr, s, hjres, sjres, hconres, sconres, ...). */
  billType: string;
  /** Chamber this bill originated in. 'house' | 'senate'. */
  chamber: "house" | "senate";
  /** proposal_type enum (mapLegislationType output). */
  type: ProposalType;
  /** proposal_status enum. */
  status: ProposalStatus;
  /** Federal jurisdiction UUID. */
  jurisdictionId: string;
  /** Governing body (House or Senate) UUID. */
  governingBodyId: string;
  /** https://www.congress.gov/... URL. */
  congressGovUrl: string;
  /** Introduction date (ISO date string or null). */
  introducedAt: string | null;
  /** Last action date (ISO date string or null). */
  lastActionAt: string | null;
  /** Optional free-text description of latest action. */
  latestActionText?: string;
  /** Congress number (e.g. 119). */
  congressNumber: number;
  /** Session identifier as stored on bill_details, usually String(congressNumber). */
  session: string;
}

// ---------------------------------------------------------------------------
// Lookup — find existing proposal by congress_gov bill key
// ---------------------------------------------------------------------------

async function findExistingProposalId(db: Db, billKey: string): Promise<string | null> {
  const { data, error } = await db
    .from("external_source_refs")
    .select("entity_id")
    .eq("source", "congress_gov")
    .eq("external_id", billKey)
    .eq("entity_type", "proposal")
    .maybeSingle();

  if (error) {
    console.error(
      `    bills.ts: external_source_refs lookup error for ${billKey}: ${error.message}`
    );
    return null;
  }

  return (data?.entity_id as string | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Insert — single write to public (proposals + bill_details + source_refs)
// ---------------------------------------------------------------------------

async function insertBill(db: Db, args: BillProposalArgs): Promise<string | null> {
  const {
    billKey,
    title,
    billNumber,
    chamber,
    type,
    status,
    jurisdictionId,
    governingBodyId,
    congressGovUrl,
    introducedAt,
    lastActionAt,
    latestActionText,
    congressNumber,
    session,
  } = args;

  const truncatedTitle = title.slice(0, 500);

  const proposalRecord: ProposalInsert = {
    title: truncatedTitle,
    type,
    status,
    jurisdiction_id: jurisdictionId,
    governing_body_id: governingBodyId,
    external_url: congressGovUrl,
    introduced_at: introducedAt,
    last_action_at: lastActionAt,
    metadata: {
      legacy_bill_number: billNumber,
      legacy_congress_num: congressNumber,
      legacy_session: session,
      ...(latestActionText ? { latest_action: latestActionText } : {}),
    },
  };

  const { data: inserted, error: propErr } = await db
    .from("proposals")
    .insert(proposalRecord)
    .select("id")
    .single();

  if (propErr || !inserted) {
    console.error(`    bills.ts: proposals insert failed for ${billKey}: ${propErr?.message}`);
    return null;
  }

  const proposalId = inserted.id as string;

  // bill_details — trigger bill_details_sync_denorm fills jurisdiction_id
  // from the parent proposals row, but supabase-js requires the column be
  // present in the INSERT; pass the value explicitly so PostgREST accepts it.
  const { error: bdErr } = await db.from("bill_details").insert({
    proposal_id: proposalId,
    bill_number: billNumber,
    chamber,
    session,
    congress_number: congressNumber,
    congress_gov_url: congressGovUrl,
    jurisdiction_id: jurisdictionId,
  });

  if (bdErr && bdErr.code !== "23505") {
    console.error(`    bills.ts: bill_details insert failed for ${billKey}: ${bdErr.message}`);
  }

  const { error: refErr } = await db.from("external_source_refs").insert({
    source: "congress_gov",
    external_id: billKey,
    entity_type: "proposal",
    entity_id: proposalId,
    source_url: congressGovUrl,
    metadata: {},
  });

  if (refErr && refErr.code !== "23505") {
    console.error(
      `    bills.ts: external_source_refs insert failed for ${billKey}: ${refErr.message}`
    );
  }

  return proposalId;
}

// ---------------------------------------------------------------------------
// Exported entry points
// ---------------------------------------------------------------------------

/**
 * Reactive create: called from the vote-ingestion path. If the bill already
 * exists (by billKey), returns its ID. Otherwise inserts it.
 */
export async function findOrCreateBillProposal(
  db: Db,
  args: BillProposalArgs
): Promise<string | null> {
  const existing = await findExistingProposalId(db, args.billKey);
  if (existing) return existing;
  return insertBill(db, args);
}

/**
 * Proactive upsert: called from the recent-bills sync. If the bill exists,
 * updates its status + last_action_at. Otherwise inserts.
 */
export async function upsertBillProposal(
  db: Db,
  args: BillProposalArgs
): Promise<string | null> {
  const existing = await findExistingProposalId(db, args.billKey);

  if (existing) {
    const { error } = await db
      .from("proposals")
      .update({
        title: args.title.slice(0, 500),
        status: args.status,
        last_action_at: args.lastActionAt,
      })
      .eq("id", existing);

    if (error) {
      console.error(`    bills.ts: proposals update failed for ${args.billKey}: ${error.message}`);
      return null;
    }

    return existing;
  }

  return insertBill(db, args);
}

/**
 * Resolves the chamber string from a Congress.gov bill type. Kept here so
 * votes.ts doesn't need a parallel lookup.
 */
export function chamberForBillType(billType: string): "house" | "senate" {
  const lt = billType.toLowerCase();
  if (lt.startsWith("h")) return "house";
  return "senate";
}

// ---------------------------------------------------------------------------
// Batched upsert — used by the proactive recent-bills sync so a single run
// collapses to a handful of chunked round-trips instead of one SELECT+INSERT
// per bill. Volume is typically a few hundred bills per sync; the per-row
// path above was ~5 min on Pro, this drops it under 10 seconds.
// ---------------------------------------------------------------------------

const BILL_CHUNK_SIZE = 500;
// .in() id-list ceiling — longer lists overflow the Kong/PostgREST URL budget
// and 400 out (FIX-545). resolveBillsBatch gets the full per-chamber bill
// buffer, which routinely exceeds 200 keys.
const RESOLVE_IN_CHUNK = 200;

export interface BillBatchResult {
  /** Successfully inserted or updated proposals. */
  upserted: number;
  /** Rows that failed at the proposals write (bill_details/refs errors are logged but not counted). */
  failed: number;
}

function buildProposalInsert(args: BillProposalArgs): ProposalInsert {
  return {
    title: args.title.slice(0, 500),
    type: args.type,
    status: args.status,
    jurisdiction_id: args.jurisdictionId,
    governing_body_id: args.governingBodyId,
    external_url: args.congressGovUrl,
    introduced_at: args.introducedAt,
    last_action_at: args.lastActionAt,
    metadata: {
      legacy_bill_number: args.billNumber,
      legacy_congress_num: args.congressNumber,
      legacy_session: args.session,
      ...(args.latestActionText ? { latest_action: args.latestActionText } : {}),
    },
  };
}

export async function upsertBillProposalsBatch(
  db: Db,
  items: BillProposalArgs[]
): Promise<BillBatchResult> {
  if (items.length === 0) return { upserted: 0, failed: 0 };

  // Client-side dedupe by billKey — duplicate keys in the same batch would
  // trip ON CONFLICT "cannot affect row a second time". Later wins.
  const byKey = new Map<string, BillProposalArgs>();
  for (const item of items) byKey.set(item.billKey, item);
  const deduped = [...byKey.values()];
  const billKeys = deduped.map((i) => i.billKey);

  // Step 1: batch lookup of existing proposals via external_source_refs
  const { data: existing, error: lookupErr } = await db
    .from("external_source_refs")
    .select("entity_id, external_id")
    .eq("source", "congress_gov")
    .eq("entity_type", "proposal")
    .in("external_id", billKeys);

  if (lookupErr) {
    console.error(`    bills.ts batch: lookup error: ${lookupErr.message}`);
    return { upserted: 0, failed: deduped.length };
  }

  const existingMap = new Map<string, string>();
  for (const r of (existing ?? []) as Array<{ entity_id: string; external_id: string }>) {
    existingMap.set(r.external_id, r.entity_id);
  }

  // Step 2: partition into update vs insert
  const toUpdate: Array<{ id: string; args: BillProposalArgs }> = [];
  const toInsert: BillProposalArgs[] = [];
  for (const item of deduped) {
    const existingId = existingMap.get(item.billKey);
    if (existingId) toUpdate.push({ id: existingId, args: item });
    else toInsert.push(item);
  }

  let upserted = 0;
  let failed = 0;

  // Step 3: batched UPDATE via upsert(onConflict='id'). Every row has a
  // known-existing id, so the ON CONFLICT path runs for all of them.
  if (toUpdate.length > 0) {
    for (let i = 0; i < toUpdate.length; i += BILL_CHUNK_SIZE) {
      const chunk = toUpdate.slice(i, i + BILL_CHUNK_SIZE);
      const records = chunk.map(({ id, args }) => ({
        id,
        ...buildProposalInsert(args),
      }));
      const { error } = await db
        .from("proposals")
        .upsert(records, { onConflict: "id" });
      if (error) {
        console.error(`    bills.ts batch: update chunk ${i}-${i + chunk.length}: ${error.message}`);
        failed += chunk.length;
      } else {
        upserted += chunk.length;
      }
    }
  }

  // Step 4: batched INSERT of new bills — proposals, then bill_details + refs
  // insertedIds declared at function scope so the FIX-397 primary_source
  // refresh below can read it after the if-block completes.
  const insertedIds: Array<string | null> = [];
  if (toInsert.length > 0) {

    for (let i = 0; i < toInsert.length; i += BILL_CHUNK_SIZE) {
      const chunk = toInsert.slice(i, i + BILL_CHUNK_SIZE);
      const records = chunk.map(buildProposalInsert);
      const { data, error } = await db
        .from("proposals")
        .insert(records)
        .select("id");
      if (error || !data) {
        console.error(`    bills.ts batch: proposal insert chunk ${i}-${i + chunk.length}: ${error?.message}`);
        failed += chunk.length;
        for (let k = 0; k < chunk.length; k++) insertedIds.push(null);
        continue;
      }
      for (const row of data as Array<{ id: string }>) insertedIds.push(row.id);
      upserted += data.length;
    }

    // 4b: bill_details — batched upsert ignoring duplicates on the compound
    // unique (some bills already have bill_details from a prior run that's
    // missing an external_source_refs row).
    const billDetailRecords = toInsert
      .map((args, idx) => {
        const proposalId = insertedIds[idx];
        if (!proposalId) return null;
        return {
          proposal_id: proposalId,
          bill_number: args.billNumber,
          chamber: args.chamber,
          session: args.session,
          congress_number: args.congressNumber,
          congress_gov_url: args.congressGovUrl,
          jurisdiction_id: args.jurisdictionId,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    for (let i = 0; i < billDetailRecords.length; i += BILL_CHUNK_SIZE) {
      const chunk = billDetailRecords.slice(i, i + BILL_CHUNK_SIZE);
      const { error } = await db
        .from("bill_details")
        .upsert(chunk, {
          onConflict: "jurisdiction_id,session,bill_number",
          ignoreDuplicates: true,
        });
      if (error) {
        console.error(`    bills.ts batch: bill_details chunk ${i}-${i + chunk.length}: ${error.message}`);
      }
    }

    // 4c: external_source_refs — batched upsert, dedup on (source, external_id)
    const refRecords = toInsert
      .map((args, idx) => {
        const proposalId = insertedIds[idx];
        if (!proposalId) return null;
        return {
          source: "congress_gov",
          external_id: args.billKey,
          entity_type: "proposal",
          entity_id: proposalId,
          source_url: args.congressGovUrl,
          metadata: {},
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    for (let i = 0; i < refRecords.length; i += BILL_CHUNK_SIZE) {
      const chunk = refRecords.slice(i, i + BILL_CHUNK_SIZE);
      const { error } = await db
        .from("external_source_refs")
        .upsert(chunk, {
          onConflict: "source,external_id",
          ignoreDuplicates: true,
        });
      if (error) {
        console.error(`    bills.ts batch: source_refs chunk ${i}-${i + chunk.length}: ${error.message}`);
      }
    }
  }

  // FIX-397: refresh primary_source on the proposals that just got xsr
  // bindings (insert path) or whose xsr last_seen_at moved (update path's
  // refRecords cover only inserts; update-path proposals stay bound to their
  // prior winner anyway, but invoking for them is cheap and idempotent).
  const refreshedIds = [
    ...toInsert.map((_, idx) => insertedIds[idx]).filter((id): id is string => Boolean(id)),
    ...toUpdate.map((u) => u.id),
  ];
  if (refreshedIds.length > 0) {
    await refreshPrimarySourceForEntities(db, "proposal", refreshedIds);
  }

  return { upserted, failed };
}

// ---------------------------------------------------------------------------
// Batch resolver — used by the vote-ingestion path to flush a session's worth
// of novel bills in one round-trip instead of one SELECT+INSERT per bill.
// ---------------------------------------------------------------------------

/**
 * Resolve billKey → proposalId for every key in billArgsBuffer.
 * - Existing bills: found in a single bulk external_source_refs lookup.
 * - Novel bills: inserted via upsertBillProposalsBatch, then re-fetched.
 * Returns a Map covering every key (null for any that couldn't be resolved).
 */
export async function resolveBillsBatch(
  db: Db,
  billArgsBuffer: Map<string, BillProposalArgs>
): Promise<Map<string, string | null>> {
  if (billArgsBuffer.size === 0) return new Map();

  const keys = [...billArgsBuffer.keys()];

  // FIX-545: a lookup error used to degrade to an all-null map (every bill
  // "unresolvable" → the chamber's votes silently skipped); the .in() lists
  // also ran unchunked past the ~200-id URL cap. Chunk + throw.
  const lookupRefs = async (lookupKeys: string[], label: string) => {
    const out: { entity_id: string; external_id: string }[] = [];
    for (let i = 0; i < lookupKeys.length; i += RESOLVE_IN_CHUNK) {
      const rows = rowsOrThrow(
        await db
          .from("external_source_refs")
          .select("entity_id, external_id")
          .eq("source", "congress_gov")
          .eq("entity_type", "proposal")
          .in("external_id", lookupKeys.slice(i, i + RESOLVE_IN_CHUNK)),
        label,
      );
      out.push(...(rows as { entity_id: string; external_id: string }[]));
    }
    return out;
  };

  const resolved = new Map<string, string | null>(keys.map((k) => [k, null]));
  for (const r of await lookupRefs(keys, "bills resolve existing-refs")) {
    resolved.set(r.external_id, r.entity_id);
  }

  const novelArgs = [...billArgsBuffer.values()].filter(
    (a) => resolved.get(a.billKey) === null
  );

  if (novelArgs.length > 0) {
    await upsertBillProposalsBatch(db, novelArgs);
    const freshRefs = await lookupRefs(
      novelArgs.map((a) => a.billKey),
      "bills resolve fresh-refs",
    );
    for (const r of freshRefs) {
      resolved.set(r.external_id, r.entity_id);
    }
  }

  return resolved;
}
