/**
 * FIX-1407 — the Senate's seen-unstored record (`pipeline_state`
 * `congress_votes:senate_rolls:<congress>`): what it skips, what it fetches
 * again, how a run folds in, and that neither a failed read nor a failed write
 * changes what the run stores.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  closesTail,
  emptySenateUnstored,
  mergeSenateUnstored,
  parseSenateUnstored,
  readSenateUnstored,
  senateSkipSets,
  senateUnstoredKey,
  senateUnstoredLine,
  writeSenateUnstored,
  RETRY_ABSENT_DAYS,
  SENATE_UNSTORED_VERSION,
  type SenateUnstoredRecord,
} from "./senate-unstored";
import { writeRollVotes, type AbsentBill } from "./vote-bill-guard";

const rec = (sessions: SenateUnstoredRecord["sessions"]): SenateUnstoredRecord => ({ v: SENATE_UNSTORED_VERSION, sessions });
const NONE = new Set<string>();

test("FIX-1407 the key carries the congress, and no other pipeline_state key starts with it", () => {
  assert.equal(senateUnstoredKey(119), "congress_votes:senate_rolls:119");
});

test("FIX-1407 merge: a re-fetched roll takes this run's reason and date; an unfetched one keeps its entry", () => {
  const prev = rec({
    "1": {
      tail_closed: false,
      rolls: {
        "senate-119-1-00003": { reason: "no_proposal_reference", seen_at: "2026-11-01" },
        "senate-119-1-00090": { reason: "bill_details_key_collision", seen_at: "2026-11-01" },
      },
    },
  });
  const { record, added } = mergeSenateUnstored(prev, {
    unstored: [
      { roll: "senate-119-1-00090", reason: "bill_details_landing_failed" },
      { roll: "senate-119-2-00007", reason: "no_proposal_reference" },
    ],
    stored: NONE,
    tailClosed: [],
  }, "2026-11-14");
  assert.deepEqual(record, rec({
    "1": {
      tail_closed: false,
      rolls: {
        "senate-119-1-00003": { reason: "no_proposal_reference", seen_at: "2026-11-01" },
        "senate-119-1-00090": { reason: "bill_details_landing_failed", seen_at: "2026-11-14" },
      },
    },
    "2": { tail_closed: false, rolls: { "senate-119-2-00007": { reason: "no_proposal_reference", seen_at: "2026-11-14" } } },
  }));
  assert.equal(added, 1);
});

test("FIX-1407 merge: a roll now in votes leaves the record; tail_closed only ever turns on", () => {
  const prev = rec({
    "1": { tail_closed: true, rolls: { "senate-119-1-00090": { reason: "bill_details_key_collision", seen_at: "2026-11-01" } } },
    "2": { tail_closed: false, rolls: {} },
  });
  const { record, pruned } = mergeSenateUnstored(prev, {
    unstored: [],
    stored: new Set(["senate-119-1-00090"]),
    tailClosed: [2],
  }, "2026-11-14");
  assert.deepEqual(record, rec({ "1": { tail_closed: true, rolls: {} }, "2": { tail_closed: true, rolls: {} } }));
  assert.equal(pruned, 1);
});

test("FIX-1407 an insert failure is never recorded: writeRollVotes leaves it out of `unstored`, so the merge never sees it", async () => {
  type Roll = { rollCallId: string; billKey: string | null; votedAt: string | null };
  const absent = new Map<string, AbsentBill>([
    ["119-S-9", { bill_key: "119-S-9", proposal_id: "p9", reason: "bill_details_key_collision", holder_proposal_id: "h", detail: null }],
  ]);
  const rolls: Roll[] = [
    { rollCallId: "senate-119-2-00001", billKey: null, votedAt: "2026-11-01" },          // no reference
    { rollCallId: "senate-119-2-00002", billKey: "119-S-404", votedAt: "2026-11-01" },   // resolved to nothing
    { rollCallId: "senate-119-2-00003", billKey: "119-S-1", votedAt: null },             // no voted_at
    { rollCallId: "senate-119-2-00004", billKey: "119-S-9", votedAt: "2026-11-01" },     // guard-absent
    { rollCallId: "senate-119-2-00005", billKey: "119-S-2", votedAt: "2026-11-01" },     // no member matched
    { rollCallId: "senate-119-2-00006", billKey: "119-S-1", votedAt: "2026-11-01" },     // insert fails (FK)
    { rollCallId: "senate-119-2-00007", billKey: "119-S-1", votedAt: "2026-11-01" },     // lands
  ];
  const ids: Record<string, string> = { "119-S-1": "p1", "119-S-2": "p2", "119-S-9": "p9" };
  const res = await writeRollVotes<Roll, string>(rolls, {
    proposalIdFor: (k) => (k ? ids[k] ?? null : null),
    absent,
    build: (r) => (r.billKey === "119-S-2" ? [] : [r.rollCallId]),
    insert: async (records) =>
      records[0] === "senate-119-2-00006" ? { error: { code: "23503", message: "fk" } } : { error: null },
    log: () => {},
  });
  assert.deepEqual(res.unstored, [
    { roll: "senate-119-2-00001", reason: "no_proposal_reference" },
    { roll: "senate-119-2-00002", reason: "bill_unresolved" },
    { roll: "senate-119-2-00003", reason: "no_voted_at" },
    { roll: "senate-119-2-00004", reason: "bill_details_key_collision" },
    { roll: "senate-119-2-00005", reason: "no_matchable_records" },
  ]);
  assert.deepEqual(res.insertFailures.map((f) => f.roll), ["senate-119-2-00006"]);
  assert.deepEqual(res.landed, ["senate-119-2-00007"]);

  const { record } = mergeSenateUnstored(emptySenateUnstored(), {
    unstored: res.unstored,
    stored: new Set(res.landed),
    tailClosed: [],
  }, "2026-11-14");
  const known = Object.keys(record.sessions["2"]!.rolls);
  assert.ok(!known.includes("senate-119-2-00006"), "the insert failure is fetched again tomorrow");
  assert.ok(!known.includes("senate-119-2-00007"));
  assert.equal(known.length, 5);
});

test("FIX-1407 the parser's reasons stay skipped however old; every other reason re-enters after 7 days", () => {
  const r = rec({
    "1": {
      tail_closed: true,
      rolls: {
        "senate-119-1-00003": { reason: "no_proposal_reference", seen_at: "2026-01-01" },
        "senate-119-1-00004": { reason: "no_voted_at", seen_at: "2026-01-01" },
        "senate-119-1-00090": { reason: "bill_details_key_collision", seen_at: "2026-11-08" },
        "senate-119-1-00091": { reason: "bill_details_landing_failed", seen_at: "2026-11-07" },
        "senate-119-1-00092": { reason: "no_matchable_records", seen_at: "2026-11-07" },
        "senate-119-1-00093": { reason: "bill_unresolved", seen_at: "2026-11-14" },
      },
    },
  });
  assert.equal(RETRY_ABSENT_DAYS, 7);
  const { seen, recheck } = senateSkipSets(r, "2026-11-14");
  assert.deepEqual([...seen].sort(), ["senate-119-1-00003", "senate-119-1-00004", "senate-119-1-00090", "senate-119-1-00093"]);
  assert.deepEqual([...recheck].sort(), ["senate-119-1-00091", "senate-119-1-00092"]);
});

test("FIX-1407 a version bump empties the record — the skip set and the closed tails with it", () => {
  const stored = {
    v: SENATE_UNSTORED_VERSION - 1,
    sessions: { "1": { tail_closed: true, rolls: { "senate-119-1-00003": { reason: "no_proposal_reference", seen_at: "2026-11-01" } } } },
  };
  assert.equal(parseSenateUnstored(stored), null);
  assert.equal(parseSenateUnstored({ ...stored, v: SENATE_UNSTORED_VERSION })!.sessions["1"]!.tail_closed, true);
});

test("FIX-1407 parse drops a malformed entry and keeps the rest", () => {
  const r = parseSenateUnstored({
    v: SENATE_UNSTORED_VERSION,
    sessions: {
      "2": {
        tail_closed: "yes",
        rolls: {
          "senate-119-2-00001": { reason: "no_proposal_reference", seen_at: "2026-11-01" },
          "senate-119-2-00002": { reason: "made_up", seen_at: "2026-11-01" },
          "senate-119-2-00003": { reason: "no_voted_at", seen_at: "yesterday" },
          "senate-119-1-00004": { reason: "no_voted_at", seen_at: "2026-11-01" },
        },
      },
    },
  });
  assert.deepEqual(r, rec({ "2": { tail_closed: false, rolls: { "senate-119-2-00001": { reason: "no_proposal_reference", seen_at: "2026-11-01" } } } }));
  assert.equal(parseSenateUnstored([]), null);
  assert.equal(parseSenateUnstored("x"), null);
});

test("FIX-1407 D3: a past year's tail closes only when it ended past the end with nothing blocked or transient in it", () => {
  const tail = { frontier: 659, end: "past-end" as const, at: 662, why: "3 consecutive misses", unsure: 0 };
  assert.equal(closesTail(2025, tail, 2026), true);
  assert.equal(closesTail(2026, tail, 2026), false, "the current session's tail stays open");
  assert.equal(closesTail(2025, { ...tail, unsure: 1 }, 2026), false, "a blocked roll in the tail could be the last one");
  assert.equal(closesTail(2025, { ...tail, end: "blocked" }, 2026), false);
  assert.equal(closesTail(2025, { ...tail, end: "max-roll" }, 2026), false);
  assert.equal(closesTail(2025, null, 2026), false);
});

/** A fake supabase-js client over one pipeline_state row. */
function fakeDb(opts: { value?: unknown; readError?: string; readThrows?: boolean; writeError?: string }) {
  const writes: unknown[] = [];
  const db = {
    from(table: string) {
      assert.equal(table, "pipeline_state");
      return {
        select() {
          return {
            eq(col: string, key: string) {
              assert.equal(col, "key");
              assert.equal(key, "congress_votes:senate_rolls:119");
              return {
                async maybeSingle() {
                  if (opts.readThrows) throw new TypeError("fetch failed");
                  if (opts.readError) return { data: null, error: { message: opts.readError } };
                  return { data: opts.value === undefined ? null : { value: opts.value }, error: null };
                },
              };
            },
          };
        },
        async upsert(row: unknown, o: unknown) {
          writes.push({ row, o });
          return { error: opts.writeError ? { message: opts.writeError } : null };
        },
      };
    },
  };
  return { db, writes };
}

test("FIX-1407 read: no row is an empty record, quietly", async () => {
  const lines: string[] = [];
  const r = await readSenateUnstored(fakeDb({}).db, 119, (l) => lines.push(l));
  assert.deepEqual(r, emptySenateUnstored());
  assert.deepEqual(lines, []);
});

test("FIX-1407 read failure → an empty record and one loud line", async () => {
  for (const o of [{ readError: "permission denied" }, { readThrows: true }]) {
    const lines: string[] = [];
    const r = await readSenateUnstored(fakeDb(o).db, 119, (l) => lines.push(l));
    assert.deepEqual(r, emptySenateUnstored());
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /⚠ FIX-1407: Senate unstored record READ FAILED \(congress_votes:senate_rolls:119: .+\) — walking with an empty record/);
  }
});

test("FIX-1407 read: another version is dropped with a line", async () => {
  const lines: string[] = [];
  const r = await readSenateUnstored(fakeDb({ value: { v: 0, sessions: {} } }).db, 119, (l) => lines.push(l));
  assert.deepEqual(r, emptySenateUnstored());
  assert.match(lines[0]!, new RegExp(`is v0, not v${SENATE_UNSTORED_VERSION} — starting over`));
});

test("FIX-1408 v2: a v1 record — every amendment roll in it a no_proposal_reference — parses to null, and the reader starts over", async () => {
  assert.equal(SENATE_UNSTORED_VERSION, 2);
  const v1 = {
    v: 1,
    sessions: {
      "1": { tail_closed: true, rolls: { "senate-119-1-00062": { reason: "no_proposal_reference", seen_at: "2026-11-14" } } },
      "2": { tail_closed: false, rolls: { "senate-119-2-00014": { reason: "no_proposal_reference", seen_at: "2026-11-14" } } },
    },
  };
  assert.equal(parseSenateUnstored(v1), null);
  const lines: string[] = [];
  const r = await readSenateUnstored(fakeDb({ value: v1 }).db, 119, (l) => lines.push(l));
  assert.deepEqual(r, emptySenateUnstored());
  assert.deepEqual(senateSkipSets(r, "2026-11-15"), { seen: new Set(), recheck: new Set() }, "nothing skipped: roll 62 is fetched again");
  assert.deepEqual(lines, [
    "  Senate unstored record: congress_votes:senate_rolls:119 is v1, not v2 — starting over (every roll fetched once)",
  ]);
});

test("FIX-1407 write: one upsert on the key; a failure is a line and `false`, never a throw", async () => {
  const ok = fakeDb({});
  const r = rec({ "1": { tail_closed: true, rolls: {} } });
  assert.equal(await writeSenateUnstored(ok.db, 119, r, () => {}), true);
  assert.equal(ok.writes.length, 1);
  const w = ok.writes[0] as { row: { key: string; value: unknown }; o: unknown };
  assert.equal(w.row.key, "congress_votes:senate_rolls:119");
  assert.deepEqual(w.row.value, r);
  assert.deepEqual(w.o, { onConflict: "key" });

  const lines: string[] = [];
  const bad = fakeDb({ writeError: "timeout" });
  assert.equal(await writeSenateUnstored(bad.db, 119, r, (l) => lines.push(l)), false);
  assert.match(lines[0]!, /Senate unstored record write failed \(congress_votes:senate_rolls:119: timeout\) — continuing/);
});

test("FIX-1407 the record line counts by reason", () => {
  const r = rec({
    "1": {
      tail_closed: true,
      rolls: {
        "senate-119-1-00003": { reason: "no_proposal_reference", seen_at: "2026-11-14" },
        "senate-119-1-00004": { reason: "no_proposal_reference", seen_at: "2026-11-14" },
        "senate-119-1-00090": { reason: "bill_details_key_collision", seen_at: "2026-11-14" },
      },
    },
    "2": { tail_closed: false, rolls: { "senate-119-2-00007": { reason: "no_voted_at", seen_at: "2026-11-14" } } },
  });
  assert.equal(
    senateUnstoredLine(r, 4, 0),
    "  Senate unstored record: 4 known (2 no reference, 1 no voted_at, 1 guard-absent), +4 added, −0 retried; tail closed: session 1",
  );
  assert.match(senateUnstoredLine(r, 0, 2, 3), /\+0 added, −2 retried, 3 now stored;/);
});
