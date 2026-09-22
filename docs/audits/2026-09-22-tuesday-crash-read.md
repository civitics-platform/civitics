# The Tuesday crash series — 09-08 / 09-15 / 09-22

**cc-145 §A.** Read 2026-09-22 22:58–23:25 UTC, about 30 minutes after Craig's
manual restart (postmaster start 22:32:13 UTC). Prod reads only. Nothing was
written to prod by §A: the reap list came back empty (§7).

**Instruments.** Supabase Logs API (`postgres_logs`, `edge_logs`), which needs no
Postgres connection. Prod `cron.job_run_details` joined to `cron.job` by name.
`data_sync_log`. `platform_usage_snapshot`. `pg_settings` and
`pg_db_role_setting`. Every "nothing in the window" claim below cites its query.

---

## 0. Verdict

**One job was in flight on all three days, and the evidence says it is the cause:
jobid 17 `donor-party-rollup-refresh`** (`0 15 * * 2`,
`CALL public.refresh_donor_party_rollup_incremental()`). It runs in **`full`
mode** every time. Its watermark has not moved since 2026-07-28, so the lag
(54 days) is past `full_rebuild_lag` (14 days). Full mode builds `dpr_stage` in
ONE statement: a `GROUP BY fr.from_id, party` over every donation in
`financial_relationships` (14.46 M rows, 12 GB) after `SET work_mem = '256MB'`.
On this box that is the FIX-1123 arithmetic:

- `hash_mem_multiplier` = 2, so the hash node is allowed 512 MB.
- `max_parallel_workers_per_gather` = 1, so leader plus worker can reach about 1 GB.
- The box itself: `effective_cache_size` 768 MB (about 1 GB RAM),
  `shared_buffers` 256 MB, `max_connections` 60.

The box degrades 2–4 minutes into the job and fails 8–12 minutes in. On 09-22 it
did not restart: it stayed degraded until the statement was cancelled at 18:07:58.

- **09-08** — server restarted between 15:10:02 and 15:14:00 UTC, about 12 min
  into jobid 17.
- **09-15** — the postmaster vanished. It crash-recovered at 15:09:48 (`last
  known up at 15:06:05`), 9.8 min into jobid 17.
- **09-22** — no restart. From **15:10:00, every pg_cron job failed with `job
  startup timeout`** until 18:08: the postmaster could not fork, which is
  FIX-1123's 08-29 signature. The Logs API went dark at 15:08:40. The front door
  returned **522 on ~100 % of requests from 16:00 to 22:28**. jobid 17's stage
  build ran until the FIX-1185 3 h role ceiling cancelled it at 18:07:58, 478 s
  late. **pg_cron mostly recovered by 18:18, ten minutes later.** That is the
  dose-response the random-timing argument lacked.

Verdict rule applied: **the first rule, a Postgres-side cause.** The cause shows
in the database's own records (`cron.job_run_details`, `data_sync_log`), not in
the log text, because the log went dark. A 🔴 is filed from this evidence.
**Craig's decision (2026-09-22 ~23:10 UTC): leave jobid 17 ACTIVE and fix it
before its next firing, Tue 2026-09-29 15:00 UTC.** If no fix is on Pro by
09-29 14:00 UTC, the pause is the fallback, and that is Craig's call.

cc-141 §3 read 11(e) refuted jobid 17 on random-timing grounds: two of seven
restarts. That argument does not survive a third consecutive firing. Nor does it
survive the fact that **every full-mode firing since 09-08 (3 of 3) coincided
with the failure.** 08-04, the only earlier full-mode run that got going, ran
6 h and was cancelled in `CREATE TEMP TABLE dpr_stage`. The `*/2` watchdogs
that could have shown the box's state that day did not exist yet (FIX-1063
shipped 08-19).

---

## 1. What contradicted the prompt

1. **"09-22 ~14:30 UTC crash, down ~8 h."** Wrong in both halves.
   - **Timing.** The Logs API shows normal operation to **15:08:40.373**, a
     routine time checkpoint (4 buffers). jobid 17 started at 15:00:00.039.
     The prompt's decisive exclusion ("09-22's crash at ~14:30 PRECEDES [jobid
     17] … it cannot be the common factor") rests on a time the log refutes.
   - **Nature.** Postgres did not crash. pg_cron wrote `cron.job_run_details`
     rows through the whole window. jobid 17's own backend committed its
     `partial` row at 18:07:58. The only terminating event in the log is Craig's
     `received fast shutdown request` at 22:28:28. There is **no** `database
     system was interrupted` line and **no** `starting PostgreSQL` line anywhere
     from 15:08:41 to 22:40 (query in §3). The ~8 h was a degraded host:
     Postgres alive but unable to fork, with ingress and log shipping down.
     It was not a dead one.
2. **"09-15's log is gone Tue 09-29 ~15:09 UTC."** It was already gone when the
   prompt was written. Logs API retention is a rolling 7 × 24 h. The earliest
   retained `postgres_logs` row at 23:04 UTC today was `2026-09-15T23:04:00.110Z`,
   so the 09-15 15:09 crash rolled off at about 09-22 15:10 UTC. **Read 2(c) was
   impossible:** a 09-15 14:30–15:30 read returns 0 rows. cc-141 §3's excerpt is
   the only surviving record of that log.
3. **§B D1: "the restart re-zeroed `pg_stat_user_indexes`."** It did not. A
   clean `fast shutdown` writes the cumulative stats out, and startup reloads
   them.
   - The entity_tags UNIQUE key read 9,579,952 at cc-141 (09-21 23:37) and
     10,519,860 after the restart.
   - The oldest `last_idx_scan` on the table is 2026-09-19 23:56. Stats reset
     at startup would have cleared it.
   - `data_sync_log` has `n_tup_ins` 1,469.

   The counter epoch is still the 09-15 15:09:48 crash (7.3 days), and
   `idx_entity_tags_visibility` is still `idx_scan 0`. The drop script's gate
   reads `pg_postmaster_start_time()`, which is 22:32:13 today, so it refuses on
   a 0.03-day "epoch". Side observation: `pg_stat_statements_info.stats_reset`
   DID move to 22:32:13. On a sick shutdown, pgss's reset time and the pgstat
   epoch can disagree. Probably the pgss dump (a postmaster exit hook) was lost
   while the checkpointer's pgstat write was not. Do not use pgss `stats_reset`
   to date index counters.

---

## 2. The three timelines

Times in UTC. "Watchdog wall" is jobid 44 `cron-job-budget-watchdog`
(`SELECT public.enforce_cron_job_budgets()`). At 14:50–14:58 on all three days
it is 0.02–0.12 s.

| | 09-08 | 09-15 | 09-22 |
|---|---|---|---|
| jobid 26 treemap-individuals-global-refresh | 14:00:00 → 14:18:04 (1,084.2 s) ✓ | 14:00:00 → 14:16:34 (994.1 s) ✓ | 14:00:00 → 14:15:16 (916.4 s) ✓ |
| box state 14:20–14:58 | watchdogs 0.0–0.1 s | watchdogs 0.0–0.1 s | watchdogs 0.0–0.1 s; checkpoints 4 buffers |
| ec-crawl 15:00 | 202.7 s (a real crawl unit) | 0.2 s | 0.2 s |
| fe-crawl 15:00 | 0.3 s | 0.2 s | 0.2 s |
| **jobid 17 donor-party-rollup-refresh** | **15:00:00.21 → `server restarted`**, dsl `reaped` | **15:00:00.18 → `server restarted`**, dsl `reaped` | **15:00:00.16 → 18:08:55 (11,335 s), dsl `partial`: mode full, units_run 0, `stage build: canceling statement due to statement timeout`** |
| watchdog wall 15:02 / :04 / :06 / :08 | 3.07 / 0.64 / 1.31 / 1.63 s (dispatch +2.2 s at :02) | 0.05 / 1.02 / 1.39 / 1.41 s | 1.08 / 3.81 / 3.96 / 2.98 s (dispatch +1.2 s at :04, +5.7 s at :06) |
| last healthy mark | 15:10:01 watchdog ✓ (1.32 s); 15:12 slot absent | 15:08:00 watchdog ✓ (1.41 s); log line 15:08:01.829 | 15:08:01 watchdog ✓ (2.98 s); last log line 15:08:40.373 |
| failure | restart ≈ 15:12 (next row 15:14:00) | `interrupted; last known up 15:06:05`, restart 15:09:48 | **15:10:00 onward: 100 % `job startup timeout`** (24 + 24 watchdog failures 15:10–16:01; ec/fe crawl, **rule-taggers-weekly 16:00**, all seven 17:0x–17:21 vacuums lost) |
| recovery | pg_cron resumes 15:14 | pg_cron started 15:09:50 | stage build cancelled 18:07:58 → watchdogs succeed from **18:18**; ~1/3 startup timeouts 18:18–22:28 (8–12/h each); fast shutdown 22:28:28; postmaster 22:32:13; zero startup timeouts since |
| front door (edge_logs) | not read (retention) | not read (retention) | 15:00–15:30: 38 5xx / 177 (30 × 504, 7 × 522); 15:30–16:00: 96 / 98; **16:00–22:30: 522 on 1,376 of 1,411 requests**; 22:30–23:00: 28 / 293 (8 × 503); 23:00: 3 / 143 |

Queries:

```sql
-- the cron rows, all three windows (LEFT JOIN: unscheduled jobs vanish from cron.job)
SELECT d.jobid, j.jobname, d.start_time, d.end_time, d.status,
       extract(epoch FROM d.end_time - d.start_time) AS wall_s, d.return_message
FROM cron.job_run_details d LEFT JOIN cron.job j USING (jobid)
WHERE d.start_time BETWEEN '2026-09-08 13:40Z' AND '2026-09-08 15:20Z'
   OR d.start_time BETWEEN '2026-09-15 13:39Z' AND '2026-09-15 15:15Z'
   OR d.start_time BETWEEN '2026-09-22 13:38Z' AND '2026-09-22 15:15Z'
ORDER BY d.start_time;
-- 09-22 15:08–23:10 grouped by hour / job / status: the 100 % → ~1/3 → 0 startup-timeout curve
```

```sql
-- edge (Logs API), 30-min buckets 09-22 13:00–23:10
select timestamp_seconds(div(unix_seconds(t.timestamp), 1800) * 1800) as b, count(*) as requests,
       countif(r.status_code >= 500) as n_5xx, countif(r.status_code = 522) as n_522
from edge_logs t cross join unnest(t.metadata) as m cross join unnest(m.response) as r
group by b order by b
```

**jobid 17's full history** (`cron.job_run_details WHERE jobid = 17`):

- 07-14 / 07-21 / 07-28 — succeeded, 388 / 420 / 352 s.
- 08-04 — `canceling statement due to statement timeout` at 21,628.6 s, in
  `CREATE TEMP TABLE dpr_stage`.
- 08-11 / 08-18 / 08-25 — `job startup timeout`.
- 09-01 — watchdog cancel at 1,814.6 s, in `array_agg(DISTINCT fr.from_id)`,
  which FIX-1112 removed.
- 09-08 / 09-15 — `server restarted`.
- 09-22 — 11,335 s: pg_cron says `succeeded`, the procedure's own row says
  `partial`.

No firing has advanced the watermark since 07-28: `pipeline_state.donor_party_rollup_watermark`
is `{"last_indexed_at": "2026-07-28 05:54:28.48494+00"}`, updated 2026-07-28 08:50:51.

---

## 3. The log tails (09-22)

Read (a), every row, unfiltered, 09-22 14:00–16:00 in three slices (122 + 78 + 30
rows):

```
select t.timestamp, t.event_message from postgres_logs t order by t.timestamp
```

Nothing in 14:00–15:08:40 matches `out of memory` / `terminated by signal` /
`could not fork` / `too many clients` / `remaining connection slots` /
`interrupted` / `starting PostgreSQL` (grep count 0 over all 230 rows). Most of
14:00–14:15 is jobid 26's own `duration: … plan:` lines: its per-chunk
`INSERT INTO _tin_state_name` ran 11–30 s per chunk and finished 14:15:16. One
`canceling statement due to statement timeout` appears at 15:00:58.754. The
last 20 rows before the gap:

```
15:02:00.150  cron job 44 starting: SELECT public.enforce_cron_job_budgets();
15:02:00.199  cron job 40 starting: SELECT public.enforce_derived_mvs_unit_budget();
15:02:00.653  cron job 40 completed: 1 row
15:02:01.591  cron job 44 completed: 1 row
15:03:36.436  checkpoint starting: time
15:03:37.429  checkpoint complete: wrote 5 buffers (0.0%); … distance=32767 kB
15:04:00.523  cron job 44 starting
15:04:00.559  cron job 40 starting
15:04:01.489  cron job 40 completed: 1 row
15:04:05.013  cron job 44 completed: 1 row          ← 4.5 s
15:06:03.915  cron job 44 starting                   ← dispatched 3.9 s late
15:06:04.741  cron job 40 starting
15:06:06.173  cron job 40 completed: 1 row
15:06:09.635  cron job 44 completed: 1 row          ← 5.7 s
15:08:00.592  cron job 44 starting
15:08:00.716  cron job 40 starting
15:08:01.314  cron job 40 completed: 1 row
15:08:04.153  cron job 44 completed: 1 row
15:08:37.570  checkpoint starting: time
15:08:40.373  checkpoint complete: wrote 4 buffers (0.0%); … total=3.060 s
     ←—— 7 h 19 m 48 s, zero rows ——→
```

Read (b), 09-22 15:08:41 → 22:40, every row: **22 rows, and all of them from
22:28:28 on.** Zero `starting PostgreSQL`, zero `interrupted`, so this was no
crash loop. It was not a dead VM either, because pg_cron kept writing rows (§2).
The first 20 after the gap:

```
22:28:28.648  received fast shutdown request
22:28:28.714  aborting any active transactions
22:28:28.725  could not receive data from client: Connection reset by peer
22:28:28.735  pg_cron scheduler shutting down
22:28:28.750  terminating connection due to administrator command
22:28:29.232  terminating connection due to administrator command
22:32:22.204  canceling statement due to statement timeout
22:32:50.792  could not receive data from client: Connection reset by peer
22:34:00.096  cron job 44 starting …   (and the */2 pair, normal walls, from here on)
22:37:13.364  checkpoint starting: time
22:39:44.627  checkpoint complete: wrote 1508 buffers (4.6%); 0 WAL file(s) added, 149 removed, 61 recycled; write=150.796 s
```

The shutdown and startup lines between 22:28:29 and 22:34 are also absent from
the Logs API. The first post-restart checkpoint retired 210 WAL segments.
Both are recorded, not interpreted.

Read (c), 09-15 14:30–15:30: **0 rows** (retention, §1.2). What survives is
cc-141 §3's excerpt: `15:08:01.829 cron job 44 completed` → 106 s of nothing →
`15:09:48.341 database system was interrupted; last known up at 2026-09-15
15:06:05 UTC`.

---

## 4. The intersection

Tuesday-specific jobs in `[crash − 90 min, crash + 5 min]`, by name:

| job | 09-08 | 09-15 | 09-22 | status at the failure |
|---|---|---|---|---|
| treemap-individuals-global-refresh (jobid 26, `0 14 * * 2`) | ended 14:18:04 | ended 14:16:34 | ended 14:15:16 | **done**, followed by ~45 min of measurably healthy box on all three days |
| **donor-party-rollup-refresh (jobid 17, `0 15 * * 2`)** | in flight (started 15:00:00) | in flight | in flight | **running, 8–12 min in, every time** |
| rule-taggers-weekly (`0 16 * * 2`) | after | after | after, lost to startup timeout at 16:00 | n/a |

Always-on jobs (ec-crawl `*/15`, fe-crawl `*/30`, both `*/2` watchdogs) are in
every window, failing or not, so they carry no signal. The one exception is
09-08's 202.7 s ec-crawl unit, which is not repeated on the other two days.
The `data_sync_log` writers across all three windows are the same set:
`front_door_watch` every 15 min, treemap, jobid 17, and the crawls. On 09-22
`donor_rollup_refresh` at 12:00 caught up in 0 s. cc-144's holds (09:02–10:20)
and the FIX-1210 repair (10:17–10:18) ended about five hours earlier.

**Intersection = one job, in flight, not ended.** The prompt's second verdict
rule ("ONE job that ENDS inside the hour") does not fit literally, and neither
does 09-22's shape ("vanished without logging"). The first rule does: a
Postgres-side cause, a job's SQL in the last lines. jobid 17's `starting` line
is at 15:00:00.039 with no completion before the gap.

`cron-watchdog` (Vercel `*/2`, new 09-22 01:xx) is innocent by construction. It
is a PostgREST call. From 16:00 PostgREST was behind a 522, so it could not
reach the box, let alone load it. Its pre-15:08 firings are not in any log read
here. Its liveness stamp is [[FIX-1208]], which is not on Pro yet.

---

## 5. The only persisted infra series

`platform_usage_snapshot`, written every 30 min by the Vercel `platform-snapshot`
route. Memory is not in the payload (`supabase-prometheus.ts:1-40` scrapes
egress, backends, disk and CPU only).

| t (UTC) | 09-08 cpu % / conns / disk GB | 09-15 | 09-22 |
|---|---|---|---|
| 12:00 | 17.8 / 16 / 35.95 | 3.0 / 18 / 37.98 | 8.8 / 17 / 38.99 |
| 13:00 | 2.8 / 16 / 35.95 | 2.7 / 18 / 37.98 | 2.5 / 17 / 38.99 |
| 14:00 | 5.7 / 16 / 35.95 | 3.7 / 18 / 37.98 | 5.0 / 8 / 39.00 |
| 14:30 | 39.1 / 10 / 35.89 | 31.1 / 8 / 37.98 | 28.7 / 8 / 38.99 |
| 15:00 | 8.7 / 11 / 35.89 | 4.2 / 15 / 37.98 | 3.1 / 13 / 38.99 |
| 15:30 | 0 / 9 / 35.24 (post-restart) | 0 / 6 / 36.62 (post-restart) | **no row** |
| 16:00 → 22:00 | normal | normal | **no rows** (the route writes to the box it measures) |
| 22:33 | | | 0 / 13 / 38.99, `error: supabase_max_connections: <!DOCTYPE html>` |

The 15:00 sample is 49–74 s into jobid 17 and flat on all three days. **At
30-min resolution the event is invisible** (rule 111: this instrument cannot see
it). The 14:30 CPU spike (28–39 %) repeats weekly. It falls after jobid 26
ended and does not correlate with the failure. Disk dropped 0.65 GB and
1.36 GB across the 09-08 and 09-15 restarts (WAL or temp cleared at restart),
not attributable from a 30-min series.

## 6. The dashboard (memory / CPU / disk IO) and the platform activity log

**Not pasted this session. The memory dimension is UNREAD.** The mechanism in
§0 is therefore arithmetic plus signature: the 256 MB × 2 × (1 + 1 worker)
budget against a ~1 GB box, FIX-1123's fork-failure shape, and the recovery ten
minutes after the cancel. It is not a measured memory curve. A memory series at
≤ 2-min resolution, persisted somewhere that does not need this database, would
have decided it outright (FIX-1125, §8).

---

## 7. What the crash left behind — the reap list

| read | result |
|---|---|
| `data_sync_log WHERE status='running'` | **0 rows**. jobid 17 closed its own row `partial` at 18:07:58 (FIX-1028's by-name `query_canceled` handler did its job). |
| `prod_session_state()` | `held false, label_present false, live_writers []`: clear |
| `rollup_watch_overrides WHERE held_since IS NOT NULL` | 0 rows |
| `ec_crawl_gate()` | `{"run": false, "reason": "cycle_cooldown", "detail": "last cycle closed 20 min ago; minimum interval is 360 min"}`: a designed state. The EC crawl ran 15 `partial` units 18:30–22:15 and closed a cycle `complete` at 22:45. |
| `pipeline_state` ec_crawl / fe_crawl | updated 23:00:00, no future `backoff_until` |
| `cron.job_run_details` non-terminal | **one row, runid 14355, jobid 44, `connecting`, NULL start**. Its neighbours are 08-24 16:15 startup timeouts and a `server restarted`, so it is a leftover of the **08-24** restart, not this one. pg_cron-internal, no owner, harmless. Not touched. |

**Reap list: empty. No prod write was made or needed.**

---

## 8. What the guards did

- **FIX-1063 budget watchdog (jobid 44, 1,800 s):** never reached jobid 17. It
  could not start from 15:10 to 18:08: the guard was starved by the condition it
  exists to end. This is FIX-1125's title, measured.
- **FIX-1194 P2-A (Vercel `*/2` `cron-watchdog`):** the second firing path needs
  no pg_cron worker, but it needs PostgREST, and PostgREST was behind a 522 from
  16:00. The two paths failed together. This outage is the shape P2-A cannot
  cover.
- **FIX-1185 `postgres` role ceiling (3 h):** the only bound that fired. It
  cancelled the stage build at 18:07:58, 11,278 s in and 478 s past the
  ceiling. The late fire is consistent with a backend that could not reach
  `CHECK_FOR_INTERRUPTS` promptly on a starved box. **It worked as designed**:
  it is "the backstop for the box cannot fork".
- **FIX-1137 (re-fire an idempotent job once):** would not have helped. The
  outage outlived every re-fire window, and rule-taggers-weekly lost its week.

## 9. The nightly after the restart

Read at the end of the session. See the cc-145 report §2.
