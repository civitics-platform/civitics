# 2026-08-29 prod memory seizure — postmortem

Investigated 2026-08-29 18:50–19:10 UTC (cc-prompt-93). Read-only against prod
except one approved data write (the `ec_crawl` blackout, §6). No code, no
schema, no schedule changes.

**Verdict in one line:** `rebuild_entity_search_index` — unit 9 of 13 of
`refresh-derived-mvs-daily` — ran a `work_mem = 256MB` hash aggregate over a
table that has grown 4.3× since the value was chosen, while `ec-crawl` was
concurrently mid-stats-arm on the same table. The box overcommitted, lost the
ability to fork backends, and every runtime guard that could have stopped it was
itself unable to start.

---

## Instruments and their sample bounds

Every claim below names its source. Bounds stated because a capped sample proves
presence, never volume or absence.

| Instrument | Bound |
|---|---|
| `cron.job_run_details` | 21,989 rows, 2026-06-29 08:00 → 2026-08-29 18:50. Covers the window fully. |
| `pipeline_state.ec_crawl.recent_units` | **Bounded ring, last 50 units.** Oldest entry 2026-08-28 10:15. Anything earlier is gone. |
| `data_sync_log` | Complete for the window. |
| `pg_stat_statements` | **Reset at the crash (07:21:57).** The 05:50–06:20 window is unrecoverable. Absence of pgss data is not absence of cost. |
| `pg_postmaster_start_time()` | 2026-08-29 07:40:57 — the *second*, manual restart. |
| `pg_stat_statements_info.stats_reset` | 2026-08-29 07:21:57.434592 — the *first*, crash restart. |
| Postgres logs | **Not consulted.** Craig elected to skip the Logs Explorer export; the SQL chain below was sufficient to name the unit. The kernel's own naming of the OOM victim is therefore *not* in evidence. |
| `cron_job_budget_action` / `ec_window_budget_action` | Complete tables, not sampled. |

### The two restarts, distinguished

`pg_stat_statements` persists its file across a **clean** shutdown and discards
it after an **unclean** one. So:

- `stats_reset = 07:21:57` → the 07:21 event was a **crash** restart.
- `postmaster_start_time = 07:40:57` with pgss *not* reset again → the 07:40
  event was a **clean** (manual) restart.

Two restarts, dated to the second, from SQL alone.

---

## 1. Minute-level timeline (durable sources only)

All times UTC, 2026-08-29.

| Time | Event | Source |
|---|---|---|
| 05:00:00.19 | ec-crawl fires, **skips** — `cycle_cooldown` | `pipeline_state.ec_crawl.skips` |
| 05:15:00.03 | ec-crawl **opens a cycle** (cooldown expired 05:00:43) | crawl cursor `cycle_started_at` |
| 05:15:12 | 6 arms gated `skipped_unchanged` | ring |
| 05:20:42 | `rebuild_entity_connections_contracts` completes — **330.4s, un-gated** | ring |
| 05:21:10 | firing ends (6m10s) | `job_run_details` |
| 05:33:05 | stats **window 1/16** — 133.5s | ring |
| 05:46:42 | stats **window 2/16** — 79.8s | ring |
| **06:00:00.096** | **ec-crawl fires** → begins stats window 3/16 | `job_run_details` |
| **06:00:00.118** | **refresh-derived-mvs-daily fires** — 22 ms later | `job_run_details` |
| 06:02–06:10 | watchdogs still succeed but slow: 1.5s, 2.2s, 1.5s, 2.9s (normal ≈0.03s) | `job_run_details` |
| **06:08:34.33** | derived-MVs reaches **unit 9/13 `rebuild_entity_search_index`**, pid 328403 | reaped-row metadata |
| **06:12:00** | **both watchdogs fail — `job startup timeout`.** Postmaster can no longer fork. | `job_run_details` |
| 06:12 → 07:03:10 | Every watchdog firing fails the same way. 51 minutes. | `job_run_details` |
| 06:31:25 | `rule-taggers-daily` fires, fails `job startup timeout` | `job_run_details` |
| 07:03:10 → 07:24:00 | **pg_cron records nothing at all** — ~10 missed `*/2` firings. The write path itself was down. | `job_run_details` |
| **07:21:57.43** | **crash restart** | `pg_stat_statements_info.stats_reset` |
| 07:24:00 | first firing after restart — still `job startup timeout` (10.6s) | `job_run_details` |
| **07:26:00.17** | first clean watchdog; **immediately reaps** the derived-MVs row | reaped-row metadata |
| 07:30:00.06 | ec-crawl fires again, runs into the manual restart | `job_run_details` |
| **07:40:57.81** | **manual restart** (Craig) | `pg_postmaster_start_time()` |
| ~07:40 | ec-crawl paused | (Craig) |
| 08:41:07 | nightly GHA run 33243718034 starts; reaps both stale crawl rows | `data_sync_log` |
| 18:45:00 | ec-crawl re-enabled; completes stats window 3/16 in 71.4s | `job_run_details`, ring |
| 19:03:28 | blackout 05:45–07:00 UTC applied (§6) | `pipeline_state` |

### Deltas from the working hypothesis

1. **The nightly was NOT in the window.** It ran **08:41–08:49**, after
   everything. Prompt premise ("inside the nightly's 05:50–08:00 window") is
   **refuted**. The 06:00 stack was two jobs, not three.
2. **The crawl did not fire every 15 min during the outage.** Only 06:00 and
   07:30 exist. pg_cron queues behind its own overrunning job, so 06:15/06:30/
   06:45/07:00/07:15 were never launched.
3. **The watchdogs did not merely "start and complete at 06:10".** They
   completed at 06:10 and then failed continuously from 06:12 to 07:03.
4. **The manual restart was 07:40:57**, not "~07:3x".
5. **Nothing was left stranded** (§5).

---

## 2. The memory killer

**Named:** `public.rebuild_entity_search_index()`, unit 9/13.

Correlation: hard failure (`job startup timeout`) begins **06:12:00**, 3m26s
after that unit starts at 06:08:34. Units 1–8 had completed in the preceding
8.5 minutes without tripping anything.

Mechanism, from `pg_proc.prosrc` and `pg_settings` on prod:

```
work_mem (global, prod)          262144 kB = 256 MB
refresh_derived_mvs              SET work_mem = '128MB'      (session)
rebuild_entity_search_index      SET LOCAL work_mem = '256MB'  ← overrides back UP
hash_mem_multiplier              2        → hash nodes may use 512 MB
max_parallel_workers_per_gather  1        → leader + 1 worker, each with its own
shared_buffers                   256 MB
max_connections                  60
commit limit (per dashboard)     ~2.18 GB
```

The function's first act:

```sql
CREATE TEMP TABLE _conn ON COMMIT DROP AS
  SELECT entity_id, count(*) FROM (
    SELECT from_id FROM entity_connections
    UNION ALL
    SELECT to_id   FROM entity_connections
  ) u GROUP BY entity_id;
```

Its own header comment says *"entity_connections (~2.4M rows)"*. Measured on
prod today:

```
reltuples  10,435,594
size       7,470 MB
```

**4.3× the size the 256MB was chosen against** (FIX-748, 2026-07-06). ~20.9M
input rows into one HashAggregate permitted 512 MB in the leader and 512 MB
again in the parallel worker — up to 1 GB for a single node, on a box whose
commit limit is ~2.18 GB and whose shared_buffers already claim 256 MB.

**Driver vs amplifier.** The concurrent crawl unit
(`rebuild_entity_connection_stats_window`) carries `work_mem=64MB` in its
`proconfig` — an order of magnitude smaller. The evidence supports the crawl as
a **contributing co-tenant**, not the driver. The connection storm Craig saw is
downstream of the fork failure, not its cause.

**What is NOT in evidence:** the kernel's own identification of the OOM victim.
Logs were not exported. The chain above is circumstantial-but-tight; it is not
a `Killed process NNN` line.

Filed as **FIX-1123**.

---

## 3. What differed on Saturday

Per-candidate, against Thu 08-27 and Fri 08-28 in the same 05:00–06:30 window.

**(a) The stats arm re-fired — SUPPORTED, and it is the whole story.**

ec-crawl duration at each firing:

| Firing | Thu 08-27 | Fri 08-28 | **Sat 08-29** |
|---|---|---|---|
| 05:00 | 27.2s | 0.03s | 0.03s |
| 05:15 | 36.8s | 0.07s | **6m10s** |
| 05:30 | 0.16s | 0.03s | **3m05s** |
| 05:45 | 8.9s | 0.02s | **1m42s** |
| 06:00 | 14.9s | 0.03s | **hung** |

Thu and Fri were clean because the crawl was **idle at 06:00** — not because the
workload was smaller. Their cycles opened at 06:30 and 19:00 respectively.

**The timing mechanism:** `min_cycle_interval_minutes = 360`. The previous cycle
closed **2026-08-28 23:00:43**. Cooldown expired 05:00:43 — after the 05:00
firing (05:00:00.19, which skipped with `cycle_cooldown`) and before 05:15. So
the cycle opened **05:15**, 45 minutes ahead of the fixed 06:00 job.

This is a free-running 6-hour clock walking against a fixed daily one. It is not
a rare alignment — it recurs whenever a cycle closes near 23:00–00:00 UTC.

**(b) Arms genuinely dirty — SUPPORTED, with a compounding loop.**

`ec_arm_source_fingerprints.disabled_arms` contains
`rebuild_entity_connections_contracts`. That arm is **not source-gated**, so it
runs un-gated every cycle (330.4s on 08-29, 344.9s on 08-28), rewrites
`entity_connections`, and thereby re-dirties the
`entity_connection_stats_windows` fingerprint — whose `fp` is
`n=10490506;t=<max updated_at>`. So the expensive 16-window stats arm is
re-triggered **every cycle**, whether or not edges meaningfully changed. The
crawl cannot go quiet. Noted in FIX-1124.

**(c) Something new in the window — REFUTED.** No second stats pass, no extra
job. The nightly ran at 08:41. The only two participants were jobid 9 and
jobid 45.

### FIX-1117 gate, first prod behavior (observation only, per decision 8)

Working as designed. On the 08-29 05:15 cycle: 9 of 11 arms recorded
`skipped_unchanged` (votes 12.3s, cosponsors/appointments/oversight/holds/gifts/
lobbying/investigation ~0.0s, external 3.4s); only `contracts` ran (330.4s,
un-gated by `disabled_arms`). Stats-window unit costs this cycle: 133.5s, 79.8s,
71.4s. The 08-28 evening cycle showed the same shape. No `Verified:` trailer
added here — that stays with the Monday read.

---

## 4. Guards audit — each guard and the case it cannot fire for

| Guard | Measures | Cannot fire for |
|---|---|---|
| `enforce_cron_job_budgets` | `age > budget_seconds`, joined to `cron_job_budget` | **refresh-derived-mvs-daily has no `cron_job_budget` row at all** — never a candidate |
| `enforce_derived_mvs_unit_budget` | unit age vs 900s | memory; and it needs a **new backend** to act |
| `refresh_derived_mvs` internal budget | 3300s whole run | a 12-minute kill |
| `rebuild_entity_search_index` | `statement_timeout 1200s` | memory; and 1200s ≫ the 12 min that mattered |
| `ec_crawl_gate` | backoff (throughput, read *after* a unit completes), blackout (clock), cooldown (clock) | an in-flight unit during a seizure — the sensor only reads on completion |

**Census:** `pg_proc` in `public` matching
`MemAvailable|available_memory|memory_limit|commit_limit|pg_backend_memory` →
**zero rows**. Nothing anywhere reads memory state.

**The deeper finding — the guards were starved by the condition they exist to
end.** Their predicates *would* have fired:

- `enforce_derived_mvs_unit_budget`: unit started 06:08:34 + 900s → due ~**06:23:34**
- `enforce_cron_job_budgets`: ec-crawl has an 1800s budget, firing ran ~81 min → due ~**06:30**

Neither ran. Every `*/2` firing from **06:12:00 to 07:03:10** failed
`job startup timeout` — pg_cron could not obtain a backend. Corroborated:
`cron_job_budget_action` has **no row on 08-29** (last action 2026-08-25) and
`ec_window_budget_action` is **empty for all time** (FIX-1101's per-window
watchdog has never fired). The watchdog ran again at 07:26:00 — after the crash
— and correctly reaped.

A canceller that must fork a process cannot bound a failure whose signature is
the inability to fork.

Filed as **FIX-1125**.

---

## 5. Stranded state — none

- `data_sync_log WHERE status='running'` → **0 rows.** Both killed rows were
  reaped: the derived-MVs row by `enforce_derived_mvs_unit_budget` at 07:26:00
  (it detected pid 328403 absent from `pg_stat_activity`), the two crawl rows by
  the nightly's stale-reaper at 08:41:07 (`reap_stale_minutes: 60`).
- **Crawl cursor consistent across both restarts.** `cycle_started_at`
  2026-08-29T05:15:00.070215, 11 banked arms, matching
  `arms_banked_on_entry` in the reaped rows. The crawl resumed correctly at
  18:45 with **window 3/16** — exactly where it stopped.
- Derived MVs: units 1–8 of 13 completed; units 9–13
  (`rebuild_entity_search_index`, `rebuild_all_primary_sources`,
  `prune_platform_usage_snapshot`, …) did not. Tonight's firing redoes the
  whole list — the procedure is not resumable, so no work is skipped.

**Nothing repaired, because nothing needed repair.** No FIX filed for stranded
state; the reapers did their job.

---

## 6. Tonight's protection

**Applied to prod 2026-08-29 19:03:28 UTC with Craig's approval.**

```sql
UPDATE public.pipeline_state
   SET value = jsonb_set(value, '{blackout}', '[{"from":"05:45","to":"07:00"}]'::jsonb),
       updated_at = now()
 WHERE key = 'ec_crawl';
```

Revert:

```sql
UPDATE public.pipeline_state
   SET value = jsonb_set(value, '{blackout}', '[]'::jsonb),
       updated_at = now()
 WHERE key = 'ec_crawl';
```

### Mechanism proven on LOCAL before offering

| Case | Result |
|---|---|
| Non-covering window (now+2h..now+3h) | `run=true, reason=clear` — so it is genuinely the predicate, not "array non-empty" |
| Covering window (now−1h..now+1h) | `run=false, reason=blackout` |
| Wrap-around (from > to) | `run=false, reason=blackout` |
| Malformed entry | `WARNING: unparseable blackout entry … — ignored`, `run=true` — **fails OPEN** |
| Driver `CALL run_entity_connections_rebuild('incremental', 1)` | `NOTICE: [rebuild/crawl] SKIPPED (blackout)`; `skips.blackout` 0→1; **0 new `data_sync_log` rows** |

Confirmed on prod after the write: `blackout` reads back
`[{"to": "07:00", "from": "05:45"}]`, gate verdict at 19:03 is `clear` (outside
the window, so the crawl keeps working tonight), and the predicate check
confirms 05:45 / 06:00 / 06:15 / 06:30 / 06:45 skip while 05:30 and 07:00 do not.

### What it does NOT cover

- **`refresh-derived-mvs-daily` (jobid 9) still runs at 06:00**, and it holds the
  memory. This removes the co-tenant, not the cause.
- `rule-taggers-daily` (06:30) still runs.
- A malformed window would silently disable the protection (fails open) — the
  applied value was read back verbatim from prod to rule this out.
- Projection assumption: the open cycle closes ~22:00 UTC, cooldown expires
  ~04:00, so the cycle reopens 04:00–04:15 and would otherwise have been at
  stats window ~7–8 at 06:00.

### How to read it tomorrow

**`pipeline_state.ec_crawl.skips.blackout` should read 5**, with
`last_skip_reason = 'blackout'`. **Not** `data_sync_log` — blackout skips
deliberately write no row there (only `backoff` does). Also check
`cron.job_run_details` for ec-crawl 05:45–06:45: five sub-second `succeeded`
firings.

---

## Follow-ups noticed, out of scope here

- **`refresh-derived-mvs-weekly` (jobid 10) is `active = t` on prod.** Memory
  note `project_weekly_derived_mvs_restarted_prod` records it as turned OFF
  after `chord_donor_state_party_flows_mv` took prod down twice. It fires
  Tuesdays 07:00 UTC. Worth confirming this is intentional before Tue 09-01.
- `ec_window_budget_action` is empty for all time — FIX-1101's per-window
  watchdog has never fired. Unverified whether that is "never needed" or
  "never works".
- The contracts/stats fingerprint loop (§3b) means the crawl re-runs the
  16-window stats arm every cycle. Captured inside FIX-1124; may deserve its own
  item.
