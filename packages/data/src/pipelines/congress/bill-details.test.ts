/**
 * FIX-1452 (cc-327 Item 3) — the bill-details walker's writer and loop.
 *
 * The unit half needs no database. The clone half (CIVITICS_CLONE_TESTS=1)
 * drives runBillDetails against the migrated local clone with read 2's
 * fixtures in place of the network, inside one BEGIN … ROLLBACK per test; each
 * measure's own transaction is a SAVEPOINT there, so "written whole or not at
 * all" is the savepoint's rollback, and nothing survives the test:
 *   1. one measure writes its sponsor, cosponsors, actions, fills and stamp
 *      together, and a second run takes nothing;
 *   2. a measure whose write fails leaves no row and no stamp, and the run
 *      goes on;
 *   3. a held session stops the loop before the next measure.
 *
 * Runs via:  CIVITICS_CLONE_TESTS=1 tsx --test src/pipelines/congress/bill-details.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  isMeasureLocalDbError,
  parseCliArgs,
  runBillDetails,
  summaryLine,
  type CongressGet,
  type HoldReading,
  type RunSummary,
  type TxControl,
} from "./bill-details";
import type { BillDetailResponse, CosponsorsPage } from "./bill-details-parse";

const LOCAL_DSN = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(__dirname, "__fixtures__", name), "utf8")) as T;
}

// ---------------------------------------------------------------------------
// Unit
// ---------------------------------------------------------------------------

test("parseCliArgs: exactly one of --dry-run / --apply; --only defaults to voted", () => {
  assert.deepEqual(parseCliArgs(["--apply"]), { apply: true, allowProd: false, only: "voted", limit: null, maxMinutes: null });
  assert.deepEqual(
    parseCliArgs(["--apply", "--allow-prod", "--only", "voted", "--limit", "25", "--max-minutes", "8"]),
    { apply: true, allowProd: true, only: "voted", limit: 25, maxMinutes: 8 },
  );
  assert.deepEqual(parseCliArgs(["--dry-run", "--only", "all"]), { apply: false, allowProd: false, only: "all", limit: null, maxMinutes: null });
  assert.ok("error" in parseCliArgs([]));
  assert.ok("error" in parseCliArgs(["--apply", "--dry-run"]));
  assert.ok("error" in parseCliArgs(["--apply", "--only", "some"]));
  assert.ok("error" in parseCliArgs(["--apply", "--limit", "0"]));
});

test("isMeasureLocalDbError: integrity and data errors fail the measure; cancels, lock and connection errors stop the run", () => {
  assert.equal(isMeasureLocalDbError({ code: "23503" }), true, "FK violation");
  assert.equal(isMeasureLocalDbError({ code: "22P02" }), true, "bad input");
  assert.equal(isMeasureLocalDbError({ code: "57014" }), false, "statement cancelled");
  assert.equal(isMeasureLocalDbError({ code: "55P03" }), false, "lock timeout");
  assert.equal(isMeasureLocalDbError({ code: "08006" }), false, "connection failure");
  assert.equal(isMeasureLocalDbError(new Error("x")), false);
});

test("summaryLine names the stop and the per-measure database time", () => {
  const s = {
    stop: "limit", stop_detail: null, selected: 30, remaining: 20, measures_done: 10, measures_stamped: 10,
    measures_not_found: 0, measures_failed: 0, failures: [], requests: 34, sponsors_set: 9, sponsors_same: 0,
    sponsors_kept_differs: 0, sponsors_unresolved_none: 1, sponsors_unresolved_many: 0, sponsors_absent: 0,
    no_bill_details: 0, cosponsors_source: 140, cosponsors_inserted: 120, cosponsors_updated: 0,
    cosponsors_unresolved: 20, actions_source: 400, actions_inserted: 400, actions_undated: 0,
    actions_duplicate_key: 0, titles_filled: 2, titles_kept_differs: 0, introduced_filled: 1,
    introduced_replaced_placeholder: 0, introduced_kept_differs: 0, db_ms_total: 400, db_ms_max: 80, elapsed_ms: 33_000,
    next_due_at: null,
  } satisfies RunSummary;
  const line = summaryLine(s, true);
  assert.match(line, /^bill-details APPLY: measures=10 /);
  assert.match(line, /stop=limit remaining=20/);
  assert.match(line, /db_ms\/measure=40 \(max 80\)/);
  assert.match(line, /s\/measure=3\.30/);
});

// ---------------------------------------------------------------------------
// Clone
// ---------------------------------------------------------------------------

const SAVEPOINT_TX: TxControl = {
  begin: async (c) => { await c.query("SAVEPOINT bill_details_measure"); },
  commit: async (c) => { await c.query("RELEASE SAVEPOINT bill_details_measure"); },
  rollback: async (c) => { await c.query("ROLLBACK TO SAVEPOINT bill_details_measure"); },
};

const hr1 = {
  detail: fixture<BillDetailResponse>("bill-119-hr-1-detail.json"),
  actions: fixture<unknown>("bill-119-hr-1-actions.json"),
  titles: fixture<unknown>("bill-119-hr-1-titles.json"),
};
const sj18 = {
  detail: fixture<BillDetailResponse>("bill-119-sjres-18-detail.json"),
  cosponsors: fixture<CosponsorsPage>("bill-119-sjres-18-cosponsors.json"),
  actions: fixture<unknown>("bill-119-sjres-18-actions.json"),
  titles: fixture<unknown>("bill-119-sjres-18-titles.json"),
};
const BAD_BIOGUIDE = "Z999001";

/**
 * The network, replaced. `bill/999/hr/N` serves HR 1's responses; `999/sjres/18`
 * SJRES 18's; `999/hr/2` SJRES 18's with one extra cosponsor whose bioguide
 * resolves to an official id that does not exist (an FK violation mid-write).
 */
function stubGet(calls: string[]): CongressGet {
  return async <T>(path: string): Promise<T> => {
    calls.push(path);
    const m = path.match(/^bill\/999\/([a-z]+)\/(\d+)(?:\/(cosponsors|actions|titles))?/);
    if (!m) throw new Error(`Congress.gov API error: 404 Not Found — ${path}`);
    const [, type, num, sub] = m;
    const src = type === "sjres" || num === "2" ? sj18 : hr1;
    if (!sub) return src.detail as T;
    if (sub === "actions") return src.actions as T;
    if (sub === "titles") return src.titles as T;
    const page = (src as typeof sj18).cosponsors;
    if (num === "2") {
      return { ...page, cosponsors: [...(page.cosponsors ?? []), { bioguideId: BAD_BIOGUIDE, fullName: "Rep. Nobody", isOriginalCosponsor: false, sponsorshipDate: "2025-03-01" }] } as T;
    }
    return page as T;
  };
}

async function clone(t: { skip: (m: string) => void }): Promise<Client | null> {
  if (process.env["CIVITICS_CLONE_TESTS"] !== "1") {
    t.skip("set CIVITICS_CLONE_TESTS=1 to run against the migrated clone");
    return null;
  }
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  await c.connect();
  return c;
}

interface Seeded { id: string; key: string; refId: string }

/** A proposal + bill_details + congress_gov ref under a congress no real bill has (999). */
async function seed(c: Client, key: string, opts: { title: string | null; billNumber: string; introduced: string | null; lastAction: string }): Promise<Seeded> {
  const fed: { j: string; g: string | null } = (await c.query(
    `SELECT p.jurisdiction_id AS j, p.governing_body_id AS g
       FROM public.proposals p JOIN public.external_source_refs x ON x.entity_id = p.id
      WHERE x.source = 'congress_gov' AND x.entity_type = 'proposal' LIMIT 1`,
  )).rows[0];
  const id = randomUUID();
  await c.query(
    `INSERT INTO public.proposals (id, title, type, status, jurisdiction_id, governing_body_id, introduced_at, last_action_at)
     VALUES ($1, $2, 'bill', 'introduced', $3, $4, $5, $6)`,
    [id, opts.title ?? opts.billNumber, fed.j, fed.g, opts.introduced, opts.lastAction],
  );
  await c.query(
    `INSERT INTO public.bill_details (proposal_id, bill_number, jurisdiction_id, session, congress_number, chamber)
     VALUES ($1, $2, $3, '999-cc327-test', 999, 'house')`,
    [id, opts.billNumber, fed.j],
  );
  const ref: { id: string } = (await c.query(
    `INSERT INTO public.external_source_refs (source, external_id, entity_type, entity_id, metadata)
     VALUES ('congress_gov', $1, 'proposal', $2, '{}'::jsonb) RETURNING id`,
    [key, id],
  )).rows[0];
  return { id, key, refId: ref.id };
}

async function threeOfficials(c: Client): Promise<[string, string, string]> {
  const rows = (await c.query<{ id: string }>(`SELECT id FROM public.officials ORDER BY id LIMIT 3`)).rows;
  assert.equal(rows.length, 3, "the clone carries officials");
  return [rows[0]!.id, rows[1]!.id, rows[2]!.id];
}

const notHeld = async (): Promise<HoldReading> => ({ held: false, reason: null });

test("clone: a measure writes sponsor, cosponsors, actions, fills and stamp together; a second run takes nothing", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await c.query("BEGIN");
    const [o1, o2, o3] = await threeOfficials(c);
    const items = sj18.cosponsors.cosponsors ?? [];
    const officials = [
      { id: o1, source_ids: { congress_gov: hr1.detail.bill!.sponsors![0]!.bioguideId! } },
      { id: o2, source_ids: { congress_gov: sj18.detail.bill!.sponsors![0]!.bioguideId! } },
      { id: o3, source_ids: { congress_gov: items[0]!.bioguideId! } },
      { id: o1, source_ids: { congress_gov: items[1]!.bioguideId! } },
      // items[2]: on two rows → unresolved, never guessed
      { id: o2, source_ids: { congress_gov: items[2]!.bioguideId! } },
      { id: o3, source_ids: { congress_gov: items[2]!.bioguideId! } },
    ];
    // HR 1: titled by its number, no introduced date. SJRES 18: a real title kept.
    const a = await seed(c, "999-HR-1", { title: null, billNumber: "HR 1", introduced: null, lastAction: "2025-07-04" });
    const b = await seed(c, "999-SJRES-18", { title: "A stored title", billNumber: "SJRES 18", introduced: "2025-02-13", lastAction: "2025-05-09" });
    const calls: string[] = [];
    const run = (): Promise<RunSummary> => runBillDetails({
      client: c, get: stubGet(calls), apply: true, only: "all", limit: null, maxMinutes: null,
      isHeld: notHeld, tx: SAVEPOINT_TX, keys: [a.key, b.key], officials, log: () => undefined,
    });

    const s = await run();
    assert.equal(s.selected, 2);
    assert.equal(s.measures_stamped, 2);
    assert.equal(s.measures_failed, 0);
    assert.equal(s.stop, "done");
    assert.equal(calls.filter((p) => p.startsWith("bill/999/hr/1/cosponsors")).length, 0, "HR 1 lists no cosponsors: not requested");
    assert.equal(s.requests, 3 + 4);

    // HR 1
    const pa = (await c.query(
      `SELECT p.title, p.introduced_at::text AS intro, bd.primary_sponsor_id AS sp,
              (SELECT count(*)::int FROM public.proposal_actions WHERE proposal_id = p.id) AS n_actions,
              (SELECT count(*)::int FROM public.proposal_cosponsors WHERE proposal_id = p.id) AS n_cos,
              x.metadata -> 'detail' AS d
         FROM public.proposals p JOIN public.bill_details bd ON bd.proposal_id = p.id
         JOIN public.external_source_refs x ON x.id = $2
        WHERE p.id = $1`, [a.id, a.refId])).rows[0];
    assert.equal(pa.sp, o1, "the sponsor's bioguide resolved to exactly one row");
    assert.equal(pa.title, hr1.detail.bill!.title, "a number-only title is filled");
    assert.equal(pa.intro, "2025-05-20", "a NULL introduced date is filled");
    assert.equal(pa.n_actions, 59);
    assert.equal(pa.n_cos, 0);
    assert.ok(pa.d.fetched_at);
    assert.equal(pa.d.sponsor.bioguide, "A000375");
    assert.equal(pa.d.cosponsor_count, 0);
    assert.equal(pa.d.short_title, "One Big Beautiful Bill Act");
    assert.equal(pa.d.title_outcome, "filled");

    // SJRES 18
    const pb = (await c.query(
      `SELECT p.title, p.introduced_at::text AS intro, bd.primary_sponsor_id AS sp,
              (SELECT count(*)::int FROM public.proposal_actions WHERE proposal_id = p.id) AS n_actions,
              x.metadata -> 'detail' AS d
         FROM public.proposals p JOIN public.bill_details bd ON bd.proposal_id = p.id
         JOIN public.external_source_refs x ON x.id = $2
        WHERE p.id = $1`, [b.id, b.refId])).rows[0];
    assert.equal(pb.title, "A stored title", "a real stored title is never overwritten");
    assert.equal(pb.d.title_outcome, "kept_differs");
    assert.equal(pb.sp, o2);
    assert.equal(pb.n_actions, (sj18.actions as { actions: unknown[] }).actions.length);
    assert.equal(pb.d.cosponsor_count, 16, "the SOURCE's count");
    assert.equal(pb.d.cosponsors_resolved, 2);
    assert.equal(pb.d.cosponsors_unresolved.length, 14);
    assert.ok(pb.d.cosponsors_unresolved.some((u: { bioguide: string; why: string }) => u.bioguide === items[2]!.bioguideId && u.why === "many"));
    const cos = (await c.query(
      `SELECT official_id, is_original_cosponsor, date_added::text AS added, source
         FROM public.proposal_cosponsors WHERE proposal_id = $1 ORDER BY official_id`, [b.id])).rows;
    assert.deepEqual(cos.map((r) => r.official_id).sort(), [o1, o3].sort());
    assert.ok(cos.every((r) => r.source === "congress_gov"));
    const timed = (await c.query(
      `SELECT action_at, action_type, source, length(source_key) AS klen
         FROM public.proposal_actions
        WHERE proposal_id = $1 AND metadata ->> 'action_code' = 'H37100'`, [b.id])).rows[0];
    assert.equal(new Date(timed.action_at).toISOString(), "2025-04-09T20:26:08.000Z", "16:26:08 Eastern is 20:26:08Z");
    assert.equal(timed.source, "congress_gov");
    assert.equal(timed.klen, 32);

    // a second run selects nothing and writes nothing
    const before = calls.length;
    const again = await run();
    assert.equal(again.selected, 0);
    assert.equal(again.measures_done, 0);
    assert.equal(again.stop, "done");
    assert.equal(calls.length, before, "no request");
    // cc-318 D7: an empty selection rests its row 12 h (new measures arrive with the nightly)
    assert.equal(s.next_due_at, null, "a run that took measures reports no next_due_at");
    const restH = (Date.parse(again.next_due_at!) - Date.now()) / 3_600_000;
    assert.ok(restH > 11.9 && restH <= 12, `next_due_at ${again.next_due_at} is now + 12 h`);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await c.end();
  }
});

test("clone: a measure whose write fails leaves no row and no stamp, and the run goes on", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await c.query("BEGIN");
    const [o1, o2, o3] = await threeOfficials(c);
    const items = sj18.cosponsors.cosponsors ?? [];
    const officials = [
      { id: o1, source_ids: { congress_gov: sj18.detail.bill!.sponsors![0]!.bioguideId! } },
      { id: o2, source_ids: { congress_gov: items[0]!.bioguideId! } },
      { id: o3, source_ids: { congress_gov: hr1.detail.bill!.sponsors![0]!.bioguideId! } },
      // resolves "exactly one" — to an id no officials row has: the FK refuses mid-write
      { id: randomUUID(), source_ids: { congress_gov: BAD_BIOGUIDE } },
    ];
    const bad = await seed(c, "999-HR-2", { title: null, billNumber: "HR 2", introduced: null, lastAction: "2025-06-01" });
    const good = await seed(c, "999-HR-5", { title: null, billNumber: "HR 5", introduced: null, lastAction: "2025-05-01" });
    const s = await runBillDetails({
      client: c, get: stubGet([]), apply: true, only: "all", limit: null, maxMinutes: null,
      isHeld: notHeld, tx: SAVEPOINT_TX, keys: [bad.key, good.key], officials, log: () => undefined,
    });
    assert.equal(s.measures_failed, 1);
    assert.match(s.failures[0]!.why, /^db 23503/);
    assert.equal(s.failures[0]!.key, "999-HR-2");
    assert.equal(s.measures_stamped, 1, "the next measure still ran");
    assert.equal(s.stop, "done");
    const left = (await c.query(
      `SELECT bd.primary_sponsor_id AS sp, p.title, p.introduced_at,
              (SELECT count(*)::int FROM public.proposal_actions WHERE proposal_id = p.id) AS n_actions,
              (SELECT count(*)::int FROM public.proposal_cosponsors WHERE proposal_id = p.id) AS n_cos,
              x.metadata AS m
         FROM public.proposals p JOIN public.bill_details bd ON bd.proposal_id = p.id
         JOIN public.external_source_refs x ON x.id = $2
        WHERE p.id = $1`, [bad.id, bad.refId])).rows[0];
    assert.equal(left.sp, null, "no sponsor");
    assert.equal(left.title, "HR 2", "no title fill");
    assert.equal(left.introduced_at, null);
    assert.equal(left.n_actions, 0, "no action row");
    assert.equal(left.n_cos, 0, "no cosponsor row");
    assert.deepEqual(left.m, {}, "no stamp");
    const ok = (await c.query(`SELECT count(*)::int AS n FROM public.proposal_actions WHERE proposal_id = $1`, [good.id])).rows[0];
    assert.equal(ok.n, 59);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await c.end();
  }
});

test("clone: a held session stops the loop before the next measure", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await c.query("BEGIN");
    const [o1] = await threeOfficials(c);
    const officials = [{ id: o1, source_ids: { congress_gov: hr1.detail.bill!.sponsors![0]!.bioguideId! } }];
    const first = await seed(c, "999-HR-3", { title: null, billNumber: "HR 3", introduced: null, lastAction: "2025-07-02" });
    const second = await seed(c, "999-HR-4", { title: null, billNumber: "HR 4", introduced: null, lastAction: "2025-07-01" });
    let reads = 0;
    const calls: string[] = [];
    const s = await runBillDetails({
      client: c, get: stubGet(calls), apply: true, only: "all", limit: null, maxMinutes: null,
      isHeld: async () => ({ held: ++reads > 1, reason: "cc-327 test hold" }),
      tx: SAVEPOINT_TX, keys: [first.key, second.key], officials, log: () => undefined,
    });
    assert.equal(s.stop, "held");
    assert.equal(s.stop_detail, "prod session held: cc-327 test hold");
    assert.equal(s.measures_stamped, 1);
    assert.equal(s.remaining, 1);
    assert.ok(calls.every((p) => !p.startsWith("bill/999/hr/4")), "the held measure was not even fetched");
    const stamps = (await c.query(
      `SELECT external_id, (metadata -> 'detail' ->> 'fetched_at') IS NOT NULL AS stamped
         FROM public.external_source_refs WHERE id = ANY ($1::uuid[]) ORDER BY external_id`,
      [[first.refId, second.refId]])).rows;
    assert.deepEqual(stamps, [{ external_id: "999-HR-3", stamped: true }, { external_id: "999-HR-4", stamped: false }]);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await c.end();
  }
});
