# FIX-1030 — why `chord_donor_state_party_flows_mv` took prod down twice

**Date:** 2026-08-13 (cc-prompt-61)
**Scope:** the one weekly `refresh_derived_mvs('weekly')` unit that failed catastrophically
on both of its last two firings.
**Method:** prod catalog reads + plain `EXPLAIN` (costs only, nothing executed on prod);
all execution experiments on the local prod-scale clone.
**Verdict:** a planner **plan flip**, triggered by the FIX-1018 index, standing on two
pre-existing statistics defects and one cost-model setting. Not bloat, not the FIX-1013
vacuum, not a definition change, not a cardinality step from the 08-09 ingest.

---

## 1. What was already known going in

| | 2026-08-11 07:00 UTC | 2026-08-13 01:05 UTC |
|---|---|---|
| unit 1 `chord_industry_flows_mv` | 262.6 s ok | 189.4 s ok |
| unit 2 `chord_donor_type_party_flows_mv` | 220.5 s ok | 143.6 s ok |
| unit 3 `chord_donor_state_party_flows_mv` | **no completion line** | **no completion line** |
| outcome | pg_cron worker starvation 07:30 → 14h22m log-dark → manual restart 22:51 | instance **crashed** 01:45:27.788819 (unclean) |

Both siblings got *faster* after the FIX-1013 vacuum while unit 3 still hung, which already
ruled bloat out as the mechanism.

## 2. The discriminating evidence — unit 3's plan vs its siblings'

Prod, plain `EXPLAIN`, nothing executed.

**Unit 2 (healthy)** — `Parallel Hash Left Join`, `financial_entities` scanned once via
`Parallel Seq Scan`, hash entry width 26. Total cost 838,482.

**Unit 3 (the killer)** — a **`Nested Loop`** whose inner side is
`Memoize → Index Scan using financial_entities_pkey`, driven by ~950k outer rows, hash
entry width 163. Total cost 613,522.

The planner picks the nested loop because it prices **19% cheaper** than the hash join.
Forcing each alternative on prod (plain `EXPLAIN`, planner knobs only):

| prod plan variant | total cost |
|---|---|
| chosen: Nested Loop + Memoize | **613,522** |
| `enable_memoize = off` | 649,291 |
| `enable_nestloop = off` (the healthy shape) | 756,100 |

So **Memoize's cost discount is what makes the nested loop win.**

## 3. Three defects, all of which had to hold at once

**(1) A 298.5× underestimate of the `financial_entities` filter.**
`LENGTH(metadata->>'state') = 2` is an expression no index and no statistics object covers,
so the planner falls back to its hardcoded `DEFAULT_EQ_SEL` (0.005).

| | estimated | actual (measured on the clone) |
|---|---|---|
| `financial_entities` rows passing the filter | 10,714 of 3,679,374 | **3,198,178 (87.13%)** |

This is what makes the nested loop's inner side look ~300× smaller than it is.

**(2) A 41× underestimate of `n_distinct(financial_relationships.from_id)`.**
`pg_stats` says **42,267** on prod (42,600 on the clone — the same defect, not a clone
artifact). Measured truth: **1,745,921 distinct donors** across 4,183,604 qualifying
donation rows. This is what makes Memoize look like it will serve ~99% of probes from cache.

**(3) `random_page_cost = 1.1`** — prod's setting (the Supabase default); stock postgres and
this project's local Docker are both `4`.

**Isolated one-at-a-time on the clone, (3) is the single setting that flips the plan:**

| clone scenario | join shape |
|---|---|
| clone defaults | Parallel Hash Join |
| **only `random_page_cost = 1.1`** | **Nested Loop + Memoize** ← reproduces prod |
| only `effective_cache_size = 768MB` | Parallel Hash Join |
| only `max_parallel_workers_per_gather = 1` | Parallel Hash Join |
| only `work_mem = 256MB` | Parallel Hash Join |

With prod's GUCs replayed the clone produces prod's plan node-for-node (cost 602,475 clone
vs 607,984 prod).

## 4. Why it started on 2026-08-11 and not before

(1)–(3) are all long-standing. The **trigger** was FIX-1018's partial index
`financial_relationships_donor_rollup_dirty_idx`, built **~03:00 UTC on 2026-08-11 — four
hours before the first catastrophic firing**. Its predicate
(`to_type='official' AND from_type='financial_entity' AND relationship_type IN (donation,
ie_support, ie_oppose)`) covers unit 3's `WHERE` almost exactly, so it handed the nested loop
a cheaper outer path than it had ever had:

| outer path | bitmap startup cost | estimated rows |
|---|---|---|
| `financial_relationships_to` (pre-FIX-1018) | 41,217 | 1,519,884 |
| `..._donor_rollup_dirty_idx` (post) | **17,539** | **953,828** |

That dropped the nested loop's total below the hash join's and flipped the plan. Confirmed by
counterfactual: dropping the index inside a rolled-back transaction on the clone restores the
hash join.

**The index is not at fault and is not touched.** It made a pre-existing misestimate reachable.

The siblings are immune structurally: unit 2 `LEFT JOIN`s `financial_entities` with **no**
`metadata` predicate, so there is no misestimated filter to shrink an inner side.

## 5. Measured execution on the clone — `EXPLAIN (ANALYZE, BUFFERS)`

```
Memoize  Hits: 2,328,993  Misses: 1,854,611  Evictions: 869,096
         Memory Usage: 262,145 kB
```

1,854,611 misses across 4,183,604 probes is a **44.3% miss rate** against a cost model that
assumed ~99% hits; 869,096 evictions is the cache thrashing exactly as 1.75M distinct keys
guarantees. **Memory Usage 256 MB** — Memoize sizes at `work_mem × hash_mem_multiplier`
(128MB × 2), so this one node may allocate the entire size of prod's `shared_buffers`.
That is the OOM-consistent shape (no server memory parameter is tuned as a result).

| estimate vs actual, same plan | est | actual | ratio |
|---|---|---|---|
| `financial_entities` filter | 10,714 | 3,198,178 | 298.5× |
| nested-loop join output | 4,722 | 3,593,976 | 761.1× |

**Buffer accounting** — cache-independent, and the number that matters, because on prod a
`read` is a real disk read against 256 MB of `shared_buffers`:

| | buffer accesses |
|---|---|
| BEFORE (nested loop) | hit 4,846,089 + read 2,906,376 = **7,752,465** |
| AFTER (the fix) | hit 4,413 + read 509,591 = **514,004** |
| SIBLING unit 2 (healthy) | read 498,015 = **498,015** |

**15.1× less buffer traffic overall; 41.2× on the `financial_entities` access specifically**
(7,418,444 → 179,993). More important than the ratio is the access *pattern*: 1.85M scattered
pkey descents plus heap fetches become one sequential scan. The fixed unit lands **within 3%
of its healthy sibling**.

### ⚠ Premise contradicted: the clone cannot reproduce the outage by duration

The clone completes the *original* query in **23.5–37 s**, not 35 minutes, because this box's
OS page cache holds the whole 1,632 MB `financial_entities` heap — the probes that are
physical disk reads on prod are RAM hits here. The clone reproduces the **plan** exactly and
the **I/O demand** exactly; it can never reproduce the **wall clock**. That is why the
evidence above is buffer counts and Memoize statistics rather than seconds, and it is a
standing caveat for any future perf repro on this clone.

## 6. The fix

**Part 1 — fence the plan.** The FE filter and state extraction are hoisted into a CTE with
an explicit `AS MATERIALIZED` optimiser fence, so `financial_entities` is scanned once and
projected narrow *before* it reaches the join. There is no index on a CTE, so no parameterised
inner path exists — the nested loop is not merely unattractive, it is **unavailable**. The fix
deliberately does not depend on the planner estimating anything correctly; estimates (1) and
(2) are still wrong and are not corrected here.

Output is **identical**: `LENGTH(x) = 2` already subsumes `x IS NOT NULL` and `x <> ''`.
Verified by full symmetric-difference parity against the pre-change contents —
**325 rows before and after, 0 rows in either direction, identical `SUM(total_usd)`
(2,197,387,010.00).**

**Part 2 — bound any unit from outside.** `enforce_derived_mvs_unit_budget()` on a 2-minute
pg_cron job cancels a unit that outlives its budget (default **900 s**, GUC-overridable). The
cancel lands in FIX-1021's existing `WHEN query_canceled` handler, which names the unit and
closes the row `partial`.

### Why not `SET LOCAL statement_timeout` — re-verified, not assumed

```
NOTICE:  B: statement_timeout after SET LOCAL = 2s
NOTICE:  C: pg_sleep(8) COMPLETED — SET LOCAL did NOT bound the unit
NOTICE:  D: statement_timeout after plain SET = 2s
NOTICE:  E: pg_sleep(8) COMPLETED — plain SET did NOT bound the unit
```

`statement_timeout` is armed once, in `start_xact_command()`, from the value in force when the
`CALL` arrives. A procedure's internal `COMMIT` goes through `SPI/_SPI_commit`, which never
re-arms it — `current_setting()` reports the new value while the real timer keeps the old
deadline. Same finding FIX-703 paid for in 2026-07; still true on PG 17. pg_cron cannot work
around it either: `SET …; CALL …` fails with *invalid transaction termination*, because
pg_cron wraps a multi-statement command in one implicit transaction and the procedure's
`COMMIT` is then illegal. **A cancel from outside the backend is the only mechanism that can
interrupt a running unit.**

## 7. Post-fix weekly cadence on the clone

Units 4–6 had **never been measured** — the FIX-1021 instrumentation shipped 08-13 and the
run that would have recorded them died.

| unit | seconds |
|---|---|
| `chord_industry_flows_mv` | 26.5 |
| `chord_donor_type_party_flows_mv` | 20.0 |
| **`chord_donor_state_party_flows_mv`** | **18.7** ← was unbounded; now 3rd fastest |
| `chord_subject_party_flows_mv` | 1.2 |
| `official_sector_dollars_mv` | 3.2 |
| `refresh_spending_totals` | 15.7 |
| **6/6 units, `complete`, 85 s total** | |

The clone runs ~7× faster than prod on these units (prod 189/143 s where the clone is
26.5/20.0 s), so the prod-equivalent worst unit stays ~263 s. **No weekly unit comes within an
order of magnitude of the 900 s per-unit budget**, which is why that value can be chosen
rather than guessed.

## 8. Forced-timeout proof

Weekly cadence run with `civitics.derived_mvs_unit_budget_seconds = 5`:

```
watchdog: {"action": "canceled", "unit": "chord_industry_flows_mv", "signaled": true,
           "budget_seconds": 5, "unit_age_seconds": 6.7, "pid": 13268}
procedure: WARNING: [derived-mvs] chord_industry_flows_mv — CANCELED …
           NOTICE:  [derived-mvs] PARTIAL (cadence=weekly) — 0/6 units ok (5 skipped, 7s)
```

Closed row: `status='partial'`, `error_message` names the unit, metadata carries
`canceled: true`, `watchdog_canceled_unit`, `watchdog_unit_age_seconds: 6.7`, and all five
skipped units by name. **No stranded `running` row.** Subsequent watchdog polls returned
`no running refresh_derived_mvs` — the cancel-once guard held and did not touch the
procedure's own bookkeeping.

## 9. Open / not done here

- Statistics (1) and (2) are **still wrong**. The durable follow-up is
  `CREATE STATISTICS` on `(LENGTH(metadata->>'state'))` and an `n_distinct` override on
  `financial_relationships.from_id`. Deliberately **not** shipped here: both need an `ANALYZE`
  to take effect and both change plan choice prod-wide, which is a blast radius this session's
  mandate does not cover. The fence works regardless of them.
- The OOM-vs-other question for the 08-13 crash remains formally open — the Memoize 256 MB
  allocation is OOM-*consistent* but the kernel OOM killer logs outside postgres.
- Analytics retention (~7 days) means onset cannot be dated from logs; the 08-11 03:00 index
  build is dated from the migration, not from a log line.

Cross-ref: FIX-1021, FIX-1018, FIX-1013, FIX-1028, FIX-1027, FIX-703, FIX-443, FIX-884,
FIX-1022, FIX-1024.
