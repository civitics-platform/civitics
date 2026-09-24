# CC prompt template + standing rules

The shape every Cowork prompt has, and the rules every prompt currently restates
in full. Cowork writes the **deltas**; CC reads the rules from here. A rule
change is one edit to this file instead of a thing to remember next time.

Filed as FIX-1175, alongside `/cc <n>` and `pnpm cc:verify`.

---

## The invariant sections

A prompt is these, in this order. Anything a prompt does not say is governed by
the checklist below.

1. **Header** — what it is, when it runs, what it must not run concurrently
   with, and the one-line posture: code-only, or which prod contact is
   sanctioned.
2. **Design of record** — the Cowork doc this implements, and the standing
   instruction: *where the tree contradicts the doc, STOP that item and report.*
3. **Phase 0 — reads before any edit** — numbered, each one a question with an
   answer that goes in the report. The measurement the build rests on is stated
   here with its expected value and an explicit STOP if it does not hold.
4. **Prod access — stated once** — `None.` or exactly what is sanctioned. Never
   spread across items.
5. **Decisions** — the design's decisions by letter, so the build can cite them.
6. **Items / commits** — one section per commit, in landing order, each naming
   its `Fixes:`/`Closes:` trailer or explicitly having none.
7. **FIX bookkeeping** — what closes, what gets filed, what gets appended.
8. **Out of scope** — the things a reasonable reader would otherwise fold in.
9. **Verification** — per commit, with named commands and expected values.
10. **Autonomous loop** — order, and the conditions that stop it.
11. **After-commit report** — the front matter (see `.claude/commands/cc.md`)
    plus the prose sections this run should answer.

---

## Standing rules checklist

CC reads this before starting. Each line is a rule that has cost a real session.

### FIX bookkeeping

- **Status is derived, never read off the markdown.** `docs/FIXES.md` has no
  checkbox. Run `pnpm fixes:status FIX-NNN` before claiming anything is open or
  closed. (FIX-1016)
- **`Fixes:` only on the commit that lands that FIX's own close.** Not on a
  follow-up, not on a docs commit that mentions it.
- **`Closes:` for an administrative closure** (recognised / superseded /
  redirected / no-op), paired with the matching `Verified: closes-as-*`.
- **`Reopens:` for a regression the commit itself discovered**; otherwise
  `pnpm fix:reopen FIX-NNN --note "…"`. Both append to `done.log`; neither
  touches FIXES.md.
- **Never write the literal `Verified:` in a commit BODY** — only in the trailer
  block. A wrapped prose line beginning with a trailer key has shadowed the real
  trailer before (FIX-465).
- **Only the FIRST `Fixes:`/`Closes:` line is read by some tooling paths** — put
  all ids for one trailer on ONE line, comma-separated.
- **Real ids at filing time.** Allocate with `pnpm fix:add`, which prints the id;
  use the printed id in the trailer immediately. Never a `FIX-<letter>`
  placeholder in a diff.
- **One line per bullet.** `fix:add --body` takes a single line — a newline
  truncates it, and bash eats backticks.
- **`fixes:sync` runs only AFTER the fix commits are on `origin/main`.** Running
  it from a worktree pre-merge is the stranded-PR failure mode (FIX-461).
- **Status commits are separate from code commits**, so a revert does not drag
  status with it.

### Git and landing

- Agents never commit on the primary VSCode checkout. One worktree per FIX:
  `pnpm session:worktree <fix-id>`.
- `main` advances only by fast-forward from a rebased branch:
  `git push origin feature/fix-<id>:main`.
- Never `--amend`, never `--no-verify`, never force-push.
- Commit trailer block, verbatim, at the end of every commit:
  ```
  Co-Authored-By: Claude <model> <noreply@anthropic.com>
  Claude-Session: <the session URL from the prompt>
  ```
- Git identity on this machine is `Civitics Platform
  <civitics.platform@gmail.com>`.

### Database

- **Check which DB is active before anything that reads or writes data:**
  `grep "^NEXT_PUBLIC_SUPABASE_URL" .env.local`.
- A migration on disk rides the next push; `pnpm db:push:prod` applies it to
  Pro. Before pushing, `supabase migration list` and confirm the pending count
  is exactly what you expect.
- Ad-hoc SQL: `node scripts/db-query.mjs --local|--prod "…"`. `--prod` is
  read-only by construction.
- Never destructive SQL against Pro without explicit confirmation in the prompt.
- A script that bulk-rewrites a table ends with `VACUUM (ANALYZE)` on what it
  rewrote.
- No heavy prod rebuilds or MV refreshes during Craig's active hours.

#### Drain-and-wait before any second prod op

A supervised landing does not end when its transaction commits. It ends when
the derived work it created has drained and the box is back where it started.
So a prompt that lands a second prod op after a first one states these gates,
and **states each as a number WITH the time it was read** — a gate with no
timestamp is an assertion, not a reading, and every figure names its instrument
and its database.

- **(a) Unguarded owners, derived from the database.** A pg_cron job whose
  command does not reach a procedure referencing `prod_session_state()` is
  UNGUARDED: it fires inside a supervised session rather than deferring to it.
  Derive the set (`cron.job` JOIN `pg_proc` — `packages/data/src/lib/cron-job-pipelines.ts`,
  the `guarded` column); today it is the twelve `*-vacuum-analyze` jobs, both
  `*/2` watchdogs, `abuse-events-retention` and `platform-counts-daily`. Start
  **≥ 90 min after the last unguarded VACUUM job's END**, with **none scheduled
  inside `[start, start + 2 × expected wall]`**.
- **(b) Autovacuum headroom, not a dead-tuple absolute.**
  `(trigger − n_dead_tup) / rate > 2 × expected wall` on `entity_connections`,
  `financial_entities` and `financial_relationships`, with `rate` from **two
  readings ≥ 30 min apart**. A rate of zero measured at the 03:00 UTC trough is
  the weakest possible input to a rate gate — re-read it inside the window the
  op will actually run in.
- **(c) Crawl arms.** No crawl unit past its own job's interval in the last
  60 min. `partial` is the crawl arm's DESIGNED terminal status and is
  ALLOWED; what is not allowed is a unit still `running` at start, or a unit
  whose wall exceeded its job's interval.
- **(d) Watchdogs.** Both `*/2` jobs 60/60 in the last 60 min, no
  `job startup timeout` on any job, and no budgeted job left `running`.
- **(e) Interlock.** `prod_session_state()` clear, `live_writers` empty.
- **(f) Front door.** 57014/min over the last 60 min **≤ 2 ×** the 0.033/min
  baseline, and front-door 5xx **≤ 1 %** over the last closed 15-min bucket.
  Read both with `pnpm --filter @civitics/data data:census:cancellations:prod`
  (Logs API; opens no Postgres connection) and quote the baseline it printed.
- **(g) Conditions, not a fixed band.** The nightly is the thing a fixed
  22:30–01:00 band was standing in for, and it is READABLE, so read it: no
  `nightly_cron` phase `running` (`data_sync_log`, last phase `complete`), and
  the nightly's next START — the DISPATCH time, **21:00 UTC**, where
  `/api/cron/gha-dispatch/nightly` fires it (FIX-1218; `prod_op_gate()`'s
  `c_nightly_start`), not the 22:35–22:50 the GitHub offset used to put it at;
  the `schedule:` fallback still arrives ~1.6–2.7 h later and stands down on
  `already_ran` — **≥ `2 × expected wall + 15 min`** away. Still
  outside 05:45–09:00 UTC, and ≥ 60 min before any weekend-only job. Vacuum
  spacing is PROPORTIONAL to the job, not one number: ≥ 90 min after the END of
  any unguarded VACUUM job whose wall exceeded 60 s (`fr-vacuum-analyze` 03:00
  = 161–212 s; `ec`/`fe` 04:30/04:50 = 10–130 s), ≥ 10 min after any other (the
  11:0x / 17:0x series is 0.2–1.5 s), and none of the > 60 s ones scheduled
  inside `[start, start + 2 × expected wall]`. Say which window you are in,
  with the clock reading. These conditions — (g), (d), (e), rule 155's vacuum
  spacing and the blackout — are readable as
  `SELECT public.prod_op_gate(<expected seconds>)`, and a runner waits on them
  with `session:wait-for-gate` (FIX-1215); (f) stays the census.
  >
  > Why: a fixed band is wrong in both directions. cc-141 opened at 23:21 UTC
  > and lost its whole run to a band whose night had already finished — that
  > weekday nightly ran 22:49–23:01. The wall is what varies: a weekday nightly
  > is ~15 min, a Sunday drop night ~100 min. A condition reads the difference;
  > an hour cannot.

> Gate (b)'s two-reading rule is scoped to ops whose wall is MINUTES. A
> metadata-only DDL — an `ALTER … SET`, a `DROP INDEX` on a small index, a
> `COMMENT` — completes inside the noise of a single reading, so demanding two
> readings ≥ 30 min apart to bound it costs an hour to bound a millisecond
> (cc-142 §5). State the op's expected wall; the gate follows from it.

> A gate must describe a state prod actually visits — `partial` is a terminal
> status; "≤ 5,000 dead" is twelve minutes after a vacuum you are forbidden to
> be near. Write gates from the instrument's own state vocabulary as ratios or
> headroom, never as absolutes only a vacuum can reach.

The measured instance is cc-131's read 7, written up in
`docs/audits/2026-09-18-fix1187-set2-deferred.md` §2: thirteen gates, eleven
passing, and both failures the clock rather than the data.

### Verification

- `pnpm build` (or `turbo run typecheck` + `lint` for a code-only change) before
  any non-`[skip vercel]` commit.
- **`tests.yml` runs SEVEN blocking checks** (FIX-1128 added the last one):
  `typecheck` · `lint` · `check:reads` · `check:render-timeouts` ·
  `check:workflow-parity` · `check:proconfig` · the three unit suites
  (`@civitics/data`, `@civitics/app-civitics`, `@civitics/db`). Run the ones a
  change can plausibly break before pushing, not after.
- The `scripts/test-*.mjs` suites are fast and dependency-free — run them
  (`fixes:test`, `fix:add:test`, `cc:verify:test`, `session:worktree:test`,
  `drain:test`, `check:proconfig:test`).
- `pnpm fixes:check` after each commit.
- **A GHA-workflow FIX's receipt is the next run AT ITS SLOT — dispatched or
  scheduled** (rule 71, rewritten by FIX-1218). `nightly.yml`,
  `sync-canary-check.yml` and `platform-snapshot.yml` are fired by
  `/api/cron/gha-dispatch/<stem>` (Vercel cron) as `workflow_dispatch`; their
  `schedule:` runs are fallbacks. Read runs with `gh run list --workflow <file>`
  WITHOUT `--event schedule`, which now hides the run that did the work, and
  read the dispatcher's own stamp, `pipeline_state.gha_dispatch_<stem>`. Never
  hand-dispatch a nightly to make a receipt: the slot is the receipt.
- Report what actually happened. A skipped step is reported as skipped.

### Reporting

- Write the report through `/cc`'s path so `pnpm cc:verify <n>` can check it.
- The structured header makes claims checkable. The prose section —
  **what contradicted the design** — is where the value has been. Keep it free.
