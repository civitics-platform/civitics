# The I/O burst ledger — where the day's Disk IO budget is already spent

**Date:** 2026-08-27
**Instruments:** prod `cron.job` + `cron.job_run_details` (14 days, 2026-08-13 →
08-26, 292 non-watchdog firings), `public.data_sync_log`, `pg_proc.prosrc`.
**Related:** [[FIX-1107]] (the budget fact), [[FIX-1111]] (the crawl this sizes),
[[FIX-969]] (the regime), [[FIX-1066]] / [[FIX-1052]] (the constraints any move
must respect), [[FIX-1112]] (the watermark census run off the same catalog read).

---

## 0. What this sampled, and what it could not classify

**Sampled.** Every `cron.job` row and every `cron.job_run_details` row in the
retained window, excluding the two `*/2` watchdogs (jobids 40 and 44) whose
firings are the *detector* of starvation rather than a cause of it. Durations
are `end_time - start_time`; a NULL `end_time` means the row never closed.

**Could not classify — state this plainly, because the temptation is to infer
IOPS from duration and that inference is only sound in one place.** We have a
direct IOPS reading for exactly two events, both from Craig's Supabase
Observability panel and neither from any catalog:

* a donations window during the 08-25/26 drain: **~2,078–2,500 IOPS** sustained,
  against a 1,000 IOPS provisioned baseline and a 3,000 IOPS disk cap;
* jobid 13's 08-25 burst: **pinned at the 3,000 cap 10:00→~11:15**, then
  throttled to **<150 IOPS at 60–75% IOwait**.

For every other job we have **duration only**. `pg_stat_statements` does not
carry physical I/O, `pg_stat_database` blocks-read counters are cluster-wide and
not attributable to a job, and Supabase exposes no per-query IOPS. So the
`I/O class` column below is a **shape judgement from duration plus what the
procedure is known to do**, not a measurement. Where a job's IOPS is genuinely
unknown, the table says `unknown`. Anything downstream that needs a real number
needs the Observability panel during a controlled run.

**One consequence worth naming up front:** because we cannot read the burst
balance, none of this can be closed-loop. [[FIX-1111]]'s sensor is unit
*duration* for exactly this reason — see §6.

---

## 1. The cost model, and the one number that makes it usable

From [[FIX-1107]]: baseline **1,000 IOPS / 22 MB/s**, disk cap **3,000 IOPS**,
and a burst pool worth roughly **30–75 minutes/day above baseline**, refilling
over hours. Three measured exhaustions: 08-24 ~30 min, 08-25 ~75 min at the cap,
08-26 ~70 min at ~2,500.

The usable conversion comes from the drain: a donations window runs **~346 s at
~2,500 IOPS**, i.e. ~1,500 excess IOPS for 346 s. The pool refills at
approximately baseline, so one window costs about **540 s of refill** — which is
independently corroborated twice over:

* 12–13 back-to-back windows exhaust the pool → 12.5 × 346 s = 4,325 s ≈ **72
  min**, matching the measured 75-minute 08-25 burst;
* it is the number the FIX-1110 drain wrapper takes as its `--sleep-seconds`
  default.

So the working unit of account is:

> **refill-seconds = writer-seconds × 1.56** (for window-class work)
> **the day holds 86,400 refill-seconds.**

⚠ The 1.56 multiplier is calibrated on ONE workload — the donations window. It
is applied below to other jobs only to give an order of magnitude, and every
such row is marked `unknown`. A job that is CPU-bound or that reads from cache
costs far less; a job doing random writes across a cold 10M-row table costs
more.

---

## 2. Per-job ledger (14 days)

Sorted by worst observed duration. `class` is the shape judgement of §0.

| jobid | job | schedule (UTC) | runs | ok | avg s | max s | class |
|---|---|---|---|---|---|---|---|
| 2 | rebuild-ec-incremental | `0 8 * * 3` | 2 | 2 | 12,264 | 21,875 | **sustained writer** (measured ~2,500 IOPS) |
| 22 | rebuild-ec-incremental-mon | `0 8 * * 1` | 2 | 2 | 20,296 | 21,615 | **sustained writer** — PAUSED |
| 13 | financial-entity-totals-incremental | `0 10 * * 2` | 2 | 0 | — | 8,048 | **sustained writer** (measured 3,000 IOPS cap) — PAUSED |
| 12 | rule-taggers-weekly | `0 16 * * 2` | 2 | 0 | — | 7,326 | sustained writer, `unknown` IOPS |
| 24 | donor-rollup-refresh | `0 9,12 * * *` | 28 | 23 | 2,997 | 7,202 | **sustained writer, `unknown` IOPS — but proven safe, see §3** |
| 26 | treemap-individuals-global-refresh | `0 14 * * 2` | 2 | 0 | — | 6,477 | sustained writer, `unknown` |
| 28 | contract-flow-rollups-refresh | `0 14 * * 4` | 2 | 2 | 1,460 | 1,867 | sustained writer, `unknown` |
| 10 | refresh-derived-mvs-weekly | `0 7 * * 2` | 2 | 1 | 1,362 | 1,362 | short, `unknown` |
| 9 | refresh-derived-mvs-daily | `0 6 * * *` | 14 | 14 | 657 | 1,355 | short, `unknown` |
| 11 | rule-taggers-daily | `30 6 * * *` | 14 | 12 | 618 | 748 | short, `unknown` |
| 6 | ec-vacuum-analyze | `0 2 * * 0,3` | 4 | 4 | 215 | 722 | short (vacuum — read-heavy) |
| 30 | fe-vacuum-analyze | `0 2 * * 0,1,3` | 6 | 6 | 70 | 196 | short |
| 38 | fr-vacuum-analyze | `0 1 * * 1` | 2 | 2 | 59 | 98 | short |
| 33,37,36,34,32,35 | the six 11:xx/17:xx vacuums | `5–18 11,17 * * *` | 28 ea | 25–27 | 0–5 | 12–93 | trivial |
| 27 | vote-stats-refresh | `30 3 * * *` | 14 | 14 | 19 | 26 | trivial |
| 25 | agency-staffing-rollup-refresh | `0 13 * * 2` | 2 | 0 | — | 18 | trivial (never completed) |
| 17 | donor-party-rollup-refresh | `0 15 * * 2` | 2 | 0 | — | 10 | `unknown` (never completed) |
| 16 | entity-connection-stats-rebuild | `0 16 * * 1,3` | 4 | 0 | — | 10 | `unknown` — **0 of 4 succeeded, see §7** |
| 31,39,29 | dpr/officials vacuum, abuse retention | various | — | all ok | 0–4 | 4–6 | trivial |

---

## 3. The contrast that proves this is a budget and not a load problem

Keep this next to any proposal to move work around, because it is the single
most counter-intuitive fact in the ledger and it is what makes a crawl viable:

* **08-26.** `donor-rollup-refresh` ran **09:00–10:59 AND 12:00–13:59** — 7,171.9 s
  and 7,186.6 s, both exiting `partial — budget exhausted`. **Four hours of
  sustained writing.** Watchdogs 40/44 recorded **5/60 failed firings across the
  entire day.**
* **08-25.** jobid 13 ran **one** 8,047.8 s burst and the box lost 35/60, 43/60,
  50/60, **58/60** watchdog firings across the following hours, peaking at 14:00
  **with nothing scheduled at all**.

Sustained load inside the budget is harmless. A burst that exhausts it is not,
and killing the writer does not return the credit — the 12:14→16:00 hole on
08-25 is a spent balance refilling, not a process.

---

## 4. The weekly map — where the burst goes, and where the slack is

Hours are UTC. `███` = sustained writer occupying the hour; `▓` = short; `·` =
trivial or empty.

```
        00 01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16 17 18-23
Mon      ·  ▓  ▓  ·  ·  ·  ▓  ·  ██ ███████ ·  ███████ ·  X  ·   ·      (22 PAUSED at 08)
Tue      ·  ·  ·  ·  ·  ·  ▓  ▓  ·  ███████ ·  ███████ ·  ██ ·  ███ ·   ·
Wed      ·  ·  ▓  ·  ·  ·  ▓  ·  ██ ███████ ·  ███████ ·  ·  ·  X  ·   ·
Thu      ·  ·  ·  ·  ·  ·  ▓  ·  ·  ███████ ·  ███████ ·  ▓▓ ·  ·  ·   ·
Fri      ·  ·  ·  ·  ·  ·  ▓  ·  ·  ███████ ·  ███████ ·  ·  ·  ·  ·   ·
Sat      ·  ·  ·  ·  ·  ·  ▓  ·  ·  ███████ ·  ███████ ·  ·  ·  ·  ·   ·
Sun      ·  ·  ▓  ·  ·  ·  ▓  ·  ·  ███████ ·  ███████ ·  ·  ·  ·  ·   ·
```

**The dominant daily consumer is jobid 24, twice a day, every day**: 09:00–11:00
and 12:00–14:00, up to 2 × 7,200 s = **14,400 writer-seconds/day**, and by §3 it
is demonstrably inside the envelope.

**Tuesday is the loaded day** — 07:00 derived-mvs-weekly, then [[FIX-1066]]'s
five moved weeklies at 13:00/14:00/15:00/16:00 stacked on top of jobid 24's two
windows, plus jobid 13 at 10:00 when it is not paused. Every one of the five
failed on 08-25.

**The slack is unambiguous and large:**

| slot | width | current occupancy |
|---|---|---|
| **18:00 → 01:00 daily** | **7 h** | **nothing at all** — the six 17:1x vacuums finish by 17:19 |
| 02:30 → 06:00 daily | 3.5 h | vote-stats 19 s, abuse-events 0 s |
| 14:00 → 17:00 Wed–Mon | 3 h | Thu contract-flow only |

Seven contiguous empty hours every night is the answer to most of §5.

---

## 5. Proposed moves — FILED, NOT MADE

Nothing below is executed. `cron.alter_job` on jobs other than the crawl is
explicitly out of scope for this prompt; these are for Craig to approve.

Constraints any move must respect, already on record:

* **[[FIX-1066]]** — the Tuesday-afternoon six must stay clear of the 11:xx/17:xx
  vacuum waves and of jobid 24's two windows.
* **[[FIX-1052]]** — jobid 16 `entity-connection-stats-rebuild` must run **after**
  the EC work, which is why it sits at 16:00. ⚠ **[[FIX-1111]] dissolves this
  premise**: with a continuous crawl there is no longer an "after". See §7.
* **[[FIX-1107]]** — jobid 13's regime is pending (cc-91); it stays paused and is
  not moved here.

| # | move | from | to | why |
|---|---|---|---|---|
| 1 | jobid 12 `rule-taggers-weekly` | Tue 16:00 | **Tue 19:00** | 7,326 s sustained writer landing on a box already in deficit from the Tuesday stack. 19:00 puts it in the empty 7-hour slot with 6 h of headroom. Its 4-of-5 failure record ([[FIX-969]]) is the strongest single case in the ledger. |
| 2 | jobid 26 `treemap-individuals-global-refresh` | Tue 14:00 | **Wed 20:00** | 6,477 s, never completed in the window. Moving it off Tuesday entirely breaks up the five-weekly stack rather than just re-ordering it. |
| 3 | jobid 28 `contract-flow-rollups-refresh` | Thu 14:00 | **Thu 21:00** | 1,867 s, currently succeeding — a low-risk move that vacates the only non-Tuesday afternoon writer. |
| 4 | jobid 10 `refresh-derived-mvs-weekly` | Tue 07:00 | leave | 1,362 s, succeeds, and 07:00 is genuinely quiet. No case to move it. |
| 5 | jobid 24 `donor-rollup-refresh` | 09:00, 12:00 | leave | §3 proves it is inside the envelope. Moving the ledger's biggest consumer on no evidence of harm would be the exact mistake this document exists to prevent. |

Net effect if 1–3 are taken: **Tuesday afternoon empties out**, the three
largest unreliable writers move into the 19:00–22:00 slack, and nothing lands
in a window jobid 24 already occupies.

---

## 6. What the crawl itself will consume (the arithmetic decision 7 asked for)

The instrument is FIX-1101's clean scheduled receipt — prod **2026-08-26 08:00,
jobid 2, `complete` in 2,654 s** — whose `arm_timings` give the full per-unit
cost table:

```
donations_incr_windows   1385 s   ← 4 windows x ~346 s (the drain had banked 12)
..._external              878 s
..._contracts             307 s
..._votes                  26 s
..._holds/_lobbying/_oversight/_appointments   10 s each
..._gifts/_cosponsors                           9 s each
..._investigation           0 s
```

**The ceiling does not depend on cycle composition, because pacing is
per-FIRING, not per-cycle.** That is the whole point of the design, and it makes
the arithmetic a one-liner:

```
at */15:  at most 96 firings/day, at most 1 unit each
worst case, every unit a full-cost window:
    96 x 346 s   =  33,216 writer-seconds/day
    x 1.56       =  51,817 refill-seconds/day
    / 86,400     =  60% of the day's refill
```

**60%, with 40% headroom, and no cycle shape can exceed it.** Compare the three
measured exhaustions, each of which spent 100% of the pool in under two hours.
So **`*/15` is inside the budget and the cadence default does not need to
change.**

Two honest caveats:

* The worst case above is unreachable in practice — `_external` (878 s) and
  `_contracts` (307 s) run once per cycle and eight arms cost ≤26 s, so the real
  mix is cheaper per firing. But it is also not a *bound* on refill cost, because
  `_external`'s IOPS is `unknown`; if it writes at window-class rates it costs
  ~1,371 refill-seconds, which exceeds one `*/15` interval's 900 s. It is one
  unit per cycle, so it amortises — but a *sequence* of `_external`-class units
  would not, and that is precisely what the §6 sensor is for.
* Local measurement, same run shape: units came in at 4–13 s for windows,
  52.6 s for `_contracts`, 78.4 s for `_external` — the same rank order as prod,
  which is weak corroboration that the arm cost profile is structural rather
  than a prod artefact.

### 6.1 ⚠ The one thing the arithmetic changed

The per-firing ceiling is safe; total *waste* is not bounded by it. A cycle is
16 windows + 10 arms = up to 26 units, and **the ten non-donations arms are
unconditional full rebuilds** — they rerun every cycle whether or not anything
changed. Because already-banked windows skip *without consuming a firing*
([[FIX-1111]] hoists that check into the driver, or the crawl would livelock at
one useless firing per 15 min), a cycle with a small dirty set completes in
~13 firings ≈ 3.3 h. That would spin those ten arms **6–7× per day against the
once-a-week they get today**.

Not a budget problem — 8 of the 10 cost ≤26 s. But `_external` + `_contracts` is
~1,185 s/cycle, so at 6.5 cycles/day that is **~2 h/day of recomputing unchanged
edges**, which is the exact waste this line of work exists to stop.

Hence `pipeline_state.ec_crawl.min_cycle_interval_minutes`, **default 360**
(≤4 cycles/day — still **28× fresher** than the current weekly rebuild). This is
the one knob not named in the cc-90 design decisions; it is here because the
arithmetic asked for it, and it is data, so Craig can retune it in one `UPDATE`.

---

## 7. Observations this ledger surfaced but does not own

**jobid 16 `entity-connection-stats-rebuild` has not succeeded once in 14 days.**
4 runs, 0 succeeded: `job startup timeout` on 08-17 (under its pre-[[FIX-1052]]
11:00 slot), then **`server restarted` on both 08-24 16:00 and 08-26 16:00** —
i.e. both scheduled firings since the move, with a NULL `end_time`. Two
consequences:

1. `entity_connection_stats` is being maintained by nothing but its
   direct-writer path right now (`project_entity_connections_writer_ownership`).
2. **[[FIX-1052]]'s premise — "16:00, AFTER the EC work" — does not survive
   [[FIX-1111]].** With a continuous crawl there is no "after the EC work"; there
   is only "during". Whatever ordering jobid 16 actually needs has to be
   re-derived against a crawl, not against a weekly batch. Filed here, not
   fixed; it belongs with cc-92's sweep.

**Prod restarts.** Two `server restarted` rows 48 h apart, both at 16:00, are
either a coincidence of Supabase-side maintenance or a signature. This ledger
cannot tell which — `cron.job_run_details` records that a connection died, never
what killed it, which is the same blind spot [[FIX-1107]] hit at 12:14–16:00.

---

## 8. Spec, not built — pacing the FEC replay's write phase

The [[FIX-903]] weekly replay is the other sustained writer on the box, and
[[FIX-1111]] deliberately does **not** try to schedule around it: the widened
[[FIX-1101]] interlock defers crawl firings while the replay holds its lock or
leaves a `fec_bulk_run_state`, and when that clears, the crawl's next unit runs —
and if the replay spent the day's budget, that unit's *duration* says so and the
sensor backs off 2 h. That is the entire Monday fix; no schedule arithmetic.

But the replay itself is still unpaced, and it should get the same treatment.
Shape, for a later prompt:

The indiv writer already has both halves of what it needs — [[FIX-1061]]'s
chunked streaming gives it a natural pacing boundary, and [[FIX-754]]'s cursors
make the write phase resumable at chunk granularity. Pacing is therefore a
**per-chunk sleep** whose size comes from the writer's own throughput
measurement, which is the only sensor available: measure a chunk's duration when
the box is healthy, and sleep a multiple of it so the chunk's above-baseline
excess is repaid before the next chunk starts — the same `writer-seconds × 1.56`
conversion §1 derives, and the same duration-as-proxy reasoning §6 uses, because
IOPS is not readable from inside the database.

**The GHA implication is the load-bearing part.** The workflow's
`timeout-minutes` is 300. Pacing multiplies wall clock by roughly the same 1.56,
so a replay that fits in 300 min today would not once paced, and raising the
timeout is the wrong lever twice over: a runner holding a prod connection for
8–10 h is its own risk, and `reference_cancelling_gha_leaves_prod_backend`
records that cancelling the GHA run **leaves the prod backend running** — the
same defect [[FIX-1110]] just fixed in the drain. The structurally consistent
answer is to **move the write phase off GHA and onto the crawl**: the FIX-754
cursors already make it a sequence of resumable units, so a pg_cron job draining
one chunk per firing is the identical shape [[FIX-1111]] just proved, and it
inherits the same budget, watchdog and backoff for free.

**For the 2024 / 2022 / 2020 re-streams (cc-93) this stops being optional.**
They are roughly 3× one cycle's volume. Paced, that is not a GHA-hosted job
under any timeout — they should be cursor-driven crawl work from the start,
rather than a GHA run that is later discovered not to fit.
