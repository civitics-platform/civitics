# USASpending resumable — the clone rehearsal (cc-214)

**Date:** 2026-10-10, 20:31–20:53 UTC. **Target:** the local prod-clone (Docker,
`127.0.0.1:54322`, postmaster up since 17:57:10Z). **Code:** `42c97ed6` (FIX-1274)
and `111c7bf2` (FIX-1291's reaper migration, applied to the clone and to prod).
**Prod:** the pipeline was NOT run against prod. The catch-up is cc-215.

What this proves, one line each:

- **A.** The box gate stops a category before any part is read. The stop path is `partial` with `metadata.gate`.
- **B.** `--max-parts` stops at a part boundary. Both parts are checkpointed in DELTA mode, and the row heartbeats.
- **C.** A run killed mid-part leaves its row `running` with a fresh heartbeat, and its checkpoint lists only completed parts. The new reaper spares the row while the heartbeat is fresh and reaps it once the heartbeat is stale.
- **D.** The resume skips completed parts, finishes, advances the baseline, clears `runInProgress` and runs the xsr tail. It keeps a `--local-archive` zip.
- **E.** A re-run of a completed archive writes **no** FR inserts. FR updates fall from every conflicting row to 10.9 % of rows sent. The residue is the file's own duplicate award keys, not the predicate.
- **mark-killed.** A `reaped` row gets the marker with `reaped_first`. The pre-change script no-ops on the same row, which is the 10-08 red.

---

## 0. Setup

**The clone.** `financial_relationships` 8,975,940 rows (reltuples), 442,292
pages. `external_source_refs` 580,012. `financial_entities` 3,682,111.
`pg_stat_user_tables` counters started at 0 (postmaster restart 17:57:10Z;
`pg_stat_database.stats_reset` NULL), so the deltas below are absolutes since
then. No other `running` row was on the clone, so the reaper reads below touched
nothing else.

**Two premises the clone contradicted:**

1. The clone's `usaspending_bulk_state` baseline is **20260706** for both
   categories, not prod's 20260806. The clone predates the 08-06 delta. Every run
   below used `--local-archive`, which processes the zip regardless of the
   baseline, so this did not matter. The row was snapshotted first and restored
   at the end (§6).
2. `box_is_saturated()` read **`clear`**, not `stale` (cc-205 D6's reading). The
   clone runs its own `box-health-probe` (local jobid 85, `* * * * *`), so its
   stamp was fresh. To prove the STOP path, run A paused jobid 85 at 20:36:47Z
   (`cron.alter_job(85, active := false)`) and waited for the 180 s staleness
   rule. It re-activated the job straight after. That is a local cron change only.

**The real archive (cc-215 reuses it).**
`C:\Users\Craig\AppData\Local\Temp\usaspending-bulk\FY(All)_All_Contracts_Delta_20260924.zip`.
That is `os.tmpdir()/usaspending-bulk/`, the pipeline's own `TMP_DIR`. It is
**1,524,399,293 bytes**, equal to the bucket listing's `<Size>`, so
`--keep-archive` reuses it. Downloaded 20:31:18–20:34:06Z (2 m 48 s) to
`.part`, then renamed. Five CSV entries, 299 columns:

| entry | compressed | uncompressed | rows |
|---|---:|---:|---:|
| `…_20260924_1.csv` | 334,474,691 | 2,158,751,767 | 1,000,000 |
| `…_20260924_2.csv` | 371,262,072 | 2,319,575,649 | 1,000,000 |
| `…_20260924_3.csv` | 337,956,975 | 2,430,253,346 | 1,000,000 |
| `…_20260924_4.csv` | 385,263,714 | 2,404,049,265 | 1,000,000 |
| `…_20260924_5.csv` | 95,440,859 | 572,150,386 | 274,410 |
| **total** | 1,524,398,311 | **9,884,780,413** | **4,274,410** |

**The rehearsal zip.** `usaspending_rehearsal_Contracts_Delta_20261010.zip`,
in the session scratchpad, 125,611,479 bytes. It holds part 1's header plus its
first 60,000 records, split into three STORED entries of 20,000 named like the
real ones (`FY(All)_All_Contracts_Delta_20260924_{1,2,3}.csv`). The records were
copied raw (`csv-parse raw: true`), so quoting is byte-identical. The `20261010`
in the zip name is the archive date the pipeline reads.

**D9 counts (FIX-1298), all five parts.** `correction_delete_ind = D`:
**56,890**, all in part 5, every one with a **blank** `federal_action_obligation`.
So today they hit the `isNaN(amount) || amount <= 0` skip and are dropped: a
deletion is never applied. Parts 1–4 carry 0 `D` rows, and no `C` appears
anywhere. Obligation `= 0`: **1,036,328**. `< 0`: **177,384**. Together that is
1,213,712 of the 4,217,520 non-D rows (28.8 %), all dropped. Part 1: 267,503
zero + 42,571 negative. The first 60k: 0 `D`, 14,843 `≤ 0` (12,813 zero, 2,030
negative).

---

## 1. Run A — gate ON, a stale box reading

`--category contracts --local-archive <rehearsal.zip> --gate-wait-s 120`,
20:39:05–20:41:08Z, exit 0. The claim was taken and released (local). The
gate polled 3 times over 120 s, then the category stopped before part 1 was
extracted:

```
[box gate] not clear after 120s (reason=stale, polls=3) — stopping (FIX-1291)
⏸  contracts stopped (gate) — 0/3 part(s) done; the next invocation resumes usaspending_rehearsal_Contracts_Delta_20261010.zip
Invocation stopped at contracts (gate) — later categories not started
```

Row `dc987d79`: `partial`, 20:39:07.619 → 20:41:07.933, `rows_inserted 0`,
`stop_reason gate`, `parts_done 0`, `parts_total 3`, `run_type delta`,
`fr_rows_changed 0`. `metadata.gate`:
`{job: usaspending-bulk, clear: false, reason: stale, polls: 3, waited_s: 120, wait_max_s: 120, age_seconds: 308, readings.probe.at: 2026-10-10T20:36:00.040Z}`.

**Deviation from the prompt:** `runInProgress` is **present** with
`completedParts: []`, not absent. The run's identity is persisted before the
first part, as the Full path always did (FIX-739: "persist immediately so a
resume is visible even if this dispatch dies before the first part
completes"). An empty record resumes as a fresh start, so nothing is lost.

`box_backoff_gate` ran on the direct client as `postgres`, the function's owner.
`has_function_privilege` read true, and no grant was needed.

## 2. Run B — gate OFF, `--max-parts 2`

`--gate-wait-s 0 --max-parts 2 --breather-s 10`, 20:46:33–20:47:29Z, exit 0.

| part | rows read | matched | sent | FR changed | wall | rows/s |
|---|---:|---:|---:|---:|---:|---:|
| 1/3 | 20,000 | 16,027 | 15,356 | 14,500 | 0.5 min | 697 |
| (breather 10 s) | | | | | | |
| 2/3 | 20,000 | 14,894 | 13,678 | 13,071 | 0.2 min | 1,368 |

The gap between matched and sent is the per-batch dedupe on the award key. The
gap between sent and changed (856 + 607) is rows already on the clone with
identical values: the predicate skipping them on first contact.

Row `e37055f1`: `partial`, `stop_reason max_parts`, `parts_done 2`,
`parts_total 3`, `parts_this_invocation 2`, `rows_inserted 29,034`,
`fr_rows_changed 27,571`. `runInProgress.completedParts`: both
`usaspending_rehearsal_Contracts_Delta_20261010.zip::FY(All)_All_Contracts_Delta_20260924_{1,2}.csv`.

**The heartbeat moved mid-run.** One read at 20:46:42 gave `heartbeat_at
20:46:40.607` (part 1/3). A read at 20:46:52.7 gave `20:46:52.371`. The last
stamp on the row was 20:47:28.81.

**Counters, before → after:** FR `n_tup_ins` 0 → **25,389**, `n_tup_upd` 0 →
**2,182**, HOT 0, `n_dead_tup` 2,182. 25,389 + 2,182 = 27,571, exactly the
pipeline's "changed": the server row count and the table counters agree. FE
inserted 173 new recipients. xsr inserted their 173 refs.

## 3. Run C — the kill (two attempts)

**Attempt 1 completed before the kill.** It started 20:48:05Z with no limits,
logged both parts `already complete — skipping`, and ran part 3. Part 3 took
20,000 rows in 0.2 min (1,638 rows/s; 14,210 matched, 13,849 sent, 13,442
changed). The run **completed at 20:48:20Z**. `Stop-Process` landed at 20:48:22Z
and found nothing to kill. `reap_stale_sync_log(1)` returned 0 rows, because
nothing was running. This attempt is the evidence for D (§4).

**Attempt 2.** First, C2a: `--max-parts 2`, 20:50:29–20:50:44Z, a re-run of
parts 1–2. It changed **1,237 + 1,579** rows, the same as run E's first two
parts, so the residue is deterministic (§5). C2b then started at 20:50:51.321
with no limits. It was killed at 20:50:53.7–54.2Z with
`Stop-Process -Force` on tsx (pid 21844) and its node child (1120), about 3 s
into part 3.

- Row `b7974f56`: **`running`**, `heartbeat_at 20:50:54.198`
  (`heartbeat_part: part 3/3`), 6.7 s old at the first read.
  `runInProgress.completedParts`: still **2**.
- **Windows note.** There is no SIGTERM here. `Stop-Process -Force`, like
  Node's own `process.kill(pid,'SIGTERM')` on Windows, is TerminateProcess, so
  sync-log's signal handler never ran and the row stayed `running`. On a Linux
  GHA runner, a SIGTERM fires that handler: `failSync` turns the row `failed`
  with `node-aborted-SIGTERM`, and mark-killed then sees an own terminal row.
  The `reaped` path (§3a) is the kill the handler cannot see: SIGKILL, OOM, or a
  live row reaped by the nightly.

### 3a. The reaper's two reads (migration `20261010050000`)

A seconds-old row proves nothing, because the old age-only predicate would not
reap it either. So the row's `started_at` was first backdated 2 h by hand, to
stand in for the 10-08 run: alive, but more than 60 min old.

```
-- read 1: started_at 18:50:51.321 (2 h old), heartbeat_at 20:50:54.198 (13.8 s old)
SELECT count(*) FROM reap_stale_sync_log(1);   -- at 20:51:08.027
 reaped
--------
      0

-- read 2: heartbeat_at set to now() - 2 h (18:51:12.887)
SELECT * FROM reap_stale_sync_log(1);          -- at 20:51:12.891
 id                                   | pipeline         | reaped_at
 b7974f56-62b6-4827-af79-c7eba6a330a2 | usaspending_bulk | 2026-10-10 20:51:12.886928+00
```

After read 2 the row is `reaped`. Its `error_message` is
`reaped_orphan — no completion after 1 min; …`, and its `reap_note` ends with
"Reaped because the row's last heartbeat (metadata.heartbeat_at, FIX-1291) - or
started_at, when it never stamped one - is older than reap_stale_minutes."
Under the 0731 body, read 1 would have reaped the live row, exactly as on 10-08.
The migration's own test runs the same pair inside a rolled-back transaction,
plus a no-heartbeat row and a junk-heartbeat row, which are both reaped.

## 4. Run D — the resume completes

**Attempt 1 of C (§3) and D2** both took this path. D2 ran
20:51:54–20:52:00Z after the C2b kill:

```
[prod-session] swept 17 leftover hold(s) from a session that did not release — freshness was unwatched for those pipelines until now (FIX-1177)
Resuming delta run (2 CSV part(s) already complete — skipping): Delta archive dated 20261010
── part 1/3 (FY(All)_All_Contracts_Delta_20260924_1.csv) already complete — skipping
── part 2/3 (FY(All)_All_Contracts_Delta_20260924_2.csv) already complete — skipping
✓ part 3/3 checkpointed — 20,000 rows in 0.1 min (5760 rows/s)
[tail] VACUUM (ANALYZE) external_source_refs — 0.3s
```

- Row `a0a196f3`: `complete`, `parts_done 3/3`, `parts_this_invocation 1`, `fr_rows_changed 1,607`. That is part 3's re-run after C2b had already written some of it.
- State: `{"baseline": {"lastArchiveDate": "20261010", "lastRunType": "delta", …}}`. **`runInProgress` is gone.**
- The tail ran: `external_source_refs.last_vacuum` 20:48:19.70 (attempt 1, 0.5 s) and 20:51:59.87 (D2), `vacuum_count` 3 across the rehearsal, `metadata.xsr_vacuum: {ok: true, seconds: 0.3}`. FR and FE got no script VACUUM; on prod their owners are the 03:00Z and 04:50Z jobs.
- The `--local-archive` zip is **kept** (125,611,479 bytes, still in the scratchpad). A `--local-archive` zip is never the pipeline's to delete. A DOWNLOADED zip under `--keep-archive` is deleted only when its category completes.
- The killed session's 17 guarded holds were swept by the next claim, so the FIX-1177 self-heal works across a hard kill.

## 5. Run E — the C1 proof (a re-run of the completed archive)

`--gate-wait-s 0 --breather-s 5`, 20:49:04–20:49:29Z. The baseline was already
20261010 and `runInProgress` empty, so all three parts ran again as a fresh run.

| part | sent | FR changed | rows/s |
|---|---:|---:|---:|
| 1/3 | 15,356 | 1,237 | 4,727 |
| 2/3 | 13,678 | 1,579 | 5,687 |
| 3/3 | 13,849 | 1,871 | 5,346 |
| **total** | **42,883** | **4,687 (10.9 %)** | |

**Counter deltas over the run:**

| table | `n_tup_ins` | `n_tup_upd` | `n_tup_hot_upd` | `n_dead_tup` |
|---|---:|---:|---:|---:|
| financial_relationships | 37,117 → 37,117 (**+0**) | 3,896 → 8,583 (**+4,687**) | 0 | 3,896 → 8,583 (**+4,687**) |
| financial_entities | 292 → 292 (+0) | 292 → 292 (+0) | 0 | — |
| external_source_refs | 292 → 292 (+0) | 0 | 0 | — |

Without the predicate, all 42,883 conflicting rows would have been rewritten:
every FR index plus a dead tuple each. With it the run wrote 4,687, which is
**89.1 % avoided**. Each part also ran 3.3–6.8× faster than its first pass.

**The residue is not ≈ 0, and the prompt's expectation was wrong in a way
worth knowing.** `contract_award_unique_key` is an AWARD key, not a
transaction key. The comment at the filter says "transaction-level", which is
wrong. Within the 60k rows, 1,299 award keys carry more than one transaction,
6,974 rows in all. Each one rewrites the same FR row, last write wins, so a
replay walks every such row back through its earlier values and forward again.
The file itself bounds that at 6,972 replay writes (scratch census:
`amount > 0` rows, last-write-wins per key, before the agency filter and the
per-batch dedupe). The pipeline's 4,687 sits inside that bound, and C2a
reproduced parts 1–2 exactly (1,237 / 1,579), so the residue is deterministic.
On a file with one transaction per key, the re-run would write 0. The
consequence for the data, not the predicate: an award's FR row holds ONE
transaction's obligation, the last one read, not the award's total. That is
FIX-1298's territory, appended there.

## 6. mark-killed on the clone

The fixture was C2b's reaped row, bound by hand to `metadata.github_run_id =
cc214-rehearsal`. The rehearsal's other rows carry no run id, so they read
"unknown" rather than "own". The invocation was
`GITHUB_RUN_ID=cc214-rehearsal pnpm run data:mark-killed -- --pipeline=usaspending_bulk --window-hours 6`.

- **The red, which is the pre-change script** (`git show 0ab88346:…/mark-killed.ts`, run in place and then restored):
  `5 terminal usaspending_bulk row(s) in window belong to other run(s) … — NOT treated as this run finishing (FIX-963)`
  then `no 'usaspending_bulk' running row in last 6h — no-op (workflow may not have started)`. That is the 10-08 behaviour.
- **The new script:** `wrote 'nightly_killed' row for orphan usaspending_bulk run (id=b7974f56-…, status=reaped, …, own_run=true, reaped_first=true, completed_at=NULL)`. The row is `nightly_killed`, `failed`, `started_at 18:50:51.321` (the backdated start), `completed_at NULL`, `error_message workflow-timeout-or-sigterm`, `source_pipeline usaspending_bulk`, `reaped_first true`, `orphan_own_run true`, `own_run_binding run-id`, `window_hours 6`.
- **A `complete` own row:** D2's row bound to `cc214-rehearsal-d2` gave `usaspending_bulk own run finished (status=complete, id=a0a196f3-…) — no-op`.

## 7. The heartbeat's cost

`pg_stat_statements` on the clone, for the whole rehearsal: the heartbeat
`UPDATE public.data_sync_log SET metadata = COALESCE(metadata,…) || jsonb_build_object('heartbeat_at', now()) || $2` ran
**171 calls, 0.050 ms mean, 0.15 ms max, 8.6 ms total**. It stamps once per
1,000 matched rows plus the part boundaries, so its rate follows throughput. On
the clone, at 700–5,800 rows/s, that is about 0.5–4 calls/s. At prod's 10-08
part-3 rate it is about 0.16 calls/s: 756,028 rows in 60.0 min is 210 rows/s,
about 3/4 of rows match, so about 158 rows/s and one flush every 6.3 s. That
is under the prompt's 0.2/s, at roughly 8 µs/s of server time. Negligible
either way.

## 8. Walls and what they say about cc-215

| run | rows/s, first pass (writes) | rows/s, re-read (skips) |
|---|---|---|
| clone, rehearsal | 697 / 1,368 / 1,638 | 4,727–5,760 |
| prod, 10-08 (cc-209 §4) | parts 1/2/3: 345 / 308 / 210 | — |

Clone walls are not prod walls; they run in both directions (playbook C4, E4).
What carries over is the ratio: a re-read part is several times cheaper than a
first pass. cc-215 will re-read parts 1–3 of the real delta, because the 10-08
run landed them but checkpointed nothing. With the predicate, that re-read
writes about 11 % of what it reads (this file's duplicate-key churn), instead
of every row as on 10-08.

## 9. Clean-up

- The clone's `pipeline_state.usaspending_bulk_state` was restored to the pre-rehearsal snapshot (baseline 20260706 both).
- Local jobid 85 was re-activated at 20:41Z.
- The rehearsal's FR / FE / xsr rows stay on the clone. They are real 09-24 delta rows, a subset of what prod lands in cc-215.
- The real archive stays in `TMP_DIR` for cc-215.
- No prod write came from the rehearsal.
