# `work_mem` allowance census — R1–R6, and the five M1 verdicts (cc-210)

**Run:** cc-210, Fri 2026-10-09 01:03Z onward. **Design of record:** Cowork's
`design-q4-role-work-mem-census-2026-10-07.md` (D1–D7 ratified 10-07).
**Instruments:** prod reads through `node scripts/db-query.mjs --prod` (READ
ONLY, `SET LOCAL max_parallel_workers_per_gather = 0` prelude); the Upstash
memory ring (`box-health-series.ts --hours 24 --json`) plus the banked
`docs/audits/2026-10-06-burst-census-ring-pre.json`; the local prod-clone for
R5. Every figure names its database and the time it was read.

This is the seed of a registry: §1's table keeps one row per active pg_cron
job, with columns meant to stay stable when `cron_job_budget`,
`rollup_watch_overrides`, `PIPELINE_BUDGET_REFS` and FIX-1137's list are
consolidated.

---

## §0 The two rule-81 windows

A reading inside a wedge or a saturation window is neither a failed nor a
successful leg. Two windows are excluded everywhere below:

| window | from | to | why |
|---|---|---|---|
| W1 | 2026-10-06 16:04Z | 2026-10-07 00:48Z | the FIX-1284 wedge (rule-taggers-weekly) |
| W2 | 2026-10-08 17:10Z | **2026-10-08 23:50:00Z** | usaspending-bulk ran 5 h 52 m to its cap (FIX-1291) |

**Box-clear = 2026-10-08T23:50:00Z.** cc-209 derived it
(`docs/cc/reports/cc-209.md` §1). The last `job startup timeout` started
23:40:00Z, so the jobid-53 probe at 23:50:00.076Z is the first with
`startup_timeouts_10m = 0`, and the ring's 23:48:22Z sample reads load1 1.06.
This run's own read agrees: at **01:04:23Z** `box_health` read
`startup_timeouts_10m 0`, `startup_timeouts_60m 0`, and `box_health_mem`
(01:02:23Z) read load1 1.6, MemAvailable 272 MB. The postmaster restarted at
**23:42:45.349Z** (`pg_postmaster_start_time()`); FIX-1291's append records it
as Craig's hand restart. pgss survived it (`stats_reset` unchanged,
`dealloc 0`), so it was a clean shutdown.

---

## §1 R1 — the live allowance table (prod, catalog reads, 01:07:43Z)

**Settings.** `hash_mem_multiplier` 2 (default) · `max_parallel_workers_per_gather`
**1** (`reset_val`; boot 2) · `max_parallel_workers` 2 · `maintenance_work_mem`
64MB · `shared_buffers` 256MB · `temp_file_limit` −1. Role row
`postgres@postgres` = **`{statement_timeout=3h, work_mem=256MB}`**
(`pg_db_role_setting`), the only row carrying `work_mem`. `work_mem` itself
reads 262,144 kB with `source = database user`; its boot value is 4 MB.

**Every public routine that SETs a memory or parallel GUC** (the
`docs/audits/2026-10-04-measure-first-census.md:1440` regex, verbatim, plus
`proconfig`): 30 routines.

| allowance | in-body SET | proconfig |
|---|---|---|
| 256MB | `run_entity_connections_rebuild`, `donor_rollup_rebuild_bulk`, `rebuild_official_vote_stats`, `run_rule_taggers` (before the cadence split), `refresh_treemap_individuals_global`, `refresh_donor_party_rollup_incremental` (+ parallel 0), `refresh_contract_flow_rollups`, `reconcile_donation_edge_orphans`, `reconcile_donor_party_rollup_orphans`, `reconcile_donor_rollup_orphans`, `reconcile_entity_connection_stats_orphans`, `reconcile_financial_entity_totals`; `SET LOCAL` in `rebuild_entity_search_index` and `refresh_group_donor_rollup`; backfills `backfill_official_donor_brackets`, `backfill_treemap_individuals_focused` | `refresh_donor_party_rollup_slice` |
| 128MB | `refresh_derived_mvs` (+ parallel 0, weekly only), `refresh_agency_staffing_rollup`, `refresh_sector_affinity_from_tag_changes`, `reconcile_recipient_count`, `refresh_official_donor_rollup_incremental`, `refresh_financial_entity_totals_incremental`; backfills `backfill_official_sector_affinity_rollup`, `backfill_official_small_dollar_rollup` | — |
| 64MB | `run_rule_taggers` weekly branch (FIX-1284) | `entity_search_conn_window` (+ parallel 0), `rebuild_entity_connection_stats_window`, `refresh_entity_connection_stats_mv` (+ parallel 0), `refresh_fe_inbound_rollup_unit`, `refresh_fe_totals_slice` |
| none (inherits the role) | `refresh_platform_counts`, `purge_abuse_events`, the `*/1` and `*/2` probe/watchdog functions, `run_fe_totals_crawl` / `run_fe_inbound_rollup` / `run_group_donor_rollup_refresh` (wrappers) | — |

Against the design's §2 table: **it matches**, with two additions the design
did not list — a fifth 64MB proconfig unit (`refresh_entity_connection_stats_mv`,
not four), and two 256MB / two 128MB `backfill_*` procedures that no cron job
calls. **21 active CALL jobs; 17 SET `work_mem` in the CALLed body or its one
callee; 13 of them run at 256MB** (counting `rule-taggers-weekly` at its merge's
64MB and `group-donor-rollup-refresh` through its callee's `SET LOCAL`).

R1's callee column flagged `reconcile_recipient_count` (SET 128MB) under
ec-crawl and `refresh_official_donor_rollup_incremental` (SET 128MB) under
donor-rollup. **Both are comment mentions, not calls** (`grep` of the bodies):
no callee raises a plain `SET work_mem` back up after M1 lowers it.

**The five M1 bodies, live vs file (Phase 0 read 2, 01:06:33Z):** `md5(prosrc)`
on prod equals the md5 of the body in its latest migration file for all five —
`run_entity_connections_rebuild` 0ee1ec81… (68,027 chars,
`20261004100000`), `donor_rollup_rebuild_bulk` ac384aa6… (36,527,
`20261004190000`), `rebuild_entity_search_index` c65a676a… (17,280,
`20261004100000`), `run_rule_taggers` 174a0ba9… (13,013, `20261007010000`),
`rebuild_official_vote_stats` 6fc336db… (3,498, `20260911000200`). No STOP.
`proconfig`: NULL on the three COMMITting procedures; `search_path` only on
`rebuild_entity_search_index` (a function) and `rebuild_official_vote_stats`
(a procedure — so it is atomic and has no COMMIT). `refresh_platform_counts`'
prod body (7,702 chars) is the `20260906000400_fix1126` body (7,557) with CRLF
line endings — 145 lines, 145 characters; the content is identical. Its latest
definition is that file, not `20260911000200` (which mentions it only in a
comment).

### §1.1 The registry rows (one per active job)

Cap = `work_mem × hash_mem_multiplier` per hash node, per process. A parallel
hash multiplies it by the participants (leader + 1 worker at prod's
`max_parallel_workers_per_gather = 1`) unless the body zeroes parallel. "Last
wall" and p50/max are from `cron.job_run_details`, last 30 d, startup-timeout
rows dropped (§3's read). Cost class is the evidence named: R2 temp (pgss), R4
MemAvailable drop, R5 node sizes.

| jobname | active | schedule | body work_mem → cap MB | parallel zeroed | cost class | unit shape | cron_job_budget s | last wall s (p50 / max, 30 d) |
|---|---|---|---|---|---|---|---|---|
| abuse-events-retention | t | `15 4 * * *` | role 256 → 512 | no | trivial (0.1 s) | multi-txn | — | 0.1 (0.1 / 0.1) |
| agency-staffing-rollup-refresh | t | `5 0 * * 2` | 128 → 256 | no | memory, small (R4 n/a) | multi-txn | 3600 | 30.5 (42.0 / 58.3) |
| box-health-probe | t | `* * * * *` | role 256 → 512 | no | trivial | function | 60 | — |
| contract-flow-rollups-refresh | t | `0 14 * * 4` | 256 → 512 | no | **memory** (pgss 3,018 MB temp / 3 calls; R4 −240 MB) | multi-txn | 9000 | 1903.7 (1904.4 / 5892.2) |
| cron-job-budget-watchdog | t | `*/2 * * * *` | role 256 → 512 | no | trivial | function | — | — |
| cron-job-run-details-retention | t | `51 1 * * *` | role 256 → 512 | no | I/O | DELETE | 300 | — |
| derived-mvs-unit-watchdog | t | `*/2 * * * *` | role 256 → 512 | no | trivial | function | — | — |
| donation-edge-orphan-sweep | t | `30 11 1 * *` | 256 → 512 | no | **memory** (pgss 1,451 MB / 1 call) | multi-txn | — | 135.5 (135.5 / 135.5) |
| donor-party-rollup-orphan-sweep | t | `0 13 1 * *` | 256 → 512 | no | I/O (pgss 0 temp, 503,897 blks) | multi-txn | — | 290.5 (290.5 / 290.5) |
| donor-party-rollup-refresh | t | `0 15 * * 2` | 256 + slice proconfig 256 → 512 | **yes** | memory | multi-txn (slices) | 1800 | 78.8 (78.8 / 11335.1) |
| donor-rollup-orphan-sweep | t | `30 12 1 * *` | 256 → 512 | no | memory (pgss 225 MB / 1) | multi-txn | — | 103.5 (103.5 / 103.5) |
| donor-rollup-refresh | t | `0 9,12 * * *` | 256 → 512 | no | **memory** (pgss 3,182 MB / 32; R4 −231 MB, swap-in 2,137/s) | multi-txn, cursor-resumable | 9000 | 0.3 (0.2 / 2498.2) |
| dpr-vacuum-analyze | t | `0 2 * * 0,3` | maint 64 | — | I/O | VACUUM | — | 7.8 (2.4 / 8.0) |
| ec-crawl | t | `*/15 * * * *` | 256 → 512 (arms: stats window proconfig 64) | no | **memory + I/O** (contracts arm 411.7 s; pgss 416 MB / 1,514) | multi-txn, cursor-resumable | 1800 | 284.3 (0.2 / 2109.3) |
| ec-vacuum-analyze | t | `30 4 * * *` | maint 64 | — | I/O | VACUUM | — | 8.9 (78.9 / 3147.9) |
| ecs-vacuum-analyze | t | `20 11,17 * * *` | maint 64 | — | I/O | VACUUM | — | 5.7 (4.4 / 17.5) |
| entity-connection-stats-orphan-sweep | t | `30 13 1 * *` | 256 → 512 | no | I/O (pgss 0 temp) | multi-txn | — | 92.8 (92.8 / 92.8) |
| fe-crawl | t | `*/30 * * * *` | wrapper role 256; slice proconfig 64 → 128 | no | I/O | multi-txn, cursor-resumable | 1800 | 40.3 (0.2 / 1952.5) |
| fe-inbound-rollup-refresh | t | `13 2 * * *` | wrapper role 256; unit proconfig 64 → 128 | no | trivial | multi-txn | 1800 | 0.1 (0.1 / 102.7) |
| fe-vacuum-analyze | t | `50 4 * * *` | maint 64 | — | I/O | VACUUM | — | 12.8 (11.6 / 99.2) |
| financial-entity-totals-reconcile | t | `0 12 1 * *` | 256 → 512 | no | I/O (pgss 0 temp, 1.75M blks) | multi-txn | — | 155.4 (155.4 / 155.4) |
| fr-vacuum-analyze | t | `0 3 * * *` | maint 64 | — | I/O | VACUUM | — | 10.7 (10.4 / 212.0) |
| group-donor-rollup-refresh | t | `10 3 * * 3` | callee SET LOCAL 256 → 512 | no | memory (R4 −187 MB) | atomic wrapper | 1800 | 101.5 (101.5 / 294.2) |
| odbt-vacuum-analyze | t | `18 11,17 * * *` | maint 64 | — | I/O | VACUUM | — | 0.1 (0.3 / 1.4) |
| odr-mv-vacuum-analyze | t | `5 11,17 * * *` | maint 64 | — | I/O | VACUUM | — | 2.0 (1.5 / 2.5) |
| odt-vacuum-analyze | t | `12 11,17 * * *` | maint 64 | — | I/O | VACUUM | — | 0.1 (0.2 / 0.3) |
| officials-vacuum-analyze | t | `30 1 * * 1` | maint 64 | — | I/O | VACUUM | — | 4.0 (3.8 / 4.0) |
| osar-vacuum-analyze | t | `16 11,17 * * *` | maint 64 | — | I/O | VACUUM | — | 0.2 (0.3 / 1.0) |
| osdr-vacuum-analyze | t | `14 11,17 * * *` | maint 64 | — | I/O | VACUUM | — | 0.2 (0.2 / 0.2) |
| platform-counts-daily | t | `53 3 * * *` | role 256 → 512 | no | I/O (plain counts; R5 §5) | atomic (proconfig) | 1800 | 29.1 (59.7 / 324.6) |
| refresh-derived-mvs-daily | t | `0 6 * * *` | 128 → 256; unit 9 SET LOCAL 256 → 512 | weekly only | **memory + I/O** (pgss 5,329 MB / 18; R4 −204 MB) | multi-txn, per-unit | 5400 | 295.2 (354.8 / 1207.6) |
| refresh-derived-mvs-weekly | t | `47 0 * * 2` | 128 → 256 (+ unit 9 256) | **yes** | memory + I/O | multi-txn, per-unit | 5400 | 1407.5 (1407.5 / 1593.2) |
| rule-taggers-daily | t | `30 6 * * *` | 256 → 512 | no | **I/O** (R5: every node under 64MB, 360k blocks read cold; R4 −272 MB → 169 MB, the 24 h ring's minimum) | multi-txn | 7200 | 203.3 (225.7 / 7203.5) |
| rule-taggers-weekly | t | `0 16 * * 2` | merge 64 → 128 (gate + sig read at 256) | no | memory | multi-txn | 7200 | 19043.9 (5062.9 / 19043.9) |
| treemap-individuals-global-refresh | t | `0 14 * * 2` | 256 → 512 | no | in-RAM (pgss 0 temp; 4.49M blks, max 907.5 s) | multi-txn | 5400 | 872.2 (916.4 / 994.1) |
| treemap-individuals-vacuum-analyze | t | `10 11,17 * * *` | maint 64 | — | I/O | VACUUM | — | 0.6 (0.6 / 1.4) |
| vm-probe-pre-ec | t | `25 4 * * *` | role 256 → 512 | no | trivial | function | — | — |
| vm-probe-pre-fe | t | `45 4 * * *` | role 256 → 512 | no | trivial | function | — | — |
| vm-probe-pre-fr | t | `55 2 * * *` | role 256 → 512 | no | trivial | function | — | — |
| vote-stats-refresh | t | `30 3 * * *` | 256 → 512 | no | small (R5: every node under 64MB; pgss 0 temp; R4 −112 / −126 MB) | **atomic** (proconfig) | — | 15.1 (22.2 / 45.3) |
| votes-vacuum-analyze | t | `37 2 * * 6` | maint 64 | — | I/O | VACUUM | — | 24.8 (24.8 / 24.8) |

Inactive: `entity-connection-stats-rebuild`, `financial-entity-totals-incremental`,
`rebuild-ec-incremental`, `rebuild-ec-incremental-mon`.

---

## §2 R2 — who spills (prod pgss, `userid = postgres`, read 01:11:53Z)

`pg_stat_statements_info.stats_reset` **2026-09-22 22:32:13Z** (16.1 d) —
unchanged, as expected; `dealloc 0`; `track = top`, so a CALL row carries its
nested statements' work. By role: **postgres 18,185 MB temp written** (2,924
statements, 81,495 calls) · anon 3,653 MB · service_role 640 MB.

| # | calls | temp written MB | shared blks read | max s | mean s | statement |
|---:|---:|---:|---:|---:|---:|---|
| 1 | 18 | 5,329 | 29,175,497 | 1593.1 | 460.1 | `CALL public.refresh_derived_mvs($1)` |
| 2 | 32 | 3,182 | 8,627,750 | 2498.1 | 175.8 | `CALL public.donor_rollup_rebuild_bulk()` |
| 3 | 3 | 3,018 | 8,880,565 | 1904.2 | 1899.1 | `CALL public.refresh_contract_flow_rollups()` |
| 4 | 2 | 1,594 | 866,019 | 324.7 | 282.8 | ad-hoc `SELECT ec.id, ec.from_id, … array_agg(e.fr_…` |
| 5 | 1 | 1,451 | 1,004,630 | 135.5 | 135.5 | `CALL public.reconcile_donation_edge_orphans()` |
| 6 | 17 | 935 | 2,474,588 | 619.7 | 80.9 | `CALL public.refresh_sector_affinity_from_tag_changes()` |
| 7 | 1 | 867 | 501,640 | 279.5 | 279.5 | `REFRESH MATERIALIZED VIEW public.chord_industry_flows_mv_new` (ad-hoc, cc-198) |
| 8 | 1,514 | 416 | 80,199,544 | 2108.4 | 23.6 | `CALL public.run_entity_connections_rebuild($1, p_max_units := $2)` |
| 9–10 | 1 + 1 | 329 + 329 | ~324k each | 110.7 / 116.5 | — | ad-hoc `WITH pats(name, pat) AS (VALUES …` |
| 11 | 1 | 314 | 1,272,247 | 93.3 | 93.3 | `CREATE INDEX CONCURRENTLY … financial_relationships_fe_spending_idx` (migration) |
| 12 | 1 | 225 | 656,467 | 103.4 | 103.4 | `CALL public.reconcile_donor_rollup_orphans()` |
| 13 | 18 | 186 | 19,733,613 | 18519.3 | 1493.0 | `CALL public.run_rule_taggers($1)` (max = the 10-06 wedge) |

Expected: `refresh_derived_mvs`, `refresh_contract_flow_rollups`,
`reconcile_donation_edge_orphans`, `donor_rollup_rebuild_bulk` as on 10-04 —
**all four are in the top five.** Every other row in the top 30 spilled less
than 12 MB.

**Design §0.4 — the 10-07 02:03Z read is in the instrument.** No
`chord_industry_flows` row runs 8.5 min. A second pgss read (01:12:32Z) for any
statement with `max_exec_time` 480–540 s found it under its real text: `SELECT
sum(fr.amount_cents)::bigint AS cif_ledger FROM financial_relationships fr JOIN
officials o … JOIN financial_entities fe …` — **1 call, 509.7 s, temp written
0, shared blocks read 494,675 (3.8 GB)**, role `postgres`. So it ran under the
role's 256MB, spilled nothing, and held whatever it hashed in private memory
(up to a 512 MB hash per node). The banked ring brackets it exactly: swap-in
24.5/s at 02:00:22Z, 287/s at 02:02:22Z, then **1,494 → 3,344 → 3,485 →
3,260/s** at 02:04–02:10Z, 2,063/s at 02:12:22Z as it ended, MemAvailable 491
→ 249 MB. The day's minimum (180 MB at 02:14:22Z) is 2–3 min after it ended,
on the storm's tail (swap-in still 831/s), coinciding with a 4-s
`fe-inbound-rollup-refresh` firing that on 10-08 moved MemAvailable *up*
109 MB. **Verdict: the ad-hoc read owned the 02:02–02:12Z swap storm** —
the instrument, not a coincidence of instants. It is exactly the class B0
lowers.

**The 10-08 USASpending upserts did not lead the temp ranking — they wrote
zero temp.** Twelve `postgres`-role `INSERT … ON CONFLICT` shapes on
`financial_relationships` / `financial_entities` (1,289 / 406 / 261 / 682 …
calls; up to 4,568 s total and 657.8 s max per shape; 6.8M shared blocks read
for the largest) — `temp_blks_written` 0 for all twelve. They are the ad-hoc
class (R6), they are I/O and WAL load rather than `work_mem` load, and pgss
cannot separate 10-08's calls from earlier FEC-bulk calls that share the
`direct-pg-upsert` shapes since 09-22. **Not an M1 input.**

---

## §3 R3 — the overlap ledger (prod `cron.job_run_details`, 30 d, read 01:11:54Z)

One read, EXPLAINed first (Seq Scan of `job_run_details`, ~69k rows in 30 d,
hash-joined to `cron.job`; cost 4,033): 5,053 runs of the active `CALL` and
`VACUUM` jobs, 2026-09-09 01:15Z → 10-09 01:00Z. The self-join ran offline. 58
startup-timeout rows (never ran) are dropped; probe/watchdog `SELECT` jobs are
not `CALL` jobs and fall out by construction. A pair whose overlap lies wholly
inside W1 or W2 is not counted.

| pair | pairs | max overlap s | at | Σ overlap s | caps A+B MB | removed W1 | removed W2 |
|---|---:|---:|---|---:|---:|---:|---:|
| ec-crawl × fe-crawl | 1397 | 329 | 09-14 01:00Z | 2041 | 640 | 6 | 8 |
| donor-rollup-refresh × ec-crawl | 65 | **1806** | 10-04 09:00Z | 4161 | **1024** | 0 | 0 |
| donor-rollup-refresh × fe-crawl | 61 | 165 | 09-09 09:00Z | 178 | 640 | 0 | 0 |
| ec-crawl × rule-taggers-daily | 43 | 38 | 09-17 07:00Z | 62 | 1024 | 0 | 0 |
| fe-crawl × rule-taggers-daily | 33 | 41 | 09-17 07:00Z | 50 | 640 | 0 | 0 |
| ec-crawl × refresh-derived-mvs-daily | 31 | 1 | 09-17 06:15Z | 5 | 1024 | 0 | 0 |
| ec-crawl × vote-stats-refresh | 30 | 39 | 10-01 03:30Z | 271 | 1024 | 0 | 0 |
| fe-crawl × vote-stats-refresh | 30 | 27 | 09-14 03:30Z | 32 | 640 | 0 | 0 |
| fe-crawl × refresh-derived-mvs-daily | 30 | 1 | 09-10 06:00Z | 6 | 640 | 0 | 0 |
| abuse-events-retention × ec-crawl | 29 | 0 | 09-18 04:15Z | 2 | 1024 | 0 | 0 |
| contract-flow-rollups-refresh × ec-crawl | 17 | **1887** | 09-17 14:45Z | 2967 | **1024** | 0 | 0 |
| ec-crawl × rule-taggers-weekly | 13 | 1 | 09-15 17:00Z | 3 | 640 | 0 | 0 |
| contract-flow-rollups-refresh × fe-crawl | 10 | 0 | 09-17 14:30Z | 2 | 640 | 0 | 0 |
| ec-crawl × treemap-individuals-global-refresh | 7 | 1 | 09-22 14:15Z | 3 | 1024 | 0 | 0 |
| fe-crawl × rule-taggers-weekly | 7 | 1 | 09-15 17:00Z | 3 | 256 | 0 | 0 |
| fe-crawl × refresh-derived-mvs-weekly | 4 | 251 | 09-15 01:00Z | 252 | 640 | 0 | 0 |
| ec-crawl × refresh-derived-mvs-weekly | 4 | 89 | 09-22 01:00Z | 173 | 1024 | 0 | 0 |
| fe-crawl × treemap-individuals-global-refresh | 4 | 0 | 10-06 14:00Z | 1 | 640 | 0 | 0 |
| donor-party-rollup-refresh × ec-crawl | 3 | 0 | 10-06 15:00Z | 1 | 1024 | 0 | 0 |
| donor-party-rollup-refresh × fe-crawl | 3 | 0 | 10-06 15:00Z | 1 | 640 | 0 | 0 |
| (12 more pairs, each 1 × ≤ 0 s — the 10-01 monthly sweeps against the crawls, and donor-rollup × fe-totals-reconcile) | 12 | 0 | 10-01 | 0 | 640–1024 | 0 | 0 |

**Worst pairs: ec-crawl × contract-flow (1,887 s) and ec-crawl × donor-rollup
(1,806 s), both 512 + 512 = 1,024 MB.** No counted pair's summed cap
**exceeds** 1,024 MB, so the R3 STOP does not fire and M1 proceeds. Two
caveats the STOP's arithmetic does not carry, both of which M1 addresses:

- The cap above is per hash node and **serial**. ec-crawl, donor-rollup,
  contract-flow and vote-stats do not zero parallel, so on prod (`max_parallel_
  workers_per_gather = 1`) a Parallel Hash among them is budgeted at
  `hash_mem × 2 participants` = 1,024 MB for one job. Counted that way, both
  worst pairs are 1,536 MB. B1/B2/B6 add `max_parallel_workers_per_gather = 0`
  for this reason.
- The R3 ledger sees only pg_cron. GHA writers (nightly, FEC/USASpending bulk)
  and ad-hoc reads overlap on top, at the role's 256MB.

**W2 removed 8 pairs, W1 removed 6** — all ec-crawl × fe-crawl.

---

## §4 R4 — the empirical footprint per firing (off-box ring; no prod read)

Rings: the banked 10-07 00:50Z → 23:42Z ring (`2026-10-06-burst-census-ring-pre.json`
— named for the 10-06 census, sampled on 10-07; it predates W2) and the live
24 h ring read 01:09:54Z (10-08 01:10Z → 10-09 01:08Z; dark from 19:18Z with
scattered samples to 23:44Z, which is W2). 2-min samples. "Before" = the last
sample at or before `start_time`; "during" = samples in `[start, end + 2 min]`.
Swap-in is `pswpin` (rule 181: the instrument; MemAvailable can rise during a
swap-out). Crawl units under 60 s are not shown — one 2-min sample cannot
separate them from what runs beside them.

| job | start | wall s | MemAvail before MB | min during MB | Δ MB | swap-in max /s | load1 max |
|---|---|---:|---:|---:|---:|---:|---:|
| **rule-taggers-daily** | 10-08 06:30Z | 203 | 441 | **169** | **−272** | 621 | 2.06 |
| rule-taggers-daily | 10-07 06:30Z | 199 | 476 | 284 | −192 | 778 | 2.14 |
| **contract-flow-rollups-refresh** | 10-08 14:00Z | 1904 | 412 | 172 | −240 | 990 | 2.28 |
| **donor-rollup-refresh** (watermark moved) | 10-08 09:00Z | 327 | 437 | 206 | −231 | **2,137** | 2.75 |
| donor-rollup-refresh | 10-08 12:00Z | 0 | 391 | 289 | −102 | 234 | 0.14 |
| donor-rollup-refresh | 10-07 09:00Z / 12:00Z | 0 / 0 | 464 / 461 | 457 / 430 | −7 / −31 | 17 / 61 | 0.00 / 0.39 |
| ec-crawl (unit ≥ 60 s, worst) | 10-08 14:00Z | 159 | 412 | 172 | −240 | 787 | 2.28 (beside contract-flow) |
| ec-crawl (stats windows after box-clear) | 10-09 00:15–00:45Z | 274–279 | 428–485 | 234–283 | −194 … −228 | 296–507 | 1.15–1.41 |
| fe-crawl (only unit ≥ 60 s) | 10-09 00:00Z | 140 | 338 | 324 | −14 | 759 | 3.03 |
| **refresh-derived-mvs-daily** | 10-08 06:00Z | 295 | 409 | 205 | −204 | 803 | 1.67 |
| refresh-derived-mvs-daily | 10-07 06:00Z | 199 | 426 | 278 | −148 | 1,676 | 2.22 |
| platform-counts-daily | 10-08 03:53Z | 29 | 475 | 264 | −211 | 673 | 0.25 |
| platform-counts-daily | 10-07 03:53Z | 23 | 454 | 290 | −164 | 509 | 0.22 |
| group-donor-rollup-refresh | 10-07 03:10Z | 102 | 457 | 270 | −187 | 408 | 0.60 |
| vote-stats-refresh | 10-08 03:30Z | 15 | 422 | 296 | −126 | 272 | 0.19 |
| vote-stats-refresh | 10-07 03:30Z | 13 | 411 | 299 | −112 | 185 | 0.16 |
| fe-inbound-rollup-refresh | 10-07 02:13Z | 4 | 355 | 180 | −175 | 831 | 1.13 (the cif_ledger storm's tail, §2) |
| fe-inbound-rollup-refresh | 10-08 02:13Z | 0 | 391 | 500 | +109 | 94 | 0.22 |
| abuse-events-retention | 10-07 / 10-08 04:15Z | 0 / 0 | 468 / 468 | 456 / 454 | −12 / −14 | 7 / 30 | ≤ 0.06 |

The 29 vacuum firings in the rings sit at −97 … +88 MB (ec-vacuum 10-08
04:30Z the largest drop, osar 11:16Z next at −84; treemap-vacuum 11:10Z the
largest swap-in at 620/s while MemAvailable rose 88 MB); none is a memory
event.

**Removed under W2 (no row): 34 firings** that started, ended or ran inside
17:10Z → 23:50Z — ec-crawl ×19, fe-crawl ×9, and the six 17:10–17:20Z
vacuums (treemap-individuals, odt, osdr, osar, odbt, ecs — one each;
odr-mv's 17:05Z run ended before the window) — plus 10
startup-timeout rows (ec-crawl ×6, fe-crawl ×4) that never ran. Five of the
34 ran past 60 s (fe-crawl 20:00Z 1,953 s; ec-crawl 21:15Z 78 s, 22:30Z
2,109 s, 23:05Z 2,006 s, 23:45Z 909 s); their footprint is the USASpending
run's. The rule-taggers-weekly / treemap / donor-party Tuesday firings are W1 or
outside both rings.

This table is the baseline for FIX-1125's threshold design (cc-203 owns that
bullet; it is not appended here). The headline: **the three daily memory
events are rule-taggers-daily (−272 MB, the 24 h ring's minimum), donor-rollup
on a moved watermark (−231 MB, swap-in 2,137/s) and contract-flow (−240 MB)**;
each is a body at 256MB. R5 (§5) splits them: donor-rollup's is a ~500 MB hash
that 64MB bounds; rule-taggers-daily's is **not** `work_mem` (every node it
builds fits under 64MB; its scan reads 360k blocks cold), so M1 will not move
its ring signature, and FIX-1125 should not read it as a `work_mem` event.

---

## §5 R5 — the clone measurement (local prod-clone)

Started 03:05Z, after `cc-203.md` and `cc-209.md` were both on origin/main
(rule 241: the shared clone is the ceiling); finished 03:44Z.

**Method.** cc-205's recipe (`docs/cc/reports/cc-205.md:84-90`). Signature
statements were found by a plan-only `EXPLAIN (FORMAT JSON)` of every
statement each body issues, at 256MB: any Hash / Hash Join / HashAggregate /
Sort / Materialize / Unique / WindowAgg node whose input exceeds 100k rows.
For the top statement of each body the run is **cold**: `docker restart
supabase_db_App`, then `sync; echo 3 > /proc/sys/vm/drop_caches` from a
privileged alpine. Then `EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON)` at
`SET LOCAL work_mem = '256MB'`, and again at `'64MB'`, one session per setting,
rolled back. `hash_mem_multiplier` is untouched (2). The backend's `RssAnon` is
sampled each second from `/proc/<pid>/status` inside the container. The other
statements of a body are run **warm vs warm**, with a repeat of the first
setting where the first run was the one paying the cache. Both settings run
at `max_parallel_workers_per_gather = 0`. That isolates `work_mem`, which is
what the verdict is about, and it is what M1 lands. It also avoids the clone's
64 MB `/dev/shm`, on which a parallel hash fails. The clone's `shared_buffers`
is 128MB; prod's is 256MB.

`rebuild_entity_search_index` is a FUNCTION whose own `SET LOCAL` decides its
`work_mem`, and EXPLAIN cannot see inside it. So the function is timed whole:
the live body (256MB), then the M1 body put in with an in-transaction `CREATE
OR REPLACE`, rolled back. `refresh_platform_counts` is atomic (it carries a
proconfig), so it is CALLed inside the rolled-back transaction at each session
setting.

**Projection to prod (rule 229).** Wall projects by the dominant relation's
PAGES, and a hash or sort's size by its input's TUPLES. Both ratios were read
at 03:21:29Z (prod / clone `pg_class`):

| relation | prod relpages | clone relpages | pages × | prod reltuples | clone reltuples | tuples × |
|---|---:|---:|---:|---:|---:|---:|
| financial_relationships | 656,163 | 442,292 | 1.48 | 15,203,144 | 10,412,807 | 1.46 |
| financial_entities | 245,569 | 179,993 | 1.36 | 5,229,498 | 3,676,687 | 1.42 |
| votes | 73,085 | 43,327 | 1.69 | 982,128 | 983,556 | 1.00 |
| entity_tags | 226,259 | 108,719 | 2.08 | 5,419,304 | 3,654,456 | 1.48 |
| entity_connections | 373,641 | 329,008 | 1.14 | 10,491,316 | 6,941,060 | 1.51 |
| entity_search_index | 15,530 | 15,188 | 1.02 | 369,019 | 359,710 | 1.03 |

### §5.1 Per statement

B = batches; mem = the node's peak memory; temp = temp blocks written (8 kB).

| body | statement (run) | signature node, clone | 256MB | 64MB | ratio 64/256 | prod projection |
|---|---|---|---|---|---:|---|
| ec-crawl | contracts arm aggregate (**cold**) | Sort 3,822,744 rows → GroupAggregate 187,780 | external merge, Disk 351,616 kB; temp 43,953; **RssAnon 327.4 MB**; **65.9 s** | external merge, Disk 351,640 kB; temp 43,962; **RssAnon 110.5 MB**; **58.7 s** | 0.89 | Sort spills at both (~515 MB at FR ×1.46). At 256MB it holds ~256 MB of RAM for no gain. Wall ~97 / ~87 s |
| ec-crawl | donations full window 0/16 (warm) | Sort 419,000 → 361,578 | quicksort 59,280 kB; 2.46 s | quicksort 58,336 kB; 2.57 s | 1.04 | ~86 MB at ×1.46 crosses 64MB — an external merge on prod at 64MB. This is the bootstrap path only; prod's incremental windows sort 754–3,803 rows |
| ec-crawl | incremental dirty set, 30 d of donation writes (warm) | HashAggregate 4,030,123 → 1,940,415 | B 1, mem 237,585 kB, temp 0; 5.83 s (13.0 s on the warm-up run) | **B 5**, mem 131,121 kB, Disk 60,792 kB, temp 13,152; 6.11 s | 1.05 | ~347 MB at 256MB (fits under 512); B ~8 at 64MB |
| donor-rollup | `_drb_fe` donor dimension (**cold**) | Hash 3,680,773 rows → Hash Right Join | **B 2**, mem **435,661 kB**, temp 47,909; **RssAnon 445.9 MB**; **35.4 s** | **B 8**, mem 109,078 kB, temp 83,859; **RssAnon 120.3 MB**; **13.6 s** | **0.38** | ×1.42 → ~619 MB, which overflows the 512 MB cap: prod's 256MB run holds **~500 MB in one hash**. That is the candidate owner of 10-08 09:00Z's −231 MB and swap-in 2,137/s (§4). At 64MB: B ~16 at 128 MB |
| donor-rollup | `_drb_targets`, full (warm) | HashAggregate 4,219,113 → 7,003 | B 1, 721 kB; 1.66 s | B 1, 721 kB; 1.16 s | 0.70 | unchanged |
| donor-rollup | chunk 0/32 aggregate (warm, repeated) | HashAggregate 98,621 → 87,346 | B 1, 47,121 kB; 0.27 s | B 1, 47,121 kB; 0.26 s | 0.96 | ~69 MB at ×1.46, under 128 MB |
| search index | `rebuild_entity_search_index()` whole (**cold**) | (inside a FUNCTION) | RssAnon 77.2 MB; **74.0 s** | RssAnon 75.4 MB; **72.2 s** | 0.98 | ESI ×1.02 — no node approaches 64MB; the 256MB is a ceiling nobody reaches |
| rule-taggers daily | `_scan` CTAS (**cold**) | Hash Semi Join, Hash 983,626 votes; Sort 1,640,088 | Hash B 1, 61,985 kB; quicksort 49,153 kB; **342.2 s** (I/O: 360,605 blocks read) | identical; **362.3 s** | 1.06 | votes ×1.00 → the hash stays 62 MB. The sort is ~72 MB at FR ×1.46, a small external merge at 64MB |
| rule-taggers daily | `_delete` (same txn) | Hash Right Anti Join, Hash 720,256 | B 1, 57,429 kB; 2.35 s | identical; 2.35 s | 1.00 | ~84 MB, under 128 MB |
| rule-taggers daily | `_insert` (same txn) | Hash Right Anti Join, Hash 720,256 | B 1, 41,954 kB; 0.81 s | identical; 0.78 s | 0.96 | ~61 MB |
| vote stats | the INSERT … WITH (**cold**) | Sort 586,505; HashAggregates over 983,626 | quicksort 47,487 kB; Hash 1,615 kB; 2.56 s | identical; 2.36 s | 0.92 | votes ×1.00 — unchanged |
| platform counts | `CALL refresh_platform_counts()` (warm, ×2) | none over 100k (plain counts; `tagged_pacs` semi-join is small) | 3.25 s (7.9 s on the first, cache-paying run); RssAnon 5.5 MB | 3.31 / 3.30 s; RssAnon 5.5 MB | 1.02 | passes by construction |

No Hash Join flipped to a Nested Loop or a Merge Join anywhere, and no node
changed type. The only plan changes are batch counts. Temp written stayed
under 700 MB per statement (655 MB at most, the 64MB dimension hash), against
917.6 GB free on the clone's volume (`df`, 03:40Z).

### §5.2 The verdicts (mechanical: wall ≤ 1.5× and no Hash Join flip and temp under the clone's free disk)

| body | worst ratio | plan flip | verdict |
|---|---:|---|---|
| `run_entity_connections_rebuild` | 1.05 (dirty set) | none | **PASS** |
| `donor_rollup_rebuild_bulk` | 0.96 (chunk); the dimension hash runs **2.6× faster** at 64MB | none | **PASS** |
| `rebuild_entity_search_index` | 0.98 | none | **PASS** — nothing it builds reaches 64MB |
| `run_rule_taggers('daily')` | 1.06 (cold scan, I/O noise) | none | **PASS** — every node fits under 64MB |
| `rebuild_official_vote_stats` | 0.92 | none | **PASS** — every node fits under 64MB |
| `refresh_platform_counts` (inherits B0) | 1.02 | none | **PASS** — no own SET needed |

**M1 lands all five bodies and B0.** Three bodies (search index, the daily,
vote stats) never reach 64MB. For them the step-down only removes headroom
they did not use. Two bodies (ec-crawl, donor-rollup) built nodes at 256MB
that 64MB bounds: the 3.8M-row contracts sort, the 4M-row dirty-set hash and
the 3.7M-row donor-dimension hash. Each of those was no slower at 64MB.

---

## §6 R6 — the ad-hoc class

**pgss (prod, 01:11:53Z), `postgres` role, by class:**

| class | statements | calls | temp written MB | max s | statements spilling |
|---|---:|---:|---:|---:|---:|
| `CALL` (pg_cron + paced runners) | 20 | 2,443 | 14,741 | 18,519.3 | 8 |
| ad-hoc `SELECT` / DML | 2,622 | 65,424 | **3,130** | 657.8 | 5 |
| DDL / migration-shaped | 192 | 389 | 314 | 93.3 | 2 |
| session / txn control | 74 | 12,951 | 0 | 0.8 | 0 |
| `VACUUM` / `ANALYZE` | 20 | 292 | 0 | 176.4 | 0 |

The ad-hoc class spilled 3.1 GB in 16 d from five statements (the EC
`array_agg` read 1,594 MB, the chord REFRESH 867 MB, two `pats` reads 329 MB
each, one 11 MB). Its biggest memory event — the 509.7 s `cif_ledger` SUM —
spilled **nothing**, which is the point: under the role's 256MB it did not need
to.

**The direct-pg writers under `packages/data/src/` (grep, rule 122).** 81 files
open a `postgres` connection (`new Client(` / `new Pool(` / `withClient(` /
`buildDbUrl(`). **Two set their own `work_mem`:**
`scripts/rebuild-entity-connections.ts:262` (`256MB`) and
`scripts/donor-rollup-sweep.ts:227` (`128MB`). **Everything else inherits the
role default** — B0 lowers it to 64MB. The scheduled or recurring inheritors:

| writer | how it runs | entry |
|---|---|---|
| nightly (fec / enrichment-light / -heavy / -tail phases) | GHA, dispatched 21:00Z | `pipelines/index.ts` |
| FEC bulk, USASpending bulk | GHA (`usaspending-bulk` dispatch-only since FIX-1291) | `pipelines/{fec,usaspending}-bulk/writer.ts` via `lib/direct-pg-upsert.ts` |
| IRS 990 | GHA | `pipelines/irs990/index.ts` |
| receipts, canary, integrity audit, mark-killed | GHA | `scripts/receipts-daily.ts`, `scripts/canary-check.ts`, `pipelines/integrity-audit/index.ts`, `scripts/mark-killed.ts` |
| paced runners and the gate | supervised | `scripts/donor-party-bootstrap-runner.ts`, `scripts/fe-totals-drain.ts`, `scripts/wait-for-gate.ts`, `lib/prod-session.ts` |
| `db-query.mjs --prod`, `supabase db push` | ad-hoc, every session | `scripts/db-query.mjs`, migrations |

The remaining ~65 files are one-off audit / remediation / verify scripts.

---

## §7 The M2/M3 candidates' rows (for cc-211)

From R1 and R2, so cc-211 needs no second prod census. The pgss figures are
every `CALL` row of the `postgres` role since the 09-22 epoch (prod, read
01:42:30Z, inside :42–:56):

| job | body | allowance | pgss calls · temp written · shared blks read · max s · mean s | R3 worst overlap | R4 |
|---|---|---|---|---|---|
| treemap-individuals-global-refresh | `refresh_treemap_individuals_global` | SET 256 | 2 · **0** · 4,494,376 · 907.5 · 889.8 | ec-crawl, 1 s | not in the rings (Tuesday 14:00Z, W1 day) |
| donor-party-rollup-refresh | `refresh_donor_party_rollup_incremental` + `refresh_donor_party_rollup_slice` | SET 256 + parallel 0; slice proconfig 256 | 10 · **0** · 5,872,159 · 270.6 · 216.4 | ec-crawl, 0 s | not in the rings |
| contract-flow-rollups-refresh | `refresh_contract_flow_rollups` | SET 256 | 3 · **3,018 MB** · 8,880,565 · 1,904.2 · 1,899.1 | **ec-crawl, 1,887 s (1,024 MB)** | **−240 MB, swap-in 990/s** |
| donation-edge-orphan-sweep | `reconcile_donation_edge_orphans` | SET 256 | 1 · **1,451 MB** · 1,004,630 · 135.5 · 135.5 | crawls, 0 s | — (10-01) |
| donor-rollup-orphan-sweep | `reconcile_donor_rollup_orphans` | SET 256 | 1 · 225 MB · 656,467 · 103.4 · 103.4 | crawls, 0 s | — |
| donor-party-rollup-orphan-sweep | `reconcile_donor_party_rollup_orphans` | SET 256 | 1 · 0 · 503,897 · 290.5 · 290.5 | crawls, 0 s | — |
| entity-connection-stats-orphan-sweep | `reconcile_entity_connection_stats_orphans` | SET 256 | 1 · 0 · 788,751 · 92.8 · 92.8 | crawls, 0 s | — |
| financial-entity-totals-reconcile | `reconcile_financial_entity_totals` | SET 256 | 1 · 0 · 1,754,980 · 155.4 · 155.4 | crawls, 0 s | — |
| group-donor-rollup-refresh | `run_group_donor_rollup_refresh` → `refresh_group_donor_rollup` | SET LOCAL 256 | 3 · 0 · 470,845 · 109.7 · 104.2 | — | −187 MB |

For the M1 bodies and the role's inheritors, the same read: `run_entity_connections_rebuild`
1,516 · 416 MB · 82,359,201 · 2,108.4 · 23.9; `donor_rollup_rebuild_bulk`
32 · 3,182 MB · 8,627,750 · 2,498.1 · 175.8; `run_rule_taggers` 18 · 186 MB ·
19,733,613 · 18,519.3 · 1,493.0; `rebuild_official_vote_stats` 16 · **0** ·
1,545,349 · 39.0 · 24.0; `refresh_platform_counts` 16 · **0** · 3,370,310 ·
69.3 · 33.6; `purge_abuse_events` 16 · 0 · 144 · 0.1. (`refresh_derived_mvs`,
which runs `rebuild_entity_search_index` as unit 9: 18 · 5,329 MB.)

A zero in the temp column at 256MB is not "cheap": it means every hash and
sort the body built fit under a 512 MB hash cap, in the backend's private
memory. Treemap and donor-party are the two Tuesday jobs that do that against
4.5M and 5.9M shared blocks.

Contract-flow is the strongest M2 candidate on every instrument: the largest
per-call spill, the longest overlap with ec-crawl, and the third-largest R4
drop.
