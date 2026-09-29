# docs/archive — manifest

Documents that finished their job. They are kept for their history and are not
maintained: a fact in here may have been true only on the day it was written.
Every reference to a file below was rewritten when it moved, and
`pnpm check:doc-links` fails a link to a doc that is not there.

To move another one, run `pnpm check:doc-links --archive <name>.md --dry-run`.
It prints the `git mv` and every line it would rewrite. Drop `--dry-run` to do
it, then add a line here. The tool refuses a doc that code or a migration cites
by path, because a comment does not follow a rename.

| file | moved | why | where its content went |
|---|---|---|---|
| [SESSION_LOG.md](SESSION_LOG.md) | before 2026-04-22 | The per-session log from before the CC loop. | `docs/done.log` (per FIX) and `docs/cc/reports/` (per run). |
| [fixes-archive.md](fixes-archive.md) | ongoing | Closed FIXES.md bullets, moved by `pnpm fixes:archive`. It is machine-owned history, and its `[x]` boxes predate FIX-1016. | `docs/FIXES.md` holds the live backlog. Status lives in `docs/done.log`. |
| [REBUILD_STATUS.md](REBUILD_STATUS.md) | 2026-04-22 | The Stage 0→2 rebuild tracker. The rebuild cut over on 2026-04-22. | `CLAUDE.md` (the cutover status line) and `docs/done.log` (FIX-097–104). |
| [MIGRATION_RUNBOOK.md](MIGRATION_RUNBOOK.md) | 2026-04-22 | The runbook that promoted `shadow.*` to `public.*`, done in migration `20260422000000`. | Executed. Nothing replaces it. |
| `scripts/` | 2026-05-10 | Orphan scripts from the pipeline audit (`copy-pac-tags-to-prod.ts`). | Deleted from `packages/data`. |
| [QWEN_PROMPTS.md](QWEN_PROMPTS.md) | 2026-09-29 | The Qwen Code task queue. Qwen is deprecated, and Claude Code runs the loop. | `docs/FIXES.md` and the CC prompts (`docs/cc/`). `QWEN.md` at the root still points here. |
| [HIT_LIST.md](HIT_LIST.md) | 2026-09-29 | Craig's pre-FIX ideas list. Read 5 of cc-172 checked all 37 items against FIXES.md. 24 are covered, fully or partly (15 fully, 9 partly), by FIXes that are all closed. 13 have no FIX; they are listed below. | `docs/FIXES.md`. The 13 uncovered items are Craig's decision list, below. |
| [PLATFORM_REBUILD_SPEC.md](PLATFORM_REBUILD_SPEC.md) | 2026-09-29 | Why the Stage 0→2 platform rebuild happened. It cut over on 2026-04-22. | The schema it produced (`supabase/migrations/`) and [REBUILD_STATUS.md](REBUILD_STATUS.md). |
| [STAGE_0_WRITER_CATALOG.md](STAGE_0_WRITER_CATALOG.md) | 2026-09-29 | The rebuild's Stage 0 writer audit. | Its 17 findings became the rebuild's migrations. `docs/STAGE_1_SCHEMA_DESIGN.md` stays in docs/ because two migrations cite it by path. |
| [STAGE_1_SCRAPER_RESEARCH.md](STAGE_1_SCRAPER_RESEARCH.md) | 2026-09-29 | The rebuild's Stage 1 source research. | `packages/data/CLAUDE.md` and the pipelines. |
| [PIPELINE_AUDIT.md](PIPELINE_AUDIT.md) | 2026-09-29 | The 2026-05 pipeline audit, now complete. Its links were re-based one level down. Six of them were already dead before the move: they point at `usaspending/` code the audit told us to delete. | Its follow-ups FIX-222 to FIX-235, all closed (see [fixes-archive.md](fixes-archive.md)), and `packages/data/CLAUDE.md`. |
| [PIPELINE_AUDIT_PROMPTS.md](PIPELINE_AUDIT_PROMPTS.md) | 2026-09-29 | The staged prompts that executed the pipeline audit. | Their commits, and the FIXes above. |
| [DASHBOARD_REDESIGN_SPEC.md](DASHBOARD_REDESIGN_SPEC.md) | 2026-09-29 | The /dashboard redesign spec. The dashboard audit program closed on 2026-08-29. | `apps/civitics/app/dashboard/`, and `/api/phases` (FIX-1078). |
| [COMMENT_SYSTEM_SPEC.md](COMMENT_SYSTEM_SPEC.md) | 2026-09-29 | The structured comment-type spec (2026-04-17). It cites no FIX ids, and no code references it. | Shipped as migration `20260418000000_comment_types.sql` and `packages/db/src/comment-kinds.ts`. |
| [CIVIC_INITIATIVES.md](CIVIC_INITIATIVES.md) | 2026-09-29 | The civic initiatives sprint tracker, which reads "all sprints complete". The two FIX ids it cites (905, 906) are closed, and no code references it. | `apps/civitics/app/initiatives/`, `apps/civitics/app/api/initiatives/`, and `docs/API.md`. |

## HIT_LIST harvest — the 13 items no FIX covers

cc-172 filed nothing from this list. These are for Craig to decide on.

- **Bugs:** `POST /api/platform/web-vitals` returns 400. The route and `WebVitalsReporter.tsx` still exist.
- **Bugs:** `pnpm dev` prints webpack's PackFileCacheStrategy "big strings" warning.
- **General:** a small local dev UI (.exe) with buttons for pipelines, env flags, fixes ops, logs and git/supabase.
- **General:** reorganize, archive and verify the docs folder. This pass is the first part of that (FIX-1243).
- **General:** a note about the HitList → FIXES → archive workflow.
- **Homepage:** a brainstorm on political ads (video), discussion and ratings.
- **Homepage:** remove the 2 buttons under the search bar. Probably stale after the FIX-554 rebuild.
- **Homepage:** remove the "browse comment periods" banner. Probably stale after FIX-554.
- **Initiatives [id]:** a collapsible status section that holds the quality gate and shows a message for each stage.
- **Agencies:** real budget (appropriations) data. Today "budget" means contract spend.
- **Graph:** the toggle button is misaligned.
- **Account:** a unique display name, defaulting to User1234.
- **Account:** presets and options.

The 24 covered items, with their FIX ids, are in the cc-172 report (read 5).
