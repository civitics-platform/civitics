# FIX-1212 bootstrap runner — caught_up (prod)

Written by `packages/data/src/scripts/donor-party-bootstrap-runner.ts` in its `finally`. Machine copy: the `.json` beside this file.

| | |
|---|---|
| outcome | **caught_up** (exit 0) |
| vocabulary | caught_up 0 · error 1 · stopped 4 · skipped 5 · max_calls 6 · gate_timeout 7 · (3 retired: census_fail — the census is waited on inside the gate, cc-151) |
| detail | caught_up (complete) after 2 CALL(s) |
| launched / finished | 2026-09-25T00:45:27.077Z / 2026-09-25T00:54:10.928Z |
| pid | 7828 |
| args | `{"unitsPerCall":2,"wallTripS":3,"breatherUntilWallS":0.5,"breatherMaxS":600,"maxWaitMinutes":720,"pollSeconds":300,"maxCalls":3,"expectedMinutes":20,"tickSeconds":120,"tripOnWallMs":null,"tripFromCall":1,"receiptTag":null,"censusMode":"report"}` |
| census mode | report — rule (3) pass=false is recorded, not a stop (0 of 0 rule (3) reading(s) would have tripped); the dark-twice trip stays armed; the gate wait's census half still holds the window · 3 census call(s) unavailable (exit 8, FIX-1219) — not readings, never a trip |
| gate | 1 poll(s): 0 held by the gate, 0 by the census (0 dark); 1 read the census unavailable (FIX-1219) and opened on the gate alone; opened 2026-09-25T00:45:26.341537+00:00 after 0.0 min · census at opening: unavailable (FIX-1219 — Logs API endpoint removed, HTTP 410) |
| claim | 2026-09-25T00:45:29.582Z → released 2026-09-25T00:54:09.176Z |
| pacing | max_units 2 per CALL; prior value null; 2 upsert(s), 2 restore(s); restored to prior: true |
| resume | windows_done before [1,2,3,4,5,6,7,8,9,10,11,12] · resuming at window 13 · target 2026-09-21T00:18:25.831727+00:00 |
| before | watermark 2026-07-28 05:54:28.48494+00 · cursor present · MV 2618055 rows / SUM 867716229900 |
| after | watermark 2026-09-21 00:18:25.831727+00 · cursor absent · crawl row absent · MV 2972870 rows / SUM 921676324700 |
| SUM after / before | 1.062186 |
| caught_up check | cursor gone true · watermark 2026-09-21 00:18:25.831727+00 = target 2026-09-21T00:18:25.831727+00:00: true |
| elevated ticks | 2 reading(s) with a watchdog wall in [1, 3) s |
| trip | none |

## Gate polls (both halves — cc-151 D2)

- 2026-09-25T00:45:27.266Z **OK** · census unavailable (FIX-1219 — Logs API endpoint removed, HTTP 410)

## CALLs

| # | max_units | pid | started | wall s | status | mode | windows_run | windows_done after | stage_seconds | apply_seconds | error / cancel | data_sync_log id |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2 | 243007 | 2026-09-25 00:45:31.171798+00 | 244.5 | partial | full | [13,14] | [1,2,3,4,5,6,7,8,9,10,11,12,13,14] | [124.06,113.12] | [3.18,3.82] | unit cap reached — 2 unit(s) run, resumable | a6e947dc-75fa-4a79-99d4-d1ae4e3d1e31 |
| 2 | 2 | 243007 | 2026-09-25 00:50:07.885078+00 | 239.3 | complete | full | [15,16] | [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16] | [115.28,117.99] | [2.84,3.01] |  | 337b8512-8aad-431b-9e38-c535af031f59 |

## Watchdog walls per CALL (s)

- CALL 1: cron-job-budget-watchdog n=3 min 0.027 / median 0.979 / max 1.365 (elevated 1); derived-mvs-unit-watchdog n=3 min 0.005 / median 0.658 / max 0.826 (elevated 0)
- CALL 2: cron-job-budget-watchdog n=2 min 0.063 / median 0.714 / max 1.365 (elevated 1); derived-mvs-unit-watchdog n=2 min 0.044 / median 0.535 / max 1.027 (elevated 1)

## Breathers

| before CALL | started | released | waited s | released by | readings | walls at release | pending at release |
|---|---|---|---|---|---|---|---|
| 2 | 2026-09-25T00:49:37.286Z | 2026-09-25T00:50:07.664Z | 30.4 | walls | 2 | cron-job-budget-watchdog 0.063 (run 65137); derived-mvs-unit-watchdog 0.044 (run 65139) |  |

## Census

- 2026-09-25T00:45:28.787Z (60 min, gate poll) exit 8: unavailable (FIX-1219 — Logs API endpoint removed, HTTP 410)
- 2026-09-25T00:45:32.225Z (15 min, before CALL 1) exit 8: unavailable (FIX-1219 — Logs API endpoint removed, HTTP 410)
- 2026-09-25T00:50:08.951Z (15 min, before CALL 2) exit 8: unavailable (FIX-1219 — Logs API endpoint removed, HTTP 410)

## Cursor at the end

```json
null
```
