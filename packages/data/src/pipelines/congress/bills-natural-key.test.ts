/**
 * FIX-1256 — a bill with no congress_gov ref but a bill_details key-holder is
 * BOUND to that holder, never minted beside it.
 *
 * The shape this exists to stop: the 08-04 recent-bills sync wrote proposals +
 * bill_details for 18 House bills and lost the refs write to a statement
 * timeout. Every later ingest of three of them (HR 4795 / 9816 / 9847) found no
 * ref, minted a new proposal, had its bill_details row silently dropped by the
 * `ignoreDuplicates` upsert on the natural key, and bound the ref to the new
 * stub — so roll 2026-house-295 references a proposal with no bill_details row.
 *
 * The fake below is a small in-memory PostgREST that ENFORCES the two unique
 * keys that matter — external_source_refs (source, external_id) and
 * bill_details (jurisdiction_id, session, bill_number) — with the same
 * ON CONFLICT DO NOTHING semantics, so the pre-fix code reproduces the stub on
 * the pass-2 fixture (test 2 fails against it) rather than passing vacuously.
 *
 * No DB, no network: runs in the default `pnpm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  upsertBillProposalsBatch,
  resolveBillsBatch,
  advanceProposalStatuses,
  type BillProposalArgs,
} from "./bills";
import { mapBillStatus, rollPassageAdvances } from "./bill-status";
import { statusAdvances, type ProposalStatus } from "./status-rank";

type Row = Record<string, unknown>;

interface FakeState {
  proposals: Row[];
  bill_details: Row[];
  external_source_refs: Row[];
  /** Tables whose reads return an error, to prove the writer fails closed. */
  failReads?: Set<string>;
  /** Called after each bill_details read — lets a test take a key mid-run. */
  afterBillDetailsRead?: (state: FakeState) => void;
  nextId: number;
  /** FIX-1257: every rpc call, in order. */
  rpcCalls?: Array<{ name: string; args: Record<string, unknown> }>;
}

const UNIQUE: Record<string, string[][]> = {
  proposals: [["id"]],
  bill_details: [["proposal_id"], ["jurisdiction_id", "session", "bill_number"]],
  external_source_refs: [["source", "external_id"]],
};

function conflicts(state: FakeState, table: string, row: Row, keys: string[][]): Row | undefined {
  const rows = state[table as "proposals"] as Row[];
  return rows.find((r) => keys.some((k) => k.every((c) => r[c] === row[c])));
}

function fakeDb(state: FakeState) {
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    const read = () => {
      if (state.failReads?.has(table)) {
        return { data: null, error: { message: `fake read failure on ${table}` } };
      }
      const rows = (state[table as "proposals"] as Row[]).filter((r) => filters.every((f) => f(r)));
      if (table === "bill_details") state.afterBillDetailsRead?.(state);
      return { data: rows.map((r) => ({ ...r })), error: null };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: any = {
      select: () => q,
      eq: (col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        return q;
      },
      in: (col: string, vals: unknown[]) => {
        filters.push((r) => vals.includes(r[col]));
        return q;
      },
      maybeSingle: () => {
        const res = read();
        return Promise.resolve({ data: res.data?.[0] ?? null, error: res.error });
      },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
        Promise.resolve(read()).then(ok, bad),
      insert: (input: Row | Row[]) => {
        const rows = Array.isArray(input) ? input : [input];
        const inserted: Row[] = [];
        for (const r of rows) {
          const row = { ...r };
          if (table === "proposals" && !row.id) row.id = `minted-${state.nextId++}`;
          if (conflicts(state, table, row, UNIQUE[table] ?? [])) {
            const res = { data: null, error: { code: "23505", message: "duplicate key" } };
            return { select: () => Promise.resolve(res), then: (ok: (v: unknown) => unknown) => Promise.resolve(res).then(ok) };
          }
          (state[table as "proposals"] as Row[]).push(row);
          inserted.push(row);
        }
        const res = { data: inserted.map((r) => ({ id: r.id, proposal_id: r.proposal_id })), error: null };
        return {
          select: () => Promise.resolve(res),
          then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok),
        };
      },
      upsert: (input: Row[], opts: { onConflict: string; ignoreDuplicates?: boolean }) => {
        const target = opts.onConflict.split(",");
        const written: Row[] = [];
        for (const r of input) {
          const row = { ...r };
          // ON CONFLICT (target) — and, as in Postgres, ANY unique violation
          // not covered by DO NOTHING's target is still an error; the tables
          // here only ever conflict on the target, so treat all as the target.
          const hit = conflicts(state, table, row, UNIQUE[table] ?? []);
          if (hit) {
            if (opts.ignoreDuplicates) continue;
            if (target.every((c) => hit[c] === row[c])) Object.assign(hit, row);
            written.push(hit);
            continue;
          }
          (state[table as "proposals"] as Row[]).push(row);
          written.push(row);
        }
        const res = { data: written.map((r) => ({ ...r })), error: null };
        return {
          select: () => Promise.resolve(res),
          then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok),
        };
      },
    };
    return q;
  };
  // FIX-1257: `proposals_advance_status` is modelled — each pair moves its
  // proposal only when the rule (the TS twin of the SQL one) says so, and the
  // moved rows come back as the RPC returns them. Every other rpc (the FIX-397
  // primary_source refresh) is the old no-op.
  const rpc = (name: string, args: Record<string, unknown>) => {
    (state.rpcCalls ??= []).push({ name, args });
    if (name !== "proposals_advance_status") return Promise.resolve({ data: 0, error: null });
    const ids = args.p_ids as string[];
    const statuses = args.p_statuses as ProposalStatus[];
    const moved: Array<{ id: string; from_status: ProposalStatus | null; to_status: ProposalStatus }> = [];
    ids.forEach((id, i) => {
      const p = state.proposals.find((r) => r.id === id);
      if (!p) return;
      const from = (p.status as ProposalStatus | undefined) ?? null;
      if (!statusAdvances(from, statuses[i]!)) return;
      p.status = statuses[i];
      moved.push({ id, from_status: from, to_status: statuses[i]! });
    });
    return Promise.resolve({ data: moved, error: null });
  };
  return { from, rpc };
}

const FED = "fed-jurisdiction";

function bill(number: number, title = `Bill ${number}`): BillProposalArgs {
  return {
    billKey: `119-HR-${number}`,
    title,
    billNumber: `HR ${number}`,
    billType: "HR",
    chamber: "house",
    type: "bill",
    status: "introduced",
    jurisdictionId: FED,
    governingBodyId: "house-body",
    congressGovUrl: `https://congress.gov/bill/119th-congress/house-bill/${number}`,
    introducedAt: null,
    lastActionAt: null,
    congressNumber: 119,
    session: "119",
  };
}

function holderState(): FakeState {
  // Two proposals that already exist: 'held' has a ref AND its key; 'orphan'
  // holds HR 4795's key and has NO ref (the 08-04 shape).
  return {
    nextId: 1,
    proposals: [
      { id: "held", title: "Held bill" },
      { id: "orphan", title: "Protect Economic and Academic Freedom Act of 2025" },
    ],
    bill_details: [
      { proposal_id: "held", jurisdiction_id: FED, session: "119", bill_number: "HR 100" },
      { proposal_id: "orphan", jurisdiction_id: FED, session: "119", bill_number: "HR 4795" },
    ],
    external_source_refs: [
      { source: "congress_gov", external_id: "119-HR-100", entity_type: "proposal", entity_id: "held" },
    ],
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asDb = (s: FakeState) => fakeDb(s) as any;

const refFor = (s: FakeState, key: string) =>
  s.external_source_refs.find((r) => r.source === "congress_gov" && r.external_id === key)?.entity_id;

test("1. a key with a ref resolves through pass 1 — updated, nothing minted, no new ref", async () => {
  const s = holderState();
  const res = await upsertBillProposalsBatch(asDb(s), [bill(100, "Held bill, retitled")]);
  assert.equal(s.proposals.length, 2);
  assert.equal(s.external_source_refs.length, 1);
  assert.equal(s.proposals.find((p) => p.id === "held")!.title, "Held bill, retitled");
  assert.deepEqual({ upserted: res.upserted, failed: res.failed, bound: res.bound }, { upserted: 1, failed: 0, bound: 0 });
});

test("2. no ref but a bill_details key-holder → the ref binds to the HOLDER; no stub is minted", async () => {
  const s = holderState();
  const res = await upsertBillProposalsBatch(asDb(s), [bill(4795, "Protect Economic and Academic Freedom Act of 2026")]);
  assert.equal(s.proposals.length, 2, "no proposal minted");
  assert.equal(refFor(s, "119-HR-4795"), "orphan", "the ref is on the key-holder");
  assert.equal(s.bill_details.length, 2, "no second bill_details row");
  assert.equal(
    s.proposals.find((p) => p.id === "orphan")!.title,
    "Protect Economic and Academic Freedom Act of 2026",
    "the bound holder is refreshed through the update path",
  );
  assert.equal(res.bound, 1);
  assert.equal(res.failed, 0);
  assert.deepEqual(res.keyConflicts, []);
});

test("3. neither a ref nor a holder → minted, with its ref and its bill_details row", async () => {
  const s = holderState();
  const res = await upsertBillProposalsBatch(asDb(s), [bill(777)]);
  assert.equal(s.proposals.length, 3);
  const minted = refFor(s, "119-HR-777");
  assert.ok(minted && String(minted).startsWith("minted-"));
  assert.ok(s.bill_details.some((b) => b.proposal_id === minted && b.bill_number === "HR 777"));
  assert.deepEqual({ upserted: res.upserted, failed: res.failed, bound: res.bound }, { upserted: 1, failed: 0, bound: 0 });
});

test("4. the holder already carries a DIFFERENT congress_gov ref → logged and counted, neither bound nor minted", async () => {
  const s = holderState();
  s.external_source_refs.push({ source: "congress_gov", external_id: "119-HR-4795-OLD", entity_type: "proposal", entity_id: "orphan" });
  const res = await upsertBillProposalsBatch(asDb(s), [bill(4795)]);
  assert.equal(s.proposals.length, 2, "not minted");
  assert.equal(refFor(s, "119-HR-4795"), undefined, "not bound");
  assert.equal(res.failed, 1);
  assert.deepEqual(res.keyConflicts, [
    { bill_key: "119-HR-4795", reason: "holder_has_other_ref", holder_proposal_id: "orphan", holder_external_id: "119-HR-4795-OLD" },
  ]);
});

test("5. a key taken between the natural-key read and the write → counted with both ids; the minted row does NOT get the ref", async () => {
  const s = holderState();
  let reads = 0;
  s.afterBillDetailsRead = (st) => {
    // The first bill_details read is Step 1b's; a concurrent writer takes HR 888 right after it.
    if (++reads === 1) {
      st.proposals.push({ id: "racer" });
      st.bill_details.push({ proposal_id: "racer", jurisdiction_id: FED, session: "119", bill_number: "HR 888" });
    }
  };
  const res = await upsertBillProposalsBatch(asDb(s), [bill(888)]);
  assert.equal(res.failed, 1);
  assert.equal(res.keyConflicts.length, 1);
  const c = res.keyConflicts[0]!;
  assert.equal(c.reason, "bill_details_key_conflict");
  assert.equal(c.holder_proposal_id, "racer");
  assert.ok(c.minted_proposal_id?.startsWith("minted-"));
  assert.equal(refFor(s, "119-HR-888"), undefined, "the ref is kept off the minted row — the next run binds it to the holder");
});

test("6. a failed natural-key read fails the batch closed — nothing is minted blind", async () => {
  const s = holderState();
  s.failReads = new Set(["bill_details"]);
  const res = await upsertBillProposalsBatch(asDb(s), [bill(4795), bill(777)]);
  assert.equal(s.proposals.length, 2);
  assert.equal(s.external_source_refs.length, 1);
  assert.deepEqual({ upserted: res.upserted, failed: res.failed }, { upserted: 0, failed: 2 });
});

test("7. resolveBillsBatch returns the HOLDER for a ref-less key and hands conflicts to the caller", async () => {
  const s = holderState();
  s.proposals.push({ id: "renumbered" });
  s.bill_details.push({ proposal_id: "renumbered", jurisdiction_id: FED, session: "119", bill_number: "HR 5000" });
  s.external_source_refs.push({ source: "congress_gov", external_id: "119-HR-5000-X", entity_type: "proposal", entity_id: "renumbered" });
  const conflicts: unknown[] = [];
  const map = await resolveBillsBatch(
    asDb(s),
    new Map([bill(100), bill(4795), bill(777), bill(5000)].map((b) => [b.billKey, b])),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    conflicts as any,
  );
  assert.equal(map.get("119-HR-100"), "held");
  assert.equal(map.get("119-HR-4795"), "orphan");
  assert.ok(String(map.get("119-HR-777")).startsWith("minted-"));
  assert.equal(map.get("119-HR-5000"), null);
  assert.equal(conflicts.length, 1);
  assert.equal(s.proposals.length, 3 + 1, "only HR 777 was minted");
  // The vote path's args are placeholders (title = the bill number): a bound
  // holder's row must not be overwritten with them.
  assert.equal(s.proposals.find((p) => p.id === "orphan")!.title, "Protect Economic and Academic Freedom Act of 2025");
});

test("7b. a failed natural-key read in the resolver throws — the chamber's votes are not written against a guess", async () => {
  const s = holderState();
  s.failReads = new Set(["bill_details"]);
  await assert.rejects(
    resolveBillsBatch(asDb(s), new Map([[bill(4795).billKey, bill(4795)]])),
    /natural-key-holders/,
  );
  assert.equal(s.proposals.length, 2);
});

test("8. a second run over the same keys is a no-op", async () => {
  const s = holderState();
  await upsertBillProposalsBatch(asDb(s), [bill(4795), bill(777)]);
  const before = JSON.stringify([s.proposals.length, s.bill_details.length, s.external_source_refs.length]);
  const res = await upsertBillProposalsBatch(asDb(s), [bill(4795), bill(777)]);
  assert.equal(JSON.stringify([s.proposals.length, s.bill_details.length, s.external_source_refs.length]), before);
  assert.deepEqual({ failed: res.failed, bound: res.bound }, { failed: 0, bound: 0 });
});

// ---------------------------------------------------------------------------
// FIX-1257 — a status only ever advances (Step 3 and the vote path)
// ---------------------------------------------------------------------------

/** One existing bill, HR 4795, holding its ref and its key, at `status`. */
function statusState(status: ProposalStatus): FakeState {
  return {
    nextId: 1,
    proposals: [{ id: "hr4795", title: "Protect Economic and Academic Freedom Act of 2025", status }],
    bill_details: [{ proposal_id: "hr4795", jurisdiction_id: FED, session: "119", bill_number: "HR 4795" }],
    external_source_refs: [
      { source: "congress_gov", external_id: "119-HR-4795", entity_type: "proposal", entity_id: "hr4795" },
    ],
  };
}

/** The recent-bills sync's args for HR 4795 with `text` as its latest action. */
function synced(text: string): BillProposalArgs {
  return { ...bill(4795), status: mapBillStatus(text), latestActionText: text };
}

const advanceCalls = (s: FakeState) => (s.rpcCalls ?? []).filter((c) => c.name === "proposals_advance_status");
const statusOf = (s: FakeState, id: string) => s.proposals.find((p) => p.id === id)!.status;

test("9 (a). a passed_chamber bill re-synced with 'Motion to reconsider…' keeps passed_chamber — the text proves no stage, so nothing is asked", async () => {
  const s = statusState("passed_chamber");
  const res = await upsertBillProposalsBatch(asDb(s), [synced("Motion to reconsider laid on the table Agreed to without objection.")]);
  assert.equal(statusOf(s, "hr4795"), "passed_chamber");
  assert.equal(advanceCalls(s).length, 0, "a null status is not sent");
  assert.deepEqual({ moved: res.status.moved.length, held: res.status.held }, { moved: 0, held: 0 });
  assert.equal(res.upserted, 1, "the rest of the row is still refreshed");
  assert.equal(
    (s.proposals[0]!.metadata as Record<string, unknown>).latest_action,
    "Motion to reconsider laid on the table Agreed to without objection.",
  );
});

test("9 (a'). a LOWER stage ('Received in the Senate and … referred to' → in_committee) is asked and HELD", async () => {
  const s = statusState("passed_chamber");
  const res = await upsertBillProposalsBatch(asDb(s), [
    synced("Received in the Senate and Read twice and referred to the Committee on Health, Education, Labor, and Pensions."),
  ]);
  assert.equal(statusOf(s, "hr4795"), "passed_chamber");
  assert.equal(advanceCalls(s).length, 1);
  assert.deepEqual({ moved: res.status.moved.length, held: res.status.held }, { moved: 0, held: 1 });
});

test("10 (b). in_committee → a 'Passed House' text advances to passed_chamber", async () => {
  const s = statusState("in_committee");
  const res = await upsertBillProposalsBatch(asDb(s), [
    synced("Passed/agreed to in House: On passage Passed by the Yeas and Nays: 237 - 169 (Roll no. 295)."),
  ]);
  assert.equal(statusOf(s, "hr4795"), "passed_chamber");
  assert.deepEqual(res.status.moved, [{ id: "hr4795", from: "in_committee", to: "passed_chamber", via: "sync" }]);
  assert.equal(res.status.held, 0);
});

test("11 (c). the status is NOT in Step 3's upsert payload (the pre-FIX-1257 shape wrote it and regressed 9 (a))", async () => {
  const s = statusState("passed_chamber");
  const seen: Row[] = [];
  const db = asDb(s);
  const from = db.from;
  db.from = (table: string) => {
    const q = from(table);
    if (table !== "proposals") return q;
    const upsert = q.upsert;
    q.upsert = (rows: Row[], opts: unknown) => {
      seen.push(...rows);
      return upsert(rows, opts);
    };
    return q;
  };
  await upsertBillProposalsBatch(db, [synced("Motion to reconsider laid on the table Agreed to without objection.")]);
  assert.equal(seen.length, 1);
  assert.ok(!("status" in seen[0]!), `Step 3 upserted status=${String(seen[0]!.status)}`);
});

test("12 (d). the vote path: a passed passage roll on an existing in_committee holder advances it", async () => {
  const s = statusState("in_committee");
  // The vote path's args are placeholders (the bill number as title, the mint
  // status from mapVoteResult); resolving must not touch the holder's row.
  const voteArgs: BillProposalArgs = { ...bill(4795, "HR 4795"), status: "passed_chamber" };
  const ids = await resolveBillsBatch(asDb(s), new Map([[voteArgs.billKey, voteArgs]]));
  assert.equal(ids.get("119-HR-4795"), "hr4795");
  assert.equal(statusOf(s, "hr4795"), "in_committee", "resolution alone does not write status");
  const res = await advanceProposalStatuses(
    asDb(s),
    rollPassageAdvances(
      [{ rollCallId: "2026-house-295", billKey: "119-HR-4795", voteQuestion: "On Passage", resultStr: "Passed" }],
      (k) => (k ? (ids.get(k) ?? null) : null),
    ),
  );
  assert.equal(statusOf(s, "hr4795"), "passed_chamber");
  assert.deepEqual(res, { moved: [{ id: "hr4795", from: "in_committee", to: "passed_chamber", via: "2026-house-295" }], held: 0, failed: 0 });
});

test("13 (e). a FAILED roll — passage or procedural — changes nothing on an existing bill", async () => {
  const s = statusState("in_committee");
  const res = await advanceProposalStatuses(
    asDb(s),
    rollPassageAdvances(
      [
        { rollCallId: "2026-house-300", billKey: "119-HR-4795", voteQuestion: "On Passage", resultStr: "Failed" },
        { rollCallId: "2026-house-301", billKey: "119-HR-4795", voteQuestion: "On Motion to Recommit", resultStr: "Failed" },
        { rollCallId: "2026-house-302", billKey: "119-HR-4795", voteQuestion: "On Motion to Recommit", resultStr: "Passed" },
      ],
      () => "hr4795",
    ),
  );
  assert.equal(statusOf(s, "hr4795"), "in_committee");
  assert.equal(advanceCalls(s).length, 0);
  assert.deepEqual(res, { moved: [], held: 0, failed: 0 });
});

test("14. a NEW bill with a stage-less latest action is minted as introduced", async () => {
  const s = holderState();
  await upsertBillProposalsBatch(asDb(s), [{ ...bill(901), status: mapBillStatus("Held at the desk."), latestActionText: "Held at the desk." }]);
  const minted = refFor(s, "119-HR-901");
  assert.equal(s.proposals.find((p) => p.id === minted)!.status, "introduced");
});
