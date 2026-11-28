/**
 * FIX-1467 (cc-341 Item 2) — the nightly never stores a short roll again.
 *
 * From about 2026-04-24 to 06-09 the votes writer's member map was built from
 * the first 1,000 `officials` rows, and every roll written in that window
 * stored only the members the cut map held, with no error; nothing re-reads a
 * stored roll (FIX-1466). Two refusals:
 *   (a) a member map under MEMBER_MAP_FLOOR (400 House bioguides, 90 senators)
 *       throws before the run writes anything — the bills of Step 1 included;
 *   (b) in the sitting Congress, a roll too few of whose recorded votes
 *       resolve (under SHORT_ROLL_SHARE, 97 %) is not stored: it is named
 *       `short_roll`, counted, and fetched again the next night. The backfill
 *       path (CONGRESS_OVERRIDE) keeps (a) only.
 *
 * Runs via:  tsx --test src/pipelines/congress/votes-short-roll.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MEMBER_MAP_FLOOR,
  MemberMapFloorError,
  SHORT_ROLL_SHARE,
  assertMemberMapFloor,
  isShortRoll,
  shortRollGuard,
} from "./votes-maps";
import { writeRollVotes, type RollForWrite } from "./vote-bill-guard";
import { emptySenateUnstored, mergeSenateUnstored, SENATE_UNSTORED_VERSION } from "./senate-unstored";
import { SITTING_CONGRESS } from "./members";

// ---------------------------------------------------------------------------
// (a) the floor
// ---------------------------------------------------------------------------

test("FIX-1467 the floor: 400 House bioguides and 90 senators pass; one under either throws", () => {
  assert.deepEqual(MEMBER_MAP_FLOOR, { house: 400, senate: 90 });
  assert.doesNotThrow(() => assertMemberMapFloor({ house: 400, senate: 90 }));
  assert.doesNotThrow(() => assertMemberMapFloor({ house: 542, senate: 100 }), "prod 2026-11-28's shape");
  assert.throws(() => assertMemberMapFloor({ house: 399, senate: 100 }), MemberMapFloorError);
  assert.throws(() => assertMemberMapFloor({ house: 542, senate: 89 }), MemberMapFloorError);
  // The 05-13 → 06-09 window's shape: about a hundred House members resolved.
  assert.throws(() => assertMemberMapFloor({ house: 106, senate: 55 }), /106 House bioguides .* 55 senators/);
});

/** runVotesPipeline's body, from its signature to the standalone entry point. */
function pipelineBody(): string {
  const src = readFileSync(join(__dirname, "votes.ts"), "utf8");
  const start = src.indexOf("export async function runVotesPipeline(");
  const end = src.indexOf("// Standalone entry point");
  assert.ok(start > 0 && end > start, "runVotesPipeline and the entry point are where this test expects");
  return src.slice(start, end);
}

test("FIX-1467 a map under the floor throws before any write: the floor check precedes every write call in runVotesPipeline", () => {
  const body = pipelineBody();
  const floor = body.indexOf("assertMemberMapFloor(");
  const maps = body.indexOf("await buildOfficialMaps(");
  assert.ok(maps > 0 && floor > maps, "the maps are built, then checked");
  const writes = [
    "upsertBillProposalsBatch(",   // Step 1's bills
    "resolveBillsBatch(",          // a novel bill's mint
    "guardBillDetails(",           // a targeted bill_details landing
    "writeRollVotes<",             // the votes
    "advanceProposalStatuses(",    // status moves
    "writeSenateUnstored(",        // the Senate record
    "writeVoteRollRows(",          // vote_rolls
  ];
  for (const w of writes) {
    const at = body.indexOf(w);
    assert.ok(at > 0, `${w} is in the body`);
    assert.ok(floor < at, `the floor check comes before ${w}`);
  }
  // Inside the try, so a throw closes the run row as failed (failSync).
  assert.ok(body.indexOf("try {") < floor, "inside the try that fails the sync row");
});

// ---------------------------------------------------------------------------
// (b) the short roll
// ---------------------------------------------------------------------------

interface Roll extends RollForWrite {
  resolved: number;
  recorded: number;
}

async function write(rolls: Roll[], short: ((b: number, r: number) => boolean) | undefined) {
  const inserted: string[] = [];
  const lines: string[] = [];
  const res = await writeRollVotes<Roll, { roll: string }>(rolls, {
    proposalIdFor: () => "11111111-1111-1111-1111-111111111111",
    absent: new Map(),
    build: (roll) => Array.from({ length: roll.resolved }, () => ({ roll: roll.rollCallId })),
    insert: async (records) => {
      inserted.push(`${records[0]!.roll}:${records.length}`);
      return { error: null };
    },
    log: (l) => lines.push(l),
    recorded: (roll) => roll.recorded,
    short,
  });
  return { res, inserted, lines };
}

const roll = (id: string, resolved: number, recorded: number): Roll =>
  ({ rollCallId: id, billKey: "119-HR-1", votedAt: "2026-05-13", resolved, recorded });

test("FIX-1467 the share is 97 %, and a roll with no recorded votes is never short", () => {
  assert.equal(SHORT_ROLL_SHARE, 0.97);
  assert.equal(isShortRoll(96, 100), true);
  assert.equal(isShortRoll(97, 100), false);
  assert.equal(isShortRoll(0, 0), false);
  // cc-341 read 3's edges: the best cut-map roll, and the worst whole roll.
  assert.equal(isShortRoll(413, 431), true, "2026-house-115, 95.8 %");
  assert.equal(isShortRoll(422, 432), false, "a whole roll short 10, 97.7 %");
});

test("FIX-1467 the sitting Congress: a roll resolving 96 % is skipped as short_roll with no insert call; one resolving 98 % is written", async () => {
  const guard = shortRollGuard(SITTING_CONGRESS, SITTING_CONGRESS);
  assert.ok(guard, "the sitting Congress refuses short rolls");
  const { res, inserted, lines } = await write(
    [roll("2026-house-160", 96, 100), roll("2026-house-161", 98, 100)],
    guard,
  );
  assert.deepEqual(inserted, ["2026-house-161:98"], "no insert for the short roll");
  assert.equal(res.inserted, 98);
  assert.deepEqual(res.landed, ["2026-house-161"], "a short roll is not landed (no status evidence, no vote_rolls row)");
  assert.deepEqual(res.unstored, [{ roll: "2026-house-160", reason: "short_roll" }]);
  assert.ok(lines.some((l) => l.includes("2026-house-160: 96 of 100 recorded votes resolve")), "named with both counts");
});

test("FIX-1467 the backfill path (CONGRESS_OVERRIDE) writes a 60 % roll: no short-roll refusal off the sitting Congress", async () => {
  assert.equal(shortRollGuard(117, SITTING_CONGRESS), undefined);
  const { res, inserted } = await write([roll("2021-house-449", 260, 434)], shortRollGuard(117, SITTING_CONGRESS));
  assert.deepEqual(inserted, ["2021-house-449:260"]);
  assert.deepEqual(res.unstored, []);
});

test("FIX-1467 a roll with no matchable records keeps its own reason, not short_roll", async () => {
  const { res } = await write([roll("2026-house-170", 0, 430)], shortRollGuard(SITTING_CONGRESS, SITTING_CONGRESS));
  assert.deepEqual(res.unstored, [{ roll: "2026-house-170", reason: "no_matchable_records" }]);
});

test("FIX-1467 a short Senate roll is never recorded as unstored, and drops an earlier entry: the next night fetches it again", () => {
  const prev = {
    v: SENATE_UNSTORED_VERSION,
    sessions: {
      "2": { tail_closed: false, rolls: { "senate-119-2-00116": { reason: "bill_unresolved" as const, seen_at: "2026-11-20" } } },
    },
  };
  const { record, added } = mergeSenateUnstored(prev, {
    unstored: [
      { roll: "senate-119-2-00114", reason: "short_roll" },
      { roll: "senate-119-2-00116", reason: "short_roll" },
      { roll: "senate-119-2-00200", reason: "no_proposal_reference" },
    ],
    stored: new Set(),
    tailClosed: [],
  }, "2026-11-28");
  assert.deepEqual(record.sessions["2"]!.rolls, {
    "senate-119-2-00200": { reason: "no_proposal_reference", seen_at: "2026-11-28" },
  });
  assert.equal(added, 1);
  assert.deepEqual(mergeSenateUnstored(emptySenateUnstored(), {
    unstored: [{ roll: "senate-119-2-00114", reason: "short_roll" }], stored: new Set(), tailClosed: [],
  }, "2026-11-28").record.sessions["2"]!.rolls, {});
});
