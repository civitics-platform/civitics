# Tuesday receipts — 2026-09-29

**cc-169.** Read 2026-09-29 23:11–23:25 UTC. That is after all four Tuesday
weekly legs had fired: 00:05, 14:00, 15:00 and 16:00. Prod reads only, through
`node scripts/db-query.mjs --prod` (one `SET TRANSACTION READ ONLY` transaction
per query). Nothing was written to prod.

**Instruments.** `cron.job_run_details` joined to `cron.job` by NAME, never by
jobid. `public.data_sync_log`, which is the procedure's own terminal row: rule
124 reads a job's health from that row, never from `cron.job_run_details.status`.
Also `public.cron_job_budget` / `cron_job_budget_action`,
`public.donor_party_rollup_mv`, `public.pipeline_state`, `pg_class`, `pg_stats`,
`pg_stat_user_tables`, and `prod_session_state()`.

**Epoch.** `pg_postmaster_start_time()` = 2026-09-22 22:32:13 UTC, Craig's
manual restart after the 09-22 wedge. Prod has not restarted since.

---

## 0. Verdict

| FIX | condition | reading | verdict |
|---|---|---|---|
| **969** | jobid 17's own first `caught_up`, on the crawl branch, inside budget, with 0 startup timeouts in its window | 15:00:00.14 → 15:01:07.98, `complete`, `mode: crawl`, `caught_up: true`, 67.8 s; 0 startup timeouts 14:00–17:00 | **closes** |
| **1138** | all three weekly legs succeed at their slots | 25: 40.0 s ✓ · 26: 907.5 s ✓ · 17: 67.9 s ✓, all `complete` | **closes** |
| **993** | both halves healthy: jobid 17 (above), and rule-taggers-daily's last seven in cadence | 09-23 → 09-29, 7 of 7 at 06:30, all `complete` | **closes** |
| **1178** | two in-band-or-below stamped dailies after the merge | 7 of 7 at 203.3–225.7 s, all below the old 713–858 band | **closes**; band re-based (§4) |

**Forker.** 0 `job startup timeout` in 14:00–17:00 today, across 381 runs. Since
09-23 there has been one, in `box-health-probe` on 09-27 at 09:29 (13.1 s).

**Ceiling and watchdog.** No run has gone over 3 h since 09-23. The longest was
`rule-taggers-weekly` today, at 5,062.9 s. `cron_job_budget_action` has no rows
since 09-17.

---

## 1. jobid 17 `donor-party-rollup-refresh` — FIX-969's receipt

`cron.job`: jobid **17**, `0 15 * * 2`, **active**.
`cron_job_budget.budget_seconds` = **1,800**. The prompt said 9,000, but 9,000
belongs to `donor-rollup-refresh`, a different job (§6).

### 1a. The last six firings (`cron.job_run_details`)

| runid | start (UTC) | end (UTC) | wall s | status | return_message |
|---|---|---|---|---|---|
| 15764 | 08-25 15:00:00.00 | 15:00:10.12 | 10.1 | failed | job startup timeout |
| 26195 | 09-01 15:00:00.38 | 15:30:14.95 | 1,814.6 | failed | canceling statement due to user request |
| 37429 | 09-08 15:00:00.21 | — | — | failed | server restarted |
| 48718 | 09-15 15:00:00.18 | — | — | failed | server restarted |
| 60017 | 09-22 15:00:00.16 | 18:08:55.26 | 11,335.1 | **succeeded** | CALL |
| **79159** | **09-29 15:00:00.10** | **15:01:07.98** | **67.9** | **succeeded** | **CALL** |

### 1b. `data_sync_log`, `pipeline = 'donor_party_rollup_refresh'`, since 09-22

| start (UTC) | wall s | status | mode | caught_up | units | rollup_rows | note |
|---|---|---|---|---|---|---|---|
| 09-22 15:00:00.22 | 11,277.8 | **partial** | full | false | 0 | 0 | `canceled — stage build: canceling statement due to statement timeout` |
| 09-23 09:02 … 09-25 00:45 | 239–271 each | partial ×7 | full | false | 2 each | ~371k each | paced runner (FIX-1212), windows 1–14 |
| 09-25 00:50:08 | 239.3 | complete | full | **true** | 2 | 371,295 | windows 15–16; `next_slice_from` 2026-09-21 00:18:25.831727 |
| **09-29 15:00:00.14** | **67.8** | **complete** | **crawl** | **true** | **3** | **2,007** | `dirty_donors` 747, `unit_capped` false |

Today's row, `metadata` quoted whole:

```json
{"lag": "6 days 22:18:41.641489", "mode": "crawl", "source": "pg_cron",
 "canceled": false, "failures": 0, "caught_up": true, "max_units": 40,
 "units_run": 3, "rollup_rows": 2007, "unit_capped": false, "dirty_donors": 747,
 "cancel_detail": null, "budget_seconds": 1500, "elapsed_seconds": 68,
 "next_slice_from": "2026-09-27 22:37:07.473216+00", "full_rebuild_lag": "14 days",
 "watermark_before": "2026-09-21T00:18:25.831727+00:00"}
```

- **The watermark moved** from 2026-09-21 00:18:25.831727 to 2026-09-27
  22:37:07.473216. `pipeline_state.donor_party_rollup_watermark.last_indexed_at`
  agrees, stamped 2026-09-29 15:01:07.97. `lag` is target minus watermark
  (6 d 22:18:41), well under the 14-day `full_rebuild_lag`, so the procedure took
  the crawl arm as designed.
- **`cursor_discarded` is absent**, and so is any `resumed`, `windows_*` or
  `cycle_*` key: no full-rebuild cursor existed to resume or discard.
- **The two instruments agree today**: `succeeded` 67.9 s and `complete` 67.8 s.
  They disagreed on 09-22, where `cron.job_run_details` said `succeeded` after
  11,335 s and `data_sync_log` said `partial` / canceled at 18:07:58. That was the
  procedure catching the 3 h ceiling's cancel and returning normally.

### 1c. `donor_party_rollup_mv` — what the crawl moved

| | rows | Σ `total_cents` |
|---|---|---|
| cc-154, after the 09-25 00:54 `caught_up` | 2,972,870 | 921,676,324,900 |
| now (23:1x UTC) | **2,972,950** | **922,639,848,600** |
| Δ | **+80** | **+963,523,700 ¢** (+$9.64 M) |

Now: Σ `tx_count` = 6,508,954; distinct donors = 2,737,481. Between the two
readings the only `data_sync_log` row for this pipeline is today's crawl.

**This was not a no-drop week.** `fec_bulk` ran 09-26 21:03 (269,167 rows,
333 s) and 09-27 21:04 (3,720,055 rows, 5,734 s). The latter ended about 22:40,
which is where the new watermark (22:37:07) sits. So 68 s is the crawl arm's
cost **on a drop week**: 747 dirty donors, 2,007 rollup rows rewritten. That is
a better receipt than the prompt expected. How 3.72 M `fec_bulk` rows became 747
dirty donors (unchanged upserts do not bump `updated_at`) is not established
here.

---

## 2. The three weekly legs — FIX-1138

`cron.job`, all active: jobid 25 `agency-staffing-rollup-refresh` `5 0 * * 2`,
jobid 26 `treemap-individuals-global-refresh` `0 14 * * 2`, jobid 17 (§1), and
jobid 12 `rule-taggers-weekly` `0 16 * * 2` (a read, §3).

### 2a. Today

| leg | cron (start → wall, status) | `data_sync_log` terminal row | budget |
|---|---|---|---|
| 25 agency-staffing | 00:05:00.05 → **40.0 s**, succeeded | `complete`, `incremental`, 20 agencies rebuilt (`dirty_ec` 19, `dirty_fr` 0), 40.0 s | 3,600 |
| 26 treemap-individuals-global | 14:00:00.13 → **907.5 s**, succeeded | `complete`, 64-chunk merge, 3,071 rows, slowest chunk 32 s, not resumed | 5,400 |
| 17 donor-party | 15:00:00.10 → **67.9 s**, succeeded | `complete`, crawl, `caught_up` (§1) | 1,800 |

### 2b. The last four Tuesdays (rule 24: the whole series)

| Tuesday | 25 agency-staffing | 26 treemap | 17 donor-party |
|---|---|---|---|
| 09-08 | 108.4 s ✓ (full, 133 agencies) | 1,084.2 s ✓ | failed: server restarted |
| 09-15 | 58.3 s ✓ | 994.1 s ✓ | failed: server restarted |
| 09-22 | 42.0 s ✓ | 916.4 s ✓ | cron `succeeded` 11,335 s / sync `partial` (3 h ceiling) |
| **09-29** | **40.0 s ✓** | **907.5 s ✓** | **67.9 s ✓ `complete`** |

The baseline before the move to the new slots: all three legs failed on 09-01
(startup timeout, a 5,420.7 s budget cancel, and a 1,814.6 s cancel). Today is
the **first Tuesday on which all three legs succeeded at their slots**.
Treemap's wall is falling steadily: 1,084, 994, 916, 907.

---

## 3. `rule-taggers-weekly` (jobid 12) — a read for D5

| Tuesday | cron | `data_sync_log` (`run_rule_taggers`, cadence weekly) |
|---|---|---|
| 09-01 | 7,519.7 s failed (budget cancel) | `reaped` |
| 09-08 | 4,692.4 s succeeded | complete, 4,406,878 tags |
| 09-15 | 4,837.7 s succeeded | complete, 4,409,537 tags |
| 09-22 | 48.2 s **failed: job startup timeout** (16:00:16, inside the forker outage) | none |
| **09-29** | **5,062.9 s succeeded** | **complete, 4,421,363 tags**; `phase_seconds` {delete 49.6, insert 4,974.3} |

**It recovered.** The 09-22 failure was the outage (172 startup timeouts that
day) and did not recur, so D5 files nothing: there is only one observation.

Noted, not filed: the successful walls climb (4,692, 4,838, 5,063 s) against a
7,200 s budget. That leaves 2,137 s of headroom (70 % used). The budget row's
note still reads "Healthy max 2741s", which predates this series. The weekly is
still DELETE-all + INSERT-all at 4.4 M rows; that is the weekly merge design,
Cowork's (§6).

---

## 4. The daily merge — FIX-1178

`rule-taggers-daily` is jobid 11, `30 6 * * *`, budget 7,200. The merge regime
went on Pro at 2026-09-23 00:03:00 (`20260920080000`).

| day | cron wall s | status | `phase_seconds` | desired | deleted | written |
|---|---|---|---|---|---|---|
| 09-20 | 987.3 | ✓ | — (rewrite) | | | 867,731 |
| 09-21 | 994.3 | ✓ | {delete 46.5, insert 947.6} | | | 868,167 |
| 09-22 | 1,015.8 | ✓ | {delete 34.1, insert 981.4} | | | 868,167 |
| **09-23** | **204.7** | ✓ | {scan 166.1, delete 28.9, insert 9.6} | 868,136 | 31 | 0 |
| **09-24** | **209.7** | ✓ | {scan 172.2, delete 26.7, insert 10.7} | 868,136 | 0 | 0 |
| **09-25** | **225.1** | ✓ | {scan 189.7, delete 25.1, insert 10.1} | 868,136 | 0 | 0 |
| **09-26** | **225.7** | ✓ | {scan 187.8, delete 25.9, insert 11.8} | 868,136 | 0 | 0 |
| **09-27** | **212.8** | ✓ | {scan 168.7, delete 31.4, insert 12.4} | 868,136 | 0 | 0 |
| **09-28** | **210.5** | ✓ | {scan 166.4, delete 32.0, insert 11.9} | 868,143 | 0 | 7 |
| **09-29** | **203.3** | ✓ | {scan 168.9, delete 26.6, insert 7.6} | 868,143 | 0 | 0 |

All seven post-merge runs were `succeeded` in cron and `complete` in
`data_sync_log`, each at 06:30:00, with no gaps: **seven of seven in cadence**,
which is FIX-993's rule-tagger half. All seven are **below** the old 713–858 s
band, and today's receipts file (`2026-09-30.json`) renders 09-29 as `below`
(203.3 s < 713 s).

The scan is 79–84 % of the wall. `delete` does its 25–32 s even when it deletes
0 rows, because it is the anti-join, not the row removal.

cc-135 found the daily stepping up on the day after each weekly. No weekly had
succeeded under the merge regime before today's (16:00; the 09-22 weekly failed at
startup). Whether today's weekly steps the next daily is therefore unobserved: the
09-30 06:30 daily has not run yet, so nothing is claimed about it.

**The new band** (rule 74: post-mechanism-change runs only):

- Series: `cron.job_run_details` walls, 2026-09-23 → 2026-09-29, n = 7, min
  203.29, max 225.69 s.
- P10 = 204.14 and P90 = 225.31 (`percentile_cont`).
- Rule: `[P10 − 10 %, P90 + 15 %]` = [183.73, 259.11], rounded outward to
  **[183, 260] s**.

### 4a. `entity_tags` heap bloat, as context and not a close condition

The estimator is cc-136's: `relpages` against `reltuples × (Σ avg_width + 24) / 8060`.

| | cc-136 (09-19) | now |
|---|---|---|
| Σ `avg_width` | 172 | 172 |
| `relpages` | 224,824 | 226,259 |
| ideal pages | 130,340 | 131,759 |
| **bloat ratio** | **1.72** | **1.72** |
| heap | 1,756 MB | 1,768 MB |

Also now: `n_live_tup` 5,418,268 and `n_dead_tup` 115,771. Last autovacuum was
09-29 17:28 and last autoanalyze 21:11. The merge stopped the daily's 865k-row
churn, but the weekly still rewrites 4.4 M rows, and nothing has compacted the
heap (FIX-1178's option (b)), so the ratio is unchanged.

---

## 5. FIX-969's thesis on the week after the fixes (09-23 → 09-29)

The claim was "each blowout starves every other job".

| day | runs | succeeded | failed | job startup timeout |
|---|---|---|---|---|
| 09-21 | 1,612 | 1,612 | 0 | 0 |
| 09-22 | 1,486 | 1,314 | 172 | **172** |
| 09-23 | 1,613 | 1,613 | 0 | 0 |
| 09-24 | 2,930 | 2,930 | 0 | 0 |
| 09-25 | 3,051 | 3,051 | 0 | 0 |
| 09-26 | 3,052 | 3,052 | 0 | 0 |
| 09-27 | 3,054 | 3,053 | 1 | 1 (`box-health-probe` 09:29:00, 13.1 s) |
| 09-28 | 3,054 | 3,054 | 0 | 0 |
| 09-29 | 2,970 | 2,970 | 0 | 0 |

The run count roughly doubles from 09-24. That is the `*/1` `box-health-probe`
(jobid 53), not new work.

- **Nothing over 3 h since 09-23.** The longest runs, by job:
  - `rule-taggers-weekly` 5,062.9 s
  - `contract-flow-rollups-refresh` 1,889.5
  - `refresh-derived-mvs-weekly` 1,593.2
  - `donor-rollup-refresh` 1,445.8 (max of 14)
  - `ec-crawl` 1,044.0 (max of 670)
  - `treemap-individuals-global-refresh` 907.5
  - `fe-crawl` 653.4 (max of 335)
  - `refresh-derived-mvs-daily` 382.1
- **`cron_job_budget_action` since 09-23: 0 rows.** The latest is 09-17 (ec-crawl
  and rule-taggers-daily).
- **`data_sync_log` since 09-23, every status other than `complete`**: only the
  designed ones. That is `partial` for unit caps (donor-party ×7, EC ×146, FE
  ×2), plus `skipped`, `deferred` and `dispatched`. There is no `canceled`,
  `failed` or `reaped` row anywhere.
- 0 postmaster restarts since 09-22 22:32:13.

---

## 6. What contradicted the prompt or the bullets

1. **jobid 17's budget is 1,800 s, not 9,000.** `cron_job_budget` for
   `donor-party-rollup-refresh` is 1,800, last updated 08-19, with the note
   "Healthy 352/388/420s". The 9,000 s budgets belong to `donor-rollup-refresh`,
   `contract-flow-rollups-refresh` and `entity-connection-stats-rebuild`. The
   1,800 s watchdog did not act on the 09-22 run (11,277 s) because the watchdog
   is itself a pg_cron job, and it could not fork that afternoon. Today's 67.9 s
   is inside either number.
2. **Not a no-drop week.** See §1c. The crawl arm handled a 3.72 M-row
   `fec_bulk` weekend in 68 s.
3. **Closing FIX-1178 leaves the weekly merge with no FIX anchor.** The
   design-paced-op-census note's decision 5 and D6 ("generalising the runner —
   needed before 1178's weekly merge is paced") and cc-162's append to the 1178
   bullet both hang the weekly `rebuild_financial_entity_size_tags` merge, and
   the generic paced-op runner, on FIX-1178. The same bullet also carries option
   (b), the one-off compaction of the 1.72× heap. Under rule 70 a closed bullet
   takes no append, so each of these needs its own bullet when Cowork prompts it.
   This run files nothing for them, because the prompt's Out of scope names that
   design as Cowork's.
