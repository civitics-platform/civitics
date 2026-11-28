/**
 * FIX-1466 (cc-341 Item 1) — the votes re-read walker.
 *
 * Pure: the row builder (roll fields from the stored rows, the cast from the
 * file, a stored member yields nothing, a differing stored cast is reported
 * and not written, a roll on two proposals or with disagreeing roll fields is
 * skipped, the gap and 1 % guards), the file readers on the fixtures, the
 * cursor's encoding, the manifest and the CLI. The runner's stops run against
 * a fake client: no database, no network.
 *
 * Clone (CIVITICS_CLONE_TESTS=1), in the SAVEPOINT pattern inside one
 * BEGIN … ROLLBACK: re-reading a stored roll twice inserts its missing rows
 * once and nothing the second time, and changes no stored row (their xmin and
 * updated_at are equal before and after).
 *
 * Runs via:  CIVITICS_CLONE_TESTS=1 tsx --test src/pipelines/congress/votes-reread.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import {
  CAST_DISAGREE_LIMIT,
  decodeDone,
  encodeDone,
  houseFileMembers,
  parseCliArgs,
  parseManifest,
  planRoll,
  rollMetadata,
  runReread,
  senateFileMembers,
  summaryLine,
  type FileMember,
  type RunOptions,
  type StoredVote,
  type Target,
} from "./votes-reread";
import { buildBioguideMap } from "./votes-maps";
import type { TxControl } from "./vote-rolls";

const LOCAL_DSN = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const fixture = (name: string) => readFileSync(join(__dirname, "__fixtures__", name), "utf8");

const PROPOSAL = "0e2433b5-0fd3-4e27-a3ae-9741c468122d";
const OTHER_PROPOSAL = "d536667f-6a0d-4aeb-b1b9-324c946b4701";
const VOTED_AT = "2026-05-13T00:00:00.000Z";

function storedRow(official: string, vote: string, over: Partial<StoredVote> = {}): StoredVote {
  return {
    official_id: official,
    vote,
    bill_proposal_id: PROPOSAL,
    voted_at: VOTED_AT,
    vote_question: "On Motion to Suspend the Rules and Agree",
    session: "2",
    chamber: "House",
    source_url: "https://clerk.house.gov/evs/2026/roll160.xml",
    metadata: { legis_num: "H RES 1274", vote_result: "Passed" },
    ...over,
  };
}

const member = (key: string, officialId: string | null, cast: string, livePairWith: string | null = null): FileMember =>
  ({ key, officialId, cast, livePairWith });

// ---------------------------------------------------------------------------
// planRoll
// ---------------------------------------------------------------------------

test("planRoll: roll fields come from the stored rows, the cast from the file; a stored member yields nothing", () => {
  const stored = [storedRow("o1", "yes"), storedRow("o2", "no")];
  const plan = planRoll("2026-house-160", stored, [
    member("A000001", "o1", "Yea"),
    member("A000002", "o2", "Nay"),
    member("A000003", "o3", "Nay"),
    member("A000004", "o4", "Not Voting"),
    member("Z999999", null, "Yea"),
  ]);
  assert.equal(plan.skip, null);
  assert.deepEqual([plan.stored, plan.inFile, plan.resolvable], [2, 5, 4]);
  assert.deepEqual(plan.unmatched, ["Z999999"]);
  assert.deepEqual(plan.disagreements, []);
  assert.deepEqual(plan.insert, [
    {
      official_id: "o3", bill_proposal_id: PROPOSAL, vote: "no", chamber: "House", roll_call_id: "2026-house-160",
      session: "2", voted_at: VOTED_AT, vote_question: "On Motion to Suspend the Rules and Agree",
      source_url: "https://clerk.house.gov/evs/2026/roll160.xml",
      metadata: { legis_num: "H RES 1274", vote_result: "Passed" },
    },
    {
      official_id: "o4", bill_proposal_id: PROPOSAL, vote: "not_voting", chamber: "House", roll_call_id: "2026-house-160",
      session: "2", voted_at: VOTED_AT, vote_question: "On Motion to Suspend the Rules and Agree",
      source_url: "https://clerk.house.gov/evs/2026/roll160.xml",
      metadata: { legis_num: "H RES 1274", vote_result: "Passed" },
    },
  ]);
});

test("planRoll: a roll re-pointed since keeps its stored proposal — nothing is read from the file but casts", () => {
  // cc-316 re-pointed nomination rolls: the stored proposal is the truth here.
  const stored = [storedRow("o1", "yes", { bill_proposal_id: OTHER_PROPOSAL, vote_question: "On the Nomination" })];
  const plan = planRoll("senate-119-1-00100", stored, [member("smith:MN", "o1", "Yea"), member("jones:AL", "o2", "Nay")]);
  assert.deepEqual(plan.insert.map((r) => [r.official_id, r.bill_proposal_id, r.vote_question, r.vote]), [
    ["o2", OTHER_PROPOSAL, "On the Nomination", "no"],
  ]);
});

test("planRoll: a stored cast that differs from the file is reported, never written", () => {
  const stored = Array.from({ length: 200 }, (_, i) => storedRow(`o${i}`, "yes"));
  const members = stored.map((r) => member(r.official_id, r.official_id, "Yea"));
  members[7] = member("o7", "o7", "Nay");
  members.push(member("new", "o-new", "Yea"));
  const plan = planRoll("2026-house-160", stored, members);
  assert.equal(plan.skip, null, "1 of 201 is under the 1 % guard");
  assert.deepEqual(plan.disagreements, [{ official_id: "o7", stored: "yes", file: "no" }]);
  assert.deepEqual(plan.insert.map((r) => r.official_id), ["o-new"], "the disagreeing member is not inserted or changed");
});

test("planRoll: stored casts disagreeing on more than 1 % of the roll skip it whole", () => {
  assert.equal(CAST_DISAGREE_LIMIT, 0.01);
  const stored = Array.from({ length: 100 }, (_, i) => storedRow(`o${i}`, "yes"));
  const members = stored.map((r, i) => member(r.official_id, r.official_id, i < 2 ? "Nay" : "Yea"));
  members.push(member("new", "o-new", "Yea"));
  const plan = planRoll("2026-house-160", stored, members);
  assert.equal(plan.skip, "casts_disagree");
  assert.deepEqual(plan.insert, []);
});

test("planRoll: a roll whose stored rows sit on two proposals is skipped and named", () => {
  const plan = planRoll("2026-house-160", [storedRow("o1", "yes"), storedRow("o2", "no", { bill_proposal_id: OTHER_PROPOSAL })], [
    member("a", "o3", "Yea"),
  ]);
  assert.equal(plan.skip, "proposals_differ");
  assert.equal(plan.skipDetail, [OTHER_PROPOSAL, PROPOSAL].sort().join(", "));
  assert.deepEqual(plan.insert, []);
});

test("planRoll: stored rows disagreeing on voted_at, the question or the roll metadata skip the roll", () => {
  const one = (over: Partial<StoredVote>) =>
    planRoll("2026-house-160", [storedRow("o1", "yes"), storedRow("o2", "no", over)],
      [member("a", "o1", "Yea"), member("b", "o2", "Nay"), member("c", "o3", "Yea")]);
  assert.deepEqual([one({ voted_at: "2026-05-14T00:00:00.000Z" }).skip, one({ voted_at: "2026-05-14T00:00:00.000Z" }).skipDetail], ["roll_fields_differ", "voted_at"]);
  assert.equal(one({ vote_question: "On Passage" }).skipDetail, "vote_question");
  assert.equal(one({ metadata: { legis_num: "H RES 1275", vote_result: "Passed" } }).skipDetail, "metadata");
  // A live pair is a member's key, not the roll's: rows that differ only by it agree.
  assert.equal(one({ metadata: { legis_num: "H RES 1274", vote_result: "Passed", live_pair_with: "S375" } }).skip, null);
});

test("planRoll: an unknown cast holds back the whole roll (FIX-1417)", () => {
  const plan = planRoll("2026-house-160", [storedRow("o1", "yes")], [member("a", "o2", "Yea"), member("b", "o3", "Abstained?")]);
  assert.equal(plan.skip, "unknown_cast");
  assert.deepEqual(plan.insert, []);
});

test("planRoll: more to insert than the file's members minus its stored rows is a stored row outside the file — skipped", () => {
  // o1 is stored but not in the file; both file members resolve to unstored officials: 2 > 2 − 1.
  const plan = planRoll("2026-house-160", [storedRow("o1", "yes")], [member("a", "o2", "Yea"), member("b", "o3", "Nay")]);
  assert.equal(plan.skip, "insert_exceeds_gap");
  assert.deepEqual(plan.insert, []);
});

test("planRoll: two file members resolving to one official — the first keeps it, the second is counted", () => {
  const plan = planRoll("2026-house-160", [storedRow("o1", "yes")], [
    member("a", "o1", "Yea"), member("b", "o2", "Yea"), member("c", "o2", "Nay"), member("d", null, "Yea"),
  ]);
  assert.equal(plan.duplicates, 1);
  assert.deepEqual(plan.insert.map((r) => [r.official_id, r.vote]), [["o2", "yes"]]);
});

test("planRoll: no stored rows is not_stored, never a roll to write", () => {
  assert.equal(planRoll("2026-house-999", [], [member("a", "o1", "Yea")]).skip, "not_stored");
});

test("planRoll, Senate: the roll's metadata keys from the stored rows; live_pair_with is the member's own, from the file", () => {
  const sen = (o: string, v: string, meta: Record<string, unknown>) => storedRow(o, v, {
    chamber: "Senate", session: "2", source_url: "https://www.senate.gov/x.xml", metadata: meta,
  });
  const roll = { vote_result: "Cloture Motion Agreed to", vote_result_text: "Cloture Motion Agreed to (74-25)" };
  const plan = planRoll("senate-119-2-00114", [sen("o1", "present", { ...roll, live_pair_with: "S375" }), sen("o2", "yes", roll)], [
    member("a:AK", "o1", "Present, Giving Live Pair", "S375"),
    member("b:AL", "o2", "Yea"),
    member("c:AZ", "o3", "Present, Giving Live Pair", "S401"),
    member("d:CA", "o4", "Nay"),
  ]);
  assert.equal(plan.skip, null);
  assert.deepEqual(plan.insert.map((r) => [r.official_id, r.vote, r.chamber, r.metadata]), [
    ["o3", "present", "Senate", { ...roll, live_pair_with: "S401" }],
    ["o4", "no", "Senate", roll],
  ]);
  assert.deepEqual(rollMetadata({ ...roll, live_pair_with: "S1" }), roll);
});

// ---------------------------------------------------------------------------
// The file readers
// ---------------------------------------------------------------------------

test("houseFileMembers: the nightly's parser, resolved by bioguide; a body that is not a roll is null", () => {
  const map = new Map([["A000370", "o-adams"], ["A000371", "o-aguilar"]]);
  const members = houseFileMembers(fixture("clerk-house-2025-362-passage.xml"), map)!;
  assert.deepEqual(members, [
    { key: "A000370", officialId: "o-adams", cast: "Nay", livePairWith: null },
    { key: "A000055", officialId: null, cast: "Yea", livePairWith: null },
    { key: "A000371", officialId: "o-aguilar", cast: "Nay", livePairWith: null },
  ]);
  assert.equal(houseFileMembers("<html><body>Not Found</body></html>", map), null);
});

test("senateFileMembers: lastname:STATE keys, a live pair's partner carried", () => {
  const members = senateFileMembers(fixture("lis-senate-115-2-00223-live-pair.xml"), new Map())!;
  assert.equal(members.length, 100);
  assert.ok(members.every((m) => m.officialId === null && /^[a-z' -]+:[A-Z]{2}$/.test(m.key)));
  const pairs = members.filter((m) => m.livePairWith);
  assert.ok(pairs.length >= 1, "the fixture carries a live pair");
  assert.ok(pairs.every((m) => m.cast === "Present, Giving Live Pair"));
});

// ---------------------------------------------------------------------------
// The cursor, the manifest, the CLI
// ---------------------------------------------------------------------------

test("encodeDone / decodeDone: ranges by prefix, padding kept, a round trip", () => {
  const ids = ["2025-house-003", "2025-house-004", "2025-house-005", "2025-house-295", "2026-house-156",
    "senate-119-2-00114", "senate-119-2-00115", "senate-119-2-00117", "2025-house-004"];
  const enc = encodeDone(ids);
  assert.deepEqual(enc, {
    "2025-house-###": "3-5,295",
    "2026-house-###": "156",
    "senate-119-2-#####": "114-115,117",
  });
  assert.deepEqual([...decodeDone(enc)].sort(), [...new Set(ids)].sort());
  assert.deepEqual([...decodeDone({ "x-#": "nope", 5: "1", "2025-house-###": 7 })], [], "malformed is dropped, not thrown");
  assert.deepEqual([...decodeDone(null)], []);
});

test("parseManifest: the committed Write 1 manifest — 154 House and 4 Senate rolls of the 119th", () => {
  const ids = parseManifest(readFileSync(join(__dirname, "../../../../../docs/audits/2026-11-28-short-rolls-manifest.tsv"), "utf8"));
  assert.equal(ids.length, 158);
  assert.equal(ids.filter((i) => i.startsWith("senate-")).length, 4);
  assert.ok(ids.includes("2026-house-160") && ids.includes("senate-119-2-00114"));
  assert.deepEqual(parseManifest("# c\nroll_call_id\tchamber\n2025-house-003\tHouse\n\n"), ["2025-house-003"]);
});

test("parseCliArgs: exactly one of --dry-run / --apply; a scope; --manifest and --only-ids exclusive", () => {
  assert.deepEqual(parseCliArgs(["--dry-run", "--manifest", "m.tsv"]), {
    apply: false, allowProd: false, chamber: null, onlyIds: null, manifest: "m.tsv", limit: null, maxMinutes: null, refetch: false,
  });
  assert.deepEqual(parseCliArgs(["--apply", "--allow-prod", "--chamber", "house", "--limit", "100", "--max-minutes", "45"]), {
    apply: true, allowProd: true, chamber: "House", onlyIds: null, manifest: null, limit: 100, maxMinutes: 45, refetch: false,
  });
  assert.deepEqual((parseCliArgs(["--apply", "--only-ids", "2025-house-003, senate-119-2-00114", "--refetch"]) as { onlyIds: string[] }).onlyIds,
    ["2025-house-003", "senate-119-2-00114"]);
  assert.ok("error" in parseCliArgs(["--apply"]), "no scope");
  assert.ok("error" in parseCliArgs(["--chamber", "house"]), "neither mode");
  assert.ok("error" in parseCliArgs(["--apply", "--dry-run", "--chamber", "house"]), "both modes");
  assert.ok("error" in parseCliArgs(["--apply", "--chamber", "both"]));
  assert.ok("error" in parseCliArgs(["--apply", "--manifest", "m.tsv", "--only-ids", "x"]));
  assert.ok("error" in parseCliArgs(["--apply", "--chamber", "house", "--limit", "0"]));
  assert.ok("error" in parseCliArgs(["--apply", "--manifest", "--limit", "5"]), "a flag is not a value");
});

// ---------------------------------------------------------------------------
// The runner's stops — a fake client
// ---------------------------------------------------------------------------

/** A client that serves STORED_SQL from `stored`, records every INSERT, and answers anything else empty. */
function fakeClient(stored: Record<string, StoredVote[]>) {
  const inserts: Array<{ roll: string; rows: number }> = [];
  const statements: string[] = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      statements.push(sql.trim().split(/\s+/).slice(0, 2).join(" "));
      if (sql.includes("FROM public.votes WHERE roll_call_id = $1")) return { rows: stored[String(params![0])] ?? [], rowCount: 0 };
      if (sql.trim().startsWith("INSERT INTO public.votes")) {
        const rows = JSON.parse(String(params![0])) as Array<{ roll_call_id: string }>;
        inserts.push({ roll: rows[0]!.roll_call_id, rows: rows.length });
        return { rows: [], rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { client: client as unknown as Client, inserts, statements };
}

function houseXml(members: Array<[string, string]>): string {
  return `<?xml version="1.0"?><rollcall-vote><vote-metadata><legis-num>H R 1</legis-num></vote-metadata><vote-data>` +
    members.map(([id, v]) => `<recorded-vote><legislator name-id="${id}">${id}</legislator><vote>${v}</vote></recorded-vote>`).join("") +
    `</vote-data></rollcall-vote>`;
}

const houseRolls = ["2026-house-160", "2026-house-161", "2026-house-162", "2026-house-163"];
const urlOf = (id: string) => `https://clerk.house.gov/evs/2026/roll${id.slice(-3)}.xml`;
const storedFor = (id: string) => [storedRow("o1", "yes", { source_url: urlOf(id) })];
const allStored = Object.fromEntries(houseRolls.map((id) => [id, storedFor(id)]));
const maps = { officialMap: new Map([["A1", "o1"], ["A2", "o2"], ["A3", "o3"]]), senatorByNameState: new Map<string, string>() };
const targets: Target[] = houseRolls.map((roll_call_id) => ({ roll_call_id, chamber: "House" }));
const notHeld = async () => ({ held: false, reason: null });
const DAY = () => new Date("2026-11-28T09:00:00Z");

function runOpts(client: Client, over: Partial<RunOptions> = {}): RunOptions {
  return {
    client, maps, apply: true, targets, limit: null, maxMinutes: null, isHeld: notHeld, now: DAY,
    sleep: async () => undefined, log: () => undefined,
    fetch: async () => houseXml([["A1", "Yea"], ["A2", "Nay"], ["A3", "Yea"]]),
    ...over,
  };
}

test("runner: each roll inserts its missing members in its own transaction; the done list is what finished", async () => {
  const { client, inserts, statements } = fakeClient(allStored);
  const s = await runReread(runOpts(client));
  assert.equal(s.stop, "done");
  assert.deepEqual(inserts, houseRolls.map((roll) => ({ roll, rows: 2 })));
  assert.deepEqual([s.rolls_read, s.rolls_changed, s.rows_inserted, s.remaining], [4, 4, 8, 0]);
  assert.deepEqual(s.done, houseRolls);
  assert.equal(statements.filter((x) => x === "BEGIN").length, 4, "one transaction a roll");
  assert.ok(!statements.some((x) => /^(UPDATE|DELETE)/.test(x)), "no UPDATE or DELETE");
  assert.match(summaryLine(s, true), /inserted=8 of 8/);
});

test("runner: a dry run reads and plans, and sends no INSERT", async () => {
  const { client, inserts, statements } = fakeClient(allStored);
  const s = await runReread(runOpts(client, { apply: false }));
  assert.deepEqual(inserts, []);
  assert.ok(!statements.includes("BEGIN"));
  assert.deepEqual([s.rows_to_insert, s.rows_inserted, s.rolls_changed], [8, 0, 4]);
});

test("runner: three fetch failures in a row stop that host for the run; the rolls left are remaining", async () => {
  const { client, inserts } = fakeClient(allStored);
  const s = await runReread(runOpts(client, { fetch: async (u) => { throw new Error(`HTTP 503 Service Unavailable — ${u}`); } }));
  assert.equal(s.house.stop, "failures");
  assert.equal(s.house.gets, 3, "the fourth roll is never asked for");
  assert.deepEqual([inserts.length, s.done.length, s.remaining, s.failures.length], [0, 0, 4, 3]);
});

test("runner: a 403 still blocked after the retries stops the host at once", async () => {
  const { client } = fakeClient(allStored);
  const waits: number[] = [];
  const s = await runReread(runOpts(client, {
    sleep: async (ms) => { waits.push(ms); },
    fetch: async (u) => { throw new Error(`HTTP 403 Forbidden — ${u}`); },
  }));
  assert.equal(s.house.stop, "blocked");
  assert.deepEqual([s.house.gets, s.house.blocked_retries], [3, 2], "one GET and the two retries, then nothing");
  assert.ok(waits.includes(30_000) && waits.includes(120_000));
});

test("runner: a held session stops the run before the next roll; --limit stops it after that many", async () => {
  {
    const { client, inserts } = fakeClient(allStored);
    let n = 0;
    const s = await runReread(runOpts(client, { isHeld: async () => ({ held: ++n > 2, reason: "cc-999 supervised" }) }));
    assert.equal(s.stop, "held");
    assert.equal(inserts.length, 2);
    assert.equal(s.remaining, 2);
  }
  {
    const { client, inserts } = fakeClient(allStored);
    const s = await runReread(runOpts(client, { limit: 3 }));
    assert.equal(s.stop, "limit");
    assert.equal(inserts.length, 3);
  }
});

test("runner: a body that is not a roll is a failure, not a done roll", async () => {
  const { client } = fakeClient(allStored);
  let n = 0;
  const s = await runReread(runOpts(client, {
    fetch: async () => (++n === 2 ? "<html>error</html>" : houseXml([["A1", "Yea"], ["A2", "Nay"]])),
  }));
  assert.equal(s.stop, "done");
  assert.deepEqual(s.done, ["2026-house-160", "2026-house-162", "2026-house-163"]);
  assert.equal(s.failures[0]!.roll, "2026-house-161");
});

// ---------------------------------------------------------------------------
// Clone
// ---------------------------------------------------------------------------

const SAVEPOINT_TX: TxControl = {
  begin: async (c) => { await c.query("SAVEPOINT votes_reread_roll"); },
  commit: async (c) => { await c.query("RELEASE SAVEPOINT votes_reread_roll"); },
  rollback: async (c) => { await c.query("ROLLBACK TO SAVEPOINT votes_reread_roll"); },
};

async function clone(t: { skip: (m: string) => void }): Promise<Client | null> {
  if (process.env["CIVITICS_CLONE_TESTS"] !== "1") {
    t.skip("set CIVITICS_CLONE_TESTS=1 to run against the migrated clone");
    return null;
  }
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  await c.connect();
  return c;
}

const CLONE_ROLL = "2021-house-449";
const FILE_CAST: Record<string, string> = { yes: "Yea", no: "Nay", not_voting: "Not Voting", present: "Present" };

test("clone: re-reading a stored roll twice inserts its missing rows once and nothing the second time; no stored row changes", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await c.query("BEGIN");
    try {
      const storedBefore = (await c.query<{ id: string; xmin: string; updated_at: string; official_id: string; vote: string; bioguide: string | null }>(
        `SELECT v.id, v.xmin::text AS xmin, v.updated_at::text AS updated_at, v.official_id, v.vote,
                o.source_ids ->> 'congress_gov' AS bioguide
           FROM public.votes v LEFT JOIN public.officials o ON o.id = v.official_id
          WHERE v.roll_call_id = $1 ORDER BY v.id`, [CLONE_ROLL],
      )).rows;
      if (storedBefore.length === 0) { t.skip(`${CLONE_ROLL} is not stored on this clone`); return; }
      const officials = (await c.query<{ id: string; source_ids: Record<string, string> | null }>(
        `SELECT id, source_ids FROM public.officials WHERE source_ids ? 'congress_gov'`,
      )).rows;
      const officialMap = buildBioguideMap(officials).map;
      // Only stored members the map resolves back to the stored official can sit in the file.
      const inFile = storedBefore.filter((r) => r.bioguide && officialMap.get(r.bioguide) === r.official_id);
      assert.equal(inFile.length, storedBefore.length, "every stored member of the roll resolves back to its own row");
      const storedIds = new Set(storedBefore.map((r) => r.official_id));
      const missing = [...officialMap].filter(([, id]) => !storedIds.has(id)).sort(([a], [b]) => a.localeCompare(b)).slice(0, 5);
      assert.equal(missing.length, 5);

      const head = fixture("clerk-house-2021-449-passage.xml").split("<vote-data>")[0]!;
      const recorded: Array<[string, string]> = [
        ...inFile.map((r) => [r.bioguide!, FILE_CAST[r.vote]!] as [string, string]),
        ...missing.map(([b]) => [b, "Yea"] as [string, string]),
        ["Z999901", "Nay"], ["Z999902", "Not Voting"],
      ];
      const body = `${head}<vote-data>` +
        recorded.map(([id, v]) => `<recorded-vote><legislator name-id="${id}">${id}</legislator><vote>${v}</vote></recorded-vote>`).join("") +
        `</vote-data></rollcall-vote>`;
      const calls: string[] = [];
      const o: RunOptions = {
        client: c, maps: { officialMap, senatorByNameState: new Map() }, apply: true,
        targets: [{ roll_call_id: CLONE_ROLL, chamber: "House" }], limit: null, maxMinutes: null,
        isHeld: notHeld, tx: SAVEPOINT_TX, now: DAY, sleep: async () => undefined, log: () => undefined,
        fetch: async (u) => { calls.push(u); return body; },
      };

      const first = await runReread(o);
      assert.equal(first.stop, "done", first.stop_detail ?? "");
      assert.deepEqual(calls, ["https://clerk.house.gov/evs/2021/roll449.xml"], "the stored source_url");
      assert.deepEqual([first.rows_inserted, first.rolls_changed, first.unmatched.size, first.cast_disagreements],
        [5, 1, 2, 0]);
      assert.deepEqual(first.done, [CLONE_ROLL]);

      const proto = (await c.query(
        `SELECT bill_proposal_id, voted_at, vote_question, session, chamber, source_url, metadata FROM public.votes WHERE id = $1`,
        [storedBefore[0]!.id],
      )).rows[0];
      const added = (await c.query(
        `SELECT v.official_id, v.vote, v.bill_proposal_id, v.voted_at, v.vote_question, v.session, v.chamber, v.source_url, v.metadata,
                v.primary_source IS NOT DISTINCT FROM p.primary_source
                  AND v.primary_source_url IS NOT DISTINCT FROM p.primary_source_url AS source_from_proposal
           FROM public.votes v JOIN public.proposals p ON p.id = v.bill_proposal_id
          WHERE v.roll_call_id = $1 AND NOT (v.official_id = ANY ($2::uuid[]))`,
        [CLONE_ROLL, [...storedIds]],
      )).rows;
      assert.deepEqual(added.map((r) => r.official_id).sort(), missing.map(([, id]) => id).sort());
      for (const r of added) {
        assert.equal(r.vote, "yes", "the cast from the file");
        assert.deepEqual(
          [r.bill_proposal_id, r.voted_at.getTime(), r.vote_question, r.session, r.chamber, r.source_url, r.metadata],
          [proto.bill_proposal_id, proto.voted_at.getTime(), proto.vote_question, proto.session, proto.chamber, proto.source_url, proto.metadata],
          "every roll-level field from the stored rows",
        );
        assert.equal(r.source_from_proposal, true, "primary_source from the parent proposal");
      }

      const second = await runReread(o);
      assert.deepEqual([second.rows_inserted, second.rolls_changed, second.rows_to_insert], [0, 0, 0], "nothing the second time");

      const storedAfter = (await c.query<{ id: string; xmin: string; updated_at: string }>(
        `SELECT id, xmin::text AS xmin, updated_at::text AS updated_at FROM public.votes WHERE id = ANY ($1::uuid[]) ORDER BY id`,
        [storedBefore.map((r) => r.id)],
      )).rows;
      assert.deepEqual(storedAfter, storedBefore.map(({ id, xmin, updated_at }) => ({ id, xmin, updated_at })), "no stored row changed");
      const total = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.votes WHERE roll_call_id = $1`, [CLONE_ROLL])).rows[0]!.n;
      assert.equal(total, storedBefore.length + 5);
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});
