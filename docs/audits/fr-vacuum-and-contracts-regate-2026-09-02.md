# FR vacuum + the FIX-1118 contracts re-gate — prod receipts, 2026-09-02

Supervised window, Craig present. Prod writes: one `VACUUM (VERBOSE, ANALYZE)`
of `financial_relationships`, and one `disabled_arms` re-gate. Both landed.

This file exists mostly for the **refutations**. Four operating premises carried
into this window did not survive measurement, and three of them were load-bearing
for a plan that would have been much more expensive than what was actually needed.

---

## 1. The headline numbers

| Probe: `count(*), max(updated_at)` over `relationship_type IN ('contract','grant')` | measured |
|---|---|
| 2026-08-28, before any index (warm) | **98,204 ms** |
| 2026-09-02 00:0x, index only (VM at 75.84% all-visible), cold | **16,062 ms** |
| 2026-09-02 00:0x, index only, warm | **4,897 ms** |
| 2026-09-02 00:1x, index + vacuumed VM, `EXPLAIN ANALYZE` | **416 ms** |
| 2026-09-02 00:1x, index + vacuumed VM, warm | **219 ms** |
| through `ec_arm_source_fingerprint()` itself | **528 ms** |

448× against the pre-index baseline; 22× from the index alone to index+vacuum.
`Heap Fetches` went **323,052 → 0**. Buffers went `hit=188,395 read=43,781` →
`hit=25,717 read=3,405`. Planner cost estimate 428,749 → 59,206.

The arm this probe now skips costs **344.6 s**, so the ratio is ~1,570:1.

---

## 2. The vacuum receipt

`VACUUM (VERBOSE, ANALYZE) public.financial_relationships`, run against an idle
box (0 non-idle backends at start), `maintenance_work_mem` left at the server
default 64 MB, `vacuum_cost_delay` 0.

```
index scans: 1
pages:  0 removed, 631265 remain, 191219 scanned (30.29% of total)
tuples: 0 removed, 14416003 remain, 0 are dead but not yet removable
index scan needed: 68527 pages from table (10.86%) had 187854 dead item identifiers removed
avg read rate: 100.692 MB/s, avg write rate: 7.464 MB/s
buffer usage: 256847 hits, 1089704 misses, 80781 dirtied
WAL usage: 150337 records, 80769 full page images, 182803016 bytes
system usage: CPU: user: 9.05 s, system: 2.83 s, elapsed: 84.54 s
```

Total including `ANALYZE`: **93.87 s** (wall clock 94.3 s).

| `financial_relationships` | before | after |
|---|---|---|
| `relallvisible` / `relpages` | 478,758 / 631,265 = **75.84%** | 631,265 / 631,265 = **100.00%** |
| `n_dead_tup` | 187,854 | **0** |
| `vacuum_count` | 1 | 2 |

No front-door impact observed; the box was idle and `ec-crawl` was in backoff
until 00:57:47 UTC, giving a ~45-minute guaranteed-quiet window for an operation
that needed 94 s of it.

---

## 3. Premises that did not survive

### 3a. "FR has `vacuum_count = 1` for ALL TIME, so it has never been adequately vacuumed"

**Refuted.** `vacuum_count` is a `pg_stat_user_tables` counter, and those counters
are **discarded on an unclean restart**. Prod crash-restarted 2026-08-29 07:21:57.
The `1` was not an all-time total; it was one vacuum since that crash — and that
one vacuum was `pg_cron` jobid 38 doing its job on Monday 2026-08-31 01:00.

`vacuum_count` is therefore **not a valid instrument for "has this table ever been
vacuumed"** on a box with this incident history. `last_vacuum` (which was sitting
right next to it, reading `2026-08-31 01:03:37`) and `cron.job_run_details` are.

### 3b. "jobid 38 (`fr-vacuum-analyze`) is not effectively running"

**Refuted.** `cron.job_run_details` shows three firings, all `succeeded`:

| run | duration |
|---|---|
| 2026-08-17 01:00:00 | 97.8 s |
| 2026-08-24 01:00:00 | 20.3 s |
| 2026-08-31 01:00:00 | 227.2 s |

The job is healthy, correctly scheduled (`0 1 * * 1`), and needs no owner fix.
It will vacuum FR again Monday 2026-09-07 01:00 UTC. Nothing was filed against it.

### 3c. "A manual vacuum ran 675 s without finishing its first index pass, so a statement_timeout is not a usable guard"

**Refuted on the cost, and the mechanism was misread.** The full vacuum took
**84.5 s** for the table (93.9 s with ANALYZE). More importantly, `index scans: 1`
— there was only ever going to *be* one index pass.

The number of index passes is `ceil(dead_tuple_TID_bytes / maintenance_work_mem)`.
FR carried 187,854 dead tuples ≈ **1.1 MB** of TIDs against a 64 MB
`maintenance_work_mem`. That is a single pass with ~58× headroom. "Did not finish
its first index pass" was never a sign of a pass-count problem, because a second
pass was arithmetically unreachable.

**Consequence for the plan:** raising `maintenance_work_mem` — the mitigation the
window was designed around — could not have helped. It cannot remove a pass that
does not exist. It was deliberately left at the default, which also avoided adding
memory pressure to a box whose ~2.18 GB commit ceiling has produced three
incidents. The correct lever was simply *running it on an idle box*.

### 3d. "FIX-1133 exists and tracks FR vacuum cost"

**Refuted.** The highest allocated id in `docs/FIXES.md` was **FIX-1129**. There is
no FIX-1133 and never was. Nothing was closed or advanced against that id.

### 3e. "The homepage MV regression may be VM decay from the Monday replay burst"

**Refuted for `official_homepage_stats_mv` specifically** — see §4. Neither of its
scan types consults the visibility map.

---

## 4. `official_homepage_stats_mv` — structural, not transient (filed as FIX-1134)

Cost history from `data_sync_log.metadata->'unit_seconds'` (pipeline
`refresh_derived_mvs`, jobid 9):

| run | `official_homepage_stats_mv` | `homepage_stats_mv` | `rebuild_entity_search_index` |
|---|---|---|---|
| 2026-08-31 06:00 | 253.9 s | 13.3 s | 21,638.3 s (the kill) |
| 2026-08-31 23:36 | 252.8 s | 11.8 s | 383.9 s |
| 2026-09-01 06:00 | **800.5 s** | **64.5 s** | **490.7 s** |

**Verdict: the 253 s baseline is structural; the 09-01 excursion is contention.**

The structural half: the MV's defining query has four CTEs and **three of them scan
`financial_relationships` independently** — `donor_counts`, `fin_counts`,
`donation_sums` — all filtering `to_type = 'official'` and all grouping by `to_id`.
FR is 4,932 MB of heap. One refresh reads it three times, ~15 GB of I/O against
`shared_buffers` of 256 MB. All three collapse into one scan with conditional
aggregates (`count(*) FILTER (…)`, `sum(…) FILTER (…)`). That is FIX-1134.

**Why VM decay is ruled out, and the instrument that rules it out:** `EXPLAIN` on
prod shows the three FR nodes as `Parallel Bitmap Heap Scan`, `Parallel Seq Scan`,
`Parallel Bitmap Heap Scan`. **Zero index-only scans over FR.** Neither a bitmap
heap scan nor a sequential scan consults the visibility map, so no amount of VM
decay or repair changes their cost. The FR vacuum in §2 — which took FR to 100%
all-visible — is therefore expected to do *nothing* for this MV. That is a
falsifiable prediction: the 2026-09-02 06:00 run should still show ~250 s+.

The transient half: three unrelated units regressed together on the 09-01 06:00 run
(3.2×, 5.5×, +28%). That is shared-resource contention on the morning, not three
independent regressions.

**Why it escaped FIX-1123:** that census filtered on functions setting
`work_mem >= 128MB`. A `REFRESH MATERIALIZED VIEW CONCURRENTLY` sets no `work_mem`
at all, so an unbounded refresh over a growing source was invisible to it. Note
this unit lives in jobid 9 — the job that has twice taken prod down.

---

## 5. The re-gate

`pipeline_state.ec_arm_source_fingerprints -> disabled_arms`:
`["rebuild_entity_connections_contracts"]` → `[]`, via
`scripts/fix1118-regate-contracts-arm.mjs` (which refuses unless
`financial_relationships_contract_grant_updated_at` exists and `indisvalid`).
The `arms` map still carries all 10 stored fingerprints.

`ec_arm_source_fingerprint('rebuild_entity_connections_contracts')` now returns
`n=3908956;t=2026-08-13 11:09:33.084306+00` in 528 ms, where it previously
returned `NULL` (the fail-open "run it" value).

**That `t` is the finding underneath the finding.** The contract/grant slice has
not changed since **2026-08-13 11:09:33**. The arm has rebuilt on every cycle for
nineteen days over a source that never moved.

### What has NOT been proven yet

`rebuild_entity_connections_contracts` has **no stored fingerprint** —
`(value->'arms') ? 'rebuild_entity_connections_contracts'` is `false`, because a
disabled arm returns NULL and NULL is never banked. So:

- **The next cycle still runs the arm**, once, and banks its fingerprint.
- **Gating begins on the cycle after that.**

Do not read the first post-re-gate cycle as a failed gate. And the *loop-breaker*
— the claim that gating contracts stops the 16-window stats arm recurring on
no-change cycles, because contracts stops rewriting `entity_connections` and
therefore stops re-dirtying the stats fingerprint — is **not observed in this
window**. `ec_crawl` was mid-cycle and in backoff until 00:57:47 UTC, and its
`min_cycle_interval_minutes` is 360, so the first observable no-change cycle is
several hours out. That observation belongs to FIX-1124, which named the loop.

---

## 6. Glance readings taken at window start

- **`fe_crawl`**: `recent_units` is **empty** and `skips` reads
  `{peer_backoff: 3, last_skip_at: 2026-09-02T00:00:00, last_skip_reason: peer_backoff}`.
  jobid 46 is `active = t`, so it is enabled but has completed **zero units**,
  yielding to `ec-crawl` on every firing so far. Three skips is too few to call
  starvation; worth re-reading next window before filing anything. The
  `financial_entity_totals_watermark` was not observed to move.
- **Box health**: `pg_stat_activity` showed 0 non-idle backends throughout
  preflight. `civitics.com` answers in 84–233 ms at the edge but returns HTTP 403
  to `curl` regardless of User-Agent — that is Cloudflare, not an outage, and it
  means curl is not a usable front-door instrument here (cf. `cf-analytics.mjs`).
- **jobid 10** (`refresh-derived-mvs-weekly`) confirmed still `active = f`.
  Blackout config intact.
