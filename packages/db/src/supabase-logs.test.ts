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
import test from "node:test";

import {
  bucketStartMs,
  buildLogsUrl,
  isAttributableField,
  isLogsEndpointGone,
  isLogsSchemaRemoval,
  queryAttribution,
  queryCancellationBuckets,
  queryEdgeBuckets,
  queryLogs,
  queryStringRange,
  sanitizeLike,
  sqlAttribution,
  sqlCancellationBuckets,
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
