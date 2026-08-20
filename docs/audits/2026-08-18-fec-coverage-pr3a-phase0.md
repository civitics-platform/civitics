# FEC coverage arc — PR 3a shipped, phase-0 floor measurement

**Date:** 2026-08-18 · **FIX:** FIX-961 (PR 3a) · **Scope:** local measurement only, no prod writes

Two things are recorded here:

1. **PR 3a shipped** — the indiv stage's in-memory aggregation maps are replaced by an
   external sort. No semantics changed; equivalence was proved against the old path.
2. **The phase-0 measurement** that PR 3b's go/no-go reads: how much disclosed money
   today's **$200 per-transaction** floor discards, and what a **$200 aggregate** floor
   would emit instead.

> **Missing referenced document.** The prompt for this work cites
> `claude/audit-fec-coverage-2026-07-29.md` (§2, §5, "Queued — PR 3"). No such file exists
> in `App/docs/audits/`, `Claude/civitics/`, or anywhere under `Civitics/` — a repo-wide
> search for its distinguishing strings (`by_size`, "coverage arc", "Queued — PR 3") hits
> only the prompt files themselves. This document is therefore written to stand alone and
> is filed under the repo's actual audit convention (`docs/audits/YYYY-MM-DD-*.md`) rather
> than as an addendum to a doc that is not in the tree. If the coverage audit exists
> outside the repo, link this from it.

---

## 1. PR 3a — external-sort aggregation (FIX-961)

### What changed

`streamIndiv` built three `Map`s sized O(distinct groups) and held them for the whole
cycle. That is what OOM'd. It now projects each surviving row into two compact sorted
records, partial-aggregates them in a bounded buffer, spills gzip'd sorted runs, and
reduces them with a k-way merge (`packages/data/src/lib/external-sort.ts`).

The `$200` per-transaction floor stays exactly where it was, applied at parse time.
Moving it is PR 3b.

Consumers in `fec-bulk/index.ts` moved from `for (… of map.values())` to
`for await (… of result.readX())`. One structure disappeared outright: the
`cycleDonorTotals` map (one entry per donor) is now a merge-join between the two
fingerprint-sorted files, done inside the stage.

The old accumulator is still callable as `FEC_INDIV_AGG_MODE=memory`. PR 3b retires it.

### Equivalence

`pnpm --filter @civitics/data data:fec:indiv-equivalence` runs each accumulator **in its
own process** and diffs every emitted set. First 5M lines of cycle-2026 `indiv26`, real
`ccl26`/`cm26` recipient sets, sort buffer 25k (12 agg + 11 meta runs — a genuine
multi-run merge):

| metric | `memory` | `external` |
|---|---:|---:|
| donor × candidate groups | 138,206 | 138,206 |
| donor × committee groups | 102,497 | 102,497 |
| donor rows | 193,708 | 193,708 |
| Σ candidate cents | 15,463,984,400 | 15,463,984,400 |
| Σ committee cents | 42,265,130,300 | 42,265,130,300 |
| Σ candidate txCount | 153,671 | 153,671 |
| Σ committee txCount | 132,312 | 132,312 |
| Σ donor totalCents | 57,729,114,700 | 57,729,114,700 |

**Per-key divergences: 0.** Same keys, same sums, same tx counts, same latest dates, same
donor rows and totals.

### End-to-end, against rows the OLD path already wrote

The harness diffs the stage in isolation. The pipeline's own consumption path
(`index.ts`: four sequential re-reads of the sorted files, the merge-join for donor
inputs, `dispose()` in a `finally`) needed exercising too, so a scoped run went through
the real pipeline against the local Docker DB:

```
FEC_CYCLES=2026 FEC_INDIV_CYCLES=2026 FEC_INDIV_RECIPIENT_CMTES=C00718866 \
  NODE_OPTIONS=--max-old-space-size=2048 pnpm --filter @civitics/data data:fec-bulk
```

Result: `Aggregation mode: external`, 19,441 donors, 19,441 donor × candidate pairs,
0 committee pairs (correct — C00718866 is candidate-authorized, so it routes
candidate-only), peak RSS 494 MB, 0 failures.

The load-bearing line is the writer's:

```
indiv-donation: 0/19,441 rows actually written (19,441 unchanged, skipped) (FIX-1008)
```

The local DB already held those rows from **old-path** runs — 19,441 rows for
`S8GA00180`, `updated_at` spanning 2026-07-30 to 2026-08-09, `sum(amount_cents)` =
1,624,733,800. The new path reproduced all 19,441 rows with values identical enough that
the FIX-1008 skip-overwrite comparator changed nothing, and `updated_at` did not move.
That is equivalence against real persisted output from the old accumulator, through the
writers, at a different point in time — a stronger check than the in-process diff.

It also cross-checks the phase-0 numbers below: §2.3's "FR rows emitted today" figure
(19,441 rows / $16,247,338) is exactly the persisted row count and dollar total, derived
by a completely separate script.

Caveat: at 19,441 groups this run stayed under the 400k buffer and took the
single-buffer fast path (`0 agg + 0 meta` runs), so it did **not** exercise the k-way
merge end-to-end. The merge is covered by the harness (up to 81+74 runs on the full file)
and by unit tests, but the first pipeline run to merge for real will be the phase-4
indiv20 backfill.

### Memory and disk

Full cycle-2026 file: 30,632,248 lines, 5,401 MB extracted, 2,105,550 rows past the $200
floor → 879,782 donors, 762,891 + 553,717 pairs.

| config | outcome | stage peak RSS | heap peak | runs (agg+meta) | peak sort disk | stream |
|---|---|---:|---:|---:|---:|---:|
| `memory`, heap 2048 MB | **OOM, exit 134** | — | — | — | — | — |
| `external`, heap 2048, buffer 400k | ✅ | 2,256 MB | 1,604 MB | 5+3 | 111.6 MB | 91 s |
| `external`, heap 1024, buffer 100k | ✅ | 900 MB | 634 MB | 20+17 | 133.8 MB | 86 s |
| `external`, heap 512, buffer 25k | ✅ | 424 MB | 206 MB | 81+74 | 142.9 MB | 93 s |

All three external configs emit identical results across a **5.3× range of resident
memory at flat wall-clock**. Peak memory tracks the sort buffer, not the cycle — a bigger
file adds runs, not resident bytes. That is the property the old path did not have.

Sort disk is now the resource to size: ~2% of extracted-text size. The extracted text is
unlinked before the merge starts, so the two peaks do not overlap; a presidential cycle's
~13 GB extract implies ~300 MB of runs against the GHA runner's ~14 GB free disk.

### Implementation note — the bug this found

The first cut framed lines as `key \t payload` and split at the first tab, while the indiv
aggregate key was itself tab-separated (`fp \t route \t recipient`). That does not throw
and does not corrupt the file: it silently regroups by a **prefix** of the intended key.
The equivalence run caught it — 240,703 aggregate groups vanished and the survivors summed
across recipients.

Two defences shipped: composite keys use `KEY_FIELD_SEP` (0x1F), and the sorter asserts
the first key added on every instance regardless of the `validateKeys` setting, because a
framing error is systematic — wrong on record #1 or never. Both are covered by tests.

---

## 2. Phase-0 measurement — the $200 floor

### 2.1 What the floor actually discards

FEC's itemization rule is per-donor **cycle aggregate**, not per transaction: once a
contributor passes $200 cumulative, every later contribution is itemized *however small*.
So `indiv{yy}.zip` contains a large population of disclosed sub-$200 rows. Our
per-transaction floor drops all of them.

Three distinct populations, which the discussion so far has conflated:

| population | in the bulk file? | today | PR 3b |
|---|---|---|---|
| aggregate ≥ $200, ≥1 tx ≥ $200 | yes | emitted, **amount understated** | emitted, correct amount |
| aggregate ≥ $200, no tx ≥ $200 | yes | **dropped entirely** | emitted (new FR rows) |
| aggregate < $200 | yes | dropped | bucketed by size bracket |
| truly unitemized (donor never passes $200) | **no** | n/a | n/a — unrecoverable |

### 2.2 FEC `by_size` — Ossoff C00718866

`api.open.fec.gov/v1/schedules/schedule_a/by_size/?committee_id=C00718866&cycle=2026`:

| bucket | count | total |
|---|---:|---:|
| size 0 (under $200) | null | $52,958,614.87 |
| size 200 ($200–499) | 14,868 | $3,837,061.41 |
| size 500 ($500–999) | 7,928 | $4,051,804.96 |
| size 1000 ($1k–2k) | 4,527 | $4,854,035.61 |
| size 2000 ($2k+) | 3,500 | $10,885,451.93 |

**Do not quote `by_size` as the floor split.** Its buckets do not reconcile: the four
itemized buckets sum to $23,628,354 and size-0 to $52,958,615, total $76.59M, against the
totals endpoint's `individual_contributions` of $67.76M. Size 0 also mixes truly
unitemized money with sub-$200 *itemized* rows, which are the only recoverable part.

The endpoint that **does** reconcile is `/committee/C00718866/totals/?cycle=2026`:

- `individual_itemized_contributions`: **$28,654,210.06**
- `individual_unitemized_contributions`: $39,110,515.04
- `coverage_end_date`: 2026-06-30 (JULY QUARTERLY)

Our floor-off pass over the same committee's rows in `indiv26` totals **$28,623,243** —
within **0.11%** of FEC's itemized figure. That agreement is what makes the numbers below
trustworthy; the residual gap is our org-shape guard (2 rows) and tx-type scope.

### 2.3 Ossoff C00718866, cycle 2026 — floor off

Run with the PR 3a machinery (`data:fec:phase0-floor --committee C00718866`), whole file,
no amount filter. One row here = one `financial_relationships` row.

| | rows | dollars |
|---|---:|---:|
| FR rows emitted **today** (≥1 tx ≥ $200) | 19,441 | $16,247,338 |
| …their **true** cycle aggregate | | $17,905,631 |
| …**understated today** | 5,884 rows (30.3%) | **$1,658,293** (9.3% of their real total) |
| **NEW** FR rows under PR 3b (agg ≥ $200, no tx ≥ $200) | **19,532** | **$7,938,864** (from 210,189 tx rows) |
| Residual (agg < $200) — bucketed, not emitted | 29,551 | $2,778,748 |
| — $0.01–$49.99 | 4,777 | $139,732 |
| — $50–$99.99 | 8,718 | $566,802 |
| — $100–$199.99 | 16,056 | $2,072,214 |

- FR rows **19,441 → 38,973 (+100.5%)**
- Dollars captured **$16.25M → $25.84M (+59.1%)**
- Against FEC's itemized $28.65M: we capture **56.7%** today, **90.2%** under PR 3b.
- The $39.11M unitemized is not in the file and stays out of reach under any rule.

### 2.4 Platform-wide, cycle 2026 — measured, not extrapolated

Same pass with `--all` (every ccl P/A recipient ∪ non-candidate committee set), whole
file: 30,632,248 lines, 22,151,720 in scope, **21,377,129 rows kept with the floor off**
vs 2,105,550 with it on — the floor discards **90.2% of in-scope rows**.

| | rows | dollars |
|---|---:|---:|
| FR rows emitted **today** | 1,316,608 | $4,074,508,705 |
| …their **true** cycle aggregate | | $4,143,577,620 |
| …**understated today** | 201,489 rows (15.3%) | **$69,068,915** (1.7%) |
| **NEW** FR rows under PR 3b | **664,178** | **$412,638,554** (from 13,804,866 tx rows) |
| Residual (agg < $200) — bucketed | 1,002,643 | $83,453,297 |
| — $0.01–$49.99 | 296,250 | $7,092,375 |
| — $50–$99.99 | 259,815 | $17,525,145 |
| — $100–$199.99 | 446,578 | $58,835,777 |

- **FR row growth: 1,316,608 → 1,980,786 (+664,178, +50.4%)** for cycle 2026.
- Dollars captured **$4.07B → $4.56B (+11.8%)**.
- Residual left unemitted: $83.5M, **1.8%** of in-file itemized dollars.

Cross-check: the 1,316,608 "today" baseline equals the PR 3a full-file run's aggregate
group count exactly, so this is the same population the pipeline emits, not a re-derivation.

### 2.5 Projection to the other loaded cycles — **extrapolation, read as a range**

Cycle 2026 is measured. The other cycles are not, and the multiplier is not constant:
small-dollar recurring giving (ActBlue/WinRed) is much heavier in presidential cycles, and
that is precisely the population the per-transaction floor drops. Ossoff's own by_size
shows the direction — 50,856 sub-$500 transactions in 2020 against 14,868 in 2026.

- **Lower bound: +50%** FR rows per cycle (the measured 2026 figure, applied unchanged).
- **Upper bound: +100%** (the measured Ossoff-2026 committee figure, treating a
  small-dollar-heavy campaign as representative of a presidential cycle's mix).
- Dollar growth is far smaller than row growth in both directions: **+12% to +60%**,
  because the newly-emitted rows are individually small.

Row growth is the cost driver, not dollars: PR 3b roughly **1.5–2× the
`financial_relationships` indiv row count per cycle**, plus up to 664,178 new
`financial_entities` donor rows for cycle 2026 alone (an upper bound — donors already
present from another recipient do not create a new entity). Everything downstream that
scales with FR row count needs sizing against that: the donor rollups, the treemap
brackets ([[FIX-965]], [[FIX-868]]), the chord MVs ([[FIX-966]], [[FIX-1030]]), and the
`entity_connections` donations arm. [[FIX-965]]'s bullet already warns that indiv20 will
grow the population further; PR 3b compounds it on every cycle at once.

### 2.6 Staleness (audit §5 item) — source side clear, prod side owed

| check | result |
|---|---|
| `indiv26.zip` Last-Modified | Sun, 16 Aug 2026 15:50:15 GMT (2 days old) |
| FEC `coverage_end_date`, C00718866 cycle 2026 | 2026-06-30 (JULY QUARTERLY) |
| max `TRANSACTION_DT` in our copy, C00718866 | 2026-06-30 — **exact match** |

The bulk source is current and our copy reaches FEC's coverage end date. **The prod half
is not verified here** — confirming that the *loaded* data reaches 2026-06-30 needs a prod
read, which is out of scope for this session; it is owed at the FIX-961 phase-4 backfill
verification.

Caveat for anyone re-running this: the platform-wide date span came back as
`20170622 … 33120101`. Those are filer typos in `TRANSACTION_DT`, not coverage. Scope the
staleness check to a single committee, or trust the FEC totals endpoint, not the file-wide
min/max.

---

## 3. Contradicted premises

1. **`claude/audit-fec-coverage-2026-07-29.md` does not exist** anywhere in the tree.
   See the note at the top.
2. **FIX-961's bullet is stale, and its candidate fix (a) was tried and failed.** The
   bullet records only the 12 GB OOM (run 30767905956, 2026-08-02, ~53M of ~69M lines) and
   lists "raise heap to ~13.5-14 GB" as a candidate. That was done — commit `8da5e209`
   raised `fec-backfill.yml` to `--max-old-space-size=14336` on 2026-08-02 — and run
   **30965259079** (2026-08-05 01:03 UTC, `cycles=2020`, confirmed running at 14336)
   OOM'd again at **~64M of ~69M lines**, ~93% of the way through. The prompt's "OOM'd a
   12 GB and then a 14 GB heap" is correct; the bullet has not caught up. Left unedited
   per the FIXES.md append-only contract.
3. **`by_size` is not a usable floor-vs-cutoff split** (§2.2). Its buckets do not
   reconcile with the totals endpoint and its size-0 bucket mixes recoverable with
   unrecoverable money. The totals endpoint reconciles with the file to 0.11%; use it.
4. **The stage is bounded, not free.** "O(1) in cycle size" is true of the live set but
   the sort buffer is a real floor — `external` at the default 400k buffer still OOMs
   under a 512 MB heap. Lower the buffer with the ceiling, not after it.

## 4. Reproduce

```bash
# from packages/data — no DB, no prod, local files only
pnpm --filter @civitics/data data:fec:indiv-equivalence \
  --txt <indiv.txt> --ccl <ccl.txt> --cm <cm.txt> --lines 5000000 --buffer 25000

pnpm --filter @civitics/data data:fec:phase0-floor \
  --txt <indiv.txt> --ccl <ccl.txt> --cm <cm.txt> --committee C00718866
pnpm --filter @civitics/data data:fec:phase0-floor \
  --txt <indiv.txt> --ccl <ccl.txt> --cm <cm.txt> --all
```

---

## 5. Addendum — phase-4 prod run and the 2026-08-18 API incident

### 5.1 The mechanism worked on the file that OOM'd twice

`fec-backfill` run **32097136492**, `cycles=2020`, on sha `51deff46`.

| | |
|---|---|
| indiv20.zip | 5,593 MB compressed → **13,109 MB extracted** |
| lines read | **69,377,425 — the whole file** (prior attempts died at 53M and 64M) |
| stream + external sort | **3m02s** (03:59:08 → 04:02:10) |
| **peak RSS** | **439 MB** — against a 14,336 MB heap that OOM'd |
| sort runs / disk | 12 agg + 9 meta · **288 MB** (projection was ~300 MB) |
| unique donors | 1,944,958 |
| donor × candidate pairs | 2,165,106 |
| donor × committee pairs | 1,149,355 |

FIX-961 is **mechanically resolved**: ~33× less memory, and the disk projection in §1
held. What did not finish is the *write* phase.

### 5.2 The write phase is the real ceiling — and it is not new

| stage | result |
|---|---|
| `donor-entities` | **complete** — 1,944,958 rows in 90m18s (~21,500/min), 1,162,416 new entities |
| `indiv-to-candidate` | **692,000 / 2,165,106** when SIGTERM'd at the 350-min cap |
| `indiv-to-committee` | not started |

The cand-rel stage opened at 20,300/min and decayed to 300–2,000/min. Cause is
cache starvation, not bloat: `financial_relationships` was **11.1M live / 94,729
dead (0.8%)** with heap cache hit **62.4%**, so each of the 2.1M upserts probes the
UNIQUE arbiter `(relationship_type, from_id, to_id, cycle_year)` on a random donor
UUID against indexes far larger than the 256 MB `shared_buffers`. Precedent confirms
this predates PR 3a: run `30769510735` (`cycles=2022`) hit the same 350-min cap on the
**old** code path — that is what FIX-962 was written about.

State is banked; a re-dispatch resumes (`fec_last_modified` is a frozen historical
file, so the FIX-754 precondition still matches). **Resume in a genuinely quiet
window** — the difference between 20,300/min and 600/min is entirely contention.

### 5.3 The incident: prod REST down 09:45–10:41 UTC (~56 min)

Public PostgREST returned `503 PGRST002` — schema cache unqueryable. Measured cause:
`refresh_treemap_individuals_global()` fired by pg_cron at 08:15 and was **still
running at 1h47m54s**, starving the box until the catalog query PostgREST needs
timed out (`pg_proc JOIN pg_namespace` → 57014 at 60,247 ms; `pg_timezone_names`
24,788 ms, later failing at 99,868 ms).

The scheduled path has **no effective `statement_timeout`** — FIX-965's 2400s figure
came from a *manual* `CALL` with the timeout set in-session, and per FIX-1056 an
in-procedure `SET statement_timeout` is decorative. Filed as **FIX-1063**.

Resolution: `pg_cancel_backend` on the treemap (catalog query 60s timeout → **28ms**
immediately), then on `refresh_financial_entity_totals_incremental` (1h31m58s);
PostgREST did not self-recover, so the project was restarted via the Management API
and REST returned 200 in 0.12–0.25s.

The FIX-961 backfill was already dead (09:44 cap) before the outage window closed and
was not the proximate cause, though its earlier load contributed to the cold cache.

### 5.4 Post-run verification

- **Both attribution detectors read CROSS-PERSON MISATTRIBUTION = 0 / $0.** ✅
- `VACUUM (ANALYZE)` tail discharged per FIX-943 (the run was SIGTERM'd before it
  could): `financial_entities` 299s (58,122 dead → 0), `financial_relationships`
  182s (94,729 dead → 0), both analyzed 10:48–10:51 — ahead of the 12:00 donor-rollup,
  whose cost is gated by exactly this (FIX-1003/1018).
- `nightly_killed` marker written correctly (`08-18 03:54 failed |
  workflow-timeout-or-sigterm`) — but only after the restart, because mark-killed
  depends on PostgREST. Filed as **FIX-1065**.
- The orphan detector's own **reference-case guard** now fails on a clean signal —
  mis-specified for a legitimate official, latent since FIX-934 shipped 08-05 and
  surfaced by the first audit run since. **Not** caused by the backfill (it added 6
  rows / $5,750 to that official). Filed as **FIX-1064**.
- Left `running`, artifacts of the cancels/restart:
  `treemap_individuals_global_refresh` (08:15) and `run_rule_taggers` (10:00).

---

## 6. Addendum — the resume completed; FIX-961 closes

`fec-backfill` run **32200957208**, `cycles=2020`, dispatched 2026-08-19 00:21:55 UTC into
a quiet box, **succeeded at 03:15:36** (2h53m41s).

FIX-754 resume did its job: `donor-entities` was already banked, so the run rebuilt the
1,944,958-fingerprint donor id map by direct-pg read in 6.5 min instead of re-upserting
90 minutes of donors.

| stage | upserted | failed |
|---|---:|---:|
| indiv → candidate | 1,473,106 (completing 2,165,106/2,165,106) | 0 |
| indiv → committee | 1,149,355 (1,149,355/1,149,355) | 0 |
| skipped_unresolved | **0** (FIX-686) | — |
| IE relationships | 4,106 | 0 |
| cross-cycle entity totals | 4,401 | 0 |

**Cycle-2020 individual money now on prod:**

| source | rows | dollars | tx |
|---|---:|---:|---:|
| `fec_bulk_indiv` → officials | 2,165,106 | $2,379,532,703 | 3,265,730 |
| `fec_bulk_indiv_to_committee` | 1,149,355 | $4,281,860,748 | 2,098,589 |
| **total** | **3,314,461** | **$6,661,393,451** | 5,364,319 |

### The write-ordering verdict (PR 3b input)

Craig's kill criterion was: sustained under ~5,000/min for 30 minutes on a quiet box →
cancel. It never came close.

| window | rate |
|---|---:|
| 00:43 | 20,377/min |
| 00:48 | 19,200/min |
| 00:52 | 18,921/min |
| 00:58 | 20,800/min |
| 01:03 | 19,628/min |
| … through the full 78-minute candidate stage | ~18,900/min average |

Same table, same fingerprint-ordered emission (random against the arbiter's `from_id`),
same ~11–14M-row `financial_relationships`: **20,400/min on a quiet box versus 300/min
under Tuesday-morning contention.** Write ordering is NOT the constraint. PR 3b's +50%
row growth needs a scheduling slot, not a write-ordering redesign.

Caveat kept honest: the 08-18 10:48 vacuum also left both tables at zero dead tuples with
fresh stats, so vacuum state and contention moved in the same direction. The contention
explanation carries most of the weight (a 68× swing), but the vacuum is not proven to
have contributed nothing.

### Verification

- Both attribution detectors: **CROSS-PERSON MISATTRIBUTION 0 / $0** ✅, and with the
  FIX-1064 guard fix both reference cases now pass for the right reason (Shontel CLEARED
  on residual overlap 267 pairs / frac 0.0742 < cut 0.1667; Ossoff MERGED holding
  $78,791,661 — up from $39,800,406, which is the cycle-2020 money landing).
- `VACUUM (ANALYZE)` tail: the pipeline vacuumed `financial_entities` itself (44.7s,
  FIX-943 rule), but nothing covered `financial_relationships`, which gained ~2.6M rows.
  Run by hand on the quiet box at 03:39–03:40 — FR 56s, FE 12s, both analyzed ahead of
  the 09:00/12:00 donor-rollup whose cost is gated by exactly that.
- Sync row closed `complete` (ins=2,782,408); `fec_bulk_run_state` cleared.

### One defect this run surfaced

The nightly `fec-phase` opened its own `fec_bulk` row at 03:02:27 and **overlapped this
run by 13 minutes**, then re-processed cycle 2020 from the shared
`pipeline_state.fec_bulk_run_state` key. The two workflows declare different GHA
concurrency groups, so nothing serializes them. Idempotent upserts meant no damage here,
but the resume cursor is not idempotent state. Filed as **FIX-1067**.

---

## 7. Addendum — PR 3b local acceptance (2026-08-19)

PR 3b lands the semantics this document measured. Three FIXes:

| FIX | what |
|---|---|
| **FIX-1067** | cross-run interlock around `runFecBulkPipeline()` — the §6 defect |
| **FIX-1061** | indiv writer stages stream off the sorted files; no whole-cycle arrays |
| **FIX-1068** | the $200 floor becomes a per-donor cycle-AGGREGATE floor applied at EMIT, with the sub-floor residual bracketed |

### 7.1 Acceptance — the numbers reproduce EXACTLY

Run against the same cached full cycle-2026 file (30,632,248 lines, 5,401 MB
extracted) through the REAL `streamIndivText`, via the rewritten harness
(`data:fec:indiv-acceptance`, which replaced `data:fec:indiv-equivalence` — the
`memory` accumulator it diffed against is retired in this PR).

**Ossoff C00718866 — against §2.3:**

| | §2.3 expected | measured | |
|---|---:|---:|:--:|
| FR rows emitted | 38,973 | 38,973 | ✓ |
| dollars | $25,844,495 | $25,844,495 | ✓ |
| residual groups | 29,551 | 29,551 | ✓ |
| residual dollars | $2,778,748 | $2,778,748 | ✓ |
| — $0.01–$49.99 | 4,777 / $139,732 | 4,777 / $139,732 | ✓ |
| — $50–$99.99 | 8,718 / $566,802 | 8,718 / $566,802 | ✓ |
| — $100–$199.99 | 16,056 / $2,072,214 | 16,056 / $2,072,214 | ✓ |

Coverage of FEC's `individual_itemized_contributions` ($28,654,210): **90.2%**,
up from 56.7%. §2.3's projection, met to the dollar.

**Platform-wide — against §2.4:**

| | §2.4 expected | measured | |
|---|---:|---:|:--:|
| FR rows | 1,980,786 | 1,980,786 | ✓ |
| dollars | $4,556,216,174 | $4,556,216,174 | ✓ |
| residual groups | 1,002,643 | 1,002,643 | ✓ |
| residual dollars | $83,453,297 | $83,453,297 | ✓ |
| — $0.01–$49.99 | 296,250 / $7,092,375 | 296,250 / $7,092,375 | ✓ |
| — $50–$99.99 | 259,815 / $17,525,145 | 259,815 / $17,525,145 | ✓ |
| — $100–$199.99 | 446,578 / $58,835,777 | 446,578 / $58,835,777 | ✓ |

Split by route: 993,638 donor×candidate ($1,220,922,776) + 987,148
donor×committee ($3,335,293,398). Donor entity rows **1,301,466** — below the
1,889,224 donors in the file by exactly the donors whose every group is
sub-floor, who correctly mint no entity.

One number differs from §2.4 and is explained, not a discrepancy: §2.4 reports
21,377,129 rows kept floor-off; the stage reports 21,382,745 admitted. The
phase-0 script counts *after* the org-shape guard, the stage counts *before* it
(5,574 org-shaped + 42 blank-name/fingerprint = 5,616 = the difference exactly).

### 7.2 Bounded memory survives the 10× bigger workload

The floor-off admission puts ~21.4M records into the sorter instead of ~2.1M.
Identical results at every configuration:

| config | FR rows | dollars | residual | peak RSS | peak heapUsed | runs (agg+meta) | sort disk | stream |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| heap 512, buffer 25k | 1,980,786 | $4,556,216,174 | 1,002,643 / $83,453,297 | 590 MB | 254.5 MB | 671+577 | 823 MB | 299 s |
| heap 1024, buffer 100k | 1,980,786 | $4,556,216,174 | 1,002,643 / $83,453,297 | 467 MB | 253.3 MB | 150+119 | 723 MB | 261 s |
| heap 2048, buffer 400k | 1,980,786 | $4,556,216,174 | 1,002,643 / $83,453,297 | 1,560 MB | 1,211.9 MB | 30+21 | 561 MB | 226 s |

**Peak heapUsed is flat at ~254 MB across a 16× buffer range** — the live set is
one buffer, not the cycle, and the 10× record increase did not move it. RSS at
buffer 400k is GC headroom, not live data (§1's note).

**Sort disk is the resource that grew: 142.9 MB → 822.7 MB at buffer 25k, ~5×.**
That is the real operational change from this PR. A presidential cycle's ~13 GB
extract implied ~300 MB of runs pre-3b; budget **~1.5–2 GB** now. The extract is
still unlinked before the merge, so the peaks do not overlap, and the GHA
runner's ~14 GB free disk still covers it — but it is no longer a rounding error.

### 7.3 What the prod run must show — and WHEN it actually fires

**The prompt's rollout premise is wrong about the day, and the code and prod
state both say so.**

Prod `pipeline_state.fec_indiv_watermark` for cycle 2026 is
`"Sun, 16 Aug 2026 15:50:15 GMT"`, which equals the Last-Modified FEC is serving
right now. `fec_bulk_run_state` is absent (cleared by the §6 run), so there is no
FIX-754 resume trigger either.

- **Sunday 2026-08-23's nightly** starts 02:00 UTC and, with GHA queueing, reaches
  the FEC phase ~05:30 UTC. FEC publishes `indiv{yy}.zip` on Sundays at ~15:20
  UTC — *ten hours later*. So the run probes the 08-16 file, hits
  `watermarkUnchanged && !isScoped` in `fec-bulk/index.ts`, and **skips the indiv
  stage entirely**. This is exactly the phase offset `drop-check.ts`'s own header
  describes.
- **Monday 2026-08-24's nightly** probes again, now sees FEC's 08-23 drop ahead of
  the 08-16 watermark, and the FIX-903 weekday drop-check fires an off-Sunday
  `fec_bulk` — a full-file replay under the new semantics. **That** is the
  acceptance run.
- The **pas2 half lands on the Sunday run** regardless: `streamPas224` has no
  watermark gate, so the (committee × candidate) aggregate floor takes effect
  there a day earlier than the indiv half.

Nothing fires before then: the weekday drop-check needs a new FEC publish, and
FEC's cadence is Sunday. An off-cycle FEC republish would fire it early, which is
now safe — local acceptance passes.

**Checklist for the post-run session:**

1. Cycle-2026 `financial_relationships` from `fec_bulk_indiv` +
   `fec_bulk_indiv_to_committee`: expect **1,980,786** rows / **$4,556,216,174**,
   up from 1,316,608 / $4,074,508,705. The pipeline's own numbers will be
   slightly LOWER than the harness's on the candidate route — the harness uses
   every ccl P/A candidate, the pipeline only our matched officials.
2. `small_dollar_bracket_rollup` for `cycle_year = 2026`: **1,002,643** summed
   `donor_count`, **$83,453,297** summed `total_cents`, ~9,823 rows before
   recipient resolution drops the unmatched.
3. `official_small_dollar_rollup.sub_floor_cents` non-zero for officials with
   bracketed residual; `/api/graph/small-dollar` returning both
   `smallDollarShare` and `smallDollarShareWithSubFloor`.
4. Write cost: ~+664k FR rows. At the §6-measured ~20,400/min on a quiet box that
   is **~33 min extra**; at the 300/min contended rate it is 37 hours, so the
   scheduling slot is the whole ballgame (§6's write-ordering verdict).
5. **FIX-943 vacuum tail** on `financial_relationships` and `financial_entities`
   — this run adds ~664k rows and rewrites more.
6. Post-run stats sanity of the FIX-1034 class (`FR.from_id` n_distinct).
7. The budget-sized surfaces watched against the growth: FIX-965 (treemap),
   FIX-868 (donor brackets), FIX-966 / FIX-1030 (chord MVs), and the
   `entity_connections` donations arm.
8. `sub_floor_cents` needs `backfill_official_small_dollar_rollup()` once per env
   to cover officials whose bracket rows landed but who were not in the donor
   dirty set. The ingest calls `small_dollar_rebuild_officials()` for its own
   bracket-touched officials, so this is belt-and-braces.

Older cycles (2024, 2022, 2020) re-stream via gated `fec-backfill` dispatches in
quiet windows, Craig-approved per dispatch, one cycle at a time. §2.5's
extrapolation (+50% to +100% rows) stands unmeasured for those.
