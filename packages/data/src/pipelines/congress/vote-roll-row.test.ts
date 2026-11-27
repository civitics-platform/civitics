/**
 * FIX-1448 (cc-331 D2, D3) — a roll's vote_rolls row from each source, and the
 * merge. The fixtures are real files fetched 2026-11-27 (cc-331 read 1) through
 * fetchText, recorded-vote and member lists cut to three, session lists cut to
 * three <vote>s:
 *   clerk-house-2025-336  On Motion to Suspend the Rules and Pass  2/3 YEA-AND-NAY  388-0
 *   clerk-house-2025-362  On Passage                               YEA-AND-NAY      215-201
 *   clerk-house-2021-449  On Passage (S J RES 33, the 117th)       YEA-AND-NAY      221-209
 *   lis-senate-119-2-00243  On the Cloture Motion   3/5  74-25, <present/> empty
 *   lis-senate-117-1-00477  On Passage of the Bill  3/5  69-28, <vote_document_text/> empty
 *   lis-senate-119-1-00372  On Passage of the Bill  1/2  50-50, the Vice President's Yea
 *   lis-vote-menu-119-2 / -117-1   the session lists (vote_menu_<congress>_<session>.xml)
 *
 * Runs via:  tsx --test src/pipelines/congress/vote-roll-row.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { buildRollRow, parseHouseRoll, parseSenateRoll } from "./votes";
import {
  detailUpsertRow,
  easternInstant,
  houseRollFields,
  mergeVoteRoll,
  parseSenateVoteMenu,
  rollIdentity,
  seedRow,
  senateRollFields,
  writeVoteRollRows,
  LIST_COLUMNS,
  type RollFields,
  type VoteRollRow,
} from "./vote-roll-row";

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, "__fixtures__", name), "utf8");
const house = (name: string) => houseRollFields(parseHouseRoll(fixture(name))!.meta);
const senate = (name: string) => senateRollFields(parseSenateRoll(fixture(name))!);

test("rollIdentity: the two federal shapes give chamber, congress, session, number and the URL the nightly fetches; any other shape is null", () => {
  assert.deepEqual(rollIdentity("2021-house-449"), {
    roll_call_id: "2021-house-449", chamber: "House", congress: 117, session: 1, roll_number: 449,
    source_url: "https://clerk.house.gov/evs/2021/roll449.xml",
  });
  assert.deepEqual(
    ["2022-house-001", "2025-house-336", "2026-house-311"].map((id) => { const r = rollIdentity(id)!; return [r.congress, r.session, r.roll_number]; }),
    [[117, 2, 1], [119, 1, 336], [119, 2, 311]],
  );
  assert.equal(rollIdentity("2022-house-001")!.source_url, "https://clerk.house.gov/evs/2022/roll001.xml");
  assert.deepEqual(rollIdentity("senate-119-2-00243"), {
    roll_call_id: "senate-119-2-00243", chamber: "Senate", congress: 119, session: 2, roll_number: 243,
    source_url: "https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00243.xml",
  });
  for (const other of ["fga-2026-001", "watauga-12", "senate-119-3-00001", "2025-house-33", "2025-senate-001", ""]) {
    assert.equal(rollIdentity(other), null, other);
  }
});

test("easternInstant: Eastern wall time to UTC across both offsets", () => {
  assert.equal(easternInstant("2025-12-15", 19, 2), "2025-12-16T00:02:00.000Z");
  assert.equal(easternInstant("2025-07-01", 11, 56), "2025-07-01T15:56:00.000Z");
  assert.equal(easternInstant("2021-12-15", 0, 20), "2021-12-15T05:20:00.000Z");
});

test("House 2025-336: a two-thirds suspension — vote-type is the majority requirement, the totals and the party rows as printed", () => {
  assert.deepEqual(house("clerk-house-2025-336-suspension.xml"), {
    vote_date: "2025-12-15",
    voted_at: "2025-12-16T00:02:00.000Z",
    question: "On Motion to Suspend the Rules and Pass, as Amended",
    title: "To require the Secretary of Agriculture to convey a parcel of property of the Forest Service to Perry County, Arkansas, and for other purposes",
    document_text: null,
    result: "Passed",
    result_text: null,
    yea: 388, nay: 0, present: 0, not_voting: 45,
    majority_requirement: "2/3 YEA-AND-NAY",
    tie_breaker: null,
    by_party: [
      { party: "Republican", yea: 197, nay: 0, present: 0, not_voting: 23 },
      { party: "Democratic", yea: 191, nay: 0, present: 0, not_voting: 22 },
      { party: "Independent", yea: 0, nay: 0, present: 0, not_voting: 0 },
    ],
    source_modified_at: null,
  } satisfies RollFields);
});

test("House 2025-362 and 2021-449: recorded votes on passage", () => {
  const a = house("clerk-house-2025-362-passage.xml");
  assert.deepEqual([a.question, a.majority_requirement, a.result, a.title, a.yea, a.nay, a.present, a.not_voting, a.voted_at],
    ["On Passage", "YEA-AND-NAY", "Passed", "Do No Harm in Medicaid Act", 215, 201, 0, 17, "2025-12-18T19:59:00.000Z"]);
  const b = house("clerk-house-2021-449-passage.xml");
  assert.deepEqual([b.vote_date, b.voted_at, b.title, b.yea, b.nay, b.present, b.not_voting],
    ["2021-12-15", "2021-12-15T05:20:00.000Z", "Joint resolution relating to increasing the debt limit", 221, 209, 0, 4]);
  assert.equal(b.by_party?.length, 3);
});

test("Senate 119-2-00243: cloture at 3/5, and the empty <present/> inside <count> is 0", () => {
  assert.deepEqual(senate("lis-senate-119-2-00243-cloture-three-fifths.xml"), {
    vote_date: "2026-09-24",
    voted_at: "2026-09-24T15:46:00.000Z",
    question: "On the Cloture Motion",
    title: "Motion to Invoke Cloture: S. 4668, as Amended",
    document_text: "A bill to protect the name, image, and likeness rights of, and provide protections for, student athletes and to promote fair competition among intercollegiate athletics, and for other purposes.",
    result: "Cloture Motion Agreed to",
    result_text: "Cloture Motion Agreed to (74-25, 3/5 majority required)",
    yea: 74, nay: 25, present: 0, not_voting: 1,
    majority_requirement: "3/5",
    tie_breaker: null,
    by_party: null,
    source_modified_at: "2026-09-24T17:05:00.000Z",
  } satisfies RollFields);
});

test("Senate 117-1-00477 (an empty text element is NULL) and 119-1-00372 (the tie, cast)", () => {
  const a = senate("lis-senate-117-1-00477-passage-three-fifths.xml");
  assert.deepEqual([a.title, a.document_text, a.result, a.majority_requirement, a.yea, a.nay, a.present, a.not_voting, a.voted_at],
    ["H.R. 6119", null, "Bill Passed", "3/5", 69, 28, 0, 3, "2021-12-03T02:05:00.000Z"]);
  const b = senate("lis-senate-119-1-00372-tie-breaker.xml");
  assert.deepEqual([b.yea, b.nay, b.present, b.not_voting], [50, 50, 0, 0], "both empty elements in <count> are 0");
  assert.deepEqual(b.tie_breaker, { by_whom: "Vice President of the United States", vote: "Yea" });
  assert.equal(b.result_text, "Bill Passed (50-50, Vice President of the United States, voted Yea)");
  assert.equal(senate("lis-senate-119-1-00411-bill-passed.xml").tie_breaker, null, "an uncast tie_breaker is NULL");
});

test("a file with no totals block gives NULL totals, not 0", () => {
  const meta = { ...parseHouseRoll(fixture("clerk-house-2025-362-passage.xml"))!.meta };
  delete meta["vote-totals"];
  const f = houseRollFields(meta);
  assert.deepEqual([f.yea, f.nay, f.present, f.not_voting, f.by_party], [null, null, null, null, null]);
  const root = { ...parseSenateRoll(fixture("lis-senate-119-2-00243-cloture-three-fifths.xml"))! };
  delete root["count"];
  const g = senateRollFields(root);
  assert.deepEqual([g.yea, g.nay, g.present, g.not_voting], [null, null, null, null]);
});

test("the session lists: one entry a <vote>, ids padded as votes stores them, the date's year from congress_year", () => {
  const l = parseSenateVoteMenu(fixture("lis-vote-menu-119-2.xml"))!;
  assert.deepEqual([l.congress, l.session, l.year], [119, 2, 2026]);
  assert.deepEqual(l.entries.map((e) => e.roll_call_id), ["senate-119-2-00279", "senate-119-2-00243", "senate-119-2-00242"]);
  assert.deepEqual(l.entries[1]!.fields, {
    vote_date: "2026-09-24",
    question: "On the Cloture Motion",
    title: "Motion to Invoke Cloture: S. 4668, as Amended; A bill to protect the name, image, and likeness rights of, and provide protections for, student athletes and to promote fair competition among intercollegiate athletics, and for other purposes.",
    result: "Agreed to",
    yea: 74,
    nay: 25,
  });
  assert.equal(l.entries[2]!.fields.question, "On the Amendment", "a nested <measure> is not the question");
  const o = parseSenateVoteMenu(fixture("lis-vote-menu-117-1.xml"))!;
  assert.deepEqual(o.entries.map((e) => [e.roll_call_id, e.fields.vote_date, e.fields.result, e.fields.yea, e.fields.nay]), [
    ["senate-117-1-00477", "2021-12-02", "Passed", 69, 28],
    ["senate-117-1-00476", "2021-12-02", "Rejected", 48, 50],
    ["senate-117-1-00001", "2021-01-06", "Not Sustained", 6, 93],
  ]);
  assert.equal(parseSenateVoteMenu("<html><body>Access Denied</body></html>"), null);
  assert.equal(parseSenateVoteMenu(fixture("lis-senate-119-2-00243-cloture-three-fifths.xml")), null);
});

// ---------------------------------------------------------------------------
// The merge (D2)
// ---------------------------------------------------------------------------

const ID = rollIdentity("senate-119-2-00243")!;
const LIST = parseSenateVoteMenu(fixture("lis-vote-menu-119-2.xml"))!.entries[1]!.fields;
const DETAIL = senate("lis-senate-119-2-00243-cloture-three-fifths.xml");

test("merge rule 1: a list fills only what is NULL, and stamps list_fetched_at", () => {
  const seeded = seedRow(ID);
  const once = mergeVoteRoll(seeded, { kind: "list", at: "2026-11-27T08:00:00Z", fields: LIST });
  for (const col of LIST_COLUMNS) assert.deepEqual(once[col], LIST[col], col);
  assert.equal(once.list_fetched_at, "2026-11-27T08:00:00Z");
  assert.equal(once.detail_fetched_at, null);
  const partial: VoteRollRow = { ...seeded, question: "kept" };
  const twice = mergeVoteRoll(partial, { kind: "list", at: "2026-11-27T09:00:00Z", fields: LIST });
  assert.equal(twice.question, "kept", "a value already there is not replaced by a list");
  assert.equal(twice.result, "Agreed to");
  const absent = mergeVoteRoll(seeded, { kind: "list", at: "2026-11-27T09:00:00Z", fields: null });
  assert.deepEqual({ ...absent, list_fetched_at: null }, seeded, "a list without the roll fills nothing");
});

test("merge rule 2: a list never overwrites a per-roll file's field", () => {
  const detailed = mergeVoteRoll(seedRow(ID), { kind: "detail", source: "lis_roll_xml", at: "2026-11-27T08:00:00Z", fields: DETAIL });
  const after = mergeVoteRoll(detailed, { kind: "list", at: "2026-11-27T09:00:00Z", fields: { ...LIST, question: "LIST", result: "LIST", yea: 1, nay: 2 } });
  assert.deepEqual({ ...after, list_fetched_at: null }, { ...detailed, list_fetched_at: null });
  assert.equal(after.result, "Cloture Motion Agreed to");
  assert.equal(after.title, "Motion to Invoke Cloture: S. 4668, as Amended");
});

test("merge rule 3: a per-roll read replaces a list's fields and an earlier per-roll read, and clears a parse failure", () => {
  const listed = mergeVoteRoll(seedRow(ID), { kind: "list", at: "2026-11-27T08:00:00Z", fields: LIST });
  const failed = mergeVoteRoll(listed, { kind: "detail_error", at: "2026-11-27T08:30:00Z", reason: "non-roll body" });
  assert.deepEqual([failed.detail_error, failed.result], ["non-roll body", "Agreed to"], "a failure keeps the list's fields");
  const detailed = mergeVoteRoll(failed, { kind: "detail", source: "lis_roll_xml", at: "2026-11-27T09:00:00Z", fields: DETAIL });
  assert.deepEqual([detailed.result, detailed.title, detailed.present, detailed.detail_error, detailed.detail_error_at, detailed.list_fetched_at],
    ["Cloture Motion Agreed to", "Motion to Invoke Cloture: S. 4668, as Amended", 0, null, null, "2026-11-27T08:00:00Z"]);
  const reread = mergeVoteRoll(detailed, { kind: "detail", source: "lis_roll_xml", at: "2026-11-28T09:00:00Z", fields: { ...DETAIL, not_voting: 2, result_text: null } });
  assert.deepEqual([reread.not_voting, reread.result_text, reread.detail_fetched_at], [2, null, "2026-11-28T09:00:00Z"], "the later read wins, NULLs included");
});

test("detailUpsertRow is the merge of a detail onto any row, without the list's stamp", () => {
  const row = detailUpsertRow(ID, "lis_roll_xml", "2026-11-27T08:00:00Z", DETAIL);
  assert.equal("list_fetched_at" in row, false, "an upsert must not clear a list stamp");
  const listed = mergeVoteRoll(seedRow(ID), { kind: "list", at: "2026-11-27T07:00:00Z", fields: LIST });
  const merged = mergeVoteRoll(listed, { kind: "detail", source: "lis_roll_xml", at: "2026-11-27T08:00:00Z", fields: DETAIL });
  assert.deepEqual({ ...listed, ...row }, merged, "upserting the row onto a listed row is the merge");
});

// ---------------------------------------------------------------------------
// The nightly's write (D3)
// ---------------------------------------------------------------------------

test("D3: buildRollRow builds from the XML in hand, and a reader that throws gives no row instead of an error", () => {
  const meta = parseHouseRoll(fixture("clerk-house-2025-336-suspension.xml"))!.meta;
  const row = buildRollRow("2025-house-336", "https://clerk.house.gov/evs/2025/roll336.xml", "clerk_xml", () => houseRollFields(meta), "2026-11-27T21:08:00Z")!;
  assert.deepEqual([row.roll_call_id, row.chamber, row.congress, row.session, row.roll_number, row.yea, row.detail_source, row.detail_fetched_at],
    ["2025-house-336", "House", 119, 1, 336, 388, "clerk_xml", "2026-11-27T21:08:00Z"]);
  assert.equal(buildRollRow("2025-house-336", "u", "clerk_xml", () => { throw new Error("boom"); }), null);
  assert.equal(buildRollRow("fga-2026-001", "u", "clerk_xml", () => houseRollFields(meta)), null);
});

test("D3: a failed vote_rolls write is counted and logged, never thrown — the votes write it follows stands", async () => {
  const meta = parseHouseRoll(fixture("clerk-house-2025-362-passage.xml"))!.meta;
  const rows = Array.from({ length: 450 }, (_, i) =>
    buildRollRow(`2025-house-${String(i + 1).padStart(3, "0")}`, "u", "clerk_xml", () => houseRollFields(meta))!);
  const lines: string[] = [];
  let calls = 0;
  const out = await writeVoteRollRows(rows, async () => {
    calls++;
    if (calls === 2) return { error: { message: 'relation "public.vote_rolls" does not exist' } };
    if (calls === 3) throw new Error("fetch failed");
    return { error: null };
  }, (l) => lines.push(l));
  assert.equal(calls, 3);
  assert.deepEqual([out.written, out.failed], [200, 250]);
  assert.equal(out.failures.length, 25, "the failure list is capped");
  assert.match(out.failures[0]!.why, /does not exist/);
  assert.equal(lines.length, 2);
  const none = await writeVoteRollRows([], async () => { throw new Error("never called"); }, () => undefined);
  assert.deepEqual(none, { written: 0, failed: 0, failures: [] });
});
