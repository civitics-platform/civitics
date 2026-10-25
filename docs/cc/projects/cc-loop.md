---
slug: cc-loop
title: The CC loop — prompts, reports and the board in the repo
lanes: [hygiene]
status: active
plan: workflow-ideas-autonomy-and-parallel-sessions-2026-09-12
goal: "P1 · Infrastructure"
steps:
  - {id: s1, kind: cc, ref: "cc-122", title: "status from done.log (FIX-1016)", done: 2026-09-11}
  - {id: s2, kind: cc, ref: "cc-122", title: "/cc, report front matter, cc:verify (FIX-1175)", done: 2026-09-11}
  - {id: s3, kind: op, ref: "FIX-1176", title: "receipts job", done: 2026-09-13}
  - {id: s4, kind: cc, ref: "cc-171", title: "lanes, projects, owed, the board"}
  - {id: s5, kind: cc, ref: "cc-172", title: "backlog, goals, windows, cron history, docs archive"}
  - {id: s6, kind: cc, ref: "cc-190", title: "the runner tears its worktree down; fixes:check guards fix:add collisions (FIX-1271)"}
  - {id: s7, kind: cc, ref: "cc-201", title: "1276 prunable orphan path + 1275 HEAVY gate", done: 2026-10-06}
  - {id: s8, kind: cc, ref: "cc-221", title: "Sunday hygiene bundle — 1283 institutions 308, 1282 worktree root, 1289 ring 900 + slot windows, db-query label", done: 2026-10-12}
  - {id: s9, kind: cc, ref: "cc-248", title: "weekly fixes-housekeep bot (Mon 10:00Z, clean --older-than 7 + archive) and session:check pulls the primary (FIX-1345)", done: 2026-10-24}
  - {id: s10, kind: op, ref: "FIX-1345", title: "the first MOVING fixes-housekeep run — a bot commit moves N >= 1 bullets to the archive, fixes:check green inside the run", after: 2026-11-02}
---

# The CC loop

Craig used to carry every Cowork prompt into Claude Code and every report back.
The loop now runs without him. Status is derived from `done.log` (FIX-1016).
Prompts are read from the prompts folder and reports are written into the repo
and checked by `cc:verify` (FIX-1175). Prod state arrives nightly as a committed
receipts file (FIX-1176). With cc-171, prompts and reports say which lane and
project they belong to and what they still owe, and `pnpm board` renders the
week from those files. With cc-172 (FIX-1243) the board also shows the open
FIXES.md backlog per lane, groups plans under their PHASE_GOALS.md phase,
collapses finished plans, gives each prompt a run-window pill, and sizes each
pg_cron firing from the receipts history.

With cc-190 the runner tears down the worktree it created, and the board counts
any merged worktree a run left behind. `fixes:check` now refuses a FIX id that two
sessions allocated, before the second one lands.

With cc-248 (FIX-1345) `docs/FIXES.md` keeps itself small without a session
touching it: a Monday 10:00Z bot moves bullets closed at least a week ago into
the archive, and `session:check` catches the primary checkout up when it is
clean and behind.
