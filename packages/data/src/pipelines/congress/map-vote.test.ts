/**
 * FIX-1417 — mapVote stops storing a cast it does not know as `not_voting`.
 *
 * senate-117-1-00059 (the 2021 impeachment verdict, "Guilty or Not Guilty")
 * is 78 `not_voting` rows: every member's `Guilty` / `Not Guilty` fell through
 * mapVote's default. D7: a verdict maps to yes / no; any other unknown cast
 * throws, and the roll writer stores nothing for that roll and names it.
 *
 * The first tests mapVote has had. No database.
 *
 * Runs via:  tsx --test src/pipelines/congress/map-vote.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UnknownCastError, mapVote } from "./members";
import { writeRollVotes } from "./vote-bill-guard";
import {
  emptySenateUnstored,
  mergeSenateUnstored,
  parseSenateUnstored,
  senateSkipSets,
  senateUnstoredLine,
} from "./senate-unstored";

test("the known casts: House Aye / No, Senate Yea / Nay, Not Voting, Present", () => {
  const table: Array<[string, string]> = [
    ["Yea", "yes"],
    ["Aye", "yes"],
    ["Nay", "no"],
    ["No", "no"],
    ["Not Voting", "not_voting"],
    ["not_voting", "not_voting"],
    ["Present", "present"],
    ["  yea ", "yes"],
  ];
  for (const [cast, want] of table) assert.equal(mapVote(cast), want, cast);
});

test("FIX-1417 an impeachment verdict: Guilty → yes, Not Guilty → no", () => {
  assert.equal(mapVote("Guilty"), "yes");
  assert.equal(mapVote("Not Guilty"), "no");
  assert.equal(mapVote("NOT GUILTY"), "no");
});

test("FIX-1417 an unknown cast throws a named error carrying the string — never not_voting", () => {
  for (const cast of ["Jeffries", "Present, Giving Live Pair", "", "Abstain"]) {
    assert.throws(
      () => mapVote(cast),
      (err: unknown) => err instanceof UnknownCastError && err.cast === cast && err.message === `unknown cast '${cast}'`,
      JSON.stringify(cast),
    );
  }
});

test("every value mapVote returns is in the votes.vote CHECK constraint (0001_initial_schema.sql)", () => {
  const sql = readFileSync(join(__dirname, "..", "..", "..", "..", "..", "supabase", "migrations", "0001_initial_schema.sql"), "utf8");
  const m = /vote\s+TEXT NOT NULL\s+CHECK \(vote IN \(([^)]*)\)\)/.exec(sql);
  assert.ok(m, "the CHECK is where the schema puts it");
  const allowed = new Set([...m[1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
  for (const cast of ["Yea", "Nay", "Not Voting", "Present", "Guilty", "Not Guilty"]) {
    assert.ok(allowed.has(mapVote(cast)), `${cast} → ${mapVote(cast)}`);
  }
});

type Roll = { rollCallId: string; billKey: string | null; votedAt: string | null; casts: string[] };

/** Build rows the way votes.ts does: one per member, `vote: mapVote(cast)`. */
async function write(rolls: Roll[]) {
  const inserted: Array<{ roll: string; vote: string }[]> = [];
  const lines: string[] = [];
  const res = await writeRollVotes<Roll, { roll: string; vote: string }>(rolls, {
    proposalIdFor: () => "p1",
    absent: new Map(),
    build: (r) => r.casts.map((c) => ({ roll: r.rollCallId, vote: mapVote(c) })),
    insert: async (records) => {
      inserted.push(records);
      return { error: null };
    },
    log: (l) => lines.push(l),
  });
  return { res, inserted, lines };
}

test("FIX-1417 writer: a roll with one unknown cast stores NOTHING, is named unknown_cast, and the next roll still lands", async () => {
  const { res, inserted, lines } = await write([
    { rollCallId: "senate-119-2-00300", billKey: "119-S-1", votedAt: "2026-11-01", casts: ["Yea", "Present, Giving Live Pair", "Nay"] },
    { rollCallId: "senate-119-2-00301", billKey: "119-S-1", votedAt: "2026-11-01", casts: ["Yea", "Nay"] },
  ]);
  assert.deepEqual(inserted.map((r) => r[0]!.roll), ["senate-119-2-00301"], "no insert call for the held roll");
  assert.deepEqual(res.unstored, [{ roll: "senate-119-2-00300", reason: "unknown_cast" }]);
  assert.deepEqual(res.landed, ["senate-119-2-00301"]);
  assert.equal(res.inserted, 2);
  assert.ok(lines.some((l) => l.includes("unknown cast 'Present, Giving Live Pair' in senate-119-2-00300")), lines.join("\n"));
});

test("FIX-1417 writer: the verdict roll's casts land as yes / no", async () => {
  const { res, inserted } = await write([
    { rollCallId: "senate-117-1-00059", billKey: "117-HRES-24", votedAt: "2021-02-13", casts: ["Guilty", "Not Guilty", "Guilty"] },
  ]);
  assert.deepEqual(inserted[0]!.map((r) => r.vote), ["yes", "no", "yes"]);
  assert.deepEqual(res.unstored, []);
});

test("FIX-1417 writer: any other error from build still propagates", async () => {
  await assert.rejects(
    writeRollVotes<Roll, string>([{ rollCallId: "r", billKey: "k", votedAt: "2026-11-01", casts: [] }], {
      proposalIdFor: () => "p1",
      absent: new Map(),
      build: () => {
        throw new TypeError("a bug, not a cast");
      },
      insert: async () => ({ error: null }),
      log: () => {},
    }),
    /a bug, not a cast/,
  );
});

test("FIX-1417 the Senate record names the roll unknown_cast, keeps it through a read-back, and skips it as the parser's own", async () => {
  const { res } = await write([
    { rollCallId: "senate-119-2-00300", billKey: "119-S-1", votedAt: "2026-11-01", casts: ["Jeffries"] },
  ]);
  const { record, added } = mergeSenateUnstored(emptySenateUnstored(), { unstored: res.unstored, stored: new Set(), tailClosed: [] }, "2026-11-17");
  assert.equal(added, 1);
  assert.deepEqual(record.sessions["2"]!.rolls["senate-119-2-00300"], { reason: "unknown_cast", seen_at: "2026-11-17" });
  // pipeline_state round trip: the reader keeps the reason rather than dropping it as malformed.
  const back = parseSenateUnstored(JSON.parse(JSON.stringify(record)));
  assert.deepEqual(back, record);
  // A parser reason: still skipped a year later, until SENATE_UNSTORED_VERSION moves.
  const { seen, recheck } = senateSkipSets(record, "2027-11-17");
  assert.ok(seen.has("senate-119-2-00300"));
  assert.equal(recheck.size, 0);
  assert.match(senateUnstoredLine(record, added, 0), /1 unknown cast/);
});
