/**
 * FIX-1219 — the Logs helper: the SQL as text, the URL it sends, the answer's
 * three kinds, and the unit normalisation.
 *
 * The shapes here are the ones cc-155 D2 recorded on prod, not guesses: the
 * 200-with-error body, the 429 headers, the 1000-row cap, the epoch-seconds
 * bucket (`{"b":1790241300,…}` is the 2026-09-24 09:15 bucket, 2 of 183).
 * The fetch cases moved here from the census lib's tests (cc-154), unchanged
 * in meaning.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  bucketStartMs,
  buildLogsUrl,
  isAttributableField,
  isLogsEndpointGone,
  isLogsSchemaRemoval,
  queryAttribution,
  queryCancellationBuckets,
  queryCancellationRenders,
  queryEdgeBuckets,
  queryLogs,
  queryStringRange,
  sampleQueryName,
  sanitizeLike,
  sqlAttribution,
  sqlCancellationBuckets,
  sqlCancellationRenders,
  sqlEdgeBuckets,
  timeFilterSql,
  worstLogsAnswer,
  ATTRIBUTABLE_FIELDS,
  LOGS_ENDPOINT,
  LOGS_RETENTION_DAYS,
  LOGS_ROW_CAP,
  MAX_LOGS_RANGE_MINUTES,
  TIME_FILTER,
  type LogsFetch,
  type LogsRenderSecond,
} from "./supabase-logs";

const T0 = Date.parse("2026-09-24T09:15:00Z");
const T1 = Date.parse("2026-09-24T09:30:00Z");

const stubFetch = (status: number, body: unknown = {}, statusText = "", headers: Record<string, string> = {}): LogsFetch =>
  async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

const q = (fetchImpl: LogsFetch) =>
  queryLogs({ sql: `SELECT 1 FROM logs WHERE ${TIME_FILTER}`, startMs: T0, endMs: T1, token: "t", timeoutMs: 1000, fetchImpl });

// ── the SQL, as text ──────────────────────────────────────────────────────────

test("the edge builder is ClickHouse over one `logs` table, filtered on `source` — no BigQuery form survives", () => {
  const sql = sqlEdgeBuckets(900);
  assert.match(sql, /FROM logs\b/);
  assert.match(sql, /WHERE source = 'edge_logs'/, "`source`, not the changelog's `source_name` (which does not exist)");
  assert.match(sql, /toUnixTimestamp\(toStartOfInterval\(timestamp, INTERVAL 900 SECOND\)\) AS b/);
  assert.match(sql, /count\(\) AS requests/);
  // A map value is a String: cast before comparing, or '500' >= 500 is a type error.
  assert.match(sql, /countIf\(toInt32OrZero\(log_attributes\['response\.status_code'\]\) >= 500\) AS n_5xx/);
  assert.match(sql, /countIf\(toInt32OrZero\(log_attributes\['response\.status_code'\]\) BETWEEN 520 AND 526\) AS n_52x/);
  assert.ok(sql.includes(TIME_FILTER));
  for (const dead of [/unnest/i, /countif\(/, /timestamp_seconds/, /unix_seconds/, /edge_logs t\b/, /source_name/]) {
    assert.doesNotMatch(sql, dead);
  }
  assert.throws(() => sqlEdgeBuckets(0), RangeError);
  assert.throws(() => sqlEdgeBuckets(1.5), RangeError);
});

test("the cancellation builder counts both classes per minute and keeps only cancellation rows", () => {
  const sql = sqlCancellationBuckets();
  assert.match(sql, /WHERE source = 'postgres_logs'/);
  assert.match(sql, /INTERVAL 60 SECOND/);
  assert.match(sql, /countIf\(event_message LIKE '%canceling statement due to statement timeout%'\) AS n_timeout/);
  assert.match(sql, /countIf\(event_message LIKE '%canceling statement due to user request%'\) AS n_user/);
  // Keeps a 1440-minute read inside the 1000-row cap; consumers read only non-zero minutes.
  assert.match(sql, /AND event_message LIKE '%canceling statement due to%'/);
  assert.ok(sql.includes(TIME_FILTER));
});

test("--by query groups by the relation/function name, never the pgrst envelope", () => {
  const sql = sqlAttribution("query", null);
  assert.match(sql, /extract\(log_attributes\['parsed\.query'\], '"public"\[\.\]"\(\[a-z0-9_\]\+\)"'\)/);
  // extract() answers '' on no match, not NULL: the fallback is an if(), not a coalesce().
  assert.match(sql, /if\(extract\(/);
  assert.match(sql, /substringUTF8\(replaceRegexpAll\(/);
  assert.match(sql, /AND log_attributes\['parsed\.sql_state_code'\] = '57014'/);
  assert.match(sql, /GROUP BY g/);
  assert.match(sql, /LIMIT 20/);
  assert.doesNotMatch(sql, /regexp_extract|regexp_replace|unnest|cast\(p\./);
});

test("a non-query field groups on its own parsed.* key; --like lands in the WHERE clause", () => {
  assert.match(sqlAttribution("user_name", null), /if\(log_attributes\['parsed\.user_name'\] = '', '\(null\)', log_attributes\['parsed\.user_name'\]\) AS g/);
  assert.doesNotMatch(sqlAttribution("user_name", null), /extract\(/);
  assert.match(sqlAttribution("query", "get_official_page"), /AND log_attributes\['parsed\.query'\] LIKE '%get_official_page%'/);
});

test("the attribution builder refuses a field or a like it cannot safely interpolate", () => {
  assert.throws(() => sqlAttribution("duration" as never, null));
  assert.throws(() => sqlAttribution("query", "a'b"));
  for (const f of ATTRIBUTABLE_FIELDS) assert.equal(isAttributableField(f), true);
  assert.equal(isAttributableField("role"), false);
  assert.equal(sanitizeLike("public.votes"), "public.votes");
  assert.equal(sanitizeLike("a\\b"), null, "a backslash would escape the closing quote in ClickHouse");
  assert.equal(sanitizeLike("a'b"), null);
  assert.equal(sanitizeLike(""), null);
  assert.equal(sanitizeLike("x".repeat(121)), null);
});

// ── the URL ───────────────────────────────────────────────────────────────────

test("the URL is the `logs` endpoint; the range rides the query string AND a half-open SQL bound", () => {
  const url = buildLogsUrl({ sql: `SELECT 1 FROM logs WHERE ${TIME_FILTER}`, startMs: T0, endMs: T1 });
  assert.equal(url.pathname, `/v1/projects/xsazcoxinpgttgquwvuf/${LOGS_ENDPOINT}`);
  assert.equal(LOGS_ENDPOINT, "analytics/endpoints/logs");
  assert.doesNotMatch(url.href, /logs\.all/);
  assert.equal(url.searchParams.get("iso_timestamp_start"), "2026-09-24T09:15:00.000Z");
  assert.equal(url.searchParams.get("iso_timestamp_end"), "2026-09-24T09:30:00.000Z");
  // The end is exclusive in the SQL because the endpoint's own end is INCLUSIVE (measured).
  assert.equal(
    url.searchParams.get("sql"),
    "SELECT 1 FROM logs WHERE timestamp >= toDateTime64('2026-09-24 09:15:00.000', 3, 'UTC') " +
      "AND timestamp < toDateTime64('2026-09-24 09:30:00.000', 3, 'UTC')",
  );
  assert.equal(timeFilterSql(Date.parse("2026-09-24T09:19:11.098Z"), T1).slice(0, 67),
    "timestamp >= toDateTime64('2026-09-24 09:19:11.098', 3, 'UTC') AND ");
});

test("the query-string range widens to whole minutes, except where that would cross 24 h", () => {
  const s = Date.parse("2026-09-24T09:19:11.098Z");
  const e = Date.parse("2026-09-24T09:34:11.098Z");
  assert.deepEqual(queryStringRange(s, e), { start: "2026-09-24T09:19:00.000Z", end: "2026-09-24T09:35:00.000Z" });
  // exactly 24 h, unaligned: widening would be 24 h + 1 min, which the endpoint clamps to its OLDEST 24 h.
  const e24 = s + 24 * 3_600_000;
  assert.deepEqual(queryStringRange(s, e24), { start: new Date(s).toISOString(), end: new Date(e24).toISOString() });
});

test("buildLogsUrl refuses what the endpoint would answer wrongly: no TIME_FILTER, an inverted range, > 24 h", () => {
  assert.throws(() => buildLogsUrl({ sql: "SELECT 1 FROM logs", startMs: T0, endMs: T1 }), /time_filter/);
  assert.throws(() => buildLogsUrl({ sql: TIME_FILTER, startMs: T1, endMs: T0 }), RangeError);
  assert.equal(MAX_LOGS_RANGE_MINUTES, 1440, "re-measured cc-155: 25 h / 48 h / 7 d each answered the OLDEST 24 h");
  assert.doesNotThrow(() => buildLogsUrl({ sql: TIME_FILTER, startMs: T1 - 1440 * 60_000, endMs: T1 }));
  assert.throws(() => buildLogsUrl({ sql: TIME_FILTER, startMs: T1 - 1441 * 60_000, endMs: T1 }), /OLDEST 24 h/);
  assert.equal(LOGS_RETENTION_DAYS, 7);
});

// ── the answer ────────────────────────────────────────────────────────────────

test("a 410 (and a 404 on the same path) is unavailable; a 503 and a throw are dark", async () => {
  assert.deepEqual(await q(stubFetch(410, { message: "Use GET /v1/projects/{ref}/analytics/endpoints/logs instead" }, "Gone")),
    { kind: "unavailable", status: 410, detail: "Logs API 410 Gone" });
  assert.equal((await q(stubFetch(404, {}, "Not Found"))).kind, "unavailable");
  assert.deepEqual(await q(stubFetch(503, {}, "Service Unavailable")), { kind: "dark", detail: "Logs API 503 Service Unavailable" });
  assert.deepEqual(await q(async () => { throw new Error("ECONNRESET"); }), { kind: "dark", detail: "Logs API request failed: ECONNRESET" });
  assert.equal(isLogsEndpointGone(500), false);
  assert.equal(isLogsEndpointGone(401), false, "a bad key is dark, not a removed endpoint");
});

test("a 429 is dark and names the rate limit and the retry-after (measured: 10/min per token)", async () => {
  const a = await q(stubFetch(429, { message: "ThrottlerException: Too Many Requests" }, "Too Many Requests", { "retry-after": "35" }));
  assert.deepEqual(a, { kind: "dark", detail: "Logs API 429 Too Many Requests (rate limit 10/min; retry-after 35s)" });
});

test("a 200 carrying an error is dark, with the error text — `res.ok` proves nothing on this endpoint", async () => {
  const a = await q(stubFetch(200, { error: "Backend error! Retry your query. Please contact support if this continues." }));
  assert.equal(a.kind, "dark");
  assert.match((a as { detail: string }).detail, /^Logs API 200 with an error: Backend error!/);
  assert.deepEqual(await q(stubFetch(200, { error: "Backend error" })), { kind: "dark", detail: "Logs API 200 with an error: Backend error" });
  assert.deepEqual(await q(stubFetch(200, {})), { kind: "dark", detail: "Logs API answered 200 without a result array" });
  assert.equal((await q(stubFetch(200, { result: [], error: null }))).kind, "rows", "error: null is not an error");
});

test("a 200 naming a table or field that does not exist is UNAVAILABLE (a schema removal), not dark — cc-156", async () => {
  // The exact bodies the endpoint returned (cc-152 read 5, cc-155 P8).
  assert.deepEqual(await q(stubFetch(200, { error: 'Field "source_name" does not exist.' })), {
    kind: "unavailable", status: 200, detail: 'Logs API schema changed: Field "source_name" does not exist.',
  });
  assert.deepEqual(await q(stubFetch(200, { error: 'Table "edge_logs" does not exist.' })), {
    kind: "unavailable", status: 200, detail: 'Logs API schema changed: Table "edge_logs" does not exist.',
  });
  // Everything else stays dark: rule 164 counts dark as a box symptom, and
  // only this shape is known not to be one.
  const throttled = await q(stubFetch(429, { message: "ThrottlerException: Too Many Requests" }, "Too Many Requests"));
  assert.equal(throttled.kind, "dark", "a 429 is still dark");
  assert.equal((await q(stubFetch(200, { error: "Backend error" }))).kind, "dark");
  assert.equal(isLogsSchemaRemoval('Field "metadata" does not exist.'), true);
  assert.equal(isLogsSchemaRemoval("Project does not exist"), false, "only a named table/field/column");
  assert.equal(isLogsSchemaRemoval("Backend error! Retry your query."), false);
  // A removed table beats a dark sibling, like a 410 does: they share one endpoint.
  const gone = await q(stubFetch(200, { error: 'Table "edge_logs" does not exist.' }));
  assert.equal(worstLogsAnswer([{ kind: "dark", detail: "Logs API 503" }, gone])?.kind, "unavailable");
});

test("an answer at the 1000-row cap is a truncation, not a reading", async () => {
  const full = Array.from({ length: LOGS_ROW_CAP }, (_, i) => ({ i }));
  const a = await q(stubFetch(200, { result: full }));
  assert.equal(a.kind, "dark");
  assert.match((a as { detail: string }).detail, /1000-row cap/);
  assert.equal((await q(stubFetch(200, { result: full.slice(1) }))).kind, "rows");
});

test("the fetch gets the Bearer token, no-store, and a timeout signal", async () => {
  let seen: Parameters<LogsFetch>[1] | null = null;
  await q(async (_u, init) => {
    seen = init;
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ result: [] }), text: async () => "" };
  });
  assert.equal(seen!.headers["Authorization"], "Bearer t");
  assert.equal(seen!.cache, "no-store");
  assert.ok(seen!.signal instanceof AbortSignal);
});

test("the precedence: unavailable beats dark beats rows", () => {
  const u = { kind: "unavailable" as const, status: 410, detail: "Logs API 410 Gone" };
  const d = { kind: "dark" as const, detail: "Logs API 503" };
  const r = { kind: "rows" as const, rows: [] };
  assert.deepEqual(worstLogsAnswer([d, u]), u);
  assert.deepEqual(worstLogsAnswer([r, d]), d);
  assert.equal(worstLogsAnswer([r, r]), null);
});

// ── the units ─────────────────────────────────────────────────────────────────

test("a bucket is epoch SECONDS on the wire and ms out of the helper; any other unit is refused", () => {
  assert.equal(bucketStartMs(1790241300), Date.parse("2026-09-24T09:15:00Z"));
  assert.equal(bucketStartMs("1790241300"), Date.parse("2026-09-24T09:15:00Z"), "a quoted UInt is tolerated");
  assert.ok(Number.isNaN(bucketStartMs("2026-09-24T09:15:00")), "the naive ISO a raw toStartOfInterval returns");
  assert.ok(Number.isNaN(bucketStartMs(1790241300000000)), "the old endpoint's microseconds");
  assert.ok(Number.isNaN(bucketStartMs(1790241300000)), "milliseconds");
  assert.ok(Number.isNaN(bucketStartMs(null)));
});

test("queryEdgeBuckets returns ms buckets from the recorded D2 shape — cc-151's 09:00 and 09:15 buckets", async () => {
  const a = await queryEdgeBuckets({
    startMs: T0 - 900_000, endMs: T1, bucketSeconds: 900, token: "t", timeoutMs: 1000,
    fetchImpl: stubFetch(200, { result: [
      { b: 1790240400, requests: 279, n_5xx: 1, n_52x: 0 },
      { b: 1790241300, requests: 183, n_5xx: 2, n_52x: 0 },
    ] }),
  });
  assert.deepEqual(a, { kind: "rows", rows: [
    { startMs: Date.parse("2026-09-24T09:00:00Z"), requests: 279, n5xx: 1, n52x: 0 },
    { startMs: Date.parse("2026-09-24T09:15:00Z"), requests: 183, n5xx: 2, n52x: 0 },
  ] });
  const bad = await queryEdgeBuckets({
    startMs: T0, endMs: T1, bucketSeconds: 900, token: "t", timeoutMs: 1000,
    fetchImpl: stubFetch(200, { result: [{ b: "2026-09-24T09:15:00", requests: 1, n_5xx: 0, n_52x: 0 }] }),
  });
  assert.deepEqual(bad, { kind: "dark", detail: 'Logs API bucket is not epoch seconds: "2026-09-24T09:15:00"' });
});

test("queryCancellationBuckets returns the 09:30:26 burst minute as one ms bucket of 6", async () => {
  const a = await queryCancellationBuckets({
    startMs: Date.parse("2026-09-24T09:19:11Z"), endMs: Date.parse("2026-09-24T09:34:11Z"), token: "t", timeoutMs: 1000,
    fetchImpl: stubFetch(200, { result: [
      { b: 1790241540, n_timeout: 1, n_user: 0 },
      { b: 1790241840, n_timeout: 1, n_user: 0 },
      { b: 1790242200, n_timeout: 6, n_user: 0 },
    ] }),
  });
  assert.equal(a.kind, "rows");
  const rows = (a as { rows: { startMs: number; timeouts: number }[] }).rows;
  assert.equal(rows.reduce((n, r) => n + r.timeouts, 0), 8, "cc-151's 09:34:11 reading");
  assert.equal(rows[2]!.startMs, Date.parse("2026-09-24T09:30:00Z"));
});

test("queryAttribution maps g/n to group/count, and an empty group to (null)", async () => {
  const a = await queryAttribution({
    field: "query", like: null, startMs: T0, endMs: T1, token: "t", timeoutMs: 1000,
    fetchImpl: stubFetch(200, { result: [{ g: "financial_relationships", n: 34 }, { g: "", n: 1 }] }),
  });
  assert.deepEqual(a, { kind: "rows", rows: [{ group: "financial_relationships", count: 34 }, { group: "(null)", count: 1 }] });
});

// ── FIX-1232 D1: the renders reading — 57014s by second ──────────────────────
//
// The fixtures are the raw Logs answers cc-162 pulled on 2026-09-26 while the
// three windows were still inside retention (__fixtures__/census-renders/; the
// README carries each read's UTC second). The CALL and breather spans are the
// runner receipts' (docs/audits/2026-09-24- and 2026-09-25-fix1212-bootstrap-
// runner.json), not re-derived.

interface Fixture { window: { start: string; end: string }; answer: { kind: string; rows?: Record<string, unknown>[] } }
const fixture = (name: string): Fixture =>
  JSON.parse(readFileSync(join(__dirname, "__fixtures__", "census-renders", `${name}.json`), "utf8")) as Fixture;

async function rendersOf(win: string): Promise<LogsRenderSecond[]> {
  const f = fixture(`${win}.renders`);
  const a = await queryCancellationRenders({
    startMs: Date.parse(f.window.start), endMs: Date.parse(f.window.end), token: "t", timeoutMs: 1000,
    fetchImpl: stubFetch(200, { result: f.answer.rows }),
  });
  assert.equal(a.kind, "rows", `${win}: the fixture reads as rows`);
  return (a as { rows: LogsRenderSecond[] }).rows;
}

async function bucketsOf(win: string): Promise<{ startMs: number; timeouts: number }[]> {
  const f = fixture(`${win}.buckets`);
  const a = await queryCancellationBuckets({
    startMs: Date.parse(f.window.start), endMs: Date.parse(f.window.end), token: "t", timeoutMs: 1000,
    fetchImpl: stubFetch(200, { result: f.answer.rows }),
  });
  assert.equal(a.kind, "rows");
  return (a as { rows: { startMs: number; timeouts: number }[] }).rows;
}

/** Rows whose second overlaps [from, to): a render at the CALL's first second counts. */
const within = (rows: readonly LogsRenderSecond[], from: string, to: string) =>
  rows.filter((r) => r.startMs >= Math.floor(Date.parse(from) / 1000) * 1000 && r.startMs < Date.parse(to));

test("FIX-1232 D1: the renders builder groups statement timeouts by second, over the bucket builder's own population", () => {
  const sql = sqlCancellationRenders();
  assert.match(sql, /toUnixTimestamp\(toStartOfSecond\(timestamp\)\) AS s/);
  assert.match(sql, /count\(\) AS n/);
  assert.match(sql, /WHERE source = 'postgres_logs'/);
  assert.match(sql, /GROUP BY s\s+ORDER BY s$/);
  assert.ok(sql.includes(TIME_FILTER));
  const timeout = "event_message LIKE '%canceling statement due to statement timeout%'";
  assert.ok(sql.includes(`AND ${timeout}`), "the WHERE is the bucket builder's timeout predicate");
  assert.ok(sqlCancellationBuckets().includes(`countIf(${timeout}) AS n_timeout`), "…and that is the string the bucket builder counts");
  assert.doesNotMatch(sql, /sql_state_code/, "57014 also matches a hand cancel; the gated population is the timeout");
  // The sample names a page the way `--by query` does, not by the ~600-char pgrst envelope.
  const groupExpr = /^\s*(if\(extract\([\s\S]*?\)) AS g,$/m.exec(sqlAttribution("query", null))![1]!;
  assert.ok(sql.includes(`anyHeavy(${groupExpr}) AS q`), "the attribution builder's query-name expression, verbatim");
});

test("FIX-1232 D1 on cc-151 (09-24): 9 events in 4 seconds; the 09:30:26 six are ONE render; one render in CALLs 1/3/4/5, none in CALL 2 or any breather", async () => {
  const rows = await rendersOf("cc151");
  assert.equal(rows.length, 4, "renders = rows");
  assert.equal(rows.reduce((n, r) => n + r.events, 0), 9, "events = Σ n");
  const burst = rows.find((r) => r.startMs === Date.parse("2026-09-24T09:30:26Z"))!;
  assert.equal(burst.events, 6);
  assert.equal(burst.sampleQuery, "entity_tags", "entity_tags ×4 of the six");
  assert.deepEqual(rows.map((r) => r.sampleQuery), ["proposals", "get_official_page", "officials", "entity_tags"]);
  const calls: [string, string][] = [
    ["2026-09-24T09:04:58.789Z", "2026-09-24T09:09:07.081Z"],
    ["2026-09-24T09:10:12.075Z", "2026-09-24T09:14:43.200Z"],
    ["2026-09-24T09:16:16.933Z", "2026-09-24T09:20:24.289Z"],
    ["2026-09-24T09:22:28.972Z", "2026-09-24T09:26:45.360Z"],
    ["2026-09-24T09:28:20.064Z", "2026-09-24T09:32:36.625Z"],
  ];
  assert.deepEqual(calls.map(([a, b]) => within(rows, a, b).length), [1, 0, 1, 1, 1]);
  const breathers: [string, string][] = [
    ["2026-09-24T09:09:07.382Z", "2026-09-24T09:10:08.162Z"],
    ["2026-09-24T09:14:43.301Z", "2026-09-24T09:16:14.058Z"],
    ["2026-09-24T09:20:24.387Z", "2026-09-24T09:22:25.303Z"],
    ["2026-09-24T09:26:45.518Z", "2026-09-24T09:28:16.416Z"],
    ["2026-09-24T09:32:36.807Z", "2026-09-24T09:34:07.636Z"],
  ];
  assert.deepEqual(breathers.map(([a, b]) => within(rows, a, b).length), [0, 0, 0, 0, 0]);
  // The pre-CALL 6 reading that stopped the run: 09:19:11–09:34:11 — 8 events, 3 renders.
  const pre6 = within(rows, "2026-09-24T09:19:11.098Z", "2026-09-24T09:34:11.098Z");
  assert.equal(pre6.length, 3);
  assert.equal(pre6.reduce((n, r) => n + r.events, 0), 8);
});

test("FIX-1232 D1 on cc-154 (09-25): one render in each CALL (get_official_page, +65 s and +158 s), none in the breather; the pre-claim hour's one row is a count, not a page", async () => {
  const rows = await rendersOf("cc154");
  const call1 = within(rows, "2026-09-25T00:45:31.171Z", "2026-09-25T00:49:37.060Z");
  const breather = within(rows, "2026-09-25T00:49:37.286Z", "2026-09-25T00:50:07.664Z");
  const call2 = within(rows, "2026-09-25T00:50:07.885Z", "2026-09-25T00:54:08.411Z");
  assert.deepEqual([call1.length, breather.length, call2.length], [1, 0, 1]);
  assert.equal(call1[0]!.startMs, Date.parse("2026-09-25T00:46:37Z"));
  assert.equal(call2[0]!.startMs, Date.parse("2026-09-25T00:52:45Z"));
  assert.deepEqual([call1[0]!.sampleQuery, call2[0]!.sampleQuery], ["get_official_page", "get_official_page"]);
  // cc-155 D4 counted "0 page renders (1 event)" for 23:45:29–00:45:29: the event
  // is a HEAD count on enrichment_queue. A by-second reading counts it as one —
  // the design's stated trade-off, visible in the sample.
  const preClaim = within(rows, "2026-09-24T23:45:29Z", "2026-09-25T00:45:29Z");
  assert.equal(preClaim.length, 1);
  assert.equal(preClaim[0]!.sampleQuery, "enrichment_queue");
});

test("FIX-1232 D1 on cc-159 (09-26 02:00–03:30): no statement timeout at all", async () => {
  assert.deepEqual(await rendersOf("cc159"), []);
});

test("FIX-1232 rule 116: on every fixture window the renders reading's events equal the bucket reading's timeouts — in total AND minute by minute", async () => {
  for (const win of ["cc151", "cc154", "cc159"]) {
    const renders = await rendersOf(win);
    const buckets = await bucketsOf(win);
    assert.equal(renders.reduce((n, r) => n + r.events, 0), buckets.reduce((n, b) => n + b.timeouts, 0), `${win}: Σ events = Σ timeouts`);
    const byMinute = new Map<number, number>();
    for (const r of renders) {
      const m = Math.floor(r.startMs / 60_000) * 60_000;
      byMinute.set(m, (byMinute.get(m) ?? 0) + r.events);
    }
    assert.deepEqual([...byMinute.entries()], buckets.filter((b) => b.timeouts > 0).map((b) => [b.startMs, b.timeouts]), `${win}: per minute`);
  }
});

test("FIX-1232 rule 116: on the fixtures sql_state_code 57014 and the timeout predicate agree only because no hand cancel landed", () => {
  for (const win of ["cc151", "cc154", "cc159"]) {
    for (const r of fixture(`${win}.diag`).answer.rows ?? []) {
      assert.equal(Number(r["n_57014"]), Number(r["n_timeout"]), `${win} ${String(r["s"])}`);
      assert.equal(Number(r["n_user"]), 0);
    }
  }
  // The 09:30:26 burst: six events, one second, .262 → .790 — no straddle.
  const burst = (fixture("cc151.diag").answer.rows ?? []).find((r) => r["s"] === 1790242226)!;
  const ms = (burst["ts"] as string[]).map((t) => Date.parse(`${t.slice(0, 23).replace(" ", "T")}Z`));
  assert.equal(Math.max(...ms) - Math.min(...ms), 528);
  assert.deepEqual([...(burst["rels"] as string[])].sort(),
    ["entity_engagement_rollup_mv", "entity_tags", "entity_tags", "entity_tags", "entity_tags", "officials"]);
});

test("FIX-1232 D1: sampleQueryName reads a raw envelope and an extracted name the same way; the cap and a bad second are dark", async () => {
  assert.equal(sampleQueryName('WITH pgrst_source AS ( SELECT "public"."officials"."id" FROM "public"."officials" )'), "officials");
  assert.equal(sampleQueryName("get_official_page"), "get_official_page");
  assert.equal(sampleQueryName(""), "(null)");
  assert.equal(sampleQueryName(null), "(null)");
  assert.equal(sampleQueryName("SELECT   1\n  FROM x"), "SELECT 1 FROM x");
  const capped = await queryCancellationRenders({
    startMs: T0, endMs: T1, token: "t", timeoutMs: 1000,
    fetchImpl: stubFetch(200, { result: Array.from({ length: LOGS_ROW_CAP }, (_, i) => ({ s: 1790241300 + i, n: 1, q: "x" })) }),
  });
  assert.equal(capped.kind, "dark", "1000 cancelled seconds is an incident, not a reading");
  const bad = await queryCancellationRenders({
    startMs: T0, endMs: T1, token: "t", timeoutMs: 1000,
    fetchImpl: stubFetch(200, { result: [{ s: "2026-09-24T09:30:26", n: 6, q: "entity_tags" }] }),
  });
  assert.deepEqual(bad, { kind: "dark", detail: 'Logs API bucket is not epoch seconds: "2026-09-24T09:30:26"' });
});
