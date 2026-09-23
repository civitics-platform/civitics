# FIX-1212 bootstrap runner — stopped (prod)

Written by `packages/data/src/scripts/donor-party-bootstrap-runner.ts` in its `finally`. Machine copy: the `.json` beside this file.

| | |
|---|---|
| outcome | **stopped** (exit 4) |
| detail | stop rule before CALL 2: (2) cron-job-budget-watchdog latest wall 1.341 s over 1 s on two consecutive readings |
| launched / finished | 2026-09-23T04:52:41.177Z / 2026-09-23T09:07:38.939Z |
| pid | 2612 |
| args | `{"probeUnits":2,"maxWaitMinutes":480,"pollSeconds":300,"maxCalls":8,"expectedMinutes":90,"tickSeconds":120,"tripOnWallMs":null,"tripFromCall":1,"receiptTag":null}` |
| gate | 51 poll(s); opened 2026-09-23T09:02:42.193301+00:00 after 250.0 min |
| claim | 2026-09-23T09:02:46.402Z → released 2026-09-23T09:07:36.903Z |
| probe | max_units 2; prior value null; restored to prior: true |
| before | watermark 2026-07-28 05:54:28.48494+00 · cursor absent · MV 1551121 rows / SUM 705589798600 |
| after | watermark 2026-07-28 05:54:28.48494+00 · cursor {"mode":"full","target":"2026-09-21T00:18:25.831727+00:00","started_at":"2026-09-23T09:02:48.434717+00:00","windows_done":[1,2]} · MV 1728538 rows / SUM 732520894800 |
| SUM after / before | 1.038168 |
| trip | 2026-09-23T09:07:05.522Z call 2: (2) cron-job-budget-watchdog latest wall 1.341 s over 1 s on two consecutive readings; cancel sent false; backend gone verified false |

## Gate polls

- 2026-09-23T04:52:41.369Z blocked: b:fe-vacuum-analyze, c:blackout
- 2026-09-23T04:57:41.382Z blocked: b:fe-vacuum-analyze, c:blackout
- 2026-09-23T05:02:41.389Z blocked: c:blackout
- 2026-09-23T05:07:41.400Z blocked: c:blackout
- 2026-09-23T05:12:41.412Z blocked: c:blackout
- 2026-09-23T05:17:41.422Z blocked: c:blackout
- 2026-09-23T05:22:41.430Z blocked: c:blackout
- 2026-09-23T05:27:41.434Z blocked: c:blackout
- 2026-09-23T05:32:41.444Z blocked: c:blackout
- 2026-09-23T05:37:41.451Z blocked: c:blackout
- 2026-09-23T05:42:41.453Z blocked: c:blackout
- 2026-09-23T05:47:41.467Z blocked: c:blackout
- 2026-09-23T05:52:41.480Z blocked: c:blackout
- 2026-09-23T05:57:41.490Z blocked: c:blackout
- 2026-09-23T06:02:41.491Z blocked: c:blackout, e:live_writers
- 2026-09-23T06:07:41.502Z blocked: c:blackout
- 2026-09-23T06:12:41.513Z blocked: c:blackout
- 2026-09-23T06:17:41.514Z blocked: c:blackout
- 2026-09-23T06:22:41.518Z blocked: c:blackout
- 2026-09-23T06:27:41.518Z blocked: c:blackout
- 2026-09-23T06:32:41.525Z blocked: c:blackout, d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog, e:live_writers
- 2026-09-23T06:37:41.533Z blocked: c:blackout, d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T06:42:41.538Z blocked: c:blackout
- 2026-09-23T06:47:41.540Z blocked: c:blackout
- 2026-09-23T06:52:41.555Z blocked: c:blackout
- 2026-09-23T06:57:41.569Z blocked: c:blackout
- 2026-09-23T07:02:41.573Z blocked: c:blackout
- 2026-09-23T07:07:41.576Z blocked: c:blackout
- 2026-09-23T07:12:41.580Z blocked: c:blackout
- 2026-09-23T07:17:41.581Z blocked: c:blackout
- 2026-09-23T07:22:41.589Z blocked: c:blackout
- 2026-09-23T07:27:41.604Z blocked: c:blackout
- 2026-09-23T07:32:41.616Z blocked: c:blackout
- 2026-09-23T07:37:41.628Z blocked: c:blackout
- 2026-09-23T07:42:41.629Z blocked: c:blackout
- 2026-09-23T07:47:41.637Z blocked: c:blackout
- 2026-09-23T07:52:41.642Z blocked: c:blackout
- 2026-09-23T07:57:41.656Z blocked: c:blackout
- 2026-09-23T08:02:41.660Z blocked: c:blackout
- 2026-09-23T08:07:41.669Z blocked: c:blackout
- 2026-09-23T08:12:41.677Z blocked: c:blackout
- 2026-09-23T08:17:41.679Z blocked: c:blackout
- 2026-09-23T08:22:41.683Z blocked: c:blackout
- 2026-09-23T08:27:41.685Z blocked: c:blackout
- 2026-09-23T08:32:41.693Z blocked: c:blackout
- 2026-09-23T08:37:41.697Z blocked: c:blackout
- 2026-09-23T08:42:41.702Z blocked: c:blackout
- 2026-09-23T08:47:41.706Z blocked: c:blackout
- 2026-09-23T08:52:41.708Z blocked: c:blackout
- 2026-09-23T08:57:41.710Z blocked: c:blackout
- 2026-09-23T09:02:41.714Z **OK**

## CALLs

| # | probe | pid | started | wall s | status | mode | windows_run | stage_seconds | apply_seconds | error / cancel | data_sync_log id |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | yes | 53253 | 2026-09-23 09:02:48.199059+00 | 257.1 | partial | full | [1,2] | [134.8,114.41] | [4.45,3.25] | unit cap reached — 2 unit(s) run, resumable | 0e7c8e74-9db4-44c3-93ad-adfb56772c74 |

## Watchdog walls per CALL (s)

- CALL 1: cron-job-budget-watchdog n=3 min 0.014 / median 0.874 / max 1.341; derived-mvs-unit-watchdog n=3 min 0.003 / median 0.495 / max 0.948

## Census

- 2026-09-23T09:02:45.603Z (60 min) exit 0: pass=true 57014=0 (0/min, ratio 0) edge 0 of 169 request(s) = 0.00 %

## Cursor at the end

```json
{
  "mode": "full",
  "target": "2026-09-21T00:18:25.831727+00:00",
  "started_at": "2026-09-23T09:02:48.434717+00:00",
  "windows_done": [
    1,
    2
  ]
}
```
