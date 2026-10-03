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
import { statusAdvances, type ProposalStatus } from "./status-rank";
import type { StatusPair } from "./bill-status";

type ProposalInsert = Database["public"]["Tables"]["proposals"]["Insert"];
type ProposalType = Database["public"]["Enums"]["proposal_type"];

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
  /**
   * The stage this run's evidence PROVES, or null when it proves none
   * (FIX-1257: a stage-less latest action like "Motion to reconsider laid on
   * the table…"). A new bill is minted with it (null → `introduced`); an
   * existing bill is only ever ADVANCED to it, through
   * `proposals_advance_status()` — never overwritten.
   */
  status: ProposalStatus | null;
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
  /** FIX-1257: Step 3's status advances on existing bills (see `advanceProposalStatuses`). */
  status: AdvanceResult;
}

// ---------------------------------------------------------------------------
// FIX-1257 — status only ever advances
// ---------------------------------------------------------------------------

/** One proposal whose status moved. `via` names the evidence (a roll id, or "sync"). */
export interface StatusMove {
  id: string;
  from: ProposalStatus;
  to: ProposalStatus;
  via: string;
}

export interface AdvanceResult {
  /** Rows `proposals_advance_status()` moved. */
  moved: StatusMove[];
  /** Pairs the rule refused (or whose id is gone) — asked for, not moved. */
  held: number;
  /** Pairs in a chunk whose RPC call errored (logged; nothing moved). */
  failed: number;
}

export const emptyAdvance = (): AdvanceResult => ({ moved: [], held: 0, failed: 0 });

export function mergeAdvance(into: AdvanceResult, add: AdvanceResult): AdvanceResult {
  into.moved.push(...add.moved);
  into.held += add.held;
  into.failed += add.failed;
  return into;
}

/**
 * Ask `proposals_advance_status()` to move each (id, status) pair — one RPC
 * call per chunk, set-based. The DATABASE applies the rule
 * (`proposal_status_advances`, re-checked against the locked row), so a status
 * never goes backwards whatever this run's evidence says; the moved rows come
 * back with their old status. Pairs with a null status are not sent.
 */
export async function advanceProposalStatuses(db: Db, pairs: readonly StatusPair[]): Promise<AdvanceResult> {
  const out = emptyAdvance();
  const byId = new Map<string, StatusPair>();
  for (const p of pairs) {
    const prev = byId.get(p.id);
    // Two pairs for one bill: keep the one the rule would take over the other.
    if (!prev || statusAdvances(prev.status, p.status)) byId.set(p.id, p);
  }
  const list = [...byId.values()];
  for (let i = 0; i < list.length; i += BILL_CHUNK_SIZE) {
    const chunk = list.slice(i, i + BILL_CHUNK_SIZE);
    const { data, error } = await db.rpc("proposals_advance_status", {
      p_ids: chunk.map((p) => p.id),
      p_statuses: chunk.map((p) => p.status),
    });
    if (error) {
      console.error(`    bills.ts: proposals_advance_status chunk ${i}-${i + chunk.length}: ${error.message}`);
      out.failed += chunk.length;
      continue;
    }
    const via = new Map(chunk.map((p) => [p.id, p.via]));
    const rows = (data ?? []) as Array<{ id: string; from_status: ProposalStatus; to_status: ProposalStatus }>;
    for (const r of rows) out.moved.push({ id: r.id, from: r.from_status, to: r.to_status, via: via.get(r.id) ?? "?" });
    out.held += chunk.length - rows.length;
  }
  return out;
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
    console.info(
      `    bills.ts: bound ${out.bound.length} ref(s) to an existing bill_details key-holder instead of minting (FIX-1256): ` +
        out.bound.slice(0, 10).map(({ id, args }) => `${args.billKey}→${id}`).join(", "),
    );
  }
  return out;
}

/**
 * Every proposals column this sync owns EXCEPT `status`. Step 3 upserts this
 * onto existing bills; `status` reaches them only through
 * `advanceProposalStatuses` (FIX-1257 — the upsert used to overwrite it, which
 * is how a stage-less latest action knocked a passed bill back to introduced).
 */
function buildProposalRow(args: BillProposalArgs): Omit<ProposalInsert, "status"> {
  return {
    title: args.title.slice(0, 500),
    type: args.type,
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

/** A NEW bill's row: a status is required, and stage-less evidence mints as `introduced`. */
function buildProposalInsert(args: BillProposalArgs): ProposalInsert {
  return { ...buildProposalRow(args), status: args.status ?? "introduced" };
}

export async function upsertBillProposalsBatch(
  db: Db,
  items: BillProposalArgs[]
): Promise<BillBatchResult> {
  if (items.length === 0) return { upserted: 0, failed: 0, bound: 0, keyConflicts: [], status: emptyAdvance() };

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
    return { upserted: 0, failed: deduped.length, bound: 0, keyConflicts: [], status: emptyAdvance() };
  }

  const existingMap = new Map<string, string>();
  for (const r of existing) {
    existingMap.set(r.external_id, r.entity_id);
  }

  // Step 1b (FIX-1256): a key with no ref may still have its proposal — bind
  // a ref to its bill_details key-holder instead of minting beside it.
  const binding = await bindToKeyHolders(db, deduped.filter((i) => !existingMap.has(i.billKey)));
  if (binding === null) {
    return { upserted: 0, failed: deduped.length, bound: 0, keyConflicts: [], status: emptyAdvance() };
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
  //
  // FIX-1257: `status` is NOT in the upsert. Each chunk's evidence goes to
  // proposals_advance_status() after it, which moves a row only forward (the
  // rule in status-rank.ts); a null status (a stage-less latest action) is not
  // sent at all. The rest of the row is refreshed as before — `metadata`
  // included, replaced whole.
  const status = emptyAdvance();
  if (toUpdate.length > 0) {
    for (let i = 0; i < toUpdate.length; i += BILL_CHUNK_SIZE) {
      const chunk = toUpdate.slice(i, i + BILL_CHUNK_SIZE);
      const records = chunk.map(({ id, args }) => ({
        id,
        ...buildProposalRow(args),
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
      const pairs: StatusPair[] = [];
      for (const { id, args } of chunk) {
        if (args.status !== null) pairs.push({ id, status: args.status, via: "sync" });
      }
      if (pairs.length > 0) mergeAdvance(status, await advanceProposalStatuses(db, pairs));
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

  return { upserted, failed, bound, keyConflicts, status };
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
