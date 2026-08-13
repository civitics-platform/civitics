# Weekly-MV regression — why `refresh_derived_mvs('weekly')` ran 6 hours on 2026-08-11

**Date:** 2026-08-12 (session ran 22:45–00:30 UTC)
**Scope:** read-only diagnosis on prod, plus two authorized one-shot
`VACUUM (ANALYZE)` runs (FIX-1013) and the migration that followed.
**Sibling document:** `docs/audits/2026-08-11-fix1018-diagnosis.md` — the recon
that produced the prompt this session ran from. Where that document and the live
records disagree, the records win and the disagreement is stated below.

**Verdict:** the weekly job was the **first domino, not a victim**. It ran alone
on an otherwise idle box and still took ≥6 h for work that measures ~15 min. The
dominant mechanism is a **visibility-map failure on `financial_entities`**,
caused by a vacuum owner scheduled ~14 h *before* the ingest it exists to clean
up — and fed by the weekly job's own unit 6, which rewrites 127,728 unchanged
rows into that table every week.

---

## 0. The one-paragraph answer

`refresh_derived_mvs('weekly')` has six units. Five are `REFRESH MATERIALIZED
VIEW CONCURRENTLY` over tiny MVs (27–20,168 rows); the sixth is
`refresh_spending_totals()`. Four of the five MVs pivot on an **Index Only Scan
on `financial_entities_pkey`** — 815,293 Memoize'd loops or 3,670,461 rows,
depending on plan. Those scans read `Heap Fetches: 0` **only while
`financial_entities` is all-visible**. `fe-vacuum-analyze` (jobid 30) ran
`0 2 * * 0,3`, so it fired **Sun 08-09 02:00 and not again until Wed 08-12
02:00** — and the Sunday FEC ingest (observed **15:55–16:55** and
**22:28–23:43**) plus the Mon 08-10 FIX-953 merge both landed *inside* that gap.
The weekly job runs **Tue 07:00**: the furthest point in that cycle from a
vacuum. Meanwhile its own unit 6 is an unbounded whole-table UPDATE that rewrites
**127,728 rows of which zero change**, across 19 indexes / 1,403 MB — so the job
bloats the table it depends on, and nothing cleans up after it until the
following day.

---

## 1. Corrections to the prompt's premises

Stated plainly, as asked. Records win.

| Premise as written | What the records show |
|---|---|
| "The 08-11 07:00 `data_sync_log` row is still stranded 'running' — close it (authorized small write)." | **Already closed.** `status='reaped'`, `reaped_at = 2026-08-12T04:08:28`, by the nightly's own `reap_stale_sync_log`. Zero rows platform-wide read `status='running'`. Decision 5's write was moot and was not performed. |
| "File the reaper's RETURNING-readback false-negative via `fix:add` (playbook E11)." | **Not filed — I have evidence against it.** The 08-12 nightly log reads `[nightly] reap_stale_sync_log — reaped 1 orphan row(s): refresh_derived_mvs (dccc1b22-…)`. It named the row it reaped, and the row is genuinely `reaped` in the DB. The reaper reported accurately here. Re-file with a real receipt if it recurs. |
| "`officials` is at 9.5% all-visible — one of the two tables to vacuum." | **Stale by the time of this session.** Autovacuum reached it at 08-12 04:11; it read **2,590/2,590 pages = 100%** before I touched it. The one-shot vacuum was run anyway (1.4 s) and the threshold override still shipped — self-healing here was luck of a very loose trigger, not coverage. |
| "Diagnose via `pg_stat_statements` for the REFRESH statements — the aggregate beats any single run." | **Unavailable.** `pg_stat_statements` holds **zero** rows matching `REFRESH MATERIALIZED VIEW` or `refresh_spending_totals`; it was reset by the 08-11 23:26 restart, as were all `pg_stat_user_tables` counters. |
| "Test the visibility hypothesis on FR (77.1%) and `officials` (9.5%) — the two tables FIX-953 churned." | **Right mechanism, wrong tables.** These queries read FR through a **Bitmap Heap Scan**, which does not consult the visibility map at all, and `officials` through a 2,590-page **Seq Scan** (540 rows survive the filter). The index-only scan that matters is on **`financial_entities`**, which neither the prompt nor the recon named. |
| "`REFRESH … CONCURRENTLY` also pays a unique-index diff join (up to ~1,900× local→prod)." | **Not a factor at this size.** The five weekly MVs are 1–325 pages (8 KB–2.6 MB). The diff join is noise; the cost is entirely in the underlying aggregate over the donation corpus. |
| "FIX-1014 early signal: last night's nightly was its first live run; the small master files republish DAILY so they should have MISSed." | **The FEC stage did not run.** The 08-12 nightly logs `[nightly] weekly stages: skipped (weekday)` at 04:08:28. The GHA job is *named* `fec-phase` but on weekdays it runs the non-FEC stages, which is what produced the premise. FIX-1014's first live exercise is **Sunday 08-16**; likewise the FIX-936/937 counters from amendment (e). Nothing was converted to evidence today. |
| "cc-prompt-58 decision 8: the arm vacuums succeeding on Wed proves `max_worker_processes = 12`." | **Confounded — see §5.** They succeeded, but jobids 2 and 16 were paused for that same Wednesday, so the test did not include the overlap that caused the original failures. Also, six arm vacuums already succeeded at **08-11 14:05–14:18**, before the restart and before `mwp=12`. |

---

## 2. The weekly job ran alone

The recon framed the outage as a contention cascade. For the *victims* — the 13
startup timeouts at 07:30–12:00 — that is right. For the weekly job itself it is
not: nothing overlapped it.

```
cron.job_run_details, 2026-08-11
  06:00  refresh-derived-mvs-daily     655.4 s  succeeded
  06:30  rule-taggers-daily            562.9 s  succeeded   → ended 06:39:22
  07:00  refresh-derived-mvs-weekly  21,802.0 s  FAILED (statement timeout)
  07:30  agency-staffing-rollup         12.3 s  job startup timeout
  …      (11 more startup timeouts through 12:00)
```

`data_sync_log` agrees: the nightly finished at **03:53**, and no pipeline ran
between then and the weekly. So from 06:39:22 to 13:03 the box carried exactly
one workload. **The weekly job is the cause of the cascade, not a casualty of
it**, and any explanation resting on job-vs-job contention is ruled out.

---

## 3. Every unit measures fast today

All on prod, `pg_stat_activity` verified at 0 non-idle backends, 2026-08-12
22:50–23:20 UTC.

| unit | what it is | measured |
|---|---|---|
| 1 `chord_industry_flows_mv` | FR ⋈ officials ⋈ FE ⋈ entity_tags → 101 rows | **185.5 s** |
| 5 `official_sector_dollars_mv` | FR ⋈ FE ⋈ entity_tags → 20,168 rows | 119.6 s *(measured 08-10, FIX-953 apply)* |
| 6 `refresh_spending_totals()` | aggregate leg alone | **92.1 s** |

Unit 1 measured **205.1 s** during the FIX-953 prod apply on 08-10 and **185.5 s**
now — no drift. Summed with the three unmeasured units (2, 3 similar in shape;
4 is votes-based and cheap), the healthy total lands squarely inside the
observed **1,253–2,781 s** baseline. **Nothing about the units themselves got
slower.**

### 3a. Two hypotheses tested and killed

**`work_mem`.** The procedure does `SET work_mem = '128MB'` against a role
default of **256 MB**, and unit 1's sort needs **221,712 kB**. That is a textbook
spill cliff, so it was worth measuring. It is not the mechanism:

```
unit 1 @ work_mem = 256MB   185,495 ms   Sort: quicksort 221712kB   Memoize evictions 0
unit 1 @ work_mem = 128MB   198,280 ms   identical plan             Memoize evictions 0
```

7% apart. `hash_mem_multiplier = 2` keeps Memoize's 101,912 kB inside budget at
either setting. The `SET` stays as FIX-748 wrote it.

**A plan flip.** If the visibility map degrades, the planner's cost for an
index-only scan rises and it may abandon Memoize. Forcing that:

```
unit 1 @ 128MB, enable_memoize = off   155,480 ms   hash join, 3,670,461 FE rows, Heap Fetches: 0
```

**Faster**, not slower. The alternative plan is not a trap.

---

## 4. What is actually different about Tuesday 07:00

### 4a. The access shape

Both plans for unit 1 pivot on the same node:

```
Memoize path:   Index Only Scan using financial_entities_pkey  (loops=815,293)   Heap Fetches: 0
Hash path:      Index Only Scan using financial_entities_pkey  (rows=3,670,461)  Heap Fetches: 0
```

`Heap Fetches: 0` holds **only while `financial_entities` is all-visible**.
`financial_entities` is 208,903 pages / 1.6 GB against `shared_buffers = 256MB`,
so every heap fetch that does occur is a cold random read.

### 4b. The vacuum owner fires before the write

```
cron.job_run_details, jobid 30 (fe-vacuum-analyze, schedule '0 2 * * 0,3')
  08-09 02:00   73.3 s   succeeded     ← Sunday, BEFORE the ingest
  08-12 02:00   61.4 s   succeeded     ← Wednesday, the next one

data_sync_log, fec_bulk
  08-09 Sun 15:55 → 16:55   complete   ← 14 h AFTER the Sunday vacuum
  08-09 Sun 22:28 → 23:43   complete
  08-10 Mon                 FIX-953 merge churns FE and FR
  08-11 Tue 07:00           refresh-derived-mvs-weekly  ← 2 days + 2 ingests + a merge
                                                          since FE's last vacuum
```

The Sunday firing cleans up *the previous week's* writes. Nothing covers Sunday's
own ingest until Wednesday. **The weekly MV job sits at the single furthest point
in that cycle from a vacuum**, and it is the only scheduled work whose cost is
dominated by an index-only scan of that table.

### 4c. The same mechanism, reproduced at full strength on a sibling table

`financial_relationships` had **no vacuum owner at all** (FIX-1013:
`SELECT count(*) FROM cron.job WHERE command ILIKE '%financial_relationships%'`
= 0). Measured on prod tonight, before and after one authorized
`VACUUM (ANALYZE)` — the FIX-1018 dirty-set build, same query, same watermark
(`2026-08-08 22:59:39`), quiet box both times:

```
BEFORE                                          AFTER
HashAggregate  7,950 ms                         HashAggregate  362 ms
  Index Only Scan …_donor_rollup_dirty_idx        Index Only Scan …_donor_rollup_dirty_idx
    Heap Fetches: 129,415                           Heap Fetches: 0
    Buffers: hit=6,836 read=60,883                  Buffers: hit=2,483 read=439
Execution Time: 7,952.257 ms                    Execution Time: 364.869 ms
```

**21.8× on wall clock. 139× on buffer reads. 129,415 heap fetches for 129,415
rows — a 100% index-only-scan fallback, FIX-884's mechanism at its theoretical
maximum.** `financial_relationships` went **77.1% → 100.0%** all-visible;
`officials` → 99.9%. Vacuum cost: **141.9 s** and **1.4 s** respectively (the
FIX-1013 bullet predicted ~176 s for FR from the `financial_entities` ratio).

This is not the weekly job's own query, and that matters: it is the *mechanism*
demonstrated at full strength on the same instance, the same night, on a table
in the same unvacuumed condition. It is corroboration, not proof — see §6.

### 4d. The job feeds its own problem

Unit 6, `refresh_spending_totals()`, was an unbounded whole-table UPDATE:

```sql
UPDATE financial_entities fe SET total_contract_cents = …, total_grant_cents = …
FROM (…aggregate over 3,822,744 contract+grant FR rows…) agg
WHERE fe.id = agg.to_id;          -- no comparison, no skip
```

Measured on prod:

```
rows the UPDATE touches every week      127,728
rows whose value would actually change        0
financial_entities indexes             19 / 1,403 MB
aggregate leg                              92.1 s
```

**127,728 no-op row rewrites a week, each a new tuple version plus index
maintenance across 19 indexes.** That is the weekly job bloating the exact table
its own MVs index-only-scan, one week ahead of the next run — and with jobid 30
not firing again until Wednesday, nothing cleans it up in between.

---

## 5. The arm vacuums, and what the Wednesday actually proves

All six FIX-1003 arm vacuums (jobids 32–37) succeeded at **08-12 11:05–11:18**,
in 0.1–1.2 s each — the slot that had been **0-for-12 lifetime**. They also
succeeded at 14:05–14:18 on both 08-11 and 08-12.

Two honest qualifications:

1. **The 08-11 14:05–14:18 successes predate the fix.** The restart was 08-11
   **23:26** (`pg_postmaster_start_time()`), so those six ran with
   `max_worker_processes = 6` — they succeeded simply because the 6 h squatter
   had died at 13:03. The 0-for-12 record was a **contention** record, and it
   clears whenever contention clears.
2. **Wednesday was not a clean test of `mwp=12`.** Jobids 2
   (`rebuild-ec-incremental`, Wed 08:00) and 16
   (`entity-connection-stats-rebuild`, Mon+Wed 11:00) were **paused** for exactly
   that day. Jobid 16 is the job that overlapped the 11:05 slot in the original
   failures. So the Wednesday demonstrates *the arm vacuums succeed on an
   unsqueezed box*, which was never in doubt.

`max_worker_processes = 12` **is** live and confirmed (`pg_settings`, source
`configuration file`), and it is the right change. But the first real test of it
is the next Mon/Wed 11:00 with jobid 16 active again — which this session
re-enables. FIX-1022 is closed on the basis that its remediation is applied and
verified present, with this confound recorded rather than papered over.

---

## 6. What this diagnosis does NOT establish

The 08-11 23:26 restart reset the cumulative statistics collector, and
`financial_entities` has since been vacuumed (08-12 02:00). So:

- `pg_stat_statements` has **zero** REFRESH rows.
- Every `last_vacuum` / `last_autovacuum` reads NULL for the incident window.
- **The degraded state cannot be reproduced.**

The visibility mechanism is therefore a strong inference from *plan shape*
(§4a), *schedule receipts* (§4b), and *the same mechanism measured at full
strength on a sibling table the same night* (§4c) — **not** a before/after of
the incident itself. Saying otherwise would overclaim.

**Falsifiable prediction.** With jobid 30 now firing Monday 02:00, the next
Tuesday 07:00 weekly should complete in **~15–45 min**. If it blows up again
with `financial_entities` freshly vacuumed, this diagnosis is wrong, and the
next suspect is unit-level cost under a cold cache (`shared_buffers` = 256 MB
against a 3.5 GB FR heap and a 1.6 GB FE heap) — i.e. FIX-589 territory, not a
vacuum problem.

**Note the prediction is not self-executing:** jobid 10 is **paused**. Someone
has to schedule that run deliberately, with the FIX-1021 budget in place, and
read `metadata.unit_seconds` afterwards.

---

## 7. What shipped

| | change | FIX |
|---|---|---|
| 1 | `refresh_derived_mvs()` — predictive between-unit budget (daily 3300 s, weekly 4200 s; GUC `civitics.derived_mvs_budget_seconds`), per-unit durations always written to `metadata.unit_seconds`, and a **by-name `query_canceled` handler** | FIX-1021 |
| 2 | `fr-vacuum-analyze` (Mon 01:00) + `officials-vacuum-analyze` (Mon 01:30), both after the observed Sunday FEC window; threshold-led autovacuum override on `officials` | FIX-1013 |
| 3 | `refresh_spending_totals()` skip-unchanged predicate; jobid 30 → `0 2 * * 0,1,3` (adds Monday, keeps Sunday) | FIX-1027 |
| 4 | `request-path-probe` job on `platform-snapshot.yml` | FIX-1026 |
| 5 | one-shot `VACUUM (ANALYZE)` of `financial_relationships` + `officials` on prod | FIX-1013 |

### 7a. Why the `query_canceled` handler is the interesting one

The procedure's per-unit handler was `EXCEPTION WHEN OTHERS`. **PL/pgSQL's
`OTHERS` matches every error type except `query_canceled` and
`assert_failure`**, and `statement_timeout` raises `query_canceled` (57014). So
the axe blew straight through the handler, past the final `UPDATE`, and out of
the procedure — which is why the 08-11 row sat `running` for 15 h until the
reaper found it. That is a **class**, not an instance: every cancel this
procedure has ever taken behaved the same way.

Trapping it by name is the only fix, and it raised a real question — after
`statement_timeout` fires, does the bookkeeping `UPDATE` also get cancelled?
Exercised locally (playbook C3 — the guard in its own failure case):

```
TEST A  budget EXIT       civitics.derived_mvs_budget_seconds = 40
        → partial, row_closed=t, units_ok=4, budget_hit=true, 9 units named as skipped
        "budget exhausted after 36s of 40s — 9 unit(s) skipped: entity_engagement_rollup_mv, …"

TEST B  query_canceled    statement_timeout = 10s
        → partial, row_closed=t, units_ok=8, canceled=true, 4 units skipped
        "canceled mid-unit — rebuild_entity_search_index: canceling statement due to statement timeout"

INVARIANT  stranded 'running' rows after all three runs: 0
```

The timer is disarmed once it has thrown, so the final `UPDATE` runs. Both
failure paths close the row.

The baseline run also demonstrates what was previously invisible — 13/13 units,
124.4 s, and per-unit timings showing `rebuild_entity_search_index` at **70.7 s**
and `official_homepage_stats_mv` at **34.9 s** carrying 85% of the run.

---

## 8. Recommended scope for cc-prompt-59

1. **Jobid 10 stays paused.** Re-enabling needs one supervised firing with the
   FIX-1021 budget live, then a read of `metadata.unit_seconds`. That run is
   also the §6 experiment — do not waste it by letting cron fire it unwatched.
2. **FIX-1023 execution** — pending Craig's sign-off on option (a), per the
   amended bullet.
3. **FIX-990 / FIX-969 deconfliction + the EC rebuild.** Jobids 2 and 16 are
   active again as of this session and their Monday/Wednesday collision is
   untouched.
4. **FIX-1004 / FIX-1007** — see the decision recorded in the session report;
   both are now measurement-blocked on the *next* dirty set, not on new code.
5. **Sunday 08-16** is the first live exercise of FIX-1014, FIX-936 and FIX-937,
   and the first Monday 02:00 firing of the new jobid 30 schedule.
6. **Carried forward from FIX-1022, deliberately NOT done here.** That bullet
   proposed four items. (1) `max_worker_processes` 6 → 12 is applied. (2)
   Lowering `cron.max_running_jobs` is **impossible** — it is not in Supabase's
   overridable set, which is why schedule deconfliction is now the standing
   mitigation. (3) Deconfliction moves to FIX-969 / FIX-990. (4) Making
   `check_cron_job_health()` escalate *zero lifetime successes* as a distinct,
   louder condition than *missed a run* is **still open** and belongs to
   FIX-968. Six jobs that had never succeeded read identically to one that
   skipped once, and that is precisely why the 0-for-12 went unnoticed for two
   weeks. FIX-1022 is closed on its headline remediation; item (4) is not part
   of that closure.
