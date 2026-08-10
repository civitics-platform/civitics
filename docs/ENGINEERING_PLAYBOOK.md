# Engineering Playbook — the operating rules, with their receipts

Distilled from the July–August 2026 FEC/rollup arc (FIX-929 → FIX-974). Every
rule was paid for by a measured incident; each carries the number and the file
that proves it. The depth stays in the cited audits — this is the rule list.

**Normative for new work.** The Stage-1 rebuild and the PR 3 rollup-capacity work
are held against it: a design that violates a rule here needs an argument in its
spec, not silence.

**Receipts are dated measurements, not constants.** Taken on Supabase **Pro
Small** (2 vCPU, 256 MB `shared_buffers`, 6 h `statement_timeout` on the
`postgres` role) against a ~10.3M-row `financial_relationships`. The rules
survive a bigger box; the numbers do not. Re-derive before quoting — rule **E3**.

**Extended 2026-08-09** with the rollup-saturation arc (FIX-995 → FIX-1015): new
rules **C5–C7**, **D6–D8**, **E9–E11**, plus dated addenda on **C2**, **C3**,
**D2**, **D4** and **E3**. Rules are append-only — a correction is appended
beneath the claim it corrects, never edited over it.

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
statement_timeout` inside a procedure body. Chunking is the only real lever: seven
pg_cron jobs have been killed by the 6 h ceiling and chunking is the only thing
that has ever fixed one.

**Apply:** design the stop you intend (budget → `partial` → resume). If something
must be stopped from outside it is `pg_cancel_backend` on a named backend,
deliberately, and the writer must already survive losing its current chunk.
*FIX-933, FIX-944, FIX-965, FIX-969 · cron audit §8*

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

---

## D. Scheduled work

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
