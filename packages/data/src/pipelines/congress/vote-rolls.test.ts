/**
 * FIX-1448 (cc-331 Item 2) — the vote-rolls walker.
 *
 * The unit half needs no database: the CLI, D6's quiet span, the id → URL
 * derivation on every shape cc-331 read 3 found, the summary line. The clone
 * half (CIVITICS_CLONE_TESTS=1) drives runVoteRolls against the migrated local
 * clone, scoped to six real stored rolls (the read-1 fixtures), with the
 * fixtures in place of the network, inside one BEGIN … ROLLBACK per test:
 *   1. a run seeds, reads two session lists and every per-roll file, newest
 *      first, and a second run takes nothing new and rests 12 h;
 *   2. a blocked House stops the House and not the Senate;
 *   3. D6: inside the quiet span senate.gov is asked nothing and the House goes
 *      on; once the nightly's votes phase has closed, the Senate goes on;
 *   4. a held session stops the run before the next roll;
 *   5. a non-roll body is stamped and rested PARSE_RETRY_DAYS.
 *
 * Runs via:  CIVITICS_CLONE_TESTS=1 tsx --test src/pipelines/congress/vote-rolls.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import {
  DEFAULT_HOUSE_LIMIT,
  DEFAULT_SENATE_LIMIT,
  PARSE_RETRY_DAYS,
  SEED_SQL,
  parseCliArgs,
  quietSpanStart,
  runVoteRolls,
  senateWindow,
  summaryLine,
  type HoldReading,
  type RunOptions,
  type RunSummary,
  type TxControl,
} from "./vote-rolls";
import { rollIdentity } from "./vote-roll-row";

const LOCAL_DSN = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const fixture = (name: string) => readFileSync(join(__dirname, "__fixtures__", name), "utf8");

// ---------------------------------------------------------------------------
// Unit
// ---------------------------------------------------------------------------

test("parseCliArgs: exactly one of --dry-run / --apply; limits default to 500 and 20 and may be 0", () => {
  assert.deepEqual(parseCliArgs(["--apply"]), { apply: true, allowProd: false, houseLimit: DEFAULT_HOUSE_LIMIT, senateLimit: DEFAULT_SENATE_LIMIT, maxMinutes: null });
  assert.deepEqual([DEFAULT_HOUSE_LIMIT, DEFAULT_SENATE_LIMIT], [500, 20]);
  assert.deepEqual(
    parseCliArgs(["--apply", "--allow-prod", "--house-limit", "50", "--senate-limit", "0", "--max-minutes", "15"]),
    { apply: true, allowProd: true, houseLimit: 50, senateLimit: 0, maxMinutes: 15 },
  );
  assert.ok("error" in parseCliArgs([]));
  assert.ok("error" in parseCliArgs(["--apply", "--dry-run"]));
  assert.ok("error" in parseCliArgs(["--apply", "--house-limit", "-1"]));
  assert.ok("error" in parseCliArgs(["--apply", "--senate-limit", "x"]));
  assert.ok("error" in parseCliArgs(["--apply", "--max-minutes", "0"]));
});

test("the id → URL derivation on every shape read 3 found; the synthetic chambers' ids are another shape", () => {
  const house = [2021, 2022, 2023, 2024, 2025, 2026].map((y) => rollIdentity(`${y}-house-007`)!);
  assert.deepEqual(house.map((h) => [h.congress, h.session, h.source_url]), [
    [117, 1, "https://clerk.house.gov/evs/2021/roll007.xml"],
    [117, 2, "https://clerk.house.gov/evs/2022/roll007.xml"],
    [118, 1, "https://clerk.house.gov/evs/2023/roll007.xml"],
    [118, 2, "https://clerk.house.gov/evs/2024/roll007.xml"],
    [119, 1, "https://clerk.house.gov/evs/2025/roll007.xml"],
    [119, 2, "https://clerk.house.gov/evs/2026/roll007.xml"],
  ]);
  for (const [c, s] of [[117, 1], [117, 2], [118, 1], [118, 2], [119, 1], [119, 2]] as const) {
    assert.equal(
      rollIdentity(`senate-${c}-${s}-00042`)!.source_url,
      `https://www.senate.gov/legislative/LIS/roll_call_votes/vote${c}${s}/vote_${c}_${s}_00042.xml`,
    );
  }
  for (const id of ["franklin-prop-cm11-passage", "franklin-prop-hb03-passage"]) assert.equal(rollIdentity(id), null);
});

test("D6: quiet from 15:00Z until the nightly's votes phase closes, 06:00Z at the latest; a span the run did not read is quiet", () => {
  const at = (iso: string) => new Date(iso);
  assert.equal(quietSpanStart(at("2026-11-27T14:59:00Z")), null);
  assert.equal(quietSpanStart(at("2026-11-27T15:00:00Z"))?.toISOString(), "2026-11-27T15:00:00.000Z");
  assert.equal(quietSpanStart(at("2026-11-28T05:59:00Z"))?.toISOString(), "2026-11-27T15:00:00.000Z");
  assert.equal(quietSpanStart(at("2026-11-28T06:00:00Z")), null);
  const span = at("2026-11-27T15:00:00Z");
  assert.equal(senateWindow(at("2026-11-27T10:00:00Z"), null, null).open, true);
  assert.equal(senateWindow(at("2026-11-27T16:00:00Z"), span, null).open, false);
  assert.equal(senateWindow(at("2026-11-27T21:30:00Z"), span, "2026-11-27 21:12:04+00").open, true);
  assert.equal(senateWindow(at("2026-11-28T05:00:00Z"), span, null).open, false);
  // The run read at 14:59 (no span); the clock crossed 15:00Z mid-run.
  assert.equal(senateWindow(at("2026-11-27T15:01:00Z"), null, null).open, false);
  assert.match(senateWindow(at("2026-11-27T16:00:00Z"), span, null).why, /^quiet since 15:00Z/);
});

test("the seed read is the LATERAL loose walk, never a scan", () => {
  assert.match(SEED_SQL, /WITH RECURSIVE r AS/);
  assert.match(SEED_SQL, /CROSS JOIN LATERAL \(SELECT v\.roll_call_id FROM public\.votes v\s+WHERE v\.roll_call_id > r\.roll_call_id\s+ORDER BY v\.roll_call_id LIMIT 1\) n/);
});

test("summaryLine names both hosts' stops, the window and the database time a roll", () => {
  const s = {
    stop: "done", stop_detail: null, seed_ids: 4800, seed_other_shape: 5, seed_inserted: 4795, seed_ms: 1200,
    lists_selected: 6, lists_read: 6, list_rows_filled: 2223, list_rows_missing: 0, list_db_ms: 900,
    senate_window: "open",
    house: { selected: 50, gets: 50, blocked_retries: 0, detailed: 49, not_parsed: 1, transient: 0, failed: 0, stop: "limit", stop_detail: null },
    senate: { selected: 10, gets: 14, blocked_retries: 2, detailed: 3, not_parsed: 0, transient: 0, failed: 0, stop: "blocked", stop_detail: "HTTP 403 on u" },
    failures: [], rolls_detailed: 52, db_ms_total: 530, db_ms_max: 40,
    remaining_house: 2700, remaining_senate: 2220, remaining_list_rolls: 0, elapsed_ms: 75_000, next_due_at: null,
  } satisfies RunSummary;
  const line = summaryLine(s, true);
  assert.match(line, /^vote-rolls APPLY: seed ids=4800 other_shape=5 inserted=4795/);
  assert.match(line, /house detail=49\/50 not_parsed=1 .* stop=limit/);
  assert.match(line, /senate detail=3\/10 .* stop=blocked \(HTTP 403 on u\)/);
  assert.match(line, /db_ms\/roll=10 \(max 40\)/);
});

// ---------------------------------------------------------------------------
// Clone
// ---------------------------------------------------------------------------

const SAVEPOINT_TX: TxControl = {
  begin: async (c) => { await c.query("SAVEPOINT vote_rolls_step"); },
  commit: async (c) => { await c.query("RELEASE SAVEPOINT vote_rolls_step"); },
  rollback: async (c) => { await c.query("ROLLBACK TO SAVEPOINT vote_rolls_step"); },
};

const SCOPE = ["2025-house-336", "2025-house-362", "2021-house-449", "senate-119-2-00243", "senate-117-1-00477", "senate-119-1-00372"];

const FILES: Record<string, string> = {
  "https://clerk.house.gov/evs/2025/roll336.xml": "clerk-house-2025-336-suspension.xml",
  "https://clerk.house.gov/evs/2025/roll362.xml": "clerk-house-2025-362-passage.xml",
  "https://clerk.house.gov/evs/2021/roll449.xml": "clerk-house-2021-449-passage.xml",
  "https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00243.xml": "lis-senate-119-2-00243-cloture-three-fifths.xml",
  "https://www.senate.gov/legislative/LIS/roll_call_votes/vote1171/vote_117_1_00477.xml": "lis-senate-117-1-00477-passage-three-fifths.xml",
  "https://www.senate.gov/legislative/LIS/roll_call_votes/vote1191/vote_119_1_00372.xml": "lis-senate-119-1-00372-tie-breaker.xml",
  "https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_119_2.xml": "lis-vote-menu-119-2.xml",
  "https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_117_1.xml": "lis-vote-menu-117-1.xml",
};

/** The network, replaced: a fixture by URL, `override` first, anything else a 404 as fetchText words it. */
function stubFetch(calls: string[], override: (url: string) => string | Error | null = () => null): RunOptions["fetch"] {
  return async (url) => {
    calls.push(url);
    const o = override(url);
    if (o instanceof Error) throw o;
    if (o !== null) return o;
    const f = FILES[url];
    if (!f) throw new Error(`HTTP 404 Not Found — ${url}\n  Body: `);
    return fixture(f);
  };
}

async function clone(t: { skip: (m: string) => void }): Promise<Client | null> {
  if (process.env["CIVITICS_CLONE_TESTS"] !== "1") {
    t.skip("set CIVITICS_CLONE_TESTS=1 to run against the migrated clone");
    return null;
  }
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  await c.connect();
  if (!(await c.query("SELECT to_regclass('public.vote_rolls') AS r")).rows[0].r) {
    await c.end();
    t.skip("20261127000000 is not applied on the clone");
    return null;
  }
  return c;
}

const notHeld = async (): Promise<HoldReading> => ({ held: false, reason: null });
const DAY = () => new Date("2026-11-27T10:00:00Z");

function opts(c: Client, calls: string[], over: Partial<RunOptions> = {}): RunOptions {
  return {
    client: c, fetch: stubFetch(calls), apply: true, houseLimit: 10, senateLimit: 10, maxMinutes: null,
    isHeld: notHeld, tx: SAVEPOINT_TX, now: DAY, sleep: async () => undefined, onlyIds: SCOPE, log: () => undefined,
    votesPhaseClosedSince: async () => null,
    ...over,
  };
}

async function inTx(t: { skip: (m: string) => void }, fn: (c: Client) => Promise<void>): Promise<void> {
  const c = await clone(t);
  if (!c) return;
  try {
    await c.query("BEGIN");
    try {
      await c.query("DELETE FROM public.vote_rolls WHERE roll_call_id = ANY ($1::text[])", [SCOPE]);
      await fn(c);
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
}

type Stored = { roll_call_id: string; result: string | null; yea: number | null; nay: number | null; present: number | null; not_voting: number | null; majority_requirement: string | null; detail_source: string | null; listed: boolean; detailed: boolean; detail_error: string | null };
async function stored(c: Client): Promise<Map<string, Stored>> {
  const rows = (await c.query<Stored>(
    `SELECT roll_call_id, result, yea, nay, present, not_voting, majority_requirement, detail_source,
            list_fetched_at IS NOT NULL AS listed, detail_fetched_at IS NOT NULL AS detailed, detail_error
       FROM public.vote_rolls WHERE roll_call_id = ANY ($1::text[])`, [SCOPE],
  )).rows;
  return new Map(rows.map((r) => [r.roll_call_id, r]));
}

test("clone: a run seeds, reads the lists and every per-roll file newest first; a second run takes nothing new and rests 12 h", async (t) => {
  await inTx(t, async (c) => {
    const calls: string[] = [];
    const s = await runVoteRolls(opts(c, calls));
    assert.equal(s.stop, "done", s.stop_detail ?? "");
    assert.deepEqual([s.seed_ids, s.seed_other_shape, s.seed_inserted], [6, 0, 6]);
    assert.deepEqual([s.lists_selected, s.lists_read, s.list_rows_filled, s.list_rows_missing], [3, 2, 2, 0], "119-1's list is not a fixture: a 404, named, its roll unlisted");
    assert.deepEqual([s.house.detailed, s.senate.detailed, s.house.stop, s.senate.stop], [3, 3, "none_left", "none_left"]);
    // Newest first, per chamber; the lists before any Senate roll file.
    assert.deepEqual(calls.filter((u) => u.includes("clerk")), [
      "https://clerk.house.gov/evs/2025/roll362.xml",
      "https://clerk.house.gov/evs/2025/roll336.xml",
      "https://clerk.house.gov/evs/2021/roll449.xml",
    ]);
    assert.deepEqual(calls.filter((u) => u.includes("senate.gov")).map((u) => u.replace(/^.*\//, "")), [
      "vote_menu_119_2.xml", "vote_menu_119_1.xml", "vote_menu_117_1.xml",
      "vote_119_2_00243.xml", "vote_119_1_00372.xml", "vote_117_1_00477.xml",
    ]);
    const rows = await stored(c);
    assert.deepEqual(
      [...rows.values()].sort((a, b) => a.roll_call_id.localeCompare(b.roll_call_id)).map((r) => [r.roll_call_id, r.yea, r.nay, r.present, r.not_voting, r.majority_requirement, r.detail_source]),
      [
        ["2021-house-449", 221, 209, 0, 4, "YEA-AND-NAY", "clerk_xml"],
        ["2025-house-336", 388, 0, 0, 45, "2/3 YEA-AND-NAY", "clerk_xml"],
        ["2025-house-362", 215, 201, 0, 17, "YEA-AND-NAY", "clerk_xml"],
        ["senate-117-1-00477", 69, 28, 0, 3, "3/5", "lis_roll_xml"],
        ["senate-119-1-00372", 50, 50, 0, 0, "1/2", "lis_roll_xml"],
        ["senate-119-2-00243", 74, 25, 0, 1, "3/5", "lis_roll_xml"],
      ],
    );
    assert.equal(rows.get("senate-119-2-00243")!.result, "Cloture Motion Agreed to", "the per-roll file replaced the list's short result");
    assert.deepEqual([rows.get("senate-119-2-00243")!.listed, rows.get("senate-119-1-00372")!.listed], [true, false]);
    assert.equal(s.next_due_at !== null, true, "nothing left in scope: rest 12 h");

    const again: string[] = [];
    const s2 = await runVoteRolls(opts(c, again));
    assert.deepEqual([s2.seed_inserted, s2.lists_selected, s2.house.selected, s2.senate.selected, again.length], [0, 0, 0, 0, 0]);
    assert.ok(Date.parse(s2.next_due_at!) - Date.now() > 11.9 * 3_600_000);
  });
});

test("clone: a blocked House stops the House for the run and not the Senate", async (t) => {
  await inTx(t, async (c) => {
    const calls: string[] = [];
    const waits: number[] = [];
    const s = await runVoteRolls(opts(c, calls, {
      fetch: stubFetch(calls, (u) => (u.includes("clerk") ? new Error(`HTTP 403 Forbidden — ${u}\n  Body: `) : null)),
      sleep: async (ms) => { if (ms >= 30_000) waits.push(ms); },
    }));
    assert.equal(s.stop, "done");
    assert.equal(s.house.stop, "blocked");
    assert.deepEqual([s.house.gets, s.house.blocked_retries, s.house.detailed], [3, 2, 0], "one roll: its GET and two retries");
    assert.deepEqual(waits, [30_000, 120_000]);
    assert.deepEqual([s.senate.detailed, s.senate.stop], [3, "none_left"]);
    assert.equal(s.remaining_house, 3);
    assert.equal(s.next_due_at, null);
  });
});

test("clone: D6 — inside the quiet span senate.gov is asked nothing and the House goes on; after the nightly's votes phase closes, the Senate goes on", async (t) => {
  await inTx(t, async (c) => {
    const calls: string[] = [];
    const s = await runVoteRolls(opts(c, calls, { now: () => new Date("2026-11-27T16:00:00Z") }));
    assert.equal(calls.filter((u) => u.includes("senate.gov")).length, 0);
    assert.equal(s.senate.stop, "window");
    assert.equal(s.house.detailed, 3);
    assert.match(s.senate_window, /^quiet since 15:00Z/);

    const later: string[] = [];
    const s2 = await runVoteRolls(opts(c, later, {
      now: () => new Date("2026-11-27T21:30:00Z"),
      votesPhaseClosedSince: async (since) => (since.toISOString() === "2026-11-27T15:00:00.000Z" ? "2026-11-27 21:12:04+00" : null),
    }));
    assert.equal(s2.senate.detailed, 3);
    assert.equal(s2.lists_read, 2);
  });
});

test("clone: a held session stops the run before the next roll", async (t) => {
  await inTx(t, async (c) => {
    const calls: string[] = [];
    let n = 0;
    const s = await runVoteRolls(opts(c, calls, {
      // Free for the start, the three lists and the first House roll; held from the second.
      isHeld: async () => ({ held: ++n > 5, reason: "cc-331 test" }),
    }));
    assert.equal(s.stop, "held");
    assert.equal(s.stop_detail, "prod session held: cc-331 test");
    assert.equal(s.house.detailed, 1);
    assert.equal(s.senate.detailed, 0);
    assert.deepEqual([s.house.stop, s.senate.stop], ["run_stopped", "run_stopped"]);
    assert.equal(s.next_due_at, null);
  });
});

test(`clone: a non-roll body is stamped with its reason and rested ${PARSE_RETRY_DAYS} days`, async (t) => {
  await inTx(t, async (c) => {
    const calls: string[] = [];
    const errorBody = '<xml>Error sanitizing file "roll362.xml". Please try again.</xml>';
    const s = await runVoteRolls(opts(c, calls, {
      senateLimit: 0,
      fetch: stubFetch(calls, (u) => (u.endsWith("/2025/roll362.xml") ? errorBody : null)),
    }));
    assert.deepEqual([s.house.detailed, s.house.not_parsed], [2, 1]);
    assert.equal(calls.filter((u) => u.includes("senate.gov")).length, 0, "--senate-limit 0 sends nothing to senate.gov, the lists included");
    const r = (await stored(c)).get("2025-house-362")!;
    assert.deepEqual([r.detailed, r.detail_error], [false, "non-roll body"]);
    const again: string[] = [];
    const s2 = await runVoteRolls(opts(c, again, { senateLimit: 0 }));
    assert.equal(s2.house.selected, 0, "rested");
    assert.equal(s2.remaining_house, 0);
  });
});
