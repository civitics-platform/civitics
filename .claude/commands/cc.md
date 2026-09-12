# /cc

Run a numbered Cowork prompt from the repo, and write its report back into the
repo.

```
/cc 122
/cc 122 --dry-run      # locate and summarise the prompt, run nothing
```

Today Craig is the transport in both directions: he copies a prompt out of
`Civitics/Claude/civitics/` into Claude Code, and pastes the report back into
Cowork. Neither leg needs a human. This command replaces the first; the report
file this writes replaces the second. (FIX-1175.)

---

## Where things live

Config, first match wins: `.claude/cc.config.json` (machine-local, untracked —
`.gitignore` excludes `.claude/*`) then `docs/cc/cc.config.json` (the versioned
default). Read by `scripts/lib/cc-config.mjs`:

| key | default | resolved against |
|---|---|---|
| `promptsDir` | `../Claude/civitics` | the **primary checkout** |
| `reportsDir` | `docs/cc/reports` | the **current worktree** |

The split matters. Prompts live outside the repo, so a path relative to
`git rev-parse --show-toplevel` breaks the moment you are in
`../civitics-worktrees/fix-NNN` — which is the normal case, because agents never
commit on the primary checkout. `--git-common-dir` returns the primary repo's
`.git` from inside a linked worktree too, so its parent is the stable anchor.
Reports are committed, so they belong to whichever worktree is committing.

An absolute `promptsDir` is taken verbatim; `CIVITICS_CC_PROMPTS_DIR` and
`CIVITICS_CC_REPORTS_DIR` override either. To see what resolves right now:

```bash
node -e "import('./scripts/lib/cc-config.mjs').then(m=>console.log(m.loadCcConfig()))"
```

---

## Instructions for the CC agent

### Step 1 — find the prompt

```bash
node -e "import('./scripts/lib/cc-config.mjs').then(async m=>{
  const c=m.loadCcConfig();
  console.log(JSON.stringify(m.findPromptFiles(process.argv[1], c).map(f=>f.path),null,2));
})" <n>
```

- **Zero matches** → abort: `No cc-prompt-<n>-*.md in <promptsDir>. Check the
  number, or pass the path directly.` Do not guess a neighbouring number.
- **More than one** → abort and list them. Ask which. Do not silently take the
  newest: two files for one number means Cowork wrote a revision, and running
  the wrong one is worse than asking.
- **One** → read it in full before doing anything.

### Step 2 — run it

The prompt file is the instruction set. Follow it exactly, including its Phase 0
reads, its stated prod-access posture, and its stop conditions. Read
`docs/cc/PROMPT_TEMPLATE.md` for the standing rules every prompt assumes rather
than restates.

Two things override the prompt text:

- **A stop condition in the prompt fires** → stop that item, record it in
  `stopped_items`, and carry on with the rest. Do not work around it.
- **The tree contradicts the prompt's premise** → stop and report. A prompt is
  written against a tree that has since moved; the tree wins.

### Step 3 — write the report

Write `<reportsDir>/cc-<n>.md`. It opens with YAML front matter — the part
`pnpm cc:verify` checks — followed by the free-form sections the prompt's
"After-commit report" section asked for.

```yaml
---
cc: 122
prompt: cc-prompt-122-fix1016-….md
started_at: 2026-09-12T04:00:00Z
finished_at: 2026-09-12T07:30:00Z
head_before: 97f33367
head_after: 1a2b3c4d
commits:
  - {sha: 1a0468b0, subject: "chore(fixes): clean + archive closed bullets"}
  - {sha: ff793ccf, subject: "feat(fixes): derive FIX status from done.log"}
fixes_closed: [FIX-1016]
fixes_filed: [FIX-1175]
fixes_reopened: []
migrations_pushed: []
prod_writes: none
ci: green
stopped_items: []
---
```

Field rules — each one is a claim the verifier checks, so state only what is
true:

- `commits` — every commit THIS run made, in order. Each must exist and be an
  ancestor of `origin/main` by the time you verify. **Quote a subject** that
  contains a comma followed by a word and a colon; the parser splits map pairs
  on that shape and quoting is what disambiguates it.
- `fixes_closed` — ids whose `Fixes:`/`Closes:` trailer rode a commit in
  `commits[]`. The verifier requires a `done.log` row naming one of those shas,
  so an id closed by earlier work does not belong here even if it is closed.
- `fixes_filed` — ids allocated by `pnpm fix:add` in this run. Each needs a
  live `<!--id:FIX-NNN-->` marker.
- `fixes_reopened` — ids you reopened. Each must derive OPEN on a `reopen` row.
- `migrations_pushed` — migration FILES. The verifier confirms the file is on
  trunk and reports the Pro side as UNCHECKED, because that is not knowable from
  here. Empty when there is no schema change.
- `prod_writes` — `none`, or a description. Never omit it; a missing value FAILs.
- `ci` — `green` or `red <run-id>`. Cross-checked against
  `gh run list --workflow tests.yml --branch main -L 1` when `gh` is available.
- `stopped_items` — one line per item you refused, stopped, or could not finish,
  and why. An empty list is a claim that nothing was stopped.

The prose below the front matter is where the value is. Keep the section the
prompt asked for, and keep **"anything that contradicted the design"** free-form
— that is the part a template must not constrain.

### Step 4 — verify, then commit

```bash
pnpm cc:verify <n>
```

Fix what FAILs — by correcting the report where the claim was wrong, or by
finishing the work where the claim was premature. Never by deleting the claim.
`UNCHECKED` is fine and expected (a prod write, a migration's Pro side).

Then commit the report alone:

```bash
git add docs/cc/reports/cc-<n>.md
git commit -m "docs(cc): report for cc-<n>"
```

Docs-only, so `tests.yml` skips it via `paths-ignore` and `fixes-integrity.yml`
still runs. Print the same report text into the chat as well — Craig may still
read it there; the file is the record.

---

## Hard rules

- **Never** invent a prompt number or run a prompt you could not read in full.
- **Never** report a claim `cc:verify` contradicts. Change the work or change
  the claim.
- **Never** commit the report before the commits it names are on `origin/main` —
  the verifier checks ancestry, and a report that describes unmerged work is
  the stranded-PR failure mode (FIX-461) in a new costume.
- `prod_writes` and `ci` are stated in every report, including runs that touched
  neither. "Nothing to report" is a claim, and it should be checkable.
