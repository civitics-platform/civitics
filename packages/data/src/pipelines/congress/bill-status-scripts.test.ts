/**
 * cc-185 — the manifest scripts (scripts/fix1260-*, fix1261-*, fix1262-*) and
 * the nightly must count the same evidence. The scripts are plain node and
 * read their rules from scripts/lib/bill-status-evidence.mjs; this file holds
 * that module's twins equal to the TypeScript the nightly runs, and PREPAREs
 * every statement the scripts send against the local clone (rule 158 — only
 * the server knows whether a column or enum cast exists).
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { isPassageQuestion, mapBillStatus } from "./bill-status";
import { mapVoteResult, VOTE_RESULT_FAILED_SUFFIX, VOTE_RESULT_PASSED_SUFFIX } from "./members";
import { PROPOSAL_STATUS_RANK } from "./status-rank";
import passageQuestions from "./passage-questions.json";

const REPO = path.join(__dirname, "..", "..", "..", "..", "..");
const LIB_URL = pathToFileURL(path.join(REPO, "scripts", "lib", "bill-status-evidence.mjs")).href;
const SENATE_MANIFEST = path.join(REPO, "docs", "audits", "2026-10-04-fix1260-senate-results.json");

// The lib is .mjs outside this package's rootDir — imported by URL, untyped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lib: any;
before(async () => {
  lib = await import(LIB_URL);
});

const CLASS_OF: Record<string, string> = { passed_chamber: "passed", failed: "failed", floor_vote: "other" };

/** Every result value the census saw (House Clerk + Senate LIS), plus the edge cases the suffix rule must get right. */
const RESULTS = [
  "Passed", "Failed", "Agreed to",
  "Bill Passed", "Joint Resolution Passed", "Resolution Agreed to", "Concurrent Resolution Agreed to",
  "Amendment Agreed to", "Amendment Rejected", "Motion Agreed to", "Motion Rejected",
  "Cloture Motion Agreed to", "Cloture Motion Rejected", "Cloture on the Motion to Proceed Agreed to",
  "Nomination Confirmed", "Nomination Rejected", "Conference Report Agreed to",
  "Motion to Table Agreed to", "Motion to Table Failed", "Motion to Proceed Agreed to",
  "Veto Sustained", "Veto Overridden", "Point of Order Not Well Taken", "Point of Order Well Taken",
  "Decision of Chair Sustained", "Decision of Chair Not Sustained", "Motion Not Agreed to",
  "Bill Defeated", "Joint Resolution Defeated", "Guilty", "Not Guilty", "",
  "agreed to", "rejected", "amendment agreed to", "resolution agreed to", "motion rejected",
];

test("cc-185 the lib's passage questions ARE passage-questions.json, and TS agrees on every one", () => {
  assert.deepEqual([...lib.PASSAGE_QUESTIONS].sort(), [...new Set([...passageQuestions.house, ...passageQuestions.senate])].sort());
  for (const q of lib.PASSAGE_QUESTIONS as string[]) assert.equal(isPassageQuestion(q), true, q);
  for (const q of ["On Ordering the Previous Question", "On the Cloture Motion", "On the Nomination", "On Motion to Recommit", ""]) {
    assert.equal(isPassageQuestion(q), false, q);
    assert.equal(lib.isPassageQuestion(q), false, q);
  }
});

test("cc-185 voteResultClass (lib) ≡ mapVoteResult (members.ts) — same regexes, same class on every value", () => {
  assert.equal(lib.FAILED_SUFFIX.source, VOTE_RESULT_FAILED_SUFFIX.source);
  assert.equal(lib.PASSED_SUFFIX.source, VOTE_RESULT_PASSED_SUFFIX.source);
  for (const r of RESULTS) assert.equal(lib.voteResultClass(r), CLASS_OF[mapVoteResult(r)], JSON.stringify(r));
});

test("cc-185 every vote_result the FIX-1260 manifest recorded classifies the same in TS as the manifest says", (t) => {
  if (!fs.existsSync(SENATE_MANIFEST)) {
    t.skip("no FIX-1260 manifest in the tree yet");
    return;
  }
  const m = JSON.parse(fs.readFileSync(SENATE_MANIFEST, "utf8")) as {
    population: { vote_result_vocabulary: Array<{ vote_result: string; class: string }> };
  };
  assert.ok(m.population.vote_result_vocabulary.length > 0);
  for (const v of m.population.vote_result_vocabulary) {
    assert.equal(CLASS_OF[mapVoteResult(v.vote_result)], v.class, JSON.stringify(v.vote_result));
  }
});

test("cc-185 STATUS_RANK (lib) ≡ PROPOSAL_STATUS_RANK (status-rank.ts)", () => {
  assert.deepEqual({ ...lib.STATUS_RANK }, { ...PROPOSAL_STATUS_RANK });
});

/** mapBillStatus with no chamber — the lib and TS must agree exactly (bill-status.test.ts's table + the FIX-1262 texts). */
const TEXTS = [
  "Motion to reconsider laid on the table Agreed to without objection.",
  "Received in the Senate.",
  "Received in the Senate and Read twice and referred to the Committee on Finance.",
  "Held at the desk.",
  "Message on Senate action sent to the House.",
  "Placed on the Union Calendar, Calendar No. 312.",
  "Introduced in House",
  "Introduced in Senate",
  "",
  "Referred to the House Committee on the Judiciary.",
  "Read twice and referred to the Committee on Finance.",
  "Ordered to be Reported (Amended) by the Yeas and Nays: 30 - 20.",
  "Passed Senate without amendment by Unanimous Consent.",
  "Vetoed by President.",
  "Signed by President.",
  "Became Public Law No: 119-12.",
  "Presented to President.",
];

test("cc-185 mapBillStatus (lib, no chamber) ≡ mapBillStatus (bill-status.ts)", () => {
  for (const t of [...TEXTS, undefined]) assert.equal(lib.mapBillStatus(t), mapBillStatus(t), JSON.stringify(t));
});

test("cc-185 mapBillStatus (lib) ≡ mapBillStatus (bill-status.ts) WITH each origin chamber (FIX-1262)", () => {
  for (const c of ["house", "senate"] as const) {
    for (const t of [...TEXTS, undefined]) assert.equal(lib.mapBillStatus(t, c), mapBillStatus(t, c), `${c}: ${JSON.stringify(t)}`);
  }
});

test("cc-185 originChamberOf reads the prefix", () => {
  for (const [n, c] of [["HR 1", "house"], ["HJRES 2", "house"], ["HCONRES 3", "house"], ["HRES 4", "house"],
                        ["S 1", "senate"], ["SJRES 2", "senate"], ["SCONRES 3", "senate"], ["SRES 4", "senate"]]) {
    assert.equal(lib.originChamberOf(n), c, n);
  }
});

test("cc-185 the scripts' SQL parses and plans against the real schema (rule 158)", async (t) => {
  const { Client } = await import("pg");
  const client = new Client({
    connectionString: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    connectionTimeoutMillis: 3000,
  });
  try {
    await client.connect();
  } catch {
    t.skip("local Docker Postgres not reachable");
    return;
  }
  const id = "00000000-0000-0000-0000-000000000001";
  const stmts: Array<[string, string]> = [
    ["senate_rolls", lib.SENATE_ROLLS_SQL()],
    ["federal_bills", lib.FEDERAL_BILLS_SQL([id])],
    ["live_status", lib.LIVE_STATUS_SQL([id])],
    ["advance_apply", lib.ADVANCE_APPLY_SQL([id, id], "passed_chamber")],
    ["mint_candidates", lib.MINT_ARTIFACT_CANDIDATES_SQL()],
    ["direct_repair", lib.DIRECT_REPAIR_SQL([{ proposal_id: id, current_status: "failed", new_status: "floor_vote" }])],
    ["voice_vote", lib.VOICE_VOTE_CANDIDATES_SQL()],
    ["proposals_tuples", lib.PROPOSALS_TUPLES_SQL()],
    ["passage_predicate", `SELECT 1 FROM public.votes v WHERE ${lib.sqlIsPassage("v.vote_question")} AND ${lib.sqlResultPassed("v.metadata->>'vote_result'")}`],
  ];
  try {
    for (const [name, sql] of stmts) {
      await client.query(`PREPARE cc185_${name} AS ${sql}`);
      await client.query(`DEALLOCATE cc185_${name}`);
    }
  } finally {
    await client.end();
  }
});

test("cc-185 the SQL result predicate classifies like voteResultClass (run on the clone, no table)", async (t) => {
  const { Client } = await import("pg");
  const client = new Client({
    connectionString: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    connectionTimeoutMillis: 3000,
  });
  try {
    await client.connect();
  } catch {
    t.skip("local Docker Postgres not reachable");
    return;
  }
  try {
    for (const r of RESULTS) {
      const { rows } = await client.query(`SELECT ${lib.sqlResultPassed("$1::text")} AS passed`, [r]);
      assert.equal(rows[0].passed, lib.voteResultClass(r) === "passed", JSON.stringify(r));
    }
    for (const q of [...(lib.PASSAGE_QUESTIONS as string[]), "On Ordering the Previous Question", "  On   Passage "]) {
      const { rows } = await client.query(`SELECT ${lib.sqlIsPassage("$1::text")} AS p`, [q]);
      assert.equal(rows[0].p, isPassageQuestion(q), JSON.stringify(q));
    }
  } finally {
    await client.end();
  }
});
