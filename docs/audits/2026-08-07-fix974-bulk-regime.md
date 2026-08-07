# donor-rollup BULK regime — prod, 2026-08-07

FIX-974. Clearing the donor-rollup backlog set-based on the FIX-965 pattern,
and — as the same run, for free — settling the FIX-973 question: is the ~9×
per-FR-row cost regression an **access pattern** that software can fix, or is it
**the box** (FIX-589)?

**Verdict up front: access pattern.** The regression is real, but it is a
property of the *per-recipient* regime, not a floor imposed by the instance.
The same work in a range-scanned, set-based regime runs **~60× faster per
recipient** on the same box, the same night.

The decision-9 tripwire (stop if the projection exceeds ~8 h) **did not fire**;
it was cleared by a read-only `EXPLAIN` before the run even started.

---

## 1. Arm-by-arm staleness census (decision 2)

Read-only on prod, 2026-08-07 01:30 UTC. All six arms are plain tables
(`relkind='r'`), including the misleadingly-named `official_donor_rollup_mv`.

Backlog at the time: dirty set **10,286 recipients** (5,029 officials) /
2,600,887 FR rows; **9,086 recipients** still owed after the incremental's
cursor (`1c5978e5-…`, watermark `2026-08-02 05:54:43`).

Staleness measured on a 100-official sample drawn from the *remaining* set.
`missing_*` counts only rows that are absent, so each is a **lower bound** on
staleness:

| arm | table | stale / missing out of 100 |
|---|---|---|
| 2 | `official_donor_totals` | **77 stale** (value differs from live FR) |
| 3 | `official_small_dollar_rollup` | **71 stale** |
| 6 | `official_donor_bracket_totals` | 54 missing |
| 5 | `treemap_individuals_rollup` (per-official scopes) | 54 missing |
| 4 | `official_sector_affinity_rollup` | 51 missing |
| 1 | `official_donor_rollup_mv` | 37 missing |

**Finding: all six arms are stale. None was fresh, so none was skipped.**

Two things the census corrected about the plan's priors:

* **Treemap is only half fresh.** FIX-965 rebuilt the **GLOBAL** sentinel scope
  (3,034 rows, 1 scope) and that *is* current. The **per-official** scopes
  (688,651 rows over 4,109 scopes) are arm 5 of this family and were stale. The
  bulk procedure rebuilds per-official scopes and never touches the global one.
* **Sector affinity is not independently fresh.** Its FIX-958 tag trigger has
  its own machinery, but `max(updated_at)` on the table was
  `2026-08-06 13:31:23` — exactly the drain's last cursor write, i.e. the drain
  is what has been writing it. `min(updated_at)` was 08-02. It is stale like the
  rest.
* **No matview depends on any of the six arms** (`pg_depend` → 0 rows). The
  chord/homepage/sector-dollars MVs aggregate `financial_relationships`
  directly. So the plan's "refresh dependent MVs at the end under their own
  budget" step **has nothing to do**, and no MV budget is spent.

---

## 2. The index-only unlock

`financial_relationships_donor_rollup_idx` is

```
(to_id, relationship_type, from_id) INCLUDE (amount_cents)
WHERE relationship_type IN ('donation','ie_support','ie_oppose')
  AND from_type = 'financial_entity'
```

`to_id` **leads** it, so a `to_id >= lo AND to_id < hi` range predicate is one
dense walk instead of N scattered descents.

Arms 2–6 filter `fr.to_type = 'official'`, and `to_type` is **not** in the
index — so on the face of it every such row needs a heap visit. Measured across
all **6,457,535** rows in the index's scope:

| check | rows |
|---|---|
| `to_type='official'` with no `public.officials` row | **0** |
| `to_type<>'official'` whose `to_id` **is** an official | **0** |

So within this index's scope, `to_type = 'official'` is **exactly**
`to_id IN (SELECT id FROM officials)`. Resolving official-ness through the
target table instead of the heap column lets the whole FR scan stay
**index-only**. FR was 94.1% all-visible / 73,646 dead tuples at run time, so
the visibility map actually pays out.

(If that decays this degrades straight back to the old cost — which is the
FIX-884/943 rule restated, and why the driver vacuums.)

---

## 3. The measurement — FIX-973's answer

### 3a. Pre-flight, read-only `EXPLAIN (ANALYZE, BUFFERS)`, chunk 0 of 32

```
GroupAggregate  (actual time=5.059..21734.376 rows=150437 loops=1)
  Buffers: shared hit=156454 read=12604
  ->  Index Only Scan using financial_relationships_donor_rollup_idx
        Index Cond: to_id >= '00000000-…' AND to_id < '08000000-…'
        Heap Fetches: 22347
Execution Time: 21755.979 ms
```

184,067 FR rows → 150,437 groups in **21.8 s** = **0.118 ms/FR row**.

| regime | per FR row | source |
|---|---|---|
| per-recipient, 2026-07-31 | 3.6 ms | FIX-973 |
| per-recipient, 2026-08-06 | **33.0 ms** | FIX-973 |
| **bulk range scan, 2026-08-07** | **0.118 ms** | this run |

The 07-31 → 08-06 regression is genuine and unexplained by density. It is also
**not a floor**: the same box, the same night, moves the same rows ~280× cheaper
when the access pattern is a range walk rather than scatter probes. (Not a
like-for-like ratio — the per-recipient figure covers six arms' worth of
re-scanning, this covers one scan feeding all six. Per arm it is still ~46×.)

### 3b. The run itself

Prod, `mode=full`, 32 chunks, budget 9,000 s, `statement_timeout=0`.
`data_sync_log` pipeline `donor_rollup_bulk`, started **2026-08-07 02:14:11 UTC**.

| metric | value |
|---|---|
| status | **complete**, 32/32 chunks, one CALL |
| targets | **15,316** recipients (6,947 officials) |
| elapsed | **926 s (15 m 26 s)** |
| slowest chunk | **59 s** |
| mean chunk | 28.9 s |
| VACUUM (ANALYZE) tail | **13 s** total — `official_donor_rollup_mv` 8 s, `treemap_individuals_rollup` 5 s, other four <1 s |

**Cache warming is visible in the chunk rate** — the run gets ~4.5× faster as it
goes, which is itself evidence for the FIX-973 working-set hypothesis:

| phase | chunks | wall clock | s/chunk |
|---|---|---|---|
| setup (targets + 3.63M-row donor dimension) + chunks 0–9 | 10 | 625 s | 62.5 (incl. setup) |
| chunks 10–31 | 22 | 301 s | **13.7** |

### The headline

| | per-recipient regime | bulk regime |
|---|---|---|
| measured | **19.0 s/recipient** (FIX-973, 08-06) | **0.060 s/recipient** (926 s / 15,316) |
| the 9,086-recipient backlog | **~48 h** of pure compute | — |
| what actually happened | — | **all 15,316 recipients in 15 m 26 s** |

**~314× faster per recipient**, on the same instance, the same night, with the
backlog cleared as a *superset* (a full pass, not just the 9,086 owed).

For scale: the naive ETA for the per-recipient drain was **~Aug 12**, with
Sunday's `fec_bulk` due to refill the dirty set before it got there.

---

## 4. dirty-only vs full pass (decision 3)

Timed both ways on local Docker (4.37M FR rows in scope, 13,139 recipients),
identical code path, only `_drb_targets` populated differently:

| mode | targets | officials | wall clock |
|---|---|---|---|
| `full` | 13,139 | 6,076 | **86 s** |
| `dirty` | 4,885 | 4,451 | **88 s** |

**Dirty was marginally *slower*.** That is the expected result once the regime
is range-based: the index walk covers the whole `to_id` range either way, and
the dirty semi-join adds a filter without removing any of that walk. Only the
per-arm derivation shrinks, and it is not the dominant term.

**Chose `full`**, because at equal cost it is strictly better:

* no dirty-set bookkeeping, and no resume-mode-mismatch class;
* it converges recipients that are stale for reasons the watermark cannot see
  (a rollup damaged by an earlier partial run is invisible to an
  `updated_at`-based dirty set);
* it makes the completion semantics trivial — after a full pass every recipient
  is current as of the captured target, so the watermark advance is
  unconditional.

Prod could not be A/B'd read-only (populating `_drb_targets` is a write), but
§3a shows the scan cost is set by the range, not the target count, which is the
same thing the local A/B measured.

---

## 5. Correctness: equality, not deltas

### 5a. Local — byte-identity against the reference implementation

The acceptance test is equality with the **live per-recipient path**, run over
the same input. Two whole `to_id` ranges (chunk 0 and chunk 17 of a 32-tiling),
**827 recipients / 353 officials**:

1. `donor_rollup_rebuild_recipients(<those 827>)` — the live reference impl —
   then snapshot all six arms.
2. Full bulk pass.
3. Row-wise set difference **both directions** on `to_jsonb(row)` minus
   write-clock columns (`updated_at` is `now()` in both impls and is not data).

| arm | rows | ref_only | bulk_only |
|---|---|---|---|
| `official_donor_rollup_mv` | 50,733 | **0** | **0** |
| `official_donor_totals` | 342 | **0** | **0** |
| `official_small_dollar_rollup` | 342 | **0** | **0** |
| `official_sector_affinity_rollup` | 1,503 | **0** | **0** |
| `treemap_individuals_rollup` | 31,263 | **0** | **0** |
| `official_donor_bracket_totals` | 691 | **0** | **0** |

The GLOBAL treemap scope was untouched (3,009 rows / 64 states, before = after).

### 5b. Local — forced-budget park and resume

`--budget-seconds 1` → parked after chunk 0 with `status='partial'`,
`chunk_cursor=0/31`, `error_message='budget exhausted — resumable at chunk 1 of
32'`. Re-CALL with a normal budget → resumed at chunk 1, ran the remaining 31,
`status='complete'`. **The byte-identity table above was re-run after the split
sweep and was still 0/0 on every arm**, including the 50,733-row arm 1 — a
sweep split across runs produces the same output as a single-pass sweep.

### 5c. Prod verification

All read-only, all **equality against a live aggregation over
`financial_relationships`**, never a delta.

**Nothing wrote FR.** Baseline captured before the run, re-read after — identical
on all three measures, so both attribution detectors are untouched by
construction:

| | before | after |
|---|---|---|
| rows | 10,280,280 | **10,280,280** |
| `SUM(COALESCE(amount_cents,0))` | 377,497,303,748,122 | **377,497,303,748,122** |
| `max(updated_at)` | 2026-08-06 06:39:22.771736+00 | **same** |

**The named three (+ Guthrie as an already-fresh control) — published vs live,
to the cent:**

| official | before (stale) | published now | live FR | diff |
|---|---|---|---|---|
| Mike Johnson | 1,135,238,100 | **1,187,648,800** | 1,187,648,800 | **0** |
| Tom Emmer | 1,096,423,800 | **1,231,421,700** | 1,231,421,700 | **0** |
| Hakeem S. Jeffries | 1,722,765,000 (already fresh) | 1,722,765,000 | 1,722,765,000 | **0** |
| Brett Guthrie (control) | 1,162,196,700 (already fresh) | 1,162,196,700 | 1,162,196,700 | **0** |

Johnson was understating by **$524,106** and Emmer by **$1,349,979**.

**60-official random sample, drawn from the reconstructed pre-run backlog**
(the old watermark `2026-08-02 05:54:43.093255+00` + old cursor
`1c5978e5-…`; FR is unchanged, so the 9,086-recipient set is exactly
reproducible after the fact). Each arm recomputed live from FR and compared:

| arm | check | mismatches |
|---|---|---|
| 1 `official_donor_rollup_mv` | Σ over all ranks per (official, reltype) = live Σ | **0** |
| 2 `official_donor_totals` | (total, pac, individual, donor_count) tuple | **0** |
| 3 `official_small_dollar_rollup` | (cents, count) | **0** |
| 4 `official_sector_affinity_rollup` | (cents, donor_count) per industry | **0** |
| 6 `official_donor_bracket_totals` | (cents, donor_count) per tier | **0** |
| 5 `treemap_individuals_rollup` | full row set, both directions, 10,216 rows | **0 / 0** |

**Platform-level sums, published vs live:**

| arm | published | live | Δ |
|---|---|---|---|
| 1 `official_donor_rollup_mv` | 3,010,800,765,982 | 3,010,800,765,982 | **0** |
| 2 `official_donor_totals` | 679,570,087,200 | 679,570,087,200 | **0** |
| 3 `official_small_dollar_rollup` | 31,030,161,000 | 31,030,161,000 | **0** |
| 4 `official_sector_affinity_rollup` | 679,570,087,200 | 679,570,087,200 | **0** |
| 6 `official_donor_bracket_totals` | 451,570,432,000 | 451,570,432,000 | **0** |

**Backlog cleared.** The dirty set the next scheduled firing will build under the
new watermark is **0 recipients**. Note this is a *deterministic* statement about
what the 09:00 UTC firing computes — the query is the procedure's own dirty-set
query — **not** an observation of that firing, which had not yet run when this
was written.

**FIX-943 vacuum rule, with evidence:** all six arms vacuumed 02:29:44–02:29:50,
`n_dead_tup = 0` on every one.

| arm | rows before | rows after |
|---|---|---|
| `official_donor_rollup_mv` | 790,923 | 1,005,465 |
| `treemap_individuals_rollup` | 691,685 | 929,230 |
| `official_sector_affinity_rollup` | 20,965 | 26,801 |
| `official_donor_bracket_totals` | 12,155 | 16,404 |
| `official_donor_totals` | 4,588 | 6,793 |
| `official_small_dollar_rollup` | 4,588 | 6,793 |

The growth is the backlog: many officials had **no rows at all**, which is why
the earlier staleness census counted `missing_*` rather than `stale_*` for four
of the six arms.

**GLOBAL treemap scope preserved** at exactly 3,034 rows; per-official scopes
4,109 → 5,582.

**Live routes**, cache-busted, during/after: `/api/graph/small-dollar` and
`/api/graph/sector-affinity` for Mike Johnson both 200 on
`X-Vercel-Cache: MISS` (1.04 s / 0.73 s). Site checked mid-run too — homepage
3.2 s cold, `/officials` 399 ms, `/proposals` 343 ms, `/institutions` 545 ms.
Per FIX-878 the route layer is weak evidence (the Vercel Data Cache can serve a
stale RPC result), which is why the DB-layer equality above is the actual proof.

---

## 6. Deliberate deviation from the FIX-965 pattern

The plan specified "UNLOGGED staging, group-then-join, … publish swap". The
group-then-join staging is there and is the whole point. **The whole-table
publish swap is not**, deliberately.

FIX-965 needs a swap because its chunks are keyed by **donor** (`from_id`) while
its output is partitioned by **state** — a donor range contributes to every
state, so no chunk's output is final until all have merged.

Here the chunk key **is** the output partition key: all six arms are keyed by
`official_id` / `scope_id`, which is `to_id`. A chunk's output is therefore
final for that chunk's recipients and there is no cross-chunk merge to protect.
Writing straight into the live arms per chunk:

* **halves the write volume and the dead-tuple load** — a shadow copy is written
  once to staging and once to live. On a box whose measured problem is I/O, and
  under the FIX-943 rule, that is the deciding argument;
* **preserves the atomicity that matters**: one chunk is one transaction, so an
  official is either wholly old or wholly new, consistent **across all six
  arms**;
* makes a partial run worth something, which is the point of clearing a backlog.

What a swap would add is cross-**official** epoch consistency, which these
tables have never had (the incremental converges one official at a time) and
which the 9,086-recipient backlog already violated far more.

Everything else from FIX-965 is kept: cursor advanced inside the chunk
transaction, predictive between-chunk budget as the only clean stop, chunk
failure **aborts** rather than skips, UNLOGGED staging with a crash-truncation
restart, and a staleness bound on resuming sweeps.

---

## 7. One invariant the bulk regime newly depends on — and now asserts

The whole speed win comes from reading **only**
`financial_relationships_donor_rollup_idx`, whose partial predicate includes
`from_type = 'financial_entity'`. Five of the six arms carry that same filter in
their live per-recipient bodies, so for them the index scope *is* the arm scope.

**Arm 2 (`official_donor_totals`) does not.** Its live body is

```
WHERE fr.to_type = 'official' AND fr.relationship_type = 'donation'
  AND fr.to_id = ANY (p_recipients)          -- no from_type predicate
```

so it is defined more broadly than the index can see. Measured on prod:

| `from_type` on donation→official rows | rows |
|---|---|
| `financial_entity` | **4,098,213** |
| anything else | **0** (single group returned) |

The difference is empty, which is why byte-identity passed on arm 2 — but
"equal because the gap happens to be empty" is not "equal". If such a row ever
landed, the per-recipient regime would count it and the bulk regime would not,
and the two regimes would disagree depending on which last touched the
recipient — silently.

Migration `20260807010000_fix974b_bulk_from_type_invariant_guard.sql` therefore
adds `donor_rollup_bulk_assert_invariants()`, called **before any arm is
written** on the fresh-sweep path. One `LIMIT 1` probe; a violation aborts the
sweep with a named error instead of publishing a quietly-low
`official_donor_totals`. (`small_dollar_rebuild_officials` already leaned on the
same invariant and said so only in a comment.)

The guarded body was re-proved byte-identical against the per-recipient
reference locally before being pushed to prod.

---

## 8. What this does not settle

* **FIX-973 is characterised, not closed.** The bulk regime routes *around* the
  regression; it does not explain why the per-recipient path went from 3.6 ms to
  33.0 ms per row in six days. The per-arm cold-cache profiling that bullet asks
  for is still unwritten, and the per-recipient path is still what the 09:00
  firing uses for the daily trickle.
* **FIX-589 gets no new argument from this run.** If anything it gets a weaker
  one: the box was never the binding constraint for *this* work.
* **FIX-969's regime split is half-built.** This is the bulk half. Auto-selecting
  bulk vs trickle by dirty-set size is still 969's PR.
* **FIX-970 is untouched.** Arm 1 is still deliberately not scoped to officials,
  matching the live body, and the 7,241 orphan ids are still there.
