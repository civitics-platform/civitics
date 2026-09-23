# FIX-1212 bootstrap runner — stopped (local)

Written by `packages/data/src/scripts/donor-party-bootstrap-runner.ts` in its `finally`. Machine copy: the `.json` beside this file.

| | |
|---|---|
| outcome | **stopped** (exit 4) |
| detail | stop rule during CALL 2: (2) cron-job-budget-watchdog wall 0.008 s >= 0 ms (test trip) on two distinct runs (19045#2026-09-23T23:51:14.585Z, 19045#2026-09-23T23:51:16.613Z); the CALL closed partial (window 5: canceling statement due to user request) |
| launched / finished | 2026-09-23T23:49:45.795Z / 2026-09-23T23:51:16.989Z |
| pid | 16936 |
| args | `{"unitsPerCall":2,"wallTripS":3,"breatherUntilWallS":0.5,"breatherMaxS":20,"maxWaitMinutes":10,"pollSeconds":5,"maxCalls":12,"expectedMinutes":60,"tickSeconds":2,"tripOnWallMs":0,"tripFromCall":2,"receiptTag":"trip"}` |
| gate | 1 poll(s); opened 2026-09-23T23:49:45.861769+00:00 after 0.0 min |
| claim | 2026-09-23T23:49:48.418Z → released 2026-09-23T23:51:16.869Z |
| pacing | max_units 2 per CALL; prior value null; 2 upsert(s), 2 restore(s); restored to prior: true |
| resume | windows_done before [1,2] · resuming at window 3 · target 2026-09-03T01:34:43.542642+00:00 |
| before | watermark 2026-06-21 00:13:37.208343+00 · cursor present · MV 1859976 rows / SUM 693098760800 |
| after | watermark 2026-06-21 00:13:37.208343+00 · cursor {"mode":"full","target":"2026-09-03T01:34:43.542642+00:00","started_at":"2026-09-23T23:49:43.724643+00:00","windows_done":[1,2,3,4]} · crawl row absent · MV 1859976 rows / SUM 693098760800 |
| SUM after / before | 1.000000 |
| caught_up check | — |
| elevated ticks | 0 reading(s) with a watchdog wall in [1, 3) s |
| trip | 2026-09-23T23:51:16.630Z call 2: rule (2) (2) cron-job-budget-watchdog wall 0.008 s >= 0 ms (test trip) on two distinct runs (19045#2026-09-23T23:51:14.585Z, 19045#2026-09-23T23:51:16.613Z); runs 19045#2026-09-23T23:51:14.585Z, 19045#2026-09-23T23:51:16.613Z; cancel sent true; backend gone verified true |

## Gate polls

- 2026-09-23T23:49:45.822Z **OK**

## CALLs

| # | max_units | pid | started | wall s | status | mode | windows_run | windows_done after | stage_seconds | apply_seconds | error / cancel | data_sync_log id |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2 | 3343 | 2026-09-23 23:49:48.505684+00 | 66.0 | partial | full | [3,4] | [1,2,3,4] | [43.41,17.85] | [1.52,1.9] | unit cap reached — 2 unit(s) run, resumable | d3e21580-45ea-4b53-a26d-bec6caf963ab |
| 2 | 2 | 3343 | 2026-09-23 23:51:14.58603+00 | 2.1 | partial | full | [] | [1,2,3,4] | [] | [] | window 5: canceling statement due to user request | 65fb8c92-8ee3-4860-82f1-8528917df0b8 |

## Watchdog walls per CALL (s)

- CALL 1: cron-job-budget-watchdog n=33 min 0.005 / median 0.008 / max 0.008 (elevated 0); derived-mvs-unit-watchdog n=33 min 0.006 / median 0.008 / max 0.008 (elevated 0)
- CALL 2: cron-job-budget-watchdog n=2 min 0.008 / median 0.008 / max 0.008 (elevated 0); derived-mvs-unit-watchdog n=2 min 0.008 / median 0.008 / max 0.008 (elevated 0)

## Breathers

| before CALL | started | released | waited s | released by | readings | walls at release | pending at release |
|---|---|---|---|---|---|---|---|
| 2 | 2026-09-23T23:50:54.548Z | 2026-09-23T23:51:14.584Z | 20.0 | breather_timeout | 2 | cron-job-budget-watchdog 0.008 (run 19045); derived-mvs-unit-watchdog 0.008 (run 19044) | cron-job-budget-watchdog: no run since the CALL returned; derived-mvs-unit-watchdog: no run since the CALL returned |

## Census

- (none)

## Cursor at the end

```json
{
  "mode": "full",
  "target": "2026-09-03T01:34:43.542642+00:00",
  "started_at": "2026-09-23T23:49:43.724643+00:00",
  "windows_done": [
    1,
    2,
    3,
    4
  ]
}
```
