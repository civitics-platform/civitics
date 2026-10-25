# 2026-10-25 IO-budget front-door outage — read-only triage (cc-250)

Read 2026-10-25 17:30Z → 18:00Z by cc-250, prod-reads posture (no CALL, no
VACUUM, no reap, no cron or dial change, no write of any kind to Pro). Every
figure names its instrument, its database, and the time it was read. "Prod" is
the Supabase Pro project `xsazcoxinpgttgquwvuf`. **C** marks an instant Craig
reported (email arrival); everything else was read. The Upstash ring was blind
(at its request cap; FIX-1125), so nothing was banked from it. The ring's
substitute turned out to be `dispatch_log.box`, which carries the on-box memory
mirror on the ticks that evaluate the gate (§3).

---

## §1 Verdict

1. **Shape: (B), a memory wedge. The box sat at the swap ceiling for at least
   14 h. That made ordinary IO stall the disk, and the final reader that tipped
   it was Supabase's daily backup.** From 21:00Z Saturday to the last sample at
   11:15Z Sunday, `dispatch_log.box` reads swap used **920–1024 MB of 1024**.
   MemAvailable read 187–414 MB, with **1024/1024 and 214 MB at 09:05:00Z**
   (load1 18.39) and **1024 and 187 MB in the 11:00 bucket**. pg_cron starved:
   **155 `job startup timeout`, the only failure class**, in steps at 03:02,
   04:33–05:05, 09:02, 10:02–10:10, and then continuously from 11:25:00Z.
   Postgres logged an **immediate forced checkpoint at 11:21:55.073Z**. It does
   this at 11:20–11:56Z on **7 of 7 retained days**, and its signature is a
   backup start. The probe failed 3 minutes later, and the data front door read
   52x from the **11:30 bucket** (99/120) through 13:15 (167/169).
   *(prod `dispatch_log`, read 17:59Z; `cron.job_run_details`, 17:32–17:34Z;
   `postgres_logs`, Logs API, 17:44Z and 17:48Z; `edge_logs`, Logs API,
   17:40Z)*
   - **Why (B) and not (A).** Our workload on 10-25 was lighter than the two
     clean days that ran the same jobs: non-monitor cron wall **3,754 s**,
     including the 752 s post-reboot donor-rollup rerun, against **4,070 s on
     10-18 and 5,037 s on 10-19** (cc-242 B1, same definition). Those days had **0 stall-minutes**. The weekly
     `rebuild_entity_connections_external` arm ran at the same size on 10-18
     (576,351 rows, 1,011 s) and on 10-25 (577,603 rows, 1,128 s). Full
     donor-rollup runs went clean on 10-18 (1,297 s) and 10-19 (1,148 s). What
     changed was memory headroom. The daily average swap from `dispatch_log.box`
     was 913 MB on 10-18, then 921, 945, 974, 984, 984, and **989 MB on 10-24**.
     Samples at ≥ 1000 MB went from 6 a day on 10-18 to 24–25 a day on 10-22…24,
     and **63 on 10-25 before the reboot**. That is creep over 17 days of
     uptime since the 10-08 restart.
   - **For (A) to be the primary instead,** our 10-25 load would have to exceed
     the clean days (it read lower), or the swap would have to have had
     headroom (it read 920–1024 MB all window). **For (D),** nothing of ours
     could be above baseline in the spend window (the ec-crawl `external` arm
     07:21–07:40Z was), and the box would have to be clean up to 11:21:55Z (it
     stalled at 04:33, 09:02 and 10:02). **(C) is excluded:** Cloudflare saw
     the 500s too (130 of 214 requests in the 12:00Z hour), and Postgres'
     ledger was not healthy.
   - **The IO-budget email fits (B):** swapping is disk IO, so a box at the
     swap ceiling turns memory pressure into IO spend. Whether swap shares the
     data volume's budget was not read. The budget symptom was real. The disk was still slow *after* the reboot had freed
     memory: `postgres_exporter` took **32.2 s** for `pg_ls_waldir()` and
     **37.1 s** for `pg_ls_archive_statusdir()` at 13:27–13:28Z, and Postgres
     logged `autovacuum worker took too long to start` at 13:27:58Z. *(postgres_logs,
     Logs API, 17:42Z)*
2. **Restart class: an unclean, Supabase-side VM reboot at 13:25:52Z, which
   nothing of ours issued.** `pg_postmaster_start_time()` =
   **2026-10-25 13:25:53.305Z**, `pg_stat_statements_info.stats_reset` =
   13:25:52.563Z, and `pg_is_in_recovery()` = f. `postgres_logs` reads
   `database system was interrupted; last known up at 2026-10-25 13:17:47 UTC`,
   then `not properly shut down; automatic recovery in progress`, with redo
   389/69000D80 → 389/6C000D18 in 0.86 s. There is no `received fast shutdown`.
   The 10-06 hand restart *was* clean. The kernel counters restarted too (pswpin
   1,457,907 at 17:34:22Z, rising at 80/s), so the VM rebooted. The front-door
   arm was configured `mode: arm` but failed safe, because its state store was
   `unreachable: upstash 400: ERR max requests limit exceeded` on every row, and
   Craig reports no hand restart (**C**). *(R1 query, prod, 17:30:54Z;
   postgres_logs, 17:42Z; `pipeline_state.box_health_mem`, 17:34:22Z and
   17:48:22Z; `data_sync_log` front_door_watch, 17:31Z)*
3. **Owners of the spend.** These are every job, unit and stream of ours above
   baseline from 03:00Z to 11:21Z, plus the one foreign reader. None of ours was
   in flight at 11:21:55Z or at 12:00Z: the last unit ended at 11:20:10Z
   (`ecs-vacuum-analyze`).
   - **ec-crawl, `rebuild_entity_connections_external` (weekly ungate):**
     07:21:00 → 07:40:39Z, **1,179.1 s, 577,603 rows**. The checkpoint at
     07:51:20Z wrote **14,585 buffers (44.5 %) and recycled 50 WAL segments**,
     and Supabase `egress_bytes` rose **+3.40 GB from 07:01 to 08:01**, against
     +0.01–0.09 GB per 30 min otherwise. It is the day's largest single write
     of ours. *(data_sync_log, 17:35Z; postgres_logs, 17:44Z;
     platform_usage_snapshot, 17:37Z)*
   - **ec-crawl, `entity_connection_stats_windows` 1–12:** 07:53 → 11:19:39Z,
     **39–70 s each, about 12.4 min in total**, one every 14 min.
   - **donor-rollup-refresh:** 04:49:00 → 04:56:25Z, **446 s, chunks 1–8 of
     32**. It then **backed off itself**: `box saturated (stale) — resumable at
     chunk 9 of 32`. Its 16:59Z rerun did all 32 chunks, because crash recovery
     truncated its UNLOGGED staging. That run read **1,934,205 shared blocks
     (≈ 14.8 GiB) plus 127,978 temp blocks in 752 s** (pgss, since the
     restart). By blocks it is the largest reader we run.
   - **rule-taggers-daily:** 06:33:00 → 06:36:27Z, 207.1 s.
   - **Fixed pg_cron:** `ec-vacuum-analyze` 04:30:00 (10.1 s) and
     `fe-vacuum-analyze` 04:50:00 (31.1 s), both inside the 04:33–05:05 stall.
     `platform-counts-daily` 03:53 (24.4 s). The 11:05–11:20 MV-vacuum series
     ran 0.1–9.9 s each.
   - **Saturday's nightly**, 21:05:25 → 22:40:46Z: littlesis **608,521 rows /
     1,771 s**, fec_bulk 274,539 / 291 s, tag_rules 118,211 / 286 s. Its
     `financial_entities` id-paging reads took **25–50 s per page** from 21:15
     to 21:40Z. The probe stayed clean through it (max 1.45 s).
   - **The status half** (`status_snapshot`, :01/:31): 83.6 s at 03:02,
     **140.9 s at 09:03**, and 39.8 s at 11:01. It was missing at 05:01 and
     10:01, and again from 11:31 to 13:01.
   - **Traffic did not rise.** Cloudflare saw 6,567 requests from 03:00 to
     13:00Z, against 10,971 in the same window on Saturday. `edge_logs` from
     03:00 to 12:00Z shows 33,761 `node` (Vercel render) requests out of 33,808.
   - **Foreign reader:** Supabase's daily backup, from the 11:21:55Z immediate
     checkpoint. Its end is not readable, since the 13:25 reboot ended it.
   - **Not readable:** autovacuum (the reboot reset `pg_stat_user_tables`), the
     swap *rate* before 13:25 (ring blind), and the IO budget itself (no API;
     Craig's screenshots carry it).
4. **Recovery mechanism: the reboot.** It freed memory (swap **183 MB** and
   MemAvailable 456 MB at 13:34:00Z, `dispatch_log.box`) and killed the backup.
   The disk stayed slow for about 10 min after it: dispatcher ticks failed until
   13:35:18Z, and the first clean tick was 13:37:06Z (6.8 s). The probe read
   clean 15/15 from the 13:45 bucket, edge 52x read 0 from the 13:45 bucket,
   and `front_door_watch` logged `recovered` at **14:00:28Z**. This was not a
   dispatcher back-off, because the ticks themselves were failing from 11:25 to
   13:35Z. *(cron.job_run_details, 17:33Z; dispatch_log, 17:59Z; data_sync_log,
   17:31Z)*

---

## §2 Timeline (UTC, 10-24 21:00 → 10-25 17:58)

| instant | what | source | READ / C |
|---|---|---|---|
| 10-24 21:00 | swap 982 MB used / MemAvailable 351 MB (first sample in window) | `dispatch_log.box`, prod, 17:59Z | READ |
| 21:05:25–21:14:10 | nightly fec-phase (fec_bulk 274,539 rows, 291 s) | receipt `docs/receipts/2026-10-25.md`; data_sync_log 17:35Z | READ |
| 21:14:12–21:44:21 | nightly enrichment-heavy (littlesis 608,521 rows, 1,771 s; FE paging reads 25–50 s each) | receipt; data_sync_log; postgres_logs 17:57Z | READ |
| 21:44:23–22:34:43 | nightly enrichment-light (openstates 1,506 s, courtlistener 683 s, edgar 416 s) | receipt; data_sync_log | READ |
| 21:51:17 / 22:46:17 | checkpoints 14,529 buf (44.3 %) / 13,417 buf (40.9 %) | postgres_logs, 17:45Z | READ |
| 22:00 | swap 1022 MB | dispatch_log.box | READ |
| 22:34:46–22:40:46 | nightly enrichment-tail (tag_rules 118,211 rows) | receipt | READ |
| 22:47:59–22:49:22 | nightly-sync `schedule` fallback run (40140082058), success | `gh run list`, 17:37Z | READ |
| 10-25 02:29 / 04:04 | two migration pushes via Supavisor (FIX-1342 prod_op_gate; FIX-1345 registry row) | postgres_logs, 17:57Z | READ |
| 03:01:23–03:02:27 | first 57014s; **03:02:00 startup-timeout trio** (probe 10.4 s); status half 83.6 s | cron.job_run_details; Logs; status_snapshot | READ |
| 03:25:00 | fr-vacuum-analyze (dispatched) 13.1 s | cron.job_run_details via dispatch_log.armed_jobid | READ |
| 04:30:00 / 04:31:00 | ec-vacuum-analyze 10.1 s; ec-crawl unit 11.4 s | cron.job_run_details | READ |
| **04:33:00–05:05:37** | **stall 1:** 14 probe failures, max 93.1 s; edge 5xx 26/1175 (04:30), 12/910 (05:00) | cron.job_run_details; edge_logs | READ |
| 04:49:00–04:56:25 | donor-rollup 446 s, backs off `box saturated (stale)` at chunk 9/32 | data_sync_log | READ |
| 04:50:00 | fe-vacuum-analyze 31.1 s | cron.job_run_details | READ |
| 06:33:00–06:36:27 | rule-taggers-daily 207.1 s | data_sync_log | READ |
| 07:01 → 07:31 | Vercel `included_usage_usd` 97.36 % → 99.87 % → **100.01 %** (daily charge ingest step) | platform_usage_snapshot, 17:37Z | READ |
| 07:31 | Vercel "usage vs the $20 credit at 100 %" email | Craig | **C** |
| **07:21:00–07:40:39** | **ec-crawl `external` arm 1,179.1 s, 577,603 rows** | data_sync_log | READ |
| 07:01 → 08:01 | Supabase egress_bytes +3.40 GB | platform_usage_snapshot | READ |
| 07:51:20 | checkpoint 14,585 buf (44.5 %), 50 WAL recycled | postgres_logs | READ |
| 07:53 → 11:19:39 | ec-stats windows 1–12, 39–70 s each | data_sync_log | READ |
| **09:02:00–09:03:33** | **stall 2:** startup-timeout trio, 93.2 s; status half **140.9 s**; swap **1024**, avail **214 MB**, load1 **18.39** (09:05) | cron.job_run_details; status_snapshot; dispatch_log.box | READ |
| 09:05–09:13 | dispatcher skips 5 ticks `box: fork_failures` | dispatch_log | READ |
| **10:02:00–10:10:30** | **stall 3:** 10 probe failures, median 11.8 s; edge 67 5xx / 29 52x of 701; status half missing | cron.job_run_details; edge_logs | READ |
| 10:12–10:19 | dispatcher skips 5 ticks `box: fork_failures` | dispatch_log | READ |
| 11:00 bucket | swap 1024, MemAvailable **187 MB** | dispatch_log.box | READ |
| 11:01:52 | status half 39.8 s; PostgREST `Thread killed by timeout manager` ×7 at 11:02:18 | status_snapshot; postgrest_logs | READ |
| 11:05–11:20:10 | seven MV VACUUM ANALYZEs, 0.1–9.9 s each; last unit of ours ends 11:20:10 | cron.job_run_details | READ |
| **11:21:52–11:21:55.073** | spread checkpoint hurried (6,618 buf in 2.7 s), then **`checkpoint starting: immediate force wait`**: the daily backup start | postgres_logs, 17:44Z | READ |
| 11:23:00 | last successful dispatcher tick before the gap | cron.job_run_details | READ |
| **11:25:00** | **probe fails** (37.5 s); continuous from here | cron.job_run_details | READ |
| 11:30 bucket | edge **99 of 120 = 52x**; front_door_watch rows stop (11:30 → 13:30 missing) | edge_logs; data_sync_log | READ |
| 11:50 | Supabase "running out of Disk IO budget" email | Craig | **C** |
| 11:53:36 | a probe starts that ends 12:49:20 (3,344.7 s, startup timeout) | cron.job_run_details | READ |
| 12:00 | FRONT DOOR DOWN (Logs arm: 11:30 at 83 % and 11:45 at 99 %, both ≥ 50 %) | Craig; edge_logs agrees | **C** (+READ buckets) |
| 12:12:53 | last pg_cron launch before the reboot (4 jobs, ended 12:54–13:14) | cron.job_run_details | READ |
| 12:25 | Vercel "5xx error rate" email | Craig | **C** |
| 12:00Z hour | Cloudflare: 130 × 500 out of 214 requests | cf-analytics, 17:38Z | READ |
| 13:00 | FRONT DOOR DOWN re-page | Craig | **C** |
| 13:14:22 / 13:14:38 | last cron row write; last Postgres line before the reboot | cron.job_run_details; postgres_logs | READ |
| 13:17:47 | Postgres "last known up" (control file) | postgres_logs | READ |
| **13:25:52** | **unclean reboot; crash recovery 0.86 s; pg_cron restarted 13:26:12** | postgres_logs; R1 | READ |
| 13:27–13:28 | exporter `pg_ls_waldir` 32.2 s, `pg_ls_archive_statusdir` 37.1 s; autovacuum worker too slow to start | postgres_logs | READ |
| 13:30:35–13:32:44 | PostgREST PGRST002 ×452 (schema cache) | postgrest_logs, 17:42Z | READ |
| 13:30 bucket | edge 3,680 requests (106 5xx, 7 52x): the reconnect burst | edge_logs | READ |
| 13:34:00 | swap **183 MB**, MemAvailable 456 MB, probe 16,468 ms | dispatch_log.box | READ |
| 13:37:06 | first clean dispatcher tick (6.8 s) | cron.job_run_details | READ |
| 13:45 bucket | probe 15/15 clean; edge 0 52x | cron.job_run_details; edge_logs | READ |
| 14:00:28 | front_door_watch `recovered` row | data_sync_log | READ |
| 14:00 | FRONT DOOR RECOVERED | Craig | **C** |
| 14:31:28 | ec-crawl cycle `complete` (window 16/16) | data_sync_log | READ |
| 16:59:00–17:11:32 | donor-rollup full rerun, 752.3 s, 1.93 M blocks read | dispatch_log / pgss | READ |
| 17:48:22 | swap ~476 MB; pswpin/out 80/87 per s at load1 0.04 | box_health_mem | READ |

Cloudflare hourly (zone civitics.com, `cf-analytics.mjs`, read 17:37Z): 21:00 1,045 · 22:00 736 · 23:00 966 · 00:00 768 · 01:00 782 · 02:00 556 · 03:00 662 · 04:00 1,028 (291 × 403) · 05:00 625 · 06:00 871 · 07:00 568 · 08:00 909 · 09:00 648 · 10:00 670 · **11:00 371 · 12:00 214** · 13:00 1,129 · 14:00 702. Cloudflare 500s per hour: 09:00 23 · 10:00 55 · 11:00 57 · **12:00 130** · 13:00 40 · 14:00 0.

---

## §3 The ring's place: probe wall + memory mirror

Probe and watchdog walls come from `cron.job_run_details` (prod, read
17:32Z). Swap, MemAvailable and load1 come from `dispatch_log.box->'memory'`,
the on-box mirror that the gate reads on each evaluated tick (prod, read
17:59Z). It carries 1–6 samples per bucket, and none on the plain
`nothing_due` ticks without a gate read. The four buckets 12:15–13:00 had **no
cron row at all**.

| bucket | probe ok / fail | probe med / max s | watchdogs ok / fail | wd med / max s | swap used MB (min–max) | MemAvailable MB (min–max) | load1 max | n mem samples |
|---|---|---|---|---|---|---|---|---|
| 10-24 21:00 | 15 / 0 | 0.108 / 1.350 | 16 / 0 | 0.059 / 0.563 | 982 | 351 | 0 | 1 |
| 10-24 21:15 | 15 / 0 | 0.158 / 0.769 | 14 / 0 | 0.089 / 0.167 | 987 | 298 | 1.53 | 1 |
| 10-24 21:30 | 15 / 0 | 0.164 / 0.872 | 16 / 0 | 0.092 / 0.755 | 991 | 240 | 2.65 | 1 |
| 10-24 21:45 | 15 / 0 | 0.076 / 0.784 | 14 / 0 | 0.030 / 0.785 | — | — | — | 0 |
| 10-24 22:00 | 15 / 0 | 0.085 / 0.214 | 16 / 0 | 0.028 / 0.191 | 1022 | 274 | 0.32 | 1 |
| 10-24 22:15 | 15 / 0 | 0.073 / 0.430 | 14 / 0 | 0.022 / 0.427 | — | — | — | 0 |
| 10-24 22:30 | 15 / 0 | 0.121 / 1.446 | 16 / 0 | 0.036 / 0.837 | 974 | 367 | 0.34 | 1 |
| 10-24 22:45 | 15 / 0 | 0.072 / 0.136 | 14 / 0 | 0.019 / 0.079 | — | — | — | 0 |
| 10-24 23:00 | 15 / 0 | 0.071 / 0.158 | 16 / 0 | 0.033 / 0.190 | 993 | 382 | 0.01 | 1 |
| 10-24 23:15 | 15 / 0 | 0.065 / 0.114 | 14 / 0 | 0.022 / 0.075 | — | — | — | 0 |
| 10-24 23:30 | 15 / 0 | 0.068 / 0.106 | 16 / 0 | 0.021 / 0.086 | 1000 | 374 | 0.02 | 1 |
| 10-24 23:45 | 15 / 0 | 0.069 / 0.120 | 14 / 0 | 0.021 / 0.056 | — | — | — | 0 |
| 10-25 00:00 | 15 / 0 | 0.070 / 0.120 | 16 / 0 | 0.026 / 0.169 | 1012 | 414 | 0.1 | 1 |
| 10-25 00:15 | 15 / 0 | 0.062 / 0.097 | 14 / 0 | 0.019 / 0.051 | — | — | — | 0 |
| 10-25 00:30 | 15 / 0 | 0.069 / 0.107 | 16 / 0 | 0.029 / 0.075 | 1000 | 376 | 0.48 | 1 |
| 10-25 00:45 | 15 / 0 | 0.061 / 0.148 | 14 / 0 | 0.021 / 0.046 | — | — | — | 0 |
| 10-25 01:00 | 15 / 0 | 0.065 / 0.128 | 16 / 0 | 0.022 / 0.158 | 994 | 367 | 0.1 | 1 |
| 10-25 01:15 | 15 / 0 | 0.063 / 0.138 | 14 / 0 | 0.027 / 0.069 | — | — | — | 0 |
| 10-25 01:30 | 15 / 0 | 0.071 / 0.091 | 16 / 0 | 0.022 / 0.052 | 1011 | 387 | 0.16 | 1 |
| 10-25 01:45 | 15 / 0 | 0.064 / 0.121 | 14 / 0 | 0.022 / 0.070 | — | — | — | 0 |
| 10-25 02:00 | 15 / 0 | 0.068 / 0.121 | 16 / 0 | 0.034 / 0.151 | 986–1023 | 362–414 | 0.25 | 2 |
| 10-25 02:15 | 15 / 0 | 0.073 / 0.218 | 14 / 0 | 0.029 / 0.233 | 953–996 | 330–380 | 0.3 | 2 |
| 10-25 02:30 | 15 / 0 | 0.074 / 0.132 | 16 / 0 | 0.028 / 0.092 | 984–997 | 354–390 | 0.12 | 2 |
| 10-25 02:45 | 15 / 0 | 0.072 / 0.118 | 14 / 0 | 0.023 / 0.075 | 988 | 364 | 0 | 1 |
| 10-25 03:00 | 14 / **1** | 0.069 / 10.424 | 14 / 2 | 0.029 / 10.453 | 1010–1024 | 263–359 | 11.32 | 6 |
| 10-25 03:15 | 15 / 0 | 0.076 / 0.100 | 14 / 0 | 0.022 / 0.066 | 1011–1023 | 336–369 | 0.12 | 3 |
| 10-25 03:30 | 15 / 0 | 0.066 / 0.127 | 16 / 0 | 0.026 / 0.098 | 1011–1023 | 306–349 | 0.06 | 2 |
| 10-25 03:45 | 15 / 0 | 0.067 / 0.235 | 14 / 0 | 0.026 / 0.091 | 1022–1023 | 321–325 | 0 | 2 |
| 10-25 04:00 | 15 / 0 | 0.073 / 0.118 | 16 / 0 | 0.028 / 0.089 | 1019 | 305 | 0.08 | 1 |
| 10-25 04:15 | 15 / 0 | 0.068 / 0.125 | 14 / 0 | 0.023 / 0.064 | 1021–1024 | 304–311 | 0.25 | 2 |
| 10-25 04:30 | 10 / **5** | 0.077 / 49.929 | 12 / 4 | 0.043 / 34.453 | 1014–1024 | 283–293 | 10.76 | 3 |
| 10-25 04:45 | 10 / **5** | 0.226 / 47.718 | 8 / 6 | 0.252 / 47.878 | 1019–1024 | 195–295 | 3.43 | 5 |
| 10-25 05:00 | 11 / **4** | 0.101 / 93.075 | 12 / 4 | 0.057 / 97.702 | 1014–1024 | 237–351 | 17.62 | 5 |
| 10-25 05:15 | 15 / 0 | 0.069 / 0.105 | 14 / 0 | 0.025 / 0.069 | 1008–1020 | 355–386 | 0.22 | 2 |
| 10-25 05:30 | 15 / 0 | 0.066 / 0.148 | 16 / 0 | 0.034 / 0.071 | 981–986 | 337–359 | 0.32 | 2 |
| 10-25 05:45 | 15 / 0 | 0.062 / 0.120 | 14 / 0 | 0.019 / 0.045 | 988–1005 | 335–358 | 0.06 | 2 |
| 10-25 06:00 | 15 / 0 | 0.063 / 0.109 | 16 / 0 | 0.032 / 0.194 | — | — | — | 0 |
| 10-25 06:15 | 15 / 0 | 0.063 / 0.155 | 14 / 0 | 0.019 / 0.043 | — | — | — | 0 |
| 10-25 06:30 | 15 / 0 | 0.063 / 0.842 | 16 / 0 | 0.030 / 0.833 | 921–975 | 246–304 | 1.98 | 3 |
| 10-25 06:45 | 15 / 0 | 0.056 / 0.078 | 14 / 0 | 0.022 / 0.037 | 1021 | 382 | 0 | 1 |
| 10-25 07:00 | 15 / 0 | 0.063 / 0.352 | 16 / 0 | 0.027 / 0.376 | 1007–1017 | 377–393 | 0.62 | 2 |
| 10-25 07:15 | 15 / 0 | 0.108 / 1.364 | 14 / 0 | 0.040 / 1.332 | 1002 | 378 | 0.04 | 1 |
| 10-25 07:30 | 15 / 0 | 0.294 / 1.943 | 16 / 0 | 0.108 / 1.485 | 946 | 311 | 1.79 | 1 |
| 10-25 07:45 | 15 / 0 | 0.071 / 0.275 | 14 / 0 | 0.029 / 0.271 | 920 | 281 | 0.13 | 1 |
| 10-25 08:00 | 15 / 0 | 0.085 / 2.064 | 16 / 0 | 0.033 / 1.187 | 962–999 | 315–336 | 0.35 | 2 |
| 10-25 08:15 | 15 / 0 | 0.074 / 0.151 | 14 / 0 | 0.029 / 0.139 | 989 | 361 | 0.01 | 1 |
| 10-25 08:30 | 15 / 0 | 0.063 / 0.129 | 16 / 0 | 0.028 / 0.126 | 972–1014 | 300–347 | 0.59 | 2 |
| 10-25 08:45 | 15 / 0 | 0.064 / 0.137 | 14 / 0 | 0.029 / 0.129 | 942–981 | 284–345 | 0.1 | 2 |
| 10-25 09:00 | 14 / **1** | 0.065 / 93.201 | 14 / 2 | 0.030 / 93.219 | 939–1024 | 214–354 | 18.39 | 6 |
| 10-25 09:15 | 15 / 0 | 0.066 / 0.103 | 14 / 0 | 0.022 / 0.052 | 1019 | 338 | 0.01 | 1 |
| 10-25 09:30 | 15 / 0 | 0.076 / 0.150 | 16 / 0 | 0.036 / 0.121 | 1023 | 287 | 0.08 | 1 |
| 10-25 09:45 | 15 / 0 | 0.071 / 0.373 | 14 / 0 | 0.028 / 0.362 | 1013–1022 | 284–295 | 1.09 | 2 |
| 10-25 10:00 | 5 / **10** | 11.810 / 84.375 | 6 / 10 | 19.232 / 88.599 | 1024 | 318 | 6.05 | 1 |
| 10-25 10:15 | 15 / 0 | 0.064 / 2.205 | 14 / 0 | 0.032 / 2.200 | 996–1024 | 314–360 | 0.89 | 5 |
| 10-25 10:30 | 15 / 0 | 0.075 / 0.671 | 16 / 0 | 0.032 / 0.666 | 1023 | 370 | 0.4 | 1 |
| 10-25 10:45 | 15 / 0 | 0.064 / 0.508 | 14 / 0 | 0.031 / 0.507 | 1008–1014 | 353–358 | 0.01 | 2 |
| 10-25 11:00 | 15 / 0 | 0.074 / 0.148 | 16 / 0 | 0.032 / 0.092 | 1024 | 187 | 2.74 | 1 |
| 10-25 11:15 | 10 / **5** | 0.145 / 86.466 | 10 / 4 | 0.211 / 88.035 | 1016–1020 | 316–318 | 0.07 | 2 |
| 10-25 11:30 | 0 / **14** | 46.411 / 116.057 | 0 / 16 | 55.476 / 126.904 | — | — | — | 0 |
| 10-25 11:45 | 0 / **5** | 89.036 / 3344.685 | 0 / 6 | 87.630 / 678.910 | — | — | — | 0 |
| 10-25 12:00 | **no rows** | – / – | 0 / 2 | 2941.316 / 3394.439 | — | — | — | 0 |
| 10-25 12:15 | **no rows** | – / – | 0 / 0 | – / – | — | — | — | 0 |
| 10-25 12:30 | **no rows** | – / – | 0 / 0 | – / – | — | — | — | 0 |
| 10-25 12:45 | **no rows** | – / – | 0 / 0 | – / – | — | — | — | 0 |
| 10-25 13:00 | **no rows** | – / – | 0 / 0 | – / – | — | — | — | 0 |
| 10-25 13:15 | 0 / **3** | 11.734 / 143.117 | 0 / 2 | 10.802 / 11.602 | — | — | — | 0 |
| 10-25 13:30 | 10 / **5** | 10.079 / 18.637 | 12 / 4 | 0.062 / 16.472 | 183–229 | 456–573 | 6.44 | 4 |
| 10-25 13:45 | 15 / 0 | 0.072 / 0.626 | 14 / 0 | 0.031 / 0.621 | 203–262 | 366–455 | 0.18 | 4 |
| 10-25 14:00 | 15 / 0 | 0.068 / 0.210 | 16 / 0 | 0.030 / 0.216 | 359 | 414 | 0 | 1 |
| 10-25 14:15 | 15 / 0 | 0.059 / 0.107 | 14 / 0 | 0.024 / 0.039 | 393–441 | 427–477 | 0 | 3 |
| 10-25 14:30 | 15 / 0 | 0.062 / 1.184 | 16 / 0 | 0.030 / 1.180 | — | — | — | 0 |
| 10-25 14:45 | 15 / 0 | 0.065 / 0.106 | 14 / 0 | 0.018 / 0.035 | 432 | 433 | 0.02 | 1 |
| 10-25 15:00 | 15 / 0 | 0.063 / 0.121 | 16 / 0 | 0.028 / 0.078 | — | — | — | 0 |
| 10-25 15:15 | 15 / 0 | 0.063 / 0.115 | 14 / 0 | 0.018 / 0.056 | — | — | — | 0 |
| 10-25 15:30 | 15 / 0 | 0.071 / 0.856 | 16 / 0 | 0.026 / 0.834 | — | — | — | 0 |
| 10-25 15:45 | 15 / 0 | 0.068 / 0.087 | 14 / 0 | 0.023 / 0.047 | — | — | — | 0 |
| 10-25 16:00 | 15 / 0 | 0.060 / 0.320 | 16 / 0 | 0.023 / 0.310 | — | — | — | 0 |
| 10-25 16:15 | 15 / 0 | 0.062 / 0.088 | 14 / 0 | 0.022 / 0.048 | — | — | — | 0 |
| 10-25 16:30 | 15 / 0 | 0.063 / 0.133 | 16 / 0 | 0.027 / 0.077 | — | — | — | 0 |
| 10-25 16:45 | 15 / 0 | 0.062 / 0.108 | 14 / 0 | 0.021 / 0.060 | — | — | — | 0 |
| 10-25 17:00 | 15 / 0 | 0.163 / 2.464 | 16 / 0 | 0.080 / 2.457 | — | — | — | 0 |
| 10-25 17:15 | 15 / 0 | 0.077 / 0.133 | 14 / 0 | 0.030 / 0.084 | — | — | — | 0 |
| 10-25 17:30 | 3 / 0 | 0.072 / 0.096 | 4 / 0 | 0.029 / 0.058 | — | — | — | 0 |

**`pipeline_state.box_health_mem`** holds only the latest sample. It cannot
show the outage, since it is overwritten every minute.

| read | `at` | MemAvailable | swap used | pswpin | pswpout | pgmajfault | oom_kill | load1 |
|---|---|---|---|---|---|---|---|---|
| prod 17:34Z | 17:34:22.608Z | 398,057,472 (380 MiB) | 482,045,952 (460 MiB) | 1,457,907 | 1,594,488 | 832,696 | 0 | 0.05 |
| prod 17:49Z | 17:48:22.607Z | 426,045,440 (406 MiB) | 497,197,056 (474 MiB) | 1,525,046 | 1,667,284 | 872,677 | — | 0.04 |

Δ over 840 s: pswpin **+67,139 (79.9/s)**, pswpout **+72,796 (86.7/s)**,
pgmajfault +39,981 (47.6/s), on an idle box at 460–474 MiB of swap. MemTotal
reads 948,191,232 (904 MiB). This is post-reboot steady churn. The rate at the
ceiling before 13:25 was not readable.

**Swap creep by day** (`dispatch_log.box`, prod, read 17:59Z; 10-25 includes
the post-reboot samples, which pull its min down to 183):

| day | samples | swap min / avg / max MB | MemAvailable min / avg MB | samples ≥ 1000 MB |
|---|---|---|---|---|
| 10-18 Sun | 87 | 788 / 913 / 1020 | 283 / 397 | 6 |
| 10-19 Mon | 105 | 809 / 921 / 1024 | 228 / 377 | 5 |
| 10-20 Tue | 72 | 834 / 945 / 1006 | 202 / 388 | 3 |
| 10-21 Wed | 63 | 828 / 974 / 1023 | 204 / 393 | 17 |
| 10-22 Thu | 64 | 892 / 984 / 1023 | 230 / 410 | 25 |
| 10-23 Fri | 59 | 875 / 984 / 1022 | 275 / 390 | 24 |
| 10-24 Sat | 60 | 907 / 989 / 1024 | 240 / 348 | 24 |
| 10-25 Sun | 107 | 183 / 873 / 1024 | 187 / 349 | 63 |

---

## §4 Tables

### R2: `front_door_watch` ledger (prod `data_sync_log`, read 17:31Z)

- Rows every 15 min at :x0:28 from 00:00:28Z to 17:30:28Z. **Nine ticks have
  no row: 11:30, 11:45, 12:00, 12:15, 12:30, 12:45, 13:00, 13:15 and 13:30.**
  On the edge buckets, 12:00 → 13:30 were DOWN-state ticks (seven, 0 of 7 left
  a row). The 11:30 and 11:45 ticks would have read `ok` (the 11:15 bucket was
  7 % 5xx) and also left nothing. So the INSERT failed whatever the verdict.
- No `down` row exists in the DB. The DOWN declarations (12:00 and 13:00, **C**)
  match the **Logs arm**: buckets 11:30 at 99/120 (82.5 %) and 11:45 at
  168/169 (99.4 %) were both ≥ 50 % at the 12:00:28 tick.
- Every row carries `probe_answered: true` and `logs_api: "4 bucket(s)"`, plus
  `restart.mode: "arm"`, `down_ticks: 0`, and
  `state_store: "unreachable: upstash 400: ERR max requests limit exceeded. Limit: 500000, Usage: 500001"`.
  The max DOWN tick N reached cannot be read, because the counter lives in the
  unreachable store.
- 13:45:28 `ok` row buckets: 12:45 105/106 · 13:00 156/157 · 13:15 167/169 ·
  13:30 7/3680. 14:00:28 `recovered`: *"the two newest closed buckets are clean
  and the one before them was 52x-saturated"*.
- Pre-outage 52x blips in the banked buckets, by bucket start: 04:30 1/1175 ·
  05:00 6/910 · 09:00 4/1180 · 10:00 28/697 (29/701 on re-read).

### R3(b): every `failed` cron row, 10-24 21:00Z → now (prod, read 17:33Z)

All **155** carry `job startup timeout`. No 57014, no user-request cancel, no
connection error. 153 are on named jobs, plus 2 dispatched one-shots
(fe-crawl jobid 599 at 04:55, ec-crawl jobid 621 at 09:03:25).

| hour | startup timeouts | jobs |
|---|---|---|
| 03 | 3 | box-health-probe, both watchdogs |
| 04 | 25 + 1 | probe, watchdogs, dispatcher-tick (+ fe-crawl one-shot) |
| 05 | 10 | probe, watchdogs, dispatcher-tick |
| 09 | 4 + 1 | probe, watchdogs, dispatcher-tick (+ ec-crawl one-shot) |
| 10 | 25 | probe, watchdogs, dispatcher-tick |
| 11 | 64 | probe, watchdogs, dispatcher-tick |
| 12 | 3 | watchdogs, dispatcher-tick |
| 13 | 19 | probe, watchdogs, dispatcher-tick |

**The :02/:32 status-half trios (FIX-1292):** 03:02:00, 05:02:00, 09:02:00,
10:02:00 and 11:32:00 each carried a probe+watchdog trio. 03:32, 04:02, 04:32,
05:32, 06:02 … 08:32, 09:32, 10:32 and 11:02 carried none. 12:02 launched
nothing, because the launcher was blocked from 11:51:28 to 12:12:53. Each trio
that fired landed on a box already at 939–1024 MB of swap: an interaction,
not a cause.

### R3(c): every firing except the four monitors (prod `cron.job_run_details`, read 17:33–17:35Z)

Dispatched one-shots are deleted from `cron.job` at reap, so they are joined
through `dispatch_log.armed_jobid` (rule 7 by name). Walls over 60 s are bold.

| job | runid / jobid | start | end | status | wall s |
|---|---|---|---|---|---|
| cron-job-run-details-retention | runid 162326 | 10-25 01:51:00 | 10-25 01:51:00 | succeeded | 0.1 |
| dpr-vacuum-analyze | runid 162352 | 10-25 02:00:00 | 10-25 02:00:01 | succeeded | 1.4 |
| ec-crawl (dispatched) | jobid 579 | 10-25 02:11:00 | 10-25 02:11:17 | succeeded | 17.5 |
| fe-inbound-rollup-refresh (dispatched) | jobid 581 | 10-25 02:21:00 | 10-25 02:21:00 | succeeded | 0.6 |
| ec-crawl (dispatched) | jobid 582 | 10-25 02:25:00 | 10-25 02:25:09 | succeeded | 9.0 |
| ec-crawl (dispatched) | jobid 583 | 10-25 02:39:00 | 10-25 02:39:05 | succeeded | 5.9 |
| ec-crawl (dispatched) | jobid 585 | 10-25 02:53:00 | 10-25 02:53:01 | succeeded | 1.4 |
| vm-probe-pre-fr | runid 162495 | 10-25 02:55:00 | 10-25 02:55:00 | succeeded | 0.1 |
| ec-crawl (dispatched) | jobid 586 | 10-25 03:17:00 | 10-25 03:17:05 | succeeded | 5.2 |
| fr-vacuum-analyze (dispatched) | jobid 588 | 10-25 03:25:00 | 10-25 03:25:13 | succeeded | 13.1 |
| ec-crawl (dispatched) | jobid 589 | 10-25 03:31:00 | 10-25 03:31:03 | succeeded | 3.8 |
| vote-stats-refresh (dispatched) | jobid 590 | 10-25 03:33:00 | 10-25 03:33:16 | succeeded | 16.6 |
| ec-crawl (dispatched) | jobid 591 | 10-25 03:47:00 | 10-25 03:47:04 | succeeded | 4.4 |
| platform-counts-daily | runid 162648 | 10-25 03:53:00 | 10-25 03:53:24 | succeeded | 24.4 |
| ec-crawl (dispatched) | jobid 593 | 10-25 04:01:00 | 10-25 04:01:02 | succeeded | 2.0 |
| abuse-events-retention | runid 162705 | 10-25 04:15:00 | 10-25 04:15:00 | succeeded | 0.0 |
| ec-crawl (dispatched) | jobid 594 | 10-25 04:17:00 | 10-25 04:17:02 | succeeded | 2.9 |
| vm-probe-pre-ec | runid 162734 | 10-25 04:25:00 | 10-25 04:25:00 | succeeded | 0.0 |
| ec-vacuum-analyze | runid 162749 | 10-25 04:30:00 | 10-25 04:30:10 | succeeded | 10.1 |
| ec-crawl (dispatched) | jobid 596 | 10-25 04:31:00 | 10-25 04:31:11 | succeeded | 11.4 |
| vm-probe-pre-fe | runid 162787 | 10-25 04:45:00 | 10-25 04:45:00 | succeeded | 0.0 |
| donor-rollup-refresh (dispatched) | jobid 597 | 10-25 04:49:00 | 10-25 04:56:58 | succeeded | **478.1** |
| fe-vacuum-analyze | runid 162801 | 10-25 04:50:00 | 10-25 04:50:31 | succeeded | 31.1 |
| ec-crawl (dispatched) | jobid 598 | 10-25 04:51:00 | 10-25 04:51:03 | succeeded | 3.4 |
| fe-crawl (dispatched) | jobid 599 | 10-25 04:55:00 | 10-25 04:55:49 | failed | 49.5 |
| ec-crawl (dispatched) | jobid 600 | 10-25 05:19:00 | 10-25 05:19:06 | succeeded | 6.6 |
| ec-crawl (dispatched) | jobid 602 | 10-25 05:35:00 | 10-25 05:35:12 | succeeded | 12.5 |
| ec-crawl (dispatched) | jobid 603 | 10-25 05:49:00 | 10-25 05:49:11 | succeeded | 11.6 |
| rule-taggers-daily (dispatched) | jobid 605 | 10-25 06:33:00 | 10-25 06:36:27 | succeeded | **207.1** |
| ec-crawl (dispatched) | jobid 606 | 10-25 06:39:00 | 10-25 06:39:01 | succeeded | 1.6 |
| ec-crawl (dispatched) | jobid 608 | 10-25 06:53:00 | 10-25 06:53:08 | succeeded | 8.4 |
| ec-crawl (dispatched) | jobid 609 | 10-25 07:07:00 | 10-25 07:07:21 | succeeded | 21.9 |
| ec-crawl (dispatched) | jobid 611 | 10-25 07:21:00 | 10-25 07:40:39 | succeeded | **1179.1** |
| ec-crawl (dispatched) | jobid 613 | 10-25 07:53:00 | 10-25 07:54:00 | succeeded | **60.5** |
| ec-crawl (dispatched) | jobid 615 | 10-25 08:07:00 | 10-25 08:08:10 | succeeded | **70.4** |
| ec-crawl (dispatched) | jobid 616 | 10-25 08:21:00 | 10-25 08:22:04 | succeeded | **64.2** |
| ec-crawl (dispatched) | jobid 618 | 10-25 08:35:00 | 10-25 08:36:06 | succeeded | **66.7** |
| ec-crawl (dispatched) | jobid 619 | 10-25 08:49:00 | 10-25 08:50:01 | succeeded | **61.7** |
| ec-crawl (dispatched) | jobid 621 | 10-25 09:03:25 | 10-25 09:03:35 | failed | 10.0 |
| ec-crawl (dispatched) | jobid 623 | 10-25 09:39:00 | 10-25 09:40:06 | succeeded | **66.1** |
| ec-crawl (dispatched) | jobid 624 | 10-25 09:53:00 | 10-25 09:53:53 | succeeded | 53.5 |
| ec-crawl (dispatched) | jobid 626 | 10-25 10:23:00 | 10-25 10:24:10 | succeeded | **70.2** |
| ec-crawl (dispatched) | jobid 628 | 10-25 10:37:00 | 10-25 10:38:08 | succeeded | **68.3** |
| ec-crawl (dispatched) | jobid 629 | 10-25 10:51:00 | 10-25 10:51:54 | succeeded | 54.2 |
| odr-mv-vacuum-analyze | runid 163773 | 10-25 11:05:00 | 10-25 11:05:02 | succeeded | 2.5 |
| ec-crawl (dispatched) | jobid 631 | 10-25 11:05:00 | 10-25 11:05:56 | succeeded | 56.6 |
| treemap-individuals-vacuum-analyze | runid 163787 | 10-25 11:10:00 | 10-25 11:10:01 | succeeded | 1.4 |
| odt-vacuum-analyze | runid 163794 | 10-25 11:12:00 | 10-25 11:12:00 | succeeded | 0.1 |
| osdr-vacuum-analyze | runid 163801 | 10-25 11:14:00 | 10-25 11:14:00 | succeeded | 0.1 |
| osar-vacuum-analyze | runid 163804 | 10-25 11:16:00 | 10-25 11:16:00 | succeeded | 0.2 |
| odbt-vacuum-analyze | runid 163810 | 10-25 11:18:00 | 10-25 11:18:00 | succeeded | 0.2 |
| ec-crawl (dispatched) | jobid 632 | 10-25 11:19:00 | 10-25 11:19:39 | succeeded | 39.0 |
| ecs-vacuum-analyze | runid 163817 | 10-25 11:20:00 | 10-25 11:20:10 | succeeded | 9.9 |
| ec-crawl (dispatched) | jobid 634 | 10-25 13:49:00 | 10-25 13:49:15 | succeeded | 15.8 |
| xsr-vacuum-analyze (dispatched) | jobid 636 | 10-25 13:53:00 | 10-25 13:53:02 | succeeded | 2.0 |
| ec-crawl (dispatched) | jobid 637 | 10-25 14:03:00 | 10-25 14:03:28 | succeeded | 28.2 |
| ec-crawl (dispatched) | jobid 638 | 10-25 14:17:00 | 10-25 14:17:17 | succeeded | 17.8 |
| ec-crawl (dispatched) | jobid 640 | 10-25 14:31:00 | 10-25 14:31:28 | succeeded | 28.1 |
| donor-rollup-refresh (dispatched) | jobid 646 | 10-25 16:59:00 | 10-25 17:11:32 | succeeded | **752.3** |
| odr-mv-vacuum-analyze | runid 164493 | 10-25 17:05:00 | 10-25 17:05:02 | succeeded | 2.9 |
| treemap-individuals-vacuum-analyze | runid 164506 | 10-25 17:10:00 | 10-25 17:10:02 | succeeded | 2.9 |
| odt-vacuum-analyze | runid 164513 | 10-25 17:12:00 | 10-25 17:12:00 | succeeded | 0.0 |
| osdr-vacuum-analyze | runid 164520 | 10-25 17:14:00 | 10-25 17:14:00 | succeeded | 0.2 |
| osar-vacuum-analyze | runid 164523 | 10-25 17:16:00 | 10-25 17:16:00 | succeeded | 0.4 |
| odbt-vacuum-analyze | runid 164530 | 10-25 17:18:00 | 10-25 17:18:00 | succeeded | 0.1 |
| ecs-vacuum-analyze | runid 164536 | 10-25 17:20:00 | 10-25 17:20:03 | succeeded | 3.8 |
| fe-crawl (dispatched) × 36 | jobid 569–647 | every ~30 min, 10-24 21:17 → 10-25 17:17 (none 11:21 → 13:51) | — | succeeded | 0.1–1.5 each |

**Overlapping 09:00 → 14:00Z:** ec-crawl jobids 621–632 (09:03 failed; 09:39,
09:53, 10:23, 10:37, 10:51, 11:05 and 11:19, each 39–70 s), the 11:05–11:20 MV
vacuums (≤ 9.9 s), and fe-crawl 0.1 s units. **In flight at 11:21:55 and at
12:00Z: no job of ours.** The monitors' launches from 11:25 on all failed to
start.

### R3(d): orphans (prod, read 17:33Z)

There are **none**. No row in the window has `status NOT IN
('succeeded','failed')` or `end_time IS NULL`. The 12:12:53 launches closed
`failed` at 12:54–13:14.

### R4: the dispatcher (prod `dispatch_log`, read 17:34–17:59Z)

| hour | pg_cron ticks (expect 30) | armed | reaped | skipped | nothing_due |
|---|---|---|---|---|---|
| 10-24 21 → 10-25 02 | 30 each | 2–7 | 2–7 | 0 | 23–28 |
| 03 | 30 | 8 | 7 | **5** | 17 |
| 04 | **25** | 6 | 7 | **6** | 14 |
| 05 | **28** | 5 | 4 | **6** | 17 |
| 06–08 | 30 each | 4–7 | 5–6 | 0 | 23–26 |
| 09 | **29** | 5 | 6 | **5** | 19 |
| 10 | **25** | 5 | 5 | **5** | 16 |
| 11 | **12** | 3 | 3 | 0 | 9 |
| **12** | **0** | 0 | 0 | 0 | 0 |
| 13 | **12** | 3 | 3 | **6** | 4 |
| 14–17 | 30 each | 2–5 | 2–5 | 0 | 25–28 |

- **What `box` carries:** the probe reading (`probe_ms`, backends,
  `startup_timeouts_10m/60m`, `watchdog_max_wall_10m`) and the memory mirror
  (`swap_used_mb`, `mem_available_mb`, `available_pct`, `load1`,
  `age_seconds`). Its thresholds are `fork_failures_10m: 3`, `stale_seconds:
  180`, `watchdog_wall_s: 1.0` (`watchdog_wall_considered: false`) and
  **`memory: "report-only — no threshold until a week of data sizes one"`**. At
  09:05:00 it held swap 1024 / MemAvailable 214 / load1 18.39 and skipped on
  `fork_failures`, not on memory.
- **Crawl throughput:** `unit_rows` is null on every row. `unit_ms` is on the
  reaped rows only. ec-crawl ran 1,615–21,856 ms before 07:21, **1,179,148 ms**
  on the `external` unit, and **53,478–70,363 ms** on stats windows 1–12. There
  was **no collapse** before 11:21: each window took about a minute by design
  size (70–104 rows each). The ec backoff did **not** trip. The `external` unit
  (1,128 s) is under `backoff_abs_seconds` 1500, it has 0 samples (fewer than
  `backoff_min_samples` 5), and `backoff_until` still reads
  2026-10-18T05:01:31Z (`pipeline_state.ec_crawl`, 17:34Z). The only sensor
  back-offs were the gate's `fork_failures` skips and donor-rollup's own
  `stale` exit.
- **`get_dispatcher_status()` (17:58:28Z):** `last_tick_at` 17:57:00, ticks_60m
  **30/30**. Decisions over 24 h: armed 88 / reaped 88 / skipped 33 /
  nothing_due 523. Dials: pause false, tick 120 s, max_live_caps 1024 MB,
  headroom 150 MB, unit_target 240 s, max_concurrent 2, rearm_cooldown 1800 s.

### R5: `data_sync_log`, 10-24 21:00Z → now, front_door_watch excluded (prod, read 17:35Z)

| pipeline | n | statuses | max wall s | note |
|---|---|---|---|---|
| nightly phases (nightly_cron) | 4 | complete | 2,992.9 | fec 490.9 · heavy 1,776.9 · light 2,992.9 · tail 326.0 |
| littlesis · openstates · courtlistener · edgar · fec_bulk · agency_leadership · tag_rules | 1 each | complete | 1,771.2 · 1,506.5 · 682.9 · 416.2 · 291.1 · 281.8 · 286.4 | inside the nightly |
| entity_connections_rebuild (ec-crawl) | 34 | 33 partial, 1 complete | **1,179.1** | 577,603 rows at 07:21; cycle complete 14:31:28 |
| donor_rollup_refresh | 2 | partial, complete | 751.1 | 04:49 partial `box saturated (stale)`; 16:59 complete, restarted because staging was truncated |
| run_rule_taggers | 1 | complete | 207.1 | |
| official_vote_stats_rebuild | 1 | complete | 16.5 | |
| platform_counts_daily | 1 | complete | 24.4 | |
| financial_entity_totals_refresh (fe-crawl) | 36 | complete | 1.5 | |
| canary_check | 2 | complete | 10.5 | GHA runs 05:00 and 09:27 concluded `failure`, a standing red ("no transition since the last run") |
| edgar_daily | 1 | skipped | 0.7 | `no_filings` |
| nightly-sync | 1 | dispatched | 0.0 | 02:00:37 |

`fr-vacuum-analyze`, `dpr-`, `ec-` and `fe-vacuum-analyze` write **no**
`data_sync_log` row. Their walls are R3(c)'s: fr 13.1 s at 03:25 (Sat's was
9.5 s), dpr 1.4 s at 02:00, ec 10.1 s, fe 31.1 s. There are no `running`
orphans, and no `skip_reason` rows beyond edgar_daily.

### R6: state rows (prod, read 17:34Z)

- `box_health` 17:34:00: probe_ms 60.2, client backends 19 of 60,
  startup_timeouts 0/0, watchdog max wall 0.025/0.073 s.
- `ec_crawl` (recent_units omitted): `backoff_until`
  2026-10-18T05:01:31Z, backoff_hours 2, backoff_abs_seconds 1500,
  backoff_multiple 2.0, backoff_min_samples 5, backoff_min_rows 1000,
  unit_budget_seconds 1800, cadence 15 min, min_cycle_interval 360 min,
  blackout `[]`, yield_to `[]`. Skips: backoff 198, blackout 527, peer_due 28,
  peer_running 25, cycle_cooldown 2345.
- `fe_crawl`: `backoff_until` 2026-10-11T04:02:32Z, blackout `[]`. Skips:
  backoff 109, peer_backoff 74.
- `cron_watchdog_vercel` 17:34:18: unit none, checked 0, canceled 0.
- `gha_dispatch_nightly`: dispatched 10-24 21:05:22Z, HTTP 204.
- `prod_session` and `monthly_egress_estimate`: **no such keys on prod.**
- `cron_job_budget_action` with `acted_at ≥ 10-24 21:00Z`: **0 rows.** The
  budget watchdog never got to act; its own launches were the ones timing out.
- `platform_dials`: headroom_target 150 MB, max_live_caps 1024 MB,
  max_concurrent_units 2, tick 120 s, unit_target 240 s, **pause false**,
  rearm_cooldown 1800 s, updated 10-15 02:10:51Z.
- `rollup_watch_overrides`: 21 rows, **none session-prefixed**.

### R7(a): `status_snapshot` (prod, read 17:36Z)

Rows land at **:01/:31**. The normal wall is 7–27 s, and the slowest section
is `pipelines` (`self_tests` on some rows). The jumps were 03:02:39 at
**83.6 s**, 09:03:53 at **140.9 s** and 11:01:52 at **39.8 s**. Rows were
**missing** at 05:01, 10:01, 11:31, 12:01, 12:31 and 13:01. 13:33:18 read
21.4 s with `error: "partial: self_tests"`. No other row carries an error.

### R7(b): `platform_usage_snapshot` (prod, read 17:37Z)

The payload's `metrics[]` carries {service, metric, value, pct, status}.
`vercel_billing` / `vercel_billing_shadow` carry the calendar and vendor-cycle
blocks.

| fetched | Vercel included_usage_usd (pct) | fluid GB-h | fluid CPU s | ISR reads | vendor-cycle MTD $ | Supabase egress GB | Supabase CPU % |
|---|---|---|---|---|---|---|---|
| 10-24 21:01 → 10-25 06:31 (every row) | 19.472 (97.36 %) | 236.577 | 39,768.2 | 27,051 | 4.154 | 77.955 → 80.422 | 3.5–52.4 |
| 07:01 | **19.974 (99.87 %)** | 237.715 | 41,086.5 | 27,596 | 5.210 | 80.448 | 11.25 |
| 07:31 | **20.003 (100.01 %)** | 237.990 | 41,152.1 | 27,596 | 5.217 | **81.660** | 24.01 |
| 08:01 → 11:01 | 20.011 (100.06 %) | 238.169 | 41,200.3 | 27,596 | 5.217 | **83.850** → 84.168 | 8.6–39.8 |
| 11:31 → 13:01 | *missing* | | | | | | |
| 13:32 | 20.011 | — | — | — | — | 84.168 | error `supabase_sql: Could not query the database for the schema ca…` |
| 14:01 → | 20.011 | | | | | 0.000 → 0.076 (counter reset at the reboot) | 0–4.8 |

- **The Vercel resource that crossed 100 % at ~07:31Z** is
  `vercel.included_usage_usd`. At 07:31 its value of 20.003 equals
  `vercel_billing.projected_usage_usd` = **20.0028**: the calendar-month
  *projection* of usage against the $20 credit. That block reads `usage_mtd_usd`
  16.13 and `credit_used_pct` 80.66. The figure was flat for nine and a half
  hours, then stepped once at 07:01, with fluid GB-h, CPU s and ISR reads moving
  in the same step. That is Vercel's daily charge ingest landing the previous
  day's ordinary spend (≈ $0.53). **It is not a night burst, and it is
  unrelated to the outage.** The vendor-cycle MTD of $5.217 corroborates
  Craig's $5.48 billing page.
- The Supabase egress step of +3.40 GB from 07:01 to 08:01 sits on the
  `external` arm's write burst. What transmitted it is not readable here.

### R8: Logs API (read 17:38–17:57Z, paced; one call at ~17:45:05Z fell inside the :45 +0–1 window, see the report)

- **(a) census 03:00 → 15:00Z:** gate FAIL. 85 renders / 107 statement-timeout
  events, ratio 3.58 against floor 36. By hour: 03 3 · 04 11 · 05 1 · 06 2 ·
  07 1 · 08 2 · **09 28** · 10 19 · 11 20 · 12 5 · 13 15. `--by
  sql_state_code`: 57014 = 113 (100 %). `--by error_severity`: ERROR = 113
  (100 %). The `--by` reads are 57014-scoped. Edge half PASS on 14:45 (0 of
  585).
- **(b)1 edge buckets:** see the §5 ledger's edge column. Onset was the 11:15
  bucket (17 5xx / 5 52x of 232), saturated from the 11:30 bucket through
  13:15, then the 13:30 bucket's 3,680-request reconnect burst, clean from
  13:45. These agree with every banked R2 bucket.
- **(b)2 attribution 03:00 → 12:00Z:** user agents were `node` 33,761 (463
  5xx), `Vercel Edge Functions` 42, and `@supabase-infra/mgmt-api` 5. Top
  paths: `/rest/v1/proposals` 3,523 · `officials` 3,291 ·
  `external_source_refs` 2,832 · `entity_activity_state` 2,083 ·
  `financial_entities` 1,947 · `financial_relationships` 1,902 ·
  `ai_summary_cache` 1,511 · `entity_engagement_rollup_mv` 1,400 ·
  `jurisdiction_page_cache` 1,355 · `rpc/official_is_content_bearing` 1,349 ·
  `rpc/get_official_page` 1,277. No crawler user agent appears at the data
  front door.
- **(b)3 postgres_logs 09:00 → 14:30Z:**
  - sqlstate per 15 min: 57014 ran 27 (09:00), 17 (10:00), 11 (11:30), 4
    (13:15) and 11 (13:30). 57P03 appeared once (13:15) and 08006 four times
    (13:30). **No 53300 and no 53200.**
  - Application names: lines with no application name (pg_cron launcher plus
    checkpointer) ran **≈ 77–83 per 15 min until 11:15 (65), then 0 from 11:30
    to 13:00**. Only a handful of
    `postgrest` cancel lines got out in that span (10 / 4 / 1 / 5 / 4 / 1).
  - **No `pg_dump`, `wal-g`, `basebackup` or walsender connection is logged in
    any window.** The backup shows only as the checkpointer's
    `immediate force wait`.
  - Patterns: **zero** `out of memory`, `terminated by signal`, `too many
    connections`, `received fast shutdown` or `checkpoints are occurring too
    frequently`. There was one `the database system is starting up` (13:25:55)
    and 11 `could not accept SSL connection` (13:29–13:36).
  - The 7-day search finds one `checkpoint starting: immediate force wait` per
    day: 10-19 11:20:56 · 10-20 11:23:03 · 10-21 11:26:00 · 10-22 11:56:30 ·
    10-23 11:25:23 · 10-24 11:26:37 · **10-25 11:21:55**. The only crash
    recovery is 10-25 13:25:53.
- **(b)4 pooler / PostgREST 11:30 → 14:15Z:** `supavisor_logs` has **no** row.
  `postgrest_logs` has **no** row between 11:30 and 13:30:24, so log shipping
  was dark too. From the reboot on there were PGRST002 ×452 (13:30:35 →
  13:32:44), timeouts ×78 (13:30:35 → 14:14:22), and errors ×25. The earlier
  sample: `Warp server error: Thread killed by timeout manager` ×7 at
  11:02:18–11:02:48.

### R9: Cloudflare (read 17:37–17:39Z)

The hourly totals and per-hour 500s are in §2. **User agents 03:00 → 13:00Z:**
56 distinct. KeenableBot 4,027 (61.3 %), ExaSearchBot 1,045, bingbot 288,
desktop Chrome 276, curl 184, then Googlebot-mobile and facebookexternalhit.
On Saturday 03:00 → 13:00Z KeenableBot was 8,094 of 10,971, so **Sunday's
volume was lower.** **Client IPs:** top 1 covers 4.2 %, top 25 66.9 %, top 100
79.2 % and top 500 97.5 %, and every top-20 address sits in Google Cloud ranges. It is
the same crawler class as Saturday, at lower volume, and mitigated 7.2 % over
the 18 h.

### R10: GitHub (read 17:37Z)

The nightly-sync dispatch ran 40132668760 (21:05:22 → 22:41:33Z) and the
schedule fallback 40140082058 (22:47:59 → 22:49:22Z), both success. The phase
walls from the receipt were fec 8 m 11 s, heavy 29 m 37 s and light 49 m 53 s.
After that came cc-246/247/248 pushes and tests from 02:15 to 04:49Z (CI only),
sync-canary-check failures at 05:00 and 09:27 (standing red), and
`platform-snapshot` every 10 min, **136 of 136 success** (11:30–13:20Z runs
took 23–25 s against 9–11 s). Nothing else overlapped 09:00 → 14:30Z.

### R11: cumulative views, **CUMULATIVE SINCE 13:25:53Z (crash recovery), NOT since 10-08** (prod, read 17:50–17:52Z)

The reboot reset `pg_stat_user_tables`, `pg_stat_io`,
`pg_stat_checkpointer`, `pg_stat_bgwriter` and pgss (all `stats_reset`
13:25:53.578Z or 13:25:52.563Z). **None of them can see the morning.**
`financial_relationships` (13 GB), `entity_connections` (7,554 MB),
`financial_entities` (3,531 MB), `entity_tags` (2,210 MB) and `votes`
(1,074 MB) all read `n_live_tup 0`, with no vacuum or analyze since the reset.
**`track_io_timing` is `off`**, so every `shared_blk_read_time` reads 0 and no
query can be ranked by read latency.

- **pgss top by `shared_blks_read + temp_blks_written`:**
  `donor_rollup_rebuild_bulk_dispatched()` 1 call, **1,934,205 read + 127,978
  temp, 752.3 s**. `run_entity_connections_rebuild` 4 calls, 190,586, 89.8 s.
  The VACUUM ANALYZEs of `official_donor_rollup_mv`,
  `treemap_individuals_rollup`, `entity_connection_stats_mv` and
  `external_source_refs` read 45,473 / 40,880 / 39,956 / 36,967 blocks.
  `record_box_health()` 256 calls, 17,555.
- **`pg_stat_io`, object = relation:**

| backend_type | context | reads | writes | extends | hits | evictions | reuses |
|---|---|---|---|---|---|---|---|
| client backend | normal | 1,243,665 | 59,019 | 106,551 | 52,508,212 | 1,294,899 | — |
| client backend | bulkread | 1,015,231 | 44,449 | — | 21,303 | 199 | 1,015,030 |
| client backend | vacuum | 186,190 | 27,494 | 0 | 30,537 | 2,554 | 183,636 |
| autovacuum worker | vacuum | 144,588 | 44,760 | 0 | 27,069 | 403 | 144,185 |
| background worker | vacuum | 6,253 | 36 | 0 | 3 | 257 | 5,996 |
| background worker | normal | 3,246 | 0 | 0 | 19,725 | 3,241 | — |
| autovacuum worker | normal | 555 | 47 | 3 | 139,076 | 515 | — |
| background writer | normal | — | 60,934 | — | — | — | — |
| checkpointer | normal | — | 22,792 | — | — | — | — |

- `pg_stat_checkpointer`: 53 timed, 1 requested (end-of-recovery), 22,792
  buffers, write 1,800 s (the spread). `pg_stat_bgwriter`: 60,934 clean, 400
  maxwritten, 1,360,462 alloc.
- Settings: shared_buffers 32,768 × 8 kB (256 MB), work_mem 64 MB,
  maintenance_work_mem 64 MB, **vacuum_cost_delay 0** (so the cron `VACUUM`s
  run unthrottled), autovacuum_vacuum_cost_delay 2 ms, max_wal_size 4 GB,
  checkpoint_timeout 300 s.
- **UNLOGGED tables truncated by the crash** (read 17:53Z):
  **`fec_emit_runs` 0 rows and `fec_emit_keys` 0 rows** (the receipt read
  2,746,756 keys this morning), `ec_donations_incr_dirty` empty, and the
  `_drb_*` donor-rollup staging (rebuilt by the 16:59 run; `_drb_fe` ≈ 5.27 M
  rows by reltuples now).

### R12: now-state (prod, read 17:36Z)

- `pg_stat_activity`, non-idle: background processes only. No client backend
  is active and no transaction is open.
- `prod_op_gate(60)`: **`ok: true`, `blocked_by: []`**, interlock clear,
  watchdogs 30/30 runs per 60 min, `startup_timeouts_60m: 0`. The last startup
  timeout was 13:35:18Z, so the (d) hold cleared at **~14:35:18Z**. Nightly
  `next_start` 21:00Z, class P, `required_minutes` 17.
- `box_is_saturated()`: `saturated: false`, reason `clear`, probe_ms 55.6,
  memory swap 460 MB / MemAvailable 380 MB (42.0 %).
- The probe's wall over the last 15 min was 0.072 / 0.096 s (median / max).
- `pg_stat_statements_info`: dealloc 0, stats_reset 13:25:52.563Z.
- `session:held` at the start (17:30Z): `held=false reason=- claimant=-
  claimed_at=- expected_minutes=- live_writers=0` (no `label_stale` field).

---

## §5 The spend ledger, one row per 15 min

This covers 21:00Z Sat → 15:00Z Sun. Columns: ours running (pg_cron walls ≥ 5
s, dispatched units, GHA phases; sync rows ≥ 5 s or ≥ 1,000 rows), the probe,
the data front door (`edge_logs`: requests · 5xx · 52x), and other readings
(status half, checkpoints ≥ 3,000 buffers, Supabase's backup). **Autovacuum
cannot be placed:** the reboot erased `last_autovacuum`. **The IO budget's own
drain and refill cannot be read** (there is no API instrument; Craig's
screenshots carry it). This ledger shows what ran, not what it cost the budget.

| bucket (UTC) | ours running (pg_cron / dispatched / GHA) | probe ok/fail · med/max s | edge req · 5xx · 52x | other |
|---|---|---|---|---|
| 10-24 21:00 | nightly fec-phase (GHA); nightly enrichment-heavy (GHA); regulations 7.9s 1,003r; congress_officials 41.6s; congress_votes 96.3s; openstates_bulk_people 42.9s 7,417r; fec_bulk 291.1s 274,539r; littlesis 1771.2s 608,521r | 15/0 · 0.108/1.350 | 2733 · 3 · 0 | — |
| 10-24 21:15 | nightly enrichment-heavy (GHA); littlesis 1771.2s 608,521r | 15/0 · 0.158/0.769 | 1559 · 0 · 0 | — |
| 10-24 21:30 | nightly enrichment-heavy (GHA); nightly enrichment-light (GHA); littlesis 1771.2s 608,521r | 15/0 · 0.164/0.872 | 1762 · 0 · 0 | status half 26.6s |
| 10-24 21:45 | nightly enrichment-light (GHA); edgar 416.2s; courtlistener 682.9s | 15/0 · 0.076/0.784 | 3197 · 0 · 0 | ckpt 14529 buf |
| 10-24 22:00 | nightly enrichment-light (GHA); courtlistener 682.9s; openstates 1506.5s 7,274r | 15/0 · 0.085/0.214 | 2051 · 2 · 0 | status half 23.6s; ckpt 8334 |
| 10-24 22:15 | nightly enrichment-light (GHA); openstates 1506.5s 7,274r; opm_fte 6.5s; elections 12.3s; congress_committees 30.8s 4,125r; agency_leadership 281.8s | 15/0 · 0.073/0.430 | 1602 · 1 · 0 | ckpts 11824/3828/3153 |
| 10-24 22:30 | nightly enrichment-light (GHA); nightly enrichment-tail (GHA); agency_leadership 281.8s; tag_ai 35.8s; tag_rules 286.4s 118,211r; sector_affinity_tag_refresh 7s | 15/0 · 0.121/1.446 | 2496 · 2 · 0 | ckpt 5463 |
| 10-24 22:45 | — | 15/0 · 0.072/0.136 | 656 · 0 · 0 | ckpt 13417 |
| 10-24 23:00 | — | 15/0 · 0.071/0.158 | 1052 · 1 · 0 | — |
| 10-24 23:15 | — | 15/0 · 0.065/0.114 | 1658 · 0 · 0 | — |
| 10-24 23:30 | — | 15/0 · 0.068/0.106 | 1588 · 0 · 0 | — |
| 10-24 23:45 | — | 15/0 · 0.069/0.120 | 1288 · 0 · 0 | — |
| 10-25 00:00 | — | 15/0 · 0.070/0.120 | 765 · 2 · 0 | — |
| 10-25 00:15 | — | 15/0 · 0.062/0.097 | 875 · 0 · 0 | — |
| 10-25 00:30 | — | 15/0 · 0.069/0.107 | 1038 · 0 · 0 | — |
| 10-25 00:45 | — | 15/0 · 0.061/0.148 | 609 · 0 · 0 | — |
| 10-25 01:00 | — | 15/0 · 0.065/0.128 | 863 · 0 · 0 | — |
| 10-25 01:15 | — | 15/0 · 0.063/0.138 | 660 · 0 · 0 | — |
| 10-25 01:30 | — | 15/0 · 0.071/0.091 | 952 · 0 · 0 | — |
| 10-25 01:45 | — | 15/0 · 0.064/0.121 | 2446 · 0 · 0 | — |
| 10-25 02:00 | ec-crawl 17.5s 1,507r | 15/0 · 0.068/0.121 | 802 · 1 · 0 | status half 27.4s |
| 10-25 02:15 | ec-crawl 9s 1,106r | 15/0 · 0.073/0.218 | 996 · 0 · 0 | ckpt 6668 |
| 10-25 02:30 | ec-crawl 5.9s | 15/0 · 0.074/0.132 | 1451 · 3 · 0 | — |
| 10-25 02:45 | — | 15/0 · 0.072/0.118 | 597 · 0 · 0 | — |
| 10-25 03:00 | — | 14/1 · 0.069/10.424 | 1767 · 2 · 0 | status half 83.6s |
| 10-25 03:15 | ec-crawl 5.2s; fr-vacuum-analyze (disp) 13.1s | 15/0 · 0.076/0.100 | 779 · 0 · 0 | — |
| 10-25 03:30 | vote-stats 16.5s | 15/0 · 0.066/0.127 | 734 · 1 · 0 | — |
| 10-25 03:45 | platform-counts-daily 24.4s | 15/0 · 0.067/0.235 | 821 · 0 · 0 | — |
| 10-25 04:00 | — | 15/0 · 0.073/0.118 | 2252 · 0 · 0 | status half 26.4s |
| 10-25 04:15 | — | 15/0 · 0.068/0.125 | 1411 · 0 · 0 | — |
| 10-25 04:30 | ec-crawl 11.4s 1,098r; ec-vacuum-analyze 10.1s | 10/5 · 0.077/49.929 | 1175 · 26 · 1 | — |
| 10-25 04:45 | donor-rollup 445.8s 19,185r; fe-vacuum-analyze 31.1s | 10/5 · 0.226/47.718 | 500 · 7 · 0 | — |
| 10-25 05:00 | canary 10s | 11/4 · 0.101/93.075 | 910 · 12 · 6 | status half MISSING |
| 10-25 05:15 | ec-crawl 6.6s | 15/0 · 0.069/0.105 | 668 · 0 · 0 | ckpt 3167 |
| 10-25 05:30 | ec-crawl 12.4s 1,360r | 15/0 · 0.066/0.148 | 904 · 1 · 0 | ckpt 5686 |
| 10-25 05:45 | ec-crawl 11.6s 1,575r | 15/0 · 0.062/0.120 | 646 · 0 · 0 | ckpt 6515 |
| 10-25 06:00 | — | 15/0 · 0.063/0.109 | 1783 · 1 · 0 | status half 26.5s |
| 10-25 06:15 | — | 15/0 · 0.063/0.155 | 1502 · 0 · 0 | — |
| 10-25 06:30 | rule-taggers 207.1s | 15/0 · 0.063/0.842 | 816 · 1 · 0 | — |
| 10-25 06:45 | ec-crawl 8.4s | 15/0 · 0.056/0.078 | 690 · 0 · 0 | — |
| 10-25 07:00 | ec-crawl 21.9s | 15/0 · 0.063/0.352 | 774 · 1 · 0 | — |
| 10-25 07:15 | ec-crawl 1179.1s 577,603r | 15/0 · 0.108/1.364 | 681 · 0 · 0 | — |
| 10-25 07:30 | ec-crawl 1179.1s 577,603r | 15/0 · 0.294/1.943 | 664 · 0 · 0 | status half 25.1s |
| 10-25 07:45 | ec-crawl 60.5s | 15/0 · 0.071/0.275 | 692 · 0 · 0 | ckpt 14585 buf/50 WAL |
| 10-25 08:00 | ec-crawl 70.3s | 15/0 · 0.085/2.064 | 1377 · 2 · 0 | — |
| 10-25 08:15 | ec-crawl 64.2s | 15/0 · 0.074/0.151 | 658 · 0 · 0 | — |
| 10-25 08:30 | ec-crawl 66.7s | 15/0 · 0.063/0.129 | 890 · 0 · 0 | — |
| 10-25 08:45 | ec-crawl 61.7s | 15/0 · 0.064/0.137 | 1986 · 0 · 0 | — |
| 10-25 09:00 | — | 14/1 · 0.065/93.201 | 1180 · 30 · 4 | status half 140.9s |
| 10-25 09:15 | canary 10.5s | 15/0 · 0.066/0.103 | 665 · 0 · 0 | — |
| 10-25 09:30 | ec-crawl 66s | 15/0 · 0.076/0.150 | 897 · 1 · 0 | — |
| 10-25 09:45 | ec-crawl 53.5s | 15/0 · 0.071/0.373 | 546 · 0 · 0 | — |
| 10-25 10:00 | — | 5/10 · 11.810/84.375 | 701 · 67 · 29 | status half MISSING |
| 10-25 10:15 | ec-crawl 70.2s | 15/0 · 0.064/2.205 | 1317 · 0 · 0 | — |
| 10-25 10:30 | ec-crawl 68.3s | 15/0 · 0.075/0.671 | 851 · 2 · 0 | — |
| 10-25 10:45 | ec-crawl 54.2s | 15/0 · 0.064/0.508 | 370 · 0 · 0 | ckpt 6186 |
| 10-25 11:00 | ec-crawl 56.6s | 15/0 · 0.074/0.148 | 1680 · 5 · 0 | status half 39.8s; ckpt 4611 |
| 10-25 11:15 | ec-crawl 39s; ecs-vacuum-analyze 9.9s; Supabase daily backup start (immediate ckpt 11:21:55; end not read) | 10/5 · 0.145/86.466 | 232 · 17 · 5 | ckpt 6618 + immediate |
| 10-25 11:30 | — | 0/14 · 46.411/116.057 | 120 · 119 · 99 | status half MISSING |
| 10-25 11:45 | — | 0/5 · 89.036/3344.685 | 169 · 168 · 168 | — |
| 10-25 12:00 | — | 0/0 · –/– | 120 · 119 · 119 | status half MISSING |
| 10-25 12:15 | — | **no rows** | 281 · 280 · 280 | — |
| 10-25 12:30 | — | **no rows** | 176 · 175 · 175 | status half MISSING |
| 10-25 12:45 | — | **no rows** | 106 · 105 · 105 | — |
| 10-25 13:00 | — | **no rows** | 157 · 156 · 156 | status half MISSING |
| 10-25 13:15 | **restart** 13:25:52 (unclean) | 0/3 · 11.734/143.117 | 169 · 168 · 167 | — |
| 10-25 13:30 | — | 10/5 · 10.079/18.637 | 3680 · 106 · 7 | status half 21.4s |
| 10-25 13:45 | ec-crawl 15.8s | 15/0 · 0.072/0.626 | 1308 · 0 · 0 | — |
| 10-25 14:00 | ec-crawl 28.2s | 15/0 · 0.068/0.210 | 749 · 0 · 0 | — |
| 10-25 14:15 | ec-crawl 17.8s | 15/0 · 0.059/0.107 | 611 · 0 · 0 | — |
| 10-25 14:30 | ec-crawl 28.1s | 15/0 · 0.062/1.184 | 732 · 0 · 0 | — |
| 10-25 14:45 | — | 15/0 · 0.065/0.106 | 585 · 0 · 0 | — |

**The three biggest spenders of ours**, by wall and by writes or reads:
ec-crawl's `external` arm (1,179 s, 577,603 rows, 07:21–07:40), donor-rollup
(446 s and 8 of 32 chunks at 04:49; a full run reads ≈ 14.8 GiB), and the 12
ec-stats windows (≈ 12.4 min, 07:53–11:20). All three ran in the 6.5 h before
the 11:21:55 backup start, and none was in flight at it.

---

## §6 Open questions and recommendations for Cowork

**(i) Is cc-249 safe tonight as written?** Re-cut it: run the MOVE, and gate
the RETURN.
- No owner in §1 is a job cc-249 touches. Today's trigger was Supabase's
  backup on a box at the swap ceiling.
- The MOVE (ec/fe vacuums on a dead-tuple gate) *removes* two fixed daily
  VACUUMs (04:30 / 04:50) that sat inside stall 1. It points the right way, so
  run it.
- The RETURN adds `refresh-derived-mvs-daily` at 06:00Z. Its historical wall
  is 199–382 s a day (cc-242 B1). The rows say its risk grows with **uptime,
  not with tonight**. The reboot reset swap to 183 MB (13:34Z); at 17:48Z it
  read about 474 MB. At the 10-18→10-24 rate of creep, the box reaches the
  ceiling again in about two weeks. Then a 06:00Z refresh lands where 10-25 sat
  at 921–1021 MB of swap.
- Land the RETURN together with a memory threshold in the gate (next point),
  or hold it until that threshold exists.
- `prod_op_gate(60)` is `ok` now. The (d) hold from the morning's startup
  timeouts cleared at ~14:35Z, so cc-249's push is not blocked by it.

**(ii) The cheapest mitigation the rows support, ranked:**
1. **Give the gate its memory threshold.** `box.thresholds.memory` says
   "report-only — no threshold until a week of data sizes one". That week now
   exists: 617 samples from 10-18 to 10-25 in `dispatch_log.box` (§3). Today's
   distress buckets read swap 939–1024 MB with MemAvailable 187–359 MB. The
   clean days had a daily minimum of 788–907 MB. A refusal of io-class units at
   swap ≥ 1000 MB, or MemAvailable < 250 MB, would have stood down the 07:21
   `external` arm (1002 MB at the time) and the donor-rollup at 04:49 (1019–1024
   MB). It is one threshold in `box_is_saturated()`.
2. **A restart before the ceiling.** The daily average crossed about 975 MB
   roughly 13 days after the 10-08 restart (10-21: 974 MB). A planned
   quiet-window restart around day 10 is cheaper than an unplanned crash
   reboot. The crash cost the morning's pg_stat history, the FEC emit
   baseline, the ec dirty set and a 14.8 GiB donor-rollup redo. This is
   Craig's call, because it is a vendor action.
3. **Not supported by today's rows:** a blackout around the 11:20Z backup slot.
   Nothing of ours was in flight at 11:21:55, so it would not have changed
   10-25. Also not supported: a vacuum cost delay (the cron VACUUMs are ≤ 31
   s), or a bot rule (traffic fell).
4. **The tier (FIX-589).** The rows give the tier argument plainly. A 904 MiB
   box creeps to the swap ceiling in about two weeks under an *unchanged*
   workload, and then the same Sunday jobs that passed on 10-18 wedge it on
   10-25.

**(iii) Instruments that were missing:**
- The ring was blind (Upstash cap). `dispatch_log.box` covered it partially, at
  1–6 samples per 15 min and only on gate-evaluated ticks. A memory column on
  *every* tick, or a bounded on-box history of `box_health_mem` (1,440 rows),
  would make it a 2-minute ring that never depends on Upstash.
- There is no IO-budget reading in any API.
- `track_io_timing = off`.
- An unclean reboot erases pgss, `pg_stat_*` and every UNLOGGED table.
- The watchdog's breadcrumb was missing for 9 ticks. Its off-box store
  (Upstash) was dark at the same time, so neither store held the outage.
- Log shipping itself went dark from 11:30 to 13:30 (`postgrest_logs` and
  `supavisor_logs` had no rows), so the Logs API cannot see inside a wedge
  either.

**(iv) Tonight's nightly (21:00Z) runs on truncated UNLOGGED state.**
`fec_emit_runs` and `fec_emit_keys` read 0 rows. Per the FIX-1106 lesson, a
residue or retraction step keyed on the *newest* run would audit against a
fresh, smaller baseline that looks well-formed. Cowork should confirm that
nothing destructive keys on it tonight. `ec_donations_incr_dirty` was also
truncated, so the ec crawl's donations increment may miss deltas written before
13:25.

**(v) Ask Supabase support:** "Project `xsazcoxinpgttgquwvuf` was hard-rebooted
at 2026-10-25 13:25:52Z, with crash recovery and no fast shutdown. What issued
it? Was the disk IO-throttled from about 09:00Z, and how much of the budget did
the 11:21:55Z backup read?" This is a recommendation, not a filing; the (D)
filing condition did not fire.
