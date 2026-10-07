---
slug: forker
title: pg_cron forker starvation (FIX-1194)
lanes: [ops]
status: active
plan: design-fix1194-forker-starvation-2026-09-19
goal: "P1 · Infrastructure"
steps:
  - {id: s1, kind: cc, ref: "cc-142", title: "P2-A — the */2 watchdogs callable from a Vercel route", done: 2026-09-22}
  - {id: s2, kind: cc, ref: "cc-149", title: "P1-B — */1 box-health probe, box_is_saturated(), the memory ring", done: 2026-09-24}
  - {id: s3, kind: cc, ref: "cc-153", title: "record_box_health service_role revoke + prod_op_gate (d) one scan", done: 2026-09-25}
  - {id: s4, kind: cc, ref: "cc-183", title: "P1-A — start gate + chunk backoff on the three heavy rollups; receipts bank the memory series"}
  - {id: s5, kind: receipt, ref: "FIX-1194", title: "a week with zero non-landing fork bursts (receipts §9 10-02 → 10-09) → Verified: prod", after: 2026-10-09T12:00Z}
  - {id: s6, kind: design, ref: "FIX-1125", title: "memory threshold — after ≥ 7 receipts days carrying forker.memory_day", after: 2026-10-09T12:00Z}
  - {id: s7, kind: design, ref: "", title: "contract-flow chunking (D-contract) — the one heavy rollup still a single statement"}
  - {id: s11, kind: cc, ref: "cc-206", title: "FIX-1285 auto-restart — shipped report mode 2026-10-07; arm = Craig; receipt = the next wedge", done: 2026-10-07}
---

# pg_cron forker starvation

A large FR/EC landing starves pg_cron of background workers while its derived
work drains, and every job that cannot fork is lost silently — both `*/2`
watchdogs included, so budget enforcement goes offline exactly when it is
needed. The design note splits the answer in two: keep the guards alive when
the forker is starved (P2), and stop adding load to a box that is already
starved (P1).

**P2-A (s1)** gave the two watchdogs a second firing path from a Vercel cron
route, so a starved forker no longer silences them. **P1-B (s2)** is the
sensor: a `*/1` probe stamps `pipeline_state.box_health`, and
`box_is_saturated()` reads it. A stale stamp IS saturation, because the probe is
itself a pg_cron firing. **s3** closed the probe's default `service_role` grant.

**P1-A (s4)** is the consumer. `donor_rollup_rebuild_bulk()`,
`refresh_contract_flow_rollups()` and `refresh_agency_staffing_rollup()` wait at
their start for a box that is neither stale nor failing forks (600 / 1,800 /
600 s), then skip with `box saturated after N s: <reason>`. The two with units
also back off at a unit boundary, as `partial`; the donor rollup resumes on its
committed cursor. The 1.0 s watchdog wall is **not** an input (D2): healthy
hours exceed it, and a bounded op drives it to 1.3 s as ordinary I/O.

**The receipt (s5)** is the design's own: a week with zero non-landing fork
bursts in receipts §9, with any `box saturated` row explained by a real burst.

**Memory (s6)** stays report-only until a series exists. cc-183 lands the code
that banks the day's summary in `docs/receipts/<day>.json` as
`forker.memory_day`. It starts banking the day `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN` exist as repository Actions secrets (Craig's action);
the threshold is designed after seven banked days.

**Contract-flow chunking (s7)** is its own design. P1-A gave that procedure a
`running` row and a cancel handler, but its two rebuilds are still one statement
each, so a cancel still costs the whole run.

**Auto-restart (s11, FIX-1285)** bounds the wedge rather than preventing it.
Three starved boxes (08-31, 09-22, 10-06) left the front door at 95–100 % 52x
after Postgres had recovered, and each ended only by a hand restart. The
front-door watchdog now decides a project restart itself after 30 minutes of
DOWN (cap 2 / 24 h, state in Upstash). It shipped in `report` mode; arming is
Craig's (`FRONT_DOOR_AUTO_RESTART=arm` plus a `project_admin_write` token), and
the receipt is the next wedge. See `docs/OPERATIONS.md` §"Front-door watchdog".
