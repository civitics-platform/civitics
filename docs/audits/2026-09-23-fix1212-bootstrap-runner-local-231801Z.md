# FIX-1212 bootstrap runner — caught_up (local)

Written by `packages/data/src/scripts/donor-party-bootstrap-runner.ts` in its `finally`. Machine copy: the `.json` beside this file.

| | |
|---|---|
| outcome | **caught_up** (exit 0) |
| detail | caught_up (complete) after 7 CALL(s) |
| launched / finished | 2026-09-23T23:18:01.035Z / 2026-09-23T23:45:55.308Z |
| pid | 16364 |
| args | `{"unitsPerCall":2,"wallTripS":3,"breatherUntilWallS":0.5,"breatherMaxS":20,"maxWaitMinutes":45,"pollSeconds":5,"maxCalls":12,"expectedMinutes":60,"tickSeconds":120,"tripOnWallMs":null,"tripFromCall":1,"receiptTag":null}` |
| gate | 265 poll(s); opened 2026-09-23T23:40:03.034271+00:00 after 22.0 min |
| claim | 2026-09-23T23:40:03.250Z → released 2026-09-23T23:45:55.106Z |
| pacing | max_units 2 per CALL; prior value null; 7 upsert(s), 7 restore(s); restored to prior: true |
| resume | windows_done before [1,2] · resuming at window 3 · target 2026-09-03T01:34:43.542642+00:00 |
| before | watermark 2026-06-21 00:13:37.208343+00 · cursor present · MV 1859976 rows / SUM 693098760800 |
| after | watermark 2026-09-03 01:34:43.542642+00 · cursor absent · crawl row absent · MV 1859976 rows / SUM 693098760800 |
| SUM after / before | 1.000000 |
| caught_up check | cursor gone true · watermark 2026-09-03 01:34:43.542642+00 = target 2026-09-03T01:34:43.542642+00:00: true |
| elevated ticks | 0 reading(s) with a watchdog wall in [1, 3) s |
| trip | none |

## Gate polls

- 2026-09-23T23:18:01.065Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:18:06.070Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:18:11.076Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:18:16.076Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:18:21.078Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:18:26.090Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:18:31.091Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:18:36.100Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:18:41.113Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:18:46.115Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:18:51.120Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:18:56.121Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:19:01.130Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:19:06.143Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:19:11.149Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:19:16.164Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:19:21.178Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:19:26.182Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:19:31.183Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:19:36.198Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:19:41.201Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:19:46.212Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:19:51.226Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:19:56.226Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:20:01.231Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:20:06.234Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:20:11.246Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:20:16.254Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:20:21.255Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:20:26.265Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:20:31.269Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:20:36.278Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:20:41.284Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:20:46.287Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:20:51.296Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:20:56.307Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:21:01.310Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:21:06.311Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:21:11.311Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:21:16.321Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:21:21.322Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:21:26.325Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:21:31.337Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:21:36.348Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:21:41.358Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:21:46.367Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:21:51.377Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:21:56.389Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:22:01.395Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:22:06.407Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:22:11.411Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:22:16.418Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:22:21.425Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:22:26.430Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:22:31.432Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:22:36.445Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:22:41.455Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:22:46.465Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:22:51.465Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:22:56.474Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:23:01.485Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:23:06.496Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:23:11.505Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:23:16.510Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:23:21.511Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:23:26.511Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:23:31.525Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:23:36.529Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:23:41.535Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:23:46.546Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:23:51.558Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:23:56.558Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:24:01.559Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:24:06.573Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:24:11.578Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:24:16.591Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:24:21.602Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:24:26.614Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:24:31.624Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:24:36.628Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:24:41.638Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:24:46.641Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:24:51.645Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:24:56.650Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:25:01.656Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:25:06.672Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:25:11.677Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:25:16.690Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:25:21.697Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:25:26.702Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:25:31.704Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:25:36.718Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:25:41.718Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:25:46.729Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:25:51.740Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:25:56.740Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:26:01.749Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:26:06.753Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:26:11.761Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:26:16.774Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:26:21.782Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:26:26.794Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:26:31.798Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:26:36.810Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:26:41.820Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:26:46.825Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:26:51.833Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:26:56.839Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:27:01.854Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:27:06.861Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:27:11.869Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:27:16.880Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:27:21.883Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:27:26.894Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:27:31.897Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:27:36.906Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:27:41.918Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:27:46.922Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:27:51.935Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:27:56.937Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:28:01.940Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:28:06.952Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:28:11.956Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:28:16.961Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:28:21.969Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:28:26.976Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:28:31.980Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:28:36.990Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:28:41.994Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:28:47.002Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:28:52.003Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:28:57.015Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:29:02.023Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:29:07.035Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:29:12.038Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:29:17.049Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:29:22.059Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:29:27.064Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:29:32.075Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:29:37.086Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:29:42.092Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:29:47.103Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:29:52.113Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:29:57.119Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:30:02.122Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:30:07.133Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:30:12.138Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:30:17.143Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:30:22.156Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:30:27.165Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:30:32.172Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:30:37.183Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:30:42.184Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:30:47.185Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:30:52.188Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:30:57.196Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:31:02.204Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:31:07.219Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:31:12.230Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:31:17.241Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:31:22.246Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:31:27.251Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:31:32.262Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:31:37.268Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:31:42.276Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:31:47.287Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:31:52.297Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:31:57.299Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:32:02.311Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:32:07.316Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:32:12.328Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:32:17.340Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:32:22.355Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:32:27.363Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:32:32.378Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:32:37.384Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:32:42.389Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:32:47.396Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:32:52.397Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:32:57.411Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:33:02.414Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:33:07.427Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:33:12.429Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:33:17.440Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:33:22.454Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:33:27.454Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:33:32.463Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:33:37.469Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:33:42.469Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:33:47.481Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:33:52.493Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:33:57.504Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:34:02.517Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:34:07.520Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:34:12.526Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:34:17.534Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:34:22.534Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:34:27.535Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:34:32.539Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:34:37.546Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:34:42.551Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:34:47.554Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:34:52.558Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:34:57.568Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:35:02.572Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:35:07.574Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:35:12.586Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:35:17.599Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:35:22.605Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:35:27.609Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:35:32.617Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:35:37.630Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:35:42.632Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:35:47.638Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:35:52.653Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:35:57.667Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:36:02.669Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:36:07.676Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:36:12.682Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:36:17.695Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:36:22.709Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:36:27.714Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:36:32.720Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:36:37.728Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:36:42.740Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:36:47.748Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:36:52.758Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:36:57.768Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:37:02.777Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:37:07.788Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:37:12.795Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:37:17.800Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:37:22.804Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:37:27.815Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:37:32.819Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:37:37.820Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:37:42.827Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:37:47.834Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:37:52.842Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:37:57.846Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:38:02.860Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:38:07.868Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:38:12.874Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:38:17.883Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:38:22.895Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:38:27.905Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:38:32.906Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:38:37.919Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:38:42.922Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:38:47.934Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:38:52.935Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:38:57.940Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:39:02.945Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:39:07.958Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:39:12.968Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:39:17.975Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:39:22.976Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:39:27.980Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:39:32.990Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:39:37.993Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:39:42.997Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:39:48.010Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:39:53.018Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:39:58.019Z blocked: d:cron-job-budget-watchdog, d:derived-mvs-unit-watchdog
- 2026-09-23T23:40:03.022Z **OK**

## CALLs

| # | max_units | pid | started | wall s | status | mode | windows_run | windows_done after | stage_seconds | apply_seconds | error / cancel | data_sync_log id |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2 | 2924 | 2026-09-23 23:40:03.790321+00 | 70.5 | partial | full | [3,4] | [1,2,3,4] | [43.74,24.53] | [1.27,0.84] | unit cap reached — 2 unit(s) run, resumable | eeeea225-4a03-4836-86df-ecd1ec647092 |
| 2 | 2 | 2924 | 2026-09-23 23:41:34.381306+00 | 22.4 | partial | full | [5,6] | [1,2,3,4,5,6] | [11.3,9.31] | [0.8,0.89] | unit cap reached — 2 unit(s) run, resumable | 13440048-a69a-4a92-927e-71a5807e1e35 |
| 3 | 2 | 2924 | 2026-09-23 23:42:16.840017+00 | 13.4 | partial | full | [7,8] | [1,2,3,4,5,6,7,8] | [5.81,5.51] | [0.85,1.09] | unit cap reached — 2 unit(s) run, resumable | 08e17a6e-5668-494e-82fd-05af54e15dcb |
| 4 | 2 | 2924 | 2026-09-23 23:42:50.260105+00 | 10.7 | partial | full | [9,10] | [1,2,3,4,5,6,7,8,9,10] | [4.98,4.01] | [0.83,0.75] | unit cap reached — 2 unit(s) run, resumable | b89afa4d-21a8-485b-9fff-642af392c11d |
| 5 | 2 | 2924 | 2026-09-23 23:43:20.97949+00 | 10.7 | partial | full | [11,12] | [1,2,3,4,5,6,7,8,9,10,11,12] | [4.39,4.3] | [0.92,1.02] | unit cap reached — 2 unit(s) run, resumable | 1e21c0b2-e47f-475e-a898-fdbeb22e936b |
| 6 | 2 | 2924 | 2026-09-23 23:43:51.746403+00 | 58.7 | partial | full | [13,14] | [1,2,3,4,5,6,7,8,9,10,11,12,13,14] | [11.83,40.86] | [3.24,2.65] | unit cap reached — 2 unit(s) run, resumable | 6c8450e5-970b-4d37-b44b-5d41c4e0d289 |
| 7 | 2 | 2924 | 2026-09-23 23:45:10.529681+00 | 44.4 | complete | full | [15,16] | [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16] | [20.36,17.99] | [2.36,2.29] |  | eab2d5f2-17d3-498d-9ed9-afe85e149169 |

## Watchdog walls per CALL (s)

- CALL 1: cron-job-budget-watchdog n=1 min 0.006 / median 0.006 / max 0.006 (elevated 0); derived-mvs-unit-watchdog n=1 min 0.006 / median 0.006 / max 0.006 (elevated 0)
- CALL 2: cron-job-budget-watchdog n=1 min 0.006 / median 0.006 / max 0.006 (elevated 0); derived-mvs-unit-watchdog n=1 min 0.006 / median 0.006 / max 0.006 (elevated 0)
- CALL 3: cron-job-budget-watchdog n=1 min 0.026 / median 0.026 / max 0.026 (elevated 0); derived-mvs-unit-watchdog n=1 min 0.023 / median 0.023 / max 0.023 (elevated 0)
- CALL 4: cron-job-budget-watchdog n=1 min 0.026 / median 0.026 / max 0.026 (elevated 0); derived-mvs-unit-watchdog n=1 min 0.023 / median 0.023 / max 0.023 (elevated 0)
- CALL 5: cron-job-budget-watchdog n=1 min 0.026 / median 0.026 / max 0.026 (elevated 0); derived-mvs-unit-watchdog n=1 min 0.023 / median 0.023 / max 0.023 (elevated 0)
- CALL 6: cron-job-budget-watchdog n=1 min 0.026 / median 0.026 / max 0.026 (elevated 0); derived-mvs-unit-watchdog n=1 min 0.023 / median 0.023 / max 0.023 (elevated 0)
- CALL 7: cron-job-budget-watchdog n=1 min 0.022 / median 0.022 / max 0.022 (elevated 0); derived-mvs-unit-watchdog n=1 min 0.038 / median 0.038 / max 0.038 (elevated 0)

## Breathers

| before CALL | started | released | waited s | released by | readings | walls at release | pending at release |
|---|---|---|---|---|---|---|---|
| 2 | 2026-09-23T23:41:14.353Z | 2026-09-23T23:41:34.380Z | 20.0 | breather_timeout | 2 | cron-job-budget-watchdog 0.006 (run 19035); derived-mvs-unit-watchdog 0.006 (run 19034) | cron-job-budget-watchdog: no run since the CALL returned; derived-mvs-unit-watchdog: no run since the CALL returned |
| 3 | 2026-09-23T23:41:56.806Z | 2026-09-23T23:42:16.838Z | 20.0 | walls | 2 | cron-job-budget-watchdog 0.026 (run 19037); derived-mvs-unit-watchdog 0.023 (run 19036) |  |
| 4 | 2026-09-23T23:42:30.225Z | 2026-09-23T23:42:50.259Z | 20.0 | breather_timeout | 2 | cron-job-budget-watchdog 0.026 (run 19037); derived-mvs-unit-watchdog 0.023 (run 19036) | cron-job-budget-watchdog: no run since the CALL returned; derived-mvs-unit-watchdog: no run since the CALL returned |
| 5 | 2026-09-23T23:43:00.945Z | 2026-09-23T23:43:20.979Z | 20.0 | breather_timeout | 2 | cron-job-budget-watchdog 0.026 (run 19037); derived-mvs-unit-watchdog 0.023 (run 19036) | cron-job-budget-watchdog: no run since the CALL returned; derived-mvs-unit-watchdog: no run since the CALL returned |
| 6 | 2026-09-23T23:43:31.733Z | 2026-09-23T23:43:51.763Z | 20.0 | breather_timeout | 2 | cron-job-budget-watchdog 0.026 (run 19037); derived-mvs-unit-watchdog 0.023 (run 19036) | cron-job-budget-watchdog: no run since the CALL returned; derived-mvs-unit-watchdog: no run since the CALL returned |
| 7 | 2026-09-23T23:44:50.493Z | 2026-09-23T23:45:10.528Z | 20.0 | breather_timeout | 2 | cron-job-budget-watchdog 0.022 (run 19039); derived-mvs-unit-watchdog 0.038 (run 19038) | cron-job-budget-watchdog: no run since the CALL returned; derived-mvs-unit-watchdog: no run since the CALL returned |

## Census

- (none)

## Cursor at the end

```json
null
```
