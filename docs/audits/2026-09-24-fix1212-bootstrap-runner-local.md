# FIX-1212 bootstrap runner — caught_up (local)

Written by `packages/data/src/scripts/donor-party-bootstrap-runner.ts` in its `finally`. Machine copy: the `.json` beside this file.

| | |
|---|---|
| outcome | **caught_up** (exit 0) |
| vocabulary | caught_up 0 · error 1 · stopped 4 · skipped 5 · max_calls 6 · gate_timeout 7 · (3 retired: census_fail — the census is waited on inside the gate, cc-151) |
| detail | caught_up (complete) after 7 CALL(s) |
| launched / finished | 2026-09-24T00:53:38.796Z / 2026-09-24T00:59:43.620Z |
| pid | 22084 |
| args | `{"unitsPerCall":2,"wallTripS":3,"breatherUntilWallS":0.5,"breatherMaxS":20,"maxWaitMinutes":45,"pollSeconds":5,"maxCalls":12,"expectedMinutes":20,"tickSeconds":120,"tripOnWallMs":null,"tripFromCall":1,"receiptTag":null}` |
| gate | 1 poll(s): 0 held by the gate, 0 by the census (0 dark); opened 2026-09-24T00:53:38.851897+00:00 after 0.0 min · census at opening: skipped — local (no Logs API) |
| claim | 2026-09-24T00:53:39.077Z → released 2026-09-24T00:59:43.478Z |
| pacing | max_units 2 per CALL; prior value null; 7 upsert(s), 7 restore(s); restored to prior: true |
| resume | windows_done before [1,2] · resuming at window 3 · target 2026-09-03T01:34:43.542642+00:00 |
| before | watermark 2026-06-21 00:13:37.208343+00 · cursor present · MV 1859976 rows / SUM 693098760800 |
| after | watermark 2026-09-03 01:34:43.542642+00 · cursor absent · crawl row absent · MV 1859976 rows / SUM 693098760800 |
| SUM after / before | 1.000000 |
| caught_up check | cursor gone true · watermark 2026-09-03 01:34:43.542642+00 = target 2026-09-03T01:34:43.542642+00:00: true |
| elevated ticks | 0 reading(s) with a watchdog wall in [1, 3) s |
| trip | none |

## Gate polls (both halves — cc-151 D2)

- 2026-09-24T00:53:38.821Z **OK** · census skipped — local (no Logs API)

## CALLs

| # | max_units | pid | started | wall s | status | mode | windows_run | windows_done after | stage_seconds | apply_seconds | error / cancel | data_sync_log id |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2 | 6231 | 2026-09-24 00:53:39.173168+00 | 90.2 | partial | full | [3,4] | [1,2,3,4] | [64.75,23.39] | [1.14,0.79] | unit cap reached — 2 unit(s) run, resumable | 6221fe4c-e406-42e1-abf3-0fd4f5a7b15b |
| 2 | 2 | 6231 | 2026-09-24 00:55:29.408014+00 | 36.6 | partial | full | [5,6] | [1,2,3,4,5,6] | [12.55,21.61] | [0.9,1.48] | unit cap reached — 2 unit(s) run, resumable | d745a293-e604-412a-9587-53af25267fb1 |
| 3 | 2 | 6231 | 2026-09-24 00:56:26.143594+00 | 55.8 | partial | full | [7,8] | [1,2,3,4,5,6,7,8] | [32.39,18.84] | [1.89,2.24] | unit cap reached — 2 unit(s) run, resumable | de511c63-798b-403f-8352-c27bdad2c72c |
| 4 | 2 | 6231 | 2026-09-24 00:57:42.021997+00 | 12.4 | partial | full | [9,10] | [1,2,3,4,5,6,7,8,9,10] | [5.24,4.59] | [1.2,1.24] | unit cap reached — 2 unit(s) run, resumable | 67182586-8c6a-4a44-88b6-1a69075ba963 |
| 5 | 2 | 6231 | 2026-09-24 00:58:14.464021+00 | 11.8 | partial | full | [11,12] | [1,2,3,4,5,6,7,8,9,10,11,12] | [5.78,4.17] | [0.77,0.91] | unit cap reached — 2 unit(s) run, resumable | 2c203a35-15b2-4578-b141-48784bc88db2 |
| 6 | 2 | 6231 | 2026-09-24 00:58:46.268927+00 | 23.1 | partial | full | [13,14] | [1,2,3,4,5,6,7,8,9,10,11,12,13,14] | [4.28,14.68] | [2.02,1.62] | unit cap reached — 2 unit(s) run, resumable | 9b89c9bf-d22b-4096-b632-810afea45b6f |
| 7 | 2 | 6231 | 2026-09-24 00:59:29.464118+00 | 13.6 | complete | full | [15,16] | [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16] | [5.54,4.49] | [1.92,1.52] |  | 2cf22db9-da9c-43bb-8570-296478100fda |

## Watchdog walls per CALL (s)

- CALL 1: cron-job-budget-watchdog n=1 min 0.009 / median 0.009 / max 0.009 (elevated 0); derived-mvs-unit-watchdog n=1 min 0.007 / median 0.007 / max 0.007 (elevated 0)
- CALL 2: cron-job-budget-watchdog n=1 min 0.035 / median 0.035 / max 0.035 (elevated 0); derived-mvs-unit-watchdog n=1 min 0.027 / median 0.027 / max 0.027 (elevated 0)
- CALL 3: cron-job-budget-watchdog n=1 min 0.050 / median 0.050 / max 0.050 (elevated 0); derived-mvs-unit-watchdog n=1 min 0.042 / median 0.042 / max 0.042 (elevated 0)
- CALL 4: cron-job-budget-watchdog n=1 min 0.050 / median 0.050 / max 0.050 (elevated 0); derived-mvs-unit-watchdog n=1 min 0.042 / median 0.042 / max 0.042 (elevated 0)
- CALL 5: cron-job-budget-watchdog n=1 min 0.006 / median 0.006 / max 0.006 (elevated 0); derived-mvs-unit-watchdog n=1 min 0.006 / median 0.006 / max 0.006 (elevated 0)
- CALL 6: cron-job-budget-watchdog n=1 min 0.006 / median 0.006 / max 0.006 (elevated 0); derived-mvs-unit-watchdog n=1 min 0.006 / median 0.006 / max 0.006 (elevated 0)
- CALL 7: cron-job-budget-watchdog n=1 min 0.006 / median 0.006 / max 0.006 (elevated 0); derived-mvs-unit-watchdog n=1 min 0.006 / median 0.006 / max 0.006 (elevated 0)

## Breathers

| before CALL | started | released | waited s | released by | readings | walls at release | pending at release |
|---|---|---|---|---|---|---|---|
| 2 | 2026-09-24T00:55:09.372Z | 2026-09-24T00:55:29.407Z | 20.0 | breather_timeout | 2 | cron-job-budget-watchdog 0.035 (run 19109); derived-mvs-unit-watchdog 0.027 (run 19108) | cron-job-budget-watchdog: no run since the CALL returned; derived-mvs-unit-watchdog: no run since the CALL returned |
| 3 | 2026-09-24T00:56:06.059Z | 2026-09-24T00:56:26.118Z | 20.1 | breather_timeout | 2 | cron-job-budget-watchdog 0.050 (run 19111); derived-mvs-unit-watchdog 0.042 (run 19110) | cron-job-budget-watchdog: no run since the CALL returned; derived-mvs-unit-watchdog: no run since the CALL returned |
| 4 | 2026-09-24T00:57:21.982Z | 2026-09-24T00:57:42.020Z | 20.0 | breather_timeout | 2 | cron-job-budget-watchdog 0.050 (run 19111); derived-mvs-unit-watchdog 0.042 (run 19110) | cron-job-budget-watchdog: no run since the CALL returned; derived-mvs-unit-watchdog: no run since the CALL returned |
| 5 | 2026-09-24T00:57:54.452Z | 2026-09-24T00:58:14.480Z | 20.0 | walls | 2 | cron-job-budget-watchdog 0.006 (run 19113); derived-mvs-unit-watchdog 0.006 (run 19112) |  |
| 6 | 2026-09-24T00:58:26.259Z | 2026-09-24T00:58:46.282Z | 20.0 | breather_timeout | 2 | cron-job-budget-watchdog 0.006 (run 19113); derived-mvs-unit-watchdog 0.006 (run 19112) | cron-job-budget-watchdog: no run since the CALL returned; derived-mvs-unit-watchdog: no run since the CALL returned |
| 7 | 2026-09-24T00:59:09.433Z | 2026-09-24T00:59:29.463Z | 20.0 | breather_timeout | 2 | cron-job-budget-watchdog 0.006 (run 19113); derived-mvs-unit-watchdog 0.006 (run 19112) | cron-job-budget-watchdog: no run since the CALL returned; derived-mvs-unit-watchdog: no run since the CALL returned |

## Census

- (none)

## Cursor at the end

```json
null
```
