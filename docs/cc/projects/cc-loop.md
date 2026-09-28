---
slug: cc-loop
title: The CC loop — prompts, reports and the board in the repo
lanes: [hygiene]
status: active
plan: workflow-ideas-autonomy-and-parallel-sessions-2026-09-12
steps:
  - {id: s1, kind: op, ref: "FIX-1016", title: "status from done.log", done: 2026-09-11}
  - {id: s2, kind: op, ref: "FIX-1175", title: "/cc, report front matter, cc:verify", done: 2026-09-11}
  - {id: s3, kind: op, ref: "FIX-1176", title: "receipts job", done: 2026-09-13}
  - {id: s4, kind: cc, ref: "cc-171", title: "lanes, projects, owed, the board"}
---

# The CC loop

Craig used to carry every Cowork prompt into Claude Code and every report back.
The loop now runs without him. Status is derived from `done.log` (FIX-1016).
Prompts are read from the prompts folder and reports are written into the repo
and checked by `cc:verify` (FIX-1175). Prod state arrives nightly as a committed
receipts file (FIX-1176). With cc-171, prompts and reports say which lane and
project they belong to and what they still owe, and `pnpm board` renders the
week from those files.
