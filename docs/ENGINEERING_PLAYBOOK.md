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

### C4. Runtime measurements are floors. Design to survive the miss.

`refresh_homepage_stats_mv()` takes 0.7 s on local and ran **22 minutes** against
an otherwise-idle prod; the FIX-968 audit's own drain projection was **wrong by
~15×**. The direction is not even reliably one way — a `VACUUM` on FR is minutes
on prod and **>17 min on local Docker**.

**Apply:** never let a projection be the only thing between a run and an unbounded
window. Resumability plus a budget is what makes a wrong estimate cheap.
*FIX-933, FIX-943 · cron audit §5 vs §7b*

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
