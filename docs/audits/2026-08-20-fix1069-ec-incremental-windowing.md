# FIX-1069 / FIX-1071 / FIX-1072 — the EC incremental donations arm, measured

**Session:** cc-prompt-72, 2026-08-20 (01:40–04:00 UTC)
**Target:** the Monday 2026-08-24 08:00 UTC firing of jobid 22 (`rebuild-ec-incremental-mon`)

> **Provenance note.** The 2026-08-19 triage this session builds on (cc-71) was
> never written to `docs/audits/` — only its SQL survives, in a session
> scratchpad. Every figure it reported has been independently re-measured here
> against prod and is reproduced below with its query, so this file stands on
> its own.

---

## 1. The defect, re-measured on prod

`data_sync_log` row `3777eabf-eba7-40ce-beff-062aa31b91cc`, jobid 2, 08-19
08:00:00 → 14:04:28 UTC:

| field | value |
|---|---|
| status | `partial` |
| rows_inserted | **0** |
| elapsed_seconds | 21868 |
| arm_timings | `{"rebuild_entity_connections_donations": 21677}` |
| arms_banked | `[]` |
| next_arm | `rebuild_entity_connections_donations` |
| budget_exhausted | **false** |
| error_message | `canceled — rebuild_entity_connections_donations: canceling statement due to statement timeout` |

99.1% of the run inside one arm. And `pipeline_state.entity_connections_rebuild_cursor`
**did not exist on prod** — confirmed by direct query. The cursor row is only
written after an arm completes, and none did.

**Root cause.** FIX-1056 built the windowed/banked donations path but gated it on
`IF v_full`. Both scheduled jobs pass `mode='incremental'`:

```
jobid  2  rebuild-ec-incremental      0 8 * * 3  CALL public.run_entity_connections_rebuild('incremental');
jobid 22  rebuild-ec-incremental-mon  0 8 * * 1  CALL public.run_entity_connections_rebuild('incremental');
```

So on prod the windowed path was unreachable code that has never once executed,
and the incremental arm went down the generic loop —
`EXECUTE format('SELECT COALESCE(SUM(edges_upserted), 0) FROM public.%I()', v_fn)`
— a single top-level statement. Everything FIX-1056 added operates *between*
arms, and there is no "between" inside one statement.

**The backlog, measured at the live watermark of 2026-08-17 04:01:23:**

```
dirty rows      3,357,701
dirty from_ids  1,961,194     (of 2,820,984 donation-ish from_ids total = 70%)
```

---

## 2. The general rule this establishes

> **An in-procedure budget bounds the NUMBER of units. It can never bound a
> single unit.**

That makes an internal budget a *scheduling* guarantee, never a *safety*
guarantee, and every procedure carrying one still needs an outside bound sized
above it. `budget_exhausted=false` next to `elapsed_seconds=21868` against an
18,000 s budget is not a sizing miss — the check never got to run.

This is the same blind spot FIX-1018 found one level up in the donor rollup
(cost in the pre-loop dirty-set build, before the guard could evaluate
anything). Pre-loop there, intra-arm here. Playbook C3.

---

## 3. What shipped

### FIX-1071 — the outside bound (landed first, alone)

`cron_job_budget` rows for both jobs at **18,000 s** — FIX-1056's own
`c_budget_default` (5 h), enforced by the FIX-1063 watchdog (jobid 44) where it
can actually land. Under the 21,600 s cluster ceiling so the watchdog wins the
race and the cancel lands in FIX-1028's `query_canceled` handler.

**Counterfactual against the real rows** — all three recent overruns recorded a
`job_pid`, so the watchdog's liveness guard would have been satisfied:

| runid | jobid | started | ran | would cancel at | seconds saved |
|---|---|---|---|---|---|
| 5993 | 2 | 08-19 08:00 | 21,875 s | 13:00 UTC | 3,875 |
| 3353 | 22 | 08-17 08:00 | 21,615 s | 13:00 UTC | 3,615 |
| 209 | 22 | 08-10 08:00 | 22,380 s | 13:00 UTC | 4,380 |

Watchdog jobid 44 verified healthy: 30/30 firings in the trailing hour.

### FIX-1069 — window the incremental arm

16 from_id-range windows with per-window COMMIT, mirroring the full path, plus
three things the full path does not need:

1. **A durable per-window watermark**, advanced by the window itself as the last
   statement of its own transaction. There is no code path that can advance a
   watermark for work that did not commit. The scalar `last_indexed_at` is kept
   as the **MIN across the 16**, so existing readers keep seeing a conservative,
   true "everything before this is fully indexed".
2. **A cycle-scoped staging table** (`ec_donations_incr_dirty`, UNLOGGED). The
   dirty set is built **once per cycle**, not per firing, so a budget exit at
   window 9 costs nothing on re-entry.
3. **Budget checked between windows**, so an exit banks the windows that
   finished.

### FIX-1072 — the census teardown + mechanism correction

See §6.

---

## 4. Proofs (local, full prod clone: 6.59M donation-ish FR rows, 5.69M edges)

Test watermark `W = 2026-08-09 00:00:00+00` → 164,452 dirty donors.

### 4.1 Equivalence — windowed output is identical to the single-pass run

| run | edges written | wall clock |
|---|---|---|
| legacy `rebuild_entity_connections_donations()` (one statement) | 1,175,158 | **348.6 s** |
| windowed, 16 committed windows | 1,175,158 | ~690 s |

Symmetric difference over every column of the affected population, with
`evidence_ids` sorted (ARRAY_AGG tie order is not deterministic across scan
shapes and is not a difference):

```
in_legacy_not_windowed | in_windowed_not_legacy
-----------------------+------------------------
                     0 |                      0
```

Cycle closed, all 16 watermarks level with the target, staging truncated to 0.

**The ~2x total-cost premium is real and is the price of boundedness.** It is
not a plan pathology — the per-window DELETE plan was checked and is optimal
(bitmap range scan on the staging PK driving a nested loop into
`entity_connections`' unique index; no sequential scan). The trade is 2x wall
clock for a run that can stop, bank, and resume, against a run that produced
**zero** after six hours.

### 4.2 Banking / ratchet — a budget exit preserves work

Driven through the **shipped** procedure with the FIX-1056 `pipeline_state`
budget override set to 120 s:

```
[donations/incr] opened cycle since=2026-08-09 target=2026-08-20 00:13:37 — 164452 dirty donors staged
    [donations] window 1/16 [00000000..10000000) — 76612 edges
    [donations] window 2/16 [10000000..20000000) — 71818 edges
    [donations] window 3/16 [20000000..30000000) — 73145 edges
WARNING:  [donations] window 4/16 — BUDGET EXHAUSTED before start; banking and exiting
[rebuild] BUDGET EXHAUSTED in mode=incremental — 221575 edges, next=donations_incr_windows (window 4/16)
```

| assertion | result |
|---|---|
| status | `partial` |
| budget_exhausted | `true` |
| rows_inserted | **221,575** (vs prod's 0) |
| next_arm | `donations_incr_windows (window 4/16)` — arm *and* window |
| windows advanced | **3** |
| windows still at W | **13** |
| scalar `last_indexed_at` | still `W` — the MIN did not move |
| staging rows surviving | **164,452** — resume is free |

The ratchet is exact: only the three committed windows advanced.

### 4.3 Resume — an interrupted sequence equals a single-pass run

Second run reused the open cycle without re-staging and skipped the completed
windows instantly. After driving the remainder to completion and closing:

```
edges_after_resume | in_legacy_not_resumed | in_resumed_not_legacy
-------------------+-----------------------+-----------------------
           1175158 |                     0 |                     0
```

**An interrupted, resumed, multi-session drain produces byte-identical output to
one uninterrupted statement.**

---

## 5. The inert `SET statement_timeout` guards, removed

`rebuild_entity_connections_donations()` carried `SET statement_timeout='45min'`
and `_donations_full()` carried `'90min'`. Neither ever bounded anything.
Re-measured on local (PG 17):

```
CREATE FUNCTION _probe() ... AS $$ PERFORM pg_sleep(5) $$;
ALTER FUNCTION _probe() SET statement_timeout = '2s';

session timeout = 0    ->  SELECT _probe()  =>  slept 5s, NO timeout
session timeout = 30s  ->  SELECT _probe()  =>  slept 5s, NO timeout
current_setting('statement_timeout') INSIDE the body  =>  '2s'
                                     outside          =>  '0'
```

The third line is the mechanism and it is why the guard was so convincing:
**proconfig genuinely changes the GUC inside the body — it just never re-arms
the timer**, which was armed once in `start_xact_command()` before the function
was entered. FIX-1063 measured this for the `CALL` path; this generalises it to
the plain `SELECT` path, i.e. all of them.

Checked before removing: the only callers are
`packages/data/src/scripts/rebuild-entity-connections.ts` and
`run-rebuild-chunks-prod.ts`, and **both use a direct `pg.Client`**, not
PostgREST — so nothing relied on proconfig to widen a role-level REST timeout.

---

## 6. The bgworker census: hypothesis refuted

FIX-1058 armed a census on 08-18 to find *which backends hold the worker slots*.
Read 08-20 (1,182 samples, 08-18 01:12 → 08-20 01:10, self-disarmed on
schedule). **It refutes the hypothesis it was built to confirm.**

- Non-client backends peaked at **8** against `max_worker_processes=12`, and all
  nine backend_types present were singletons (archiver, autovacuum launcher,
  bgwriter, checkpointer, logical repl launcher, pg_cron launcher, pg_net
  worker, walwriter, occasional autovacuum worker). No pool was competing.
- Client backends peaked at **25** against `max_connections=60`.

**And the hypothesis was structurally unavailable anyway:**
`cron.use_background_workers = off`. pg_cron then never requests a background
worker per job — it opens a **libpq client connection** and sends the command as
one simple query (the same fact FIX-1063 depends on). So "pg_cron may request 32
concurrent job workers from a 12-slot pool" describes a request pg_cron does not
make. `cron.max_running_jobs=32` bounds concurrent *connections*, and 32 < 60.

**Therefore `job startup timeout` = failure to establish a CONNECTION** inside
pg_cron's task-start window, not failure to acquire a slot. The bottleneck is
the postmaster's ability to fork and complete a handshake. FIX-1058's own log
evidence said so and was read as supporting the wrong mechanism — `could not
accept SSL connection: EOF detected` / `Connection reset by peer` are clients
dying **in the TLS handshake**.

**Corollary: raising `max_worker_processes` is a non-remedy for cron startup
timeouts.** Drop it from the candidate list.

**The census corroborated a box-wide stall by its own absence** — exactly what it
was designed to do. Samples landed per 30-min bucket on 08-19 (15 expected each):

```
07:00  15    09:00   8    11:00   9    13:00   1
07:30  15    09:30   4    11:30   2    14:00   1
08:00  15    10:00  10    12:00   —    14:30   1
08:30  15    10:30   8    12:30   —
```

Zero samples in **both** the 12:00 and 12:30 buckets — precisely the window in
which 91 of 91 cron firings died. The sampler could not get a connection either.

**Not established here:** *which* resource saturated. The I/O-starvation reading
(~265 GB physical reads against a 256 MB `shared_buffers`, confirmed here as
`shared_buffers=32768` 8 kB pages) is the 08-19 triage's measurement, not the
census's. Record it as consistent-and-measured-elsewhere, never as
census-proven.

---

## 7. Monday readiness

With FIX-1069 on prod, the 08-24 08:00 UTC firing will:

1. seed all 16 window watermarks from the scalar (`2026-08-17 04:01:23`);
2. stage the dirty set once;
3. work through 16 committed windows, banking each;
4. either converge, or budget-exit at 5 h **with every completed window
   preserved** and `next_arm` naming the exact window to resume at.

Either way it cannot repeat 08-19's "six hours, zero rows, nothing banked", and
FIX-1071 bounds it from outside regardless.

**The optional weekend drain** (`node scripts/drain-ec-donations.mjs --prod
--allow-prod --until 04:45`, Sat 08-22 or Sun 08-23 in the 01:00–05:00 UTC
quiet slot) would take Monday's dirty set to near zero. It is supervised and
interruptible; `--until` stops before a window it cannot finish, and stopping is
free.

---

## 8. The first prod drain — measured, 2026-08-20 04:38–05:41 UTC

Run supervised on an idle box (nightly complete 03:06:53, vote-stats 03:30:20,
0 cron and 0 pipelines running; FR 0.08% dead / 99.5% all-visible, EC 0.07% /
100%). Hard stop 05:30 to protect `refresh-derived-mvs-daily` at 06:00.

```
prepare done in 88.0s — 1,961,194 donors staged
  window  1/16    356,388 edges  702.5s
  window  2/16    349,871 edges  697.1s
  window  3/16    352,814 edges  706.8s
  window  4/16    351,677 edges  718.1s
  window  5/16    349,574 edges  708.0s
DEADLINE reached before window 6/16 — stopping cleanly.
windows run: 5   edges written: 1,760,324   total elapsed: 61.7 min
```

**Every design property held on prod.** Windows 0–4 carry the cycle target;
5–15 still carry the old watermark. Exactly 5 banked, 11 pending — the ratchet
is exact. The scalar `last_indexed_at` did **not** move (it is the MIN, and 11
windows lag), staging survived intact at 1,961,194 rows, and the cycle stayed
open, so the next firing resumes for free.

**612,284 of 1,961,194 donors drained (31.2%).**

### 8.1 The pre-loop cost is a non-issue — no index needed

**88 seconds** to stage 1,961,194 donors. That retires the FIX-1018-class
concern in §7 and settles the index question: a ~300 MB partial index on
`(from_id, updated_at)` would be buying back 88 s paid once per cycle. **Do not
build it.**

### 8.2 Window cost scales cleanly

| | local | prod | ratio |
|---|---|---|---|
| donors/window | ~10k | ~122k | 12.2x |
| seconds/window | 43 | ~707 | 16.3x |

Timings are flat across windows (702/697/707/718/708 s, σ ≈ 8 s), which is the
uniform nibble partition doing its job. **A full 16-window drain projects to
~3.2 h** (88 s + 16 × ~707 s) — it fits a 4-hour quiet slot with margin.

### 8.3 A bulk rewrite degrades the visibility map — the script now vacuums

The drain rewrote 1,760,324 edges and took `entity_connections` from **100%
all-visible to 77.3%**, with 4.21% dead tuples. Autovacuum had already fired
mid-drain (05:19) and had *not* closed it. That is exactly the FIX-884
precondition: a heap page loses its all-visible mark if **any** tuple on it is
dead, so every index-only scan over EC silently degrades to per-row heap fetches.

This was a violation of the standing CLAUDE.md convention (FIX-943: *any script
that bulk-rewrites a table ends by vacuuming what it rewrote*) in
`scripts/drain-ec-donations.mjs` itself. `VACUUM (ANALYZE)` run by hand
immediately after — **~90 s, restoring 0 dead tuples and 100% all-visible** —
and the vacuum tail is now part of the script, on the early-stop path too,
because a partial drain dirties just as many pages as a complete one.

### 8.4 A mid-cycle residual cannot be read off the scalar watermark

The script originally closed by reporting "dirty set since the scalar
watermark", which mid-cycle is **the full original backlog regardless of
progress** — it told an operator who had just drained 31% of the donor space
that nothing had happened. Fixed: it now reports windows-at-target, the donors
still owed in pending windows, and an explicit note that the scalar deliberately
does not move until the last window lands.

---

## 9. The second drain — cycle CLOSED, backlog at zero

Run 2026-08-20 22:55 → 2026-08-21 01:11 UTC, hard stop 02:00 (an hour of margin
on the ~03:00 nightly).

```
resuming cycle target=2026-08-20 02:58:40 staged=2026-08-20 04:39:57
                                          (1961194 dirty donors already staged)
prepare done in 0.6s
  window  1..5/16   SKIPPED (already at target)
  window  6/16    358,827 edges  702.7s      window 11/16    353,229 edges  733.1s
  window  7/16    350,280 edges  714.7s      window 12/16    357,870 edges  742.1s
  window  8/16    354,219 edges  728.0s      window 13/16    352,687 edges  738.1s
  window  9/16    344,629 edges  736.0s      window 14/16    358,380 edges  729.6s
  window 10/16    358,148 edges  755.7s      window 15/16    353,284 edges  746.3s
                                             window 16/16    354,801 edges  731.5s
close: cycle CLOSED — staging cleared, scalar watermark advanced
VACUUM (ANALYZE) entity_connections — done in 79.6s
windows run: 11   skipped: 5   edges written: 3,896,354   elapsed: 135.7 min
```

**Resume is free, measured: `prepare` took 0.6 s against 88 s to open the cycle
— 147x — and the five banked windows skipped instantly.** That is the
cycle-scoped staging table and the per-window ratchet doing exactly what they
were built for, against a real cycle 18 hours old.

### 9.1 Final state, verified independently of the script's own output

| check | result |
|---|---|
| windows at target | **16/16**, one distinct value |
| cycle block | gone |
| staging rows | 0 |
| scalar `last_indexed_at` | `2026-08-20 02:58:40.681855+00` |
| **dirty set remaining** | **0 rows / 0 donors** |
| donation edges | 8,558,850 |
| opposition edges | 4,648 |
| EC dead tuples / all-visible | **0 / 100.0%** (vacuum tail, `last_vacuum` 08-21 01:10) |
| budget watchdog cancellations | 0 — it never had to act |

Across both drains: **5,656,678 edges written over 16 windows in 3.3 h of
wall clock**, and the donation-edge population went from 6,594,441 after drain 1
to 8,558,850 — the backlog was not merely stale, it was *missing* edges the
failed rebuilds could never write.

### 9.2 The windowed path does not starve the box

During the 2 h 15 m of drain 2, prod logged **144 cron firings, 0 `job startup
timeout`, 0 failures**. Set that beside 2026-08-19, when the unwindowed
six-hour statement was running and **91 of 91 firings died** in the 12:00–13:29
window and the census sampler could not get a connection either.

Same table, comparable write volume, opposite outcome. Short committed
transactions with COMMITs between them leave the postmaster able to accept
connections; one six-hour statement does not. That is a second, independent
argument for the windowing beyond budget-and-resume, and it is the first direct
evidence for the connection-accept mechanism §6 relocated the problem to.

---

## 10. Monday readiness — settled

**The 08-24 08:00 UTC firing will find a dirty set of zero** (plus whatever the
Friday, Saturday and Sunday nightlies add, which is ordinary daily volume — the
08-17→08-20 backlog is gone).

It will open a fresh cycle, stage a small dirty set, run 16 cheap windows, and
close. Nothing about it resembles 2026-08-19.

Both bounds remain in place regardless: FIX-1056's 5 h internal budget now has
units small enough to see between, and FIX-1071's 18,000 s outside bound
backstops it.

---

## 11. The 2026-08-25 cost census — window 5 was the CHEAPEST window

Written from cc-prompt-87, whose working hypothesis was that the 16 uniform
UUID-space windows are cost-imbalanced and need cost-weighted bounds. **The
measurement refutes that.** Recorded here in full because the negative result is
the useful part: it redirects the fix.

### 11.1 What the 2026-08-24 run actually did

Authoritative record, `data_sync_log` row for `entity_connections_rebuild`,
2026-08-24 08:00:00.120226 → 13:16:16.359763 UTC:

```
status            partial
rows_inserted     556008
elapsed_seconds   18976          budget_seconds 18000
arm_timings       {"donations_incr_windows": 18976}
arms_banked       []
next_arm          donations_incr_windows
budget_exhausted  false
cancel_detail     donations window 5 [40000000..50000000):
                  canceling statement due to user request
```

Two corrections to the prompt's reading:

- **`556,008` is the total banked by windows 1–4, not window 5's output.**
  Window 5 committed nothing — it was cancelled, and its transaction rolled back.
- **The cancel was `user request`, not a statement timeout.** That is
  `pg_cancel_backend()`, i.e. **FIX-1071's outside watchdog doing exactly its
  job** at the 18,000 s bound. `budget_exhausted false` next to
  `elapsed_seconds 18976` is FIX-1071's signature, not a failure of it.

So: windows 1–4 (zero-based keys 0–3) banked in ~5,236 s — ~1,309 s each —
and window 5 (zero-based 4, range `[40000000..50000000)`) then ran ~13,740 s
alone before the axe.

### 11.2 The census

The `ec_donations_incr_dirty` staging table could not be read: it is `UNLOGGED`
and **prod restarted at 2026-08-24 16:26:19 UTC**, which truncates unlogged
tables. Its 565,810 rows were gone before this session opened. (FIX-1069 handles
this correctly — `prepare()`'s `EXISTS` check falls through and rebuilds rather
than advancing watermarks over unprocessed donors — but it does mean **every
prod restart destroys an open cycle's resume state**, which is worth its own
FIX.)

The dirty set was therefore **reconstructed read-only** from the cycle block's
own bounds (`since_at` 2026-08-20 02:58:40.681855+00, `target_at` 2026-08-24
05:32:17.788383+00), yielding 546,451 donors against the recorded 565,810 — the
3.5% gap is the staging table's `(from_id, from_type)` key versus this query's
`from_id`, i.e. donors present under two `from_type`s. Faithful enough to census.

Cost is measured as `entity_connections.evidence_count`, which is the number of
FR rows behind an edge — so Σ evidence is a direct proxy for the FR rows the
window's `ARRAY_AGG` re-reads, and the edge count is exactly the window's
`DELETE` cost.

| win_idx | driver log | staged donors | EC edges to DELETE | evidence rows | max donor | p99 donor |
|---:|---|---:|---:|---:|---:|---:|
| 0 | window 1/16 | 34,288 | 115,170 | 139,052 | 2,520 | 43 |
| 1 | window 2/16 | 33,978 | 111,878 | 132,197 | 1,206 | 43 |
| 2 | window 3/16 | 33,982 | 116,548 | 138,924 | 1,517 | 47 |
| 3 | window 4/16 | 34,316 | 111,586 | 132,147 | 1,459 | 41 |
| **4** | **window 5/16 ← cancelled** | **34,321** | **75,731** | **93,699** | **912** | **39** |
| 5 | window 6/16 | 34,278 | 84,562 | 106,944 | 1,600 | 44 |
| 6 | window 7/16 | 34,079 | 80,452 | 100,466 | 1,502 | 40 |
| 7 | window 8/16 | 34,197 | 78,882 | 99,311 | 1,919 | 39 |
| 8 | window 9/16 | 34,399 | 75,692 | 93,156 | 1,066 | 39 |
| 9 | window 10/16 | 34,122 | 78,608 | 100,586 | 1,525 | 36 |
| 10 | window 11/16 | 34,063 | 79,089 | 99,890 | 1,173 | 39 |
| 11 | window 12/16 | 33,683 | 79,502 | 100,351 | 1,681 | 40 |
| 12 | window 13/16 | 34,458 | 79,743 | 99,930 | 1,487 | 41 |
| 13 | window 14/16 | 34,165 | 81,240 | 101,499 | 1,421 | 41 |
| 14 | window 15/16 | 33,868 | 77,932 | 98,013 | 1,657 | 40 |
| 15 | window 16/16 | 34,254 | 80,547 | 102,063 | 1,336 | 40 |
| | **total** | **546,451** | **1,407,162** | **1,738,228** | | |

### 11.3 The verdict: shape (iii), and not by a small margin

- **Donor counts are uniform to ±1.1%** (33,683–34,458). UUID v4 spreads
  perfectly across the 16 equal ranges, exactly as the FIX-588/703 design
  assumed.
- **Cost is uniform to 1.5×** (75,692–116,548 edges). There is no cost-weighting
  to recover.
- **There is no mega-fan-out donor anywhere.** The largest single dirty donor in
  any window carries 2,520 evidence rows; p99 is 36–47; the average is 2.7–4.1.
- **Window 5 is the CHEAPEST window in the table by evidence rows** (93,699) and
  second-cheapest by edges. Windows 1–4 — the ones that finished — each did
  **~1.50× the DELETE work and ~1.45× the aggregation work** of the window that
  hung.

Put together: windows 1–4 averaged 1,309 s each on 113,796 edges. Window 5 spent
≥13,740 s on 75,731 edges. **That is ≥10.5× the wall-clock for 0.67× the work —
a ≥15× blowup in cost per unit, inside a run whose per-unit work is flat.**

A cost model cannot produce that. Only table state can.

### 11.4 The mechanism the numbers point at

Each window `DELETE`s its dirty donors' edges and re-`INSERT`s them, then
`COMMIT`s. Across windows 1–4 that is **455,182 deleted tuples** and 556,008
inserted ones, all landing in `entity_connections` with nothing vacuuming
between windows.

`entity_connections` carries `autovacuum_vacuum_scale_factor = 0.05` (FIX-943),
so its autovacuum trigger sits at roughly

```
50 + 0.05 x 9,974,720 reltuples  ~=  498,786 dead tuples
```

The four banked windows generate ~455k dead tuples — **just under the trigger**.
So for the whole of windows 1–4 autovacuum is entitled to do nothing, and by
window 5 the table is either at its worst un-vacuumed state or has *just* tripped
the threshold and is competing for the same starved I/O.

This is the FIX-884 / FIX-943 mechanism one level in: a heap page loses its
all-visible mark if **any** tuple on it is dead, `entity_connections` carries
~26.7 tuples per page, and the window's `DELETE` drives
`entity_connections_from_id_connection_type` — an index whose value is
index-only scanning. Un-mark the heap and every probe becomes a heap fetch.
The rebuild degrades its own read path as it goes, monotonically, which is
precisely a flat-work / rising-time curve that blows up a few windows in.

Note the standing FIX-943 rule does not cover this: it says a script that bulk-
rewrites a table vacuums *what it rewrote, at the end*. This script bulk-rewrites
the same table **sixteen times inside one run**, and the damage is done to
itself, in-flight, long before any tail could run.

Corroborating state, measured 2026-08-25 03:5x UTC (after the 08-24 16:26
restart, so `pg_stat_user_tables` counters are reset and only the `pg_class`
columns — which vacuum writes — are trustworthy):

| table | relpages | relallvisible | % all-visible | reloptions |
|---|---:|---:|---:|---|
| `financial_relationships` | 613,257 | 494,664 | **80.66%** | scale_factor 0.02 |
| `entity_connections` | 373,641 | 373,641 | 100.00% | scale_factor 0.05 |

`entity_connections` is back at 100% because autovacuum repaired it in the ~15 h
after the run. `financial_relationships` at 80.66% with no recorded vacuum is
FIX-1100's separate finding — the killed FEC writer that never paid its tail,
2.5 h before this EC run started reading the table.

### 11.5 Two premises the prompt carried that the data does not support

1. **"Use the `pg_stats` MCV list for `financial_relationships.from_id` to place
   mega-fan-out donors in windows."** The MCV list is useless for this arm. Its
   top five values are all `from_type = 'agency'` with `relationship_type IN
   ('contract','grant')` — 3,087,864 contract + 301,576 grant rows — i.e.
   USASpending awards, which the donations arm's
   `relationship_type IN ('donation','ie_support','ie_oppose')` filter never
   touches. Of the top 30 MCV values, **exactly one** was in the donations dirty
   set (NATIONAL TREASURY EMPLOYEES UNION POLI, 4,266 FR rows, 453 edges). The
   1,965,147-row and 1,063,151-row "donors" the MCV list appears to show are
   agencies with no `financial_entities` row and zero donation edges.

2. **"Window 5 ran 3 h 49 m (556,008 edges, 72% of the run)."** Window 5 wrote
   zero durable edges; 556,008 is windows 1–4's banked total. The run was stopped
   by FIX-1071's outside watchdog (`user request`), not by a statement timeout.

### 11.6 What this changes about the fix

| cc-87 decision | verdict |
|---|---|
| 2 — cost-weighted window bounds computed in `prepare()` | **Drop.** Cost is already uniform to 1.5× and the slow window was the cheapest. Cost-weighting would reshuffle bounds that are not the problem, at the price of a more expensive `prepare()` and a new persisted-bounds contract. |
| 3 — outside per-window budget (FIX-1030 unit-watchdog pattern) | **Keep.** Still a real gap: window 5 ate 13,740 s of an 18,000 s budget on 5.4% of the work, and nothing bounded it below the whole-run level. |
| 4 — bisect the window on cancel | **Drop.** Bisection is the right response to a too-big unit. This unit was not too big; both halves would degrade identically because the cause is table state, not range size. |
| 6 — refuse to start while the FEC bulk writer is live | **Keep and widen.** The 08-24 EC run began 2.5 h after a killed FEC replay left `financial_relationships` bulk-rewritten and un-vacuumed. An advisory-lock probe would not have caught that — the FEC writer was already dead. The condition that matters is "a FEC bulk run is live **or** left `fec_bulk_run_state` behind", the latter being exactly the durable marker FIX-1100 now keys its compensating vacuum on. |
| **new** — vacuum `entity_connections` between windows | **Add.** This is what the census actually indicts. |

The FIX-1101 that follows from this evidence is: an **inter-window vacuum** of
`entity_connections`, a **per-window outside budget**, and the **FEC interlock
widened to the pending-run-state case** — not cost-weighted bounds and not
bisection.

---

## 12. The 2026-08-25 A/B — the inter-window vacuum mechanism is ALSO refuted

Written from cc-prompt-88, whose brief was to build §11.6's prescribed fix after
proving its mechanism on a clone. **The proof failed, so the vacuum was not
shipped.** Recorded in full because, again, the negative result is the useful
part — and because this is the second mechanism in two sessions that survived a
plausible narrative and died on measurement.

### 12.1 The harness

Local full prod clone: `financial_relationships` 10,412,646 rows / 441,234
pages, `entity_connections` 6,985,892 rows / 350,645 pages. Watermark
`W = 2026-08-04 05:00:00+00`, chosen by bisection to stage **565,593 dirty
donors** against prod's recorded `dirty_donors 565,810` on 08-24 — a 0.04%
match, so the arms consume a dirty set of the same size and shape as the run
under investigation.

Both arms drive the **shipped** `rebuild_ec_donations_incr_window()`, one window
per statement, exactly as `run_entity_connections_rebuild()` drives it. Fairness
protocol: each arm begins with a `VACUUM (ANALYZE)` of `entity_connections`
(0 dead tuples, 100% all-visible — the state drain 2 left behind, and the state
a scheduled firing is meant to wake into), and each arm resets only the 16
window watermarks, so `prepare()` resumes the SAME staged rows in 0.1–0.2 s
rather than re-deriving a possibly different dirty set. The windows are
idempotent (DELETE + re-derive from full history), so a re-run is the same
logical work, not a different workload.

**A fidelity correction that mattered.** The first control arm ran with local
defaults and was a null result for the wrong reason: local's autovacuum trigger
is `50 + 0.05 x 6,985,892 ~= 349,345` against ~155k dead tuples per window, so
autovacuum intervenes by window 3 and silently repairs the damage under test.
Prod's trigger is `~= 498,786` against ~113k per window — that is, **prod's
autovacuum was entitled to do nothing for the whole banked run.** The faithful
reproduction is therefore `autovacuum_enabled = false` on `entity_connections`,
which reproduces prod's *effective* state exactly rather than approximating it
with a tuned scale factor. Arm A' and Arm B both run that way. (The flag is
restored unconditionally on process exit and the restore was asserted — FIX-885
is exactly this footgun.)

### 12.2 The result

| | Arm A' — control, no vacuum | Arm B — `VACUUM (ANALYZE)` when dead > 100k |
|---|---|---|
| window 1 | 155,066 edges — **69.5 s** | 155,066 edges — **66.1 s** |
| window 2 | 148,767 edges — **62.8 s** | 148,767 edges — **44.2 s** (+13.6 s vacuum) |
| window 3 | 151,605 edges — **42.4 s** | 151,605 edges — **41.1 s** (+2.8 s vacuum) |
| window 4 | 148,344 edges — **56.0 s** | 148,344 edges — **45.6 s** (+15.0 s vacuum) |
| window 5 | 146,456 edges — **46.7 s** | 146,456 edges — **38.2 s** (+15.4 s vacuum) |
| window time | 277.4 s | 235.2 s |
| vacuum time | 0 s | 46.8 s |
| **total** | **277.4 s** | **282.0 s** |
| window 1 -> 5 ratio | **0.67x** | 0.58x |

Arm A' entered each window with dead tuples at 0 / 155,066 / 303,833 / 455,438 /
603,782 — window 4 entered at **455,438, prod's exact 08-24 level** — and the
arm finished at **750,238, 1.65x prod's accumulation and well past prod's own
trigger.** The window-time curve does not rise. It falls.

**Verdict.** The inter-window vacuum buys ~15% on window time and pays for all
of it in vacuum time: 282.0 s against 277.4 s, i.e. **1.7% slower overall**.
Against a symptom of **>=10.5x** this is not the mechanism, and the
toggle-a-cron-job machinery it would have required — which carries the FIX-885
stranded-flag failure mode — was not shipped.

### 12.3 Why it could never have been the mechanism

The structural argument, which outranks the timings and is the durable lesson:

> **Visibility-map decay can only cost an INDEX-ONLY scan. This arm does not
> contain one.**

Measured plans at the real dirty-set size:

```
aggregation  ->  Nested Loop
                   -> Parallel Index Only Scan on ec_donations_incr_dirty
                   -> Index Scan using financial_relationships_from
                        on financial_relationships
                        Index Cond: (from_type = d.from_type) AND (from_id = d.from_id)

DELETE       ->  a tuple cannot be marked dead without visiting the heap,
                 so no DELETE plan is ever index-only
```

The `financial_relationships` read is a **plain `Index Scan`** — it fetches the
heap tuple unconditionally and never consults the visibility map. That single
line also disposes of the sibling hypothesis this session was asked to test:
FR's 80.66% all-visible, left by the killed FEC replay, **is not an input to
this query's cost.**

And the VM damage that *does* occur is real but **local**, so it cannot
accumulate across windows. Probed mid-run at 455k dead tuples, index-only scan
forced over a fixed range:

| probed from_id range | state | Heap Fetches | time |
|---|---|---:|---:|
| `[00000000..04000000)` | rewritten by window 1 | **108,534** | 156.9 ms |
| `[d0000000..d4000000)` | no window has touched it | **139** | 66.0 ms |

`entity_connections` is physically clustered by `from_id` — the full rebuild
inserts window by window — so each window damages its own neighbourhood and the
next window reads somewhere else. FIX-884's mechanism is real; it does not reach
this workload.

### 12.4 So what did move window 5 — the box, not the arm

Measured 2026-08-25 with **both EC cron jobs `active = f`** and no EC rebuild
running anywhere on prod:

> **prod stalled box-wide 11:00-18:00 UTC.**

`cron.job_run_details`, jobs 40 and 44 (the `*/2` watchdogs, 30 firings/hour):

```
hour   11:00  12:00  13:00  14:00  15:00  16:00  17:00  18:00  19:00
failed 17/30  22/30  25/30  29/30  16/30  12/30  14/30   1/30   0/30
```

Corroborated by two independent instruments: all five of FIX-1066's moved
Tuesday weeklies failed (jobids 25/26/17 at 13:00/14:00/15:00 on `job startup
timeout`; jobids 13 and 12 cancelled at their budgets), and six GitHub Actions
`platform-snapshot` runs were cancelled between 11:36 and 17:28.

**The box enters this state without the EC rebuild.** That is the fact the 08-24
reading could not have. FIX-1101's bullet records jobid 44 failing 24 of 30
firings in the 12:00 hour on 08-24 and reads it as *the six-hour window starving
the watchdog*; the same starvation occurred on 08-25 with the arm paused. Window
5 ran 09:27 -> 13:16 straight through that band.

The most defensible reading of the >=10.5x is that **window 5 was a victim of a
recurring afternoon pathology, not its cause.** The pathology is unattributed —
no cron job and no `data_sync_log` row accounts for the 12:14-16:00 core of the
08-25 stall — and is filed separately. It is not an EC defect.

### 12.5 What shipped instead

Only what survives all of the above:

1. **The per-window outside budget** (default 30 min, overridable at
   `pipeline_state.entity_connections_window_budget`). It survives every
   refutation here **because it does not depend on knowing the cause.** Window 5
   ate 13,740 s of an 18,000 s bound on 5.4% of the work with nothing below the
   run level able to see it; a per-window bound catches that in 30 minutes
   whatever the reason.
2. **The widened FEC interlock**, with its justification restated honestly: not
   FR's visibility map (§12.3), but write contention and a dirty set computed
   against a moving target.

Dropped: cost-weighted bounds (§11), bisect-on-cancel (§11), and now the
inter-window vacuum (§12).

### 12.6 Method note — the instrument that settled it

Two sessions running proposed a mechanism for this arm from *correlational*
evidence: first a big window (§11 refuted it), then a decayed visibility map
(§12 refuted it). What settled both was reading the **plan**, not the counters.

A mechanism that requires an index-only scan is falsifiable in one `EXPLAIN`, in
under a second, before any A/B harness is written. That check belongs at the
START of a FIX-884/FIX-943-shaped diagnosis, not after two arms have run.
