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

**As built (cc-264, 2026-11-07).** The placement above contradicts itself: the rung
"excludes every ARM, as `box: memory` does" cannot also sit "after `headroom:`,
before `io: vacuum live`", because `box: memory` is `box_is_saturated`'s verdict at
`dispatch_one_unit` step 4, before any row, and those two are per-row reasons. It was
built box-level: after `memory`, before `watchdog_wall`, as the reasons
`io_throttled` and `io_saturated`, with the streak kept by `record_box_health_mem`.
"Never touches a running unit" holds for cancels only: `box_backoff_gate` and two
units' chunk loops read the same verdict (Craig ruled inherit and document). The 11-02
replay above is inferred from the walls, because no `io_time_pct` sample exists before
11-03. → `docs/OPERATIONS.md` §Disk IO budget.

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

## The 11-16 pass (cc-286, read-only prod)

The second drop night's post-landing pass under the rung: `io_samples` 2
(FIX-1399) and the stale-mirror hold (FIX-1392 H1), both live since
2026-11-11 01:10:43Z. The landing was fec_bulk complete, 4,159,334 rows,
21:09:25 → 23:24:39Z Sun 11-15. The pass ran from the first ec-crawl arm after
the landing (02:27:02Z Mon, donations window 1/16) to the closing unit
(ecs window 16/16, then the complete unit armed 01:33Z, reaped **01:39:00Z
Tue**). That is 23 h 12 min, against 11-09's 02:41 → 22:21Z.

The sources are cc-266's: `dispatch_log` (box readings per row),
`cron.job_run_details` and the off-box ring (`data:box-health:series --hours
30`, 768 samples from 11-15 20:36Z). The table starts at Sun 23:00Z, the
landing's tail, so the stall before the pass's first arm is in it. Quiet runs
(no skip, no timeout) are merged. **Bold** = startup timeouts.

| 15-min bucket (Z) | ticks | io_sat / io_thr / fork / stale skips | armed | streak max | io max | st10 max | mirror age max | startup timeouts | ring n | ring io max | busy ≥ 90 % at ≤ 12 MB/s (MB/s) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 11-15 23:00 | 7 | 0/0/0/0 |  | — | — | — | — | 0 | 8 | 76.1 | — |
| 11-15 23:15 | 8 | 1/0/0/0 | fe-crawl 23:25 | 2 | 92 | 0 | 40 | 0 | 7 | 100 | — |
| 11-15 23:30 | 7 | 0/0/0/0 | donor-rollup-refresh 23:35, entity-tags-vacuum-analyze 23:37 | 1 | 99.3 | 0 | 35 | 0 | 8 | 99.3 | donor bulk armed 23:35:01 on streak 1 (99.3 %, 86.25 MB/s) |
| 11-15 23:45 | 8 | 0/0/0/0 |  | — | — | — | — | 0 | 7 | 89 | — |
| **11-16 00:00** | 6 | 0/0/4/0 | fe-crawl 00:03 | 1 | 100 | 5 | 176 | **7** | 4 | 100 | 00:10(8.93) |
| **11-16 00:15** | 7 | 0/0/4/0 |  | 1 | 100 | 6 | 762 | **9** | 2 | 81.5 | — |
| **11-16 00:30** | 5 | 0/0/5/0 |  | 0 | 59.4 | 13 | 314 | **10** | 4 | 59.4 | — |
| **11-16 00:45** | 2 | 0/0/1/0 |  | 0 | 29.7 | 4 | 31 | **11** | 2 | 96 | 00:52(7.34) |
| **11-16 01:00** | 4 | 0/0/3/1 |  | 1 | 96 | 16 | 876 | **18** | 3 | 98.9 | 01:14(6.17) |
| **11-16 01:15** | 4 | 0/0/2/2 |  | 1 | 98.9 | 15 | 883 | **23** | 0 | — | — |
| **11-16 01:30** | 4 | 0/0/1/3 |  | 1 | 98.9 | 15 | 1733 | **20** | 2 | — | — |
| **11-16 01:45** | 5 | 0/0/4/1 |  | 1 | 98.9 | 12 | 2678 | **15** | 2 | 30.2 | — |
| **11-16 02:00** | 4 | 0/0/1/3 |  | 1 | 98.9 | 16 | 3541 | **21** | 1 | — | — |
| **11-16 02:15** | 8 | 0/0/6/0 | ec-crawl 02:27 | 1 | 98.9 | 11 | 3751 | **3** | 6 | 7.7 | — |
| **11-16 02:30** | 7 | 0/1/5/0 |  | 4 | 100 | 3 | 161 | **3** | 5 | 100 | 02:38(8.09) 02:40(10.51) 02:42(8.82); hold set 02:38:27 (2nd sample) |
| **11-16 02:45** | 1 | 0/0/0/1 |  | 4 | 98 | 0 | 667 | **24** | 0 | — | — |
| **11-16 03:00** | 5 | 0/0/4/1 |  | 4 | 98 | 14 | 1397 | **12** | 5 | 1.2 | — |
| 11-16 03:15 | 8 | 0/8/0/0 |  | 0 | 0.1 | 0 | 37 | 0 | 7 | 0.1 | — |
| 11-16 03:30 | 7 | 0/6/0/0 | fe-crawl 03:43 | 0 | 3.8 | 0 | 37 | 0 | 8 | 3.8 | hold H-a ends 03:42:25 |
| 11-16 03:45 → 05:45 | 7–8 | 0 | fe-inbound-rollup-refresh, ec-crawl ×3, vote-stats-refresh, fe-crawl ×2, fe-vacuum-analyze | 0 | 55.9 | 0 | 37 | 0 | 7–8 | 84.1 | — |
| **11-16 06:00** | 7 | 2/1/0/0 | refresh-derived-mvs-daily 06:01 | 3 | 97.3 | 0 | 165 | **3** | 7 | 100 | 06:12(6.26); hold set 06:12:25 (3rd sample) |
| 11-16 06:15 | 8 | 0/3/5/0 |  | 5 | 100 | 3 | 165 | 0 | 7 | 100 | 06:16(7.96) 06:18(6.13) |
| 11-16 06:30 | 7 | 0/7/0/0 |  | 0 | 4 | 0 | 37 | 0 | 8 | 4 | — |
| 11-16 06:45 | 8 | 0/8/0/0 |  | 0 | 0.4 | 0 | 37 | 0 | 7 | 0.4 | — |
| 11-16 07:00 | 7 | 0/7/0/0 |  | 0 | 1.7 | 0 | 37 | 0 | 8 | 1.7 | — |
| 11-16 07:15 | 8 | 0/2/0/0 | fr-vacuum-analyze 07:19, ec-crawl 07:21, fe-crawl 07:25, rule-taggers-daily 07:27 | 1 | 97 | 0 | 38 | 0 | 7 | 97 | hold H-b ends 07:18:24 → 4 arms in 8 min |
| **11-16 07:30** | 2 | 0/0/0/1 |  | 0 | 66.1 | 10 | 271 | **22** | 4 | 95 | — |
| **11-16 07:45** | 1 | 0/0/1/0 |  | 0 | 41.4 | 14 | 524 | **32** | 0 | — | — |
| **11-16 08:00** | 0 | 0/0/0/0 |  | — | — | — | — | **34** | 1 | — | — |
| **11-16 08:15** | 4 | 0/0/1/3 |  | 0 | 32.4 | 22 | 281 | **15** | 2 | 32.4 | — |
| **11-16 08:30** | 4 | 0/0/4/0 |  | 0 | — | 15 | 1075 | **15** | 0 | — | — |
| **11-16 08:45** | 6 | 0/0/6/0 |  | 0 | 0.2 | 10 | 1803 | **11** | 2 | 0.2 | — |
| 11-16 09:00 | 7 | 0/0/2/0 | ec-crawl 09:05, fe-crawl 09:07 | 0 | 3.6 | 5 | 37 | 0 | 7 | 98.9 | 09:14(7.44) |
| **11-16 09:15** | 5 | 0/0/2/0 |  | 1 | 98.9 | 15 | 522 | **16** | 2 | 88 | — |
| **11-16 09:30** | 6 | 0/0/5/1 |  | 1 | 54 | 15 | 180 | **8** | 6 | 54 | — |
| **11-16 09:45** | 6 | 0/0/2/0 | ec-crawl 09:45 | 1 | 95.7 | 10 | 37 | **10** | 5 | 95.7 | 09:58(6.26) |
| **11-16 10:00** | 6 | 0/0/5/1 |  | 0 | 39.4 | 10 | 411 | **8** | 5 | 39.4 | — |
| 11-16 10:15 → 11:45 | 7–8 | 0 | ec-crawl, fe-crawl, ec-vacuum-analyze | 0 | 0.4 | 0 | 37 | 0 | 7–8 | 94.1 | — |
| 11-16 12:00 | 7 | 2/0/0/0 | fe-crawl 12:01, ec-crawl 12:03, donor-rollup-refresh 12:13 | 3 | 99.4 | 0 | 37 | 0 | 8 | 99.4 | — |
| 11-16 12:15 | 8 | 0/2/0/0 | ec-crawl 12:23 | 2 | 100 | 0 | 47 | 0 | 7 | 100 | 12:24(8.03) 12:26(9.9); hold set 12:26:23 (2nd sample) |
| **11-16 12:30** | 4 | 0/2/2/0 |  | 1 | 95.4 | 8 | 278 | **15** | 4 | 100 | 12:30(10.74) 12:32(9.19) |
| **11-16 12:45** | 7 | 0/0/7/0 |  | 1 | 98.9 | 13 | 300 | **6** | 5 | 98.9 | 12:56(7.26) |
| **11-16 13:00** | 4 | 0/0/3/1 |  | 0 | 80 | 14 | 508 | **14** | 4 | 80 | — |
| **11-16 13:15** | 8 | 0/2/6/0 |  | 2 | 99.9 | 7 | 875 | **3** | 6 | 99.9 | 13:26(7.3) 13:28(6.92); hold extended 13:28:24 |
| **11-16 13:30** | 6 | 0/1/5/0 |  | 3 | 100 | 5 | 167 | **8** | 5 | 100 | 13:30(6.69) 13:36(7.33) 13:38(7.75) 13:40(7.44) |
| **11-16 13:45** | 4 | 0/0/3/1 |  | 4 | 97.2 | 8 | 402 | **15** | 2 | 95.1 | 13:52(7.68) |
| **11-16 14:00** | 7 | 0/1/6/0 |  | 4 | 6.5 | 13 | 37 | **3** | 8 | 6.5 | — |
| 11-16 14:15 | 8 | 0/8/0/0 |  | 0 | 0.1 | 0 | 37 | 0 | 7 | 0.1 | — |
| 11-16 14:30 | 7 | 0/7/0/0 |  | 0 | 2.6 | 0 | 37 | 0 | 8 | 2.6 | — |
| 11-16 14:45 | 8 | 0/4/0/0 | fe-crawl 14:53, odbt-vacuum-analyze 14:59 | 0 | 67 | 0 | 37 | 0 | 7 | 67 | hold H-c ends 14:52:24 |
| 11-16 15:00 → 17:45 | 7–8 | 0 | fe-crawl ×6 | 0 | 0.2 | 0 | 37 | 0 | 7–8 | 4.6 | — |
| 11-16 18:00 | 7 | 0/0/0/0 | fe-crawl 18:13 | 0 | 0.1 | 0 | 37 | 0 | 8 | 3.1 | ecs-vacuum due 18:07, held 12 ticks (group ec) |
| 11-16 18:15 | 8 | 0/0/0/0 | ec-crawl 18:27 | 0 | 0.2 | 0 | 37 | 0 | 7 | 0.2 | ec-crawl armed 18:27 (−06:05:34): an orphaned running row held it live from 12:57 |
| 11-16 18:30 | 7 | 0/0/0/0 | ecs-vacuum-analyze 18:33, fe-crawl 18:43 | 0 | 82.2 | 0 | 37 | 0 | 8 | 82.2 | ecs-vacuum armed 18:33:01 (−00:26:00) |
| 11-16 18:45 → 21:00 | 7–8 | 0 | ec-crawl ×10, fe-crawl ×4, ec-vacuum-analyze, nightly, officials-vacuum-analyze | 0 | 86.2 | 0 | 41 | 0 | 6–8 | 100 | — |
| 11-16 21:15 | 8 | 3/0/0/0 | fe-crawl 21:21, ec-crawl 21:29 | 4 | 100 | 0 | 40 | 0 | 7 | 100 | — |
| 11-16 21:30 → 00:00 | 7–8 | 0 | ec-crawl ×9, fe-crawl ×6, entity-tags-vacuum-analyze, agency-staffing-rollup-refresh | 0 | 69.5 | 0 | 39 | 0 | 7–8 | 100 | — |
| 11-17 00:15 | 8 | 0/0/0/0 | donor-rollup-refresh 00:15, odt-vacuum-analyze 00:21, ec-crawl 00:25, osdr-vacuum-analyze 00:27 | 1 | 99.9 | 0 | 37 | 0 | 7 | 86.3 | donor bulk armed 00:15:00 on streak 1 (99.9 %, 27.86 MB/s) |
| 11-17 00:30 | 7 | 0/0/0/0 | ec-crawl 00:41, fe-crawl 00:43 | 0 | 0.1 | 0 | 37 | 0 | 8 | 100 | — |
| 11-17 00:45 | 8 | 1/0/0/0 | refresh-derived-mvs-weekly 00:47 | 2 | 94.1 | 0 | 37 | 0 | 7 | 94.1 | — |
| 11-17 01:00 → 01:15 | 7–8 | 0 | ec-crawl, fe-crawl | 0 | 61.1 | 0 | 37 | 0 | 7–8 | 100 | — |
| 11-17 01:30 | 7 | 0/0/0/0 | ec-crawl 01:33 | 0 | 3 | 0 | 36 | 0 | 8 | 66.1 | closing unit armed 01:33, reaped 01:39:00 |

**The holds** (the mirror's samples; the ring's at :22 the same minute):

| hold | set | io % / all-disk MB/s at the set | sample of the streak | refreshed | throttle_until (final) | skips under it (mirror ≤ 180 s / > 180 s) | arms inside |
|---|---|---|---|---|---|---|---|
| H-a | 02:38:27Z | 97 / 8.09 | 2nd | 02:40:23, 02:42:25 | 03:42:25Z | io_throttled 15 / 0, fork_failures 6 / 0, stale 0 / 2 | none (fe-crawl 03:43:01) |
| H-b | 06:12:25Z | 97.3 / 6.26 | 3rd: the 2nd (06:08, 96.2 %) read 27.56 MB/s, over the floor | 06:16:36, 06:18:24 | 07:18:24Z | io_throttled 28 / 0, fork_failures 5 / 0 | none (fr-vacuum-analyze 07:19:01) |
| H-c | 12:26:23Z | 100 / 9.9 | 2nd | 12:32:24, 13:28:24, 13:30:23, 13:38:24, 13:40:31, 13:52:24 | 14:52:24Z | io_throttled 27 / 0, fork_failures 24 / 8, stale 0 / 2 | none (fe-crawl 14:53:02) |

- **No ARMED row since 11-13 carries a `throttle_until` later than its arm.**
  The three arms that carry one each came 36–38 s after it expired.
- **No `box: io_throttled` skip was stamped on a stale mirror.** Twelve skips
  fell under a standing hold with the mirror > 180 s old. Each was refused
  first by `stale` (4) or `fork_failures` (8), which rank above the hold.
- **Startup timeouts: 414 on 11-16, all 00:00 → 14:02Z.** 137 fell before the
  pass's first arm, under the donor bulk's staging (armed 23:35:01Z on a
  streak of 1) and the `schedule:` fallback, which failed open on its
  `already_ran` read at 00:34:20Z. **277 fell inside the pass.** Of those,
  103 were under a hold (H-a 36, H-b 3, H-c 64) and 174 were outside one.
  171 of the 174 came in 07:30 → 10:15Z. That stall began when H-b expired
  and four units armed in eight minutes: fr-vacuum-analyze, ec-crawl,
  fe-crawl (97 %, 128.84 MB/s, streak 1, ran 2,876.8 s against a p50 of
  0.1 s) and rule-taggers-daily (83.3 %, ran 5,116.1 s against a p50 of
  181.1 s). The ring then gapped 30 and 32 min, and no hold was set again
  until 12:26Z.
- **H2** (60–89.9 % at ≤ 12 MB/s): 18 box rows on 11-16, 15 of them in the
  pass, and 17 ring samples. **H3** (a stale mirror with
  `startup_timeouts_10m` 1 or 2): 0.

**Beside it:**

- **11-02** (§2): 270 startup timeouts 03:45 → 08:15Z, no rung.
- **11-09** (cc-266): 306 in 05:00 → 11:15Z under `io_samples` 3. There were
  two holds (08:32:25Z, 14:23Z) and one arm into a standing hold, on a 404 s
  mirror (donor-rollup-refresh 08:39:49Z).
- **11-16:** 414, 277 of them in the pass, under `io_samples` 2. There were
  three holds and no arm into one.

## The calibration (11-11 → 11-19) (cc-294, read-only)

**Verdict: no bucket is claimed.** No candidate measure is proportional to
the dashboard's "Disk IO % consumed" across the nine days (the STOP row of
cc-294's read 7). The closest is minutes ≥ 90 % `io_time`, and it misses two
1 % days by 13 and 15 points.

**Sources.** Every off-box ring dump on disk was used: cc-271's (11-11
19:58Z → 11-13 01:54Z), cc-280's (11-14 20:22 → 23:20Z), cc-286's (11-15
20:36Z → 11-17 02:34Z) and cc-294's (11-18 19:24Z → 11-20 01:22Z). An
interval is taken only between two samples of one dump. Reads come from the
cumulative counters, so they are exact across a gap. Writes come from the
route's rates, so they are missing in a gap > 6 min. The counters carry no
write ops, so **ops are reads only**. Root = every disk minus `/data`. Busy
minutes for the UTC hours the ring does not cover come from the banked
`busy_instants` (files 11-12 → 11-20; none truncated), at 2 min each. The
dashboard numbers are Craig's. 11-17's final reading is 23 %, the same value
he read at 03:19Z; 11-18 and 11-19 are 1 % each.

| UTC day | dashboard | ring coverage (samples / 720; gap) | read GB `/data` / root / both | write GB both | read Mops both | GB over 11 MB/s `/data` / root / both | Mops over 500/s `/data` / both | busy min (full day) |
|---|---:|---|---|---:|---:|---|---|---:|
| 11-11 | 1 | 19:58 → 24:00 (121) | 17.1 / 30.7 / 47.8 | 14.5 | 2.12 | 13.3 / 1.7 / 19.8 | 0.44 / 0.55 | 0 |
| 11-12 | 1 | **full** (718) | 212.0 / 193.7 / 405.6 | 75.9 | 18.28 | 114.1 / 14.7 / 182.0 | 4.81 / 6.66 | 8 |
| 11-13 | 1 | 00:00 → 01:54 (58) | 1.8 / 12.9 / 14.7 | 3.9 | 0.67 | 0 / 1.2 / 2.1 | 0 / 0.07 | 2 |
| 11-14 | 1 | 20:22 → 23:20 (90) | 102.9 / 32.1 / 135.1 | 31.1 | 6.03 | 85.7 / 1.4 / 103.9 | 2.93 / 3.50 | 16 |
| 11-15 | 19 | 20:36 → 24:00 (102) | 219.2 / 64.4 / 283.7 | 109.4 | 17.12 | 207.7 / 13.1 / 279.0 | 9.38 / 12.02 | 10 |
| 11-16 | 96 | **full** (588; 4.20 h in gaps) | 449.6 / 248.3 / 697.9 | 142.8 | 32.82 | 320.2 / 12.2 / 398.0 | 11.26 / 13.86 | 108 |
| 11-17 | 23 | 00:00 → 02:34 (78) | 97.2 / 27.4 / 124.6 | 20.0 | 7.53 | 68.4 / 2.8 / 89.1 | 4.36 / 5.18 | 20 (14 by 02:34) |
| 11-18 | 1 | 19:24 → 24:00 (138) | 28.8 / 36.2 / 65.0 | 17.5 | 2.65 | 14.9 / 2.5 / 25.0 | 0.45 / 0.60 | 18 |
| 11-19 | 1 | **full** (720) | 170.6 / 183.7 / 354.3 | 73.6 | 13.25 | 107.6 / 9.3 / 152.2 | 2.12 / 3.39 | 2 |

**The fits.** Least squares through the origin; residuals are predicted minus
read, in points.

| measure | fit on the 3 full days: rms / max | fit on all 9: rms / max | implied 100 % (all 9) | worst residuals (all 9) |
|---|---|---|---|---|
| GB over 11 MB/s, both | 27.7 / 31.7 | 19.2 / 37.3 | 678 GB | 11-16 −37, 11-12 +26, 11-15 +22, 11-19 +21 |
| GB over 11 MB/s, `/data` | 23.7 / 26.8 | 17.6 / 31.9 | 499 GB | 11-16 −32, 11-15 +23, 11-12 +22 |
| GB over 11 MB/s, root | 44.9 / 63.6 | 27.0 / 67.2 | 42 GB | 11-16 −67 |
| Mops over 500/s, both (reads) | 25.6 / 35.0 | 19.7 / 41.7 | 25.5 M | 11-16 −42, 11-15 +28, 11-12 +25 |
| Mops over 500/s, `/data` | 22.8 / 32.9 | 18.8 / 38.9 | 19.7 M | 11-16 −39, 11-15 +29 |
| raw GB r+w, both | 33.1 / 34.8 | 20.2 / 37.6 | 1,440 GB | 11-16 −38, 11-12 +32 |
| raw read Mops, both | 30.7 / 35.7 | 19.0 / 34.9 | 54 M | 11-16 −35, 11-12 +33 |
| **minutes ≥ 90 % `io_time`** (full day) | **3.5 / 6.1** | **7.9 / 14.5** | **116 min** | **11-18 +14.5, 11-14 +12.8, 11-15 −10.4** |

Sweeping the baseline (11 → 60 MB/s; 500 → 3,000 ops/s), whether summed per
day or run as a drain/refill bucket carried across midnight, does not beat
busy minutes. The best sweep, ops over ~2,500/s, reads the volume's own
3,000-IOPS ceiling, so it measures the same thing as busy minutes. At the
published baselines the bucket model is self-contradictory. 11-15's evening
drained 11.9 M ops, or 276 GB, without a throttle. 11-16's 12:26Z throttle
onset stood at 4.9 M ops, or 229 GB, of depletion.

**What the dashboard is not.**

- It is not a day's sum. Both full 1 % days carry 152–182 GB over 11 MB/s.
  The daily backup's 11:15–12:00Z sequential read (130–150 MB/s) is 43–58 GB
  of that on each day read, yet the days read 1 %.
- 11-17's final equals its 03:19Z reading, although 3 busy samples (6 min)
  came after it. This repeats 11-02's 88 → 88 (§1). The figure behaves like a
  level reached early in the day and not added to afterwards.

**Per-unit costs, in raw units** (no bucket, so no percentages). An interval
with k unit kinds live is split 1/k. Unit spans come from `data_sync_log` and
from `dispatch_log` (armed → reaped) for the VACUUMs.

- **One post-landing ecs window**, the 11-16 pass's 16, alone: ~250 s, 2 busy
  min, 6–10 GB over 11 MB/s (median 6.4), 0.45–0.64 M read ops over 500/s.
- **The 11-16 pass** (02:27Z Mon → 01:39Z Tue): 114 busy min, 483.7 GB over
  11 MB/s, 18.9 M ops over 500/s.

| unit kind | busy min | GB over 11 MB/s | share | Mops over 500/s |
|---|---:|---:|---:|---:|
| ec-crawl ecs windows | 28 | 105.1 | 21.7 % | 7.21 |
| ec-crawl donations windows | 23 | 96.7 | 20.0 % | 3.10 |
| no unit running (autovacuum, checkpoints, the landing's tail) | 20 | 96.2 | 19.9 % | 1.16 |
| rollups / MVs (incl. the 00:47Z weekly) | 22 | 55.3 | 11.4 % | 3.79 |
| dispatched VACUUMs | 0 | 48.9 | 10.1 % | 0.23 |
| fe-crawl | 5 | 38.4 | 7.9 % | 1.60 |
| donor rollup | 8 | 19.2 | 4.0 % | 0.56 |
| taggers | 5 | 12.8 | 2.7 % | 0.70 |
| the nightly's pipelines (fallback + 21:00Z) | 3 | 11.1 | 2.3 % | 0.54 |

- **Swap traffic on root:** root's own throughput over 11 MB/s in the pass
  was 13.9 GB. Swap-in on file 11-17 was 46.6 GB, 16.7 % of root's 279.2 GB.
  It costs through coincidence with the other units, not on its own.
- **The vote merge's hour (11-18 02:53–02:56Z):** not covered. The ring held
  11-18 only from 19:24Z. The banked instants show 0 busy samples at
  02:53–02:56Z, and 4 (8 min) in 03:08–04:34Z, under ecs windows 5–8 of the
  cycle the merge fell inside (272 → 205 s each, against ~40 s before it).
  The day read 1 %.

**Small's baselines** (1,000 IOPS, 21.75 MB/s), on 11-16:

| measure | on Micro's baselines | on Small's | Small as a share of Micro |
|---|---:|---:|---:|
| GB over the baseline, both | 398.0 | 258.9 | 65 % |
| Mops over the baseline, both | 13.86 | 8.07 | 58 % |
| busy minutes | 108 | 108 | unchanged: they read `/data`'s own ceiling, not the instance baseline |

If the dashboard scaled with either overage, 96 % would read ~62 % (MB) or
~56 % (ops). Neither fits, so no consumed share is claimed. Every one of these
numbers **assumes the bucket is the same size on Small, which is unverified.**

## The 11-23 outage, and the rung with no pause (cc-313, read-only prod)

Sun 11-22's landing (run 45070093713, fec phase 21:05:48 → 23:22:25Z) was
followed by an outage. Prod stopped answering from ~23:45Z. Craig restarted the
project from the dashboard; Postgres shut down at 02:02:10Z and came back
at 02:03:20Z. On Craig's test the dispatcher then ran the rest of the pass with
no `pause`, under the rung as it stood: `io_time_pct_ceiling` 90, `io_samples` 2,
`io_mbps_floor` 12, `io_throttle_hold_min` 60, `max_concurrent_units` 2. Prod
ran the old bodies (FIX-1441, FIX-1439 and FIX-1443 unpushed). Uptime before the
restart: day 18 since 11-05 01:59:17Z.

Sources:

- **The ring:** two off-box banks joined by `at`, with 173 overlapping samples
  identical: `ring-20261123T0218Z.json` (cc-312) and `ring-20261124T0107Z.json`.
- **The Logs API:** `postgres_logs` and `edge_logs`.
- **`dispatch_log`**, `cron.job_run_details`, `data_sync_log` and
  `status_snapshot`.

The ring's disk counters reset at 02:04:22Z because the VM rebooted, so the one
interval across the reboot is not counted.

**The onset, in one line:**

- 23:43:00Z: the first post-landing ec-crawl unit was armed (donations window
  1/16, target 22:47:00Z). It ran 23:47:00 → 00:23:56Z, and the budget
  watchdog cancelled it at 2,205 s.
- fe-crawl (00:39:00 → 01:16:38Z, a 2,249 s slice, cancelled) and
  donor-rollup-refresh (00:41:04 → 01:22:06Z) then ran side by side. The
  donor rollup was killed by its 2,400 s transaction timeout at 01:21:09Z, so
  its staging never committed.
- A second ec-crawl unit started 01:37:00Z and was in flight at the shutdown.
- `edge_logs` 5xx:
  - 18 / 97 at 23:45Z;
  - 64 / 87 at 00:00Z;
  - 53 / 65 at 00:45Z;
  - **214 / 216 at 01:00Z** (192 × 503, 22 × 504, 0 × 52x);
  - 120 / 152 at 01:15Z;
  - 2 / 295 at 01:30Z;
  - 84 / 136 at 01:45Z;
  - 122 / 247 at 02:00Z (114 × 52x, the restart);
  - 0 / 212 from 02:15Z.
- `postgres_logs`: 280 PostgREST statement timeouts (23:22 → 02:01Z), with no
  OOM, signal, `server process` or recovery line.

**B1, clean or crash: clean.**

- 02:02:10Z: `terminating connection due to administrator command`, which is a
  fast shutdown.
- 02:03:20Z: `the database system is starting up`.
- Every `stats_reset` is unchanged:
  - `pg_stat_statements_info` 2026-10-25 13:25:52.563285Z;
  - `pg_stat_bgwriter` / `pg_stat_checkpointer` / `pg_stat_io`
    13:25:53.578037Z.
- The cumulative counters survived, and the UNLOGGED staging is intact:
  - `fec_emit_keys` 13,732,065 live rows, 1.82 GB;
  - `_drb_fe` 5,387,636;
  - `_drb_targets` 584;
  - `fec_emit_runs` 28.
- `_drb_chunk_fe`, `_drb_donor` and `ec_donations_incr_dirty` read 0. Each was
  last analyzed by its own writer, at 03:16:52Z and 00:24:18Z.

**A1, the ring:** 15-min buckets from 11-22 21:00Z to the read (11-24 01:06Z).
Runs of quiet buckets (no sample ≥ 90 %, load1 < 3) are merged.

| 15-min bucket (Z) | samples | swap max MB | MemAvail min MB | swap-in / swap-out p95 (pg/s) | all-disk read MB/s p95 / max | all-disk r+w MB/s p95 / max | io_time max % | load1 max | samples ≥ 90 % |
|---|---:|---:|---:|---|---|---|---:|---:|---:|
| 11-22 21:00 → 22:45 (8 buckets; p95 = the worst bucket's) | 60 | 567 | 298 | 623.5 / 1146.8 | 35.9 / 35.9 | 52.7 / 52.7 | 81.1 | 2.8 | 0 |
| 11-22 23:00 | 8 | 532 | 349 | 470.6 / 881.8 | 43.6 / 43.6 | 51.1 / 51.1 | 100 | 3.8 | 1 |
| 11-22 23:15 | 7 | 508 | 360 | 570.9 / 529 | 78.3 / 78.3 | 125.2 / 125.2 | 100 | 3.1 | 3 |
| 11-22 23:30 | 7 | 547 | 320 | 852.5 / 1279.9 | 58.1 / 58.1 | 80.7 / 80.7 | 100 | 4.9 | 1 |
| 11-22 23:45 | 4 | 514 | 324 | 357.9 / 401.7 | 64.9 / 64.9 | 89.8 / 89.8 | 75.5 | 13.7 | 0 |
| 11-23 00:00 | 1 | 509 | 371 | — / — | — / — | — / — | — | 15.7 | 0 |
| 11-23 00:15 | 4 | 488 | 311 | 191.9 / 278.8 | 8.4 / 8.4 | 9.4 / 9.4 | 54.1 | 16.4 | 0 |
| 11-23 00:30 | 5 | 578 | 323 | 361.8 / 751.7 | 6.8 / 6.8 | 10 / 10 | 2.3 | 0.8 | 0 |
| 11-23 00:45 | 0 | — | — | — / — | — / — | — / — | — | — | 0 |
| 11-23 01:00 | 1 | 442 | 366 | — / — | — / — | — / — | — | 11.4 | 0 |
| 11-23 01:15 | 4 | 502 | 389 | 196.6 / 262 | 8.7 / 8.7 | 10.4 / 10.4 | 11.2 | 10.4 | 0 |
| 11-23 01:30 | 8 | 436 | 368 | 335.8 / 494.4 | 22.1 / 22.1 | 30.1 / 30.1 | 100 | 3.6 | 3 |
| 11-23 01:45 | 1 | 450 | 346 | — / — | — / — | — / — | — | 19.4 | 0 |
| 11-23 02:00 | 6 | 493 | 346 | 756.2 / 657.2 | 137.3 / 137.3 | 141.8 / 141.8 | 96.4 | 2.8 | 2 |
| 11-23 02:15 → 06:00 (16 buckets; p95 = the worst bucket's) | 120 | 511 | 307 | 715.3 / 1098.7 | 85.6 / 85.6 | 95.8 / 95.8 | 89.7 | 1.7 | 0 |
| 11-23 06:15 | 7 | 369 | 366 | 257.4 / 321.1 | 68.4 / 68.4 | 78.8 / 78.8 | 90.8 | 1.9 | 1 |
| 11-23 06:30 | 8 | 468 | 319 | 358.7 / 555 | 33.1 / 33.1 | 37.2 / 37.2 | 94.8 | 1.3 | 1 |
| 11-23 06:45 → 11:30 (20 buckets; p95 = the worst bucket's) | 150 | 697 | 221 | 874.1 / 1337.8 | 89.7 / 89.7 | 119.4 / 119.4 | 84.7 | 2.8 | 0 |
| 11-23 11:45 | 7 | 597 | 278 | 298.3 / 429.7 | 136.8 / 136.8 | 139.8 / 139.8 | 97.6 | 1.7 | 2 |
| 11-23 12:00 → 16:00 (17 buckets; p95 = the worst bucket's) | 128 | 654 | 274 | 700.6 / 1009 | 65.4 / 65.4 | 101 / 101 | 83.9 | 2.4 | 0 |
| 11-23 16:15 | 7 | 385 | 289 | 225.2 / 203.3 | 43.9 / 43.9 | 45.5 / 45.5 | 98.7 | 1.4 | 1 |
| 11-23 16:30 | 8 | 504 | 375 | 350 / 782.7 | 7 / 7 | 10.5 / 10.5 | 1.9 | 0.3 | 0 |
| 11-23 16:45 | 7 | 481 | 314 | 330.5 / 495.6 | 44.2 / 44.2 | 45.8 / 45.8 | 95.1 | 1.6 | 1 |
| 11-23 17:00 | 8 | 511 | 379 | 470.3 / 1215.2 | 11.9 / 11.9 | 17.3 / 17.3 | 3.3 | 0.7 | 0 |
| 11-23 17:15 | 7 | 366 | 310 | 301.1 / 279 | 48.1 / 48.1 | 50.8 / 50.8 | 97.7 | 1.2 | 1 |
| 11-23 17:30 | 8 | 506 | 349 | 447.4 / 1069.3 | 12.5 / 12.5 | 17.2 / 17.2 | 3.5 | 0.4 | 0 |
| 11-23 17:45 | 7 | 420 | 326 | 341.2 / 418.2 | 47.8 / 47.8 | 49.3 / 49.3 | 100 | 1.2 | 1 |
| 11-23 18:00 | 8 | 528 | 256 | 336.8 / 728.5 | 6.9 / 6.9 | 9.5 / 9.5 | 3.9 | 0.2 | 0 |
| 11-23 18:15 | 7 | 385 | 302 | 124.6 / 173.8 | 43.5 / 43.5 | 44.8 / 44.8 | 100 | 1 | 1 |
| 11-23 18:30 | 8 | 408 | 323 | 332 / 392.2 | 25.4 / 25.4 | 27.6 / 27.6 | 47.4 | 0.6 | 0 |
| 11-23 18:45 | 7 | 437 | 349 | 273.9 / 213.2 | 43.8 / 43.8 | 45.8 / 45.8 | 63.8 | 0.9 | 0 |
| 11-23 19:00 | 8 | 411 | 274 | 397 / 798.3 | 32 / 32 | 37.7 / 37.7 | 97.6 | 1.6 | 1 |
| 11-23 19:15 | 7 | 419 | 374 | 137.9 / 219.8 | 9.6 / 9.6 | 15.1 / 15.1 | 6.2 | 0.3 | 0 |
| 11-23 19:30 | 8 | 500 | 319 | 301.2 / 657.9 | 43 / 43 | 44 / 44 | 98.4 | 2 | 1 |
| 11-23 19:45 | 7 | 364 | 362 | 166.2 / 268.3 | 5.8 / 5.8 | 7.1 / 7.1 | 0.2 | 0.2 | 0 |
| 11-23 20:00 | 8 | 456 | 326 | 848.3 / 1071 | 53.6 / 53.6 | 58.5 / 58.5 | 100 | 1.8 | 1 |
| 11-23 20:15 | 7 | 408 | 381 | 49.1 / 172 | 4.4 / 4.4 | 5.3 / 5.3 | 0.3 | 0.2 | 0 |
| 11-23 20:30 | 8 | 464 | 268 | 627 / 783 | 42.9 / 42.9 | 42.8 / 42.8 | 100 | 1.3 | 1 |
| 11-23 20:45 | 7 | 405 | 388 | 117.5 / 223.6 | 5.8 / 5.8 | 6.9 / 6.9 | 0.1 | 0.2 | 0 |
| 11-23 21:00 | 8 | 465 | 293 | 456.4 / 575.8 | 41.3 / 41.3 | 41.9 / 41.9 | 100 | 1.5 | 1 |
| 11-23 21:15 | 7 | 393 | 309 | 164.1 / 199.2 | 32.2 / 32.2 | 47.4 / 47.4 | 100 | 1.6 | 1 |
| 11-23 21:30 | 8 | 463 | 362 | 406.9 / 743.7 | 41.1 / 41.1 | 42.4 / 42.4 | 97.8 | 1.5 | 1 |
| 11-23 21:45 | 7 | 391 | 349 | 101.3 / 244.6 | 5 / 5 | 6.2 / 6.2 | 0.2 | 0.4 | 0 |
| 11-23 22:00 | 8 | 456 | 325 | 450.4 / 492 | 41.9 / 41.9 | 42 / 42 | 97.6 | 1.4 | 1 |
| 11-23 22:15 | 7 | 450 | 357 | 99.1 / 335.8 | 5 / 5 | 6.6 / 6.6 | 0.4 | 0.1 | 0 |
| 11-23 22:30 | 8 | 497 | 332 | 373.9 / 525.5 | 40.3 / 40.3 | 41.8 / 41.8 | 94.6 | 1.6 | 1 |
| 11-23 22:45 | 7 | 440 | 365 | 184.2 / 341.6 | 9.4 / 9.4 | 10.4 / 10.4 | 12.3 | 0.3 | 0 |
| 11-23 23:00 | 8 | 507 | 323 | 542.6 / 986.5 | 40.9 / 40.9 | 41.2 / 41.2 | 64.6 | 1 | 0 |
| 11-23 23:15 | 7 | 428 | 277 | 87.7 / 231.7 | 28.3 / 28.3 | 29.7 / 29.7 | 100 | 1.4 | 1 |
| 11-23 23:30 → 00:30 (5 buckets; p95 = the worst bucket's) | 38 | 506 | 270 | 431.8 / 796.4 | 40.8 / 40.8 | 53.7 / 53.7 | 84.8 | 1.1 | 0 |
| 11-24 00:45 | 7 | 509 | 284 | 226.4 / 281.9 | 27.1 / 27.1 | 29.3 / 29.3 | 90.8 | 1.2 | 3 |
| 11-24 01:00 | 4 | 561 | 229 | 410.4 / 548.7 | 33.2 / 33.2 | 38.6 / 38.6 | 100 | 1.8 | 1 |

- **Gaps over 6 min:**
  - 23:48:22 → 23:56:22Z (8);
  - 23:58:22 → 00:14:22Z (16);
  - **00:38:22 → 01:12:22Z (34, the longest)**;
  - 01:12:22 → 01:20:22Z (8);
  - 01:44:22 → 01:58:22Z (14).
  - Two more read exactly 6.0 min: 00:18 → 00:24Z, and 01:58 → 02:04Z
    across the restart.
- **The samples that bracket the gaps** read load1 13.7–19.4 with `io_time`
  unrated (23:56Z, 00:14–00:26Z, 01:12–01:24Z and 01:58Z).
- **The ten samples before the longest gap** read swap 405–578 MB, MemAvailable
  311–486 MB, all-disk 1.3–10 MB/s and io 0.2–54.1 %.
- **01:40–01:44Z** read io 97–100 % at 7.5–8.5 MB/s and 248–279 reads/s: the
  throttle shape.
- **After the reboot,** 02:06–02:10Z read 124–142 MB/s at 75–96 %.

**B3, the dispatcher's view** (cc-286 read 3's columns), 11-22 23:00Z →
11-24 00:30Z. Runs with no skip, no startup timeout and no busy-at-floor
sample are merged. **Bold** = startup timeouts.

| 15-min bucket (Z) | ticks | io_sat / io_thr / fork / stale skips | armed | streak max | io max | st10 max | mirror age max | startup timeouts | ring n | ring io max | busy ≥ 90 % at ≤ 12 MB/s (MB/s) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 11-22 23:00 | 7 | 0/0/0/0 |  | — | — | — | — | 0 | 8 | 100 | — |
| 11-22 23:15 | 8 | 1/0/0/0 | fe-crawl 23:23 | 2 | 100 | 0 | 37 | 0 | 7 | 100 | — |
| **11-22 23:30** | 7 | 1/0/5/0 | ec-crawl 23:43 | 2 | 100 | 3 | 149 | **3** | 7 | 100 | — |
| **11-22 23:45** | 4 | 0/0/0/1 | entity-tags-vacuum-analyze 23:45, osdr-vacuum-analyze 23:49 | 0 | 63 | 3 | 38 | **15** | 4 | 75.5 | — |
| **11-23 00:00** | 4 | 0/0/2/3 |  | 0 | 75.5 | 12 | 933 | **9** | 1 | — | — |
| **11-23 00:15** | 5 | 0/0/4/1 |  | 0 | 10.1 | 13 | 564 | **17** | 4 | 54.1 | — |
| 11-23 00:30 | 7 | 0/0/3/0 | fe-crawl 00:37, donor-rollup-refresh 00:39 | 0 | 2.3 | 5 | 38 | 0 | 5 | 2.3 | — |
| **11-23 00:45** | 2 | 0/0/0/1 |  | 0 | 0.2 | 14 | 1128 | **17** | 0 | — | — |
| **11-23 01:00** | 1 | 0/0/0/1 |  | 0 | 0.2 | 13 | 2108 | **35** | 1 | — | — |
| **11-23 01:15** | 3 | 0/0/3/0 |  | 0 | 3.5 | 12 | 2921 | **12** | 4 | 11.2 | — |
| 11-23 01:30 | 7 | 0/1/2/0 | ec-crawl 01:35, odt-vacuum-analyze 01:37, osdr-vacuum-analyze 01:39 | 2 | 100 | 3 | 38 | 0 | 8 | 100 | 01:40(8.45) 01:42(8.1) 01:44(7.55) |
| **11-23 01:45** | 3 | 0/1/0/2 |  | 3 | 97.4 | 7 | 827 | **13** | 1 | — | — |
| **11-23 02:00** | 5 | 0/2/3/0 |  | 3 | 96.4 | 8 | 133 | **6** | 6 | 96.4 | — |
| 11-23 02:15 | 8 | 0/8/0/0 |  | 0 | 0.3 | 2 | 37 | 0 | 7 | 0.3 | — |
| 11-23 02:30 | 7 | 0/7/0/0 |  | 0 | 3.3 | 0 | 37 | 0 | 8 | 3.3 | — |
| 11-23 02:45 → 11:30 | 7–8 | 0 | donor-rollup-refresh, fe-crawl ×15, fe-inbound-rollup-refresh, vote-stats-refresh, fe-vacuum-analyze, refresh-derived-mvs-daily, rule-taggers-daily, fr-vacuum-analyze, ec-crawl ×8, ec-vacuum-analyze ×2 | 1 | 94.8 | 0 | 38 | 0 | 7–8 | 94.8 | — |
| 11-23 11:45 | 8 | 1/0/0/0 | fe-crawl 11:47, ec-crawl 11:57 | 2 | 97.6 | 0 | 38 | 0 | 7 | 97.6 | — |
| 11-23 12:00 → 00:15 | 7–8 | 0 | fe-crawl ×25, ec-crawl ×23, ec-vacuum-analyze, donor-rollup-refresh, ecs-vacuum-analyze, nightly, officials-vacuum-analyze, entity-tags-vacuum-analyze, agency-staffing-rollup-refresh | 1 | 97.6 | 0 | 39 | 0 | 7–8 | 100 | — |

**The holds.** One was set, before the restart, and none after it.

| hold | set | io % / MB/s at the set | sample of the streak | refreshed | throttle_until (final) | armed in the 6 min before | running at the set |
|---|---|---|---|---|---|---|---|
| H | 01:42:23.78Z | 100 / 8.1 | 2nd (01:40:22Z, 100 % / 8.45 MB/s, was the 1st) | 01:44:24.74Z (3rd, 97.4 / 7.55) | 02:44:24.74Z | odt-vacuum-analyze 01:37:00Z (0.6 s), osdr-vacuum-analyze 01:39:08Z (0.8 s) | ec-crawl (armed 01:35:01Z, run 01:37:00Z, donations window 1/16 of a new cycle) |

- **Skips under H, by mirror age (≤ 180 s / > 180 s):** `io_throttled` 19 / 0,
  `fork_failures` 3 / 0, `stale` 0 / 2.
- **No arm inside H.** It held across the restart: 17 `io_throttled` ticks
  02:11 → 02:43Z on a cold box that read 0–10 MB/s.
- **The 02:11Z sample** read a streak of 2 at 96.4 % / 141.84 MB/s. The floor
  clause refused it, so it did not extend the hold.

| release | arms in the 10 min after | startup timeouts in the 30 min after | 11-16, beside it |
|---|---|---:|---|
| H, 02:44:24.74Z | donor-rollup-refresh 02:45:01Z (1,746 s; 584 targets; 41.3 GB read) | 0 | H-b's 07:18:24Z release: four arms in 8 min, 171 timeouts in the next 2 h 45 m |

**From the restart to the pass's close** (00:21:25Z 11-24):

- skips: `io_saturated` 1 (11:51Z, the backup), `io_throttled` 17 and
  `fork_failures` 2;
- 89 arms and 2 startup timeouts (02:05:00Z);
- no H1, H2 or H3 row;
- no arm into a standing hold;
- two arms at streak 1 (fe-crawl 06:37Z and 22:13Z, 0.1 s each).

**The pass:**

- Its first ec-crawl unit was at 23:47:00Z 11-22, and it closed at 00:21:25Z
  11-24 (24 h 34 m).
- The 01:37Z unit's `running` row survived the restart reap (02:07:00Z,
  `failed: server restarted`, `end_time` NULL, so it closed 0 rows). The row
  held ec-crawl `live` until its 6 h window lapsed: armed 07:39Z.
- After that: 16 donations windows (07:41 → 15:47Z, 198.6–234.5 s,
  1,299,865 rows) and 16 stats windows (16:17Z → 00:21Z, 276.9 → 122.5 s,
  Σ 3,606.4 s).

**B4, which units spent the IO:** every unit ≥ 60 s from 11-22 21:05Z to the
read, over the ring's counters. MB read is all disks. MB written is the
route's r+w rate minus the counted reads, so it is approximate and is missing
where the ring gapped. Overlapping units are marked, not split. Top 20 of 53
(the full list is in cc-313's report):

| # | unit | span (Z) | wall s | p50 s (14 d) | MB read (all disks) | MB written ≈ | min ≥ 90 % | swap-in MB | overlapped |
|---:|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | nightly | 11-22 21:05:22 → 23:36:25 | 9,063 | 805.2 | 266,789 | 106,792 | 10 | 10,769 | yes |
| 2 | donor-rollup-refresh | 11-23 02:47:00 → 03:16:06 | 1,746 | 0.2 | 41,299 | 9,566 | 0 | 931 |  |
| 3 | fe-crawl | 11-22 23:25:00 → 23:35:38 | 638 | 0.1 | 32,650 | 10,222 | 4 | 1,320 | yes |
| 4 | donor-rollup-refresh (failed: SSL connection has been closed u) | 11-23 00:41:04 → 01:22:06 | 2,462 | 0.2 | 28,589 | 0 (rates 4 %) | 0 | 1,806 | yes |
| 5 | fe-crawl | 11-23 00:39:00 → 01:16:38 | 2,259 | 0.1 | 27,540 | 0 (rates 0 %) | 0 | 1,642 | yes |
| 6 | refresh-derived-mvs-weekly | 11-24 00:49:00 → 01:04:04 | 904 | 1,068.4 | 23,099 | 2,580 | 8 | 676 |  |
| 7 | nightly | 11-23 21:05:22 → 21:21:51 | 989 | 805.2 | 22,357 | 5,051 | 4 | 497 | yes |
| 8 | refresh-derived-mvs-daily | 11-23 06:03:00 → 06:19:01 | 962 | 321.8 | 20,463 | 5,798 | 2 | 488 |  |
| 9 | ec-crawl (failed: ERROR:  canceling statement due ) | 11-22 23:47:00 → 00:23:56 | 2,217 | 48.5 | 19,876 | 0 (rates 35 %) | 0 | 1,650 | yes |
| 10 | fr-vacuum-analyze | 11-23 07:29:00 → 07:31:59 | 180 | 9.8 | 13,636 | 6,035 | 0 | 423 |  |
| 11 | ec-crawl | 11-23 16:49:00 → 16:53:45 | 285 | 48.5 | 10,267 | 699 | 2 | 288 |  |
| 12 | ec-crawl | 11-23 16:17:00 → 16:21:59 | 300 | 48.5 | 10,004 | 594 | 2 | 162 |  |
| 13 | ec-crawl | 11-23 19:29:00 → 19:33:26 | 267 | 48.5 | 9,845 | 777 | 2 | 261 |  |
| 14 | ec-crawl | 11-23 18:57:00 → 19:01:41 | 281 | 48.5 | 9,450 | 626 | 2 | 252 |  |
| 15 | ec-crawl | 11-23 20:01:00 → 20:05:24 | 265 | 48.5 | 9,213 | 774 | 2 | 367 |  |
| 16 | ec-crawl | 11-23 17:53:00 → 17:57:34 | 275 | 48.5 | 9,189 | 474 | 2 | 210 |  |
| 17 | ec-crawl | 11-23 17:21:00 → 17:25:32 | 273 | 48.5 | 9,172 | 500 | 2 | 182 |  |
| 18 | ec-crawl (failed: server restarted) | 11-23 01:37:00 → 02:02:10 | 1,510 | 48.5 | 9,088 | 0 (rates 29 %) | 6 | 633 |  |
| 19 | ec-crawl | 11-23 18:25:00 → 18:29:28 | 268 | 48.5 | 8,500 | 478 | 2 | 91 |  |
| 20 | ec-crawl | 11-23 21:05:00 → 21:09:14 | 255 | 48.5 | 8,296 | 528 | 2 | 171 | yes |

**By kind:**

| unit kind | units | wall s | GB read | min ≥ 90 % | swap-in GB |
|---|---:|---:|---:|---:|---:|
| nightly | 2 | 10,052 | 289.1 | 14 | 11.27 |
| ec-crawl stats windows | 16 | 3,972 | 133.0 | 28 | 3.05 |
| fe-crawl | 6 | 3,755 | 86.8 | 4 | 3.30 |
| ec-crawl donations windows | 16 | 3,468 | 86.5 | 0 | 2.13 |
| donor-rollup-refresh | 2 | 4,209 | 69.9 | 0 | 2.74 |
| MVs / taggers | 3 | 2,082 | 49.7 | 12 | 1.41 |
| dispatched VACUUMs | 6 | 738 | 45.2 | 0 | 1.32 |
| ec-crawl (cut: cancelled / restarted) | 2 | 3,727 | 29.0 | 6 | 2.28 |

**Per UTC day, all disks:**

| UTC day | dashboard (Craig) | ring samples / 720 | read GB | write GB ≈ | min ≥ 90 % | swap-in GB | startup timeouts |
|---|---:|---:|---:|---:|---:|---:|---:|
| 11-22 | 18 % | 716 | 678 | 204 | 12 | 45.5 | 18 |
| 11-23 | 100 % (at 01:58Z) | 682 | 755 | 132 | 48 | 35.5 | 109 |

- 11-23's no-unit reads were 283 GB, including the backup window
  (11:15–12:00Z, 60.8 GB) and the post-reboot warm-up.

**Beside the three Mondays:**

- **11-02:** dashboard 17 % / 88 %; 270 startup timeouts (03:45 → 08:15Z).
- **11-09:** 306 (05:00 → 11:15Z) under `io_samples` 3; two holds, one arm into
  a hold.
- **11-16:** 19 % / 96 %; 414 (277 in the pass) under `io_samples` 2; three
  holds, none armed into. H-b's release admitted four arms in 8 min, and 171
  followed in 2 h 45 m. The pass ran 23 h 12 min.
- **11-23:** 18 % / 100 %; 127 from the landing (122 between the first
  ec-crawl arm and the restart, 2 after it); one hold, set 60 min into the
  stall, released into one arm. The pass ran 24 h 34 min, cut by a restart.
