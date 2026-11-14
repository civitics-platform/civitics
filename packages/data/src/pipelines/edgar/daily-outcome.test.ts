/**
 * FIX-1394 / FIX-1410 — the EDGAR daily says what happened to its index read,
 * reads a file that exists, and runs dry.
 *
 * 180 nightly rows from 05-13 were `skipped / no_filings`. Each night the
 * index answered 403, and the scan returned [] on any non-OK, non-404 status.
 * cc-278 read 2 found the 403 is how the archive answers a MISSING object: an
 * unpublished daily-index date and the full-index path the code built both
 * 403 with `<Error><Code>AccessDenied</Code>`. So the scan asks the quarter
 * listing first, and the caller logs three different things:
 *
 *   refused        → `failed` (failSync, the status in the message)
 *   not_published  → `skipped / index_not_published`
 *   read, no row   → `skipped / no_filings`
 *
 * FIX-1410: the URL was `full-index`, the day was today (listed ~22:00 ET,
 * after the 21:00Z nightly), and the form names were the pre-structured
 * `SC 13D/G`. The run now reads the newest listed file, matches both families,
 * and — EDGAR_DAILY_WRITES false — writes nothing, logging the parse yield.
 *
 * Every fetch here is a stub; an unexpected URL throws, so no test reaches
 * the network.
 *
 * Runs via:  tsx --test src/pipelines/edgar/daily-outcome.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DRY_RUN_FETCH_CAP, EDGAR_DAILY_WRITES, runEdgarDailyPipeline, type EdgarDailyDeps } from "./index";
import {
  candidateQuarters,
  dailyIndexUrl,
  isTargetForm,
  pickNewestListed,
  scanDailyShareholders,
  type EdgarFetchLike,
  type ShareholderFiling,
} from "./shareholders";
import type { EdgarResponse } from "./client";
import type { UniverseEntry } from "./universe";

const ARCHIVE = "https://www.sec.gov/Archives/edgar/daily-index";
const Q4 = `${ARCHIVE}/2026/QTR4/`;
const LISTING_URL = `${Q4}index.json`;
const FILE_1113 = `${Q4}master.20261113.idx`;
const ACCESS_DENIED = `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>AccessDenied</Code><Message>Access Denied</Message><RequestId>X</RequestId></Error>`;
// Sat 11-14 03:30Z — mid-quarter, so one listing; 11-13's file is the newest.
const NOW = new Date("2026-11-14T03:30:00Z");

const TRACKED_CIK = "0000320193";
const UNIVERSE: UniverseEntry[] = [{ ticker: "AAPL", name: "Apple Inc.", cik: TRACKED_CIK, sector: "Information Technology" }];

function listing(...names: string[]): string {
  return JSON.stringify({
    directory: {
      item: names.map((name) => ({ "last-modified": "11/13/2026 10:01:42 PM", name, type: "file", href: name, size: "668 KB" })),
      name: "Archives/edgar/daily-index/2026/QTR4/",
      "parent-dir": "../",
    },
  });
}

function masterIdx(...rows: string[]): string {
  return [
    "Description:           Daily Index of EDGAR Dissemination Feed by Company Name",
    "Last Data Received:    Nov 13, 2026",
    "Comments:              webmaster@sec.gov",
    "Anonymous FTP:         ftp://ftp.sec.gov/edgar/",
    " ",
    "CIK|Company Name|Form Type|Date Filed|Filename",
    "--------------------------------------------------------------------------------",
    ...rows,
    "",
  ].join("\n");
}

const COVER_PAGE =
  `<table><tr><td>1. NAME OF REPORTING PERSON<br>Jane Q. Doe</td></tr>` +
  `<tr><td>11. PERCENT OF CLASS REPRESENTED BY AMOUNT IN ROW (9)</td><td>7.3%</td></tr></table>`;

/** The two GETs one filing costs: its index.json, then the primary document. */
function filingAnswers(cikInt: string, accession: string, doc = COVER_PAGE): Record<string, Answer> {
  const base = `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accession.replace(/-/g, "")}`;
  return {
    [`${base}/index.json`]: {
      status: 200,
      body: JSON.stringify({ directory: { item: [{ name: `${accession}-index.html`, type: "text.gif" }, { name: "doc13g.htm", type: "text.gif" }] } }),
    },
    [`${base}/doc13g.htm`]: { status: 200, body: doc },
  };
}

type Answer = { status: number; body: string } | { network: string };

/** A fetch stub over a URL → answer table. Unknown URLs throw. */
function stubFetch(answers: Record<string, Answer>): { fetch: EdgarFetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetch: EdgarFetchLike = async (url) => {
    urls.push(url);
    const a = answers[url];
    if (!a) throw new Error(`test: unexpected URL ${url}`);
    if ("network" in a) throw new Error(a.network);
    const res: EdgarResponse = { status: a.status, ok: a.status >= 200 && a.status < 300, body: a.body, finalUrl: url, contentLength: a.body.length };
    return res;
  };
  return { fetch, urls };
}

interface Calls {
  skip:     Array<{ reason: string; metadata?: Record<string, unknown> }>;
  fail:     Array<{ message: string; metadata?: Record<string, unknown> }>;
  complete: Array<{ inserted: number; status?: string; metadata?: Record<string, unknown> }>;
  writes:   ShareholderFiling[][];
}

/** Every collaborator stubbed. writesEnabled is NOT set: the default is EDGAR_DAILY_WRITES. */
function deps(fetch: EdgarFetchLike, calls: Calls, extra: Partial<EdgarDailyDeps> = {}): Partial<EdgarDailyDeps> {
  return {
    startSync:       async () => "log-1",
    completeSync:    async (_id, result, status) => { calls.complete.push({ inserted: result.inserted, status, metadata: result.metadata }); },
    failSync:        async (_id, message, metadata) => { calls.fail.push({ message, metadata }); },
    skipSync:        async (_id, reason, metadata) => { calls.skip.push({ reason, metadata }); },
    universe:        () => UNIVERSE,
    loadTrackedCiks: async () => new Map([[TRACKED_CIK, "company-uuid-1"]]),
    scan:            (o) => scanDailyShareholders({ ...o, fetch }),
    writeFilings:    async (filings) => { calls.writes.push(filings); return { shareholders: filings.length, edges: 0, reviewQueue: 0, failed: 0 }; },
    now:             () => NOW,
    dateOverride:    () => undefined,
    ...extra,
  };
}

function newCalls(): Calls {
  return { skip: [], fail: [], complete: [], writes: [] };
}

// ──────────────────────────────────────────────────────────────────────────
// FIX-1394 — the outcome
// ──────────────────────────────────────────────────────────────────────────

test("a listed file is read: with writes on, its tracked 13D/G row reaches the write half and the run completes", async () => {
  const { fetch, urls } = stubFetch({
    [LISTING_URL]: { status: 200, body: listing("company.20261113.idx", "master.20261112.idx", "master.20261113.idx") },
    [FILE_1113]:   { status: 200, body: masterIdx("320193|APPLE INC.|SC 13G/A|20261113|edgar/data/320193/0001214659-26-014133.txt") },
    ...filingAnswers("320193", "0001214659-26-014133"),
  });
  const calls = newCalls();
  const result = await runEdgarDailyPipeline(deps(fetch, calls, { writesEnabled: true }));

  assert.equal(urls[0], LISTING_URL, "the listing is read before any file");
  assert.equal(urls[1], FILE_1113);
  assert.equal(calls.writes.length, 1);
  const [filing] = calls.writes[0]!;
  assert.equal(filing!.accession, "0001214659-26-014133");
  assert.equal(filing!.filingType, "SC 13G/A");
  assert.equal(filing!.holders[0]!.holderName, "Jane Q. Doe");
  assert.equal(filing!.holders[0]!.pctOfClass, 7.3);
  assert.equal(calls.complete.length, 1);
  assert.equal(calls.complete[0]!.metadata?.["index_file"], "master.20261113.idx");
  assert.equal(calls.complete[0]!.metadata?.["dry_run"], false);
  assert.deepEqual(calls.skip, []);
  assert.deepEqual(calls.fail, []);
  assert.equal(result.fatal_error, undefined);
});

test("a file the listing does not name is not_published → skipped / index_not_published, and is never fetched", async () => {
  const { fetch, urls } = stubFetch({
    [LISTING_URL]: { status: 200, body: listing("master.20261110.idx", "master.20261112.idx") },
  });
  // EDGAR_DAILY_DATE names a day the listing does not carry.
  const calls = newCalls();
  const result = await runEdgarDailyPipeline(deps(fetch, calls, { dateOverride: () => new Date("2026-11-13T00:00:00Z") }));
  assert.deepEqual(calls.skip, [{ reason: "index_not_published", metadata: { index_file: "master.20261113.idx" } }]);
  assert.deepEqual(calls.fail, []);
  assert.deepEqual(calls.complete, []);
  assert.ok(!urls.includes(FILE_1113), "an unlisted file is not requested — its 403 would read as a refusal");
  assert.equal(result.fatal_error, undefined);

  // And a listing that names no master file at all.
  const empty = stubFetch({ [LISTING_URL]: { status: 200, body: listing("company.20261001.idx") } });
  const calls2 = newCalls();
  await runEdgarDailyPipeline(deps(empty.fetch, calls2));
  assert.deepEqual(calls2.skip, [{ reason: "index_not_published", metadata: { index_file: null } }]);
});

for (const status of [403, 500]) {
  test(`a listed file answering ${status} is refused → failSync with the status in the message`, async () => {
    const { fetch } = stubFetch({
      [LISTING_URL]: { status: 200, body: listing("master.20261113.idx") },
      [FILE_1113]:   { status, body: ACCESS_DENIED },
    });
    const calls = newCalls();
    const result = await runEdgarDailyPipeline(deps(fetch, calls));

    assert.equal(calls.fail.length, 1);
    assert.match(calls.fail[0]!.message, new RegExp(`HTTP ${status} `));
    assert.ok(calls.fail[0]!.message.includes(FILE_1113), "the message names the URL");
    assert.ok(calls.fail[0]!.message.includes("<Error><Code>AccessDenied"), "the message carries the body's head");
    assert.ok(!calls.fail[0]!.message.includes("\n"), "one line");
    assert.equal(calls.fail[0]!.metadata?.["index_http_status"], status);
    assert.deepEqual(calls.skip, [], "a refusal is never a quiet day");
    assert.deepEqual(calls.complete, []);
    assert.ok(result.fatal_error, "the result carries the failure to the CLI and the nightly");
  });
}

test("the listing itself failing is refused → failSync", async () => {
  const { fetch } = stubFetch({ [LISTING_URL]: { status: 403, body: ACCESS_DENIED } });
  const calls = newCalls();
  await runEdgarDailyPipeline(deps(fetch, calls));
  assert.equal(calls.fail.length, 1);
  assert.match(calls.fail[0]!.message, /HTTP 403 .*daily-index\/2026\/QTR4\/index\.json/);
  assert.deepEqual(calls.skip, []);
});

test("a listing that throws, or is not the directory JSON, is refused too", async () => {
  for (const answer of [{ network: "edgarFetch failed after 3 attempts: ECONNRESET" }, { status: 200, body: "<html>not json</html>" }] as Answer[]) {
    const { fetch } = stubFetch({ [LISTING_URL]: answer });
    const calls = newCalls();
    await runEdgarDailyPipeline(deps(fetch, calls));
    assert.equal(calls.fail.length, 1, JSON.stringify(answer));
    assert.deepEqual(calls.skip, []);
  }
});

test("a read file with no tracked 13D/G row is the genuine quiet day → skipped / no_filings, naming the file and its 13D/G count", async () => {
  const { fetch } = stubFetch({
    [LISTING_URL]: { status: 200, body: listing("master.20261113.idx") },
    // An untracked CIK, and a tracked CIK on a non-13D/G form.
    [FILE_1113]:   { status: 200, body: masterIdx(
      "1000275|ROYAL BANK OF CANADA|SCHEDULE 13G/A|20261113|edgar/data/1000275/0001214659-26-014133.txt",
      "320193|APPLE INC.|8-K|20261113|edgar/data/320193/0000320193-26-000101.txt",
    ) },
  });
  const calls = newCalls();
  await runEdgarDailyPipeline(deps(fetch, calls));
  assert.deepEqual(calls.skip, [{
    reason:   "no_filings",
    metadata: { index_file: "master.20261113.idx", rows_13dg: 1, rows_13dg_by_form: { "SCHEDULE 13G/A": 1 } },
  }]);
  assert.deepEqual(calls.fail, []);
  assert.deepEqual(calls.writes, []);
});

// ──────────────────────────────────────────────────────────────────────────
// FIX-1410 — the directory, the day, the form names, dry mode
// ──────────────────────────────────────────────────────────────────────────

test("dailyIndexUrl builds daily-index/{YYYY}/QTR{N}/master.YYYYMMDD.idx for a date in each quarter", () => {
  assert.equal(dailyIndexUrl(new Date("2026-02-03T00:00:00Z")), `${ARCHIVE}/2026/QTR1/master.20260203.idx`);
  assert.equal(dailyIndexUrl(new Date("2026-05-15T00:00:00Z")), `${ARCHIVE}/2026/QTR2/master.20260515.idx`);
  assert.equal(dailyIndexUrl(new Date("2026-09-30T23:59:59Z")), `${ARCHIVE}/2026/QTR3/master.20260930.idx`);
  assert.equal(dailyIndexUrl(new Date("2026-12-31T00:00:00Z")), `${ARCHIVE}/2026/QTR4/master.20261231.idx`);
  assert.ok(!dailyIndexUrl(new Date("2026-11-13T00:00:00Z")).includes("full-index"));
});

test("candidateQuarters adds the previous quarter only in a quarter's first 7 days", () => {
  assert.deepEqual(candidateQuarters(NOW), [{ year: 2026, quarter: 4 }]);
  assert.deepEqual(candidateQuarters(new Date("2026-01-02T21:05:00Z")), [{ year: 2026, quarter: 1 }, { year: 2025, quarter: 4 }]);
  assert.deepEqual(candidateQuarters(new Date("2026-04-07T23:59:00Z")), [{ year: 2026, quarter: 2 }, { year: 2026, quarter: 1 }]);
  assert.deepEqual(candidateQuarters(new Date("2026-04-08T00:00:00Z")), [{ year: 2026, quarter: 2 }]);
});

test("pickNewestListed takes the newest name across listings, with its own directory", () => {
  const picked = pickNewestListed([
    { kind: "listed", url: `${ARCHIVE}/2026/QTR1/index.json`, files: [] },
    { kind: "listed", url: `${ARCHIVE}/2025/QTR4/index.json`, files: ["master.20251229.idx", "master.20251230.idx", "master.20251231.idx"] },
  ]);
  assert.deepEqual(picked, { file: "master.20251231.idx", dirUrl: `${ARCHIVE}/2025/QTR4/` });
  assert.equal(pickNewestListed([{ kind: "listed", url: LISTING_URL, files: [] }]), null);
});

test("the scan reads the newest listed file, not today's — and at a quarter boundary, last quarter's", async () => {
  // Fri 11-13 21:05Z, the nightly's slot: 11-13 is not listed yet, 11-12 is.
  const mid = stubFetch({
    [LISTING_URL]: { status: 200, body: listing("master.20261110.idx", "master.20261112.idx") },
    [`${Q4}master.20261112.idx`]: { status: 200, body: masterIdx() },
  });
  const a = await scanDailyShareholders({ now: new Date("2026-11-13T21:05:00Z"), trackedCiks: new Map(), fetch: mid.fetch });
  assert.equal(a.kind, "read");
  assert.equal(a.kind === "read" && a.file, "master.20261112.idx");

  // Fri 01-02 21:05Z: the new quarter's directory refuses (does not exist yet);
  // last quarter's listing names 12-31.
  const q1 = `${ARCHIVE}/2027/QTR1/`;
  const q4 = `${ARCHIVE}/2026/QTR4/`;
  const boundary = stubFetch({
    [`${q1}index.json`]: { status: 403, body: ACCESS_DENIED },
    [`${q4}index.json`]: { status: 200, body: listing("master.20261230.idx", "master.20261231.idx") },
    [`${q4}master.20261231.idx`]: { status: 200, body: masterIdx() },
  });
  const b = await scanDailyShareholders({ now: new Date("2027-01-02T21:05:00Z"), trackedCiks: new Map(), fetch: boundary.fetch });
  assert.equal(b.kind === "read" && b.file, "master.20261231.idx");
  assert.ok(boundary.urls.includes(`${q4}master.20261231.idx`));

  // Mon 01-05: the new quarter lists 01-02 — newer than 12-31, so it wins.
  const later = stubFetch({
    [`${q1}index.json`]: { status: 200, body: listing("master.20270102.idx") },
    [`${q4}index.json`]: { status: 200, body: listing("master.20261231.idx") },
    [`${q1}master.20270102.idx`]: { status: 200, body: masterIdx() },
  });
  const c = await scanDailyShareholders({ now: new Date("2027-01-05T21:05:00Z"), trackedCiks: new Map(), fetch: later.fetch });
  assert.equal(c.kind === "read" && c.file, "master.20270102.idx");

  // Outside the lookback a refused current listing is a refusal, not a fallback.
  const refused = stubFetch({ [LISTING_URL]: { status: 403, body: ACCESS_DENIED } });
  const d = await scanDailyShareholders({ now: NOW, trackedCiks: new Map(), fetch: refused.fetch });
  assert.equal(d.kind, "refused");
});

test("both families of form names match; other forms do not", async () => {
  for (const f of ["SC 13D", "SC 13D/A", "SC 13G", "SC 13G/A", "SCHEDULE 13D", "SCHEDULE 13D/A", "SCHEDULE 13G", "SCHEDULE 13G/A"]) {
    assert.ok(isTargetForm(f), f);
  }
  for (const f of ["SC TO-T", "13F-HR", "SCHEDULE 13E3", "8-K", "SC 14D9"]) {
    assert.ok(!isTargetForm(f), f);
  }

  const { fetch } = stubFetch({
    [LISTING_URL]: { status: 200, body: listing("master.20261113.idx") },
    [FILE_1113]:   { status: 200, body: masterIdx(
      "320193|APPLE INC.|SCHEDULE 13G/A|20261113|edgar/data/320193/0001214659-26-000001.txt",
      "320193|APPLE INC.|SCHEDULE 13D|20261113|edgar/data/320193/0001214659-26-000002.txt",
      "320193|APPLE INC.|SC 13G|20261113|edgar/data/320193/0001214659-26-000003.txt",
      "320193|APPLE INC.|SC TO-T|20261113|edgar/data/320193/0001214659-26-000004.txt",
    ) },
    ...filingAnswers("320193", "0001214659-26-000001"),
    ...filingAnswers("320193", "0001214659-26-000002"),
    ...filingAnswers("320193", "0001214659-26-000003"),
  });
  const out = await scanDailyShareholders({ now: NOW, trackedCiks: new Map([[TRACKED_CIK, "c1"]]), fetch });
  assert.equal(out.kind, "read");
  if (out.kind !== "read") return;
  assert.equal(out.stats.rowsTracked, 3);
  assert.deepEqual(out.filings.map((f) => f.filingType), ["SCHEDULE 13G/A", "SCHEDULE 13D", "SC 13G"]);
  assert.deepEqual(out.stats.rows13dgByForm, { "SCHEDULE 13G/A": 1, "SCHEDULE 13D": 1, "SC 13G": 1 });
});

test("EDGAR_DAILY_WRITES is false: the write half is never called, and the run completes with the parse yield", async () => {
  assert.equal(EDGAR_DAILY_WRITES, false, "flipping the constant is a later prompt (cc-278 D4)");
  const { fetch } = stubFetch({
    [LISTING_URL]: { status: 200, body: listing("master.20261113.idx") },
    [FILE_1113]:   { status: 200, body: masterIdx(
      "1000275|ROYAL BANK OF CANADA|SCHEDULE 13G/A|20261113|edgar/data/1000275/0001214659-26-014133.txt",
      "320193|APPLE INC.|SCHEDULE 13G/A|20261113|edgar/data/320193/0001214659-26-000001.txt",
      "320193|APPLE INC.|SCHEDULE 13G|20261113|edgar/data/320193/0001214659-26-000002.txt",
    ) },
    ...filingAnswers("320193", "0001214659-26-000001"),
    ...filingAnswers("320193", "0001214659-26-000002", "<html>structured filing — no cover-page table</html>"),
  });
  const calls = newCalls();
  let writeCalls = 0;
  const result = await runEdgarDailyPipeline(deps(fetch, calls, {
    writeFilings: async () => { writeCalls++; return { shareholders: 0, edges: 0, reviewQueue: 0, failed: 0 }; },
  }));

  assert.equal(writeCalls, 0, "no shareholders row, edge or review-queue row");
  assert.deepEqual(calls.skip, []);
  assert.deepEqual(calls.fail, []);
  assert.equal(calls.complete.length, 1);
  assert.equal(calls.complete[0]!.status, undefined, "complete, not partial");
  assert.equal(result.inserted, 0);
  assert.deepEqual(calls.complete[0]!.metadata, {
    dry_run:           true,
    index_file:        "master.20261113.idx",
    rows_13dg:         3,
    rows_13dg_by_form: { "SCHEDULE 13G/A": 2, "SCHEDULE 13G": 1 },
    rows_tracked:      2,
    filings_fetched:   2,
    not_fetched:       0,
    documents_found:   2,
    fetch_errors:      0,
    holders_parsed:    1,
    holders_with_pct:  1,
    unparsed:          1,
    samples:           [{ accession: "0001214659-26-000001", form: "SCHEDULE 13G/A", holder: "Jane Q. Doe", pct: 7.3 }],
  });
});

test(`dry mode fetches at most ${DRY_RUN_FETCH_CAP} filings; the rest count not_fetched`, async () => {
  const n = DRY_RUN_FETCH_CAP + 5;
  const accessions = Array.from({ length: n }, (_, i) => `0001214659-26-${String(i + 1).padStart(6, "0")}`);
  let answers: Record<string, Answer> = {
    [LISTING_URL]: { status: 200, body: listing("master.20261113.idx") },
    [FILE_1113]:   { status: 200, body: masterIdx(...accessions.map((a) => `320193|APPLE INC.|SCHEDULE 13G/A|20261113|edgar/data/320193/${a}.txt`)) },
  };
  for (const a of accessions) answers = { ...answers, ...filingAnswers("320193", a) };
  const { fetch, urls } = stubFetch(answers);
  const calls = newCalls();
  await runEdgarDailyPipeline(deps(fetch, calls));

  const filingIndexGets = urls.filter((u) => u.includes("/edgar/data/") && u.endsWith("/index.json"));
  assert.equal(filingIndexGets.length, DRY_RUN_FETCH_CAP);
  const meta = calls.complete[0]!.metadata!;
  assert.equal(meta["rows_tracked"], n);
  assert.equal(meta["filings_fetched"], DRY_RUN_FETCH_CAP);
  assert.equal(meta["not_fetched"], 5);
  assert.equal((meta["samples"] as unknown[]).length, 5);
});
