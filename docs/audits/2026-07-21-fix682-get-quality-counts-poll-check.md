# FIX-682 — is `/api/claude/status` polled enough to justify materializing `get_quality_counts()`?

**Date:** 2026-07-21 · **Status:** closed — no-op (leave as-is per the bullet's own gate).

## The gate

FIX-682 measured `get_quality_counts()` at 70 calls / 13.7s mean via PostgREST in
the 2026-06-27 pgss window and set an explicit gate: **materialize to a snapshot
ONLY if `/api/claude/status` carries recurring concurrent load; if it's hit only
on-demand by an operator, leave as-is.**

## Caller enumeration (code)

`get_quality_counts()` is invoked in exactly one place:
`app/api/claude/status/_lib/sections.ts:433`, inside `computeStatusPayload()`.
`computeStatusPayload` runs from:

1. **`writeStatusSnapshot()`** — called by the **platform-snapshot cron**
   (`.github/workflows/platform-snapshot.yml`, `cron: */10 * * * *`, drifts
   ~5–15 min under GHA load) via `/api/cron/platform-snapshot`. This is the
   off-request-path snapshot **writer**.
2. **Stale-snapshot fallback** in `/api/claude/status/core` and `/quality` — only
   when `status_snapshot` is older than the staleness window (~20–30 min), i.e.
   when the cron has been down. Both routes otherwise **read the snapshot**.

Request-path readers:
- **Dashboard** (`app/dashboard/useDashboardData.ts`): fetches `/core` + `/quality`
  on load, then polls on a **15-minute** `setInterval` (+ a re-fetch on tab focus).
  Every one of these hits the **snapshot** (fresh), never `get_quality_counts`.
- No `vercel.json` cron hits it (the schedule lives in GHA, per the route header).
- No other GHA workflow calls the endpoint.

So the FIX-297 snapshot materialization the bullet proposes (single-row snapshot
refreshed by the existing cron, RPC-read with live-compute fallback) **already
exists** — `get_quality_counts()` is already off the request path.

## Prod pg_stat_statements (read-only, 2026-07-21)

Window since `stats_reset` 2026-07-17 03:53 UTC = **122.46 hours**. Only ONE
statement matches `get_quality_counts` (no DDL / monitor / request-path variants):

| kind | calls | mean_ms | max_ms | total_sec | **calls/hour** |
|---|---|---|---|---|---|
| postgrest-call (`WITH pgrst_source … get_quality_counts()`) | 82 | 18,996 | 30,673 | 1,557.7 | **0.67** |

**0.67 calls/hour** — sporadic, single-threaded, off the request path. (Even the
*intended* 10-min cron cadence is 6/hour single-threaded; the measured effective
rate is ~1 per 90 min, consistent with GHA free-tier cron drift.) There is no
request-path variant of the call at all — confirming the dashboard/page reads are
served entirely by `status_snapshot`.

## Verdict

Signal (b): **sporadic / operator-cadence, not recurring concurrent load.** The
proposed materialization already exists (FIX-297), and `get_quality_counts()` runs
only to refresh the snapshot at ≤0.67/hour off the request path. There is nothing
to materialize away and no recurring concurrent request-path load. Per the bullet's
own gate — **leave as-is.**

**Closure:** `Closes: FIX-682`, `Verified[FIX-682]: closes-as-no-op`.
