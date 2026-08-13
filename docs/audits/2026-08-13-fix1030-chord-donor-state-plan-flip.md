# FIX-1030 — why `chord_donor_state_party_flows_mv` took prod down twice

**Date:** 2026-08-13 (cc-prompt-61)
**Scope:** the one weekly `refresh_derived_mvs('weekly')` unit that failed catastrophically
on both of its last two firings.
**Method:** prod catalog reads + plain `EXPLAIN` (costs only, nothing executed on prod);
all execution experiments on the local prod-scale clone.
**Verdict:** a planner **plan flip**, triggered by the FIX-1018 index, standing on two
pre-existing statistics defects and one cost-model setting. Not bloat, not the FIX-1013
vacuum, not a definition change, not a cardinality step from the 08-09 ingest.

---

## 1. What was already known going in

| | 2026-08-11 07:00 UTC | 2026-08-13 01:05 UTC |
|---|---|---|
| unit 1 `chord_industry_flows_mv` | 262.6 s ok | 189.4 s ok |
| unit 2 `chord_donor_type_party_flows_mv` | 220.5 s ok | 143.6 s ok |
| unit 3 `chord_donor_state_party_flows_mv` | **no completion line** | **no completion line** |
| outcome | pg_cron worker starvation 07:30 → 14h22m log-dark → manual restart 22:51 | instance **crashed** 01:45:27.788819 (unclean) |

Both siblings got *faster* after the FIX-1013 vacuum while unit 3 still hung, which already
ruled bloat out as the mechanism.

## 2. The discriminating evidence — unit 3's plan vs its siblings'

Prod, plain `EXPLAIN`, nothing executed.

**Unit 2 (healthy)** — `Parallel Hash Left Join`, `financial_entities` scanned once via
`Parallel Seq Scan`, hash entry width 26. Total cost 838,482.

**Unit 3 (the killer)** — a **`Nested Loop`** whose inner side is
`Memoize → Index Scan using financial_entities_pkey`, driven by ~950k outer rows, hash
entry width 163. Total cost 613,522.

The planner picks the nested loop because it prices **19% cheaper** than the hash join.
Forcing each alternative on prod (plain `EXPLAIN`, planner knobs only):

| prod plan variant | total cost |
|---|---|
| chosen: Nested Loop + Memoize | **613,522** |
| `enable_memoize = off` | 649,291 |
| `enable_nestloop = off` (the healthy shape) | 756,100 |

So **Memoize's cost discount is what makes the nested loop win.**

## 3. Three defects, all of which had to hold at once

**(1) A 298.5× underestimate of the `financial_entities` filter.**
`LENGTH(metadata->>'state') = 2` is an expression no index and no statistics object covers,
so the planner falls back to its hardcoded `DEFAULT_EQ_SEL` (0.005).

| | estimated | actual (measured on the clone) |
|---|---|---|
| `financial_entities` rows passing the filter | 10,714 of 3,679,374 | **3,198,178 (87.13%)** |

This is what makes the nested loop's inner side look ~300× smaller than it is.

**(2) A 41× underestimate of `n_distinct(financial_relationships.from_id)`.**
`pg_stats` says **42,267** on prod (42,600 on the clone — the same defect, not a clone
artifact). Measured truth: **1,745,921 distinct donors** across 4,183,604 qualifying
donation rows. This is what makes Memoize look like it will serve ~99% of probes from cache.

**(3) `random_page_cost = 1.1`** — prod's setting (the Supabase default); stock postgres and
this project's local Docker are both `4`.

**Isolated one-at-a-time on the clone, (3) is the single setting that flips the plan:**

| clone scenario | join shape |
|---|---|
| clone defaults | Parallel Hash Join |
| **only `random_page_cost = 1.1`** | **Nested Loop + Memoize** ← reproduces prod |
| only `effective_cache_size = 768MB` | Parallel Hash Join |
| only `max_parallel_workers_per_gather = 1` | Parallel Hash Join |
| only `work_mem = 256MB` | Parallel Hash Join |

With prod's GUCs replayed the clone produces prod's plan node-for-node (cost 602,475 clone
vs 607,984 prod).

## 4. Why it started on 2026-08-11 and not before

(1)–(3) are all long-standing. The **trigger** was FIX-1018's partial index
`financial_relationships_donor_rollup_dirty_idx`, built **~03:00 UTC on 2026-08-11 — four
hours before the first catastrophic firing**. Its predicate
(`to_type='official' AND from_type='financial_entity' AND relationship_type IN (donation,
ie_support, ie_oppose)`) covers unit 3's `WHERE` almost exactly, so it handed the nested loop
a cheaper outer path than it had ever had:

| outer path | bitmap startup cost | estimated rows |
|---|---|---|
| `financial_relationships_to` (pre-FIX-1018) | 41,217 | 1,519,884 |
| `..._donor_rollup_dirty_idx` (post) | **17,539** | **953,828** |

That dropped the nested loop's total below the hash join's and flipped the plan. Confirmed by
counterfactual: dropping the index inside a rolled-back transaction on the clone restores the
hash join.

**The index is not at fault and is not touched.** It made a pre-existing misestimate reachable.

The siblings are immune structurally: unit 2 `LEFT JOIN`s `financial_entities` with **no**
`metadata` predicate, so there is no misestimated filter to shrink an inner side.

## 5. Measured execution on the clone — `EXPLAIN (ANALYZE, BUFFERS)`

```
Memoize  Hits: 2,328,993  Misses: 1,854,611  Evictions: 869,096
         Memory Usage: 262,145 kB
```

1,854,611 misses across 4,183,604 probes is a **44.3% miss rate** against a cost model that
assumed ~99% hits; 869,096 evictions is the cache thrashing exactly as 1.75M distinct keys
guarantees. **Memory Usage 256 MB** — Memoize sizes at `work_mem × hash_mem_multiplier`
(128MB × 2), so this one node may allocate the entire size of prod's `shared_buffers`.
That is the OOM-consistent shape (no server memory parameter is tuned as a result).

| estimate vs actual, same plan | est | actual | ratio |
|---|---|---|---|
| `financial_entities` filter | 10,714 | 3,198,178 | 298.5× |
| nested-loop join output | 4,722 | 3,593,976 | 761.1× |

**Buffer accounting** — cache-independent, and the number that matters, because on prod a
`read` is a real disk read against 256 MB of `shared_buffers`:

| | buffer accesses |
|---|---|
| BEFORE (nested loop) | hit 4,846,089 + read 2,906,376 = **7,752,465** |
| AFTER (the fix) | hit 4,413 + read 509,591 = **514,004** |
| SIBLING unit 2 (healthy) | read 498,015 = **498,015** |

**15.1× less buffer traffic overall; 41.2× on the `financial_entities` access specifically**
(7,418,444 → 179,993). More important than the ratio is the access *pattern*: 1.85M scattered
pkey descents plus heap fetches become one sequential scan. The fixed unit lands **within 3%
of its healthy sibling**.

### ⚠ Premise contradicted: the clone cannot reproduce the outage by duration

The clone completes the *original* query in **23.5–37 s**, not 35 minutes, because this box's
OS page cache holds the whole 1,632 MB `financial_entities` heap — the probes that are
physical disk reads on prod are RAM hits here. The clone reproduces the **plan** exactly and
the **I/O demand** exactly; it can never reproduce the **wall clock**. That is why the
evidence above is buffer counts and Memoize statistics rather than seconds, and it is a
standing caveat for any future perf repro on this clone.

## 6. The fix

**Part 1 — fence the plan.** The FE filter and state extraction are hoisted into a CTE with
an explicit `AS MATERIALIZED` optimiser fence, so `financial_entities` is scanned once and
projected narrow *before* it reaches the join. There is no index on a CTE, so no parameterised
inner path exists — the nested loop is not merely unattractive, it is **unavailable**. The fix
deliberately does not depend on the planner estimating anything correctly; estimates (1) and
(2) are still wrong and are not corrected here.

Output is **identical**: `LENGTH(x) = 2` already subsumes `x IS NOT NULL` and `x <> ''`.
Verified by full symmetric-difference parity against the pre-change contents —
**325 rows before and after, 0 rows in either direction, identical `SUM(total_usd)`
(2,197,387,010.00).**

**Part 2 — bound any unit from outside.** `enforce_derived_mvs_unit_budget()` on a 2-minute
pg_cron job cancels a unit that outlives its budget (default **900 s**, GUC-overridable). The
cancel lands in FIX-1021's existing `WHEN query_canceled` handler, which names the unit and
closes the row `partial`.

### Why not `SET LOCAL statement_timeout` — re-verified, not assumed

```
NOTICE:  B: statement_timeout after SET LOCAL = 2s
NOTICE:  C: pg_sleep(8) COMPLETED — SET LOCAL did NOT bound the unit
NOTICE:  D: statement_timeout after plain SET = 2s
NOTICE:  E: pg_sleep(8) COMPLETED — plain SET did NOT bound the unit
```

`statement_timeout` is armed once, in `start_xact_command()`, from the value in force when the
`CALL` arrives. A procedure's internal `COMMIT` goes through `SPI/_SPI_commit`, which never
re-arms it — `current_setting()` reports the new value while the real timer keeps the old
deadline. Same finding FIX-703 paid for in 2026-07; still true on PG 17. pg_cron cannot work
around it either: `SET …; CALL …` fails with *invalid transaction termination*, because
pg_cron wraps a multi-statement command in one implicit transaction and the procedure's
`COMMIT` is then illegal. **A cancel from outside the backend is the only mechanism that can
interrupt a running unit.**

## 7. Post-fix weekly cadence on the clone

Units 4–6 had **never been measured** — the FIX-1021 instrumentation shipped 08-13 and the
run that would have recorded them died.

| unit | seconds |
|---|---|
| `chord_industry_flows_mv` | 26.5 |
| `chord_donor_type_party_flows_mv` | 20.0 |
| **`chord_donor_state_party_flows_mv`** | **18.7** ← was unbounded; now 3rd fastest |
| `chord_subject_party_flows_mv` | 1.2 |
| `official_sector_dollars_mv` | 3.2 |
| `refresh_spending_totals` | 15.7 |
| **6/6 units, `complete`, 85 s total** | |

The clone runs ~7× faster than prod on these units **when prod's cache is warm** (prod
189/143 s where the clone is 26.5/20.0 s), which puts the prod-equivalent worst unit at
~263 s.

> **⚠ Corrected 2026-08-13 04:20 UTC — the ~7× factor only holds warm.** The prod apply
> (§10) measured this exact fixed statement at **442 s on a cold box**, i.e. a ~24×
> clone-to-prod factor, not 7×. The 900 s per-unit budget still holds — 442 s is the
> worst-case cold measurement and unit 3 now *completes* where it previously never did —
> but the real headroom is **~2×, not the ~3.4× claimed in the migration header**. The
> weekly job runs at 07:00 Tuesday, an hour after the 06:00 daily has warmed the same
> heaps, so the cold case is not the expected case; a cold-box false trip would close the
> row `partial` cleanly and skip the remaining units, which is the safe direction.

**No weekly unit comes within an order of magnitude of 900 s on a warm box**, which is why
that value can be chosen rather than guessed — but see the correction above before treating
any clone timing as a prod prediction.

## 8. Forced-timeout proof

Weekly cadence run with `civitics.derived_mvs_unit_budget_seconds = 5`:

```
watchdog: {"action": "canceled", "unit": "chord_industry_flows_mv", "signaled": true,
           "budget_seconds": 5, "unit_age_seconds": 6.7, "pid": 13268}
procedure: WARNING: [derived-mvs] chord_industry_flows_mv — CANCELED …
           NOTICE:  [derived-mvs] PARTIAL (cadence=weekly) — 0/6 units ok (5 skipped, 7s)
```

Closed row: `status='partial'`, `error_message` names the unit, metadata carries
`canceled: true`, `watchdog_canceled_unit`, `watchdog_unit_age_seconds: 6.7`, and all five
skipped units by name. **No stranded `running` row.** Subsequent watchdog polls returned
`no running refresh_derived_mvs` — the cancel-once guard held and did not touch the
procedure's own bookkeeping.

## 9. Prod apply — and the request-path incident it caused

Applied **2026-08-13 03:55:29 → 04:03:15 UTC** via `pnpm db:push:prod`, against a gate that
was clean at 03:55: **0 non-idle backends, 0 running `data_sync_log` rows**, last cron run
03:30 (`vote-stats-refresh`, 13 s, succeeded), jobid 10 paused, daily cadence 2 h away.

**The apply caused ~5.5 minutes of request-path timeouts.** Postgres logs, 03:57:43 →
04:03:12, stopping dead at the apply's end:

```
duration: 442115.812 ms  plan: Query Text: CREATE MATERIALIZED VIEW
    public.chord_donor_state_party_flows_mv AS WITH donor_states AS MATERIALIZED (...)
process 13991 still waiting for AccessShareLock on relation 127653 of database 5
    after 1000.090 ms
57014 canceling statement due to statement timeout          (dozens)
08006 connection to client lost
```

Two compounding mechanisms:

1. **Lock.** An MV's definition cannot be replaced in place, so the migration does
   `DROP` + `CREATE … AS` (which populates). That holds **ACCESS EXCLUSIVE on the MV name
   for the entire 442 s rebuild**; every reader blocks on AccessShareLock and then dies at
   the 8 s `service_role` statement_timeout.
2. **I/O.** The `CREATE`'s sequential scan of the 1,632 MB `financial_entities` heap ran on
   a box up only 2h10m since the 01:45:27 crash, so the 256 MB shared_buffers was cold and
   the scan paid full physical-read cost — starving the request path generally. This is why
   the timeouts were **not** confined to /graph chord callers.

**The estimate miss.** This session predicted "~2–3 min, blocked on that MV's readers,"
extrapolating the clone's warm 18.7 s by the ~7× steady-state factor. The real cold-box
factor was ~24× and the blast radius was site-wide, not MV-local. **A warm-cache clone
timing is not a safe basis for predicting a cold-prod DDL window.**

Filed as **FIX-1032** with the durable fix shape: build the replacement out of line
(`CREATE … WITH NO DATA` → `REFRESH` → short rename-swap transaction) so the exclusive
window is milliseconds, and schedule MV-definition swaps against a warm box.

**Self-resolved, no escalation.** No restart (`pg_postmaster_start_time` unchanged at
01:45:27), 0 errors in the following 4 minutes, `/` 200 in 2.2 s and `/graph` 200 in 0.57 s
at 04:07, 0 non-idle backends.

**Post-apply prod state, verified:** MV 325 rows / `SUM` 2,197,387,010.00 (byte-identical to
the clone's rebuild — the clone's donation subset matches prod's); definition carries the
`AS MATERIALIZED` fence; unique index, GRANTs and FIX-1003b autovacuum reloptions all
survived the swap; prod's plan for the new definition is all hash joins with no Memoize;
`enforce_derived_mvs_unit_budget()` present, `SECURITY INVOKER`, EXECUTE only for
postgres/service_role; cron job 40 `derived-mvs-unit-watchdog` active on `*/2 * * * *`, 4
runs, all succeeded, slowest **58 ms**.

The pre-swap MV read 326 rows / 2,139,715,460.00 — that delta is **staleness being
corrected**, not the fix changing output: unit 3 had not refreshed successfully since before
08-11, and the old and new definitions produce identical results on identical data (§6).

**jobid 10 remains `active=false`.** The supervised verification firing did not happen.

## 10. The supervised firing — FIX-1033, 2026-08-13 04:50 UTC

**Result: full pass.** `status=complete`, 6/6 units, **707.1 s**, no failures, no cancel, no
budget hit.

| unit | prod seconds |
|---|---|
| `chord_industry_flows_mv` | 185.7 |
| `chord_donor_type_party_flows_mv` | 128.0 |
| **`chord_donor_state_party_flows_mv`** | **160.3** ← had never completed on prod |
| `chord_subject_party_flows_mv` | 2.8 |
| `official_sector_dollars_mv` | 112.1 |
| `refresh_spending_totals` | 118.2 |

**Unit 3 is sibling-class, exactly as the fix predicted** — 160.3 s, sitting between its two
siblings (185.7 and 128.0). Against a unit that on 08-13 ran ≥34m44s without returning and on
08-11 never returned at all.

Headroom is better than either earlier estimate: total 707.1 s against the 4200 s budget
(17%), slowest unit 185.7 s against the 900 s fence (**4.85×**, vs the ~3.4× claimed warm and
the ~2× feared cold). Units 4–6 measured on prod for the first time.

**jobid 10 `refresh-derived-mvs-weekly` re-enabled** (`cron.alter_job` with the jobid resolved
by name, not hardcoded). Post-close-out: jobs 9/10/40 all active, the one-off unscheduled, no
restart, 0 stranded rows, 0 advisory locks.

### Attempt 1 aborted — operator error, worth recording

The first firing (04:30) was killed by **this session**: `cron.unschedule()` was run 11 s in to
prevent the one-off re-firing, and unscheduling a *running* pg_cron job cancels its worker.
`cron.job_run_details` jobid 41: `status=failed`, `return_message='job canceled'`,
`end_time=04:30:11.130007`. The backend survived the cancel long enough to finish unit 1
(~207 s) and was torn down ~04:35:56 (`connection to client lost` / `Broken pipe` — pg_cron
reaches its worker over libpq). Backend kill is the un-catchable FATAL class, so the row
stranded `running` and needed the reaper.

**The lesson is ordering:** the re-fire risk from leaving a one-off scheduled is 24 h away;
the unschedule risk is immediate. Unschedule *after* the run completes. Attempt 2 did that.

Two things this exposed:

- **Resolved as fine — pg_cron workers ARE visible to the watchdog.** The open worry was that
  the guard's `state <> 'idle'` predicate would drop a NULL-state background worker, making
  the 900 s fence inert in the only configuration production uses. Measured on the live
  worker: `application_name=pg_cron`, `backend_type=client backend`, `state=active` (not
  NULL), `query=CALL public.refresh_derived_mvs('weekly');`, and the guard's full predicate
  evaluates **TRUE**. The fence is live for pg_cron-launched runs.
- **Still open — FIX-1035.** The watchdog only probes pid liveness *after* the budget
  elapses, so a dead backend is indistinguishable from a long unit: at 04:44 it still returned
  `within budget, unit_age_seconds: 702.5` for a process gone eleven minutes. It also fooled
  the operator, who reported unit 2 as "running long, heading for the fence" when unit 2 had
  accrued only ~149 s of real work. `current_unit_started_at` freezes at death; growing
  `unit_age` is arithmetic, not evidence of life.

## 11. Open / not done here

- Statistics (1) and (2) are **still wrong**. The durable follow-up is
  `CREATE STATISTICS` on `(LENGTH(metadata->>'state'))` and an `n_distinct` override on
  `financial_relationships.from_id`. Deliberately **not** shipped here: both need an `ANALYZE`
  to take effect and both change plan choice prod-wide, which is a blast radius this session's
  mandate does not cover. The fence works regardless of them.
- The OOM-vs-other question for the 08-13 crash remains formally open — the Memoize 256 MB
  allocation is OOM-*consistent* but the kernel OOM killer logs outside postgres.
- Analytics retention (~7 days) means onset cannot be dated from logs; the 08-11 03:00 index
  build is dated from the migration, not from a log line.

Cross-ref: FIX-1021, FIX-1018, FIX-1013, FIX-1028, FIX-1027, FIX-703, FIX-443, FIX-884,
FIX-1022, FIX-1024.
