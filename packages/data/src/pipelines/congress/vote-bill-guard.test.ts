/**
 * FIX-1238 — a roll whose bill has no `bill_details` row is landed once or
 * skipped with a count; it is never inserted to fail the FK.
 *
 * The prod shape (2026-09-30): roll `2026-house-295` references `119-HR-4795`,
 * whose xsr ref binds proposal d536667f… (created 08-28, no bill_details row),
 * while proposal 0e2433b5… (created 08-04, no xsr ref) holds the compound key
 * `(federal, 119, HR 4795)`. That is case (b): the targeted landing hits 23505
 * and the roll is skipped with BOTH ids logged.
 *
 * Runs via:  tsx --test src/pipelines/congress/vote-bill-guard.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  guardBillDetails,
  writeRollVotes,
  skipLine,
  type BillDetailsGuardDeps,
  type LandResult,
  type RollForWrite,
} from "./vote-bill-guard";
import type { BillProposalArgs } from "./bills";

const PRESENT_KEY = "119-HR-1";
const ABSENT_KEY = "119-HR-4795";
const PRESENT_ID = "11111111-1111-1111-1111-111111111111";
const ABSENT_ID = "d536667f-6a0d-4aeb-b1b9-324c946b4701";
const HOLDER_ID = "0e2433b5-0fd3-4e27-a3ae-9741c468122d";

function args(billKey: string): BillProposalArgs {
  const [, type, number] = billKey.split("-");
  return {
    billKey,
    title: `${type} ${number}`,
    billNumber: `${type} ${number}`,
    billType: type!,
    chamber: "house",
    type: "bill",
    status: "introduced",
    jurisdictionId: "eb075dd5-038f-4b21-82f7-30f5c9e1d49a",
    governingBodyId: "6dc41b0b-98c9-4d06-9148-cc911b67b718",
    congressGovUrl: "https://congress.gov/bill/119th-congress/house-bill/" + number,
    introducedAt: null,
    lastActionAt: null,
    congressNumber: 119,
    session: "119",
  };
}

const keyToId = new Map<string, string | null>([
  [PRESENT_KEY, PRESENT_ID],
  [ABSENT_KEY, ABSENT_ID],
]);
const billArgs = new Map([
  [PRESENT_KEY, args(PRESENT_KEY)],
  [ABSENT_KEY, args(ABSENT_KEY)],
]);

interface Harness {
  deps: BillDetailsGuardDeps;
  lines: string[];
  landCalls: string[];
  presentCalls: string[][];
}

function harness(opts: {
  present: Set<string>;
  land: (id: string) => LandResult;
  /** ids the landing makes visible on the re-check. */
  afterLand?: Set<string>;
  throwOnRead?: boolean;
}): Harness {
  const lines: string[] = [];
  const landCalls: string[] = [];
  const presentCalls: string[][] = [];
  const landed = new Set<string>();
  return {
    lines,
    landCalls,
    presentCalls,
    deps: {
      presentIds: async (ids) => {
        presentCalls.push([...ids]);
        if (opts.throwOnRead) throw new Error("gateway 502");
        return new Set(ids.filter((id) => opts.present.has(id) || (landed.has(id) && (opts.afterLand ?? new Set()).has(id))));
      },
      land: async (id) => {
        landCalls.push(id);
        const r = opts.land(id);
        // A self-held 23505 means the row IS there (it appeared in the race).
        if (r.status === "landed" || (r.status === "collision" && r.holderProposalId === id)) landed.add(id);
        return r;
      },
      log: (l) => lines.push(l),
    },
  };
}

interface Roll extends RollForWrite {
  members: string[];
}
const rolls: Roll[] = [
  { rollCallId: "2026-house-100", billKey: PRESENT_KEY, votedAt: "2026-09-03", members: ["a", "b", "c"] },
  { rollCallId: "2026-house-295", billKey: ABSENT_KEY, votedAt: "2026-09-03", members: ["a", "b", "c", "d"] },
];

async function write(absent: Awaited<ReturnType<typeof guardBillDetails>>) {
  const inserts: string[][] = [];
  const lines: string[] = [];
  const res = await writeRollVotes<Roll, { roll: string; m: string; p: string }>(rolls, {
    proposalIdFor: (k) => (k ? (keyToId.get(k) ?? null) : null),
    absent,
    build: (roll, proposalId) => roll.members.map((m) => ({ roll: roll.rollCallId, m, p: proposalId })),
    insert: async (records) => {
      inserts.push(records.map((r) => r.roll));
      return { error: null };
    },
    log: (l) => lines.push(l),
  });
  return { res, inserts, lines };
}

test("two rolls: the PRESENT-bill roll inserts and counts; the absent one whose landing fails is skipped with no .insert call", async () => {
  const h = harness({
    present: new Set([PRESENT_ID]),
    land: () => ({ status: "failed", message: "permission denied for table bill_details" }),
  });
  const absent = await guardBillDetails(rolls.map((r) => r.billKey), keyToId, billArgs, h.deps);

  assert.deepEqual(h.presentCalls[0]!.sort(), [ABSENT_ID, PRESENT_ID].sort(), "ONE batched presence read covering both");
  assert.deepEqual(h.landCalls, [ABSENT_ID], "exactly one targeted landing, for the absent bill only");
  assert.equal(absent.size, 1);
  assert.equal(absent.get(ABSENT_KEY)!.reason, "bill_details_landing_failed");

  const { res, inserts, lines } = await write(absent);
  assert.equal(res.inserted, 3, "the present-bill roll's 3 rows count (rule 105: it must still insert)");
  assert.deepEqual(inserts, [["2026-house-100", "2026-house-100", "2026-house-100"]], "no insert for 295");
  assert.equal(res.skipped.length, 1);
  assert.deepEqual(res.skipped[0], {
    roll: "2026-house-295",
    bill_key: ABSENT_KEY,
    proposal_id: ABSENT_ID,
    reason: "bill_details_landing_failed",
    holder_proposal_id: null,
  });
  assert.ok(
    lines.some((l) =>
      l.includes(`skipped roll 2026-house-295: bill ${ABSENT_KEY} has no bill_details row (proposal ${ABSENT_ID})`),
    ),
    "the counted skip line names roll, bill and proposal",
  );
});

test("case (b): a compound-key collision logs BOTH proposal ids and skips — it is not resolved", async () => {
  const h = harness({
    present: new Set([PRESENT_ID]),
    land: () => ({ status: "collision", holderProposalId: HOLDER_ID }),
  });
  const absent = await guardBillDetails(rolls.map((r) => r.billKey), keyToId, billArgs, h.deps);
  const a = absent.get(ABSENT_KEY)!;
  assert.equal(a.reason, "bill_details_key_collision");
  assert.equal(a.holder_proposal_id, HOLDER_ID);
  assert.ok(h.lines.some((l) => l.includes(HOLDER_ID) && l.includes(ABSENT_ID)), "landing log names both ids");

  const { res, inserts, lines } = await write(absent);
  assert.equal(inserts.length, 1, "only the present-bill roll is inserted");
  assert.equal(res.skipped[0]!.holder_proposal_id, HOLDER_ID);
  const skip = lines.find((l) => l.includes("skipped roll 2026-house-295"))!;
  assert.ok(skip.includes(ABSENT_ID) && skip.includes(HOLDER_ID), "skip line names both ids");
});

test("case (a): the targeted landing succeeds and is visible on re-check → the roll inserts, nothing is skipped", async () => {
  const h = harness({
    present: new Set([PRESENT_ID]),
    land: () => ({ status: "landed" }),
    afterLand: new Set([ABSENT_ID]),
  });
  const absent = await guardBillDetails(rolls.map((r) => r.billKey), keyToId, billArgs, h.deps);
  assert.equal(absent.size, 0);
  assert.deepEqual(h.presentCalls[1], [ABSENT_ID], "the landed id is re-checked");
  const { res, inserts } = await write(absent);
  assert.equal(res.inserted, 7);
  assert.equal(inserts.length, 2);
  assert.equal(res.skipped.length, 0);
});

test("a landing that reports success but is not visible on re-check is still skipped", async () => {
  const h = harness({ present: new Set([PRESENT_ID]), land: () => ({ status: "landed" }), afterLand: new Set() });
  const absent = await guardBillDetails(rolls.map((r) => r.billKey), keyToId, billArgs, h.deps);
  assert.equal(absent.get(ABSENT_KEY)!.detail, "landed but not visible on re-check");
});

test("a 23505 whose holder is the proposal itself is a race, not a collision — treated as present", async () => {
  const h = harness({
    present: new Set([PRESENT_ID]),
    land: (id) => ({ status: "collision", holderProposalId: id }),
    afterLand: new Set([ABSENT_ID]),
  });
  const absent = await guardBillDetails(rolls.map((r) => r.billKey), keyToId, billArgs, h.deps);
  assert.equal(absent.size, 0);
});

test("every bill present: no landing, no skip — the pre-FIX-1238 path exactly", async () => {
  const h = harness({ present: new Set([PRESENT_ID, ABSENT_ID]), land: () => assert.fail("must not land") });
  const absent = await guardBillDetails(rolls.map((r) => r.billKey), keyToId, billArgs, h.deps);
  assert.equal(absent.size, 0);
  assert.equal(h.landCalls.length, 0);
  const { res } = await write(absent);
  assert.equal(res.inserted, 7);
});

test("the presence read throwing FAILS OPEN — no skips, a warning, the insert is attempted as before", async () => {
  const h = harness({ present: new Set(), land: () => assert.fail("must not land"), throwOnRead: true });
  const absent = await guardBillDetails(rolls.map((r) => r.billKey), keyToId, billArgs, h.deps);
  assert.equal(absent.size, 0);
  assert.ok(h.lines.some((l) => l.includes("presence read failed")));
});

test("rolls with no proposal or no voted_at are logged as before and never reach the guard's skip", async () => {
  const lines: string[] = [];
  const res = await writeRollVotes<Roll, string>(
    [
      { rollCallId: "2026-house-001", billKey: null, votedAt: "2026-01-01", members: ["a"] },
      { rollCallId: "2026-house-002", billKey: ABSENT_KEY, votedAt: null, members: ["a"] },
    ],
    {
      proposalIdFor: (k) => (k ? (keyToId.get(k) ?? null) : null),
      absent: new Map(),
      build: () => assert.fail("must not build"),
      insert: async () => assert.fail("must not insert"),
      log: (l) => lines.push(l),
    },
  );
  assert.equal(res.skipped.length, 0);
  assert.match(lines[0]!, /no proposal reference/);
  assert.match(lines[1]!, /no voted_at/);
});

test("a non-FK insert error is recorded as an insert failure; 23505 is not", async () => {
  let n = 0;
  const res = await writeRollVotes<Roll, string>(rolls, {
    proposalIdFor: (k) => (k ? (keyToId.get(k) ?? null) : null),
    absent: new Map(),
    build: (r) => r.members,
    insert: async () =>
      ++n === 1 ? { error: { code: "23505", message: "dup" } } : { error: { code: "23503", message: "fk" } },
    log: () => {},
  });
  assert.equal(res.inserted, 0);
  assert.deepEqual(res.insertFailures, [{ roll: "2026-house-295", code: "23503", message: "fk" }]);
});

test("skipLine: the landing-failed shape carries the reason", () => {
  const l = skipLine("senate-119-2-00042", {
    bill_key: "119-S-221",
    proposal_id: "p",
    reason: "bill_details_landing_failed",
    holder_proposal_id: null,
    detail: "boom",
  });
  assert.equal(l.trim(), "skipped roll senate-119-2-00042: bill 119-S-221 has no bill_details row (proposal p) — landing failed: boom");
});
