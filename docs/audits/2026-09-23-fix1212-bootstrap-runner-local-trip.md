# FIX-1212 bootstrap runner — stopped (local)

Written by `packages/data/src/scripts/donor-party-bootstrap-runner.ts` in its `finally`. Machine copy: the `.json` beside this file.

| | |
|---|---|
| outcome | **stopped** (exit 4) |
| detail | stop rule during CALL 2: (2) cron-job-budget-watchdog latest wall 0.266 s over 0 ms (test trip) on two consecutive readings; the CALL closed partial (window 3: canceling statement due to user request) |
| launched / finished | 2026-09-23T04:41:29.481Z / 2026-09-23T04:42:07.910Z |
| pid | 16408 |
| args | `{"probeUnits":2,"maxWaitMinutes":480,"pollSeconds":5,"maxCalls":8,"expectedMinutes":90,"tickSeconds":10,"tripOnWallMs":0,"tripFromCall":2,"receiptTag":"trip"}` |
| gate | 1 poll(s); opened 2026-09-23T04:41:29.537782+00:00 after 0.0 min |
| claim | 2026-09-23T04:41:29.899Z → released 2026-09-23T04:42:07.750Z |
| probe | max_units 2; prior value null; restored to prior: true |
| before | watermark 2026-07-25 04:41:27.703112+00 · cursor absent · MV 1859976 rows / SUM 693098760800 |
| after | watermark 2026-07-25 04:41:27.703112+00 · cursor {"mode":"full","target":"2026-09-03T01:34:43.542642+00:00","started_at":"2026-09-23T04:41:30.056748+00:00","windows_done":[1,2]} · MV 1859976 rows / SUM 693098760800 |
| SUM after / before | 1.000000 |
| trip | 2026-09-23T04:42:06.741Z call 2: (2) cron-job-budget-watchdog latest wall 0.266 s over 0 ms (test trip) on two consecutive readings; cancel sent true; backend gone verified true |

## Gate polls

- 2026-09-23T04:41:29.504Z **OK**

## CALLs

| # | probe | pid | started | wall s | status | mode | windows_run | stage_seconds | apply_seconds | error / cancel | data_sync_log id |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | yes | 16952 | 2026-09-23 04:41:30.020332+00 | 26.5 | partial | full | [1,2] | [14.07,6.88] | [3.28,2.08] | unit cap reached — 2 unit(s) run, resumable | 68b891e3-4373-46bd-bb49-23eff95e95e5 |
| 2 |  | 16952 | 2026-09-23 04:41:56.621194+00 | 10.8 | partial | full | [] | [] | [] | window 3: canceling statement due to user request | 69b1127c-b9e2-4b24-b42a-d0b6737b7943 |

## Watchdog walls per CALL (s)

- CALL 1: cron-job-budget-watchdog n=3 min 0.051 / median 0.051 / max 0.051; derived-mvs-unit-watchdog n=3 min 0.018 / median 0.018 / max 0.018
- CALL 2: cron-job-budget-watchdog n=2 min 0.051 / median 0.159 / max 0.266; derived-mvs-unit-watchdog n=2 min 0.018 / median 0.030 / max 0.042

## Census

- (none)

## Cursor at the end

```json
{
  "mode": "full",
  "target": "2026-09-03T01:34:43.542642+00:00",
  "started_at": "2026-09-23T04:41:30.056748+00:00",
  "windows_done": [
    1,
    2
  ]
}
```
