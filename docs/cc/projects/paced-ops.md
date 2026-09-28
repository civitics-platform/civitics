---
slug: paced-ops
title: Paced ops — the census, the runner, the weekly merge
lanes: [ops, design]
status: active
plan: design-paced-op-census-2026-09-26 §7
steps:
  - {id: s1, kind: cc, ref: "cc-162", title: "renders census + cancellation lens"}
  - {id: s2, kind: cc, ref: "cc-164", title: "paced runner: budget 3/CALL, breather census, edge floor p0 0.23 %"}
  - {id: s3, kind: design, ref: "FIX-1178", title: "weekly-merge paced-op design note — is rebuild_financial_entity_size_tags a paced op? phase_seconds lens"}
  - {id: s4, kind: cc, ref: "", title: "weekly-merge prompt"}
  - {id: s5, kind: op, ref: "FIX-1178", title: "VACUUM (FULL) entity_tags as a later landing"}
---

# Paced ops

A prod op that is too big for one quiet window is run as many small CALLs, each
judged by the front-door census before the next one starts. cc-162 made the
census count renders instead of queries; cc-164 gave the runner a per-CALL
render budget and a breather that reads the census.

**Next:** the design note for the weekly merge (s3). Its input is cc-169's
re-based FIX-1178 band. The generic runner is built with that job, not before
it (census decision 5).

**Gate on s5:** `VACUUM (FULL)` takes ACCESS EXCLUSIVE. It lands only after the
weekly merge has run paced, and only as a supervised landing.
