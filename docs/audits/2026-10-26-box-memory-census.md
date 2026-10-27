# 2026-10-26 — the box memory census (cc-251, M1–M5)

**What this is.** The receipt that sizes the levers left after the dispatcher's
memory gate ([FIX-1354](../FIXES.md)). It is a set of reads, not a build. Every
read is prod, read-only, taken 2026-10-26 23:47Z → 2026-10-27 00:01Z. The box
was then 34.5 h past its 2026-10-25 13:25:53Z reboot. D6 asks one question:
*how many MB of the box's resident + swapped memory are Postgres memory we can
shape, and how many are the Supabase stack's?* §Verdict answers it and §Levers
ranks cc-252's options against the answer. Cowork writes cc-252 from this file.

Instruments: `node scripts/db-query.mjs --prod` (read-only unless stated
otherwise), `dispatch_log.box` (the on-box mirror the tick records), and one
scrape of the Supabase metrics endpoint (the URL `/api/cron/box-health` reads).
That scrape is a supplementary instrument, added because M3 was refused.

## M1 — the swap fill curve (`dispatch_log.box`, read 23:55:17Z)

**The column's shape.** `dispatch_log.box` holds `box_is_saturated()->'readings'`:
`{probe, memory, thresholds}`. `memory` = `{age_seconds, mem_available_mb,
mem_total_mb, available_pct, swap_used_mb, load1}`, rounded MB from
`pipeline_state.box_health_mem`. The tick writes it on **`armed` and box-`skipped`
rows only** (`dispatch_one_unit` steps 4 and 7). `nothing_due` and `reaped`
rows carry NULL. So the series is 728 of 9,156 rows (695 armed + 33 skipped)
from 2026-10-15 03:13Z: a sample each time the gate was evaluated *and*
something armed or was refused, not every 2 min.

| day (UTC) | n | swap min | P50 | P95 | max | MemAvail min | P50 | max | load1 max | n ≥ 1,000 swap | n < 250 avail |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 10-16 | 2 | 912 | 919 | 925.3 | 926 | 452 | 452 | 452 | 0.07 | 0 | 0 |
| 10-17 | 6 | 823 | 939 | 948.3 | 950 | 256 | 461 | 488 | 0.23 | 0 | 0 |
| 10-18 | 87 | 788 | 915 | 1,002.1 | 1,020 | 283 | 401 | 514 | 1.63 | 6 | 0 |
| 10-19 | 105 | 809 | 923 | 996.8 | 1,024 | 228 | 382 | 506 | 1.72 | 5 | 3 |
| 10-20 | 72 | 834 | 955.5 | 996.4 | 1,006 | 202 | 398.5 | 471 | 1.29 | 3 | 1 |
| 10-21 | 63 | 828 | 981 | 1,014 | 1,023 | 204 | 406 | 472 | 2.76 | 17 | 1 |
| 10-22 | 64 | 892 | 993.5 | 1,014.9 | 1,023 | 230 | 421.5 | 464 | 1.76 | 25 | 1 |
| 10-23 | 59 | 875 | 993 | 1,020.1 | 1,022 | 275 | 396 | 444 | 1.20 | 24 | 0 |
| 10-24 | 60 | 907 | 992.5 | 1,022.1 | 1,024 | 240 | 364.5 | 410 | 2.65 | 24 | 2 |
| **10-25** | 117 | 183 | 1,007 | 1,024 | 1,024 | 187 | 349 | 573 | **18.39** | 63 | 6 |
| 10-26 | 93 | 311 | 435 | 515.4 | 569 | 233 | 387 | 600 | 3.81 | 0 | 1 |

Restarts: **2026-10-08 23:42Z** (before the series; 10-16 is day 8 of that
uptime) and **2026-10-25 13:25:52Z**. The mirror's age stayed at 37–41 s on
every day except 10-25 (max 407 s, the wedge).

**The clean-day pool (10-18 → 10-24, the days whose MINs are the prompt's
788–907):** n 510, swap P50 962 / P90 1,011.1 / **P95 1,017** / P99 1,022.9 /
max 1,024. 104 samples (20 %) are at ≥ 1,000 MB, 23 (4.5 %) are at ≥ 1,018 MB,
and 40 have MemAvailable < 300 MB. The P95 is ≥ 1,000, so the prompt's rule
sets **`swap_ceiling_mb` = 1,017 + 1 = 1,018**. A 1,000 line would have
refused 20 % of a clean day's gate-evaluated ticks.

**The post-reboot fill (2-h buckets, 10-25 13:00Z → now):**

| bucket (UTC) | n | swap min / avg / max | MemAvail min / avg / max | load1 max |
|---|---|---|---|---|
| 10-25 12:00 | 9 | 183 / 211 / 262 | 366 / 464 / 573 | 6.44 |
| 10-25 14:00 | 7 | 359 / 423 / 460 | 414 / 446 / 477 | 0.15 |
| 10-25 16:00 | 5 | 289 / 418 / 494 | 317 / 433 / 476 | 0.78 |
| 10-25 18:00 | 4 | 421 / 483 / 567 | 389 / 424 / 484 | 0.15 |
| 10-25 20:00 | 4 | 369 / 470 / 604 | 309 / 429 / 521 | 0.34 |
| 10-25 22:00 | 2 | 411 / 421 / 431 | 295 / 325 / 355 | 2.10 |
| 10-26 00:00 | 5 | 422 / 447 / 474 | 265 / 377 / 430 | 0.63 |
| 10-26 02:00 | 14 | 311 / 408 / 569 | 262 / 363 / 600 | 3.81 |
| 10-26 04:00 | 14 | 326 / 403 / 499 | 255 / 322 / 406 | 1.64 |
| 10-26 06:00 | 9 | 344 / 426 / 497 | 327 / 374 / 424 | 1.29 |
| 10-26 08:00 | 12 | 337 / 436 / 515 | 253 / 359 / 493 | 1.37 |
| 10-26 10:00 | 10 | 365 / 452 / 496 | 233 / 391 / 476 | 1.79 |
| 10-26 12:00 | 4 | 449 / 498 / 554 | 426 / 434 / 453 | 0.33 |
| 10-26 14:00 | 4 | 417 / 460 / 518 | 369 / 424 / 493 | 0.18 |
| 10-26 16:00 | 6 | 422 / 469 / 516 | 374 / 430 / 498 | 0.19 |
| 10-26 18:00 | 4 | 419 / 457 / 476 | 370 / 413 / 449 | 0.31 |
| 10-26 20:00 | 5 | 335 / 435 / 477 | 281 / 391 / 449 | 0.12 |
| 10-26 22:00 | 6 | 392 / 442 / 475 | 378 / 428 / 485 | 0.16 |

The first-day step is reached in **hours**. Swap went from 183 MB at the reboot
to ~420 MB by 14:00Z and has sat at 400–470 MB average since. That floor is
the stack's plus the buffer pool's cold pages (§M4); it formed in < 2 h. The
creep after it is slow: 10-16's 912–926 MB was day 8 of the previous uptime,
and 10-21's P50 of 981 MB was day 13. One day in, MemAvailable is no better
than on the creep days: 10-26 P50 387 MB against 382–421 MB on 10-19 → 10-23.
**The creep is in swap, not in MemAvailable.**

**What the two lines would have done** (every `armed` row since 10-15 replayed;
mirror age ≤ 180 s on all of them; cap = `job_registry.cap_mb`, default 64):

| day | arms | swap ≥ 1,000 | swap ≥ 1,018 | headroom < 150 | ≥ 1,018 or headroom | ≥ 1,000 or headroom |
|---|---|---|---|---|---|---|
| 10-18 | 87 | 6 | 1 | 0 | 1 | 6 |
| 10-19 | 105 | 5 | 2 | 6 | 7 | 10 |
| 10-20 | 72 | 3 | 0 | 3 | 3 | 6 |
| 10-21 | 63 | 17 | 2 | 3 | 5 | 20 |
| 10-22 | 64 | 25 | 3 | 1 | 4 | 26 |
| 10-23 | 59 | 24 | 7 | 1 | 8 | 25 |
| 10-24 | 60 | 24 | 8 | 5 | 11 | 27 |
| 10-25 | 84 | 36 | 19 | 3 | 20 | 37 |
| **10-26** | 93 | 0 | 0 | **9** | 9 | 9 |

10-25's 04:47Z donor-rollup arm (swap 1,023, MemAvailable 290) stands down on
the ceiling. The 07:19Z ec-crawl arm (swap 1,002, MemAvailable 378) passes
both lines at 1,018: the line moved, so that arm is no longer one the gate
catches. **The headroom test is live on a one-day-old box.** It would have
deferred 9 of 10-26's 93 arms, all 128-cap crawls at MemAvailable 233–276 MB.
At the dial's 150 MB, a 256-cap row arms only when MemAvailable is ≥ 406 MB;
10-26's median reading was 387.

## M2 — the long-lived backends (`pg_stat_activity`, read 23:56:23Z)

Uptime 34.5 h (`pg_postmaster_start_time()` 2026-10-25 13:25:53.305061Z).

| group | backends | age | never recycles? |
|---|---|---|---|
| PostgREST pool (`authenticator` / `postgrest`) | 13 | 0.00–0.01 h, idle after `COMMIT` | **no**: the pool turns over in minutes |
| PostgREST `LISTEN "pgrst"` (pid 2722) | 1 | 34.38 h, idle 123,773 s | **yes** |
| `postgres_exporter` (`supabase_admin`, pid 1269) | 1 | 34.50 h | **yes** |
| Supavisor: our db-query session (`postgres`) + its `auth_query` (`pgbouncer`) | 2 | 0.02 h | no (per-session) |
| pg_cron launcher, pg_net 0.20.0 worker, logical replication launcher (`supabase_admin`) | 3 | 34.51 h | yes |
| autovacuum launcher, checkpointer, background writer, walwriter, archiver | 5 | 34.51 h | yes |

At this read no client backend other than the two above is older than 6 h. The
cache-growth candidates are those two plus the 8 auxiliary processes, **10 in
all**. pg_cron's jobs run as client backends (`cron.use_background_workers =
off`), each a fresh connection that ends with its job, so none of ours persists.

## M3 — per-backend memory: **refused**

`SELECT pg_log_backend_memory_contexts(1269)` →
`ERROR:  permission denied for function pg_log_backend_memory_contexts`
(23:56Z). `has_function_privilege('postgres', …, 'EXECUTE')` = false. The ACL
is `{supabase_admin=X/supabase_admin}` and `postgres` is not superuser
(PG 17.6, aarch64). Per the prompt, M3 stops here and no Logs API read was made.
**There is no per-backend grand-total sum.** The next row is the closest
substitute.

### M3′ — the kernel's split (the metrics endpoint, one scrape at 23:59:18Z, HTTP 200, 346 ms)

| MiB | series | reading |
|---|---|---|
| 904.3 | `MemTotal` | the box |
| 356.6 | `MemAvailable` | = the mirror's 356 |
| 46.8 | `MemFree` | |
| **208.6** | `AnonPages` | every process's private memory that is resident: Postgres backends + the stack |
| **115.2** | `Shmem` | resident shared memory, all of it (Postgres allocates 307.3, §M4) |
| 352.9 | `Active_file` + `Inactive_file` | page cache (131.7 active + 221.2 inactive) |
| 85.6 | `Slab` | 35.2 reclaimable + 50.3 not |
| 18.6 + 4.0 + 13.7 | `PageTables` + `KernelStack` + `VmallocUsed` | kernel |
| **430.9** | `SwapTotal − SwapFree` | 1,024.0 − 593.1; `SwapCached` 81.1 |
| 1,798.1 / 1,476.1 | `Committed_AS` / `CommitLimit` | overcommitted 1.22× |
| 14.7 | `process_resident_memory_bytes{gotrue}` | the only stack process with an RSS series, except |
| 9.5 | `process_resident_memory_bytes{service_type="postgresql"}` | the Go exporter (its `go_memstats` sit beside it), not Postgres |

No other stack process (PostgREST, Kong/Envoy, the admin API, vector, WAL-G)
exports an RSS series here, and PSI is not exported.

## M4 — shared memory and the buffer pool

**`pg_shmem_allocations` (23:57:38Z):** 70 allocations, **307.3 MiB**
(322,256,896 B). The top 15: Buffer Blocks 256 MB · `<anonymous>` 35 MB ·
XLOG Ctl 7,881 kB · Buffer Descriptors 2,048 kB · (unnamed) 1,221 kB ·
transaction 1,034 kB · Checkpointer Data 1,024 kB · Checkpoint BufferIds
640 kB · subtransaction 522 kB · commit_timestamp 522 kB · Buffer IO Condition
Variables 512 kB · Shared Memory Stats 274 kB · multixact_member 261 kB ·
serializable 261 kB · notify 131 kB.

**Allocated 307.3 MiB against 115.2 MiB of resident `Shmem`.** All 32,768
buffers are in use (0 unused, below), so every Buffer Blocks page has been
touched. **At least 256 − 115.2 = 141 MiB of the buffer pool is therefore in
swap now.** That is a lower bound: it assumes the other 51 MiB of Postgres shm,
and every other tmpfs page, are resident. The upper bound is all 192 MiB of
non-resident Postgres shm. Put plainly, 33–45 % of the 431 MiB of swap in use
is Postgres's own buffer pool.

**`pg_buffercache` (23:58:16Z).** `pg_available_extensions` lists it (1.5) as
not installed, and `postgres` holds CREATE on the database and on `extensions`.
It ran inside ONE transaction through `db-query --prod --call
--yes-i-mean-prod --timeout 2min`: `BEGIN; CREATE EXTENSION … SCHEMA
extensions; <reads>; ROLLBACK;`. Afterwards `pg_extension` showed 0 rows for
it, so no catalog change survived and no DROP was needed (prompt §4 allows
create + read + DROP; this did less).

| usagecount | buffers | MB | dirty |
|---|---|---|---|
| 0 | 7,404 | 58 | 0 |
| 1 | 11,568 | 90 | 15 |
| 2 | 2,174 | 17 | 24 |
| 3 | 1,143 | 9 | 6 |
| 4 | 3,050 | 24 | 8 |
| 5 | 7,429 | 58 | 53 |

**The cold share: 18,972 of 32,768 buffers (57.9 %, 148 MiB) at usagecount
≤ 1**, with 0 unused and 106 dirty. Top 15 relations by buffers held:

| relation | kind | buffers | cached | relation size | % of rel cached | usage ≤ 1 | avg usage |
|---|---|---|---|---|---|---|---|
| public.financial_relationships_contract_grant_updated_at | i | 8,003 | 63 MB | 63 MB | 99.5 | 8,002 | 0.87 |
| public.officials | r | 2,590 | 20 MB | 20 MB | 100.0 | 0 | 4.12 |
| cron.job_run_details | r | 2,444 | 19 MB | 19 MB | 100.1 | 3 | 4.99 |
| public.financial_relationships | r | 2,318 | 18 MB | 5,255 MB | 0.3 | 1,623 | 0.88 |
| public.votes | r | 1,776 | 14 MB | 571 MB | 2.4 | 1,586 | 0.80 |
| public.data_sync_log | r | 1,584 | 12 MB | 12 MB | 100.2 | 0 | 4.99 |
| public.votes_updated_at | i | 1,468 | 11 MB | 17 MB | 69.1 | 1,467 | 0.00 |
| public.financial_entities_pkey | i | 1,438 | 11 MB | 232 MB | 4.8 | 1,207 | 1.16 |
| public.proposals | r | 950 | 7,600 kB | 146 MB | 5.1 | 267 | 3.19 |
| public.financial_entities | r | 935 | 7,480 kB | 1,919 MB | 0.4 | 878 | 0.53 |
| public.financial_entities_canonical_trgm | i | 899 | 7,192 kB | 312 MB | 2.3 | 899 | 0.39 |
| public.enrichment_queue | r | 650 | 5,200 kB | 274 MB | 1.9 | 62 | 2.38 |
| pg_toast.pg_toast_44214 | t | 567 | 4,536 kB | 6,440 kB | 70.4 | 471 | 0.47 |
| public.entity_tags_fe_industry_content | i | 485 | 3,880 kB | 7,376 kB | 52.6 | 393 | 0.85 |
| pg_toast.pg_toast_135670 | t | 473 | 3,784 kB | 85 MB | 4.3 | 13 | 1.98 |

The hot set is small tables read on every tick or route: officials,
`cron.job_run_details`, `data_sync_log`. The largest single holder is one
63 MB index held whole and **cold** (avg usage 0.87): the ec crawl's
`updated_at` walk over contract/grant rows.

**`pg_stat_io`, object = relation (cumulative since 13:25:53.578Z):**

| backend_type | context | reads | writes | hits | evictions | reuses |
|---|---|---|---|---|---|---|
| client backend | normal | 29,901,619 | 3,705,525 | 316,775,934 | 30,153,638 | — |
| client backend | bulkread | 11,025,609 | 224,759 | 104,364 | 192,016 | 10,833,596 |
| client backend | vacuum | 2,906,048 | 1,303,370 | 142,087 | 12,820 | 2,893,228 |
| autovacuum worker | vacuum | 1,273,885 | 290,466 | 162,649 | 14,666 | 1,259,219 |
| background worker | vacuum | 1,061,841 | 440,684 | 37,031 | 2,449 | 1,059,392 |
| background worker | bulkread | 805,394 | 71,100 | 1,584 | 92,839 | 712,540 |
| background worker | normal | 66,020 | 16,237 | 227,940 | 66,007 | — |
| autovacuum worker | normal | 21,440 | 791 | 922,739 | 21,406 | — |
| background writer | normal | — | 3,755,300 | — | — | — |
| checkpointer | normal | — | 290,083 | — | — | — |

The pool churns. Client backends evicted **30.15 M buffers in 34.5 h**, about
243 evictions a second and 26.7× the pool's size each hour, against 29.9 M normal
reads. `pg_stat_database` hit ratio is 87.10 % (318.4 M hits / 47.2 M reads).
`background worker` here means parallel workers, since pg_cron jobs are client
backends. They did 1.93 M reads, 4.2 % of all relation reads (805 k of them
parallel seq-scan bulkreads, 1.06 M parallel-vacuum index reads).
`track_io_timing` is off, so the `read_time` columns are 0.

## M5 — the knobs as they stand (read 23:57:38Z)

| setting | prod value | source | PG default (boot_val) | tree / FIX-589 note |
|---|---|---|---|---|
| shared_buffers | 32768 × 8 kB = **256 MB** | configuration file | 128 MB | 06-14 audit: 256 MB, ≈ RAM/4 by tier |
| work_mem | **64 MB** | database user (`postgres`@`postgres`) | 4 MB | 06-14 read 3.4 MB (the platform default then) |
| hash_mem_multiplier | **2** | default | 2 | → 128 MB per hash node at 64 MB |
| maintenance_work_mem | 64 MB | configuration file | 64 MB | |
| autovacuum_work_mem | -1 (→ maintenance_work_mem, 64 MB) | default | -1 | ≤ 3 × 64 MB with 3 workers |
| autovacuum_max_workers | 3 | default | 3 | |
| max_parallel_workers_per_gather | **1** (`reset_val`; the 0 read is db-query's `SET LOCAL`) | configuration file | 2 | |
| max_parallel_workers | 2 | configuration file | 8 | |
| max_worker_processes | 12 | configuration file | 8 | |
| max_parallel_maintenance_workers | 1 | configuration file | 2 | |
| effective_cache_size | 98304 × 8 kB = 768 MB | configuration file | 4 GB | 06-14: 768 MB |
| temp_buffers | 8 MB | default | 8 MB | |
| wal_buffers | 983 × 8 kB ≈ 7.7 MB | configuration file | -1 | |
| max_connections | 60 | configuration file | 100 | 06-14: 60 |
| huge_pages | try (HugePages_Total 0, so none) | default | try | |
| track_io_timing | off | default | off | |
| log_min_duration_statement | -1 | default | -1 | |
| jit | off | configuration file | on | |
| statement_timeout | 3 h (postgres@postgres) | database user | 0 | FIX-1185 |

**`pg_db_role_setting`:** `postgres`@`postgres` `{statement_timeout=3h,
work_mem=64MB}` · `postgres`@all `{search_path="$user", public, extensions}` ·
`authenticator`@all `{session_preload_libraries=safeupdate,
statement_timeout=8s, lock_timeout=8s}` · `anon` `{statement_timeout=3s}` ·
`authenticated` `{statement_timeout=8s}` · `supabase_admin` `{search_path=…,
log_statement=none, statement_timeout=0}` · `supabase_auth_admin`
`{search_path=auth, idle_in_transaction_session_timeout=60000,
log_statement=none}` · `supabase_read_only_user`
`{default_transaction_read_only=on}` · `supabase_storage_admin`
`{search_path=storage, log_statement=none}` · all@`postgres`
`{app.settings.jwt_exp=3600}`. Nothing is set on a `postgrest` role (there is
none; PostgREST logs in as `authenticator`). `service_role` has no row.

**`pg_stat_statements`:** 747 statements, 310,096 calls;
`pg_stat_statements_info.stats_reset` 2026-10-25 13:25:52.563285Z (the reboot).

The in-body overrides sit on top of this. `refresh_derived_mvs` runs `SET
work_mem = '128MB'` as a plain SET that survives its COMMITs
(`20261004075000:548`), so each of the daily's 13 units gets 256 MB of hash
headroom per hash node. cc-186 counted 24 procedures with an in-body `SET
work_mem` and 5 more in `proconfig`.

## Verdict (D6)

**How much of the box is Postgres memory we can shape, and how much is the
stack's?** Read at 23:5xZ, 34.5 h after the reboot, with 904 MiB resident and
431 MiB of swap in use:

1. **Postgres shared memory: 307 MiB allocated, 115 MiB of it resident, and
   ≥ 141 MiB of the buffer pool in swap.** Only `shared_buffers` shapes it.
   57.9 % of the pool (148 MiB) is cold at usagecount ≤ 1, and that cold part
   is roughly the part the kernel has already swapped out. The pool keeps paying
   for those pages: a "hit" on a swapped buffer is a major fault, slower than a
   page-cache read. The pool still churns at 26.7× its size an hour.
2. **Postgres backends' private memory: not measurable from `postgres`** (M3
   refused). At most 10 processes persist (M2), 2 of them clients. PostgREST's
   pool turns over in minutes, and every unit of ours is a fresh connection. All
   private memory together, every process on the box, is 208.6 MiB resident
   (`AnonPages`) plus 239–290 MiB of swap (the 431 less the 141–192 of shm).
   About 450–500 MiB in all, and it cannot be split between Postgres backends
   and the stack from here. The part of it ours can move is the *burst*: work_mem
   × hash_mem_multiplier per hash node, the parallel worker, and the unit caps
   the dispatcher admits. The resident baseline is not ours.
3. **The kernel and the page cache are not levers:** about 122 MiB kernel
   (Slab 85.6, PageTables 18.6, KernelStack 4.0, Vmalloc 13.7) and 353 MiB of
   page cache. MemAvailable counts most of the cache.

**One line: our levers can move ~141–148 MiB of the box's 904 MiB resident +
431 MiB swapped as standing memory (the buffer pool's cold, swapped share), and
shape the bursts above the baseline. The other ~450–500 MiB of process
memory, plus the kernel, is either the stack's or unattributable without
`supabase_admin`.**

## Levers (Cowork's seven, ranked against the rows)

| # | lever | the row that supports or refutes it | verdict |
|---|---|---|---|
| 1 | **the gate** (this run, FIX-1354) | M1: 19 of 10-25's 84 arms at swap ≥ 1,018. The headroom test defers 9 of 10-26's 93 on a one-day box | **landed**. It frees nothing; it stops arming into the floor |
| 7 | **`shared_buffers`** 256 → 128 MB | M4: ≥ 141 MiB of the pool in swap, 57.9 % cold, 30.15 M evictions in 34.5 h. M3′: `Shmem` resident 115.2 of 307.3 allocated | **largest standing number**, about 128 MiB of swap occupancy back, with the page cache serving those reads instead. Needs a restart and Supabase's config path. Craig's call, best paired with #3 of his plan (the restart) |
| 3 | `hash_mem_multiplier` 2 → 1 on `postgres` | M5: work_mem 64 MB × 2 = 128 MB per hash node; `refresh_derived_mvs`'s in-body 128 MB × 2 = 256 MB | **halves the per-node burst** (128 → 64, 256 → 128). It does not touch the baseline. Every in-body `SET work_mem` keeps its multiplier, so set it on the role, not in the body |
| 2 | `max_parallel_workers_per_gather` = 0 on `postgres` | M5: the server is already at **1**, not 2. M4: parallel workers = 4.2 % of reads (805 k parallel bulkreads) | **small**. At 1, each parallel plan adds at most one worker backend + a DSM segment. The ad-hoc class is already 0 (db-query). Worth doing for the DSM refusal class (cc-188), not for MB |
| 4 | dispatcher dials + `autovacuum_work_mem` caps | M5: `autovacuum_work_mem` −1 → 64 MB × 3 workers; `max_live_caps_mb` 1,024, `max_concurrent_units` 2 | **moderate, burst-only**. 3 × 64 MB autovacuum is up to 192 MB beside two units; a 32 MB cap halves it |
| 5 | the status half's fan-out (FIX-1292) | cc-203: one burst per firing, 50–150 MB MemAvailable dip at :00/:30 | **burst-only**, not in this census's rows (no per-statement memory read). Unchanged from cc-203 |
| 6 | PostgREST's pool | M2: 13 of 14 pool backends ≤ 0.01 h old. Only the LISTEN backend persists | **refuted as a cache-growth lever**. The pool recycles; its cost is connection count (14 of 60), not a growing cache |

**Ranking for cc-252:** #3 (one role setting, halves every hash burst) and #2
(one role setting, removes the DSM class) are cheap and reversible. #4's
`autovacuum_work_mem` is the third role-level knob. #7 is the only lever with a
standing ~130 MiB, and it rides a restart, so it is Craig's to schedule with
the day-10 restart. #5 and #6 do not show in these rows.
