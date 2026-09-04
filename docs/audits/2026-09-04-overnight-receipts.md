# Overnight receipts, 2026-09-04

**Report only. Nothing here changed a schedule, a threshold, or any data.** Read
during Phase 0 of cc-prompt-104, against prod, ~01:15–01:40 UTC.

Three of these are the first measurements after work that shipped in the
preceding days, and one of them decides whether two other FIXes can close. That
is why they are written down rather than left in a session transcript.

---

## 1. FIX-1134 — the first post-swap `official_homepage_stats_mv` refresh

`refresh-derived-mvs-daily` (jobid 9), firing 2026-09-03 06:00 UTC:

| firing | `unit_seconds.official_homepage_stats_mv` |
|---|---:|
| 2026-08-31 06:00 | 253.9 s |
| 2026-08-31 23:36 | 252.8 s |
| 2026-09-01 06:00 | 800.5 s |
| 2026-09-02 06:00 | 298.0 s |
| **2026-09-03 06:00** | **47.5 s** |

**47.5 s against a 252.8–298.0 s baseline — 5.3x to 6.3x faster**, and 16.9x
against the 09-01 outlier. This is the first firing after the FIX-1134/FIX-1032
single-FR-scan MV swap landed on prod (2026-09-02 22:47 UTC), so it is the
receipt for that work.

The run's overall status is `partial`, for an unrelated reason: the
`derived-mvs-unit-watchdog` cancelled `rebuild_entity_search_index` mid-unit and
4 of 13 units were skipped, 8 ok. `official_homepage_stats_mv` itself completed.

## 2. FIX-1036 — the canary reached steady state

`canary_check` rows either side of the 09-03 00:19 dispatch:

| run | `alert_tier` | `alert_sent` | transition kinds |
|---|---|---|---|
| 2026-09-03 00:19 (dispatch) | `ESCALATE` | `true` | all 12 `new` |
| 2026-09-03 09:15 (scheduled) | *(null)* | `false` | all 12 `unchanged` |

The second scheduled run saw the same twelve findings, classified every one of
them `unchanged`, and **sent nothing**. That is the steady-state behaviour
FIX-1036 was built for: the canary pages on transitions, not on standing state.

Note for anyone reconciling against cc-prompt-104's brief, which expected three
transitions: there are **twelve** — `nightly_missing`, nine `rollup:*` entries,
and one `orphan:*`. The count is not the receipt; the `unchanged`/`alert_sent:
false` pair is.

## 3. jobid 24 — the bulk regime is live on prod but had nothing to do

Both 2026-09-03 firings of `donor-rollup-refresh`:

```
09:00  complete  regime=bulk  chunks=32  targets=0  elapsed=0.0s
12:00  complete  regime=bulk  chunks=32  targets=0  elapsed=0.0s
skip_reason: caught up at the FIX-983 horizon —
             2026-09-01 07:28:45.938461+00 is at or before the watermark
             2026-09-01 07:28:45.938461+00
```

`regime=bulk` proves FIX-973's set-based path is what pg_cron now calls — the
09-02 firings still read `mode=incremental` (the 09-02 09:00 run took 4,411 s
over 35 chunks for 361 recipients). So the code is live and took its
caught-up early return.

**But there was no dirty set to process.** `financial_relationships` had **zero
writes on 2026-09-03** — `max(updated_at)` over the day is null. So this is
*not* the receipt FIX-992 needs, and it is not FIX-973's prod leg either.

**Consequence: FIX-992 and FIX-973's prod verification both stay open.** The
receipt they need is a jobid-24 firing that meets a non-empty dirty set, which
requires the nightly FEC phase to have written FR after the watermark. Do not
close either on the strength of a caught-up run.

## 4. Crawl arms

- **EC crawl** — `get_ec_crawl_health()` signal `ok`. Watermark
  `2026-09-01T07:28:45Z`, last cycle closed `2026-09-03T19:15:00Z`, currently in
  `cycle_cooldown`. Healthy.
- **FE crawl** — still skipping on `backoff` (35 backoff skips, 8 peer_backoff;
  last skip `2026-09-04T01:00:00Z`). Watermark unchanged at
  `2026-08-19T02:24:53Z`, newest unit `2026-09-02T05:02:17Z`. Consistent with
  the arm being parked; no action taken.

## 5. FIX-1102 — the cancelled-streak mechanism is gone

`platform-snapshot` run conclusions since 2026-08-29 (44 runs):

| conclusion | count |
|---|---:|
| success | 41 |
| failure | 3 |
| **cancelled** | **0** |

The three failures are all on 2026-08-31 — the front-door wedge — and are true
positives. The last `cancelled` run was **2026-08-26**, before FIX-1127 moved
the snapshot trigger job to a Vercel cron on 08-29. The job whose timeouts were
being laundered into `cancelled` no longer exists, so FIX-1102 closes as
superseded (by FIX-1127 for the mechanism, FIX-1130 for the coverage gap).

## 6. Incidental: the restart that cleared the 08-31 wedge is still visible

`pg_postmaster_start_time()` reads **2026-08-31 23:01:12+00** (74.4 h uptime at
the time of reading). The Logs API series has `edge_logs` at 100% 52x through
the 22:45 bucket and clean from 23:15. The restart sits between them.

That is independent corroboration, from a completely different source, that a
project restart is what ends this failure mode — which is why it is the one line
in the FIX-1130 runbook.
