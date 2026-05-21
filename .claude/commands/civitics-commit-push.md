# /civitics-commit-push

Encapsulates the Civitics autonomous-loop git mechanics as a single command:
**commit → push → `pnpm fixes:sync` → status commit → push**.

Use this **after** a complete code change is staged (`git add ...`) and built
(`pnpm build` passed). The command will not stage files for you, will not run
the build, and will not apply migrations. Those steps happen before invocation.

It exists to prevent three recurring mistakes the inline autonomous-loop block
in CC prompts kept producing:

1. Missing `Verified:` trailer → done.log row logged as `unverified`, losing
   per-environment provenance.
2. Wrong-order push → `fixes:sync` running before the code commit means
   done.log records the sync's SHA instead of the code SHA.
3. Forgotten `chore(fixes): sync status …` follow-up commit → done.log diff
   stays un-pushed; next session reads stale FIXES.md state.

---

## Usage

```
/civitics-commit-push <tier> <fix-ids> ["subject"] ["body"]
```

- `<tier>` — required. One of seven valid `Verified:` trailer values:
  - Code-fix tiers: `local`, `prod`, `local+prod`
  - Closure tiers (administrative, no code change): `closes-as-recognized`,
    `closes-as-superseded`, `closes-as-redirected`, `closes-as-no-op`
- `<fix-ids>` — required. One or more `FIX-NNN` tokens, comma- or
  space-separated. Examples: `FIX-305`, `FIX-305,FIX-308`,
  `FIX-305 FIX-308 FIX-319`.
- `["subject"]` — optional. Commit subject line in quotes. If omitted, you
  (the CC agent) compose one from the staged diff.
- `["body"]` — optional. Commit body in quotes. If omitted, you compose a
  one-paragraph summary from the staged diff.

**Trailer selection is automatic from `<tier>`:**

- `<tier>` ∈ {`local`, `prod`, `local+prod`} → emit `Fixes: <ids>` trailer.
- `<tier>` ∈ {`closes-as-*`} → emit `Closes: <ids>` trailer.

The user never specifies Fixes-vs-Closes directly — the tier decides. This
matches the contract documented in `CLAUDE.md` (FIXES Workflow,
FIX-314).

### Examples

```
/civitics-commit-push local FIX-305 "feat(tooling): /civitics-commit-push slash command"
/civitics-commit-push local+prod FIX-308,FIX-319
/civitics-commit-push closes-as-superseded FIX-213 "docs(fixes): close FIX-213 as superseded by FIX-253"
/civitics-commit-push local FIX-308 "[skip vercel] wip: OfficialCard query swap"
```

The `[skip vercel]` prefix is honored verbatim if it appears in the subject —
no separate flag.

---

## Instructions for the CC agent

You are running the `civitics-commit-push` command. Treat the steps below as
the fixed flow — do not improvise additional steps or skip the approval gate.

### Step 1 — Parse `$ARGUMENTS`

`$ARGUMENTS` contains everything the user typed after the command name.
Extract:

- `tier` — first whitespace-delimited token. Validate it is one of the seven
  valid values above. If invalid, **abort** with: `Invalid tier: '<got>'. Must
  be one of: local, prod, local+prod, closes-as-recognized,
  closes-as-superseded, closes-as-redirected, closes-as-no-op.`
- `fix_ids` — every `FIX-NNN` token remaining after `tier`. Normalize to a
  comma-and-space separated list (e.g. `FIX-305, FIX-308`). If zero
  `FIX-NNN` tokens found, **abort** with: `No FIX-NNN ID parsed. Pass at
  least one, e.g. /civitics-commit-push local FIX-305.`
- `subject` (optional) — the first quoted string after `tier` + ids, if any.
- `body` (optional) — the second quoted string, if any.

### Step 2 — Pre-flight checks

Run `git status --porcelain`. If output is empty, **abort** with: `No staged
or modified changes. Stage files with 'git add ...' then re-run.`

If output contains only unstaged changes (lines starting with ` M`, `??`,
etc., but nothing in column 1), **abort** with: `Changes are present but
none staged. Run 'git add <files>' first — this command never stages on
your behalf.`

Capture the current branch:

```
git rev-parse --abbrev-ref HEAD
```

Save as `branch`. The push step uses `git push origin <branch>` — feature
branches work; do not hardcode `main`.

### Step 3 — Compose the commit message

If `subject` was provided, use it verbatim. Otherwise compose a Conventional
Commits–style subject from the staged diff (`git diff --cached --stat` +
`git diff --cached`) — short, ≤70 chars, e.g. `fix(officials): use polymorphic
to_type/to_id filter on OfficialCard`.

If `body` was provided, use it verbatim. Otherwise compose a one-paragraph
summary (2–6 sentences) from the staged diff. Describe **why**, not just
what — the diff already shows what.

Compose the final message in this exact shape (note: blank line between
each block):

```
<subject>

<body>

Verified: <tier>
<trailer-name>: <fix-ids>
```

Where `<trailer-name>` is:

- `Fixes` if `tier` ∈ {`local`, `prod`, `local+prod`}
- `Closes` if `tier` ∈ {`closes-as-*`}

`<tier>` in the `Verified:` line is the raw value the user passed (`local`,
`local+prod`, `closes-as-superseded`, etc. — `scripts/fixes-sync.mjs`
normalizes these into done.log's canonical column values).

### Step 4 — Approval gate

Display the full composed commit message in a fenced block and ask:

> Run this commit and push, then sync? (y/n)

On `n` / `no` / anything ambiguous: **abort with zero side effects**. Do not
commit, push, or run sync.

On `y` / `yes`: proceed to step 5.

### Step 5 — Code commit + push

In sequence (stop on any non-zero exit):

```bash
git commit -m "<the composed message — pass via HEREDOC to preserve newlines>"
git push origin <branch>
```

Use the same HEREDOC pattern documented in the global commit guidance — never
shell-escape multi-line messages inline.

Capture the resulting SHA: `git rev-parse HEAD` → `code_sha`.

### Step 6 — Sync

```bash
pnpm fixes:sync
```

If `pnpm fixes:sync` exits non-zero, **stop**. Surface the error to the user
verbatim and do not attempt the status commit. The code commit is already
pushed; the user can re-run sync manually after resolving.

### Step 7 — Conditional status commit

Check whether `docs/done.log` or `docs/FIXES.md` were modified by sync:

```bash
git status --porcelain docs/done.log docs/FIXES.md
```

- If both are clean: skip to step 8. Print `fixes:sync produced no changes —
  status commit skipped (idempotent).`
- If either is modified:

  ```bash
  git add docs/done.log docs/FIXES.md
  git commit -m "chore(fixes): sync status after <fix-ids>"
  git push origin <branch>
  ```

  Capture: `git rev-parse HEAD` → `status_sha`.

### Step 8 — Report

Print a final summary:

```
✓ <code_sha> — <subject>
✓ <status_sha> — chore(fixes): sync status after <fix-ids>     (or: status commit skipped)
Branch: <branch>
Trailer: Verified: <tier>; <trailer-name>: <fix-ids>
```

Stop. Do not initiate any further work.

---

## Hard rules

- **Never** `--no-verify` or pass any other hook-skipping flag. If a hook
  fails, surface the failure and let the user resolve.
- **Never** `git commit --amend`. Always create a new commit. (Per
  `CLAUDE.md` — "never amend".)
- **Never** force-push (`git push -f`, `git push --force-with-lease`, etc.).
- **Never** push to a branch other than the current branch.
- **Never** stage files on the user's behalf. If `git status` shows unstaged
  changes only, abort and let the user `git add` explicitly.
- **Never** rewrite, edit, or remove existing lines in `docs/done.log` or
  `docs/FIXES.md` directly. Only `pnpm fixes:sync` may modify them as part
  of this command's flow.
- **Never** invoke a different branch's push, change git remote, modify git
  config, or touch `.gitignore`.
- If `pnpm fixes:sync` errors: stop. Don't push a half-state.

## Why these rules exist

This command is invoked many times per session and runs against `main` by
default. Every safeguard above maps to a real prior incident or to the
explicit "never amend / never --no-verify" guidance in
`CLAUDE.md`. The approval gate at step 4 is the only place the
user reviews — once they approve, the command runs the rest unattended, so
the rest of the flow has to be conservative.
