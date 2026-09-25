/**
 * FIX-1219 — the ONE client for the Supabase Management API `logs` endpoint.
 *
 *   GET https://api.supabase.com/v1/projects/{ref}/analytics/endpoints/logs
 *       ?sql=<ClickHouse SQL>&iso_timestamp_start=<ISO>&iso_timestamp_end=<ISO>
 *   Authorization: Bearer <SUPABASE_MANAGEMENT_API_KEY>
 *
 * Supabase removed `analytics/endpoints/logs.all` (BigQuery dialect, one table
 * per source, nested `metadata` reached by `cross join unnest`) on 2026-09-23;
 * it has answered 410 Gone since ~10:00 UTC 09-24 (changelog 48235). Two
 * consumers read through this file and nothing else may build a Logs URL:
 *
 *   * `packages/data/src/scripts/cancellation-census.ts` — gate (f) and `--by`
 *   * `apps/civitics/app/api/cron/front-door-watch/route.ts` — the corroborator
 *
 * Before this, each consumer carried its own copy of the edge query, which is
 * how a removal took both of them dark on the same morning.
 *
 * ── THE ENDPOINT, AS MEASURED (cc-155 D2, prod, 2026-09-25 01:35–01:55 UTC) ──
 *
 * This header is the durable record. The docs and the changelog disagree with
 * each other and with the endpoint in three places, marked ≠ below; the
 * measurement wins.
 *
 * TABLE. One table, `logs`. Columns seen: `id` UUID, `timestamp`
 * DateTime64(9), `source` String, `event_message` String, `log_attributes`
 * Map(String, String), `project` String, `severity_text` String. `SELECT *`
 * and `DESCRIBE TABLE logs` both answer "Backend error!", so name columns.
 *   ≠ The changelog filters on `source_name`. That column does not exist
 *     ("Field \"source_name\" does not exist."); the API reference's `source`
 *     is right. Sources seen: edge_logs, postgres_logs, postgrest_logs,
 *     supavisor_logs.
 *
 * KEYS. `log_attributes` flattens the old nested metadata into dotted keys, and
 * every value is a STRING (the type is Map(String, String)), so a number is
 * cast before it is compared. A missing key reads '' (not NULL).
 *   edge_logs:      response.status_code ("200", "500", …), request.method,
 *                   request.path, request.search, request.url,
 *                   request.headers.user_agent ("node" on a Vercel server
 *                   render), request.headers.x_client_info, response.origin_time
 *   postgres_logs:  parsed.sql_state_code ("57014"), parsed.query,
 *                   parsed.application_name ("postgrest"), parsed.user_name
 *                   (still "authenticator" on every PostgREST row, as cc-137
 *                   found), parsed.backend_type, parsed.command_tag,
 *                   parsed.database_name, parsed.connection_from,
 *                   parsed.error_severity, parsed.session_id, parsed.timestamp
 *
 * TIME. `timestamp` is UTC and comes back as a naive ISO string with
 * microseconds ("2026-09-24T09:30:26.262000"). The builders below never
 * return it raw: a bucket is `toUnixTimestamp(toStartOfInterval(…))`, epoch
 * SECONDS as a JSON number (1790241300), and `bucketStartMs` turns that into
 * ms here, so no consumer keeps a unit conversion. (The old endpoint returned
 * MICROseconds; both consumers carried a `/ 1000`.)
 *
 * RANGE. The query-string range is REQUIRED — the same SQL with the range only
 * in a WHERE clause and no query-string range answers "Backend error!" — and it
 * is honoured to the sub-second:
 *   ≠ The API reference says the range "is rounded to the nearest minute". It
 *     is not: a start of 09:15:08 excluded a row at 09:15:07.861, and an end
 *     of 09:29:55 excluded one at 09:29:55.368.
 *   The END is INCLUSIVE: an end of exactly 09:29:55.368 kept the row stamped
 *     09:29:55.368. So a row on a bucket boundary would be counted in both
 *     neighbouring windows. `queryLogs` therefore also filters HALF-OPEN in the
 *     SQL (`TIME_FILTER`, filled here, never by a caller), and passes the
 *     query-string range widened to whole minutes so that the documented
 *     rounding, if it ever starts, cannot shave the window.
 *
 * MAX WINDOW: 24 h, and above it the answer is WRONG, not refused. Rule 147,
 * re-measured on this endpoint: a 25 h, a 48 h and a 7-day request each came
 * back HTTP 200 with exactly 24 hourly rows — the OLDEST 24 h of the range —
 * and no error. The old endpoint did the same. So `queryLogs` refuses a range
 * over `MAX_LOGS_RANGE_MINUTES` rather than send it.
 *
 * ROW CAP: 1000, silently. `LIMIT 5000` over 6 h of edge_logs returned 1000
 * rows and no error. Every builder here aggregates server-side, and
 * `queryLogs` treats an answer of exactly the cap as `dark` — it is a
 * truncation, not a reading.
 *
 * RATE LIMIT: 10 requests per 60 s per token (`x-ratelimit-limit: 10`,
 * `retry-after` in seconds on the 429). The census makes 2 calls and the route
 * 1, on the same token, so a burst of hand reads can blind a route firing. A
 * 429 is `dark` with the retry-after in its detail.
 *
 * ERRORS: a bad query is HTTP 200 with `{"error": "…"}` and no `result`. So
 * `res.ok` proves nothing; the body is checked. That answer is `dark`.
 *
 * WALL: 0.4–2.4 s for a 15–60 min read; 8–12 s for a 1440-min `postgres_logs`
 * attribution (the old endpoint's `--by query` over 1440 min timed out twice
 * at 20 s in cc-151 read 5).
 *
 * RETENTION: a rolling 7 × 24 h from now, as before.
 *
 * ── WHY NOT `mgmtGet` (supabase-usage.ts) ────────────────────────────────────
 *
 * Read before writing this (rule 133): same base, same Bearer header, same
 * `cache: "no-store"`. But it THROWS on any non-2xx with the status folded
 * into a message string, has no timeout, takes no fetch to stub, and returns
 * whatever JSON came back. This endpoint's contract lives exactly in the parts
 * it discards: 410 vs every other status, 429's retry-after, and the 200 that
 * carries an error. So this is a sibling with the same headers plus a timeout,
 * not a caller. supabase-usage.ts keeps its own `MGMT_BASE` / `PROJECT_REF`
 * copies; cc-155 was scoped not to touch it (its `usage.api-counts` still
 * answers 200, read 5).
 *
 * NO POSTGRES. Nothing here opens a database connection, which is the point:
 * both consumers exist to be readable when the database is not.
 */

export const MGMT_BASE = "https://api.supabase.com/v1";
export const PROJECT_REF = "xsazcoxinpgttgquwvuf";

/** The endpoint path. The one place it is spelled; `logs.all` is gone. */
export const LOGS_ENDPOINT = "analytics/endpoints/logs";

/** The measured 24-hour ceiling above which the endpoint answers the OLDEST 24 h. */
export const MAX_LOGS_RANGE_MINUTES = 1440;

/** Retention: a rolling 7 × 24 h from now. */
export const LOGS_RETENTION_DAYS = 7;

/** An answer this long is a truncation (measured: LIMIT 5000 came back 1000). */
export const LOGS_ROW_CAP = 1000;

/** The measured rate limit: requests per 60 s per token. */
export const LOGS_RATE_LIMIT_PER_MIN = 10;

/**
 * Every builder's SQL carries this token where the time bound goes, and
 * `queryLogs` fills it — with the SAME range it sends in the query string.
 * A caller never writes a time bound, so the two can never disagree.
 */
export const TIME_FILTER = "{{time_filter}}";

// ─────────────────────────────── the answer ───────────────────────────────────
//
// `rows` is a reading. `dark` is the endpoint failing to answer this time — a
// 5xx, a 429, a timeout, a network error, a 200 carrying an error or no result
// array, an answer at the row cap. `unavailable` is the endpoint being GONE:
// 410, or 404 on the same path. That is not a reading and not a symptom of the
// box, so every consumer keeps it distinct (the census's exit 8, the watch's
// `corroborator_unavailable`). Moved here from the census lib (cc-154).

export type LogsAnswer<T> =
  | { kind: "rows"; rows: T[] }
  | { kind: "dark"; detail: string }
  | { kind: "unavailable"; status: number; detail: string };

/** 410 Gone, and 404 on the same path: the endpoint is not there. Every other non-200 is dark. */
export function isLogsEndpointGone(status: number): boolean {
  return status === 410 || status === 404;
}

/**
 * The answer a set of answers owes before anything reads their rows:
 * `unavailable` if ANY is (they share one endpoint, and a dark sibling of a
 * removed endpoint says nothing), else the first `dark`, else null — every
 * answer has rows. The census maps this to exit 8 / exit 2.
 */
export function worstLogsAnswer(
  answers: readonly LogsAnswer<unknown>[],
): Extract<LogsAnswer<unknown>, { kind: "unavailable" | "dark" }> | null {
  const gone = answers.find((a): a is Extract<LogsAnswer<unknown>, { kind: "unavailable" }> => a.kind === "unavailable");
  if (gone) return gone;
  const dark = answers.find((a): a is Extract<LogsAnswer<unknown>, { kind: "dark" }> => a.kind === "dark");
  return dark ?? null;
}

/** The slice of `fetch` this file uses, so a test can stub it. */
export type LogsFetch = (
  url: URL,
  init: { headers: Record<string, string>; cache?: "no-store"; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

// ─────────────────────────────── the range ────────────────────────────────────

const MINUTE_MS = 60_000;

/** 'YYYY-MM-DD HH:MM:SS.mmm' in UTC — the literal `toDateTime64(…, 3, 'UTC')` parses. */
function chDateTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

/** The half-open SQL bound that replaces `TIME_FILTER`. Exported for the tests. */
export function timeFilterSql(startMs: number, endMs: number): string {
  return (
    `timestamp >= toDateTime64('${chDateTime(startMs)}', 3, 'UTC') ` +
    `AND timestamp < toDateTime64('${chDateTime(endMs)}', 3, 'UTC')`
  );
}

/**
 * The query-string range: widened to whole minutes (so the documented rounding
 * cannot shave the window; the SQL bound is what is exact), unless widening
 * would cross the 24-hour ceiling — then exact, which the endpoint honours.
 */
export function queryStringRange(startMs: number, endMs: number): { start: string; end: string } {
  const wideStart = Math.floor(startMs / MINUTE_MS) * MINUTE_MS;
  const wideEnd = Math.ceil(endMs / MINUTE_MS) * MINUTE_MS;
  const [s, e] = wideEnd - wideStart <= MAX_LOGS_RANGE_MINUTES * MINUTE_MS ? [wideStart, wideEnd] : [startMs, endMs];
  return { start: new Date(s).toISOString(), end: new Date(e).toISOString() };
}

// ─────────────────────────────── the call ─────────────────────────────────────

export interface QueryLogsOptions {
  /** ClickHouse SQL containing `TIME_FILTER` exactly where the time bound goes. */
  sql: string;
  startMs: number;
  endMs: number;
  token: string;
  timeoutMs: number;
  fetchImpl?: LogsFetch;
}

/** The URL `queryLogs` sends. Pure, so a test can read it. Throws on a caller error. */
export function buildLogsUrl(opts: Pick<QueryLogsOptions, "sql" | "startMs" | "endMs">): URL {
  const { sql, startMs, endMs } = opts;
  if (!sql.includes(TIME_FILTER)) {
    throw new Error(`Logs SQL must carry ${TIME_FILTER} where the time bound goes; queryLogs fills it`);
  }
  if (!(Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs)) {
    throw new RangeError(`Logs range must be start < end, got ${startMs} → ${endMs}`);
  }
  if (endMs - startMs > MAX_LOGS_RANGE_MINUTES * MINUTE_MS) {
    throw new RangeError(
      `Logs range ${Math.round((endMs - startMs) / MINUTE_MS)} min exceeds the endpoint's measured ` +
        `${MAX_LOGS_RANGE_MINUTES}-minute answer window; above it the endpoint returns the OLDEST 24 h ` +
        "of the range with no error. Walk a longer span in slices.",
    );
  }
  const url = new URL(`${MGMT_BASE}/projects/${PROJECT_REF}/${LOGS_ENDPOINT}`);
  url.searchParams.set("sql", sql.split(TIME_FILTER).join(timeFilterSql(startMs, endMs)));
  const qs = queryStringRange(startMs, endMs);
  url.searchParams.set("iso_timestamp_start", qs.start);
  url.searchParams.set("iso_timestamp_end", qs.end);
  return url;
}

/**
 * One read of the Logs endpoint: rows, dark or unavailable. Never throws for
 * anything the endpoint or the network does; throws only for a caller error
 * (no `TIME_FILTER`, an inverted range, a range over 24 h).
 */
export async function queryLogs<T>(opts: QueryLogsOptions): Promise<LogsAnswer<T>> {
  const url = buildLogsUrl(opts);
  const fetchImpl: LogsFetch = opts.fetchImpl ?? ((u, init) => fetch(u, init));
  try {
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok) {
      // Drain the body so the socket goes back to the pool: the census ends on
      // process.exitCode, not process.exit(), and must not wait on it.
      await res.text().catch(() => "");
      if (isLogsEndpointGone(res.status)) {
        return { kind: "unavailable", status: res.status, detail: `Logs API ${res.status} ${res.statusText}`.trim() };
      }
      const retry = res.status === 429 ? res.headers?.get("retry-after") : null;
      const limit = res.status === 429 ? ` (rate limit ${LOGS_RATE_LIMIT_PER_MIN}/min${retry ? `; retry-after ${retry}s` : ""})` : "";
      return { kind: "dark", detail: `Logs API ${res.status} ${res.statusText}`.trim() + limit };
    }
    const json = (await res.json()) as { result?: unknown; error?: unknown } | null;
    const err = json?.error;
    if (err !== undefined && err !== null && err !== "") {
      const text = typeof err === "string" ? err : JSON.stringify(err);
      return { kind: "dark", detail: `Logs API 200 with an error: ${text.slice(0, 200)}` };
    }
    if (!Array.isArray(json?.result)) {
      return { kind: "dark", detail: "Logs API answered 200 without a result array" };
    }
    if (json.result.length >= LOGS_ROW_CAP) {
      return {
        kind: "dark",
        detail: `Logs API answered ${json.result.length} rows — the ${LOGS_ROW_CAP}-row cap; truncated, not a reading`,
      };
    }
    return { kind: "rows", rows: json.result as T[] };
  } catch (err) {
    return { kind: "dark", detail: `Logs API request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─────────────────────────────── the units ────────────────────────────────────

/**
 * A builder's bucket `b` → ms since epoch. The builders return epoch SECONDS
 * (a JSON number; a numeric string is tolerated). Anything else — the naive ISO
 * string a raw `toStartOfInterval` returns, a µs value from the old endpoint's
 * habit — is NaN, and the typed readers below turn a NaN into `dark`.
 */
export function bucketStartMs(b: unknown): number {
  const n = typeof b === "number" ? b : typeof b === "string" && /^\d+$/.test(b) ? Number(b) : NaN;
  // Epoch seconds for any date this code will see sit in [1e9, 1e10). A value
  // outside that band is some other unit, and guessing it is how a verdict
  // gets read off the wrong 15 minutes.
  return Number.isFinite(n) && n >= 1e9 && n < 1e10 ? n * 1000 : NaN;
}

function mapRows<R, T>(a: LogsAnswer<R>, f: (r: R) => T & { startMs: number }): LogsAnswer<T & { startMs: number }> {
  if (a.kind !== "rows") return a;
  const rows = a.rows.map(f);
  const bad = rows.find((r) => Number.isNaN(r.startMs));
  if (bad) {
    const raw = (a.rows[rows.indexOf(bad)] as { b?: unknown } | undefined)?.b;
    return { kind: "dark", detail: `Logs API bucket is not epoch seconds: ${JSON.stringify(raw)}` };
  }
  return { kind: "rows", rows };
}

// ─────────────────────────────── edge_logs: the front door ────────────────────

/** One `edge_logs` bucket: the census's EdgeBucket and the watch's FrontDoorBucket. */
export interface LogsEdgeBucket {
  /** Bucket start, ms since epoch. */
  startMs: number;
  requests: number;
  n5xx: number;
  /** Cloudflare-class 520–526: the front-door wedge signature (FIX-1130). */
  n52x: number;
}

/**
 * Per-bucket requests / 5xx / 52x over `edge_logs`. The ClickHouse form of the
 * old `timestamp_seconds(div(unix_seconds(t.timestamp), N) * N)` + double
 * `unnest` down to `r.status_code`: one edge row is one response, so `count()`
 * is the old `count(*)` after the unnest. Re-validated against cc-151's
 * 08:45 / 09:00 / 09:15 buckets (0/136, 1/279, 2/183 — identical).
 */
export function sqlEdgeBuckets(bucketSeconds: number): string {
  if (!Number.isInteger(bucketSeconds) || bucketSeconds <= 0) {
    throw new RangeError(`bucketSeconds must be a positive integer, got ${bucketSeconds}`);
  }
  const status = "toInt32OrZero(log_attributes['response.status_code'])";
  return `
SELECT
  toUnixTimestamp(toStartOfInterval(timestamp, INTERVAL ${bucketSeconds} SECOND)) AS b,
  count() AS requests,
  countIf(${status} >= 500) AS n_5xx,
  countIf(${status} BETWEEN 520 AND 526) AS n_52x
FROM logs
WHERE source = 'edge_logs'
  AND ${TIME_FILTER}
GROUP BY b
ORDER BY b`;
}

export async function queryEdgeBuckets(opts: Omit<QueryLogsOptions, "sql"> & { bucketSeconds: number }): Promise<LogsAnswer<LogsEdgeBucket>> {
  const a = await queryLogs<{ b: unknown; requests: unknown; n_5xx: unknown; n_52x: unknown }>({
    ...opts,
    sql: sqlEdgeBuckets(opts.bucketSeconds),
  });
  return mapRows(a, (r) => ({
    startMs: bucketStartMs(r.b),
    requests: Number(r.requests) || 0,
    n5xx: Number(r.n_5xx) || 0,
    n52x: Number(r.n_52x) || 0,
  }));
}

// ─────────────────────────────── postgres_logs: cancellations ─────────────────

/** One minute with a cancellation in it. Same shape as the census's CancellationBucket. */
export interface LogsCancellationBucket {
  startMs: number;
  /** `canceling statement due to statement timeout` — the 57014 class the gate is about. */
  timeouts: number;
  /** `canceling statement due to user request` — cancelled by hand. Reported, never gated. */
  userRequests: number;
}

/**
 * Per-minute cancellation counts over `postgres_logs`, both classes in one
 * query (the gate counts timeouts; a hand cancel is a different event and is
 * reported alongside, never added in).
 *
 * One difference from the BigQuery form, on purpose: the WHERE keeps only
 * cancellation rows, so a minute without one returns NO row where the old
 * query returned a 0/0 row. Every consumer already reads only non-zero minutes
 * (the verdict sums; the table prints non-zero rows; the zero-minute count is
 * `minutes − minutes with a timeout`), and it keeps a 1440-minute read inside
 * the 1000-row cap — per-minute rows over ALL postgres_logs would not be.
 */
export function sqlCancellationBuckets(): string {
  return `
SELECT
  toUnixTimestamp(toStartOfInterval(timestamp, INTERVAL 60 SECOND)) AS b,
  countIf(event_message LIKE '%canceling statement due to statement timeout%') AS n_timeout,
  countIf(event_message LIKE '%canceling statement due to user request%') AS n_user
FROM logs
WHERE source = 'postgres_logs'
  AND event_message LIKE '%canceling statement due to%'
  AND ${TIME_FILTER}
GROUP BY b
ORDER BY b`;
}

export async function queryCancellationBuckets(opts: Omit<QueryLogsOptions, "sql">): Promise<LogsAnswer<LogsCancellationBucket>> {
  const a = await queryLogs<{ b: unknown; n_timeout: unknown; n_user: unknown }>({ ...opts, sql: sqlCancellationBuckets() });
  return mapRows(a, (r) => ({
    startMs: bucketStartMs(r.b),
    timeouts: Number(r.n_timeout) || 0,
    userRequests: Number(r.n_user) || 0,
  }));
}

// ─────────────────────────────── attribution ──────────────────────────────────

/**
 * The `parsed.*` keys a 57014 row carries, PROBED (cc-137 on the old endpoint,
 * re-probed cc-155 on this one — every one is present on the 09-24 09:30:26
 * `entity_tags` cancellation). Allow-listed because the field is interpolated
 * into the SQL.
 *
 * `user_name` is deliberately included and deliberately near-useless for the
 * role split: PostgREST logs in as `authenticator` and then SET ROLEs, and the
 * Postgres log records the LOGIN role. Still `authenticator` on every row.
 */
export const ATTRIBUTABLE_FIELDS = [
  "query",
  "user_name",
  "application_name",
  "backend_type",
  "command_tag",
  "database_name",
  "connection_from",
  "error_severity",
  "sql_state_code",
  "session_id",
] as const;

export type AttributableField = (typeof ATTRIBUTABLE_FIELDS)[number];

export function isAttributableField(v: string): v is AttributableField {
  return (ATTRIBUTABLE_FIELDS as readonly string[]).includes(v);
}

/**
 * `like` is interpolated into a ClickHouse string literal, so it is restricted
 * to characters that cannot close one, escape one, or start a comment. Null
 * when unusable; the caller turns that into a refusal.
 */
export function sanitizeLike(raw: string): string | null {
  if (raw.length === 0 || raw.length > 120) return null;
  return /^[A-Za-z0-9_. :/-]+$/.test(raw) ? raw : null;
}

/** One attribution group: a field value and how many 57014s carried it. */
export interface LogsAttributionRow {
  group: string;
  count: number;
}

/**
 * Which statement is being cancelled, grouped server-side (`LIMIT 20`, far
 * inside the row cap). Filters on `parsed.sql_state_code = '57014'` — every
 * cancel class, as the BigQuery form did.
 *
 * `query` does NOT group by the query text: PostgREST wraps every read in a
 * ~600-character `WITH pgrst_source AS (…)` envelope, so it groups by the
 * relation or function name (`"public"."get_official_page"` →
 * `get_official_page`), falling back to the first 60 characters of the
 * whitespace-collapsed text. ClickHouse's `extract` returns '' (not NULL) on
 * no match, hence `if(… != '', …)` where the old form had `coalesce`.
 * Re-validated against cc-151 read 5: financial_relationships 34,
 * enrichment_queue 10, check_senate_reference_cohort 2,
 * list_scheduled_rollup_pipelines 1 — identical.
 */
export function sqlAttribution(field: AttributableField, like: string | null): string {
  if (!isAttributableField(field)) throw new Error(`not an attributable field: ${String(field)}`);
  if (like !== null && sanitizeLike(like) !== like) throw new Error(`unusable like: ${like}`);
  const attr = (k: string) => `log_attributes['parsed.${k}']`;
  const fn = `extract(${attr("query")}, '"public"[.]"([a-z0-9_]+)"')`;
  const groupExpr =
    field === "query"
      ? `if(${fn} != '', ${fn}, substringUTF8(replaceRegexpAll(if(${attr("query")} = '', event_message, ${attr("query")}), '[[:space:]]+', ' '), 1, 60))`
      : `if(${attr(field)} = '', '(null)', ${attr(field)})`;
  const likeClause = like ? `\n  AND ${attr("query")} LIKE '%${like}%'` : "";
  return `
SELECT
  ${groupExpr} AS g,
  count() AS n
FROM logs
WHERE source = 'postgres_logs'
  AND ${attr("sql_state_code")} = '57014'
  AND ${TIME_FILTER}${likeClause}
GROUP BY g
ORDER BY n DESC
LIMIT 20`;
}

export async function queryAttribution(
  opts: Omit<QueryLogsOptions, "sql"> & { field: AttributableField; like: string | null },
): Promise<LogsAnswer<LogsAttributionRow>> {
  const { field, like, ...rest } = opts;
  const a = await queryLogs<{ g: unknown; n: unknown }>({ ...rest, sql: sqlAttribution(field, like) });
  if (a.kind !== "rows") return a;
  return {
    kind: "rows",
    rows: a.rows.map((r) => ({
      group: r.g === null || r.g === undefined || r.g === "" ? "(null)" : String(r.g),
      count: Number(r.n) || 0,
    })),
  };
}
