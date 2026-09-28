---
slug: demo
title: The fixture project — one step of every kind
lanes: [ops, design]
status: active
plan: fixture-plan §1
steps:
  - {id: s1, kind: cc, ref: "cc-880", title: "an older run, verified"}
  - {id: s2, kind: op, ref: "FIX-40", title: "an op with a done.log row"}
  - {id: s3, kind: design, ref: "FIX-60", title: "a design note, hand-dated", done: 2026-09-20}
  - {id: s4, kind: cc, ref: "cc-902", title: "the stale-marker run"}
  - {id: s5, kind: receipt, ref: "FIX-50", title: "the Wednesday receipt", after: 2026-09-30T15:00Z}
  - {id: s6, kind: decision, ref: "", title: "a decision nobody has dated"}
  - {id: s7, kind: design, ref: "FIX-61", title: "a design note gated past the week", after: 2026-10-20}
  - {id: s8, kind: cc, ref: "", title: "a prompt not yet written"}
  - {id: s9, kind: cc, ref: "cc-903", title: "a landed run whose verify FAILs"}
---

# Demo

Free prose.
