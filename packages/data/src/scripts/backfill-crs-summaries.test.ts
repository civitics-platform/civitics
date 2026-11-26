/**
 * FIX-1455 (cc-318 Item 1) — the CRS walker in a box, and the cursor it needs.
 *
 * The unit half needs no database. The clone half (CIVITICS_CLONE_TESTS=1)
 * drives runCrsSummaries against the migrated local clone with fixtures in
 * place of the network, inside one BEGIN … ROLLBACK per test; each measure's
 * own transaction is a SAVEPOINT there:
 *   1. a run stamps what it asks; a second run inside 7 days takes none of
 *      them and reaches the next measures;
 *   2. a never-asked measure precedes an asked one; a measure with a summary
 *      is never taken;
 *   3. --max-minutes and a held session stop between measures, the row
 *      complete | partial (skipped only when held before the first measure);
 *   4. an empty selection writes next_due_at;
 *   5. the stamp leaves the bill-details walker's `detail` key on the same ref
 *      intact, and the reverse; the don't-clobber UPDATE keeps a filled summary.
 *
 * Runs via:  CIVITICS_CLONE_TESTS=1 tsx --test src/scripts/backfill-crs-summaries.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  REASK_AFTER_DAYS,
  closeAs,
  latestSummaryText,
  parseCliArgs,
  runCrsSummaries,
  runMetadata,
  summaryLine,
  writeMeasure,
  type CongressGet,
  type RunSummary,
} from "./backfill-crs-summaries";
import { runBillDetails, type HoldReading, type TxControl } from "../pipelines/congress/bill-details";

const LOCAL_DSN = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// ---------------------------------------------------------------------------
// Unit
// ---------------------------------------------------------------------------

const SUMMARY = {
  summaries: [
    { actionDate: "2025-01-03", text: "<p>The introduced version.</p>", updateDate: "2025-01-10T00:00:00Z", versionCode: "00" },
    { actionDate: "2025-03-01", text: "<p><strong>Clean Water Act</strong></p><p>This bill does X &amp; Y.</p>", updateDate: "2025-03-05T00:00:00Z", versionCode: "07" },
  ],
};
const TEXT = "Clean Water Act This bill does X & Y.";

test("parseCliArgs: exactly one of --dry-run / --apply; --limit and --max-minutes are positive", () => {
  assert.deepEqual(parseCliArgs(["--apply", "--allow-prod"]), { apply: true, allowProd: true, limit: null, maxMinutes: null });
  assert.deepEqual(parseCliArgs(["--dry-run", "--limit", "10", "--max-minutes", "15"]), { apply: false, allowProd: false, limit: 10, maxMinutes: 15 });
  assert.ok("error" in parseCliArgs([]));
  assert.ok("error" in parseCliArgs(["--apply", "--dry-run"]));
  assert.ok("error" in parseCliArgs(["--apply", "--max-minutes", "0"]));
  assert.ok("error" in parseCliArgs(["--apply", "--max-minutes", ""]), "the workflow passes the flag only when its input is set");
});

test("latestSummaryText takes the newest version and strips it to prose", () => {
  assert.equal(latestSummaryText(SUMMARY), TEXT);
  assert.equal(latestSummaryText({ summaries: [] }), null);
  assert.equal(latestSummaryText({}), null);
});

const base = (o: Partial<RunSummary>): RunSummary => ({
  stop: "done", stop_detail: null, selected: 0, remaining: 0, asked: 0, written: 0, already_filled: 0, none: 0,
  not_found: 0, unparseable: 0, failed: 0, failures: [], requests: 0, next_due_at: null, elapsed_ms: 0, ...o,
});

test("closeAs: a clean stop is complete or partial; held before any measure is skipped; only a run-level db error fails", () => {
  assert.equal(closeAs(base({ stop: "done" })), "complete");
  assert.equal(closeAs(base({ stop: "done", next_due_at: "2026-12-01T00:00:00Z" })), "complete", "an empty selection advances");
  for (const stop of ["limit", "max_minutes", "api_errors"] as const) assert.equal(closeAs(base({ stop, asked: 3 })), "partial", stop);
  assert.equal(closeAs(base({ stop: "held", asked: 1 })), "partial");
  assert.equal(closeAs(base({ stop: "held" })), "skipped");
  assert.equal(closeAs(base({ stop: "db_error", asked: 2 })), "failed");
});

test("summaryLine and runMetadata: the counts, the stop, and next_due_at only when set", () => {
  const s = base({ stop: "max_minutes", selected: 1200, remaining: 80, asked: 1100, written: 9, none: 1080, not_found: 11, failed: 2, requests: 1102, elapsed_ms: 900_000 });
  const line = summaryLine(s, true);
  assert.match(line, /^crs-summaries APPLY: asked=1100 \(written 9, already_filled 0, none 1080, not_found 11\) unparseable=0 failed=2 requests=1102/);
  assert.match(line, /stop=max_minutes selected=1200 remaining=80 elapsed=900\.0s$/);
  const args = { apply: true, allowProd: true, limit: null, maxMinutes: 15 };
  assert.equal("next_due_at" in runMetadata(s, args), false);
  const empty = runMetadata(base({ next_due_at: "2026-12-01T00:00:00Z" }), args);
  assert.equal(empty["next_due_at"], "2026-12-01T00:00:00Z");
  assert.equal(empty["max_minutes"], 15);
  assert.equal(empty["reask_after_days"], REASK_AFTER_DAYS);
});

// ---------------------------------------------------------------------------
// Clone
// ---------------------------------------------------------------------------

const SAVEPOINT_TX: TxControl = {
  begin: async (c) => { await c.query("SAVEPOINT crs_measure"); },
  commit: async (c) => { await c.query("RELEASE SAVEPOINT crs_measure"); },
  rollback: async (c) => { await c.query("ROLLBACK TO SAVEPOINT crs_measure"); },
};

/** The network, replaced: hr/1 has a summary, hr/3 is a 404, hr/5 a 503, every other measure none yet. */
function stubGet(calls: string[], onCall?: () => void): CongressGet {
  return async <T>(path: string): Promise<T> => {
    calls.push(path);
    onCall?.();
    const m = path.match(/^bill\/999\/([a-z]+)\/(\d+)\/summaries$/);
    if (!m) throw new Error(`Congress.gov API error: 404 Not Found — ${path}?api_key=SECRET`);
    if (m[2] === "1") return SUMMARY as T;
    if (m[2] === "3") throw new Error(`Congress.gov API error: 404 Not Found — https://api.congress.gov/v3/${path}?api_key=SECRET`);
    if (m[2] === "5") throw new Error(`Congress.gov API error: 503 Service Unavailable — https://api.congress.gov/v3/${path}?api_key=SECRET`);
    return { summaries: [] } as T;
  };
}

const notHeld = async (): Promise<HoldReading> => ({ held: false, reason: null });

async function clone(t: { skip: (m: string) => void }): Promise<Client | null> {
  if (process.env["CIVITICS_CLONE_TESTS"] !== "1") {
    t.skip("set CIVITICS_CLONE_TESTS=1 to run against the migrated clone");
    return null;
  }
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  await c.connect();
  return c;
}

/** One rolled-back transaction per test. */
async function inTx(t: { skip: (m: string) => void }, fn: (c: Client) => Promise<void>): Promise<void> {
  const c = await clone(t);
  if (!c) return;
  try {
    await c.query("BEGIN");
    await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await c.end();
  }
}

interface Seeded { id: string; key: string; refId: string }

/**
 * A proposal and its congress_gov ref under a congress no real bill has (999).
 * `askedDaysAgo` writes metadata.crs as the walker would have; `metadata` adds
 * other keys (the bill-details walker's `detail`).
 */
async function seed(c: Client, key: string, o: { summary?: string | null; askedDaysAgo?: number; metadata?: Record<string, unknown> } = {}): Promise<Seeded> {
  const fed: { j: string; g: string | null } = (await c.query(
    `SELECT p.jurisdiction_id AS j, p.governing_body_id AS g
       FROM public.proposals p JOIN public.external_source_refs x ON x.entity_id = p.id
      WHERE x.source = 'congress_gov' AND x.entity_type = 'proposal' LIMIT 1`,
  )).rows[0];
  const id = randomUUID();
  await c.query(
    `INSERT INTO public.proposals (id, title, type, status, jurisdiction_id, governing_body_id, summary_plain)
     VALUES ($1, $2, 'bill', 'introduced', $3, $4, $5)`,
    [id, key, fed.j, fed.g, o.summary ?? null],
  );
  const ref: { id: string } = (await c.query(
    `INSERT INTO public.external_source_refs (source, external_id, entity_type, entity_id, metadata)
     VALUES ('congress_gov', $1, 'proposal', $2,
             $3::jsonb || CASE WHEN $4::int IS NULL THEN '{}'::jsonb
                               ELSE jsonb_build_object('crs', jsonb_build_object('asked_at', now() - make_interval(days => $4::int), 'result', 'none')) END)
     RETURNING id`,
    [key, id, JSON.stringify(o.metadata ?? {}), o.askedDaysAgo ?? null],
  )).rows[0];
  return { id, key, refId: ref.id };
}

async function crs(c: Client, refId: string): Promise<{ asked_at: string; result: string } | null> {
  return (await c.query(`SELECT metadata -> 'crs' AS crs FROM public.external_source_refs WHERE id = $1`, [refId])).rows[0].crs;
}

test("clone: a run stamps what it asks; a second run inside 7 days takes none of them and reaches the next measures", async (t) => {
  await inTx(t, async (c) => {
    const a = await seed(c, "999-HR-1");
    const b = await seed(c, "999-HR-2");
    const n = await seed(c, "999-HR-3");
    const d = await seed(c, "999-HR-4");
    const keys = [a.key, b.key, n.key, d.key];
    const calls: string[] = [];
    const run = (limit: number | null) => runCrsSummaries({
      client: c, get: stubGet(calls), apply: true, limit, maxMinutes: null,
      isHeld: notHeld, tx: SAVEPOINT_TX, keys, log: () => undefined,
    });

    const s1 = await run(3);
    assert.equal(s1.selected, 4);
    assert.equal(s1.stop, "limit");
    assert.equal(s1.remaining, 1);
    assert.deepEqual([s1.asked, s1.written, s1.none, s1.not_found], [3, 1, 1, 1]);
    assert.equal(closeAs(s1), "partial");
    assert.equal((await crs(c, a.refId))?.result, "summary");
    assert.equal((await crs(c, b.refId))?.result, "none");
    assert.equal((await crs(c, n.refId))?.result, "not_found");
    assert.equal(await crs(c, d.refId), null, "the measure past the limit is not stamped");
    assert.ok(Date.parse((await crs(c, a.refId))!.asked_at) > Date.now() - 3_600_000, "asked_at is an instant");
    assert.equal((await c.query(`SELECT summary_plain FROM public.proposals WHERE id = $1`, [a.id])).rows[0].summary_plain, TEXT);

    const before = calls.length;
    const s2 = await run(null);
    assert.equal(s2.selected, 1, "hr/1 has a summary now; hr/2 and hr/3 were asked inside 7 days");
    assert.deepEqual(calls.slice(before), ["bill/999/hr/4/summaries"], "it reaches the next measure");
    assert.equal(s2.stop, "done");
    assert.equal(closeAs(s2), "complete");
    assert.equal(s2.next_due_at, null, "a run that took a measure reports no next_due_at");
  });
});

test("clone: a never-asked measure precedes an asked one; a measure with a summary is never taken", async (t) => {
  await inTx(t, async (c) => {
    const asked = await seed(c, "999-HR-10", { askedDaysAgo: REASK_AFTER_DAYS + 1 });
    const fresh = await seed(c, "999-HR-11");
    const filled = await seed(c, "999-HR-12", { summary: "A summary already stored." });
    const calls: string[] = [];
    const s = await runCrsSummaries({
      client: c, get: stubGet(calls), apply: true, limit: 1, maxMinutes: null,
      isHeld: notHeld, tx: SAVEPOINT_TX, keys: [asked.key, fresh.key, filled.key], log: () => undefined,
    });
    assert.equal(s.selected, 2, "the filled measure is not selected");
    assert.deepEqual(calls, ["bill/999/hr/11/summaries"], "never asked first, although 999-HR-10 sorts before it");
    assert.equal(await crs(c, filled.refId), null);

    const all = await runCrsSummaries({
      client: c, get: stubGet(calls), apply: true, limit: null, maxMinutes: null,
      isHeld: notHeld, tx: SAVEPOINT_TX, keys: [asked.key, fresh.key, filled.key], log: () => undefined,
    });
    assert.equal(all.selected, 1, "then the one asked over 7 days ago");
    assert.equal(calls.at(-1), "bill/999/hr/10/summaries");
    assert.ok(calls.every((p) => !p.includes("/hr/12/")), "a measure with a summary is never asked");
  });
});

test("clone: --max-minutes and a held session stop between measures; three 503s stop the run", async (t) => {
  await inTx(t, async (c) => {
    const ms = [await seed(c, "999-HR-20"), await seed(c, "999-HR-21"), await seed(c, "999-HR-22")];
    const keys = ms.map((m) => m.key);
    // A clock that moves 6 minutes per request: a 10-minute box asks two.
    let clock = 0;
    const calls: string[] = [];
    const boxed = await runCrsSummaries({
      client: c, get: stubGet(calls, () => { clock += 6 * 60_000; }), apply: true, limit: null, maxMinutes: 10,
      isHeld: notHeld, tx: SAVEPOINT_TX, keys, now: () => clock, log: () => undefined,
    });
    assert.equal(boxed.stop, "max_minutes");
    assert.equal(boxed.asked, 2);
    assert.equal(boxed.remaining, 1);
    assert.equal(closeAs(boxed), "partial");
    assert.equal(await crs(c, ms[2]!.refId), null, "the third measure was not asked");

    const more = [await seed(c, "999-HR-30"), await seed(c, "999-HR-31")];
    let reads = 0;
    const held = await runCrsSummaries({
      client: c, get: stubGet([]), apply: true, limit: null, maxMinutes: null,
      isHeld: async () => ({ held: ++reads > 1, reason: "cc-318 test hold" }),
      tx: SAVEPOINT_TX, keys: more.map((m) => m.key), log: () => undefined,
    });
    assert.equal(held.stop, "held");
    assert.equal(held.stop_detail, "prod session held: cc-318 test hold");
    assert.equal(held.asked, 1);
    assert.equal(closeAs(held), "partial");
    assert.equal(await crs(c, more[1]!.refId), null, "the held measure was not asked");

    const first = await runCrsSummaries({
      client: c, get: stubGet([]), apply: true, limit: null, maxMinutes: null,
      isHeld: async () => ({ held: true, reason: "cc-318 test hold" }),
      tx: SAVEPOINT_TX, keys: more.map((m) => m.key), log: () => undefined,
    });
    assert.equal(closeAs(first), "skipped", "held before the first measure: nothing asked, the row does not advance");

    // hr/5, hres/5, s/5 answer 503 and sort first; sres/40 is the measure the stop leaves.
    const bad = [await seed(c, "999-HR-5"), await seed(c, "999-HRES-5"), await seed(c, "999-S-5"), await seed(c, "999-SRES-40")];
    const api = await runCrsSummaries({
      client: c, get: stubGet([]), apply: true, limit: null, maxMinutes: null,
      isHeld: notHeld, tx: SAVEPOINT_TX, keys: bad.map((m) => m.key), backoffMs: () => 0, log: () => undefined,
    });
    assert.equal(api.stop, "api_errors");
    assert.equal(api.failed, 3);
    assert.equal(api.remaining, 1);
    assert.equal(closeAs(api), "partial");
    assert.doesNotMatch(JSON.stringify(api.failures), /SECRET/, "the key is redacted before a failure is kept");
    for (const m of bad) assert.equal(await crs(c, m.refId), null, "a transient failure is not stamped");
  });
});

test("clone: an empty selection writes next_due_at — the oldest asked + 7 days, at least 2 h out; 12 h with none left", async (t) => {
  await inTx(t, async (c) => {
    const recent = await seed(c, "999-HR-50", { askedDaysAgo: 3 });
    const older = await seed(c, "999-HR-51", { askedDaysAgo: 5 });
    const s = await runCrsSummaries({
      client: c, get: stubGet([]), apply: true, limit: null, maxMinutes: null,
      isHeld: notHeld, tx: SAVEPOINT_TX, keys: [recent.key, older.key], log: () => undefined,
    });
    assert.equal(s.selected, 0);
    assert.equal(closeAs(s), "complete");
    const dbNow = Date.parse((await c.query(`SELECT now() AS n`)).rows[0].n);
    const days = (Date.parse(s.next_due_at!) - dbNow) / 86_400_000;
    assert.ok(Math.abs(days - 2) < 0.001, `the 5-day-old ask is due again in 2 days, got ${days}`);
    assert.match(s.next_due_at!, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/, "the dispatcher's next_due_at shape");

    const nearly = await seed(c, "999-HR-52", { askedDaysAgo: REASK_AFTER_DAYS });
    await c.query(`UPDATE public.external_source_refs SET metadata = jsonb_set(metadata, '{crs,asked_at}', to_jsonb(now() - interval '7 days' + interval '30 minutes')) WHERE id = $1`, [nearly.refId]);
    const soon = await runCrsSummaries({
      client: c, get: stubGet([]), apply: true, limit: null, maxMinutes: null,
      isHeld: notHeld, tx: SAVEPOINT_TX, keys: [nearly.key], log: () => undefined,
    });
    const hours = (Date.parse(soon.next_due_at!) - dbNow) / 3_600_000;
    assert.ok(Math.abs(hours - 2) < 0.01, `due in 30 min, rested at least 2 h: got ${hours}`);

    const done = await seed(c, "999-HR-53", { summary: "Stored." });
    const none = await runCrsSummaries({
      client: c, get: stubGet([]), apply: true, limit: null, maxMinutes: null,
      isHeld: notHeld, tx: SAVEPOINT_TX, keys: [done.key], log: () => undefined,
    });
    const empty = (Date.parse(none.next_due_at!) - dbNow) / 3_600_000;
    assert.ok(Math.abs(empty - 12) < 0.01, `nothing without a summary: 12 h, got ${empty}`);
  });
});

test("clone: the CRS stamp keeps the bill-details walker's detail key, and the reverse; a filled summary is never overwritten", async (t) => {
  await inTx(t, async (c) => {
    const detail = { fetched_at: "2026-11-26T05:00:00.000Z", sponsor: { bioguide: "S001213", name: "Rep. Steil" }, action_count: 28 };
    const a = await seed(c, "999-HR-60", { metadata: { detail, other: 1 } });
    await runCrsSummaries({
      client: c, get: stubGet([]), apply: true, limit: null, maxMinutes: null,
      isHeld: notHeld, tx: SAVEPOINT_TX, keys: [a.key], log: () => undefined,
    });
    const m = (await c.query(`SELECT metadata FROM public.external_source_refs WHERE id = $1`, [a.refId])).rows[0].metadata;
    assert.deepEqual(m.detail, detail, "detail untouched");
    assert.equal(m.other, 1);
    assert.equal(m.crs.result, "none");

    // The reverse: the bill-details walker's stamp on a ref that carries crs.
    const fixture = (name: string): unknown =>
      JSON.parse(readFileSync(join(__dirname, "..", "pipelines", "congress", "__fixtures__", name), "utf8"));
    const hr1: Record<string, unknown> = {
      detail: fixture("bill-119-hr-1-detail.json"),
      actions: fixture("bill-119-hr-1-actions.json"),
      titles: fixture("bill-119-hr-1-titles.json"),
    };
    const b = await seed(c, "999-HR-61", { askedDaysAgo: 1 });
    const crsBefore = await crs(c, b.refId);
    const bd = await runBillDetails({
      client: c,
      get: async <T>(path: string): Promise<T> => {
        const sub = path.match(/\/(actions|titles)(?:\?|$)/)?.[1];
        return (sub ? hr1[sub] : hr1["detail"]) as T;
      },
      apply: true, only: "all", limit: null, maxMinutes: null, isHeld: notHeld,
      tx: SAVEPOINT_TX, keys: [b.key], officials: [], log: () => undefined,
    });
    assert.equal(bd.measures_stamped, 1);
    const mb = (await c.query(`SELECT metadata FROM public.external_source_refs WHERE id = $1`, [b.refId])).rows[0].metadata;
    assert.ok(mb.detail?.fetched_at, "bill-details stamped detail");
    assert.deepEqual(mb.crs, crsBefore, "crs untouched");

    // Don't-clobber: a summary stored between the selection and the write stays.
    const f = await seed(c, "999-HR-62");
    await c.query(`UPDATE public.proposals SET summary_plain = 'Stored first.' WHERE id = $1`, [f.id]);
    const wrote = await writeMeasure(c, SAVEPOINT_TX, { ref_id: f.refId, proposal_id: f.id, external_id: f.key, asked_at: null }, "summary", TEXT);
    assert.equal(wrote, false);
    assert.equal((await c.query(`SELECT summary_plain FROM public.proposals WHERE id = $1`, [f.id])).rows[0].summary_plain, "Stored first.");
    assert.equal((await crs(c, f.refId))?.result, "summary", "the ask is still stamped");
  });
});
