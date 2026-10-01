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
  - {id: s5, kind: op, ref: "FIX-1258", title: "compaction: pg_repack if available, else deferred (design D5)", after: 2026-10-13}
  - {id: s6, kind: design, ref: "", title: "generic paced runner — lifted with the first windowable op (1240 backfill / dp full cycle / 1211)"}
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

**The generic runner (s6)** is decoupled from FIX-1248, which retires census
decision 5. It is built with the first op that genuinely needs windows.
