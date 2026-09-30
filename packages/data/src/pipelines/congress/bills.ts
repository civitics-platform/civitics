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
import { refreshPrimarySourceForEntities, rowsOrThrow, fetchChunkedByIds } from "@civitics/db";

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

/**
 * FIX-1256 — a bill key that could not be bound to one proposal cleanly.
 * Counted in `failed` and carried to `data_sync_log.metadata.bill_key_conflicts`;
 * which proposal is the bill is left for a human.
 */
export interface BillKeyConflict {
  bill_key: string;
  /**
   * holder_has_other_ref — the proposal holding the natural key already carries
   *   a DIFFERENT congress_gov ref, so the key is neither bound to it nor minted.
   * bill_details_key_conflict — the key was free when read and taken by the time
   *   the minted proposal's bill_details row was written; the minted proposal is
   *   left WITHOUT the ref, so the next run binds the ref to the holder.
   */
  reason: "holder_has_other_ref" | "bill_details_key_conflict";
  /** The proposal holding `(jurisdiction_id, session, bill_number)`, when it could be read. */
  holder_proposal_id: string | null;
  holder_external_id?: string;
  minted_proposal_id?: string;
}

export interface BillBatchResult {
  /** Successfully inserted or updated proposals. */
  upserted: number;
  /**
   * Rows that failed at the proposals write, plus every key in `keyConflicts`
   * (bill_details/refs chunk errors are logged but not counted).
   */
  failed: number;
  /** FIX-1256: keys with no ref whose bill_details key-holder was found and bound instead of minting. */
  bound: number;
  keyConflicts: BillKeyConflict[];
}

/**
 * FIX-1256 — the natural key of `bill_details`, UNIQUE
 * `(jurisdiction_id, session, bill_number)`. Every writer derives it from the
 * same three args, so a bill's key-holder can be found without its ref.
 */
export function billNaturalKey(
  args: Pick<BillProposalArgs, "jurisdictionId" | "session" | "billNumber">,
): { jurisdiction_id: string; session: string; bill_number: string } {
  return { jurisdiction_id: args.jurisdictionId, session: args.session, bill_number: args.billNumber };
}

/** The `bill_details` row for `proposalId` — every column derives from the bill key. */
export function billDetailsRow(proposalId: string, args: BillProposalArgs) {
  return {
    proposal_id: proposalId,
    ...billNaturalKey(args),
    chamber: args.chamber,
    congress_number: args.congressNumber,
    congress_gov_url: args.congressGovUrl,
  };
}

/**
 * FIX-1256 — billKey → the proposal holding its `bill_details` natural key,
 * for keys that have one. `null` when any chunk could not be read: the caller
 * must not mint blind, because minting next to an unseen holder is the stub.
 */
async function lookupBillDetailHolders(
  db: Db,
  items: BillProposalArgs[],
): Promise<Map<string, string> | null> {
  const out = new Map<string, string>();
  const groups = new Map<string, BillProposalArgs[]>();
  for (const item of items) {
    const g = `${item.jurisdictionId}|${item.session}`;
    const list = groups.get(g) ?? [];
    list.push(item);
    groups.set(g, list);
  }
  for (const list of groups.values()) {
    const { jurisdiction_id, session } = billNaturalKey(list[0]!);
    const { rows, failed } = await fetchChunkedByIds<{ proposal_id: string; bill_number: string }>(
      list.map((i) => i.billNumber),
      (chunk) => db
        .from("bill_details")
        .select("proposal_id, bill_number")
        .eq("jurisdiction_id", jurisdiction_id)
        .eq("session", session)
        .in("bill_number", chunk),
      { chunkSize: RESOLVE_IN_CHUNK, label: "bills:natural-key-holders" },
    );
    if (failed.length > 0) {
      console.error(`    bills.ts batch: natural-key lookup error: ${failed[0]!.error.message}`);
      return null;
    }
    const holderByNumber = new Map(rows.map((r) => [r.bill_number, r.proposal_id]));
    for (const item of list) {
      const holder = holderByNumber.get(item.billNumber);
      if (holder) out.set(item.billKey, holder);
    }
  }
  return out;
}

interface KeyHolderBinding {
  /** Keys bound this call to their bill_details key-holder. */
  bound: Array<{ id: string; args: BillProposalArgs }>;
  /** Keys nobody holds — the only ones a caller may mint. */
  unheld: BillProposalArgs[];
  conflicts: BillKeyConflict[];
  /** Keys whose bind write failed (neither bound nor mintable this run). */
  bindFailed: number;
}

/**
 * FIX-1256 — the natural-key pass. A key with no congress_gov ref may still
 * have its proposal: one holding the bill_details natural key whose ref was
 * lost. The 08-04 sync lost the refs write for 18 House bills to a statement
 * timeout (proposals, bill_details and refs are three separate PostgREST calls,
 * not one transaction); each later ingest of three of them minted a stub that
 * took the ref while the ignoreDuplicates bill_details upsert left the key on
 * the holder. So: bind a NEW ref to the holder (ON CONFLICT DO NOTHING) and
 * never mint beside it. A holder already bound to a DIFFERENT congress_gov key
 * (a renumbered bill?) is not ours to rebind — logged, counted, left.
 *
 * Writes refs only; never the holder's proposals row. `null` when a read
 * failed: the caller must not mint blind.
 */
async function bindToKeyHolders(db: Db, items: BillProposalArgs[]): Promise<KeyHolderBinding | null> {
  const out: KeyHolderBinding = { bound: [], unheld: [], conflicts: [], bindFailed: 0 };
  if (items.length === 0) return out;

  const holders = await lookupBillDetailHolders(db, items);
  if (holders === null) return null;

  const holderRefs = new Map<string, string>();
  if (holders.size > 0) {
    const { rows, failed } = await fetchChunkedByIds<{ entity_id: string; external_id: string }>(
      [...new Set(holders.values())],
      (chunk) => db
        .from("external_source_refs")
        .select("entity_id, external_id")
        .eq("source", "congress_gov")
        .eq("entity_type", "proposal")
        .in("entity_id", chunk),
      { chunkSize: RESOLVE_IN_CHUNK, label: "bills:holder-refs" },
    );
    if (failed.length > 0) {
      console.error(`    bills.ts: holder-ref lookup error: ${failed[0]!.error.message}`);
      return null;
    }
    for (const r of rows) holderRefs.set(r.entity_id, r.external_id);
  }

  const toBind: Array<{ id: string; args: BillProposalArgs }> = [];
  for (const item of items) {
    const holder = holders.get(item.billKey);
    if (!holder) {
      out.unheld.push(item);
      continue;
    }
    const other = holderRefs.get(holder);
    if (other !== undefined && other !== item.billKey) {
      console.error(
        `    bills.ts: ${item.billKey} — its bill_details key is held by proposal ${holder}, ` +
          `which is already bound to congress_gov ${other}; neither bound nor minted (FIX-1256)`,
      );
      out.conflicts.push({
        bill_key: item.billKey,
        reason: "holder_has_other_ref",
        holder_proposal_id: holder,
        holder_external_id: other,
      });
      continue;
    }
    toBind.push({ id: holder, args: item });
  }

  for (let i = 0; i < toBind.length; i += BILL_CHUNK_SIZE) {
    const chunk = toBind.slice(i, i + BILL_CHUNK_SIZE);
    const { error } = await db
      .from("external_source_refs")
      .upsert(
        chunk.map(({ id, args }) => ({
          source: "congress_gov",
          external_id: args.billKey,
          entity_type: "proposal",
          entity_id: id,
          source_url: args.congressGovUrl,
          metadata: {},
        })),
        { onConflict: "source,external_id", ignoreDuplicates: true },
      );
    if (error) {
      console.error(`    bills.ts: holder ref bind chunk ${i}-${i + chunk.length}: ${error.message}`);
      out.bindFailed += chunk.length;
      continue;
    }
    out.bound.push(...chunk);
  }
  if (out.bound.length > 0) {
    console.log(
      `    bills.ts: bound ${out.bound.length} ref(s) to an existing bill_details key-holder instead of minting (FIX-1256): ` +
        out.bound.slice(0, 10).map(({ id, args }) => `${args.billKey}→${id}`).join(", "),
    );
  }
  return out;
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
  if (items.length === 0) return { upserted: 0, failed: 0, bound: 0, keyConflicts: [] };

  // Client-side dedupe by billKey — duplicate keys in the same batch would
  // trip ON CONFLICT "cannot affect row a second time". Later wins.
  const byKey = new Map<string, BillProposalArgs>();
  for (const item of items) byKey.set(item.billKey, item);
  const deduped = [...byKey.values()];
  const billKeys = deduped.map((i) => i.billKey);

  // Step 1: batch lookup of existing proposals via external_source_refs.
  //
  // FIX-1037: this `.in()` was UNCHUNKED while `lookupRefs` twenty lines down
  // in the same file chunks the identical query at RESOLVE_IN_CHUNK -- the
  // helper simply was not reachable from packages/ until it moved into
  // @civitics/db. `billKeys` is every novel bill in the run (resolveBillKeys
  // passes the whole `novelArgs` set), so on a first-run or backfill ingest it
  // is thousands of keys in one request line. Bill keys are shorter than uuids,
  // which is why this survived: it fails at a higher count, not at no count.
  const { rows: existing, failed: lookupFailed } = await fetchChunkedByIds<{ entity_id: string; external_id: string }>(
    billKeys,
    (chunk) => db
      .from("external_source_refs")
      .select("entity_id, external_id")
      .eq("source", "congress_gov")
      .eq("entity_type", "proposal")
      .in("external_id", chunk),
    { label: "bills:existing-refs" },
  );

  if (lookupFailed.length > 0) {
    console.error(`    bills.ts batch: lookup error: ${lookupFailed[0]!.error.message}`);
    return { upserted: 0, failed: deduped.length, bound: 0, keyConflicts: [] };
  }

  const existingMap = new Map<string, string>();
  for (const r of existing) {
    existingMap.set(r.external_id, r.entity_id);
  }

  // Step 1b (FIX-1256): a key with no ref may still have its proposal — bind
  // a ref to its bill_details key-holder instead of minting beside it.
  const binding = await bindToKeyHolders(db, deduped.filter((i) => !existingMap.has(i.billKey)));
  if (binding === null) {
    return { upserted: 0, failed: deduped.length, bound: 0, keyConflicts: [] };
  }

  // Step 2: partition into update vs insert. A bound holder is an existing
  // bill, so Step 3 refreshes its proposals row from this run's congress.gov
  // data — the sync's own contract. resolveBillsBatch binds its holders BEFORE
  // calling here and never passes them in: the vote path's args are
  // placeholders (the bill number as title, the roll date as introduced_at)
  // and must not overwrite a real row.
  const toUpdate: Array<{ id: string; args: BillProposalArgs }> = [];
  for (const item of deduped) {
    const existingId = existingMap.get(item.billKey);
    if (existingId) toUpdate.push({ id: existingId, args: item });
  }
  toUpdate.push(...binding.bound);
  const toInsert: BillProposalArgs[] = binding.unheld;
  const keyConflicts: BillKeyConflict[] = [...binding.conflicts];

  let upserted = 0;
  let failed = keyConflicts.length + binding.bindFailed;
  const bound = binding.bound.length;

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

    // 4b: bill_details. Step 1b already bound every key whose natural key had
    // a holder, so a key conflict here is a key taken between that read and
    // this write — never ignored (FIX-1256): the rows the upsert did not
    // return are logged with both ids, counted, and kept off the ref in 4c.
    const argsByMinted = new Map<string, BillProposalArgs>();
    const billDetailRecords = toInsert
      .map((args, idx) => {
        const proposalId = insertedIds[idx];
        if (!proposalId) return null;
        argsByMinted.set(proposalId, args);
        return billDetailsRow(proposalId, args);
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    const unlanded: string[] = [];
    for (let i = 0; i < billDetailRecords.length; i += BILL_CHUNK_SIZE) {
      const chunk = billDetailRecords.slice(i, i + BILL_CHUNK_SIZE);
      const { data, error } = await db
        .from("bill_details")
        .upsert(chunk, {
          onConflict: "jurisdiction_id,session,bill_number",
          ignoreDuplicates: true,
        })
        .select("proposal_id");
      if (error) {
        console.error(`    bills.ts batch: bill_details chunk ${i}-${i + chunk.length}: ${error.message}`);
        continue;
      }
      const landed = new Set(((data ?? []) as Array<{ proposal_id: string }>).map((r) => r.proposal_id));
      for (const r of chunk) if (!landed.has(r.proposal_id)) unlanded.push(r.proposal_id);
    }

    const unbound = new Set(unlanded);
    if (unlanded.length > 0) {
      const conflicted = unlanded.map((id) => argsByMinted.get(id)!);
      const holdersNow = (await lookupBillDetailHolders(db, conflicted)) ?? new Map<string, string>();
      for (const minted of unlanded) {
        const args = argsByMinted.get(minted)!;
        const holder = holdersNow.get(args.billKey) ?? null;
        console.error(
          `    bills.ts batch: ${args.billKey} — bill_details key taken by proposal ${holder ?? "(unread)"} ` +
            `after the natural-key read; minted proposal ${minted} is left WITHOUT the ref (FIX-1256)`,
        );
        keyConflicts.push({
          bill_key: args.billKey,
          reason: "bill_details_key_conflict",
          holder_proposal_id: holder,
          minted_proposal_id: minted,
        });
        failed += 1;
      }
    }

    // 4c: external_source_refs — batched upsert, dedup on (source, external_id)
    const refRecords = toInsert
      .map((args, idx) => {
        const proposalId = insertedIds[idx];
        if (!proposalId || unbound.has(proposalId)) return null;
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

  return { upserted, failed, bound, keyConflicts };
}

// ---------------------------------------------------------------------------
// FIX-1238 — the vote writer's bill_details guard (see ./vote-bill-guard.ts)
// ---------------------------------------------------------------------------

/**
 * Which of `proposalIds` have a `bill_details` row — the FK target of
 * `votes.bill_proposal_id`. Chunked like `lookupRefs`; throws on a read error
 * (the guard decides what a failed read means, not this).
 */
export async function presentBillDetailIds(db: Db, proposalIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < proposalIds.length; i += RESOLVE_IN_CHUNK) {
    const rows = rowsOrThrow(
      await db
        .from("bill_details")
        .select("proposal_id")
        .in("proposal_id", proposalIds.slice(i, i + RESOLVE_IN_CHUNK)),
      "votes bill_details presence",
    );
    for (const r of rows as { proposal_id: string }[]) out.add(r.proposal_id);
  }
  return out;
}

/**
 * ONE targeted landing of a `bill_details` row for a proposal that already
 * exists but has none. Every column is derivable from the roll's bill key, so
 * no congress.gov fetch is needed. A 23505 means the compound unique
 * `(jurisdiction_id, session, bill_number)` is held by another proposal
 * (FIX-1238 case b) — its holder is read back and returned, never resolved.
 */
export async function landBillDetails(
  db: Db,
  proposalId: string,
  args: BillProposalArgs,
): Promise<
  | { status: "landed" }
  | { status: "collision"; holderProposalId: string | null }
  | { status: "failed"; message: string }
> {
  const { error } = await db.from("bill_details").insert(billDetailsRow(proposalId, args));
  if (!error) return { status: "landed" };
  if (error.code !== "23505") return { status: "failed", message: error.message };

  const key = billNaturalKey(args);
  const { data: holder, error: holderErr } = await db
    .from("bill_details")
    .select("proposal_id")
    .eq("jurisdiction_id", key.jurisdiction_id)
    .eq("session", key.session)
    .eq("bill_number", key.bill_number)
    .maybeSingle();
  if (holderErr) {
    console.error(`    bills.ts: bill_details holder lookup failed for ${args.billKey}: ${holderErr.message}`);
  }
  return { status: "collision", holderProposalId: (holder?.proposal_id as string | undefined) ?? null };
}

// ---------------------------------------------------------------------------
// Batch resolver — used by the vote-ingestion path to flush a session's worth
// of novel bills in one round-trip instead of one SELECT+INSERT per bill.
// ---------------------------------------------------------------------------

/**
 * Resolve billKey → proposalId for every key in billArgsBuffer.
 * - Existing bills: found in a single bulk external_source_refs lookup.
 * - Bills whose ref is missing but whose bill_details natural key is held:
 *   a ref is bound to the holder, which is returned (FIX-1256's second pass).
 * - Novel bills (unresolved by both): inserted via upsertBillProposalsBatch,
 *   then re-fetched through their refs.
 * Returns a Map covering every key (null for any that couldn't be resolved);
 * key conflicts are appended to `conflicts` so the caller can count them in
 * rows_failed.
 */
export async function resolveBillsBatch(
  db: Db,
  billArgsBuffer: Map<string, BillProposalArgs>,
  conflicts?: BillKeyConflict[],
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

  // FIX-1256 — the second pass: a key with no ref whose bill_details key is
  // held resolves to the HOLDER (a ref is bound to it). Its proposals row is
  // left alone — the vote path's args are placeholders. Only keys unresolved by
  // both passes are minted. A failed read throws, like the lookups above.
  const binding = await bindToKeyHolders(
    db,
    [...billArgsBuffer.values()].filter((a) => resolved.get(a.billKey) === null),
  );
  if (binding === null) throw new Error("bills resolve natural-key-holders: read failed (see the log line above)");
  for (const b of binding.bound) resolved.set(b.args.billKey, b.id);
  conflicts?.push(...binding.conflicts);
  if (binding.bound.length > 0) {
    await refreshPrimarySourceForEntities(db, "proposal", binding.bound.map((b) => b.id));
  }

  const novelArgs = binding.unheld;

  if (novelArgs.length > 0) {
    const batch = await upsertBillProposalsBatch(db, novelArgs);
    conflicts?.push(...batch.keyConflicts);
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
