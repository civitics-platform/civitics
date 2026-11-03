# The IO-budget census — the 11-02 post-landing throttle (cc-262, read-only prod)

Run 2026-11-03 01:33Z → ~03:30Z (Mon 11-02 evening PST). Read-only against
Supabase Pro: `db-query --prod` (every read under `statement_timeout 30s`, no
`count(*)` over a table ≥ 1 M rows, `EXPLAIN` without ANALYZE), the Prometheus
endpoint (GET), the Upstash ring (LRANGE), `gh`. No migration, no dial, no
`--call`. The one deploy is FIX-1375's sampler (code-only). Prod head
`20261101000000` / 538, postmaster 10-25 13:25:53Z. The four pins were as cc-258
read them (`box_is_saturated ac8dbcdd`, `dispatch_one_unit d6a9073b`,
`get_dispatcher_status 4c305237`, `prod_op_gate 1d3507cd`).
`track_io_timing` is off, `log_temp_files` is −1 and `shared_buffers` is 256 MB.

**The finding in one paragraph.** 11-02 had one throttle, not two stalls. It
ran 03:51 → 08:07Z, about 4 h 15 min, with memory flat. Five heavy dispatched
units ran back to back at 6–28× their walls. Each one armed in a clean
15-minute bucket between bursts of pg_cron startup timeouts, because nothing
the dispatcher reads is IO. The match that lit it was the ec-crawl's
post-landing `entity_connection_stats_windows` pass. Each of its 16 windows
reads ~8.8 GB from `/data` at the gp3 volume's 3,000-IOPS ceiling, and the pass
had begun at 03:01Z. On top of it at 03:53Z, `refresh_platform_counts()`
seq-scanned `entity_connections` three times. The same stack, with the same
statements cancelled, ran on 09-01 and 08-31.

## 1. The budget readings (Supabase Reports → Database → "Disk IO consumed", UTC days)

| day | reading | when read | what the day held |
|---|---|---|---|
| 10-27 → 10-30 | 1 % each | (cc-262's prompt) | quiet weekdays |
| 11-01 Sun | 17 % | final | contract-flow 2,792 s 00:21–01:07Z; the drop-night landing 21:05–23:03Z |
| 11-02 Mon | 88 % | ~05:40Z | the post-landing tail (below) |
| 11-02 Mon | **88 %** | final (Craig, `/cc` args) | still 88 %: nothing after ~05:40Z moved it |
| 11-03 Tue | **9 %** | ~01:30Z (Craig) | the 00:47Z weekly (1,236 s) and ec-crawl ecs windows 4–7 of a SECOND post-landing pass |

These are the only budget readings that exist. What they imply:

- **88 → 88.** The figure did not climb through the afternoon, although the box
  ran normal work from 08:13Z, including ec-crawl units at 52–95 s and the
  ecs pass's windows 4–16 to 11:31Z. Either the dashboard reports the day's
  **deepest depletion** (a low-water mark that refills invisibly), or
  above-baseline use after 05:40Z was negligible. It did **not** reach
  100 %. That sits badly with a 4 h throttle. Without the series this is
  undecidable: the dashboard aggregate may hide an hour at empty. The
  sampler's all-disk MB/s against the 87 Mbps (~10.9 MB/s) baseline answers it
  from the first throttled day on.
- **9 % in 90 minutes on 11-03.** The weekly plus four ecs windows spent 9 %
  of a day's budget. At that rate a full 16-window pass alone spends ~35–45 %.

## 2. Attribution — 11-02 03:00 → 08:30Z, 15-min buckets (read 3)

The columns join `cron.job_run_details` (all jobs), the Upstash ring (2-min
samples; a missing sample = the route could not scrape = the box's ingress
was starved), and `dispatch_log` arms / reaps / box-skips. **Bold** = a bucket
with `job startup timeout`s, the stall signature: 270 of them 03:45 → 08:15Z.

| bucket (Z) | cron runs / startup timeouts | ring samples (of 7–8) | load1 max | MemAvail min MB | swap max MB | pgmajfault/s mean | dispatcher armed | reaped | box skips |
|---|---|---|---|---|---|---|---|---|---|
| 03:00 | 39 / 0 | 8 | 1.59 | 290 | 494 | 193 |  | fe-crawl 0s, ec-crawl 173s |  |
| 03:15 | 40 / 0 | 7 | 2.45 | 245 | 618 | 203 | ec-crawl, fr-vacuum-analyze, fe-crawl | ec-crawl 285s, fr-vacuum-analyze 166s, fe-crawl 0s |  |
| 03:30 | 40 / 0 | 8 | 1.29 | 271 | 535 | 223 | vote-stats-refresh, ec-crawl | vote-stats-refresh 16s, ec-crawl 281s |  |
| **03:45** | 39 / **10** | 5 | 1.87 | 248 | 472 | 103 | ec-crawl |  |  |
| **04:00** | 30 / **23** | 1 | 31.41 | 366 | 579 | — |  |  | stale ×5 |
| **04:15** | 47 / **16** | 4 | 17.48 | 283 | 541 | 197 |  | ec-crawl 2079s | stale ×1, fork_failures ×3 |
| **04:30** | 38 / **12** | 5 | 8.93 | 380 | 545 | 88 |  |  | fork_failures ×4 |
| 04:45 | 42 / 0 | 7 | 2.4 | 335 | 564 | 103 | fe-crawl, ec-crawl, ec-vacuum-analyze, donor-rollup-refresh | fe-crawl 0s, ec-crawl 0s, ec-vacuum-analyze 129s | fork_failures ×1 |
| **05:00** | 37 / **19** | 4 | 19.59 | 260 | 532 | 234 |  |  | fork_failures ×2 |
| **05:15** | 35 / **26** | 0 | — | — | — | — |  |  | stale ×2, fork_failures ×1 |
| **05:30** | 41 / **14** | 3 | 8.63 | 447 | 535 | 111 |  | donor-rollup-refresh 2230s | stale ×1, fork_failures ×4 |
| 05:45 | 37 / 0 | 7 | 0.15 | 319 | 508 | 46 |  |  | fork_failures ×1 |
| **06:00** | 39 / **13** | 6 | 9.21 | 248 | 523 | 247 | refresh-derived-mvs-daily |  | stale ×1 |
| **06:15** | 32 / **25** | 1 | 25.13 | 359 | 571 | — |  |  | fork_failures ×1, stale ×1 |
| **06:30** | 44 / **7** | 6 | 14.46 | 301 | 512 | 76 | rule-taggers-daily | refresh-derived-mvs-daily 1519s | fork_failures ×4 |
| **06:45** | 37 / **18** | 3 | 18.48 | 320 | 544 | 139 |  |  | fork_failures ×2, stale ×1 |
| **07:00** | 38 / **27** | 3 | 20.73 | 364 | 609 | 165 |  |  | fork_failures ×1 |
| **07:15** | 37 / **12** | 2 | 12.04 | 334 | 565 | 198 |  |  | stale ×1, fork_failures ×4 |
| **07:30** | 38 / **13** | 4 | 6.56 | 212 | 543 | 245 |  |  | stale ×1, fork_failures ×3 |
| **07:45** | 37 / **32** | 2 | 16.19 | 240 | 527 | 56 |  |  | stale ×1 |
| **08:00** | 38 / **3** | 6 | 3.81 | 214 | 499 | 115 | fe-crawl | rule-taggers-daily 5180s | fork_failures ×6 |
| 08:15 | 39 / 0 | 7 | 0.4 | 292 | 511 | 90 | ec-crawl, ec-crawl | fe-crawl 0s, ec-crawl 52s |  |

What it says:

- **Memory is not in it.** MemAvailable ran 212–447 MB and swap ≤ 618 MB through
  the window. These are ordinary numbers for this box. cc-250's 10-25 wedge
  had swap at the 1 GiB ceiling.
- **Swap-in and major faults FELL during the stall.** pgmajfault fell from
  ~200–330/s before 03:54Z to 56–245/s inside it. With load1 at 16–31, that
  means processes queued on IO that was not being served. A device delivering
  its normal ~3,000 IOPS would have kept swap-in near its pre-stall rate.
- **The dispatcher armed into the gaps.** The two clean buckets (04:45, 05:45)
  are where `box_is_saturated` cleared. The 04:45 window armed four units,
  including **donor-rollup-refresh** (04:57Z). It then ran 2,227 s and did
  **0 of 32 chunks** before its own box check bailed ("box saturated (stale)
  — resumable at chunk 0"). That was 37 min of reads that wrote nothing. The
  next clean minute armed **refresh-derived-mvs-daily** (06:01Z, 1,519 s,
  cancelled mid-unit at `rebuild_entity_search_index`). The one after armed
  **rule-taggers-daily** (06:37Z, 5,180 s against p50 186 s).
- **The front door:** `front_door_watch` rows are missing at 04:15, 04:30, 05:30
  and 07:15Z. Several that did land took 6–8 s (05:15, 06:15, 06:45, 07:00,
  07:45, 08:00) against the usual 1–2 s.

The walls, against the 30 days before (`dispatch_log` reaped rows since 10-03):

| unit | p50 (n) | worst before 11-02 | 11-02 | × p50 |
|---|---|---|---|---|
| ec-crawl unit (ecs window 3/16) | 60–95 s normal unit; ecs window ~250 s post-landing | 2,079 s (cancel, backoff → 06:27Z) | 2,079 s | ~8× a post-landing window |
| donor-rollup-refresh | 0.1 s (28; most are no-ops) | 1,432.8 s (10-26, a post-landing Monday) | 2,230 s, 0 chunks | — |
| refresh-derived-mvs-daily | 225.1 s (8) | 349.5 s (11-01) | 1,519 s, cancelled | 6.7× |
| rule-taggers-daily | 186.2 s (14) | 213.7 s | 5,180 s | 27.8× |
| platform-counts-daily (cron 48) | 20–69 s | 102.0 s (10-26) | 2,065.9 s, cancelled | ~50× |
| ec-vacuum-analyze | 8.9 s (9) | 127.8 s (10-26) | 128.8 s | the post-landing norm |
| fr-vacuum-analyze | 9.5 s (14) | 172.9 s (10-26) | 165.9 s | the post-landing norm |

The two vacuums ran at their post-landing norm (10-26 had the same 128 / 173 s).
They are part of the load, not victims of it.

## 3. What was reading (read 4) — pgss and pg_statio, cumulative since 10-25 13:25:52Z

`pg_stat_statements` total `shared_blks_read` is **1,047.9 GB** (8 KB blocks, a
miss in shared_buffers, which may still be an OS-cache hit) and `temp` is 29.7 GB.
The top by blocks read:

| GB read | calls | mean s | max s | hit % | statement |
|---|---|---|---|---|---|
| **341.5** | 154 | 112.5 | 2,079.2 | 89.3 | `CALL run_entity_connections_rebuild($1, p_max_units := $2)` (the ec-crawl) |
| 93.7 | 10 | 562.2 | 1,518.7 | 94.0 | `CALL refresh_derived_mvs($1)` (+ 5.20 GB temp) |
| 80.9 | 17 | 382.5 | 2,227.2 | 93.7 | `CALL donor_rollup_rebuild_bulk_dispatched()` (+ 5.00 GB temp) |
| 55.5 | 1,271 | 4.2 | 22.0 | 83.8 | `INSERT INTO financial_relationships …` (the FEC landing) |
| 42.8 | 9 | 800.8 | 5,179.9 | 96.8 | `CALL run_rule_taggers($1)` |
| 32.7 | 1 | 2,791.6 | 2,791.6 | 80.1 | `CALL refresh_contract_flow_rollups()` |
| 28.5 | 9 | 149.9 | 181.2 | 0.2 | `SELECT get_financial_entity_naics()` |
| 28.4 | 387 | 5.9 | 456.1 | 77.7 | `CALL run_fe_totals_crawl(…)` |
| 23.9 / 23.6 / 22.9 | 9 / 9 / 8 | 59 / 47 / 50 | 99 / 129 / 173 | 33 / 24 / 17 | `VACUUM (ANALYZE)` FE / EC / FR |
| **22.5** | 7 | 51.2 | 102.0 | 13.7 | `CALL refresh_platform_counts()` (the cancelled 11-02 run is not recorded) |
| 22.1 | 53 | 28.8 | 46.2 | 43.0 | `SELECT id, canonical_name, entity_type FROM financial_entities WHERE id > $1 …` |
| 19.8 | 1,083 | 1.6 | 7.4 | 22.8 | `SELECT id, donor_fingerprint FROM financial_entities WHERE donor_fingerprint = ANY($1)` |
| 17.5 | 1 | 986.2 | 986.2 | 94.2 | `CALL refresh_treemap_individuals_global()` |

The ec-crawl is a third of every block read since the restart. Its
`entity_connection_stats_windows` stage is the heavy part (section 5). By
temp written, the top is a PostgREST `data_sync_log` read (12.56 GB over
4,700 calls; FIX-1357's territory), then refresh_derived_mvs (5.20 GB) and
donor-rollup (5.00 GB). `pg_statio_user_tables`, cumulative, read at 02:20Z:

| table | heap_blks_read | heap_blks_hit | idx_blks_read | idx_blks_hit |
|---|---|---|---|---|
| entity_connections | 34,535,008 (263 GB) | 143,961,537 | 11,411,722 | 51,864,639 |
| financial_relationships | 28,183,667 (215 GB) | 44,290,477 | 9,315,678 | 28,257,801 |
| financial_entities | 20,313,272 (155 GB) | 35,227,913 | 4,265,357 | 46,263,715 |
| entity_tags | 4,574,801 (35 GB) | 13,813,454 | 2,998,565 | 27,472,081 |
| votes | 1,949,123 | 6,069,461 | 245,098 | 156,989,101 |
| proposals | 1,470,413 | 3,596,547 | 196,555 | 2,775,913 |
| officials | 670,418 | 14,743,394 | 121,723 | 3,830,980 |

The planned end-of-session re-read for a delta was not taken (section 10).

## 4. H2 — `refresh_platform_counts()` on a dirty visibility map (reads 5, 8)

`refresh_platform_counts()` on prod: md5 `a7fdc22d`, cron 48 `53 3 * * *` active,
`cron_job_budget` 1800 s, registry `at 53 3 * * *` `io` **cap 64** (FIX-1357
re-derived it from 128; the prompt's 128 is stale), group `platform`, priority
2. **One transaction.** The 04:27Z cancel rolled back whole, so
`platform_counts` still reads **11-01 03:53:00Z** for all 16 metrics, and so
does `connection_type_counts` (13 rows). The page is one day stale, not wrong.

Visibility at 02:20Z on 11-03, and the plan each count takes now:

| table | relpages | relallvisible / relpages | last vacuum (manual / auto) | n_dead_tup | the count's plan |
|---|---|---|---|---|---|
| entity_connections | 373,641 (2,919 MB) | **0.848** | 11-02 04:54 / 11-01 07:29 | 168,499 | **Seq Scan** (and so are the filtered count and the `connection_type` GROUP BY) |
| entity_tags | 133,332 (1,042 MB) | **0.535** | — / 10-31 22:39 | 238,694 | **Seq Scan** |
| financial_relationships | 674,274 (5,268 MB) | 1.000 | 11-02 03:25 | 0 | Index Only Scan `financial_relationships_type` |
| financial_entities | 245,569 (1,919 MB) | 1.000 | 11-02 22:56 | 0 | Index Only Scan `financial_entities_fec_committee_id_key` |
| proposals | 18,692 | 0.888 | — / 10-31 22:03 | 4,413 | (small) |
| votes / officials / ai_summary_cache | | 1.000 | | 0 | (small) |

At 03:53Z on 11-02, FR had been vacuumed 28 min earlier, so its count was clean.
EC's last vacuum was the 11-01 07:29 autovacuum, before the landing. FE's VM
was dirtied by the landing's totals crawl and not vacuumed until 22:56Z. So the
run read EC's 2.9 GB heap three times plus entity_tags' 1 GB, cold, through
256 MB of shared_buffers on a 904 MB box. pgss puts a normal run at
**3.2 GB/run** (22.5 GB / 7) with a 13.7 % hit ratio.

The day-after-landing walls (cron 48, 10-01 → 11-02):

| | Mondays after a landing | every other day |
|---|---|---|
| walls | 10-05 48.6 s · 10-12 *server restarted* · 10-19 40.3 s · 10-26 **102.0 s** · 11-02 **2,065.9 s cancelled** | 20.0–69.3 s (median ~33 s) |

**Verdict on H2: held as a contributor, not the cause.** A dirty VM costs
platform-counts up to ~3× on a post-landing Monday (10-26: 102 s). The 11-02
cancel is 20× worse than that. It ran inside the throttle, and every unit
inside it ran 6–28× slow. Its 3 EC seq scans arrived at 03:53Z exactly as the
ecs window and the post-vacuum reads were already saturating the volume. That
is three cold full-heap reads that bought nothing a `reltuples` read could not.

**Option verdict (FIX-1376): option 1.** Make EC / FR / FE / entity_tags
`reltuples`-approximate with `method='approx'`. The column exists, and so does
the `'exact'` path for the small tables. Take the `connection_type` totals from
a fresh rollup or behind the `io:` rung. That removes ~6 of the ~9 GB a cold
run reads. Moving the job under the dispatcher only reschedules the reads.
Gating on `relallvisible / relpages ≥ 0.9` would still Seq Scan EC, whose plan
does not use an IOS at 0.848.

## 5. H3 — the post-landing stack (read 6)

**The ec-crawl's `entity_connection_stats_windows` stage is the elephant.**
Windows per UTC day since 10-12 (from `data_sync_log.metadata.units`):

| day | windows | Σ window s | per window |
|---|---|---|---|
| Sun 10-18 / 10-25 / 11-01 (the pre-landing weekly pass) | 16 / 17 / 17 | 603 / 606 / 535 | **~35 s** |
| Mon 10-12 / 10-19 / 10-26 / 11-02 (after the drop night) | 30 / 25 / 18 / 20 | 4,449 / 1,446 / 3,764 / 4,062 | **~150–250 s** |
| Tue 11-03 to 02:11Z (a second pass, started Mon 23:17Z) | 7 | 1,904 | ~270 s (443 s for window 6/16 at 00:47Z, beside the weekly) |
| Tue–Sat otherwise | 3–4 | 18–41 | ~10 s |

The same 16 windows cost **~7× more after a landing** (~35 s → ~250 s), and a
post-landing Monday runs the pass up to twice. On 11-02 the first pass began
03:01Z (window 1/16 at 03:17, 256 s; window 2/16 at 03:35, 258 s). Window 3/16
armed 03:51Z and is the unit the throttle caught: cancelled at 2,054 s, backoff
to 06:27Z, finished 11:31Z (window 16/16). The live calibration (section 6)
measured one of tonight's second-pass windows. It reads **~8.8 GB from
`/data`** in ~235 s, so a 16-window pass reads on the order of **140 GB**. The
pgss line (341.5 GB over 154 ec-crawl calls since 10-25, two post-landing
Mondays) agrees.

What was LIVE (dispatch_log spans):

- **at 03:56Z:** ec-crawl (window 3/16, armed 03:51), platform-counts (cron 48,
  from 03:53), and the FR vacuum's aftermath (reaped 03:27, 165.9 s). The
  nightly's phases had ended 23:05Z the night before; its FIX-943 vacuum tail
  is in the 22:55–23:03Z rows, not at 03:56.
- **at 05:01Z:** donor-rollup-refresh (armed 04:57, reaped 05:37:05, 2,230 s,
  0 of 32 chunks), after ec-vacuum-analyze (04:51 → 04:57, 128.8 s) in the same
  clean window.
- **at 06:15Z / 07:00Z:** refresh-derived-mvs-daily (06:01 → 06:30), then
  rule-taggers-daily (06:37 → 08:07).

**Verdict on H3: held.** The trigger was the ecs-windows pass, a known
IO-bound unit at the volume's IOPS ceiling. Platform-counts and the vacuums'
reads arrived on top of it. Then the dispatcher stacked four more heavy units
into the stall, one per clean bucket, because it reads no IO signal. The stack
prolonged the throttle from ~30 min (03:56 → 04:27) to ~4 h 15 min.

**The precedents** (`data_sync_log`; cron history is gone):

- **08-31, the Monday after a landing:** refresh_derived_mvs 06:00Z ran 21,919 s,
  **cancelled mid-unit at `rebuild_entity_search_index`**, the same statement
  as 11-02. entity_connections_rebuild 12:15Z ran 1,977 s, cancelled at
  `rebuild_entity_connections_contracts`. This is FIX-1123's starvation window.
- **09-01:** donor_rollup_refresh 12:00Z ran 6,734 s ("budget exhausted"),
  donor_rollup_orphan_sweep 3,390 s, entity_connections_rebuild 12:45Z 2,113 s,
  **cancelled at `entity_connection_stats_windows window 1/16`**,
  entity_connection_stats_orphan_sweep 1,796 s, treemap 5,421 s reaped by the
  budget watchdog. The same stage and the same shape. The 09-01 sweeps were the
  1st-of-month load stacked on it.

## 6. The calibration (read 9) — the box's disk, measured

Two findings came before any number:

1. **Two devices.** The db host's node_exporter reports `nvme1n1` (`/data`,
   57 GB ext4) and `nvme0n1` (the root volume, `/dev/nvme0n1p2` at `/`).
   **Since boot the root volume has read as much as `/data`** (1.89 TB vs
   1.88 TB). `pswpin` alone is 92.6 M pages (~379 GB) and `pswpout` 96.3 M
   (~394 GB), roughly all of root's 410 GB written. The rest of root's reads
   are file-backed pages faulted back in under memory pressure. **The memory
   ceiling is spending the IO budget.** The Micro's burst budget is per
   instance, so both devices draw on it.
2. **The endpoint refreshes once a minute** (a 10 s poll: values change every
   ~60 s, at about :15). A rate over the route's clock is wrong by up to 2×:
   the first 60 s sampler read io_time **184 %**. Σ `node_cpu_seconds_total` /
   ncpu tracks the exporter's clock to the second (Δ59.6 s / 59.8 s / 69.5 s
   per refresh), so it is the denominator. FIX-1375's sampler uses it.

The weekly (00:47 → 01:11Z, 1,235.9 s) had reaped before the session opened, so
the calibration ran on the ec-crawl's second-pass ecs windows (exporter-clock
rates, scratch sampler, 01:35–01:57Z):

| at (Z) | Δt s | /data read MB/s | /data io_time % | queue | /data reads/s | root read MB/s | swap-in pages/s | what |
|---|---|---|---|---|---|---|---|---|
| 01:49:28–01:52:38 | 60–70 | 0.00–0.01 | 0.0–0.2 | 0 | 0.2–1.3 | 0.01–0.33 | 2–32 | **idle floor** |
| 01:53:38 | 59.5 | **58.86** | 43.2 | 9.9 | 414 | 3.98 | 689 | window 9/16, sequential phase (~142 KB/read) |
| 01:54:48 | 67.5 | 28.66 | **96.7** | 28.9 | **3,063** | 21.43 | 970 | random phase |
| 01:55:48 | 57.7 | 28.15 | **101.4** | 30.5 | **3,093** | 7.98 | 337 | random phase |
| 01:56:59 | 69.0 | 25.80 | **97.9** | 30.1 | **2,952** | 4.32 | 224 | random phase |
| 01:38:30 | 60.1 | 26.05 | 100.3 | 31.4 | 3,023 | 6.04 | 243 | window 8/16 (route-clock, cached-pair corrected) |

- **Idle floor:** < 0.1 MB/s, io_time < 0.5 %, < 2 reads/s.
- **The ceiling of a known IO-bound unit:** ~3,000 reads/s at io_time ~100 %,
  queue ~30, ~28 MB/s of ~9.5 KB random reads. That is the **gp3 volume's
  3,000-IOPS baseline**, not a MB/s limit: the sequential phase moved 59 MB/s
  at 43 % busy. The instance was **bursting**: 3,000 + root's 250–870
  reads/s is far above the Micro's baseline, and 11-03 read 9 %, not 100 %.
- **So the throttle signature to look for is a collapse in the CEILING.**
  Reads/s and MB/s fall several-fold at the same ~100 % io_time. The
  arithmetic, from Supabase's Micro figures: an instance baseline of 87 Mbps
  (~10.9 MB/s) against a 2,085 Mbps burst, and an IOPS baseline the
  dashboard's IO tab states (~500 for Micro; to be confirmed against the
  dashboard). A ~6× cut from ~3,000 is the size of 11-02's 6–28× walls.
  This is inferred from the walls. The first throttled day under the sampler
  measures it.

`track_io_timing` cost/benefit (not flipped, out of scope): it would add
`blk_read_time` to pgss (per-statement IO wait, the attribution this census had
to infer), at a clock read per block IO. That is cheap on this hardware
(`pg_test_timing` belongs in the change's prompt). It is the one GUC that
would turn read 4 from blocks into seconds.

## 7. H1 — the post-landing tail burns the budget

**Verdict: held in shape, undecidable in mechanism.** The tail cost ~5× the
landing (11-01 17 % with the landing; 11-02 88 %). The post-landing ecs pass is
~7× its quiet cost and runs at the volume's IOPS ceiling for ~67 min of window
time per pass (more when stacked). 11-03's 9 % in 90 min shows the second pass
alone spending at roughly that rate. What is NOT decided: whether 11-02's
throttle was the instance's burst bucket at zero (the dashboard said 88 %, not
100 %) or a different limiter. The sampler's first throttled day decides it:
io_time ~100 % with all-disk MB/s at ≤ ~11 and reads/s ≪ 3,000 is the bucket.

## 8. The `io:` rung — design (FIX-1375; a migration for a later class-P prompt)

- **Inputs:** the mirror's (`pipeline_state.box_health_mem`) `io_time_pct`,
  `disk_all_read_mbps + disk_all_write_mbps`, and `disk_reads_ps`. These land
  once cc-259 extends `record_box_health_mem`'s `c_numeric` with the sampler's
  rate keys. The RPC **drops** unlisted keys today, and the rates are omitted,
  never null, so the whitelist can be strict. `box_is_saturated` needs the last
  `io_samples` mirror readings, but the mirror keeps one row. So the rung either
  reads a short history (a `box_health_mem_ring` of N rows, or N keys) or the
  RPC keeps a counter of consecutive busy samples. The counter is the smaller
  change.
- **Dials** (`platform_dials`, proposed from section 6):
  `io_time_pct_ceiling` **90** (the IOPS ceiling reads 97–101 %; idle < 1 %),
  `io_samples` **3** (6 min at 2-min cadence; one ecs window is ~4 min, so this
  catches the second window, not the first), `io_mbps_floor` **12** (the
  87 Mbps baseline is ~10.9 MB/s; bursting at the ceiling is ~28 + root's 4–21),
  `io_throttle_hold_min` **60**.
- **Two readings:** `io: saturated`: io_time ≥ ceiling for `io_samples`
  consecutive samples. `io: throttled`: the same AND all-disk MB/s ≤ floor,
  which holds `io_throttle_hold_min` after the last such sample, because a
  throttle ends when the bucket refills, not when the current unit stops.
- **Where:** after `headroom:`, before `io: vacuum live` (rule 410). It
  **excludes every ARM**, as `box: memory` does, and never touches a running
  unit (a cancel mid-window is the 2,079 s partial, which helps nothing). It
  would have refused the 04:47–04:57Z arms (ec-vacuum-analyze,
  donor-rollup-refresh) and 06:01Z / 06:37Z, and left the 03:51Z ecs window
  alone. Arming that window was correct in itself. The stack after it was not.
- **The gate:** `prod_op_gate` (d) reads the same input (FIX-1377). **This
  conflicts with FIX-1353** (open, dispatcher s23). FIX-1353 narrows (d) for
  class P to `box_is_saturated` plus the last 10 min. On 11-02 a 10-min or
  60-min window reopened in the 04:45Z and 05:45Z clean buckets, mid-throttle.
  FIX-1353's narrowing is safe only once the `io:` input is in
  `box_is_saturated`, so build FIX-1353 after FIX-1375's rung, or with it.

## 9. How many hours after a landing

The landing ended 23:03Z (nightly reaped 23:05Z). The throttle ran 03:56 →
08:07Z, from **4.9 h to 9.1 h** after it. The ecs first pass completed at
**11:31Z (12.5 h)**. A second full pass ran Mon 23:17Z → Tue (window 11/16 at
02:11Z) and spent 11-03's first 9 %. **Until the rung lands, then: no IO-heavy
push or class-B op from the drop night's 21:00Z until the first post-landing
ecs pass completes (~12.5 h on 11-02), and none during a second pass.**
Practically that means Sunday 21:00Z → Tuesday ~06:00Z, or a clear Saturday.
FIX-1374's push stays on Sat 11-07.

## 10. Not done here, and why

- **Read 7 (the Logs API: `postgres_logs` checkpoint / cancel / fork lines,
  `edge_logs` 5xx per 5 min, the Vercel runtime logs for `/api/cron/box-health`
  03:50–04:30Z): skipped for time.** The per-bucket startup-timeout counts
  above come from `cron.job_run_details`, the same signal; the front-door 5xx
  of 118 at 04:00Z is cc-258's read.
- **The live calibration on the weekly:** the session opened 01:33Z, after it
  had reaped (00:47 → 01:11Z, 1,235.9 s). The calibration ran on the ec-crawl's
  second-pass windows, an IO-bound unit of the same class.
- **The end-of-session `pg_statio` re-read (read 4's delta):** not taken.

## For cc-255 (the `shared_buffers` halving)

The IO before-curve starts at FIX-1375's deploy (11-03, section 6 of cc-262's
report has the first samples). cc-255's before/after adds, from
`data:box-health:series` and receipts §9's IO line: /data read MB/s
p50 / p95 / max, io_time p95 / max, minutes at io_time ≥ 90 %, the all-disk
MB/s, and the dashboard's daily %. The halving trades RAM for exactly these
reads. Root-volume reads (swap and file-backed faults) may FALL if the freed
RAM goes to the page cache, while `/data` reads RISE. Read both.
