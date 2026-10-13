---
slug: dispatcher
title: "Job registry + unit dispatcher — BY replaces AT"
lanes: [ops, design]
status: active
plan: spec-job-registry-and-dispatcher-2026-10-11 (Cowork project; v1.1)
goal: "P1 · Infrastructure"
steps:
  - {id: s1, kind: cc, ref: "cc-223", title: "R1 — registry tables + seed + check:job-registry + playbook D9 + the contract audit (branch; lands Wed)"}
  - {id: s2, kind: cc, ref: "cc-225", title: "N1 — the nightly's fec_bulk writer takes the FIX-950 claim (branch; lands Thu)"}
  - {id: s3, kind: cc, ref: "cc-224", title: "R2 — dispatch_one_unit() + dispatch_tick() + the ARM/reap path + the route re-fire + the tile (branch; lands Thu)"}
  - {id: s4, kind: op, ref: "cc-226", title: "R1 lands — one gated migration, inert for the s14 S1 ring", after: 2026-10-14T23:15Z}
  - {id: s5, kind: op, ref: "cc-227", title: "R2 + N1 land — one gated migration + Vercel + the GHA step; ZERO eligible rows", after: 2026-10-15T23:15Z}
  - {id: s6, kind: receipt, ref: "FIX-1308", title: "proving Thu 23:15Z → Mon ~02:00Z (≈ 75 h, contains the Sun 10-18 drop night): tick cadence held on odd minutes, no unrecovered gap > 6 min, the re-fire exercised once (park the tick 10 min Sat), the tick's own cost from pgss, the Fri/Sat/Sun nightlies' claims visible in prod_session_state() and the guarded jobs skipped under them", after: 2026-10-19T02:00Z}
  - {id: s7, kind: op, ref: "", title: "M1 — donor-rollup → stale_after 12 h (one registry row; the 0 9,12 cron parked)", after: 2026-10-19T16:00Z}
  - {id: s8, kind: receipt, ref: "FIX-1308", title: "M1 72 h: watermark lag ≤ 13 h at every read; the R3 overlap with ec-crawl not re-created; band held → the dial to 6 h", after: 2026-10-22T16:00Z}
  - {id: s9, kind: op, ref: "", title: "V1 — fr-vacuum-analyze as a unit (dead_tuples > 60 % + floor 24 h; the 03:00Z cron parked; the role's vacuum_cost_delay set)", after: 2026-10-20T16:00Z}
  - {id: s10, kind: op, ref: "", title: "E1 — ec-crawl eligible (stale_after 10 min under its */15 floor) + yield_to → exclusion_group + 3 small vacuums", after: 2026-10-21T16:00Z}
  - {id: s11, kind: op, ref: "", title: "N2 — the nightly START by 21:00Z..23:00Z via the gha-dispatch stamp + 1124 part 2 retires the blackout config + 3 vacuums", after: 2026-10-22T16:00Z}
  - {id: s12, kind: op, ref: "", title: "the remaining ~6 vacuums (2–3/day) + R1b cron_job_budget → VIEW", after: 2026-10-23T16:00Z}
  - {id: s13, kind: design, ref: "FIX-1125", title: "the swap-in sensor design (Cowork, Wed/Thu 10-14/15; built against the 7 banked slot-window days)"}
  - {id: s14, kind: design, ref: "", title: "s7 contract-flow chunking design (Cowork, Thu/Fri after the Thu 14:00Z M3 reading)"}
  - {id: s15, kind: cc, ref: "FIX-1125", title: "FIX-1125 sensor + D8 headroom + the controller", after: 2026-10-19T16:00Z}
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
