/**
 * FIX-1238 — a roll whose bill has no `bill_details` row is landed once or
 * skipped with a count; it is never inserted to fail.
 *
 * `votes.bill_proposal_id` FKs to `bill_details(proposal_id)`, but the vote
 * writer resolves a roll's bill through `external_source_refs` alone
 * (`resolveBillsBatch`), which never checks that the resolved proposal HAS a
 * `bill_details` row. Two ways it can lack one:
 *
 *   (a) the proposal already had an xsr ref, so `upsertBillProposalsBatch`
 *       took its `toUpdate` branch — which writes `proposals` only and never
 *       back-fills `bill_details`;
 *   (b) the compound unique `(jurisdiction_id, session, bill_number)` is held
 *       by a DIFFERENT proposal, so the `ignoreDuplicates` upsert wrote nothing
 *       while the new ref bound the bill key to the new id. FIX-1256 stops (b)
 *       at the source — the batch writer binds the ref to the holder before
 *       it mints — and repaired the three live pairs; the guard still catches
 *       any that predate it.
 *
 * Either way the whole roll (~433 rows for `2026-house-295`) was inserted,
 * failed `votes_bill_proposal_id_fkey`, and rolled back — every night, because
 * a failed roll is not in the pre-loaded `roll_call_id` set and is re-fetched.
 * That rollback was the entire source of `votes` dead-tuple growth.
 *
 * Now: ONE batched read of which resolved proposals have a `bill_details` row;
 * each one that does not gets ONE targeted landing (case a lands; case b is a
 * 23505 on the compound key, logged with BOTH proposal ids and left for a
 * human — which of two proposals is the real bill is not a code decision);
 * whatever is still absent is SKIPPED with a counted log line and recorded in
 * the run's `data_sync_log.metadata.skipped_rolls[]` and `rows_failed`.
 *
 * Pure over its injected deps so the matrix is assertable without a database
 * (`vote-bill-guard.test.ts`).
 */

import type { BillProposalArgs } from "./bills";

export type SkipReason = "bill_details_key_collision" | "bill_details_landing_failed";

/** A bill a roll references whose proposal still has no `bill_details` row after the landing. */
export interface AbsentBill {
  bill_key: string;
  proposal_id: string;
  reason: SkipReason;
  /** Case (b): the proposal that holds `(jurisdiction_id, session, bill_number)`. */
  holder_proposal_id: string | null;
  detail: string | null;
}

/** One entry of `data_sync_log.metadata.skipped_rolls[]`. */
export interface SkippedRoll {
  roll: string;
  bill_key: string;
  proposal_id: string;
  reason: SkipReason;
  holder_proposal_id: string | null;
}

export type LandResult =
  | { status: "landed" }
  | { status: "collision"; holderProposalId: string | null }
  | { status: "failed"; message: string };

export interface BillDetailsGuardDeps {
  /** Which of `ids` have a `bill_details` row. Throws when it cannot be read. */
  presentIds(ids: string[]): Promise<Set<string>>;
  /** One targeted landing of a `bill_details` row for an existing proposal. */
  land(proposalId: string, args: BillProposalArgs): Promise<LandResult>;
  log(line: string): void;
}

export function skipLine(rollCallId: string, a: AbsentBill): string {
  const base =
    `    skipped roll ${rollCallId}: bill ${a.bill_key} has no bill_details row (proposal ${a.proposal_id})`;
  if (a.reason === "bill_details_key_collision") {
    return (
      base +
      ` — (jurisdiction_id, session, bill_number) is held by proposal ${a.holder_proposal_id ?? "(unknown)"};` +
      ` which one is the bill is left for a human (FIX-1238 case b)`
    );
  }
  return base + (a.detail ? ` — landing failed: ${a.detail}` : "");
}

/**
 * Return every bill key (among `usedKeys`) whose resolved proposal still has
 * no `bill_details` row after one targeted landing attempt.
 *
 * FAILS OPEN on a read error: if the presence read throws, the guard logs it
 * and returns an empty map, so the writer behaves exactly as it did before
 * FIX-1238 (attempt the insert, log the FK error). A transient read failure
 * must not turn into "skip every roll tonight".
 */
export async function guardBillDetails(
  usedKeys: Iterable<string | null>,
  keyToId: ReadonlyMap<string, string | null>,
  billArgs: ReadonlyMap<string, BillProposalArgs>,
  deps: BillDetailsGuardDeps,
): Promise<Map<string, AbsentBill>> {
  const absent = new Map<string, AbsentBill>();
  const keyById = new Map<string, string[]>();
  for (const k of usedKeys) {
    if (!k) continue;
    const id = keyToId.get(k);
    if (!id) continue;
    const ks = keyById.get(id) ?? [];
    if (!ks.includes(k)) ks.push(k);
    keyById.set(id, ks);
  }
  const ids = [...keyById.keys()];
  if (ids.length === 0) return absent;

  let present: Set<string>;
  try {
    present = await deps.presentIds(ids);
  } catch (err) {
    deps.log(
      `  ⚠ FIX-1238: bill_details presence read failed (${errText(err)}) — ` +
        `proceeding without the guard; an FK failure will be logged as before`,
    );
    return absent;
  }

  const missing = ids.filter((id) => !present.has(id));
  if (missing.length === 0) return absent;

  const landed: string[] = [];
  for (const id of missing) {
    const key = keyById.get(id)![0]!;
    const args = billArgs.get(key);
    deps.log(`    FIX-1238: bill ${key} (proposal ${id}) has no bill_details row — one targeted landing`);
    let r: LandResult;
    if (!args) {
      r = { status: "failed", message: "no bill args buffered for this key" };
    } else {
      try {
        r = await deps.land(id, args);
      } catch (err) {
        r = { status: "failed", message: errText(err) };
      }
    }
    // A 23505 whose holder IS this proposal means the row appeared between the
    // read and the insert — it is present, not a collision.
    if (r.status === "collision" && r.holderProposalId === id) r = { status: "landed" };

    if (r.status === "landed") {
      landed.push(id);
      deps.log(`      landed bill_details for ${key}`);
      continue;
    }
    const entry: AbsentBill =
      r.status === "collision"
        ? {
            bill_key: key,
            proposal_id: id,
            reason: "bill_details_key_collision",
            holder_proposal_id: r.holderProposalId,
            detail: null,
          }
        : {
            bill_key: key,
            proposal_id: id,
            reason: "bill_details_landing_failed",
            holder_proposal_id: null,
            detail: r.message,
          };
    deps.log(
      r.status === "collision"
        ? `      collision: (jurisdiction_id, session, bill_number) for ${key} is held by proposal ` +
            `${r.holderProposalId ?? "(unknown)"}, not ${id} — left for a human`
        : `      landing failed for ${key}: ${r.message}`,
    );
    for (const k of keyById.get(id)!) absent.set(k, { ...entry, bill_key: k });
  }

  // Re-check what was landed: a landing that reported success but is not
  // visible is still absent, and inserting against it would fail the FK.
  if (landed.length > 0) {
    let again: Set<string> | null = null;
    try {
      again = await deps.presentIds(landed);
    } catch (err) {
      deps.log(`  ⚠ FIX-1238: re-check read failed (${errText(err)}) — trusting the landing`);
    }
    if (again) {
      for (const id of landed) {
        if (again.has(id)) continue;
        for (const k of keyById.get(id)!) {
          absent.set(k, {
            bill_key: k,
            proposal_id: id,
            reason: "bill_details_landing_failed",
            holder_proposal_id: null,
            detail: "landed but not visible on re-check",
          });
        }
      }
    }
  }
  return absent;
}

export interface RollForWrite {
  rollCallId: string;
  billKey: string | null;
  votedAt: string | null;
}

export interface InsertFailure {
  roll: string;
  code: string | null;
  message: string;
}

export interface WriteRollsDeps<R extends RollForWrite, V> {
  proposalIdFor(billKey: string | null): string | null;
  absent: ReadonlyMap<string, AbsentBill>;
  /** Build the roll's vote rows. Called only for a roll that will be inserted. */
  build(roll: R, proposalId: string, votedAtIso: string): V[];
  insert(records: V[]): Promise<{ error: { code?: string | null; message: string } | null }>;
  log(line: string): void;
}

export interface WriteRollsResult {
  inserted: number;
  skipped: SkippedRoll[];
  insertFailures: InsertFailure[];
}

/**
 * Pass 2 of each chamber: write every buffered roll. A roll whose bill is in
 * `absent` is skipped BEFORE any row is built — no `.insert` call is made for
 * it — and counted. Everything else is exactly the pre-FIX-1238 behaviour.
 */
export async function writeRollVotes<R extends RollForWrite, V>(
  rolls: readonly R[],
  deps: WriteRollsDeps<R, V>,
): Promise<WriteRollsResult> {
  const out: WriteRollsResult = { inserted: 0, skipped: [], insertFailures: [] };
  for (const roll of rolls) {
    const proposalId = deps.proposalIdFor(roll.billKey);
    if (!proposalId) {
      deps.log(`    ${roll.rollCallId}: no proposal reference, skipping vote records`);
      continue;
    }
    if (!roll.votedAt) {
      deps.log(`    ${roll.rollCallId}: no voted_at, skipping (column is NOT NULL)`);
      continue;
    }
    const a = roll.billKey ? deps.absent.get(roll.billKey) : undefined;
    if (a) {
      deps.log(skipLine(roll.rollCallId, a));
      out.skipped.push({
        roll: roll.rollCallId,
        bill_key: a.bill_key,
        proposal_id: a.proposal_id,
        reason: a.reason,
        holder_proposal_id: a.holder_proposal_id,
      });
      continue;
    }
    const records = deps.build(roll, proposalId, new Date(roll.votedAt).toISOString());
    if (records.length === 0) {
      deps.log(`    ${roll.rollCallId}: no matchable vote records`);
      continue;
    }
    const { error } = await deps.insert(records);
    if (error && error.code !== "23505") {
      deps.log(`    ${roll.rollCallId}: insert error — ${error.message}`);
      out.insertFailures.push({ roll: roll.rollCallId, code: error.code ?? null, message: error.message });
    } else if (error?.code === "23505") {
      deps.log(`    ${roll.rollCallId}: unique violation on (roll_call_id, official_id)`);
    } else {
      out.inserted += records.length;
      deps.log(`    ${roll.rollCallId}: inserted ${records.length} votes`);
    }
  }
  return out;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
