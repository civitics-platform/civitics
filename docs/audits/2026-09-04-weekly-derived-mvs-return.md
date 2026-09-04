# 2026-09-04 — the weekly derived-MV refresh returns bounded (FIX-1129 step 4)

Receipt for the supervised firing that FIX-1129 required before jobid 10 could
come off pause, and for the FIX-966 closure it earns.

## The supervised firing

Hand-fired `CALL public.refresh_derived_mvs('weekly')` on prod, 2026-09-04
03:41:55 UTC, Craig-authorized, with the FIX-1030 per-unit watchdog live and a
15 s poll on `data_sync_log.current_unit`, `pg_stat_activity` and
`pg_stat_database.temp_bytes`.

**`complete` — 6/6 units ok, 0 failures, 0 skipped, 857.3 s.**

| unit | seconds | % of the 900 s unit budget |
|---|---|---|
| `chord_industry_flows_mv` | 236.1 | 26% |
| `chord_donor_type_party_flows_mv` | 195.4 | 22% |
| `chord_donor_state_party_flows_mv` | 197.3 | 22% |
| `chord_subject_party_flows_mv` | 2.9 | <1% |
| `official_sector_dollars_mv` | 103.4 | 11% |
| `refresh_spending_totals` | 122.1 | 14% |

Whole run 857.3 s against the procedure's own 4,200 s predictive budget (20%)
and the new 5,400 s `cron_job_budget` backstop (16%). `canceled = false`,
`budget_hit = false`, zero unit-watchdog cancels during the window. The backend
held `state = active` with **no wait event** throughout — CPU-bound, never
blocked on I/O or a lock. Database `temp_bytes` grew ~120 MB across the whole
run, consistent with unit 1's sort spilling and nothing else.

## What the numbers settle

**FIX-1109 finding 2 is fixed on prod, not just in theory.**
`chord_donor_type_party_flows_mv` is the unit that died on 2026-08-25 with
`could not resize shared memory segment … to 134217728 bytes: No space left on
device`, and that reproduces on the prod-scale clone at
`max_parallel_workers_per_gather = 1`. With the weekly cadence now setting that
GUC to 0 it ran 195.4 s clean. 134217728 is 128 MB — exactly the `work_mem` the
procedure sets — because a `Parallel Hash` builds its side in a DSM segment and
`financial_entities` is 3.06M rows at width 26 for that unit. Non-parallel, the
same join keeps its build in private memory bounded by
`work_mem × hash_mem_multiplier` and spills in batches instead of failing.

**FIX-966 closes as superseded.** Its unit,
`chord_donor_state_party_flows_mv`, was cancelled at 1,200 s on 2026-08-05. It
ran **197.3 s** here — 16% of that cancel. FIX-1030's `AS MATERIALIZED` fence
was the actual fix; this firing is the proof, so 966 carries no code of its own.

**The 06:00 contention was real and is now gone.** `chord_industry_flows_mv`
ran 868.8 s on 08-25 at 07:00 UTC, inside the daily's stack, against 185.7 s on
08-13 at 04:50 for the same work. At 03:41 it ran 236.1 s. The 4.7× spread was
co-tenancy, not data growth — which is the whole argument for the slot move.

## The new slot

jobid 10 → **Tuesday 00:47 UTC**, moved with `alter_job` BY NAME so the jobid
and its whole `cron.job_run_details` history survived (it is still jobid 10).
Hour 00 measures 0.0% startup timeouts over 154 Tuesday runs; the old 07:00
measures 16.8%. Minute 47 clears the `*/2` watchdogs (odd), ec-crawl and
fe-crawl (not a multiple of 15 or 30), and jobid 25's 00:05 firing whose
longest run is 1,183 s. The move also ends the shared-advisory-lock hazard: the
weekly and the daily share one lock, so a daily still running at 07:00 made the
weekly log `skipped` and lose the week entirely.

`active = true` was restored only after the run above landed `complete`, behind
a guard that refuses unless the last weekly row is `complete`, uncancelled,
carries exactly six `unit_seconds`, and the schedule reads `47 0 * * 2`.

**First scheduled exercise: Tuesday 2026-09-09 00:47 UTC.** That firing is the
durable receipt — this one was hand-fired.

## Post-run state

Five MVs repopulated (101 / 27 / 334 / 74 / 20,291 rows). `entity_search_index`
holds 364,129 rows across all eight kinds — the 09-03 daily's cancel rolled its
TRUNCATE and INSERTs back together, so search was never stranded empty.

## Not done here

The daily's `rebuild_entity_search_index` swings 5× day to day and has been
watchdog-cancelled twice in five days. That is **not** the monotonic regression
FIX-1129 predicted — 09-02 ran 202.5 s, inside the pre-incident normal band,
between the 490.7 s and the 1,017.4 s. Filed as FIX-1144 with the numbers and
the instrumentation-first prescription; the weekly no longer shares that stack.
