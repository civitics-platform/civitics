# CC prompt template + standing rules

The shape every Cowork prompt has, and the rules every prompt currently restates
in full. Cowork writes the **deltas**; CC reads the rules from here. A rule
change is one edit to this file instead of a thing to remember next time.

Filed as FIX-1175, alongside `/cc <n>` and `pnpm cc:verify`.

---

## The invariant sections

A prompt is these, in this order. Anything a prompt does not say is governed by
the checklist below.

0. **Front matter** (FIX-1242, from cc-171) — a YAML block at the very top of
   the file, read by `pnpm cc:prompt <n>` with the same parser `cc:verify`
   uses. It is data about the run, not instructions:
   ```yaml
   ---
   cc: 171                    # MUST equal the filename's number — /cc aborts otherwise
   lane: hygiene              # one of cc.config.json's lanes (below)
   project: cc-loop           # optional; MUST name docs/cc/projects/<slug>.md
   when: any                  # optional; see "when:" below
   attended: unattended-ok    # optional; supervised | unattended-ok
   posture: code-only         # optional; code-only | prod-reads | prod-writes
   concurrent_with: [168, 170]  # optional; cc numbers that may be in flight
   ---
   ```
   **`when:`** has five forms. Every instant must carry a zone (`Z` or
   `±HH:MM`); a zoneless one is refused, because it would shift by the
   writer's offset.

   | form | meaning | card pill |
   |---|---|---|
   | `any` | no constraint | `any time` |
   | `2026-10-01` or `2026-10-01T16:30Z` | runs then | `runs Thu 10-01 16:30 UTC` |
   | `after 2026-09-29T16:30Z` | not before this; open-ended after it (FIX-1243) | `runs after Tue 09-29 16:30 UTC` |
   | `2026-10-01T23:15Z..2026-10-02T03:30Z` | a bounded window (FIX-1243) | `window Thu 10-01 23:15–03:30 UTC` |
   | (absent) | nothing drawn | — |

   When `.claude/board.local.json` names a `tz`, the pill adds the local time.
   A `posture: prod-writes` card also reads "needs a supervised slot" and
   names the next supervised window. When two prod-writes prompts' windows
   share a UTC day, both cards carry a ⚠ chip and the header counts them. One
   prod-writing session at a time is still a human rule (rule 180); the board
   only shows the overlap.

   **The lanes**, one line each:
   - `ops` — pg_cron, vacuum, paced runners, gates, receipts, box sizing.
   - `fec` — FEC/USAspending coverage, rollups, industry and NAICS tags,
     official↔candidate binding.
   - `app` — pages, auth/grants, desk, dashboard UI.
   - `hygiene` — lint, CI, docs, cost/billing observability, the CC loop's own
     tooling.
   - `design` — Cowork-owned design notes not yet prompts. A plan-step lane
     only: no prompt or report carries it.

   `/cc` copies `lane` and `project` into the report verbatim, and writes the
   report's `owed:` from the prompt's Verification section. `cc:verify` FAILs a
   report whose lane is not in the list, whose project names no plan file, or
   whose `owed` entry is malformed; `lane` is required on reports from cc-172.
   Reports before cc-172 carry no lane — `docs/cc/lanes-backfill.json` places
   cc-162…170 for the board, and nothing is back-filled earlier.

   **Plan files** (`docs/cc/projects/<slug>.md`) hold a multi-prompt
   initiative. Their front matter is `slug`, `title`, `lanes`, `status`
   (`active | planned | done | archived`), `plan` (the name of Cowork's
   design note), an optional `goal:` and `steps:`, followed by free prose.
   `steps:` is a block list of
   `{id, kind: cc|design|receipt|op|decision, ref, title, after?, done?}`.
   A prompt joins a project by naming it in `project:`. Three rules (FIX-1243):
   - `goal: "P1 · Infrastructure"` puts the tile under that phase's
     PHASE_GOALS.md header, together with the header's own `~NN%`. The text
     after `P<N> · ` must be a `### ` group under that phase, or the tile gets
     a lint line. Nothing derives checkbox state.
   - A plan whose steps are all done counts as **done**, whatever `status:`
     says; a lint line flags the disagreement. It collapses into the one
     `done:` row, which `pnpm board --projects all` expands.
   - `status: archived` hides the plan, and the board keeps a count.

   **The board.** `pnpm board` renders all of the above from the tree alone,
   into `<boardDir>/board.json` and `index.html` beside the prompts. The page
   has a projects strip grouped by phase, an 8-column UTC week and the lanes.
   Each lane ends with its **backlog row**: the open 🔴/🟠 FIXes in that lane
   that no plan step or in-window card already names. A full-width **bugs**
   row follows the lanes.
   - Prod state comes from the latest committed `docs/receipts/<day>.json`,
     labelled with the time it describes. The board never opens a connection.
   - Cron and nightly sizes come from the newest 14 receipts files, and a
     banner flags one older than 30 h.
   - `/cc` runs the board at the end of Step 4. It is never committed, because
     it writes outside the repo.
   - `docs/cc/README.md` lists every file in the loop.

   **Supervised windows are local.** The week's per-day footer, meaning the
   hours someone is at the keyboard to supervise a landing, comes from
   `.claude/board.local.json` in the primary checkout. That file is untracked by
   construction (`.gitignore` excludes `.claude/*`), and
   `docs/cc/board.local.example.json` shows its shape with placeholder times.
   It stays out of the repo for two reasons. Someone's working hours are not
   project state, and a committed copy would be stale the first week they
   changed. Without the file, the board simply draws no footer row.
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
   State every owed receipt in the `owed:` shape —
   `{fix: FIX-NNN, what: "<one line>", after: <date or zoned ISO instant>}` —
   so `/cc` copies it into the report mechanically.
10. **Autonomous loop** — order, and the conditions that stop it. Every loop
    carries the ratified permission-prompt reading (cc-174, FIX-1250): **any
    permission prompt — log the exact command, stop THAT command, carry on if
    the item can complete without it, and flag the reading in
    `stopped_items`.** It replaces the older "any permission prompt (log the
    exact command, STOP)", which read as stopping the whole run.
11. **After-commit report** — the front matter (see `.claude/commands/cc.md`:
    the FIX-1175 fields plus `lane`, `project` and `owed` from §0 and §9) plus
    the prose sections this run should answer.

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
- **Every filing names its lane.** `pnpm fix:add … --lane <lane>` is required
  (FIX-1243). The lane is one of `cc.config.json`'s `lanes`, and it is written
  as a `<!--lane:X-->` marker after the id marker, on the same line. It is
  usually the prompt's own lane. A bullet with no marker is placed by its
  `## ` section through `sectionLanes`; the BUGS section maps to the board's
  `bugs` row. Never retrofit a marker onto someone else's bullet; Craig may
  hand-add one.
- **One line per bullet.** `fix:add --body` takes a single line — a newline
  truncates it, and bash eats backticks.
- **`fixes:sync` runs only AFTER the fix commits are on `origin/main`.** Running
  it from a worktree pre-merge is the stranded-PR failure mode (FIX-461).
- **Status commits are separate from code commits**, so a revert does not drag
  status with it.

### Git and landing

- Agents never commit on the primary VSCode checkout. One worktree per FIX:
  `pnpm session:worktree <fix-id>`. Create it before `cc:prompt <n> --start`
  and run that from inside it, so the marker names the slot. `/cc` Step 4 tears
  it down after the report push with `pnpm session:worktree:done <slot>`, run
  from the primary checkout in a tool call that STARTS there (a `cd` in the
  same command still EPERMs). That is the sanctioned teardown of a merged tree
  and needs no approval. A failure is reported as `worktree LEFT: <slot> —
  <reason>`, never retried with `rm` (cc-190).
- `main` advances only by fast-forward from a rebased branch:
  `git push origin feature/fix-<id>:main`.
- Never `--amend`, never `--no-verify`, never force-push.
- **Every push to main goes through the pre-push hook's `session:held` gate**
  (FIX-1250). The hook reads `prod_session_state()` through the primary
  checkout's `.env.local.prod` and `held=true` REFUSES the push — so does an
  unreadable state; wait and retry. Never `--no-verify`, never the
  `CIVITICS_SKIP_HELD_GUARD` escape (it exists for a checkout with no prod DSN
  and is never set by a prompt). `pnpm session:held` prints the one line by
  hand: `held=<bool> reason=… claimant=… claimed_at=… expected_minutes=…
  live_writers=<n>`, exit 0 free / 1 held / 2 unreadable. It steps aside under
  `GITHUB_ACTIONS`, where the nightly pushes its receipts.
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
  the `guarded` column); today it is the thirteen `*-vacuum-analyze` jobs, both
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
- **(f) Front door, in RENDERS (FIX-1232).** Renders lost (57014 statement
  timeouts grouped by second, so one page's 4–6 fanned-out reads count once)
  over the last 60 min fail **only when both** exceed their bounds: more than
  the Poisson-P99 floor at the printed baseline (6 in 60 min at 0.033/min) **and**
  a ratio over **2 ×** that baseline. Front-door 5xx over the last closed
  15-min bucket fails **only when** pct > 1 % **AND** n5xx > the exact binomial
  P99 at **p0 = 0.23 %** (the median day, cc-162 read 3; re-measured ~10-03);
  a bucket of n < 30 proves nothing (FIX-1233). At n = 183 the floor is 2, so
  cc-151's 2/183 = 1.09 % passes and 3/183 fails. Read both with
  `pnpm --filter @civitics/data data:census:cancellations:prod` (Logs API;
  opens no Postgres connection) and quote the renders, the events, the
  baseline, and the edge line's p0 and floor it printed. The baseline is not
  re-derived in renders until ~10-03. **A paced runner's pre-CALL reading
  judges the time OUTSIDE its CALL spans; the CALLs are judged by
  `--renders-per-call-max`; a breather the census still holds at
  `--breather-max-s` is a stop in stop mode** (a would_trip in report mode; a
  breather the walls still hold proceeds) (FIX-1234).
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
  is a BAND, not a class: ~10 s between drops, 161–212 s after a weekend drop
  (14-d mean 87.6 s, cc-158 read 2) — so the ≥ 90-min spacing applies on the
  night after a drop and ≥ 10 min otherwise; read the LAST wall, never assume
  the class; `ec`/`fe` 04:30/04:50 = 10–130 s), ≥ 10 min after any other (the
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
- **`tests.yml` runs EIGHT blocking checks** (FIX-1214 added the last one):
  `typecheck` · `lint` · `check:reads` · `check:render-timeouts` ·
  `check:workflow-parity` · `check:proconfig` · `check:no-store-routes` · the
  three unit suites (`@civitics/data`, `@civitics/app-civitics`,
  `@civitics/db`). Run the ones a change can plausibly break before pushing,
  not after. `check:render-timeouts` also fails a `revalidate` page that reads
  through `withDbTimeout` without calling `assertRenderNotDegraded()`
  (FIX-1227).
- The `scripts/test-*.mjs` suites are fast and dependency-free — run them
  (`fixes:test`, `fix:add:test`, `cc:verify:test`, `board:test`,
  `session:worktree:test`, `drain:test`, `check:proconfig:test`,
  `check:no-store-routes:test`, `check:render-timeouts:test`,
  `check:doc-links:test`, `session:held:test`, `hook:test`). `cc:verify:test`
  also covers `cc:prompt`; `fixes:test` also runs `session:held:test`.
  `board:test` (which also runs the phase-goals pin) and `pnpm check:doc-links`
  run in `fixes-integrity.yml` on every push (FIX-1243), as do
  `session:held:test` and `hook:test` (FIX-1250).
- **Moving a doc** goes through `pnpm check:doc-links --archive <name>.md
  --dry-run`. The dry run lists every `git mv` and every rewrite; without
  `--dry-run` it performs them. It refuses a doc that code or a migration
  cites by path. Add a line to `docs/archive/README.md`.
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
