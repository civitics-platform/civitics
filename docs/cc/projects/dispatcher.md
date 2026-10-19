---
slug: dispatcher
title: "Job registry + unit dispatcher — BY replaces AT"
lanes: [ops, design]
status: active
plan: spec-job-registry-and-dispatcher-2026-10-11 (Cowork project; v1.1) + v1.3 cutover note (spec-dispatcher-v1.3-cutover-from-zero-2026-10-13)
goal: "P1 · Infrastructure"
steps:
  - {id: s1, kind: cc, ref: "cc-223", title: "R1 — registry tables + seed + check:job-registry + playbook D9 + the contract audit (branch; lands Wed)", done: 2026-10-13}
  - {id: s2, kind: cc, ref: "cc-225", title: "N1 — the nightly's fec_bulk writer takes the FIX-950 claim (branch; landed by cc-227)", done: 2026-10-14}
  - {id: s3, kind: cc, ref: "cc-224", title: "R2 — dispatch_one_unit() + dispatch_tick() + the ARM/reap path + the route re-fire + the tile (branch; landed by cc-227)", done: 2026-10-14}
  - {id: s4, kind: op, ref: "FIX-1307", title: "R1 lands (cc-226) — one gated migration, inert for the s14 S1 ring; rode with FIX-1312's vote-stats-refresh park", after: 2026-10-14T23:15Z, done: 2026-10-14}
  - {id: s5, kind: op, ref: "FIX-1308", title: "R2 + N1 land (cc-227) — one gated migration + Vercel + the GHA step; ZERO eligible rows (landed 2026-10-15 03:12Z, Craig's call #2 (a))", done: 2026-10-14}
  - {id: s6, kind: receipt, ref: "FIX-1308", title: "proving Thu 23:15Z → Mon ~02:00Z (≈ 75 h, contains the Sun 10-18 drop night): tick cadence held on odd minutes, no unrecovered gap > 6 min, the re-fire exercised once (park the tick 10 min Sat), the tick's own cost from pgss, the Fri/Sat/Sun nightlies' claims visible in prod_session_state() and the guarded jobs skipped under them", after: 2026-10-19T02:00Z}
  - {id: s7, kind: op, ref: "FIX-1316", title: "RETURN M1 — donor-rollup-refresh → stale_after 12 h (its cron parked since s16; write the row's rule + flip it + read the first dispatched firing in band) — cc-234 landed it 10-16 03:22Z; first firing 03:25Z in band (69 ms); the 13:00Z window retired by the donor_rollup_rebuild_bulk_dispatched() wrapper", after: 2026-10-15}
  - {id: s8, kind: receipt, ref: "FIX-1316", title: "M1 72 h+ (Mon evening; contains the Sun drop night): watermark lag ≤ 13 h at every read; the dispatched firings in band; cooldown rows named; → the dial to 6 h — s8 input (cc-238): firings 10-18 03:41Z dirty 1,296.7 s (662 targets, 133,605 rows, sweep → 10-17 21:08:59Z; receipts verdict above 0–400 s) → 16:05Z caught up 40 ms → 10-19 04:09Z dirty 1,147.9 s (645 targets, 116,698 rows, watermark → 10-18 22:31:59.42Z, the drop-Monday class 878–1,446 s) → 16:31Z caught up 34 ms; no cooldown row, no budget action; the anchor is the run's END (03:41 → 16:05 → 04:09 → 16:31, FIX-1323)", after: 2026-10-19T23:15Z}
  - {id: s9, kind: op, ref: "FIX-1320", title: "MOVE V1 — fr-vacuum-analyze as a unit (dead_tuples > 60 % + floor 24 h; the 03:00Z cron parked AT this move — vacuums are KEEP, never parked by s16; the role's vacuum_cost_delay set) — cc-235 landed it 02:12Z (cron jobid 38 parked); first dispatched VACUUM 03:03:00Z 9,508 ms; vacuum_cost_delay NOT set (D-c)", after: 2026-10-17T02:12Z}
  - {id: s10, kind: op, ref: "FIX-1327", title: "RETURN E1 — ec-crawl eligible (stale_after 10 min under its */15 floor) + yield_to → exclusion_group + 3 small vacuums (parked since s16) — cc-237 landed it 00:33Z (ec-crawl stale_after 10 minutes, fe-crawl stale_after 25 minutes); first units 00:37Z (ec, donations window 1/16, 18,770 ms) / 00:39Z (fe, 2,172 ms); the 3 small vacuums wait for FIX-1322 + FIX-1326", after: 2026-10-18T00:33Z}
  - {id: s11, kind: op, ref: "", title: "N2 — the nightly START by 21:00Z..23:00Z via the gha-dispatch stamp + 1124 part 2 retires the blackout config + 3 vacuums (GHA — untouched by s16)", after: 2026-10-22T16:00Z}
  - {id: s12, kind: op, ref: "", title: "MOVE the remaining ~6 vacuums (2–3/day) + RETURN the parked dailies then weeklies + R1b cron_job_budget → VIEW and R1b's cron.unschedule of the returned jobs", after: 2026-10-23T16:00Z}
  - {id: s13, kind: design, ref: "FIX-1125", title: "the swap-in sensor design (Cowork, Wed/Thu 10-14/15; built against the 7 banked slot-window days)"}
  - {id: s14, kind: design, ref: "", title: "s7 contract-flow chunking design (Cowork, Thu/Fri after the Thu 14:00Z M3 reading)"}
  - {id: s15, kind: cc, ref: "FIX-1125", title: "FIX-1125 sensor + D8 headroom + the controller", after: 2026-10-19T16:00Z}
  - {id: s16, kind: cc, ref: "cc-232", title: "park-derived-layer — the 18 derived-layer pg_cron jobs active := false by name + 16 FIX-1059 hold rows (FIX-1311); the 20 plumbing jobs stay on; each parked job returns only through the registry"}
  - {id: s17, kind: op, ref: "FIX-1321", title: "RETURN the first two by dailies — fe-inbound-rollup-refresh by 13 2 * * *, vote-stats-refresh by 30 3 * * * (cc-235; the by form's first prod exercise) — first firings 02:17:00Z (58 / 16,388 ms), the 03:30Z slot 03:35:00Z (16,727 ms)", after: 2026-10-17T02:12Z}
  - {id: s18, kind: cc, ref: "cc-236", title: "readers: receipts band-judge dispatched firings (1318) + the canary's held-aware rate check (1315) + UTC done.log dates (1319)", done: 2026-10-16}
  - {id: s19, kind: op, ref: "FIX-1328", title: "RETURN rule-taggers-weekly on a stale_after 7 days bridge (cc-237); first dispatched weekly Tue 10-20 ~16:15Z → FIX-1284 2nd / FIX-1248 close → FIX-1258", after: 2026-10-18T00:33Z}
  - {id: s20, kind: cc, ref: "", title: "B1 — the dispatcher-body prompt: FIX-1322 io-class cap, FIX-1323 phase-lock, FIX-1326 NULL anchor, FIX-1329 by-weekly/monthly forms; switches rule-taggers-weekly to by 0 16 * * 2 and returns rule-taggers-daily in the same push (after Tue 16:15Z)", after: 2026-10-20T18:00Z}
---

# Job registry + unit dispatcher

Craig's brainstorm line from 10-07 is the whole idea: a **registry** of every
scheduled job, and a **dispatcher** that picks the highest-priority job nearest
its deadline whose group is clear, reads the box, runs ONE unit under a budget,
records it and stops. A job stops being "run AT 03:00" and becomes "be fresh BY
a deadline". The registry (FIX-1307) is three tables, `job_registry`,
`platform_dials` and `dispatch_log`. Its seed is read from prod's live
`cron.job`, `cron_job_budget` and `rollup_watch_overrides`, and every row starts
as `at <its cron schedule>`, so landing it changes nothing. The dispatcher is
FIX-1308. Folding `cron_job_budget` into a VIEW over the registry is FIX-1309.

Three constraints are not on the calendar, and they set the order. The s14 S1
ring window (Wed 02:30Z → Thu 02:30Z) must see nothing that runs change, so R1
lands inert on Wed 23:15Z and R2 lands after the window closes. R2's proving
must contain a drop night, so it runs Thu → Mon and covers Sun 10-18. And the
first-run row moves (M1, V1, N2) go **one per day**, so a regression has
exactly one suspect.

**Dials are data.** Every runtime value — tick cadence, unit target, the
Σ-caps ceiling, headroom, pause, each job's deadline rule and priority — is one
row write. A row move is a one-row `UPDATE`; a regression is a revert of that
row. Nothing in the build redefines a procedure body to change behaviour.

The four Cowork decisions of 10-11 evening (Craig's go), as R2 will build them:
**C1** the dispatcher ARMS every unit as a one-shot pg_cron job and never
`EXECUTE`s inline; **C2** the tick is a SECURITY DEFINER function wrapped by a
budgeted `CALL` procedure on ODD minutes; **C3** Vercel probe routes are not
registry rows; **C4** `dispatch_log` retention lives inside the tick.

The nets, outermost first: `platform_dials.pause`; `max_live_caps_mb` (1,024,
the box rule cc-210 R3 measured); the `*/2` budget watchdog, which still
cancels any unit over its `budget_seconds`; the front-door auto-restart; and
the box-health route, which re-fires a stale tick (FIX-1137's option A).

The design of record is the Cowork spec
`spec-job-registry-and-dispatcher-2026-10-11` v1.1 (D1–D12 ratified), which is
not in the tree. Each prompt restates the decisions it rests on. The contract
itself becomes playbook D9, and cc-223's contract audit (dated 2026-10-12) is
the first census of the 41 against it. Both ride FIX-1307's branch and reach
main with cc-226.

## s16 — the derived layer is parked (cc-232, FIX-1311, 2026-10-13)

Craig's decision on Mon 10-12 (~20:20 PDT): the dispatcher migrates from
**zero**, not alongside cron. Every derived-layer pg_cron job is parked
(`active := false`, by NAME) by
`20261013230000_fix1311_park_derived_layer_crons.sql`. R1 and R2 then land on a
quiet box. Each job comes back **only** through a registry row with a real
deadline rule (`stale_after` / `by` / `dead_tuples`): one return, one receipt.
Derived data goes stale for a week or more, and Craig accepts that. In return:

- the s6 proving week is clean, because no cron jobs are running for the tick
  to defer around;
- no job ever has two owners;
- the two Tuesday weeklies that wedged the box twice in seven days stay off
  until they come back behind `box_is_saturated()`. They are jobid 10
  (`refresh-derived-mvs-weekly`, 10-13) and jobid 12 (`rule-taggers-weekly`'s
  lineage, 10-06).

**PARKED — 18 jobs.** Each pipeline below has a FIX-1059 hold row in
`rollup_watch_overrides`, with `hold_reason` = `parked for the dispatcher
cutover (cc-232, FIX-1311); returns via job_registry`. Two pairs share a
pipeline, so 18 jobs make 16 rows.

| job | pipeline (Q_CRON_JOB_PIPELINES) | class |
|---|---|---|
| `ec-crawl` | `entity_connections_rebuild` | crawl |
| `fe-crawl` | `financial_entity_totals_refresh` | crawl |
| `donor-rollup-refresh` | `donor_rollup_refresh` | daily ×2 |
| `fe-inbound-rollup-refresh` | `financial_entity_inbound_rollup` | daily |
| `rule-taggers-daily` | `run_rule_taggers` | daily |
| `refresh-derived-mvs-daily` | `refresh_derived_mvs` | daily |
| `donor-party-rollup-refresh` | `donor_party_rollup_refresh` | weekly |
| `treemap-individuals-global-refresh` | `treemap_individuals_global_refresh` | weekly |
| `contract-flow-rollups-refresh` | `contract_flow_rollups_rebuild` | weekly |
| `agency-staffing-rollup-refresh` | `agency_staffing_rollup_refresh` | weekly |
| `group-donor-rollup-refresh` | `group_donor_rollup_refresh` | weekly |
| `rule-taggers-weekly` | `run_rule_taggers` | weekly |
| `refresh-derived-mvs-weekly` | `refresh_derived_mvs` | weekly |
| `financial-entity-totals-reconcile` | `financial_entity_totals_reconcile` | monthly |
| `donation-edge-orphan-sweep` | `donation_edge_orphan_sweep` | monthly |
| `donor-party-rollup-orphan-sweep` | `donor_party_rollup_orphan_sweep` | monthly |
| `donor-rollup-orphan-sweep` | `donor_rollup_orphan_sweep` | monthly |
| `entity-connection-stats-orphan-sweep` | `entity_connection_stats_orphan_sweep` | monthly |

**KEPT ON — 20 jobs (the plumbing).**

- `box-health-probe`: the dispatcher reads `box_is_saturated()` off its stamp.
- `cron-job-budget-watchdog` and `derived-mvs-unit-watchdog`: they bound
  whatever the dispatcher arms.
- 13 vacuums, plus `vm-probe-pre-ec`: `dpr-`, `ec-`, `ecs-`, `fe-`, `fr-`,
  `odbt-`, `odr-mv-`, `odt-`, `officials-`, `osar-`, `osdr-`,
  `treemap-individuals-` and `xsr-vacuum-analyze`. The GHA nightly keeps
  landing FR rows, so these must keep running (FIX-943).
- `abuse-events-retention`, `cron-job-run-details-retention` and
  `platform-counts-daily`.

**NOT NAMED by cc-232, so left as they were — all active on prod at 23:14Z:**
`vm-probe-pre-fe`, `vm-probe-pre-fr`, `votes-vacuum-analyze` and
`vote-stats-refresh`. The first three are plumbing in all but name.
`vote-stats-refresh` (`CALL rebuild_official_vote_stats()`, daily 03:30Z,
guarded, pipeline `official_vote_stats_rebuild`) is a derived-layer rollup.
Under the decision's own logic it would have been parked. Whether to park it is
Craig's call; it is still on.
`vote-stats-refresh` parked by cc-226, FIX-1312 (2026-10-15 02:10:51Z, the same gated push as R1); 19 parked / 17 hold rows.

**Already inactive and not touched:** `entity-connection-stats-rebuild`,
`financial-entity-totals-incremental`, `rebuild-ec-incremental` and
`rebuild-ec-incremental-mon`.

**A return** means three things: write the row's deadline rule, flip it to
eligible, and read the first dispatched firing in band. The same change also
deletes that pipeline's hold row. (M1 CONVERTED it instead, into a `cadence_hours = 12` declaration — FIX-1316 D-c — so `list_scheduled_rollup_pipelines()` reads an override, not an orphan, until the canary reads the registry rule, FIX-1317.) Where a daily and a weekly share a pipeline,
the row goes when the second of the pair returns. A return never re-schedules
the cron job, because that would mint a new jobid. The parked row stays
`active = false` until R1b's cleanup `cron.unschedule`s it.

**Recommended return order** (Cowork's; Craig decides):

1. the two crawls, one at a time — they can resume, and each has a week of
   changes to walk;
2. `donor-rollup-refresh` (`stale_after 12 hours`);
3. the vacuum class, moved under `dead_tuples` rules (V1). The vacuums are
   KEEP, so this is a move, not a return;
4. the dailies (`by HH:MM`);
5. the weeklies, last. They come back behind `box_is_saturated()` by
   construction.

The dated `after:` slots on s7/s9/s10/s12 above still follow the pre-park
order (M1, then V1, then E1). They have not been re-sequenced to put the crawls
first; moving them is Craig's call.

**For cc-226 / `check:job-registry`:** an inactive `cron.job` row with an `at`
registry row is the **expected cutover state**, not drift. If the checker fails
on it, adjust the checker, not the park.

**Receipts:** in the daily receipts file, an `inactive` verdict for any of the
18 is the cutover, not a fault. The cron lookback is 14 days, so a parked job
keeps showing its last pre-park firings, still band-compared, until those age
out. A firing dated after the park instant is the fault. The cron-slot receipts that FIX-1248, 1284,
1295 and 1296 were waiting on become first-dispatched-firing receipts when
their jobs return.

**Rollback** (whole cutover, valid only before the first return):
`scripts/fix1311-unpark-derived-layer-crons.sql`, run with
`db-query --prod --call --yes-i-mean-prod --file` under a FIX-950 claim. It
flips the 18 back by name and deletes the 16 hold rows by their `hold_reason`.
Once any job has returned, un-park the rest one at a time instead.

## s6 — the proving ledger (opened by cc-227, 2026-10-15 03:13Z)

R2 reached prod at 03:12Z: `20261015230000`, one gated push from the primary
under the FIX-950 claim. The push log printed `[fix1308] scheduled
dispatcher-tick (jobid 58) at 1-59/2 * * * *`, and the budget row is 120 s. The
first tick fired at **03:13:00Z**. So the proving runs Thu 03:13Z → Mon 10-19
~02:00Z, about 95 h rather than the ≈ 75 h the step title assumed from a Thu
23:15Z landing. Every registry row is still `at …`, so until M1 every tick is
`nothing_due` with reason `no eligible rows`. N1 (FIX-1310) is on main from
`6b8f5bb3`, and `nightly.yml` reads it at the next 21:00Z start.

The columns (D-g):

- **ticks/60 min**: `pg_cron`-source `dispatch_log` rows in a trailing 60
  min. Expect 30 ± 1, every one on an odd minute.
- **longest gap**: the max `ticked_at − lag(ticked_at)`. Expect ≤ 6 min, or a
  gap recovered by a `vercel`-source row.
- **vercel rows**: `source = 'vercel'`. Expect 0 until cc-228's Sat park
  exercise.
- **tick pgss**: `calls · mean · max` of `CALL public.dispatch_tick()`.
- **armed**: `decision = 'armed'`. Expect 0 all week.
- **box-health ms**: the */2 route's own `elapsed_ms`, before → after.
- **status ms**: `section_times.dispatcher` in the */30 status snapshot
  (rolls at :01/:31).

| window | owner | ticks/60 min | longest gap | vercel rows | tick pgss | armed | box-health ms | status ms | notes |
|---|---|---|---|---|---|---|---|---|---|
| Thu 10-15 03:13→04:13Z, the first hour | cc-227 | 30 in the trailing 60 min at 04:14:07Z (31 since 03:13:00Z), every one on an odd minute | 00:02:00.12 | 0 | 31 · 32.9 ms · 71.0 ms | 0 | before 469–908 (n=17, median 578) → after 452–1269 (n=30, median 570); no dispatcher line, so no re-fire | 144 (first roll 03:31:16Z; in-DB 3.6 ms direct / 17.8 ms via PostgREST) | one `live_units 1` / 128 MB at 03:53:00Z = `platform-counts-daily` (KEEP, 03:53:00→03:53:29Z, succeeded); runs 31/31 succeeded, avg 35 ms, max 76 ms; `cron.job` t 24 / f 23; `cron_job_budget` 21 |
| Thu 10-15 03:13Z → Fri 10-16 02:00:18Z, the first 22 h 47 min | cc-228 | 30 in every full hour 04Z→01Z (22 of 22) and 24 in the 03Z hour from 03:13; 30 trailing at 02:00:18Z; 684 rows, `even_minute_rows` 0 | 00:02:03.66 (min 00:01:56.77); 0 gaps > 3 min | 0 | 684 · 35.2 ms · **2,666.9 ms** | 0 | before 451–999 (n=33, median 603) → after 430–6,534 (n=680, median 704). The logged `elapsed_ms` is printed BEFORE the dispatcher read, so it cannot carry R2's cost (cc-227's comparison included) | 283–659 over the last four rolls (00:02 659 · 00:31 340 · 01:01 283 · 01:31 290); in-DB 0.95 ms, PostgREST pgss 46 calls · 26.4 mean · 530.8 max | per hour (pg_cron): 03Z 24, then 04Z–01Z 30 each (vercel 0, other 0, every hour). Runs 684/684 succeeded, avg 38 ms. The max is runid 128502, 21:09:00.94→21:09:03.87Z (2.921 s, launched 0.94 s late) inside the Thu nightly, `live_units` 1. `live_units > 0` on 8 rows: 03:53 `platform-counts-daily` 128 MB, 11:05 `odr-mv-vacuum-analyze` 64 MB, 21:01–21:13 the GHA nightly's `nightly_cron` phases 128 → 192 MB. 6 rows ticked > 0.3 s late (max 3.72 s at 21:09, 1.68 s at 01:33). One route read error at 01:00:30Z (`dispatch_log read failed: Supabase query timed out after 2000ms`, in a run whose scrape took 5,418 ms): no re-fire, and the ticks either side are 2 min apart. Read by `db-query --prod` 02:00:18Z, Vercel runtime logs 01:57Z, `status_snapshot` 02:00:55Z |
| Fri 10-16: the receipts' §9 `unit_dispatcher` line | Fri receipts (read by cc-228) | 30/30 at 23:27Z | | 0 | | 0 | | | `2026-10-16.md` (generated 23:28:52Z): "Dispatcher (FIX-1308): 30/30 ticks last 60 min (last 1.9 min before this file, pg_cron); 24 h: 0 armed / 0 reaped / 0 missed / 0 skipped; 0 eligible rows; pause false". It carries jobid 58 (`no-band`), and `check:job-registry` reads 0 problems / 0 warnings against it: the WARN cleared |
| Thu 10-15 PDT (Fri 10-16 02:01:16→02:11:16Z): the park exercise (`dispatcher-tick` active := false for 10 min, pause = false) | cc-228 | 0 pg_cron rows while parked; 25 trailing at 02:15:41Z | 02:01:00.055 → 02:08:23.041 `vercel` (7 m 23 s) → 02:13:00.052 pg_cron (4 m 37 s) | **1** `nothing_due` | | 0 | the re-firing run's memory line 473 ms | | the re-fire exercised ONCE. Route line at 02:08:23.101Z: `[cron/box-health] dispatcher re-fired (last tick 442 s ago > 360 s — re-firing): nothing_due - — no eligible rows`. Exactly one, not "one every ~2 min": the route keys on the newest row of ANY source, so the `vercel` row reset the 360 s clock, and the next stale run (02:16:22) would have come after the un-park. The first pg_cron row after `active := true` was 02:13:00.052Z, odd, 103 s later. `pause` false and `disp-%` 0 at every read |
| Fri 10-16 03:22→04:27Z: M1's first armed/reaped rows (FIX-1316) | cc-234 | 30 trailing at 04:27:10Z, 0 on even minutes; since the push: armed 1 · reaped 1 · nothing_due 32 | 00:02:00.137 | 0 | 753 · 35.3 ms · 2,666.9 ms (cumulative since 10-15 03:13Z, so not separable by window). The tick's own run walls in the armed window: arm 167 ms (03:23), live 88 ms (03:25), reap 33 ms (03:27); the hour avg 41.7 ms, max 180 ms | **1** (reaped 1) | before 469–1,274 (n=28, median ≈706) → after 447–1,085 (n=32, median ≈671); no dispatcher line | 124 (03:31) · 154 (04:01), both carrying `rearm_cooldown_seconds` 1800. No roll fell inside the 03:23–03:27 armed window. Clone, live unit: the live-first LATERAL 11 buffers / 0.14 ms (was loops = every armed row: 4,283 floored / 6,301 unfloored) | `dispatch_log` 722 `armed` 03:23:00.189Z (`stale_after 12 hours → -2 days -03:22:59`, floor 129436, for 03:25:00Z; jobid 59 `disp-donor-rollup-refresh-1792120980`, postgres, budget 9000) → 723 `nothing_due · live (donor-rollup-refresh)` 1 unit / 128 MB → run 129442 03:25:00.041→.110Z succeeded → `data_sync_log` complete, the caught-up exit, 54 ms, targets 0 → 724 `reaped succeeded: CALL` unit_ms 69 at 03:27:00.049Z → 725 `next: donor-rollup-refresh in 11:58:00`. Band 0–400 s: in. `box_is_saturated()` (default args) read `watchdog_wall` from the 03:25:00Z probe: a 1.58 s budget-watchdog run at 03:24:00Z, before the run (148 of 5,026 runs > 1 s over 7 d); the dispatcher's own read excludes it (D2). Read by `db-query --prod` 04:27:10Z, Vercel logs 04:27Z |
| Sat 10-17 02:12→04:05Z: V1 (FIX-1320) + the first two `by` dailies (FIX-1321) | cc-235 | 30 trailing at 04:05:49Z, 0 on even minutes; since the push (02:12:28Z): armed 5 · reaped 5 · nothing_due 52, all pg_cron | 00:02:00.35 | 0 | 1,462 · 38.4 ms · 2,795.0 ms (cumulative). The tick's own run walls since the push: n=57, avg 55 ms, max 288 ms (03:55, idle), 0 not succeeded. Arm/live/reap: vote-stats arm 58 (02:13) · fe-inbound arm 44 (02:15) · live 57 (02:17) · reap 127 (02:19); fr arm 64 (03:01) · live 58 (03:03) · reap 113 (03:05); the 03:3x pair 52 (03:31) · 69 (03:33) · 40 (03:35) · 62 (03:37) | **5** (reaped 5) | after 478–1,054 (n=58, median 730); no `re-fired`, no `dispatch_log read failed`. Every line is level error on `off_box=FAILED(upstash LPUSH: ERR max requests limit exceeded …)`: the Upstash quota exhausted since 10-12 (FIX-1304 / FIX-1313), `on_box=ok` | 187 (02:31) · 136 (03:01) · 389 (03:31) · 181 (04:01); `eligible` 1 → 4 from the 02:31 roll | `dispatch_log` 1409 `armed` vote-stats-refresh 02:13:00.079Z (`by 30 3 * * * → -22:43:00` — the push landed 02:12:28Z, BEFORE 02:13, but the first tick ran after it, so fe-inbound's slot was already Sat 02:13 and vote-stats was the more overdue) jobid 61, for 02:17:00Z, no budget row → 1410 `armed` fe-inbound-rollup-refresh 02:15:00.065Z (`→ -00:02:00`, live 1/128) jobid 62, its 1800 s budget row (21 → 22) → runs 02:17:00Z both succeeded (vote-stats 16.39 s, complete 560 rows; fe-inbound 58 ms, complete, watermark caught up, 0 recipients) → 1411 `live` 2 / 256 MB → 1412/1413 `reaped succeeded: CALL` 02:19:00.04Z unit_ms 16,388 / 58 (budget 22 → 21). **fr:** 1435 `armed` 03:01:00.083Z (`dead_tuples > 60% of trigger + floor 24 hours → -00:00:59`: the FLOOR term, n_dead_tup 0 of a 312,158 trigger) jobid 63 `disp-fr-vacuum-analyze-1792206060` `3 3 17 10 *` postgres `VACUUM (ANALYZE) public.financial_relationships;`, NO budget row (21) → run 133012 03:03:00.035→03:03:09.543Z succeeded `VACUUM` → 1436 `live` 1/64 → 1437 `reaped succeeded: VACUUM` 03:05:00.056Z unit_ms **9,508** (cron 30-d p50/max 10.1/234.7 s) → last_vacuum 10-16 03:00:00.26Z → 10-17 03:03:00.18Z, vacuum_count 4 → 5, n_dead_tup 0 → 0; box clear before/during/after. **The pair:** 1451 `armed` donor-rollup-refresh 03:31:00.071Z (`stale_after 12 hours → -00:01:59`) jobid 64 → 03:33Z, 49 ms, the caught-up exit; 1452 `armed` vote-stats-refresh 03:33:00.109Z (`by 30 3 * * * → -00:03:00`, live 1/128) jobid 65 → 03:35:00.026→16.753Z, complete 560 rows, reaped 03:37:00.047Z 16,727 ms — ONE firing for the 03:30Z slot. No tick recorded `live_units 2` in the pair: each arm row carries the census taken before its own arm, and donor-rollup was reaped before vote-stats was counted. **57014:** [03:00, 03:15Z] 0 renders / 0 events vs [02:00, 02:15Z] 0 / 0; front door 0 / 225. **Drift (FIX-1323):** donor-rollup 03:25 → 15:29 → 03:33; fr 03:00:00 (cron) → 03:03:00 (dispatched), and its next anchor is the REAP tick 03:05:00.06Z, not the vacuum's 03:03:00.18Z, so Sun's run is 03:07 or 03:09Z. Read by `db-query --prod` 04:05:49Z, Vercel logs 04:07Z |
| Sun 10-18 00:33→03:54Z: E1 — ec-crawl + fe-crawl RETURNED (FIX-1327) + the weekly bridge (FIX-1328) | cc-237 | 30 trailing at 01:41:29Z and at 03:54:20Z, 0 on even minutes; since the push (00:33:05.92Z): armed 24 (ec 13 · fe 7 · fe-inbound 1 · fr 1 · vote-stats 1 · donor-rollup 1) · reaped 23 (donor-rollup live at the close) · nothing_due 76 (46 idle, 18 `cooldown:`, 12 `live (…)`), all pg_cron | 00:02:00.70 | 0 | 2,176 · 49.4 ms · **4,913.9 ms** (cumulative; was 2,064 · 44.6 · 3,499.5 at 00:12Z). The tick's own run walls since the push: n=100, avg 152 ms, max **4,949 ms** (the 02:05 fe reap tick, row stamped 02:05:04.36Z); arm ticks 48–582 ms; idle ticks rose from ~45 to 250–300 ms while donor-rollup's 03:41Z unit ran | **24** (reaped 23) | 486–1,046 (n=32, median 722) to 01:38Z, 0 `re-fired`, 0 `dispatch_log read failed`; every line `level: error` on the Upstash 500k quota (FIX-1304/1313) | 214 (01:01, eligible **7**) · 360 (01:31, live ec) · 155 (02:01) · 178 (02:31) · 575 (03:01) · 411 (03:31, live vote-stats) | First units: ec 2086 armed 00:35:00.334Z `stale_after 10 minutes → -4 days -02:54:29` → ran 00:37:00.039→00:37:18.809Z, donations window 1/16, 2,200 edges, 18,770 ms; fe 2087 armed 00:37:00.140Z → ran 00:39:00.032→00:39:02.204Z, one 70-row slice, caught up, 2,172 ms. Cadence ec 13:41–13:55 (15:52 / 15:55 / 15:29 when the arm lands on a :15/:45 skip), fe 27:58–30:00. Budget rows 21 → 22 (one crawl armed) → 23 (both) → 21; fr / vote-stats none. **First `units` row**: 02:17:00.126Z `live (ec-crawl)` 2 / 256 (ec + fe-inbound), again 03:51 (donor-rollup + ec). No `group busy`, no `caps`, no `gated`, no `missed`. **ec's FIX-1111 sensor tripped** at 03:01:31Z (window 11/16, 16.1 s/krow vs median 7.19, backoff_until 05:01:31Z) → fe `skipped` (peer_backoff) 03:03Z / 03:39Z, ec `skipped` (backoff) 03:17Z / 03:51Z → **the first I6 cooldown rows on prod**: `cooldown: fe-crawl (1 non-advancing reap(s), last 'succeeded: CALL' at 2026-10-18 03:05:00+00; re-arm at 2026-10-18 03:35:00+00)` (03:05:00.340Z), then `(2 …, re-arm at 04:41:00)` (03:41:00.080Z); ec's two rungs (re-arm 03:49Z, then 04:53Z by the formula) never show in a reason — fe sorts first and the tick logs one exclusion. fr floor 03:07:00.071Z `→ -00:01:59` → VACUUM 03:09:00.030→03:09:13.245Z, 13,215 ms (drift: 03:03 → 03:09, FIX-1323); fe-inbound 02:15Z → 750 ms; vote-stats 03:31Z → 17,413 ms; donor-rollup 03:39Z (15:37 → 03:41, +4 min) running 13 min+ at the close on the Sat nightly's donation rows. 57014: [00:33, 01:33Z] 0 renders / 0 events, front door 0 / 816; the hour before 0 / 0, 0 / 793 |
| Sun 10-18 21:00→23:00Z: the drop night (FIX-1310, FIX-1327) | cc-238 | 30 in the 21Z hour and 30 in the 22Z hour, 0 on even minutes; every tick 21:01:00.075→22:31:04.715Z (46) reads live **1 / 128** = the `nightly` registry row (pipeline nightly_cron, group fr-table), one 2 / 192 at 22:33:01Z (a vacuum in `pg_stat_progress_vacuum`; no cron vacuum then) | 00:02:08.31 | 0 | the tick's run walls 21:00→23:00Z: n=60, avg 838 ms, **max 7,879 ms** (runid 139695, 22:45:00.695Z, the post-release tail; the new s6 max), 0 not succeeded | **2** (fe 22:37:02.74Z, ec 22:51:00.31Z, both after the release) | [20:56, 23:04Z] 479–9,216 (n=65, median 1,244); 0 `re-fired`, 0 `dispatch_log read failed`; all `level: error` on the Upstash quota | 311 (21:01) · **28,668** (21:31, the roll's query_time 52 s mid-landing) · 1,251 (22:01) · 4,464 (22:31) · 359 (23:01) | Run 39165849274 (workflow_dispatch 21:00:12Z → 22:46:33Z success; fec-phase 21:00:15→22:35:27Z). fec_bulk ran on the FIX-903 **drop** trigger (`weekly stages: skipped (weekday)`, nominal slot day 10-19), 21:04:35→22:35:20Z complete. **N1's claim:** `exempting this run's own writer row(s): nightly_cron:fec (FIX-1310)` 21:04:35.14Z → `interlock acquired (prod_supervised_session)` 21:04:35.38Z → `held 5 guarded pipeline(s)` 21:04:35.77Z → … → `[fec-lock] interlock released` 22:35:20.93Z → `cleared 5 hold(s)` 22:35:21.28Z → `interlock released` 22:35:21.51Z (1 h 30 m 46 s). The reason string is not printed and `pipeline_state.prod_session` is gone; by `nightly-hold.ts:182` it was `nightly fec_bulk drop run 39165849274 …` (not `weekly`). **0 `gated: prod_session` rows:** ec-crawl sat on its FIX-1330 rung 4 (`cooldown: ec-crawl (4 …; re-arm at 22:49:00)`) and the cooldown is the first exclusion, so every tick logged it; fe-crawl (due ~21:12Z) was excluded by the prod_session gate by elimination and armed on the first tick after the release. After: fe slices 2,290 / 12,320 / 10,452 rows (22:39 / 23:09 / 23:39Z, 153.0 / 119.3 / 102.0 s), caught up to 22:31:59.42Z at 23:40:42Z; ec opened a NEW donations cycle 22:53Z with its target clamped to the horizon (21:53:00.18Z), windows 1–16 to 02:31Z, closed 09:47:27Z Mon; the landing's tail (to 22:31:59Z, 16,969 dirty donors) opened Mon 17:53Z. fr: no pct firing (n_dead_tup 15,224 at the 02:55Z probe vs 187,295) — FIX-1320's drop-night entry not met. 0 deferred rows; `fec_bulk_run_state` absent. FIX-1293's tile null on every roll from 21:31Z (8.2–17.0 s) |
| Thu 10-15 03:13Z → Mon 10-19 01:59Z: the close (FIX-1308) + the four receipts' §9 lines | cc-238 | 2,839 pg_cron tick-minutes; every full hour 10-15 04Z → 10-19 01Z reads **30** except 10-16 02Z (25 + 1 vercel, the park exercise); the opening 03Z hour 24; `even_minute_rows` 0 | **00:07:22.99** (ending at the 10-16 02:08:23.04Z vercel row, recovered); the only other gap > 3 min is its 4 m 37 s tail | **1** all week | pgss 3,382 · 104.9 ms · 7,813.5 ms at 20:09Z Mon (cumulative since 10-13 01:24Z; not separable at 02:00Z). Windowed run walls (jobid 58): **2,839 runs, avg 91.2 ms, p50 34 ms, max 7,879 ms** (Sun 22:45Z; the 02:05Z 4,949 ms is now third), 21 > 1 s, 0 not succeeded | **108** armed / 107 reaped (ec 55, fe 40, donor-rollup 6, vote-stats 3, fe-inbound 2, fr 2), **0 missed**, 0 error, 0 skipped — "0 all week" was superseded by the returns | see the drop-night row | | The §9 `unit_dispatcher` lines, 30/30 in all four: Fri 10-16 (0 armed / 0 eligible), Sat 10-17 (2 / 1), Sun 10-18 (6 / 4), Mon 10-19 (`80 armed / 80 reaped / 0 missed / 0 skipped; 7 eligible rows; pause false`, generated 22:46:11Z Sun; `dispatched` 80: ec 41, fe 34, donor-rollup 2 (`above` the 03:41Z dirty run 1,297,719 ms / `in-band` 57 ms), fe-inbound / fr / vote-stats 1 each, all no-band; `missed_24h` 0). `check:job-registry` against it: 54 rows, 0 problems, 0 warnings. The Mon 05:00Z canary 39202285976 success: 0 orphaned, 15 retired/held, fec_bulk's 126 h escalation gone, `run_rule_taggers` rate demoted (held). Record FIX-1308 `8e1995bd` (cc-238) |

**FIX-1137** stays open. It closes `closes-as-superseded` only once a `missed`
→ re-arm row has moved on prod. No registry row is eligible before M1, so the
re-arm path cannot fire until then.
