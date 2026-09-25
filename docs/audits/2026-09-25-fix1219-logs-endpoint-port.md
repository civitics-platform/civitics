# FIX-1219 — the Logs port: the `logs` endpoint, mapped by probing; the census and the front-door watch re-validated on it

cc-155, 2026-09-25 01:35–02:20 UTC. Prod contact was reads only: the Management API `logs` endpoint, `usage.api-counts` once, and `db-query.mjs --prod`.

The durable schema map lives in the header of `packages/db/src/supabase-logs.ts`. This file is the evidence behind it.

## 1. The endpoint, in one table

| Question | Answer, as measured | Docs said |
|---|---|---|
| Path | `GET /v1/projects/{ref}/analytics/endpoints/logs` | same |
| Dialect | ClickHouse; one table, `logs` | same |
| Source filter | `source = 'edge_logs'` | changelog: `source_name` (**does not exist**); reference: `source` |
| Columns seen | `id` UUID, `timestamp` DateTime64(9), `source`, `event_message`, `log_attributes` Map(String, String), `project`, `severity_text` | — |
| `SELECT *` / `DESCRIBE` | both "Backend error!" | — |
| Nested fields | `log_attributes['response.status_code']`, `['parsed.sql_state_code']` …; every value a String; a missing key reads '' | map access (same) |
| Timestamp on the wire | naive ISO UTC, µs: `"2026-09-24T09:30:26.262000"` | — |
| Bucket on the wire | `toUnixTimestamp(toStartOfInterval(…))` → epoch **seconds**, a JSON number | — (old endpoint: µs) |
| Time range | query string required; SQL-only → Backend error | "defaults to last 1 minute" |
| Range precision | honoured to the sub-second; **end inclusive** | "rounded to the nearest minute" (**not observed**) |
| Max window | 24 h; above it the **oldest** 24 h, HTTP 200, no error | "no more than 24 hours" (the silent clamp is not mentioned) |
| Row cap | 1000, silent (`LIMIT 5000` → 1000) | not stated |
| Rate limit | 10 / 60 s per token; 429 with `retry-after` | 429 listed, limit not stated |
| Bad query | HTTP 200 `{"error": "…"}`, no `result` | response has `error` |
| Wall | 0.4–2.4 s for a 15–60 min read; 8–12 s for 1440 min of `postgres_logs` | — |

## 2. Every probe, in order

"range" is the query-string range (`iso_timestamp_start` → `iso_timestamp_end`). Every call was HTTP 200 unless marked otherwise.

| # | SQL (abridged) | range | Answer |
|---|---|---|---|
| P1 | `SELECT * FROM logs WHERE source_name = 'edge_logs' ORDER BY timestamp DESC LIMIT 2` | 09-25 01:20–01:40 | `{"error":"Backend error! Retry your query. Please contact support if this continues."}` |
| P2 | `SELECT timestamp, event_message FROM logs WHERE source_name = 'edge_logs' …` | same | Backend error! |
| P3 | same with `source = 'edge_logs'` | same | 2 rows: `GET \| 200 \| …/rest/v1/financial_entities?… \| node`, `"timestamp":"2026-09-25T01:39:06.251000"` |
| P4 | `SELECT timestamp, event_message FROM logs ORDER BY timestamp DESC LIMIT 2` | same | `Warp server error: Thread killed by timeout manager` @ 01:39:48.390339 |
| P5 | `SELECT * FROM logs WHERE source = 'edge_logs' LIMIT 1` | 01:30–01:40 | Backend error! |
| P6 | `DESCRIBE TABLE logs` | same | Backend error! |
| P7 | `SELECT timestamp, log_attributes FROM logs WHERE source = 'edge_logs' ORDER BY timestamp DESC LIMIT 1` | same | the edge key map: `response.status_code "200"`, `request.method GET`, `request.path /rest/v1/financial_entities`, `request.search`, `request.url`, `request.headers.user_agent node`, `request.headers.x_client_info supabase-js-node/2.99.1`, `response.origin_time "310"`, `request.cf.*`, … |
| P8 | `SELECT <col> FROM logs WHERE source = 'postgres_logs' LIMIT 1`, one column per call | 01:20–01:40 | `id` → UUID; `source_name` → `Field "source_name" does not exist.`; `source` → postgres_logs; the 4th call → **429** `ThrottlerException` |
| P9 | the throttle, re-polled every 15 s | — | 01:41:07 429 `x-ratelimit-limit=10 x-ratelimit-remaining=0 retry-after=35` → 01:41:54 200 `remaining=9 reset=60` |
| A1 | `SELECT toTypeName(timestamp), toTypeName(log_attributes), …` | 01:30–01:40 | `DateTime64(9)`, `Map(String, String)`, String, String, UUID |
| A2 | `SELECT timestamp, event_message, log_attributes FROM logs WHERE source = 'postgres_logs' AND event_message LIKE '%statement timeout%' ORDER BY timestamp LIMIT 1` | 09-24 09:30–09:31 | `canceling statement due to statement timeout`; `parsed.sql_state_code 57014`, `parsed.application_name postgrest`, `parsed.user_name authenticator`, `parsed.command_tag BIND`, `parsed.query WITH pgrst_source AS ( SELECT "public"."entity_tags"…`, `parsed.timestamp 2026-09-24 09:30:26.262 UTC`; timestamp `2026-09-24T09:30:26.262000` |
| A3–A6 | `project` / `severity_text` / `metadata` / `body` | 01:30–01:40 | xsazcoxinpgttgquwvuf / INFO / does not exist / does not exist |
| A7 | `SELECT source, count() … GROUP BY source` | 01:30–01:40 | edge_logs 273, postgres_logs 49, postgrest_logs 21, supavisor_logs 16 |
| B1 | `SELECT count(), min(timestamp), max(timestamp) … edge_logs` | 09-24 09:15–09:30 | **183**, 09:15:07.861 → 09:29:55.368 (the old endpoint's 183) |
| B2 | same, range in SQL only, no query string | none | Backend error! |
| B3 | same, SQL `timestamp >= 09:15 AND < 09:30` | 09:00–10:00 | 183, same min/max: a SQL bound inside a wider range is exact |
| B4 | B1 | 09:15:20–09:29:40 | 173, 09:15:28.224 → 09:28:22.675 |
| B5 | B1 | 09:15:40–09:29:20 | 171, 09:16:18.203 → 09:28:22.675 |
| B6 | edge buckets at 900 s; `b` raw and `toUnixTimestamp(b)` | 08:30–09:30 | `"b":"2026-09-24T08:30:00"`, `"b_s":1790238600`; 08:30 317/0/0 · 08:45 **136/0/0** · 09:00 **279/1/0** · 09:15 **183/2/0** (requests/5xx/52x) |
| B7 | cancellations per minute | 09:19:11–09:34:11 | 09:19 ×1 · 09:24 ×1 · 09:30 ×6 = **8** |
| B8 | `log_attributes['response.status_code']`, count | 09:00–09:30 | "200" 439, "204" 10, "201" 4, "500" 3, "406" 2, "401" 2, "206" 2 |
| C1 | hourly `postgres_logs` count + 57014 | 24 h: 09-23 00:00 → 09-24 00:00 | 24 rows from 09-23 00:00 (7.7 s) |
| C2 | same | 25 h: 09-22 23:00 → 09-24 00:00 | 24 rows from **09-22 23:00** — the oldest 24 h (8.5 s) |
| C3 | same | 48 h: 09-22 00:00 → 09-24 00:00 | 18 rows from **09-22 00:00**; the 15:00–22:00 hole is the cc-145 postgres_logs dark window — the oldest 24 h (5.6 s) |
| C4 | same | 7 d: 09-18 03:00 → 09-25 01:00 | 24 rows from **09-18 03:00** — the oldest 24 h (9.8 s) |
| C5 | raw `timestamp`, `LIMIT 5000` | 09-24 06:00–12:00 | **1000** rows (the cap) |
| C6 | raw `timestamp`, no LIMIT | 08:00–09:00 | 966 rows (under the cap) |
| C7 | attribution by `parsed.application_name`, 57014 | 09-23 00:42 → 09-24 00:42 | postgrest **47** (11.7 s) |
| C8 | attribution by relation/function name | same | financial_relationships **34**, enrichment_queue **10**, check_senate_reference_cohort **2**, list_scheduled_rollup_pipelines **1** (8.3 s) |
| D1 | count/min/max `postgres_logs` | 24 h + 1 min: 09-23 00:41 → 09-24 00:42 | 3875, 00:42:00.001 → 00:40:17.240 (= D2; consistent with the clamp, since neither 00:41 minute holds a row) |
| D2 | same | 24 h: 00:42 → 00:42 | 3875, same |
| D3 | B1 | 09:15:00 → **09:29:55** | 182, max 09:28:22.675: the 09:29:55.368 row is excluded, so the end is not rounded up |
| D4 | B1 | **09:15:08** → 09:30 | 182, min 09:15:08.644: the 09:15:07.861 row is excluded, so the start is not rounded down |
| D5 | B1 | 09:15 → **09:29:55.368** | 183, max 09:29:55.368: **the end is inclusive** |
| D6 | D1 | 24 h + 30 min: 09-23 00:12 → 09-24 00:42 | 3869, 09-23 00:12:00.001 → 09-24 00:10:16.864 — the oldest 24 h |

The consequences are built into the helper:
- the range goes in the query string AND in a half-open SQL bound, because the endpoint's end is inclusive;
- a range over 1440 min is refused;
- an answer at 1000 rows is dark;
- 429 is dark with its retry-after;
- a 200 carrying `error` is dark;
- buckets are read as epoch seconds and returned in ms.

## 3. Re-validation: the census, old endpoint vs `logs`, same windows

Old readings are from cc-151's receipt `docs/audits/2026-09-24-fix1212-bootstrap-runner.md` and cc-151 read 6. New readings are the worktree's census at e85edf1c, run against prod through the helper.

| Window (`--end`) | Old | New |
|---|---|---|
| 09-24 09:34:11 · 15 min | 8, ratio 16.16 FAIL · edge 09:15 2/183 = 1.09 % FAIL · exit 1 | 8, ratio 16.16, floor 3, FAIL · 09:15 2/183 = 1.09 % FAIL · exit 1 |
| 09:28:20 · 15 | 2, 4.04 pass · 09:00 1/279 · exit 0 | identical |
| 09:22:29 · 15 | 2, 4.04 pass · 09:00 1/279 · exit 0 | identical |
| 09:16:17 · 15 | 1, 2.02 pass · 09:00 1/279 · exit 0 | identical |
| 09:10:12 · 15 | 1, 2.02 pass · 08:45 0/136 · exit 0 | identical |
| 09:04:59 · 15 | 0 · 08:45 0/136 · exit 0 | identical |
| 09:04:53 · 60 | 0, floor 6 · 08:45 0/136 · exit 0 | identical |
| 09-24 00:41:43 · 60 | 6, ratio 3.03, floor 6 pass · 00:15 6/583 = 1.03 % FAIL · exit 1 | identical |
| `--by application_name` 1440 → 00:42 | postgrest 47/47 | postgrest 47/47 |
| `--by query` 1440 → 00:42 | 34 / 10 / 2 / 1 (timed out twice at 20 s) | 34 / 10 / 2 / 1, in 9.3 s |

**By second, 09-24 09:00–09:35** (57014 in `postgres_logs`; 5xx in `edge_logs`):

| pg second | n | relation / function | edge 5xx row (request start) | user-agent |
|---|---|---|---|---|
| 09:07:53 | 1 | proposals | 09:07:48 GET /rest/v1/proposals | node |
| 09:19:59 | 1 | get_official_page | 09:19:55 POST /rest/v1/rpc/get_official_page | node |
| 09:24:21 | 1 | officials | 09:24:18 GET /rest/v1/officials | node |
| 09:30:26 | 6 | entity_tags ×4, entity_engagement_rollup_mv, officials | 09:30:20 ×6, same paths | node |

This matches cc-151 §5.3, including its two edge times.

No count differs anywhere, so there is no edge delta to explain. The population is the same:
- Vercel's `node` server renders are in `edge_logs`.
- `sql_state_code` rides every cancellation.

## 4. The watch, after the deploy (e85edf1c, Vercel success 02:08:43 UTC)

`data_sync_log`, pipeline `front_door_watch`:

| started_at | state | logs_api | buckets (requests / 5xx / 52x) |
|---|---|---|---|
| 09-25 01:45:28 | corroborator_unavailable | unavailable (410, FIX-1219) | zero-filled |
| 09-25 02:00:28 | corroborator_unavailable | unavailable (410, FIX-1219) | zero-filled |
| **09-25 02:15:28** | **ok** | **4 bucket(s)** | 01:15 293/0/0 · 01:30 441/0/0 · 01:45 393/0/0 · 02:00 628/0/0 |

- The census over the same hour read the same four buckets: 293 / 441 / 393 / 628. It is one builder with two consumers.
- The canary classifier (`classifyFrontDoorWatch`), run over the real last-60-min rows (4 firings, 3 blind, newest ok), returns `tier: null`. The `front_door_corroborator_unavailable` report clears.
- Gate (f), as the template states it, from the primary checkout at 02:17:54: `pnpm --filter @civitics/data data:census:cancellations:prod --minutes 60 --json` exited 0.
  - 0 × 57014 over 60 min, floor 6.
  - The last closed bucket was 02:00, with 0 of 628.

## 5. The measurement cc-152 item 7 owed: the visitor cost of one paced CALL

This is cc-154's run on 09-25 (claim 00:45:29, release 00:54:09). The read is one by-second pass over 09-24 23:45 → 09-25 00:55, with one render = one second.

| Span | Renders lost | Events | What |
|---|---|---|---|
| hour before the claim, 23:45:29–00:45:29 | 0 page renders | 1 | 00:30:44 `HEAD /rest/v1/enrichment_queue?select=*&status=eq.processing` (ua node): a count, not a page. 0 donor-page (FIX-1217) reads |
| CALL 1, 00:45:32–00:49:33 (windows 13–14) | **1** | 1 | 00:46:37 `rpc/get_official_page` (edge 00:46:33), +65 s into the CALL |
| breather, 00:49:33–00:50:07 | **0** | 0 | — |
| CALL 2, 00:50:07–00:54:06 (windows 15–16) | **1** | 1 | 00:52:45 `rpc/get_official_page` (edge 00:52:41), +158 s |
| 00:54:06–00:55:00 | 0 | 0 | — |

**One official-profile render lost per paced CALL of two windows; none in the breather.** cc-151's five CALLs (windows 3–12) lost 4 renders (9 events: 1, 0, 1, 1, and one render of 6). That is 0.8 renders per CALL. Three of those four renders were official-page reads; the fourth was `proposals`.
