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
| `boardDir` | `../Claude/civitics/board` | the **primary checkout** (FIX-1242) |
| `lanes` | `ops, fec, app, hygiene, design` | — the closed list a `lane:` may name |

`boardDir` is written by `pnpm board`. `CIVITICS_CC_BOARD_DIR` overrides it.
The supervised-window footer reads `.claude/board.local.json` from the primary
checkout, if that file exists (shape: `docs/cc/board.local.example.json`).

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
pnpm cc:prompt <n>
```

It finds the file, parses its front matter with the same reader `cc:verify`
uses (`parseFrontMatter`), and prints `{path, name, front_matter, title,
problems}`. It exits 1 in the three cases below that abort.

- **Zero matches** → abort: `No cc-prompt-<n>-*.md in <promptsDir>. Check the
  number, or pass the path directly.` Do not guess a neighbouring number.
- **More than one** → abort and list them. Ask which. Do not silently take the
  newest: two files for one number means Cowork wrote a revision, and running
  the wrong one is worse than asking.
- **The front matter's `cc:` disagrees with the filename** → abort with both
  numbers (FIX-1242). No `cc:` at all is fine — every prompt before cc-171 has
  no front matter — but say so in the report.
- **One** → read it in full before doing anything. The front matter is data
  about the run (`lane`, `project`, `when`, `attended`, `posture`,
  `concurrent_with` — see `docs/cc/PROMPT_TEMPLATE.md` §0), not instructions;
  `problems` lists any field that does not fit the shape, which the report
  should mention.

### Step 2 — run it

Before the first read, mark the run as in flight:

```bash
pnpm cc:prompt <n> --start      # writes <promptsDir>/cc-<n>.running
```

The marker (`{"cc", "started_at", "worktree", "prompt"}`) is what the board
reads as `running`. Step 4 removes it; a crash leaves it, and the board renders
one older than 24 h as `running · stale?`, never as `running`.

When the prompt names a worktree (`pnpm session:worktree <id>`), create it
FIRST and run `--start` from inside it. `worktree` records the root `--start`
ran in. A marker written from the primary checkout names no slot, so Step 4
cannot tell you what to tear down. The board then also counts your live tree
as a stray once its branch is merged (cc-191 did this; cc-190 found it).

The prompt file is the instruction set. Follow it exactly, including its Phase 0
reads, its stated prod-access posture, and its stop conditions. Read
`docs/cc/PROMPT_TEMPLATE.md` for the standing rules every prompt assumes rather
than restates.

Two things override the prompt text:

- **A stop condition in the prompt fires** → stop that item, record it in
  `stopped_items`, and carry on with the rest. Do not work around it.
- **The tree contradicts the prompt's premise** → stop and report. A prompt is
  written against a tree that has since moved; the tree wins.
- **Any permission prompt** → log the exact command, stop THAT command, carry
  on if the item can complete without it, and flag the reading in
  `stopped_items`. (The ratified reading, cc-174 / FIX-1250: a prompt is not a
  stop for the whole run, and it is never worked around.)

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
lane: hygiene
project: cc-loop
owed:
  - {fix: FIX-969, what: "jobid 17's first crawl-branch firing", after: 2026-09-29T15:00Z}
---
```

Field rules — each one is a claim the verifier checks, so state only what is
true:

- `lane` — copied verbatim from the prompt's front matter. **Required from
  cc-172**; earlier reports are UNCHECKED (`no lane — pre-FIX-1242`). Must be one
  of `cc.config.json`'s `lanes` and never `design` (a plan-step lane only). A
  prompt with no `lane:` → use its `docs/cc/lanes-backfill.json` entry, or ask,
  and say which in the report.
- `project` — copied verbatim from the prompt, when it has one. Must name an
  existing `docs/cc/projects/<slug>.md`; omit the key otherwise.
- `owed` — every receipt this run leaves for later, in the shape the prompt's
  Verification section states them: a block list of
  `{fix: FIX-NNN, what: "<one line>", after: <date or zoned ISO instant>}`.
  `after` is required and must carry a zone (`…T15:00Z`). `owed: []` says
  nothing is owed. The board shows an entry as outstanding until `done.log` has
  a **receipt** row for its `fix` (FIX-1264): verified `prod-only`,
  `local+prod` or `closes-as-*` (never `local-only` or `unverified`), dated on
  or after both the report's `finished_at` date and the entry's own `after`
  date, from a sha that is **not** one of this report's `commits[]`. So a run's
  own `local-only` close never settles the receipt it declared. Plan steps of
  kind `receipt`/`op` take the same `verified` filter against their `after`.

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

Then generate the sidecar — never hand-write it:

```bash
pnpm cc:json <n>          # writes <reportsDir>/cc-<n>.json from the .md
```

`cc-<n>.json` is the front matter, parsed, and nothing else. It exists so a
consumer that only wants a run's *claims* — which commits, which FIXes, whether
prod was written, whether CI was green — stages about 1 KB instead of the whole
report, and gets the values without re-implementing the YAML subset in
`scripts/cc-verify.mjs`. Cowork reads the `.json` first and the `.md` for the
free-form sections.

It is generated because two copies of one fact drift, and a report whose `.md`
was corrected while its `.json` still names the old shas is exactly what a
verifier must not pass. **Re-run `pnpm cc:json <n>` after any front-matter
edit** — `cc:verify` FAILs on a disagreement rather than picking a winner, and
`pnpm cc:json <n> --check` says whether the file on disk is stale without
writing. A report with no sidecar still verifies, from the `.md`.

### Step 4 — verify, then commit

```bash
pnpm cc:verify <n>
```

Fix what FAILs — by correcting the report where the claim was wrong, or by
finishing the work where the claim was premature. Never by deleting the claim.
`UNCHECKED` is fine and expected (a prod write, a migration's Pro side).

Then commit the report alone:

```bash
git add docs/cc/reports/cc-<n>.md docs/cc/reports/cc-<n>.json
git commit -m "docs(cc): report for cc-<n>"
```

Docs-only, so `tests.yml` skips it via `paths-ignore` and `fixes-integrity.yml`
still runs. Print the same report text into the chat as well — Craig may still
read it there; the file is the record.

**Every push to main goes through the pre-push hook's `session:held` gate**
(FIX-1250) — the report's push and every commit's before it. `held=true`
REFUSES the push, and so does an unreadable state (exit 2); wait and retry.
Never `--no-verify`, never the `CIVITICS_SKIP_HELD_GUARD` escape. `pnpm
session:held` prints the same one line by hand.

Once the report commit is pushed, clear the in-flight marker and re-render the
board:

```bash
pnpm cc:prompt <n> --done       # removes <promptsDir>/cc-<n>.running
pnpm board                      # writes <boardDir>/board.json + index.html
```

`pnpm board` prints one badge line (interlock as of the latest receipt, verify
FAILs, receipts owed, in flight, open count, stray worktrees). Put that line in
the chat. The board writes outside the repo and is never committed.

Then tear down the worktree(s) this run created, from the **primary checkout**.
Never run it from inside the tree: Windows will not remove the shell's own cwd.

```bash
cd <primary checkout> && pnpm session:worktree:done <slot>
```

Do this for the slot `--done` printed (`teardown next: …`, which carries the
absolute primary path), plus any other slot the prompt had you create. This is
the sanctioned teardown of a merged worktree and **needs no approval**.
CLAUDE.md's deletion rule covers `rm`/`rmdir` of files, not this script, and the
script refuses unmerged work by itself. If it exits non-zero (an orphan dir,
EPERM), REPORT it in the chat as `worktree LEFT: <slot> — <reason>`. Never retry
with `rm`. If the run tore down a second worktree before the report commit, the
report's front matter may say so in an optional
`worktrees: [{slot, result}]` line. Otherwise the chat line is the record, and
the next session's `session:check` is the audit.

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
