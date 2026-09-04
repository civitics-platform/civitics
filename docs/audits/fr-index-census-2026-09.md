# `financial_relationships` index census — 2026-09-04

**Stats window: 6.60 days — 2026-08-29 07:21:57 UTC → 2026-09-04 21:48 UTC.**

This is the number every counter in this document has to be read against, and it
is shorter than the cc-104 read assumed. Establishing it took three reads,
because the obvious one lies:

| read | value | what it means |
|---|---|---|
| `pg_stat_database.stats_reset` | **NULL** | ambiguous — "never reset" *or* "discarded after a crash and the per-DB entry recreated fresh". Not evidence on its own. |
| `pg_stat_statements_info.stats_reset` | `2026-08-29 07:21:57+00` | pgss keeps an explicit reset timestamp that survives the recreate |
| `data_sync_log` triangulation | `n_tup_ins = 626` vs 2,690 rows since 2026-04-22, and **633 rows inserted since 2026-08-29** | corroborates 08-29 independently of pgss |

So the cumulative statistics were discarded at the **2026-08-29 07:21 outage**,
and the 2026-08-31 23:01 restart was *clean* (stats survived it —
`n_tup_ins = 626` exceeds the 483 rows written since that restart).
`pg_postmaster_start_time()` is therefore **not** the window.

> **Rule this establishes.** `pg_stat_database.stats_reset = NULL` is not proof
> of a long window. Triangulate against `pg_stat_statements_info.stats_reset`
> **and** an insert-only table's `n_tup_ins` before treating any `idx_scan = 0`
> as evidence.

### What 6.6 days covers, and what it does not

Window = Sat 2026-08-29 → Fri 2026-09-04. Firings inside it, from
`cron.job_run_details`:

| cadence | covered? |
|---|---|
| `*/15`, `*/30`, daily, twice-daily | yes (569 / 142 / 6 / 14 firings) |
| weekly Mon (jobid 38, 39) | yes — 1 |
| weekly Tue (12, 17, 25, 26) | yes — 1 each |
| weekly Thu (28) | yes — 1 |
| monthly day-1 (14, 15, 18, 19, 23) | yes — 1 each (2026-09-01) |
| **weekly Tue 00:47 — jobid 10 `refresh-derived-mvs-weekly`** | **NO — zero firings.** It refreshes four FR-reading matviews. |
| **manual-only pipelines** — `usaspending-bulk`, `irs990`, `fec-bulk` | **NO, and no window can guarantee it.** |

The last two rows are why the classification predicate below is keyed on
**role first, callers second, counters last**, and why the 14-day floor for
Class C is not negotiable on a 6.6-day window.

---

## Class predicate

- **A — CONSTRAINT.** `indisprimary`, or `indisunique` and backing an
  `ON CONFLICT` arbiter / a `pg_constraint` row / a live uniqueness invariant.
  Never a drop candidate. `idx_scan` never counts uniqueness enforcement, so a
  UNIQUE arbiter at 0 scans is doing its job invisibly.
- **B — CALLER-USED.** A corpus query's prod `EXPLAIN` uses it. Keep.
- **C — UNREFERENCED.** No caller **and** `idx_scan = 0` over a window of at
  least 14 days; *or* structurally redundant (exact duplicate / strict
  leading-column prefix of a sibling with the same partial predicate and no
  INCLUDE the sibling lacks) regardless of window; *or* its column is dead in the
  data. Drop candidate.
- **D — UNDECIDED.** No caller, but the window is under 14 days or has not
  covered the caller's cadence. **HOLD with a dated re-read. Never dropped on
  this pass.**

---

## The class table — 19 indexes, 7,184 MB (prod, 2026-09-04)

Heap 4,932 MB; indexes 7,184 MB across 19. Sizes are prod
`pg_relation_size`; `idx_scan` is over the 6.6-day window above.

| # | index | prod size | idx_scan | class | evidence |
|---|---|---|---|---|---|
| 1 | `_derivation` | 1157 MB | 1,844,911 | **B** | The most-scanned index on the table. Fallback path for every `relationship_type`-leading shape. |
| 2 | `_donor_rollup_idx` | 958 MB | 687,717 | **B** | C15 gives an `Index Only Scan`. Donor rollup (jobid 24, twice daily). |
| 3 | `_relcycle_unique` | 877 MB | 2,562,966 | **A** | UNIQUE. The upsert arbiter: `REL_CONFLICT = [relationship_type, from_id, to_id, cycle_year]`, `packages/data/src/pipelines/fec-bulk/writer.ts:886`, executed by `direct-pg-upsert.ts`. Also C19. |
| 4 | `_donation_size_rollup` | 621 MB | 1,654,973 | **B** | C4 and C16 give `Index Only Scan`. FE totals crawl (jobid 46, `*/30`). |
| 5 | `_agency_spend_lateral` | 577 MB | 133 | **B** | C14 gives an `Index Only Scan`. `get_jurisdiction_page_live` / `get_agency_page_live` LATERAL top-100; staffing rollup (jobid 25, weekly Tue). |
| 6 | `_pkey` | 573 MB | **0** | **A** | PRIMARY KEY — `pg_constraint.contype = 'p'`. `DROP INDEX CONCURRENTLY` cannot drop it. Not a candidate at any scan count. |
| 7 | `_usaspending_unique` | 518 MB | **0** | **A** | UNIQUE, and the live `ON CONFLICT (usaspending_award_id)` arbiter — `conflictColumns: ["usaspending_award_id"]`, `packages/data/src/pipelines/usaspending-bulk/writer.ts:291`. 3,908,902 non-NULL rows. Zero scans **because USASpending bulk is manual-only and did not run in the window** — exactly the case the role-first ordering exists for. |
| 8 | `_from` | 460 MB | 194,583 | **B** | Not a prefix of `_derivation` (which leads with `relationship_type`). |
| 9 | `_donor_rollup_dirty_idx` | 267 MB | 11 | **B** | C11 gives an `Index Only Scan`. The incremental dirty set; the low scan count is the cadence, not disuse. |
| 10 | `_treemap_global_rollup` | 256 MB | 41,949 | **B** | C17 gives an `Index Only Scan`. FIX-1142, built 2026-09-04. |
| 11 | `_to` | 207 MB | 55,283 | **B** | C1 and C3 — the two highest-call PostgREST shapes. |
| 12 | `_amount` | 198 MB | 526 | **B** | C8/C25 give an `Index Scan`. Caller found: **`get_official_page`**, whose spending block is *globally* scoped by design — `WHERE relationship_type IN ('contract','grant') AND amount_cents > 0 ORDER BY amount_cents DESC LIMIT 10`, with no official predicate ("faithfully NOT official-filtered, as the page's query isn't"). Request path. |
| 13 | `_updated_at` | 194 MB | 968 | **B** | C13 gives an `Index Only Scan`. The whole-table watermark read; `_donor_rollup_dirty_idx` and `_contract_grant_updated_at` are both narrower and cannot serve it. |
| 14 | `_type` | 157 MB | 1,011 | **B** *(was C by structure — pulled by the rehearsal)* | Structurally a **strict leading-column prefix of two siblings** (`_derivation`, `_relcycle_unique`), so Class C on the letter of the predicate. The clone rehearsal pulled it: see below. Caller = **`ec_arm_source_fingerprint`**, three arms, on jobid 45 `ec-crawl` `*/15`. |
| 15 | `_cycle` | 133 MB | **0** | **D** | `cycle_year` is live in the data (10,636,985 non-NULL) but **no caller reads it as a leading key**. The only live reference is `promote_candidate_to_elected`'s `c.cycle_year IS NOT DISTINCT FROM e.cycle_year`, a tuple match, not a `cycle_year`-leading lookup. C9 proves the index *works* when a query wants it; nothing wants it. **Window is 6.6 days, so HOLD, not drop.** |
| 16 | `_contract_grant_updated_at` | 27 MB | 29 | **B** | C7b and C12 give an `Index Only Scan`. FIX-1118. Beats `_type` for the contract/grant arm precisely because it is the narrower partial. |
| 17 | `_started_at` | 16 kB | **0** | **D** | 1 non-NULL row of 14,545,887. No index-driven caller: the two live readers (`rebuild_entity_connections_holds`, `rebuild_entity_connections_lobbying`) use `MIN(fr.started_at)` / `ARRAY_AGG(... ORDER BY fr.started_at)` *inside* an already-filtered group. **But the column has a writer** — `started_at` is in `REL_COLUMNS`, `fec-bulk/writer.ts:879`, under a CHECK requiring exactly one of `occurred_at` / `started_at`. Live column, unreferenced index, so D and not C. |
| 18 | `_disclosure_unique` | 16 kB | **0** | **A + B** | 54 non-NULL rows. UNIQUE, and the irs990 writer's dedup invariant — it *writes* `disclosure_form_id` as the dedup key (`irs990/writer.ts:564`) and *reads* it back as a pre-check, `.in("disclosure_form_id", ...)` in 200-row chunks (`irs990/writer.ts:544`). C10 gives an `Index Only Scan`. Zero scans is the cadence (irs990 is manual-only), not disuse. |
| 19 | `_fec_filing_unique` | 8192 B | **0** | **C** | **Dead column.** `count(fec_filing_id) = 0` on prod *and* on the clone. Zero references in `pg_proc.prosrc`, zero in `pg_matviews`, zero in `apps/` or `packages/` outside the generated `database.ts`. No `ON CONFLICT (fec_filing_id)` anywhere. The UNIQUE index enforces an invariant over an empty set that nothing writes to. |

### The cc-104 "six never scanned, ~1,224 MB" reading

The six are rows 6, 7, 15, 17, 18, 19 above, and the arithmetic is right —
573 + 518 + 133 MB + 40 kB is about 1,224 MB. The **conclusion** is not:

- `_pkey` (573 MB) is the PRIMARY KEY. Undroppable and undebatable.
- `_usaspending_unique` (518 MB) is a live `ON CONFLICT` arbiter.
- Together those are **1,091 MB — 89% of the "unused" bytes — doing invisible
  work.**

What is actually loose is `_cycle` (133 MB) plus 40 kB of tiny indexes, and
`_cycle` is held by the window, not released by it.

---

## Caller corpus, cadence, and index

25 shapes, enumerated from four sources unioned and deduped: `pg_stat_statements`
rows touching FR (top 40 by `calls` and by `total_exec_time`); every
`pg_proc.prosrc` / `pg_matviews.definition` in the **live catalog** referencing FR
(76 functions, 6 matviews, 0 views); `packages/data` / `apps/civitics` direct
queries; and the scheduled set from `cron.job`. Each row is one prod
`EXPLAIN (COSTS OFF)` with literal parameters taken from real rows.

| # | caller | cadence | index used |
|---|---|---|---|
| C1 | PostgREST `to_type+to_id+rt` to `from_id` (1,220 calls) | request path | `_to` |
| C2 | PostgREST `from_type+from_id+rt ORDER BY amount_cents DESC` (1,215) | request path | `_donation_size_rollup` + Sort |
| C3 | PostgREST `to_type+to_id+rt=ANY ORDER BY amount_cents DESC` (1,206) | request path | `_to` + Sort |
| C4 | PostgREST `rt+from_type+from_id=ANY(...)` (48) | request path | `_donation_size_rollup` |
| C5 | PostgREST bare `SELECT * LIMIT/OFFSET` (258 calls, 338.9 ms mean) | request path | **Seq Scan** — see follow-ups |
| C6 | `official_homepage_stats_mv` defining query | jobid 9, daily 06:00 | **Parallel Seq Scan** — see the measurement below |
| C7 | `relationship_type` alone | audit-origin | `_type` (IOS) |
| C7b | `relationship_type IN ('contract','grant')` | jobid 45, `*/15` | `_contract_grant_updated_at` (IOS) |
| C8 | global `ORDER BY amount_cents DESC LIMIT` | request path | `_amount` |
| C9 | `cycle_year = 2024` | **no caller** | `_cycle` (IOS) — proves it works; nothing calls it |
| C10 | irs990 writer dedup pre-check | manual | `_disclosure_unique` (IOS) |
| C11 | dirty set `updated_at > wm`, official from FE donation/ie | jobid 24, twice daily | `_donor_rollup_dirty_idx` (IOS) |
| C12 | `max(updated_at)` contract/grant | jobid 45, `*/15` | `_contract_grant_updated_at` (IOS backward) |
| C13 | `updated_at > wm`, whole table | watermark reads | `_updated_at` (IOS) |
| C14 | agency lateral spend top-N | request path + jobid 25 | `_agency_spend_lateral` (IOS) |
| C15 | donor rollup `to_id + rt + from_id` | jobid 24, twice daily | `_donor_rollup_idx` (IOS) |
| C16 | FE donation size rollup | jobid 46, `*/30` | `_donation_size_rollup` (IOS) |
| C17 | treemap global chunk | jobid 26, weekly Tue | `_treemap_global_rollup` (IOS) |
| C18 | `usaspending_award_id` lookup | manual | `_usaspending_unique` |
| C19 | relcycle arbiter probe | every FR upsert | `_relcycle_unique` |
| C20 | `id` lookup | request path | `_pkey` |
| C21 | `started_at IS NOT NULL ORDER BY started_at DESC` | **no caller** | `_started_at` — proves it works; nothing calls it |
| C22 | `ec_arm_source_fingerprint` gifts arm | jobid 45, `*/15` | `_type` |
| C23 | `ec_arm_source_fingerprint` holds arm | jobid 45, `*/15` | `_type` |
| C24 | `ec_arm_source_fingerprint` lobbying arm | jobid 45, `*/15` | `_type` |
| C25 | `get_official_page` global top-10 spending | request path | `_amount` |

---

## Clone rehearsal — 2026-09-04, local Docker (10.4M rows, same 19 indexes)

Baseline: all 25 shapes explained. Then `_fec_filing_unique` and `_type` dropped,
all 25 re-explained.

**`_fec_filing_unique` — zero plan changes.** Stays in the set.

**`_type` — four shapes moved, and it is pulled from the set:**

| shape | before | after |
|---|---|---|
| C7b `rt IN ('contract','grant')` | `_type` | `_contract_grant_updated_at` (27 MB — *smaller*, not a degradation) |
| C22 `ec_arm_source_fingerprint` gifts | `_type` | **`_relcycle_unique`** |
| C23 `ec_arm_source_fingerprint` holds | `_type` | **`_relcycle_unique`** |
| C24 `ec_arm_source_fingerprint` lobbying | `_type` | **`_relcycle_unique`** |

`_relcycle_unique` is **877 MB on prod against `_type`'s 157 MB, so 5.6x** — and
these three probes run every 15 minutes on jobid 45. That is the
"a different, larger index" degradation, so `_type` moves to **Class B, caller
`ec_arm_source_fingerprint`**. The structural redundancy is real (the planner
*can* take a sibling; note it takes `_relcycle_unique`, not the `_derivation`
one would guess) — it is just not free. `ec_arm_source_fingerprint`'s own comment
already documents the property being relied on: *"Three of these four carry zero
rows today, which is why they probe in 20–35 ms: the bitmap index scan finds
nothing and there is no heap to fetch."*

`_type` was recreated on the clone and the corpus re-verified: **with only
`_fec_filing_unique` dropped, all 25 plans are identical to baseline.**

---

## The drop set

| index | prod size | class | recreate DDL (saved before the drop) |
|---|---|---|---|
| `financial_relationships_fec_filing_unique` | 8192 bytes | C — dead column | `CREATE UNIQUE INDEX financial_relationships_fec_filing_unique ON public.financial_relationships USING btree (fec_filing_id) WHERE (fec_filing_id IS NOT NULL);` |

One index, 8 kB. **The honest summary of this census is that the bytes are not
available**: 89% of the apparent slack is two constraints, and the only
byte-significant unreferenced index (`_cycle`, 133 MB) is held by the window.

Executed out-of-band by `scripts/fix1133-drop-fr-indexes.mjs`;
`supabase/migrations/20260904030000_fix1133_drop_dead_fr_indexes.sql` carries the
idempotent `DROP INDEX IF EXISTS` as the real path for local and any
rebuilt-from-zero environment.

### Prod execution — 2026-09-04, 22:1x UTC

Run out-of-band via `scripts/fix1133-drop-fr-indexes.mjs` (dry-run first, then
the real pass), inside the 18:00-01:00 UTC slack window.

Pre-flight, all clean: zero transactions older than 60 s, zero cron jobs in
`running`, jobid 38 not due (Mondays), and the constraint-abort guard passed
(no `pg_constraint.conindid` row for the target). Recreate DDL printed before
the drop.

| | before | after |
|---|---|---|
| FR index count | 19 | **18** |
| FR index bytes | 7,532,675,072 (7,184 MB) | 7,531,126,784 (7,182 MB) |

The 1,548,288-byte delta is larger than the 8,192-byte index because the table
takes writes continuously between the two reads; only the index-count change is
cleanly attributable.

`psql` wall clock 0.8 s. Post-drop `pg_index` no longer lists the target, and
**all 25 corpus shapes re-EXPLAINed on prod are identical to the pre-drop
plans** — including C22/C23/C24 still on `_type` and C25 still on `_amount`.
`n_tup_hot_upd` remains 0; `n_dead_tup` remains 0.

## The hold set — re-read on or after **2026-09-12**

| index | prod size | why held |
|---|---|---|
| `_cycle` | 133 MB | no caller, 0 scans, window 6.6 d |
| `_started_at` | 16 kB | no index-driven caller, 0 scans; column has a writer |

**133 MB total — below the 500 MB bar for its own FIX bullet, so it lives here.**

The re-read date is the later of two constraints measured from
`stats_reset = 2026-08-29 07:21:57`:

1. window of at least 14 days, so **2026-09-12 07:21 UTC**
2. one firing of every cadence in the caller table. The only uncovered scheduled
   cadence is jobid 10 (weekly Tue 00:47), next firing **2026-09-08**.

**Before trusting the re-read, re-check `pg_stat_statements_info.stats_reset`.**
If it has moved past 2026-08-29, the window restarted and the clock restarts with
it. Manual-only pipelines (`usaspending-bulk`, `irs990`, `fec-bulk`) are *never*
covered by any date — which is why rows 7, 18 and 19 are decided on role and on
column liveness, not on counters, and always must be.

## Write amplification

| metric | value |
|---|---|
| `n_tup_ins` / `n_tup_upd` / `n_tup_del` | 37,838 / 187,000 / 936 |
| `n_tup_hot_upd` | **0** |
| `relallvisible / relpages` | 631,265 / 631,265 = **100.00%** |
| `n_dead_tup` | 0 (last vacuum 2026-09-02 00:13) |

Zero HOT updates is **structural, not incidental**, and the census cannot fix it:

- `financial_relationships_updated_at` is a `BEFORE UPDATE FOR EACH ROW` trigger
  running `set_updated_at()`. Every UPDATE therefore changes `updated_at`.
- `updated_at` is indexed **three times** (`_updated_at`,
  `_donor_rollup_dirty_idx`, `_contract_grant_updated_at`), and all three are
  Class B.
- Independently, the upsert `DO UPDATE SET` list is `REL_COLUMNS` minus
  `REL_CONFLICT` — `from_type, to_type, amount_cents, occurred_at, started_at,
  ended_at, source_url, metadata` — of which `from_type`, `to_type` and
  `amount_cents` are all indexed.

So HOT is unreachable while the trigger and any one `updated_at` index both
exist. Nothing is filed against it: no `updated_at` index is Class C. The
existing mitigation is FIX-1008's `DO UPDATE SET ... WHERE (any SET column
actually differs)` guard, which suppresses the no-op UPDATE entirely.

One correction to the FIX-1133 premise: the three tiny indexes are **not**
meaningful write targets. All three are partial over near-empty predicates
(`fec_filing_id IS NOT NULL` = 0 rows, `started_at IS NOT NULL` = 1,
`disclosure_form_id IS NOT NULL` = 54), so an ordinary INSERT never gets an entry
in them. They are 3 of 19 *vacuum sweeps*, but a sweep of an 8 kB index is
microseconds. FR's vacuum cost is dominated by the five indexes over 500 MB, and
those are Class A or Class B without exception.

## Vacuum baseline and the receipt

jobid 38 `fr-vacuum-analyze`, schedule `0 1 * * 1` — **Monday 01:00 UTC**.

| firing | duration |
|---|---|
| 2026-08-31 | 227.2 s |
| 2026-08-24 | 20.3 s |
| 2026-08-17 | 97.8 s |

The after-receipt is the **next scheduled firing, 2026-09-07 01:00 UTC** — not an
ad-hoc VACUUM, which is FIX-1133's own first lesson. With an 8 kB index removed
the expected delta is nil; the receipt's value is the baseline itself, for the
day the hold set is re-read and a 133 MB index may actually leave.

## The homepage-MV covering-index question — measured, not built

`official_homepage_stats_mv`'s FR scan is
`SELECT to_id, count(*) FILTER (...), count(*), sum(amount_cents) FILTER (...) FROM
financial_relationships WHERE to_type = 'official' GROUP BY to_id` — no `to_id`
predicate, so it reads every `to_type = 'official'` row. Prod plan: **Parallel
Seq Scan**, filter `to_type = 'official'`. It does **not** ride `_derivation`, as
the FIX-1133 premise guessed.

Candidate measured on the clone:
`(to_id) INCLUDE (relationship_type, amount_cents) WHERE to_type = 'official'`,
built at 200 MB over 4,219,115 rows (prod would be about 250 MB).

| plan | buffers (hit + read) | reads | time |
|---|---|---|---|
| Parallel Seq Scan (planner's choice) | 442,306 | 431,714 | 1,543.7 ms |
| Parallel Index Only Scan on the candidate | 182,716 | **36,828** | 628.8 ms |
| ratio | 2.42x | **11.72x** | 2.45x |

The read win clears the 3x bar, **but the planner will not take the plan.** With
the candidate index present it still chose the seq scan; with
`enable_seqscan = off` it chose a Bitmap Heap Scan on `_to` (315,773 reads,
4,456 ms — *worse than the seq scan*); only `enable_seqscan = off` **and**
`enable_bitmapscan = off` produced the index-only plan. Building the index alone
would add about 250 MB to a 19-index table, one more sweep to every vacuum, and
change nothing at runtime.

Filed as a FIX with these numbers. The work is not "add a covering index" — it is
"add it *and* make the refresh take it", which is a costing or query-shape change
and a different piece of work. Not built here.

## Follow-ups noticed, not done

- **`_usaspending_unique` is a full index over a 73%-NULL column.** 518 MB for
  3,908,902 non-NULL values out of 14,545,887 rows. A partial
  `WHERE usaspending_award_id IS NOT NULL` would be roughly a quarter the size,
  but `ON CONFLICT (usaspending_award_id)` cannot infer a partial index unless
  the statement carries a matching `WHERE` in its conflict target — so this is a
  writer change, not an index change. Not a census action.
- **C5: PostgREST is serving bare `SELECT * FROM financial_relationships LIMIT n
  OFFSET m`** — 258 calls at 338.9 ms mean (87.4 s total) in the window, every
  one a Seq Scan. Worth finding the caller.
- **`_derivation` at 1,157 MB has 1.84M scans but only 2.79M `idx_tup_fetch`
  against 71.8M `idx_tup_read`** — a 26:1 read-to-fetch ratio suggesting most of
  its scans are wide range probes. Possibly a narrower sibling would serve them,
  but that is an index *build* question, out of scope here.
