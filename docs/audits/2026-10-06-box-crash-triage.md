# 2026-10-06 box outage — read-only triage (cc-204)

Read 2026-10-07 01:06Z → 01:18Z by cc-204, prod-reads posture (no CALL, no
VACUUM, no reap, no cron change, no write of any kind to Pro). Every figure
names its instrument, its database, and the time it was read. "Prod" is the
Supabase Pro project `xsazcoxinpgttgquwvuf`. The banked ring is
`docs/audits/2026-10-06-box-crash-ring.json` (457 samples, read 01:06:55Z).

---

## §1 Verdict

1. **Shape: forker starved, then ingress dark. Postgres was never dead.** From
   16:04Z the box ran out of memory: ring 16:04:22Z MemAvailable **141 MB of
   904**, swap **1024 of 1024 MB used (0 MB free)**, swap-in **1,379/s**. pg_cron
   then failed 100 % `job startup timeout` (17:00–20:59Z, 24 of 24 firings) — the
   09-22 fingerprint. Postgres recovered *internally* after the job below ended
   (first succeeded probe 21:27:00Z, clean 15/15 per quarter-hour from 22:30Z).
   The front door did **not** recover: `edge_logs` read **98–100 % 52x every
   30 min from 16:30Z to 00:30Z**, and at 00:24:33Z the pooler still could not
   connect (`Failed to connect to database: {:error, :timeout}`). Only the manual
   restart cleared it. *(ring, Upstash, 01:06:55Z; `cron.job_run_details`,
   prod, 01:09Z; `edge_logs`, Logs API, 01:17:05Z; GHA run 37551030602 log,
   read 01:12Z)*
2. **Restart class: clean — the box was wedged, not crashed.**
   `pg_stat_statements_info.stats_reset` = 2026-09-22 22:32:13Z, which is earlier
   than `pg_postmaster_start_time()` = 2026-10-07 00:48:31.210Z, so pgss
   survived the stop. `postgres_logs` has `received fast shutdown request` at
   00:46:35.973Z and no crash-recovery line (`was not properly shut down`,
   `redo starts at`, `terminated by signal`, `out of memory`: zero rows,
   15:34Z → 01:03Z). The kernel counters reset across the restart (`pswpin`
   126,719,189 at 16:04:22Z → 80,245 at 00:50:22Z), so the restart rebooted the
   VM, after Postgres had shut down cleanly. *(R2 query, prod, 01:07:48Z;
   `postgres_logs`, Logs API, 01:13:55Z; ring raw samples, Upstash, 01:10:51Z)*
3. **Job in flight at the gap: `rule-taggers-weekly`, and nothing else.**
   jobid 12, runid 100671, `CALL public.run_rule_taggers('weekly');`, start
   **16:00:00.146Z**, end 21:17:24.036Z, wall **5:17:23.9**, status `succeeded`.
   This was the **first merge-mode firing under FIX-1248**. The three completed
   firings before it (09-08, 09-15, 09-29) took 1:18–1:24 in the rewrite form,
   and 09-22 failed to start. By `auto_explain`, the merge's
   `_scan`, pre-count and `_delete` finished by 16:02:48.014Z, so the
   `_insert`'s hash anti-join was running when the ring hit 0 MB of free swap at
   16:04:22Z. Its sync row closed `partial` at 21:03:37.914Z,
   `canceled — size_tags: canceling statement due to statement timeout`,
   `elapsed_seconds 18218`, `desired_rows 4426852`, `deleted_rows 623`,
   `tags_written 0`, so the whole merge rolled back. *(`cron.job_run_details`,
   prod, 01:09Z; `data_sync_log` id 3b30e9ff…, prod, 01:09Z; `postgres_logs`,
   Logs API, 01:17:16Z)*

The owner is `SET work_mem = '256MB'` in `run_rule_taggers`. That is also the
`postgres` role default (`pg_db_role_setting`: `statement_timeout=3h,work_mem=256MB`),
and `hash_mem_multiplier = 2`, so one hash node may take 512 MB on a 904 MB box
with 256 MB of `shared_buffers`. The migration header
(`20261001010000_fix1248_weekly_size_tags_merge.sql`, section 3) predicted the
INSERT's hash at "~560 MB, over the 512 MB hash_mem" and expected "Batches: 2
… not a GB". It also projected a prod wall of "~65 s" for a small delta. The
measured wall was 18,218 s, and the merge was cancelled.

---

## §2 Timeline (UTC, 10-06 → 10-07)

R = read by cc-204 (instrument, DB, read time in the row). C = Craig's report.

| instant | what | src |
|---|---|---|
| 15:00:00.153 | `donor-party-rollup-refresh` (jobid 17) starts; ends 15:01:18.939, `complete`, 2,218 rows | R `cron.job_run_details` + `data_sync_log`, prod, 01:09Z |
| 15:02:22 | ring: swap-in 1,177.9/s, MemAvailable 304 MB (the :02 signature, scaled by jobid 17) | R ring, Upstash, 01:06:55Z |
| 15:58:22 | ring: MemAvailable 477 MB, swap used 825 MB, swap-in 5.5/s (calm) | R ring |
| 16:00:00.002 | `cron job 12 starting: CALL public.run_rule_taggers('weekly');` | R `postgres_logs`, Logs API, 01:17:16Z |
| 16:00:40.139 | signature count, 39.9 s | R `postgres_logs` (auto_explain) |
| 16:01:39.763 | `CREATE TEMP TABLE fes_desired …` (`_scan`), 59.6 s | R `postgres_logs` |
| 16:02:14.044 | pre-count `SELECT count(*) … LEFT JOIN`, 21.6 s | R `postgres_logs` |
| 16:02:22 | ring: MemAvailable 234 MB, swap 1005/1024 used (19 MB free), swap-in 901.9/s, swap-out 1,283.9/s, load1 1.74, scrape 2,062 ms | R ring |
| 16:02:48.014 | `DELETE FROM public.entity_tags …` (`_delete`), 30.3 s — the `_insert` starts after this | R `postgres_logs` |
| 16:03:17.063 | `SELECT public.record_box_health()` took 15.3 s | R `postgres_logs` |
| 16:04:00.447 | last `succeeded` `box-health-probe` before the gap (both `*/2` watchdogs 16:04:00.446 / .448) | R `cron.job_run_details`, prod, 01:08Z |
| 16:04:05.492 | last `postgres_logs` row before an 8 h 42 min silence | R `postgres_logs` |
| **16:04:22** | **last ring sample: MemAvailable 141 MB (15.6 %), swap 1024/1024 used, swap-in 1,379.2/s, swap-out 1,401.4/s, load1 2.95, scrape 7,719 ms, `oom_kill` 0** | R ring + raw samples, Upstash, 01:10:51Z |
| 16:06:22 → 00:48:22 | no ring sample: the metrics scrape failed, and a failed scrape writes nothing (`packages/db/src/box-health-store.ts:198-203`) | R ring |
| 16:00–16:29 bucket | `edge_logs` 221 requests, 75 5xx, 74 52x | R `edge_logs`, Logs API, 01:17:05Z |
| 16:30 → 00:29 | `edge_logs` 98–100 % 52x in every 30-min bucket | R `edge_logs` |
| 17:00–20:59 | pg_cron: 0 succeeded, 24 failed, all `job startup timeout`; some verdicts landed up to 2 h 08 min after firing (odr-mv-vacuum-analyze 17:22:22 → 19:31:04) | R `cron.job_run_details`, prod, 01:10Z |
| ~19:00:00 | the `postgres` role's 3 h `statement_timeout` was due to cancel the CALL. **Not observed**: the cancel landed 2 h 03 min later | inferred from R role setting + R sync row |
| 21:00:12 | Vercel dispatcher creates nightly run 37530682016 (`workflow_dispatch`); `pipeline_state.gha_dispatch_nightly` NOT stamped (last stamp 10-05 21:00:13) | R `gh run list`, 01:11Z; R `pipeline_state`, prod, 01:10Z |
| 21:00:58.433 | preflight: `could not read data_sync_log (<!DOCTYPE html> … 522: Connection timed out …) — FAIL OPEN: already_ran=false` | R GHA log |
| 21:03:37.914 | size_tags cancelled, `canceling statement due to statement timeout`; sync row `partial`, `elapsed_seconds 18218` | R `data_sync_log`, prod, 01:09Z |
| 21:09:06 | run 37530682016 ends; all five jobs `failure` | R `gh run view`, 01:11Z |
| 21:17:24.036 | `rule-taggers-weekly` pg_cron row ends `succeeded` (wall 5:17:23.9) | R `cron.job_run_details` |
| 21:27:00.126 | first `succeeded` probe after the gap (watchdogs 21:27:00.107 / .121) — 5 h 22 min 59 s gap | R `cron.job_run_details` |
| 21:30–22:29 | catch-up: probe 46 ok in the 21:30 quarter; hour 21 = 75 ok / 59 failed, hour 22 = 117 / 9 | R `cron.job_run_details` |
| 22:30 → 00:45 | pg_cron 100 % succeeded (probe 15/15 per quarter-hour) — **while the front door stayed 52x** | R `cron.job_run_details` + `edge_logs` |
| 00:15:46 | `schedule:` fallback run 37551030602 | R `gh run list` |
| 00:16:33.529 | preflight 522, `FAIL OPEN: already_ran=false` | R GHA log |
| 00:17:40.084 | fec-phase: Cloudflare 522, "could not establish a TCP connection to the origin server. The TCP handshake timed out" | R GHA log |
| 00:24:33.392 | receipts: `[receipts] FAILED: error: Failed to connect to database: {:error, :timeout}` (pooler `aws-0-us-west-2.pooler.supabase.com:5432`) | R GHA log |
| 00:24:37 | run 37551030602 ends; all five jobs `failure` | R `gh run view` |
| 00:30–00:45 | Craig restarts the project by hand | **C** |
| 00:46:35.458 | `archive command failed with exit code 1` (`pg_stat_archiver.last_failed_time`, same instant) — the first `postgres_logs` row after the silence | R `postgres_logs`; R `pg_stat_archiver`, prod, 01:18:18Z |
| 00:46:35.973 | `received fast shutdown request` → 00:46:35.993 `aborting any active transactions` → 00:46:36.000 `pg_cron scheduler shutting down` → 2 × `57P01 terminating connection due to administrator command` | R `postgres_logs` |
| 00:48:31.210 | `pg_postmaster_start_time()` | R R2 query, prod, 01:07:48Z |
| 00:48:40.747 | one 57014 (PostgREST's domain-base-type introspection, its schema-cache load) | R census renders half, Logs API, 01:12:55Z |
| 00:50:22 | first ring sample after: MemAvailable 589 MB, swap used 257 MB, `pswpin` counter reset (a VM reboot) | R ring |

---

## §3 Ring, the 60 min before the gap

Every sample, `data:box-health:series --hours 24`, Upstash, read 01:06:55Z.
`swap_mb` is swap used, of 1,024 MB. MemTotal is 904 MB.

| at (UTC) | avail_mb | avail % | swap_mb | load1 | swpin/s | swpout/s | scrape_ms |
|---|---|---|---|---|---|---|---|
| 15:04:22Z | 342 | 37.8 | 701 | 0.08 | 42 | 107.2 | 468 |
| 15:06:22Z | 346 | 38.2 | 711 | 0.09 | 17.5 | 36.9 | 503 |
| 15:08:22Z | 367 | 40.6 | 726 | 0.01 | 20.3 | 49.4 | 305 |
| 15:10:22Z | 393 | 43.5 | 755 | 0 | 54.4 | 106.2 | 478 |
| 15:12:22Z | 425 | 47.0 | 777 | 0 | 3.8 | 49.3 | 288 |
| 15:14:22Z | 528 | 58.4 | 901 | 0.14 | 72.1 | 320.9 | 466 |
| 15:16:22Z | 339 | 37.5 | 722 | 0.16 | 524.3 | 51.6 | 456 |
| 15:18:22Z | 338 | 37.3 | 706 | 0.06 | 27.2 | 5.3 | 466 |
| 15:20:22Z | 298 | 32.9 | 685 | 0.03 | 49.2 | 0.4 | 427 |
| 15:22:22Z | 468 | 51.8 | 821 | 0.09 | 11.4 | 308.2 | 399 |
| 15:24:22Z | 452 | 50.0 | 811 | 0.01 | 21.6 | 0 | 414 |
| 15:26:22Z | 443 | 49.0 | 810 | 0 | 2.3 | 0 | 945 |
| 15:28:22Z | 439 | 48.6 | 809 | 0.02 | 1.5 | 0 | 262 |
| 15:30:22Z | 449 | 49.6 | 803 | 0.09 | 17.9 | 0 | 215 |
| 15:32:22Z | 432 | 47.7 | 939 | 0.34 | 280.9 | 519.5 | 994 |
| 15:34:22Z | 497 | 54.9 | 859 | 0.14 | 66 | 11.1 | 429 |
| 15:36:22Z | 492 | 54.4 | 848 | 0.02 | 23 | 0 | 483 |
| 15:38:22Z | 481 | 53.2 | 847 | 0 | 1.9 | 0 | 238 |
| 15:40:22Z | 452 | 50.0 | 827 | 0 | 57.1 | 1.9 | 536 |
| 15:42:22Z | 477 | 52.8 | 842 | 0.06 | 36.9 | 77.3 | 816 |
| 15:44:22Z | 481 | 53.2 | 841 | 0.05 | 3.4 | 0 | 465 |
| 15:46:22Z | 430 | 47.6 | 813 | 0.13 | 74.2 | 0 | 787 |
| 15:48:22Z | 306 | 33.8 | 715 | 0.1 | 249.4 | 12.8 | 260 |
| 15:50:22Z | 282 | 31.2 | 695 | 0.08 | 93.2 | 29.9 | 251 |
| 15:52:22Z | 480 | 53.1 | 830 | 0.07 | 95.8 | 473.8 | 796 |
| 15:54:22Z | 475 | 52.5 | 830 | 0.16 | 1.7 | 1.1 | 239 |
| 15:56:22Z | 474 | 52.5 | 827 | 0.08 | 6.3 | 0 | 736 |
| 15:58:22Z | 477 | 52.7 | 825 | 0.08 | 5.5 | 0.1 | 276 |
| 16:00:22Z | 434 | 48.0 | 793 | 0.47 | 104.2 | 16.7 | 231 |
| 16:02:22Z | 234 | 25.8 | 1005 | 1.74 | 901.9 | 1283.9 | 2062 |
| 16:04:22Z | 141 | 15.6 | 1024 | 2.95 | 1379.2 | 1401.4 | 7719 |

Readings:

- **Rule 181 shows up twice.** At 15:14:22Z MemAvailable *rose* to 528 MB while
  swap-out ran at 320.9/s; at 15:52:22Z it rose to 480 MB at 473.8/s. A rise is
  not relief. Read `pswpin` with it.
- **The :02/:32 signature is visible all day.** Over the 10-06 samples, the 30
  at :02/:32 average 508.6 swap-in/s and the 417 others average 47.7/s.
  *(computed from the banked ring, 01:15Z)* The day's maximum, 1,811.8/s, was
  06:02:22Z, and the box survived it. The fatal sample, 16:04:22Z (1,379.2/s),
  is **not** a signature minute: it is the day's highest off-signature reading.
- **Swap-in rate alone does not mark the outage; the pair does.** By raw ring
  samples (Upstash, 01:10:51Z), swap free went to ≤ 60 MB at 9 instants on
  10-06: 01:00–01:08Z (31, 2, 3 and 43 MB), 04:32Z (53), 11:32–11:34Z (50, 59),
  16:02Z (19) and 16:04Z (**0**). The box survived every one before 16:02. Only
  16:04:22Z combines **0 MB of swap free with MemAvailable under 200 MB**.
- `oom_kill` (node_vmstat) was 0 on every sample up to 16:04:22Z. Whether the
  kernel OOM killer fired after that is not knowable: the counter reset with the
  VM.

---

## §4 Tables

### R3(a) — the outage window from Postgres' side (`cron.job_run_details`, prod, read 01:08Z)

| job | last `succeeded` before | first `succeeded` after | gap |
|---|---|---|---|
| box-health-probe | 16:04:00.447298 | 21:27:00.126065 | 5:22:59.7 |
| cron-job-budget-watchdog | 16:04:00.446227 | 21:27:00.107415 | 5:22:59.7 |
| derived-mvs-unit-watchdog | 16:04:00.448412 | 21:27:00.121466 | 5:22:59.7 |

The second-longest gap for each was a 21:34→21:45/46 catch-up stutter
(10:57 / 12:03 / 12:03).

### R3(c) — every `failed` row on 10-06, by class and hour (prod, read 01:09Z)

| hour (UTC) | `job startup timeout` | distinct jobs | all other classes |
|---|---|---|---|
| 16:00 | 85 | 5 | 0 |
| 17:00 | 13 | 12 | 0 |
| 18:00 | 3 | 3 | 0 |
| 19:00 | 1 | 1 | 0 |
| 20:00 | 7 | 4 | 0 |
| 21:00 | 59 | 5 | 0 |
| 22:00 | 9 | 4 | 0 |

177 rows, 100 % `job startup timeout`. Zero `statement timeout`, `server closed
the connection`, `administrator command` or `could not connect` rows. Against
successes (prod, 01:10Z): 12:00–15:00 ran 126–127 ok/h with 0 failed; 16:00 was
14 ok / 85 failed (85.9 %); 17:00–20:59 was 0 ok / 24 failed; 21:00 was 75 / 59;
22:00 was 117 / 9; from 23:00 it was 0 failed.

### R3(d) — the Tuesday stack, last `succeeded` firing started 10-06 (prod, read 01:09Z)

| job | jobid | start | end | wall |
|---|---|---|---|---|
| treemap-individuals-global-refresh | 26 | 14:00:00.163 | 14:14:32.381 | 0:14:32.2 |
| donor-party-rollup-refresh | 17 | 15:00:00.153 | 15:01:18.939 | 0:01:18.8 |
| **rule-taggers-weekly** | **12** | **16:00:00.146** | **21:17:24.036** | **5:17:23.9** |
| donor-rollup-refresh | 24 | 12:00:00.132 | 12:00:00.431 | 0:00:00.3 |
| refresh-derived-mvs-daily | 9 | 06:00:00.180 | 06:03:34.048 | 0:03:33.9 |
| rule-taggers-daily | 11 | 06:30:00.148 | 06:33:08.564 | 0:03:08.4 |
| ec-crawl | 45 | 23:45:00.143 | 23:45:00.232 | 0:00:00.1 |
| fe-crawl | 46 | 23:30:00.205 | 23:30:00.364 | 0:00:00.2 |
| platform-counts-daily | 48 | 03:53:00.045 | 03:54:09.378 | 0:01:09.3 |
| ec-vacuum-analyze | 6 | 04:30:00.238 | 04:32:05.550 | 0:02:05.3 |
| fe-vacuum-analyze | 30 | 04:50:00.109 | 04:50:10.838 | 0:00:10.7 |
| fr-vacuum-analyze | 38 | 03:00:00.243 | 03:00:10.373 | 0:00:10.1 |
| ecs / odbt / odr-mv / odt / osar / osdr / treemap-individuals-vacuum-analyze | 47/37/32/34/36/35/33 | 11:05–11:20 | — | 0:00:00.1–0:00:11.1 |
| dpr / officials / votes-vacuum-analyze | 31/39/56 | not scheduled 10-06 (Sun+Wed / Mon / Sat) | | |

All seven `*-vacuum-analyze` 17:20 slots **failed** `job startup timeout`
(fired 17:22:22, verdicts 18:11–19:31). `rule-taggers-weekly`'s history (prod,
01:09Z): 09-08 1:18:12, 09-15 1:20:37, 09-22 failed `job startup timeout`
(0:00:48), 09-29 1:24:22, **10-06 5:17:23**.

**In flight at 16:04:22.338Z** (start < gap AND (end IS NULL OR end > gap),
every job, from 10-05): **one row** — `rule-taggers-weekly`, runid 100671.

### R4 — `data_sync_log`, started 10-06 14:00Z → now (prod, read 01:09Z; `front_door_watch` excluded)

| pipeline | status | started | wall | notes |
|---|---|---|---|---|
| financial_entity_totals_refresh | complete | 14:00 … 01:00 every :00/:30 *except 16:30–21:30* | 0.1–0.4 s | no row for the eleven slots 16:30–21:30Z |
| treemap_individuals_global_refresh | complete | 14:00:00.215 | 0:14:32 | 3,071 ins |
| donor_party_rollup_refresh | complete | 15:00:00.235 | 0:01:18.7 | 2,218 ins, `mode crawl`, `lag 7 days 01:32` |
| entity_connections_rebuild | complete | 15:15:00.229 | 0:00:24.7 | |
| **run_rule_taggers** | **partial** | **16:00:00.181** | **5:03:37.7** | `canceled — size_tags: canceling statement due to statement timeout`; metadata `{action: canceled, tagger: size_tags, cadence: weekly, deleted_rows: 623, desired_rows: 4426852, tags_written: 0, elapsed_seconds: 18218}` |
| entity_connections_rebuild | complete | 21:45:03.202 | 0:07:07 | first EC unit after the gap |

- **No `running` rows anywhere** (`count(*) WHERE status='running'` = 0).
- **No `nightly_cron` row with `nominal_day = '2026-10-07'`**, and none started
  after 10-06 00:13:41Z. Neither run reached the DB.
- **No `skipped` row with a `box saturated` reason.** The only `skipped` row on
  10-06 is `edgar_daily` at 00:11:41Z, `no_filings`, which is Monday's loss
  (FIX-1281).
- `rule-taggers-weekly`'s terminal row (rule 124) is the `partial` row above.
  pg_cron recorded the CALL as `succeeded` at 21:17:24Z, because the procedure
  catches `query_canceled`. That is 13 min 46 s after the size_tags row closed:
  the rest of the weekly branch ran after the cancel, with no timeout armed.

### R5 — state rows (prod, read 01:10Z)

| key | updated_at | reading |
|---|---|---|
| box_health | 01:10:00.068 | probe alive; `backends.client` 11 of 60, `active` 1 |
| box_health_mem | 01:10:22.586 | `oom_kill 0`, `pswpin 128619` (fresh boot), `mem_total_bytes 948191232` |
| cron_watchdog_vercel | 01:10:18.398 | `checked 0, canceled 0` |
| gha_dispatch_nightly | **2026-10-05 21:00:13.449** | `dispatched`, the 10-05 dispatch. **Nothing stamped for 10-06 21:00Z** |
| donor_party_rollup_watermark | 10-06 15:01:18.795 | `last_indexed_at 2026-10-05 00:09:13` |
| donor_rollup_watermark | 10-05 09:14:38.693 | `last_indexed_at 2026-10-05 00:09:13` — the same instant as the party watermark; consistent with no FR write since the 10-06 nominal nightly, not read further |
| ec_crawl / fe_crawl | 01:00:00 | advancing |
| prod_session, donor_party_full_rebuild | — | **no row** |
| size_tags:donation_watermark | **2026-09-29 17:24:22.942** | did not advance; rolled back with the cancel |

- `cron_job_budget_action` rows with `acted_at::date = '2026-10-06'`: **zero.**
  `rule-taggers-weekly`'s budget is 7,200 s, so the watchdog was due to act at
  ~18:00Z. It could not launch: every `cron-job-budget-watchdog` firing from
  16:06Z to 21:23Z was a `job startup timeout`.
- `rollup_watch_overrides`: 3 rows (`entity_connection_stats_rebuild`,
  `front_door_watch`, `recipient_count_reconcile`), none session-prefixed. No
  stale hold.
- `entity_tags` (`pg_stat_user_tables`, prod, 01:16:11Z): n_live_tup 5,413,881,
  n_dead_tup **221,243**, heap 1,768 MB, last_autovacuum 10-04 22:55:51. These
  are the dead tuples the rolled-back merge left behind.

### R8 — now-state (prod, read 01:10–01:11Z)

- `pg_stat_activity`: no non-idle client backend (8 background processes only).
- `prod_op_gate(600)`: `ok: true`, `blocked_by: []` (readings: vacuum, nightly,
  blackout, interlock, watchdogs, stuck_units).
- `box_is_saturated()`: `saturated: false`, `reason: clear`; memory 395 MB
  available (43.7 %), swap used 271 MB, `startup_timeouts_60m 0`.
- `prod_session_state()`: `held false`, `label_stale false`, `reason_text clear`,
  `live_writers []`. `session:held`, 01:07:43Z:
  `held=false reason=- claimant=- claimed_at=- expected_minutes=- live_writers=0`.
- Since 00:48:31Z (at 01:11:18Z): probe 23/23 succeeded (expected ~22 at
  `* * * * *`), each `*/2` watchdog 11/11 (expected 11).
- `pg_stat_statements`: 2,955 rows, 1,559,947 calls. `stats_reset` is still
  2026-09-22 22:32:13Z, so **there is no fresh epoch.** `pg_stat_io` and
  `pg_stat_checkpointer` `stats_reset` = 2026-09-15 15:09:48Z.
- `pg_stat_archiver` (01:18:18Z): `failed_count` 1,196 since 09-15,
  `last_failed_time` 00:46:35.458Z (WAL `…33B000000E8`), `last_archived_time`
  01:17:34Z (`…33C000000CC`). Archiving is current again.

---

## §5 Rule 81 — died in the restart (neither leg)

**None.** `cron.job_run_details` has zero rows started on 10-06 or later with
`status NOT IN ('succeeded','failed')` or `end_time IS NULL`. `data_sync_log`
has zero `running` rows. The fast shutdown at 00:46:36Z terminated two
connections (`57P01` × 2). Their owners are not in the logs, and no Civitics
row was left open by them.

Not rule-81 rows, and kept apart from it:

- the `run_rule_taggers` `partial` row: cancelled by the outage, five hours
  before the restart. It is a failed leg for FIX-1248, not a restart death.
- the two nightly runs: they failed before the restart, on a dark front door.

---

## §6 R7 census output, verbatim

**(a)** `data:census:cancellations:prod -- --start 2026-10-06T15:04:22Z --end
2026-10-07T00:58:31Z --json` (Logs API, read 01:12:50–55Z), trimmed to its
verdict fields:

```
cancellations: renders 1, events 1, minutes 594.15, ratio_renders 0.051, floor_renders 31, pass true
  by_second: 2026-10-07T00:48:40Z  events 1  page "WITH -- Recursively get the base types of domains base_types"
edge (fixed to the last hour, 23:45Z → 00:45Z):
  buckets 23:45 70/69 · 00:00 75/74 · 00:15 72/71 · 00:30 102/101 (requests/5xx)
  lastClosed 101 of 102 = 99.02 % > 1 % and > P99 floor 2 at p0 0.23 % → pass false
pass: false
```

`--by sql_state_code` (read 01:13:03Z): `57014  1  100.0 %`. `--by
error_severity` (read 01:13:14Z): `ERROR  1  100.0 %`. **Both `--by` reads are
scoped to 57014 rows** (the header is "57014 attribution"), so they cannot name
53200 / 57P0x. The stand-in census below covers every `postgres_logs` row.

**(b)** THROWAWAY reader (never committed). It uses `queryLogs`, `source =
'postgres_logs'`, `log_attributes['parsed.*']`, and `TIME_FILTER`.

Postmaster patterns over 15:34:22Z → 01:03:31Z (read 01:13:55Z), every match:

```
2026-10-07 00:46:35.973  LOG  00000  received fast shutdown request
2026-10-07 00:46:36.000  LOG  00000  pg_cron scheduler shutting down
```

There were zero matches for `out of memory`, `terminated by signal`, `was not
properly shut down`, `automatic recovery in progress`, `redo starts at`,
`received immediate shutdown request`, `could not fork`, `too many connections`
and `the database system is starting up`. There was also **no `database system
is ready to accept connections`**, although the postmaster started at 00:48:31Z.

Every `postgres_logs` row, by hour × state × severity (read 01:14:06Z):

```
2026-10-06 15:00  00000  LOG    110
2026-10-06 16:00  00000  LOG     33
2026-10-07 00:00  00000  LOG     50
2026-10-07 00:00  08006  LOG      2
2026-10-07 00:00  57P01  FATAL    2
2026-10-07 00:00  57014  ERROR    1
2026-10-07 01:00  00000  LOG     20
```

The window holds no 53200 or 57P02. No rows exist for 17:00–23:59. The silence
runs **16:04:05.492Z → 00:46:35.458Z** (read 01:17:16Z), and the first row after
it is `archive command failed with exit code 1`. The pg_cron log lines that must
have been written 21:27Z–00:45Z, when pg_cron was running clean, are absent. So
the box's log shipping stayed dark after Postgres recovered, as did the metrics
endpoint, the REST ingress, the pooler path and WAL archiving.

`edge_logs` per 30 min, 15:00Z → 01:00Z (read 01:17:05Z) — requests / 5xx / 52x:

```
15:00 347/0/0     15:30 1975/0/0    16:00 221/75/74   16:30 129/128/128
17:00 80/78/78    17:30 491/490/490 18:00 121/119/119 18:30 88/86/86
19:00 122/120/120 19:30 115/114/114 20:00 142/142/142 20:30 127/125/125
21:00 106/104/104 21:30 109/108/108 22:00 141/139/139 22:30 130/128/128
23:00 164/162/162 23:30 189/187/187 00:00 147/145/145 00:30 223/111/107
```

---

## §7 Tonight's nightly (nominal day 2026-10-07)

- **Dispatched run** 37530682016 (`workflow_dispatch`, `dispatched_by=vercel-cron`,
  created 21:00:12Z): **ran and failed.** Preflight at 21:00:58Z got a 522 and
  failed open, so the fec-phase ran. `reap_stale_sync_log` failed with a 522 at
  21:01:30Z. All five jobs ended `failure` (21:00:16 → 21:09:06Z). The
  dispatcher stamp is absent because the stamp needs the DB.
- **`schedule:` fallback** 37551030602 (created 00:15:46Z): **ran and failed.**
  Its preflight also answered `false` on a failure (00:16:33Z, 522, `FAIL OPEN`),
  so it too ran the fec-phase into the dark front door. Cloudflare reported "the
  TCP handshake timed out". All five jobs ended `failure` (00:15:50 → 00:24:35Z).
- **No `docs/receipts/2026-10-07.*`**: the `receipts` job runs on `always()`,
  but it failed in both runs. The last attempt was at 00:24:33Z: `Failed to
  connect to database: {:error, :timeout}` via the session pooler.
- **Written:** nothing. No `data_sync_log` row exists for nominal 10-07.
- **Lost:** Tuesday 10-06's EDGAR 13D/G. `edgar_daily` scans `new Date()`
  unless `EDGAR_DAILY_DATE` is set (`packages/data/src/pipelines/edgar/index.ts:67-73`),
  so any run from now on reads Wednesday's index. This is the second
  consecutive day lost, after Monday's (FIX-1281).
- **Caught up by Wed 21:00Z** (upserts): everything else the nightly writes.
  `rule-taggers-weekly`'s size tags are **not** caught up. Its signature did not
  advance, so the next firing (Tue 10-13 16:00Z) redoes the same merge.

---

## §8 Open questions for Cowork

1. **Why did the 3 h ceiling land 2 h 03 min late?** The `postgres` role carries
   `statement_timeout=3h`, and the CALL began 16:00:00Z, so the cancel was due
   ~19:00Z. It landed 21:03:37.914Z (`elapsed_seconds 18218`). One candidate is
   a backend thrashing on page faults that did not reach `CHECK_FOR_INTERRUPTS`
   for two hours. The other is a timer that was not armed for this statement.
   Whichever it is, FIX-1185's "the one timer that DOES arm across a procedure's
   COMMITs … the backstop when the box cannot fork" did not bound this run at
   3 h.
2. **Why did the front door not recover with Postgres?** pg_cron was clean from
   22:30Z, but REST (522, TCP handshake timeout), the pooler (`{:error,
   :timeout}`), the metrics endpoint, log shipping and WAL archiving stayed dark
   until the 00:46Z restart. Without the restart, would the outage have run on
   indefinitely? This is the Supabase side of the box; it is worth one read of
   their status page for 10-06 16:00Z–00:46Z, and possibly a ticket.
3. **The merge's memory model vs the box.** The header sized the INSERT hash
   from a clone and accepted ">512 MB → Batches: 2". On prod, the 512 MB node
   ran on a 904 MB box whose steady state already holds ~800 MB in swap. What is
   the fix shape: a lower `work_mem` for the merge, keyed units, or a
   `box_is_saturated()` start gate? It must exist before **Tue 10-13 16:00Z**,
   when jobid 12 fires again with the same work. Whether to park jobid 12 until
   then is Craig's call; this run changed no cron.
4. **`postgres` role `work_mem=256MB`.** Every pg_cron job and every ad-hoc
   `postgres` read inherits a 512 MB hash allowance on this box. Is that
   deliberate (FIX-950?), or should the role default be lower, with the jobs
   that need it setting it per job?
5. **The missing `database system is ready to accept connections` line** after
   the 00:48:31Z start. Is it a filter gap or a shipping gap? Until that is
   known, `postgres_logs` is not a complete restart record.
