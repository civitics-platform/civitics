# FIX-1212 bootstrap runner — stopped (prod)

Written by `packages/data/src/scripts/donor-party-bootstrap-runner.ts` in its `finally`. Machine copy: the `.json` beside this file.

| | |
|---|---|
| outcome | **stopped** (exit 4) |
| vocabulary | caught_up 0 · error 1 · stopped 4 · skipped 5 · max_calls 6 · gate_timeout 7 · (3 retired: census_fail — the census is waited on inside the gate, cc-151) |
| detail | stop rule before CALL 6: (3) census pass=false (57014 rate or front-door 5xx) |
| launched / finished | 2026-09-24T01:04:47.500Z / 2026-09-24T09:34:13.975Z |
| pid | 17080 |
| args | `{"unitsPerCall":2,"wallTripS":3,"breatherUntilWallS":0.5,"breatherMaxS":600,"maxWaitMinutes":600,"pollSeconds":300,"maxCalls":12,"expectedMinutes":60,"tickSeconds":120,"tripOnWallMs":null,"tripFromCall":1,"receiptTag":null}` |
| gate | 97 poll(s): 96 held by the gate, 0 by the census (0 dark); opened 2026-09-24T09:04:47.970458+00:00 after 480.1 min · census at opening: pass (0/60 min, ratio 0.00, floor 6; edge 0 of 136 request(s) = 0.00 %) |
| claim | 2026-09-24T09:04:54.549Z → released 2026-09-24T09:34:12.693Z |
| pacing | max_units 2 per CALL; prior value null; 5 upsert(s), 5 restore(s); restored to prior: true |
| resume | windows_done before [1,2] · resuming at window 3 · target 2026-09-21T00:18:25.831727+00:00 |
| before | watermark 2026-07-28 05:54:28.48494+00 · cursor present · MV 1728538 rows / SUM 732520894800 |
| after | watermark 2026-07-28 05:54:28.48494+00 · cursor {"mode":"full","target":"2026-09-21T00:18:25.831727+00:00","started_at":"2026-09-23T09:02:48.434717+00:00","windows_done":[1,2,3,4,5,6,7,8,9,10,11,12]} · crawl row absent · MV 2618055 rows / SUM 867716229900 |
| SUM after / before | 1.184562 |
| caught_up check | — |
| elevated ticks | 12 reading(s) with a watchdog wall in [1, 3) s |
| trip | 2026-09-24T09:34:11.098Z call 6: rule (3) (3) census pass=false (57014 rate or front-door 5xx); cancel sent false; backend gone verified true |

## Gate polls (both halves — cc-151 D2)

- 2026-09-24T01:04:47.752Z held by the gate: b:fr-vacuum-analyze · census not read (gate blocked)
- 2026-09-24T01:09:47.753Z held by the gate: b:fr-vacuum-analyze · census not read (gate blocked)
- 2026-09-24T01:14:47.755Z held by the gate: b:fr-vacuum-analyze · census not read (gate blocked)
- 2026-09-24T01:19:47.756Z held by the gate: b:fr-vacuum-analyze · census not read (gate blocked)
- 2026-09-24T01:24:47.761Z held by the gate: b:fr-vacuum-analyze · census not read (gate blocked)
- 2026-09-24T01:29:47.763Z held by the gate: b:fr-vacuum-analyze · census not read (gate blocked)
- 2026-09-24T01:34:47.766Z held by the gate: b:fr-vacuum-analyze · census not read (gate blocked)
- 2026-09-24T01:39:47.768Z held by the gate: b:fr-vacuum-analyze · census not read (gate blocked)
- 2026-09-24T01:44:47.770Z held by the gate: b:fr-vacuum-analyze · census not read (gate blocked)
- 2026-09-24T01:49:47.772Z held by the gate: b:fr-vacuum-analyze · census not read (gate blocked)
- 2026-09-24T01:54:47.775Z held by the gate: b:fr-vacuum-analyze · census not read (gate blocked)
- 2026-09-24T01:59:47.777Z held by the gate: b:fr-vacuum-analyze · census not read (gate blocked)
- 2026-09-24T02:04:47.780Z held by the gate: b:fr-vacuum-analyze · census not read (gate blocked)
- 2026-09-24T02:09:47.782Z held by the gate: b:fr-vacuum-analyze · census not read (gate blocked)
- 2026-09-24T02:14:47.785Z held by the gate: b:fr-vacuum-analyze · census not read (gate blocked)
- 2026-09-24T02:19:47.787Z held by the gate: b:fr-vacuum-analyze · census not read (gate blocked)
- 2026-09-24T02:24:47.789Z held by the gate: b:fr-vacuum-analyze · census not read (gate blocked)
- 2026-09-24T02:29:47.792Z held by the gate: b:fr-vacuum-analyze · census not read (gate blocked)
- 2026-09-24T02:34:47.793Z held by the gate: b:ec-vacuum-analyze, b:fr-vacuum-analyze · census not read (gate blocked)
- 2026-09-24T02:39:47.796Z held by the gate: b:ec-vacuum-analyze, b:fr-vacuum-analyze · census not read (gate blocked)
- 2026-09-24T02:44:47.799Z held by the gate: b:ec-vacuum-analyze, b:fr-vacuum-analyze · census not read (gate blocked)
- 2026-09-24T02:49:47.802Z held by the gate: b:ec-vacuum-analyze, b:fr-vacuum-analyze · census not read (gate blocked)
- 2026-09-24T02:54:47.803Z held by the gate: b:ec-vacuum-analyze, b:fr-vacuum-analyze · census not read (gate blocked)
- 2026-09-24T02:59:47.806Z held by the gate: b:ec-vacuum-analyze, b:fr-vacuum-analyze · census not read (gate blocked)
- 2026-09-24T03:04:47.808Z held by the gate: b:ec-vacuum-analyze, b:fr-vacuum-analyze · census not read (gate blocked)
- 2026-09-24T03:09:47.811Z held by the gate: b:ec-vacuum-analyze, b:fr-vacuum-analyze · census not read (gate blocked)
- 2026-09-24T03:14:47.813Z held by the gate: b:ec-vacuum-analyze · census not read (gate blocked)
- 2026-09-24T03:19:47.816Z held by the gate: b:ec-vacuum-analyze · census not read (gate blocked)
- 2026-09-24T03:24:47.818Z held by the gate: b:ec-vacuum-analyze · census not read (gate blocked)
- 2026-09-24T03:29:47.821Z held by the gate: b:ec-vacuum-analyze · census not read (gate blocked)
- 2026-09-24T03:34:47.824Z held by the gate: b:ec-vacuum-analyze · census not read (gate blocked)
- 2026-09-24T03:39:47.827Z held by the gate: b:ec-vacuum-analyze · census not read (gate blocked)
- 2026-09-24T03:44:47.828Z held by the gate: b:ec-vacuum-analyze · census not read (gate blocked)
- 2026-09-24T03:49:47.831Z held by the gate: b:ec-vacuum-analyze, c:blackout · census not read (gate blocked)
- 2026-09-24T03:54:47.833Z held by the gate: b:ec-vacuum-analyze, c:blackout · census not read (gate blocked)
- 2026-09-24T03:59:47.837Z held by the gate: b:ec-vacuum-analyze, c:blackout · census not read (gate blocked)
- 2026-09-24T04:04:47.838Z held by the gate: b:ec-vacuum-analyze, c:blackout · census not read (gate blocked)
- 2026-09-24T04:09:47.838Z held by the gate: b:ec-vacuum-analyze, c:blackout · census not read (gate blocked)
- 2026-09-24T04:14:47.840Z held by the gate: b:ec-vacuum-analyze, c:blackout · census not read (gate blocked)
- 2026-09-24T04:19:47.845Z held by the gate: b:ec-vacuum-analyze, c:blackout · census not read (gate blocked)
- 2026-09-24T04:24:47.847Z held by the gate: b:ec-vacuum-analyze, c:blackout · census not read (gate blocked)
- 2026-09-24T04:29:47.850Z held by the gate: b:ec-vacuum-analyze, c:blackout · census not read (gate blocked)
- 2026-09-24T04:34:47.851Z held by the gate: b:ec-vacuum-analyze, c:blackout · census not read (gate blocked)
- 2026-09-24T04:39:47.855Z held by the gate: b:ec-vacuum-analyze, c:blackout · census not read (gate blocked)
- 2026-09-24T04:44:47.858Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T04:49:47.858Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T04:54:47.860Z held by the gate: b:fe-vacuum-analyze, c:blackout · census not read (gate blocked)
- 2026-09-24T04:59:47.863Z held by the gate: b:fe-vacuum-analyze, c:blackout · census not read (gate blocked)
- 2026-09-24T05:04:47.865Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T05:09:47.868Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T05:14:47.868Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T05:19:47.872Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T05:24:47.876Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T05:29:47.878Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T05:34:47.881Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T05:39:47.883Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T05:44:47.887Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T05:49:47.889Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T05:54:47.892Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T05:59:47.894Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T06:04:47.896Z held by the gate: c:blackout, d:cron-job-budget-watchdog, e:live_writers · census not read (gate blocked)
- 2026-09-24T06:09:47.899Z held by the gate: c:blackout, d:cron-job-budget-watchdog · census not read (gate blocked)
- 2026-09-24T06:14:47.902Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T06:19:47.904Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T06:24:47.907Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T06:29:47.910Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T06:34:47.912Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T06:39:47.915Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T06:44:47.917Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T06:49:47.920Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T06:54:47.922Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T06:59:47.925Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T07:04:47.926Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T07:09:47.929Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T07:14:47.933Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T07:19:47.935Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T07:24:47.950Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T07:29:47.956Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T07:34:47.963Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T07:39:47.975Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T07:44:47.978Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T07:49:47.981Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T07:54:47.995Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T07:59:47.998Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T08:04:48.000Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T08:09:48.003Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T08:14:48.011Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T08:19:48.013Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T08:24:48.016Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T08:29:48.019Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T08:34:48.019Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T08:39:48.024Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T08:44:48.025Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T08:49:48.030Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T08:54:48.031Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T08:59:48.035Z held by the gate: c:blackout · census not read (gate blocked)
- 2026-09-24T09:04:48.037Z **OK** · census pass (0/60 min, ratio 0.00, floor 6; edge 0 of 136 request(s) = 0.00 %)

## CALLs

| # | max_units | pid | started | wall s | status | mode | windows_run | windows_done after | stage_seconds | apply_seconds | error / cancel | data_sync_log id |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2 | 165967 | 2026-09-24 09:04:58.789798+00 | 247.6 | partial | full | [3,4] | [1,2,3,4] | [119.06,123.01] | [2.8,2.53] | unit cap reached — 2 unit(s) run, resumable | 22d56234-dddc-4fe1-b5f2-2f46710a3ab3 |
| 2 | 2 | 165967 | 2026-09-24 09:10:12.075441+00 | 270.6 | partial | full | [5,6] | [1,2,3,4,5,6] | [144.83,120.71] | [2.89,1.96] | unit cap reached — 2 unit(s) run, resumable | 4a554538-8d86-4ca7-bc8e-92e4f75c83ad |
| 3 | 2 | 165967 | 2026-09-24 09:16:16.93355+00 | 246.9 | partial | full | [7,8] | [1,2,3,4,5,6,7,8] | [118.26,117] | [2.58,8.84] | unit cap reached — 2 unit(s) run, resumable | 626e8d1b-08cc-461b-bc74-4c728f1989ab |
| 4 | 2 | 165967 | 2026-09-24 09:22:28.972328+00 | 255.9 | partial | full | [9,10] | [1,2,3,4,5,6,7,8,9,10] | [122.93,122.33] | [7.82,2.64] | unit cap reached — 2 unit(s) run, resumable | b516361d-bbb4-4892-bcf5-b7fc9f348855 |
| 5 | 2 | 165967 | 2026-09-24 09:28:20.064126+00 | 256.1 | partial | full | [11,12] | [1,2,3,4,5,6,7,8,9,10,11,12] | [117.45,126.77] | [5.52,3.11] | unit cap reached — 2 unit(s) run, resumable | 2bb9f584-61a7-4c9f-8374-c71c14ff0b78 |

## Watchdog walls per CALL (s)

- CALL 1: cron-job-budget-watchdog n=3 min 0.020 / median 0.796 / max 1.194 (elevated 1); derived-mvs-unit-watchdog n=3 min 0.006 / median 0.517 / max 1.015 (elevated 1)
- CALL 2: cron-job-budget-watchdog n=3 min 0.049 / median 1.224 / max 1.240 (elevated 2); derived-mvs-unit-watchdog n=3 min 0.022 / median 0.975 / max 1.099 (elevated 1)
- CALL 3: cron-job-budget-watchdog n=3 min 0.028 / median 0.548 / max 1.190 (elevated 1); derived-mvs-unit-watchdog n=3 min 0.010 / median 0.274 / max 0.839 (elevated 0)
- CALL 4: cron-job-budget-watchdog n=3 min 0.018 / median 1.129 / max 1.155 (elevated 2); derived-mvs-unit-watchdog n=3 min 0.007 / median 0.998 / max 1.035 (elevated 1)
- CALL 5: cron-job-budget-watchdog n=3 min 0.033 / median 0.186 / max 0.993 (elevated 0); derived-mvs-unit-watchdog n=3 min 0.025 / median 0.132 / max 0.744 (elevated 0)

## Breathers

| before CALL | started | released | waited s | released by | readings | walls at release | pending at release |
|---|---|---|---|---|---|---|---|
| 2 | 2026-09-24T09:09:07.382Z | 2026-09-24T09:10:08.162Z | 60.8 | walls | 3 | cron-job-budget-watchdog 0.049 (run 63147); derived-mvs-unit-watchdog 0.022 (run 63149) |  |
| 3 | 2026-09-24T09:14:43.301Z | 2026-09-24T09:16:14.058Z | 90.8 | walls | 4 | cron-job-budget-watchdog 0.028 (run 63160); derived-mvs-unit-watchdog 0.010 (run 63162) |  |
| 4 | 2026-09-24T09:20:24.387Z | 2026-09-24T09:22:25.303Z | 120.9 | walls | 5 | cron-job-budget-watchdog 0.018 (run 63172); derived-mvs-unit-watchdog 0.007 (run 63174) |  |
| 5 | 2026-09-24T09:26:45.518Z | 2026-09-24T09:28:16.416Z | 90.9 | walls | 4 | cron-job-budget-watchdog 0.033 (run 63184); derived-mvs-unit-watchdog 0.025 (run 63186) |  |
| 6 | 2026-09-24T09:32:36.807Z | 2026-09-24T09:34:07.636Z | 90.8 | walls | 4 | cron-job-budget-watchdog 0.031 (run 63198); derived-mvs-unit-watchdog 0.018 (run 63200) |  |

## Census

- 2026-09-24T09:04:53.734Z (60 min, gate poll) exit 0: pass (0/60 min, ratio 0.00, floor 6; edge 0 of 136 request(s) = 0.00 %)
- 2026-09-24T09:04:59.126Z (15 min, before CALL 1) exit 0: pass (0/15 min, ratio 0.00, floor 3; edge 0 of 136 request(s) = 0.00 %)
- 2026-09-24T09:10:12.401Z (15 min, before CALL 2) exit 0: pass (1/15 min, ratio 2.02, floor 3; edge 0 of 136 request(s) = 0.00 %)
- 2026-09-24T09:16:17.263Z (15 min, before CALL 3) exit 0: pass (1/15 min, ratio 2.02, floor 3; edge 1 of 279 request(s) = 0.36 %)
- 2026-09-24T09:22:29.301Z (15 min, before CALL 4) exit 0: pass (2/15 min, ratio 4.04, floor 3; edge 1 of 279 request(s) = 0.36 %)
- 2026-09-24T09:28:20.309Z (15 min, before CALL 5) exit 0: pass (2/15 min, ratio 4.04, floor 3; edge 1 of 279 request(s) = 0.36 %)
- 2026-09-24T09:34:11.098Z (15 min, before CALL 6) exit 1: FAIL (8/15 min, ratio 16.16, floor 3 — 57014 FAIL; edge 2 of 183 request(s) = 1.09 % — edge FAIL)

## Cursor at the end

```json
{
  "mode": "full",
  "target": "2026-09-21T00:18:25.831727+00:00",
  "started_at": "2026-09-23T09:02:48.434717+00:00",
  "windows_done": [
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    9,
    10,
    11,
    12
  ]
}
```
