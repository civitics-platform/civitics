# Pre-dispatcher FIX triage — the records (cc-281, 2026-11-14)

**Decision (Craig, Fri 11-13 21:59 PST, "recs good"):** Cowork's triage T1–T4 of
the eight bullets filed before the dispatcher went live. Seven are settled here;
FIX-603 is not touched. T1: close FIX-1137, FIX-1186 and FIX-1125 as
superseded, and FIX-1181 on one clean `pg_stat_statements` read. T2: the
dispatcher plan's s15b is parked without a FIX. T3: FIX-1292, FIX-1075 and
FIX-1039 close as redirected, each to one short successor carrying this run's
numbers. T4: FIX-1039's successor is the Under Attack exit, and this run takes
the counting read for it.

**Answer.** All seven close: four superseded or no-op, three redirected.
**FIX-1411** succeeds FIX-1292: the :02/:32 slots are still LIT, and they hold
38.2 % of all swap-in. **FIX-1412** succeeds FIX-1075: `_external`'s last five
walls are 1,010.6–1,210.7 s, so its 1,350 s trigger is not met. **FIX-1413**
succeeds FIX-1039: the Under Attack exit. Of 12,414 requests stopped at the edge
in 24 h, at most 4,605 can be the mode's alone.

**Prod contact: read-only.** Eight `node scripts/db-query.mjs --prod`
statements, each rehearsed first on the local clone: read 1 (`cron.job` +
`job_registry`), read 2 (`dispatch_log`), read 3 (`pg_stat_statements`),
read 4 (`dispatch_log`, `platform_dials`, `pg_db_role_setting`, `pg_proc`,
`pipeline_state`), read 5 (`status_snapshot`), read 6 and a 6b
(`data_sync_log.metadata.units`, `pipeline_state`), and an eighth, two
`job_registry` rows for the ec-crawl's budget. The off-box ring was read once
(`pnpm --filter @civitics/data data:box-health:series --json`, one Upstash
LRANGE). Cloudflare was read through 46 `scripts/cf-analytics.mjs` runs (50
GraphQL queries). Nothing was written anywhere: not prod, Upstash, Cloudflare
or Vercel. The scratch SQL and the fold scripts are in the session scratchpad
and are not committed. Every number below can be reproduced from the reads.

---

## §1 The seven, one row each

| FIX | what it asked for | what exists now | the read | verdict | the close |
|---|---|---|---|---|---|
| FIX-1137 🟠 M (5,743 chars) | pg_cron option A: when a firing is abandoned at startup, re-fire an idempotent job once instead of waiting for its next slot | The dispatcher (FIX-1308). Every registry row is armed as a one-shot pg_cron job. A reap that is not `succeeded` leaves the row due, so a later tick arms it again. Only 10 plain cron jobs are left, all plumbing (read 1). | 1, 2 | **superseded**. Read 1: no active job outside the ten except the dispatcher's own arm. Read 2: 2 non-success reaps since 10-31, both re-armed. | `Closes: FIX-1137` · `closes-as-superseded` |
| FIX-1186 🟡 L (2,725) | A per-unit `statement_timeout` needs each unit to be its own top-level statement. Evaluate that against the unit watchdog before building it. | Each dispatched unit IS its own top-level `CALL`: a one-shot job with a `job_registry.budget_seconds` row that the `*/2` watchdog enforces. The pre-loop gap no in-body budget reached is bounded by FIX-1393's `transaction_timeout`, which is on prod. | 4 | **superseded**. `donor_rollup_rebuild_bulk()` contains `transaction_timeout` (2 mentions, md5 `b7df526046f4911f9cac3c5ace222b60`). | `Closes: FIX-1186` · `closes-as-superseded` |
| FIX-1125 🟠 M (23,680) | Nothing in the 06:00 stack bounds MEMORY, and the runtime guards were starved by the condition they end | The box gate's memory rule and swap ceiling (FIX-1354), the headroom rung after live (FIX-1362), `max_parallel_workers_per_gather 0` + `hash_mem_multiplier 1` on `postgres` and `authenticator` (FIX-1356), `cap_mb` re-derived (FIX-1357), `shared_buffers` 128 MB (FIX-1379) | 4 | **superseded**. Every rung is live. `headroom:` fired 6 times (11-01 → 11-04). `box: memory` has 0 rows in the retained log. s15b is parked without a FIX (T2). | `Closes: FIX-1125` · `closes-as-superseded` |
| FIX-1181 🟠 M (6,127) | Two `service_role` RPCs complete past the measured 8 s bound. Re-read pgss weekly, and close on the third clean read (#1 cc-141, #2 cc-186). | — | 3 | **no-op**. Read #3 is clean: 0 statements by an API role past 8,000 ms over a 20 d 10 h epoch. | `Closes: FIX-1181` · `closes-as-no-op` |
| FIX-1292 🟠 M (12,440) | The half-hour swap-in burst is the snapshot route's firing. R7 / cc-216 traced it to the status half. File the fix. | — (no build) | 5 | **redirected → FIX-1411**. Still LIT on 29.97 h of ring. | `Closes: FIX-1292` · `closes-as-redirected` |
| FIX-1075 🟡 M (8,224) | Window the remaining EC arms the way FIX-1069 did donations, driven by measured arm timings | `_external` runs weekly at ~1,000–1,200 s. FIX-1270 parks an arm after two cancels. | 6 | **redirected → FIX-1412**. The trigger is not met: no wall ≥ 1,350 s, let alone twice running. | `Closes: FIX-1075` · `closes-as-redirected` |
| FIX-1039 🔴 M (6,434) | Under Attack is load-bearing cost control. Do not take it off before the limiter works. Do not set `CIVITICS_APP_URL` to civitics.com, which would kill both monitors. | The landmine half is done (FIX-1057). Since then: the limiter keyed per client (FIX-1401), the fleet Block (FIX-1403) and the `SearchBot` rule (FIX-1390). | 4, 7, 8 | **redirected → FIX-1413**, the exit. | `Closes: FIX-1039` · `closes-as-redirected` |

The closes are seven `--allow-empty` commits, one id each, made after the rebase.
`pnpm fixes:sync` writes their `done.log` rows once the commits are on `origin/main`.
`pnpm fixes:status FIX-1137 …` reads them back.

Plan steps that pointed at a closed id:

- `dispatcher.md` s15b: `ref: ""`, parked per T2.
- `dispatcher.md` s13 (the swap-in sensor design): `ref: ""`. It is parked with s15b.
- `forker.md` s6 (the memory threshold): `ref: ""`. The threshold lives in the box gate.
- `forker.md` s14 (the fix from R7's verdict): re-pointed at FIX-1411.

The `dispatcher.md` paragraph that kept FIX-1137 open now carries a dated line
recording its close.

---

## §2 Read 1 — what is still a plain cron job (prod, 11-14 23:22Z)

Active, 11 rows. The ten expected:

- `abuse-events-retention` (`15 4 * * *`)
- `box-health-probe` (`* * * * *`)
- `cron-job-budget-watchdog` (`*/2`)
- `cron-job-run-details-retention` (`51 1 * * *`)
- `derived-mvs-unit-watchdog` (`*/2`)
- `dispatcher-tick` (`1-59/2 * * * *`)
- `platform-counts-daily` (`53 3 * * *`)
- `vm-probe-pre-ec` (`25 4 * * *`)
- `vm-probe-pre-fe` (`45 4 * * *`)
- `vm-probe-pre-fr` (`55 2 * * *`)

The one outside the list is the dispatcher's own arm: **`disp-ec-crawl-1794698340`**,
`21 23 14 11 *`, running `CALL public.run_entity_connections_rebuild('incremental',
p_max_units := 1);`. That is an ARM-path one-shot, not a plain cron job, so it
does not trip the STOP row. The other 37 `cron.job` rows are inactive. Each
names its registry rule (`by …`, `stale_after …`, `dead_tuples > …`), except
four parked `at` rows: `entity-connection-stats-rebuild`,
`financial-entity-totals-incremental`, `rebuild-ec-incremental` and
`rebuild-ec-incremental-mon`.

`job_registry` by runner and rule kind:

| runner | at | by | stale_after | dead_tuples |
|---|---:|---:|---:|---:|
| pg_cron | 14 | 16 | 3 | 15 |
| github_actions | 7 | 1 | — | — |

**Eligible** (not `at`, and pg_cron or a `gha-dispatch:` call): **35** of 56, as expected.

## §3 Read 2 — the re-arm, observed (prod)

`dispatch_log`'s oldest row is **2026-10-31 01:59:00Z**. Retention lives inside
the tick, so "since 10-25" reads from 10-31. Since then: **1,209 reaps, 2 not
`succeeded`, both re-armed**.

| job | reason | reaped | re-armed | after |
|---|---|---|---|---|
| donor-rollup-refresh | `failed: ERROR: canceling statement due to user request CONTEXT: SQL statement "INSERT INTO public._drb_fe (id, display_name, entity_type, state, industry_tag, industry_label) SELECT fe.id, fe.display_na…` (id 19597, `disp-donor-rollup-refresh-1794200220`, unit_ms 9,277,430) | 2026-11-09 07:35:04.60Z | 08:39:49.33Z | 1 h 04 m 44.7 s |
| donor-rollup-refresh | `failed: job startup timeout` (id 19625, `disp-donor-rollup-refresh-1794213542`, unit_ms 10,006) | 2026-11-09 08:43:09.43Z | 09:45:00.18Z | 1 h 01 m 50.7 s |

Only two such rows exist, so the "three rows verbatim" are these two. The second
is FIX-1137's own case: pg_cron abandoned the firing at startup. The dispatcher
armed it again 62 minutes later, with no option-A code.

## §4 Read 3 — FIX-1181's third weekly read (prod, 11-14 23:22:45Z)

- `pg_stat_statements_info.stats_reset` **2026-10-25 13:25:52.56Z**, so the
  window is **20 d 09 h 57 m**. The postmaster dates from the 11-05 01:59:17Z
  planned restart, which kept pgss (playbook D13). Read #2's epoch was 09-22.
- Statements run by `service_role`, `authenticator`, `anon` or `authenticated`
  with `max_exec_time > 8000`: **none**.
- `link_officials_to_districts`, `service_role`: 9 calls, max **7,636.2 ms**,
  mean 7,316.7 ms.
- `refresh_primary_source_for_entities`: `service_role` 1,972 calls, max
  **6,103.9 ms**, mean 58.4 ms; `postgres` 6 calls, max 549.3 ms.

## §5 Read 4 — the memory gate's footprint, the dials, the donor bound, the zone (prod)

`dispatch_log` from 10-31 01:59Z to 11-14 23:21Z (11,809 rows), matched on
`reason` and `excluded`:

| text | rows | oldest | newest |
|---|---:|---|---|
| `box: memory` | **0** | — | — |
| `headroom:` | 6 | 11-01 06:35:07Z | 11-04 21:13:11Z |
| `box: io_saturated` | 22 | 11-07 21:31:00Z | 11-14 21:41:00Z |
| `box: io_throttled` | 37 | 11-09 09:09:00Z | 11-09 15:23:00Z |

- `platform_dials`: `swap_ceiling_mb` **1018**, `headroom_target_mb` **150**
  (updated 11-05 02:00:34Z).
- `pg_db_role_setting`:
  - `postgres` in `postgres`: `statement_timeout=3h, work_mem=64MB,
    max_parallel_workers_per_gather=0, hash_mem_multiplier=1`.
  - `authenticator` in `postgres`: `max_parallel_workers_per_gather=0,
    hash_mem_multiplier=1`.
  - `authenticator`, all databases: `session_preload_libraries=safeupdate,
    statement_timeout=8s, lock_timeout=8s`.
  - `postgres`, all databases: `search_path`.
- `shared_buffers` **128MB**, PostgreSQL 17.6, postmaster 2026-11-05 01:59:17Z.
- `donor_rollup_rebuild_bulk()`: contains `transaction_timeout` (**true**).
- `pipeline_state.cf_mitigation_loop`: `{"tripped": null, "breaches": [],
  "scope_probe": {"writable": true, "checked_at": "2026-11-14T19:00:48.773Z",
  "scope_missing": false}, "transitions": [], "last_revert_at": null}`. **It
  records no security level.** The last API read of the level is
  `docs/audits/2026-11-09-upstash-spend-census.md` §5: `under_attack`, modified
  2026-08-15 22:03:19Z. This run was not cleared for a Cloudflare REST read.

## §6 Read 5 — the swap-in burst, re-measured (in full)

**Instrument:** the off-box ring (`data:box-health:series --json`, Upstash, read
2026-11-14 23:23:30Z). It holds **900 samples, 2026-11-13 17:24:22Z →
2026-11-14 23:22:22Z = 29.97 h**, every 2 min at :22 s. That is the whole ring
(30 h, FIX-1289), not 7 days.

**Where the status half lands.** These are the last 48 `status_snapshot` rows
(prod; `fetched_at` UTC, then `query_time_ms`). `fetched_at` falls in the :01
minute 22 times, the :31 minute 23 times, and the :02 / :32 minutes 3 times.
`query_time_ms` p50 **16,142** (lower median), mean 19,750, p90 31,662, max
**62,635**. Three rows carry an `error`. A ring sample stamped :02:22 covers
:00:22 → :02:22, which contains every status write. So the two slots are
**:02 and :32**.

```
11-13 23:31:26  13929
11-14 00:01:29  16547
11-14 00:31:31  15317
11-14 01:01:37  28091 err
11-14 01:31:25  17379
11-14 02:01:28  17993
11-14 02:31:36  26780
11-14 03:01:34  14137
11-14 03:31:20  14488
11-14 04:01:28  15520
11-14 04:31:27  18151
11-14 05:01:23  12421
11-14 05:31:28  17934
11-14 06:01:30  15653
11-14 06:32:20  38978
11-14 07:01:29  14166
11-14 07:31:37  13965
11-14 08:01:31  28736 err
11-14 08:31:26  18034
11-14 09:01:18  13956
11-14 09:31:16  12575
11-14 10:02:13  31831
11-14 10:31:23  15481
11-14 11:01:22  17466
11-14 11:31:22  17690
11-14 12:01:23  15231
11-14 12:31:42  33364
11-14 13:01:18  12395
11-14 13:31:37  29472 err
11-14 14:01:26  15058
11-14 14:31:18  12810
11-14 15:01:39  31662
11-14 15:31:19  15320
11-14 16:01:31  18707
11-14 16:31:24  17649
11-14 17:01:22  15010
11-14 17:31:22  14548
11-14 18:01:27  15259
11-14 18:31:22  18264
11-14 19:02:09  62635
11-14 19:31:20  15321
11-14 20:01:28  18523
11-14 20:31:33  29058
11-14 21:01:36  29743
11-14 21:31:21  19106
11-14 22:01:17  13580
11-14 22:31:18  16142
11-14 23:01:17  11933
```

**The fold** (`scripts/box-health-minute-profile-lit.mjs`, swap-in pages/s,
lower median). cc-216's rule: a slot is LIT when its median is > 240 and ≥ 80 %
of its samples are > 240. It is QUIET when its median is < 60 and ≤ 2 samples
are > 240. A slot with n < 12 is not judged.

| slot | n | mean | median | max | > 240 | verdict |
|---|---:|---:|---:|---:|---:|---|
| :02 | 30 | 493.8 | 491.9 | 737.7 | 30 (100 %) | **LIT** |
| :32 | 30 | 500.6 | 485.5 | 814.7 | 30 (100 %) | **LIT** |
| every other minute | 839 | 57.6 | 33.4 | — | 34 (4.1 %) | neither (median < 60, but 34 > 240) |

- **Share of swap-in:** the two slots are 6.7 % of the samples and carry
  **38.2 %** of all swap-in pages in the window. They hold 60 of the 94 samples
  above 240.
- Swap-out rides with the burst: the slots' median swap-out is 627.6 / 718.9
  pages/s, against 0–129 in every other minute. The :02 slot's ΔMemAvailable
  median is −69 MB.
- **Sensitivity, with the ec-crawl's stats-window spans excluded:** the read 6
  spans that touch the ring are 11-13 17:01:00–17:01:06Z (window 16/16, before
  the ring starts) and four gated probes of 2–4 s (11-13 23:05Z, 11-14 05:09Z,
  11-14 11:13Z, 11-14 17:17Z). Dropping each sample whose 2-min interval overlaps
  a span removes 4 samples and changes nothing. :02 and :32 are unchanged and
  LIT; the control is n 835, median 33.0, 32 > 240; the share is **38.5 %**. The
  stats-window cycle finished at 11-13 17:01Z, before the ring begins, so this
  ring has no stats-window load to remove.

Per minute (even minutes only; the probe is `*/2`). `so_med` is the median
swap-out:

```
min   n   mean    med    max  >240  so_med
:00  30   44.7   51.6  115.5    0     0.2
:02  30  493.8  491.9  737.7   30   627.6
:04  30  106.4     60    508    3   129.3
:06  30  108.9   38.1  509.9    6    15.7
:08  30   45.5   14.8  431.6    2     2.3
:10  30   60.4   50.1  250.8    1     5.3
:12  30   65.7   41.5  309.1    2     7.6
:14  30   85.4   39.8  491.4    3     4.5
:16  30   71.9   34.5  433.5    2     1.9
:18  30   43.7   12.1  383.8    3       0
:20  30   41.3     33   98.7    0     0.8
:22  30     43   18.2  222.8    0     6.3
:24  30   49.7   30.3  328.5    1     0.5
:26  30   52.1   26.7  218.2    0       0
:28  30   28.1    7.9    303    1       0
:30  30   47.9   50.6  150.2    0       0
:32  30  500.6  485.5  814.7   30   718.9
:34  30   91.3   63.3  350.3    2    56.2
:36  30     75   42.4  353.6    2    14.9
:38  30   44.6   14.4  399.9    1     1.6
:40  30   46.3   48.1  126.4    0     0.8
:42  30   57.7   31.1  357.6    1     4.8
:44  30   85.3   52.1  314.4    3     5.9
:46  30   55.4   32.5  170.2    0     0.3
:48  30   20.2    9.2  233.4    0       0
:50  30   68.8   63.5  231.1    0     0.5
:52  30   56.7   30.7  202.8    0     9.9
:54  30   53.3   30.3  297.9    1     5.9
:56  30   45.7     25  146.8    0     0.9
:58  30   18.3    8.3   89.7    0     0.2
```

**Verdict:** both slots are still LIT, more strongly than cc-213's pre-split
figures (:02 mean 488.3 / median 371.3, 23 of 24; :32 423.8 / 355.0, 23 of 24,
as `box-health-minute-profile-lit.mjs`'s header records them). Nothing else in
the hour comes close to the status half's firing at :00 and :30.

## §7 Read 6 — the EC arms (prod `data_sync_log.metadata.units`, since 09-01)

There are 1,668 `entity_connections_rebuild` rows from 09-01 02:15Z to
11-14 23:21Z. `pipeline_state` holds **no `ec_arm_parked` entry**. The registry
row: `ec-crawl` `budget_seconds` **1800**, `stale_after 10 minutes`, cap 64,
group `ec`.

Every real `_external` unit since 09-01, in order:

| started | seconds | edges | note |
|---|---:|---:|---|
| 09-06 14:30Z | 951.5 | 574,420 | |
| 09-13 04:15Z | 1,043.9 | 574,495 | |
| 09-20 02:00Z | 991.2 | 574,590 | |
| 09-27 02:30Z | 1,003.6 | 574,650 | |
| 10-04 09:00Z | **1,797.7** | 0 | cancelled: backoff `absolute duration 1798 s >= 1500 s` |
| 10-04 11:45Z | 1,025.1 | 574,687 | |
| 10-11 11:45Z | 1,176.1 | 574,835 | last five ↓ |
| 10-18 10:31Z | 1,010.6 | 576,351 | |
| 10-25 07:21Z | 1,128.1 | 577,603 | |
| 11-01 07:07Z | 1,078.7 | 578,336 | |
| 11-08 03:31Z | 1,210.7 | 578,722 | |

There are only four real `_contracts` units since 09-01. It has been gated since:
09-01 09:45Z 410.7 s (189,949) · 09-02 15:15Z 346.2 s (189,949) · 10-08 23:45Z
411.7 s (204,040) · 10-11 11:30Z 424.3 s (219,168).

Other arms since 09-01, real units only:

| arm | units | max s | median s | units > 60 s |
|---|---:|---:|---:|---:|
| `donations_incr_windows` (windowed) | 583 | 1,645.8 | 52.1 | 269 |
| `entity_connection_stats_windows` (windowed) | 902 | 2,054.1 | 45.3 | 391 |
| `_votes` | 31 | 161.9 | 17.8 | 1 (10-05 03:00Z, 161.9 s, 9,799 edges) |
| `_oversight` | 14 | 8.9 | 8.6 | 0 |

Windowed units at or above 1,350 s: one `donations_incr_windows` window
(11-09 09:51Z, 1,645.8 s) and eight `entity_connection_stats_windows` windows
(09-01 → 11-09 14:09Z, max 2,054.1 s; all eight set backoff). These are already
windowed, and FIX-1412's trigger names `_external` only.

## §8 Read 7 — what the edge stops, last 24 h (in full)

`scripts/cf-analytics.mjs --since 2026-11-13T23:20:00Z --hours 24`, so every
query covers the same fixed window, 11-13 23:20Z → 11-14 23:20Z. (An earlier
run whose window ran past "now" was discarded.) The script shows a user agent
truncated to 93 characters. Edge and origin lists are joined on that display
string, so one display line can be a family of full strings. The Mac line is
every `Macintosh; Intel Mac OS X 10_15_7 … Chrome` version together.

**Hourly** (edge status split and the origin column):

```
hour_utc                total      200      403    other   cache_hit   origin  top_host
2026-11-13T23:00:00Z     1784      930      469      385         77      662  www.civitics.com=1628
2026-11-14T00:00:00Z     2289     1308      423      558        118      906  www.civitics.com=2185
2026-11-14T01:00:00Z     1325      650      324      351         55      440  www.civitics.com=1275
2026-11-14T02:00:00Z      364       78      211       75          4       67  www.civitics.com=306
2026-11-14T03:00:00Z      409       60      268       81          1       51  www.civitics.com=322
2026-11-14T04:00:00Z      332       53      192       87          0       56  www.civitics.com=278
2026-11-14T05:00:00Z      272       24      178       70          0       27  www.civitics.com=221
2026-11-14T06:00:00Z      794      134      573       87         23      108  www.civitics.com=731
2026-11-14T07:00:00Z      314       36      204       74          1       33  www.civitics.com=254
2026-11-14T08:00:00Z      451       35      344       72          0       36  www.civitics.com=403
2026-11-14T09:00:00Z      363       82      209       72          4       76  www.civitics.com=289
2026-11-14T10:00:00Z      314       47      196       71          1       50  www.civitics.com=264
2026-11-14T11:00:00Z      357       35      249       73          0       42  www.civitics.com=234
2026-11-14T12:00:00Z      417       30      314       73          0       31  www.civitics.com=232
2026-11-14T13:00:00Z      339       33      228       78          0       39  www.civitics.com=257
2026-11-14T14:00:00Z      357       55      226       76          0       55  www.civitics.com=283
2026-11-14T15:00:00Z      304       46      187       71          0       55  www.civitics.com=249
2026-11-14T16:00:00Z      295       33      199       63          1       38  www.civitics.com=236
2026-11-14T17:00:00Z     2777       45     1457     1275          0       41  civitics.com=2530
2026-11-14T18:00:00Z      290       41      187       62          0       47  www.civitics.com=215
2026-11-14T19:00:00Z      285       38      183       64          0       34  www.civitics.com=213
2026-11-14T20:00:00Z      311       37      229       45          0       41  www.civitics.com=224
2026-11-14T21:00:00Z      297       61      176       60          0       64  www.civitics.com=223
2026-11-14T22:00:00Z      306       45      203       58          3       43  www.civitics.com=240
2026-11-14T23:00:00Z      145       50       76       19          2       35  www.civitics.com=126

TOTAL 15491   edge-200 3986   origin 3077   mitigated(403) 7505   → 48.4% mitigated
```

**By user agent, top 30, edge:**

```
distinct userAgent values: 145
requests across them:  15491
top 30 by request count:
    1.     2926   18.9% cum  (empty)
    2.     2356   34.1% cum  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0...
    3.     1207   41.9% cum  Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; KeenableBot/1.0; +https://keen...
    4.      738   46.7% cum  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0...
    5.      647   50.8% cum  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0...
    6.      624   54.9% cum  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0...
    7.      620   58.9% cum  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0...
    8.      617   62.8% cum  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0...
    9.      616   66.8% cum  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0...
   10.      611   70.8% cum  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0...
   11.      577   74.5% cum  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0...
   12.      507   77.8% cum  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0...
   13.      485   80.9% cum  Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.4; +https://openai.co...
   14.      450   83.8% cum  curl/8.18.0
   15.      308   85.8% cum  facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)
   16.      195   87.0% cum  Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing....
   17.      180   88.2% cum  Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gec...
   18.       79   88.7% cum  Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome...
   19.       79   89.2% cum  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0...
   20.       67   89.7% cum  Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome...
   21.       66   90.1% cum  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0....
   22.       64   90.5% cum  Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome...
   23.       59   90.9% cum  Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome...
   24.       59   91.3% cum  Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome...
   25.       58   91.6% cum  Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome...
   26.       56   92.0% cum  Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome...
   27.       55   92.4% cum  Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome...
   28.       53   92.7% cum  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0...
   29.       52   93.0% cum  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0...
   30.       51   93.4% cum  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0...
cumulative coverage:
  top    1 → 18.9%
  top    5 → 50.8%
  top   10 → 70.8%
  top   25 → 91.6%
  top   50 → 97.7%
  top  100 → 99.7%
```

**By user agent, top 30, origin-reaching:**

```
distinct userAgent values: 32
requests across them:  3077

top 30 by request count:
    1.      594   19.3% cum  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0...
    2.      450   33.9% cum  curl/8.18.0
    3.      194   40.2% cum  Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing....
    4.      191   46.4% cum  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0...
    5.      189   52.6% cum  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0...
    6.      180   58.4% cum  Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gec...
    7.      155   63.5% cum  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0...
    8.      152   68.4% cum  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0...
    9.      146   73.2% cum  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0...
   10.      142   77.8% cum  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0...
   11.      137   82.2% cum  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0...
   12.      133   86.5% cum  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0...
   13.       79   89.1% cum  Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome...
   14.       71   91.4% cum  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0...
   15.       59   93.3% cum  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0...
   16.       39   94.6% cum  Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)
   17.       27   95.5% cum  Mozilla/5.0 (iPad; CPU OS 27_0_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriO...
   18.       25   96.3% cum  Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safar...
   19.       24   97.1% cum  Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Geck...
   20.       23   97.8% cum  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0...
   21.       19   98.4% cum  Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:160.0) Gecko/20100101 Firefox/160.0
   22.       12   98.8% cum  Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0
   23.        9   99.1% cum  Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome...
   24.        6   99.3% cum  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0...
   25.        5   99.5% cum  Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gec...
   26.        4   99.6% cum  Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:126.0) Gecko/20100101 Firefox/126.0
   27.        4   99.7% cum  Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safar...
   28.        3   99.8% cum  Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome...
   29.        2   99.9% cum  Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safar...
   30.        1   99.9% cum  Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gec...

cumulative coverage:
  top    1 → 19.3%
  top    5 → 52.6%
  top   10 → 77.8%
  top   25 → 99.5%
```

**By path, top 20, edge:**

```
distinct clientRequestPath values: 4635
requests across them:  15491

top 20 by request count:
    1.     1689   10.9% cum  /cdn-cgi/rum
    2.     1255   19.0% cum  /favicon.ico
    3.      867   24.6% cum  /api/platform/web-vitals
    4.      540   28.1% cum  /
    5.      413   30.8% cum  /75c49be622312150/vitals
    6.      340   32.9% cum  /cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1
    7.      299   34.9% cum  /api/notifications
    8.      239   36.4% cum  /_vercel/insights/view
    9.      226   37.9% cum  /api/track-view
   10.      224   39.3% cum  /icon.svg
   11.      157   40.3% cum  /officials
   12.      147   41.3% cum  /api/officials/5201c5c4-7b93-4042-a74f-d494a20e74de/responsiveness
   13.      111   42.0% cum  /robots.txt
   14.       46   42.3% cum  /api/follows
   15.       46   42.6% cum  /api/questions
   16.       45   42.9% cum  /api/comments
   17.       40   43.1% cum  /api/constituent-status
   18.       36   43.4% cum  /agencies
   19.       15   43.5% cum  /api/session/properties
   20.       14   43.6% cum  /jurisdictions/040cc038-70fb-4a3f-95e9-550c3a772efd

cumulative coverage:
  top    1 → 10.9%
  top    5 → 30.8%
  top   10 → 39.3%
  top   25 → 44.0%
  top   50 → 45.2%
  top  100 → 47.0%
  top  250 → 51.2%
  top  500 → 57.7%
  top 1000 → 68.4%
```

**By path, top 20, origin-reaching:**

```
distinct clientRequestPath values: 677
requests across them:  3077

top 20 by request count:
    1.      517   16.8% cum  /api/platform/web-vitals
    2.      239   24.6% cum  /_vercel/insights/view
    3.      232   32.1% cum  /api/notifications
    4.      224   39.4% cum  /api/track-view
    5.      223   46.6% cum  /icon.svg
    6.      157   51.7% cum  /officials
    7.      153   56.7% cum  /
    8.      147   61.5% cum  /api/officials/5201c5c4-7b93-4042-a74f-d494a20e74de/responsiveness
    9.      102   64.8% cum  /75c49be622312150/vitals
   10.       52   66.5% cum  /robots.txt
   11.       45   68.0% cum  /api/follows
   12.       45   69.4% cum  /api/questions
   13.       42   70.8% cum  /api/comments
   14.       40   72.1% cum  /api/constituent-status
   15.       10   72.4% cum  /.git/HEAD
   16.       10   72.7% cum  /.git/config
   17.        8   73.0% cum  /_next/static/chunks/3588-08192268b359996b.js
   18.        8   73.3% cum  /_next/static/chunks/5b8f0dd8-9f99cf0e1865768d.js
   19.        7   73.5% cum  /_next/static/chunks/25-0e1c22dea3caa860.js
   20.        7   73.7% cum  /_next/static/chunks/webpack-5d09b6a06aecff13.js

cumulative coverage:
  top    1 → 16.8%
  top    5 → 46.6%
  top   10 → 66.5%
  top   25 → 74.8%
  top   50 → 77.4%
  top  100 → 80.7%
  top  250 → 86.1%
  top  500 → 94.2%
```

**Edge status, whole window:** 403 7,505 · 200 3,986 · 204 1,676 · 301 1,252 ·
499 670 · 401 276 · 307 79 · 404 13 · 400 12 · 500 9 · 304 9 · 308 3 · 522 1.

**The 17:00Z spike** (2,777 requests, 2,530 to the apex): 2,443 of them carry
an empty user agent. Its status split is 1,458 × 403, 1,210 × 301, 60 × 204,
45 × 200, 3 × 307 and 2 × 400.

## §9 Read 8 — the attribution (in full)

Here "stopped" means edge requests minus origin-reaching requests, as read 7
defines it.

| bucket | how it was read | edge | origin | **stopped** |
|---|---|---:|---:|---:|
| all | read 7 | 15,491 | 3,077 | **12,414** |
| the ten `CHROME_FLEET_UAS` (the Block in `Common Exploit Paths`) | exact `--ua-like` on `…Chrome/13_.0.0.0 Safari/537.36` and `…/14_…`, per string, minus the non-fleet 131 (8) and 144/145/147 (3) | 7,913 | 1,910 | **6,003** |
| `SearchBot` (ExaSearchBot / KeenableBot) | `--ua-like "%ExaSearchBot%"`, `"%KeenableBot%"` | 1,208 | 0 | **1,208** |
| the exploit paths (`.php`, `wp-`, `.env`, `xmlrpc`, `phpmyadmin`) | five `--path-like` reads, deduplicated by path (325 paths; 55 requests matched two patterns) | 598 | 0 | **598** |
| **everything else** | the remainder | — | — | **4,605** |

- **The fleet's 1,910 origin requests all fall before the Block.** The fleet's
  hourly origin column reads 0 in every bucket from 02:00Z. Its 6,003 stopped
  include up to 2,838 in the 23:00–01:59Z buckets: the challenges, cache hits
  and edge-served beacons of the 2.25 h before the 01:34:46Z Block, and the
  25 min after it. From 02:00Z the ten strings sent 3,176 requests, and none
  reached the origin.
- **Overlap.** No exploit-path request came from a fleet string or a SearchBot
  string: the UA lists for all five patterns were read. Of the exploit paths' 598
  requests, 500 came from the empty user agent.
- **"Everything else" (4,605) is an UPPER bound on what Under Attack alone
  stops.** It also holds whatever Browser Integrity Check (On) and the `Meta`
  rule did. It holds the edge's own 301s, from Always Use HTTPS (1,252 in the
  window, across all buckets), and `/cdn-cgi/*` (107 in the remainder). It also
  holds the one 135-family request that shares the fleet string's display prefix.
- **The exact per-rule split is on Craig's dashboard only** (Security → Events,
  by service). This Free zone refuses `firewallEventsAdaptiveGroups`. It is not
  estimated here.

The remainder's top 10 user agents (stopped − fleet − SearchBot − exploit, by
display string):

```
  2426  (empty UA)
   485  Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.4; +https://openai.co...
   476  Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome...
   308  facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)
    66  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0....
    53  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0...
    52  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0...
    51  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0...
    48  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0...
    46  Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 ...
```

The remainder's top 10 paths (path stopped − fleet path stopped − SearchBot
path − exploit paths). The fleet's path lists come from the two `--ua-like`
patterns, so they carry the 11 non-fleet requests: path total 4,594 against the
by-UA 4,605. That gap is also why `/.env` reads −1.

```
   381  /
    67  /api/notifications
    54  /robots.txt
    41  /cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1
    34  /agencies
    27  /favicon.ico
    15  /api/session/properties
    14  /jurisdictions/040cc038-70fb-4a3f-95e9-550c3a772efd
    13  /backup_db.sql
    13  /august-2026.sql
```

The top 30 user agents at the edge: edge / origin / stopped.

```
 1.  2926     0  2926  (empty UA)
 2.  2356   594  1762  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0...
 3.  1207     0  1207  Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; KeenableBot/1.0; +https://keen...
 4.   738   191   547  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0...
 5.   647   146   501  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0...
 6.   624   142   482  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0...
 7.   621   152   469  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0...
 8.   617   189   428  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0...
 9.   616   137   479  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0...
10.   611   155   456  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0...
11.   578    91   487  Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome...
12.   577   133   444  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0...
13.   507    71   436  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0...
14.   485     0   485  Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.4; +https://openai.co...
15.   450   450     0  curl/8.18.0
16.   308     0   308  facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)
17.   195   194     1  Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing....
18.   188   186     2  Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gec...
19.    79    59    20  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0...
20.    66     0    66  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0....
21.    53     0    53  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0...
22.    52     0    52  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0...
23.    51     0    51  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0...
24.    48     0    48  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0...
25.    46     0    46  Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 ...
26.    46     0    46  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0...
27.    45     0    45  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0...
28.    44     0    44  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0...
29.    41    39     2  Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)
30.    38    27    11  Mozilla/5.0 (iPad; CPU OS 27_0_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriO...
```
