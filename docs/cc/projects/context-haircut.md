---
slug: context-haircut
title: "Context load + timing rules — census, haircut, re-derivation"
lanes: [hygiene, ops]
status: active
plan: design-context-haircut-and-io-census-2026-10-21.md
steps:
  - {id: s1, kind: cc, ref: "cc-242", title: "the census — docs/audits/2026-10-22-context-and-io-census.md (read-only; files FIX-1339, FIX-1340, FIX-1341)", done: 2026-10-23}
  - {id: s2, kind: op, ref: "FIX-1340", title: "pnpm fixes:clean THEN pnpm fixes:archive (human-run) — archive alone moves 0; clean selects 179 closed bullets / 690 KB, leaving FIXES.md ≈ 119 KB"}
  - {id: s3, kind: cc, ref: "cc-245", title: "root CLAUDE.md haircut (FIX-1339) — 22 of 29 sections / 44.1 KB classified K+R/D/H/G; reduce to K rules + playbook pointers; resolve the PROMPT_TEMPLATE overlap"}
  - {id: s4, kind: cc, ref: "cc-246", title: "package CLAUDE.md haircuts (graph 32.4 KB H+D first; data's stale EC-rebuild schedule) + top-level docs archive (ROADMAP.md movable; API.md's refusal is a test-fixture false positive)"}
  - {id: s5, kind: design, ref: "timing-rules", title: "re-derive the gates from the post-cutover series (Cowork) — blackout idle 0/5 incl. prod_op_gate's constant fallback (FIX-1341); vacuum spacing idle 0/3; migration pushes ≤ 26 s, 0 overlaps"}
  - {id: s6, kind: design, ref: "memory", title: "Cowork memory restructure (done 10-21 — the export is in ../Claude/civitics/memory-export)", done: 2026-10-21}
---

# Context load + timing rules

Three things were noticed in the 10-21 Cowork session and had not been measured on the tree:

- the `CLAUDE.md` tree is 224 KB and narrates history as rules;
- `docs/FIXES.md` is 809 KB, 85 % of it closed bullets;
- the supervised-op timing rules were sized on the 08-24..26 burst receipts, before the crawl and the dispatcher existed.

cc-242 measured all three. Each `CLAUDE.md` section gets one letter: **K** keep as a rule, **R** receipt (move it to the playbook), **D** derivable, **H** history or stale, **G** generic coaching. Each gate gets a verdict by receipt (`earned`, `idle` or `unknown`). Craig decides what is cut. The census only proposes; the haircut and re-derivation steps act on its tables.
