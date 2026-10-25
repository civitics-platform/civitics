---
slug: paced-ops
title: Paced ops — the census, the runner, the weekly merge
lanes: [ops, design]
status: active
plan: design-fix1248-weekly-size-tags-merge-2026-09-29 + design-paced-op-census-2026-09-26 §7
goal: "P1 · Infrastructure"
steps:
  - {id: s1, kind: cc, ref: "cc-162", title: "renders census + cancellation lens"}
  - {id: s2, kind: cc, ref: "cc-164", title: "paced runner: budget 3/CALL, breather census, edge floor p0 0.23 %"}
  - {id: s3, kind: design, ref: "FIX-1248", title: "weekly-merge paced-op design note — is rebuild_financial_entity_size_tags a paced op? phase_seconds lens", done: 2026-09-29}
  - {id: s4, kind: cc, ref: "cc-179", title: "weekly-merge prompt — not paced (design D2)"}
  - {id: s5, kind: op, ref: "FIX-1258", title: "compaction: pg_repack if available, else deferred (design D5) — cc-244 repacked entity_tags on prod 00:29:06→00:33:18Z Sat 10-24 under its own claim (heap 1,768 → 972 MB, relpages 226,259 → 124,400, total 4,422 → 2,169 MB); the twin 20261024000000 rode cc-247's gated push 2026-10-25 (no-op)", after: 2026-10-13, done: 2026-10-24}
  - {id: s6, kind: design, ref: "", title: "generic paced runner — lifted with the first windowable op (1240 backfill / dp full cycle / 1211)"}
  - {id: s7, kind: cc, ref: "cc-188", title: "census builds — the snapshot reads, 1132, 1145, the arm gate + park"}
  - {id: s8, kind: cc, ref: "cc-189", title: "FIX-1124 part 1 — crawls yield to peers (the first dispatcher instance)"}
  - {id: s9, kind: receipt, ref: "FIX-1124", title: "a week of peer_due/peer_running skips with zero crawl↔daily overlaps → part 2 retires the blackout", after: 2026-10-11T12:00Z}
  - {id: s10, kind: cc, ref: "cc-195", title: "FIX-1145 — the home-page MV reads the two rollups; jobid 24 refreshes it after a run that moved the watermark"}
  - {id: s11, kind: receipt, ref: "FIX-1145", title: "Mon 06:00 unit 4 ≤ 5 s; the first jobid 24 run that moves the watermark stamps homepage_mv_refreshed true", after: 2026-10-05T09:30Z}
  - {id: s12, kind: cc, ref: "cc-198", title: "FIX-1281 — per-phase preflight; the Tuesday records"}
  - {id: s13, kind: receipt, ref: "FIX-1281", title: "the first schedule fallback after landing reads already_ran=true on all four phases and exits in a runner-minute; a runnerless fec-phase (when one next happens) is retried", after: 2026-10-08T06:00Z, done: 2026-10-08}
  - {id: s14, kind: cc, ref: "cc-205", title: "FIX-1284 — the merge at work_mem 64MB behind the P1-A box gate; keyed units if 10-13 reads > 50 % of budget"}
  - {id: s15, kind: receipt, ref: "FIX-1284", title: "jobid 12's 10-13 16:00Z merge complete, phase_seconds in the projection, box clear and the ring quiet 16:02-16:10Z", after: 2026-10-13T18:30Z}
  - {id: s16, kind: cc, ref: "cc-209", title: "the Thursday records — 1281's fallback receipt, 501, 1255; 1189/1268 held under the USASpending saturation; the cap-kill filed"}
  - {id: s17, kind: cc, ref: "cc-210", title: "work_mem census R1–R6 + M1 — the postgres role default and five bodies at 64MB with parallel 0; FIX-1287's per-phase stamp"}
  - {id: s18, kind: receipt, ref: "FIX-1294", title: "the first platform-counts-daily after the push in band + a fresh postgres session reads 64MB", after: 2026-10-10T04:00Z}
  - {id: s19, kind: receipt, ref: "FIX-1295", title: "M1 bodies' first firings in band — ec-crawl's first dirty unit, donor-rollup's first watermark-moving firing, Sat 03:30 / 06:00 unit 9 / 06:30", after: 2026-10-12T10:00Z}
  - {id: s20, kind: cc, ref: "cc-211", title: "work_mem M2+M3 — treemap, donor-party + slice, contract-flow, the five sweeps at 64MB (group-donor STOPped at 256MB, FIX-1296); FIX-1293 landed but did not move prod (reopened); FIX-1290"}
  - {id: s21, kind: receipt, ref: "FIX-1295", title: "M2's Tuesday — treemap 14:00Z and donor-party 15:00Z in band (new bands), the ring quiet, beside the weekly at 64", after: 2026-10-13T16:00Z}
  - {id: s22, kind: receipt, ref: "FIX-1295", title: "M3 — contract-flow Thu 14:00Z in band; the five sweeps 11-01", after: 2026-10-15T15:30Z}
  - {id: s23, kind: cc, ref: "cc-212", title: "the Saturday records — 1189 (a+b+c), 1294's receipt, 1194's week line; 1295's M1 receipts held (no donation row stamped since 10-08, so no crawl rows and no watermark move; FIX-1297 filed)"}
  - {id: s24, kind: cc, ref: "cc-214", title: "USASpending made resumable — skip-unchanged, delta checkpoints, dials, heartbeat + reaper predicate, the claim, mark-killed reaped"}
  - {id: s25, kind: op, ref: "cc-215", title: "USASpending catch-up invocation 1 — contracts COMPLETE (baseline 20260924; 2.74M sent / 926k changed), assistance 5/7 parts; killed 01:21Z on a census STOP; the front door stayed down to ~02:25Z on FIX-1297's prepare", done: 2026-10-11}
  - {id: s26, kind: op, ref: "cc-218", title: "FIX-1297 stop-gap — one donation row re-stamped under a claim (the Sat 21:07Z fec_bulk row, not the 10-08 one; the MAX walk 0.048 ms)", done: 2026-10-11}
  - {id: s27, kind: op, ref: "cc-217", title: "USASpending catch-up invocation 2 + the FIX-1274/1291 prod record + the FIX-1297 re-stamp (assistance 6-7/7 in 8.2 min, baselines 20260924 / 20260923; FIX-1300 files the weekly's return)", done: 2026-10-11}
  - {id: s28, kind: op, ref: "cc-219", title: "Monday records (1189 drop night, 1295 M1 (iii), 1297 clear, 1292 revert control, 1291 reap, 1289 window) + FIX-1296 group-donor 64MB and FIX-1299 xsr weekly vacuum landed", done: 2026-10-13}
  - {id: s29, kind: op, ref: "cc-220", title: "FIX-1297/1293 — the donation-types updated_at partial index CIC'd on prod + the twin; the stop-gap retired; Tuesday records 1284/1248/1287/1295 M2 (1293 stays open on the tick rule)", done: 2026-10-14}
---

# Paced ops

A prod op that is too big for one quiet window is run as many small CALLs, each
judged by the front-door census before the next one starts. cc-162 made the
census count renders instead of queries; cc-164 gave the runner a per-CALL
render budget and a breather that reads the census.

**The weekly merge is not a paced op** (design D2, ratified 2026-09-29). It is
one gated migration (cc-179): `run_rule_taggers('weekly')` merges the `size`
tags instead of rewriting all 4.4M, and its receipts are the scheduled Tuesday
firings, 2026-10-06 and 2026-10-13. FIX-1248 closes on the second.

**Compaction (s5):** prod has `pg_repack` available (cc-179 read 5), so the
one-time compaction of `entity_tags` is FIX-1258, landed after 2026-10-13.
Never `VACUUM (FULL)`: it holds ACCESS EXCLUSIVE on a table every entity page
reads.

cc-244 did it on Sat 2026-10-24, inside its own FIX-950 claim
(00:28:47–00:33:56Z):
- **The client.** `scripts/pg_repack/Dockerfile` is a source build of 1.5.2,
  because PGDG carries only 1.5.3 now. It runs through the session pooler.
  `scripts/fix1258-repack-entity-tags.mjs` drives it and asserts every catalog
  property after the swap.
- **The cost.** Wall 251.8 s plus a 30.8 s tail VACUUM (ANALYZE). The heap
  went 1,768 → 972 MB and the total relation 4,422 → 2,169 MB, with 7/7
  indexes valid and 100 % all-visible.
- **It was not free at the front door.** The copy and index builds cost **6
  renders / 7 events** of 57014 across 00:30:03–00:33:09Z on the 1 GB box.
  That was IO, not locks: dispatcher ticks ran 7.3–9.3 s. The edge 5xx stayed
  under its floor (7/1163). A repack of a bigger table should budget that
  front-door cost against its wall.
- **The extension stays (D6).** The twin `20261024000000` rode cc-247's gated
  push on 2026-10-25, a no-op on prod.

**The generic runner (s6)** is decoupled from FIX-1248, which retires census
decision 5. It is built with the first op that genuinely needs windows.

**Census builds (s7):** cc-188 landed the measure-first census's levers that
fit the box as it is. FIX-1269 covers the status snapshot's two reads (a
partial index and a freshness stamp). FIX-1132 has the 06:00 search-index unit
read the stats table when it is provably current. FIX-1270 parks a generic EC
arm after two consecutive cancels. Two items stopped on prod evidence: FIX-1145's
rollup read would make the home page's donor numbers lag each weekend drop by a
day, and the `_external` content fingerprint would still change every week.

**Peer yield (s8, s9):** FIX-1124 part 1 (cc-189) is the first instance of a
crawl reading what is running and what is due instead of a clock. `crawl_gate`
skips `peer_running` while a listed peer's own `running` row exists, and
`peer_due` from 1,800 s before its daily slot to 60 s after it. The 06:00 daily
waits up to 600 s on an in-flight unit and then runs anyway. The blackout stays
until a receipt week with zero crawl↔daily overlaps (s9). Then part 2 retires it
and turns `prod_op_gate` check (c) into the same look-ahead.

**Home-page MV (s10, s11):** cc-195 builds rec (iii), the smallest of cc-188's
three ways past FIX-1145's stop. `official_homepage_stats_mv` now reads
`official_donor_totals` and `official_vote_stats` instead of scanning
`financial_relationships`, and drops the column nothing read. The 06:00 unit
stays. The MV would otherwise lag each drop by a day, because the donor rollup
only moves at 09:00 or 12:00. So `donor_rollup_rebuild_bulk` (jobid 24) now
refreshes the MV right after a run that moved its watermark. The receipt (s11)
is Monday's 06:00 unit seconds and the first jobid 24 row that carries
`homepage_mv_refreshed: true`.

**Per-phase preflight (s12, s13):** cc-198 makes the nightly's nominal-day
preflight judge each phase on its own `nightly_cron` row (FIX-1281). On Mon
10-05 the dispatched run's fec-phase never got a hosted runner, the three
enrichment jobs ran anyway, and the late `schedule:` fallback stood down on
their rows, so the night's FEC phase was lost with no retry. Now the fallback
runs FEC and the enrichment jobs stand down on their own verdicts. The receipt
(s13) is the first scheduled fallback after landing: all four verdicts `true`
on a healthy night.

**The 10-06 wedge (s14, s15):** the first merge firing (Tue 10-06 16:00Z) did
not complete. Its INSERT's anti-join hash (~560 MB under `work_mem 256MB` ×
`hash_mem_multiplier 2`) wedged the 904 MB box four minutes in (FIX-1284,
cc-204's triage), and the merge rolled back. cc-205 runs the weekly merge at
`work_mem 64MB`. Every hash then spills to temp past 128 MB: on the clone that
was Batches 2 / 2 / 4, no slower, with peak backend memory 380 → 126 MB. The
P1-A start gate (`box_backoff_gate`) now runs before the weekly's lock. The
gate cannot see memory (the sensor's memory half is report-only), so the
work_mem change is what matters. Still not paced: keyed units with a COMMIT per
unit are the complete answer, and they get built only if the 10-13 firing (s15)
reads more than half its 7,200 s budget. FIX-1248's two-Tuesday close moves to
10-13 + 10-20.

**USASpending made survivable (s24):** the 10-08 dispatch was a six-hour prod
writer that nothing on the box could see or bound (FIX-1291; playbook rule C9).
cc-214 gives the pipeline the shape the paced ops already have: every part
checkpoints in delta mode too, the FR upsert skips unchanged rows, the box gate
is read before each part and every 100k rows, a wall dial stops it `partial` at
a boundary, its row heartbeats so the nightly's reaper spares it, and the
supervised entry takes the FIX-950 claim while the workflow only reads it. The
catch-up (cc-215) is then several claimed invocations of
`data:usaspending-bulk:prod -- --category contracts --max-minutes N`, each one
resuming the 2026-09-24 delta's parts from the kept zip, ending before the
03:00Z `fr-vacuum-analyze` owner fires; assistance follows contracts. The
schedule's return (FIX-1274 shape (2), FIX-1291 step 4) comes after it.
