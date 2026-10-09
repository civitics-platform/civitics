# FIX-1125 burst census — part 2: observation two, the R2 table, the sampler run, the verdict (cc-203)

Run Fri 2026-10-09 00:04Z onward, worktree `fix-1125`. Design of record: cc-202's
header and cc-203's prompt. Companion files, all in `docs/audits/`:

- `2026-10-07-burst-census-ring-post.json` — the WHOLE 24 h ring, read 2026-10-09T00:07:09.763Z (rule 24). The exclusion is applied by the profile, never by the file.
- `2026-10-07-burst-census-samples.jsonl` — every sampler read (§3), one JSON line per read.
- `2026-10-06-burst-census-ring-pre.json` / `2026-10-06-burst-census-pre.md` — observation one (cc-202).

Units throughout: swap-in / swap-out in **pages/s** (the ring's backward 2-min rates, from `/proc/vmstat` via the privileged metrics endpoint); MemAvailable in **MB**; pgss and `pg_stat_io` blocks are **8 kB**; times in **ms** unless marked.

## 1. Windows, instants, epochs

**The move.** `/api/cron/platform-snapshot` at `7,37` since **2026-10-07T23:57:51Z** (cc-202 §2). Confirmed on main (`apps/civitics/vercel.json:24-25` reads `"7,37 * * * *"`, commit 9f9e3b05) and on prod: the newest `platform_usage_snapshot.fetched_at` at read time was 2026-10-09T00:08:03.663Z and the newest `status_snapshot.fetched_at` 00:08:15.734Z (the column is `fetched_at`, not `captured_at` — cc-202 §4.2). The deploy instant + 24 h (23:57:51Z 10-08) was honoured: this run started at 00:04:21Z 10-09.

**Rule 81's second window: `2026-10-08T17:10Z → 2026-10-08T23:50:00Z`.** The end is **box-clear**, defined as the first `pipeline_state.box_health.at` with `startup_timeouts_10m = 0` AND `box_health_mem` stamped within the previous 4 min with `load1 < 3` (floor 23:30Z).

- `box_health` holds only the latest probe, so the first qualifying probe was reconstructed from `cron.job_run_details` (prod, read-only, 00:09Z):
  - the **last startup timeouts** of the saturation were three at **23:40:00.000Z** (jobids 44, 53, 40 — the budget watchdog, the box-health probe itself and the derived-MVs unit watchdog);
  - the probe (jobid 53) then succeeded every minute from 23:41:00.639Z (that one took 36.5 s) onward;
  - its **23:50:00.076Z** firing is the first whose 10-minute window (`start_time > p_now − 10 min`) no longer holds the 23:40:00.000 failures → `startup_timeouts_10m = 0`;
  - the memory stamp at that instant is the 23:48:22Z ring sample (`box_health_mem` is written by the same scrape a few seconds later): **load1 1.06**, MemAvailable 354 MB.
- **Box-clear = 2026-10-08T23:50:00Z** (≈ .08 s). The first LIVE poll, 2026-10-09T00:06:00.082Z, read the qualifying row verbatim: `startup_timeouts_10m 0, startup_timeouts_60m 30, probe_ms 77.6, backends client 11 / active 1`, mem stamped 00:04:25.047Z with `load1 1.48`, `mem_available_bytes 346,730,496`.
- Not a clean box straight away: the ring read 812–1,436 pages/s swap-in at 23:54–23:58Z and `load1 3.03` at 00:00:22Z. The definition takes the first instant; this paragraph is why the sampler started 45 min after it, not 15.

**Postgres restarted at 2026-10-08T23:42:45.349Z** (`pg_postmaster_start_time()`, prod, 00:13Z). That is the ring's dark stretch 23:32:22 → 23:44:22Z, after which swap in use had fallen 630 → 205 MB. The cumulative statistics survived it (`pg_stat_statements_info.stats_reset` 2026-09-22T22:32:13Z; `pg_stat_io` / `pg_stat_checkpointer` / `pg_stat_bgwriter` / `pg_stat_archiver.stats_reset` 2026-09-15T15:09:48Z; `pg_stat_database.stats_reset` NULL), so it was an orderly restart, not crash recovery. cc-209 recorded it as **Craig's hand restart** (FIX-1291's append, ba9945d8). It ended the saturation; nothing in the census depends on it beyond that.

**Epochs (rule 140, read 4, prod 00:13:18Z).** pgss: `stats_reset` 2026-09-22T22:32:13Z, `dealloc 0`, 3,467 entries of `pg_stat_statements.max` 5,000, **`pg_stat_statements.track = top`** (rule 111 holds on prod: a procedure's inner statements are invisible; 0 entries with `toplevel = false`). `pg_stat_io` / checkpointer / bgwriter / archiver: 2026-09-15T15:09:48Z. Settings that bear on a half-hour reading: `checkpoint_timeout 5min`, `archive_mode on`, **`archive_timeout 2min`**. The archiver had `archived_count 27,868`, `failed_count 1,198`, last failure 2026-10-08T22:50:06Z (inside the window). The sampler takes deltas between its own samples, so none of these epochs moves a number below.

**The PG 17 views, from `pg_attribute` on the clone (17.6; rule 151):**

- `pg_stat_io`: backend_type, object, context, reads, read_time, writes, write_time, writebacks, writeback_time, extends, extend_time, op_bytes, hits, evictions, reuses, fsyncs, fsync_time, stats_reset
- `pg_stat_checkpointer`: num_timed, num_requested, restartpoints_timed, restartpoints_req, restartpoints_done, write_time, sync_time, buffers_written, stats_reset
- `pg_stat_archiver`: archived_count, last_archived_wal, last_archived_time, failed_count, last_failed_wal, last_failed_time, stats_reset
- `pg_stat_bgwriter` (PG 17 keeps only three counters): buffers_clean, maxwritten_clean, buffers_alloc, stats_reset
- `pg_stat_statements` 1.11 adds `toplevel`, `stats_since` and `minmax_stats_since`; the sampler keys entries on `userid::regrole | toplevel | queryid` and reads `stats_since` to tell a reset from a delta.

## 2. Observation two (R1) and the snapshot's clock (R2)

### 2.1 The ring after the move

`node scripts/box-health-minute-profile.mjs docs/audits/2026-10-07-burst-census-ring-post.json --after 2026-10-08T00:07:51Z --exclude 2026-10-08T17:10:00Z..2026-10-08T23:50:00Z`

- The ring returned **616 samples in 24 h**, not 720: 10-08 00:08:22Z → 10-09 00:06:22Z, with the gaps inside the saturation. **After `--after` and `--exclude`: 519 samples** (the prompt expected ≥ 480; ≥ 300 was the STOP).
- `--exclude` / `--within` are new (rule 122: the profile had only `--after`; added in 9845b18a). A row is cut by its STAMP, half-open `[from, to)`, as rule 81 words it. One consequence: the 23:50:22Z sample is kept, and its backward rate covers 23:48:22 → 23:50:22, two minutes before box-clear.

Key minutes, pre-move (observation one, 10-07, n = 22–23) against post-move (outside the window). Each sample's rate is BACKWARD over the previous ~2 min and lands at :x?:22, so ":10" covers :08:22 → :10:22.

| min | covers | pre mean | pre median | post n | post mean | post median | post max | post swap-out mean / median | post Δavail MB | post samples > 240 |
|---|---|---|---|---|---|---|---|---|---|---|
| :00 | :58:22→:00:22 | 43.7 | 20.8 | 18 | 252.7 | 160.2 | 758.8 | 94.1 / 3.8 | −79.7 | 8 / 18 |
| **:02** | :00:22→:02:22 | **399.7** | **335.7** | 18 | 263.9 | 155.6 | 1,913.6 | 365.2 / 225.8 | +35.2 | 7 / 18 |
| :08 | :06:22→:08:22 | 200.0 | 6.0 | 18 | 33.3 | 21.2 | 143.0 | 20.9 / 0 | −12.9 | 0 / 17 |
| **:10** | :08:22→:10:22 | 201.2 | 24.3 | 17 | **399.7** | **381.1** | 620.0 | 343.7 / 295.7 | −62.6 | **17 / 17** |
| :16 | :14:22→:16:22 | 94.9 | 16.4 | 17 | 296.1 | 161.6 | 989.7 | 168.3 / 7.6 | −48.4 | 7 / 17 |
| :30 | :28:22→:30:22 | 60.1 | 21.3 | 17 | 233.7 | 140.2 | 776.7 | 106.2 / 13.8 | −56.7 | 7 / 17 |
| **:32** | :30:22→:32:22 | **331.2** | **295.0** | 17 | 175.7 | 59.4 | 765.6 | 251.9 / 151.2 | +50.7 | 5 / 17 |
| :38 | :36:22→:38:22 | 14.2 | 9.6 | 17 | 20.8 | 14.6 | 65.3 | 11.2 / 0 | −7.5 | 0 / 17 |
| **:40** | :38:22→:40:22 | 40.9 | 38.8 | 17 | **369.7** | **369.1** | 540.2 | 242.7 / 188.3 | −86.9 | **15 / 17** |
| :46 | :44:22→:46:22 | 42.4 | 16.3 | 17 | 228.4 | 37.1 | 849.3 | 140.8 / 11.6 | −36.3 | 7 / 17 |

(Pre-move :02 / :32 were 22 / 23 and 17 / 23 above 240. The pre ":08 mean 200.0" is the single 02:04–02:18Z event cc-202 flagged; compare by median.)

**The burst followed the snapshot, one sample later than the prompt predicted.** It did not land in :08/:38 (medians 21.2 / 14.6, 0 of 34 samples above 240). It landed in **:10/:40**, the :08:22→:10:22 window: 32 of 34 samples above 240, medians 381.1 / 369.1. Pre-move it sat in [+0:22, +2:22] after the cron instant, post-move in [+1:22, +3:22]. The intersection, **+1:22 → +2:22 after the fire**, is where the swap-in happens. A 7-minute move lands an odd-minute shift on an even-minute sampler, and a lag past +1:22 puts the whole burst in the second sample. The prompt's ":08/:38" assumed a lag under +1:22.

**But :02/:32 did not fall to the background over the whole day, and that is a different signal.** Split the out-of-window hours by what ec-crawl (`*/15`) did in them (prod `cron.job_run_details`, per-hour wall). On 10-08 ec-crawl ran real units 09:00–16:59Z (101–291 s of wall per hour, single units to 159 s) and again at 05:00Z (29 s). On 10-07 it never exceeded 32 s/h. fe-crawl read ~0 s/h all day until 18:00Z.

| min | ec-crawl idle hours (00–04, 06–08, 17; n = 8) mean / median | ec-crawl busy hours (05, 09–16, 23 tail; n = 9) mean / median |
|---|---|---|
| :00 | 105.1 / 63.4 | 327.6 / 359.7 |
| :02 | **73.6 / 10.6** | 426.5 / 265.6 |
| :08 | 16.2 / 6.9 | 48.5 / 34.0 |
| **:10** | **371.3 / 371.0** | **424.8 / 395.9** |
| :16 | 36.2 / 27.7 | 527.1 / 551.8 |
| :30 | 147.1 / 63.6 | 310.6 / 330.0 |
| :32 | **119.3 / 48.4** | 225.9 / 59.4 |
| :38 | 14.3 / 7.2 | 26.5 / 20.6 |
| **:40** | **331.7 / 328.9** | **403.4 / 392.9** |
| :46 | 43.0 / 26.0 | 393.3 / 270.7 |
| other | 46.5 / 15.3 (n = 159) | 90.4 / 29.3 (n = 185) |

- In ec-idle hours :02/:32 are background (means 73.6 / 119.3, medians 10.6 / 48.4) and the burst is wholly at :10/:40.
- In ec-busy hours EVERY quarter-hour minute is raised (:00, :02, :16, :30, :46 all with medians 265–552). That is ec-crawl's `*/15`, not a half-hour signature, and it does not exist in observation one.
- n = 8 and 9 per minute (rule 175): the split is read for its SHAPE, which every quarter-hour minute shares, not for a ratio.

The hour-by-minute grid behind the split (swap-in, pages/s, rounded):

```
hr    :00   :02   :04   :10   :16   :30   :32   :40   :46
 0    759   322   449   392    24    49    44   383    10
 1     14    40     1   371    89   144    73   328    32
 2     12     2     -   381    52    64     4   354    37
 3     92    33    45   324    28   272    64   232    25
 4     86    11     6   409    30   107    98   364    36
 5    337   114    16   467   162    50    28   379    10
 6    434   490   803   451    37   499   621   329   158
 7     63    11    46   333    12    16     2   369    19
 8     62     2    58   310    19    26    48   295    26
 9     58  1914  2137   461   357   140     2   427   271
10    160   158    10   372   308   132     5   371   245
11    366   299     3   620   228   330    59   540   249
12    234   160    72   396   552   398   240   360   714
13    360   318    50   357   705   484   766   239   552
14    476   455   787   410   990   777   632   434   849
15    494   156   150   373   788   444   272   488   625
16    464   266    45   367   655    41    30   393    25
17     79     1    43   310   398     0   535  1029   359   ← 17:10Z onward is the window
18    831   751   400   943   696   393   420  1200   610   ← window
19    450   869   554   985   315     -     -     -     -   ← window
```

(10-08 06:00 is the 06:00 stack; 09:02–09:04 is the donor-rollup 09:00 burst cc-192 saw, out of scope.)

**Verdict: A — the route owns the half-hour burst.**
- All outside hours, n = 17–18 per minute: :10 / :40 = **399.7 / 369.7** (medians 381.1 / 369.1) against pre-move 201.2 / 40.9; :02 / :32 = **263.9 / 175.7** (medians 155.6 / 59.4) against pre-move 399.7 / 331.2; :08 / :38 = 33.3 / 20.8.
- ec-crawl-idle hours, n = 8: :10 / :40 = 371.3 / 331.7; :02 / :32 = 73.6 / 119.3.
- By the prompt's literal thresholds over all hours the :02/:32 means are C-shaped (raised, below pre-move). The residual is ec-crawl's `*/15` on 10-08 only, and it raises :16/:46 by as much as :02/:32. It is not a second half-hour owner. §4 carries this to the filing.

**Excluded — saturation, not a verdict** (`--within 2026-10-08T17:10:00Z..2026-10-08T23:50:00Z`, 97 samples, 17:10:22 → 23:48:22Z): means :02 810.4 (n 2), :32 368.4 (n 4), :08 196.9 (n 3), :38 183.9 (n 2), :10 745.7 (n 3), :40 1,114.3 (n 3), every other minute 444.5 (n 78). That is a 6 h swap-in regime at 300–1,200 pages/s at every minute, and it has no half-hour signature to read.

**With the window NOT excluded** (`--after` only, all 616 rows): means :02 318.5, :32 212.4, :08 50.5, :38 37.9, :16 322.1, :46 245.1. The exclusion lowers :02 by 54.6 and :32 by 36.7, and leaves the verdict unchanged.

### 2.2 R2 — the snapshot's clock against the burst, by tick

48 post-move ticks (10-08 00:07 → 23:37Z). The status half has **no row for 19:37 → 23:37Z** (nine ticks; the route wrote neither table during the saturation), so 39 ticks carry a row. `usage end` = `platform_usage_snapshot.fetched_at − tick`; `route end` = `status_snapshot.fetched_at − tick` (the insert's `NOW()`, i.e. the end of the status compute); `status ms` = `query_time_ms`; the slowest section is the largest top-level `section_times` key. Ring columns are the :08 (:06:22→:08:22) and :10 (:08:22→:10:22) samples after the tick (pages/s; Δavail vs the previous sample, MB).

| tick | usage end s | route end s | status ms | slowest section ms | :08 swapin | :08 swapout | :08 Δavail MB | :10 swapin | :10 swapout | :10 Δavail MB | in-window |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 00:07 | 54.8 | 61.6 | 6208 | pipelines 6198 | — | — | — | 391.9 | 565.6 | -60 | no |
| 00:37 | 58.2 | 69.8 | 10328 | self_tests 10320 | 33.7 | 0.4 | 3 | 382.5 | 83.8 | -161 | no |
| 01:07 | 63.3 | 71.7 | 7322 | self_tests 7314 | 4.9 | 0 | -1 | 371 | 216.6 | -94 | no |
| 01:37 | 55.1 | 62.9 | 6716 | pipelines 6708 | 26.8 | 0 | -25 | 327.7 | 115.3 | -127 | no |
| 02:07 | 57 | 64.8 | 6717 | pipelines 6708 | 4.1 | 0 | -12 | 381.1 | 251.1 | -71 | no |
| 02:37 | 59.4 | 67.3 | 6562 | pipelines 6554 | 25 | 0 | -34 | 354.4 | 13.1 | -176 | no |
| 03:07 | 57.5 | 65.7 | 6863 | pipelines 6857 | 21.8 | 0 | -15 | 324.2 | 325.4 | -26 | no |
| 03:37 | 63.6 | 69.8 | 4956 | pipelines 4949 | 7.2 | 0 | 1 | 231.6 | 38.2 | -103 | no |
| 04:07 | 63.9 | 72.2 | 7114 | self_tests 7108 | 10.4 | 0 | -4 | 409.1 | 584.7 | 20 | no |
| 04:37 | 54.9 | 63.8 | 7524 | self_tests 7515 | 5.6 | 0 | 10 | 364 | 186.3 | -86 | no |
| 05:07 | 61.9 | 71.5 | 8072 | self_tests 8065 | 60.4 | 0 | -37 | 467 | 295.7 | -102 | no |
| 05:37 | 61.1 | 68.5 | 6265 | self_tests 6257 | 7.7 | 0 | 4 | 379 | 513.3 | -33 | no |
| 06:07 | 61.7 | 72.7 | 9800 | self_tests 9794 | 58.7 | 120.9 | 5 | 451 | 424.7 | -33 | no |
| 06:37 | 69.5 | 77.1 | 6148 | pipelines 6140 | 9.3 | 0 | -7 | 328.9 | 558.5 | 24 | no |
| 07:07 | 64.8 | 71.8 | 5893 | pipelines 5887 | 17.5 | 0 | -12 | 332.6 | 205.4 | -70 | no |
| 07:37 | 62.6 | 71.3 | 7392 | pipelines 7383 | 4.6 | 0 | -12 | 369.1 | 30 | -155 | no |
| 08:07 | 59 | 65.9 | 5806 | self_tests 5799 | 5.2 | 0 | 0 | 309.8 | 71.4 | -117 | no |
| 08:37 | 63.1 | 69.6 | 5469 | self_tests 5463 | 2.6 | 0 | 8 | 295.3 | 133.5 | -78 | no |
| 09:07 | 59.1 | 66.3 | 6022 | self_tests 6015 | 80.4 | 69.4 | -29 | 461.2 | 533.7 | -1 | no |
| 09:37 | 64.8 | 75.7 | 9505 | self_tests 9498 | 36.9 | 1.1 | -37 | 426.6 | 327.2 | -65 | no |
| 10:07 | 52.6 | 61.5 | 7559 | self_tests 7552 | 21.2 | 0 | -14 | 372.4 | 103.9 | -135 | no |
| 10:37 | 59.1 | 73.4 | 13069 | self_tests 13063 | 14.6 | 0 | -3 | 371.1 | 188.3 | -65 | no |
| 11:07 | 53.5 | 64.3 | 9678 | self_tests 9672 | 24.6 | 0 | 20 | 620 | 854.2 | 88 | no |
| 11:37 | 59.2 | 68.2 | 8093 | self_tests 8083 | 6.7 | 0 | 3 | 540.2 | 487 | -39 | no |
| 12:07 | 62.9 | 72.1 | 8039 | self_tests 8031 | 16.6 | 0 | -13 | 395.9 | 322 | -16 | no |
| 12:37 | 60.2 | 70.8 | 8986 | self_tests 8980 | 65.3 | 0 | -48 | 360.3 | 203.7 | -86 | no |
| 13:07 | 79.1 | 92.8 | 12319 | self_tests 12313 | 35.8 | 0.1 | -34 | 357 | 42.7 | -154 | no |
| 13:37 | 87.9 | 96.7 | 7702 | self_tests 7692 | 14.4 | 96.5 | 29 | 239.1 | 149.7 | -62 | no |
| 14:07 | 71.6 | 78.2 | 5874 | pipelines 5867 | 143 | 156.2 | -35 | 409.7 | 723.4 | -16 | no |
| 14:37 | 78.6 | 91.5 | 11580 | self_tests 11574 | 31.7 | 0 | -34 | 433.8 | 537.9 | -70 | no |
| 15:07 | 81.8 | 91.1 | 8321 | pipelines 8314 | 20.7 | 0 | -14 | 373.4 | 103.3 | -169 | no |
| 15:37 | 58.4 | 69.5 | 10129 | self_tests 10123 | 40.2 | 88.9 | 13 | 487.6 | 337.7 | -78 | no |
| 16:07 | 66.1 | 74.8 | 7810 | self_tests 7805 | 34 | 8.3 | -13 | 367 | 219.9 | -109 | no |
| 16:37 | 56.6 | 68 | 10199 | self_tests 10194 | 20.6 | 3.9 | 2 | 392.9 | 222 | -117 | no |
| 17:07 | 62.5 | 69.7 | 6304 | self_tests 6295 | 6.9 | 0 | -11 | 309.8 | 106.4 | -97 | no |
| 17:37 | 66.5 | 97 | 28738 | self_tests 28730 | 99.9 | 178.4 | 19 | 1028.8 | 1133.6 | -41 | **yes** |
| 18:07 | 63.2 | 74.1 | 9637 | pipelines 9222 | 118.9 | 179.1 | 9 | 942.9 | 1131.2 | 12 | **yes** |
| 18:37 | 70.1 | 84.4 | 11129 | self_tests 11121 | 267.8 | 330.8 | 19 | 1199.7 | 1330.2 | 4 | **yes** |
| 19:07 | 87.2 | 99.2 | 10764 | pipelines 10756 | 274.9 | 234.7 | -38 | 984.5 | 1166.4 | 10 | **yes** |
| 19:37 | — | — | — | — | — | — | — | — | — | — | **yes** |
| 20:07 | — | — | — | — | — | — | — | — | — | — | **yes** |
| 20:37 | — | — | — | — | — | — | — | — | — | — | **yes** |
| 21:07 | — | — | — | — | — | — | — | — | — | — | **yes** |
| 21:37 | — | — | — | — | — | — | — | — | — | — | **yes** |
| 22:07 | — | — | — | — | — | — | — | — | — | — | **yes** |
| 22:37 | — | — | — | — | — | — | — | — | — | — | **yes** |
| 23:07 | — | — | — | — | — | — | — | — | — | — | **yes** |
| 23:37 | — | — | — | — | — | — | — | — | — | — | **yes** |

**Spearman ρ, outside the window only (ties averaged):**
- ρ(status `query_time_ms`, :10 swap-in) = **0.478, n = 35**
- ρ(route end, :10 swap-in) = **0.002, n = 35**
- ρ(status ms, :08 swap-in) = 0.393, n = 34; ρ(route end, :08 swap-in) = 0.226, n = 34
- ρ(status ms, :10 swap-out) = 0.037, n = 35

(The prompt expected n ≈ 36: there are 35 outside ticks with a :10 sample and a status row. 17:07Z is outside, since 17:07 < 17:10.)

- **The burst is at every tick, not at the slow ones.** All 35 outside ticks read 231.6–620.0 at :10, and the route ended between +61.5 s and +96.7 s on every one of them. The route's END does not predict the burst's size (ρ 0.002). The status compute's LENGTH predicts it moderately (ρ 0.478): a longer `self_tests` / `pipelines` section goes with a bigger burst.
- **The burst lands after the status insert.** `status_snapshot.fetched_at` falls at +61.5 → +96.7 s; the burst sample opens at +82 s. The :08 sample, which holds most of the status compute, is quiet (2.6–143.0). Read with cc-202's pre-move clock (status half +0:50 → +1:30, burst inside +0:22 → +2:22), the swap-in sits in the **~40–80 s after the status compute ends**. That is the sampler's question.

## 3. The sampler run (D2)

### 3.1 What ran

```
node scripts/pgss-tick-sampler.mjs --prod --db-query ../../App/scripts/db-query.mjs \
     --minutes 5,11,35,41 --activity-at 7:30,8:30,9:30,37:30,38:30,39:30 --ticks 4 \
     --not-before 2026-10-09T00:30:00Z --out docs/audits/2026-10-07-burst-census-samples.jsonl
```

- **Verdict A's set, widened by R1.** The prompt's A set was `5,10,35,40` with activity at :07:30/:08:30. R1 put the burst in the :08:22→:10:22 sample, so the closing bracket moved to :11/:41 (after :10:22, still clear of cc-210's :12–:26 / :42–:56) and an activity read was added at :09:30/:39:30 (inside the burst window).
- **The committed file, run from the worktree** at 2ca4a0bd = 9845b18a after the rebase (identical content). `--db-query` points at the primary checkout's `db-query.mjs`, because a worktree's `.env.local.prod` is a stub.
- **First read 00:35:00.20Z**, 45 min after box-clear (≥ + 15 min). Four ticks: 00:37, 01:07, 01:37, 02:07; the cron was still at `7,37` throughout.
- **21 reads:** 8 bracket samples, 12 activity reads and 1 texts read. Every one completed; none was cancelled.
  - Server-side read time: 1.2–173.5 ms (texts 263.7 ms), all under the 2 s STOP.
  - **Skew: 20 of 21 within ±201 ms; tick 3's opening sample was 1,955 ms late** (02:05:01.955Z), which breaks the prompt's ≤ 1 s.
  - The cause: this machine's clock stepped between 01:41 and 02:03. The supplementary read at 02:03:45 was 1.93 s late on the same lead, and both self-corrected on the next read.
  - The bracket still opens 2 min before the route fires, so tick 3's delta covers the same events. The breach is recorded, not hidden.
- **Supplementary reads (a deviation, §3.6):** eight more in-memory reads through the same `db-query --prod`, at 01:31:45 / 01:33:45 / 01:36:45 / 01:38:45 / 02:01:45 / 02:03:45 / 02:06:45 / 02:08:45. They read `pg_stat_activity.backend_start` and `pg_stat_database.sessions`, which the sampler's fixed SQL does not carry. Saved as `2026-10-07-burst-census-backends.jsonl`.
- **The sampler reads pgss WITHOUT text** (`pg_stat_statements(false)`). A validation read at 00:17:13Z with text took 864 ms against 108 ms without, so the texts are one read at the end.

### 3.2 Tick against quiet, per interval

The tick is open → close (6 min, the route inside it). The quiet is close → the next open (24 min).

| interval | min | service_role calls / exec ms / shared_read | postgres exec ms / shared_read | client bulkread blocks | client normal reads | db temp files / MB | checkpoints timed / requested | WAL segs archived |
|---|---|---|---|---|---|---|---|---|
| tick 0 00:35→00:40 | 6 | 318 / 11,850 / 8,224 | 484 / 22 | 140,805 | 9,938 | 13 / 316 | 1 / 0 | 3 |
| quiet after 0 00:40→01:05 | 24 | 1,389 / 36,242 / 34,732 | 903,243 / 2,986,266 | 789,202 | 2,229,570 | 55 / 1,412 | 5 / 0 | 44 |
| tick 1 01:05→01:11 | 6 | 326 / 17,378 / 7,837 | 981 / 2,398 | 77,394 | 17,186 | 13 / 320 | 1 / 0 | 3 |
| quiet after 1 01:11→01:35 | 24 | 76 / 3,401 / 4,580 | 590,300 / 2,183,706 | 746,823 | 1,446,955 | 55 / 1,423 | 5 / 0 | 15 |
| tick 2 01:35→01:40 | 6 | 320 / 12,223 / 8,121 | 491 / 2,035 | 140,225 | 12,270 | 13 / 320 | 1 / 0 | 3 |
| quiet after 2 01:40→02:05 | 24.03 | 103 / 4,479 / 7,912 | 547,891 / 2,112,706 | 746,822 | 1,378,130 | 49 / 1,265 | 5 / 0 | 15 |
| tick 3 02:05→02:11 | 5.97 | 312 / 11,874 / 26,953 | 450 / 2 | 156,985 | 9,973 | 12 / 315 | 1 / 0 | 3 |

- **Nothing in the tick dwarfs the quiet.** Per minute, the quiet ran 3.5–5.8× the tick's client reads (normal + bulkread: 88.6–126 k/min against 15.8–25.4 k/min) and the same temp rate (≈ 53–59 MB/min against 52–53 MB/min in the ticks).
- The quiet's load is ec-crawl catching up on the 10-08 USASpending dirty set: `CALL public.run_entity_connections_rebuild($1, p_max_units := $2)`, **2 units per quiet, 503–562 s exec and 2.09–2.22 M shared reads (16–17 GB) each interval, 3 of 3 quiets**. fe-crawl (`run_fe_totals_crawl`) ran 26–40 s per quiet.
- The route's own pgss work is the same in every tick: **312–326 service_role calls, 11.9–17.4 s total exec, 7.8–27.0 k shared reads, 0 temp blocks**.
- **Checkpoints:** `num_timed` 1 per tick and 5 per quiet, i.e. `checkpoint_timeout 5min` and nothing else. **`num_requested` 0 in every tick and every quiet**, so no backup-requested checkpoint lands on the half hour.
- **Archiver:** 3 segments per 6-min tick (`archive_timeout 2min`), 15–44 per quiet, 0 failures. That is the WAL volume plus the 2-minute timeout, with no half-hour shape.

**Caveat: when these counters move.** `pg_stat_io` and `pg_stat_database` are flushed when a backend goes idle, i.e. at the end of its top-level statement. A long CALL's I/O lands in the bracket it ENDS in, not where it happened. No CALL completed inside any tick (postgres-role exec 0.45–0.98 s per tick).

### 3.3 The route's statements (pgss, the four ticks)

Ranked by Δtemp_blks_written, then Δshared_blks_read. Full tables in §3.9. The same entries lead every tick, `pgrst_source`-wrapped, `service_role`:

- `data_sync_log` (the `pipelines` section): 10 calls, 6.9–8.2 s exec, ~1.3 k blocks per tick;
- one scalar RPC (`pgrst_scalar` over a JSON payload): 1.2–3.8 s, 1.8–2.4 k blocks;
- `officials.source_ids/metadata`: 0.27 s, 2.2–2.6 k blocks;
- `enrichment_queue.*` reads: 2 calls, 0.46–1.5 s, 1.3 k blocks;
- the two inserts (`status_snapshot` 39 ms, `platform_usage_snapshot` 26 ms) and 35 `platform_usage` inserts (41 ms).

**The two candidates the brief named:**
- `get_connection_type_counts` does not appear in any tick (`connection_types` reads 0 ms in `section_times` on every post-move tick).
- The `proposals` reads in the bracket are 205 blocks / 83 ms (`proposals.*`) and 12 blocks / 11 ms (`proposals.id`). Neither is a candidate.

Every tick's #1 by temp is an **`anon`** `officials` read (519–577 temp blocks, 1 call). It recurs in the quiets (1 call there too), so it is site traffic, not the route.

### 3.4 `pg_stat_io`

Per tick: `client backend · bulkread` reads 77,394 / 140,805 / 140,225 / 156,985 blocks; `client backend · normal` reads 9,938–17,186; autovacuum, background worker and checkpointer reads ≈ 0. Per quiet: bulkread 746,822–789,202 and normal 1.38–2.23 M (the crawl).

**The tick's bulkread is a client backend, and the one client statement that ENDS inside every tick and is not in pgss is `get_ec_crawl_health`'s, cancelled at 8 s** (§3.7):
- its `section_times` wall is 8,130 / 8,337 / 8,187 / 8,444 ms on the four ticks;
- the Logs census shows 4 × 57014 `get_ec_crawl_health` in the window;
- its body counts `count(DISTINCT from_id)` over `financial_relationships` rows `updated_at > <EC donations watermark>`: a scan plus a sort.

Inference, not proof: pgss cannot see a cancelled statement (rule 112). This is debris (§4).

### 3.5 Activity

The pool is the observation. The activity reads (§3.9, verbatim) show no active client backend at any :x7:30 / :x8:30 / :x9:30 instant. The route's statements are sub-second each and fall between reads. What they show instead is the PostgREST pool:

- **00:37:30** — only the `LISTEN "pgrst"` backend (pid 2493, born 23:43:05, the restart).
- **00:38:30** — 10 PostgREST backends, contiguous pids 7825–7834, last `COMMIT` 00:38:15–22 (the status half).
- **00:39:30** — the same ten, all touched again at 00:38:45–46.
- **01:07:30** — 11 backends (10641–10653) from a wave at 01:06:30, before the route.
- **01:08:30** — those are gone; 11 new (10672–10682), last used 01:08:15–22.
- **01:09:30** — two of those remain, plus 9 new (10708–10716) used at 01:08:46–47.

### 3.6 Connection churn is NOT the tick's (supplementary reads)

| read (target) | at (server) | sessions | Δ since previous | PostgREST data backends | their backend_start |
|---|---|---|---|---|---|
| 01:31:45 | 01:31:45.651 | 268,344 | — | 11 | 01:30:11 … 01:30:17 |
| 01:33:45 | 01:33:44.398 | 268,367 | 23 | 11 | 01:31:50 … 01:32:23 |
| 01:36:45 | 01:36:44.954 | 268,405 | 38 | 11 | 01:35:40 … 01:36:22 |
| 01:38:45 | 01:38:45.014 | 268,425 | 20 | 11 | 01:37:08 … 01:37:32 |
| 02:01:45 | 02:01:45.668 | 268,633 | 208 | 11 | 02:00:11 … 02:00:17 |
| 02:03:45 | 02:03:46.926 | 268,655 | 22 | 11 | 02:03:01 … 02:03:05 |
| 02:06:45 | 02:06:44.349 | 268,677 | 22 | 11 | 02:03:02 … 02:06:23 |
| 02:08:45 | 02:08:45.038 | 268,697 | 20 | 11 | 02:07:09 … 02:07:10 |

(Each Δ includes the read's own session.)

- PostgREST forks a fresh set of ~11 backends for EVERY burst of concurrent requests (01:30:11, 01:31:50, 01:35:40, 01:37:08, 02:00:11, 02:03:01 …) and reaps them within about 1–2 min. The route's own set (01:37:08–01:37:32, 02:07:09–10) is one of many.
- **Sessions rose 20 per 2 min across both route windows** (01:36:45→01:38:45, 02:06:45→02:08:45), against **23, 22 and 22 per 2 min** in the three control windows (and 38 in 3 min).
- The route adds no connection churn. The fork hypothesis I formed at 00:39 is refuted, and it is recorded here because the activity reads alone would have suggested it.
- `cron.use_background_workers` is `off`: pg_cron jobs connect over libpq, which is most of the ~11/min background.

### 3.7 The Logs complement (rule 112)

`pnpm --filter @civitics/data data:census:cancellations:prod -- --by query --start 2026-10-09T00:35:00Z --end 2026-10-09T02:11:00Z`

One read, run 02:20:05Z (clear of :15/:30 +0–1; rule 190), windowed to the sampler's span and nothing earlier:

| group | 57014 |
|---|---|
| `get_ec_crawl_health` | **4** |
| `search_graph_entities` | 4 |
| `get_official_page` | 1 |
| `proposals` | 1 |
| `SELECT count(*) AS total, count(*) FILTER (WHERE o.metadata …` | 1 |
| `ai_summary_cache` | 1 |
| **total** | **12** in 96 min |

- `--by` attributes and does not time-stamp.
- `get_ec_crawl_health` 4 = one per route tick, matching its 8.1–8.4 s section walls.
- The rest are site reads (`search_graph_entities`, `get_official_page`) with no tick placement.

### 3.8 The ring over the sampler's window

Read 02:25Z, `--hours 3`; not committed: the 24 h file is the observation.

- **The route's burst barely shows tonight.** :10/:40 read 199.9 / 167.0 / 158.0 / 231.3 pages/s (mean 189.1, n 4) and :08/:38 read 12.2 / 41.0 / 14.8 / 35.8. Every other minute averaged 208.5 (n 47).
- **The crawls dominate tonight.** ec-crawl's quarter-hour units read :02 688.7 / 510.5, :32 507.0 / 594.6 and :16 / :46 440.8–558.1.
- So the brackets measured the route on a night when its burst was at background level.
- Answer to "do the crawls register at :00/:30 with the snapshot gone": **yes, tonight, in the catch-up**. They did not on 10-07, and on 10-08 only 09–16Z.

### 3.9 The sampler's `--report` output

`node scripts/pgss-tick-sampler.mjs --report docs/audits/2026-10-07-burst-census-samples.jsonl --top 25`, verbatim. Activity snapshots trimmed to 20 rows each, active first.

#### Reads

| kind | tick | edge | target | at (server) | skew ms | read ms | error |
|---|---|---|---|---|---|---|---|
| sample | 0 | open | 00:35:00Z | 2026-10-09T00:35:00.201881+00:00 | 201 | 109.4 |  |
| activity | 0 |  | 00:37:30Z | 2026-10-09T00:37:29.805547+00:00 | -195 | 5.2 |  |
| activity | 0 |  | 00:38:30Z | 2026-10-09T00:38:30.04124+00:00 | 41 | 48.7 |  |
| activity | 0 |  | 00:39:30Z | 2026-10-09T00:39:30.02869+00:00 | 28 | 11.6 |  |
| sample | 0 | close | 00:41:00Z | 2026-10-09T00:40:59.955798+00:00 | -45 | 35 |  |
| sample | 1 | open | 01:05:00Z | 2026-10-09T01:05:00.037685+00:00 | 37 | 160.1 |  |
| activity | 1 |  | 01:07:30Z | 2026-10-09T01:07:29.984544+00:00 | -16 | 1.7 |  |
| activity | 1 |  | 01:08:30Z | 2026-10-09T01:08:30.044253+00:00 | 44 | 4.3 |  |
| activity | 1 |  | 01:09:30Z | 2026-10-09T01:09:29.989324+00:00 | -11 | 1.2 |  |
| sample | 1 | close | 01:11:00Z | 2026-10-09T01:11:00.00388+00:00 | 3 | 37.4 |  |
| sample | 2 | open | 01:35:00Z | 2026-10-09T01:35:00.033478+00:00 | 33 | 55.2 |  |
| activity | 2 |  | 01:37:30Z | 2026-10-09T01:37:30.019102+00:00 | 19 | 6 |  |
| activity | 2 |  | 01:38:30Z | 2026-10-09T01:38:29.979606+00:00 | -21 | 1.2 |  |
| activity | 2 |  | 01:39:30Z | 2026-10-09T01:39:30.031471+00:00 | 31 | 4.2 |  |
| sample | 2 | close | 01:41:00Z | 2026-10-09T01:40:59.976352+00:00 | -24 | 29.6 |  |
| sample | 3 | open | 02:05:00Z | 2026-10-09T02:05:01.955274+00:00 | 1,955 | 173.5 |  |
| activity | 3 |  | 02:07:30Z | 2026-10-09T02:07:29.979931+00:00 | -21 | 1.7 |  |
| activity | 3 |  | 02:08:30Z | 2026-10-09T02:08:30.004897+00:00 | 4 | 1.3 |  |
| activity | 3 |  | 02:09:30Z | 2026-10-09T02:09:29.992138+00:00 | -8 | 1.8 |  |
| sample | 3 | close | 02:11:00Z | 2026-10-09T02:11:00.055354+00:00 | 55 | 35.9 |  |
| texts |  |  | — | 2026-10-09T02:11:00.57354+00:00 | — | 263.7 |  |

#### Tick 0 — 00:35:00Z → 00:40:59Z

Tick interval 6 min; quiet interval 00:40:59Z → 01:05:00Z, 24 min. pgss entries reset inside the tick: 0.

**pgss top 25** (ranked by Δtemp_blks_written, then Δshared_blks_read; blocks are 8 kB; ms = total_exec_time) — tick vs the quiet interval after it

| # | role | queryid | status | Δcalls | Δexec ms | Δshared_read | Δtemp_written | Δwal bytes | quiet Δcalls | quiet Δexec ms | quiet Δshared_read | quiet Δtemp_written | query |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | anon | 1508858691171407755 | ok | 1 | 142.1 | 28 | 519 | 0 | 1 | 776.2 | 17 | 402 | `WITH pgrst_source AS ( SELECT "public"."officials"."id", "public"."officials"."full_name", "public"."officials` |
| 2 | service_role | 261368320601411136 | ok | 1 | 1,231 | 2,396 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (SELECT pgrst_call.pgrst_scalar FROM (SELECT $1 AS json_data) pgrst_payload, LATERAL (SEL` |
| 3 | service_role | 2554425566920005236 | ok | 1 | 275.1 | 2,188 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."officials"."source_ids", "public"."officials"."metadata" FROM "public"` |
| 4 | service_role | -2421107269687758048 | ok | 10 | 7,680.2 | 1,338 | 0 | 6,052 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."data_sync_log"."pipeline", "public"."data_sync_log"."status", "public"` |
| 5 | service_role | 2620195143544750333 | ok | 2 | 826.6 | 1,320 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."enrichment_queue".* FROM "public"."enrichment_queue" WHERE "public"."e` |
| 6 | service_role | 8455176733294703641 | ok | 2 | 290.3 | 312 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (SELECT pgrst_call.pgrst_scalar FROM (SELECT $1 AS json_data) pgrst_payload, LATERAL (SEL` |
| 7 | anon | 4936605479865170683 | ok | 6 | 320.4 | 301 | 0 | 0 | 12 | 67.1 | 201 | 0 | `WITH pgrst_source AS ( SELECT "public"."entity_tags"."entity_id", "public"."entity_tags"."tag", "public"."enti` |
| 8 | service_role | -6404761789365416609 | ok | 2 | 82.8 | 205 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."proposals".* FROM "public"."proposals" WHERE "public"."proposals"."sta` |
| 9 | service_role | -6696635423447632495 | ok | 1 | 191 | 189 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (SELECT "pgrst_call".* FROM (SELECT $1 AS json_data) pgrst_payload, LATERAL (SELECT "p_da` |
| 10 | anon | -2045323968914584561 | ok | 1 | 40.5 | 41 | 0 | 0 | 3 | 1,017.7 | 82 | 0 | `WITH pgrst_source AS ( SELECT "public"."official_homepage_stats_mv"."official_id", "public"."official_homepage` |
| 11 | service_role | 7229084577808365084 | ok | 1 | 587.6 | 32 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."data_sync_log"."pipeline", "public"."data_sync_log"."completed_at", "p` |
| 12 | service_role | -4993992466744859843 | ok | 1 | 13.9 | 30 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (SELECT pgrst_call.pgrst_scalar FROM (SELECT "public"."get_supabase_auth_mau"() pgrst_sca` |
| 13 | service_role | 3453641684384573199 | ok | 1 | 39.1 | 27 | 0 | 142,009 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (INSERT INTO "public"."status_snapshot"("error", "payload", "query_time_ms", "section_tim` |
| 14 | anon | 670723039596070302 | ok | 1 | 11.4 | 27 | 0 | 0 | 3 | 107.1 | 54 | 0 | `WITH pgrst_source AS ( SELECT "public"."agencies"."id", "public"."agencies"."name", "public"."agencies"."short` |
| 15 | service_role | 854284877495226294 | ok | 1 | 28 | 26 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."enrichment_queue".* FROM "public"."enrichment_queue" WHERE "public"."e` |
| 16 | service_role | -8163617005886991080 | ok | 1 | 27.7 | 26 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."enrichment_queue".* FROM "public"."enrichment_queue" WHERE "public"."e` |
| 17 | service_role | -7585905412265968687 | ok | 1 | 15.7 | 22 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (SELECT "pgrst_call".* FROM "public"."get_supabase_self_metrics"() pgrst_call) SELECT $3:` |
| 18 | service_role | -7143699471244390991 | ok | 1 | 25.7 | 21 | 0 | 87,419 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (INSERT INTO "public"."platform_usage_snapshot"("any_critical", "any_warning", "error", "` |
| 19 | anon | -4500003832951230167 | ok | 1 | 17.3 | 21 | 0 | 0 | 3 | 371.8 | 188 | 0 | `WITH pgrst_source AS ( SELECT "public"."officials"."id", "public"."officials"."full_name", "public"."officials` |
| 20 | service_role | 2896657904173213369 | ok | 35 | 40.7 | 16 | 0 | 20,571 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (INSERT INTO "public"."platform_usage"("metric", "period_start", "recorded_at", "service"` |
| 21 | postgres | 2762051918779143514 | ok | 3 | 32.7 | 14 | 0 | 4,278 | 12 | 3,929.6 | 441 | 0 | `SELECT public.enforce_derived_mvs_unit_budget()` |
| 22 | service_role | 8041890013005832657 | ok | 1 | 11.4 | 12 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."proposals"."id" FROM "public"."proposals" WHERE "public"."proposals"."` |
| 23 | service_role | 130051690042343360 | ok | 1 | 7.7 | 11 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (SELECT "pgrst_call".* FROM "public"."get_drift_source_presence"() pgrst_call) SELECT $3:` |
| 24 | service_role | 1045774767069509405 | ok | 2 | 9.1 | 10 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (SELECT "pgrst_call".* FROM "public"."chord_industry_flows"() pgrst_call) SELECT $3::bigi` |
| 25 | service_role | 1945587259687017174 | ok | 1 | 260 | 9 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (SELECT pgrst_call.pgrst_scalar FROM (SELECT $1 AS json_data) pgrst_payload, LATERAL (SEL` |

**Per role** (Σ over pgss entries; tick | quiet)

| role | Δcalls | Δexec ms | Δshared_read | Δtemp_written | Δwal bytes | quiet Δcalls | quiet Δexec ms | quiet Δshared_read | quiet Δtemp_written |
|---|---|---|---|---|---|---|---|---|---|
| service_role | 318 | 11,850 | 8,224 | 0 | 281,246 | 1,389 | 36,242 | 34,732 | 0 |
| anon | 88 | 622 | 495 | 519 | 0 | 789 | 12,962 | 3,089 | 402 |
| postgres | 35 | 484 | 22 | 0 | 7,956 | 246 | 903,243 | 2,986,266 | 0 |
| pgbouncer | 19 | 29 | 3 | 0 | 0 | 41 | 165 | 86 | 0 |
| supabase_admin | 55 | 11 | 0 | 0 | 13,232 | 265 | 536 | 52 | 0 |
| authenticator | 86 | 4 | 0 | 0 | 0 | 263 | 27 | 0 | 0 |

**pg_stat_io** (per backend_type / object / context; reads/writes/extends in op_bytes units = 8 kB blocks)

| backend_type | object | context | reads | writes | extends | hits | evictions | reuses | writebacks | fsyncs | quiet reads | quiet writes | quiet evictions |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| client backend | relation | bulkread | 140,805 | 0 | 0 | 2 | 38 | 140,767 | 0 | 0 | 789,202 | 35 | 835 |
| client backend | relation | normal | 9,938 | 0 | 6 | 164,132 | 9,944 | 0 | 0 | 0 | 2,229,570 | 195,060 | 2,229,659 |
| background writer | relation | normal | 0 | 292 | 0 | 0 | 0 | 0 | 320 | 0 | 0 | 68,315 | 0 |
| checkpointer | relation | normal | 0 | 256 | 0 | 0 | 0 | 0 | 256 | 24 | 0 | 1,659 | 0 |
| autovacuum worker | relation | normal | 19 | 0 | 0 | 2,339 | 19 | 0 | 0 | 0 | 872 | 58 | 873 |
| autovacuum worker | relation | vacuum | 13 | 0 | 0 | 30 | 13 | 0 | 0 | 0 | 220,199 | 51 | 311 |
| background worker | relation | normal | 9 | 0 | 0 | 1,127 | 9 | 0 | 0 | 0 | 652 | 37 | 643 |

**checkpointer / bgwriter / archiver / database** (tick → quiet)

- checkpointer: tick { num_timed 1, num_requested 0, restartpoints_timed 0, restartpoints_req 0, restartpoints_done 0, write_time 25,736, sync_time 113, buffers_written 256 } — quiet { num_timed 5, num_requested 0, restartpoints_timed 0, restartpoints_req 0, restartpoints_done 0, write_time 321,517, sync_time 205, buffers_written 1,659 }
- bgwriter: tick { buffers_clean 292, maxwritten_clean 0, buffers_alloc 9,905 } — quiet { buffers_clean 68,315, maxwritten_clean 619, buffers_alloc 2,232,887 }
- archiver: tick { archived_count 3, failed_count 0 } — quiet { archived_count 44, failed_count 0 }
- database: tick { temp_files 13, temp_bytes 331,098,833, blks_read 151,082, blks_hit 165,572, xact_commit 574 } — quiet { temp_files 55, temp_bytes 1,480,462,306, blks_read 3,250,987, blks_hit 14,239,512, xact_commit 2,608 }

**pg_stat_activity at 2026-10-09T00:37:29.805547+00:00** (20 rows; active first)

| pid | backend_type | application_name | usename | state | wait | xact_start | query_start | query |
|---|---|---|---|---|---|---|---|---|
| 1174 | pg_net 0.20.0 worker | pg_net 0.20.0 | supabase_admin | — | Extension:Extension | — | — | `` |
| 1173 | archiver |  | — | — | Activity:ArchiverMain | — | — | `` |
| 1171 | walwriter |  | — | — | Activity:WalWriterMain | — | — | `` |
| 1169 | background writer |  | — | — | Activity:BgwriterHibernate | — | — | `` |
| 1175 | pg_cron launcher | pg_cron scheduler | supabase_admin | — | Extension:Extension | — | — | `` |
| 1172 | autovacuum launcher |  | — | — | Activity:AutovacuumMain | — | — | `` |
| 1168 | checkpointer |  | — | — | Activity:CheckpointerMain | — | — | `` |
| 1176 | logical replication launcher |  | supabase_admin | — | Activity:LogicalLauncherMain | — | — | `` |
| 2493 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 23:43:05Z | `LISTEN "pgrst"` |
| 7774 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 00:34:29Z | `COMMIT` |
| 7775 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 00:34:29Z | `COMMIT` |
| 7776 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 00:34:29Z | `COMMIT` |
| 7797 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 00:35:49Z | `COMMIT` |
| 7795 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 00:35:49Z | `COMMIT` |
| 7796 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 00:35:49Z | `COMMIT` |
| 7798 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 00:35:49Z | `COMMIT` |
| 7803 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 00:36:18Z | `COMMIT` |
| 7819 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 00:36:22Z | `COMMIT` |
| 1250 | client backend | postgres_exporter | supabase_admin | idle | Client:ClientRead | — | 00:37:12Z | `SELECT extract(epoch from max(current_timestamp - xact_start)) AS xact_runtime FROM pg_stat_activity` |
| 7825 | client backend | Supavisor (auth_query) | pgbouncer | idle | Client:ClientRead | — | — | `` |

**pg_stat_activity at 2026-10-09T00:38:30.04124+00:00** (20 rows; active first)

| pid | backend_type | application_name | usename | state | wait | xact_start | query_start | query |
|---|---|---|---|---|---|---|---|---|
| 1172 | autovacuum launcher |  | — | — | Activity:AutovacuumMain | — | — | `` |
| 1168 | checkpointer |  | — | — | Activity:CheckpointerMain | — | — | `` |
| 1176 | logical replication launcher |  | supabase_admin | — | Activity:LogicalLauncherMain | — | — | `` |
| 1175 | pg_cron launcher | pg_cron scheduler | supabase_admin | — | Extension:Extension | — | — | `` |
| 1174 | pg_net 0.20.0 worker | pg_net 0.20.0 | supabase_admin | — | Extension:Extension | — | — | `` |
| 1173 | archiver |  | — | — | Activity:ArchiverMain | — | — | `` |
| 1171 | walwriter |  | — | — | Activity:WalWriterMain | — | — | `` |
| 1169 | background writer |  | — | — | Activity:BgwriterMain | — | — | `` |
| 2493 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 23:43:05Z | `LISTEN "pgrst"` |
| 1250 | client backend | postgres_exporter | supabase_admin | idle | Client:ClientRead | — | 00:38:12Z | `SELECT setting as connection_count FROM pg_settings WHERE name = 'max_connections';` |
| 7834 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 00:38:15Z | `COMMIT` |
| 7827 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 00:38:15Z | `COMMIT` |
| 7832 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 00:38:15Z | `COMMIT` |
| 7829 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 00:38:16Z | `COMMIT` |
| 7828 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 00:38:16Z | `COMMIT` |
| 7830 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 00:38:16Z | `COMMIT` |
| 7833 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 00:38:16Z | `COMMIT` |
| 7826 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 00:38:18Z | `COMMIT` |
| 7825 | client backend | Supavisor (auth_query) | pgbouncer | idle | Client:ClientRead | — | 00:38:18Z | `SELECT * FROM pgbouncer.get_auth($1)` |
| 7831 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 00:38:22Z | `COMMIT` |

**pg_stat_activity at 2026-10-09T00:39:30.02869+00:00** (20 rows; active first)

| pid | backend_type | application_name | usename | state | wait | xact_start | query_start | query |
|---|---|---|---|---|---|---|---|---|
| 1174 | pg_net 0.20.0 worker | pg_net 0.20.0 | supabase_admin | — | Extension:Extension | — | — | `` |
| 1173 | archiver |  | — | — | Activity:ArchiverMain | — | — | `` |
| 1171 | walwriter |  | — | — | Activity:WalWriterMain | — | — | `` |
| 1169 | background writer |  | — | — | Activity:BgwriterHibernate | — | — | `` |
| 1168 | checkpointer |  | — | — | Activity:CheckpointerMain | — | — | `` |
| 1172 | autovacuum launcher |  | — | — | Activity:AutovacuumMain | — | — | `` |
| 1176 | logical replication launcher |  | supabase_admin | — | Activity:LogicalLauncherMain | — | — | `` |
| 1175 | pg_cron launcher | pg_cron scheduler | supabase_admin | — | Extension:Extension | — | — | `` |
| 2493 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 23:43:05Z | `LISTEN "pgrst"` |
| 7832 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 00:38:45Z | `COMMIT` |
| 7829 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 00:38:45Z | `COMMIT` |
| 7828 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 00:38:45Z | `COMMIT` |
| 7830 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 00:38:45Z | `COMMIT` |
| 7833 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 00:38:45Z | `COMMIT` |
| 7831 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 00:38:46Z | `COMMIT` |
| 7826 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 00:38:46Z | `COMMIT` |
| 7834 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 00:38:46Z | `COMMIT` |
| 7827 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 00:38:46Z | `COMMIT` |
| 1250 | client backend | postgres_exporter | supabase_admin | idle | Client:ClientRead | — | 00:39:13Z | `SELECT slot_name, pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS realtime_lag_bytes, active A` |
| 7867 | client backend | Supavisor (auth_query) | pgbouncer | idle | Client:ClientRead | — | — | `` |

#### Tick 1 — 01:05:00Z → 01:11:00Z

Tick interval 6 min; quiet interval 01:11:00Z → 01:35:00Z, 24 min. pgss entries reset inside the tick: 0.

**pgss top 25** (ranked by Δtemp_blks_written, then Δshared_blks_read; blocks are 8 kB; ms = total_exec_time) — tick vs the quiet interval after it

| # | role | queryid | status | Δcalls | Δexec ms | Δshared_read | Δtemp_written | Δwal bytes | quiet Δcalls | quiet Δexec ms | quiet Δshared_read | quiet Δtemp_written | query |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | anon | 1508858691171407755 | ok | 1 | 110.8 | 0 | 577 | 0 | 1 | 83.2 | 2,454 | 525 | `WITH pgrst_source AS ( SELECT "public"."officials"."id", "public"."officials"."full_name", "public"."officials` |
| 2 | service_role | 2554425566920005236 | ok | 1 | 277.9 | 2,570 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."officials"."source_ids", "public"."officials"."metadata" FROM "public"` |
| 3 | anon | 8332510295035626829 | ok | 5 | 415 | 2,170 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."proposals"."id" FROM "public"."proposals" ORDER BY "public"."proposals` |
| 4 | postgres | 1859845736403777070 | ok | 6 | 376.7 | 2,041 | 0 | 11,082 | 24 | 12,674 | 9,333 | 0 | `SELECT public.record_box_health()` |
| 5 | service_role | 261368320601411136 | ok | 1 | 3,800.2 | 1,847 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (SELECT pgrst_call.pgrst_scalar FROM (SELECT $1 AS json_data) pgrst_payload, LATERAL (SEL` |
| 6 | service_role | 2620195143544750333 | ok | 2 | 1,546.7 | 1,320 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."enrichment_queue".* FROM "public"."enrichment_queue" WHERE "public"."e` |
| 7 | service_role | -2421107269687758048 | ok | 10 | 8,188.4 | 1,301 | 0 | 9,445 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."data_sync_log"."pipeline", "public"."data_sync_log"."status", "public"` |
| 8 | service_role | 8455176733294703641 | ok | 2 | 133.3 | 314 | 0 | 1,960 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (SELECT pgrst_call.pgrst_scalar FROM (SELECT $1 AS json_data) pgrst_payload, LATERAL (SEL` |
| 9 | anon | 4936605479865170683 | ok | 6 | 260.3 | 294 | 0 | 0 | 12 | 266.4 | 259 | 0 | `WITH pgrst_source AS ( SELECT "public"."entity_tags"."entity_id", "public"."entity_tags"."tag", "public"."enti` |
| 10 | postgres | 8042366906601248217 | new | 1 | 49.5 | 285 | 0 | 0 | 0 | 0 | 0 | 0 | `SELECT p.proname, p.prokind, array_to_string(p.proconfig, $1) AS proconfig, (SELECT string_agg(m[$2], $3 ORDER` |
| 11 | service_role | -6696635423447632495 | ok | 1 | 157.7 | 189 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (SELECT "pgrst_call".* FROM (SELECT $1 AS json_data) pgrst_payload, LATERAL (SELECT "p_da` |
| 12 | anon | -1988485147468028327 | ok | 51 | 57.3 | 146 | 0 | 0 | 1 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."jurisdiction_page_cache"."jurisdiction_id", "public"."jurisdiction_pag` |
| 13 | anon | -4361883710270042138 | ok | 1 | 38.3 | 74 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (SELECT pgrst_call.pgrst_scalar FROM (SELECT $1 AS json_data) pgrst_payload, LATERAL (SEL` |
| 14 | service_role | 7229084577808365084 | ok | 1 | 2,573.1 | 72 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."data_sync_log"."pipeline", "public"."data_sync_log"."completed_at", "p` |
| 15 | anon | -7014619302214866527 | ok | 1 | 4.5 | 70 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."institutions"."id" FROM "public"."institutions" WHERE "public"."instit` |
| 16 | anon | -4904800359878543082 | ok | 1 | 7.1 | 44 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."jurisdiction_page_cache"."jurisdiction_id", row_to_json("jurisdiction_` |
| 17 | anon | -2045323968914584561 | ok | 1 | 38.8 | 41 | 0 | 0 | 2 | 41.7 | 41 | 0 | `WITH pgrst_source AS ( SELECT "public"."official_homepage_stats_mv"."official_id", "public"."official_homepage` |
| 18 | anon | 6295302398730243616 | ok | 1 | 29.8 | 39 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (SELECT pgrst_call.pgrst_scalar FROM (SELECT $1 AS json_data) pgrst_payload, LATERAL (SEL` |
| 19 | postgres | 8546852756653860799 | ok | 1 | 2.1 | 38 | 0 | 0 | 0 | 0 | 0 | 0 | `SELECT version FROM supabase_migrations.schema_migrations ORDER BY version` |
| 20 | anon | -888150488749408837 | ok | 2 | 41.1 | 32 | 0 | 1,027 | 1 | 16.8 | 9 | 0 | `WITH pgrst_source AS ( SELECT "public"."proposals"."id", "public"."proposals"."title", "public"."proposals"."t` |
| 21 | anon | -3618264231192052946 | ok | 1 | 12.9 | 31 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."financial_relationships"."from_id", "public"."financial_relationships"` |
| 22 | service_role | -8163617005886991080 | ok | 1 | 52.3 | 26 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."enrichment_queue".* FROM "public"."enrichment_queue" WHERE "public"."e` |
| 23 | service_role | 854284877495226294 | ok | 1 | 51.6 | 26 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."enrichment_queue".* FROM "public"."enrichment_queue" WHERE "public"."e` |
| 24 | service_role | -4993992466744859843 | ok | 1 | 13 | 26 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (SELECT pgrst_call.pgrst_scalar FROM (SELECT "public"."get_supabase_auth_mau"() pgrst_sca` |
| 25 | postgres | 8033683396300415726 | new | 1 | 10.6 | 23 | 0 | 0 | 0 | 0 | 0 | 0 | `SELECT p.proname, p.prokind, md5(p.prosrc) AS md5, length(p.prosrc) AS len, p.proconfig, p.proacl FROM pg_proc` |

**Per role** (Σ over pgss entries; tick | quiet)

| role | Δcalls | Δexec ms | Δshared_read | Δtemp_written | Δwal bytes | quiet Δcalls | quiet Δexec ms | quiet Δshared_read | quiet Δtemp_written |
|---|---|---|---|---|---|---|---|---|---|
| service_role | 326 | 17,378 | 7,837 | 0 | 292,589 | 76 | 3,401 | 4,580 | 0 |
| anon | 468 | 1,155 | 3,059 | 577 | 1,027 | 429 | 7,669 | 4,111 | 525 |
| postgres | 79 | 981 | 2,398 | 0 | 11,082 | 110 | 590,300 | 2,183,706 | 0 |
| supabase_admin | 58 | 9 | 0 | 0 | 14,328 | 261 | 314 | 37 | 0 |
| pgbouncer | 19 | 7 | 1 | 0 | 0 | 23 | 526 | 190 | 0 |
| authenticator | 144 | 2 | 0 | 0 | 0 | 386 | 8 | 0 | 0 |

**pg_stat_io** (per backend_type / object / context; reads/writes/extends in op_bytes units = 8 kB blocks)

| backend_type | object | context | reads | writes | extends | hits | evictions | reuses | writebacks | fsyncs | quiet reads | quiet writes | quiet evictions |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| client backend | relation | bulkread | 77,394 | 0 | 0 | 5 | 35 | 77,359 | 0 | 0 | 746,823 | 0 | 622 |
| client backend | relation | normal | 17,186 | 0 | 15 | 208,599 | 17,201 | 0 | 0 | 0 | 1,446,955 | 4,720 | 1,446,956 |
| background writer | relation | normal | 0 | 557 | 0 | 0 | 0 | 0 | 576 | 0 | 0 | 7,219 | 0 |
| checkpointer | relation | normal | 0 | 226 | 0 | 0 | 0 | 0 | 226 | 28 | 0 | 638 | 0 |
| autovacuum worker | relation | normal | 21 | 0 | 0 | 2,159 | 21 | 0 | 0 | 0 | 535 | 0 | 535 |
| background worker | relation | normal | 9 | 0 | 0 | 949 | 9 | 0 | 0 | 0 | 797 | 0 | 797 |
| autovacuum worker | relation | vacuum | 2 | 0 | 0 | 27 | 2 | 0 | 0 | 0 | 26 | 0 | 26 |

**checkpointer / bgwriter / archiver / database** (tick → quiet)

- checkpointer: tick { num_timed 1, num_requested 0, restartpoints_timed 0, restartpoints_req 0, restartpoints_done 0, write_time 23,545, sync_time 102, buffers_written 226 } — quiet { num_timed 5, num_requested 0, restartpoints_timed 0, restartpoints_req 0, restartpoints_done 0, write_time 64,811, sync_time 157, buffers_written 638 }
- bgwriter: tick { buffers_clean 557, maxwritten_clean 0, buffers_alloc 17,183 } — quiet { buffers_clean 7,219, maxwritten_clean 46, buffers_alloc 1,449,027 }
- archiver: tick { archived_count 3, failed_count 0 } — quiet { archived_count 15, failed_count 0 }
- database: tick { temp_files 13, temp_bytes 335,317,775, blks_read 94,731, blks_hit 208,939, xact_commit 843 } — quiet { temp_files 55, temp_bytes 1,492,418,099, blks_read 2,195,582, blks_hit 9,258,421, xact_commit 1,734 }

**pg_stat_activity at 2026-10-09T01:07:29.984544+00:00** (22 rows, first 20; active first)

| pid | backend_type | application_name | usename | state | wait | xact_start | query_start | query |
|---|---|---|---|---|---|---|---|---|
| 1174 | pg_net 0.20.0 worker | pg_net 0.20.0 | supabase_admin | — | Extension:Extension | — | — | `` |
| 1173 | archiver |  | — | — | Activity:ArchiverMain | — | — | `` |
| 1171 | walwriter |  | — | — | Activity:WalWriterMain | — | — | `` |
| 1169 | background writer |  | — | — | Activity:BgwriterHibernate | — | — | `` |
| 1168 | checkpointer |  | — | — | Activity:CheckpointerMain | — | — | `` |
| 1176 | logical replication launcher |  | supabase_admin | — | Activity:LogicalLauncherMain | — | — | `` |
| 1175 | pg_cron launcher | pg_cron scheduler | supabase_admin | — | Extension:Extension | — | — | `` |
| 1172 | autovacuum launcher |  | — | — | Activity:AutovacuumMain | — | — | `` |
| 2493 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 23:43:05Z | `LISTEN "pgrst"` |
| 10653 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:06:30Z | `COMMIT` |
| 10646 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:06:30Z | `COMMIT` |
| 10651 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:06:30Z | `COMMIT` |
| 10642 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:06:30Z | `COMMIT` |
| 10645 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:06:30Z | `COMMIT` |
| 10650 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:06:30Z | `COMMIT` |
| 10652 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:06:30Z | `COMMIT` |
| 10649 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:06:30Z | `COMMIT` |
| 10647 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:06:31Z | `COMMIT` |
| 10644 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:06:31Z | `COMMIT` |
| 10641 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:06:31Z | `COMMIT` |

**pg_stat_activity at 2026-10-09T01:08:30.044253+00:00** (22 rows, first 20; active first)

| pid | backend_type | application_name | usename | state | wait | xact_start | query_start | query |
|---|---|---|---|---|---|---|---|---|
| 1172 | autovacuum launcher |  | — | — | Activity:AutovacuumMain | — | — | `` |
| 1173 | archiver |  | — | — | Activity:ArchiverMain | — | — | `` |
| 1171 | walwriter |  | — | — | Activity:WalWriterMain | — | — | `` |
| 1169 | background writer |  | — | — | Activity:BgwriterHibernate | — | — | `` |
| 1174 | pg_net 0.20.0 worker | pg_net 0.20.0 | supabase_admin | — | Extension:Extension | — | — | `` |
| 1168 | checkpointer |  | — | — | Activity:CheckpointerMain | — | — | `` |
| 1176 | logical replication launcher |  | supabase_admin | — | Activity:LogicalLauncherMain | — | — | `` |
| 1175 | pg_cron launcher | pg_cron scheduler | supabase_admin | — | Extension:Extension | — | — | `` |
| 2493 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 23:43:05Z | `LISTEN "pgrst"` |
| 1250 | client backend | postgres_exporter | supabase_admin | idle | Client:ClientRead | — | 01:08:12Z | `SELECT CASE WHEN usename IN ('postgres', 'authenticator', 'supabase_auth_admin', 'supabase_storage_a` |
| 10674 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:08:15Z | `COMMIT` |
| 10679 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:08:15Z | `COMMIT` |
| 10680 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:08:15Z | `COMMIT` |
| 10673 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:08:15Z | `COMMIT` |
| 10672 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:08:15Z | `COMMIT` |
| 10681 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:08:16Z | `COMMIT` |
| 10675 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:08:16Z | `COMMIT` |
| 10676 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:08:16Z | `COMMIT` |
| 10678 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:08:16Z | `COMMIT` |
| 10677 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:08:18Z | `COMMIT` |

**pg_stat_activity at 2026-10-09T01:09:29.989324+00:00** (22 rows, first 20; active first)

| pid | backend_type | application_name | usename | state | wait | xact_start | query_start | query |
|---|---|---|---|---|---|---|---|---|
| 1171 | walwriter |  | — | — | Activity:WalWriterMain | — | — | `` |
| 1173 | archiver |  | — | — | Activity:ArchiverMain | — | — | `` |
| 1172 | autovacuum launcher |  | — | — | Activity:AutovacuumMain | — | — | `` |
| 1174 | pg_net 0.20.0 worker | pg_net 0.20.0 | supabase_admin | — | Extension:Extension | — | — | `` |
| 1175 | pg_cron launcher | pg_cron scheduler | supabase_admin | — | Extension:Extension | — | — | `` |
| 1176 | logical replication launcher |  | supabase_admin | — | Activity:LogicalLauncherMain | — | — | `` |
| 1168 | checkpointer |  | — | — | Activity:CheckpointerMain | — | — | `` |
| 1169 | background writer |  | — | — | Activity:BgwriterHibernate | — | — | `` |
| 2493 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 23:43:05Z | `LISTEN "pgrst"` |
| 10677 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:08:18Z | `COMMIT` |
| 10682 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:08:22Z | `COMMIT` |
| 10708 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:08:46Z | `COMMIT` |
| 10709 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:08:46Z | `COMMIT` |
| 10710 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:08:46Z | `COMMIT` |
| 10711 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:08:46Z | `COMMIT` |
| 10712 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:08:46Z | `COMMIT` |
| 10713 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:08:46Z | `COMMIT` |
| 10714 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:08:46Z | `COMMIT` |
| 10715 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:08:47Z | `COMMIT` |
| 10716 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:08:47Z | `COMMIT` |

#### Tick 2 — 01:35:00Z → 01:40:59Z

Tick interval 6 min; quiet interval 01:40:59Z → 02:05:01Z, 24.03 min. pgss entries reset inside the tick: 0.

**pgss top 25** (ranked by Δtemp_blks_written, then Δshared_blks_read; blocks are 8 kB; ms = total_exec_time) — tick vs the quiet interval after it

| # | role | queryid | status | Δcalls | Δexec ms | Δshared_read | Δtemp_written | Δwal bytes | quiet Δcalls | quiet Δexec ms | quiet Δshared_read | quiet Δtemp_written | query |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | anon | 1508858691171407755 | ok | 1 | 80 | 26 | 563 | 0 | 1 | 1,658.7 | 2,445 | 420 | `WITH pgrst_source AS ( SELECT "public"."officials"."id", "public"."officials"."full_name", "public"."officials` |
| 2 | service_role | 261368320601411136 | ok | 1 | 1,528.3 | 2,283 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (SELECT pgrst_call.pgrst_scalar FROM (SELECT $1 AS json_data) pgrst_payload, LATERAL (SEL` |
| 3 | service_role | 2554425566920005236 | ok | 1 | 266.6 | 2,221 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."officials"."source_ids", "public"."officials"."metadata" FROM "public"` |
| 4 | postgres | 1859845736403777070 | ok | 6 | 339.5 | 2,021 | 0 | 6,502 | 25 | 11,516.5 | 9,077 | 0 | `SELECT public.record_box_health()` |
| 5 | service_role | 2620195143544750333 | ok | 2 | 463.3 | 1,320 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."enrichment_queue".* FROM "public"."enrichment_queue" WHERE "public"."e` |
| 6 | service_role | -2421107269687758048 | ok | 10 | 6,903 | 1,301 | 0 | 6,455 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."data_sync_log"."pipeline", "public"."data_sync_log"."status", "public"` |
| 7 | service_role | 8455176733294703641 | ok | 2 | 155.5 | 344 | 0 | 2,004 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (SELECT pgrst_call.pgrst_scalar FROM (SELECT $1 AS json_data) pgrst_payload, LATERAL (SEL` |
| 8 | anon | 4936605479865170683 | ok | 6 | 130.3 | 264 | 0 | 0 | 11 | 404.1 | 259 | 0 | `WITH pgrst_source AS ( SELECT "public"."entity_tags"."entity_id", "public"."entity_tags"."tag", "public"."enti` |
| 9 | service_role | -6696635423447632495 | ok | 1 | 96.5 | 194 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (SELECT "pgrst_call".* FROM (SELECT $1 AS json_data) pgrst_payload, LATERAL (SELECT "p_da` |
| 10 | service_role | -6404761789365416609 | ok | 2 | 49.6 | 184 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."proposals".* FROM "public"."proposals" WHERE "public"."proposals"."sta` |
| 11 | anon | 4673625372736388492 | ok | 2 | 53.1 | 131 | 0 | 0 | 6 | 136.3 | 44 | 0 | `WITH pgrst_source AS ( SELECT "public"."financial_entities"."id", "public"."financial_entities"."display_name"` |
| 12 | anon | 7215065337439406510 | ok | 1 | 59.2 | 87 | 0 | 0 | 1 | 100.6 | 280 | 0 | `WITH pgrst_source AS ( SELECT "public"."proposals"."id", "public"."proposals"."title", "public"."proposals"."t` |
| 13 | service_role | 7229084577808365084 | ok | 1 | 2,203.4 | 73 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."data_sync_log"."pipeline", "public"."data_sync_log"."completed_at", "p` |
| 14 | anon | -5427108520373100516 | ok | 1 | 29.6 | 70 | 0 | 0 | 2 | 27.3 | 20 | 0 | `WITH pgrst_source AS ( SELECT "public"."officials"."id", "public"."officials"."full_name", "public"."officials` |
| 15 | anon | 764920611771298824 | ok | 2 | 41 | 58 | 0 | 0 | 6 | 1,108.3 | 102 | 0 | `WITH pgrst_source AS (SELECT pgrst_call.pgrst_scalar FROM (SELECT $1 AS json_data) pgrst_payload, LATERAL (SEL` |
| 16 | anon | -6768324784603011920 | ok | 3 | 19.7 | 47 | 0 | 0 | 6 | 51 | 13 | 0 | `WITH pgrst_source AS (SELECT "pgrst_call".* FROM (SELECT $1 AS json_data) pgrst_payload, LATERAL (SELECT "p_en` |
| 17 | anon | -2045323968914584561 | ok | 1 | 34.4 | 41 | 0 | 0 | 2 | 21.2 | 41 | 0 | `WITH pgrst_source AS ( SELECT "public"."official_homepage_stats_mv"."official_id", "public"."official_homepage` |
| 18 | service_role | -4993992466744859843 | ok | 1 | 24.9 | 29 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (SELECT pgrst_call.pgrst_scalar FROM (SELECT "public"."get_supabase_auth_mau"() pgrst_sca` |
| 19 | anon | 670723039596070302 | ok | 1 | 17.1 | 27 | 0 | 0 | 2 | 4.5 | 27 | 0 | `WITH pgrst_source AS ( SELECT "public"."agencies"."id", "public"."agencies"."name", "public"."agencies"."short` |
| 20 | service_role | -8163617005886991080 | ok | 1 | 11.2 | 26 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."enrichment_queue".* FROM "public"."enrichment_queue" WHERE "public"."e` |
| 21 | service_role | -7143699471244390991 | ok | 1 | 13.8 | 21 | 0 | 85,953 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (INSERT INTO "public"."platform_usage_snapshot"("any_critical", "any_warning", "error", "` |
| 22 | anon | -4500003832951230167 | ok | 1 | 21.4 | 20 | 0 | 0 | 2 | 108.7 | 180 | 0 | `WITH pgrst_source AS ( SELECT "public"."officials"."id", "public"."officials"."full_name", "public"."officials` |
| 23 | service_role | -7585905412265968687 | ok | 1 | 28.5 | 19 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (SELECT "pgrst_call".* FROM "public"."get_supabase_self_metrics"() pgrst_call) SELECT $3:` |
| 24 | service_role | 3453641684384573199 | ok | 1 | 32.5 | 17 | 0 | 140,859 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (INSERT INTO "public"."status_snapshot"("error", "payload", "query_time_ms", "section_tim` |
| 25 | service_role | 2896657904173213369 | ok | 35 | 21 | 16 | 0 | 30,614 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (INSERT INTO "public"."platform_usage"("metric", "period_start", "recorded_at", "service"` |

**Per role** (Σ over pgss entries; tick | quiet)

| role | Δcalls | Δexec ms | Δshared_read | Δtemp_written | Δwal bytes | quiet Δcalls | quiet Δexec ms | quiet Δshared_read | quiet Δtemp_written |
|---|---|---|---|---|---|---|---|---|---|
| service_role | 320 | 12,223 | 8,121 | 0 | 292,408 | 103 | 4,479 | 7,912 | 0 |
| anon | 154 | 556 | 851 | 563 | 0 | 339 | 4,816 | 3,619 | 420 |
| postgres | 48 | 491 | 2,035 | 0 | 11,788 | 83 | 547,891 | 2,112,706 | 0 |
| pgbouncer | 19 | 8 | 3 | 0 | 0 | 29 | 509 | 196 | 0 |
| supabase_admin | 58 | 5 | 0 | 0 | 12,132 | 282 | 334 | 34 | 0 |
| authenticator | 154 | 2 | 0 | 0 | 0 | 315 | 5 | 0 | 0 |

**pg_stat_io** (per backend_type / object / context; reads/writes/extends in op_bytes units = 8 kB blocks)

| backend_type | object | context | reads | writes | extends | hits | evictions | reuses | writebacks | fsyncs | quiet reads | quiet writes | quiet evictions |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| client backend | relation | bulkread | 140,225 | 0 | 0 | 9 | 35 | 140,190 | 0 | 0 | 746,822 | 0 | 622 |
| client backend | relation | normal | 12,270 | 0 | 14 | 183,989 | 12,284 | 0 | 0 | 0 | 1,378,130 | 2,881 | 1,378,130 |
| background writer | relation | normal | 0 | 936 | 0 | 0 | 0 | 0 | 896 | 0 | 0 | 10,275 | 0 |
| checkpointer | relation | normal | 0 | 548 | 0 | 0 | 0 | 0 | 548 | 32 | 0 | 1,449 | 0 |
| autovacuum worker | relation | normal | 25 | 0 | 0 | 2,544 | 25 | 0 | 0 | 0 | 527 | 0 | 527 |
| background worker | relation | normal | 9 | 0 | 0 | 997 | 9 | 0 | 0 | 0 | 1,081 | 0 | 1,081 |
| autovacuum worker | relation | vacuum | 6 | 0 | 0 | 32 | 6 | 0 | 0 | 0 | 55 | 0 | 55 |

**checkpointer / bgwriter / archiver / database** (tick → quiet)

- checkpointer: tick { num_timed 1, num_requested 0, restartpoints_timed 0, restartpoints_req 0, restartpoints_done 0, write_time 59,633, sync_time 6, buffers_written 548 } — quiet { num_timed 5, num_requested 0, restartpoints_timed 0, restartpoints_req 0, restartpoints_done 0, write_time 146,349, sync_time 127, buffers_written 1,449 }
- bgwriter: tick { buffers_clean 936, maxwritten_clean 0, buffers_alloc 12,365 } — quiet { buffers_clean 10,275, maxwritten_clean 49, buffers_alloc 1,380,502 }
- archiver: tick { archived_count 3, failed_count 0 } — quiet { archived_count 15, failed_count 0 }
- database: tick { temp_files 13, temp_bytes 335,301,896, blks_read 152,719, blks_hit 184,666, xact_commit 671 } — quiet { temp_files 49, temp_bytes 1,326,269,171, blks_read 2,126,834, blks_hit 8,215,101, xact_commit 1,648 }

**pg_stat_activity at 2026-10-09T01:37:30.019102+00:00** (22 rows, first 20; active first)

| pid | backend_type | application_name | usename | state | wait | xact_start | query_start | query |
|---|---|---|---|---|---|---|---|---|
| 1174 | pg_net 0.20.0 worker | pg_net 0.20.0 | supabase_admin | — | Extension:Extension | — | — | `` |
| 1173 | archiver |  | — | — | Activity:ArchiverMain | — | — | `` |
| 1176 | logical replication launcher |  | supabase_admin | — | Activity:LogicalLauncherMain | — | — | `` |
| 1175 | pg_cron launcher | pg_cron scheduler | supabase_admin | — | Extension:Extension | — | — | `` |
| 1172 | autovacuum launcher |  | — | — | Activity:AutovacuumMain | — | — | `` |
| 1171 | walwriter |  | — | — | Activity:WalWriterMain | — | — | `` |
| 1169 | background writer |  | — | — | Activity:BgwriterHibernate | — | — | `` |
| 1168 | checkpointer |  | — | — | Activity:CheckpointerMain | — | — | `` |
| 2493 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 23:43:05Z | `LISTEN "pgrst"` |
| 13139 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:35:41Z | `COMMIT` |
| 13140 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:35:41Z | `COMMIT` |
| 13141 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:35:41Z | `COMMIT` |
| 13131 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:35:41Z | `COMMIT` |
| 13132 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:35:42Z | `COMMIT` |
| 13160 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:36:18Z | `COMMIT` |
| 13162 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:36:23Z | `COMMIT` |
| 13167 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:37:08Z | `COMMIT` |
| 13166 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:37:08Z | `COMMIT` |
| 13168 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:37:09Z | `COMMIT` |
| 13169 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:37:09Z | `COMMIT` |

**pg_stat_activity at 2026-10-09T01:38:29.979606+00:00** (22 rows, first 20; active first)

| pid | backend_type | application_name | usename | state | wait | xact_start | query_start | query |
|---|---|---|---|---|---|---|---|---|
| 1174 | pg_net 0.20.0 worker | pg_net 0.20.0 | supabase_admin | — | Extension:Extension | — | — | `` |
| 1173 | archiver |  | — | — | Activity:ArchiverMain | — | — | `` |
| 1172 | autovacuum launcher |  | — | — | Activity:AutovacuumMain | — | — | `` |
| 1171 | walwriter |  | — | — | Activity:WalWriterMain | — | — | `` |
| 1169 | background writer |  | — | — | Activity:BgwriterHibernate | — | — | `` |
| 1168 | checkpointer |  | — | — | Timeout:CheckpointWriteDelay | — | — | `` |
| 1176 | logical replication launcher |  | supabase_admin | — | Activity:LogicalLauncherMain | — | — | `` |
| 1175 | pg_cron launcher | pg_cron scheduler | supabase_admin | — | Extension:Extension | — | — | `` |
| 2493 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 23:43:05Z | `LISTEN "pgrst"` |
| 1250 | client backend | postgres_exporter | supabase_admin | idle | Client:ClientRead | — | 01:38:12Z | `select case when (select count(*) from pg_stat_wal_receiver) = 1 and pg_last_wal_receive_lsn() = pg_` |
| 13169 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:38:16Z | `COMMIT` |
| 13167 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:38:16Z | `COMMIT` |
| 13166 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:38:16Z | `COMMIT` |
| 13178 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:38:17Z | `COMMIT` |
| 13179 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:38:17Z | `COMMIT` |
| 13176 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:38:17Z | `COMMIT` |
| 13168 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:38:17Z | `COMMIT` |
| 13173 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:38:18Z | `COMMIT` |
| 13177 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:38:18Z | `COMMIT` |
| 13174 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:38:18Z | `COMMIT` |

**pg_stat_activity at 2026-10-09T01:39:30.031471+00:00** (22 rows, first 20; active first)

| pid | backend_type | application_name | usename | state | wait | xact_start | query_start | query |
|---|---|---|---|---|---|---|---|---|
| 1174 | pg_net 0.20.0 worker | pg_net 0.20.0 | supabase_admin | — | Extension:Extension | — | — | `` |
| 1173 | archiver |  | — | — | Activity:ArchiverMain | — | — | `` |
| 1171 | walwriter |  | — | — | Activity:WalWriterMain | — | — | `` |
| 1169 | background writer |  | — | — | Activity:BgwriterHibernate | — | — | `` |
| 1168 | checkpointer |  | — | — | Activity:CheckpointerMain | — | — | `` |
| 1176 | logical replication launcher |  | supabase_admin | — | Activity:LogicalLauncherMain | — | — | `` |
| 1175 | pg_cron launcher | pg_cron scheduler | supabase_admin | — | Extension:Extension | — | — | `` |
| 1172 | autovacuum launcher |  | — | — | Activity:AutovacuumMain | — | — | `` |
| 2493 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 23:43:05Z | `LISTEN "pgrst"` |
| 13169 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:38:16Z | `COMMIT` |
| 13167 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:38:16Z | `COMMIT` |
| 13166 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:38:16Z | `COMMIT` |
| 13178 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:38:17Z | `COMMIT` |
| 13179 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:38:17Z | `COMMIT` |
| 13176 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:38:17Z | `COMMIT` |
| 13168 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:38:17Z | `COMMIT` |
| 13173 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:38:18Z | `COMMIT` |
| 13177 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:38:18Z | `COMMIT` |
| 13174 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:38:18Z | `COMMIT` |
| 13175 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 01:38:22Z | `COMMIT` |

#### Tick 3 — 02:05:01Z → 02:11:00Z

Tick interval 5.97 min; quiet interval — (last tick). pgss entries reset inside the tick: 0.

**pgss top 25** (ranked by Δtemp_blks_written, then Δshared_blks_read; blocks are 8 kB; ms = total_exec_time) — tick vs the quiet interval after it

| # | role | queryid | status | Δcalls | Δexec ms | Δshared_read | Δtemp_written | Δwal bytes | quiet Δcalls | quiet Δexec ms | quiet Δshared_read | quiet Δtemp_written | query |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | service_role | 130051690042343360 | ok | 1 | 898.2 | 18,735 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (SELECT "pgrst_call".* FROM "public"."get_drift_source_presence"() pgrst_call) SELECT $3:` |
| 2 | service_role | 2554425566920005236 | ok | 1 | 501.4 | 2,328 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."officials"."source_ids", "public"."officials"."metadata" FROM "public"` |
| 3 | service_role | 261368320601411136 | ok | 1 | 1,277.7 | 2,310 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (SELECT pgrst_call.pgrst_scalar FROM (SELECT $1 AS json_data) pgrst_payload, LATERAL (SEL` |
| 4 | service_role | 2620195143544750333 | ok | 2 | 814.5 | 1,320 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."enrichment_queue".* FROM "public"."enrichment_queue" WHERE "public"."e` |
| 5 | service_role | -2421107269687758048 | ok | 10 | 5,195.1 | 1,248 | 0 | 3,398 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."data_sync_log"."pipeline", "public"."data_sync_log"."status", "public"` |
| 6 | service_role | 8455176733294703641 | ok | 2 | 239.4 | 320 | 0 | 2,027 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (SELECT pgrst_call.pgrst_scalar FROM (SELECT $1 AS json_data) pgrst_payload, LATERAL (SEL` |
| 7 | anon | 4936605479865170683 | ok | 5 | 273.2 | 281 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."entity_tags"."entity_id", "public"."entity_tags"."tag", "public"."enti` |
| 8 | service_role | -6696635423447632495 | ok | 1 | 159.7 | 193 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (SELECT "pgrst_call".* FROM (SELECT $1 AS json_data) pgrst_payload, LATERAL (SELECT "p_da` |
| 9 | service_role | -6404761789365416609 | ok | 2 | 379.9 | 184 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."proposals".* FROM "public"."proposals" WHERE "public"."proposals"."sta` |
| 10 | service_role | 7229084577808365084 | ok | 1 | 1,785 | 124 | 0 | 2,285 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."data_sync_log"."pipeline", "public"."data_sync_log"."completed_at", "p` |
| 11 | anon | -2045323968914584561 | ok | 1 | 44.4 | 41 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."official_homepage_stats_mv"."official_id", "public"."official_homepage` |
| 12 | service_role | -4993992466744859843 | ok | 1 | 17.5 | 30 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (SELECT pgrst_call.pgrst_scalar FROM (SELECT "public"."get_supabase_auth_mau"() pgrst_sca` |
| 13 | anon | 670723039596070302 | ok | 1 | 17.6 | 27 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."agencies"."id", "public"."agencies"."name", "public"."agencies"."short` |
| 14 | service_role | -8163617005886991080 | ok | 1 | 32.7 | 26 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."enrichment_queue".* FROM "public"."enrichment_queue" WHERE "public"."e` |
| 15 | service_role | -7143699471244390991 | ok | 1 | 27.9 | 21 | 0 | 85,516 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (INSERT INTO "public"."platform_usage_snapshot"("any_critical", "any_warning", "error", "` |
| 16 | anon | -4500003832951230167 | ok | 1 | 20.4 | 20 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."officials"."id", "public"."officials"."full_name", "public"."officials` |
| 17 | service_role | -7585905412265968687 | ok | 1 | 17.6 | 19 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (SELECT "pgrst_call".* FROM "public"."get_supabase_self_metrics"() pgrst_call) SELECT $3:` |
| 18 | service_role | 3453641684384573199 | ok | 1 | 45.9 | 16 | 0 | 128,258 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (INSERT INTO "public"."status_snapshot"("error", "payload", "query_time_ms", "section_tim` |
| 19 | service_role | 2896657904173213369 | ok | 35 | 17.9 | 16 | 0 | 30,553 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (INSERT INTO "public"."platform_usage"("metric", "period_start", "recorded_at", "service"` |
| 20 | service_role | 8041890013005832657 | ok | 1 | 21.3 | 12 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."proposals"."id" FROM "public"."proposals" WHERE "public"."proposals"."` |
| 21 | anon | 764920611771298824 | ok | 1 | 19.9 | 12 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (SELECT pgrst_call.pgrst_scalar FROM (SELECT $1 AS json_data) pgrst_payload, LATERAL (SEL` |
| 22 | service_role | 1945587259687017174 | ok | 1 | 288.1 | 11 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (SELECT pgrst_call.pgrst_scalar FROM (SELECT $1 AS json_data) pgrst_payload, LATERAL (SEL` |
| 23 | service_role | 1045774767069509405 | ok | 2 | 8.6 | 11 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS (SELECT "pgrst_call".* FROM "public"."chord_industry_flows"() pgrst_call) SELECT $3::bigi` |
| 24 | anon | -888150488749408837 | ok | 1 | 13 | 10 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."proposals"."id", "public"."proposals"."title", "public"."proposals"."t` |
| 25 | anon | -5427108520373100516 | ok | 1 | 4.9 | 10 | 0 | 0 | 0 | 0 | 0 | 0 | `WITH pgrst_source AS ( SELECT "public"."officials"."id", "public"."officials"."full_name", "public"."officials` |

**Per role** (Σ over pgss entries; tick | quiet)

| role | Δcalls | Δexec ms | Δshared_read | Δtemp_written | Δwal bytes | quiet Δcalls | quiet Δexec ms | quiet Δshared_read | quiet Δtemp_written |
|---|---|---|---|---|---|---|---|---|---|
| service_role | 312 | 11,874 | 26,953 | 0 | 278,335 | — | — | — | — |
| anon | 107 | 468 | 473 | 0 | 0 | — | — | — | — |
| postgres | 47 | 450 | 2 | 0 | 5,555 | — | — | — | — |
| supabase_admin | 59 | 15 | 0 | 0 | 12,966 | — | — | — | — |
| pgbouncer | 17 | 6 | 2 | 0 | 0 | — | — | — | — |
| authenticator | 115 | 2 | 0 | 0 | 0 | — | — | — | — |

**pg_stat_io** (per backend_type / object / context; reads/writes/extends in op_bytes units = 8 kB blocks)

| backend_type | object | context | reads | writes | extends | hits | evictions | reuses | writebacks | fsyncs | quiet reads | quiet writes | quiet evictions |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| client backend | relation | bulkread | 156,985 | 0 | 0 | 17 | 70 | 156,915 | 0 | 0 | — | — | — |
| client backend | relation | normal | 9,973 | 0 | 15 | 167,636 | 9,988 | 0 | 0 | 0 | — | — | — |
| checkpointer | relation | normal | 0 | 385 | 0 | 0 | 0 | 0 | 385 | 29 | — | — | — |
| background writer | relation | normal | 0 | 155 | 0 | 0 | 0 | 0 | 128 | 0 | — | — | — |
| autovacuum worker | relation | normal | 15 | 0 | 0 | 2,177 | 15 | 0 | 0 | 0 | — | — | — |
| autovacuum worker | relation | vacuum | 6 | 0 | 0 | 31 | 6 | 0 | 0 | 0 | — | — | — |

**checkpointer / bgwriter / archiver / database** (tick → quiet)

- checkpointer: tick { num_timed 1, num_requested 0, restartpoints_timed 0, restartpoints_req 0, restartpoints_done 0, write_time 53,412, sync_time 6, buffers_written 385 } — quiet { — }
- bgwriter: tick { buffers_clean 155, maxwritten_clean 0, buffers_alloc 10,082 } — quiet { — }
- archiver: tick { archived_count 3, failed_count 0 } — quiet { — }
- database: tick { temp_files 12, temp_bytes 330,711,804, blks_read 167,222, blks_hit 167,432, xact_commit 607 } — quiet { — }

**pg_stat_activity at 2026-10-09T02:07:29.979931+00:00** (23 rows, first 20; active first)

| pid | backend_type | application_name | usename | state | wait | xact_start | query_start | query |
|---|---|---|---|---|---|---|---|---|
| 1174 | pg_net 0.20.0 worker | pg_net 0.20.0 | supabase_admin | — | Extension:Extension | — | — | `` |
| 1173 | archiver |  | — | — | Activity:ArchiverMain | — | — | `` |
| 1171 | walwriter |  | — | — | Activity:WalWriterMain | — | — | `` |
| 1169 | background writer |  | — | — | Activity:BgwriterHibernate | — | — | `` |
| 1168 | checkpointer |  | — | — | Activity:CheckpointerMain | — | — | `` |
| 1176 | logical replication launcher |  | supabase_admin | — | Activity:LogicalLauncherMain | — | — | `` |
| 1172 | autovacuum launcher |  | — | — | Activity:AutovacuumMain | — | — | `` |
| 1175 | pg_cron launcher | pg_cron scheduler | supabase_admin | — | Extension:Extension | — | — | `` |
| 2493 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 23:43:05Z | `LISTEN "pgrst"` |
| 14809 | client backend |  | supabase_admin | idle | Client:ClientRead | — | 01:57:54Z | `show archive_mode;` |
| 15643 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 02:07:09Z | `COMMIT` |
| 15644 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 02:07:09Z | `COMMIT` |
| 15646 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 02:07:09Z | `COMMIT` |
| 15647 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 02:07:09Z | `COMMIT` |
| 15645 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 02:07:09Z | `COMMIT` |
| 15649 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 02:07:10Z | `COMMIT` |
| 15648 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 02:07:10Z | `COMMIT` |
| 15650 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 02:07:10Z | `COMMIT` |
| 15651 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 02:07:10Z | `COMMIT` |
| 15652 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 02:07:10Z | `COMMIT` |

**pg_stat_activity at 2026-10-09T02:08:30.004897+00:00** (23 rows, first 20; active first)

| pid | backend_type | application_name | usename | state | wait | xact_start | query_start | query |
|---|---|---|---|---|---|---|---|---|
| 1174 | pg_net 0.20.0 worker | pg_net 0.20.0 | supabase_admin | — | Extension:Extension | — | — | `` |
| 1173 | archiver |  | — | — | Activity:ArchiverMain | — | — | `` |
| 1171 | walwriter |  | — | — | Activity:WalWriterMain | — | — | `` |
| 1169 | background writer |  | — | — | Activity:BgwriterHibernate | — | — | `` |
| 1168 | checkpointer |  | — | — | Timeout:CheckpointWriteDelay | — | — | `` |
| 1176 | logical replication launcher |  | supabase_admin | — | Activity:LogicalLauncherMain | — | — | `` |
| 1172 | autovacuum launcher |  | — | — | Activity:AutovacuumMain | — | — | `` |
| 1175 | pg_cron launcher | pg_cron scheduler | supabase_admin | — | Extension:Extension | — | — | `` |
| 2493 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 23:43:05Z | `LISTEN "pgrst"` |
| 14809 | client backend |  | supabase_admin | idle | Client:ClientRead | — | 01:57:54Z | `show archive_mode;` |
| 1250 | client backend | postgres_exporter | supabase_admin | idle | Client:ClientRead | — | 02:08:12Z | `SELECT COUNT(*) as default_transaction_read_only FROM pg_settings WHERE name = 'default_transaction_` |
| 15639 | client backend | Supavisor (auth_query) | pgbouncer | idle | Client:ClientRead | — | 02:08:16Z | `SELECT * FROM pgbouncer.get_auth($1)` |
| 15651 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 02:08:17Z | `COMMIT` |
| 15649 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 02:08:18Z | `COMMIT` |
| 15648 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 02:08:18Z | `COMMIT` |
| 15645 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 02:08:18Z | `COMMIT` |
| 15647 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 02:08:18Z | `COMMIT` |
| 15650 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 02:08:18Z | `COMMIT` |
| 15646 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 02:08:18Z | `COMMIT` |
| 15643 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 02:08:19Z | `COMMIT` |

**pg_stat_activity at 2026-10-09T02:09:29.992138+00:00** (23 rows, first 20; active first)

| pid | backend_type | application_name | usename | state | wait | xact_start | query_start | query |
|---|---|---|---|---|---|---|---|---|
| 1174 | pg_net 0.20.0 worker | pg_net 0.20.0 | supabase_admin | — | Extension:Extension | — | — | `` |
| 1173 | archiver |  | — | — | Activity:ArchiverMain | — | — | `` |
| 1168 | checkpointer |  | — | — | Activity:CheckpointerMain | — | — | `` |
| 1176 | logical replication launcher |  | supabase_admin | — | Activity:LogicalLauncherMain | — | — | `` |
| 1175 | pg_cron launcher | pg_cron scheduler | supabase_admin | — | Extension:Extension | — | — | `` |
| 1172 | autovacuum launcher |  | — | — | Activity:AutovacuumMain | — | — | `` |
| 1171 | walwriter |  | — | — | Activity:WalWriterMain | — | — | `` |
| 1169 | background writer |  | — | — | Activity:BgwriterHibernate | — | — | `` |
| 2493 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 23:43:05Z | `LISTEN "pgrst"` |
| 14809 | client backend |  | supabase_admin | idle | Client:ClientRead | — | 01:57:54Z | `show archive_mode;` |
| 15644 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 02:08:19Z | `COMMIT` |
| 15652 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 02:08:22Z | `COMMIT` |
| 1250 | client backend | postgres_exporter | supabase_admin | idle | Client:ClientRead | — | 02:09:13Z | `set statement_timeout to '20s'` |
| 15681 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 02:09:15Z | `COMMIT` |
| 15682 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 02:09:16Z | `COMMIT` |
| 15675 | client backend | Supavisor (auth_query) | pgbouncer | idle | Client:ClientRead | — | 02:09:16Z | `SELECT * FROM pgbouncer.get_auth($1)` |
| 15683 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 02:09:16Z | `COMMIT` |
| 15684 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 02:09:16Z | `COMMIT` |
| 15685 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 02:09:16Z | `COMMIT` |
| 15687 | client backend | postgrest | authenticator | idle | Client:ClientRead | — | 02:09:16Z | `COMMIT` |

## 4. The verdict and the owner (D3)

**Expected first (cc-202's brief §5):** under A, a route statement whose tick delta dwarfs its quiet delta and leads on temp_blks_written / shared_blks_read, expected `get_connection_type_counts` or the exact `proposals` count.

**Found:**

1. **The route owns the half-hour burst.** It followed the cron from :00/:30 to :07/:37: 32 of 34 :10/:40 samples above 240 pages/s, :08/:38 at 0 of 34, and :02/:32 back to background (73.6 / 119.3) in ec-crawl-idle hours.
2. **No Postgres statement in the route owns it.** The route's completed work is identical at every tick (≈ 320 calls, 12–17 s exec, 8–27 k blocks, 0 temp). Neither expected candidate is there. Nothing in the bracket dwarfs the quiet per minute in pgss, `pg_stat_io`, `pg_stat_database`, the checkpointer or the archiver.
3. **The burst is a fixed cost per firing.** Its size does not track the status compute's length (pre-move ρ = −0.051, n = 35, over 5–50 s walls; post-move ρ = 0.478, n = 35, over 5–13 s). It arrives +1:22 → +2:22 after the cron instant, at or just after the status insert.
4. **Not connection churn.** Sessions per 2 min are the same with and without the route (§3.6).
5. **Not a Supabase-side cadence.** `num_requested` is 0 at every tick; archiving is the 2-min timeout; and the burst MOVED with a Vercel cron, which nothing Supabase-side would do.
6. **Where it must be, then:** in the route's firing but outside Postgres's statistics. Three candidates, none measured here:
   - (a) the on-box PostgREST process serving the route's fan-out (its memory is invisible to every view read here);
   - (b) on-box services the usage half's Supabase API calls touch (Management API, the privileged metrics endpoint);
   - (c) the ring's own clock: if the metrics endpoint serves counters ~20–50 s stale, the ":10" sample covers the status half itself, and the same lag fits observation one.
7. **The decisive next step is R7:** split the route's two halves onto separate minutes for 24 h (e.g. usage at :07/:37, status at :22/:52), and read which half's sample lights. Same instrument, no new code beyond a second cron entry.

**Owner filed: [[FIX-1292]]** — 🟠 M, ours, statement NOT named. It is ours, so it has levers:
- the R7 split;
- a cadence change (hourly halves the count: the burst samples carried 29.3 % of 10-07's swap-in and 20.4 % of 10-08's out-of-window swap-in, on 6.6–6.7 % of samples);
- the s6 threshold: it trips on a swap-in rate, so it must expect one burst sample per firing, at +1:22..+3:22 (:02/:32 once the cron is back at `*/30`), at ~300–400 pages/s with a 50–150 MB MemAvailable dip.

**Debris, named (never an owner):**
- **`get_ec_crawl_health`'s FR count**, cancelled at service_role's 8 s on every tick since **17:38Z 10-08**: 4 × 57014 in the window; section wall 8.1–8.9 s at 17:38, 18:08, 18:38 and 19:08Z 10-08 and on all five 10-09 ticks (8,130–8,444 ms). Before that it was 0.2–1.2 s on every tick of 10-07 and 10-08. The USASpending run's FR rewrite (10-08 17:13Z → 23:05Z, [[FIX-1291]]) pushed the dirty set behind the EC watermark, and the count went unbounded. It is a real per-tick cost and a broken tile while the backlog lasts, so it is filed separately ([[FIX-1293]]), but it postdates the burst by days: the burst was at :10/:40 at 00:10–16:40Z 10-08 with this section under 1.2 s.
- **ec-crawl's catch-up** (`run_entity_connections_rebuild`, 3 of 3 quiets) owns tonight's :02/:32/:16/:46. Its delta is the same in every quiet and absent from every tick.
- **cc-210's census read** (`SELECT s.calls, s.temp_blks_written … FROM pg_stat_statements`, postgres) sits in the 01:11→01:35 quiet, inside its own :12–:26 rule, not in a bracket.
- **cc-209's reads** do not appear in any bracket.
- **No USASpending straggler:** no `financial_relationships` / `external_source_refs` / `financial_entities` VALUES upsert in any read.
- `get_financial_entity_naics()` (133 s, 391 k blocks) and 27 `entity_tags` INSERTs (106 s) in the first quiet are enrichment-side, not in a bracket.

## 5. What contradicted the design

- **The burst moved cleanly, but one sample later than predicted** (:10/:40, not :08/:38). The prompt's A/B/C thresholds name :08/:38, and by them alone the reading is C-shaped (:02/:32 raised, below pre-move). The residual is ec-crawl's 10-08 daytime regime at every quarter-hour minute, not a second half-hour owner (§2.1).
- **How much the exclusion changed the means:** :02 318.5 → 263.9 and :32 212.4 → 175.7 without → with. The verdict is the same either way.
- **The sampler acquits every statement it can see.** The brief expected it to name one.
- **`pg_stat_io` attributes the tick's reads to `client backend` (bulkread), not to the checkpointer, bgwriter or autovacuum.** That bulkread is tonight's debris (the cancelled crawl-health count), and it is flush-time-attributed.
- **No `num_requested` checkpoint on the half hour** (0 of 7 intervals).
- **The connection-churn hypothesis** formed from the activity reads was refuted by the supplementary reads.
- **Tonight is a poor night to bracket the route.** The crawl catch-up kept every minute near 200 pages/s and the route's burst sat at background (§3.8). The 10-08 daytime ring, not tonight's sampler, carries the verdict.
- **Two instruments are worth keeping** (rule 106; not filed — the prompt puts that out of scope):
  - `pg_stat_database.sessions` deltas, which cost nothing and answered the churn question;
  - the backend_start column in the sampler's activity read.
