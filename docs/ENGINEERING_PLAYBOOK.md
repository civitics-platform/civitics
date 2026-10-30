# Engineering Playbook — the operating rules, with their receipts

Distilled from the July–August 2026 FEC/rollup arc (FIX-929 → FIX-974). Every
rule was paid for by a measured incident; each carries the number and the file
that proves it. The depth stays in the cited audits — this is the rule list.

**Normative for new work.** The Stage-1 rebuild and the PR 3 rollup-capacity work
are held against it: a design that violates a rule here needs an argument in its
spec, not silence.

**Receipts are dated measurements, not constants.** Taken on Supabase **Pro
Small** (2 vCPU, 256 MB `shared_buffers`, 6 h `statement_timeout` on the
`postgres` role — **that ceiling is 3 h from 2026-09-16, FIX-1185**, so every
receipt below was taken under the older, looser bound) against a ~10.3M-row
`financial_relationships`. The rules
survive a bigger box; the numbers do not. Re-derive before quoting — rule **E3**.

**Extended 2026-08-09** with the rollup-saturation arc (FIX-995 → FIX-1015): new
rules **C5–C7**, **D6–D8**, **E9–E11**, plus dated addenda on **C2**, **C3**,
**D2**, **D4** and **E3**. Rules are append-only — a correction is appended
beneath the claim it corrects, never edited over it.

**Extended 2026-10-10** with the USASpending arc (FIX-1291, FIX-1274): new rule
**C9**, plus dated addenda on **A1**, **C3**, **C5**, **C6** and **D4**.

**Extended 2026-10-23** with the receipts the root `CLAUDE.md` haircut moved out
(cc-245, FIX-1339). Root keeps each rule as one line; the measurements live here.
New rules **C10** and **C11**, plus dated addenda on **C2**, **C5** and **D3**.

**Extended 2026-10-24** with the receipts the package `CLAUDE.md` haircuts moved
out (cc-246, FIX-1346). Each package file keeps its rule as one line; the
measurements live here. New rule **B4**, plus dated addenda on **C5**, **D1**,
**D7**, **E8** and **E11**.

**Extended 2026-10-26** with the box memory census (cc-251, FIX-1354). New
rule **B5**.

**Extended 2026-10-28** with memory levers 2 + 3 and `[skip vercel]` made real
(cc-252, FIX-1356 / FIX-1357 / FIX-1359). New rules **C12** and **D10**, plus a
dated addendum on **D9** (the caps). D9 item 1's "(D10)" is the spec's D10, not
this file's.

**Extended 2026-10-29** with the first weekly's RETURN (cc-253, FIX-1361 /
FIX-1363). New rule **D11**.

**Extended 2026-10-30** with the second weekly's RETURN (cc-254, FIX-1365).
New rule **D12**.

---

## A. Data-shape regimes

### A1. Trickle and bulk are different regimes. Never run a backlog through the trickle path.

Per-entity incremental is right for a daily dirty set of tens and is the wrong
*shape* for thousands. `refresh_official_donor_rollup_incremental()` measured
**19.0 s/recipient** on prod 2026-08-06; the 9,086-recipient backlog projected to
**~48 h of pure compute**. The same six arms rebuilt set-based over `to_id` ranges
cleared **all 15,316 recipients in 926 s** — one CALL, 32/32 chunks — at **0.060
s/recipient**. Same instance, same night: **~314×**.

**Apply:** size the dirty set before choosing a path. If per-entity needs more
than one scheduled window, build the bulk pass instead of scheduling more windows
(auto-selection is still open — FIX-969).
*FIX-973, FIX-974 · audit `2026-08-07-fix974-bulk-regime.md` §3*

**Addendum — 2026-10-10.** A file NAMED "delta" is still the bulk regime when it
is 1.45 GB: `FY(All)_All_Contracts_Delta_20260924.zip` is five 1M-row CSV parts
(9.9 GB uncompressed), and the pipeline skipped its per-part checkpoint on the
strength of the word. Regime is decided by size and rate, never by the vendor's
label. *FIX-1274, FIX-1291 · `docs/cc/reports/cc-209.md` §4*

### A2. Chunk by key RANGE aligned to the read index — never by entity list.

`to_id = ANY(uuid[])` over scattered uuids is N index descents plus scattered heap
access; a range predicate on the *leading* column of the same index is one dense
walk. `to_id` leads `financial_relationships_donor_rollup_idx`, and moving to
`to_id >= lo AND to_id < hi` took per-row cost **33.0 ms → 0.118 ms**.

**Apply:** per-row cost at **millisecond scale is the amplification signature** —
roughly one random page per row. Check the chunk key against the index the scan
must use before optimising the aggregation. *FIX-974 · audit §2, §3a*

### A3. Publish-swap only when the chunk key differs from the output partition key.

`refresh_treemap_individuals_global()` chunks by donor while its output is
partitioned by **state**, so no chunk is final until all 64 merge — it needs the
swap (FIX-965). The six donor-rollup arms are keyed by `official_id`/`scope_id`,
which *is* the chunk key, so each chunk's output is final: writing straight to the
live arms **halves write volume and dead-tuple load**, and one chunk = one
transaction keeps an official wholly old or wholly new across all six arms.

**Apply:** ask what a chunk's output is final *for*. If that is the table's own
key, skip the swap and say so in the migration comment.
*FIX-974 audit §6 · `20260806000000_fix965_…sql`*

### A4. The chunked-writer skeleton — all six parts, every time.

Each failed at least once when missing (FIX-944, FIX-965, FIX-974):

1. **Group-then-join into UNLOGGED staging** — group FR by donor first, join
   `financial_entities` once per donor, never per FR row. UNLOGGED, in `public`
   so it survives per-chunk `COMMIT`s and session ends.
2. **Cursor advanced INSIDE the chunk transaction** — a cancelled run can never
   claim a chunk it did not commit; it loses at most that chunk.
3. **Predictive between-chunk budget as the ONLY clean stop** — `elapsed +
   slowest × 1.25 > budget` → `status='partial'`, resumable. Overridable by a
   **session-scoped** GUC, so a dead run cannot strand a widened budget into the
   scheduled job.
4. **Chunk failure ABORTS, never skips** — a skipped range silently corrupts a
   global aggregate.
5. **Staleness bound on resume** — crash recovery truncates UNLOGGED tables, so a
   resume finding staging empty restarts at chunk 0; a sweep older than 72 h
   restarts fresh, since merged partials from mixed FR epochs are worse than
   redoing the work.
6. **`VACUUM (ANALYZE)` tail on every table rewritten** — outside the procedure
   (`VACUUM` cannot run in one), driven by the script: 13 s for six arms on prod.

*Drivers: `packages/data/src/scripts/donor-rollup-bulk.ts`,
`treemap-global-sweep.ts` · vacuum rule: root `CLAUDE.md` → Data-state changes*

---

## B. Reads on a small box

### B1. Design heavy read paths to be index-only — and ASSERT the invariant that keeps them there.

Arms 2–6 filter `fr.to_type='official'`, which is not in the index — but across
all **6,457,535** rows in the index's scope there are **0** `to_type='official'`
rows lacking an `officials` row and **0** other-`to_type` rows whose `to_id` is an
official, so resolving official-ness through the target table keeps the scan
index-only. "Equal by coincidence" is a defect class, not a foundation:
`donor_rollup_bulk_assert_invariants()` probes the one arm whose live body lacks
the `from_type` predicate **before any arm is written**.

**Apply:** `INCLUDE` what the aggregation reads, and watch `relallvisible` and
`Heap Fetches`, not just dead-tuple percent — a heap page loses its all-visible
mark if **any** tuple on it is dead, and FIX-884 was 0.9% all-visible → **34,534
heap fetches, 20.5 s of a 22.1 s query**.
*FIX-974 audit §7 · `20260807010000_fix974b_…sql` · FIX-884, FIX-943*

### B2. Do the cache math before the query math.

FR at ~3.5 GB plus a 616 MB rollup index against **256 MB `shared_buffers`**: six
arms each re-scanning the same recipients pinned the backend on `IO/DataFileRead`
for **64+ minutes continuously**, Supavisor intermittently refused connections
(`ECHECKOUTTIMEOUT`), and live PostgREST traffic queued behind it. Warming is
visible once the access pattern is right — 62.5 s/chunk over the first 10, **13.7
s/chunk over the last 22**.

**Apply:** working set vs `shared_buffers` is the first calculation. But note what
this arc settled: the same work on the same box the same night ran ~314× faster on
a different access pattern, so **millisecond-scale per-row cost is evidence about
access pattern, not instance size** (FIX-589 got no support from it).
*FIX-973, FIX-970 · audit `2026-08-06-fix968-cron-window-envelopes.md` §7b*

### B3. A self-warmed EXPLAIN settles nothing.

`EXPLAIN (ANALYZE, BUFFERS)` of arm 1 over 25 real recipients returned in **47 ms**
with `shared hit=11674 read=2` — against a cache warmed by the density query run
immediately before it. It left the cold-cache question exactly where it was. The
measurement that meant something was a whole chunk: `hit=156454 read=12604`,
21.8 s, `Heap Fetches: 22347`.

**Apply:** measure a real unit of work with a known cache state, or state which
one you measured. To time write arms safely on prod, run the real workload in a
transaction ending in `ROLLBACK`. *FIX-973 · FIX-974 audit §3a*

### B4. A render that waits on the database is billed while it waits. Bound every request-path read.

*Added 2026-10-24, moved from `apps/civitics/CLAUDE.md` (cc-246).* Vercel bills
provisioned fluid-compute memory for the **entire** time a function is blocked on
I/O. An unwrapped `await supabase.from(...).select(...)` on a page-render path
against a slow or degraded database makes the render hang and accrue GB-hours
while it waits. It is also the only defense against a low-and-slow crawl that
evades the IP rate limiters, because each request is cheap to send and expensive
to hold. The 2026-06-21 cost-resilience audit named it P0: the sweep wrapped
**178 reads across 27 files** under `apps/civitics/app/**` in
`withDbTimeout(query, 3000, "route:purpose")`, which races the query and returns
`{ data: null, error }` instead of hanging. A degraded database then yields a
fast degraded render, not a slow full one.

**Apply:** bound every render-path read and make every call site survive the
null. A guard that only covers the reads someone remembered is E5's failure, so
`pnpm check:render-timeouts` scans for unwrapped reads in CI. A `revalidate` page
must also call `assertRenderNotDegraded()`, or a timeout-null render gets cached
as the page (FIX-1227). *FIX-638, FIX-639, FIX-1227 ·
`scripts/check-render-timeouts.mjs` · `apps/civitics/src/lib/supabase-check.ts`*

### B5. The box creeps to its swap ceiling under an unchanged workload. Gate on the mirror; expect a foreign reader to finish the wedge.

*Added 2026-10-26 (cc-251).* No job of ours grew between 10-18 and 10-24. The
non-monitor cron wall was 3,754 s on the incident day against 4,070 / 5,037 s on
clean days. Swap still crept from a daily average of 913 MB to 989 MB of the
1,024 MB ceiling, 17 days after the 10-08 restart. By day 13 of that uptime
(10-21), 17 of 63 gate readings sat at ≥ 1,000 MB.

The dispatcher kept arming io- and memory-heavy units into it, because its box
gate measured only the forker (stale probe, fork failures). Supabase's daily
backup forced an immediate checkpoint at 11:21:55Z 10-25, and that finished the
wedge: front door 52× 11:30–13:15Z, then an unclean vendor-side reboot at
13:25:52Z.

After the reboot the floor came back within two hours (183 → ~420 MB of swap).
At least 141 MiB of the 256 MB buffer pool sits in swap, which is the pool's
cold share. MemAvailable on a one-day-old box (median 387 MB) is no better than
on the creep days. **The creep is in swap, not MemAvailable.**

**Apply:**

- The gate reads the on-box mirror (`pipeline_state.box_health_mem`, written by
  the Vercel route). It stands down at `platform_dials.swap_ceiling_mb` (1018,
  the clean-day P95 + 1) and per row at MemAvailable − `cap_mb` <
  `headroom_target_mb` (150). A stale mirror fails open and is counted, because
  the on-box clauses already fail closed.
- A gate cannot stop a reader that is not ours. Until the tier changes, a planned
  quiet-window restart around day 10 of uptime is the lever for the creep.

*FIX-1354, FIX-1125, FIX-589 · `docs/audits/2026-10-25-io-budget-front-door-triage.md`
· `docs/audits/2026-10-26-box-memory-census.md`*

---

## C. Long-running writers

### C1. "What must be ATOMIC?" decides transaction boundaries — not "what belongs together".

The first attempt at the FIX-933 merge held the money move *and* every rollup in
one transaction: ~2 h of sustained write I/O exhausted Pro Small's burst credits —
homepage 18.7 s, `count(*)` on a 31k-row table past 600 s, one rebuild at **66+
minutes against the 10 it took in rehearsal**. The shipped split: money move atomic
at **~12 min**, rollups after `COMMIT`, the rebuild chunked at 5,000 donors — 66+
min became **22 chunks averaging ~33 s**, homepage steady at 0.39 s.

**Apply:** the atomic set is the smallest one whose partial application would be
*wrong*, not the largest one that is conceptually a unit. Everything else is
after-COMMIT work with its own resume granularity keyed off committed state.
*FIX-933 · commits `de656eac`, `e45b9973`*

### C2. Cancellation is never a control path.

Cancelling the client did not stop the work — Postgres does not notice a dropped
connection mid-query; it took `pg_cancel_backend` (FIX-933). Nor is cancelling
free: a cancelled 2400 s treemap CALL on 2026-08-05 wedged the instance, prod
unreachable **~15:50–22:41 UTC** (FIX-965). And `statement_timeout` **arms once at
CALL start** — per-chunk `COMMIT`s do not re-arm it, nor does `SET
statement_timeout` inside a procedure body.

**There are TWO levers, and they do different jobs.** This rule used to say
chunking was the only one; 2026-08-19 falsified that.

- **Chunking is the CONVERGENCE lever** — it makes a killed run keep its
  progress, so the next firing starts from where the last one died. Seven
  pg_cron jobs have been killed by the 6 h ceiling and chunking is the only
  thing that has ever made one finish.
- **The budget watchdog is the BOUNDING lever** — it makes sure nothing runs
  unbounded in the first place. `enforce_cron_job_budgets()` (pg_cron jobid 44)
  is an EXTERNAL watchdog keyed off `cron.job_run_details.job_pid`: it reads
  per-job budgets from a table and `pg_cancel_backend`s any firing that exceeds
  its own. It works — live cancel proof on a 20 s budget, cancelled at 94 s,
  `signaled: true`, and 114/114 clean firings through the 173-minute backfill
  window.

Chunking without a bound still runs forever; a bound without chunking still
loses the run's work. Build both.

**Two traps, both measured — do not re-derive the broken shape:**

1. **You cannot prefix a pg_cron job command with `SET statement_timeout`.**
   pg_cron sends the job command as ONE simple-query message, which Postgres
   wraps in an implicit transaction block, so
   `SET statement_timeout='…'; CALL <proc>` fails *instantly* with "invalid
   transaction termination" for any procedure containing `COMMIT` — and six of
   the seven CALL-shaped jobs contain one. Measured on pg_cron 1.6.4 with
   `use_background_workers = off`, which is prod's setting.
2. **`ALTER FUNCTION … SET statement_timeout` (proconfig) is decorative for this
   purpose.** A function declared with it slept 5 s past a 2 s setting and
   returned normally. It is not a bound.

That leaves the external watchdog as the only mechanism that actually bounds a
scheduled firing, which is why it is a first-class lever and not a nicety.

**Apply:** design the stop you intend (budget → `partial` → resume). Give every
scheduled heavy job BOTH a chunk boundary it can resume from AND a row in the
budget table. If something must be stopped from outside it is
`pg_cancel_backend` on a named backend, deliberately, and the writer must
already survive losing its current chunk.
*FIX-933, FIX-944, FIX-965, FIX-969, FIX-1030, FIX-1056, FIX-1063 · cron audit §8*

**Addendum — 2026-08-08, three instances in one day.** Killing the *client* never
stops the *backend*; Postgres does not notice a dead connection until TCP
keepalives expire. A dead session's diagnostic probe kept scanning
`financial_relationships` for **37 minutes** and contributed to a
connection-refusal outage on an already-starved instance; a cancelled GHA
workflow's Supavisor-pooled backend was still `active` on `INSERT INTO
financial_entities` **15+ minutes** after the run reported `cancelled`.

**Apply:** after cancelling *anything* that writes to prod, re-read
`pg_stat_activity` and terminate what is still there. Guard the terminate on
**identity** — `usename` + `backend_start` + query text, never a bare PID, so a
recycled PID matches zero rows — and issue it over the **direct** connection,
because the session-mode pooler refuses checkouts (`ECHECKOUTTIMEOUT`) exactly
when the pool is the congested resource. `pg_terminate_backend` returning `t`
means the signal was sent, not that the backend died: a backend in
`IO:DataFileRead` exits at its next interrupt check. Re-poll before calling the
box quiet. *FIX-995 investigation, 2026-08-08*

**Addendum — 2026-10-23, the `statement_timeout` receipts (moved from root
`CLAUDE.md`).** The timeout is armed once, by the server, at the start of a
top-level statement, from the GUC value at that moment. A routine-level `SET` —
proconfig, `set_config` in a body, a `SET` after an intra-procedure `COMMIT` —
changes what `current_setting()` reports and nothing else. Measured both
directions on PG 17: it cannot tighten (60 s session, 1 s proconfig — a 3 s
sleep completed) and cannot loosen (2 s session, 30 s proconfig — cancelled at
2.001 s, identically to the same body with no proconfig). Trap 1 above is the
multi-statement shape, not the `SET`: `SELECT 1; CALL <proc>` dies identically,
~10 ms in, zero units run (cc-125). Two more consequences: a routine carrying
**any** `SET` clause runs atomic and cannot `COMMIT`; and once the timeout has
**fired** it is disarmed for the rest of that statement, so a procedure that
catches `query_canceled` and continues runs every remaining unit unbounded
(14.0 s of work under a 4 s bound). `pnpm check:proconfig` fails a migration
that writes the inert form; a deliberate exception carries
`-- fix1128: <reason>` on the line or the line above.

The `postgres` role's in-backend ceiling is **3 h** (FIX-1185; was 6 h), sized
on the **trailing-30-day** window. It is the one timer that DOES arm across
intra-procedure `COMMIT`s, so it backstops what the watchdog cannot: a box that
cannot fork (2026-08-29 — a canceller that must fork cannot bound that failure),
and a watchdog late by more than a budget's slack. It is a DEFAULT, not a cap: a
supervised landing that needs more sets `SET statement_timeout` as its own
statement and says so in its header; a pg_cron job cannot, because its command
must stay single-statement. A per-job budget sits at least one
max-watchdog-lateness under the ceiling (10,800 − 963.8 = 9,836.2 s; the largest
active budget was 9,000), or the ceiling silently demotes the watchdog for that
job and the run ends on a global timer that records nothing job-specific.
**Roll back with `SET statement_timeout = '6h'`, never `RESET`** — a `RESET`
removes the ceiling instead of restoring it.
*FIX-1128, FIX-1185, FIX-1063 · `docs/audits/2026-09-13-fix1128-experiments.md`,
`docs/audits/2026-09-14-fix1128-half2-census.md` §4 ·
`20260916000000_fix1185_postgres_role_statement_timeout_3h.sql`*

### C3. A guard must be able to fire in the case it exists for.

Three guards this arc were silently incapable of firing in their own situation.
`budgeted()` compared elapsed time only *after* the query returned, so it stayed
silent through all **64 minutes** of the worst case (FIX-933). `SHOW
statement_timeout` returns a column *named* `statement_timeout`;
`donor-rollup-sweep.ts` read `.st`, always `undefined`, so its break-glass gate
**always refused to run** — found only when the sweep was needed (FIX-968).
`mark-killed.ts` defaulted to a 4 h lookback against a 350-min job cap, so the
backstop no-op'd exactly on the longest run (FIX-962).

**Apply:** exercise every guard in its failure case at least once, and prefer
server-owned ceilings to client-side arithmetic — FIX-933's fix was a per-step
`statement_timeout` translating 57014 into a named `BudgetExceeded`.

**Addendum — the fourth guard, FIX-1002.** The donor-rollup predictive budget
guard is evaluated only *between* chunks (`IF v_chunk_no > 0 AND …`), so a run
whose **first** chunk exceeds the whole window never evaluates it once. Run 195
on 2026-08-08 ran **6h00m06s**, was killed by the 6 h role `statement_timeout`,
committed **zero** chunks, and served the public site statement timeouts and 503s
throughout — with the guard silent the entire time. Its chunk 1 was 50 recipients
against a slowest-ever chunk of 5,447 s recorded three hours earlier.

**Apply, sharpened:** ask *which iteration* a guard first becomes capable of
firing on. "After the first unit of work" is a blind spot whenever one unit can
be the whole budget — arm it from iteration 1 off a **durable cross-run** worst
case rather than one seeded inside the run. *FIX-1002 · commit `b31c6029`*

**Addendum — 2026-10-10, the FIX-962 guard no-op'd on the longest run AGAIN.**
`usaspending-bulk.yml` still passed mark-killed no `--window-hours` (default 4 h
against its 350-min cap) two months after FIX-962 named exactly that failure — and
by the time the step ran, the 10-08 contracts row was not `running` anyway: the
nightly's age-only `reap_stale_sync_log(60)` had flipped it to `reaped` at
21:00:54Z while its GHA process ran on to 23:04:58Z. mark-killed treated only
`running` as an orphan, so the run that saturated the box for six hours left no
kill marker at all. Two detectors, each blind to the state the other leaves.

**Apply:** a detector is sized on the job's CAP (the workflow now passes
`--window-hours 6`), and it must recognise the states the OTHER detectors leave
behind — a `reaped` row is an orphan (marked `reaped_first`). And an age-only
reaper kills a live run that spans the nightly: a writer that can run past 60
minutes stamps `metadata.heartbeat_at`, and `reap_stale_sync_log()` reads the
heartbeat before `started_at`. *FIX-1291 · `20261010050000_fix1291_…sql` ·
`packages/data/src/scripts/mark-killed.ts`*

### C4. Runtime measurements are floors. Design to survive the miss.

`refresh_homepage_stats_mv()` takes 0.7 s on local and ran **22 minutes** against
an otherwise-idle prod; the FIX-968 audit's own drain projection was **wrong by
~15×**. The direction is not even reliably one way — a `VACUUM` on FR is minutes
on prod and **>17 min on local Docker**.

**Apply:** never let a projection be the only thing between a run and an unbounded
window. Resumability plus a budget is what makes a wrong estimate cheap.
*FIX-933, FIX-943 · cron audit §5 vs §7b*

### C5. A bulk rewriter needs a NAMED vacuum owner at a layer that can issue `VACUUM` — and "owned" must mean "owned by something that runs".

The root `CLAUDE.md` rule says a bulk rewriter ends by vacuuming what it rewrote.
This is the part that keeps being missed: **a pg_cron procedure cannot be that
owner** — `VACUUM` cannot run inside a function or a transaction block, and a
plpgsql body is always inside one, even immediately after a `COMMIT`. So the
owner is a script tail or a separate scheduled `VACUUM` job, never the writer
itself. Six donor-rollup arms rewritten twice daily by `DELETE`+`INSERT` had
neither: last autovacuum 2026-08-02, by 08-08 reading 19.9 / 18.6 / 18.6% dead at
73.7 / 32.5 / 31.7% all-visible, and per-recipient cost over that same window went
**3.06 s → ~108 s** — the site-down run. A manual `VACUUM (ANALYZE)` of all six
took **8.4 s** and returned every one to 100% all-visible. The control is in the
same neighbourhood: `donor_party_rollup_mv`, the one arm-adjacent table that
already had a scheduled vacuum job, sat at **0.0% dead** throughout.

**"Owned" is a claim about the schedule, not the code.** FIX-975's census recorded
`financial_relationships` as **96.8% OWNED** — truthfully, against
`donor_rollup_rebuild_bulk()`'s vacuum tail. But cron jobid 24 does not call that
procedure (getting it called is what FIX-1004 was still open to do), so the owner
was a code path nothing scheduled. Measured after the 2026-08-09 `fec-backfill`
dispatch: prod carries **nine** `VACUUM (ANALYZE)` cron jobs and FR is not among
them; FR's `last_vacuum` read 2026-08-06 00:56:29 — three days stale and
predating the run entirely — while `financial_entities`, which does have a
scheduled job, was vacuumed 26 s before the pipeline closed.

**Staging tables count.** `donor_rollup_rebuild_bulk()`'s four persistent
`_drb_*` staging tables have never had a manual `VACUUM` (`last_vacuum` NULL on
all four), and `_drb_fe` at **35,118 pages** is larger than four of the six arms.
They read clean only because the bulk path last ran two days earlier.

**Counter-caution — do not over-tune.** `financial_relationships` tripped its own
autovacuum two hours into a bulk ingest and then split I/O with it. An aggressive
scale factor on a table under sustained bulk write buys a mid-write vacuum, not a
clean one; prefer an unconditional scheduled job **after** the write window.
Prefer the cron job over a pipeline tail for the same reason a tail is weaker:
`fec-backfill.yml` can be SIGTERM'd at its 350-min cap and the nightly at its
150-min cap, and a tail that does not run on the kill path is not an owner.

**Apply:** name the owner and the schedule in the same PR as the writer, and
check `pg_stat_user_tables.last_vacuum` against the writer's last run before
believing any census. See A4.6 for the tail as part of the writer skeleton, D7
for choosing the autovacuum lever.
*FIX-1003, FIX-1005, FIX-1013, FIX-975, FIX-943, FIX-884 · `supabase/tests/verify_fix1003.sql`*

**Addendum — 2026-10-10, "named owner" and "the tail" are reconciled by TIMING.**
A USASpending landing writes three tables. `financial_relationships` and
`financial_entities` have daily scheduled owners (`fr-vacuum-analyze` 03:00Z,
`fe-vacuum-analyze` 04:50Z — `docs/receipts/2026-10-10.md` §2), and a script
`VACUUM` of FR on prod is FIX-1133's front-door incident (the script banners cite it as FIX-1144).
`external_source_refs` has NO owner — 580k rows, last autovacuum 2026-09-29
(FIX-1291's reading). So the pipeline's tail vacuums ONLY the table nobody owns
(`VACUUM (ANALYZE) external_source_refs` when a category completes), and the
supervised catch-up is SCHEDULED to end before the owners fire for the rest.

**Apply:** before writing a tail, read the vacuum schedule by table. Vacuum what
has no owner; for what has one, end the landing before it runs and say so in the
runbook. An ownerless table touched by a bulk writer is a filing, not a tail
forever (FIX-1299 files the weekly `xsr-vacuum-analyze` job). *FIX-1291,
FIX-1274, FIX-1133, FIX-1191 · `packages/data/src/pipelines/usaspending-bulk/index.ts`
(`vacuumExternalSourceRefs`)*

**Addendum — 2026-10-23, why the tail is not optional (moved from root
`CLAUDE.md`).** Autovacuum tuning narrows the window but never closes it: the
trigger is `autovacuum_vacuum_threshold + scale_factor × reltuples`, so a table
is always allowed a floor of dead tuples first — on `financial_relationships`
still **~164k** after the FIX-943 tuning — and a bulk rewrite lands its whole
load inside that window at once. The FIX-930 audit went from **~8 min to blowing
a 600 s `statement_timeout`** purely on the FIX-933 merge's ~260k dead tuples,
and completed again after a vacuum. The four-day `donor-rollup-refresh` failure
(FIX-944) cleared only because the FIX-933 merge script happened to carry a
vacuum tail; nothing scheduled one. So verify `pg_stat_user_tables.last_vacuum`
before treating a post-rewrite timing regression as a query problem, and never
"fix" one by raising the timeout. The daily canary reports the cause
(`bloat_degraded`, report-only) and escalates on the consequence (`vm_degraded`)
via `check_rebuild_autovacuum_status()`. *FIX-943, FIX-930, FIX-933, FIX-944*

**Addendum — 2026-10-24, sizing an ad-hoc vacuum (moved from
`packages/db/CLAUDE.md`).** A scheduled vacuum's runtimes measure the **steady
state**, not a catch-up, and the two are not the same order of magnitude. jobid 38
`fr-vacuum-analyze` was cheap (227.2 s / 20.3 s / 97.8 s over three firings)
*precisely because* it ran weekly and never had much to do. Sizing an ad-hoc run
from those numbers put **8 front-door statement timeouts through prod in 16
minutes** on 2026-09-01. On `financial_relationships` the heap was not the cost:
the heap phase finished 631,265 blocks in about 115 s, and the remaining **560 s
was the index phase**, which is proportional to index bytes × index count —
every pass sweeps all of them in full, on a box with 256 MB of `shared_buffers`.
A **cancelled VACUUM banks nothing**: `vacuum_count`, `last_vacuum` and
`n_dead_tup` are unchanged and the next attempt restarts from the top. And the
index count is a first-class cost you cannot assume is reducible: the census of
all 19 FR indexes found exactly one droppable (8 kB, a UNIQUE partial over a
column with zero non-NULL rows); 1,091 MB of apparent slack was a PRIMARY KEY plus
a live `ON CONFLICT` arbiter, both invisible to `idx_scan`.

**Apply:** size an ad-hoc vacuum from `n_dead_tup` and the index footprint,
never from `cron.job_run_details`, and budget a bulk rewrite of FR for its
tens-of-minutes, front-door-visible tail. Classify indexes by **role first,
callers second, counters last**, and check the stats window before believing a
zero: `pg_stat_database.stats_reset` reads NULL both when stats were never reset
and when a crash discarded them — triangulate against
`pg_stat_statements_info.stats_reset` and an insert-only table's `n_tup_ins`.
*FIX-1133 · `docs/audits/fr-index-census-2026-09.md`*

### C6. When resume is hard, price a full replay's no-op fraction before designing a cursor.

A content-keyed resume cursor for the FEC indiv ingest was **proven
non-convergent** before it was built: the sort key must be the conflict arbiter
(`donor_fingerprint`, or `(from_id, to_id)`) to survive a republish, and those key
spaces are effectively random with respect to newness — so a republished superset
almost always adds rows *below* the cursor, the below-cursor slice is always
re-run, and the re-run slice **is** all the progress the cursor bought. Net saving
on a mid-file cursor: zero. What dissolved the problem instead was making the
replay cheap: `ON CONFLICT … DO UPDATE SET … WHERE (any SET column IS DISTINCT
FROM EXCLUDED)` on a re-ingest measured **0.5–6.3% new rows**, i.e. ~95% no-op,
came in at **5.39×** on `financial_relationships` (1.735 → 0.322 ms/row) and
**3.18×** on `financial_entities` (0.344 → 0.108 ms/row), with `rows_written = 0`
on every skip slice. **342.6 min** of projected writer work against a 350-min cap
became ~123 min — and the cursor's original motivation went with it.

Two constraints the measurement fixed in place. The skip predicate must cover
**exactly** the `SET` list, never a caller-chosen subset — a `SET` column outside
the predicate changes silently. And an unchanged row returns no `RETURNING` row,
so any caller that needed those ids must re-read them on the same connection.

**Apply:** before designing resume state, measure what fraction of a full replay
is a no-op and what an idempotent no-op costs. A cheap replay beats a correct
cursor, and it beats an incorrect one by more. Watch for the sibling trap: an
existence probe over already-present keys finds rows that are ABSENT but is blind
to rows PRESENT WITH A CHANGED VALUE, so it silently drops real updates.
*FIX-1008, FIX-1010, FIX-999 · `packages/data/src/lib/direct-pg-upsert.ts`*

**Addendum — 2026-10-10, a rule proven on one writer is not a rule in every
writer.** The skip predicate above was measured at **5.39×** on
`financial_relationships` for the FEC replay — and
`usaspending-bulk/writer.ts`'s FR `bulkUpsert` never passed it. The 10-08 delta
run and every resumed part re-sent rows already landed, and each conflicting
row was rewritten in full: 0 % HOT (C7), every FR index and a dead tuple per
row. FIX-1274 adds `skipUnchangedRows: true`; the helper's predicate is built
from the `SET` list, so all 11 updated columns are compared.

**Apply, sharpened:** census every call site for the predicate whenever it is
proven on one (`grep -rn "bulkUpsert(" packages/data/src/`). As of 2026-10-10,
the `DO UPDATE` sites that pass neither `skipUnchangedRows` nor
`updateOnlyIfSame`: `fec-bulk/writer.ts` pac-entity (`financial_entities`,
`updateColumns` scoped) and ie-spender-name (`financial_entities` — its
RETURNING feeds an id map, so a skip needs the C6 re-read), the
`small_dollar_bracket_rollup` write (`fec-bulk/writer.ts` ~1685), and both
`littlesis/writer.ts` upserts (`external_relationships`,
`external_relationships_review_queue`). The FR sites — four in fec-bulk, one
in usaspending — all skip now. *FIX-1274, FIX-1291 · cc-214 rehearsal audit
`2026-10-10-usaspending-resumable-rehearsal.md` (run E is the receipt; cc-215
adds prod's)*

**Receipt — 2026-10-10, the rehearsal's run E** (`docs/audits/2026-10-10-usaspending-resumable-rehearsal.md` §5):
a re-run of a completed 60k-row slice of the 09-24 delta sent **42,883** rows and
changed **4,687** — FR `n_tup_ins` +0, `n_tup_upd` +4,687, HOT 0 — so **89.1 %** of
the rewrite was avoided. The residue is the file's own churn, not the predicate:
`contract_award_unique_key` is an AWARD key, and 1,299 keys carry 6,974
transactions that rewrite one row each, last write wins (FIX-1298).

### C7. Every index is a write cost — and indexing a column a trigger always changes makes HOT impossible by construction.

`financial_relationships` takes **exactly zero** HOT updates —
`n_tup_upd 4,911,666 / n_tup_hot_upd 0` — because an unpredicated 159 MB btree
indexes `updated_at`, the column the `set_updated_at()` BEFORE UPDATE trigger
changes on every update. HOT requires that no indexed column change, so that one
index makes it unreachable and every upsert rewrites all **16 indexes
(4,855 MB)** and leaves a dead tuple. `financial_entities` carries the same
trigger but does *not* index `updated_at`, and gets **27.06%** HOT. A non-HOT
update also writes an entry into every index whether or not its columns changed:
five `financial_entities` indexes read `idx_scan = 0` over the full post-cutover
window — **310 MB across 5 of 19** — and are still maintained on 840,338 upserts
per cycle at ~73% non-HOT.

**Apply:** treat the index list as part of the write path's cost, and check
`n_tup_hot_upd` before optimising anything else about an upsert. But do **not**
batch-drop on `idx_scan = 0` alone — a zero-scan index can be a uniqueness
constraint, an `ON CONFLICT` arbiter, or serving a route that has not run since
the counters started. `financial_relationships_usaspending_unique` is 485 MB at
`idx_scan = 0` and must stay: it is the conflict arbiter for a
manual-dispatch-only pipeline (FIX-740). Expression indexes over a rewritten
`jsonb` column are the worst of both — re-evaluated per write *and* a HOT blocker.
*FIX-1008, FIX-1012, FIX-884*

### C8. A guard that fires must PROPAGATE. Catching an abort and returning normally converts a safety stop into a no-op.

C3 asks whether a guard *can* fire. This is the next question: what happens
after it does. `merge-same-person-official-dupes.ts` had a correct, server-owned
budget guard — `budgeted()` translating 57014 into a named `BudgetExceeded` — and
`runRollups()` caught it, printed **"✗ PHASE 2 ABORTED — … stopping before the
remaining work makes it worse"**, and then `return`ed normally. `main()`'s next
line was an unconditional `await runMvsAndVacuum(client)`.

So on the FIX-953 prod apply (2026-08-10 ~23:10 UTC) the guard fired exactly as
designed at `refresh_treemap_individuals_global()` chunk 53/64 — and the script
proceeded straight into phase 3, the **heaviest I/O in the whole run**, against
the instance it had just diagnosed as degraded. The six MV refreshes ran at
**25–70× their local timings** (`refresh_official_homepage_stats_mv` 326.2 s vs
4.7 s local; `refresh_chord_industry_flows_mv` 205.1 s vs 20.3 s). Prod went
fully unresponsive — pooler `ECHECKOUTTIMEOUT`, effectively every PostgREST GET
returning Cloudflare 522 for 30+ minutes — and needed a manual project reset
(`pg_postmaster_start_time()` = 2026-08-11 01:08:19 UTC).

The abort message was the tell and nobody could act on it: it told the operator
the run had stopped at the precise moment the run was accelerating. A guard whose
only effect is a log line is decoration.

**Apply:** a caught abort must change what the caller *does*, not only what it
prints. Return a status (or rethrow) and branch on it; skip every remaining stage
whose cost the abort just declared unaffordable; and exit **non-zero** (FIX-1017
uses `2`, distinct from `1`, so a wrapper can tell a deliberate safety stop from
a crash and neither reads as clean). Then check the skipped stages against C5 —
skipping is only free for work that has another owner that runs. Phase 3's MV
refreshes are also refreshed by `refresh_derived_mvs('daily')`, so skipping them
costs nothing; its `VACUUM` tail is **not** covered, so the abort message has to
name it as outstanding and point at `--vacuum-only`. *FIX-1017, FIX-953*

### C9. A prod-writing pipeline is VISIBLE to the interlock, or it does not run on prod.

`prod_session_state()`'s writers-live list is 19 advisory locks plus the
nightly's `running` rows; the `cron_job_budget` watchdog is keyed by
`cron.job.jobname`. A GHA direct-pg writer holds neither. So on 2026-10-08 the
USASpending dispatch wrote `financial_relationships` for **5 h 52 m** — three
of the 2026-09-24 delta's five 1M-row parts in 2 h 04 m, then silence to the
350-min cap — and nothing on the box could see it or bound it: **131** pg_cron
startup timeouts, `fe-crawl` budget-cancelled, the nightly's fec-phase
`partial`. It took no claim, read no box gate, had no wall dial, checkpointed
nothing (delta mode never did — "deltas are small, a killed delta simply
reprocesses" was false for a 1.45 GB delta), and rewrote every conflicting FR
row (C6).

**Apply:**

- a SUPERVISED run takes the FIX-950 claim (`runUnderProdSession`) — then the
  nightly's writer blocks, the guarded procedures and an unattended dispatch all
  see it;
- an UNATTENDED run preflights `prod_session_state()` and writes `skipped`
  (`prod session held: …`) when a session is held. It claims only as a
  DECLARED SELF-EXEMPT writer — `exemptWriters: ['nightly_cron:<phase>']`,
  recorded in the label as `exempt_writers` — and never with `force`. The
  exemption names its own FIX-462 `running` row and nothing else; without it a
  scheduled job holding the interlock is a nightly refusing itself (rule 169).
  A refused claim still writes `skipped`. The nightly's `fec_bulk` writer is
  that claimant since FIX-1310 (cc-225);
- a claimant killed by its job cap (SIGTERM — `sync-log.ts` re-kills, so
  `withProdSession`'s `finally` never runs) or by SIGKILL drops its advisory
  lock with its backend but LEAVES ITS HOLD ROWS. Today's net is the next
  claimant's leftover-hold sweep (it runs first, even on a refused claim, and
  logs what it swept) and, until then, `canary-prod-session`'s
  `prod_session_hold_stale` report. The nightly is the first claimant killed
  on a schedule (FIX-1100's Sunday overruns); a kill-path sweep is N2's
  (cc-225 finding 1, decided cc-227);
- every multi-unit landing checkpoints per unit IN EVERY MODE, so a stop is
  resumable;
- it reads the box gate (`box_backoff_gate`) at unit boundaries, as the pg_cron
  rollups do — and since the gate's memory half is report-only (FIX-1125), a
  wall dial (`--max-minutes`) is the memory stop until it isn't;
- a long writer heartbeats its `data_sync_log` row, so the reaper (C3 addendum)
  can tell a live run from an orphan.

*FIX-1291, FIX-1274 · `docs/audits/2026-10-04-fix1274-usaspending-delta-read.md`,
`docs/cc/reports/cc-209.md` §4, the cc-214 rehearsal audit
(`2026-10-10-usaspending-resumable-rehearsal.md`) · `packages/data/src/scripts/usaspending-bulk.ts`
· FIX-1310 `packages/data/src/pipelines/index.ts` (the nightly's claim)*

### C10. A manifest-scoped remediation must not carry a platform-scoped tail.

Every step in a remediation script's tail either SCALES WITH THE MANIFEST or HAS
A SCHEDULED OWNER. Anything that is neither is a bug in the script, not a cost of
the change. Measured on prod 2026-09-07, the FIX-954 set-2 apply — a **28-row**
manifest: the delete plus all three manifest-scoped rollups took **78 s**
(`donor_rollup_rebuild_recipients` 28.8 s / 2 officials,
`financial_entity_donation_totals_rebuild` 15.3 s / 28 donors,
`donor_party_rollup_rebuild_donors` 33.8 s). The script then entered
`rebuild_financial_entity_ie_totals()` — platform-scoped, its cost independent of
the manifest — and was cancelled by hand **28 minutes** in. Front-door damage
over that one step, by SQLSTATE from the Logs API: **70 × 57014** plus
13 × `08006` and 6 × `08P01`, against a baseline of **1 × 57014** in the
equivalent window earlier the same day. The conservation phase before it cost
another 132: **202 cancellations, ~70× baseline**, the rate highest during the
global rebuild. With everything stopped, the next 15-minute window measured zero.

**A step's presence in a tail is not evidence it has an owner.** FIX-688 moved
the EC rebuild to pg_cron and left `refresh_group_donor_rollup()` with no
scheduled owner at all — its only non-script caller sits in a workflow that
became `workflow_dispatch`-only. It had been re-derived purely as a side effect
of remediation tails, and nobody had noticed. `--defer-tails` shipped covering
the VACUUM, search index and treemap; the six MV refreshes and then these two
global rebuilds each had to be added after a prod run found them.

**Apply:** check each tail step's owner by NAME in three places:
`cron.job.command`, `pg_proc.prosrc` (a job may CALL a procedure that calls it)
and the GHA workflows. `--defer-tails` must cover every ownerless or
platform-scoped step, and the dry run prints each step's cost class —
manifest-scoped, platform-scoped-with-owner, platform-scoped-orphan — so the
trade is visible before the go-ahead rather than at minute 28. Reviewer's test: a
step whose runtime does not move when the manifest goes from 28 rows to 2,736 is
platform-scoped by definition.
*FIX-1165, FIX-954, FIX-688 · `20260908000000_fix1165_group_donor_rollup_owner.sql`*

### C11. Every `updated_at` watermark clamps to `watermark_horizon()` — and a landing held longer than the lag rewinds the watermarks.

`financial_relationships.updated_at` (and `votes.updated_at`,
`entity_connections.derived_at`) is stamped `NOW()` — when the writing
transaction BEGAN, not when it committed. Every incremental rollup takes
`dirty = updated_at > watermark`, so a transaction that starts before a rollup's
watermark read and commits after it leaves rows stamped *below* the new watermark
that were invisible at read time. Nothing ever picks them up again. FIX-983
closes the routine case with a head-lag horizon: no watermark may advance past
`clock_timestamp() - civitics.watermark_lag_seconds` (default 3600), so ordinary
writers are safe by construction.

**Apply:** every `updated_at` watermark reader/writer clamps to
`public.watermark_horizon()` — not `NOW()`, not a bare `MAX(updated_at)` — bounds
its dirty set above by the clamped target (`updated_at <= target`), and when the
clamped target is at or below the current watermark logs a `complete` cycle with
rows=0 and leaves the watermark alone. Writing it would move it BACKWARDS, and a
non-`complete` status freezes the freshness clock (FIX-1140).
`fr_watermark_horizon()` survives as a one-line wrapper so FIX-983's thirteen
proven call sites need no churn; use the canonical name for anything new. The
votes arm (`entity_connections_votes`) was the last holdout (FIX-1139).

**A supervised landing that holds one transaction longer than the lag is outside
the guarantee.** The FIX-933 money move (C1) held ~12 min atomic — inside 1 h,
so covered — but the shape scales with the landing, not the lag. Such a landing
either rewinds every FR-keyed watermark to its own transaction start before
committing, or runs with the incremental consumers paused. If its duration is
known in advance, raising the GUC for the session that drives the consumers costs
only staleness. Batch-committing writers need nothing. The keys, all in
`pipeline_state`: `financial_entity_totals_watermark`,
`donor_party_rollup_watermark`, `donor_rollup_watermark`,
`entity_connections_donations` (its scalar `last_indexed_at` **and** all sixteen
`windows` entries), `agency_staffing_watermark` (`fr_last_indexed_at`). The EC
donations arm is already covered by the FIX-1101 interlock, which defers its
cycle while a FEC bulk run is pending or in flight; every other consumer is not.
FIX-1074 is the broader convention this sits under: a landing owns the *derived*
work its rewrite creates, not just the watermark correctness of it.
*FIX-983, FIX-1074, FIX-1139, FIX-1140, FIX-1101, FIX-933 ·
`20260903010000_fix983_fr_watermark_horizon.sql`,
`20260905000100_fix1139_votes_watermark_horizon.sql`*

### C12. A role setting is a LOGIN default — set it on the role that logs in, and read it from a session that started after it.

`ALTER ROLE r IN DATABASE postgres SET p = v` writes `pg_db_role_setting`; a
backend applies it once, at login, and never again. Three consequences, each
measured on 2026-10-28 (FIX-1356):
1. **The login role is the row that matters.** PostgREST logs in as
   `authenticator` and `SET ROLE`s to `anon` / `authenticated` /
   `service_role` per request, so a planner or memory GUC for the request path
   goes on `authenticator`. A row on `anon` would be inert for it. pg_cron
   units are fresh `postgres` logins (`cron.use_background_workers = off`), so
   `postgres` covers every dispatched unit, gated push and ad-hoc read.
2. **A "new" session may be an old backend.** Supavisor's session pooler hands
   back warm backends. After the push, two `db-query --prod` sessions landed
   on backends started at 01:22:09Z and 01:22:52.77Z, before the 01:22:53Z
   commit, and read the OLD `hash_mem_multiplier 2`. Only a third, concurrent
   one reached a backend started at 01:23:27Z (`reset_val 1`, source
   `database user`). Print `backend_start` beside every such read; the catalog
   row is the authoritative statement of what new sessions get.
3. **Who may set it is decided by the GUC's context, not a list.** On
   Supabase `postgres` is not a superuser. A USERSET parameter (`work_mem`,
   `hash_mem_multiplier`, `max_parallel_workers_per_gather`) can be set on any
   role `postgres` administers (itself; `authenticator` via ADMIN OPTION, a
   modifiable reserved role in supautils). `supautils.privileged_role_allowed_configs`
   governs SUSET parameters, and a placeholder such as `civitics.*` needs an
   explicit SET grant (fix1316's failure). `has_parameter_privilege(…, 'SET')`
   reads only `pg_parameter_acl` grants, so it returned **f** for `work_mem`,
   whose ALTER ROLE had landed. Rehearse the statement itself on the clone
   instead.

**Apply:** a GUC for the request path goes on `authenticator`, one for jobs on
`postgres`. Its read-back is the catalog plus a session whose `backend_start`
postdates the commit. The revert restores the exact prior array: RESET where
there was no entry, SET where there was one.
*FIX-1356 · `20261028000000_fix1356_parallel_zero_hash_mem_one.sql` · cc-252*

---

## D. Scheduled work

> **Between 2026-10-13 and each job's return, the derived layer is parked;
> the registry is the only way back.** FIX-1311 / cc-232 set the 18
> derived-layer pg_cron jobs (the crawls, the money rollups, the taggers, the
> derived MVs, the reconcile and orphan sweeps) to `active = false` by name.
> Each has a FIX-1059 hold row. Only the plumbing stays on: the probe, the two
> watchdogs, the vacuums, the retention jobs and platform counts. Never
> re-activate a parked job with `cron.alter_job`. Each job comes back through a
> `job_registry` row with a deadline rule, read on its first dispatched firing.
> The lists and the return order are in `docs/cc/projects/dispatcher.md` s16.

### D1. A pg_cron firing can be dropped silently — assume it, and back it up.

With `cron.use_background_workers = off`, pg_cron opens a fresh libpq connection
to localhost per firing with a fixed **~10 s window**; under sustained load from
any source that setup blows the window and the firing is **abandoned entirely** —
no queue, no retry, nothing written but one `cron.job_run_details` row. Observed
events bottom out at **10.1 s** across seven jobs and five clock slots, from three
independent load sources, so rehoming a job only relocates its exposure. Cost of
three dropped firings of one job: **3,401 of 6,770** officials carried a wrong
`official_donor_totals` row — 2,446 had **no row at all** — understating
**$2,079,909,441**, with Donald Trump reading **$500** against $42,292,553 live.

**Apply:** add a same-day backstop firing (nearly free when the procedure is
watermark-gated — 8 of 23 retained runs finished in ≤0.1 s on an empty dirty set)
and a health read of `cron.job_run_details`. `check_cron_job_health()` is the
pattern: SECURITY DEFINER owned by `postgres`, because `service_role` holds the
table grants but **not** `USAGE` on schema `cron`.
*FIX-968 · cron audit §1, §4, §5 · `20260806010000_fix968_…sql`*

**Addendum — 2026-10-24, the same holds for a GitHub schedule, worse (moved
from `packages/db/CLAUDE.md`).** A GHA `schedule:` has no delivery guarantee:
GitHub drops scheduled runs under load. `*/10 * * * *` was measured firing **8
times in 51 hours** (mean ~6.4 h, shortest gap 3.2 h, 2026-08-29), after drifting
to 1–3.5 h gaps in May — so a 4 h staleness threshold existed purely to absorb a
tick that claimed to be ten minutes. The cron expression is not evidence of
anything; the observed run history is. The opposite fix is wrong too: driving a
sub-daily HTTP tick from pg_cron curling the route couples the tick to the health
of the database it reports on, and the dashboard matters most when that database
is in distress.

**Apply:** a sub-daily tick goes on a Vercel cron (`platform-snapshot` is `*/30`
in `apps/civitics/vercel.json`) and its consumers' staleness thresholds move WITH
the cron expression. pg_cron is right for in-database work, not for watching the
platform. *FIX-1127, FIX-327, FIX-1120 · `apps/civitics/src/lib/snapshot-freshness.ts`*

### D2. `cron.job_run_details` is the record. `data_sync_log` lies twice.

**A `reaped_orphan` span is not a runtime** — it is `started_at` → *when the
reaper ran*. FIX-944 reported four failing runs as 20h15m / 20h22m / 20h09m /
4h22m and built a causal story on it ("the nightly reaps the still-running
rollup"). `cron.job_run_details` shows **6h08m / 6h00m / 6h00m / 6h00m**, all dying
~15:00 on the 6 h `statement_timeout` — **already dead ~14 hours before the
nightly that supposedly reaped them**; the story, and the FIX-950 framing citing
it, were falsified. **A `running` row is not liveness** either: orphan rows outlive
dead processes, and GHA-launched pipelines have no second source — no run
identifier is recorded, so `GITHUB_RUN_ID` cannot be joined after the fact.

**Apply:** `cron.job_run_details` is authoritative for pg_cron work, the GHA API
for workflow work; liveness comes from `pg_stat_activity`, never a status column.
*FIX-944, FIX-971 (open) · cron audit §6b*

**Addendum — liveness, outcome and progress are THREE questions with three
sources.** The rule above separates the first two. 2026-08-08 established the
third as independent of both: jobid 24 run 195 read `failed` in
`cron.job_run_details` after six hours — and had committed **zero** chunks.
`pipeline_state.donor_rollup_watermark.updated_at` still held 12:28:38, the cursor
written by the *previous* run. A `failed` outcome is equally consistent with
"did 95% and died", and nothing in the outcome record distinguishes them.

| question | source | what it is NOT |
|---|---|---|
| is it alive **now**? | `pg_stat_activity` | a `running` status row — orphans outlive processes (D2) |
| how did it **end**? | `cron.job_run_details`, GHA API | a `data_sync_log` span — `reaped_orphan` is not a runtime (D2) |
| how far did it **get**? | `pipeline_state` cursor / watermark | the outcome — `failed` says nothing about durable progress |

**Apply:** name the question before picking the source. Any post-mortem that
concludes "it failed" without reading the cursor has not established whether the
work needs redoing. Corollary from E7: the cursor's own `updated_at` must be
`clock_timestamp()` or it will misreport progress by one chunk.
*FIX-1002, FIX-1007 · 2026-08-08*

### D3. Reference cron jobs by NAME. Alter in place.

Ids get misrecorded — the FIX-968 bullet named jobid 34; there is no jobid 34, it
is **24**. And `cron.unschedule` + `cron.schedule` mints a **new jobid** (measured
on local: 24 → 42) while `cron.job_run_details` is keyed by jobid: in the FIX-968
migration that would have orphaned the very `job startup timeout` rows that
diagnosed the bug *and* made the new `check_cron_job_health()` report
`missing_daily` on deploy day — a false positive from the detector shipped in the
same migration.

**Apply:** look the job up by `jobname`, then `cron.alter_job(job_id := …)` — it
keeps the id, the history and the detector's continuity, and is still idempotent.
*FIX-968 migration §1*

**Addendum — 2026-10-23, the clone's `cron.job` is not prod's (moved from root
`CLAUDE.md`).** `pnpm db:clone:prod` dumps `--schema=public --data-only`, and
`cron.job` lives in the `cron` schema, so it is never restored. The local rows
are whatever local migrations created, with whatever `active` flags local runs
left. Jobids differ (`ec-vacuum-analyze` is 6 on prod and 15 locally;
`platform-counts-daily` is 48 and 69), and so does `active` (2026-09-05: 33 of 37
jobs active on prod, 21 of 37 locally). The clone is deliberately not mirrored to
prod's flags, because a live pg_cron there would run prod-shaped jobs against
local data. FIX-944 nearly went the wrong way on this: the clone suggested half
the prod schedule was disabled, which would have justified re-enabling prod jobs
that were never off.

**Apply:** read cron state from prod, by name —
`node scripts/db-query.mjs --prod "SELECT jobid, jobname, active, schedule FROM cron.job ORDER BY jobname;"`
— and never treat the clone's `cron.job` as evidence about prod. *FIX-946, FIX-944*

### D4. Monitoring needs a RATE measure, and a detector covers only what it enumerates.

The canary *did* fire for the stale rollup, correctly and on time. What it could
not see is the same job's per-row cost regressing **~9×** in six days while runs
still completed inside the freshness window — a regression that converges before
the threshold is invisible by construction (FIX-972 therefore records `chunk_size`
and `recipients_done` per run, so a rate detector has something to read). Coverage
is enumeration: the canary watched **1 of 21** pg_cron jobs, seven were starved in
the same window, and `rule-taggers-weekly` has failed **4 of its 5** retained runs
at the 6 h ceiling with nothing watching it.

**Apply:** escalate on the consequence, report the cause — `startup_timeouts` and
`missing_daily` escalate; blowouts and the run trail are report-only, because
escalating on them would fail the canary most Tuesdays and train the alert to be
ignored (the FIX-943 `bloat_degraded` vs `vm_degraded` split).
*FIX-968, FIX-969, FIX-972, FIX-943 · cron audit §6 · `canary-check.ts`*

**Addendum — an intentional hold is a distinct STATE, not a quiet period.**
`fec_bulk` has no freshness watch at all: `list_scheduled_rollup_pipelines(90)`
returns 13 pipelines and none of them is fec_bulk, because the census selects on
`metadata->>'source' = 'pg_cron'` and fec_bulk runs from GHA with a NULL source.
So it could stop ingesting for a month unnoticed — and right now it is
*deliberately* held off the nightly (FIX-998) with nothing distinguishing "held"
from "silently broken". Two enumeration failures compound: the registry's
predicate excludes a whole launcher class, and `nightly_cron` records the
**phase**, not the pipeline — the fec-phase row proves the phase ran, not that
anything was ingested.

**Apply:** when a detector enumerates by launcher, ask which launchers it
excludes. And model a hold as its own state; a monitor that cannot represent
"intentionally paused" trades a silent failure for a standing false alarm, which
D4's own escalate-on-consequence rule then trains everyone to ignore.
*FIX-1011, FIX-998, FIX-977*

**Addendum — 2026-10-10, an unschedule and its hold row land together.** The
FIX-1011 census now derives the registry from every `data_sync_log` pipeline,
GHA ones included — so when `usaspending-bulk.yml`'s Thursday schedule came off
on 2026-10-08, the canary kept reporting `rollup:usaspending_bulk` as overdue:
the unschedule shipped without the `rollup_watch_overrides` hold row that the
`20260903000000` convention asks for in the SAME change. A detector covers only
what it enumerates, and it also covers everything it enumerates — including the
pipeline a human just paused.

**Apply:** an unschedule (a cron `unschedule`/`alter_job`, OR a workflow losing
its `schedule:`) carries its hold row in the same commit; the schedule's return
deletes it in the same commit. *FIX-1291 ·
`20261010050000_fix1291_reaper_heartbeat_usaspending_hold.sql`*

### D5. Guard constants are tuned to a table size and go stale when the table steps.

Two consecutive drain windows cleared **exactly 600** recipients and stopped at
601. Not a `LIMIT` — 600 is `3 × c_chunk_size(200)`, the predictive budget guard
doing exactly what it was designed to do at a quantum that no longer fits, and it
is arithmetic: three chunks complete and the fourth is refused whenever
`3,812 s < c < 4,985 s`, with prod at `c ≈ 3,900 s`. The reservation it can never
spend is one `1.25 × slowest chunk` — **27–32% of every window** at a 65-min chunk,
against under 6% on 07-31 when the slowest chunk was 749 s.

**Apply:** record the table size a quantum was tuned against and re-derive when the
table steps. Here: chunk 200 → 50 (quantum ~24% → ~7% of budget), which also cut
the outer timeout's blast radius from 109 min of discarded work to ~27.
*FIX-972 · `20260806230000_fix972_donor_rollup_chunk_quantum.sql`*

### D6. pg_cron QUEUES per jobid. A different session's advisory lock SKIPS. "Defers" means neither — never write it.

Three behaviours in this family have been described with one word, and that
conflation has now produced two falsified bullets (FIX-968, FIX-974). Name the
one you mean:

| | trigger | what happens | trace left |
|---|---|---|---|
| **(a) QUEUED** | a firing comes due while the **same jobid** is still running | pg_cron keeps one task per jobid and runs them **back-to-back** — nothing is dropped, nothing waits on a lock | **none.** `cron.job_run_details.start_time` lands ~1.0 s after the prior `end_time`, and `data_sync_log` shows nothing at all |
| **(b) SKIPPED** | a **different session** holds the advisory lock (the bulk driver, a manual sweep) | `pg_try_advisory_lock` is non-blocking → returns false → a `status='skipped'` row is written and the procedure RETURNs. **That firing's work is forfeited until the next one** — it is not delayed into the running one | greppable: `status='skipped'`, `skip_reason='advisory lock held by a concurrent donor-rollup refresh'` |
| **(c) "defers"** | — | used in this repo for both, precise about neither | — |

Measured on 08-06, 08-07 and 08-08: the second run starts within ~1 s of the
first ending, chaining two full budget windows into one continuous **9.5 h**
block. `max_running_jobs` is 32, so this is not a slot cap.

**The observability asymmetry is the reason this hid for three days.** A lock-skip
writes a row you can grep for; queueing writes nothing anywhere. Absence of
`skipped` rows is therefore not evidence that firings are not chaining — the
evidence is `start_time` ≈ prior `end_time` in `cron.job_run_details`.

**Consequence — a split schedule provides no isolation once a run overruns.** Two
firings 3 h apart do not bound anything if a run can exceed 3 h; they concatenate.
So a per-run budget must sit **below the gap between firings**, or the schedule is
decorative. FIX-1002's remedy was exactly this: cut the budget from 4h30m to 2h so
a firing cannot still be running when the next is due.

**Apply:** before rescheduling anything to "give it room", check whether the two
firings share a jobid. If they do, the room is imaginary until the budget is cut.
*FIX-1002, FIX-968, FIX-974 (2026-08-09 clarifier), FIX-972 · migration `20260807000000` header ~line 88 states the false (a)≡(b) equivalence and is frozen; the FIX-974 bullet is the correction of record*

### D7. Pick the autovacuum lever by table size — on a small relation the THRESHOLD is the whole trigger.

The trigger is **additive**: `autovacuum_vacuum_threshold + scale_factor ×
reltuples`. On a large table the default threshold (50) is rounding error and only
the scale factor moves anything — which is why every large-table override in this
repo is a scale factor. On a small, high-churn relation the scale term is
negligible and the threshold **is** the trigger, so a scale-factor override alone
changes nothing and the relation sits indefinitely just under the default. On a
27-row matview the scale term is **1.35**.

Measured on prod 2026-08-09, relations with no override ranked by dead ratio:
`proposal_popularity_24h` **100%** (0 live / 6 dead), `supabase_prometheus_state`
75.0%, `platform_alert_state` 70.3%, `pipeline_runtime_stats_mv` 47.2%,
`platform_usage` 29.6%, `platform_limits` 22.6% — several at **0.0% all-visible**.
Five tiny relations given `autovacuum_vacuum_threshold = 20` alongside the scale
factor went from **24.9–62.0% dead / 0.0% all-visible → 0 dead / 100%** within
seconds, on the first autovacuum evaluation after the override landed.

**Apply:** compute both terms before choosing the lever. Honest scoping — the
direct cost of bloat on a 1–5 page relation is near zero; the value is that these
are exactly the relations where the FIX-884 all-visible mechanism is invisible in
monitoring because the absolute numbers look harmless. Autovacuum genuinely
suffices once the trigger is reachable, so this is an override, not a cron job
(contrast C5, where the table is bulk-rewritten and needs an owner).
*FIX-1003, FIX-1006, FIX-943, FIX-884*

**Addendum — 2026-10-24, the large-table side: what a scale factor buys and what
it costs (moved from `packages/db/CLAUDE.md`).** Every vacuum pass scans **all**
of a table's indexes, so the budget is index bytes × index count, not row count.
`entity_connections` carries 3.5 GB across 10 indexes on an I/O-bound Small
instance, so it stays at 0.05 with a **daily** scheduled `ec-vacuum-analyze`
(placed by FIX-1152 on 2026-09-07 at 04:30 UTC, ahead of the 06:00 daily that
depended on it; `fe-vacuum-analyze` at 04:50 on the same reasoning). Making the *autovacuum* threshold more aggressive
is the move most likely to hurt the request path. Autovacuum keys on dead
tuples, while what breaks the search-index unit is the visibility map. A
scheduled VACUUM is already decay-keyed: it skips all-visible pages, and (PG14+)
the index pass when dead items are few, so a quiet day is nearly free. 0.05 is
not a guess: four tables have held it in production here and all four sit at
**100.0% all-visible**. Self-maintaining rollups need nothing —
`entity_connection_stats_mv`, `entity_search_index`, `group_donor_rollup`,
`official_donor_rollup_mv` and `treemap_individuals_rollup` delete and re-insert
millions of rows, clear even the 0.2 default every run, and were all 100%
all-visible while untuned.

**Apply:** ask first whether the table is on the request path — one rewritten
wholesale and read only by a nightly job can decay cheaply
(`external_relationships_review_queue` is deliberately untuned). Default to
0.05; go to 0.02 only for cheap tables or the very largest request-path tables;
let a scheduled VACUUM carry a big table rather than tightening its autovacuum.
*FIX-1152 · `20260907000000_fix1152_daily_vacuum_slots_and_vm_receipt.sql`*

### D8. A quantum, batch size, page size or rate limit is a DISCRIMINATOR over a population. Census its cost distribution before choosing the number.

D5 says a quantum tuned to a table size goes stale when the table steps, and
re-tuned the donor-rollup chunk 200 → 50 on that basis. Necessary, and not
sufficient — because the quantum counted the wrong thing. The chunk is quantised
by **recipient count** while the cost driver is per-recipient
`financial_relationships` fan-out, and that distribution on the uuid-ordered dirty
set is p50 **36** / p99 **7,326** / max **308,875** donors — an **8,580×** spread.
A fixed 50-recipient chunk therefore has unbounded cost: one such chunk ran past a
6 h `statement_timeout` having committed nothing, and the between-chunk budget
guard never evaluated once (C3).

**Apply:** for any number that slices a population, ask the **p99/p50 ratio of
whatever the number counts**. If it is large, the number counts the wrong thing —
quantise by an estimate of the cost driver instead. The estimate does not have to
be expensive: `official_donor_totals.donor_count` is maintained by the same
procedure and costs 117 pages to read. State the distribution you measured next
to the constant you chose, so D5's re-derivation has something to re-derive
against. *FIX-1002 · cf. D5, C3*

### D9. A scheduled job is a registry row and a unit — the pipeline contract.

A cron schedule says WHEN a job runs. It says nothing about how much of the
box the job takes, whether two jobs touching the same tables overlap, or
whether a firing that ran out of time picks up where it stopped. Each of those
has cost a real incident: the overlap ledger of cc-210 R3, the 6 h chunk that
committed nothing (D8), the bulk rewrite with no vacuum owner (C5). The
registry (`public.job_registry`, FIX-1307) holds one row per scheduled job, and
the unit dispatcher (FIX-1308) reads it to run ONE bounded unit at a time,
under a box rule (Σ live `cap_mb` + the candidate's cap ≤
`platform_dials.max_live_caps_mb`). Neither works for a job that does not meet
the contract below. The receipt for each item is named after it.

1. **One unit entry point** `(p_max_rows, p_max_units)`, with a persisted
   cursor, reporting rows and wall per unit. `(NULL, 1)` is today's atomic run
   (D10). A full rebuild that readers must see whole goes through the fix1134
   staging-table-then-swap shape, chunk by chunk (D7 of the spec). Receipt:
   `run_entity_connections_rebuild(…, p_max_units := 1)` — the ec-crawl's
   `entity_connections_rebuild_cursor` — is the shape. In the contract audit
   (`docs/audits/2026-10-12-job-registry-contract-audit.md` §3), 6 of the 21
   active CALL jobs have a cursor and a bounded unit, and none has the
   signature yet.
2. **One `data_sync_log` row per unit**, with `partial` as a terminal status
   that the next firing resumes from (A4, C2; FIX-754). Receipt: the crawl
   arms' `partial` is a DESIGNED status, never a failure.
3. **A registry row** (spec §2) — runner, unit_call, priority, deadline_rule,
   cost_class, cap_mb, exclusion_group, budget_seconds, gates. Receipt:
   `pnpm check:job-registry` fails CI for a cron job or a scheduled workflow
   with no row.
4. **The FIX-950 claim** for every GHA or manual writer (C9). A pg_cron
   writer is guarded by `prod_session_state()` in its body; a writer outside
   the database must CLAIM the session so the guarded jobs stand down under it.
   Receipt: `usaspending-bulk` holds one today; the nightly's fec phase takes
   one in N1 (cc-225).
5. **A band in `docs/receipts/bands.json`** from its first firings:
   `PROVISIONAL` at n = 1, re-based at five. Receipt: `check:job-registry`
   fails a row with no band and no `no-band` declaration, so a missing band is
   at least a stated decision.
6. **A vacuum owner for every table it rewrites** (C5) — a registry row of
   `unit_shape 'bare'` whose `unit_call` is that table's `VACUUM (ANALYZE)`,
   with no budget row (D11 of the spec). FIX-1299's lesson: a remediation
   script's tail is not an owner. Receipt: the audit's §2 item-6 column lists
   each body's rewritten tables against the 14 vacuum rows.
7. **The skip predicate on its upserts** (`skipUnchangedRows` /
   `updateOnlyIfSame`, C6) and `updateColumns` named, so a replay of unchanged
   input writes nothing and stamps no `updated_at` (C7). Receipt: the C6
   census of the `DO UPDATE` sites. SQL procedures that write in place are
   n/a.
8. **Its own `SET work_mem` and `SET max_parallel_workers_per_gather = 0`**
   in the body, sized against the BOX, not the query (cc-210; the M1–M3
   migrations). The cap goes on the registry row:
   `cap_mb = work_mem × hash_mem_multiplier (2)`, serial. A body that does not
   zero parallel is budgeted at × 2 participants. Receipt:
   `packages/data/src/__tests__/job-registry-seed.test.ts` fails a `CALL` row
   whose `cap_mb` is not 2 × the work_mem its body's newest migration sets.
9. **A `rollup_watch_overrides` cadence row** if it writes `data_sync_log`
   (FIX-1059), until the registry absorbs that table: the canary's
   `list_scheduled_rollup_pipelines()` then reads a declared cadence instead of
   one inferred from a cron expression or an observed median. Receipt: the
   audit's §2 item-9 column. Today only 5 rows exist, so this is the item the
   registry's `deadline_rule` is most likely to absorb.

**Apply:** `check:job-registry` verifies items 3 and 5 structurally on every
push, and the seed test verifies 8's arithmetic. The audit is the first census
of the rest. A new data source is onboarded by meeting all nine. When the
registry and the contract disagree, the contract is the target and the
registry row says so in its `note`. A row moves from `at …` to `by …` /
`stale_after …` only when its job meets items 1, 2 and 8, because the
dispatcher can only bound a unit it can see the end of.
*FIX-1307 · spec-job-registry-and-dispatcher-2026-10-11 §1 · docs/audits/2026-10-12-job-registry-contract-audit.md*

**Addendum — 2026-10-28, the multiplier is 1 (item 8).** FIX-1356 set
`hash_mem_multiplier = 1` on the `postgres` login role, so item 8's arithmetic
is now `cap_mb = work_mem × 1`. FIX-1357 halved the 33 multiplier-derived rows
(4 at 256 → 128, 29 at 128 → 64), Σ 6,656 → 4,288. It left the 14 VACUUM rows
(`maintenance_work_mem`, which the multiplier does not scale) and the 8 GHA
rows. The cap is an input to FIX-1354's headroom rung
(`MemAvailable − cap_mb < headroom_target_mb`), so a cap derived under the
wrong multiplier is a real refusal, not a rounding: the 256-cap daily needed
MemAvailable ≥ 406 against a ~387 median and was excluded at 397 MB on its
first slot (Tue 10-27 06:01Z). **Apply:** re-derive every cap when the
multiplier, the role's `work_mem` or a body's `SET work_mem` moves — the
derivation table lives in `20261028001000`'s header, and
`fix1357-caps.test.ts` pins it. The seed test still checks the SEED's × 2.
*FIX-1357 · cc-252 read 6*

### D10. A convention nobody measured is not a control — read the system's own record of what it did.

`[skip vercel]` was taught in CLAUDE.md, OPERATIONS, CONTRIBUTING, the README,
the handoff and the commit-push command, and tagged on hundreds of commits as
"no deploy". Vercel has no commit-message skip and the tree had no
`ignoreCommand`, so it skipped nothing, ever: every tagged push on 10-24/25/26
built a production deployment, and cc-249 found it only by quoting Vercel's
deployment list. Nothing failed, so nothing was checked. The cost was a build
per receipts / bot / docs push, and a false belief that main could run ahead of
production. FIX-1359 made it real (`apps/civitics/scripts/vercel-ignore-build.sh`),
and the design shows the second trap: Vercel builds only a push's tip, so the
question is the range since the last SUCCESSFUL deployment
(`VERCEL_GIT_PREVIOUS_SHA`), not `HEAD^..HEAD` — that diff would have skipped
every records push whose tip is an empty commit above an app change. And the
third: a file setting OVERRIDES the dashboard one. The project's dashboard
Ignored Build Step had been cancelling every Preview all along, and the
`ignoreCommand` silently replaced it. The first branch push after the landing
built a 2-minute preview, and `vercel inspect` on an older Canceled preview is
what showed the rule existed. Read the setting a file will override before
writing the file.

**Apply:** a convention that claims to switch something off names the
mechanism that does it, and its first claim is checked against the switched
system's own record — the deployment list, `cron.job_run_details`, the GHA run
list — not against the absence of complaints. A skip rule decides on the range
the system acts on, and a doubt builds.
*FIX-1359 · cc-249 (the deployment ids) · cc-252*

### D11. A slot keyed on a shared anchor is satisfied by its sibling — and the lapse writes no row.

The dispatcher's `by` and `stale_after` rows read their clock off "the
pipeline's newest complete|partial `data_sync_log` row". Two registry rows
share a pipeline when one procedure runs at two cadences: `refresh_derived_mvs`
daily + weekly, `run_rule_taggers` daily + weekly. So each row's completion
resets the other's clock. At the RETURN push (cc-253 read 3, 10-28 23:50Z) the
weekly's own last run was 10-06 01:10:27Z and its prev slot was Tue 10-27
00:47Z, but the daily's Wed 06:06:32Z row was newer than that slot. The old
body therefore read the weekly NOT due, and its first dispatched run would have
been an unsupervised Tue 11-03. The hazard is worse in steady state: a weekly
the gate holds past 06:00Z lapses to the next week the moment the daily
completes, and a `by` lapse writes nothing, so no row is there to notice. The
rule-taggers pair had not lapsed only because its daily slot happens to
precede its weekly's on the same day. FIX-1361's `job_registry.anchor_cadence`
keys the read on `metadata->>'cadence'`, which both procedures stamp on their
running row.

**Apply:** a registry row that shares its pipeline with another dispatched row
carries `anchor_cadence`, and its pipeline stamps the cadence on every row it
writes. Read the arithmetic both ways before the push: the anchor under the
current body and under the new one, with the sibling's row quoted. Today's
latent pairs share a pipeline with a parked `at` row only (ec-crawl /
`rebuild-ec-incremental*`, fe-crawl / `financial-entity-totals-incremental`).
They become siblings the day the `at` row RETURNs. A crawl's rows stamp no
cadence, so that RETURN needs the stamp first.
*FIX-1361 · cc-253 (read 3)*

### D12. A windowed cycle under a per-slot row expires after `c_cycle_max_age / slot` CALLs. Size the cycle or change the row's rule, never the age.

`refresh_donor_party_rollup_incremental` has two paths. The crawl COMMITs each
slice's rows and its watermark together and needs no cursor. The windowed full
rebuild (FIX-1212) keeps a cursor of the windows it has done, and discards it
at `c_cycle_max_age` 22 days (FIX-1216). Under a `by 0 15 * * 2` row the
dispatcher gives the procedure ONE CALL per Tuesday, because a `partial`
advances the row's clock. Each CALL stops at its 1500 s unit budget, so a cycle
gets three CALLs before its cursor expires. The windowed path has never run on
prod. Its one-statement predecessor took 11,278 s (09-22), and prod cold IO runs
10–60× the clone's 311 s cycle. So a cycle needing more than three Tuesdays
restarts forever and the watermark never moves: FIX-1216's trap, reached a new
way. The mode is picked by `lag > full_rebuild_lag_days`. At the RETURN (cc-254
read 3) the lag was 14 d 22:53. That reads **full** at the absent-key default
of 14 and **crawl** at prod's 30 (FIX-1249). The prompt had assumed the key
absent and planned a dial move; the read found the dial already crawl-first.

**Apply:** before a resumable returns under a per-slot rule, compute both
paths' CALL count against the slot: the windowed cycle's CALLs against
`c_cycle_max_age / slot`, and the crawl's slices against `max_units ×
unit_budget`. Quote the mode the body picks with prod's dial, not the default.
If only the windowed path fits the lag, the RETURN waits for a supervised cycle
or a resized one. Lengthening the age only lengthens the loop.
*FIX-1365 · FIX-1212 · FIX-1216 · FIX-1249 · cc-254 (read 3)*

---

## E. Verification and process

### E1. Prove conservation and equality on BASE tables, never on rollups.

A frozen rollup makes any delta against it look clean while the absolute is wrong
— precisely how $2.08B of understatement sat behind a stable-looking table (D1).
Conservation, FIX-933: platform donation dollars on officials $5,052,387,823 →
$4,832,843,124, an observed drop of **$219,544,699** against a deleted-loser sum of
**$219,544,699** — difference **$0**. Equality, FIX-974: every check is against a
live aggregation over `financial_relationships`, never a delta — FR byte-identical
before/after, published == live **to the cent**, a 60-official sample with **0
mismatches on all six arms**, and local byte-identity against the live
per-recipient implementation, **0/0 on every arm**, again after a park and resume.

**Apply:** finish on live routes with `X-Vercel-Cache: MISS`, but treat that as
*weak* evidence — per FIX-878 the Vercel Data Cache can serve a stale RPC result on
a fresh deploy. DB-layer equality is the proof.
*FIX-933, FIX-974, FIX-878 · FIX-974 audit §5*

### E2. Never size work off a proxy built from a rollup.

"Recipients processed per window" was proxied by counting `DISTINCT official_id`
with a recent `updated_at` in two rollup tables holding **4,336 rows total** — so
the proxy could never report more than 4,336 however much work ran. Falsified
against a run whose true count was known: 8,381 processed, proxy reported
**3,339** — and it was on its way to justifying a 50-hour break-glass sweep that
was not needed.

**Apply:** a rollup's row count is a *ceiling* on any "rows touched" proxy built
from it. Validate a sizing metric against a run whose true count is independently
known before quoting it as measured. *FIX-951*

### E3. Operational facts are hypotheses until re-derived.

Five filed, load-bearing numbers from this arc were later measured wrong — each in
a bullet anyone would reasonably have trusted:

| claim | corrected to |
|---|---|
| FR autovacuum "mathematically never fires" (threshold 1,663,805) | FR already carried a 0.05 override; real trigger **410,458**, and it had fired |
| donor-rollup failed runs took 20h15m / 20h22m / 20h09m | **6h08m / 6h00m / 6h00m**, dead ~14 h earlier (D2) |
| dropped firings caused by the stretched nightly MV window | true for **08-05 only**; other days were 6 h blowouts and GHA retries |
| scoping the dirty set to officials "cuts the work by roughly half" | **~30%** — non-officials are 51% of recipients but 30.2% of row work |
| ~1,000 recipients per 6 h window | measurement artifact (E2) |

**Apply:** every correction came from re-deriving against an independent source,
not from re-reading the bullet. When a number decides a multi-hour action, re-derive
it first; when you correct one, **append** the correction rather than editing the
claim away. *FIX-943, FIX-944, FIX-968, FIX-970, FIX-951*

**Appended 2026-08-09 — two more, per this rule's own instruction:**

| claim | corrected to |
|---|---|
| nightly `fec_bulk` OOM'd; `--max-old-space-size=12288` is load-bearing | **it never OOM'd** — no `FATAL ERROR` / `Reached heap limit` in any of six nights' logs. The mechanism is the **150-minute GHA `timeout-minutes` cap** (two nights log `exceeded the maximum execution time`), plus two unrelated prod statement timeouts. "Cap the heap" was never a fix direction (FIX-995) |
| `financial_relationships` vacuum **96.8% OWNED** (FIX-975 census) | true of the code, false of the schedule — the owner is `donor_rollup_rebuild_bulk()`, which cron jobid 24 does not call. FR `last_vacuum` was **3 days stale** after a full ingest (FIX-1013, C5) |

Both share a shape worth naming: the original claim was *true about an artifact*
(a log line, a function body) and false about the *thing the artifact stands for*.

### E4. Check cross-environment and cross-run expectations by DECOMPOSITION, not magnitude.

A 14× wall-clock gap between two runs of the same job looked catastrophic;
decomposed, dirty-set density differed by **1.38×**, leaving **~9× per FR row**
(3.6 → 33.0 ms) — a sharper finding than the headline, and the one that pointed at
access pattern. Likewise "dirty-only must be cheaper than a full pass" was assumed,
then timed: full 13,139 targets **86 s** vs dirty 4,885 targets **88 s** — dirty
marginally *slower*, because in a range regime the index walk dominates. Full was
chosen on the measurement.

**Apply:** normalise to a per-unit cost before naming a cause. A magnitude
comparison across environments or runs is not evidence until the units match.
*FIX-973, FIX-970 · FIX-974 audit §4*

### E5. A guard covers only the sites it enumerates. Enumerate by mechanism.

The FIX-955 guard covered `matchRow`, `buildMatchIndex` and `persistNewFecIds`.
The per-cycle weball name-fallback loop (`fec-bulk/index.ts` ~1084–1118) was a
fourth site nobody enumerated, and the first weekly run after the merge wrote
**$132,878,137 / 32,988 duplicate donation rows** onto 79 retired stubs. The
sibling case: the same last-write-wins map-collision defect lived in
`senatorByNameState`, the bioguide map, `loadOfficialsByFecIds` and
`buildMatchIndex` — fixed as a class, every map now **refusing** to overwrite an
occupied slot and logging both ids.

**Apply:** after fixing one site, grep for the *mechanism* — every `.set()` on an
identity map, every place a fallback selects from a candidate pool — and fix the
whole set. *FIX-960, FIX-940, FIX-941 · `congress/votes-maps.ts`,
`fec-bulk/candidates.ts`*

### E6. Refusing to match beats guessing a match.

`matchRow`'s weball fallback returned `pool[0]` outright when the state-narrowed
surname pool had one element — first names were never compared on that branch, so
the narrowing *removed* the ambiguity guard that would have forced a skip. Sherrod
Brown's Senate CAND_ID bound to **Shontel M. Brown**, whose page then carried
43,960 donation rows / **$50,998,289** against $2.26M of her own money. It does not
self-heal: the writer upserts on `(relationship_type, from_id, to_id, cycle_year)`,
so a corrected binding writes a **new** row and never retires the old one — every
mis-binding stays resident until remediated by hand (weeks of work, FIX-930 →
FIX-933/934/954).

**Apply:** an unbound official renders $0 plus a sync note; a mis-bound one renders
another person's donors under their name. When identity is uncertain, skip and log
— and make sure a later correction can actually retire the earlier write.
*FIX-929, FIX-933*

### E7. Timestamps humans read must be true, or must not exist.

A cursor UPDATE wrote `updated_at = NOW()`, which is `transaction_timestamp()`.
Each chunk runs in its own transaction beginning immediately after the previous
`COMMIT`, so the stamp records when chunk N *started* — one whole chunk early. A
run's last cursor write read 13:31:23 against a 15:20:29 end: **1h49m of apparent
stall after the final commit**, and the proof is exact — the gap is 6,546 s,
precisely that run's recorded `slowest_chunk_seconds`. The cursor *value* was never
wrong, only its timestamp. It cost a full diagnostic pass.

**Apply:** `clock_timestamp()` for anything read as progress —
`pipeline_state.updated_at` is what an operator or a stall detector reads. `NOW()`
is for transactional consistency, not observability. *FIX-972*

### E8. Bound derived-data cost by PRODUCT semantics, not source row counts.

This is what makes floor-removal survivable, and it is the standing constraint on
PR 3. Arm 1 stores the **top 200** donors per (official, relationship_type) plus
**one rank-201 tail aggregate**; the treemap arm keeps **rank ≤ 50** per state.
Stored width is set by what a surface renders, so source growth changes scan cost
but not stored size — which is why a tripled donor population did not multiply
these tables. What unbounded growth does to everything else: the FIX-952 indiv22
backfill (+1.27M donors, 1,262,769 new donation rows) broke
`refresh_treemap_individuals_global()` at its 2400 s budget **on an idle box**, and
the equivalent 2020 file OOM'd a 16 GB GHA runner at a 12 GB heap.

**Apply:** state the product question a derived table answers and the N that
answers it, then aggregate everything past N into one labelled remainder row. "All
of it, ranked" is not a product requirement. Note FEC ingest still drops
contributions under the $200 itemization floor (`fec-bulk/indiv.ts:203`) —
removing that floor multiplies source rows by an order of magnitude.
*FIX-974 migration (arm 1 body), FIX-952, FIX-965, FIX-961*

**Addendum — 2026-10-24, the floor moved and the ingest stopped tracking the
data (moved from `packages/data/CLAUDE.md`).** The "$200 itemization floor"
above was the wrong rule. FEC itemizes on a per-donor **cycle aggregate**: once
a contributor passes $200 cumulative with a committee, every later contribution
is itemized however small. Applying $200 per transaction at parse discarded
**90.2%** of in-scope cycle-2026 rows. PR 3b admits `amount > 0` and applies the
floor once per `(donor × recipient × cycle)` group at emit; a group under $200
writes no FR or donor row and is counted into `small_dollar_bracket_rollup`
instead. Measured on the full cycle-2026 file, identical across sort buffers
25k/100k/400k: FR rows **1,316,608 → 1,980,786** (+50.4%), dollars
**$4,074,508,705 → $4,556,216,174** (+11.8%), and the residual, silently dropped
before, is now 1,002,643 groups / $83,453,297, bracketed. The stage could take
that tenfold growth because PR 3a had already made its memory independent of the
data. The old heap guidance (8 GB, 12 GB for a presidential cycle) tuned a number
that was O(distinct groups); 12 GB OOM'd at ~53M of ~69M lines of `indiv20`.
The external sort (bounded buffer, gzip'd sorted runs, k-way merge) completed the
full cycle-2026 file — 30,632,248 lines, 5,401 MB extracted — at heap 2048 /
1024 / 512 MB with buffers 400k / 100k / 25k: stage peak RSS 2,256 / 900 /
424 MB, identical outputs, flat wall-clock (86–93 s). After the floor moved, sort
disk grew ~5× (142.9 → 822.7 MB at buffer 25k) while peak heap did not move
(~254 MB).

**Apply:** apply a source's filter at the grain the source defines it, and
measure what the wrong grain discarded before trusting a "threshold". When a
memory ceiling tracks the data, bound the working set instead of raising the
ceiling — the knob is the buffer (`FEC_INDIV_SORT_BUFFER`), and the resource to
budget becomes disk. *FIX-1068, FIX-961 · `docs/audits/2026-08-18-fec-coverage-pr3a-phase0.md`
· `packages/data/src/lib/external-sort.ts`*

### E9. Prove a zero with a relaxation ladder — drop one predicate clause at a time and show where the population dies.

A query returning zero rows is ambiguous between "the thing does not exist" and
"my predicate is wrong", and the second is the common case. The ladder resolves
it: run the same query with one clause removed per rung and report the count at
each rung, so the zero is localised to exactly one clause. Standing watch #1,
2026-08-09: **L1 83 → L2 83 → L3 83 → L4 83 → L5 0**, which pins the collapse to
the money predicate and nothing else. Composition then confirms the mechanism
rather than assuming it — **0 of 83** held a live id, **0 of 83** held any
`financial_relationships` row.

**Apply:** a zero you cannot localise to a single clause is not evidence, and it
must not be reported as one. This is strictly stronger than the usual defence
("here is a case that *would* fire"): a positive control proves the query can
return rows, the ladder proves *which* clause is the one returning none. Report
the rung counts, not just the conclusion. *standing watch #1, 2026-08-09 · cf. E10*

### E10. An assertion that cannot fail is not evidence — and three-valued logic makes assertions pass vacuously.

Two ways a green check means nothing, both measured in one verification file:

**The population was empty.** `verify_fix1003.sql` derives its arm set by walking
the call tree from `refresh_official_donor_rollup_incremental()`. Anchored on
`PERFORM|CALL`, the walk misses the chunk loop's **assignment** call form
(`v_n := public.donor_rollup_rebuild_recipients(v_chunk)`) and returns the empty
set — which every "all arms are covered" assertion satisfies perfectly. The fix is
a sanity gate that runs *before* the cases: `IF v_n < 6 THEN RAISE EXCEPTION …
'the call-tree walker is broken, so the cases below would pass vacuously'`.

**NULL is not FALSE.** `array_to_string(NULL, ',')` is NULL,
`NULL LIKE '%autovacuum%'` is NULL, and `count(*) FILTER (WHERE NOT overridden)`
does not count NULLs — so a table with **no overrides at all** passed an
"everything is overridden" check. `COALESCE` the expression, and pair every
`count(*) FILTER (WHERE NOT ok) = 0` with `count(*) > 0`.

**Apply:** a test that passes on `main` before the fix proves nothing — run it
against the unfixed state once and watch it fail. Assert the population is
non-empty as its own case, and make NULL an error rather than a pass.
*FIX-1003 · `supabase/tests/verify_fix1003.sql` · cf. C3 (the guard-side twin)*

### E11. An adjacent metric is not the fact. Name the authoritative source per question.

`5/5 R2 uploads ok` was read as "five files were downloaded from FEC" — but that
counter **structurally excludes cache hits**, which was exactly the case being
ruled out. A stale 2 GB file was ingested on the strength of it. Same class,
different pair: `downloadWithR2Cache` decides freshness with `r2Lm >= fecLm`,
where `r2Lm` is *when we finished uploading* and `fecLm` is *when FEC published* —
two timestamps that answer different questions, so a republish mid-run can pin
superseded bytes stamped newer than the live file (near-miss measured 2026-08-09:
FEC republished at 16:03:26 GMT, our uploads drained 16:54:40–16:55:32Z; it did
not fire only because that file took the cache branch, which re-uploads nothing).
And dead-tuple counts were read as "the run committed nothing", falsified by
`pipeline_state` (D2 addendum).

**Apply:** for each question, name the source that is authoritative *for that
question* and go to it — the write-count for "did it write", the watermark for
"how far", FEC's own reported headers for "is our copy current". When comparing
two values, check they answer the same question: store the remote's reported
`Last-Modified` / `Content-Length` / `ETag` as metadata and compare
reported-then vs reported-now, so your own object's timestamp drops out of the
decision. Cheap belt-and-braces beats clever: the two files here differ by
**65,891,767 bytes (3.3%)**, so a size compare alone would have caught it. E2 is
the special case of this where the proxy is built from a rollup.
*FIX-1014, FIX-1008, FIX-1002 · `packages/data/src/pipelines/fec-bulk/util.ts`*

**Addendum — 2026-10-24, two more adjacent metrics (moved from
`packages/db/CLAUDE.md`).** *"An EC edge exists" is not "a donation exists".*
`entity_connections` donation edges are rebuilt on a schedule, so they **lag**
the weekend FEC ingest until the next rebuild: an individual→committee pair from
the current weekend legitimately has no edge yet, then self-heals. FIX-736's
EC-derived `financial_entities.recipient_count` under-counted for exactly that
window; the FR-derived aggregates (`recipient_count`, `total_donated_cents`,
`total_received_cents`) are recomputed from `financial_relationships` and are
effectively real-time. FIX-735 investigated the "edge gap" and closed it
working-as-designed on that reasoning. *`count: 'estimated'` is not the row
count.* It reads `pg_class.reltuples`, which is whatever the last vacuum or
analyze wrote, and it drifts in one direction after a bulk delete: it overstated
`votes` by **31%** after the vote-stub retirement. `platform_counts` replaced it
with one EXACT `count(*)` per metric, overwritten daily with a `counted_at` the
surface shows.

**Apply:** query `financial_relationships` for presence and counts; read EC as a
display cache. When the request-path cost is counting rather than aggregating, an
exact count taken daily beats a planner estimate taken constantly — the price is
freshness, so surface it rather than hide it. *FIX-735, FIX-736, FIX-1146,
FIX-1095*
