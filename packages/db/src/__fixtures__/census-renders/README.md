# census-renders fixtures (FIX-1232, cc-162 Phase 0)

Raw answers from the Supabase Management API `logs` endpoint, pulled on
2026-09-26 while the windows were still inside the rolling 7 × 24 h retention.
Each file is `{read_at_utc, wall_ms, kind, window, sql, answer}` — `answer` is
exactly what `queryLogs` returned, so a test can feed `answer.rows` back
through a stubbed fetch. Reads were paced at most 4 per minute and never inside
the `front-door-watch` minutes (:00/:15/:30/:45 +0–1).

`kind`:

- `renders` — the D1 SQL before it was a builder: 57014 statement timeouts
  grouped by `toStartOfSecond(timestamp)`, `count() AS n`,
  `anyHeavy(log_attributes['parsed.query']) AS q` (the raw PostgREST envelope).
- `buckets` — `sqlCancellationBuckets()` as it stood (per-minute
  `n_timeout` / `n_user`).
- `diag` — per second: the timeout-LIKE count, the `sql_state_code = '57014'`
  count, the user-request count, and the relation name the attribution builder
  extracts from each event. The population check for rule 116.
- `edge900` — `sqlEdgeBuckets(900)`.
- `p0.dayN` — `sqlEdgeBuckets(86400)` over one slice (two rows: the slice
  straddles a UTC midnight).

| file | read (UTC) | window (UTC) | answer |
|---|---|---|---|
| cc151.renders.json | 2026-09-26 21:17:19 | 09-24 09:00–09:35 | 4 seconds, 9 events: 09:07:53 ×1 `proposals`, 09:19:59 ×1 `get_official_page`, 09:24:21 ×1 `officials`, 09:30:26 ×6 |
| cc151.buckets.json | 21:17:36 | same | 4 minutes, `n_timeout` 1+1+1+6 = 9, `n_user` 0 |
| cc151.diag.json | 21:17:39 | same | 09:30:26 = `entity_tags` ×4 + `entity_engagement_rollup_mv` + `officials`, stamped .262 → .790 (528 ms, one second) |
| cc151.edge900.json | 21:20:02 | 09-24 09:00–09:30 | 09:00 1 / 279, 09:15 2 / 183 |
| cc154.renders.json | 21:18:03 | 09-24 23:40 – 09-25 01:00 | 3 seconds, 3 events: 00:30:44 `enrichment_queue` (a HEAD count, not a page — cc-155 D4), 00:46:37 and 00:52:45 `get_official_page` |
| cc154.buckets.json | 21:18:05 | same | 3 minutes, 1 + 1 + 1 |
| cc154.diag.json | 21:18:08 | same | n_57014 = n_timeout on every second, n_user 0 |
| cc159.renders.json | 21:19:03 | 09-26 02:00–03:30 | 0 rows |
| cc159.buckets.json | 21:19:05 | same | 0 rows |
| cc159.diag.json | 21:19:07 | same | 0 rows |
| cc159.edge900.json | 21:19:09 | same | 0 5xx over 595 / 541 / 424 / 165 / 434 / 582 |
| p0.smallest-15min-24h.json | 21:20:18 | 09-25 21:00 – 09-26 21:00 | the five smallest 15-min buckets: 75, 76, 89, 103, 110 requests, 0 5xx |
| p0.day1.json | 21:20:34 | 09-19 22:00 – 09-20 21:00 (23 h: the oldest hour had left retention) | 44 / 24,046 = 0.18 % |
| p0.day2.json | 21:20:50 | 09-20 21:00 – 09-21 21:00 | 70 / 18,251 = 0.38 % |
| p0.day3.json | 21:21:06 | 09-21 21:00 – 09-22 21:00 | 1,366 / 19,674 = 6.94 % (1,268 of them 52x — the 09-22 wedge) |
| p0.day4.json | 21:21:22 | 09-22 21:00 – 09-23 21:00 | 255 / 20,248 = 1.26 % (212 of them 52x) |
| p0.day5.json | 21:21:38 | 09-23 21:00 – 09-24 21:00 | 58 / 25,554 = 0.23 % |
| p0.day6.json | 21:21:55 | 09-24 21:00 – 09-25 21:00 | 38 / 32,297 = 0.12 % |
| p0.day7.json | 21:22:10 | 09-25 21:00 – 09-26 21:00 | 31 / 34,343 = 0.09 % |

The seven slices together: 1,862 5xx / 174,413 requests = **1.07 %**, above
the 1 % gate. That fired cc-162's stop on the edge half of D2 (a binomial
floor at a p0 above the gate it sits under is not a floor); the series is kept
here for the decision that replaces it.
