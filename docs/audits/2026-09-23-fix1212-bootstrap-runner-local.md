# FIX-1212 bootstrap runner — caught_up (local)

Written by `packages/data/src/scripts/donor-party-bootstrap-runner.ts` in its `finally`. Machine copy: the `.json` beside this file.

| | |
|---|---|
| outcome | **caught_up** (exit 0) |
| detail | caught_up (complete) after 2 CALL(s) |
| launched / finished | 2026-09-23T04:35:44.997Z / 2026-09-23T04:41:01.955Z |
| pid | 13108 |
| args | `{"probeUnits":2,"maxWaitMinutes":480,"pollSeconds":5,"maxCalls":8,"expectedMinutes":90,"tickSeconds":120,"tripOnWallMs":null,"tripFromCall":1,"receiptTag":null}` |
| gate | 1 poll(s); opened 2026-09-23T04:35:45.067107+00:00 after 0.0 min |
| claim | 2026-09-23T04:35:45.345Z → released 2026-09-23T04:41:01.378Z |
| probe | max_units 2; prior value null; restored to prior: true |
| before | watermark 2026-07-25 04:35:43.060411+00 · cursor absent · MV 1859976 rows / SUM 693098760800 |
| after | watermark 2026-09-03 01:34:43.542642+00 · cursor absent · MV 1859976 rows / SUM 693098760800 |
| SUM after / before | 1.000000 |
| trip | none |

## Gate polls

- 2026-09-23T04:35:45.028Z **OK**

## CALLs

| # | probe | pid | started | wall s | status | mode | windows_run | stage_seconds | apply_seconds | error / cancel | data_sync_log id |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | yes | 16715 | 2026-09-23 04:35:46.023699+00 | 143.9 | partial | full | [1,2] | [108.86,26.87] | [3.43,4.46] | unit cap reached — 2 unit(s) run, resumable | 99035e7e-29da-4286-b3d6-b96339b77e75 |
| 2 |  | 16715 | 2026-09-23 04:38:09.984586+00 | 170.0 | complete | full | [3,4,5,6,7,8,9,10,11,12,13,14,15,16] | [17.1,10.64,6.71,8.48,5.77,4.54,4.26,4.44,4.33,5.2,19.47,8.87,8.18,7.94] | [1.41,1.61,1.72,1.58,1.64,1.85,1.26,1.38,1.2,18.89,4.29,4.6,4.78,6.39] |  | 40a3cc11-9372-47b3-9545-13a40f0c35fe |

## Watchdog walls per CALL (s)

- CALL 1: cron-job-budget-watchdog n=2 min 0.007 / median 0.026 / max 0.044; derived-mvs-unit-watchdog n=2 min 0.007 / median 0.040 / max 0.073
- CALL 2: cron-job-budget-watchdog n=2 min 0.051 / median 0.062 / max 0.073; derived-mvs-unit-watchdog n=2 min 0.018 / median 0.043 / max 0.068

## Census

- (none)

## Cursor at the end

```json
null
```
