/**
 * FIX-1394 — the EDGAR daily says what happened to its index read.
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
 * Every fetch here is a stub; an unexpected URL throws, so no test reaches
 * the network.
 *
 * Runs via:  tsx --test src/pipelines/edgar/daily-outcome.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runEdgarDailyPipeline, type EdgarDailyDeps } from "./index";
import { scanDailyShareholders, type EdgarFetchLike, type ShareholderFiling } from "./shareholders";
import type { EdgarResponse } from "./client";
import type { UniverseEntry } from "./universe";

const Q4 = "https://www.sec.gov/Archives/edgar/daily-index/2026/QTR4/";
const LISTING_URL = `${Q4}index.json`;
const FILE_1113 = `${Q4}master.20261113.idx`;
const ACCESS_DENIED = `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>AccessDenied</Code><Message>Access Denied</Message><RequestId>X</RequestId></Error>`;

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
const FILING_SEG = "edgar/data/320193/000121465926014133";

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

const FILING_ANSWERS: Record<string, Answer> = {
  [`https://www.sec.gov/Archives/${FILING_SEG}/index.json`]: {
    status: 200,
    body: JSON.stringify({ directory: { item: [{ name: "0001214659-26-014133-index.html", type: "text.gif" }, { name: "doc13g.htm", type: "text.gif" }] } }),
  },
  [`https://www.sec.gov/Archives/${FILING_SEG}/doc13g.htm`]: { status: 200, body: COVER_PAGE },
};

interface Calls {
  skip:     Array<{ reason: string; metadata?: Record<string, unknown> }>;
  fail:     Array<{ message: string; metadata?: Record<string, unknown> }>;
  complete: Array<{ inserted: number; status?: string; metadata?: Record<string, unknown> }>;
  writes:   ShareholderFiling[][];
}

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
    now:             () => new Date("2026-11-13T00:00:00Z"),
    ...extra,
  };
}

function newCalls(): Calls {
  return { skip: [], fail: [], complete: [], writes: [] };
}

test("a listed file is read: its tracked 13D/G row reaches the write half and the run completes", async () => {
  const { fetch, urls } = stubFetch({
    [LISTING_URL]: { status: 200, body: listing("company.20261113.idx", "master.20261112.idx", "master.20261113.idx") },
    [FILE_1113]:   { status: 200, body: masterIdx("320193|APPLE INC.|SC 13G/A|20261113|edgar/data/320193/0001214659-26-014133.txt") },
    ...FILING_ANSWERS,
  });
  const calls = newCalls();
  const result = await runEdgarDailyPipeline(deps(fetch, calls));

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
  assert.deepEqual(calls.skip, []);
  assert.deepEqual(calls.fail, []);
  assert.equal(result.fatal_error, undefined);
});

test("a file the listing does not name is not_published → skipped / index_not_published, and is never fetched", async () => {
  const { fetch, urls } = stubFetch({
    [LISTING_URL]: { status: 200, body: listing("master.20261110.idx", "master.20261112.idx") },
  });
  const calls = newCalls();
  const outcome = await scanDailyShareholders({ date: new Date("2026-11-13T00:00:00Z"), trackedCiks: new Map(), fetch });
  assert.equal(outcome.kind, "not_published");

  const result = await runEdgarDailyPipeline(deps(fetch, calls));
  assert.deepEqual(calls.skip, [{ reason: "index_not_published", metadata: { index_file: "master.20261113.idx" } }]);
  assert.deepEqual(calls.fail, []);
  assert.deepEqual(calls.complete, []);
  assert.ok(!urls.includes(FILE_1113), "an unlisted file is not requested — its 403 would read as a refusal");
  assert.equal(result.fatal_error, undefined);
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

test("a read file with no tracked 13D/G row is the genuine quiet day → skipped / no_filings", async () => {
  const { fetch } = stubFetch({
    [LISTING_URL]: { status: 200, body: listing("master.20261113.idx") },
    // An untracked CIK, and a tracked CIK on a non-13D/G form.
    [FILE_1113]:   { status: 200, body: masterIdx(
      "1000275|ROYAL BANK OF CANADA|SC 13G/A|20261113|edgar/data/1000275/0001214659-26-014133.txt",
      "320193|APPLE INC.|8-K|20261113|edgar/data/320193/0000320193-26-000101.txt",
    ) },
  });
  const calls = newCalls();
  await runEdgarDailyPipeline(deps(fetch, calls));
  assert.deepEqual(calls.skip, [{ reason: "no_filings", metadata: { index_file: "master.20261113.idx" } }]);
  assert.deepEqual(calls.fail, []);
  assert.deepEqual(calls.writes, []);
});
