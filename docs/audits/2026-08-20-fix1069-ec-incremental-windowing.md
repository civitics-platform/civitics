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

## 9. Monday readiness — as it now stands

The cycle is **open** on prod with 5 of 16 windows banked. Monday 08-24 08:00
UTC therefore does **not** start fresh: `prepare()` finds the open cycle, reuses
the staging table (no re-stage, no 88 s), skips windows 0–4 instantly, and runs
the remaining 11 at ~707 s each ≈ **2.2 h** — comfortably inside both the 5 h
internal budget and FIX-1071's 18,000 s outside bound. It then closes the cycle
and advances the scalar watermark.

So Monday converges on its own with no further intervention. An optional second
drain (`node scripts/drain-ec-donations.mjs --prod --allow-prod --until HH:MM`)
in any quiet slot before then makes Monday close to instant; it needs ~2.2 h to
finish the cycle outright.

Note the cycle's 7-day guard: `staged_at` is 2026-08-20, so the cycle is valid
through 2026-08-27. Monday is well inside it.
