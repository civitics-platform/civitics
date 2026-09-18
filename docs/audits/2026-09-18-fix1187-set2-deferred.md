# FIX-1187 — set 2 re-derived, reviewed, and NOT applied: the corrected drain-and-wait readings and why it waited

**2026-09-18, cc-131 items 4 and 6.** Set 2 was **not run**. It is deferred to
cc-132 with a committed, reviewed manifest and a full set of read-7 readings.

The reason is the clock and nothing else. cc-131 fixes set 2's window at
**Saturday 2026-09-19 ~12:00–21:30 UTC**, and its autonomous loop says in
advance what to do when the session lands early:

> if the window is Saturday and the session is Friday, STOP here and report —
> set 2 and items 4/6/7 carry to cc-132's item 0 … commit the v2 manifest in
> item 6 anyway so cc-132 applies a REVIEWED file

This session ran **Friday 2026-09-18 01:14–04:15 UTC**, roughly 32 hours before
the window opens. So this is the planned branch, not a failure: items 1–3 landed
(the Sunday deadline is met with ~68 hours to spare), the manifest is derived and
validated, and the readings below are the record.

---

## 1. The manifest: five rows became four

`docs/audits/2026-09-18-fix1187-office-promotion-manifest-v2.tsv`, four rows,
with the authorisation header. The 2026-09-16 file keeps a one-line
`# SUPERSEDED by …` comment and is not deleted.

**Re-derived on prod 2026-09-18 02:47 UTC.** The keyed shape-B query — active
elected row, `role_title = 'Senator'`, live `fec_candidate_id` with an `H`
prefix, joined to a `tier='candidate'` "Candidate for Senator" row of the same
person holding an `S` id with live FR rows — returns **exactly four**:

| survivor | uuid | holds (House) | Senate stub | Senate id | stub FR rows |
|---|---|---|---|---:|---:|
| Adam B. Schiff | `26876d52` | H0CA27085 | `2c0f0bd2` | S4CA00555 | 19,632 |
| Gary C. Peters | `efd0cd51` | H8MI09068 | `cdc8ae79` | S4MI00355 | 23,464 |
| John R. Curtis | `0fcc1b87` | H8UT03238 | `f073c8ba` | S4UT00282 | 1,850 |
| Cynthia M. Lummis | `a911c906` | H8WY00148 | `60bfd339` | S0WY00137 | 1,852 |

Every stub FR count matches cc-130's prediction exactly (19,632 / 23,464 /
1,850 / 1,852), and every survivor UUID matches cc-129's manifest. Total to
move: **46,798 stub FR rows**.

**Marshall is correctly absent.** cc-131's FIX-1195 restore made `60f87348` an
elected Senator holding `S0KS00315` live with `H6KS01179` in
`prior_fec_candidate_ids`, and the promotion had already merged his Senate
stub's money onto that row ($11,374,334 / 4,867 FR rows). There is no Senate
stub left to merge, so the shape-B predicate no longer matches him. That is the
set-2 outcome, reached by a different route.

**Set 1 is confirmed complete for all four.** The four House stubs
(`41d2af4c`, `b05ae301`, `71a323fc`, `12b08a65`) each now carry
`{"merged_fec_candidate_ids": [<house id>]}` and **zero** FR rows — the
precondition the 09-16 file spelled out as "SET 1 MUST RUN BEFORE SET 2",
because `_manifest` is `(survivor PRIMARY KEY, dup UNIQUE)` and two stubs for
one survivor would violate `financial_relationships_relcycle_unique`.

### Clone dry run (read 7i) — passes

```
Manifest: 4 pairs confirmed against live state.
  3/17 run here; 14 deferred to scheduled owners.
  FR delete colliding losers (survivor side)   22233   5.1s
  FR move to_id → survivor (all types)         23944  31.8s
  entity_connections delete stale money edges  21907   1.7s
  difference (must be $0):  $0  OK
  official_donor_totals diffs outside the manifest: 0  OK
✓ DRY-RUN complete — all checks passed, rolled back.
```

The manifest path resolves from `packages/data` as
`../../docs/audits/…` (rule 135). The collision direction is the OPPOSITE of set
1's, as cc-129 predicted: donation pairs 22,228 with **dup-fresher 22,204** vs
survivor-fresher 8. The clone predates set 1, so these are **shape** checks, not
predictions — prod's 46,798 stub rows are roughly double the clone's 23,944.

---

## 2. Read 7 — every reading with its time

This is **FIX-1193's first satisfiable instance.** cc-130 recorded four of ten
gates failing, two of them on criteria that could not be met at all. Both have
been replaced.

| gate | reading (UTC) | value | verdict |
|---|---|---|---|
| **7a** unguarded owners | 02:48 | 34 active jobs; **16 unguarded** (12 vacuums + both `*/2` watchdogs + `abuse-events-retention` + `platform-counts-daily`), 18 guarded | derived |
| **7a** vacuum clearance | 03:59 | `ec-vacuum-analyze` next at **04:30**, 31 min away | **FAIL at this hour** |
| **7b** EC headroom | 02:49 / 03:59 | dead 457,118; trigger 522,489; **headroom 65,371**; rate **0/h** over 70 min | pass, see caveat |
| **7b** FE headroom | 02:49 / 03:59 | dead 85,956; trigger 260,784; **headroom 174,828**; rate **0/h** | pass |
| **7b** FR headroom | 02:49 / 03:59 | dead 212,083; trigger 289,448; **headroom 77,365**; rate **0/h** | pass |
| **7b** EC dead/live, all-visible | 03:59 | **4.37 %**, **73.3 %** all-visible | reported, no gate |
| **7c** crawl units | 02:49 | `ec-crawl` 4/4 succeeded, walls **0.1–0.3 s** (interval 15 min); `fe-crawl` 2/2, 0.1–0.2 s (30 min); **none running**; max unit wall **0.3 s** | **PASS** |
| **7d** watchdogs | 02:49 | `cron-job-budget-watchdog` **30/30** succeeded, `derived-mvs-unit-watchdog` **30/30** — **60/60**; max wall 0.9 s; **zero** non-succeeded firings of any job in 60 min; no `job startup timeout`; nothing running | **PASS** |
| **7e** interlock | 02:49 | `held: false`, `live_writers: []` | **PASS** |
| **7f** 57014/min | 02:51, 60-min window | **1** cancellation = **0.0167/min** vs 0.033/min baseline (gate ≤ 2×) | **PASS** |
| **7f** front-door 5xx | 02:52, 15-min window | **0 of 501** requests = **0.0 %** (gate ≤ 1 %) | **PASS** |
| **7g** clock | 03:59 | outside 22:30–01:00 ✓, 106 min clear of 05:45 ✓ — but the window is **Saturday** | **FAIL (by design)** |
| **7h** the four unchanged | 02:5x | all four survivors and all four stubs exactly as read 5 left them | **PASS** |
| **7i** manifest + clone dry run | 04:0x | path resolves; dry run passes, conservation $0 | **PASS** |

**Eleven of thirteen pass.** The two failures are both the clock: 7a because a
daily vacuum was 31 minutes out at reading time, and 7g because the window is
tomorrow. Neither is a property of the data.

### Which of cc-130's unsatisfiable gates are now gateable

- **"≤ 5,000 dead tuples on EC"** — cc-130 proved this unreachable outside the
  excluded window: EC accrues faster than that between vacuums. cc-131 replaces
  it with a **headroom-and-rate** gate — `(trigger − n_dead_tup) / rate > 2 ×
  expected wall` — which is a statement about whether autovacuum can trip
  *during the set*, which is the thing that actually matters. It reads
  **65,371 dead tuples of headroom at a measured 0/h**, i.e. satisfiable, where
  the old form read 457,118 ≫ 5,000 and was never going to pass.
- **"no `partial` unit"** — replaced by "no unit still `running` at start, and
  no unit wall > its own interval". `partial` is the crawl arm's **designed**
  terminal status, so the old form failed on correct behaviour. The new form
  reads 0.1–0.3 s units against a 15-minute interval.

### The caveat that belongs on the rate

**0 dead tuples/hour was measured across 70 minutes at 03:00–04:00 UTC, the
quietest hour of the day, and does not predict Saturday midday.** It is genuine
quiet rather than a stalled collector — `pg_stat_database.xact_commit` advanced
between two consecutive reads, and the crawl arms are completing in 0.1–0.3 s
because they are caught up. But a rate of zero measured at the trough is the
weakest possible input to a gate expressed as a rate. cc-132 must re-read it
**inside** the Saturday window, not reuse this.

---

## 3. What the readings surfaced that the gates did not ask for

**`fe-vacuum-analyze` failed on 2026-09-17 04:50 with `job startup timeout`** —
the only non-succeeded firing of any vacuum job in nine days. This is already
recorded verbatim in FIX-1194's bullet, so nothing new is filed. What the
follow-through adds is the consequence: FE's `last_vacuum` is still
2026-09-16 04:50 and its `vacuum_count` is 1. FE is nonetheless fine at 99.9 %
all-visible, so the miss cost little **this** time. The shape is the concern —
the landing's starvation takes out the maintenance job that exists to clean up
after the landing.

**`ec-vacuum-analyze` ran 3,147.9 s (52m 28s) on 2026-09-17**, against 9–133 s
on each of the eight preceding days — a 24–350× blow-up, and set 1's churn is
the only candidate. It is also the job the 09-17 receipts show as **skipped**
under the FIX-950 interlock the day set 1 landed.

**EC has decayed to 73.3 % all-visible** and is sitting there, not falling: the
09-17 daily recorded `pct_all_visible: 100.0` at 06:00 and it has been 73.3 %
across both of this session's readings 70 minutes apart. The daily 04:30 vacuum
owns it.

**`financial_relationships` reads `vacuum_count = 0` and `last_vacuum` NULL, and
this is NOT a missing vacuum.** The postmaster restarted **2026-09-15 15:09:48
UTC** and `pg_stat_statements_info.stats_reset` carries that exact timestamp,
while `pg_stat_database.stats_reset` reads NULL — the trap that
`project_stats_reset_null_is_not_a_window` names. `fr-vacuum-analyze` last ran
**2026-09-14 01:00** (200.7 s, succeeded), before the restart; its next firing is
Monday 2026-09-21 01:00. EC's `vacuum_count = 2` (09-16, 09-17) and FE's `= 1`
(09-16 only, the 09-17 run having failed) corroborate the same epoch. A census
run without that check would have filed a false alarm against FIX-1191.

FR's actual position for FIX-1191: **212,083 dead tuples, 82.7 % all-visible,
77,365 below the autovacuum trigger, with a WEEKLY owner three days out.** Set
2 adds 46,798 rows of churn on top of that, and Monday 01:00 is what collects it.

---

## 4. Why the promotion fired, with its own log line

cc-130 caught the deletions live at ~23:20:28 UTC and inferred the mechanism.
The nightly's own output confirms it exactly (GHA run 35286154536, `fec-phase`,
2026-09-17T23:20:46Z):

```
  promote-candidates: Mark Harris (NC representative) — 668 votes + 2763 total FKs moved
  promote-candidates: Robert Menendez (NJ representative) — 1593 votes + 11916 total FKs moved
  promote-candidates: Roger Marshall (KS senator) — 1879 votes + 3097 total FKs moved
  promote-candidates: detected=3 promoted=3 failed=0
```

**`detected=3`** is the reassuring number: exactly three pairs existed, so the
damage is bounded to the three cc-130 found and cc-131 repaired. Prod now reads
**0 pairs before the guard and 0 after**, because the promotion has consumed
them all.

That nightly ran on **unguarded** `main` with the **unfixed** RPC. FIX-1196's
guard landed at 01:45 UTC and FIX-1195's migration at 01:47 UTC on 2026-09-18,
so the next nightly — firing ~21:00 UTC on 09-18, FEC phase ~23:20 — is the
first guarded one, and its `skipped_bound=N` line is the prod evidence. cc-132
reads it.

---

## 5. What contradicted the design

Nothing in set 2's own premises. Read 5 returned exactly the four rows cc-130
predicted, with the FR counts and survivor UUIDs it predicted, and the clone dry
run passes on the re-derived manifest.

Two smaller corrections, both recorded above rather than acted on:

- cc-131 describes the erasure as happening "on 2026-09-17" and the set-2 stop
  as cc-130's. Both are right, but the promotion is precisely **23:20:46 UTC on
  2026-09-17**, which belongs to the nightly **named 2026-09-18** (nominal day,
  3 h slot offset). Anyone reading `docs/receipts/2026-09-18.md` for the event
  is reading the right file with a date one day ahead of the wall clock.
- cc-131's read 6 asks for the **2026-09-18** `refresh-derived-mvs-daily` on
  both instruments. It fires at 06:00 UTC and this session ran 01:14–04:15 UTC,
  so it had not fired. Item 5 therefore did not land and FIX-1185 / FIX-1128
  stay open. The most recent daily is 09-17, and it is `partial`: pg_cron
  recorded `succeeded` while `data_sync_log` recorded the watchdog cancelling
  `rebuild_entity_search_index` at 1,018.2 s against a 900 s unit budget, 8 of
  13 units OK and 4 skipped. That is cc-130 §3's finding reproducing exactly,
  and it is the watchdog working — but the record cc-131 wants needs a clean
  13/13 run, which only 09-18 or later can supply.
