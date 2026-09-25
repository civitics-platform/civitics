# FIX-1212 bootstrap runner — caught_up (local)

Written by `packages/data/src/scripts/donor-party-bootstrap-runner.ts` in its `finally`. Machine copy: the `.json` beside this file.

| | |
|---|---|
| outcome | **caught_up** (exit 0) |
| vocabulary | caught_up 0 · error 1 · stopped 4 · skipped 5 · max_calls 6 · gate_timeout 7 · (3 retired: census_fail — the census is waited on inside the gate, cc-151) |
| detail | caught_up (complete) after 2 CALL(s) |
| launched / finished | 2026-09-24T23:51:48.581Z / 2026-09-25T00:17:00.210Z |
| pid | 15148 |
| args | `{"unitsPerCall":2,"wallTripS":3,"breatherUntilWallS":0.5,"breatherMaxS":20,"maxWaitMinutes":45,"pollSeconds":30,"maxCalls":12,"expectedMinutes":20,"tickSeconds":120,"tripOnWallMs":null,"tripFromCall":1,"receiptTag":null,"censusMode":"report"}` |
| census mode | report — rule (3) pass=false is recorded, not a stop (0 of 0 rule (3) reading(s) would have tripped); the dark-twice trip stays armed; the gate wait's census half still holds the window |
| gate | 46 poll(s): 45 held by the gate, 0 by the census (0 dark); opened 2026-09-25T00:14:18.930691+00:00 after 22.5 min · census at opening: skipped — local (no Logs API) |
| claim | 2026-09-25T00:14:19.226Z → released 2026-09-25T00:16:59.970Z |
| pacing | max_units 2 per CALL; prior value null; 2 upsert(s), 2 restore(s); restored to prior: true |
| resume | windows_done before [1,2,3,4,5,6,7,8,9,10,11,12] · resuming at window 13 · target 2026-09-03T01:34:43.542642+00:00 |
| before | watermark 2026-06-21 00:13:37.208343+00 · cursor present · MV 1859976 rows / SUM 693098760800 |
| after | watermark 2026-09-03 01:34:43.542642+00 · cursor absent · crawl row absent · MV 1859976 rows / SUM 693098760800 |
| SUM after / before | 1.000000 |
| caught_up check | cursor gone true · watermark 2026-09-03 01:34:43.542642+00 = target 2026-09-03T01:34:43.542642+00:00: true |
| elevated ticks | 0 reading(s) with a watchdog wall in [1, 3) s |
| trip | none |

## Gate polls (both halves — cc-151 D2)

- 2026-09-24T23:51:48.606Z held by the gate: a:nightly_due, d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-24T23:52:18.621Z held by the gate: a:nightly_due, d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-24T23:52:48.626Z held by the gate: a:nightly_due, d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-24T23:53:18.638Z held by the gate: a:nightly_due, d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-24T23:53:48.645Z held by the gate: a:nightly_due, d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-24T23:54:18.647Z held by the gate: a:nightly_due, d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-24T23:54:48.647Z held by the gate: a:nightly_due, d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-24T23:55:18.660Z held by the gate: a:nightly_due, d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-24T23:55:48.662Z held by the gate: a:nightly_due, d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-24T23:56:18.669Z held by the gate: a:nightly_due, d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-24T23:56:48.674Z held by the gate: a:nightly_due, d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-24T23:57:18.685Z held by the gate: a:nightly_due, d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-24T23:57:48.690Z held by the gate: a:nightly_due, d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-24T23:58:18.701Z held by the gate: a:nightly_due, d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-24T23:58:48.703Z held by the gate: a:nightly_due, d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-24T23:59:18.709Z held by the gate: a:nightly_due, d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-24T23:59:48.715Z held by the gate: a:nightly_due, d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-25T00:00:18.719Z held by the gate: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-25T00:00:48.719Z held by the gate: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-25T00:01:18.732Z held by the gate: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-25T00:01:48.739Z held by the gate: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-25T00:02:18.751Z held by the gate: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-25T00:02:48.753Z held by the gate: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-25T00:03:18.760Z held by the gate: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-25T00:03:48.762Z held by the gate: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-25T00:04:18.772Z held by the gate: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-25T00:04:48.776Z held by the gate: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-25T00:05:18.781Z held by the gate: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-25T00:05:48.786Z held by the gate: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-25T00:06:18.801Z held by the gate: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-25T00:06:48.803Z held by the gate: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-25T00:07:18.814Z held by the gate: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-25T00:07:48.822Z held by the gate: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-25T00:08:18.828Z held by the gate: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-25T00:08:48.837Z held by the gate: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-25T00:09:18.843Z held by the gate: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-25T00:09:48.848Z held by the gate: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-25T00:10:18.862Z held by the gate: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-25T00:10:48.869Z held by the gate: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-25T00:11:18.878Z held by the gate: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-25T00:11:48.880Z held by the gate: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-25T00:12:18.886Z held by the gate: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-25T00:12:48.893Z held by the gate: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-25T00:13:18.894Z held by the gate: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-25T00:13:48.907Z held by the gate: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog · census not read (gate blocked)
- 2026-09-25T00:14:18.916Z **OK** · census skipped — local (no Logs API)

## CALLs

| # | max_units | pid | started | wall s | status | mode | windows_run | windows_done after | stage_seconds | apply_seconds | error / cancel | data_sync_log id |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2 | 2752 | 2026-09-25 00:14:19.332823+00 | 96.8 | partial | full | [13,14] | [1,2,3,4,5,6,7,8,9,10,11,12,13,14] | [54.86,39.5] | [1.38,0.98] | unit cap reached — 2 unit(s) run, resumable | 53978ec2-d33f-4e11-960e-246cc9cb9b88 |
| 2 | 2 | 2752 | 2026-09-25 00:16:16.19505+00 | 43.0 | complete | full | [15,16] | [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16] | [27.8,12.86] | [0.89,1.19] |  | 7d44719d-138d-44f3-a16e-7c3bf2bb41ad |

## Watchdog walls per CALL (s)

- CALL 1: cron-job-budget-watchdog n=1 min 0.006 / median 0.006 / max 0.006 (elevated 0); derived-mvs-unit-watchdog n=1 min 0.010 / median 0.010 / max 0.010 (elevated 0)
- CALL 2: cron-job-budget-watchdog n=1 min 0.015 / median 0.015 / max 0.015 (elevated 0); derived-mvs-unit-watchdog n=1 min 0.007 / median 0.007 / max 0.007 (elevated 0)

## Breathers

| before CALL | started | released | waited s | released by | readings | walls at release | pending at release |
|---|---|---|---|---|---|---|---|
| 2 | 2026-09-25T00:15:56.155Z | 2026-09-25T00:16:16.194Z | 20.0 | walls | 2 | cron-job-budget-watchdog 0.015 (run 20703); derived-mvs-unit-watchdog 0.007 (run 20701) |  |

## Census

- (none)

## Cursor at the end

```json
null
```
