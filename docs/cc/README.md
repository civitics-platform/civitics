# docs/cc — the CC loop

Cowork writes a numbered prompt, Claude Code runs it, and a report lands in the
repo, where anyone can check its claims. Nobody has to carry text between the
two. (FIX-1175, FIX-1242, FIX-1243.)

## The files

| what | where | run it with |
|---|---|---|
| Prompt template and standing rules | [PROMPT_TEMPLATE.md](PROMPT_TEMPLATE.md) | read by every run |
| The run command | `.claude/commands/cc.md` | `/cc <n>` in Claude Code |
| Prompts, written by Cowork | `../Claude/civitics/cc-prompt-<n>-*.md`, outside the repo | `pnpm cc:prompt <n> [--start\|--done]` |
| Reports, written by `/cc` | `docs/cc/reports/cc-<n>.md` + `.json` | `pnpm cc:verify <n>` · `pnpm cc:json <n>` |
| Where prompts and reports resolve | [cc.config.json](cc.config.json) (`.claude/cc.config.json` overrides) | — |
| Lanes: ops · fec · app · hygiene · design | `cc.config.json` `lanes` | a prompt's `lane:` |
| FIX lanes | a `<!--lane:X-->` marker on the bullet, else `cc.config.json` `sectionLanes` | `pnpm fix:add --lane <lane>` |
| Projects (multi-prompt plans) | [projects/](projects/) — one plan file each, with an optional `goal: "P<N> · <group>"` | a prompt's `project:` |
| Lanes for cc-162…170, which predate `lane:` | [lanes-backfill.json](lanes-backfill.json) | read by the board |
| The board | `../Claude/civitics/board/` (`index.html` + `board.json`), never committed | `pnpm board [--projects all]` |
| Supervised windows (local, untracked) | `.claude/board.local.json`, in the shape of [board.local.example.json](board.local.example.json) | read by the board |
| In-flight marker | `../Claude/civitics/cc-<n>.running` | `cc:prompt --start` / `--done` |
| Doc links | every `.md` link and backtick `docs/…` path must resolve | `pnpm check:doc-links` |

The board reads only the tree:
- reports and prompts;
- plan files and PHASE_GOALS.md;
- FIXES.md with done.log;
- the newest 14 `docs/receipts/*.json`.

It never opens a database connection. The same tree and the same `--now`
always give the same bytes.

## How a week runs

1. Cowork writes the prompts. Each one's front matter names its lane, its
   project and a `when:` (`any`, a date, `after <ISO>`, or `<ISO>..<ISO>`).
   The board lays out the week from those, from what reports still owe, and
   from pg_cron and the nightly.
2. Claude Code runs `/cc <n>` in a worktree, lands its commits on `main`,
   writes the report and runs `pnpm cc:verify <n>`. Only then does it commit
   the report.
3. `pnpm board` re-renders the page. Cowork reads each report's `.json` claims
   and `.md` prose, and writes the next prompt against what the tree now says.
