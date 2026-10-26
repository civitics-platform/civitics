---
slug: context-haircut
title: "Context load + timing rules — census, haircut, re-derivation"
lanes: [hygiene, ops]
status: active
plan: design-context-haircut-and-io-census-2026-10-21.md
steps:
  - {id: s1, kind: cc, ref: "cc-242", title: "the census — docs/audits/2026-10-22-context-and-io-census.md (read-only; files FIX-1339, FIX-1340, FIX-1341)", done: 2026-10-23}
  - {id: s2, kind: op, ref: "FIX-1340", title: "pnpm fixes:clean THEN pnpm fixes:archive (human-run) — archive alone moves 0; clean selects 179 closed bullets / 690 KB, leaving FIXES.md ≈ 119 KB"}
  - {id: s3, kind: cc, ref: "cc-245", title: "root CLAUDE.md haircut (FIX-1339) — 22 of 29 sections / 44.1 KB classified K+R/D/H/G; reduce to K rules + playbook pointers; resolve the PROMPT_TEMPLATE overlap", done: 2026-10-23}
  - {id: s3a, kind: cc, ref: "cc-245", title: "MEMORY.md census; K/D/G proposal in the cc-245 report", done: 2026-10-23}
  - {id: s4, kind: cc, ref: "cc-246", title: "package CLAUDE.md haircuts (FIX-1346) — graph/db/data/apps 142.5 KB → 36.4 KB, archived verbatim; ROADMAP.md archived; API.md kept (live routes; the checker's fixture refusal fixed); the drain-worker call handed to s4c", done: 2026-10-24}
  - {id: s4a, kind: design, ref: "v-blocks", title: "home the archived V blocks (tiers, pricing, Phase 5, mission prose) — Craig's call from the cc-246 table"}
  - {id: s4b, kind: cc, ref: "cc-249", title: "the four small package files (ai/maps/ui/blockchain) — letters in cc-246 read 9 — FIX-1347, cc-249: ai 10,347 → 2,249 B, maps 6,541 → 2,086 B, blockchain 4,402 → 708 B, ui left; archived byte-equal; the CLAUDE.md tree 77,345 → 61,098 B", done: 2026-10-26}
  - {id: s4c, kind: design, ref: "drain-worker", title: "keep or retire .claude/agents/drain-worker.md (retiring takes the agent + drain-prompt-version.test.ts + the drain prompt files together) — Craig's call from the cc-246 report — RETIRED (Craig 10-24 #5a): cc-249 deleted the agent, claim.ts, data:drain:claim, the tag/summary prompts, their version test and the .gitignore stanza", done: 2026-10-26}
  - {id: s5, kind: design, ref: "FIX-1342", title: "re-derive the gates from the post-cutover series (Cowork) — blackout idle 0/5 (FIX-1341, superseded by cc-243's FIX-1336, which removed prod_op_gate's constant fallback; close it as superseded); vacuum spacing idle 0/3; migration pushes ≤ 26 s, 0 overlaps — landed by cc-247: prod_op_gate learns the op classes, the clocked spacing retires", done: 2026-10-25}
  - {id: s5a, kind: op, ref: "FIX-1342", title: "the three-push receipt — gate wait ≤ the census latency, 0 deferred-writer rows under the claim, claim ≤ 30 s, on the next three class-P pushes (cc-248+) — candidate 1 = cc-248 (10-25 03:09→04:04Z, 55 min on (d) only, claim ≤ 7 s); candidate 2 = cc-249 (10-26 00:09:05→00:14:05Z, 299.7 s on e:live_writers only — fe-crawl's dispatched unit — claim 1.8 s from the new receipt line, 0 skipped writer rows); the third is owed", after: 2026-10-25}
  - {id: s5b, kind: cc, ref: "cc-249", title: "the stall-minute receipts line — FIX-1343, cc-249: receipts §9 gains Stall minutes (24 h, FIX-1343) and the JSON stall_minutes key; the first prod rendering (the Tue 10-27 nominal file) owed", done: 2026-10-26}
  - {id: s6, kind: design, ref: "memory", title: "Cowork memory restructure (done 10-21 — the export is in ../Claude/civitics/memory-export)", done: 2026-10-21}
---

# Context load + timing rules

Three things were noticed in the 10-21 Cowork session and had not been measured on the tree:

- the `CLAUDE.md` tree is 224 KB and narrates history as rules;
- `docs/FIXES.md` is 809 KB, 85 % of it closed bullets;
- the supervised-op timing rules were sized on the 08-24..26 burst receipts, before the crawl and the dispatcher existed.

cc-242 measured all three. Each `CLAUDE.md` section gets one letter: **K** keep as a rule, **R** receipt (move it to the playbook), **D** derivable, **H** history or stale, **G** generic coaching. Each gate gets a verdict by receipt (`earned`, `idle` or `unknown`). Craig decides what is cut. The census only proposes; the haircut and re-derivation steps act on its tables.
