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
  - {id: s7, kind: op, ref: "", title: "RETURN M1 — donor-rollup-refresh → stale_after 12 h (its cron parked since s16; write the row's rule + flip it + read the first dispatched firing in band)", after: 2026-10-19T16:00Z}
  - {id: s8, kind: receipt, ref: "FIX-1308", title: "M1 72 h: watermark lag ≤ 13 h at every read; the R3 overlap with ec-crawl not re-created; band held → the dial to 6 h", after: 2026-10-22T16:00Z}
  - {id: s9, kind: op, ref: "", title: "MOVE V1 — fr-vacuum-analyze as a unit (dead_tuples > 60 % + floor 24 h; the 03:00Z cron parked AT this move — vacuums are KEEP, never parked by s16; the role's vacuum_cost_delay set)", after: 2026-10-20T16:00Z}
  - {id: s10, kind: op, ref: "", title: "RETURN E1 — ec-crawl eligible (stale_after 10 min under its */15 floor) + yield_to → exclusion_group + 3 small vacuums (parked since s16)", after: 2026-10-21T16:00Z}
  - {id: s11, kind: op, ref: "", title: "N2 — the nightly START by 21:00Z..23:00Z via the gha-dispatch stamp + 1124 part 2 retires the blackout config + 3 vacuums (GHA — untouched by s16)", after: 2026-10-22T16:00Z}
  - {id: s12, kind: op, ref: "", title: "MOVE the remaining ~6 vacuums (2–3/day) + RETURN the parked dailies then weeklies + R1b cron_job_budget → VIEW and R1b's cron.unschedule of the returned jobs", after: 2026-10-23T16:00Z}
  - {id: s13, kind: design, ref: "FIX-1125", title: "the swap-in sensor design (Cowork, Wed/Thu 10-14/15; built against the 7 banked slot-window days)"}
  - {id: s14, kind: design, ref: "", title: "s7 contract-flow chunking design (Cowork, Thu/Fri after the Thu 14:00Z M3 reading)"}
  - {id: s15, kind: cc, ref: "FIX-1125", title: "FIX-1125 sensor + D8 headroom + the controller", after: 2026-10-19T16:00Z}
  - {id: s16, kind: cc, ref: "cc-232", title: "park-derived-layer — the 18 derived-layer pg_cron jobs active := false by name + 16 FIX-1059 hold rows (FIX-1311); the 20 plumbing jobs stay on; each parked job returns only through the registry"}
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
deletes that pipeline's hold row. Where a daily and a weekly share a pipeline,
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
| Fri 10-16: the receipts' §9 `unit_dispatcher` line | Fri receipts | | | 0 | | 0 | | | the job-registry WARN on `dispatcher-tick` clears once a receipts file carries jobid 58 |
| Sat 10-17: the park exercise (`dispatcher-tick` active := false for 10 min, pause = false) | cc-228 | | recovered by `vercel` rows | ≥ 1 `nothing_due` | | 0 | | | the re-fire exercised ONCE, then active := true |
| Sun 10-18: the drop night (nightly ~21:00→23:00Z) | Mon prompt | held through the nightly | | | | 0 | | | N1's claim in `prod_session_state()`: reason `nightly fec_bulk weekly run <id> …`, `exempt_writers ['nightly_cron:fec']`, released in finally with no hold rows left; `live_units` 1 for the nightly (FIX-1310 owed) |
| Mon 10-19 ~02:00Z: the close, plus Mon's receipts §9 line | Mon prompt | | | | | 0 all week | | | the s6 receipt (FIX-1308 owed) |

**FIX-1137** stays open. It closes `closes-as-superseded` only once a `missed`
→ re-arm row has moved on prod. No registry row is eligible before M1, so the
re-arm path cannot fire until then.
