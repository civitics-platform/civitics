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

### Verification

- `pnpm build` (or `turbo run typecheck` + `lint` for a code-only change) before
  any non-`[skip vercel]` commit.
- The `scripts/test-*.mjs` suites are fast and dependency-free — run them.
- `pnpm fixes:check` after each commit.
- Report what actually happened. A skipped step is reported as skipped.

### Reporting

- Write the report through `/cc`'s path so `pnpm cc:verify <n>` can check it.
- The structured header makes claims checkable. The prose section —
  **what contradicted the design** — is where the value has been. Keep it free.
