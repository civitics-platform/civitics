# FIX-1169 — the week of pre-vacuum probes, and the decision: no gate

cc-167, 2026-09-27. Prod, read-only. Closes FIX-1169 as measured.

## The question

FIX-1169 asked whether `ec-vacuum-analyze` (daily 04:30 UTC) is a fixed daily
cost worth gating on `pg_class`: skip the run when `entity_connections` is at
least 95 % all-visible and its `n_dead_tup` is under the autovacuum trigger.
The pre-vacuum instrument landed 2026-09-20 (`record_vm_probe`, jobs
`vm-probe-pre-fr 55 2 * * *`, `vm-probe-pre-ec 25 4 * * *`,
`vm-probe-pre-fe 45 4 * * *`). The bullet's own append said the decision waits
for a week of those probes. This is that week.

## The week — 7 firings, 2026-09-21 → 2026-09-27

Sources. The probe rows are the "Before the vacuum" blocks in
`docs/receipts/2026-09-22.md` … `2026-09-27.md` §4 (each file is generated the
evening before its nominal date, so it carries the previous morning's probes).
The 09-27 probes and all 09-27 walls are read directly from prod
(`pipeline_state 'vm_probe:%'`, `cron.job_run_details` by job NAME) at
2026-09-27 06:43 UTC, because no receipts file has them yet.

| day (UTC) | EC before: pct / dead | EC wall | FE before: pct / dead | FE wall | FR before: pct / dead | FR wall |
|---|---|---|---|---|---|---|
| 09-21 | 91.3 / 112,391 | 87.5 s | 100 / 77,541 | 96.2 s | 100 / 67,144 | 161.1 s |
| 09-22 | 76.4 / 286,579 | 143.5 s | 100 / 8 | 12.7 s | 100 / 0 | 9.7 s |
| 09-23 | 100 / 682 | 9.4 s | 100 / 663 | 19.9 s | 100 / 683 | 9.9 s |
| 09-24 | 99.8 / 722 | 9.2 s | 99.7 / 606 | 11.5 s | 99.9 / 715 | 9.8 s |
| 09-25 | 99.8 / 934 | 9.3 s | 99.7 / 745 | 11.6 s | 99.9 / 652 | 10.3 s |
| 09-26 | 99.8 / 822 | 9.1 s | 99.7 / 688 | 11.6 s | 99.9 / 884 | 9.9 s |
| 09-27 | 100.0 / 0 | 9.1 s | 100.0 / 3,975 | 30.8 s | 99.9 / 851 | 11.4 s |

The EC autovacuum trigger, from `check_rebuild_autovacuum_status()`'s
`vacuum_trigger`, read 2026-09-27 06:43 UTC: **521,975**.

## The decision rule, applied

A `pg_class` gate saves the vacuum's wall on the days it would skip. So the
whole weekly saving is the sum of EC walls on days where EC was **≥ 95 %
all-visible AND `n_dead_tup` < 521,975**:

- 09-23 9.4 + 09-24 9.2 + 09-25 9.3 + 09-26 9.1 + 09-27 9.1 = **46.1 s per week**
- 09-21 (91.3 %) and 09-22 (76.4 %) fail the all-visible clause. A gate runs
  the vacuum on both, and those are the two days that cost real time
  (87.5 s and 143.5 s).

Threshold (cc-167 D3): close as measured if the weekly saving is under 60 s.
Build a gate, or recommend a cadence, only if the saving is at least 60 s AND
some qualifying day's vacuum still cost more than 30 s. **46.1 s < 60 s, and
no qualifying day cost more than 9.4 s. Decision: no gate.**

## Why the quiet-day floor is ~9 s, and why a gate cannot buy more than that

On a quiet day the vacuum finds ~99.8 % of 373,641 pages all-visible and skips
them. What remains is the visibility-map walk plus the ANALYZE's 30,000-page
random sample. A gate would skip both. The pre-vacuum state was already
known to be write-volume-keyed (FIX-1169's 09-14 append: 8.9 s to 132.6 s).
This week puts the probe that the append lacked behind it. The expensive days
are the days after a bulk write (the Sunday FEC drop lands 09-20 night → 09-21
and 09-22), and a `pg_class` predicate would correctly let those run.

## One caveat about the instrument

`record_vm_probe()` reads `pg_class.relallvisible / relpages`, and only VACUUM
and ANALYZE refresh those columns. So "pct before the vacuum" means "pct as of
the relation's last vacuum or analyze", not the live visibility map. Only
`n_dead_tup` (from `pg_stat_user_tables`) is live. For `entity_connections`
this barely matters: autovacuum and autoanalyze reach it between the daily
runs (09-27: autovacuum 02:52:54, then the 04:25 probe read 100.0 % / 0 dead).
For `votes` it matters completely. Its 82.6 % was printed on all seven
mornings, but it is one reading, from the 2026-09-20 18:51 UTC autoanalyze.
See FIX-1239.

`votes` on the same probe, for the record: 82.6 % on every day, with dead
tuples 26,929 → 27,362 → 27,795 → 28,228 → 28,861 → 29,494 → 29,927: +433 a
day, and +633 on the two days carrying 200 committed updates. The source is
FIX-1238.

## Not changed

`ec-vacuum-analyze`'s slot and command. This decision closes the gate
question. It does not revisit FIX-1152's daily cadence.
