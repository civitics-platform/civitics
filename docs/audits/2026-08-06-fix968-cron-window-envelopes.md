# pg_cron window envelopes — prod, 2026-08-06

FIX-968 phase 1. Measured read-only from `cron.job` + `cron.job_run_details` on
prod (`db-query.mjs --prod`, READ ONLY). Retained window: **2026-06-29 08:00 →
2026-08-06 03:30 UTC, 177 runs**. `data_sync_log` is used only to correlate GHA
load; it is *not* the failure record — a job that dies at startup writes nothing
there at all, which is why FIX-944's self-heal and the three-day blind spot both
happened.

Filed per FIX-968 decision 9: this is the input the PR-3 rollup-capacity work
needs, and re-deriving it later costs another prod pass.

> **Correction to the FIX-968 bullet:** the donor-rollup job is **jobid 24**, not
> 34. No jobid 34 exists. Every reference below is to 24.

---

## 1. Instance envelope (the constraint everything else sits inside)

| setting | value | source |
|---|---|---|
| `max_worker_processes` | **6** | configuration file |
| `max_parallel_workers` | 2 | configuration file |
| `max_parallel_workers_per_gather` | 1 | configuration file |
| `max_parallel_maintenance_workers` | 1 | configuration file |
| `max_connections` | 60 | configuration file |
| `shared_buffers` | 256 MB | configuration file |
| `statement_timeout` (postgres role) | **6 h** (21600000 ms) | database user |
| `work_mem` | 256 MB | database user |
| `cron.use_background_workers` | **off** | — |
| `cron.max_running_jobs` | 32 | — |
| `cron.timezone` | GMT | — |

`cron.use_background_workers = off` is the load-bearing one: pg_cron does **not**
use a bgworker slot per job. It opens a fresh **libpq connection to
`localhost`** for each firing and gives it a fixed ~10 s window to connect and
authenticate. Every observed `job startup timeout` bottoms out at **10.1–11.4 s**,
which is that window, not a bgworker-slot exhaustion.

So the failure is: *under sustained CPU/IO saturation on a 2-vCPU Small, a fresh
local connection cannot complete setup in 10 s, and pg_cron abandons the firing
entirely.* The job does not queue, does not retry, and writes nothing anywhere
except one `cron.job_run_details` row.

---

## 2. Per-job runtime envelope

All 21 active jobs, retained window. `p50`/`p95`/`max` in seconds.

| jobid | jobname | schedule (UTC) | runs | ok | fail | p50 | p95 | max |
|---|---|---|---|---|---|---|---|---|
| 27 | vote-stats-refresh | `30 3 * * *` | 17 | 16 | 1 | 31 | 195 | 702 |
| 29 | abuse-events-retention | `15 4 * * *` | 13 | 12 | 1 | 0.1 | 8.7 | 21 |
| 9 | refresh-derived-mvs-daily | `0 6 * * *` | 33 | 33 | 0 | 633 | 1 692 | **12 547** |
| 11 | rule-taggers-daily | `30 6 * * *` | 33 | 33 | 0 | 408 | 1 162 | **14 028** |
| 10 | refresh-derived-mvs-weekly | `0 7 * * 2` | 5 | 5 | 0 | 2 027 | 2 780 | 2 781 |
| 25 | agency-staffing-rollup-refresh | `30 7 * * 2` | 3 | 3 | 0 | 547 | 1 120 | 1 183 |
| 22 | rebuild-ec-incremental-mon | `0 8 * * 1` | 3 | 1 | 2 | 2 252 | 19 668 | **21 603** |
| 2 | rebuild-ec-incremental | `0 8 * * 3` | 5 | 4 | 1 | 2 206 | 4 783 | 5 350 |
| 6 | ec-vacuum-analyze | `0 8 1 * *` | 1 | 1 | 0 | 10 | — | 10 |
| 26 | treemap-individuals-global-refresh | `15 8 * * 2` | 3 | 2 | 1 | 1 638 | 19 618 | **21 616** |
| 17 | donor-party-rollup-refresh | `45 8 * * 2` | 4 | 3 | 1 | 404 | 18 447 | **21 629** |
| **24** | **donor-rollup-refresh** | `0 9 * * *` | **23** | **15** | **8** | **22** | **21 622** | **22 080** |
| 13 | financial-entity-totals-incremental | `0 9 * * 2` | 5 | 3 | 2 | 1 776 | 17 807 | **21 611** |
| 12 | rule-taggers-weekly | `0 10 * * 2` | 5 | **1** | **4** | 21 601 | 21 611 | **21 613** |
| 16 | entity-connection-stats-rebuild | `0 11 * * 1,3` | 8 | 8 | 0 | 3 616 | 17 296 | 18 568 |
| 23 | donation-edge-orphan-sweep | `30 11 1 * *` | 1 | 1 | 0 | 176 | — | 176 |
| 14 | financial-entity-totals-reconcile | `0 12 1 * *` | 1 | 1 | 0 | 271 | — | 271 |
| 15 | donor-rollup-orphan-sweep | `30 12 1 * *` | 1 | 1 | 0 | 23 | — | 23 |
| 18 | donor-party-rollup-orphan-sweep | `0 13 1 * *` | 1 | 1 | 0 | 162 | — | 162 |
| 19 | entity-connection-stats-orphan-sweep | `30 13 1 * *` | 1 | 1 | 0 | 50 | — | 50 |
| 28 | contract-flow-rollups-refresh | `0 14 * * 4` | 2 | 2 | 0 | 4 056 | 6 819 | 7 126 |

**Bolded `max` values at ~21 600 s are not runtimes — they are the 6 h
`statement_timeout` firing.** Seven distinct jobs (22, 26, 17, 24, 13, 12, and
the retired jobid 1) have blown it at least once. jobid 12 blows it on **4 of 5
runs**.

That matters more than it looks: a job that blows the 6 h ceiling doesn't fail
fast — it runs flat out for six hours and *then* dies. It is the single largest
source of the saturation that starves other jobs.

---

## 3. The day, laid out

Recurring daily occupancy (UTC), with weekly/monthly overlays:

```
02:00  ── GHA nightly-sync triggered
       │  nightly_cron typically 05:15–07:11 (fec_bulk is the long pole)
       │  on failure days fec_bulk RETRIES land 19:30–04:30 (measured 08-02..08-05)
03:30  ▌ 27 vote-stats-refresh          p50 31s
04:15  ▌ 29 abuse-events-retention      p50 0.1s
05:15  ████████████ nightly_cron (GHA) ──────────────┐
06:00  ██████ 9  refresh-derived-mvs-daily  p50 633s │  max 12 547s (08-05: to 09:29)
06:30  ██████ 11 rule-taggers-daily        p50 408s  │  max 14 028s (08-05: to 10:23)
07:00  ████ 10 refresh-derived-mvs-weekly  (Tue)     │
07:30  ██ 25 agency-staffing-rollup       (Tue)      │
07:11  ───────────────────────────────────────────────┘
08:00  ████ 22 rebuild-ec-mon (Mon) / 2 rebuild-ec (Wed)
08:15  ████ 26 treemap-individuals-global  (Tue)
08:45  ██ 17 donor-party-rollup            (Tue)
09:00  ▌ 24 donor-rollup-refresh  ← DAILY, and 13 fe-totals-incremental (Tue)
10:00  ████ 12 rule-taggers-weekly         (Tue)
11:00  ██████ 16 ec-stats-rebuild          (Mon+Wed)  p50 3 616s
11:30–13:30  monthly orphan sweeps (1st)
14:00  ████ 28 contract-flow-rollups       (Thu)
──────────────────────────────────────────────────────
15:00–02:00   NOTHING SCHEDULED
              but = 11:00–22:00 ET, peak user traffic,
              and where fec_bulk retries land on failure days
```

**There is no 4-hour band that is both unscheduled and off-peak.** 15:00–02:00 is
the only unscheduled band and it is exactly the live-traffic window, which the
no-heavy-prod-ops-during-active-hours rule exists to protect.

---

## 4. Every `job startup timeout` in the retained window

Nine events, five distinct clock slots, five distinct jobs.

| when (UTC) | jobid | job | dur | what was saturating the box |
|---|---|---|---|---|
| 07-26 09:00 | 24 | donor-rollup | 22.2 s | (outside `data_sync_log` pull) |
| 07-27 08:00 | 22 | rebuild-ec-mon | 10.5 s | (outside pull) |
| **08-03 03:30** | 27 | vote-stats | 10.7 s | GHA fec_bulk 08-02 22:10 → 08-03 04:03 |
| 08-03 09:00 | **24** | **donor-rollup** | 11.4 s | jobid 22 mid-6h-blowout (08:00→14:00) + nightly_cron 08:20→09:50 |
| **08-04 04:15** | 29 | abuse-events | 21.2 s | GHA fec_bulk 08-03 22:37 → 08-04 04:27 |
| 08-04 09:00 | 13 | fe-totals-incr | 10.1 s | jobid 26 (08:15→14:15) + 17 (08:45→14:45), both 6h blowouts |
| 08-04 09:00 | **24** | **donor-rollup** | 10.2 s | same |
| 08-04 10:00 | 12 | rule-taggers-wk | 14.4 s | same |
| 08-05 08:00 | 2 | rebuild-ec | 43.1 s | jobid 9 (06:00→09:29) + 11 (06:30→10:23) |
| 08-05 09:00 | **24** | **donor-rollup** | 10.5 s | same |

### What this refutes

The FIX-968 bullet's stated probable cause — *"post-indiv22 the nightly
`refresh_derived_mvs` window stretched to 06:00–09:29 so the box is saturated at
09:00"* — **holds for 08-05 only**. On the other two days the MV block finished
early and on time:

- **08-03**: MV daily 06:00→**06:15**, taggers 06:30→**06:48**. Both long done by
  09:00. The saturation was jobid 22 burning its full 6 h.
- **08-04**: MV daily 06:00→**06:10**, taggers 06:30→**06:51**. Also done. The
  saturation was jobids 26 and 17 *both* burning their full 6 h.

And two of the nine events land at **03:30 and 04:15** — slots with zero cron
overlap — during overnight GHA `fec_bulk` retries.

**Correct generalisation:** pg_cron startup timeouts on this box are a function of
*sustained load from any source*, not of any particular clock slot. Three
independent sources have caused them (a stretched MV window, a 6 h-blowout cron
job, an overnight GHA fec_bulk retry). Moving one job to a different hour does not
address the mechanism; it relocates one job's exposure.

---

## 5. Current damage to the odt family

Watermark `pipeline_state.donor_rollup_watermark.last_indexed_at` =
**2026-08-02 05:54:43** (last advanced by the 08-02 09:00 run, runid 151,
2 h 00 m). No `sweep_cursor` key present, so no sweep is mid-flight and
`check_rollup_freshness` reports `stale`, not `partial`.

**Dirty set (procedure semantics — `relationship_type IN (donation, ie_support,
ie_oppose)`, `from_type='financial_entity'`, `updated_at > watermark`):**

| metric | value |
|---|---|
| dirty recipients (all types) | **9 562** |
| dirty recipients that are officials | 4 305 |
| dirty FR rows | **2 513 018** |
| watermark the next run would set | 2026-08-05 06:41:23 |

**9 562 is the largest dirty set this job has ever faced** (prior max: 8 381 on
07-31, which completed in 3 h 08 m / 42 chunks).

**`official_donor_totals` vs live FR** (`to_type='official'`,
`relationship_type='donation'` — the exact FIX-836 source query):

| metric | value |
|---|---|
| officials with live donation rows | 6 770 |
| officials with an `odt` row | 4 324 |
| officials with **no `odt` row at all** | **2 446** |
| officials whose `odt` row disagrees | 955 |
| **total wrong** | **3 401** |
| **total understated** | **207 990 944 100 ¢ = $2 079 909 441** |

Worst deltas (all understatements):

| official | odt | live | delta | under |
|---|---|---|---|---|
| Raphael G. Warnock | $4 307 869 | $69 632 441 | $65 324 572 | 93.8 % |
| Donald Trump | $500 | $42 292 553 | $42 292 053 | 100.0 % |
| Herschel Walker | $23 850 | $35 045 011 | $35 021 161 | 99.9 % |
| Charles E. Schumer | $5 092 547 | $34 948 468 | $29 855 921 | 85.4 % |
| Mark Kelly | $11 158 612 | $40 896 281 | $29 737 669 | 72.7 % |
| Catherine Cortez Masto | $5 179 044 | $28 771 325 | $23 592 281 | 82.0 % |
| John Fetterman | $2 910 103 | $22 670 836 | $19 760 733 | 87.2 % |
| Marco Rubio | $490 663 | $19 811 719 | $19 321 056 | 97.5 % |
| Margaret Wood Hassan | $6 370 480 | $24 098 602 | $17 728 122 | 73.6 % |
| Tim Scott | $16 209 221 | $30 226 024 | $14 016 803 | 46.4 % |

> **This is materially worse than the FIX-968 bullet's four-official picture.**
> The bullet cited Guthrie / Johnson / Emmer at ~$0.4–1.2 M each. The real
> blast radius is 3 401 officials and $2.08 B, dominated not by the FIX-934/954
> remediation but by **2 446 officials that have never had an `odt` row** — the
> 2022-cycle Senate field that the FIX-952 attribution backfill brought into
> scope on 08-05. Trump reads as $500 on every surface that trusts `odt`.

**Coverage check — does one incremental run actually fix it?**

| metric | value |
|---|---|
| wrong officials | 3 401 |
| **covered by the current dirty set** | **3 401** |
| not covered | **0** |

Yes. Every wrong official is inside the dirty set, so **one successful run
converges the whole thing** — no orphan sweep (jobid 15, monthly on the 1st)
needed, and no bootstrap. Confirmed there is no `from_type` scope gap: all
4 092 651 donation-to-official FR rows have `from_type='financial_entity'`.

**Cost gate (FIX-943).** `financial_relationships` is clean:

| table | live | dead | % dead | last_vacuum |
|---|---|---|---|---|
| financial_relationships | 10 274 689 | **0** | 0.00 % | 2026-08-06 00:56:29 |
| entity_connections | 5 059 971 | 6 165 | 0.12 % | 2026-08-06 00:56:42 |
| official_donor_totals | 4 324 | 405 | 8.56 % | (autovac 08-02 11:01) |

Freshly vacuumed → the fast per-chunk regime applies (FIX-951: 269 s/chunk at
8 381 recipients, vs 685 s/chunk in the FIX-943 degraded regime).

**Runtime floor, not an estimate:** 9 562 recipients ÷ 200 = **48 chunks**.
At the measured-fast 269 s/chunk → **≈ 3 h 35 m**. At the degraded 685 s/chunk →
≈ 9 h 08 m, which would *not* fit the 6 h ceiling. FR is clean, so the fast
regime is the expected one — but 3 h 35 m is a floor and the dirty set is 14 %
larger than the run that produced that number.

---

## 6. Why three days passed unnoticed — partly wrong

The FIX-968 bullet says nothing surfaced the failure. **The canary did fire.**

`sync-canary-check.yml` runs `data:canary-check:ci` daily at ~07:30 UTC, and
FIX-944 already added `donor_rollup_refresh` to `ROLLUP_PIPELINES` with
`maxAgeHours: 48`. Its GHA history:

| date | result |
|---|---|
| 2026-08-01 | success |
| 2026-08-02 | success |
| 2026-08-03 | success |
| **2026-08-04** | **failure** |
| **2026-08-05** | **failure** |

It escalated correctly and on time — 08-04 is the first run at which
`hours_since_complete` (68.5 h) crossed 48 h. It also composes a Resend alert
whose subject carries `stale rollup: donor_rollup_refresh`.

So the gap is **not** detection of *this* job's staleness. The two real gaps:

1. **It detects the consequence, never the cause.** The canary knows `odt` is
   stale. Nothing anywhere reads `cron.job_run_details`, so "the job never
   started" is indistinguishable from "the job ran and did nothing," and the
   48 h threshold means a startup timeout is invisible for two days by design.
2. **It covers 1 of 21 jobs.** Five different jobs were starved in this window
   (24, 27, 29, 13, 2, 12, 22). Only jobid 24 has any watcher at all. jobid 12
   has failed 4 of 5 runs at the 6 h ceiling with nothing reporting it.

A `cron.job_run_details` reader is reachable from the canary: `postgres` holds
`USAGE` on schema `cron` and `SELECT` on both tables; `service_role` has the
table grants but **not** schema `USAGE`. So the shape is a `SECURITY DEFINER`
function owned by `postgres` with `cron` on its `search_path` — identical to the
existing `check_rebuild_autovacuum_status`.

---

## 7. Where the "09:00–15:00 donor-rollup window" is actually written

Grepped the whole repo. The rule exists in exactly **two** places:

| site | editable? |
|---|---|
| `packages/data/src/scripts/treemap-global-sweep.ts:28` | yes |
| `supabase/migrations/20260731000000_fix944_resumable_donor_rollup.sql:25` | **no — applied migration, frozen** |

Plus the slot rationale in `supabase/migrations/20260713020000_fix832_donor_rollup_daily_cadence.sql`
(also frozen) and FIXES.md bullets FIX-868 / FIX-944 / FIX-968 (append-only).

It is **not** in `docs/OPERATIONS.md`, not in any `CLAUDE.md`, and not in any
runbook. The documentation cost of moving the window is therefore one comment
line in one script — far smaller than FIX-968 decision 5 assumed.

---

## 7b. The 2026-08-06 drain, as it actually ran

Added after the fact. The runtime projection in §5 was **wrong by ~15×** and the
correction matters more than the original estimate did.

**Firings under the new `0 9,12 * * *` shape:**

| runid | start | end | secs | cron status | data_sync_log |
|---|---|---|---|---|---|
| 181 | 09:00:03 | 12:16:14 | 11 771 | succeeded | `partial` — "budget exhausted — resumable at recipient 601 of 10 286" |
| 182 | 12:16:15 | (running) | — | running | `running`, dirty 9 686, resuming from cursor |

Both design goals held. 09:00 **started** (the three prior days died at startup),
and the 12:00 firing did not double-run against the in-flight instance — pg_cron
held it and launched it **one second** after 181 released, resuming from the
cursor. That is better than the advisory-lock `skipped` this was designed for.

**Throughput, measured:** 600 recipients = 3 chunks in 3h16m ≈ **65 min/chunk**,
against FIX-951's measured **269 s/chunk**. A 14.5× gap.

**It is not a plan problem.** `EXPLAIN` (planning only) of arms 1 and 2 at chunk
sizes 200/100/50/25/10:

| chunk | full arm-1 cost | arm-2 cost | plan |
|---|---|---|---|
| 200 | 78 251 | 72 308 | Index Only Scan `financial_relationships_donor_rollup_idx` |
| 50 | 27 783 | 24 664 | same |
| 25 | 10 478 | 8 822 | same |

Perfectly linear, no seq scan, no missing index, no spill cliff, no plan flip.
**So chunk size is not a throughput lever** — it only recovers the ~27% of each
window the 1.25× budget guard leaves unused (181 stopped at 3h16m of a 4h30m
budget because it would not start a 4th chunk).

The cost is genuine I/O on a cache-starved instance: the backend sat on
`IO/DataFileRead` for 64+ minutes continuously, and the Supavisor pooler
intermittently refused connections outright (`ECHECKOUTTIMEOUT`) throughout
05:50–13:00. Live PostgREST traffic was queueing behind it. This is the
FIX-775 lesson — memory-bounded is not I/O-bounded.

**Whale load** (per-recipient donation rows, worst offenders):

| official | FR rows | distinct donors |
|---|---|---|
| Raphael G. Warnock | 81 354 | 80 674 |
| Mark Kelly | 41 977 | 37 687 |
| Herschel Walker | 32 254 | 32 242 |
| John Fetterman | 26 466 | 25 807 |
| Catherine Cortez Masto | 24 423 | 23 699 |
| **Donald Trump** | **742** | 637 |

Trump's $42.3M understatement comes from 742 rows, not a long tail — it is
committee money. Also visible: **ten separate "Donald Trump" `officials` rows**
(and two "Marco Rubio"), most with 1 FR row and no rollup — the known prod
officials pollution, untouched here.

**Dirty-set composition — sizes the FIX-970 lever, and corrects it:**

| `to_type` | dirty rows | % of rows | recipients | rows/recipient |
|---|---|---|---|---|
| `official` | 1 815 180 | **69.8 %** | 5 029 | 361 |
| `financial_entity` | 785 707 | **30.2 %** | 5 257 | 149 |

Non-official recipients are **51 % of the recipient count but only 30 % of the
row work** — they are *cheaper* per recipient, not more expensive. The
speculation that committee recipients might carry bigger individual-donor tails
than candidates is **false on this data**.

> **Correction to FIX-970's bullet**, which was filed before this measurement and
> says scoping would "cut the work by roughly half": scoping the dirty set to
> officials halves the CHUNK COUNT (52 → 26) but cuts total row work by only
> **~30 %**, and each surviving chunk gets ~1.4× heavier. Expected saving is
> therefore **~30 %**, not ~50 %. FIX-970's correctness case — 7 241 dead
> `official_id`s in a 776 137-row table no consumer reads by that key — is
> unaffected and stands on its own.
>
> Consequence for sequencing: a ~30 % saving does **not** justify discarding an
> in-flight sweep to re-scope it. Let the drain finish; scope for future runs.

**Projection at measured rate:** ~9 500 recipients remaining ≈ 48 chunks ×
65 min ≈ **52 h of compute**; at ~3 chunks per window and 2 windows/day, roughly
**8 days**. The 12:00 backstop is free as a startup retry (~0.1 s on an empty
dirty set) but on a day like this one it drains 12:16–16:46 UTC = 08:16–12:46
ET, i.e. through US-morning traffic. Worth revisiting if the whale-heavy dirty
sets become routine rather than a one-off consequence of the FIX-952 backfill.

---

## 8. Carry-forward for PR 3 (rollup capacity)

Facts worth not re-deriving:

- The 6 h `statement_timeout` is a **role default on `postgres`**
  (`pg_db_role_setting`), armed once at `CALL` start and not re-armed by the
  procedure's per-chunk `COMMIT`s. No procedure carries a `proconfig` override —
  all eight checked return empty. Session-level `SET statement_timeout = 0`
  before the `CALL` is the only lift, which is exactly what the break-glass
  sweep scripts do.
- Seven jobs have blown that ceiling. Chunking arms (the FIX-944 / FIX-965
  pattern) is the only thing that has ever fixed one.
- `max_parallel_workers_per_gather = 1` and `max_parallel_workers = 2` — these
  rollups get almost no intra-query parallelism, so per-chunk cost is essentially
  single-core and scales linearly with the dirty set.
- Per-chunk cost swings **2.5×** on `financial_relationships` dead tuples
  (FIX-943). Check `n_dead_tup` before sizing any run.
- `cron.job_run_details` retains ~38 days at current volume (177 rows). Any
  capacity analysis should snapshot it rather than assume it persists.
