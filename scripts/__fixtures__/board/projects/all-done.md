---
slug: all-done
title: Every step done, but the file still says active
lanes: [hygiene]
status: active
goal: "P2 · Not A Group"
plan: fixture-plan §2
steps:
  - {id: s1, kind: op, ref: "FIX-40", title: "an op with a done.log row"}
  - {id: s2, kind: design, ref: "", title: "a design note, hand-dated", done: 2026-09-25}
---

# All done

Rule 105's wrong-but-green shape: a board that trusted `status:` would keep
this as an active tile with nothing left to do.
